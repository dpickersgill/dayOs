'use strict';
// Guests, round 2, Track ACCOUNT: the household account, one prefilled checkout, rebuy and pass renewal, rewards online,
// the designed confirmation and the morning-of message, card reload online and gift experiences.
// router is mounted at /guests (staff); publicRouter under /public (no sign-in; the household signs in by an emailed link,
// the same session as the family page, family_tokens). tick() runs every 5 minutes; daily() once a day.
//
// Privacy: every household route works only on people in the signed-in household (lib/household.js); a person outside
// it is "not found". Allergy and medical notes are never sent here. Sign-in never says whether an email has an account.
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, todayIn, addDays, nowIn, seasonFor } = require('../lib/util');
const { notFound, conflict, bad, unauthorized } = require('../lib/errors');
const { baseUrl } = require('../lib/baseurl');
const { audit } = require('../lib/audit');
const { money, dayText, esc } = require('../lib/format');
const mailer = require('../lib/mailer');
const PP = require('../lib/programplus');
const HH = require('../lib/household');
const R = require('../lib/rewards');
const V = require('../lib/guestvisits');
const G = require('../lib/guestsettings');
const arrival = require('../lib/arrival');
const { ON_FILE } = require('../lib/waivers');
const { eachTenant } = require('../lib/jobs');

const router = express.Router();
const publicRouter = express.Router();
const system = (tenantId) => ({ auth: { tenantId, userId: null } });
const d10 = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
const publicBase = () => require('../config').stripe.publicUrl || '';

async function tenantFor(slug) {
  const t = await one(pool, 'SELECT id, name, slug, phone, timezone, online_shop, waiver_text FROM tenants WHERE slug = ?', [String(slug)]);
  if (!t) throw notFound('Mountain');
  return t;
}
/** The signed-in household, or 401. */
async function householdFor(req) {
  const t = await tenantFor(req.params.slug);
  const email = await PP.sessionEmail(t.id, req.get('x-family-session'));
  if (!email) throw unauthorized('Sign in again: ask for a new link');
  const hh = await HH.forEmail(pool, t.id, email);
  return { t, email, hh };
}
const inHousehold = (hh, id) => { if (!HH.has(hh, id)) throw notFound('Person'); return Number(id); };

// ---------------------------------------------------------------- the household account
/** Everything the account page shows. */
publicRouter.get('/:slug/account', async (req, res) => {
  const { t, email, hh } = await householdFor(req);
  res.set('Cache-Control', 'no-store');
  const today = todayIn(t.timezone);
  const season = seasonFor(today);
  const settings = await G.get(pool, t.id);
  const members = [];
  const seen = new Set();
  for (const a of hh.adults) for (const m of await HH.membersOf(pool, t.id, a)) if (!seen.has(m.id)) { seen.add(m.id); members.push({ ...m, relation: hh.adults.includes(m.id) ? (m.id === hh.primary ? 'self' : 'adult') : m.relation }); }
  for (const id of hh.ids.filter((x) => !seen.has(x))) { // a child on a program place only
    const p = await one(pool, 'SELECT id, first_name, last_name, date_of_birth FROM people WHERE tenant_id = ? AND id = ? AND anonymised_at IS NULL', [t.id, id]);
    if (p) { seen.add(id); members.push({ ...p, date_of_birth: d10(p.date_of_birth), relation: 'child', has_photo: false }); }
  }
  for (const m of members) {
    m.waiver_signed = Boolean(await one(pool, ON_FILE, [t.id, m.id, season]));
    m.visits = await V.summary(pool, t.id, m.id, today, t.timezone);
    delete m.email;
  }
  const ids = members.map((m) => m.id);
  const tickets = ids.length ? (await rows(pool, `SELECT t.id, t.code, t.valid_from, t.valid_to, t.uses_remaining, t.person_id, p.name AS product, p.kind, pe.first_name, (pe.photo IS NOT NULL) AS has_photo,
      (SELECT c.label FROM rfid_cards c WHERE c.tenant_id = t.tenant_id AND c.ticket_id = t.id AND c.status = 'assigned' LIMIT 1) AS card_label
    FROM tickets t JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id LEFT JOIN people pe ON pe.tenant_id = t.tenant_id AND pe.id = t.person_id
    WHERE t.tenant_id = ? AND t.person_id IN (?) AND t.status = 'active' AND t.valid_to >= ? ORDER BY p.kind = 'season_pass' DESC, t.valid_from, pe.first_name LIMIT 60`, [t.id, ids, today]))
    .map((k) => ({ ...k, valid_from: d10(k.valid_from), valid_to: d10(k.valid_to), has_photo: Boolean(k.has_photo), pass: k.kind === 'season_pass' })) : [];
  const names = Object.fromEntries((await rows(pool, 'SELECT id, name FROM products WHERE tenant_id = ?', [t.id])).map((p) => [p.id, p.name]));
  const rewards = (await R.usable(pool, t.id, ids, today)).map((r) => ({ id: r.id, person_id: r.person_id, first_name: (members.find((m) => m.id === r.person_id) || {}).first_name, kind: r.kind, reason: r.reason,
    words: R.words(r, names), code: r.code, valid_from: d10(r.valid_from), valid_to: d10(r.valid_to),
    choices: Object.entries(r.options).map(([k, o]) => ({ choice: k, words: k === 'free_ticket' ? `A free ${names[o.product_id] || 'day ticket'}` : k === 'percent' ? `${o.percent}% off a ticket` : `${money(o.cents)} off your order` })) }));
  const receipts = (await rows(pool, "SELECT reference, amount_cents, paid_at, view_token FROM shop_orders WHERE tenant_id = ? AND contact_email = ? AND status = 'paid' ORDER BY id DESC LIMIT 20", [t.id, email]))
    .map((o) => ({ reference: o.reference, amount_cents: o.amount_cents, paid_on: d10(o.paid_at), link: `/shop/${t.slug}?order=${o.view_token}` }));
  // Season recaps (Track LOYALTY): a private link per person or household, when LOYALTY offers loyalty.recapLinks.
  const L = require('../lib/loyalty');
  const recaps = typeof L.recapLinks === 'function' ? await L.recapLinks(pool, t.id, ids, baseUrl(req)).catch(() => []) : [];
  // Pass renewal: someone who had a season pass last season and none for this one, with the pass on sale online.
  const passes = await rows(pool, "SELECT id, name, base_price_cents FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind = 'season_pass' ORDER BY base_price_cents, id", [t.id]);
  const prevStart = `${Number(season.slice(0, 4)) - 1}-08-01`; const [seasonStart] = V.seasonRange(season);
  const renew = [];
  if (passes.length && ids.length) {
    const had = await rows(pool, `SELECT DISTINCT t.person_id, t.product_id FROM tickets t JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
      WHERE t.tenant_id = ? AND t.person_id IN (?) AND p.kind = 'season_pass' AND t.status <> 'void' AND t.valid_from >= ? AND t.valid_from < ?`, [t.id, ids, prevStart, seasonStart]);
    for (const hRow of had) {
      if (tickets.some((k) => k.pass && k.person_id === hRow.person_id) || renew.some((x) => x.person_id === hRow.person_id)) continue;
      const m = members.find((x) => x.id === hRow.person_id);
      const product = passes.find((p) => p.id === hRow.product_id) || passes[0];
      renew.push({ person_id: hRow.person_id, first_name: m ? m.first_name : '', has_photo: Boolean(m && m.has_photo), product_id: product.id, product: product.name });
    }
  }
  const last = await lastOrder(t.id, email, hh);
  await audit(pool, system(t.id), 'account_view', 'people', null, { email });
  res.json({ mountain: t.name, phone: t.phone, email, today, members, tickets, rewards, receipts, recaps, renew, rebuy: last ? { people: last.people.map((p) => p.first_name), products: [...new Set(last.lines.map((l) => l.name))] } : null,
    autorenew: Boolean(settings.autorenew_on), shop: Boolean(t.online_shop), waiver_link: t.waiver_text ? `/waiver/${t.slug}` : null });
});

/** A pass photo on file, for the household's own eyes (renewal: "is this still you?"). */
publicRouter.get('/:slug/account/people/:id/photo', async (req, res) => {
  const { t, hh } = await householdFor(req);
  const id = inHousehold(hh, req.params.id);
  const p = await one(pool, 'SELECT photo FROM people WHERE tenant_id = ? AND id = ?', [t.id, id]);
  res.set('Cache-Control', 'no-store');
  res.json({ photo: p && p.photo ? p.photo : null });
});

const personSchema = z.object({
  first_name: z.string().trim().min(1).max(60), last_name: z.string().trim().min(1).max(60),
  date_of_birth: dateStr.nullable().optional(),
  height_in: z.number().int().min(20).max(96).nullable().optional(), weight_lb: z.number().int().min(15).max(400).nullable().optional(),
  boot_size: z.string().trim().max(10).nullable().optional(), stance: z.enum(['regular', 'goofy']).nullable().optional(),
  discipline: z.enum(['ski', 'snowboard', 'telemark', 'adaptive']).nullable().optional(),
  ability_level: z.enum(['first_timer', 'beginner', 'intermediate', 'advanced']).nullable().optional(),
  ski_level: z.number().int().min(1).max(9).nullable().optional(), snowboard_level: z.number().int().min(1).max(9).nullable().optional(),
  photo: z.string().max(120000).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'The photo must be a JPEG').optional(),
});
const FIELDS = ['first_name', 'last_name', 'date_of_birth', 'height_in', 'weight_lb', 'boot_size', 'stance', 'discipline', 'ability_level', 'ski_level', 'snowboard_level', 'photo'];

/** Saved family: change one person's details (sizes, levels, birthday, the pass photo). */
publicRouter.patch('/:slug/account/people/:id', validate(personSchema.partial()), async (req, res) => {
  const { t, hh, email } = await householdFor(req);
  const id = inHousehold(hh, req.params.id);
  const keys = FIELDS.filter((k) => req.body[k] !== undefined);
  if (!keys.length) return res.json({ ok: true });
  if (req.body.date_of_birth && req.body.date_of_birth > todayIn(t.timezone)) throw bad('A birthday cannot be in the future');
  await tx(async (conn) => {
    await conn.query(`UPDATE people SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => req.body[k]), t.id, id]);
    await audit(conn, system(t.id), 'account_person_update', 'people', id, { fields: keys, email });
  });
  res.json({ ok: true });
});

/** Saved family: add a child (you are their parent or guardian) or a second adult (relation family, with their own email to sign in). */
publicRouter.post('/:slug/account/people', validate(personSchema.extend({ adult: z.boolean().default(false), email: z.string().trim().toLowerCase().email().max(255).optional() })), async (req, res) => {
  const { t, hh, email } = await householdFor(req);
  if (!hh.primary) throw conflict('Buy a ticket or register first, so we know who you are.');
  if (hh.ids.length >= 12) throw conflict('A household holds up to 12 people. Please call the mountain.');
  const b = req.body;
  if (b.date_of_birth && b.date_of_birth > todayIn(t.timezone)) throw bad('A birthday cannot be in the future');
  if (!b.adult && !b.date_of_birth) throw bad('Add the birthday for a child: it sets their ticket price');
  const id = await tx(async (conn) => {
    const keys = FIELDS.filter((k) => b[k] !== undefined && b[k] !== null);
    const [r] = await conn.query(`INSERT INTO people (tenant_id, ${keys.join(', ')}${b.adult && b.email ? ', email' : ''}, source) VALUES (?, ${keys.map(() => '?').join(', ')}${b.adult && b.email ? ', ?' : ''}, 'online')`,
      [t.id, ...keys.map((k) => b[k]), ...(b.adult && b.email ? [b.email] : [])]);
    await HH.link(conn, t.id, hh.primary, r.insertId, !b.adult);
    await audit(conn, system(t.id), 'account_person_add', 'people', r.insertId, { adult: b.adult, email });
    return r.insertId;
  });
  res.status(201).json({ id });
});

// ---------------------------------------------------------------- one prefilled checkout, rebuy and renewal
/** The last paid online order of this email: who came and what each had (ticket, rental). */
async function lastOrder(tenantId, email, hh) {
  const o = await one(pool, "SELECT order_id FROM shop_orders WHERE tenant_id = ? AND contact_email = ? AND status = 'paid' AND order_id IS NOT NULL ORDER BY id DESC LIMIT 1", [tenantId, email]);
  if (!o) return null;
  const lines = (await rows(pool, `SELECT i.person_id, i.product_id, i.line_kind, i.tier, p.name, p.kind, pe.first_name FROM order_items i JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id
    JOIN people pe ON pe.tenant_id = i.tenant_id AND pe.id = i.person_id WHERE i.tenant_id = ? AND i.order_id = ? AND i.person_id IS NOT NULL ORDER BY i.id`, [tenantId, o.order_id])).filter((l) => HH.has(hh, l.person_id));
  const people = []; for (const l of lines) if (!people.some((p) => p.id === l.person_id)) people.push({ id: l.person_id, first_name: l.first_name });
  return { lines, people };
}

/** For each person: their usual ticket (last one bought, or the cheapest one-day ticket) and usual rental. */
async function usualFor(t, personId, day) {
  const tickets = await rows(pool, "SELECT id, name, kind, valid_days FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind IN ('day_ticket','multi_day') ORDER BY kind = 'day_ticket' DESC, valid_days, base_price_cents, id", [t.id]);
  const rentals = await rows(pool, "SELECT id, name FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind = 'rental' ORDER BY id", [t.id]);
  const lastT = await one(pool, "SELECT i.product_id, i.tier FROM order_items i JOIN products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id WHERE i.tenant_id = ? AND i.person_id = ? AND p.kind IN ('day_ticket','multi_day') ORDER BY i.id DESC LIMIT 1", [t.id, personId]);
  const lastR = await one(pool, "SELECT i.product_id FROM order_items i WHERE i.tenant_id = ? AND i.person_id = ? AND i.line_kind = 'rental' ORDER BY i.id DESC LIMIT 1", [t.id, personId]);
  const ticket = (lastT && tickets.find((p) => p.id === lastT.product_id)) || tickets[0] || null;
  const rental = (lastR && rentals.find((p) => p.id === lastR.product_id)) || rentals[0] || null;
  const p = await one(pool, 'SELECT date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [t.id, personId]);
  const tier = p.date_of_birth ? null : (lastT && lastT.tier) || null;
  return { ticket, rental, rented_before: Boolean(lastR), tier, day };
}

/**
 * Builds the basket for a day: each person picked gets their usual ticket, a rental when asked (their sizes are on file),
 * and a lesson hand-off link. same_as_last: the people and rentals from the last order. The guest checks the total with
 * POST /shop/quote and pays with POST /shop/orders, sending the same session.
 */
publicRouter.post('/:slug/account/basket', validate(z.object({ date: dateStr, people: z.array(z.object({ id: z.number().int().positive(), rental: z.boolean().optional(), lesson: z.boolean().optional() })).max(12).optional(), same_as_last: z.boolean().optional() })), async (req, res) => {
  const { t, hh, email } = await householdFor(req);
  res.set('Cache-Control', 'no-store');
  let picks = req.body.people || [];
  if (req.body.same_as_last) {
    const last = await lastOrder(t.id, email, hh);
    if (!last) throw conflict('There is no earlier order to repeat');
    picks = last.people.map((p) => ({ id: p.id, rental: last.lines.some((l) => l.person_id === p.id && l.line_kind === 'rental') }));
  }
  if (!picks.length) throw bad('Pick who is coming');
  const items = []; const addons = []; const lessons = []; const missing = [];
  for (const pk of picks) {
    const id = inHousehold(hh, pk.id);
    const u = await usualFor(t, id, req.body.date);
    if (!u.ticket) throw conflict('No lift tickets are on sale online right now');
    const p = await one(pool, 'SELECT first_name, date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [t.id, id]);
    if (!p.date_of_birth && !u.tier) missing.push({ id, first_name: p.first_name });
    items.push({ product_id: u.ticket.id, valid_on: req.body.date, holder: { person_id: id, ...(p.date_of_birth ? {} : { age_group: u.tier || undefined }) } });
    if (pk.rental && u.rental) addons.push({ product_id: u.rental.id, quantity: 1, for_item: items.length - 1 });
    if (pk.lesson) lessons.push(p.first_name);
  }
  const lessonLink = lessons.length ? `/book/${encodeURIComponent(t.slug)}?date=${req.body.date}` : null;
  res.json({ basket: { items, addons }, missing_age: missing, lesson_for: lessons, lesson_link: lessonLink });
});

/** Renew a season pass with last season's photo: the basket line, once the guest confirmed the photo is still them. */
publicRouter.post('/:slug/account/renew', validate(z.object({ person_id: z.number().int().positive(), product_id: z.number().int().positive(), photo_is_me: z.literal(true) })), async (req, res) => {
  const { t, hh } = await householdFor(req);
  const id = inHousehold(hh, req.body.person_id);
  const p = await one(pool, 'SELECT date_of_birth, (photo IS NOT NULL) AS has_photo FROM people WHERE tenant_id = ? AND id = ?', [t.id, id]);
  if (!p.has_photo) throw conflict('There is no photo on file. Add a new one to renew.');
  if (!p.date_of_birth) throw conflict('Add the birthday first: a season pass needs it.');
  res.json({ basket: { items: [{ product_id: req.body.product_id, valid_on: todayIn(t.timezone), holder: { person_id: id, use_photo_on_file: true } }], addons: [] } });
});

// ---------------------------------------------------------------- card reload online
/** Checks a card number from the back of an RFID card. Says only whether a day can go onto it, never whose it is. */
publicRouter.post('/:slug/reload/check', validate(z.object({ card: z.string().trim().min(4).max(40) })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const card = await require('../lib/shopsale').reloadable(pool, t.id, req.body.card, todayIn(t.timezone));
  if (!card) return res.json({ ok: false, reason: 'We could not find that card. Check the number on the back, or buy at the ticket window.' });
  if (card.busy) return res.json({ ok: false, reason: 'That card already holds a ticket or pass that is still good. Use it at the lift.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- gift experiences
const THEMES = ['First day on snow', 'A Saturday with Grandpa', 'A day on the mountain', 'Learn to ride'];
const INCLUDES = ['ticket', 'rental', 'lesson'];
const giftHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** What a gift experience can include, priced from the mountain's online products (an adult's price). */
async function includesMenu(db, tenantId) {
  const pick = async (sql) => one(db, sql, [tenantId]);
  const ticket = await pick("SELECT id, name, base_price_cents AS cents FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind = 'day_ticket' ORDER BY valid_days, base_price_cents, id LIMIT 1");
  const rental = await pick("SELECT id, name, base_price_cents AS cents FROM products WHERE tenant_id = ? AND active = 1 AND kind = 'rental' ORDER BY base_price_cents, id LIMIT 1");
  const lesson = await pick("SELECT id, name, base_price_cents AS cents FROM products WHERE tenant_id = ? AND active = 1 AND kind = 'lesson' ORDER BY base_price_cents, id LIMIT 1");
  return Object.fromEntries(Object.entries({ ticket, rental, lesson }).filter(([, v]) => v && v.cents > 0));
}
const giftSchema = z.object({
  theme: z.string().trim().min(1).max(80), includes: z.array(z.enum(INCLUDES)).max(3).default([]), amount_cents: z.number().int().min(0).max(100000).default(0),
  from_name: z.string().trim().min(1).max(150), recipient_name: z.string().trim().min(1).max(150), recipient_email: z.string().trim().toLowerCase().email().max(255),
  message: z.string().trim().max(500).optional(), deliver_on: dateStr,
});
/** The value of a gift experience: its included items at today's adult price, plus any amount. */
async function giftValue(db, tenantId, g) {
  const menu = await includesMenu(db, tenantId);
  for (const k of g.includes) if (!menu[k]) throw bad(`This mountain does not offer a ${k} as a gift right now`);
  const cents = g.includes.reduce((n, k) => n + menu[k].cents, 0) + (g.amount_cents || 0);
  if (cents < 500) throw bad('A gift is at least 5.00. Add something to it.');
  return { cents, items: g.includes.map((k) => ({ kind: k, product_id: menu[k].id, name: menu[k].name, cents: menu[k].cents })) };
}

/** Makes the experience for a gift card just sold (the shop's fulfil, or the window's gift card dialog). */
async function attachExperience(conn, tenantId, { giftCardId, orderId, gift }) {
  const value = await giftValue(conn, tenantId, gift);
  const [r] = await conn.query(`INSERT INTO gift_experiences (tenant_id, gift_card_id, order_id, theme, includes, from_name, recipient_name, recipient_email, message, deliver_on, token_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, giftCardId, orderId || null, gift.theme, JSON.stringify({ items: value.items, amount_cents: gift.amount_cents || 0 }), gift.from_name, gift.recipient_name, gift.recipient_email,
    gift.message || null, gift.deliver_on, giftHash(crypto.randomBytes(24).toString('base64url'))]); // a real token is made at delivery
  return r.insertId;
}

publicRouter.get('/:slug/gifts/menu', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const menu = await includesMenu(pool, t.id);
  res.json({ themes: THEMES, includes: Object.entries(menu).map(([k, v]) => ({ key: k, name: v.name, cents: v.cents })), today: todayIn(t.timezone) });
});

/** Delivers one gift: a new private link (the old one stops working) and the email to the person receiving it. */
async function deliver(t, g, base) {
  const token = crypto.randomBytes(24).toString('base64url');
  const [u] = await pool.query('UPDATE gift_experiences SET token_hash = ?, delivered_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND delivered_at IS NULL', [giftHash(token), t.id, g.id]);
  if (!u.affectedRows) return false;
  const link = `${base}/gift/${t.slug}/${token}`;
  const text = [`Hi ${g.recipient_name.split(' ')[0]},`, '', `${g.from_name} sent you a gift from ${t.name}: ${g.theme}.`, '', 'Open it here:', link, '', g.message ? `"${g.message}"` : '', '', `See you on the mountain. ${t.name}`].join('\n');
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f3f6f7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:24px 8px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:10px">
<tr><td bgcolor="#12303a" style="padding:28px 24px;border-radius:10px 10px 0 0;font:700 22px/1.3 Arial,Helvetica,sans-serif;color:#ffffff">A gift for you, ${esc(g.recipient_name.split(' ')[0])}</td></tr>
<tr><td style="padding:20px 24px;font:16px/1.5 Arial,Helvetica,sans-serif;color:#12303a">${esc(g.from_name)} sent you a gift from ${esc(t.name)}: <b>${esc(g.theme)}</b>.${g.message ? `<br><br><i>"${esc(g.message)}"</i>` : ''}</td></tr>
<tr><td style="padding:0 24px 28px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#1a5fb4" style="border-radius:6px"><a href="${esc(link)}" style="display:inline-block;padding:14px 22px;font:600 16px Arial,Helvetica,sans-serif;color:#ffffff;text-decoration:none">Open your gift</a></td></tr></table></td></tr>
</table></td></tr></table></body></html>`;
  const r = await mailer.send({ tenantId: t.id, to: g.recipient_email, fromName: t.name, subject: `${g.from_name} sent you a gift: ${g.theme}`, text, html, tag: 'gift-experience' });
  if (!r.ok) await pool.query('UPDATE gift_experiences SET delivered_at = NULL WHERE tenant_id = ? AND id = ?', [t.id, g.id]);
  return r.ok;
}

async function giftByToken(t, token) {
  const g = await one(pool, `SELECT g.*, c.code, c.balance_cents, c.initial_cents, c.status AS card_status FROM gift_experiences g LEFT JOIN gift_cards c ON c.tenant_id = g.tenant_id AND c.id = g.gift_card_id
    WHERE g.tenant_id = ? AND g.token_hash = ? AND g.delivered_at IS NOT NULL`, [t.id, giftHash(token)]);
  if (!g) throw notFound('Gift');
  return g;
}
const giftOut = (t, g) => {
  const inc = typeof g.includes === 'string' ? JSON.parse(g.includes) : g.includes;
  return { mountain: t.name, theme: g.theme, from_name: g.from_name, recipient_name: g.recipient_name, message: g.message, includes: inc.items.map((i) => i.name), amount_cents: inc.amount_cents || 0,
    value_cents: g.initial_cents, balance_cents: g.balance_cents, redeemed: Boolean(g.redeemed_at), code: g.redeemed_at ? g.code : null, account: `/family/${t.slug}`, shop: t.online_shop ? `/shop/${t.slug}` : null };
};

/** The reveal page's data: by its private link only. */
publicRouter.get('/:slug/gift/:token', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const g = await giftByToken(t, req.params.token);
  if (!g.revealed_at) await pool.query('UPDATE gift_experiences SET revealed_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND revealed_at IS NULL', [t.id, g.id]);
  res.json(giftOut(t, g));
});

/**
 * Redeems the gift once: the person receiving it joins (or starts) their household account with the email it was sent
 * to, the gift card becomes theirs, and the page shows the code to use at the window. A second try says it is done.
 */
publicRouter.post('/:slug/gift/:token/redeem', validate(z.object({ first_name: z.string().trim().min(1).max(60), last_name: z.string().trim().min(1).max(60), date_of_birth: dateStr.optional() })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const g0 = await giftByToken(t, req.params.token);
  const out = await tx(async (conn) => {
    const g = await one(conn, 'SELECT * FROM gift_experiences WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, g0.id]);
    if (g.redeemed_at) throw conflict('This gift has already been opened and added to an account');
    let p = await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND LOWER(email) = ? AND first_name = ? AND last_name = ? AND anonymised_at IS NULL ORDER BY id LIMIT 1', [t.id, g.recipient_email, req.body.first_name, req.body.last_name]);
    if (!p) {
      const [r] = await conn.query("INSERT INTO people (tenant_id, first_name, last_name, email, date_of_birth, source) VALUES (?, ?, ?, ?, ?, 'online')", [t.id, req.body.first_name, req.body.last_name, g.recipient_email, req.body.date_of_birth || null]);
      p = { id: r.insertId };
    }
    await conn.query('UPDATE gift_experiences SET redeemed_at = UTC_TIMESTAMP(), redeemed_person_id = ? WHERE tenant_id = ? AND id = ?', [p.id, t.id, g.id]);
    if (g.gift_card_id) await conn.query('UPDATE gift_cards SET recipient_name = ? WHERE tenant_id = ? AND id = ?', [`${req.body.first_name} ${req.body.last_name}`, t.id, g.gift_card_id]);
    await audit(conn, system(t.id), 'gift_redeem', 'gift_experiences', g.id, { person_id: p.id });
    return p.id;
  });
  // A sign-in link to the new account, so the person receiving the gift can see it there.
  if (mailer.enabled()) {
    const token = await PP.newToken(t.id, g0.recipient_email, 'link');
    await mailer.send({ tenantId: t.id, to: g0.recipient_email, fromName: t.name, subject: `Your account at ${t.name}`, tag: 'gift-account',
      text: [`Hi ${req.body.first_name},`, '', `Your gift is in your account at ${t.name}. Sign in here (the link works once, for 30 minutes):`, `${baseUrl(req)}/family/${t.slug}?t=${token}`, '', t.name].join('\n') }).catch(() => {});
  }
  res.json({ ...giftOut(t, await giftByToken(t, req.params.token)), person_id: undefined, joined: Boolean(out) });
});

/** The gift card balance page: a code in, the balance out. Rate limited with the rest of /public. */
publicRouter.post('/:slug/gift-balance', validate(z.object({ code: z.string().trim().min(6).max(20) })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const c = await one(pool, 'SELECT balance_cents, initial_cents, status, expires_on FROM gift_cards WHERE tenant_id = ? AND code = ?', [t.id, req.body.code.toUpperCase().replace(/\s/g, '')]);
  if (!c || c.status !== 'active') return res.json({ found: false });
  res.json({ found: true, balance_cents: c.balance_cents, initial_cents: c.initial_cents, expires_on: d10(c.expires_on), mountain: t.name });
});

// ---------------------------------------------------------------- staff: arrival words, the morning-of time, a gift at the window
router.get('/account-settings', requireRole('manager', 'counter'), async (req, res) => res.json(await arrival.get(pool, req.auth.tenantId)));
router.patch('/account-settings', requireRole('manager'), validate(arrival.schema), async (req, res) => {
  await tx(async (conn) => { await arrival.save(conn, req.auth.tenantId, req.body); await audit(conn, req, 'update', 'account_settings', req.auth.tenantId, req.body); });
  res.json(await arrival.get(pool, req.auth.tenantId));
});
/** The window sells a gift experience as a gift card: this adds the theme and delivery to a gift card just sold. */
router.post('/gift-experiences', requireRole('manager', 'counter'), validate(giftSchema.extend({ gift_card_id: z.number().int().positive() })), async (req, res) => {
  const id = await tx(async (conn) => {
    const c = await one(conn, 'SELECT id, order_id FROM gift_cards WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, req.body.gift_card_id]);
    if (!c) throw notFound('Gift card');
    if (await one(conn, 'SELECT id FROM gift_experiences WHERE tenant_id = ? AND gift_card_id = ?', [req.auth.tenantId, c.id])) throw conflict('That gift card already has a gift experience');
    const gid = await attachExperience(conn, req.auth.tenantId, { giftCardId: c.id, orderId: c.order_id, gift: req.body });
    await audit(conn, req, 'create', 'gift_experiences', gid, { gift_card_id: c.id });
    return gid;
  });
  res.status(201).json({ id });
});
router.get('/gift-experiences/menu', requireRole('manager', 'counter'), async (req, res) => res.json({ themes: THEMES, includes: Object.entries(await includesMenu(pool, req.auth.tenantId)).map(([k, v]) => ({ key: k, name: v.name, cents: v.cents })) }));

// ---------------------------------------------------------------- the morning-of message
/**
 * On a visit day, at the mountain's time (default 7:00 AM), one short email per order with tickets for today: lifts open,
 * new snow, first chair, and the tickets link. A text too, only with recorded consent (the consent ledger) and texting set
 * up. Once per order per day (morning_messages is the claim).
 */
async function runMorning(t, base, { now: at = null } = {}) {
  const now = at || nowIn(t.timezone); const today = now.slice(0, 10);
  const set = await arrival.get(pool, t.id);
  if (!set.morning_on || now.slice(11, 16) < set.morning_time || now.slice(11, 16) > '11:00') return 0;
  const list = await rows(pool, `SELECT DISTINCT s.id, s.order_id, s.contact_name, s.contact_email, s.view_token, o.person_id FROM shop_orders s JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
    JOIN order_items i ON i.tenant_id = s.tenant_id AND i.order_id = s.order_id JOIN tickets k ON k.tenant_id = i.tenant_id AND k.order_item_id = i.id JOIN products p ON p.tenant_id = k.tenant_id AND p.id = k.product_id
    WHERE s.tenant_id = ? AND s.status = 'paid' AND k.status = 'active' AND p.kind IN ('day_ticket','multi_day','activity') AND k.valid_from <= ? AND k.valid_to >= ?
      AND NOT EXISTS (SELECT 1 FROM morning_messages m WHERE m.tenant_id = s.tenant_id AND m.order_id = s.order_id AND m.on_date = ?) LIMIT 500`, [t.id, today, today, today]);
  if (!list.length) return 0;
  const cond = await arrival.conditions(pool, t.id, today);
  const sms = require('../lib/sms');
  const { currentConsent } = require('../lib/consent');
  let sent = 0;
  for (const s of list) {
    const [claim] = await pool.query('INSERT IGNORE INTO morning_messages (tenant_id, order_id, on_date) VALUES (?, ?, ?)', [t.id, s.order_id, today]);
    if (!claim.affectedRows) continue;
    const link = `${base}/shop/${t.slug}?order=${s.view_token}`;
    const words = cond && cond.words ? `${cond.words.charAt(0).toUpperCase()}${cond.words.slice(1)}.` : 'See you on the mountain.';
    const text = [`Good morning, ${String(s.contact_name).split(' ')[0]}.`, '', `Today at ${t.name}: ${words}`, '', 'Your tickets:', link, '', `Where to park: ${set.park_text}`].join('\n');
    const r = await mailer.send({ tenantId: t.id, to: s.contact_email, fromName: t.name, subject: `Today at ${t.name}`, text, tag: 'morning-of' });
    let texted = false;
    if (sms.enabled() && s.person_id) {
      const c = await currentConsent(pool, t.id, s.person_id);
      const phone = await one(pool, 'SELECT phone FROM people WHERE tenant_id = ? AND id = ?', [t.id, s.person_id]);
      if (c.sms && c.sms.status === 'opted_in' && phone && phone.phone) texted = (await sms.send({ tenantId: t.id, to: phone.phone, body: `Today at ${t.name}: ${words} Your tickets: ${link}` })).ok;
    }
    await pool.query('UPDATE morning_messages SET emailed = ?, texted = ? WHERE tenant_id = ? AND order_id = ? AND on_date = ?', [r.ok ? 1 : 0, texted ? 1 : 0, t.id, s.order_id, today]);
    if (r.ok) sent += 1;
  }
  return sent;
}

/** Gifts due today or earlier that have not gone yet. */
async function runGifts(t, base) {
  const today = todayIn(t.timezone);
  const due = await rows(pool, 'SELECT * FROM gift_experiences WHERE tenant_id = ? AND delivered_at IS NULL AND deliver_on <= ? ORDER BY id LIMIT 200', [t.id, today]);
  let n = 0;
  for (const g of due) if (await deliver(t, g, base)) n += 1;
  return n;
}

async function tick(base = publicBase()) {
  const out = { morning: 0, gifts: 0 };
  if (!mailer.enabled()) return out;
  await eachTenant('guests_account', async (t) => {
    if (await require('../lib/sandbox').isSandbox(t.id)) return {};
    out.gifts += await runGifts(t, base);
    out.morning += await runMorning(t, base);
    return {};
  }, { columns: 'id, slug, name, timezone, online_shop' });
  return out;
}
async function daily() { return {}; }

module.exports = { router, publicRouter, tick, daily, runMorning, runGifts, attachExperience, giftValue, includesMenu, THEMES };
