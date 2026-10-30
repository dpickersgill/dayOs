'use strict';
// Fair by design (Track FAIR): the walk-up cap, when a day's price rises next, the price-drop promise, closure credits,
// the conditions guarantee and the fair scan review (flags a manager looks at, blocks a guest can answer). Each promise
// is a mountain setting, off by default (lib/guestsettings.js). Callers: lib/pricing.js and the window (cap), the online
// shop calendar (nextRise, badges), the confirmation email (guaranteeLink), the gate (holdFor) and the guests job.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const config = require('../config');
const G = require('./guestsettings');
const rewards = require('./rewards');
const mailer = require('./mailer');
const cardrefund = require('./cardrefund');
const { audit } = require('./audit');
const { money, dayText } = require('./format');
const { addDays, todayIn, seasonFor, dayRange, localTime } = require('./util');
const utc = (s) => (s ? new Date(`${String(s).replace(' ', 'T').slice(0, 19)}Z`) : null);
const { conflict, notFound, bad } = require('./errors');
const { seasonRange } = require('./guestvisits');

const TICKET_KINDS = ['day_ticket', 'multi_day'];
const dstr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
const system = (tenantId) => ({ auth: { tenantId, userId: null }, ip: null });

// ---------------------------------------------------------------- settings and private links
const FAIR_DEFAULTS = { renew_on: null, renew_rule: 'lower', travel_minutes: 5 };
/** guest_settings plus this track's own (fair_settings). */
async function settings(db, tenantId) {
  const g = await G.get(db, tenantId);
  const f = await one(db, 'SELECT renew_on, renew_rule, travel_minutes FROM fair_settings WHERE tenant_id = ?', [tenantId]);
  const out = { ...g, ...FAIR_DEFAULTS, ...(f || {}) };
  if (out.renew_on) out.renew_on = dstr(out.renew_on);
  return out;
}
async function saveFair(conn, tenantId, fields) {
  const keys = Object.keys(fields).filter((k) => k in FAIR_DEFAULTS);
  if (!keys.length) return;
  await conn.query(`INSERT INTO fair_settings (tenant_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(', ')}`, [tenantId, ...keys.map((k) => fields[k])]);
}

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
/** A new private link token (43 characters, random). Only its hash is kept. */
async function newLink(db, tenantId, kind, refId, { days = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('INSERT INTO fair_links (tenant_id, kind, ref_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
    [tenantId, kind, refId, hash(token), days ? new Date(Date.now() + days * 864e5) : null]);
  return token;
}
/** The row a private link points at, or null (unknown, another kind, another mountain, or expired). */
async function linkFor(db, slug, kind, token) {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(String(token || ''))) return null;
  const l = await one(db, `SELECT l.*, t.id AS tid, t.name AS mountain, t.slug, t.phone, t.timezone FROM fair_links l JOIN tenants t ON t.id = l.tenant_id
    WHERE l.token_hash = ? AND l.kind = ? AND t.slug = ? AND (l.expires_at IS NULL OR l.expires_at > NOW())`, [hash(token), kind, String(slug)]);
  return l;
}
const baseOf = (base) => base || config.stripe.publicUrl || '';

async function mail(tenantId, to, subject, lines, tag) {
  if (!to || !mailer.enabled()) return false;
  const t = await one(pool, 'SELECT name, phone FROM tenants WHERE id = ?', [tenantId]);
  const text = [...lines, '', t.phone ? `Questions? Call ${t.phone}.` : '', t.name].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
  const r = await mailer.send({ tenantId, to, fromName: t.name, subject, text, tag });
  return r.ok;
}
/** Who hears about a ticket: the online buyer, else the holder, else the customer on the order. */
async function contactOf(db, tenantId, ticketId) {
  const r = await one(db, `SELECT k.order_item_id, i.order_id, hp.first_name AS h_first, hp.email AS h_email, op.first_name AS o_first, op.email AS o_email,
      (SELECT so.contact_email FROM shop_orders so WHERE so.tenant_id = k.tenant_id AND so.order_id = i.order_id ORDER BY so.id LIMIT 1) AS s_email,
      (SELECT so.contact_name FROM shop_orders so WHERE so.tenant_id = k.tenant_id AND so.order_id = i.order_id ORDER BY so.id LIMIT 1) AS s_name
    FROM tickets k JOIN order_items i ON i.tenant_id = k.tenant_id AND i.id = k.order_item_id JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
    LEFT JOIN people hp ON hp.tenant_id = k.tenant_id AND hp.id = k.person_id LEFT JOIN people op ON op.tenant_id = o.tenant_id AND op.id = o.person_id
    WHERE k.tenant_id = ? AND k.id = ?`, [tenantId, ticketId]);
  if (!r) return null;
  if (r.s_email) return { email: r.s_email, name: first(r.s_name), holder: r.h_first };
  if (r.h_email) return { email: r.h_email, name: r.h_first, holder: r.h_first };
  if (r.o_email) return { email: r.o_email, name: r.o_first, holder: r.h_first };
  return null;
}
/** The last day credits are good for: the end of the season (tenants.season_ends_on, else Jul 31 of the season). */
async function seasonEnd(db, tenantId, day) {
  const t = await one(db, 'SELECT season_ends_on FROM tenants WHERE id = ?', [tenantId]);
  const end = t && t.season_ends_on ? dstr(t.season_ends_on) : null;
  return end && end >= day ? end : seasonRange(seasonFor(day))[1];
}

// ---------------------------------------------------------------- prices: the cap and the next rise
/** The best price the shop ever offers for this product and day (the early-buy price, when there is one). */
function bestOnline(product, cents) {
  const days = Number(product.advance_days); const pct = Number(product.advance_percent);
  if (!days || !pct || pct > 90) return cents;
  return cents - Math.round(cents * pct / 100);
}
/**
 * The walk-up cap in detail: { cents, capped, online_cents, cap_cents }. windowCents is the window's price; the cap
 * keeps it within cap_cents of the best online price for the same ticket and day. Only day and multi-day tickets.
 */
async function walkup(db, tenantId, { product, windowCents }) {
  const out = { cents: windowCents, capped: false, online_cents: null, cap_cents: null };
  if (!product || !TICKET_KINDS.includes(product.kind)) return out;
  const s = await G.get(db, tenantId);
  if (!Number(s.walkup_cap_on) || s.walkup_cap_cents === null || s.walkup_cap_cents === undefined) return out;
  const online = bestOnline(product, windowCents);
  const most = online + Number(s.walkup_cap_cents);
  Object.assign(out, { online_cents: online, cap_cents: Number(s.walkup_cap_cents) });
  if (windowCents > most) Object.assign(out, { cents: most, capped: true });
  return out;
}
/** The window or same-day price after the walk-up cap (contract). product: the products row (or productId). */
async function capWalkup(db, tenantId, { windowCents, product = null, productId = null }) {
  const p = product || (productId ? await one(db, 'SELECT * FROM products WHERE tenant_id = ? AND id = ?', [tenantId, productId]) : null);
  return (await walkup(db, tenantId, { product: p, windowCents })).cents;
}

/**
 * When this product's online price for this day goes up next, or null: { on: 'YYYY-MM-DD', cents, from_cents, to_cents }.
 * A day's price is fixed by its date price, guest type and base price; what changes as the day comes closer is the
 * early-buy discount ("buy N days ahead and save"), which ends N-1 days before the visit. tier: the guest type (adult).
 */
async function nextRise(db, tenantId, productId, day, { tier = 'adult', today = null, product = null } = {}) {
  const p = product || await one(db, 'SELECT * FROM products WHERE tenant_id = ? AND id = ?', [tenantId, productId]);
  if (!p || !TICKET_KINDS.includes(p.kind)) return null;
  const days = Number(p.advance_days); const pct = Number(p.advance_percent);
  if (!days || !pct || pct > 90) return null;
  const now = today || todayIn((await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
  const gap = Math.round((new Date(`${day}T12:00:00Z`) - new Date(`${now}T12:00:00Z`)) / 864e5);
  if (gap < days) return null; // the early price has already ended for this day
  let base;
  try { base = (await require('./pricing').unitPrice(db, tenantId, p.id, tier, day)).cents; } catch (_) { return null; }
  const off = Math.round(base * pct / 100);
  if (!off) return null;
  return { on: addDays(day, -(days - 1)), cents: off, from_cents: base - off, to_cents: base };
}

/** Badges for the shop: one per promise the mountain has on, with the words the guest sees. */
async function badges(db, tenantId) {
  const s = await G.get(db, tenantId);
  const out = [];
  if (Number(s.walkup_cap_on) && s.walkup_cap_cents !== null) out.push({ key: 'walkup_cap', text: 'Fair walk-up price', detail: `The ticket window never charges more than ${money(Number(s.walkup_cap_cents))} over the best online price.` });
  if (Number(s.price_promise_on)) out.push({ key: 'price_promise', text: 'Price-drop promise', detail: 'Bought online and the price for your day goes down? We refund the difference to your card.' });
  if (Number(s.closure_credit_on)) out.push({ key: 'closure_credit', text: 'Closure credit', detail: 'If we close on your day and you did not ski, you get a credit for the season.' });
  if (Number(s.conditions_guarantee_on)) out.push({ key: 'conditions_guarantee', text: 'Conditions guarantee', detail: `Not happy with the conditions? Tell us within ${s.conditions_hours} hours of your first lift and get a credit.` });
  if (Number(s.plans_on)) out.push({ key: 'payment_plan', text: `Pay in ${s.plans_count}`, detail: `Season passes can be paid in ${s.plans_count} monthly payments.` });
  if (Number(s.autorenew_on)) out.push({ key: 'auto_renew', text: 'Auto-renew', detail: 'Pass holders can renew automatically at the best price.' });
  return out;
}

// ---------------------------------------------------------------- the conditions guarantee
/** A private link for the guest's conditions guarantee on a day ticket, or null when it is off (contract). */
async function guaranteeLink(db, tenantId, ticketId, base) {
  const s = await G.get(db, tenantId);
  if (!Number(s.conditions_guarantee_on)) return null;
  const k = await one(db, 'SELECT k.id, p.kind FROM tickets k JOIN products p ON p.tenant_id = k.tenant_id AND p.id = k.product_id WHERE k.tenant_id = ? AND k.id = ?', [tenantId, ticketId]);
  if (!k || !TICKET_KINDS.includes(k.kind)) return null;
  const t = await one(db, 'SELECT slug FROM tenants WHERE id = ?', [tenantId]);
  return `${baseOf(base)}/guarantee/${t.slug}/${await newLink(db, tenantId, 'guarantee', ticketId)}`;
}
/** What the guarantee page shows, and whether the guest can claim now. */
async function guaranteeView(db, l) {
  const tenantId = l.tenant_id;
  const s = await G.get(db, tenantId);
  const k = await one(db, `SELECT k.id, k.code, k.valid_from, k.valid_to, k.status, k.person_id, k.order_item_id, p.name AS product, i.unit_price_cents, pe.first_name
    FROM tickets k JOIN products p ON p.tenant_id = k.tenant_id AND p.id = k.product_id JOIN order_items i ON i.tenant_id = k.tenant_id AND i.id = k.order_item_id
    LEFT JOIN people pe ON pe.tenant_id = k.tenant_id AND pe.id = k.person_id WHERE k.tenant_id = ? AND k.id = ?`, [tenantId, l.ref_id]);
  if (!k) throw notFound('Ticket');
  const today = todayIn(l.timezone);
  const [dayFrom, dayTo] = dayRange(l.timezone, today);
  const firstScan = await one(db, "SELECT MIN(scanned_at) AS at FROM scans WHERE tenant_id = ? AND ticket_id = ? AND result = 'ok' AND scanned_at >= ? AND scanned_at < ?", [tenantId, k.id, dayFrom, dayTo]);
  const claimed = await one(db, "SELECT id, code, credit_cents, options, valid_to, created_at FROM guest_rewards WHERE tenant_id = ? AND source_key = ? LIMIT 1", [tenantId, `conditions:${k.id}`]);
  const off = await one(db, 'SELECT on_date FROM fair_guarantee_off WHERE tenant_id = ? AND on_date = ?', [tenantId, today]);
  const hours = Number(s.conditions_hours);
  const at = firstScan && firstScan.at ? utc(firstScan.at) : null;
  const until = at ? new Date(at.getTime() + hours * 36e5) : null;
  let state = 'open'; let why = null;
  if (claimed) state = 'claimed';
  else if (!Number(s.conditions_guarantee_on)) { state = 'closed'; why = 'The conditions guarantee is not offered right now.'; }
  else if (off) { state = 'closed'; why = 'The conditions guarantee is off today. Please see the ticket window.'; }
  else if (k.status === 'void') { state = 'closed'; why = 'This ticket was refunded.'; }
  else if (!at) { state = 'waiting'; why = `The guarantee starts when you scan in at the first lift. Then you have ${hours} hours.`; }
  else if (Date.now() > until.getTime()) { state = 'closed'; why = `The guarantee was good for ${hours} hours after your first lift.`; }
  const cents = Number(k.unit_price_cents);
  return { mountain: l.mountain, phone: l.phone, ticket: { product: k.product, day: dstr(k.valid_from), first_name: k.first_name || null }, hours, state, why,
    first_scan_at: at ? at.toISOString() : null, until: until ? until.toISOString() : null, credit_cents: cents, has_holder: Boolean(k.person_id),
    reward: claimed ? { code: claimed.code, cents: (rewards.shape(claimed).options.credit || {}).cents, valid_to: dstr(claimed.valid_to) } : null };
}
/** The guest says the conditions were not good: a conditions credit, once per ticket, within the hours. */
async function claimGuarantee(l, { note }) {
  const v = await guaranteeView(pool, l);
  if (v.state === 'claimed') return v;
  if (v.state !== 'open') throw conflict(v.why || 'The guarantee cannot be used now.');
  const k = await one(pool, 'SELECT id, person_id, order_item_id FROM tickets WHERE tenant_id = ? AND id = ?', [l.tenant_id, l.ref_id]);
  let personId = k.person_id;
  if (!personId) {
    const o = await one(pool, 'SELECT o.person_id FROM order_items i JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id WHERE i.tenant_id = ? AND i.id = ?', [l.tenant_id, k.order_item_id]);
    personId = o && o.person_id;
  }
  if (!personId) throw conflict('This ticket has no name on it. Please see the ticket window and we will sort it out.');
  const today = todayIn(l.timezone);
  await tx(async (conn) => {
    await conn.query('SELECT id FROM tickets WHERE tenant_id = ? AND id = ? FOR UPDATE', [l.tenant_id, k.id]);
    const r = await rewards.issue(conn, l.tenant_id, { personId, kind: 'conditions', reason: `Conditions guarantee${note ? `: ${String(note).slice(0, 150)}` : ''}`, options: { credit: { cents: v.credit_cents } },
      validFrom: today, validTo: await seasonEnd(conn, l.tenant_id, today), sourceKey: `conditions:${k.id}` });
    await audit(conn, system(l.tenant_id), 'conditions_claim', 'guest_rewards', r.id, { ticket_id: k.id, credit_cents: v.credit_cents, note: note || null });
  });
  const c = await contactOf(pool, l.tenant_id, k.id);
  const v2 = await guaranteeView(pool, l);
  if (c && v2.reward) {
    await mail(l.tenant_id, c.email, `Your conditions credit from ${l.mountain}`, [`Hi ${c.name},`, '', `Sorry the conditions were not what you hoped for. Here is a credit of ${money(v2.reward.cents)} for another day this season.`, '',
      `Your code: ${v2.reward.code}`, `Good through ${dayText(v2.reward.valid_to)}. Show the code at the ticket window, or use it online.`]).catch(() => {});
  }
  return v2;
}
/** Manager: claims for a range of days, and whether the guarantee is off on each day. */
async function guaranteeClaims(db, tenantId, from, to) {
  const data = await rows(db, `SELECT r.id, r.code, r.reason, r.status, r.options, r.created_at, p.first_name, p.last_name FROM guest_rewards r JOIN people p ON p.tenant_id = r.tenant_id AND p.id = r.person_id
    WHERE r.tenant_id = ? AND r.kind = 'conditions' AND r.created_at >= ? AND r.created_at < ? ORDER BY r.id DESC LIMIT 300`, [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 06:00:00`]);
  const off = await rows(db, 'SELECT on_date FROM fair_guarantee_off WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date', [tenantId, from, addDays(to, 30)]);
  return { data: data.map((r) => ({ id: r.id, code: r.code, reason: r.reason, status: r.status, cents: (rewards.shape(r).options.credit || {}).cents || 0, at: r.created_at, name: `${r.first_name} ${r.last_name}` })), off_days: off.map((o) => dstr(o.on_date)) };
}

// ---------------------------------------------------------------- the price-drop promise
/**
 * Daily: tickets for a future day bought online and paid by card. When the online price for that ticket, day and guest
 * type is now lower than the guest paid (after any earlier drop refunds), the difference (and its tax) goes back to the
 * card through the card refund process (order_refunds, lib/cardrefund.js), once per ticket per lower price, audited, and
 * the guest gets an email. Window sales are skipped: they were not bought ahead, and cash cannot go back to a card.
 */
async function priceDrops(tenantId) {
  const s = await G.get(pool, tenantId);
  if (!Number(s.price_promise_on)) return { checked: 0, refunded: 0 };
  const t = await one(pool, 'SELECT id, timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const { advance } = require('./shopsale');
  const { unitPrice } = require('./pricing');
  const cands = await rows(pool, `SELECT k.id AS ticket_id, k.valid_from, i.id AS item_id, i.order_id, i.tier, i.unit_price_cents, i.quantity, i.tax_cents, i.refunded_at, p.*
      FROM tickets k JOIN order_items i ON i.tenant_id = k.tenant_id AND i.id = k.order_item_id JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
      JOIN products p ON p.tenant_id = k.tenant_id AND p.id = k.product_id
     WHERE k.tenant_id = ? AND k.status = 'active' AND k.valid_from > ? AND o.channel = 'online' AND o.status = 'paid' AND i.refunded_at IS NULL
       AND p.kind IN ('day_ticket','multi_day') AND EXISTS (SELECT 1 FROM order_payments op WHERE op.tenant_id = o.tenant_id AND op.order_id = o.id AND op.processor = 'stripe' AND op.reference LIKE 'pi\\_%')
     ORDER BY k.id LIMIT 2000`, [tenantId, today]);
  let refunded = 0; const sent = [];
  for (const c of cands) {
    const day = dstr(c.valid_from);
    let now;
    try { now = advance(c, today, day, (await unitPrice(pool, tenantId, c.id, c.tier, day)).cents).cents; } catch (_) { continue; }
    const before = await one(pool, 'SELECT MIN(to_cents) AS low FROM fair_price_drops WHERE tenant_id = ? AND ticket_id = ?', [tenantId, c.ticket_id]);
    const paid = before && before.low !== null ? Math.min(Number(before.low), Number(c.unit_price_cents)) : Number(c.unit_price_cents);
    if (now >= paid) continue;
    const out = await tx(async (conn) => {
      const order = await one(conn, 'SELECT id, total_cents, refunded_cents FROM orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, c.order_id]);
      const diff = paid - now;
      const perUnitTax = Number(c.quantity) > 0 ? Number(c.tax_cents) / Number(c.quantity) : 0;
      const tax = Number(c.unit_price_cents) > 0 ? Math.round(perUnitTax * diff / Number(c.unit_price_cents)) : 0;
      const amount = Math.min(diff + tax, Number(order.total_cents) - Number(order.refunded_cents));
      if (amount <= 0) return null;
      const [d] = await conn.query('INSERT IGNORE INTO fair_price_drops (tenant_id, ticket_id, order_id, from_cents, to_cents, refund_cents) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, c.ticket_id, c.order_id, paid, now, amount]);
      if (d.affectedRows !== 1) return null; // this drop was already refunded
      const card = await one(conn, "SELECT reference FROM order_payments WHERE tenant_id = ? AND order_id = ? AND processor = 'stripe' AND reference LIKE 'pi\\_%' ORDER BY id LIMIT 1", [tenantId, order.id]);
      const [rf] = await conn.query("INSERT INTO order_refunds (tenant_id, order_id, user_id, reason, note, amount_cents, tax_cents, method) VALUES (?, ?, NULL, 'price_promise', ?, ?, ?, 'card')",
        [tenantId, order.id, `Price for ${dayText(day)} went from ${money(paid)} to ${money(now)}`, amount, Math.min(tax, amount)]);
      await cardrefund.markPending(conn, tenantId, rf.insertId, card.reference);
      await conn.query('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE tenant_id = ? AND id = ?', [amount, tenantId, order.id]);
      await conn.query('UPDATE fair_price_drops SET refund_id = ? WHERE id = ?', [rf.insertId, d.insertId]);
      await audit(conn, system(tenantId), 'price_promise_refund', 'tickets', c.ticket_id, { order_id: order.id, from_cents: paid, to_cents: now, refund_cents: amount });
      return { refundId: rf.insertId, amount, day, paid, now, ticketId: c.ticket_id, name: c.name };
    });
    if (!out) continue;
    refunded += 1;
    await cardrefund.send(tenantId, out.refundId);
    sent.push(out);
  }
  for (const o of sent) {
    const ct = await contactOf(pool, tenantId, o.ticketId);
    if (ct) await mail(tenantId, ct.email, `Good news: the price for your day went down`, [`Hi ${ct.name},`, '', `The price of ${o.name} for ${dayText(o.day)} went down from ${money(o.paid)} to ${money(o.now)}.`,
      `We promised you would never pay more than the online price, so ${money(o.amount)} is on its way back to your card. It usually shows in 5 to 10 business days.`, '', 'Your ticket stays the same. See you on the mountain.'], 'price-promise').catch(() => {});
  }
  return { checked: cands.length, refunded };
}

// ---------------------------------------------------------------- closure credits
/**
 * Who would get a closure credit for a day: each day ticket valid that day that did not scan (or, with closedFrom,
 * scanned only before that time, mountain time). A ticket with no name on it and an order with no customer is listed
 * as skipped. Returns { day, items: [{ ticket_id, name, product, cents, why }], skipped: n, total_cents }.
 */
async function closurePreview(db, tenantId, day, { closedFrom = null } = {}) {
  const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const [from, to] = dayRange(t.timezone, day);
  const list = await rows(db, `SELECT k.id, k.person_id, o.person_id AS buyer_id, i.unit_price_cents, i.quantity, p.name AS product, COALESCE(hp.first_name, bp.first_name) AS first_name, COALESCE(hp.last_name, bp.last_name) AS last_name,
      (SELECT MIN(s.scanned_at) FROM scans s WHERE s.tenant_id = k.tenant_id AND s.ticket_id = k.id AND s.result = 'ok' AND s.scanned_at >= ? AND s.scanned_at < ?) AS first_scan
    FROM tickets k JOIN products p ON p.tenant_id = k.tenant_id AND p.id = k.product_id JOIN order_items i ON i.tenant_id = k.tenant_id AND i.id = k.order_item_id
    JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
    LEFT JOIN people hp ON hp.tenant_id = k.tenant_id AND hp.id = k.person_id LEFT JOIN people bp ON bp.tenant_id = o.tenant_id AND bp.id = o.person_id
    WHERE k.tenant_id = ? AND p.kind = 'day_ticket' AND k.status <> 'void' AND k.valid_from <= ? AND k.valid_to >= ? AND i.refunded_at IS NULL ORDER BY k.id`, [from, to, tenantId, day, day]);
  const items = []; let skipped = 0;
  for (const k of list) {
    const scan = k.first_scan ? localTime(k.first_scan, t.timezone).slice(11, 19) : null;
    if (scan && (!closedFrom || scan >= closedFrom)) continue; // skied before the closure, or skied at all on a full closure
    const personId = k.person_id || k.buyer_id;
    if (!personId) { skipped += 1; continue; }
    const cents = Math.round(Number(k.unit_price_cents));
    if (!cents) continue;
    items.push({ ticket_id: k.id, person_id: personId, name: k.first_name ? `${k.first_name} ${k.last_name}` : 'Guest', product: k.product, cents, why: scan ? `scanned at ${scan.slice(0, 5)}, before the closure` : 'did not scan' });
  }
  return { day, items, skipped, total_cents: items.reduce((n, i) => n + i.cents, 0), today: todayIn(t.timezone) };
}
/** Gives the credits: one closure reward per ticket (once, by source_key), valid for the season, with an email each. */
async function closureIssue(req, day, { scope = 'mountain', closedFrom = null, reason = null }) {
  const tenantId = req.auth.tenantId;
  const s = await G.get(pool, tenantId);
  if (!Number(s.closure_credit_on)) throw conflict('Closure credits are off. Turn them on in Settings first.');
  const t = await one(pool, 'SELECT name, timezone FROM tenants WHERE id = ?', [tenantId]);
  if (day > todayIn(t.timezone)) throw bad('A closure credit is for today or a day that has passed');
  const pre = await closurePreview(pool, tenantId, day, { closedFrom });
  const made = await tx(async (conn) => {
    const out = [];
    const today = todayIn(t.timezone);
    const validTo = await seasonEnd(conn, tenantId, today);
    for (const i of pre.items) {
      const key = `closure:${i.ticket_id}`;
      if (await one(conn, 'SELECT id FROM guest_rewards WHERE tenant_id = ? AND person_id = ? AND source_key = ? FOR UPDATE', [tenantId, i.person_id, key])) continue; // given already
      const r = await rewards.issue(conn, tenantId, { personId: i.person_id, kind: 'closure', reason: `Closed ${dayText(day)}${reason ? `: ${reason}` : ''}`, options: { credit: { cents: i.cents } }, validFrom: today, validTo, sourceKey: key });
      out.push({ ...i, id: r.id, code: r.code, valid_to: validTo });
    }
    const fresh = out;
    await conn.query(`INSERT INTO fair_closures (tenant_id, on_date, scope, closed_from, reason, issued_count, issued_cents, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE scope = VALUES(scope), closed_from = VALUES(closed_from), reason = VALUES(reason), issued_count = issued_count + VALUES(issued_count), issued_cents = issued_cents + VALUES(issued_cents)`,
    [tenantId, day, scope, closedFrom, reason, fresh.length, fresh.reduce((n, x) => n + x.cents, 0), req.auth.userId || null]);
    await audit(conn, req, 'closure_credits', 'fair_closures', null, { day, scope, closed_from: closedFrom, count: fresh.length, cents: fresh.reduce((n, x) => n + x.cents, 0) });
    return fresh;
  });
  for (const m of made) {
    const c = await contactOf(pool, tenantId, m.ticket_id);
    if (c) await mail(tenantId, c.email, `A credit from ${t.name} for ${dayText(day)}`, [`Hi ${c.name},`, '', `We had to close${scope === 'main_lifts' ? ' the main lifts' : ''} on ${dayText(day)}${reason ? ` (${reason})` : ''}. We are sorry you missed your day.`,
      `Here is a credit of ${money(m.cents)} for another day this season.`, '', `Your code: ${m.code}`, `Good through ${dayText(m.valid_to)}. Show the code at the ticket window, or use it online.`], 'closure-credit').catch(() => {});
  }
  return { day, issued: made.length, cents: made.reduce((n, x) => n + x.cents, 0), skipped: pre.skipped };
}
/** Days marked closed in the operating calendar in the last week with tickets sold and no credits given yet. */
async function closureSuggestions(db, tenantId) {
  const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const days = await rows(db, `SELECT c.on_date, c.notes FROM calendar_days c WHERE c.tenant_id = ? AND c.status = 'closed' AND c.on_date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM fair_closures f WHERE f.tenant_id = c.tenant_id AND f.on_date = c.on_date)
    AND EXISTS (SELECT 1 FROM tickets k JOIN products p ON p.tenant_id = k.tenant_id AND p.id = k.product_id WHERE k.tenant_id = c.tenant_id AND p.kind = 'day_ticket' AND k.status <> 'void' AND k.valid_from <= c.on_date AND k.valid_to >= c.on_date)
    ORDER BY c.on_date DESC`, [tenantId, addDays(today, -7), today]);
  const done = await rows(db, 'SELECT on_date, scope, closed_from, reason, issued_count, issued_cents, created_at FROM fair_closures WHERE tenant_id = ? ORDER BY on_date DESC LIMIT 20', [tenantId]);
  return { suggested: days.map((d) => ({ day: dstr(d.on_date), notes: d.notes })), done: done.map((d) => ({ ...d, on_date: dstr(d.on_date) })) };
}

// ---------------------------------------------------------------- fair scan review
/**
 * Looks at recent scans (the last `minutes`) for what a manager should see. Nothing is blocked here.
 * - two_gates: the same ticket let through at two different gates within a minute (shared or copied).
 * - far_apart: the same ticket at two different lifts closer together in time than travel_minutes allows.
 * - failed_reloads: five or more failed online reloads of one card in a day.
 */
async function detect(tenantId, { minutes = 30 } = {}) {
  const f = await settings(pool, tenantId);
  const travel = Math.max(1, Number(f.travel_minutes) || 5);
  const pairs = await rows(pool, `SELECT a.ticket_id, a.id AS a_id, b.id AS b_id, a.location AS a_loc, b.location AS b_loc, a.scanned_at AS a_at, b.scanned_at AS b_at, TIMESTAMPDIFF(SECOND, a.scanned_at, b.scanned_at) AS secs, k.code
      FROM scans a JOIN scans b ON b.tenant_id = a.tenant_id AND b.ticket_id = a.ticket_id AND b.id > a.id AND b.scanned_at >= a.scanned_at AND b.scanned_at <= DATE_ADD(a.scanned_at, INTERVAL ? MINUTE)
      JOIN tickets k ON k.tenant_id = a.tenant_id AND k.id = a.ticket_id
     WHERE a.tenant_id = ? AND a.result = 'ok' AND b.result = 'ok' AND a.ticket_id IS NOT NULL AND a.scanned_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
       AND COALESCE(a.location, '') <> COALESCE(b.location, '') ORDER BY a.id LIMIT 500`, [travel, tenantId, minutes + travel]);
  let made = 0;
  for (const p of pairs) {
    const kind = Number(p.secs) <= 60 ? 'two_gates' : 'far_apart';
    const evidence = { code: p.code, scans: [{ at: p.a_at, location: p.a_loc }, { at: p.b_at, location: p.b_loc }], seconds: Number(p.secs), travel_minutes: travel };
    const [r] = await pool.query('INSERT IGNORE INTO fair_flags (tenant_id, ticket_id, kind, dedupe, evidence) VALUES (?, ?, ?, ?, ?)', [tenantId, p.ticket_id, kind, `${p.a_id}-${p.b_id}`, JSON.stringify(evidence)]);
    made += r.affectedRows;
  }
  const reloads = await rows(pool, `SELECT uid, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM fair_reload_failures WHERE tenant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) GROUP BY uid HAVING n >= 5`, [tenantId]);
  for (const r of reloads) {
    const card = await one(pool, 'SELECT ticket_id FROM rfid_cards WHERE tenant_id = ? AND uid = ?', [tenantId, r.uid]);
    const [x] = await pool.query('INSERT IGNORE INTO fair_flags (tenant_id, ticket_id, kind, dedupe, evidence) VALUES (?, ?, ?, ?, ?)',
      [tenantId, card ? card.ticket_id : null, 'failed_reloads', `${r.uid}-${dstr(r.last_at)}`, JSON.stringify({ uid: r.uid, failures: Number(r.n), first_at: r.first_at, last_at: r.last_at })]);
    made += x.affectedRows;
  }
  return { flagged: made };
}
/** The online card reload calls this on each failed attempt (ACCOUNT's reload), so many in a row reach the review list. */
async function noteFailedReload(db, tenantId, { uid, why = null }) {
  if (!uid) return;
  await db.query('INSERT INTO fair_reload_failures (tenant_id, uid, why) VALUES (?, ?, ?)', [tenantId, String(uid).slice(0, 64), why ? String(why).slice(0, 120) : null]);
}
const FLAG_WORDS = { two_gates: 'Scanned at two gates within a minute', far_apart: 'Scanned at two lifts too far apart for the time', failed_reloads: 'Many failed card reloads' };
/** The review list for managers: open flags first, with the evidence, the holder and the photo; and the blocks. */
async function reviewList(db, tenantId) {
  const flags = await rows(db, `SELECT f.*, k.code, p.first_name, p.last_name, p.photo, pr.name AS product FROM fair_flags f
      LEFT JOIN tickets k ON k.tenant_id = f.tenant_id AND k.id = f.ticket_id LEFT JOIN people p ON p.tenant_id = k.tenant_id AND p.id = k.person_id
      LEFT JOIN products pr ON pr.tenant_id = k.tenant_id AND pr.id = k.product_id
     WHERE f.tenant_id = ? ORDER BY f.status = 'open' DESC, f.id DESC LIMIT 100`, [tenantId]);
  const blocks = await rows(db, `SELECT b.*, k.code, p.first_name, p.last_name, p.photo, pr.name AS product FROM fair_blocks b JOIN tickets k ON k.tenant_id = b.tenant_id AND k.id = b.ticket_id
      LEFT JOIN people p ON p.tenant_id = k.tenant_id AND p.id = k.person_id LEFT JOIN products pr ON pr.tenant_id = k.tenant_id AND pr.id = k.product_id
     WHERE b.tenant_id = ? ORDER BY b.status = 'active' DESC, b.id DESC LIMIT 100`, [tenantId]);
  const holder = (r) => ({ name: r.first_name ? `${r.first_name} ${r.last_name}` : null, photo: r.photo || null, product: r.product || null, code: r.code || null });
  return {
    flags: flags.map((f) => ({ id: f.id, ticket_id: f.ticket_id, kind: f.kind, words: FLAG_WORDS[f.kind], status: f.status, evidence: typeof f.evidence === 'string' ? JSON.parse(f.evidence) : f.evidence, created_at: f.created_at, ...holder(f) })),
    blocks: blocks.map((b) => ({ id: b.id, ticket_id: b.ticket_id, reason: b.reason, status: b.status, created_at: b.created_at, reply: b.reply, replied_at: b.replied_at, lifted_at: b.lifted_at, lift_note: b.lift_note, ...holder(b) })),
  };
}
async function dismissFlag(req, flagId) {
  const [r] = await pool.query("UPDATE fair_flags SET status = 'dismissed', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND status = 'open'", [req.auth.userId, req.auth.tenantId, flagId]);
  if (!r.affectedRows) throw notFound('Open flag');
  await audit(pool, req, 'flag_dismissed', 'fair_flags', flagId, {});
}
/** A manager blocks a pass or ticket with a reason. The guest is emailed the reason and a page to reply. */
async function block(req, { ticketId, flagId = null, reason }, base) {
  const tenantId = req.auth.tenantId;
  const id = await tx(async (conn) => {
    const k = await one(conn, 'SELECT id, status FROM tickets WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, ticketId]);
    if (!k) throw notFound('Ticket');
    if (await one(conn, "SELECT id FROM fair_blocks WHERE tenant_id = ? AND ticket_id = ? AND status = 'active'", [tenantId, ticketId])) throw conflict('This pass is already blocked');
    const [b] = await conn.query('INSERT INTO fair_blocks (tenant_id, ticket_id, flag_id, reason, blocked_by) VALUES (?, ?, ?, ?, ?)', [tenantId, ticketId, flagId, reason, req.auth.userId]);
    if (flagId) await conn.query("UPDATE fair_flags SET status = 'blocked', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [req.auth.userId, tenantId, flagId]);
    await audit(conn, req, 'pass_blocked', 'tickets', ticketId, { reason, flag_id: flagId, block_id: b.insertId });
    return b.insertId;
  });
  const t = await one(pool, 'SELECT name, slug FROM tenants WHERE id = ?', [tenantId]);
  const c = await contactOf(pool, tenantId, ticketId);
  let emailed = false;
  if (c) {
    const token = await newLink(pool, tenantId, 'blocked', id, { days: 60 });
    emailed = await mail(tenantId, c.email, `Your pass at ${t.name} is on hold`, [`Hi ${c.name},`, '', `We put ${c.holder ? `${c.holder}'s` : 'your'} pass on hold, so it will not open the lifts for now.`, '', `Why: ${reason}`, '',
      'If we got this wrong, or there is something we should know, please tell us here. A manager reads every reply:', `${baseOf(base)}/blocked/${t.slug}/${token}`], 'pass-blocked').catch(() => false);
  }
  return { id, emailed };
}
async function unblock(req, blockId, note) {
  const out = await tx(async (conn) => {
    const b = await one(conn, "SELECT * FROM fair_blocks WHERE tenant_id = ? AND id = ? AND status = 'active' FOR UPDATE", [req.auth.tenantId, blockId]);
    if (!b) throw notFound('Active block');
    await conn.query("UPDATE fair_blocks SET status = 'lifted', lifted_by = ?, lifted_at = UTC_TIMESTAMP(), lift_note = ? WHERE id = ?", [req.auth.userId, note || null, b.id]);
    await audit(conn, req, 'pass_unblocked', 'tickets', b.ticket_id, { block_id: b.id, note: note || null });
    return b;
  });
  const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const c = await contactOf(pool, req.auth.tenantId, out.ticket_id);
  if (c) await mail(req.auth.tenantId, c.email, `Your pass at ${t.name} works again`, [`Hi ${c.name},`, '', 'Thank you for your patience. Your pass opens the lifts again.', note ? `\n${note}` : ''], 'pass-unblocked').catch(() => {});
}
/** The guest's reply page: the reason, and their answer (one reply, which they can update while the block stands). */
async function blockedView(db, l) {
  const b = await one(db, `SELECT b.reason, b.status, b.reply, b.replied_at, b.created_at, pr.name AS product, p.first_name FROM fair_blocks b JOIN tickets k ON k.tenant_id = b.tenant_id AND k.id = b.ticket_id
    LEFT JOIN products pr ON pr.tenant_id = k.tenant_id AND pr.id = k.product_id LEFT JOIN people p ON p.tenant_id = k.tenant_id AND p.id = k.person_id WHERE b.tenant_id = ? AND b.id = ?`, [l.tenant_id, l.ref_id]);
  if (!b) throw notFound('Pass');
  return { mountain: l.mountain, phone: l.phone, product: b.product, first_name: b.first_name || null, reason: b.reason, status: b.status, reply: b.reply, replied_at: b.replied_at, since: b.created_at };
}
async function blockedReply(l, text) {
  const [r] = await pool.query("UPDATE fair_blocks SET reply = ?, replied_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND status = 'active'", [String(text).slice(0, 2000), l.tenant_id, l.ref_id]);
  if (!r.affectedRows) throw conflict('This pass is not on hold any more, so there is nothing to answer.');
  await audit(pool, system(l.tenant_id), 'block_reply', 'fair_blocks', l.ref_id, { length: String(text).length });
  return blockedView(pool, l);
}

// ---------------------------------------------------------------- the gate
/**
 * Whether the gate must refuse this ticket for a fair reason, or null: a manager's block, or a payment plan left unpaid.
 * Called by lib/access.js decide() inside the scan's transaction. Returns { result, reason }.
 */
async function holdFor(conn, tenantId, ticket) {
  if (!ticket) return null;
  const b = await one(conn, "SELECT reason FROM fair_blocks WHERE tenant_id = ? AND ticket_id = ? AND status = 'active' LIMIT 1", [tenantId, ticket.id]);
  if (b) return { result: 'blocked', reason: 'A manager put this pass on hold. Send the guest to the ticket window. The guest has an email with the reason.' };
  const p = await one(conn, `SELECT pp.id FROM payment_plans pp JOIN order_items i ON i.tenant_id = pp.tenant_id AND i.order_id = pp.order_id
    WHERE pp.tenant_id = ? AND i.id = ? AND pp.status = 'suspended' LIMIT 1`, [tenantId, ticket.order_item_id]);
  if (p) return { result: 'plan_unpaid', reason: 'A payment on this pass is overdue. Send the guest to the ticket window to pay or update their card.' };
  return null;
}

module.exports = {
  TICKET_KINDS, settings, saveFair, newLink, linkFor, hash, mail, contactOf, seasonEnd, system, baseOf,
  capWalkup, walkup, bestOnline, nextRise, badges, guaranteeLink, guaranteeView, claimGuarantee, guaranteeClaims,
  priceDrops, closurePreview, closureIssue, closureSuggestions,
  detect, noteFailedReload, reviewList, dismissFlag, block, unblock, blockedView, blockedReply, holdFor, FLAG_WORDS,
};
