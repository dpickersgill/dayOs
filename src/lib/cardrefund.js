'use strict';

// Card refunds through Stripe. The refund is written to the books first (order_refunds, card_status 'pending'), then sent
// to Stripe. If Stripe cannot be reached the row is marked 'failed' and is retried by the daily job or by a manager, always
// with the same idempotency key, so the guest can never be refunded twice and a refund can never be silently lost.
const { pool, rows, one } = require('../db');
const stripe = require('./stripe');
const { logFailure } = require('./jobs');

/** Marks a refund row as owed back to a card, inside the caller's transaction. */
async function markPending(conn, tenantId, refundId, paymentIntent) {
  // The refund goes back through the Stripe account the payment was taken on: the mountain's own, or the platform's.
  const account = await require('./connect').accountOfPayment(conn, tenantId, paymentIntent);
  await conn.query("UPDATE order_refunds SET card_status = 'pending', card_ref = ?, card_key = ?, card_account = ? WHERE tenant_id = ? AND id = ?",
    [paymentIntent, `card-refund-${tenantId}-${refundId}`, account, tenantId, refundId]);
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

/** Daily: retries every card refund still owed (failed, or pending for more than 10 minutes). */
async function retryAll() {
  const due = await rows(pool, "SELECT tenant_id, id FROM order_refunds WHERE card_status = 'failed' OR (card_status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)) ORDER BY id LIMIT 200");
  const out = { sent: 0, failed: 0 };
  for (const d of due) { const s = await send(d.tenant_id, d.id); if (s === 'sent') out.sent += 1; else if (s === 'failed') out.failed += 1; }
  return out;
}

module.exports = { markPending, send, retryAll };
