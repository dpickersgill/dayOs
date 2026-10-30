'use strict';

// The emails a guest gets when a sale changes after it was made: a refund (what was refunded, how much, and where the
// money goes) and a ticket moved to another day online (the old day, the new day, and anything paid). Plain words, in
// the same style as the ticket email (lib/shopsale.js emailTickets). Sending never undoes the change: a failure is logged
// by the mailer and the change stands.
const { pool, rows, one } = require('../db');
const mailer = require('./mailer');
const { money, dayText } = require('./format');

const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };

/** Who hears about an order: the online buyer's email, else the customer on the order when they have one. */
async function recipientOf(tenantId, orderId) {
  const shop = await one(pool, "SELECT contact_name, contact_email, view_token FROM shop_orders WHERE tenant_id = ? AND order_id = ? AND status = 'paid' ORDER BY id LIMIT 1", [tenantId, orderId]);
  if (shop && shop.contact_email) return { name: shop.contact_name, email: shop.contact_email, token: shop.view_token };
  const p = await one(pool, 'SELECT p.first_name, p.last_name, p.email FROM orders o JOIN people p ON p.tenant_id = o.tenant_id AND p.id = o.person_id WHERE o.tenant_id = ? AND o.id = ?', [tenantId, orderId]);
  if (p && p.email) return { name: `${p.first_name} ${p.last_name}`, email: p.email, token: null };
  return null;
}

/** "your Visa ending 4242", or "the card you paid with" when the card's details were never seen (an online payment). */
function cardWords(pays) {
  const c = pays.find((p) => p.tender === 'card' && p.card_last4);
  if (!c) return 'the card you paid with';
  return `your ${BRANDS[c.card_brand] || 'card'} ending ${c.card_last4}`;
}

/**
 * After a refund: what was refunded, the amount back, and where it goes (the card, cash at the window, the gift card).
 * refund: { amount_cents, returns: [{ method, amount_cents }], item_ids }. Returns true when an email went.
 */
async function refundEmail(tenantId, orderId, refund, baseUrl) {
  if (!mailer.enabled() || !refund || !refund.amount_cents) return false;
  const to = await recipientOf(tenantId, orderId);
  if (!to) return false;
  const t = await one(pool, 'SELECT name, slug, phone FROM tenants WHERE id = ?', [tenantId]);
  const pays = await rows(pool, 'SELECT tender, card_brand, card_last4 FROM order_payments WHERE tenant_id = ? AND order_id = ? ORDER BY id', [tenantId, orderId]);
  const lines = refund.item_ids && refund.item_ids.length ? await rows(pool, `SELECT COALESCE(i.label, pr.name, pg.name, CASE i.line_kind WHEN 'gift_card' THEN 'Gift card' ELSE 'Item' END) AS name, i.valid_on, p.first_name, p.last_name
      FROM order_items i LEFT JOIN products pr ON pr.tenant_id = i.tenant_id AND pr.id = i.product_id LEFT JOIN programs pg ON pg.tenant_id = i.tenant_id AND pg.id = i.program_id
      LEFT JOIN people p ON p.tenant_id = i.tenant_id AND p.id = i.person_id WHERE i.tenant_id = ? AND i.order_id = ? AND i.id IN (?) ORDER BY i.id`, [tenantId, orderId, refund.item_ids]) : [];
  const where = (r) => (r.method === 'card' ? `${money(r.amount_cents)} back to ${cardWords(pays)}. It usually shows on your statement in 5 to 10 business days.`
    : r.method === 'cash' ? `${money(r.amount_cents)} in cash, handed back at the window.`
      : r.method === 'gift_card' ? `${money(r.amount_cents)} back on your gift card.` : `${money(r.amount_cents)} returned.`);
  const text = [`Hi ${first(to.name)},`, '', `We refunded ${refund.whole_order ? 'your order' : 'part of your order'} at ${t.name} (order ${orderId}).`, '',
    ...(lines.length ? ['What was refunded:', ...lines.map((l) => `- ${l.name}${l.first_name ? `, ${l.first_name} ${l.last_name}` : ''}${l.valid_on ? `, ${dayText(l.valid_on)}` : ''}`), ''] : []),
    'The money:', ...(refund.returns || []).filter((r) => r.amount_cents > 0).map((r) => `- ${where(r)}`), '',
    ...(lines.length ? ['Refunded tickets no longer work at the gate.', ''] : []),
    ...(to.token && baseUrl ? ['Your order:', `${baseUrl}/shop/${t.slug}?order=${to.token}`, ''] : []),
    t.phone ? `Questions? Call ${t.phone}.` : ''].join('\n');
  const r = await mailer.send({ tenantId, to: to.email, fromName: t.name, subject: `Your refund from ${t.name}: ${money(refund.amount_cents)}`, text, tag: 'shop-refund' });
  return r.ok;
}

/** After a ticket moved to another day online: the old day, the new day, and what the change cost. */
async function changeEmail(tenantId, { shopOrderId, ticketId, from, to: newDay, paidCents = 0 }, baseUrl) {
  if (!mailer.enabled()) return false;
  const row = await one(pool, 'SELECT contact_name, contact_email, view_token, reference FROM shop_orders WHERE tenant_id = ? AND id = ?', [tenantId, shopOrderId]);
  if (!row || !row.contact_email) return false;
  const t = await one(pool, 'SELECT name, slug, phone FROM tenants WHERE id = ?', [tenantId]);
  const k = await one(pool, 'SELECT pr.name AS product, p.first_name, p.last_name, t.code FROM tickets t JOIN products pr ON pr.tenant_id = t.tenant_id AND pr.id = t.product_id LEFT JOIN people p ON p.tenant_id = t.tenant_id AND p.id = t.person_id WHERE t.tenant_id = ? AND t.id = ?', [tenantId, ticketId]);
  if (!k) return false;
  const text = [`Hi ${first(row.contact_name)},`, '', `Your ticket at ${t.name} has moved to a new day.`, '',
    `- ${k.product}${k.first_name ? `, ${k.first_name} ${k.last_name}` : ''}`,
    `- Was: ${dayText(from)}`, `- Now: ${dayText(newDay)}`,
    paidCents ? `- You paid ${money(paidCents)} for the change.` : '- The change was free.', '',
    'The barcode is the same. Show it at the gate on the new day. Your tickets are here:', baseUrl ? `${baseUrl}/shop/${t.slug}?order=${row.view_token}` : `Order ${row.reference}`, '',
    t.phone ? `Questions? Call ${t.phone}.` : ''].join('\n');
  const r = await mailer.send({ tenantId, to: row.contact_email, fromName: t.name, subject: `Your ticket is now for ${dayText(newDay)}`, text, tag: 'shop-change' });
  return r.ok;
}

module.exports = { refundEmail, changeEmail, recipientOf, cardWords };
