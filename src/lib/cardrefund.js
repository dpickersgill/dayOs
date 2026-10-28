'use strict';

// Card refunds through Stripe. The refund is written to the books first (order_refunds, card_status 'pending'), then sent
// to Stripe. If Stripe cannot be reached the row is marked 'failed' and is retried by the daily job or by a manager, always
// with the same idempotency key, so the guest can never be refunded twice and a refund can never be silently lost.
const { pool, tx, rows, one } = require('../db');
const stripe = require('./stripe');
const { logFailure } = require('./jobs');

/** Marks a refund row as owed back to a card, inside the caller's transaction. */
async function markPending(conn, tenantId, refundId, paymentIntent) {
  // The refund goes back through the Stripe account the payment was taken on: the mountain's own, or the platform's.
  const account = await require('./connect').accountOfPayment(conn, tenantId, paymentIntent);
  await conn.query("UPDATE order_refunds SET card_status = 'pending', card_ref = ?, card_key = ?, card_account = ? WHERE tenant_id = ? AND id = ?",
    [paymentIntent, `card-refund-${tenantId}-${refundId}`, account, tenantId, refundId]);
}

/**
 * Splits the card part of a refund across the order's card payments (pays: its order_payments rows), oldest first, each
 * capped at what it has left after earlier card refunds. Each Stripe payment (online, or on a counter reader) gets its own
 * part, refunded back through Stripe to that card; cards taken on a separate machine share one part that the desk refunds
 * on that machine. Returns [{ method: 'card', cents, ref }], ref being the Stripe payment, or null for the desk.
 */
async function splitCard(conn, tenantId, orderId, pays, cents) {
  const cards = pays.filter((p) => p.tender === 'card');
  const viaStripe = (p) => p.processor === 'stripe' && p.reference;
  const before = await rows(conn, "SELECT card_ref, SUM(amount_cents) AS cents FROM order_refunds WHERE tenant_id = ? AND order_id = ? AND method = 'card' GROUP BY card_ref", [tenantId, orderId]);
  const back = new Map(before.map((b) => [b.card_ref || '', Number(b.cents)]));
  const left = new Map(); // what each Stripe payment, and the desk's cards together (''), still have to give back
  for (const p of cards) { const k = viaStripe(p) ? String(p.reference) : ''; left.set(k, (left.get(k) || 0) + Number(p.amount_cents)); }
  for (const [k, v] of left) left.set(k, v - (back.get(k) || 0));
  // Desk refunds beyond the desk's own cards (written before refunds were split by card) came off the Stripe payments.
  let over = Math.max(-(left.get('') || 0), 0);
  for (const p of cards.filter(viaStripe)) { const k = String(p.reference); const take = Math.min(over, Math.max(left.get(k), 0)); left.set(k, left.get(k) - take); over -= take; }
  const out = []; let todo = cents;
  for (const p of cards) {
    if (todo <= 0) break;
    const k = viaStripe(p) ? String(p.reference) : '';
    const give = Math.min(todo, Math.max(left.get(k) || 0, 0));
    if (give <= 0) continue;
    left.set(k, left.get(k) - give); todo -= give;
    const same = out.find((x) => x.ref === (k || null));
    if (same) same.cents += give; else out.push({ method: 'card', cents: give, ref: k || null });
  }
  if (todo > 0) out.push({ method: 'card', cents: todo, ref: null }); // what the records cannot place goes to the desk
  return out;
}

/** Sends one pending or failed card refund to Stripe. Returns 'sent', 'failed' or 'skipped'. Never throws. */
async function send(tenantId, refundId) {
  const r = await one(pool, "SELECT id, amount_cents, card_status, card_ref, card_key, card_account FROM order_refunds WHERE tenant_id = ? AND id = ?", [tenantId, refundId]);
  if (!r || !['pending', 'failed'].includes(r.card_status) || !r.card_ref || r.amount_cents <= 0) return 'skipped';
  if (!stripe.enabled()) { await pool.query("UPDATE order_refunds SET card_status = 'failed', card_error = ? WHERE tenant_id = ? AND id = ?", ['Card payment is not set up', tenantId, r.id]); return 'failed'; }
  try {
    // Stripe forgets idempotency keys after a day, so a later retry first looks for a refund already made for this row
    // (a timeout can hide a refund that did go through).
    let done = null;
    if (r.card_status === 'failed') {
      // A retry must be able to check first; if it cannot, it waits for the next try rather than risk refunding twice.
      done = (await stripe.listRefunds(r.card_ref, { account: r.card_account || null })).find((x) => x.metadata && x.metadata.summitops_refund === String(r.id) && x.status !== 'failed' && x.status !== 'canceled') || null;
    }
    const out = done ? { id: done.id } : await stripe.refund({ paymentIntent: r.card_ref, amountCents: r.amount_cents, key: r.card_key, metadata: { summitops_refund: String(r.id), tenant: String(tenantId) }, account: r.card_account || null });
    await pool.query("UPDATE order_refunds SET card_status = 'sent', card_error = NULL, card_refund_id = ? WHERE tenant_id = ? AND id = ?", [out.id || null, tenantId, r.id]);
    return 'sent';
  } catch (err) {
    await pool.query("UPDATE order_refunds SET card_status = 'failed', card_error = ? WHERE tenant_id = ? AND id = ?", [String(err.message || 'Stripe refused the refund').slice(0, 250), tenantId, r.id]);
    logFailure({ job: 'card_refund', tenant: tenantId, refund: r.id, message: err.message });
    return 'failed';
  }
}

// ---------------------------------------------------------------- paid card pages we cannot honor
// A guest paid on Stripe's page for something we cannot give them: the lesson request was canceled while they were still
// paying, the lesson filled, the amount does not match, or the payment cannot be matched to what it was for. The whole
// payment goes back. Like a refund above it is written down first (card_returns, one row per payment, so a repeated
// Stripe event never owes it twice), then sent after the commit, and retried by the daily job until Stripe has it.

/**
 * Writes a full refund of one paid card page as owed, inside the caller's transaction, with an audit entry. Returns its
 * id, or null when this payment is already owed back (a repeated event).
 */
async function oweReturn(conn, { tenantId, kind, rowId = null, session = null, paymentIntent, amountCents, account = null, reason }) {
  if (!paymentIntent || !(Number(amountCents) > 0)) return null;
  const [r] = await conn.query('INSERT IGNORE INTO card_returns (tenant_id, kind, row_id, checkout_session, payment_intent, account, amount_cents, reason, card_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, kind, rowId, session, String(paymentIntent), account || null, Number(amountCents), String(reason || 'could not be honored').slice(0, 300), `card-return-${paymentIntent}`.slice(0, 100)]);
  if (r.affectedRows !== 1) return null;
  await require('./audit').audit(conn, { auth: { tenantId, userId: null } }, 'card_return', 'card_returns', r.insertId, { kind, row_id: rowId, amount_cents: Number(amountCents), reason });
  return r.insertId;
}

/** True when this payment is already owed back (or was given back) in full. */
async function returned(conn, tenantId, paymentIntent) {
  return Boolean(paymentIntent && await one(conn, 'SELECT id FROM card_returns WHERE tenant_id = ? AND payment_intent = ?', [tenantId, String(paymentIntent)]));
}

/** Sends one owed card return to Stripe. Returns 'sent', 'failed' or 'skipped'. Never throws. */
async function sendReturn(id) {
  const r = await one(pool, 'SELECT * FROM card_returns WHERE id = ?', [id]);
  if (!r || !['pending', 'failed'].includes(r.card_status)) return 'skipped';
  if (!stripe.enabled()) { await pool.query("UPDATE card_returns SET card_status = 'failed', card_error = ? WHERE id = ?", ['Card payment is not set up', r.id]); return 'failed'; }
  try {
    let done = null;
    if (r.card_status === 'failed') {
      // A retry looks first, as above: ours by its metadata, or refunds already covering the whole payment.
      const live = (await stripe.listRefunds(r.payment_intent, { account: r.account || null })).filter((x) => x.status !== 'failed' && x.status !== 'canceled');
      done = live.find((x) => x.metadata && x.metadata.summitops_return === String(r.id))
        || (live.length && live.reduce((n, x) => n + Number(x.amount || 0), 0) >= r.amount_cents ? live[0] : null);
    }
    const out = done ? { id: done.id } : await stripe.refund({ paymentIntent: r.payment_intent, amountCents: r.amount_cents, key: r.card_key, metadata: { summitops_return: String(r.id), tenant: String(r.tenant_id) }, account: r.account || null });
    await pool.query("UPDATE card_returns SET card_status = 'sent', card_error = NULL, card_refund_id = ? WHERE id = ?", [out.id || null, r.id]);
    return 'sent';
  } catch (err) {
    await pool.query("UPDATE card_returns SET card_status = 'failed', card_error = ? WHERE id = ?", [String(err.message || 'Stripe refused the refund').slice(0, 250), r.id]);
    logFailure({ job: 'card_return', tenant: r.tenant_id, card_return: r.id, message: err.message });
    return 'failed';
  }
}

/**
 * A paid card page that names one of our rows but cannot be matched to it (the row is waiting on a different page, or was
 * settled another way): the whole payment is owed back and sent, the row itself is left alone, and the operator is
 * alerted, because it means a card page was lost track of. Returns { refunded: true }, or { duplicate: true } when this
 * payment was already owed back.
 */
async function returnStray({ tenantId, kind, rowId, obj, account = null, why }) {
  const id = await tx((conn) => oweReturn(conn, { tenantId, kind, rowId, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account, reason: why }));
  if (!id) return { duplicate: true };
  logFailure({ job: 'stripe_webhook', tenant: tenantId, kind, row: rowId, message: `a paid card page could not be matched and is refunded: ${why}` });
  await sendReturn(id);
  return { refunded: true };
}

/** Daily: retries every card refund and card return still owed (failed, or pending for more than 10 minutes). */
async function retryAll() {
  const due = await rows(pool, "SELECT tenant_id, id FROM order_refunds WHERE card_status = 'failed' OR (card_status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)) ORDER BY id LIMIT 200");
  const out = { sent: 0, failed: 0 };
  for (const d of due) { const s = await send(d.tenant_id, d.id); if (s === 'sent') out.sent += 1; else if (s === 'failed') out.failed += 1; }
  const back = await rows(pool, "SELECT id FROM card_returns WHERE card_status = 'failed' OR (card_status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)) ORDER BY id LIMIT 200");
  for (const d of back) { const s = await sendReturn(d.id); if (s === 'sent') out.sent += 1; else if (s === 'failed') out.failed += 1; }
  return out;
}

module.exports = { markPending, splitCard, send, retryAll, oweReturn, returned, sendReturn, returnStray };
