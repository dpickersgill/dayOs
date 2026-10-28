'use strict';

// Front desk > Partner passes (/partner-passes, part of Sell): the Indy Pass and other partner passes a mountain honors.
//   GET  /                         the programs, with today's visits
//   GET  /tab , PUT /tab           whether Sell shows its Partner passes tab (the mountain can turn it off; a manager)
//   POST /indy                     set up the Indy Pass from its usual rules (a manager)
//   POST / , PATCH /:id            a program's rules (a manager)
//   PUT  /:id/blackouts            its blackout dates
//   GET  /:id/check                what a pass gets on a day (free, discount or why not), and its days here this season
//   GET  /:id/redemptions(.csv)    every visit in a date range, to check against the partner's statement
//   POST /redemptions/:rid/id-checked   ID checked when an online reservation is picked up
//   POST /redemptions/:rid/void    a manager gives the day back (the ticket is voided too)
// The sale itself goes through /checkout as a ticket line with `partner` (so payments, receipts and refunds work as
// usual). Guests reserve a free day online at /reserve/<mountain> (publicRouter below), when the mountain allows it.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, addDays, seasonFor, newCode } = require('../lib/util');
const { bad, conflict, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { unitPrice } = require('../lib/pricing');
const { resolvePerson } = require('../lib/customers');
const { ON_FILE, shaOf } = require('../lib/waivers');
const { isMinor } = require('../lib/family');
const { cell } = require('../lib/csv');
const { money } = require('../lib/format');
const mailer = require('../lib/mailer');
const P = require('../lib/partnerpasses');

const router = express.Router();
const publicRouter = express.Router();
const desk = requireRole('counter', 'manager');
const boss = requireRole('manager');

const levelSchema = z.object({ key: z.string().trim().regex(/^[a-z0-9_]{1,30}$/, 'Short lowercase key'), label: z.string().trim().min(1).max(40), blackouts: z.boolean() });
const fields = {
  name: z.string().trim().min(2).max(80),
  product_id: z.number().int().positive(),
  levels: z.array(levelSchema).min(1).max(6).optional(),
  number_label: z.string().trim().min(2).max(60).optional(),
  free_days: z.number().int().min(0).max(30).optional(),
  discount_days: z.number().int().min(0).max(30).optional(),
  discount_percent: z.number().int().min(0).max(100).optional(),
  daily_limit: z.number().int().min(1).max(100000).nullable().optional(),
  id_check: z.boolean().optional(),
  online: z.boolean().optional(),
  reservation_required: z.boolean().optional(),
  staff_note: z.string().trim().max(500).nullable().optional(),
  active: z.boolean().optional(),
};
const toRow = (b) => {
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    out[k] = k === 'levels' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return out;
};
async function dayTicket(conn, tenantId, productId) {
  const p = await one(conn, 'SELECT id, kind, name FROM products WHERE tenant_id = ? AND id = ?', [tenantId, productId]);
  if (!p) throw notFound('Product');
  if (p.kind !== 'day_ticket') throw bad(`${p.name} is not a day ticket. Partner pass days are issued as a day ticket.`);
  return p;
}
const tzOf = async (db, t) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const day = (d) => String(d).slice(0, 10);

router.get('/', desk, async (req, res) => {
  const { tenantId } = req.auth;
  const today = todayIn(await tzOf(pool, tenantId));
  const programs = await rows(pool, 'SELECT p.*, pr.name AS product_name FROM partner_programs p LEFT JOIN products pr ON pr.tenant_id = p.tenant_id AND pr.id = p.product_id WHERE p.tenant_id = ? ORDER BY p.active DESC, p.name', [tenantId]);
  const counts = await rows(pool, `SELECT r.program_id, COUNT(*) AS n, SUM(r.channel = 'online' AND r.id_checked = 0) AS unchecked FROM partner_redemptions r WHERE r.tenant_id = ? AND r.on_date = ? AND ${P.COUNTS} GROUP BY r.program_id`, [tenantId, today]);
  const blackouts = await rows(pool, 'SELECT program_id, on_date FROM partner_blackouts WHERE tenant_id = ? AND on_date >= ? ORDER BY on_date', [tenantId, addDays(today, -1)]);
  const products = await rows(pool, "SELECT id, name FROM products WHERE tenant_id = ? AND kind = 'day_ticket' AND active = 1 ORDER BY name", [tenantId]);
  const { slug, partner_tab: tab } = await one(pool, 'SELECT slug, partner_tab FROM tenants WHERE id = ?', [tenantId]);
  res.json({
    today, products, reserve_path: `/reserve/${slug}`, show_tab: Boolean(Number(tab)),
    data: programs.map((p) => {
      const c = counts.find((x) => x.program_id === p.id);
      return { ...P.shape(p), today_count: c ? Number(c.n) : 0, today_unchecked: c ? Number(c.unchecked || 0) : 0, blackouts: blackouts.filter((b) => b.program_id === p.id).map((b) => day(b.on_date)) };
    }),
  });
});

// Sell shows a Partner passes tab unless the mountain turns it off (Settings, Sell and gate).
router.get('/tab', desk, async (req, res) => {
  const t = await one(pool, 'SELECT partner_tab FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.json({ show: Boolean(t && Number(t.partner_tab)) });
});

router.put('/tab', boss, validate(z.object({ show: z.boolean() })), async (req, res) => {
  const { tenantId } = req.auth;
  const before = Boolean(Number((await one(pool, 'SELECT partner_tab FROM tenants WHERE id = ?', [tenantId])).partner_tab));
  await pool.query('UPDATE tenants SET partner_tab = ? WHERE id = ?', [req.body.show ? 1 : 0, tenantId]);
  await audit(pool, req, 'update', 'tenants', tenantId, { partner_tab: { before, after: req.body.show } });
  res.json({ show: req.body.show });
});

router.post('/indy', boss, validate(z.object({ product_id: z.number().int().positive() })), async (req, res) => {
  const { tenantId } = req.auth;
  await dayTicket(pool, tenantId, req.body.product_id);
  if (await one(pool, 'SELECT id FROM partner_programs WHERE tenant_id = ? AND name = ?', [tenantId, P.INDY.name])) throw conflict('The Indy Pass is already set up');
  const row = toRow({ ...P.INDY, product_id: req.body.product_id });
  const cols = Object.keys(row);
  const [r] = await pool.query(`INSERT INTO partner_programs (tenant_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, [tenantId, ...Object.values(row)]);
  await audit(pool, req, 'create', 'partner_programs', r.insertId, { name: P.INDY.name });
  res.status(201).json({ id: r.insertId });
});

router.post('/', boss, validate(z.object(fields)), async (req, res) => {
  const { tenantId } = req.auth;
  await dayTicket(pool, tenantId, req.body.product_id);
  const row = toRow(req.body);
  const cols = Object.keys(row);
  const [r] = await pool.query(`INSERT INTO partner_programs (tenant_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, [tenantId, ...Object.values(row)]);
  await audit(pool, req, 'create', 'partner_programs', r.insertId, { name: req.body.name });
  res.status(201).json({ id: r.insertId });
});

router.patch('/:id', boss, validate(z.object(fields).partial()), async (req, res) => {
  const { tenantId } = req.auth;
  if (req.body.product_id) await dayTicket(pool, tenantId, req.body.product_id);
  const row = toRow(req.body);
  if (!Object.keys(row).length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE partner_programs SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...Object.values(row), tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Partner pass');
  await audit(pool, req, 'update', 'partner_programs', paramId(req), Object.keys(row));
  res.json({ ok: true });
});

// The whole list of blackout dates from today on (past ones are kept as they were).
router.put('/:id/blackouts', boss, validate(z.object({ dates: z.array(dateStr).max(400) })), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await one(pool, 'SELECT id FROM partner_programs WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!p) throw notFound('Partner pass');
  const today = todayIn(await tzOf(pool, tenantId));
  const dates = [...new Set(req.body.dates)].filter((d) => d >= today).sort();
  await tx(async (conn) => {
    await conn.query('DELETE FROM partner_blackouts WHERE tenant_id = ? AND program_id = ? AND on_date >= ?', [tenantId, p.id, today]);
    for (const d of dates) await conn.query('INSERT INTO partner_blackouts (tenant_id, program_id, on_date) VALUES (?, ?, ?)', [tenantId, p.id, d]);
  });
  await audit(pool, req, 'update', 'partner_blackouts', p.id, { dates: dates.length });
  res.json({ ok: true, dates });
});

// What a pass gets on a day. Never fails for "not allowed": the answer says why, so the window can tell the guest.
router.get('/:id/check', desk, async (req, res) => {
  const { tenantId } = req.auth;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIn(await tzOf(pool, tenantId));
  try {
    const c = await P.check(pool, tenantId, paramId(req), { number: req.query.number, level: req.query.level, date });
    let windowCents = null;
    try { windowCents = (await unitPrice(pool, tenantId, c.program.product_id, String(req.query.tier || 'adult'), date)).cents; } catch (_) { windowCents = null; }
    res.json({ ok: true, date, number: c.number, level: c.level, kind: c.kind, percent: c.percent, window_cents: windowCents, price_cents: windowCents === null ? null : P.chargeFor(windowCents, c), used: c.used, free_days: c.program.free_days, discount_days: c.program.discount_days, history: c.history.map((h) => ({ on_date: day(h.on_date), kind: h.kind, channel: h.channel })) });
  } catch (err) {
    if (err.status === 409) res.json({ ok: false, date, reason: err.message, used: err.details && err.details.used, history: err.details && err.details.history ? err.details.history.map((h) => ({ on_date: day(h.on_date), kind: h.kind })) : [] });
    else throw err;
  }
});

async function redemptionList(tenantId, programId, from, to) {
  return rows(pool, `SELECT r.*, CONCAT(pe.first_name, ' ', pe.last_name) AS holder, t.code AS ticket_code, u.email AS sold_by,
      (r.status = 'active' AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.tenant_id = r.tenant_id AND oi.id = r.order_item_id AND oi.refunded_at IS NOT NULL)) AS counts
    FROM partner_redemptions r
    LEFT JOIN people pe ON pe.tenant_id = r.tenant_id AND pe.id = r.person_id
    LEFT JOIN tickets t ON t.tenant_id = r.tenant_id AND t.id = r.ticket_id
    LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.created_by
    WHERE r.tenant_id = ? AND r.program_id = ? AND r.on_date BETWEEN ? AND ? ORDER BY r.on_date, r.id`, [tenantId, programId, from, to]);
}
const range = async (req) => {
  const today = todayIn(await tzOf(pool, req.auth.tenantId));
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const to = ok(req.query.to) ? String(req.query.to) : today;
  const from = ok(req.query.from) ? String(req.query.from) : to;
  if (from > to) throw bad('The start date is after the end date');
  return { from, to };
};

router.get('/:id/redemptions', desk, async (req, res) => {
  const { tenantId } = req.auth;
  const p = await one(pool, 'SELECT * FROM partner_programs WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!p) throw notFound('Partner pass');
  const { from, to } = await range(req);
  const list = (await redemptionList(tenantId, p.id, from, to)).map((r) => ({ ...r, on_date: day(r.on_date), counts: Boolean(Number(r.counts)), id_checked: Boolean(r.id_checked) }));
  const live = list.filter((r) => r.counts);
  res.json({
    program: P.shape(p), from, to, data: list,
    totals: { visits: live.length, free: live.filter((r) => r.kind === 'free').length, discount: live.filter((r) => r.kind === 'discount').length, charged_cents: live.reduce((n, r) => n + r.charged_cents, 0), window_cents: live.reduce((n, r) => n + r.window_cents, 0), online_unchecked: live.filter((r) => r.channel === 'online' && !r.id_checked).length },
  });
});

router.get('/:id/redemptions.csv', desk, async (req, res) => {
  const { tenantId } = req.auth;
  const p = await one(pool, 'SELECT * FROM partner_programs WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!p) throw notFound('Partner pass');
  const { from, to } = await range(req);
  const list = await redemptionList(tenantId, p.id, from, to);
  const levels = P.levelsOf(p);
  const head = ['Date', 'Pass number', 'Level', 'Guest', 'Day', 'Window price', 'Charged', 'Where', 'ID checked', 'Ticket', 'Status'];
  const lines = list.map((r) => [day(r.on_date), r.number, (levels.find((l) => l.key === r.level) || { label: r.level || '' }).label, r.holder || '', r.kind === 'free' ? 'Free' : `${r.percent_off}% off`,
    (r.window_cents / 100).toFixed(2), (r.charged_cents / 100).toFixed(2), r.channel === 'online' ? 'Reserved online' : 'Window', r.id_checked ? 'Yes' : 'No', r.ticket_code || '',
    r.status === 'void' ? `Voided${r.void_reason ? `: ${r.void_reason}` : ''}` : Number(r.counts) ? 'Counted' : 'Refunded'].map(cell).join(','));
  const name = `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${from}${from === to ? '' : `-to-${to}`}.csv`;
  res.set('content-type', 'text/csv; charset=utf-8').set('content-disposition', `attachment; filename="${name}"`).send([head.map(cell).join(','), ...lines].join('\r\n'));
});

router.post('/redemptions/:rid/id-checked', desk, async (req, res) => {
  const { tenantId } = req.auth;
  const [r] = await pool.query("UPDATE partner_redemptions SET id_checked = 1 WHERE tenant_id = ? AND id = ? AND status = 'active'", [tenantId, Number(req.params.rid) || 0]);
  if (!r.affectedRows) throw notFound('Visit');
  await audit(pool, req, 'id_checked', 'partner_redemptions', Number(req.params.rid));
  res.json({ ok: true });
});

router.post('/redemptions/:rid/void', boss, validate(z.object({ reason: z.string().trim().min(3, 'Say why').max(200) })), async (req, res) => {
  const { tenantId } = req.auth;
  const rid = Number(req.params.rid) || 0;
  await tx(async (conn) => {
    const r = await one(conn, 'SELECT * FROM partner_redemptions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, rid]);
    if (!r) throw notFound('Visit');
    if (r.status === 'void') throw conflict('That visit is already voided');
    await conn.query("UPDATE partner_redemptions SET status = 'void', void_reason = ? WHERE tenant_id = ? AND id = ?", [req.body.reason, tenantId, rid]);
    if (r.ticket_id) await conn.query("UPDATE tickets SET status = 'void' WHERE tenant_id = ? AND id = ?", [tenantId, r.ticket_id]);
    await audit(conn, req, 'void', 'partner_redemptions', rid, { reason: req.body.reason });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- guests reserve a free day online (/reserve/<mountain>)
const RESERVE_DAYS = 60;

async function publicTenant(slug) {
  const t = await one(pool, 'SELECT id, name, slug, timezone, phone, waiver_text FROM tenants WHERE slug = ?', [String(slug || '').slice(0, 63)]);
  if (!t) throw notFound('Mountain');
  return t;
}

publicRouter.get('/:slug/partner', async (req, res) => {
  const t = await publicTenant(req.params.slug);
  const today = todayIn(t.timezone);
  const programs = await rows(pool, 'SELECT * FROM partner_programs WHERE tenant_id = ? AND active = 1 AND online = 1 ORDER BY name', [t.id]);
  const out = [];
  for (const p of programs) {
    const black = (await rows(pool, 'SELECT on_date FROM partner_blackouts WHERE tenant_id = ? AND program_id = ? AND on_date BETWEEN ? AND ?', [t.id, p.id, today, addDays(today, RESERVE_DAYS)])).map((b) => day(b.on_date));
    let full = [];
    if (p.daily_limit !== null) {
      full = (await rows(pool, `SELECT r.on_date, COUNT(*) AS n FROM partner_redemptions r WHERE r.tenant_id = ? AND r.program_id = ? AND r.on_date BETWEEN ? AND ? AND ${P.COUNTS} GROUP BY r.on_date`, [t.id, p.id, today, addDays(today, RESERVE_DAYS)]))
        .filter((x) => Number(x.n) >= p.daily_limit).map((x) => day(x.on_date));
    }
    out.push({ id: p.id, name: p.name, number_label: p.number_label, levels: P.levelsOf(p).map((l) => ({ key: l.key, label: l.label, blackouts: l.blackouts })), free_days: p.free_days, discount_days: p.discount_days, discount_percent: p.discount_percent, blackouts: black, full, reservation_required: Boolean(p.reservation_required), id_check: Boolean(p.id_check) });
  }
  res.json({ mountain: t.name, phone: t.phone || null, today, last_day: addDays(today, RESERVE_DAYS), programs: out, waiver_text: t.waiver_text || null });
});

const reserveSchema = z.object({
  number: z.string().trim().min(3).max(60),
  level: z.string().max(30).optional(),
  date: dateStr,
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  date_of_birth: dateStr,
  email: z.string().trim().email('Enter an email address for the confirmation').max(255),
  phone: z.string().trim().max(40).optional(),
  waiver_accepted: z.boolean().optional(),
  website: z.string().max(200).optional(), // a bot trap: people never see it
});

publicRouter.post('/:slug/partner/:id/reserve', validate(reserveSchema), async (req, res) => {
  const t = await publicTenant(req.params.slug);
  const b = req.body;
  if (b.website) { res.status(201).json({ ok: true }); return; } // a bot filled the hidden box: say thanks, save nothing
  const today = todayIn(t.timezone);
  if (b.date < today) throw bad('Choose today or a day ahead');
  if (b.date > addDays(today, RESERVE_DAYS)) throw bad(`Reservations open ${RESERVE_DAYS} days ahead`);
  const minor = isMinor(b.date_of_birth, b.date);
  if (t.waiver_text && !minor && !b.waiver_accepted) throw bad('Read and accept the waiver to reserve');
  const out = await tx(async (conn) => {
    const c = await P.check(conn, t.id, paramId(req), { number: b.number, level: b.level, date: b.date, lock: true });
    if (!c.program.online) throw notFound('Partner pass');
    if (c.kind !== 'free') throw conflict(`Your free ${c.program.name} days here are used. The ${c.percent}% off day is bought at the ticket window.`);
    const { product, cents } = await unitPrice(conn, t.id, c.program.product_id, 'adult', b.date);
    const details = { first_name: b.first_name, last_name: b.last_name, date_of_birth: b.date_of_birth };
    if (!minor) { details.email = b.email; if (b.phone) details.phone = b.phone; }
    const who = await resolvePerson(conn, t.id, { details, scope: 'none', source: 'online', fillOnly: true });
    if (!who.id) throw bad('Could not save your details');
    const season = seasonFor(b.date);
    let waiverToSign = Boolean(t.waiver_text);
    if (t.waiver_text && !(await one(conn, ON_FILE, [t.id, who.id, season]))) {
      if (!minor) {
        await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_person_id, signed_by_name, signer_relation, text_sha, method) VALUES (?, ?, ?, 'general', ?, ?, 'self', ?, 'accepted_online')",
          [t.id, who.id, season, who.id, `${b.first_name} ${b.last_name}`, shaOf(t.waiver_text)]);
        waiverToSign = false;
      }
    } else waiverToSign = false;
    const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, user_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, channel) VALUES (?, ?, NULL, 'paid', 0, 0, 0, 0, 'online')", [t.id, who.id]);
    const [it] = await conn.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents) VALUES (?, ?, ?, 'ticket', ?, 'adult', 1, 0, ?, 0, 0)", [t.id, o.insertId, product.id, who.id, b.date]);
    const code = newCode();
    const [tk] = await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t.id, it.insertId, who.id, product.id, code, b.date, b.date, product.uses ?? null]);
    await P.record(conn, t.id, c, { date: b.date, windowCents: cents, chargedCents: 0, personId: who.id, orderId: o.insertId, itemId: it.insertId, ticketId: tk.insertId, channel: 'online', idChecked: false });
    await audit(conn, { auth: { tenantId: t.id, userId: null } }, 'partner_reserve', 'partner_redemptions', null, { program: c.program.id, date: b.date });
    return { code, program: c.program, used: c.used.free + 1, waiverToSign };
  });
  const p = out.program;
  if (mailer.enabled()) {
    const text = [`Hi ${b.first_name},`, '', `Your ${p.name} day at ${t.name} is reserved for ${b.date}.`, `This is free day ${out.used} of ${p.free_days} here this season.`, '',
      `Your ticket: ${out.code}`, p.id_check ? 'Bring photo ID that matches the name on your pass account. We check it when you collect your ticket or card.' : null,
      out.waiverToSign ? 'Your waiver is still to sign: do it at the ticket window.' : null, `Keep your ${p.number_label.toLowerCase()} handy.`, '', t.phone ? `Questions? Call ${t.phone}.` : null].filter((x) => x !== null).join('\n');
    mailer.send({ tenantId: t.id, to: b.email, fromName: t.name, subject: `Your ${p.name} day at ${t.name}, ${b.date}`, text, tag: 'partner-reserve' }).catch(() => {});
  }
  res.status(201).json({ ok: true, code: out.code, date: b.date, program: p.name, free_day: out.used, free_days: p.free_days, id_check: Boolean(p.id_check), waiver_to_sign: out.waiverToSign, mountain: t.name, charged: money(0) });
});

module.exports = { router, publicRouter };
