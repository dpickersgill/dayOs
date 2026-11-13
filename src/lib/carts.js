'use strict';

// Carts (release 2026.11.22, Trash and recycling): the carts at each address, cart requests, and carts in the yard.
//
// The rules, in one place:
//   Address        a cart belongs to an address: the water customer list's service address when it has that street,
//                  house number and unit, else the street and house number themselves.
//   Sizes and fees the manager lists the sizes offered for each stream (35, 65 or 95 gallons) and, for each, the fee for
//                  an extra cart and for a replacement the resident caused. A new home's first cart and a stolen cart are
//                  free. A fee of 0 makes that request free.
//   Requests       new, extra, replacement, stolen. From the public page (/cart-request/<slug>) or taken by staff. A fee
//                  is paid online on the municipality's own Stripe account (metadata.kind 'cart', routed like bulk
//                  pickup), or at the office when its Stripe account is not ready. Staff checks (an address that already
//                  has a cart of that stream, more extras than allowed, a request already open) refuse a staff entry
//                  unless overridden; on the public page they are only shown to staff, so the page never tells anyone
//                  what carts or requests an address has.
//   Delivery       the office gives a request a delivery day; that day's stops (cartStopsFor) show on the crew's list
//                  and, with Collection routes, on that day's route. Delivered takes one cart of that stream and size
//                  out of the yard: stock never goes below zero, so a cart that is not in the yard cannot be delivered.
//   Refunds        a canceled request's card payment goes back in full through lib/cardrefund.js (card_returns, kind
//                  'cart'); money paid at the office waits there.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { todayIn } = require('./util');
const { money } = require('./format');
const { logFailure } = require('./jobs');
const { bad, conflict, notFound } = require('./errors');

/** lib/collection.js: zones, and the Today cards of Trash and recycling. */
const collection = () => require('./collection');

const SIZES = [35, 65, 95];
const KINDS = { new: 'New cart', extra: 'Extra cart', replacement: 'Replacement cart', stolen: 'Stolen cart' };
const KIND_KEYS = Object.keys(KINDS);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () => `C${Array.from(crypto.randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
const token = () => crypto.randomBytes(16).toString('hex');
const houseNo = (s) => { const m = /^\s*(\d{1,7})/.exec(String(s || '')); return m ? Number(m[1]) : null; };
const OPEN = "('awaiting_payment','open','scheduled')";
const DEFAULT_RULES = [
  'Each home gets one trash cart and one recycling cart. A new home\'s first carts are free.',
  'Extra carts and replacements for carts damaged by misuse may carry a fee, shown before you send the request.',
  'A stolen cart is replaced free. Give the police report number if you have one.',
  'Carts belong to the municipality and stay with the house when you move.',
].join('\n');

// ---------------------------------------------------------------- settings and sizes
async function settingsOf(tenantId, db = pool) {
  let s = await one(db, 'SELECT * FROM cart_settings WHERE tenant_id = ?', [tenantId]);
  if (!s) {
    await db.query('INSERT IGNORE INTO cart_settings (tenant_id, rules_text) VALUES (?, ?)', [tenantId, DEFAULT_RULES]);
    s = await one(db, 'SELECT * FROM cart_settings WHERE tenant_id = ?', [tenantId]);
  }
  return { online: Boolean(s.online), max_extra: Number(s.max_extra), rules_text: s.rules_text || '' };
}

const streamsOf = (db, tenantId) => rows(db, 'SELECT id, name, kind, color FROM collection_streams WHERE tenant_id = ? AND active = 1 ORDER BY sort, id', [tenantId]);

/** The sizes offered: [{ id, stream_id, stream, stream_kind, size_gal, extra_fee_cents, replacement_fee_cents, active }]. */
async function optionsOf(db, tenantId, { all = false } = {}) {
  const list = await rows(db, `SELECT o.id, o.stream_id, s.name AS stream, s.kind AS stream_kind, o.size_gal, o.extra_fee_cents, o.replacement_fee_cents, o.active
    FROM cart_options o JOIN collection_streams s ON s.tenant_id = o.tenant_id AND s.id = o.stream_id
    WHERE o.tenant_id = ?${all ? '' : ' AND o.active = 1 AND s.active = 1'} ORDER BY s.sort, s.id, o.size_gal`, [tenantId]);
  return list.map((o) => ({ ...o, id: Number(o.id), stream_id: Number(o.stream_id), size_gal: Number(o.size_gal), extra_fee_cents: Number(o.extra_fee_cents), replacement_fee_cents: Number(o.replacement_fee_cents), active: Boolean(o.active) }));
}

/** The fee for this kind of request on this size: extras and replacements as set; a new home's cart and a stolen one free. */
const feeOf = (opt, kind) => (kind === 'extra' ? opt.extra_fee_cents : kind === 'replacement' ? opt.replacement_fee_cents : 0);

async function optionFor(db, tenantId, streamId, size) {
  const o = (await optionsOf(db, tenantId)).find((x) => x.stream_id === Number(streamId) && x.size_gal === Number(size));
  if (!o) throw bad('That cart size is not offered for that stream. Pick one from the list.');
  return o;
}

// ---------------------------------------------------------------- addresses
const streetOk = async (db, tenantId, id) => {
  const s = await one(db, 'SELECT id, name FROM streets WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, id]);
  if (!s) throw bad('Pick a street from the list');
  return s;
};
/** The service address (water customer list) at this street, house number and unit, or null. */
async function serviceAddressAt(db, tenantId, streetId, houseNumber, unit) {
  const r = await one(db, `SELECT id FROM service_addresses WHERE tenant_id = ? AND street_id = ? AND house_number = ? AND COALESCE(unit, '') = ? AND active = 1 ORDER BY id LIMIT 1`,
    [tenantId, streetId, String(houseNumber).trim(), String(unit || '').trim()]);
  return r ? Number(r.id) : null;
}
const addressOf = (r) => `${r.house_number} ${r.street}${r.unit ? `, ${r.unit}` : ''}`;
const sameAddress = 'street_id = ? AND house_number = ? AND COALESCE(unit, \'\') = ?';
const addrParams = (a) => [a.street_id, String(a.house_number).trim(), String(a.unit || '').trim()];

/** The carts in use at an address (any stream). */
const cartsAt = (db, tenantId, a) => rows(db, `SELECT c.*, s.name AS stream FROM carts c JOIN collection_streams s ON s.tenant_id = c.tenant_id AND s.id = c.stream_id
  WHERE c.tenant_id = ? AND c.street_id = ? AND c.house_number = ? AND COALESCE(c.unit, '') = ? AND c.status = 'in_use' ORDER BY s.sort, c.id`, [tenantId, ...addrParams(a)]);

/**
 * What staff should know before taking this request, in plain words (empty when nothing): an address that already has a
 * cart of that stream asking for a new one, more extras than allowed, or the same kind of request already open.
 */
async function checksFor(db, tenantId, r, s, { exceptId = null } = {}) {
  const out = [];
  const have = (await cartsAt(db, tenantId, r)).filter((c) => Number(c.stream_id) === Number(r.stream_id));
  const stream = (await one(db, 'SELECT name FROM collection_streams WHERE tenant_id = ? AND id = ?', [tenantId, r.stream_id]) || {}).name || 'that stream';
  const open = await rows(db, `SELECT id, kind FROM cart_requests WHERE tenant_id = ? AND ${sameAddress} AND stream_id = ? AND status IN ${OPEN}${exceptId ? ' AND id <> ?' : ''}`,
    [tenantId, ...addrParams(r), r.stream_id, ...(exceptId ? [exceptId] : [])]);
  if (open.some((x) => x.kind === r.kind)) out.push(`A ${KINDS[r.kind].toLowerCase()} request for ${stream} is already open at this address.`);
  if (r.kind === 'new' && have.length) out.push(`This address already has ${have.length === 1 ? 'a' : have.length} ${stream} cart${have.length === 1 ? '' : 's'}. Ask for an extra cart or a replacement instead.`);
  if (r.kind === 'extra') {
    const extras = Math.max(have.length - 1, 0) + open.filter((x) => ['extra', 'new'].includes(x.kind)).length;
    if (extras >= s.max_extra) out.push(`This address already has ${have.length} ${stream} cart${have.length === 1 ? '' : 's'}; up to ${s.max_extra} extra ${s.max_extra === 1 ? 'is' : 'are'} allowed.`);
  }
  return out;
}

/** The contact rules shared by both request forms; returns the phone and email to keep. */
function contactOf(b) {
  const sms = require('./sms');
  const phone = b.phone ? String(b.phone).trim() : null; const email = b.email ? String(b.email).trim() : null;
  if (!phone && !email) throw bad('Give a phone number or an email address, so you can be told when the cart is coming');
  if (phone && !sms.phoneKey(phone)) throw bad('Check the phone number: use a 10-digit US number');
  if (b.texts_ok && !phone) throw bad('Give a phone number to get texts');
  if (b.emails_ok && !email) throw bad('Give an email address to get emails');
  return { phone, email };
}

/** Adds a request inside the caller's transaction. Returns { id, reference, view_token }. */
async function insertRequest(conn, tenantId, r) {
  for (let attempt = 0; ; attempt += 1) {
    const ref = reference(); const tok = token();
    try {
      const [ins] = await conn.query(`INSERT INTO cart_requests (tenant_id, reference, view_token, kind, stream_id, size_gal, street_id, house_number, house_no, unit, service_address_id, resident_id,
          contact_name, contact_phone, contact_email, texts_ok, emails_ok, note, police_report, source, status, pay_method, pay_status, fee_cents, paid_cents, paid_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? > 0, UTC_TIMESTAMP(), NULL), ?)`,
      [tenantId, ref, tok, r.kind, r.stream_id, r.size_gal, r.street_id, String(r.house_number).trim(), houseNo(r.house_number), r.unit ? String(r.unit).trim() : null, r.service_address_id || null, r.resident_id || null,
        r.contact_name ? String(r.contact_name).slice(0, 120) : null, r.contact_phone ? String(r.contact_phone).slice(0, 30) : null, r.contact_email ? String(r.contact_email).slice(0, 190) : null,
        r.texts_ok ? 1 : 0, r.emails_ok ? 1 : 0, r.note || null, r.police_report || null, r.source, r.status, r.pay_method, r.pay_status, r.fee_cents, r.paid_cents || 0, r.paid_cents || 0, r.created_by || null]);
      return { id: Number(ins.insertId), reference: ref, view_token: tok };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
}

const FULL = `SELECT r.*, st.name AS street, cs.name AS stream, cs.kind AS stream_kind, t.name AS town, t.slug, t.phone AS town_phone, t.timezone
  FROM cart_requests r JOIN streets st ON st.tenant_id = r.tenant_id AND st.id = r.street_id
  JOIN collection_streams cs ON cs.tenant_id = r.tenant_id AND cs.id = r.stream_id JOIN tenants t ON t.id = r.tenant_id`;
const fullOf = (db, tenantId, id) => one(db, `${FULL} WHERE r.tenant_id = ? AND r.id = ?`, [tenantId, id]);

const pageLink = (base, slug) => `${base}/cart-request/${encodeURIComponent(slug)}`;
const viewLink = (base, slug, tok) => `${pageLink(base, slug)}?request=${tok}`;

/** Can this municipality take a card payment now? Its own connected Stripe account, ready, and not a demo. */
async function cardReady(tenantId) {
  if (await require('./sandbox').isSandbox(tenantId)) return false;
  return (await require('./connect').payee(tenantId)).ok;
}

// ---------------------------------------------------------------- telling the resident
const dayWords = (d) => require('./bulkpickup').longDay(d);
function words(kind, r, base) {
  const link = viewLink(base, r.slug, r.view_token);
  const what = `${r.size_gal}-gallon ${r.stream} cart`;
  const where = addressOf(r);
  const call = r.town_phone ? ` Questions? Call ${r.town_phone}.` : '';
  switch (kind) {
    case 'confirm':
      return { subject: `${KINDS[r.kind]} request ${r.reference}`, text: `${r.town}: we have your ${KINDS[r.kind].toLowerCase()} request for a ${what} at ${where}. Reference ${r.reference}.${r.pay_status === 'paid' ? ` Paid ${money(r.paid_cents)}.` : r.pay_status === 'due' ? ` The fee is ${money(r.fee_cents)}.` : ''} We will tell you the delivery day: ${link}${call}` };
    case 'pay_link':
      return { subject: `Pay for your ${what}`, text: `${r.town}: the ${KINDS[r.kind].toLowerCase()} for ${where} is ${money(r.fee_cents)}. Pay by card here: ${link} Reference ${r.reference}.${call}` };
    case 'scheduled':
      return { subject: `Your cart is coming ${dayWords(r.deliver_on)}`, text: `${r.town}: your ${what} will be delivered to ${where} on ${dayWords(r.deliver_on)}. Reference ${r.reference}.${call}` };
    case 'delivered':
      return { subject: 'Your cart was delivered', text: `${r.town}: your ${what} was delivered to ${where}. Reference ${r.reference}.${call}` };
    case 'cancelled':
      return { subject: `Cart request ${r.reference} canceled`, text: `${r.town}: your cart request for ${where} is canceled. Reference ${r.reference}.${r.pay_status === 'refunded' ? ` ${money(r.refunded_cents)} is going back to your card; it can take 5 to 10 days to show.` : r.pay_status === 'refund_due' ? ' Your refund is waiting at the office.' : ''}${call}` };
    default: throw new Error(`no message ${kind}`);
  }
}

/** Tells the resident, by the ways they agreed to (texts honor STOP). Returns the channels used. Never throws. */
async function tell(tenantId, id, kind, base, { receipt = false, only = null } = {}) {
  try {
    const r = await fullOf(pool, tenantId, id);
    if (!r || !(r.contact_phone || r.contact_email)) return [];
    const w = words(kind, r, base);
    const ch = await require('./bulkpickup').channelsFor({ tenant_id: tenantId, phone: r.contact_phone, email: r.contact_email, texts_ok: r.texts_ok, emails_ok: r.emails_ok }, { receipt });
    const sent = [];
    for (const c of ch) {
      if (only && c !== only) continue;
      if (r.source === 'online' && kind === 'confirm' && !(await require('./publicsends').allow(tenantId, c === 'text' ? 'sms' : 'email', c === 'text' ? r.contact_phone : r.contact_email, `cart-${kind}`))) continue;
      if (c === 'text') {
        const out = await require('./sms').send({ tenantId, to: r.contact_phone, body: `${w.text} Reply STOP to stop texts.`, from: await require('./residents').fromNumber(pool, tenantId), tag: `cart-${kind}` });
        if (out.ok) sent.push('text');
      } else {
        const out = await require('./mailer').send({ tenantId, to: r.contact_email, fromName: r.town, subject: w.subject, text: w.text, tag: `cart-${kind}` });
        if (out.ok) sent.push('email');
      }
    }
    return sent;
  } catch (err) {
    logFailure({ job: 'cart_requests', tenant: tenantId, request: id, message: `could not send the ${kind} message: ${err.message}` });
    return [];
  }
}

// ---------------------------------------------------------------- money
/** Writes a full card refund of the request's payment as owed, inside the caller's transaction. Returns the card_returns id or null. */
async function oweCardRefund(conn, r, reason) {
  if (r.pay_method !== 'card' || r.pay_status !== 'paid' || !r.payment_intent || !(r.paid_cents > 0)) return null;
  const id = await require('./cardrefund').oweReturn(conn, { tenantId: r.tenant_id, kind: 'cart', rowId: r.id, session: r.stripe_session_id, paymentIntent: r.payment_intent, amountCents: r.paid_cents, account: r.processor_account, reason });
  await conn.query("UPDATE cart_requests SET pay_status = 'refunded', refunded_cents = paid_cents WHERE tenant_id = ? AND id = ?", [r.tenant_id, r.id]);
  return id;
}
const sendRefund = (id) => (id ? require('./cardrefund').sendReturn(id) : null);

/** A card page for a request waiting for its fee. Each try is its own page; the one before it is closed. */
async function checkout(tenantId, id, base) {
  const connect = require('./connect'); const stripe = require('./stripe');
  const r = await fullOf(pool, tenantId, id);
  const payee = await connect.payeeOrThrow(tenantId);
  const [u] = await pool.query("UPDATE cart_requests SET pay_tries = pay_tries + 1 WHERE tenant_id = ? AND id = ? AND pay_method = 'card' AND pay_status = 'due' AND status IN ('awaiting_payment','open','scheduled') AND pay_tries < 900", [tenantId, r.id]);
  if (u.affectedRows !== 1) throw conflict('This request does not need a card payment now.');
  if (r.stripe_session_id) await stripe.expireCheckout(r.stripe_session_id, { account: r.processor_account || payee.account || null });
  const pay = connect.checkoutFor(payee, r.fee_cents, { tenant_id: String(tenantId), request_id: String(r.id), kind: 'cart', reference: r.reference });
  const link = viewLink(base, r.slug, r.view_token);
  const co = await stripe.createCheckout({
    amountCents: r.fee_cents, name: `${r.town}: ${KINDS[r.kind].toLowerCase()}`, description: `${r.size_gal}-gallon ${r.stream} cart for ${addressOf(r)}`.slice(0, 480),
    email: r.contact_email || undefined, reference: r.reference, ...pay, idempotencyKey: `cart-${r.id * 1000 + r.pay_tries + 1}`,
    successUrl: `${link}&paid=1`, cancelUrl: `${link}&unpaid=1`,
  });
  await pool.query('UPDATE cart_requests SET stripe_session_id = ?, processor_account = ? WHERE tenant_id = ? AND id = ?', [co.id, payee.account || null, tenantId, r.id]);
  return co.url;
}

/** Stripe told us a cart request's card page was paid or lapsed (metadata.kind 'cart', routed from routes/lessonbook.js). */
async function handleWebhook(event, obj, base) {
  const cardrefund = require('./cardrefund'); const connect = require('./connect');
  const tenantId = Number(obj.metadata.tenant_id); const id = Number(obj.metadata.request_id);
  if (event.type === 'checkout.session.expired') {
    await pool.query("UPDATE cart_requests SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND (stripe_session_id = ? OR stripe_session_id IS NULL)", [tenantId, id, obj.id]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  let failed = null; let stray = null;
  const out = await tx(async (conn) => {
    failed = null; stray = null;
    const row = await one(conn, 'SELECT * FROM cart_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!row) { logFailure({ job: 'stripe_webhook', tenant: tenantId, message: `a paid card page names cart request ${id}, which is not on file` }); return { ignored: true }; }
    if (row.payment_intent === String(obj.payment_intent) || await cardrefund.returned(conn, tenantId, obj.payment_intent)) return { duplicate: true };
    const waiting = row.pay_method === 'card' && row.pay_status === 'due' && !['cancelled', 'delivered'].includes(row.status);
    if (!waiting) { stray = row.status === 'cancelled' ? 'the cart request was canceled before the payment arrived' : 'the cart request was already settled'; return { problem: true }; }
    if (row.stripe_session_id && row.stripe_session_id !== obj.id) { stray = 'it was not the newest card page for this cart request'; return { problem: true }; }
    if (Number(obj.amount_total) !== Number(row.fee_cents)) { failed = 'the amount did not match'; return { problem: true }; }
    const paidTo = connect.paidTo(event);
    await conn.query(`UPDATE cart_requests SET status = IF(status IN ('awaiting_payment','expired'), 'open', status), pay_status = 'paid', paid_cents = ?, paid_at = UTC_TIMESTAMP(), payment_intent = ?, stripe_session_id = ?,
        processor_account = ?, platform_fee_cents = ? WHERE tenant_id = ? AND id = ?`,
    [Number(obj.amount_total), String(obj.payment_intent), obj.id, paidTo.account, paidTo.feeCents, tenantId, row.id]);
    await require('./audit').audit(conn, { auth: { tenantId, userId: null } }, 'cart_paid', 'cart_requests', row.id, { amount_cents: Number(obj.amount_total), reference: row.reference });
    return { ok: true };
  });
  if (stray) return cardrefund.returnStray({ tenantId, kind: 'cart', rowId: id, obj, account: event.account || null, why: stray });
  if (failed) {
    const owed = await tx((conn) => cardrefund.oweReturn(conn, { tenantId, kind: 'cart', rowId: id, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account: event.account || null, reason: failed }));
    if (owed) await cardrefund.sendReturn(owed);
    return { refunded: true };
  }
  if (out.ok) await tell(tenantId, id, 'confirm', base, { receipt: true });
  return { ok: Boolean(out.ok), duplicate: out.duplicate, ignored: out.ignored };
}

// ---------------------------------------------------------------- stock
/**
 * Changes the carts in the yard of one stream and size by delta, inside the caller's transaction, and writes the move.
 * Never below zero: a change that would go below zero is refused. Returns the count left.
 */
async function moveStock(conn, tenantId, { streamId, size, delta, reason, note = null, requestId = null, by = null }) {
  await conn.query('INSERT IGNORE INTO cart_stock (tenant_id, stream_id, size_gal, on_hand) VALUES (?, ?, ?, 0)', [tenantId, streamId, size]);
  const [u] = await conn.query('UPDATE cart_stock SET on_hand = CAST(on_hand AS SIGNED) + ? WHERE tenant_id = ? AND stream_id = ? AND size_gal = ? AND CAST(on_hand AS SIGNED) + ? >= 0',
    [delta, tenantId, streamId, size, delta]);
  if (u.affectedRows !== 1) {
    const s = await one(conn, 'SELECT name FROM collection_streams WHERE tenant_id = ? AND id = ?', [tenantId, streamId]);
    const left = await one(conn, 'SELECT on_hand FROM cart_stock WHERE tenant_id = ? AND stream_id = ? AND size_gal = ?', [tenantId, streamId, size]);
    const have = Number(left.on_hand); const what = `${size}-gallon ${s ? `${s.name} ` : ''}cart`;
    throw conflict(have === 0 ? `No ${what}s are in the yard. Receive carts first.` : `Only ${have} ${what}${have === 1 ? ' is' : 's are'} in the yard. Receive more carts first.`, { code: 'no_stock' });
  }
  const now = await one(conn, 'SELECT on_hand FROM cart_stock WHERE tenant_id = ? AND stream_id = ? AND size_gal = ?', [tenantId, streamId, size]);
  await conn.query('INSERT INTO cart_stock_moves (tenant_id, stream_id, size_gal, delta, reason, note, request_id, on_hand, by_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, streamId, size, delta, reason, note, requestId, Number(now.on_hand), by]);
  return Number(now.on_hand);
}

const stockOf = (db, tenantId) => rows(db, `SELECT k.stream_id, s.name AS stream, k.size_gal, k.on_hand FROM cart_stock k JOIN collection_streams s ON s.tenant_id = k.tenant_id AND s.id = k.stream_id
  WHERE k.tenant_id = ? ORDER BY s.sort, s.id, k.size_gal`, [tenantId]).then((r) => r.map((x) => ({ ...x, stream_id: Number(x.stream_id), size_gal: Number(x.size_gal), on_hand: Number(x.on_hand) })));

// ---------------------------------------------------------------- delivery
/**
 * The cart deliveries planned for a date, for the crew's stop list and (with Collection routes) that day's route:
 * [{ id, reference, kind, stream_id, stream, size_gal, street_id, street, house_number, unit, address, delivered }].
 * Addresses only, never the resident's name or contact.
 */
async function cartStopsFor(conn, tenantId, date) {
  const list = await rows(conn, `SELECT r.id, r.reference, r.kind, r.stream_id, cs.name AS stream, r.size_gal, r.street_id, st.name AS street, r.house_number, r.unit, r.status, r.note
    FROM cart_requests r JOIN streets st ON st.tenant_id = r.tenant_id AND st.id = r.street_id JOIN collection_streams cs ON cs.tenant_id = r.tenant_id AND cs.id = r.stream_id
    WHERE r.tenant_id = ? AND r.deliver_on = ? AND r.status IN ('scheduled','delivered') ORDER BY st.name, r.house_no, r.house_number, r.id`, [tenantId, date]);
  return list.map((r) => ({ id: Number(r.id), reference: r.reference, kind: r.kind, kind_label: KINDS[r.kind], stream_id: Number(r.stream_id), stream: r.stream, size_gal: Number(r.size_gal),
    street_id: Number(r.street_id), street: r.street, house_number: r.house_number, unit: r.unit, address: addressOf(r), delivered: r.status === 'delivered' }));
}

/** Cart requests waiting for the office to give them a delivery day: the Today card and the menu's count both use this. */
async function waitingCount(db, tenantId) {
  const r = await one(db, "SELECT COUNT(*) AS n FROM cart_requests WHERE tenant_id = ? AND status = 'open'", [tenantId]);
  return Number(r.n);
}

/** Carts in use by stream and size, and by stream and collection zone (an address no zone covers counts as "No zone"). */
async function counts(db, tenantId) {
  const by = await rows(db, `SELECT c.stream_id, s.name AS stream, c.size_gal, COUNT(*) AS n FROM carts c JOIN collection_streams s ON s.tenant_id = c.tenant_id AND s.id = c.stream_id
    WHERE c.tenant_id = ? AND c.status = 'in_use' GROUP BY c.stream_id, s.name, c.size_gal ORDER BY MIN(s.sort), c.stream_id, c.size_gal`, [tenantId]);
  const addrs = await rows(db, `SELECT c.street_id, c.house_no, c.stream_id, s.name AS stream, COUNT(*) AS n FROM carts c JOIN collection_streams s ON s.tenant_id = c.tenant_id AND s.id = c.stream_id
    WHERE c.tenant_id = ? AND c.status = 'in_use' GROUP BY c.street_id, c.house_no, c.stream_id, s.name`, [tenantId]);
  const zoneOf = new Map(); const zones = new Map();
  for (const a of addrs) {
    const k = `${a.street_id}|${a.house_no}`;
    if (!zoneOf.has(k)) zoneOf.set(k, await collection().zoneFor(db, tenantId, { streetId: Number(a.street_id), houseNo: a.house_no === null ? null : Number(a.house_no) }));
    const z = zoneOf.get(k);
    const name = z && z.zoneId ? z.zoneName : z && z.notCollected ? 'Not collected' : 'No zone';
    const key = `${name}|${a.stream_id}`;
    const cur = zones.get(key) || { zone: name, zone_id: z && z.zoneId ? z.zoneId : null, stream_id: Number(a.stream_id), stream: a.stream, carts: 0 };
    cur.carts += Number(a.n); zones.set(key, cur);
  }
  return {
    by_size: by.map((x) => ({ stream_id: Number(x.stream_id), stream: x.stream, size_gal: Number(x.size_gal), carts: Number(x.n) })),
    by_zone: [...zones.values()].sort((a, b) => (a.zone_id === null) - (b.zone_id === null) || a.zone.localeCompare(b.zone) || a.stream.localeCompare(b.stream)),
  };
}

/** Carts delivered between two dates (inclusive), for the monthly report. */
async function deliveredBetween(db, tenantId, from, to) {
  const r = await one(db, "SELECT COUNT(*) AS n FROM cart_requests WHERE tenant_id = ? AND status = 'delivered' AND deliver_on BETWEEN ? AND ?", [tenantId, from, to]);
  return Number(r.n);
}

/** Card pages nobody paid for a day are let go (the webhook normally does it first). Run by the daily job. */
async function expireUnpaid() {
  const [r] = await pool.query("UPDATE cart_requests SET status = 'expired' WHERE status = 'awaiting_payment' AND updated_at < UTC_TIMESTAMP() - INTERVAL 1 DAY");
  return { expired: r.affectedRows };
}

const todayOf = async (db, tenantId) => todayIn((await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
const requestOf = async (db, tenantId, id, { lock = false } = {}) => {
  const r = await one(db, `SELECT * FROM cart_requests WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!r) throw notFound('Cart request');
  return r;
};

module.exports = {
  SIZES, KINDS, KIND_KEYS, OPEN, DEFAULT_RULES, collection, settingsOf, streamsOf, optionsOf, feeOf, optionFor, streetOk, serviceAddressAt, addressOf, cartsAt, checksFor, contactOf,
  insertRequest, fullOf, pageLink, viewLink, cardReady, words, tell, oweCardRefund, sendRefund, checkout, handleWebhook, moveStock, stockOf, cartStopsFor, waitingCount, counts,
  deliveredBetween, expireUnpaid, todayOf, requestOf, houseNo,
};
