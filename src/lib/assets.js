'use strict';

// Assets and fleet: the rules that are not just storage. When a date-bound paper (registration, insurance, inspection,
// warranty) is about to run out, what a machine is worth on the books, what it has cost to keep, and whether the numbers
// say to replace it. Plus the starting inspection checklists every mountain gets.
const { one, rows, pool, tx } = require('../db');
const { dayRange } = require('./util');
const { CATEGORY_OF } = require('./ops');

const CATEGORIES = [['fleet', 'Fleet and vehicles'], ['lift', 'Lifts'], ['snowmaking', 'Snowmaking'], ['facility', 'Buildings and facilities'], ['equipment', 'Equipment and tools'], ['other', 'Other']]
  .map(([value, label]) => ({ value, label }));
const categoryOf = (a) => a.category || CATEGORY_OF[a.kind] || 'other';

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const PAPERS = [['registration_expires', 'Registration'], ['insurance_expires', 'Insurance'], ['inspection_expires', 'Annual inspection'], ['warranty_expires', 'Warranty']];
/** Each date-bound paper with its state: expired, due within `warnDays`, or fine. Retired assets have none. */
function papers(a, today, warnDays = 30) {
  if (a.status === 'retired') return [];
  const soon = addDays(today, warnDays);
  return PAPERS.map(([key, label]) => {
    const on = ymd(a[key]);
    if (!on) return null;
    // A warranty running out is worth knowing, not an alarm: it is never "expired" in red.
    const state = on < today ? (key === 'warranty_expires' ? 'ended' : 'expired') : on <= soon ? 'soon' : 'ok';
    return { key, label, on, state };
  }).filter(Boolean);
}

/** Whole years (with one decimal) between two dates. */
const yearsBetween = (a, b) => Math.max(0, Math.round(((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (365.25 * 86400000)) * 10) / 10);

/**
 * Book value by straight-line depreciation: cost less salvage, spread evenly over the useful life, never below salvage.
 * Returns null when the purchase cost or date is not known.
 */
function bookValue(a, today) {
  if (a.purchase_cents === null || a.purchase_cents === undefined || !a.purchased_on) return null;
  const cost = Number(a.purchase_cents); const salvage = Number(a.salvage_cents || 0);
  const life = Number(a.useful_life_years || 0);
  if (!life) return cost;
  const age = yearsBetween(ymd(a.purchased_on), today);
  return Math.round(Math.max(salvage, cost - (cost - salvage) * Math.min(1, age / life)));
}

/**
 * What an asset has cost: labor, parts, outside work and fuel, all-time and in the last 12 months, and per hour or mile
 * of use. `since` is the date 12 months ago.
 */
async function costs(conn, tenantId, assetIds, since) {
  if (!assetIds.length) return new Map();
  const ids = [assetIds];
  // completed_at is a mountain-clock time; opened_at is a UTC timestamp, so it is compared with the same moment in UTC.
  const sinceUtc = dayRange((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone, since)[0];
  const [labor, parts, vendor, fuel] = await Promise.all([
    rows(conn, `SELECT w.asset_id, SUM(l.hours * l.rate_cents) AS all_c, SUM(IF(l.worked_on >= ?, l.hours * l.rate_cents, 0)) AS yr_c, SUM(l.hours) AS hours
      FROM work_order_labor l JOIN work_orders w ON w.tenant_id = l.tenant_id AND w.id = l.work_order_id WHERE l.tenant_id = ? AND w.asset_id IN (?) GROUP BY w.asset_id`, [since, tenantId, ...ids]),
    rows(conn, `SELECT m.asset_id, SUM(-m.qty * m.unit_cost_cents) AS all_c, SUM(IF(m.at >= ?, -m.qty * m.unit_cost_cents, 0)) AS yr_c
      FROM part_moves m WHERE m.tenant_id = ? AND m.asset_id IN (?) AND m.kind IN ('issue','return') GROUP BY m.asset_id`, [since, tenantId, ...ids]),
    rows(conn, `SELECT asset_id, SUM(vendor_cost_cents) AS all_c, SUM(IF(IF(completed_at IS NULL, opened_at >= ?, completed_at >= ?), vendor_cost_cents, 0)) AS yr_c
      FROM work_orders WHERE tenant_id = ? AND asset_id IN (?) AND vendor_cost_cents IS NOT NULL AND status <> 'cancelled' GROUP BY asset_id`, [sinceUtc, since, tenantId, ...ids]),
    rows(conn, `SELECT asset_id, SUM(cost_cents) AS all_c, SUM(IF(filled_at >= ?, cost_cents, 0)) AS yr_c, SUM(gallons) AS gallons
      FROM asset_fuel WHERE tenant_id = ? AND asset_id IN (?) GROUP BY asset_id`, [since, tenantId, ...ids]),
  ]);
  const out = new Map(assetIds.map((id) => [id, { labor: 0, parts: 0, vendor: 0, fuel: 0, labor_12: 0, parts_12: 0, vendor_12: 0, fuel_12: 0, labor_hours: 0, gallons: 0 }]));
  const put = (list, key, extra) => { for (const r of list) { const o = out.get(Number(r.asset_id)); if (!o) continue; o[key] = Math.round(Number(r.all_c || 0)); o[`${key}_12`] = Math.round(Number(r.yr_c || 0)); if (extra) extra(o, r); } };
  put(labor, 'labor', (o, r) => { o.labor_hours = Number(r.hours || 0); });
  put(parts, 'parts');
  put(vendor, 'vendor');
  put(fuel, 'fuel', (o, r) => { o.gallons = Number(r.gallons || 0); });
  for (const o of out.values()) {
    o.maintenance = o.labor + o.parts + o.vendor;
    o.maintenance_12 = o.labor_12 + o.parts_12 + o.vendor_12;
    o.total = o.maintenance + o.fuel;
  }
  return out;
}

/**
 * The lifecycle picture for one asset: age, book value, cost per hour and mile, and whether to think about replacing it.
 * Replace when the last 12 months of upkeep passed `replacePct` percent of what it is worth now, or it is past its life.
 */
function lifecycle(a, c, today, replacePct = 50) {
  const age = a.purchased_on ? yearsBetween(ymd(a.purchased_on), today) : null;
  const book = bookValue(a, today);
  const hours = Number(a.hours || 0); const miles = Number(a.miles || 0);
  const reasons = [];
  if (book !== null && c.maintenance_12 > 0 && c.maintenance_12 >= book * (replacePct / 100)) reasons.push(`Upkeep in the last 12 months is ${Math.round((c.maintenance_12 / Math.max(book, 1)) * 100)}% of its book value`);
  if (age !== null && a.useful_life_years && age >= Number(a.useful_life_years)) reasons.push(`It is ${age} years old, past its ${a.useful_life_years}-year life`);
  return {
    age_years: age, book_value_cents: book,
    cost_per_hour_cents: hours > 0 ? Math.round(c.total / hours) : null,
    cost_per_mile_cents: miles > 0 ? Math.round(c.total / miles) : null,
    replace: reasons.length > 0, reasons,
  };
}

// ---------------------------------------------------------------- starting checklists
const T = (name, kinds, items) => ({ name, kinds, items: items.map(([key, label]) => ({ key, label })) });
const DEFAULT_TEMPLATES = [
  T('Vehicle pre-trip', ['truck', 'bus'], [['brakes', 'Service brakes and parking brake hold'], ['steering', 'Steering: no excess play'], ['lights', 'Headlights, brake lights, turn signals, flashers'], ['horn', 'Horn'], ['wipers', 'Wipers and washer fluid'], ['mirrors', 'Mirrors and glass clean, not cracked'], ['tires', 'Tires: tread, pressure, damage; wheels and lug nuts'], ['leaks', 'No fuel, oil or coolant leaks under the vehicle'], ['belts', 'Seat belts'], ['safety', 'Fire extinguisher, triangles and first aid kit on board'], ['gauges', 'Gauges and warning lights normal after start']]),
  T('Groomer pre-shift', ['groomer'], [['engine', 'Engine oil and coolant level'], ['hydraulic', 'Hydraulic oil level, no leaks at hoses and fittings'], ['tracks', 'Tracks, grousers and track tension'], ['tiller', 'Tiller, comb and finisher'], ['blade', 'Blade and its pins'], ['winch', 'Winch, cable and anchor (if fitted)'], ['lights', 'Work lights and beacon'], ['cab', 'Radio, fire extinguisher and first aid kit in the cab'], ['fuel', 'Fuel for the shift'], ['warnings', 'No warning lights after start']]),
  T('Snowmobile or UTV pre-ride', ['snowmobile', 'utv'], [['throttle', 'Throttle returns freely; brake works'], ['killswitch', 'Kill switch or tether tested'], ['lights', 'Headlight, tail and brake light'], ['steering', 'Steering and skis or wheels'], ['track', 'Track or tires: damage and tension'], ['fuel', 'Fuel and oil'], ['kit', 'Rescue kit, sled or rack secured']]),
  T('Small vehicle check', ['golf_cart', 'mower', 'boat', 'loader'], [['brakes', 'Brakes'], ['steering', 'Steering'], ['tires', 'Tires or hull'], ['power', 'Battery charge or fuel'], ['lights', 'Lights and horn'], ['guards', 'Guards, covers and safety equipment']]),
  T('Facility walk-through', ['hvac', 'boiler', 'pool', 'electrical', 'kitchen', 'building', 'generator'], [['leaks', 'No visible leaks or water damage'], ['noise', 'No unusual noise, smell or vibration'], ['gauges', 'Gauges, temperatures and pressures in range'], ['guards', 'Guards, covers and panels in place'], ['fire', 'Fire extinguisher present and tagged'], ['clear', 'Area clean and access clear']]),
  T('General pre-use', [], [['condition', 'Overall condition, no damage'], ['guards', 'Guards and safety devices in place'], ['controls', 'Controls and stops work'], ['leaks', 'No leaks'], ['clean', 'Clean and ready']]),
];

/** The settings row, created on first use; also gives every untagged asset a tag (A-0001 and up), oldest first. */
async function ensureSettings(conn, tenantId) {
  await conn.query('INSERT IGNORE INTO asset_settings (tenant_id) VALUES (?)', [tenantId]);
  if (await one(conn, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND asset_tag IS NULL LIMIT 1', [tenantId])) {
    // Tag untagged assets (made in core Maintenance, or before the add-on) in one transaction, so two screens loading at once
    // cannot hand out the same number. Inside a caller's transaction, that one is used.
    const backfill = async (c) => {
      const s = await one(c, 'SELECT next_tag FROM asset_settings WHERE tenant_id = ? FOR UPDATE', [tenantId]);
      const untagged = await rows(c, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND asset_tag IS NULL ORDER BY id', [tenantId]);
      if (!untagged.length) return;
      let n = Number(s.next_tag);
      for (const a of untagged) {
        // Skip a number someone typed in by hand.
        while (await one(c, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND asset_tag = ?', [tenantId, tagOf(n)])) n += 1;
        await c.query('UPDATE ops_assets SET asset_tag = ? WHERE tenant_id = ? AND id = ? AND asset_tag IS NULL', [tagOf(n), tenantId, a.id]);
        n += 1;
      }
      await c.query('UPDATE asset_settings SET next_tag = ? WHERE tenant_id = ?', [n, tenantId]);
    };
    if (conn === pool) await tx(backfill); else await backfill(conn);
  }
  const { n: tpl } = await one(conn, 'SELECT COUNT(*) AS n FROM inspection_templates WHERE tenant_id = ?', [tenantId]);
  if (!Number(tpl)) {
    for (const t of DEFAULT_TEMPLATES) await conn.query('INSERT IGNORE INTO inspection_templates (tenant_id, name, kinds, items) VALUES (?, ?, ?, ?)', [tenantId, t.name, t.kinds.join(',') || null, JSON.stringify(t.items)]);
  }
  return one(conn, 'SELECT * FROM asset_settings WHERE tenant_id = ?', [tenantId]);
}
const tagOf = (n) => `A-${String(n).padStart(4, '0')}`;

/** The checklist that suits an asset: the first whose kinds include it, or the general one. */
function templateFor(templates, kind) {
  return templates.find((t) => t.kinds && String(t.kinds).split(',').includes(kind)) || templates.find((t) => !t.kinds) || templates[0] || null;
}

module.exports = { CATEGORIES, categoryOf, papers, bookValue, costs, lifecycle, ensureSettings, tagOf, templateFor, DEFAULT_TEMPLATES, yearsBetween, addDays, ymd };
