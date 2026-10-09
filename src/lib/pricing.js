'use strict';

const { rows, one } = require('../db');
const { bad, notFound, conflict } = require('./errors');
const { allowedOn, dayName, daysText } = require('./saledays');

/**
 * Unit price for one product / tier / date, in cents. Precedence (most specific wins):
 *   1. price_calendar row for that date and tier
 *   2. price_calendar row for that date with no tier (applies to every tier)
 *   3. price_tiers row for the tier
 *   4. products.base_price_cents
 * A blackout row for that date (tier-specific or all tiers) blocks the sale.
 */
async function unitPrice(db, tenantId, productId, tier, date) {
  const product = await one(db, 'SELECT * FROM products WHERE tenant_id = ? AND id = ?', [tenantId, productId]);
  if (!product) throw notFound('Product');
  if (!product.active) throw conflict('Product is not on sale');
  if (!allowedOn(product.sale_days, date)) throw conflict(`${product.name} is not sold on ${dayName(date)}s (${daysText(product.sale_days)})`);

  const cal = await rows(
    db,
    'SELECT tier, price_cents, blackout FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND (tier = ? OR tier IS NULL)',
    [tenantId, productId, date, tier],
  );
  if (cal.some((c) => c.blackout)) throw conflict(`${product.name} is blacked out on ${date}`);

  const specific = cal.find((c) => c.tier === tier && c.price_cents !== null);
  if (specific) return { product, cents: specific.price_cents, source: 'calendar_tier' };
  const general = cal.find((c) => c.tier === null && c.price_cents !== null);
  if (general) return { product, cents: general.price_cents, source: 'calendar' };

  const t = await one(db, 'SELECT price_cents FROM price_tiers WHERE tenant_id = ? AND product_id = ? AND tier = ?', [tenantId, productId, tier]);
  if (t) return { product, cents: t.price_cents, source: 'tier' };
  return { product, cents: product.base_price_cents, source: 'base' };
}

/**
 * Looks up a promo code and computes the discount on a subtotal.
 * Returns { discountCents, promo } or throws if the code is invalid today.
 * Pass `lock: true` inside a transaction to serialize max_uses accounting.
 */
async function applyPromo(db, tenantId, code, subtotalCents, onDate, { lock = false } = {}) {
  const promo = await one(db, `SELECT * FROM promo_codes WHERE tenant_id = ? AND code = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, code]);
  if (!promo) throw bad('Unknown promo code');
  if (promo.starts_on && onDate < promo.starts_on) throw bad('Promo code is not active yet');
  if (promo.ends_on && onDate > promo.ends_on) throw bad('Promo code has expired');
  if (promo.max_uses !== null && promo.used_count >= promo.max_uses) throw bad('Promo code has been fully used');

  let discount = 0;
  if (promo.percent_off) discount += Math.floor((subtotalCents * promo.percent_off) / 100);
  if (promo.amount_off_cents) discount += promo.amount_off_cents;
  return { discountCents: Math.min(discount, subtotalCents), promo };
}

module.exports = { unitPrice, applyPromo };
