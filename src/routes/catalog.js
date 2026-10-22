'use strict';

const express = require('express');
const { pool, rows, one } = require('../db');
const { crud } = require('../lib/crud');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, tierEnum, validate, paramId } = require('../lib/util');
const GT = require('../lib/guesttypes');
const { unitPrice, applyPromo } = require('../lib/pricing');
const { notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');

const products = express.Router();
const pricing = express.Router();

const productFields = {
  kind: z.enum(['day_ticket', 'multi_day', 'season_pass', 'punch_card', 'lesson', 'rental', 'program', 'voucher']),
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
};

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
    columns: ['kind', 'name', 'base_price_cents', 'valid_days', 'uses', 'active', 'online', 'sale_days', 'online_daily_limit', 'advance_days', 'advance_percent'],
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
