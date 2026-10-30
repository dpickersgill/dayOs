'use strict';

// Online shop, manager tools (mounted at /online-shop): a calendar of prices and limits you can change for many days at
// once, and how ticket sales are pacing against last year. The guest-facing and window-facing routes are in shop.js.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, todayIn, addDays, weekdayOf, dayRange } = require('../lib/util');
const { bad } = require('../lib/errors');
const { unitPrice } = require('../lib/pricing');
const { audit } = require('../lib/audit');
const shop = require('../lib/shopsale');

const router = express.Router();
const dstr = (d) => String(d).slice(0, 10);
const TICKET_SQL = "SELECT id, name, kind, online_daily_limit FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind IN ('day_ticket','multi_day') ORDER BY name";
const MAX_SPAN = 400;

const span = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

// ---------------------------------------------------------------- price and limit calendar
router.get('/calendar', requireRole('manager'), async (req, res) => {
  const t = await one(pool, 'SELECT id, timezone, online_daily_limit FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const today = todayIn(t.timezone);
  const from = dateStr.parse(String(req.query.from || today));
  const to = dateStr.parse(String(req.query.to || addDays(from, 41)));
  if (to < from || span(from, to).length > 62) throw bad('Pick up to 62 days at a time');
  const prods = await rows(pool, TICKET_SQL, [t.id]);
  const use = await shop.usage(pool, t.id, from, to);
  const cal = await rows(pool, 'SELECT product_id, on_date, tier, price_cents, blackout FROM price_calendar WHERE tenant_id = ? AND on_date >= ? AND on_date <= ?', [t.id, from, to]);
  const days = [];
  for (const d of span(from, to)) {
    const u = use.get(d) || { all: 0, by: new Map() };
    const row = { date: d, weekday: weekdayOf(d), sold: u.all, mountain_limit: use.over.has(`${d}|0`) ? use.over.get(`${d}|0`) : t.online_daily_limit, mountain_limit_is_override: use.over.has(`${d}|0`), products: [] };
    for (const p of prods) {
      const entries = cal.filter((c) => c.product_id === p.id && dstr(c.on_date) === d);
      const closed = entries.some((c) => c.blackout && c.tier === null);
      let price = null;
      if (!closed) { try { price = (await unitPrice(pool, t.id, p.id, 'adult', d)).cents; } catch (_) { price = null; } }
      row.products.push({ id: p.id, price_cents: price, closed, special: entries.some((c) => !c.blackout), limit: use.over.has(`${d}|${p.id}`) ? use.over.get(`${d}|${p.id}`) : p.online_daily_limit, limit_is_override: use.over.has(`${d}|${p.id}`), sold: u.by.get(p.id) || 0 });
    }
    days.push(row);
  }
  res.json({ today, products: prods.map((p) => ({ id: p.id, name: p.name })), days });
});

const applySchema = z.object({
  from: dateStr, to: dateStr,
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  product_id: z.number().int().positive().nullable().optional(), // null or missing: every online day-ticket product (limits: the whole mountain)
  action: z.enum(['price', 'close', 'open', 'clear', 'limit', 'clear_limit']),
  price_cents: z.number().int().min(1).max(10000000).optional(),
  tier: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,30}$/).nullable().optional(), // a guest type code (lib/guesttypes.js)
  // A price for each guest type, or one change (a percent or an amount, up or down) applied to each type's own price.
  prices: z.array(z.object({ tier: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,30}$/), price_cents: z.number().int().min(1).max(10000000) })).min(1).max(30).optional(),
  change: z.object({ percent: z.number().min(-90).max(500).optional(), amount_cents: z.number().int().min(-10000000).max(10000000).optional() })
    .refine((c) => (c.percent !== undefined) !== (c.amount_cents !== undefined), 'Give a percent or an amount, not both').optional(),
  limit: z.number().int().min(0).max(1000000).optional(),
});
router.post('/calendar', requireRole('manager'), validate(applySchema), async (req, res) => {
  const b = req.body; const tenantId = req.auth.tenantId;
  if (b.to < b.from) throw bad('The last day is before the first day');
  const days = span(b.from, b.to).filter((d) => !b.weekdays || !b.weekdays.length || b.weekdays.includes(weekdayOf(d)));
  if (!days.length) throw bad('No days match those weekdays');
  if (span(b.from, b.to).length > MAX_SPAN) throw bad(`Pick up to ${MAX_SPAN} days at a time`);
  if (b.action === 'price' && !b.price_cents && !b.prices && !b.change) throw bad('Enter the price');
  if (b.prices) await require('../lib/guesttypes').assertKnown(pool, tenantId, b.prices.map((x) => x.tier));
  if (b.tier) await require('../lib/guesttypes').assertKnown(pool, tenantId, [b.tier]);
  if (b.action === 'limit' && b.limit === undefined) throw bad('Enter the limit');
  const all = await rows(pool, TICKET_SQL, [tenantId]);
  let targets = all;
  if (b.product_id) { targets = all.filter((p) => p.id === b.product_id); if (!targets.length) throw bad('That product is not sold online'); }
  // Each product's own prices: its base price and a price for each guest type that has one. A bulk change never flattens
  // them: one price with no guest type is refused when a product has different prices by type.
  const own = new Map();
  for (const p of targets) {
    const base = (await one(pool, 'SELECT base_price_cents FROM products WHERE tenant_id = ? AND id = ?', [tenantId, p.id])).base_price_cents;
    own.set(p.id, { base, tiers: await rows(pool, 'SELECT tier, price_cents FROM price_tiers WHERE tenant_id = ? AND product_id = ?', [tenantId, p.id]) });
  }
  if (b.action === 'price' && b.price_cents && !b.tier && !b.prices && !b.change) {
    const mixed = targets.find((p) => own.get(p.id).tiers.some((t) => t.price_cents !== own.get(p.id).base));
    if (mixed) throw bad(`${mixed.name} has its own price for each guest type. Set a price for each type, or change every price by a percent or an amount.`);
  }
  const changed = (cents) => {
    const c = b.change.percent !== undefined ? Math.round(cents * (100 + b.change.percent) / 100) : cents + b.change.amount_cents;
    if (c < 1) throw bad('That change takes a price to zero or below');
    return c;
  };
  const setPrice = async (conn, pid, d, tier, cents) => {
    await conn.query('DELETE FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND (tier <=> ?)', [tenantId, pid, d, tier]);
    await conn.query('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents, blackout) VALUES (?, ?, ?, ?, ?, 0)', [tenantId, pid, d, tier, cents]);
  };
  await tx(async (conn) => {
    for (const d of days) {
      if (b.action === 'limit' || b.action === 'clear_limit') {
        const pid = b.product_id || 0;
        if (b.action === 'limit') await conn.query('INSERT INTO shop_day_limits (tenant_id, on_date, product_id, max_tickets) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE max_tickets = VALUES(max_tickets)', [tenantId, d, pid, b.limit]);
        else await conn.query('DELETE FROM shop_day_limits WHERE tenant_id = ? AND on_date = ? AND product_id = ?', [tenantId, d, pid]);
        continue;
      }
      for (const p of targets) {
        if (b.action === 'price' && b.prices) {
          for (const x of b.prices) await setPrice(conn, p.id, d, x.tier, x.price_cents);
        } else if (b.action === 'price' && b.change) {
          // the base price (for types with no price of their own), then each type's own price, each changed the same way
          const o = own.get(p.id);
          // a change starts from the products' own prices, so earlier special prices that day go first
          await conn.query('DELETE FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND blackout = 0', [tenantId, p.id, d]);
          await setPrice(conn, p.id, d, null, changed(o.base));
          for (const t of o.tiers) await setPrice(conn, p.id, d, t.tier, changed(t.price_cents));
        } else if (b.action === 'price') {
          await setPrice(conn, p.id, d, b.tier ?? null, b.price_cents);
        } else if (b.action === 'close') {
          await conn.query('DELETE FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND tier IS NULL', [tenantId, p.id, d]);
          await conn.query('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents, blackout) VALUES (?, ?, ?, NULL, NULL, 1)', [tenantId, p.id, d]);
        } else if (b.action === 'open') {
          await conn.query('DELETE FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND tier IS NULL AND blackout = 1', [tenantId, p.id, d]);
        } else if (b.action === 'clear') {
          await conn.query('DELETE FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ?', [tenantId, p.id, d]);
        }
      }
    }
    await audit(conn, req, 'shop_calendar', 'products', b.product_id || 0, { action: b.action, from: b.from, to: b.to, days: days.length, price_cents: b.price_cents, tier: b.tier, prices: b.prices, change: b.change, limit: b.limit });
  });
  res.json({ ok: true, days: days.length });
});

// ---------------------------------------------------------------- sales pace and funnel
const sumRow = async (tenantId, startUtc, endUtc) => {
  // Revenue includes date-change fees; the order count does not (a fee is not a new booking).
  const r = await one(pool, `SELECT COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM order_items x WHERE x.tenant_id = o.tenant_id AND x.order_id = o.id AND x.line_kind <> 'fee') THEN o.id END) AS orders,
      COALESCE(SUM(o.total_cents), 0) AS revenue FROM orders o WHERE o.tenant_id = ? AND o.channel = 'online' AND o.status = 'paid' AND o.created_at >= ? AND o.created_at < ?`, [tenantId, startUtc, endUtc]);
  const t = await one(pool, "SELECT COUNT(*) AS tickets FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id WHERE t.tenant_id = ? AND o.channel = 'online' AND o.status = 'paid' AND t.status <> 'void' AND o.created_at >= ? AND o.created_at < ?", [tenantId, startUtc, endUtc]);
  return { orders: Number(r.orders), revenue_cents: Number(r.revenue), tickets: Number(t.tickets) };
};
const pct = (now, was) => (was ? Math.round(((now - was) / was) * 100) : null);

router.get('/pace', requireRole('manager'), async (req, res) => {
  const t = await one(pool, 'SELECT id, timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const today = todayIn(t.timezone);
  const WEEKS = 4; const startThis = addDays(today, -7 * WEEKS + 1); // the last 28 days, today included
  const startLast = addDays(startThis, -364); const endLast = addDays(today, -364); // same weekdays one year ago
  const [thisStart] = dayRange(t.timezone, startThis); const [, thisEnd] = dayRange(t.timezone, today);
  const [lastStart] = dayRange(t.timezone, startLast); const [, lastEnd] = dayRange(t.timezone, endLast);
  const now = await sumRow(t.id, thisStart, thisEnd); const was = await sumRow(t.id, lastStart, lastEnd);

  // Days ahead: tickets sold so far for each visit day, against what had been sold a year ago at the same lead time.
  const ahead = [];
  const horizon = 21;
  const [aheadStart] = dayRange(t.timezone, today); const [, aheadEnd] = dayRange(t.timezone, addDays(today, horizon));
  const cutoffLast = new Date(Date.now() - 364 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const nowRows = await rows(pool, "SELECT t.valid_from AS d, COUNT(*) AS n FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND o.channel = 'online' AND o.status = 'paid' AND t.status <> 'void' AND p.kind IN ('day_ticket','multi_day') AND t.valid_from >= ? AND t.valid_from <= ? GROUP BY t.valid_from", [t.id, today, addDays(today, horizon)]);
  const lastRows = await rows(pool, "SELECT t.valid_from AS d, COUNT(*) AS final_n, SUM(o.created_at <= ?) AS by_then FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND o.channel = 'online' AND o.status = 'paid' AND t.status <> 'void' AND p.kind IN ('day_ticket','multi_day') AND t.valid_from >= ? AND t.valid_from <= ? GROUP BY t.valid_from", [cutoffLast, t.id, addDays(today, -364), addDays(today, horizon - 364)]);
  const byNow = new Map(nowRows.map((r) => [dstr(r.d), Number(r.n)]));
  const byLast = new Map(lastRows.map((r) => [dstr(r.d), r]));
  for (let k = 0; k <= horizon; k++) {
    const d = addDays(today, k); const ly = byLast.get(addDays(d, -364));
    ahead.push({ date: d, sold: byNow.get(d) || 0, last_year_by_now: ly ? Number(ly.by_then) : 0, last_year_final: ly ? Number(ly.final_n) : 0 });
  }
  void aheadStart; void aheadEnd;

  const f = await one(pool, 'SELECT COALESCE(SUM(visits), 0) AS visits FROM shop_visits WHERE tenant_id = ? AND day >= ? AND day <= ?', [t.id, startThis, today]);
  const bk = await one(pool, "SELECT COUNT(*) AS baskets, SUM(status = 'paid') AS paid FROM shop_orders WHERE tenant_id = ? AND created_at >= ? AND created_at < ?", [t.id, thisStart, thisEnd]);
  const funnel = { visits: Number(f.visits), baskets: Number(bk.baskets), paid: Number(bk.paid || 0) };
  funnel.visit_to_basket = funnel.visits ? Math.round((funnel.baskets / funnel.visits) * 100) : null;
  funnel.basket_to_paid = funnel.baskets ? Math.round((funnel.paid / funnel.baskets) * 100) : null;
  res.json({ today, window: { days: WEEKS * 7, from: startThis, now, last_year: was, change: { orders: pct(now.orders, was.orders), tickets: pct(now.tickets, was.tickets), revenue: pct(now.revenue_cents, was.revenue_cents) } }, ahead, funnel });
});

module.exports = { router };
