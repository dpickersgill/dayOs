'use strict';
// What a ticket (or an order line) is still paid for, worked out one way for everyone: the line refund (routes/sales.js),
// change day at the window (routes/guestswindow.js), the price-drop promise, closure credits and the conditions
// guarantee (lib/fairprice.js). Before this, each one had its own idea and money could go back twice.
//
// For one ticket, in cents before tax:
//   list      the unit price before any promo or reward (order_items.list_cents; older lines: what the line says)
//   paid      what the sale took for it: the unit price less its share of the line's discount (a promo, or a reward
//             online). At the window a reward is already out of unit_price_cents (order_items.reward_cents says how much).
//   back      money already given back on it: change-day refunds (window_changes) and price-drop refunds (fair_price_drops)
//   extra     what a change of day charged on top (its own small "Price difference" order, while that is not refunded)
//   net       paid - back + extra, never below 0; 0 when the line was refunded or the ticket voided
//   kept      net less extra: the part of it still held on the ticket's own order (what a refund of that line can return)
const { rows } = require('../db');

const n = (x) => Number(x || 0);

/** Values for many tickets at once: Map(ticketId => { ticket_id, item_id, order_id, list, paid, back, extra, net, kept, discount }). */
async function forTickets(db, tenantId, ticketIds) {
  const ids = [...new Set([].concat(ticketIds).map(Number).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const base = await rows(db, `SELECT k.id, k.status, i.id AS item_id, i.order_id, i.quantity, i.unit_price_cents, i.discount_cents, i.list_cents, i.refunded_at
      FROM tickets k JOIN order_items i ON i.tenant_id = k.tenant_id AND i.id = k.order_item_id WHERE k.tenant_id = ? AND k.id IN (?)`, [tenantId, ids]);
  const changes = await rows(db, `SELECT w.ticket_id, SUM(CASE WHEN w.diff_cents < 0 THEN -w.diff_cents ELSE 0 END) AS back,
      SUM(CASE WHEN w.diff_cents > 0 AND NOT EXISTS (SELECT 1 FROM order_items f WHERE f.tenant_id = w.tenant_id AND f.order_id = w.paid_order_id AND f.refunded_at IS NOT NULL) THEN w.diff_cents ELSE 0 END) AS extra
    FROM window_changes w WHERE w.tenant_id = ? AND w.ticket_id IN (?) GROUP BY w.ticket_id`, [tenantId, ids]);
  const drops = await rows(db, `SELECT ticket_id, SUM(LEAST(from_cents - to_cents, refund_cents)) AS back FROM fair_price_drops
    WHERE tenant_id = ? AND ticket_id IN (?) AND from_cents > to_cents GROUP BY ticket_id`, [tenantId, ids]);
  const ch = new Map(changes.map((c) => [c.ticket_id, c]));
  const dr = new Map(drops.map((d) => [d.ticket_id, n(d.back)]));
  for (const b of base) {
    const qty = Math.max(n(b.quantity), 1);
    const unit = n(b.unit_price_cents);
    const discount = Math.round(n(b.discount_cents) / qty); // this ticket's share of the line's discount
    const paid = Math.max(unit - discount, 0);
    const list = b.list_cents === null || b.list_cents === undefined ? unit : n(b.list_cents);
    const c = ch.get(b.id) || {};
    const back = n(c.back) + (dr.get(b.id) || 0);
    const extra = n(c.extra);
    const gone = b.refunded_at || b.status === 'void';
    const net = gone ? 0 : Math.max(paid - back + extra, 0);
    out.set(b.id, { ticket_id: b.id, item_id: b.item_id, order_id: b.order_id, list, paid, discount: Math.max(list - paid, 0), back, extra, net, kept: gone ? 0 : Math.max(paid - back, 0) });
  }
  return out;
}

/** What is still paid for one ticket (cents before tax), or 0 when there is no such ticket. */
async function netPaidForTicket(db, tenantId, ticketId) {
  const v = (await forTickets(db, tenantId, [ticketId])).get(Number(ticketId));
  return v ? v.net : 0;
}

/** The same for one ticket, with the parts (see the top of this file), or null. */
async function ticketValue(db, tenantId, ticketId) {
  return (await forTickets(db, tenantId, [ticketId])).get(Number(ticketId)) || null;
}

/**
 * What a refund of an order line can still give back, before tax, from that order: the line's price less its discount,
 * less what has gone back on its tickets already (a change of day, a price drop). Lines without tickets (a lesson, a
 * rental) are worth their price less their discount. line: an order_items row.
 */
async function lineKept(db, tenantId, line) {
  const gross = Math.max(n(line.unit_price_cents) * n(line.quantity) - n(line.discount_cents), 0);
  if (line.refunded_at) return 0;
  const ks = await rows(db, 'SELECT id FROM tickets WHERE tenant_id = ? AND order_item_id = ?', [tenantId, line.id]);
  if (!ks.length) return gross;
  const v = await forTickets(db, tenantId, ks.map((k) => k.id));
  const back = [...v.values()].reduce((s, x) => s + x.back, 0);
  return Math.max(gross - back, 0);
}

module.exports = { forTickets, netPaidForTicket, ticketValue, lineKept };
