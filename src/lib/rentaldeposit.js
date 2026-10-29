'use strict';

// Rental deposits held on the guest's card, on the counter's card reader (Stripe Terminal, server-driven, the same way
// routes/terminal.js takes a counter sale), on the mountain's own Stripe account (lib/connect.js).
//
// What Stripe says about how long a hold lasts (checked October 2026,
// https://docs.stripe.com/payments/place-a-hold-on-a-payment-method, "Authorization validity windows"):
//   Card-present (in-person) authorizations: Visa 5 days (exactly 4 days 18 hours), Mastercard, American Express and
//   Discover 2 days. "If the authorization expires before you capture the funds, the funds are released and the payment
//   status changes to canceled." A partial capture (amount_to_capture) releases the rest, and only one capture is allowed.
//   The charge's payment_method_details.card_present.capture_before, when Stripe sends it, says exactly when it ends.
// We cannot know the card brand before the guest taps, so we plan for the shortest window (2 days):
//   - A day rental due back within HOLD_SAFE_HOURS (36 hours) of the hand-out gets a hold: a PaymentIntent with
//     capture_method manual on card_present. That leaves at least 12 hours after the due time to settle it.
//   - Anything longer, and every season rental, saves the card instead and takes nothing now: a SetupIntent for a
//     Stripe Customer, run on the reader with process_setup_intent (allow_redisplay 'limited'; see
//     https://docs.stripe.com/api/terminal/readers/process_setup_intent and
//     https://docs.stripe.com/terminal/features/saving-payment-details/save-directly). Stripe attaches the reusable
//     card it makes from the tapped card ("generated_card" on the SetupIntent's latest_attempt
//     payment_method_details.card_present) to the Customer. If gear is not returned or fees are owed, staff confirm and
//     we charge that card off-session (off_session true, confirm true). With nothing owed the card is detached.
// The daily job flags holds within a day of their end while gear is still out (Out now shows a warning) and records a
// hold Stripe has let go. When the card service is not set up, or the reader is offline, the counter falls back to a
// note deposit (rental_charges kind 'deposit', as before) and says so.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { logFailure } = require('./jobs');
const { AppError, bad, notFound, conflict, forbidden } = require('./errors');
const { audit } = require('./audit');
const { nowIn, localTime } = require('./util');
const config = require('../config');
const stripe = require('./stripe');
const connect = require('./connect');

const HOLD_SAFE_HOURS = 36;
const HOLD_HOURS = { visa: 114, other: 48 }; // 4 days 18 hours for Visa, 2 days for the rest
const ACTIVE = ['waiting', 'held', 'saved'];
const testMode = () => /^(sk|rk)_test_/.test(config.stripe.secretKey || '');
const BRANDS = new Set(['visa', 'mastercard', 'amex', 'discover']);
const brandOf = (b) => (BRANDS.has(String(b || '').toLowerCase()) ? String(b).toLowerCase() : (b ? 'other' : null));
const BRAND_NAME = { visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', other: 'Card' };
const cardText = (brand, last4) => (last4 ? `${BRAND_NAME[brand] || 'Card'} ending ${last4}` : null);
const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const msOf = (s) => Date.parse(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);
const robot = (tenantId) => ({ auth: { tenantId, userId: null }, ip: null });

function needStripe() {
  if (!stripe.enabled()) throw new AppError(503, 'Card deposits are not set up yet. Connect Stripe under Billing first, or take a note deposit.', { fallback: 'note' });
}
async function sc(path, body, opts) {
  const r = await stripe.tryCall(path, body, opts);
  if (!r.ok) throw new AppError(r.status && r.status < 500 ? 400 : 502, `The card service said: ${r.error}`);
  return r.json;
}

/** Hold or save: a hold only for a day rental due back soon enough that the shortest card-present hold outlasts it. */
function planFor(contract, timeZone) {
  if (contract.kind === 'season') return 'saved';
  const due = contract.due_at instanceof Date ? utc(contract.due_at) : String(contract.due_at);
  const hours = (msOf(due) - msOf(nowIn(timeZone))) / 3600000;
  return hours <= HOLD_SAFE_HOURS ? 'hold' : 'saved';
}

/** Whether card deposits can be taken here now, and with which readers. For the counter to choose before it asks. */
async function readiness(tenantId) {
  const p = await connect.payee(tenantId);
  const readers = await rows(pool, 'SELECT id, label, simulated, account FROM terminal_readers WHERE tenant_id = ? AND active = 1 ORDER BY label, id', [tenantId]);
  const usable = p.ok ? readers.filter((r) => (r.account || null) === (p.account || null)) : [];
  const why = !stripe.enabled() || !p.ok ? 'The card service is not set up for this mountain.' : !usable.length ? 'No card reader is paired. A manager pairs one under Billing.' : null;
  return { ready: !why, why, test_mode: testMode(), readers: usable.map((r) => ({ id: Number(r.id), label: r.label, simulated: Boolean(Number(r.simulated)) })) };
}

const shape = (d) => d && ({
  id: Number(d.id), contract_id: Number(d.contract_id), kind: d.kind, status: d.status, amount_cents: Number(d.amount_cents), taken_cents: Number(d.taken_cents),
  failure: d.failure || null, card_brand: d.card_brand || null, card_last4: d.card_last4 || null, card: cardText(d.card_brand, d.card_last4),
  expires_at: d.expires_at || null, created_at: d.created_at,
});
const rowOf = (tenantId, id) => one(pool, 'SELECT * FROM rental_deposits WHERE tenant_id = ? AND id = ?', [tenantId, id]);
const activeFor = (conn, tenantId, contractId) => one(conn, `SELECT * FROM rental_deposits WHERE tenant_id = ? AND contract_id = ? AND status IN ('waiting','held','saved') ORDER BY id DESC LIMIT 1`, [tenantId, contractId]);

/** The contract's summary columns follow the deposit row. */
async function mirror(conn, d) {
  const status = { waiting: 'pending', held: 'held', saved: 'held', released: 'released', captured: 'captured', charged: 'captured', failed: 'failed', canceled: 'none', expired: 'failed' }[d.status];
  const mode = d.status === 'canceled' ? 'none' : d.kind === 'hold' ? 'card_hold' : 'card_saved';
  await conn.query('UPDATE rental_contracts SET deposit_mode = ?, deposit_status = ?, deposit_ref = ?, deposit_customer = ?, deposit_card = ? WHERE tenant_id = ? AND id = ?',
    [mode, status, d.status === 'canceled' ? null : d.intent, d.status === 'canceled' ? null : d.customer || null, cardText(d.card_brand, d.card_last4), d.tenant_id, d.contract_id]);
}

/**
 * Sends the deposit to the reader: a hold for a short day rental, or a saved card for a long or season rental. The
 * counter then asks GET /rentals/deposits/:id until the guest has tapped. A reader that cannot be reached is reported
 * with fallback 'note', so the counter can take a note deposit instead.
 */
async function start(req, contractId, { reader_id: readerId, amount_cents: amount, kind: forced = null }) {
  const { tenantId } = req.auth;
  needStripe();
  const c = await one(pool, `SELECT c.*, p.first_name, p.last_name, p.email, p.phone FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.id = ?`, [tenantId, contractId]);
  if (!c) throw notFound('Contract');
  if (!['out', 'overdue'].includes(c.status)) throw conflict('Take a deposit once the gear is handed out');
  if (await activeFor(pool, tenantId, contractId)) throw conflict('This rental already has a card deposit. Cancel it first to start again.');
  const reader = await one(pool, 'SELECT * FROM terminal_readers WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, readerId]);
  if (!reader) throw new AppError(404, 'That card reader is not paired with this mountain');
  const p = await connect.payee(tenantId);
  if (!p.ok) throw new AppError(503, 'Card deposits are not set up yet. Connect Stripe under Billing first, or take a note deposit.', { fallback: 'note' });
  if ((p.account || null) !== (reader.account || null)) throw conflict('This reader belongs to a Stripe account that is no longer connected. Remove it and pair it again.');
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const kind = forced === 'saved' ? 'saved' : planFor(c, tz); // a switch from a hold always saves the card
  const acct = { account: reader.account || null };
  const key = crypto.randomUUID();
  const metadata = { tenant_id: String(tenantId), kind: 'rental_deposit', contract_id: String(contractId) };
  let intent; let customer = null; let sent;
  if (kind === 'hold') {
    if (!(amount >= 50)) throw bad('Enter the deposit to hold, at least 0.50');
    const pi = await sc('/v1/payment_intents', { amount, currency: 'usd', payment_method_types: ['card_present'], capture_method: 'manual', description: `Rental deposit, contract ${contractId}`, metadata }, { ...acct, idempotencyKey: `dep-pi-${key}` });
    intent = pi.id;
    sent = await stripe.tryCall(`/v1/terminal/readers/${encodeURIComponent(reader.stripe_reader)}/process_payment_intent`, { payment_intent: intent }, { ...acct, idempotencyKey: `dep-proc-${key}` });
  } else {
    const cus = await sc('/v1/customers', { name: `${c.first_name} ${c.last_name}`.slice(0, 120), ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}), metadata: { tenant_id: String(tenantId), person_id: String(c.person_id) } }, { ...acct, idempotencyKey: `dep-cus-${key}` });
    customer = cus.id;
    const si = await sc('/v1/setup_intents', { payment_method_types: ['card_present'], customer, usage: 'off_session', description: `Rental deposit card, contract ${contractId}`, metadata }, { ...acct, idempotencyKey: `dep-si-${key}` });
    intent = si.id;
    sent = await stripe.tryCall(`/v1/terminal/readers/${encodeURIComponent(reader.stripe_reader)}/process_setup_intent`, { setup_intent: intent, allow_redisplay: 'limited' }, { ...acct, idempotencyKey: `dep-proc-${key}` });
  }
  const [ins] = await pool.query('INSERT INTO rental_deposits (tenant_id, contract_id, reader_id, kind, intent, account, customer, amount_cents, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, contractId, reader.id, kind, intent, reader.account || null, customer, kind === 'hold' ? amount : (amount || 0), req.auth.userId]);
  if (!sent.ok) {
    await stripe.tryCall(`/v1/${kind === 'hold' ? 'payment_intents' : 'setup_intents'}/${encodeURIComponent(intent)}/cancel`, {}, acct);
    const why = /offline|unreachable|not connected/i.test(sent.error) ? 'The reader is not online. Check it is on and on Wi-Fi, or take a note deposit.' : /busy|in progress/i.test(sent.error) ? 'The reader is busy with another payment. Cancel that one first.' : sent.error;
    await pool.query("UPDATE rental_deposits SET status = 'failed', failure = ? WHERE id = ?", [why.slice(0, 255), ins.insertId]);
    throw new AppError(409, why, { fallback: 'note' });
  }
  const row = await rowOf(tenantId, ins.insertId);
  await pool.query('UPDATE rental_contracts SET deposit_cents = ? WHERE tenant_id = ? AND id = ?', [row.amount_cents, tenantId, contractId]);
  await mirror(pool, row);
  await audit(pool, req, 'deposit_start', 'rental_contracts', contractId, { kind, amount_cents: Number(row.amount_cents), reader: reader.label });
  return shape(row);
}

/** Asks Stripe how a deposit on the reader is going and keeps the answer. Never throws for Stripe being slow. */
async function settle(row) {
  if (row.status !== 'waiting') return row;
  const acct = { account: row.account || null };
  let next = null; let failure = null; let brand = null; let last4 = null; let pm = null; let expires = null;
  let obj;
  try {
    obj = row.kind === 'hold'
      ? await stripe.get(`/v1/payment_intents/${encodeURIComponent(row.intent)}?expand[]=latest_charge`, acct)
      : await stripe.get(`/v1/setup_intents/${encodeURIComponent(row.intent)}?expand[]=latest_attempt`, acct);
  } catch (_) { return row; }
  if (row.kind === 'hold' && obj.status === 'requires_capture') {
    const det = obj.latest_charge && obj.latest_charge.payment_method_details && obj.latest_charge.payment_method_details.card_present;
    brand = brandOf(det && det.brand); last4 = det && /^\d{4}$/.test(String(det.last4 || '')) ? det.last4 : null;
    expires = det && det.capture_before ? utc(new Date(det.capture_before * 1000)) : utc(new Date(Date.now() + (brand === 'visa' ? HOLD_HOURS.visa : HOLD_HOURS.other) * 3600000));
    next = 'held';
  } else if (row.kind === 'saved' && obj.status === 'succeeded') {
    const det = obj.latest_attempt && obj.latest_attempt.payment_method_details && obj.latest_attempt.payment_method_details.card_present;
    pm = det && det.generated_card;
    brand = brandOf(det && det.brand); last4 = det && /^\d{4}$/.test(String(det.last4 || '')) ? det.last4 : null;
    if (pm) next = 'saved';
    else { next = 'failed'; failure = 'That card cannot be saved for later (a phone wallet cannot). Ask for the physical card, or take a note deposit.'; }
  } else if (obj.status === 'canceled') {
    next = 'canceled';
  } else {
    const reader = await one(pool, 'SELECT stripe_reader FROM terminal_readers WHERE id = ?', [row.reader_id]);
    let action = null;
    try { action = reader ? (await stripe.get(`/v1/terminal/readers/${encodeURIComponent(reader.stripe_reader)}`, acct)).action : null; } catch (_) { action = null; }
    const err = obj.last_payment_error || obj.last_setup_error;
    if (action && action.status === 'failed') { next = 'failed'; failure = action.failure_message || 'The card was not accepted.'; }
    else if (err && obj.status === 'requires_payment_method') { next = 'failed'; failure = err.message || 'The card was declined.'; }
  }
  if (!next) return row;
  await pool.query("UPDATE rental_deposits SET status = ?, failure = ?, card_brand = ?, card_last4 = ?, payment_method = ?, expires_at = ? WHERE id = ? AND status = 'waiting'",
    [next, failure ? String(failure).slice(0, 255) : null, brand, last4, pm, expires, row.id]);
  const now = await one(pool, 'SELECT * FROM rental_deposits WHERE id = ?', [row.id]);
  await mirror(pool, now);
  return now;
}

/** Test mode only: a simulated reader acts as if a card was tapped (Stripe's test card, or a declined one). */
async function simulate(req, id, outcome) {
  const row = await rowOf(req.auth.tenantId, id);
  if (!row) throw notFound('Deposit');
  const reader = await one(pool, 'SELECT * FROM terminal_readers WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, row.reader_id]);
  if (!testMode() || !reader || !Number(reader.simulated)) throw bad('Only a test reader in Stripe test mode can be simulated.');
  if (row.status !== 'waiting') throw conflict('That deposit is already finished.');
  const card = outcome === 'decline' ? { card_present: { number: '4000000000000002' }, type: 'card_present' } : {};
  await sc(`/v1/test_helpers/terminal/readers/${encodeURIComponent(reader.stripe_reader)}/present_payment_method`, card, { account: reader.account || null });
  return shape(await settle(row));
}

/** Stops a deposit still waiting on the reader, or lets go of one that never mattered (the gear never went out). */
async function cancel(req, id) {
  let row = await rowOf(req.auth.tenantId, id);
  if (!row) throw notFound('Deposit');
  row = await settle(row);
  const acct = { account: row.account || null };
  if (row.status === 'waiting') {
    const reader = await one(pool, 'SELECT stripe_reader FROM terminal_readers WHERE id = ?', [row.reader_id]);
    if (reader) await stripe.tryCall(`/v1/terminal/readers/${encodeURIComponent(reader.stripe_reader)}/cancel_action`, {}, acct);
    const c = await stripe.tryCall(`/v1/${row.kind === 'hold' ? 'payment_intents' : 'setup_intents'}/${encodeURIComponent(row.intent)}/cancel`, {}, acct);
    if (!c.ok) { row = await settle(row); if (row.status === 'waiting') throw new AppError(409, 'The reader is finishing. Wait a moment and try again.'); }
    else await pool.query("UPDATE rental_deposits SET status = 'canceled' WHERE id = ? AND status = 'waiting'", [row.id]);
    row = await rowOf(req.auth.tenantId, row.id);
    await mirror(pool, row);
    await audit(pool, req, 'deposit_cancel', 'rental_contracts', row.contract_id, { deposit: row.id });
  }
  return shape(row);
}

/** Lets go of a hold, or forgets a saved card. Returns the new status. Throws only when Stripe refuses. */
async function letGo(d) {
  const acct = { account: d.account || null };
  if (d.kind === 'hold') {
    const r = await stripe.tryCall(`/v1/payment_intents/${encodeURIComponent(d.intent)}/cancel`, {}, acct);
    if (!r.ok && !/canceled|cancelled/i.test(r.error)) throw new AppError(502, `The card service said: ${r.error}`);
  } else if (d.payment_method) {
    await stripe.tryCall(`/v1/payment_methods/${encodeURIComponent(d.payment_method)}/detach`, {}, acct); // already gone is fine
  }
  await pool.query("UPDATE rental_deposits SET status = 'released', detached_at = IF(kind = 'saved', NOW(), detached_at) WHERE id = ? AND status IN ('held','saved')", [d.id]);
  const now = await one(pool, 'SELECT * FROM rental_deposits WHERE id = ?', [d.id]);
  await mirror(pool, now);
  return now;
}

const dueFees = (conn, tenantId, contractId) => rows(conn, "SELECT * FROM rental_charges WHERE tenant_id = ? AND contract_id = ? AND status = 'due' AND kind <> 'deposit' ORDER BY id", [tenantId, contractId]);

/**
 * After the last piece is back: nothing owed releases the card deposit at once; fees owed wait for staff to confirm
 * what to take. Never throws (the gear is back whatever the card service says). Returns what happened, or null.
 */
async function afterReturn(tenantId, contractId, req) {
  try {
    let d = await activeFor(pool, tenantId, contractId);
    if (!d) return null;
    d = await settle(d);
    if (d.status === 'waiting') return { action: 'waiting', ...shape(d) };
    if (!['held', 'saved'].includes(d.status)) return null;
    const fees = await dueFees(pool, tenantId, contractId);
    const owed = fees.reduce((a, f) => a + Number(f.cents), 0);
    if (!owed) {
      const now = await letGo(d);
      await audit(pool, req || robot(tenantId), 'deposit_release', 'rental_contracts', contractId, { deposit: d.id, kind: d.kind });
      return { action: 'released', ...shape(now) };
    }
    return { action: 'confirm', owed_cents: owed, can_take_cents: d.kind === 'hold' ? Math.min(owed, Number(d.amount_cents)) : owed, ...shape(d) };
  } catch (err) {
    logFailure({ job: 'rental_deposit_release', tenant: tenantId, contract: contractId, message: err.message });
    return { action: 'error', message: 'The card deposit could not be released just now. Try Release on the contract again.' };
  }
}

/**
 * Takes the fees owed from the card deposit, after staff confirm: a capture of up to the fees from a hold (the rest of
 * the hold is let go), or an off-session charge on a saved card. Loss fees need a manager. The money is recorded as a
 * paid card sale against the fees it paid (a fee only partly covered is split, and the rest stays due).
 */
async function take(req, contractId) {
  const { tenantId } = req.auth;
  let d = await activeFor(pool, tenantId, contractId);
  if (!d) throw conflict('This rental has no card deposit to take from');
  d = await settle(d);
  if (!['held', 'saved'].includes(d.status)) throw conflict('The card deposit is not ready yet');
  const contract = await one(pool, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ?', [tenantId, contractId]);
  const fees = await dueFees(pool, tenantId, contractId);
  if (!fees.length) throw conflict('Nothing is owed on this rental. Release the deposit instead.');
  const manager = ['owner', 'manager'].includes(req.auth.role);
  if (fees.some((f) => f.kind === 'loss') && !manager) throw forbidden('Charging for lost gear needs a manager');
  if (['out', 'overdue'].includes(contract.status) && !manager) throw forbidden('Gear is still out. A manager decides when to charge the card before it is back.');
  // A saved card can be charged any amount with nobody there to tap, so a manager decides every such charge. Counter
  // staff can only capture from a hold, and never more than is owed or than the hold.
  if (d.kind === 'saved' && !manager) throw forbidden('Charging a saved card needs a manager. Ask a manager to confirm the fees and charge it.');
  const owed = fees.reduce((a, f) => a + Number(f.cents), 0);
  const acct = { account: d.account || null };
  const p = await connect.payee(tenantId);
  // Claim the deposit first, so a second press of Take (or a second screen) stops here instead of taking it again.
  const was = d.status;
  const [claim] = await pool.query("UPDATE rental_deposits SET status = 'taking' WHERE id = ? AND status IN ('held','saved')", [d.id]);
  if (!claim.affectedRows) throw conflict('Someone is already taking this deposit. Refresh to see the result.');
  const restore = () => pool.query("UPDATE rental_deposits SET status = ? WHERE id = ? AND status = 'taking'", [was, d.id]);
  let amount; let ref = d.intent;
  try {
    if (d.kind === 'hold') {
      amount = Math.min(owed, Number(d.amount_cents));
      const fee = p.ok && (p.account || null) === (d.account || null) ? connect.feeFor(p, amount) : 0;
      const r = await stripe.tryCall(`/v1/payment_intents/${encodeURIComponent(d.intent)}/capture`, { amount_to_capture: amount, ...(fee ? { application_fee_amount: fee } : {}) }, { ...acct, idempotencyKey: `dep-capture-${d.id}` });
      if (!r.ok) {
        if (/expired|canceled|cancelled/i.test(r.error)) {
          await pool.query("UPDATE rental_deposits SET status = 'expired', failure = ? WHERE id = ? AND status = 'taking'", ['The hold ended before it was used', d.id]);
          await mirror(pool, await rowOf(tenantId, d.id));
          throw conflict('The card hold has ended, so nothing can be taken from it. Collect the fees another way.');
        }
        throw new AppError(502, `The card service said: ${r.error}`);
      }
      d.fee = fee;
    } else {
      amount = owed;
      const fee = p.ok && (p.account || null) === (d.account || null) ? connect.feeFor(p, amount) : 0;
      const r = await stripe.tryCall('/v1/payment_intents', {
        amount, currency: 'usd', customer: d.customer, payment_method: d.payment_method, payment_method_types: ['card'], off_session: true, confirm: true,
        description: `Rental fees, contract ${contractId}`, metadata: { tenant_id: String(tenantId), kind: 'rental_fees', contract_id: String(contractId) }, ...(fee ? { application_fee_amount: fee } : {}),
      }, { ...acct, idempotencyKey: `dep-charge-${d.id}-${amount}` });
      if (!r.ok || r.json.status !== 'succeeded') {
        const why = r.ok ? 'The bank wants the guest to confirm this charge. Ask them to pay at the counter.' : r.error;
        await audit(pool, req, 'deposit_charge_failed', 'rental_contracts', contractId, { amount_cents: amount, why: String(why).slice(0, 200) });
        throw new AppError(409, `The saved card was not charged: ${why}`);
      }
      ref = r.json.id;
      d.fee = fee;
    }
  } catch (err) {
    await restore(); // nothing was taken: the deposit is as it was (a hold that ended is already recorded as ended)
    throw err;
  }
  const orderId = await tx(async (conn) => {
    const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, total_cents, user_id, channel, payment_ref) VALUES (?, ?, 'paid', ?, ?, ?, 'window', 'card')", [tenantId, contract.person_id, amount, amount, req.auth.userId ?? null]);
    await conn.query("INSERT INTO order_items (tenant_id, order_id, line_kind, person_id, contract_id, unit_price_cents, label) VALUES (?, ?, 'rental', ?, ?, ?, 'Rental fees from deposit')", [tenantId, o.insertId, contract.person_id, contractId, amount]);
    await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, card_brand, card_last4, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, ?, ?, 'stripe', ?, ?)",
      [tenantId, o.insertId, amount, ref, d.card_brand, d.card_last4, d.account || null, d.fee || 0]);
    let left = amount;
    // the fees as they are now, locked: one paid another way meanwhile is not paid twice
    const nowDue = await rows(conn, "SELECT * FROM rental_charges WHERE tenant_id = ? AND contract_id = ? AND status = 'due' AND kind <> 'deposit' ORDER BY id FOR UPDATE", [tenantId, contractId]);
    for (const f of nowDue) {
      if (left <= 0) break;
      const cents = Number(f.cents);
      if (cents <= left) {
        await conn.query("UPDATE rental_charges SET status = 'paid', order_id = ?, resolved_at = NOW() WHERE tenant_id = ? AND id = ? AND status = 'due'", [o.insertId, tenantId, f.id]);
        left -= cents;
      } else {
        // only part of this fee is covered: the covered part is paid, the rest stays due
        await conn.query("UPDATE rental_charges SET cents = ? WHERE tenant_id = ? AND id = ? AND status = 'due'", [cents - left, tenantId, f.id]);
        await conn.query("INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note, status, order_id, resolved_at) VALUES (?, ?, ?, ?, ?, 'paid', ?, NOW())", [tenantId, contractId, f.kind, left, `${f.note ? `${f.note}, ` : ''}part from deposit`.slice(0, 200), o.insertId]);
        left = 0;
      }
    }
    await conn.query(`UPDATE rental_deposits SET status = ?, taken_cents = ?, order_id = ? WHERE id = ?`, [d.kind === 'hold' ? 'captured' : 'charged', amount, o.insertId, d.id]);
    await audit(conn, req, 'deposit_take', 'rental_contracts', contractId, { deposit: d.id, kind: d.kind, amount_cents: amount, owed_cents: owed, order_id: o.insertId });
    return o.insertId;
  });
  const now = await rowOf(tenantId, d.id);
  await mirror(pool, now);
  // a saved card is not kept once the rental is settled
  if (d.kind === 'saved' && d.payment_method && !['out', 'overdue'].includes(contract.status)) {
    const det = await stripe.tryCall(`/v1/payment_methods/${encodeURIComponent(d.payment_method)}/detach`, {}, acct);
    if (det.ok) await pool.query('UPDATE rental_deposits SET detached_at = NOW() WHERE id = ?', [d.id]);
  }
  return { ...shape(now), order_id: orderId, owed_cents: owed, still_due_cents: owed - amount };
}

/** Releases the card deposit by hand (fees waived, or paid another way). With gear still out it needs a manager. */
async function release(req, contractId) {
  const { tenantId } = req.auth;
  let d = await activeFor(pool, tenantId, contractId);
  if (!d) throw conflict('This rental has no card deposit to release');
  d = await settle(d);
  if (d.status === 'waiting') throw conflict('The reader is still waiting for the card. Cancel it there instead.');
  const contract = await one(pool, 'SELECT status FROM rental_contracts WHERE tenant_id = ? AND id = ?', [tenantId, contractId]);
  const manager = ['owner', 'manager'].includes(req.auth.role);
  if (['out', 'overdue'].includes(contract.status) && !manager) throw forbidden('Gear is still out. Only a manager can release the deposit now.');
  const owed = (await dueFees(pool, tenantId, contractId)).reduce((a, f) => a + Number(f.cents), 0);
  if (owed && !manager) throw forbidden('Fees are still owed on this rental. Take them from the deposit, or ask a manager to release it.');
  const now = await letGo(d);
  await audit(pool, req, 'deposit_release', 'rental_contracts', contractId, { deposit: d.id, kind: d.kind, by_hand: true, ...(owed ? { owed_cents: owed } : {}) });
  return shape(now);
}

/**
 * When a card hold on this contract ends, as the mountain's local time ('YYYY-MM-DD HH:MM:SS'), or null with no hold.
 * A hold still waiting for the tap is planned for the shortest window (2 days from now).
 */
async function holdEndsLocal(conn, tenantId, contractId, timeZone) {
  const d = await one(conn, "SELECT status, expires_at FROM rental_deposits WHERE tenant_id = ? AND contract_id = ? AND kind = 'hold' AND status IN ('waiting','held','taking') ORDER BY id DESC LIMIT 1", [tenantId, contractId]);
  if (!d) return null;
  const end = d.status !== 'waiting' && d.expires_at ? String(d.expires_at) : utc(new Date(Date.now() + HOLD_HOURS.other * 3600000));
  return localTime(end, timeZone);
}

/**
 * Switches a card hold to a saved card, for a rental extended past the end of its hold: the reader is checked, the
 * hold is let go, and the guest taps again to save the card (same amount noted). Nothing owed is allowed.
 */
async function switchToSaved(req, contractId, { reader_id: readerId }) {
  const { tenantId } = req.auth;
  needStripe();
  let d = await activeFor(pool, tenantId, contractId);
  if (!d || d.kind !== 'hold') throw conflict('This rental has no card hold to switch');
  d = await settle(d);
  if (d.status === 'waiting') throw conflict('The reader is still waiting for the card. Cancel it there first.');
  if (d.status !== 'held') throw conflict('The card hold is not active, so there is nothing to switch. Start a new deposit.');
  const c = await one(pool, 'SELECT status FROM rental_contracts WHERE tenant_id = ? AND id = ?', [tenantId, contractId]);
  if (!['out', 'overdue'].includes(c.status)) throw conflict('Switch the deposit while the gear is out');
  if ((await dueFees(pool, tenantId, contractId)).length) throw conflict('Fees are owed on this rental. Settle them before you switch the deposit.');
  const reader = await one(pool, 'SELECT * FROM terminal_readers WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, readerId]);
  if (!reader) throw new AppError(404, 'That card reader is not paired with this mountain');
  const p = await connect.payee(tenantId);
  if (!p.ok || (p.account || null) !== (reader.account || null)) throw conflict('This reader cannot take a card for this mountain now. Check the card reader under Billing.');
  await letGo(d);
  await audit(pool, req, 'deposit_release', 'rental_contracts', contractId, { deposit: d.id, kind: d.kind, switch_to: 'saved' });
  return start(req, contractId, { reader_id: readerId, amount_cents: Number(d.amount_cents), kind: 'saved' });
}

/** When the card cannot be used: the deposit is noted on the contract, as before (the shop holds cash, an ID, a note). */
async function noteDeposit(req, contractId, amount, note) {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, contractId]);
    if (!c) throw notFound('Contract');
    if (!['out', 'overdue'].includes(c.status)) throw conflict('Take a deposit once the gear is handed out');
    if (await activeFor(conn, tenantId, contractId)) throw conflict('This rental already has a card deposit');
    if (await one(conn, "SELECT id FROM rental_charges WHERE tenant_id = ? AND contract_id = ? AND kind = 'deposit' AND status = 'due'", [tenantId, contractId])) throw conflict('This rental already has a deposit noted');
    await conn.query("INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note) VALUES (?, ?, 'deposit', ?, ?)", [tenantId, contractId, amount, (note || 'Deposit held').slice(0, 200)]);
    await conn.query("UPDATE rental_contracts SET deposit_cents = ?, deposit_mode = 'note', deposit_status = 'held' WHERE tenant_id = ? AND id = ?", [amount, tenantId, contractId]);
    await audit(conn, req, 'deposit_note', 'rental_contracts', contractId, { amount_cents: amount });
  });
  return { ok: true, mode: 'note' };
}

/**
 * Daily: deposits still waiting on a reader after 10 minutes are asked about again; holds within a day of their end
 * while gear is still out are flagged for Out now; holds past their end are checked with Stripe and recorded as ended.
 * Then what was left behind is cleaned up: a hold on a rental that is back with nothing owed is let go (one tapped
 * after the return, or one nobody released), and a saved card on a rental back for 7 days with nothing owed is
 * detached (one charged while the gear was out, or with fees paid another way). Each is audited.
 */
async function sweep() {
  if (!stripe.enabled()) return { checked: 0 };
  const out = { checked: 0, warned: 0, expired: 0, released: 0, detached: 0 };
  for (const r of await rows(pool, "SELECT * FROM rental_deposits WHERE status = 'waiting' AND created_at < NOW() - INTERVAL 10 MINUTE ORDER BY id LIMIT 500")) {
    out.checked += 1;
    try { await settle(r); } catch (err) { logFailure({ job: 'rental_deposits', tenant: r.tenant_id, deposit: r.id, message: err.message }); }
  }
  const [w] = await pool.query(`UPDATE rental_deposits d JOIN rental_contracts c ON c.id = d.contract_id AND c.tenant_id = d.tenant_id
    SET d.warned_at = NOW() WHERE d.status = 'held' AND d.kind = 'hold' AND d.warned_at IS NULL AND d.expires_at < NOW() + INTERVAL 1 DAY AND c.status IN ('out','overdue')`);
  out.warned = w.affectedRows;
  for (const d of await rows(pool, "SELECT * FROM rental_deposits WHERE status = 'held' AND kind = 'hold' AND expires_at < NOW() ORDER BY id LIMIT 500")) {
    try {
      const pi = await stripe.get(`/v1/payment_intents/${encodeURIComponent(d.intent)}`, { account: d.account || null });
      if (pi.status === 'canceled') {
        await pool.query("UPDATE rental_deposits SET status = 'expired', failure = 'The hold ended before it was used' WHERE id = ? AND status = 'held'", [d.id]);
        await mirror(pool, await one(pool, 'SELECT * FROM rental_deposits WHERE id = ?', [d.id]));
        await audit(pool, robot(d.tenant_id), 'deposit_expired', 'rental_contracts', d.contract_id, { deposit: d.id });
        out.expired += 1;
      }
    } catch (err) { logFailure({ job: 'rental_deposits', tenant: d.tenant_id, deposit: d.id, message: err.message }); }
  }
  const nothingOwed = `c.status = 'returned' AND NOT EXISTS (SELECT 1 FROM rental_charges f WHERE f.tenant_id = d.tenant_id AND f.contract_id = d.contract_id AND f.status = 'due' AND f.kind <> 'deposit')`;
  for (const d of await rows(pool, `SELECT d.* FROM rental_deposits d JOIN rental_contracts c ON c.id = d.contract_id AND c.tenant_id = d.tenant_id
    WHERE d.kind = 'hold' AND d.status = 'held' AND ${nothingOwed} ORDER BY d.id LIMIT 500`)) {
    try {
      await letGo(d);
      await audit(pool, robot(d.tenant_id), 'deposit_release', 'rental_contracts', d.contract_id, { deposit: d.id, kind: d.kind, by: 'daily job', why: 'gear back, nothing owed' });
      out.released += 1;
    } catch (err) { logFailure({ job: 'rental_deposits', tenant: d.tenant_id, deposit: d.id, message: err.message }); }
  }
  for (const d of await rows(pool, `SELECT d.* FROM rental_deposits d JOIN rental_contracts c ON c.id = d.contract_id AND c.tenant_id = d.tenant_id
    WHERE d.kind = 'saved' AND d.status IN ('saved','charged') AND d.payment_method IS NOT NULL AND d.detached_at IS NULL
      AND c.checked_in_at < NOW() - INTERVAL 7 DAY AND ${nothingOwed} ORDER BY d.id LIMIT 500`)) {
    try {
      if (d.status === 'saved') await letGo(d);
      else {
        const r = await stripe.tryCall(`/v1/payment_methods/${encodeURIComponent(d.payment_method)}/detach`, {}, { account: d.account || null });
        if (!r.ok && !/no such|not attached|detached/i.test(r.error)) throw new Error(r.error);
        await pool.query('UPDATE rental_deposits SET detached_at = NOW() WHERE id = ?', [d.id]);
      }
      await audit(pool, robot(d.tenant_id), 'deposit_card_detached', 'rental_contracts', d.contract_id, { deposit: d.id, by: 'daily job', why: 'back 7 days, nothing owed' });
      out.detached += 1;
    } catch (err) { logFailure({ job: 'rental_deposits', tenant: d.tenant_id, deposit: d.id, message: err.message }); }
  }
  return out;
}

module.exports = { HOLD_SAFE_HOURS, HOLD_HOURS, planFor, readiness, start, settle, simulate, cancel, afterReturn, take, release, noteDeposit, sweep, shape, rowOf, testMode, holdEndsLocal, switchToSaved };
