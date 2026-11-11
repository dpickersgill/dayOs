'use strict';

// Bulk trash pickup (muni release 1, Trash and recycling app): residents book a pickup of large items for a collection
// day, by a weekly cutoff, and pay by size online (the municipality's own Stripe account), with stickers, or at the office.
// The crew works the day's stop list and marks each stop Picked up, Not out or Not accepted.
//
// The rules, in one place:
//   Collection days   weekdays (0 Sunday to 6 Saturday). A skip date (a holiday) has no pickup on it.
//   Cutoff            bookings for a collection day close cutoff_days_before days ahead at cutoff_time, on the
//                     municipality's own clock (Monday's pickup closes at noon Thursday). Staff may book later.
//   Capacity          stops a day. A booking counts once it is booked, or while its card page is open (40 minutes).
//   Cancel            the resident may cancel before the cutoff: a card payment goes back in full through the
//                     municipality's Stripe account (lib/cardrefund.js, the shop's refund path). After it, staff decide.
//   Not out           the crew needs a photo; the resident is told by text or email only if they said yes, never with the photo.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { todayIn, nowIn, addDays, weekdayOf, clock } = require('./util');
const { money } = require('./format');
const { logFailure } = require('./jobs');

const HOLD_MINUTES = 40; // an unpaid card page holds its stop this long (Stripe's page lasts 31 minutes)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () => Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');
const token = () => crypto.randomBytes(16).toString('hex');
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DEFAULT_RULES = [
  'Put items at the curb by 6:00 AM on collection day, and not before 6:00 PM the night before.',
  'We take furniture, mattresses (wrapped in plastic), carpet (rolled, under 4 feet, tied), and large household items.',
  'We do not take tires, paint, chemicals, propane tanks, TVs, computers or other electronics, or building debris.',
  'Refrigerators, freezers and air conditioners need a sticker showing the refrigerant was removed.',
].join('\n');
const DEFAULT_SIZES = [
  ['Small', 'One person can carry it: a chair, a small table, a rolled rug.', 1500, 5],
  ['Medium', 'Two people carry it: a loveseat, a dresser, a mattress or box spring.', 2500, 5],
  ['Large', 'A sofa, a sectional piece, a recliner, a large cabinet.', 3500, 3],
  ['Metal', 'Metal only: a bike, a grill without its propane tank, metal shelves or furniture, a water heater.', 0, 5],
];

/** The settings row as the app uses it. */
function shape(s) {
  return {
    online: Boolean(s.online), collection_days: String(s.collection_days || '').split(',').filter((x) => /^[0-6]$/.test(x)).map(Number).sort(),
    cutoff_days_before: Number(s.cutoff_days_before), cutoff_time: String(s.cutoff_time).slice(0, 5), capacity: Number(s.capacity), curb_by: String(s.curb_by).slice(0, 5),
    pay_card: Boolean(s.pay_card), pay_stickers: Boolean(s.pay_stickers), office_name: s.office_name, rules_text: s.rules_text || '', not_out_policy: s.not_out_policy,
  };
}

/** The municipality's bulk pickup settings, made with the defaults (Monday, noon Thursday, 40 stops, four sizes) the first time. */
async function settingsOf(tenantId, db = pool) {
  let s = await one(db, 'SELECT * FROM bulk_settings WHERE tenant_id = ?', [tenantId]);
  if (!s) {
    await tx(async (conn) => {
      const [r] = await conn.query('INSERT IGNORE INTO bulk_settings (tenant_id, rules_text) VALUES (?, ?)', [tenantId, DEFAULT_RULES]);
      if (r.affectedRows !== 1) return;
      const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM bulk_sizes WHERE tenant_id = ?', [tenantId]);
      if (Number(n.n)) return;
      for (const [i, [name, description, price, max]] of DEFAULT_SIZES.entries()) {
        await conn.query('INSERT INTO bulk_sizes (tenant_id, name, description, price_cents, max_qty, sort) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, name, description, price, max, i + 1]);
      }
    });
    s = await one(db, 'SELECT * FROM bulk_settings WHERE tenant_id = ?', [tenantId]);
  }
  return shape(s);
}

const sizesOf = (db, tenantId, { all = false } = {}) => rows(db, `SELECT id, name, description, price_cents, max_qty, sort, active FROM bulk_sizes WHERE tenant_id = ?${all ? '' : ' AND active = 1'} ORDER BY sort, id`, [tenantId])
  .then((r) => r.map((x) => ({ ...x, active: Boolean(x.active) })));

/** The moment bookings for a collection day close, on the municipality's clock: 'YYYY-MM-DD HH:MM:SS'. */
const cutoffOf = (s, date) => `${addDays(date, -s.cutoff_days_before)} ${s.cutoff_time}:00`;

/** "Monday, Nov 16" */
function longDay(date) {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}
/** "noon Thursday, Nov 12" style words for a cutoff: "Thursday, Nov 12 at 12:00 PM". */
const cutoffWords = (at) => `${longDay(at.slice(0, 10))} at ${clock(at)}`;

/** Stops taken on each day between from and to (booked, or a card page still open). Map date -> count. */
async function takenOn(db, tenantId, from, to) {
  const r = await rows(db, `SELECT collection_date AS d, COUNT(*) AS n FROM bulk_bookings WHERE tenant_id = ? AND collection_date BETWEEN ? AND ?
    AND (status = 'booked' OR (status = 'awaiting_payment' AND held_until > UTC_TIMESTAMP())) GROUP BY collection_date`, [tenantId, from, to]);
  return new Map(r.map((x) => [String(x.d).slice(0, 10), Number(x.n)]));
}

/**
 * The collection days from today for `days` days, each with its cutoff and whether a resident can still book it:
 * [{ date, cutoff_at, closed, skipped, note, booked, capacity, left, available }]. now: the municipality's wall clock.
 */
async function calendar(db, tenantId, s, tz, { days = 42, now = null } = {}) {
  const today = todayIn(tz);
  const clockNow = now || nowIn(tz);
  const end = addDays(today, days);
  const skips = new Map((await rows(db, 'SELECT on_date, note FROM bulk_skip_dates WHERE tenant_id = ? AND on_date BETWEEN ? AND ?', [tenantId, today, end])).map((x) => [String(x.on_date).slice(0, 10), x.note || '']));
  const taken = await takenOn(db, tenantId, today, end);
  const out = [];
  for (let d = today; d <= end; d = addDays(d, 1)) {
    if (!s.collection_days.includes(weekdayOf(d))) continue;
    const cutoff = cutoffOf(s, d);
    const booked = taken.get(d) || 0;
    const skipped = skips.has(d);
    const closed = clockNow >= cutoff;
    const left = Math.max(s.capacity - booked, 0);
    out.push({ date: d, cutoff_at: cutoff, closed, skipped, note: skipped ? skips.get(d) : null, booked, capacity: s.capacity, left, available: !closed && !skipped && left > 0 });
  }
  return out;
}

/** Why a resident cannot book this day, or null when they can. */
function whyNot(day) {
  if (!day) return 'Pick one of the collection days shown.';
  if (day.skipped) return `There is no pickup on ${longDay(day.date)}${day.note ? ` (${day.note})` : ''}. Pick another day.`;
  if (day.closed) return `Booking for ${longDay(day.date)} closed ${cutoffWords(day.cutoff_at)}. Pick a later day.`;
  if (day.left <= 0) return `${longDay(day.date)} is full. Pick another day.`;
  return null;
}

/** Locks the municipality's settings row, so two people cannot both take the last stop of a day. */
const lockDay = (conn, tenantId) => conn.query('SELECT id FROM bulk_settings WHERE tenant_id = ? FOR UPDATE', [tenantId]);

/** Prices the items: [{ size_id, quantity }] -> { lines: [{ size_id, name, unit_cents, quantity }], total }. Refuses a size not on offer or too many. */
async function price(conn, tenantId, items) {
  const sizes = new Map((await sizesOf(conn, tenantId)).map((x) => [Number(x.id), x]));
  const merged = new Map();
  for (const it of items) merged.set(Number(it.size_id), (merged.get(Number(it.size_id)) || 0) + Number(it.quantity));
  const lines = [];
  for (const [sizeId, qty] of merged) {
    if (!qty) continue;
    const z = sizes.get(sizeId);
    if (!z) throw require('./errors').bad('One of those item sizes is not offered any more. Reload the page and pick again.');
    if (qty > z.max_qty) throw require('./errors').bad(`${z.name}: up to ${z.max_qty} for one pickup. For more, call the office.`);
    lines.push({ size_id: sizeId, name: z.name, unit_cents: Number(z.price_cents), quantity: qty, sort: z.sort });
  }
  if (!lines.length) throw require('./errors').bad('Add at least one item');
  lines.sort((a, b) => a.sort - b.sort);
  return { lines: lines.map(({ sort, ...l }) => l), total: lines.reduce((n, l) => n + l.unit_cents * l.quantity, 0) };
}

/** Adds a booking and its items inside the caller's transaction. Returns { id, reference, view_token }. */
async function insertBooking(conn, tenantId, b, lines) {
  for (let attempt = 0; ; attempt += 1) {
    const ref = reference(); const tok = token();
    try {
      const [r] = await conn.query(`INSERT INTO bulk_bookings (tenant_id, reference, view_token, collection_date, street_id, house_number, unit, resident_id, items_note, source, status,
          pay_method, pay_status, total_cents, paid_cents, paid_at, held_until, texts_ok, emails_ok, credit_from_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(?, UTC_TIMESTAMP(), NULL), IF(? = 'awaiting_payment', UTC_TIMESTAMP() + INTERVAL ${HOLD_MINUTES} MINUTE, NULL), ?, ?, ?, ?)`,
      [tenantId, ref, tok, b.collection_date, b.street_id, b.house_number, b.unit || null, b.resident_id, b.items_note || null, b.source, b.status,
        b.pay_method, b.pay_status, b.total_cents, b.paid_cents || 0, b.paid_cents ? 1 : 0, b.status, b.texts_ok ? 1 : 0, b.emails_ok ? 1 : 0, b.credit_from_id || null, b.created_by || null]);
      for (const l of lines) {
        await conn.query('INSERT INTO bulk_booking_items (tenant_id, booking_id, size_id, name, unit_cents, quantity) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, r.insertId, l.size_id, l.name, l.unit_cents, l.quantity]);
      }
      return { id: Number(r.insertId), reference: ref, view_token: tok };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
}

const itemsOf = (db, tenantId, bookingIds) => (bookingIds.length ? rows(db, 'SELECT booking_id, size_id, name, unit_cents, quantity FROM bulk_booking_items WHERE tenant_id = ? AND booking_id IN (?) ORDER BY id', [tenantId, bookingIds]) : Promise.resolve([]));
const itemsText = (items) => items.map((i) => `${i.quantity} ${i.name}`).join(', ');
const addressOf = (b) => `${b.house_number} ${b.street}${b.unit ? `, ${b.unit}` : ''}`;
const pageLink = (base, slug) => `${base}/bulk-pickup/${encodeURIComponent(slug)}`;
const viewLink = (base, slug, tok) => `${pageLink(base, slug)}?booking=${tok}`;

/** Can this municipality take a card payment now? Its own connected Stripe account, ready, and not a demo. */
async function cardReady(tenantId) {
  if (await require('./sandbox').isSandbox(tenantId)) return false;
  return (await require('./connect').payee(tenantId)).ok;
}

// ---------------------------------------------------------------- telling the resident
/**
 * The ways this resident may be reached for this booking: a text when they said yes to texts (on the booking and still on
 * file: a STOP texted back turns it off until they text START, lib/residents.js) and the phone has not said no; an email
 * when they said yes to emails.
 * receipt: an email confirmation or payment link goes to the email they gave even without a yes to reminders.
 */
async function channelsFor(b, { receipt = false } = {}) {
  const sms = require('./sms'); const mailer = require('./mailer');
  const out = [];
  const key = sms.phoneKey(b.phone);
  if (b.texts_ok && key && sms.enabled() && await require('./residents').textsAllowed(pool, b.tenant_id, { texts_ok: b.r_texts_ok, phone: b.phone })) out.push('text');
  if (b.email && mailer.enabled() && (receipt || (b.emails_ok && b.r_emails_ok))) out.push('email');
  return out;
}

const FULL = `SELECT b.*, s.name AS street, r.name, r.phone, r.email, r.texts_ok AS r_texts_ok, r.emails_ok AS r_emails_ok, t.name AS town, t.slug, t.phone AS town_phone, t.timezone
  FROM bulk_bookings b JOIN streets s ON s.tenant_id = b.tenant_id AND s.id = b.street_id LEFT JOIN residents r ON r.tenant_id = b.tenant_id AND r.id = b.resident_id
  JOIN tenants t ON t.id = b.tenant_id`;
const fullOf = (db, tenantId, id) => one(db, `${FULL} WHERE b.tenant_id = ? AND b.id = ?`, [tenantId, id]);

/** The words of each message. kind: confirm, reminder, not_out, not_accepted, pay_link, cancelled. */
function words(kind, b, items, s, base) {
  const link = viewLink(base, b.slug, b.view_token);
  const day = longDay(b.collection_date);
  const where = addressOf(b);
  const call = b.town_phone ? ` Questions? Call ${b.town_phone}.` : '';
  const what = itemsText(items);
  switch (kind) {
    case 'confirm': {
      const pay = b.pay_status === 'paid' ? `Paid ${money(b.paid_cents)}.` : b.pay_method === 'stickers' ? 'Put a bulk pickup sticker on each item.' : b.pay_status === 'due' ? `Please pay ${money(b.total_cents)} at ${s.office_name} before collection day.` : '';
      return { subject: `Bulk pickup booked for ${day}`, text: `${b.town}: your bulk pickup is booked for ${day} at ${where} (${what}). Reference ${b.reference}. ${pay} Put items at the curb by ${clock(s.curb_by)} that morning. You can cancel until ${cutoffWords(cutoffOf(s, b.collection_date))}: ${link}${call}` };
    }
    case 'reminder':
      return { subject: `Bulk pickup tomorrow, ${day}`, text: `${b.town}: put your items at the curb by ${clock(s.curb_by)} ${day} for bulk pickup at ${where} (${what}). Reference ${b.reference}.${b.pay_method === 'stickers' ? ' Put a sticker on each item.' : ''} ${link}${call}` };
    case 'not_out':
      return { subject: `Bulk pickup: nothing was out at ${where}`, text: `${b.town}: the crew came by ${where} for your bulk pickup on ${day} and nothing was out at the curb. Reference ${b.reference}. To book again: ${pageLink(base, b.slug)}${call}` };
    case 'not_accepted':
      return { subject: `Bulk pickup: some items were left at ${where}`, text: `${b.town}: the crew could not take items at ${where} on ${day}. Reason: ${b.outcome_reason || 'not accepted for bulk pickup'}. Reference ${b.reference}.${call}` };
    case 'pay_link':
      return { subject: `Pay for your bulk pickup on ${day}`, text: `${b.town}: your bulk pickup on ${day} at ${where} (${what}) is ${money(b.total_cents)}. Pay by card here: ${link} Reference ${b.reference}.${call}` };
    case 'cancelled':
      return { subject: `Bulk pickup canceled for ${day}`, text: `${b.town}: your bulk pickup on ${day} at ${where} is canceled. Reference ${b.reference}.${b.pay_status === 'refunded' ? ` ${money(b.refunded_cents)} is going back to your card; it can take 5 to 10 days to show.` : b.pay_status === 'refund_due' ? ` Your refund is waiting at ${s.office_name}.` : ''}${call}` };
    default: throw new Error(`no message ${kind}`);
  }
}

/**
 * Tells the resident about their booking, by the ways they agreed to. Returns the channels used (empty when none).
 * Never throws: a message that cannot go out is logged without the resident's details.
 */
async function tell(tenantId, bookingId, kind, base, { receipt = false, only = null } = {}) {
  try {
    const b = await fullOf(pool, tenantId, bookingId);
    if (!b || !b.resident_id) return [];
    const s = await settingsOf(tenantId);
    const items = await itemsOf(pool, tenantId, [b.id]);
    const w = words(kind, b, items, s, base);
    const sent = [];
    for (const ch of await channelsFor(b, { receipt })) {
      if (only && ch !== only) continue;
      if (ch === 'text') {
        const r = await require('./sms').send({ tenantId, to: b.phone, body: w.text, from: await require('./residents').fromNumber(pool, tenantId), tag: `bulk-${kind}` }); // the municipality's own texting number when it has one
        if (r.ok) sent.push('text');
      } else {
        const r = await require('./mailer').send({ tenantId, to: b.email, fromName: b.town, subject: w.subject, text: w.text, tag: `bulk-${kind}` });
        if (r.ok) sent.push('email');
      }
    }
    return sent;
  } catch (err) {
    logFailure({ job: 'bulk_pickup', tenant: tenantId, booking: bookingId, message: `could not send the ${kind} message: ${err.message}` });
    return [];
  }
}

// ---------------------------------------------------------------- money back
/**
 * Writes a full card refund of the booking's payment as owed, inside the caller's transaction (lib/cardrefund.js, the
 * same path the shop and lessons use: written first, sent after the commit, retried by the daily job). Returns the
 * card_returns id to send, or null when there is no card payment to give back.
 */
async function oweCardRefund(conn, b, reason) {
  if (b.pay_method !== 'card' || b.pay_status !== 'paid' || !b.payment_intent || !(b.paid_cents > 0)) return null;
  const id = await require('./cardrefund').oweReturn(conn, { tenantId: b.tenant_id, kind: 'bulk', rowId: b.id, session: b.stripe_session_id, paymentIntent: b.payment_intent, amountCents: b.paid_cents, account: b.processor_account, reason });
  await conn.query("UPDATE bulk_bookings SET pay_status = 'refunded', refunded_cents = paid_cents WHERE tenant_id = ? AND id = ?", [b.tenant_id, b.id]);
  return id;
}
const sendRefund = (id) => (id ? require('./cardrefund').sendReturn(id) : null);

// ---------------------------------------------------------------- Stripe
/**
 * A card page for a booking that is waiting for its card payment. Each try is its own page; the one before it is closed,
 * so only the newest can be paid (a payment on an older one goes back in full). Returns the page's address.
 */
async function checkout(tenantId, bookingId, base) {
  const connect = require('./connect'); const stripe = require('./stripe');
  const b = await fullOf(pool, tenantId, bookingId);
  const payee = await connect.payeeOrThrow(tenantId);
  const items = await itemsOf(pool, tenantId, [b.id]);
  const [u] = await pool.query("UPDATE bulk_bookings SET pay_tries = pay_tries + 1 WHERE tenant_id = ? AND id = ? AND pay_method = 'card' AND pay_status = 'due' AND status IN ('awaiting_payment','booked') AND pay_tries < 900", [tenantId, b.id]);
  if (u.affectedRows !== 1) throw require('./errors').conflict('This pickup does not need a card payment now.');
  const tries = b.pay_tries + 1;
  if (b.stripe_session_id) await stripe.expireCheckout(b.stripe_session_id, { account: b.processor_account || payee.account || null });
  const pay = connect.checkoutFor(payee, b.total_cents, { tenant_id: String(tenantId), booking_id: String(b.id), kind: 'bulk', reference: b.reference });
  const link = viewLink(base, b.slug, b.view_token);
  const co = await stripe.createCheckout({
    amountCents: b.total_cents, name: `${b.town}: bulk pickup ${longDay(b.collection_date)}`, description: itemsText(items).slice(0, 480),
    email: b.email || undefined, reference: b.reference, ...pay, idempotencyKey: `bulk-${b.id * 1000 + tries}`,
    successUrl: `${link}&paid=1`, cancelUrl: `${link}&unpaid=1`,
  });
  await pool.query('UPDATE bulk_bookings SET stripe_session_id = ?, processor_account = ? WHERE tenant_id = ? AND id = ?', [co.id, payee.account || null, tenantId, b.id]);
  return co.url;
}

class Unhonourable extends Error {}

/** Stripe told us a bulk pickup's card page was paid or lapsed (metadata.kind 'bulk', routed from routes/lessonbook.js). */
async function handleWebhook(event, obj, base) {
  const cardrefund = require('./cardrefund'); const connect = require('./connect');
  const tenantId = Number(obj.metadata.tenant_id); const id = Number(obj.metadata.booking_id);
  if (event.type === 'checkout.session.expired') {
    await pool.query("UPDATE bulk_bookings SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND (stripe_session_id = ? OR stripe_session_id IS NULL)", [tenantId, id, obj.id]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  let failed = null; let stray = null; let out;
  try {
    out = await tx(async (conn) => {
      failed = null; stray = null;
      await lockDay(conn, tenantId);
      const row = await one(conn, 'SELECT * FROM bulk_bookings WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
      if (!row) { logFailure({ job: 'stripe_webhook', tenant: tenantId, message: `a paid card page names bulk pickup ${id}, which is not on file` }); return { ignored: true }; }
      if (row.payment_intent === String(obj.payment_intent) || await cardrefund.returned(conn, tenantId, obj.payment_intent)) return { duplicate: true };
      // Only a booking still waiting for this card payment, on its newest card page. Anything else goes back in full.
      const waiting = row.pay_method === 'card' && row.pay_status === 'due' && row.status !== 'cancelled';
      if (!waiting) { stray = row.status === 'cancelled' ? 'the pickup was canceled before the payment arrived' : 'the pickup was already settled'; return { problem: true }; }
      if (row.stripe_session_id && row.stripe_session_id !== obj.id) { stray = 'it was not the newest card page for this pickup'; return { problem: true }; }
      if (Number(obj.amount_total) !== Number(row.total_cents)) { failed = 'the amount did not match'; return { problem: true }; }
      if (row.status === 'expired') {
        // The page lapsed on our side but the resident paid: the stop is theirs if the day still has room and is still open.
        const s = await settingsOf(tenantId, conn);
        const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
        const day = (await calendar(conn, tenantId, s, tz, { days: 120 })).find((d) => d.date === String(row.collection_date).slice(0, 10));
        if (!day || day.skipped || day.closed || day.left <= 0) throw new Unhonourable('the day filled up or closed while the card page was open');
      }
      const paidTo = connect.paidTo(event);
      await conn.query(`UPDATE bulk_bookings SET status = 'booked', pay_status = 'paid', paid_cents = ?, paid_at = UTC_TIMESTAMP(), payment_intent = ?, stripe_session_id = ?,
          processor_account = ?, platform_fee_cents = ? WHERE tenant_id = ? AND id = ?`,
      [Number(obj.amount_total), String(obj.payment_intent), obj.id, paidTo.account, paidTo.feeCents, tenantId, row.id]);
      await require('./audit').audit(conn, { auth: { tenantId, userId: null } }, 'bulk_paid', 'bulk_bookings', row.id, { amount_cents: Number(obj.amount_total), reference: row.reference });
      return { ok: true };
    });
  } catch (err) {
    if (!(err instanceof Unhonourable)) throw err;
    failed = err.message; out = { problem: true };
  }
  if (stray) return cardrefund.returnStray({ tenantId, kind: 'bulk', rowId: id, obj, account: event.account || null, why: stray });
  if (failed) {
    const owed = await tx(async (conn) => {
      const [u] = await conn.query("UPDATE bulk_bookings SET status = IF(status = 'booked', status, 'expired'), cancel_reason = ? WHERE tenant_id = ? AND id = ?", [`Card payment refunded: ${failed}`.slice(0, 200), tenantId, id]);
      if (u.affectedRows !== 1) return null;
      return cardrefund.oweReturn(conn, { tenantId, kind: 'bulk', rowId: id, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account: event.account || null, reason: failed });
    });
    if (owed) await cardrefund.sendReturn(owed);
    return { refunded: true };
  }
  if (out.ok) await tell(tenantId, id, 'confirm', base, { receipt: true });
  return { ok: Boolean(out.ok), duplicate: out.duplicate, ignored: out.ignored };
}

// ---------------------------------------------------------------- the reminder the day before
/**
 * Reminds residents who said yes, the afternoon before their collection day (from 3:00 PM to 9:00 PM on the municipality's
 * clock). Each booking is claimed before it is sent, so two runs never send twice. Run by the 5-minute guests job.
 */
async function remindDue(base, { now = null } = {}) {
  const out = { reminded: 0 };
  const towns = await rows(pool, `SELECT DISTINCT b.tenant_id, t.timezone FROM bulk_bookings b JOIN tenants t ON t.id = b.tenant_id
    WHERE b.status = 'booked' AND b.reminded_at IS NULL AND b.collection_date BETWEEN UTC_DATE() - INTERVAL 1 DAY AND UTC_DATE() + INTERVAL 2 DAY
      AND (b.texts_ok = 1 OR b.emails_ok = 1) AND t.status = 'active'`);
  for (const t of towns) {
    const st = await require('./modules').stateOf(t.tenant_id);
    if (!st.on.has('solidwaste')) continue;
    const clockNow = now || nowIn(t.timezone);
    const hour = Number(clockNow.slice(11, 13));
    if (hour < 15 || hour >= 21) continue;
    const tomorrow = addDays(clockNow.slice(0, 10), 1);
    const due = await rows(pool, "SELECT id FROM bulk_bookings WHERE tenant_id = ? AND collection_date = ? AND status = 'booked' AND reminded_at IS NULL AND (texts_ok = 1 OR emails_ok = 1) ORDER BY id LIMIT 500", [t.tenant_id, tomorrow]);
    for (const d of due) {
      const [claim] = await pool.query('UPDATE bulk_bookings SET reminded_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND reminded_at IS NULL', [t.tenant_id, d.id]);
      if (!claim.affectedRows) continue;
      if ((await tell(t.tenant_id, d.id, 'reminder', base)).length) out.reminded += 1;
    }
  }
  return out;
}

module.exports = {
  HOLD_MINUTES, DAY_NAMES, DEFAULT_SIZES, DEFAULT_RULES, settingsOf, sizesOf, cutoffOf, cutoffWords, longDay, calendar, whyNot, lockDay, price, insertBooking,
  itemsOf, itemsText, addressOf, pageLink, viewLink, cardReady, channelsFor, fullOf, tell, words, oweCardRefund, sendRefund, checkout, handleWebhook, remindDue,
};
