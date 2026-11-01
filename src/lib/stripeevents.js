'use strict';
// Refunds and disputes made outside Verdynt/OS (2026.11.11). A refund the mountain gives in its own Stripe dashboard, or
// a guest's bank disputing a charge, used to leave the books saying the money was still in. Stripe tells us with
//   charge.refunded            the charge's amount_refunded now; what is more than the refunds we sent ourselves is
//                              written down as a card refund on the order ("Refunded in the Stripe dashboard")
//   charge.dispute.created / .updated / .closed / .funds_withdrawn / .funds_reinstated
//                              kept in payment_disputes with the order, and logged so the alert fires
// Tickets and places are not voided: staff decide that (the order shows the refund or the dispute).
const { pool, tx, one } = require('../db');
const { audit } = require('./audit');
const { logFailure } = require('./jobs');

const sys = (tenantId) => ({ auth: { tenantId, userId: null } });
const piOf = (obj) => (typeof obj.payment_intent === 'object' && obj.payment_intent ? obj.payment_intent.id : obj.payment_intent) || null;

/** The order a Stripe payment was recorded on: { tenant_id, order_id } or null. tenantId: from the connected account. */
async function paymentOf(conn, pi, tenantId) {
  if (!pi) return null;
  return one(conn, `SELECT tenant_id, order_id FROM order_payments WHERE reference = ? AND tender = 'card' AND processor = 'stripe'${tenantId ? ' AND tenant_id = ?' : ''} ORDER BY id LIMIT 1`, tenantId ? [pi, tenantId] : [pi]);
}

async function refunded(event, obj, tenantId) {
  const pi = piOf(obj);
  return tx(async (conn) => {
    const pay = await paymentOf(conn, pi, tenantId);
    if (!pay) return { ignored: true };
    await conn.query('SELECT id FROM orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [pay.tenant_id, pay.order_id]);
    // What we already sent back on this payment ourselves (pending ones too: their answer may come after this event).
    const ours = await one(conn, "SELECT COALESCE(SUM(amount_cents), 0) AS c FROM order_refunds WHERE tenant_id = ? AND card_ref = ? AND (card_status IS NULL OR card_status IN ('pending','sent'))", [pay.tenant_id, pi]);
    const ret = await one(conn, "SELECT COALESCE(SUM(amount_cents), 0) AS c FROM card_returns WHERE tenant_id = ? AND payment_intent = ? AND card_status IN ('pending','sent')", [pay.tenant_id, pi]);
    const extra = Number(obj.amount_refunded || 0) - Number(ours.c) - Number(ret.c);
    if (extra <= 0) return { refund: 'known' };
    const last = obj.refunds && Array.isArray(obj.refunds.data) && obj.refunds.data[0] ? obj.refunds.data[0].id : null;
    const [r] = await conn.query("INSERT INTO order_refunds (tenant_id, order_id, user_id, reason, note, amount_cents, tax_cents, method, card_status, card_ref, card_refund_id) VALUES (?, ?, NULL, 'other', 'Refunded in the Stripe dashboard', ?, 0, 'card', 'sent', ?, ?)",
      [pay.tenant_id, pay.order_id, extra, pi, last]);
    await conn.query('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE tenant_id = ? AND id = ?', [extra, pay.tenant_id, pay.order_id]);
    await audit(conn, sys(pay.tenant_id), 'stripe_dashboard_refund', 'orders', pay.order_id, { amount_cents: extra, refund_id: r.insertId });
    return { refund: 'recorded', amount_cents: extra };
  });
}

async function disputed(event, obj, tenantId) {
  const pi = piOf(obj);
  const pay = await paymentOf(pool, pi, tenantId);
  const t = pay ? pay.tenant_id : tenantId;
  if (!t) return { ignored: true };
  const status = String(obj.status || event.type.split('.').pop()).slice(0, 40);
  await pool.query(`INSERT INTO payment_disputes (tenant_id, order_id, payment_intent, dispute_id, amount_cents, reason, status, evidence_due_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE status = VALUES(status), amount_cents = VALUES(amount_cents), reason = VALUES(reason), evidence_due_by = VALUES(evidence_due_by)`,
  [t, pay ? pay.order_id : null, pi, String(obj.id).slice(0, 255), Number(obj.amount || 0), obj.reason ? String(obj.reason).slice(0, 60) : null, status,
    obj.evidence_details && obj.evidence_details.due_by ? new Date(obj.evidence_details.due_by * 1000) : null]);
  await audit(pool, sys(t), event.type.replace(/\./g, '_').slice(0, 40), 'orders', pay ? pay.order_id : null, { dispute: String(obj.id).slice(0, 80), amount_cents: Number(obj.amount || 0), status });
  if (event.type === 'charge.dispute.created') logFailure({ job: 'stripe_dispute', tenant: t, message: `a card payment was disputed (order ${pay ? pay.order_id : 'not found'}): answer it in the Stripe dashboard` });
  return { dispute: status };
}

/** Handles a charge.* event, or returns null when it is not one of these. */
async function handle(event) {
  const type = String((event && event.type) || '');
  const obj = event && event.data && event.data.object;
  if (!obj || !(type === 'charge.refunded' || type.startsWith('charge.dispute.'))) return null;
  const tenantId = event.account ? await require('./connect').tenantForAccount(event.account) : null;
  if (event.account && !tenantId) return { ignored: true };
  return type === 'charge.refunded' ? refunded(event, obj, tenantId) : disputed(event, obj, tenantId);
}

module.exports = { handle };
