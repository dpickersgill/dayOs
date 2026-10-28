'use strict';

// Card readers at the counter (Stripe Terminal, server-driven). A Stripe smart reader (S700/S710, WisePOS E, T600) sits
// on the counter on the mountain's Wi-Fi; nothing is installed on the counter computer. A manager pairs it under Billing
// with the code the reader shows. At checkout, Card on reader sends the amount to the reader through Stripe's API, the
// guest taps, inserts or swipes, and the counter screen asks this server how it went every second or two. Stripe's
// payment_intent webhooks and the daily job check too, so a payment the screen stopped watching (a refresh, a dropped
// connection) is still recorded, and shows under Billing to finish or refund.
//
// The money is a direct charge on the mountain's own Stripe account, like the online shop (lib/connect.js), with the
// platform's fee when the console sets one. A payment that succeeded is attached to the sale it paid for when the sale
// is completed (routes/checkout.js); one that never gets attached, because the sale failed or was abandoned, can be
// refunded from the counter in one click. In Stripe's test mode, a simulated reader and a "Simulate a tap" button let
// the whole flow be tried on staging with no hardware.
const crypto = require('crypto');
const express = require('express');
const { pool, one, rows } = require('../db');
const { logFailure } = require('../lib/jobs');
const { z, validate } = require('../lib/util');
const { requireRole } = require('../middleware/auth');
const { AppError, bad, notFound, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const config = require('../config');
const stripe = require('../lib/stripe');
const connect = require('../lib/connect');

const router = express.Router();
const sellers = ['counter', 'manager'];
const testMode = () => /^(sk|rk)_test_/.test(config.stripe.secretKey || '');
const BRANDS = new Set(['visa', 'mastercard', 'amex', 'discover']);
const brandOf = (b) => (BRANDS.has(String(b || '').toLowerCase()) ? String(b).toLowerCase() : (b ? 'other' : null));

function needStripe() {
  if (!stripe.enabled()) throw new AppError(503, 'Card payments are not set up yet. Connect Stripe under Billing first.');
}
/** Stripe's answer, or a clear error for the person at the counter. */
async function sc(path, body, opts) {
  const r = await stripe.tryCall(path, body, opts);
  if (!r.ok) throw new AppError(r.status && r.status < 500 ? 400 : 502, `The card service said: ${r.error}`);
  return r.json;
}
const readerRow = (tenantId, id) => one(pool, 'SELECT * FROM terminal_readers WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, id]);
const shape = (r) => ({ id: Number(r.id), label: r.label, device_type: r.device_type, serial: r.serial, simulated: Boolean(Number(r.simulated)), created_at: r.created_at });

// ---------------------------------------------------------------- readers
/** The mountain's readers, for the checkout (anyone who sells) and for Billing (managers). */
router.get('/readers', requireRole(...sellers), async (req, res) => {
  const list = await rows(pool, 'SELECT * FROM terminal_readers WHERE tenant_id = ? AND active = 1 ORDER BY label, id', [req.auth.tenantId]);
  const t = await one(pool, 'SELECT terminal_location, address FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.json({ enabled: stripe.enabled(), test_mode: testMode(), has_location: Boolean(t && t.terminal_location), readers: list.map(shape) });
});

const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200), city: z.string().trim().min(1).max(100),
  state: z.string().trim().length(2).transform((s) => s.toUpperCase()), postal_code: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'A 5-digit ZIP code'),
});
/** Pairs a reader: the code it shows on screen (or simulated-wpe in test mode) and a name for it. */
router.post('/readers', requireRole('manager'), validate(z.object({
  registration_code: z.string().trim().min(3).max(60), label: z.string().trim().min(1).max(100), address: addressSchema.optional(),
})), async (req, res) => {
  needStripe();
  const p = await connect.payeeOrThrow(req.auth.tenantId);
  const t = await one(pool, 'SELECT id, name, terminal_location, terminal_location_account FROM tenants WHERE id = ?', [req.auth.tenantId]);
  // Stripe groups readers by location (an address). One per mountain, made with its first reader, on its own account.
  let location = t.terminal_location && (t.terminal_location_account || null) === (p.account || null) ? t.terminal_location : null;
  if (!location) {
    if (!req.body.address) throw bad('Add the mountain’s street address for the first reader. Stripe needs it for the card reader.', { need: 'address' });
    const a = req.body.address;
    const loc = await sc('/v1/terminal/locations', { display_name: t.name.slice(0, 100), address: { line1: a.line1, city: a.city, state: a.state, postal_code: a.postal_code, country: 'US' } }, { account: p.account });
    location = loc.id;
    await pool.query('UPDATE tenants SET terminal_location = ?, terminal_location_account = ? WHERE id = ?', [location, p.account || null, t.id]);
  }
  const code = req.body.registration_code;
  if (/^simulated-/i.test(code) && !testMode()) throw bad('Test readers only work while Stripe is in test mode.');
  const r = await sc('/v1/terminal/readers', { registration_code: code, label: req.body.label, location }, { account: p.account });
  const simulated = /^simulated-/i.test(code) || /simulated/i.test(String(r.device_type || '')) ? 1 : 0;
  const [ins] = await pool.query('INSERT INTO terminal_readers (tenant_id, stripe_reader, account, label, device_type, serial, simulated, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, r.id, p.account || null, req.body.label, r.device_type || null, r.serial_number || null, simulated, req.auth.userId]);
  await audit(pool, req, 'create', 'terminal_readers', ins.insertId, { label: req.body.label, device_type: r.device_type || null, simulated: Boolean(simulated) });
  res.status(201).json(shape(await readerRow(req.auth.tenantId, ins.insertId)));
});

router.delete('/readers/:id', requireRole('manager'), async (req, res) => {
  const r = await readerRow(req.auth.tenantId, Number(req.params.id));
  if (!r) throw notFound('Reader');
  if (stripe.enabled()) await stripe.del(`/v1/terminal/readers/${encodeURIComponent(r.stripe_reader)}`, { account: r.account || null }).catch(() => {}); // gone at Stripe already: fine
  await pool.query('UPDATE terminal_readers SET active = 0 WHERE id = ? AND tenant_id = ?', [r.id, req.auth.tenantId]);
  await audit(pool, req, 'delete', 'terminal_readers', r.id, { label: r.label });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- charging
const payShape = (p) => ({ id: Number(p.id), status: p.status, amount_cents: Number(p.amount_cents), failure: p.failure || null,
  card_brand: p.card_brand || null, card_last4: p.card_last4 || null, attached: Boolean(p.order_id), reader_id: Number(p.reader_id), created_at: p.created_at });
/** The brand and last 4 of the card on a payment (with its latest charge expanded), when Stripe says. */
function cardOf(intent) {
  const card = intent && intent.latest_charge && intent.latest_charge.payment_method_details && (intent.latest_charge.payment_method_details.card_present || intent.latest_charge.payment_method_details.interac_present);
  return { brand: card ? brandOf(card.brand) : null, last4: card && /^\d{4}$/.test(String(card.last4 || '')) ? card.last4 : null };
}

/** Sends an amount to a reader. The counter screen then asks GET /terminal/payments/:id until it settles. */
router.post('/charges', requireRole(...sellers), validate(z.object({ reader_id: z.number().int().positive(), amount_cents: z.number().int().min(50).max(10_000_000) })), async (req, res) => {
  needStripe();
  const reader = await readerRow(req.auth.tenantId, req.body.reader_id);
  if (!reader) throw new AppError(404, 'That card reader is not paired with this mountain');
  const p = await connect.payeeOrThrow(req.auth.tenantId);
  if ((p.account || null) !== (reader.account || null)) throw conflict('This reader belongs to a Stripe account that is no longer connected. Remove it and pair it again.');
  const amount = req.body.amount_cents;
  const fee = connect.feeFor(p, amount);
  const key = crypto.randomUUID();
  const pi = await sc('/v1/payment_intents', {
    amount, currency: 'usd', payment_method_types: ['card_present'], capture_method: 'automatic',
    ...(fee ? { application_fee_amount: fee } : {}), description: 'Counter sale',
    metadata: { tenant_id: String(req.auth.tenantId), kind: 'counter', reader: reader.label.slice(0, 80) },
  }, { account: reader.account || null, idempotencyKey: `pi-${key}` });
  const [ins] = await pool.query('INSERT INTO terminal_payments (tenant_id, reader_id, intent, account, amount_cents, fee_cents, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, reader.id, pi.id, reader.account || null, amount, fee, req.auth.userId]);
  const sent = await stripe.tryCall(`/v1/terminal/readers/${encodeURIComponent(reader.stripe_reader)}/process_payment_intent`, { payment_intent: pi.id }, { account: reader.account || null, idempotencyKey: `proc-${key}` });
  if (!sent.ok) {
    await stripe.tryCall(`/v1/payment_intents/${pi.id}/cancel`, {}, { account: reader.account || null });
    const why = /offline|unreachable|not connected/i.test(sent.error) ? 'The reader is not online. Check it is on and on Wi-Fi.' : /busy|in progress/i.test(sent.error) ? 'The reader is busy with another payment. Cancel that one first.' : sent.error;
    await pool.query("UPDATE terminal_payments SET status = 'failed', failure = ? WHERE id = ?", [why.slice(0, 255), ins.insertId]);
    throw new AppError(409, why);
  }
  res.status(201).json(payShape(await one(pool, 'SELECT * FROM terminal_payments WHERE id = ?', [ins.insertId])));
});

/** Asks Stripe how a payment is going and keeps the answer. Never throws for Stripe being slow: it stays "waiting". */
async function settle(row) {
  if (row.status !== 'waiting') return row;
  const acct = { account: row.account || null };
  let intent;
  try { intent = await stripe.get(`/v1/payment_intents/${encodeURIComponent(row.intent)}?expand[]=latest_charge`, acct); } catch (_) { return row; }
  let next = null; let failure = null; let brand = null; let last4 = null;
  if (intent.status === 'succeeded') {
    next = 'succeeded';
    ({ brand, last4 } = cardOf(intent));
  } else if (intent.status === 'canceled') {
    next = 'canceled';
  } else {
    const reader = await one(pool, 'SELECT stripe_reader FROM terminal_readers WHERE id = ?', [row.reader_id]);
    let action = null;
    try { action = reader ? (await stripe.get(`/v1/terminal/readers/${encodeURIComponent(reader.stripe_reader)}`, acct)).action : null; } catch (_) { action = null; }
    if (action && action.status === 'failed') { next = 'failed'; failure = action.failure_message || 'The card was not accepted.'; }
    else if (intent.last_payment_error && intent.status === 'requires_payment_method') { next = 'failed'; failure = intent.last_payment_error.message || 'The card was declined.'; }
  }
  if (!next) return row;
  await pool.query("UPDATE terminal_payments SET status = ?, failure = ?, card_brand = ?, card_last4 = ? WHERE id = ? AND status = 'waiting'", [next, failure ? String(failure).slice(0, 255) : null, brand, last4, row.id]);
  return one(pool, 'SELECT * FROM terminal_payments WHERE id = ?', [row.id]);
}

const payRow = (tenantId, id) => one(pool, 'SELECT * FROM terminal_payments WHERE tenant_id = ? AND id = ?', [tenantId, id]);

router.get('/payments/:id', requireRole(...sellers), async (req, res) => {
  const row = await payRow(req.auth.tenantId, Number(req.params.id));
  if (!row) throw notFound('Payment');
  res.json(payShape(await settle(row)));
});

/** Test mode only: makes a simulated reader act as if a card was tapped (Stripe's test card, or a declined one). */
router.post('/payments/:id/simulate', requireRole(...sellers), validate(z.object({ outcome: z.enum(['approve', 'decline']).default('approve') })), async (req, res) => {
  const row = await payRow(req.auth.tenantId, Number(req.params.id));
  if (!row) throw notFound('Payment');
  const reader = await one(pool, 'SELECT * FROM terminal_readers WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, row.reader_id]);
  if (!testMode() || !reader || !Number(reader.simulated)) throw bad('Only a test reader in Stripe test mode can be simulated.');
  if (row.status !== 'waiting') throw conflict('That payment is already finished.');
  const card = req.body.outcome === 'decline' ? { card_present: { number: '4000000000000002' }, type: 'card_present' } : {};
  await sc(`/v1/test_helpers/terminal/readers/${encodeURIComponent(reader.stripe_reader)}/present_payment_method`, card, { account: reader.account || null });
  res.json(payShape(await settle(row)));
});

/**
 * Stops a payment. Still waiting: the reader stops asking for a card. Already paid but not part of a completed sale
 * (the sale failed, or the line was removed): the guest's money goes back to their card.
 */
router.post('/payments/:id/cancel', requireRole(...sellers), validate(z.object({ keep_if_paid: z.boolean().optional() })), async (req, res) => {
  let row = await payRow(req.auth.tenantId, Number(req.params.id));
  if (!row) throw notFound('Payment');
  row = await settle(row);
  const acct = { account: row.account || null };
  if (row.status === 'waiting') {
    const reader = await one(pool, 'SELECT stripe_reader FROM terminal_readers WHERE id = ?', [row.reader_id]);
    if (reader) await stripe.tryCall(`/v1/terminal/readers/${encodeURIComponent(reader.stripe_reader)}/cancel_action`, {}, acct);
    const c = await stripe.tryCall(`/v1/payment_intents/${encodeURIComponent(row.intent)}/cancel`, {}, acct);
    if (!c.ok) { row = await settle(row); if (row.status === 'waiting') throw new AppError(409, 'The reader is finishing that payment. Wait a moment and try again.'); }
    else await pool.query("UPDATE terminal_payments SET status = 'canceled' WHERE id = ? AND status = 'waiting'", [row.id]);
  }
  row = await payRow(req.auth.tenantId, row.id);
  // The counter giving up on a reader that went quiet: a payment that went through after all is kept for the sale.
  if (row.status === 'succeeded' && req.body.keep_if_paid) return res.json(payShape(row));
  if (row.status === 'succeeded') {
    if (row.order_id) throw conflict('That payment is part of a completed sale. Refund it from the order instead.');
    await stripe.refund({ paymentIntent: row.intent, amountCents: Number(row.amount_cents), key: `terminal-cancel-${row.id}`, metadata: { tenant_id: String(req.auth.tenantId), kind: 'counter_cancel' }, account: row.account || null });
    await pool.query("UPDATE terminal_payments SET status = 'refunded' WHERE id = ? AND status = 'succeeded' AND order_id IS NULL", [row.id]);
    await audit(pool, req, 'refund', 'terminal_payments', row.id, { amount_cents: Number(row.amount_cents), reason: 'not part of a sale' });
  }
  res.json(payShape(await payRow(req.auth.tenantId, row.id)));
});

/**
 * Card payments taken on a reader in the last two days that never became part of a sale, to finish or refund them, and
 * payments still waiting on the reader a few minutes on (the counter screen stopped watching): those are asked about
 * again first, and any still waiting are listed so a manager can check the reader and cancel them.
 */
router.get('/unattached', requireRole(...sellers), async (req, res) => {
  const STUCK = "status = 'waiting' AND created_at < NOW() - INTERVAL 3 MINUTE AND created_at > NOW() - INTERVAL 2 DAY";
  for (const r of await rows(pool, `SELECT * FROM terminal_payments WHERE tenant_id = ? AND ${STUCK} ORDER BY id DESC LIMIT 10`, [req.auth.tenantId])) await settle(r);
  const list = await rows(pool, `SELECT * FROM terminal_payments WHERE tenant_id = ? AND order_id IS NULL AND ((status = 'succeeded' AND created_at > NOW() - INTERVAL 2 DAY) OR (${STUCK})) ORDER BY id DESC`, [req.auth.tenantId]);
  res.json({ payments: list.map((p) => ({ ...payShape(p), ...(p.status === 'waiting' ? { note: 'Still waiting for the card on the reader. Check the reader; if the guest did not pay, cancel it.' } : {}) })) });
});

const EVENTS = { 'payment_intent.succeeded': 'succeeded', 'payment_intent.payment_failed': 'failed', 'payment_intent.canceled': 'canceled' };
/**
 * Stripe says a counter payment succeeded, failed or was canceled (metadata.kind 'counter'). The payment is matched by its
 * PaymentIntent and the Stripe account it was taken on, checked with Stripe (for the card's brand and last 4) and kept.
 * If Stripe cannot be asked, the event's own word is kept. A payment already finished is left alone, except a success,
 * which always counts: the money was taken.
 */
async function handleWebhook(event, obj) {
  const next = EVENTS[event.type];
  if (!next || !obj || !obj.id) return { ignored: true };
  const row = await one(pool, 'SELECT * FROM terminal_payments WHERE tenant_id = ? AND intent = ? AND account <=> ?', [Number(obj.metadata && obj.metadata.tenant_id), String(obj.id), event.account || null]);
  if (!row) return { ignored: true };
  let now = await settle(row);
  if (now.status === 'waiting' || (next === 'succeeded' && now.status === 'failed')) {
    let card = { brand: null, last4: null };
    if (next === 'succeeded') { try { card = cardOf(await stripe.get(`/v1/payment_intents/${encodeURIComponent(row.intent)}?expand[]=latest_charge`, { account: row.account || null })); } catch (_) { /* recorded without the card */ } }
    const failure = next === 'failed' ? String((obj.last_payment_error && obj.last_payment_error.message) || 'The card was not accepted.').slice(0, 255) : null;
    await pool.query(`UPDATE terminal_payments SET status = ?, failure = ?, card_brand = COALESCE(?, card_brand), card_last4 = COALESCE(?, card_last4) WHERE id = ? AND status IN (${next === 'succeeded' ? "'waiting','failed'" : "'waiting'"})`,
      [next, failure, card.brand, card.last4, row.id]);
    now = await one(pool, 'SELECT * FROM terminal_payments WHERE id = ?', [row.id]);
  }
  return { terminal: now.status };
}

/** Daily: asks Stripe about every counter payment still waiting after 10 minutes, and keeps the answer. */
async function sweep() {
  if (!stripe.enabled()) return { checked: 0, settled: 0 };
  const due = await rows(pool, "SELECT * FROM terminal_payments WHERE status = 'waiting' AND created_at < NOW() - INTERVAL 10 MINUTE ORDER BY id LIMIT 500");
  const out = { checked: due.length, settled: 0 };
  for (const r of due) {
    try { if ((await settle(r)).status !== 'waiting') out.settled += 1; } catch (err) { logFailure({ job: 'terminal_sweep', tenant: r.tenant_id, payment: r.id, message: err.message }); }
  }
  return out;
}

/**
 * For checkout: the reader payment a sale says it was paid by, locked, checked (this mountain, succeeded, the same
 * amount, not already used) and marked as used by this order. Returns what to record on the order's payment.
 */
async function attach(conn, tenantId, id, amountCents, orderId) {
  const [[row]] = await conn.query('SELECT * FROM terminal_payments WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
  if (!row) throw bad('That card reader payment was not found');
  if (row.status !== 'succeeded') throw conflict('That card reader payment has not gone through');
  if (row.order_id) throw conflict('That card reader payment is already part of another sale');
  if (Number(row.amount_cents) !== Number(amountCents)) throw conflict('The card reader payment is for a different amount');
  await conn.query('UPDATE terminal_payments SET order_id = ? WHERE id = ?', [orderId, row.id]);
  return { intent: row.intent, account: row.account || null, fee: Number(row.fee_cents) || 0, brand: row.card_brand || null, last4: row.card_last4 || null };
}

module.exports = { router, attach, handleWebhook, sweep };
