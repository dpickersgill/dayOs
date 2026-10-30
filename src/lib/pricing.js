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
 * opts.at 'window': the ticket window's price, after the walk-up cap (lib/fairprice.js, a mountain setting, off by
 * default). Then `walkup` says what the cap did: { from_cents, online_cents, cap_cents } when it lowered the price.
 */
async function unitPrice(db, tenantId, productId, tier, date, { at = null } = {}) {
  await require('./guesttypes').assertKnown(db, tenantId, [tier], { forSale: true });
  const product = await one(db, 'SELECT * FROM products WHERE tenant_id = ? AND id = ?', [tenantId, productId]);
  if (!product) throw notFound('Product');
  if (!product.active) throw conflict('Product is not on sale');
  if (!allowedOn(product.sale_days, date)) throw conflict(`${product.name} is not sold on ${dayName(date)}s (${daysText(product.sale_days)})`);

  const cal = await rows(
    db,
    'SELECT tier, price_cents, blackout FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND (tier = ? OR tier IS NULL)',
    [tenantId, productId, date, tier],
  );
  const t = await one(db, 'SELECT price_cents FROM price_tiers WHERE tenant_id = ? AND product_id = ? AND tier = ?', [tenantId, productId, tier]);
  const out = priceFrom(product, cal, t ? t.price_cents : null, tier);
  if (out.blackout) throw conflict(`${product.name} is blacked out on ${date}`);
  if (at === 'window') {
    const w = await require('./fairprice').walkup(db, tenantId, { product, windowCents: out.cents });
    if (w.capped) return { product, cents: w.cents, source: 'walkup_cap', walkup: { from_cents: out.cents, online_cents: w.online_cents, cap_cents: w.cap_cents } };
  }
  return { product, cents: out.cents, source: out.source, walkup: null };
}

/**
 * The same rules as unitPrice, worked out from rows already loaded (so a whole month can be priced in a few queries).
 * cal: that day's price_calendar rows for the product; tierPrice: its price_tiers price for the tier, or null.
 * Returns { blackout: true } or { cents, source }.
 */
function priceFrom(product, cal, tierPrice, tier) {
  const mine = cal.filter((c) => c.tier === tier || c.tier === null);
  if (mine.some((c) => c.blackout)) return { blackout: true };
  const specific = mine.find((c) => c.tier === tier && c.price_cents !== null);
  if (specific) return { cents: specific.price_cents, source: 'calendar_tier' };
  const general = mine.find((c) => c.tier === null && c.price_cents !== null);
  if (general) return { cents: general.price_cents, source: 'calendar' };
  if (tierPrice !== null && tierPrice !== undefined) return { cents: tierPrice, source: 'tier' };
  return { cents: product.base_price_cents, source: 'base' };
}

/**
 * Looks up a promo code and computes the discount on a subtotal.
 * Returns { discountCents, promo } or throws if the code is invalid today.
 * Pass `lock: true` inside a transaction to serialize max_uses accounting.
 */
async function applyPromo(db, tenantId, code, subtotalCents, onDate, { lock = false, excludeEmail = null } = {}) {
  const promo = await one(db, `SELECT * FROM promo_codes WHERE tenant_id = ? AND code = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, code]);
  if (!promo) throw bad('Unknown promo code');
  if (promo.starts_on && onDate < promo.starts_on) throw bad('Promo code is not active yet');
  if (promo.ends_on && onDate > promo.ends_on) throw bad('Promo code has expired');
  if (promo.max_uses !== null) {
    // Online baskets waiting on the card page hold a use, so a one-use code cannot go to two guests at once. A guest's own
    // earlier basket (they went back from the card page) does not count against them.
    const [[h]] = await db.query("SELECT COUNT(*) AS n FROM shop_orders WHERE tenant_id = ? AND status = 'awaiting_payment' AND created_at > DATE_SUB(NOW(), INTERVAL 40 MINUTE) AND promo_code = ? AND (? IS NULL OR contact_email <> ?)", [tenantId, promo.code, excludeEmail, excludeEmail]);
    if (promo.used_count + Number(h.n) >= promo.max_uses) throw bad('Promo code has been fully used');
  }

  let discount = 0;
  if (promo.percent_off) discount += Math.floor((subtotalCents * promo.percent_off) / 100);
  if (promo.amount_off_cents) discount += promo.amount_off_cents;
  return { discountCents: Math.min(discount, subtotalCents), promo };
}

module.exports = { unitPrice, priceFrom, applyPromo };
