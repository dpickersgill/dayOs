'use strict';
// Which tenders paid for which lines of an order (2026.11.11), worked out one way for every refund: a line refund
// (routes/sales.js) and change day at the window (routes/guestswindow.js). Before this, money went back "last payment
// first" across the whole order, so a ticket paid by gift card in a basket with a gift card bought for cash came back as
// cash, and a comped ticket moved to a cheaper day paid out real cash.
//
// The rule. Payments are not tied to lines at the till, so they are shared out the one way the sale allows:
//   - a gift card line (a new gift card) is paid only by cash, card or other: a gift card or a comp cannot buy one
//     (routes/checkout.js), so its whole value is "free" money;
//   - every other line is paid by each tender in proportion: its share of gift card money, of comp, of money not paid
//     yet (a payment plan's later installments), and the rest by cash, card or other.
// Giving back: the gift card share goes back on the gift card (never as cash), the comp share gives back nothing, the
// unpaid share comes off the plan's later installments, and only the free share goes back as cash, card or other.
const { rows, one } = require('../db');
const { conflict, bad, forbidden } = require('./errors');
const { money } = require('./format');

const n = (x) => Number(x || 0);
const FREE = ['cash', 'card', 'other'];
const lineValue = (l) => Math.max(n(l.unit_price_cents) * n(l.quantity) - n(l.discount_cents), 0) + n(l.tax_cents);

/**
 * Splits what is to be given back for some lines of an order into its parts. order: the orders row; items: every line
 * of the order; pays: every order_payments row; picks: [{ line, cents }] (cents: the value to give back for that line,
 * tax included). Returns { gift, comp, unpaid, free } in cents (they add up to the picks).
 */
function mix(order, items, pays, picks) {
  const total = n(order.total_cents);
  const giftLines = items.filter((l) => l.line_kind === 'gift_card').reduce((s, l) => s + lineValue(l), 0);
  const rest = Math.max(total - giftLines, 0); // what every other line is worth together
  const sum = (t) => pays.filter((p) => p.tender === t).reduce((s, p) => s + n(p.amount_cents), 0);
  const giftPaid = sum('gift_card'); const compPaid = sum('comp');
  const unpaidAll = Math.max(total - pays.reduce((s, p) => s + n(p.amount_cents), 0), 0);
  const out = { gift: 0, comp: 0, unpaid: 0, free: 0 };
  for (const { line, cents } of picks) {
    const c = Math.max(n(cents), 0);
    if (line.line_kind === 'gift_card' || !rest) { out.free += c; continue; }
    const g = Math.round(c * Math.min(giftPaid / rest, 1));
    const k = Math.min(Math.round(c * Math.min(compPaid / rest, 1)), c - g);
    const u = Math.min(Math.round(c * Math.min(unpaidAll / rest, 1)), c - g - k);
    out.gift += g; out.comp += k; out.unpaid += u; out.free += c - g - k - u;
  }
  return out;
}

/**
 * The ways money goes back for { gift, free }: [{ method, cents }]. left(tender): what that tender still has to give
 * back on this order. method: a way staff picked (optional). The gift card share only ever goes back on the gift card;
 * the free share goes back by cash, card or other, last payment first, and only when that is used up onto a gift card
 * that paid. Throws a 409 when it cannot be placed.
 */
function plan({ gift, free }, pays, left, method = null) {
  const out = [];
  const put = (m, c) => { if (c <= 0) return; const s = out.find((x) => x.method === m); if (s) s.cents += c; else out.push({ method: m, cents: c }); };
  if (method && method !== 'gift_card' && gift > 0) throw conflict(`${money(gift)} of this was paid by gift card, so it goes back on the gift card. Leave the way to give it back empty, or pick gift card.`);
  if (method) {
    const todo = gift + free;
    if (todo > Math.max(left(method), 0)) throw conflict(`Only ${money(Math.max(left(method), 0))} is left to return by ${method.replace('_', ' ')}`);
    put(method, todo);
    return out;
  }
  if (gift > Math.max(left('gift_card'), 0)) throw conflict('There is not enough left on the gift card payments to give this back');
  put('gift_card', gift);
  let todo = free;
  const order = [...new Set(pays.filter((p) => FREE.includes(p.tender)).map((p) => p.tender).reverse())];
  for (const t of order) {
    if (todo <= 0) break;
    const give = Math.min(todo, Math.max(left(t), 0));
    put(t, give); todo -= give;
  }
  if (todo > 0) { // store credit is fine; cash is never made out of gift card money
    const give = Math.min(todo, Math.max(left('gift_card') - gift, 0));
    put('gift_card', give); todo -= give;
  }
  if (todo > 0) throw conflict('There is not enough left to refund from what was paid');
  return out;
}

/** What each tender of the order still has to give back: (tender) => cents. pays: the order's payments. */
async function leftOf(conn, tenantId, orderId, pays) {
  const returned = await rows(conn, 'SELECT method, SUM(amount_cents) AS cents FROM order_refunds WHERE tenant_id = ? AND order_id = ? GROUP BY method', [tenantId, orderId]);
  return (tender) => pays.filter((p) => p.tender === tender).reduce((s, p) => s + n(p.amount_cents), 0) - n((returned.find((r) => r.method === tender) || {}).cents);
}

/**
 * Puts gift card money back on the cards that paid this order, last first, each at most what it paid less what earlier
 * refunds put back (unless the card itself has since been canceled). Inside the refund's transaction.
 */
async function backOnCards(conn, tenantId, orderId, pays, cents) {
  let remaining = cents;
  for (const p of pays.filter((x) => x.tender === 'gift_card').reverse()) {
    if (remaining <= 0) break;
    const already = await one(conn, "SELECT COALESCE(SUM(delta_cents), 0) AS cents FROM gift_card_txns WHERE tenant_id = ? AND gift_card_id = ? AND order_id = ? AND kind = 'refund'", [tenantId, p.gift_card_id, orderId]);
    const put = Math.min(remaining, Math.max(n(p.amount_cents) - n(already.cents), 0));
    if (put <= 0) continue;
    const g = await one(conn, 'SELECT status, balance_cents FROM gift_cards WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, p.gift_card_id]);
    if (g && g.status === 'active') {
      const next = n(g.balance_cents) + put;
      await conn.query('UPDATE gift_cards SET balance_cents = ? WHERE tenant_id = ? AND id = ?', [next, tenantId, p.gift_card_id]);
      await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, order_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, ?, 'refund', ?, ?)", [tenantId, p.gift_card_id, orderId, put, next]);
    }
    remaining -= put;
  }
}

/**
 * "Other" money (a check, a partner voucher, a payment taken outside the app) never goes in the drawer, so at the counter
 * it is treated like a comp (2026.11.11): it needs a reference and a reason, and counter staff can record it, together
 * with any comp on the same sale, only up to the mountain's counter comp limit. Managers and owners always can.
 * tenant: { comp_counter_limit_cents }. other: [{ amount_cents, reference, reason }]; compCents: comp on the same sale.
 */
function checkOther(req, tenant, other, compCents = 0) {
  if (!other.length) return;
  for (const p of other) {
    if (!String(p.reference || '').trim()) throw bad('An "other" payment needs a reference (the check number, voucher or receipt)');
    if (p.reason !== undefined && !String(p.reason || '').trim()) throw bad('Say why this is paid another way');
  }
  const cents = other.reduce((s, p) => s + n(p.amount_cents), 0) + n(compCents);
  if (['owner', 'manager'].includes(req.auth.role)) return;
  const limit = n(tenant && tenant.comp_counter_limit_cents);
  if (cents > limit) throw forbidden(limit ? `Counter staff can record free or "other" payments up to ${money(limit)} on a sale. Ask a manager.` : 'Only a manager can record a payment taken another way. Ask a manager.');
}

module.exports = { mix, plan, leftOf, backOnCards, lineValue, checkOther };
