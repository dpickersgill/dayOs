'use strict';

// Sales tax, added on top of prices. A tax rule applies a rate (basis points: 600 = 6%) to one kind of sale or to
// everything. Tax is worked out per line after any promo discount has been shared out, so a refund of one line
// returns exactly the tax that was charged on it.
const { rows } = require('../db');

async function loadRules(conn, tenantId) {
  return rows(conn, 'SELECT id, name, applies_to, rate_bps FROM tax_rules WHERE tenant_id = ? AND active = 1 ORDER BY id', [tenantId]);
}

/** Splits a whole number of cents across weights so the parts add up exactly (largest remainder). */
function share(total, weights) {
  const sum = weights.reduce((n, w) => n + w, 0);
  if (!total || !sum) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((n, v) => n + v, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) out[order[k][1]] += 1;
  return out;
}

/** Splits an amount evenly over n units (remainder to the first ones). */
const split = (total, n) => share(total, Array.from({ length: n }, () => 1));

/**
 * priced: [{ type, cents }] (cents is the line total before discount). discount: total promo discount in cents, shared over
 * every line except gift cards. Gift cards are never taxed. Sets p.discount, p.tax and p.taxParts on each line.
 * Returns { tax, taxes: [{ name, rate_bps, amount_cents }] } for the whole basket.
 */
function applyTax(priced, discount, rules) {
  const eligible = priced.map((p) => (p.type === 'gift_card' ? 0 : p.cents));
  const shares = share(discount, eligible);
  const byRule = new Map();
  let tax = 0;
  priced.forEach((p, i) => {
    p.discount = shares[i];
    p.taxParts = [];
    p.tax = 0;
    if (p.type === 'gift_card') return; // a gift card is money held for later: tax is charged when it is spent
    const taxable = p.cents - p.discount;
    for (const r of rules) {
      if (r.applies_to !== 'all' && r.applies_to !== p.type) continue;
      const cents = Math.round((taxable * r.rate_bps) / 10000);
      if (!cents) continue;
      p.taxParts.push({ name: r.name, rate_bps: r.rate_bps, cents });
      p.tax += cents;
      const cur = byRule.get(r.name) || { name: r.name, rate_bps: r.rate_bps, amount_cents: 0 };
      cur.amount_cents += cents;
      byRule.set(r.name, cur);
    }
    tax += p.tax;
  });
  return { tax, taxes: [...byRule.values()] };
}

module.exports = { loadRules, share, split, applyTax };
