'use strict';

// The online shop: pricing a basket of tickets and passes, and turning a paid basket into people, waivers, an order and
// tickets. Used by the public shop routes and by the card payment webhook. Nothing is sold until the payment lands.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { unitPrice, priceFrom, applyPromo } = require('./pricing');
const { loadRules, applyTax, split } = require('./tax');
const { resolvePerson } = require('./customers');
const { addLink, isMinor, mayActAsGuardian } = require('./family');
const { recordConsent } = require('./consent');
const { tierFor, contactPerson } = require('./onlinesale');
const { addDays, todayIn, seasonFor, newCode } = require('./util');
const { conflict, bad, Unhonourable } = require('./errors');
const { allowedOn, dayName, daysText } = require('./saledays');
const { audit } = require('./audit');
const mailer = require('./mailer');
const stripe = require('./stripe');

const KINDS = ['day_ticket', 'multi_day', 'season_pass'];
const MAX_ITEMS = 20;
const MAX_DAYS_AHEAD = 365;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const { money } = require('./format');


const ADDON_KINDS = ['lesson', 'rental', 'voucher'];
const MAX_ADDON_QTY = 10;
const GIFT_MIN = 500; const GIFT_MAX = 100000; // same limits as the ticket window
const AGE_GROUPS = ['child', 'youth', 'adult', 'senior'];
const LIMITED_KINDS = ['day_ticket', 'multi_day']; // passes are not counted against a day's limit
/** "Buy online and save": percent off when the visit is at least advance_days away. Online only. */
function advance(product, today, day, cents) {
  const days = Number(product.advance_days); const pct = Number(product.advance_percent);
  if (!days || !pct || pct > 90) return { cents, saved: 0 };
  const gap = Math.round((new Date(`${day}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000);
  if (gap < days) return { cents, saved: 0 };
  const off = Math.round(cents * pct / 100);
  return { cents: cents - off, saved: off };
}
const dstr = (d) => String(d).slice(0, 10);

/**
 * How many tickets are spoken for on each day from `from` to `to`: tickets already sold (any channel, not voided) plus
 * baskets waiting on the card page. A multi-day ticket counts on every day it is valid. Returns Map day -> { all, by: Map product -> n }.
 */
async function usage(conn, tenantId, from, to) {
  const map = new Map();
  const bump = (pid, a, b) => {
    for (let d = a < from ? from : a; d <= (b > to ? to : b); d = addDays(d, 1)) {
      const u = map.get(d) || { all: 0, by: new Map() };
      u.all += 1; u.by.set(pid, (u.by.get(pid) || 0) + 1); map.set(d, u);
    }
  };
  const sold = await rows(conn, `SELECT t.product_id, t.valid_from, t.valid_to FROM tickets t JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id
    WHERE t.tenant_id = ? AND t.status <> 'void' AND p.kind IN ('day_ticket','multi_day') AND t.valid_to >= ? AND t.valid_from <= ?`, [tenantId, from, to]);
  for (const t of sold) bump(t.product_id, dstr(t.valid_from), dstr(t.valid_to));
  const holds = await rows(conn, "SELECT basket FROM shop_orders WHERE tenant_id = ? AND status = 'awaiting_payment' AND created_at > DATE_SUB(NOW(), INTERVAL 40 MINUTE)", [tenantId]);
  for (const h of holds) {
    let b; try { b = JSON.parse(h.basket); } catch (_) { continue; }
    for (const l of (b.quote && b.quote.lines) || []) if (LIMITED_KINDS.includes(l.kind)) bump(l.product_id, l.valid_on, addDays(l.valid_on, Math.max(l.valid_days, 1) - 1));
  }
  // A manager can set a different limit for one day (a holiday cap, say): product 0 means the whole mountain.
  map.over = new Map();
  for (const o of await rows(conn, 'SELECT on_date, product_id, max_tickets FROM shop_day_limits WHERE tenant_id = ? AND on_date >= ? AND on_date <= ?', [tenantId, from, to])) map.over.set(`${dstr(o.on_date)}|${o.product_id}`, Number(o.max_tickets));
  return map;
}
/** Tickets still available that day for a product under its own limit and the mountain's limit (Infinity when neither is set). */
function left(use, tenant, product, day) {
  if (!LIMITED_KINDS.includes(product.kind)) return Infinity;
  const u = use.get(day) || { all: 0, by: new Map() };
  const over = use.over || new Map();
  const pLimit = over.has(`${day}|${product.id}`) ? over.get(`${day}|${product.id}`) : product.online_daily_limit;
  const tLimit = over.has(`${day}|0`) ? over.get(`${day}|0`) : tenant.online_daily_limit;
  let l = Infinity;
  if (pLimit !== null && pLimit !== undefined) l = Math.min(l, pLimit - (u.by.get(product.id) || 0));
  if (tLimit !== null && tLimit !== undefined) l = Math.min(l, tLimit - u.all);
  return Math.max(l, 0);
}
const hasLimits = (tenant, products) => (tenant.online_daily_limit !== null && tenant.online_daily_limit !== undefined) || products.some((p) => p.online_daily_limit !== null && p.online_daily_limit !== undefined);
/** True when any limit could apply from `from` on: a standing limit, or a limit set for one day. */
async function limited(conn, tenant, products, from) {
  if (hasLimits(tenant, products)) return true;
  return Boolean(await one(conn, 'SELECT 1 AS x FROM shop_day_limits WHERE tenant_id = ? AND on_date >= ? LIMIT 1', [tenant.id, from]));
}

/** Price one basket. items: [{ product_id, valid_on, holder: { first_name, last_name, date_of_birth } }]. Prices always come from here. */
async function quote(conn, tenant, items, extras = {}) {
  const addonsIn = extras.addons || []; const giftsIn = extras.gifts || [];
  if (items.length > MAX_ITEMS) throw bad(`A basket holds up to ${MAX_ITEMS} tickets`);
  if (!items.length && !addonsIn.length && !giftsIn.length) throw bad('Add something to your order');
  const today = todayIn(tenant.timezone);
  const last = addDays(today, MAX_DAYS_AHEAD);
  const priced = []; const detail = [];
  for (const it of items) {
    const product = await one(conn, 'SELECT id, kind, name, valid_days, uses, active, online, sale_days, online_daily_limit, advance_days, advance_percent FROM products WHERE tenant_id = ? AND id = ?', [tenant.id, it.product_id]);
    if (!product || !product.active || !product.online || !KINDS.includes(product.kind)) throw conflict('One of those tickets is not sold online');
    const day = product.kind === 'season_pass' ? (it.valid_on && it.valid_on >= today ? it.valid_on : today) : it.valid_on;
    if (!day || day < today) throw bad('Pick today or a later day for each ticket');
    if (day > last) throw bad('That day is too far ahead to buy online');
    const h = it.holder;
    if (h.date_of_birth && h.date_of_birth > today) throw bad('Date of birth cannot be in the future');
    if (product.kind === 'season_pass' && !h.date_of_birth) throw bad('A season pass needs the holder\'s date of birth');
    if (!h.date_of_birth && !AGE_GROUPS.includes(h.age_group)) throw bad('Pick an age group for each ticket');
    if (h.photo && product.kind !== 'season_pass') delete h.photo;
    const tier = h.date_of_birth ? tierFor(h.date_of_birth, day) : h.age_group;
    const base = await unitPrice(conn, tenant.id, product.id, tier, day);
    const adv = advance(product, today, day, base.cents);
    const cents = adv.cents;
    priced.push({ type: 'ticket', unit: cents, cents });
    detail.push({ product_id: product.id, name: product.name, saved: adv.saved, kind: product.kind, limit: product.online_daily_limit, valid_on: day, valid_days: product.valid_days, uses: product.uses, tier, holder: it.holder });
  }
  // Daily limits: count what is already spoken for, then add this basket line by line.
  const ticketLines = detail.filter((d) => LIMITED_KINDS.includes(d.kind));
  if (ticketLines.length) {
    const from = ticketLines.reduce((m, d) => (d.valid_on < m ? d.valid_on : m), ticketLines[0].valid_on);
    const to = ticketLines.reduce((m, d) => { const e = addDays(d.valid_on, Math.max(d.valid_days, 1) - 1); return e > m ? e : m; }, ticketLines[0].valid_on);
    const use = await usage(conn, tenant.id, from, to);
    for (const d of ticketLines) {
      const prod = { id: d.product_id, kind: d.kind, online_daily_limit: d.limit };
      for (let day = d.valid_on; day <= addDays(d.valid_on, Math.max(d.valid_days, 1) - 1); day = addDays(day, 1)) {
        const l = left(use, tenant, prod, day);
        if (l < 1) throw conflict(`${d.name} is sold out for ${day}`);
        const u = use.get(day) || { all: 0, by: new Map() }; u.all += 1; u.by.set(d.product_id, (u.by.get(d.product_id) || 0) + 1); use.set(day, u);
      }
    }
  }
  // Add-ons: lessons, prepaid rentals and vouchers sold as ordinary products. They come as a voucher the guest uses at the mountain.
  const addons = [];
  for (const a of addonsIn) {
    const product = await one(conn, 'SELECT id, kind, name, valid_days, uses, active, online FROM products WHERE tenant_id = ? AND id = ?', [tenant.id, a.product_id]);
    if (!product || !product.active || !product.online || !ADDON_KINDS.includes(product.kind)) throw conflict('One of those add-ons is not sold online');
    const qty = Math.min(Math.max(Number(a.quantity) || 1, 1), MAX_ADDON_QTY);
    const base = await unitPrice(conn, tenant.id, product.id, 'adult', today);
    if (base.cents <= 0) throw bad(`${product.name} has no price set`);
    const type = product.kind === 'voucher' ? 'ticket' : product.kind;
    priced.push({ type, unit: base.cents, cents: base.cents * qty });
    addons.push({ product_id: product.id, name: product.name, kind: product.kind, quantity: qty, unit: base.cents, valid_days: Math.max(product.valid_days, 1), uses: product.uses });
  }
  const gifts = [];
  for (const g of giftsIn) {
    if (g.amount_cents < GIFT_MIN || g.amount_cents > GIFT_MAX) throw bad(`A gift card is ${money(GIFT_MIN)} to ${money(GIFT_MAX)}`);
    priced.push({ type: 'gift_card', unit: g.amount_cents, cents: g.amount_cents });
    gifts.push({ amount_cents: g.amount_cents, recipient_name: g.recipient_name || null, message: g.message || null });
  }
  const subtotal = priced.reduce((n, p) => n + p.cents, 0);
  if (subtotal <= 0) throw bad('Those tickets have no price set. Please call the mountain.');
  // A promo code takes money off everything except gift cards.
  let discount = 0; let promo = null;
  if (extras.promo_code) {
    const code = String(extras.promo_code).trim().toUpperCase();
    const eligible = priced.reduce((n, p) => n + (p.type === 'gift_card' ? 0 : p.cents), 0);
    if (!eligible) throw bad('A promo code cannot be used on a gift card');
    discount = (await applyPromo(conn, tenant.id, code, eligible, today, { lock: conn !== pool, excludeEmail: extras.contact_email || null })).discountCents;
    promo = code;
  }
  const { tax, taxes } = applyTax(priced, discount, await loadRules(conn, tenant.id));
  const lines = detail.map((d, i) => ({ ...d, unit: priced[i].unit, tax: priced[i].tax, discount: priced[i].discount }));
  const nT = detail.length;
  addons.forEach((a, i) => { a.tax = priced[nT + i].tax; a.discount = priced[nT + i].discount; });
  gifts.forEach((g, i) => { g.tax = 0; g.discount = 0; });
  return { lines, addons, gifts, promo, discount, subtotal, tax, taxes, total: subtotal - discount + tax };
}

/** What can be bought on one day: price per age group, tickets left, and why something is not available. */
async function dayMenu(conn, tenant, day) {
  const today = todayIn(tenant.timezone);
  if (day < today) throw bad('Pick today or a later day');
  if (day > addDays(today, MAX_DAYS_AHEAD)) throw bad('That day is too far ahead to buy online');
  const prods = await rows(conn, `SELECT id, kind, name, valid_days, uses, sale_days, online_daily_limit, advance_days, advance_percent FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind IN ('day_ticket','multi_day','season_pass') ORDER BY FIELD(kind, 'day_ticket','multi_day','season_pass'), name`, [tenant.id]);
  const use = await limited(conn, tenant, prods, day) ? await usage(conn, tenant.id, day, addDays(day, 30)) : new Map();
  const out = [];
  for (const p of prods) {
    const item = { id: p.id, kind: p.kind, name: p.name, valid_days: p.valid_days, uses: p.uses, available: true, reason: null, left: null, days_text: p.sale_days && Number(p.sale_days) !== 127 ? daysText(p.sale_days) : null, prices: [] };
    if (!allowedOn(p.sale_days, day)) { item.available = false; item.reason = `Sold ${daysText(p.sale_days).replace(' only', '')} only. Not sold on ${dayName(day)}s.`; out.push(item); continue; }
    let l = Infinity;
    for (let i = 0; i < Math.max(p.valid_days, 1) && LIMITED_KINDS.includes(p.kind); i++) l = Math.min(l, left(use, tenant, p, addDays(day, i)));
    if (l < 1) { item.available = false; item.reason = 'Sold out for this day.'; out.push(item); continue; }
    if (l !== Infinity) item.left = l;
    for (const tier of ['child', 'youth', 'adult', 'senior']) {
      try { const base = (await unitPrice(conn, tenant.id, p.id, tier, day)).cents; const adv = advance(p, today, day, base); item.prices.push({ tier, price_cents: adv.cents, was_cents: adv.saved ? base : null }); } catch (err) { if (err.status === 409) { item.available = false; item.reason = 'Not sold on this day.'; item.prices = []; break; } throw err; }
    }
    out.push(item);
  }
  return out;
}

/** Days in the next year when a product cannot be bought online: blacked out, not a sale day, or sold out. */
async function closedDates(conn, tenant, products) {
  const today = todayIn(tenant.timezone); const last = addDays(today, MAX_DAYS_AHEAD);
  const use = await limited(conn, tenant, products, today) ? await usage(conn, tenant.id, today, last) : new Map();
  const out = new Map();
  for (const p of products) {
    const set = new Set(p.blackout_dates);
    for (let d = today; d <= last; d = addDays(d, 1)) {
      if (!allowedOn(p.sale_days, d)) { set.add(d); continue; }
      if (LIMITED_KINDS.includes(p.kind) && (use.has(d) || (use.over && use.over.size)) && left(use, tenant, p, d) < 1) set.add(d);
    }
    out.set(p.id, [...set].sort());
  }
  return out;
}

/** Days a late basket would take over the daily limit (counted before its own tickets are added). */
async function overDays(conn, tenant, lines) {
  const limited = lines.filter((l) => LIMITED_KINDS.includes(l.kind));
  if (!limited.length) return [];
  const from = limited.reduce((m, l) => (l.valid_on < m ? l.valid_on : m), limited[0].valid_on);
  const to = limited.reduce((m, l) => { const e = addDays(l.valid_on, Math.max(l.valid_days, 1) - 1); return e > m ? e : m; }, limited[0].valid_on);
  const use = await usage(conn, tenant.id, from, to);
  const out = new Set();
  for (const l of limited) {
    for (let d = l.valid_on; d <= addDays(l.valid_on, Math.max(l.valid_days, 1) - 1); d = addDays(d, 1)) {
      if (left(use, tenant, { id: l.product_id, kind: l.kind, online_daily_limit: l.limit }, d) < 1) out.add(d);
      const u = use.get(d) || { all: 0, by: new Map() }; u.all += 1; u.by.set(l.product_id, (u.by.get(l.product_id) || 0) + 1); use.set(d, u);
    }
  }
  return [...out];
}

/**
 * A paid basket becomes people on file, waivers where the buyer can legitimately sign, one order and one ticket per holder.
 * Runs inside the caller's transaction on a locked shop_orders row.
 */
async function fulfil(conn, tenantId, row, { paymentIntent }) {
  let basket; try { basket = JSON.parse(row.basket); } catch (_) { throw bad('The saved basket is unreadable'); }
  const q = basket.quote; const c = basket.contact;
  const tenant = await one(conn, 'SELECT id, timezone, waiver_text, online_daily_limit FROM tenants WHERE id = ?', [tenantId]);
  // A payment that lands after the 40-minute hold is still honoured (the guest paid), but staff are told if it took the
  // day over its limit.
  const late = await one(conn, 'SELECT created_at < DATE_SUB(NOW(), INTERVAL 40 MINUTE) AS late FROM shop_orders WHERE tenant_id = ? AND id = ?', [tenantId, row.id]);
  const overLimit = late && Number(late.late) ? await overDays(conn, tenant, q.lines || []) : [];
  const today = todayIn(tenant.timezone);
  const season = seasonFor(today);
  const contact = await contactPerson(conn, tenantId, { first_name: c.first_name, last_name: c.last_name, email: row.contact_email, phone: row.contact_phone });
  if (row.news_opt_in) {
    await conn.query('UPDATE people SET marketing_opt_in = 1 WHERE tenant_id = ? AND id = ?', [tenantId, contact.id]);
    await recordConsent(conn, tenantId, contact.id, 'email', 'opted_in', 'online', null);
  }
  const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, user_id, status, promo_code, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, NULL, 'paid', ?, ?, ?, ?, ?, 'online', ?)", [tenantId, contact.id, q.promo || null, q.subtotal, q.discount || 0, q.tax, q.total, paymentIntent]);
  const orderId = o.insertId;
  if (q.promo) await conn.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE tenant_id = ? AND code = ?', [tenantId, q.promo]);
  for (const t of q.taxes) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, orderId, t.name, t.rate_bps, t.amount_cents]);
  const waiverNeeded = []; const tickets = [];
  for (const ln of q.lines) {
    const st = ln.holder;
    const sameAsContact = st.first_name.toLowerCase() === String(c.first_name).toLowerCase() && st.last_name.toLowerCase() === String(c.last_name).toLowerCase();
    const minor = st.date_of_birth ? isMinor(st.date_of_birth, ln.valid_on) : (ln.tier === 'child' || ln.tier === 'youth');
    const details = { first_name: st.first_name, last_name: st.last_name };
    if (st.date_of_birth) details.date_of_birth = st.date_of_birth;
    if (st.photo) details.photo = st.photo;
    // The buyer's email and phone belong to the buyer, so only the buyer's own record gets them.
    if (sameAsContact && !minor) { details.email = row.contact_email; details.phone = row.contact_phone; }
    const who = await resolvePerson(conn, tenantId, { personId: sameAsContact && !minor ? contact.id : undefined, details, scope: 'none', source: 'online', fillOnly: true });
    if (!who.id) throw bad(`Could not save ${st.first_name} ${st.last_name}`);
    const guardianOk = minor && await mayActAsGuardian(conn, tenantId, contact.id, who.id, who.created);
    if (guardianOk) await addLink(conn, tenantId, contact.id, who.id, 'guardian');
    let waiver = await one(conn, 'SELECT id FROM waivers WHERE tenant_id = ? AND person_id = ? AND season = ? LIMIT 1', [tenantId, who.id, season]);
    if (!waiver && row.waiver_accepted && (guardianOk || (sameAsContact && !minor)) && contact.id) {
      await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_person_id, signed_by_name, signer_relation, text_sha) VALUES (?, ?, ?, 'general', ?, ?, ?, ?)", [tenantId, who.id, season, contact.id, row.contact_name, minor ? 'guardian' : 'self', row.waiver_text_sha]);
      waiver = { id: 1 };
    }
    if (!waiver && tenant.waiver_text) waiverNeeded.push(`${st.first_name} ${st.last_name}`);
    const [it] = await conn.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents) VALUES (?, ?, ?, 'ticket', ?, ?, 1, ?, ?, ?, ?)", [tenantId, orderId, ln.product_id, who.id, ln.tier, ln.unit, ln.valid_on, ln.discount || 0, ln.tax || 0]);
    const code = newCode();
    const validTo = addDays(ln.valid_on, Math.max(ln.valid_days, 1) - 1);
    await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, it.insertId, who.id, ln.product_id, code, ln.valid_on, validTo, ln.uses ?? null]);
    tickets.push(code);
  }
  // Add-ons become a voucher the guest uses at the mountain; each unit has its own code and barcode.
  for (const a of q.addons || []) {
    const discEach = split(a.discount || 0, a.quantity); const taxEach = split(a.tax || 0, a.quantity); // shared evenly, so refunding one unit returns its share
    for (let k = 0; k < a.quantity; k++) {
      const [it] = await conn.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents) VALUES (?, ?, ?, ?, ?, 'adult', 1, ?, ?, ?, ?)",
        [tenantId, orderId, a.product_id, a.kind === 'voucher' ? 'ticket' : a.kind, contact.id, a.unit, today, discEach[k], taxEach[k]]);
      await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [tenantId, it.insertId, contact.id, a.product_id, newCode(), today, addDays(today, a.valid_days - 1), a.uses ?? null]);
    }
  }
  const giftCodes = [];
  for (const g of q.gifts || []) {
    const code = newCode();
    const [gc] = await conn.query('INSERT INTO gift_cards (tenant_id, code, initial_cents, balance_cents, purchaser_id, recipient_name, message, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, code, g.amount_cents, g.amount_cents, contact.id, g.recipient_name, g.message, orderId]);
    await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, order_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, ?, 'issue', ?, ?)", [tenantId, gc.insertId, orderId, g.amount_cents, g.amount_cents]);
    await conn.query("INSERT INTO order_items (tenant_id, order_id, line_kind, person_id, gift_card_id, tier, quantity, unit_price_cents, discount_cents, tax_cents) VALUES (?, ?, 'gift_card', ?, ?, 'adult', 1, ?, 0, 0)", [tenantId, orderId, contact.id, gc.insertId, g.amount_cents]);
    giftCodes.push(code);
  }
  await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, processor) VALUES (?, ?, 'card', ?, ?, 'stripe')", [tenantId, orderId, q.total, paymentIntent]);
  await conn.query("UPDATE shop_orders SET status = 'paid', paid_at = NOW(), order_id = ?, payment_intent = COALESCE(?, payment_intent), note = ? WHERE tenant_id = ? AND id = ?",
    [orderId, paymentIntent, [waiverNeeded.length ? `Waiver still to sign at the gate: ${waiverNeeded.join(', ')}.` : '', overLimit.length ? `Payment arrived late: ${overLimit.join(', ')} went over the daily limit.` : ''].filter(Boolean).join(' ').slice(0, 300) || null, tenantId, row.id]);
  await audit(conn, { auth: { tenantId, userId: null } }, 'shop_paid', 'shop_orders', row.id, { tickets: tickets.length, order_id: orderId });
  return { orderId, tickets, waiverNeeded, giftCodes };
}

/** What the guest sees for their order: only reachable with the secret link token. */
async function viewOf(tenantId, token) {
  const row = await one(pool, 'SELECT id, reference, status, contact_name, amount_cents, order_id, note FROM shop_orders WHERE tenant_id = ? AND view_token = ?', [tenantId, String(token || '')]);
  if (!row) return null;
  let tickets = [];
  if (row.order_id) {
    tickets = await rows(pool,
      `SELECT t.code, t.valid_from, t.valid_to, t.status, t.uses_remaining, p.name AS product, p.kind, p.valid_days, pe.first_name, pe.last_name
       FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id
       LEFT JOIN people pe ON pe.id = t.person_id AND pe.tenant_id = t.tenant_id
       WHERE t.tenant_id = ? AND i.order_id = ? ORDER BY t.id`, [tenantId, row.order_id]);
    tickets = tickets.map((t) => ({ ...t, movable: t.status === 'active' && t.kind === 'day_ticket' && Number(t.valid_days) === 1 }));
  }
  const gift_cards = row.order_id ? await rows(pool, 'SELECT code, initial_cents AS amount_cents, recipient_name, message FROM gift_cards WHERE tenant_id = ? AND order_id = ? ORDER BY id', [tenantId, row.order_id]) : [];
  return { reference: row.reference, status: row.status, name: row.contact_name, amount_cents: row.amount_cents, tickets, gift_cards };
}

/** Email the tickets once. Failure to send never undoes the sale: the page with the tickets is always there. */
async function emailTickets(tenantId, rowId, baseUrl) {
  const row = await one(pool, 'SELECT * FROM shop_orders WHERE tenant_id = ? AND id = ?', [tenantId, rowId]);
  if (!row || row.status !== 'paid' || row.emailed_at || !mailer.enabled()) return false;
  const t = await one(pool, 'SELECT name, slug, phone FROM tenants WHERE id = ?', [tenantId]);
  const link = `${baseUrl}/shop/${t.slug}?order=${row.view_token}`;
  const v = await viewOf(tenantId, row.view_token);
  const lines = v.tickets.map((k) => `- ${k.product}${k.first_name ? `, ${k.first_name} ${k.last_name}` : ''}: ${k.valid_from === k.valid_to ? k.valid_from : `${k.valid_from} to ${k.valid_to}`}`);
  const gifts = v.gift_cards.map((g) => `- Gift card ${g.code}, ${money(g.amount_cents)}${g.recipient_name ? ` for ${g.recipient_name}` : ''}`);
  const text = [`Hi ${row.contact_name.split(' ')[0]},`, '', `Thank you for your order at ${t.name} (reference ${row.reference}, ${money(row.amount_cents)}).`, '', ...lines, ...gifts, '',
    'Show the barcode on your phone at the gate. Your tickets are here:', link, '', ...(row.note ? [row.note, ''] : []), t.phone ? `Questions? Call ${t.phone}.` : ''].join('\n');
  const r = await mailer.send({ tenantId, to: row.contact_email, fromName: t.name, subject: `Your tickets for ${t.name}`, text, tag: 'shop-tickets' });
  if (r.ok) await pool.query('UPDATE shop_orders SET emailed_at = NOW() WHERE tenant_id = ? AND id = ? AND emailed_at IS NULL', [tenantId, rowId]);
  return r.ok;
}

/** Stripe webhook for shop baskets (metadata.kind === 'shop'). A repeated event changes nothing; a basket we cannot honour is refunded in full. */
async function handleWebhook(event, obj, baseUrl) {
  const tenantId = Number(obj.metadata.tenant_id); const id = Number(obj.metadata.shop_order_id);
  if (event.type === 'checkout.session.expired') {
    await pool.query("UPDATE shop_orders SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND stripe_session_id = ?", [tenantId, id, obj.id]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  let failed = null;
  let out;
  try {
    out = await tx(async (conn) => {
      const row = await one(conn, 'SELECT * FROM shop_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
      if (!row || row.stripe_session_id !== obj.id) return { ignored: true };
      // Act only on a basket still waiting (or let go when the guest pressed back: their payment can still land). A repeat,
      // including one we refunded, changes nothing.
      if (!['awaiting_payment', 'expired'].includes(row.status)) return { duplicate: true };
      if (Number(obj.amount_total) !== row.amount_cents) { failed = 'the amount did not match'; return { problem: true }; }
      try { return { ...(await fulfil(conn, tenantId, row, { paymentIntent: obj.payment_intent })), ok: true }; } catch (err) {
        if (err.status && err.status < 500) throw new Unhonourable(err.message);
        throw err;
      }
    });
  } catch (err) {
    if (!(err instanceof Unhonourable)) throw err;
    failed = err.message; out = { problem: true }; // rolled back: nothing half-made is kept
  }
  if (failed) {
    // Refund first: if Stripe cannot be reached this throws, Stripe sends the event again, and we try again.
    if (obj.payment_intent && stripe.enabled()) await stripe.refund({ paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), key: `shop-autorefund-${tenantId}-${id}` });
    await pool.query("UPDATE shop_orders SET status = 'refunded', payment_intent = ?, note = ? WHERE tenant_id = ? AND id = ? AND status IN ('awaiting_payment','expired')", [obj.payment_intent, `Refunded automatically: ${failed}`.slice(0, 300), tenantId, id]);
    return { refunded: true };
  }
  if (out.ok) await emailTickets(tenantId, id, baseUrl).catch(() => {});
  return { ok: Boolean(out.ok), duplicate: out.duplicate, ignored: out.ignored };
}

/**
 * One month for the calendar: per day the adult price of the cheapest day ticket on sale, and whether that ticket is
 * open, nearly sold out, or the day is closed. Worked out from a handful of queries (not one menu per day), and kept for
 * 60 seconds per mountain and month because every visitor asks for it.
 */
const monthCache = new Map();
const FEW = 20;
async function monthView(conn, tenant, ym) {
  const key = `${tenant.id}:${ym}`; const hit = monthCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.out;
  const today = todayIn(tenant.timezone); const last = addDays(today, MAX_DAYS_AHEAD);
  const first = `${ym}-01`; let end = first; while (addDays(end, 1).slice(0, 7) === ym) end = addDays(end, 1);
  const out = {};
  const prods = await rows(conn, `SELECT id, kind, name, valid_days, base_price_cents, sale_days, online_daily_limit, advance_days, advance_percent FROM products
    WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind IN ('day_ticket','multi_day','season_pass')`, [tenant.id]);
  if (!prods.length) return out;
  const tickets = prods.filter((p) => LIMITED_KINDS.includes(p.kind));
  const ids = tickets.map((p) => p.id);
  const cal = ids.length ? await rows(conn, 'SELECT product_id, on_date, tier, price_cents, blackout FROM price_calendar WHERE tenant_id = ? AND product_id IN (?) AND on_date >= ? AND on_date <= ?', [tenant.id, ids, first, addDays(end, 30)]) : [];
  const tiers = ids.length ? await rows(conn, "SELECT product_id, price_cents FROM price_tiers WHERE tenant_id = ? AND product_id IN (?) AND tier = 'adult'", [tenant.id, ids]) : [];
  const use = ids.length && await limited(conn, tenant, tickets, first) ? await usage(conn, tenant.id, first, addDays(end, 30)) : new Map();
  const calOn = new Map();
  for (const c of cal) { const k = `${c.product_id}|${dstr(c.on_date)}`; if (!calOn.has(k)) calOn.set(k, []); calOn.get(k).push(c); }
  const adultTier = new Map(tiers.map((t) => [t.product_id, t.price_cents]));
  const passOnly = !tickets.length;
  for (let d = first; d <= end; d = addDays(d, 1)) {
    if (d < today || d > last) continue;
    if (passOnly) { out[d] = { state: 'open', from_cents: null }; continue; }
    let best = null; let soldOut = false;
    for (const p of tickets) {
      if (!allowedOn(p.sale_days, d)) continue;
      const dayCal = calOn.get(`${p.id}|${d}`) || [];
      if (dayCal.some((c) => c.blackout)) continue; // like the day's menu: a blackout on any age group closes the product
      const price = priceFrom(p, dayCal, adultTier.get(p.id), 'adult');
      let l = Infinity;
      for (let k = 0; k < Math.max(p.valid_days, 1); k++) l = Math.min(l, left(use, tenant, p, addDays(d, k)));
      if (l < 1) { soldOut = true; continue; }
      const cents = advance(p, today, d, price.cents).cents;
      // The calendar shows the cheapest one-day ticket when there is one, else the cheapest ticket of any length.
      const rank = [p.kind === 'day_ticket' && Number(p.valid_days) === 1 ? 0 : 1, cents];
      if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) best = { rank, cents, left: l };
    }
    if (!best) { out[d] = { state: soldOut ? 'sold_out' : 'closed' }; continue; }
    out[d] = { state: best.left !== Infinity && best.left <= FEW ? 'few' : 'open', from_cents: best.cents, left: best.left === Infinity ? null : best.left };
  }
  monthCache.set(key, { at: Date.now(), out });
  if (monthCache.size > 500) monthCache.clear();
  return out;
}

module.exports = { leftOn: left, monthView, advance, KINDS, dayMenu, closedDates, usage, quote, fulfil, viewOf, emailTickets, handleWebhook, reference, MAX_ITEMS };
