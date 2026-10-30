'use strict';

// The online shop. Staff side (managers and counter staff): the list of online orders, mounted at /online-shop.
// Public side (no sign-in, keyed by the mountain's web address): the menu, a price check, placing a basket and
// reading your tickets with the secret link. A basket takes no tickets until the card payment lands (see lib/shopsale).
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, todayIn, addDays } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { baseUrl } = require('../lib/baseurl');
const stripe = require('../lib/stripe');
const connect = require('../lib/connect');
const sandbox = require('../lib/sandbox');
const shop = require('../lib/shopsale');
const after = require('../lib/shopafter');
const ACT = require('../lib/activities');
const { nowIn } = require('../lib/util');
const { dayText } = require('../lib/format');

const router = express.Router();
const publicRouter = express.Router();
const MAX_OPEN_BASKETS = 150; // unpaid baskets waiting at once, so a flood cannot fill the table

// ---------------------------------------------------------------- staff
router.get('/orders', requireRole('manager', 'counter'), async (req, res) => {
  const list = await rows(pool,
    `SELECT id, reference, contact_name, contact_email, contact_phone, status, amount_cents, order_id, note, emailed_at, created_at, paid_at,
       (SELECT COUNT(*) FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id WHERE i.tenant_id = s.tenant_id AND i.order_id = s.order_id) AS tickets
     FROM shop_orders s WHERE tenant_id = ? AND (status <> 'awaiting_payment' OR created_at > DATE_SUB(NOW(), INTERVAL 2 HOUR)) ORDER BY id DESC LIMIT 200`, [req.auth.tenantId]);
  res.json({ data: list });
});

router.post('/orders/:id/resend', requireRole('manager', 'counter'), async (req, res) => {
  const row = await one(pool, 'SELECT id, status FROM shop_orders WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, Number(req.params.id)]);
  if (!row) throw notFound('Online order');
  if (row.status !== 'paid') throw conflict('Only a paid order has tickets to send');
  await pool.query('UPDATE shop_orders SET emailed_at = NULL WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, row.id]);
  const sent = await shop.emailTickets(req.auth.tenantId, row.id, baseUrl(req));
  if (!sent) throw conflict('The email could not be sent. Check that email is set up, then try again.');
  res.json({ ok: true });
});

// Will-call: find a guest's order at the window by reference, email, phone or name. Shows the tickets, the secret link to reprint, and a resend.
router.get('/lookup', requireRole('manager', 'counter'), async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 3) throw bad('Type at least 3 letters or numbers');
  const like = `%${term.replace(/[%_]/g, '')}%`;
  const digits = term.replace(/\D/g, '');
  const found = await rows(pool,
    `SELECT s.id, s.reference, s.status, s.contact_name, s.contact_email, s.contact_phone, s.amount_cents, s.order_id, s.view_token, s.created_at, s.emailed_at
     FROM shop_orders s WHERE s.tenant_id = ? AND s.status = 'paid' AND (s.reference = ? OR s.contact_email LIKE ? OR s.contact_name LIKE ? OR (? <> '' AND REPLACE(REPLACE(REPLACE(REPLACE(s.contact_phone, '-', ''), ' ', ''), '(', ''), ')', '') LIKE ?)
       OR EXISTS (SELECT 1 FROM order_items i JOIN tickets t ON t.order_item_id = i.id AND t.tenant_id = i.tenant_id WHERE i.tenant_id = s.tenant_id AND i.order_id = s.order_id AND t.code = ?))
     ORDER BY s.id DESC LIMIT 20`, [req.auth.tenantId, term.toUpperCase(), like, like, digits.length >= 4 ? digits : '', `%${digits}%`, term.toUpperCase()]);
  const out = [];
  for (const o of found) {
    const tickets = await rows(pool,
      `SELECT t.code, t.valid_from, t.valid_to, t.status, p.name AS product, pe.first_name, pe.last_name,
         (SELECT COUNT(*) FROM scans sc WHERE sc.tenant_id = t.tenant_id AND sc.ticket_id = t.id AND sc.result = 'ok') AS scans
       FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id
       LEFT JOIN people pe ON pe.id = t.person_id AND pe.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND i.order_id = ? ORDER BY t.id`, [req.auth.tenantId, o.order_id]);
    out.push({ ...o, tickets });
  }
  const slug = (await one(pool, 'SELECT slug FROM tenants WHERE id = ?', [req.auth.tenantId])).slug;
  res.json({ data: out.map((o) => ({ ...o, link: `${baseUrl(req)}/shop/${slug}?order=${o.view_token}`, view_token: undefined })) });
});

// Group inquiries and the waitlist.
router.get('/groups', requireRole('manager', 'counter'), async (req, res) => {
  res.json({ data: await rows(pool, "SELECT id, contact_name, organisation, email, phone, group_size, preferred_on, note, status, created_at FROM group_enquiries WHERE tenant_id = ? ORDER BY FIELD(status, 'new','contacted','booked','closed'), id DESC LIMIT 200", [req.auth.tenantId]) });
});
router.patch('/groups/:id', requireRole('manager', 'counter'), validate(z.object({ status: z.enum(['new', 'contacted', 'booked', 'closed']) })), async (req, res) => {
  const [r] = await pool.query('UPDATE group_enquiries SET status = ? WHERE tenant_id = ? AND id = ?', [req.body.status, req.auth.tenantId, Number(req.params.id)]);
  if (!r.affectedRows) throw notFound('Inquiry');
  res.json({ ok: true });
});
router.get('/waitlist', requireRole('manager', 'counter'), async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT on_date, SUM(party_size) AS people, COUNT(*) AS entries, SUM(notified_at IS NOT NULL) AS told FROM shop_waitlist WHERE tenant_id = ? AND on_date >= CURDATE() - INTERVAL 1 DAY GROUP BY on_date ORDER BY on_date LIMIT 60', [req.auth.tenantId]) });
});

// Look of the public page: brand color, logo, hero photo, and the opening-day banner.
const imageUrl = z.string().max(450000).regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/, 'Use a JPEG or PNG picture');
const brandSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must look like #1a5fb4').nullable().optional(),
  logo: imageUrl.nullable().optional(),
  hero: imageUrl.nullable().optional(),
  opening_day: dateStr.nullable().optional(),
  opening_note: z.string().trim().max(200).nullable().optional(),
});
/** Brand colors must stay readable with white text on buttons. */
const luminance = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
router.get('/brand', requireRole('manager'), async (req, res) => {
  const b = await one(pool, 'SELECT color, logo, hero, opening_day, opening_note FROM shop_brand WHERE tenant_id = ?', [req.auth.tenantId]);
  res.json(b ? { ...b, opening_day: b.opening_day ? String(b.opening_day).slice(0, 10) : null } : { color: null, logo: null, hero: null, opening_day: null, opening_note: null });
});
router.put('/brand', requireRole('manager'), validate(brandSchema), async (req, res) => {
  const b = req.body;
  if (b.color && (1.05) / (luminance(b.color) + 0.05) < 4.5) throw bad('That color is too light for white button text. Pick a darker one.');
  const cur = await one(pool, 'SELECT color, logo, hero, opening_day, opening_note FROM shop_brand WHERE tenant_id = ?', [req.auth.tenantId]) || {};
  const pick = (k) => (b[k] === undefined ? (cur[k] ?? null) : b[k]);
  await pool.query('INSERT INTO shop_brand (tenant_id, color, logo, hero, opening_day, opening_note) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE color = VALUES(color), logo = VALUES(logo), hero = VALUES(hero), opening_day = VALUES(opening_day), opening_note = VALUES(opening_note)',
    [req.auth.tenantId, pick('color'), pick('logo'), pick('hero'), pick('opening_day'), pick('opening_note')]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- public
async function tenantFor(slug) {
  const t = await one(pool, 'SELECT id, name, slug, address, phone, timezone, waiver_text, online_shop, shop_message, online_daily_limit, shop_change_hours, shop_change_fee_cents, stripe_account, stripe_charges_enabled FROM tenants WHERE slug = ?', [slug]);
  if (!t || !t.online_shop) throw notFound('Shop');
  t.open = connect.readyRow(t) && !(await sandbox.isSandbox(t.id)); // card payments go to the mountain's own Stripe account
  return t;
}

// ---- the signed-in household (Guests round 2, ACCOUNT): the same session as the household account (/family/<mountain>).
const HH = require('../lib/household');
async function householdOf(req, t) {
  const token = req.get('x-family-session');
  if (!token) return null;
  const email = await require('../lib/programplus').sessionEmail(t.id, token);
  if (!email) return null;
  const hh = await HH.forEmail(pool, t.id, email);
  return hh.ids.length ? { ...hh, email } : null;
}
/**
 * Fills in holders picked from the household (holder.person_id): their names, date of birth, and for a pass renewal the
 * photo on file when the guest said it is still them. Refuses a person outside the household. Returns the extras for quote().
 */
async function prepare(req, t, b) {
  const hh = await householdOf(req, t);
  const fill = async (h, { photo = false } = {}) => {
    if (!h || !h.person_id) return;
    if (!HH.has(hh, h.person_id)) throw bad('Sign in again to buy for your family');
    const p = await one(pool, 'SELECT first_name, last_name, date_of_birth, photo FROM people WHERE tenant_id = ? AND id = ?', [t.id, h.person_id]);
    h.first_name = p.first_name; h.last_name = p.last_name;
    if (p.date_of_birth && !h.age_group) h.date_of_birth = String(p.date_of_birth instanceof Date ? p.date_of_birth.toISOString() : p.date_of_birth).slice(0, 10);
    if (photo && h.use_photo_on_file && !h.photo && p.photo && /^data:image\/jpeg;base64,/.test(p.photo)) h.photo = p.photo;
    delete h.use_photo_on_file;
  };
  for (const it of b.items || []) await fill(it.holder, { photo: true });
  for (const a of b.activities || []) await fill(a.holder);
  for (const a of b.addons || []) await fill(a.holder);
  const extras = { ...b, household: hh };
  if (b.reload_card) {
    const today = todayIn(t.timezone);
    const card = await shop.reloadable(pool, t.id, b.reload_card, today);
    const one1 = (b.items || []).length === 1 && !(b.activities || []).length && !(b.gifts || []).length;
    if (!card || card.busy || !one1) throw conflict('We could not load a day onto that card. Check the number on the back of the card, or buy at the ticket window.');
    extras.reload = { card_id: Number(card.id) };
  }
  return extras;
}

const holderSchema = z.object({
  person_id: z.number().int().positive().optional(), // someone in the signed-in household
  use_photo_on_file: z.boolean().optional(), // a pass renewal: the guest confirmed last season's photo is still them
  first_name: z.string().trim().min(1).max(60).optional(), // filled from the household when person_id is given
  last_name: z.string().trim().min(1).max(60).optional(),
  date_of_birth: dateStr.optional(),
  age_group: z.string().trim().toLowerCase().max(30).optional(), // a guest type code marked for online sale
  photo: z.string().max(120000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'The photo must be a JPEG').optional(), // season pass holders only
});
const itemSchema = z.object({ product_id: z.number().int().positive(), valid_on: dateStr.optional(), holder: holderSchema });
// A rental or a lesson package goes with one person: the holder of ticket number for_item in this basket, or a person
// named here with the day (a guest who has a pass and only wants gear). A voucher is for the buyer.
const addonSchema = z.object({ product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(10).default(1), for_item: z.number().int().min(0).max(shop.MAX_ITEMS - 1).optional(),
  holder: holderSchema.omit({ photo: true }).optional(), valid_on: dateStr.optional() });
// An activity: one guest's place on an attraction on a day, in a time slot (none for a day pass).
const activitySchema = z.object({ product_id: z.number().int().positive(), valid_on: dateStr, start_time: z.string().trim().max(8).optional(), holder: holderSchema });
const giftSchema = z.object({ amount_cents: z.number().int().min(500).max(100000), recipient_name: z.string().trim().max(150).optional(), message: z.string().trim().max(300).optional() });
const basketShape = {
  items: z.array(itemSchema).max(shop.MAX_ITEMS).default([]),
  addons: z.array(addonSchema).max(10).default([]),
  gifts: z.array(giftSchema).max(5).default([]),
  activities: z.array(activitySchema).max(shop.MAX_ITEMS).default([]),
  promo_code: z.string().trim().max(40).optional(),
  reward: z.object({ id: z.number().int().positive(), choice: z.enum(['free_ticket', 'percent', 'credit']), for_item: z.number().int().min(0).max(shop.MAX_ITEMS - 1).optional() }).optional(),
  plan: z.boolean().optional(), // pay in parts (a payment plan), when offered
  reload_card: z.string().trim().max(40).optional(), // the number on the back of an RFID card: the day goes onto it
};
/** Every holder needs a name by the time the basket is priced: typed, or filled from the household. */
const named = (b) => [...b.items, ...b.activities].every((x) => x.holder.first_name && x.holder.last_name) && b.addons.every((a) => !a.holder || (a.holder.first_name && a.holder.last_name));
const nonEmpty = (b) => b.items.length + b.addons.length + b.gifts.length + b.activities.length > 0;

publicRouter.get('/:slug/shop', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const today = todayIn(t.timezone);
  pool.query('INSERT INTO shop_visits (tenant_id, day, visits) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE visits = visits + 1', [t.id, today]).catch(() => {}); // for the funnel; never blocks the page
  const prods = await rows(pool, `SELECT id, kind, name, base_price_cents, valid_days, uses, sale_days, online_daily_limit FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind IN ('day_ticket','multi_day','season_pass') ORDER BY FIELD(kind, 'day_ticket','multi_day','season_pass'), name`, [t.id]);
  // Only the guest types sold online have their prices shown (Military, say, is sold at the window with an ID check).
  const onlineCodes = new Set((await require('../lib/guesttypes').list(pool, t.id, { visibleOnly: true })).filter((g) => g.online).map((g) => g.code));
  const out = [];
  for (const p of prods) {
    const tiers = (await rows(pool, 'SELECT tier, price_cents FROM price_tiers WHERE tenant_id = ? AND product_id = ? ORDER BY price_cents', [t.id, p.id])).filter((x) => onlineCodes.has(x.tier));
    const blackouts = await rows(pool, 'SELECT on_date FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND blackout = 1 AND tier IS NULL AND on_date >= ? AND on_date <= ?', [t.id, p.id, today, addDays(today, 365)]);
    out.push({ id: p.id, kind: p.kind, name: p.name, valid_days: p.valid_days, uses: p.uses, base_price_cents: p.base_price_cents, sale_days: p.sale_days, online_daily_limit: p.online_daily_limit, kind_limited: false, prices: tiers, blackout_dates: blackouts.map((b) => String(b.on_date).slice(0, 10)) });
  }
  const closed = await shop.closedDates(pool, t, out);
  const guestTypes = (await require('../lib/guesttypes').list(pool, t.id, { visibleOnly: true })).map((g) => ({ code: g.code, name: g.name, online: g.online, min_age: g.min_age, max_age: g.max_age }));
  for (const p of out) { p.closed_dates = closed.get(p.id); delete p.sale_days; delete p.online_daily_limit; delete p.kind_limited; }
  const brand = await one(pool, 'SELECT color, logo, hero, opening_day, opening_note FROM shop_brand WHERE tenant_id = ?', [t.id]);
  const [cal, snow, lifts, trails] = await Promise.all([
    one(pool, 'SELECT status, open_time, close_time FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [t.id, today]),
    one(pool, 'SELECT base_in, new_snow_in FROM snow_readings WHERE tenant_id = ? ORDER BY read_at DESC LIMIT 1', [t.id]),
    one(pool, "SELECT COUNT(*) AS total, SUM(status = 'open') AS open FROM lifts WHERE tenant_id = ?", [t.id]),
    one(pool, "SELECT COUNT(*) AS total, SUM(status = 'open') AS open FROM trails WHERE tenant_id = ?", [t.id]),
  ]);
  const conditions = (cal || snow || Number(lifts.total)) ? { status: cal ? cal.status : null, open_time: cal ? cal.open_time : null, close_time: cal ? cal.close_time : null, base_in: snow ? snow.base_in : null, new_snow_in: snow ? snow.new_snow_in : null, lifts_open: Number(lifts.total) ? Number(lifts.open || 0) : null, lifts_total: Number(lifts.total), trails_open: Number(trails.total) ? Number(trails.open || 0) : null, trails_total: Number(trails.total) } : null;
  // Add-ons: rentals and lesson packages go with a person; vouchers are the buyer's. A single lesson is booked on the
  // lesson page (a time that fits the person), so the shop links there instead of selling a lesson voucher.
  const addons = await rows(pool, `SELECT id, kind, name, valid_days, uses, base_price_cents FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND (kind IN ('rental','voucher') OR (kind = 'lesson' AND uses > 1)) ORDER BY FIELD(kind, 'rental','lesson','voucher'), name`, [t.id]);
  const addonTiers = addons.length ? await rows(pool, 'SELECT product_id, tier, price_cents FROM price_tiers WHERE tenant_id = ? AND product_id IN (?)', [t.id, addons.map((a) => a.id)]) : [];
  const booking = await one(pool, "SELECT online_booking, (SELECT COUNT(*) FROM products p WHERE p.tenant_id = t.id AND p.active = 1 AND p.kind = 'lesson') AS lessons FROM tenants t WHERE t.id = ?", [t.id]);
  // Activities by attraction, with each attraction's limits in words (shown before paying).
  const acts = await rows(pool, "SELECT id, name, attraction_id, timed, base_price_cents FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind = 'activity' AND attraction_id IS NOT NULL ORDER BY name", [t.id]);
  const atts = acts.length ? (await ACT.activeAttractions(pool, t.id)).filter((a) => acts.some((p) => p.attraction_id === a.id)) : [];
  const actTiers = acts.length ? await rows(pool, 'SELECT product_id, tier, price_cents FROM price_tiers WHERE tenant_id = ? AND product_id IN (?) ORDER BY price_cents', [t.id, acts.map((p) => p.id)]) : [];
  const activities = atts.map((a) => ({ attraction: { ...ACT.attractionOut(a), status_note: undefined }, products: acts.filter((p) => p.attraction_id === a.id).map((p) => ({ id: p.id, name: p.name, timed: Boolean(p.timed), base_price_cents: p.base_price_cents, prices: actTiers.filter((x) => x.product_id === p.id).map((x) => ({ tier: x.tier, price_cents: x.price_cents })) })) }));
  res.json({ activities, addons: addons.map((a) => ({ id: a.id, kind: a.kind, name: a.name, valid_days: a.valid_days, uses: a.uses, price_cents: a.base_price_cents, per_person: a.kind !== 'voucher',
    prices: addonTiers.filter((x) => x.product_id === a.id && onlineCodes.has(x.tier)).map((x) => ({ tier: x.tier, price_cents: x.price_cents })) })),
    badges: await require('../lib/fairprice').badges(pool, t.id).catch(() => []), lesson_booking: Boolean(booking && booking.online_booking && Number(booking.lessons)) ? { link: `/book/${encodeURIComponent(t.slug)}` } : null, gift: { min_cents: 500, max_cents: 100000 }, mountain: t.name, brand: brand ? { ...brand, opening_day: brand.opening_day ? String(brand.opening_day).slice(0, 10) : null } : null, conditions, phone: t.phone, message: t.shop_message, open: t.open, today, waiver_text: t.waiver_text || null, products: out, guest_types: guestTypes });
});

publicRouter.get('/:slug/shop/month', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const ym = String(req.query.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw bad('month must be YYYY-MM');
  // The price calendar (Track FAIR's lib/fairprice.js): when each day's price rises next, for the ticket the day shows.
  const days = await shop.monthView(pool, t, ym);
  const fair = require('../lib/fairprice');
  const out = {};
  for (const [d, v] of Object.entries(days)) {
    const rise = v.product_id ? await fair.nextRise(pool, t.id, v.product_id, d).catch(() => null) : null;
    out[d] = { ...v, product_id: undefined, next_rise: rise || null };
  }
  res.json({ month: ym, days: out, badges: await fair.badges(pool, t.id).catch(() => []) });
});

publicRouter.get('/:slug/shop/day', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const day = String(req.query.date || '');
  if (!dateStr.safeParse(day).success) throw bad('date must be YYYY-MM-DD');
  res.json({ date: day, products: await shop.dayMenu(pool, t, day) });
});

/** One day of one attraction's activities: each time slot with places left and the price by age group. */
publicRouter.get('/:slug/shop/activities', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const day = String(req.query.date || '');
  if (!dateStr.safeParse(day).success) throw bad('date must be YYYY-MM-DD');
  const today = todayIn(t.timezone);
  if (day < today) throw bad('Pick today or a later day');
  if (day > addDays(today, 365)) throw bad('That day is too far ahead to buy online');
  const aid = Number(req.query.attraction_id) || 0;
  const prods = await rows(pool, "SELECT id, kind, name, attraction_id, timed, day_capacity, sale_days, active FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind = 'activity' AND attraction_id = ? ORDER BY name", [t.id, aid]);
  const used = await ACT.taken(pool, t.id, prods.map((p) => p.id), day);
  const now = day === today ? nowIn(t.timezone).slice(11, 16) : null;
  const types = (await require('../lib/guesttypes').list(pool, t.id, { visibleOnly: true })).filter((g) => g.online).map((g) => g.code);
  const out = [];
  for (const p of prods) {
    const d = await ACT.dayOf(pool, t.id, p, day, { now, used });
    const prices = [];
    let reason = null;
    for (const tier of types) {
      try { prices.push({ tier, price_cents: (await require('../lib/pricing').unitPrice(pool, t.id, p.id, tier, day)).cents }); } catch (err) { if (err.status === 409) { reason = 'Not sold on this day.'; break; } throw err; }
    }
    const slots = d.slots.filter((x) => !x.past).map((x) => ({ start: x.start, end: x.end, label: x.label, left: x.left }));
    if (!reason && d.timed && !slots.length) reason = 'No times on this day.';
    out.push({ id: p.id, name: p.name, timed: d.timed, available: !reason, reason, prices: reason ? [] : prices, slots: reason ? [] : slots });
  }
  res.json({ date: day, products: out });
});

publicRouter.post('/:slug/shop/quote', validate(z.object(basketShape).refine(nonEmpty, 'Add something to your order')), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const extras = await prepare(req, t, req.body);
  if (!named(req.body)) throw bad('Fill in the name for every ticket');
  const q = await shop.quote(pool, t, req.body.items, extras);
  res.json({ plan: q.plan ? { count: q.plan.count, first_cents: q.plan.first_cents, then: q.plan.then } : null, reward: q.reward ? { id: q.reward.id, choice: q.reward.choice, cents: q.reward.cents, words: q.reward.words } : null, reload: Boolean(q.reload), lines: q.lines.map((l) => ({ name: l.name, valid_on: l.valid_on, tier: l.tier, unit_cents: l.unit, saved_cents: l.saved || 0, tax_cents: l.tax })),
    activities: q.activities.map((a) => ({ name: a.name, attraction: a.attraction, valid_on: a.valid_on, start_time: a.start_time, tier: a.tier, unit_cents: a.unit, tax_cents: a.tax, limits_text: a.limits_text })), addons: q.addons.map((a) => ({ product_id: a.product_id, name: a.name, kind: a.kind, quantity: a.quantity, unit_cents: a.unit, tier: a.tier, valid_on: a.valid_on, for_item: a.for_item, for_name: a.holder ? `${a.holder.first_name} ${a.holder.last_name}` : null })), gifts: q.gifts, promo: q.promo, discount_cents: q.discount, subtotal_cents: q.subtotal, tax_cents: q.tax, total_cents: q.total });
});

publicRouter.post('/:slug/shop/orders', validate(z.object({
  contact_first_name: z.string().trim().min(1).max(60),
  contact_last_name: z.string().trim().min(1).max(60),
  contact_email: z.string().trim().toLowerCase().email().max(255),
  contact_phone: z.string().trim().min(7).max(40),
  ...basketShape,
  waiver_accepted: z.boolean().optional(),
  terms_accepted: z.boolean().optional(),
  limits_accepted: z.boolean().optional(), // every rider meets the attraction's height, weight and age limits
  news_opt_in: z.boolean().optional(),
  website: z.string().max(200).optional(), // a hidden field people never fill; a robot does
}).refine(nonEmpty, 'Add something to your order')), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const b = req.body;
  res.set('Cache-Control', 'no-store');
  if (b.website) return res.status(202).json({ ok: true });
  if (!t.open) throw conflict(`Online sales are not open right now.${t.phone ? ` Please call ${t.phone}.` : ''}`);
  if (!b.terms_accepted) throw bad('Please confirm you understand tickets are not refundable online');
  if (t.waiver_text && !b.waiver_accepted) throw bad('Please read and accept the waiver');
  if (b.activities.length && !b.limits_accepted && (await rows(pool, `SELECT a.id FROM products p JOIN attractions a ON a.tenant_id = p.tenant_id AND a.id = p.attraction_id
      WHERE p.tenant_id = ? AND p.id IN (?) AND (a.min_height_in IS NOT NULL OR a.min_weight_lb IS NOT NULL OR a.max_weight_lb IS NOT NULL OR a.min_age IS NOT NULL)`, [t.id, b.activities.map((a) => a.product_id)])).length) {
    throw bad('Please confirm every rider meets the height, weight and age limits');
  }
  const extras = await prepare(req, t, b);
  if (!named(b)) throw bad('Fill in the name for every ticket');
  const sha = t.waiver_text ? crypto.createHash('sha256').update(t.waiver_text).digest('hex') : null;
  const accepted = Boolean(b.waiver_accepted && t.waiver_text); // with no waiver wording there is nothing to accept
  const made = await tx(async (conn) => {
    await conn.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [t.id]); // one basket at a time per mountain, so two guests cannot both take the last ticket
    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM shop_orders WHERE tenant_id = ? AND status = 'awaiting_payment' AND created_at > DATE_SUB(NOW(), INTERVAL 40 MINUTE)", [t.id]);
    if (Number(n) >= MAX_OPEN_BASKETS) throw conflict('A lot of people are buying right now. Please try again in a few minutes.');
    const quote = await shop.quote(conn, t, b.items, { ...extras, needPhoto: true });
    const basket = JSON.stringify({ contact: { first_name: b.contact_first_name, last_name: b.contact_last_name }, quote });
    for (let attempt = 0; ; attempt++) {
      const ref = shop.reference(); const token = crypto.randomBytes(16).toString('hex');
      try {
        const [r] = await conn.query(
          'INSERT INTO shop_orders (tenant_id, reference, view_token, contact_name, contact_email, contact_phone, basket, waiver_accepted, waiver_text_sha, news_opt_in, amount_cents, promo_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [t.id, ref, token, `${b.contact_first_name} ${b.contact_last_name}`, b.contact_email, b.contact_phone, basket, accepted ? 1 : 0, accepted ? sha : null, b.news_opt_in ? 1 : 0, quote.plan ? quote.plan.first_cents : quote.total, quote.promo || null]);
        return { id: r.insertId, ref, token, quote, charge: quote.plan ? quote.plan.first_cents : quote.total };
      } catch (err) { if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue; throw err; }
    }
  });
  let co;
  try {
    const pay = connect.checkoutFor(await connect.payeeOrThrow(t.id), made.charge, { tenant_id: String(t.id), request_id: String(made.id), shop_order_id: String(made.id), kind: 'shop', reference: made.ref });
    const n = made.quote.lines.length + made.quote.activities.length + made.quote.addons.reduce((x, a) => x + a.quantity, 0) + made.quote.gifts.length;
    co = await stripe.createCheckout({
      amountCents: made.charge, saveCard: Boolean(made.quote.plan), name: `${t.name}: ${n} item${n > 1 ? 's' : ''}`, description: [...made.quote.lines.map((l) => `${l.name} ${dayText(l.valid_on)}`), ...made.quote.activities.map((a) => `${a.name} ${dayText(a.valid_on)}${a.start_time ? ` ${ACT.clock(a.start_time)}` : ''}`), ...made.quote.addons.map((a) => `${a.quantity} x ${a.name}`), ...made.quote.gifts.map(() => 'Gift card')].join(', ').slice(0, 480),
      email: b.contact_email, reference: made.ref, ...pay, idempotencyKey: `shop-${made.id}`,
      successUrl: `${baseUrl(req)}/shop/${req.params.slug}?order=${made.token}`, cancelUrl: `${baseUrl(req)}/shop/${req.params.slug}?cancelled=${made.token}`,
    });
  } catch (err) {
    await pool.query("UPDATE shop_orders SET status = 'expired' WHERE tenant_id = ? AND id = ?", [t.id, made.id]);
    throw err;
  }
  await pool.query('UPDATE shop_orders SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [co.id, t.id, made.id]);
  res.status(201).json({ ok: true, reference: made.ref, checkout_url: co.url, amount_cents: made.charge });
});

// The guest came back from the card page without paying: their basket stops holding tickets and promo uses at once.
publicRouter.post('/:slug/shop/orders/:token/abandon', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  await pool.query("UPDATE shop_orders SET status = 'expired' WHERE tenant_id = ? AND view_token = ? AND status = 'awaiting_payment'", [t.id, String(req.params.token)]);
  res.json({ ok: true });
});

publicRouter.post('/:slug/shop/waitlist', validate(z.object({
  email: z.string().trim().toLowerCase().email().max(255), name: z.string().trim().max(150).optional(), date: dateStr,
  party_size: z.number().int().min(1).max(20).default(1), website: z.string().max(200).optional(),
})), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const b = req.body;
  if (b.website) return res.status(202).json({ ok: true });
  const menu = (await shop.dayMenu(pool, t, b.date)).filter((m) => m.kind !== 'season_pass');
  if (menu.some((m) => m.available)) throw conflict('Tickets are still on sale for that day.');
  if (!menu.some((m) => /Sold out/.test(m.reason || ''))) throw conflict('That day is not on sale, so there is nothing to wait for.');
  await pool.query('INSERT INTO shop_waitlist (tenant_id, email, name, on_date, party_size) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE party_size = VALUES(party_size), notified_at = NULL', [t.id, b.email, b.name || null, b.date, b.party_size]);
  res.status(201).json({ ok: true });
});

publicRouter.post('/:slug/shop/group', validate(z.object({
  contact_name: z.string().trim().min(1).max(150), organisation: z.string().trim().max(150).optional(), email: z.string().trim().toLowerCase().email().max(255),
  phone: z.string().trim().max(40).optional(), group_size: z.number().int().min(6).max(5000), preferred_on: dateStr.optional(), note: z.string().trim().max(1000).optional(), website: z.string().max(200).optional(),
})), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const b = req.body;
  if (b.website) return res.status(202).json({ ok: true });
  await pool.query('INSERT INTO group_enquiries (tenant_id, contact_name, organisation, email, phone, group_size, preferred_on, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t.id, b.contact_name, b.organisation || null, b.email, b.phone || null, b.group_size, b.preferred_on || null, b.note || null]);
  res.status(201).json({ ok: true });
});

publicRouter.post('/:slug/shop/orders/:token/change', validate(z.object({ ticket_code: z.string().trim().min(6).max(30), date: dateStr })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const row = await one(pool, 'SELECT * FROM shop_orders WHERE tenant_id = ? AND view_token = ?', [t.id, req.params.token]);
  if (!row) throw notFound('Order');
  if (!t.open) throw conflict('Online sales are not open right now. Please call.');
  const root = `${baseUrl(req)}/shop/${req.params.slug}?order=${req.params.token}`;
  const out = await after.requestChange({ tenant: t, shopRow: row, code: req.body.ticket_code, newDate: req.body.date, successUrl: `${root}&changed=1`, cancelUrl: root });
  // A free change is done now: the guest gets an email with the old and new day (a paid one is emailed when the payment lands).
  if (out.done) await require('../lib/salemail').changeEmail(t.id, { shopOrderId: row.id, ticketId: out.ticket_id, from: out.from, to: out.to, paidCents: 0 }, baseUrl(req)).catch(() => false);
  res.json({ done: out.done, due_cents: out.due_cents, checkout_url: out.checkout_url });
});

publicRouter.get('/:slug/shop/orders/:token', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const v = await shop.viewOf(t.id, req.params.token);
  if (!v) throw notFound('Order');
  const br = await one(pool, 'SELECT color, logo, hero FROM shop_brand WHERE tenant_id = ?', [t.id]);
  res.json({ ...v, waiver_link: v.waiver_needed.length ? `${baseUrl(req)}/waiver/${t.slug}` : null, mountain: t.name, phone: t.phone, brand: br || null, changes: t.shop_change_hours === null ? null : { hours: t.shop_change_hours, fee_cents: t.shop_change_fee_cents } });
});

module.exports = { router, publicRouter };
