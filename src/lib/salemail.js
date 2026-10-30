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

// ---------------------------------------------------------------- the designed confirmation (Guests round 2, ACCOUNT)
// One email for a shop order or a window sale with an email: who, what, which day, the barcode drawn in table cells (it
// shows without images), where to park and where to go first, today's conditions, a first day step by step for a guest
// here for the first time, the conditions guarantee link when the mountain offers it (lib/fairprice.js), and a hidden spot
// kept for a wallet button later. A table layout that Gmail and Outlook draw the same, and a plain-text part.
const { esc, daysText } = require('./format');
const barcode = require('./emailbarcode');
const arrival = require('./arrival');
const { todayIn, addDays } = require('./util');

const FIRST_DAY = [
  'Come early: about an hour before you want to ride.',
  'Rentals: go to the rental shop first. Your sizes help us fit you fast.',
  'Lessons: meet your instructor at the meeting place 15 minutes before the start.',
  'Dress in layers, with gloves, goggles and a helmet. No cotton next to your skin.',
  'Scan your ticket at the lift. Ask any staff member if you are not sure where to go.',
];

/** The tickets on an order, with their person and whether that person is here for the first time. */
async function ticketsOf(tenantId, orderId) {
  const list = await rows(pool, `SELECT t.id, t.code, t.valid_from, t.valid_to, t.status, t.person_id, pr.name AS product, pr.kind, p.first_name, p.last_name
    FROM tickets t JOIN order_items i ON i.tenant_id = t.tenant_id AND i.id = t.order_item_id JOIN products pr ON pr.tenant_id = t.tenant_id AND pr.id = t.product_id
    LEFT JOIN people p ON p.tenant_id = t.tenant_id AND p.id = t.person_id WHERE t.tenant_id = ? AND i.order_id = ? AND t.status <> 'void' ORDER BY t.id`, [tenantId, orderId]);
  const V = require('./guestvisits');
  for (const k of list) {
    k.valid_from = String(k.valid_from instanceof Date ? k.valid_from.toISOString() : k.valid_from).slice(0, 10);
    k.valid_to = String(k.valid_to instanceof Date ? k.valid_to.toISOString() : k.valid_to).slice(0, 10);
    k.first_timer = k.person_id && ['day_ticket', 'multi_day', 'lesson', 'rental'].includes(k.kind) ? !(await V.daysHere(pool, tenantId, k.person_id, '2000-01-01', addDays(k.valid_from, -1))).length : false;
  }
  return list;
}

/** The confirmation's parts: { subject, text, html, to }. order: { orderId, shopOrderId } (one of them). */
async function confirmation(tenantId, { orderId = null, shopOrderId = null }, base = '') {
  const t = await one(pool, 'SELECT id, name, slug, phone, address, timezone FROM tenants WHERE id = ?', [tenantId]);
  let row = null;
  if (shopOrderId) row = await one(pool, 'SELECT id, reference, contact_name, contact_email, view_token, amount_cents, order_id FROM shop_orders WHERE tenant_id = ? AND id = ?', [tenantId, shopOrderId]);
  const oid = row ? row.order_id : orderId;
  if (!oid) return null;
  const to = row ? { name: row.contact_name, email: row.contact_email, token: row.view_token } : await recipientOf(tenantId, oid);
  if (!to || !to.email) return null;
  const order = await one(pool, 'SELECT id, total_cents FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, oid]);
  const tickets = await ticketsOf(tenantId, oid);
  const gifts = await rows(pool, 'SELECT code, initial_cents, recipient_name FROM gift_cards WHERE tenant_id = ? AND order_id = ? ORDER BY id', [tenantId, oid]);
  const arrive = await arrival.get(pool, tenantId);
  const cond = await arrival.conditions(pool, tenantId, todayIn(t.timezone)).catch(() => null);
  const fair = require('./fairprice');
  for (const k of tickets) k.guarantee = await fair.guaranteeLink(pool, tenantId, k.id, base).catch(() => null);
  const firstTimers = tickets.filter((k) => k.first_timer).map((k) => k.first_name).filter(Boolean);
  const link = to.token && base ? `${base}/shop/${t.slug}?order=${to.token}` : null;
  const account = base ? `${base}/family/${t.slug}` : null;
  const condLink = base ? `${base}/shop/${t.slug}` : null;
  const ref = row ? row.reference : `order ${oid}`;
  const total = row ? row.amount_cents : order ? order.total_cents : 0;
  const days = [...new Set(tickets.map((k) => k.valid_from))].sort();
  const subject = days.length ? `Your tickets for ${t.name}: ${dayText(days[0])}` : `Your order at ${t.name}`;
  const who = (k) => `${k.first_name ? `${k.first_name} ${k.last_name}` : 'Guest'}`;

  const text = [`Hi ${first(to.name)},`, '', `You are all set for ${t.name} (${ref}, ${money(total)}).`, '',
    ...tickets.map((k) => `- ${who(k)}: ${k.product}, ${daysText(k.valid_from, k.valid_to)}. Code ${k.code}${k.guarantee ? `. Conditions guarantee: ${k.guarantee}` : ''}`),
    ...gifts.map((g) => `- Gift card ${g.code}, ${money(g.initial_cents)}${g.recipient_name ? ` for ${g.recipient_name}` : ''}`), '',
    'Show the barcode at the lift. Turn your screen brightness up.', link ? `Your tickets: ${link}` : '', '',
    `Where to park: ${arrive.park_text}`, `Where to go first: ${arrive.first_text}`, t.address ? `Find us: ${t.address}` : '',
    cond && cond.words ? `Today at ${t.name}: ${cond.words}.` : '', condLink ? `Conditions: ${condLink}` : '', '',
    ...(firstTimers.length ? [`${firstTimers.join(' and ')}: your first day, step by step`, ...FIRST_DAY.map((x, i) => `${i + 1}. ${x}`), ''] : []),
    account ? `Your account (passes, family, rewards): ${account}` : '', t.phone ? `Questions? Call ${t.phone}.` : ''].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');

  const C = { ink: '#12303a', soft: '#5b6b73', line: '#d9e1e5', bg: '#f3f6f7', accent: '#1a5fb4' };
  const td = (inner, style = '') => `<tr><td style="padding:0 24px;${style}">${inner}</td></tr>`;
  const ticketHtml = (k) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.line};border-radius:8px;margin:0 0 16px">
    <tr><td style="padding:16px 16px 8px;font:600 18px/1.3 Arial,Helvetica,sans-serif;color:${C.ink}">${esc(who(k))}</td></tr>
    <tr><td style="padding:0 16px 12px;font:15px/1.4 Arial,Helvetica,sans-serif;color:${C.soft}">${esc(k.product)}<br><b style="color:${C.ink}">${esc(daysText(k.valid_from, k.valid_to))}</b></td></tr>
    <tr><td align="center" style="padding:8px 16px">${barcode.table(k.code)}</td></tr>
    <tr><td align="center" style="padding:4px 16px 16px;font:700 22px/1.2 'Courier New',Courier,monospace;letter-spacing:3px;color:#000">${esc(k.code)}</td></tr>
    ${k.guarantee ? `<tr><td style="padding:0 16px 16px;font:14px/1.4 Arial,Helvetica,sans-serif;color:${C.soft}">Conditions not good? <a href="${esc(k.guarantee)}" style="color:${C.accent}">Use the conditions guarantee</a>.</td></tr>` : ''}
  </table>`;
  const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px"><tr><td bgcolor="${C.accent}" style="border-radius:6px"><a href="${esc(href)}" style="display:inline-block;padding:12px 20px;font:600 16px Arial,Helvetica,sans-serif;color:#ffffff;text-decoration:none">${esc(label)}</a></td></tr></table>`;
  const p = (s, extra = '') => `<p style="margin:0 0 12px;font:15px/1.5 Arial,Helvetica,sans-serif;color:${C.ink};${extra}">${s}</p>`;
  const h2 = (s) => `<h2 style="margin:16px 0 8px;font:700 17px/1.3 Arial,Helvetica,sans-serif;color:${C.ink}">${s}</h2>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px">
  <tr><td bgcolor="${C.ink}" style="padding:20px 24px;border-radius:10px 10px 0 0;font:700 20px/1.3 Arial,Helvetica,sans-serif;color:#ffffff">${esc(t.name)}<br><span style="font:15px Arial,Helvetica,sans-serif;color:#cfe0e6">You are all set, ${esc(first(to.name))}.</span></td></tr>
  ${td(p(`${esc(ref)} &middot; ${esc(money(total))}`, `color:${C.soft};margin-top:16px`))}
  ${td(tickets.map(ticketHtml).join('') + gifts.map((g) => p(`Gift card <b>${esc(g.code)}</b>, ${esc(money(g.initial_cents))}${g.recipient_name ? ` for ${esc(g.recipient_name)}` : ''}`)).join(''))}
  ${td(p('Show the barcode at the lift. Turn your screen brightness up.') + (link ? button(link, 'Open your tickets') : ''))}
  <!-- wallet: a spot for "Add to Apple Wallet" and "Add to Google Wallet" buttons (not built yet). Keep it hidden until then. -->
  <tr><td data-slot="wallet" style="display:none;max-height:0;overflow:hidden;mso-hide:all"></td></tr>
  ${td(h2('Getting here') + p(`<b>Park:</b> ${esc(arrive.park_text)}`) + p(`<b>First:</b> ${esc(arrive.first_text)}`) + (t.address ? p(esc(t.address), `color:${C.soft}`) : ''))}
  ${cond && cond.words ? td(h2('Today on the mountain') + p(`${esc(cond.words.charAt(0).toUpperCase() + cond.words.slice(1))}.${condLink ? ` <a href="${esc(condLink)}" style="color:${C.accent}">See conditions</a>` : ''}`)) : condLink ? td(p(`<a href="${esc(condLink)}" style="color:${C.accent}">Today's conditions</a>`)) : ''}
  ${firstTimers.length ? td(h2(`${esc(firstTimers.join(' and '))}: your first day, step by step`) + `<ol style="margin:0 0 12px;padding-left:20px;font:15px/1.5 Arial,Helvetica,sans-serif;color:${C.ink}">${FIRST_DAY.map((x) => `<li style="margin:0 0 6px">${esc(x)}</li>`).join('')}</ol>`) : ''}
  ${account ? td(p(`Passes, family and rewards are in <a href="${esc(account)}" style="color:${C.accent}">your account</a>.`, `color:${C.soft}`)) : ''}
  ${td(p(t.phone ? `Questions? Call ${esc(t.phone)}.` : '&nbsp;', `color:${C.soft};padding-bottom:12px`))}
</table></td></tr></table></body></html>`;
  return { to, subject, text, html, tickets, orderId: oid };
}

/** Sends the confirmation. Returns true when it went. */
async function sendConfirmation(tenantId, which, base) {
  if (!mailer.enabled()) return false;
  const c = await confirmation(tenantId, which, base);
  if (!c) return false;
  const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [tenantId]);
  const r = await mailer.send({ tenantId, to: c.to.email, fromName: t.name, subject: c.subject, text: c.text, html: c.html, tag: 'confirmation' });
  return r.ok;
}

module.exports = { refundEmail, changeEmail, recipientOf, cardWords, confirmation, sendConfirmation, ticketsOf, FIRST_DAY };
