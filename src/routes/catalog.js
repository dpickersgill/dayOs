'use strict';

const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { crud } = require('../lib/crud');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, tierEnum, validate, paramId } = require('../lib/util');
const GT = require('../lib/guesttypes');
const { unitPrice, applyPromo } = require('../lib/pricing');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const ACT = require('../lib/activities');

const products = express.Router();
const pricing = express.Router();

const productFields = {
  kind: z.enum(['day_ticket', 'multi_day', 'season_pass', 'punch_card', 'lesson', 'rental', 'program', 'voucher', 'activity']),
  name: z.string().min(1).max(255),
  base_price_cents: z.coerce.number().int().min(0),
  valid_days: z.coerce.number().int().min(1).max(400).default(1),
  uses: z.coerce.number().int().min(1).nullable().optional(),
  active: z.coerce.number().int().min(0).max(1).optional(),
  online: z.coerce.number().int().min(0).max(1).optional(),
  sale_days: z.coerce.number().int().min(1).max(127).nullable().optional(), // weekdays it is sold; blank = every day
  advance_days: z.coerce.number().int().min(1).max(365).nullable().optional(), // visit at least this many days away...
  advance_percent: z.coerce.number().int().min(1).max(90).nullable().optional(), // ...gets this percent off online
  online_daily_limit: z.coerce.number().int().min(1).max(100000).nullable().optional(), // most sold for one day online; blank = no limit
  // An activity (kind 'activity'): the attraction it is for, sold by time slot (timed) or for the whole day (a day pass,
  // with an optional cap a day). Time slots are set with the schedules below.
  attraction_id: z.coerce.number().int().positive().nullable().optional(),
  timed: z.coerce.number().int().min(0).max(1).optional(),
  day_capacity: z.coerce.number().int().min(1).max(100000).nullable().optional(),
};

// ---- activities: the attraction a product is for, its time slots, and the attractions a lift ticket includes
/** The attractions a manager can link products to (read straight from the table: the selling side's own list). */
products.get('/activity-options', requireRole('manager', 'counter'), async (req, res) => {
  res.json({ attractions: (await ACT.activeAttractions(pool, req.auth.tenantId)).map(ACT.attractionOut) });
});

/** An activity must name one of this mountain's active attractions; another product must not name one. */
products.use(async (req, _res, next) => {
  try {
    if (!['POST', 'PATCH'].includes(req.method) || !/^\/(\d+)?$/.test(req.path) || !req.body || typeof req.body !== 'object') return next();
    const cur = req.method === 'PATCH' ? await one(pool, 'SELECT kind, attraction_id FROM products WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, Number(req.path.slice(1))]) : null;
    const kind = req.body.kind || (cur && cur.kind);
    const att = req.body.attraction_id !== undefined ? req.body.attraction_id : (cur ? cur.attraction_id : null);
    if (kind === 'activity') {
      if (!att) throw bad('Choose the attraction this activity is for');
      const a = await ACT.attractionOf(pool, req.auth.tenantId, Number(att));
      if (!a || !a.active) throw bad('That attraction is not on file. Add it in Settings, Attractions.');
    } else if (req.body.attraction_id) throw bad('Only an activity is linked to an attraction');
    return next();
  } catch (err) { return next(err); }
});

products.get('/:id/activity', requireRole('manager', 'counter'), async (req, res) => {
  const pid = paramId(req);
  const p = await one(pool, 'SELECT id, kind, attraction_id, timed, day_capacity FROM products WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, pid]);
  if (!p) throw notFound('Product');
  const [schedules, includes] = await Promise.all([
    rows(pool, 'SELECT * FROM activity_schedules WHERE tenant_id = ? AND product_id = ? AND active = 1 ORDER BY starts_on, id', [req.auth.tenantId, pid]),
    rows(pool, 'SELECT attraction_id FROM product_attractions WHERE tenant_id = ? AND product_id = ? ORDER BY attraction_id', [req.auth.tenantId, pid]),
  ]);
  res.json({ ...p, timed: Boolean(p.timed), schedules: schedules.map(ACT.scheduleOut), includes: includes.map((r) => r.attraction_id) });
});

/** The attractions a lift ticket or pass includes: its holder is let in at those attractions' gates. */
products.put('/:id/includes', requireRole('manager'), validate(z.object({ attraction_ids: z.array(z.number().int().positive()).max(50) })), async (req, res) => {
  const pid = paramId(req); const t = req.auth.tenantId;
  const p = await one(pool, 'SELECT id, kind FROM products WHERE tenant_id = ? AND id = ?', [t, pid]);
  if (!p) throw notFound('Product');
  if (p.kind === 'activity') throw bad('An activity is for its own attraction only');
  const ids = [...new Set(req.body.attraction_ids)];
  if (ids.length && (await rows(pool, 'SELECT id FROM attractions WHERE tenant_id = ? AND id IN (?)', [t, ids])).length !== ids.length) throw bad('One of those attractions is not on file');
  await tx(async (conn) => {
    await conn.query('DELETE FROM product_attractions WHERE tenant_id = ? AND product_id = ?', [t, pid]);
    for (const a of ids) await conn.query('INSERT INTO product_attractions (tenant_id, product_id, attraction_id) VALUES (?, ?, ?)', [t, pid, a]);
    await audit(conn, req, 'set_includes', 'products', pid, { attraction_ids: ids });
  });
  res.json({ ok: true });
});

const scheduleFields = {
  days: z.number().int().min(1).max(127).default(127), // weekdays it runs (Sunday 1, Monday 2 ... Saturday 64)
  starts_on: dateStr,
  ends_on: dateStr.nullable().optional(),
  start_times: z.array(z.string().trim().refine((x) => ACT.hhmm(x), 'Use a time like 09:30')).min(1).max(ACT.MAX_TIMES),
  slot_minutes: z.number().int().min(5).max(720),
  capacity: z.number().int().min(1).max(10000),
};
async function timedActivity(req) {
  const p = await one(pool, 'SELECT id, kind, timed FROM products WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!p) throw notFound('Product');
  if (p.kind !== 'activity') throw bad('Time slots are for activities');
  return p;
}
const scheduleRow = (b) => {
  if (b.ends_on && b.starts_on && b.ends_on < b.starts_on) throw bad('The last day is before the first day');
  return b.start_times ? { ...b, start_times: ACT.parseTimes(b.start_times.join(',')).join(',') } : b;
};
products.post('/:id/schedules', requireRole('manager'), validate(z.object(scheduleFields)), async (req, res) => {
  const p = await timedActivity(req);
  const b = scheduleRow(req.body);
  const [r] = await pool.query('INSERT INTO activity_schedules (tenant_id, product_id, days, starts_on, ends_on, start_times, slot_minutes, capacity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, p.id, b.days, b.starts_on, b.ends_on || null, b.start_times, b.slot_minutes, b.capacity]);
  await audit(pool, req, 'add_schedule', 'products', p.id, { schedule_id: r.insertId, ...b });
  res.status(201).json(ACT.scheduleOut(await one(pool, 'SELECT * FROM activity_schedules WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, r.insertId])));
});
products.patch('/:id/schedules/:sid', requireRole('manager'), validate(partialOf(scheduleFields)), async (req, res) => {
  const p = await timedActivity(req);
  const sid = paramId(req, 'sid');
  const cur = await one(pool, 'SELECT * FROM activity_schedules WHERE tenant_id = ? AND product_id = ? AND id = ? AND active = 1', [req.auth.tenantId, p.id, sid]);
  if (!cur) throw notFound('Time slots');
  const b = scheduleRow({ starts_on: String(cur.starts_on).slice(0, 10), ...req.body, ends_on: req.body.ends_on === undefined ? (cur.ends_on ? String(cur.ends_on).slice(0, 10) : null) : req.body.ends_on });
  const set = []; const vals = [];
  for (const k of ['days', 'starts_on', 'ends_on', 'start_times', 'slot_minutes', 'capacity']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(b[k]); }
  await pool.query(`UPDATE activity_schedules SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, req.auth.tenantId, sid]);
  await audit(pool, req, 'change_schedule', 'products', p.id, { schedule_id: sid, ...req.body });
  res.json(ACT.scheduleOut(await one(pool, 'SELECT * FROM activity_schedules WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, sid])));
});
/** Taking slots off sale keeps every booking already made (each ticket still carries its slot). */
products.delete('/:id/schedules/:sid', requireRole('manager'), async (req, res) => {
  const p = await timedActivity(req);
  const sid = paramId(req, 'sid');
  const [r] = await pool.query('UPDATE activity_schedules SET active = 0 WHERE tenant_id = ? AND product_id = ? AND id = ? AND active = 1', [req.auth.tenantId, p.id, sid]);
  if (!r.affectedRows) throw notFound('Time slots');
  await audit(pool, req, 'remove_schedule', 'products', p.id, { schedule_id: sid });
  res.json({ ok: true });
});

// ---- tiers and calendar are nested under a product ----
products.get('/:id/pricing', requireRole('manager', 'counter'), async (req, res) => {
  const pid = paramId(req);
  const [tiers, calendar] = await Promise.all([
    rows(pool, 'SELECT tier, price_cents FROM price_tiers WHERE tenant_id = ? AND product_id = ? ORDER BY tier', [req.auth.tenantId, pid]),
    rows(pool, 'SELECT on_date, tier, price_cents, blackout FROM price_calendar WHERE tenant_id = ? AND product_id = ? ORDER BY on_date', [req.auth.tenantId, pid]),
  ]);
  res.json({ tiers, calendar });
});

products.put(
  '/:id/tiers',
  requireRole('manager'),
  validate(z.object({ tiers: z.array(z.object({ tier: tierEnum, price_cents: z.number().int().min(0) })).max(40) })),
  async (req, res) => {
    const pid = paramId(req);
    if (!(await one(pool, 'SELECT id FROM products WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, pid]))) throw notFound('Product');
    await GT.assertKnown(pool, req.auth.tenantId, req.body.tiers.map((t) => t.tier));
    for (const t of req.body.tiers) {
      await pool.query(
        'INSERT INTO price_tiers (tenant_id, product_id, tier, price_cents) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE price_cents = VALUES(price_cents)',
        [req.auth.tenantId, pid, t.tier, t.price_cents],
      );
    }
    await audit(pool, req, 'set_tiers', 'products', pid, req.body.tiers);
    res.json({ ok: true });
  },
);

/** Set or replace date-specific prices or blackouts. tier omitted = applies to all tiers. */
products.put(
  '/:id/calendar',
  requireRole('manager'),
  validate(
    z.object({
      entries: z
        .array(z.object({ on_date: dateStr, tier: tierEnum.optional(), price_cents: z.number().int().min(0).optional(), blackout: z.boolean().default(false) }))
        .min(1)
        .max(400),
    }),
  ),
  async (req, res) => {
    const pid = paramId(req);
    if (!(await one(pool, 'SELECT id FROM products WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, pid]))) throw notFound('Product');
    await GT.assertKnown(pool, req.auth.tenantId, req.body.entries.map((e) => e.tier));
    for (const e of req.body.entries) {
      if (!e.blackout && e.price_cents === undefined) continue;
      // MySQL unique keys treat NULL tier as distinct, so clear the old row first.
      await pool.query('DELETE FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND (tier <=> ?)', [req.auth.tenantId, pid, e.on_date, e.tier ?? null]);
      await pool.query('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents, blackout) VALUES (?, ?, ?, ?, ?, ?)', [
        req.auth.tenantId, pid, e.on_date, e.tier ?? null, e.blackout ? null : e.price_cents, e.blackout ? 1 : 0,
      ]);
    }
    await audit(pool, req, 'set_calendar', 'products', pid, { count: req.body.entries.length });
    res.json({ ok: true });
  },
);

products.use(
  crud({
    table: 'products',
    entity: 'Product',
    createSchema: z.object(productFields),
    updateSchema: partialOf(productFields),
    columns: ['kind', 'name', 'base_price_cents', 'valid_days', 'uses', 'active', 'online', 'sale_days', 'online_daily_limit', 'advance_days', 'advance_percent', 'attraction_id', 'timed', 'day_capacity'],
    filters: ['kind', 'active'],
    orderBy: 'kind, name',
    readRoles: ['counter', 'instructor'],
    writeRoles: ['manager'],
    allowDelete: false,
  }),
);

// ---- promo codes ----
const promoFields = {
  code: z.string().min(3).max(40).transform((s) => s.toUpperCase()),
  percent_off: z.number().int().min(1).max(100).nullable().optional(),
  amount_off_cents: z.number().int().min(1).nullable().optional(),
  starts_on: dateStr.nullable().optional(),
  ends_on: dateStr.nullable().optional(),
  max_uses: z.number().int().min(1).nullable().optional(),
};
pricing.use(
  '/promos',
  crud({
    table: 'promo_codes',
    entity: 'Promo code',
    createSchema: z.object(promoFields).refine((p) => p.percent_off || p.amount_off_cents, 'Set percent_off or amount_off_cents'),
    updateSchema: partialOf(promoFields),
    columns: ['code', 'percent_off', 'amount_off_cents', 'starts_on', 'ends_on', 'max_uses'],
    orderBy: 'code',
    readRoles: ['counter'],
    writeRoles: ['manager'],
  }),
);

/** Price a basket without selling it. Used by the ticket window, online checkout and the pricing preview. */
pricing.post(
  '/quote',
  requireRole('counter', 'manager'),
  validate(
    z.object({
      date: dateStr,
      promo_code: z.string().optional(),
      items: z.array(z.object({ product_id: z.number().int().positive(), tier: tierEnum.default('adult'), quantity: z.number().int().min(1).max(200).default(1) })).min(1).max(50),
    }),
  ),
  async (req, res) => {
    const { date, promo_code, items } = req.body;
    const lines = [];
    let subtotal = 0;
    for (const it of items) {
      const { product, cents, source } = await unitPrice(pool, req.auth.tenantId, it.product_id, it.tier, date);
      lines.push({ product_id: product.id, name: product.name, tier: it.tier, quantity: it.quantity, unit_price_cents: cents, price_source: source });
      subtotal += cents * it.quantity;
    }
    let discount = 0;
    if (promo_code) discount = (await applyPromo(pool, req.auth.tenantId, promo_code.toUpperCase(), subtotal, date)).discountCents;
    res.json({ date, lines, subtotal_cents: subtotal, discount_cents: discount, total_cents: subtotal - discount });
  },
);

module.exports = { products, pricing };
