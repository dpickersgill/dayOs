'use strict';

// What public works costs (release 2026.11.20, workstream "money"). A municipality keeps departments (Streets, Water,
// Sewer, ...) and funds (General, Water, Sewer, Sanitation, Liquid Fuels, Capital); every work order belongs to one of
// each, and to a street when it is road work (for the Liquid Fuels report, PennDOT's MS-965). A work order's cost is:
//   labor       each person's hours at their own labor rate (staff_labor_rates), else the shop labor rate
//   equipment   each machine's hours at its hourly rate (ops_assets.hourly_rate_cents), else the suggested rate for its type
//   parts       from stock, at cost (part_moves, as before)
//   materials   one-off lines not from stock, with a quantity and unit cost (work_order_materials)
//   outside     the vendor's bill (work_orders.vendor_cost_cents, as before)
// Rates are copied onto each line when it is logged, so a later rate change keeps old costs.
//
// A work order's department, fund and street are filled in once (fillBooks), from the first of: what someone chose; the
// asset (its own department and fund, else Fleet for a vehicle, Buildings for a building system); the map item (water,
// sewer or stormwater by its system, else Streets); the resident request (by its category's words, its street); the
// street notice (by its type). The fund is the asset's own, else the department's. People can change them afterwards.
// A ski area has none of this: departments and funds are never made for it, and its work orders stay as they were.
const { rows, one } = require('../db');
const { todayIn, nowIn } = require('./util');
const { notFound, bad, conflict, forbidden } = require('./errors');
const { audit } = require('./audit');

// [name, kind]; kind marks the fund the Liquid Fuels report reads ('liquid_fuels').
const DEFAULT_FUNDS = [['General', 'general'], ['Water', 'water'], ['Sewer', 'sewer'], ['Sanitation', 'sanitation'], ['Liquid Fuels', 'liquid_fuels'], ['Capital', 'capital']];
// [name, kind, the kind of fund it charges by default]
const DEFAULT_DEPARTMENTS = [
  ['Streets', 'streets', 'general'], ['Water', 'water', 'water'], ['Sewer', 'sewer', 'sewer'], ['Stormwater', 'stormwater', 'general'],
  ['Sanitation', 'sanitation', 'sanitation'], ['Parks', 'parks', 'general'], ['Buildings', 'buildings', 'general'], ['Fleet', 'fleet', 'general'],
];
const DEPT_KINDS = DEFAULT_DEPARTMENTS.map((d) => d[1]);
const FUND_KINDS = DEFAULT_FUNDS.map((f) => f[1]);

/**
 * Suggested hourly rates for equipment with none of its own, in cents: a starting point close to published equipment
 * rate schedules for a small public works fleet (operator not included). By words in its name first, then its type.
 */
const SUGGESTED_BY_NAME = [[/jet|vac/i, 15000], [/sweeper/i, 9500], [/packer|garbage|refuse/i, 9000], [/plow|dump/i, 8500], [/backhoe|excavator/i, 8000], [/pickup|van/i, 4000], [/mower/i, 3500], [/chipper/i, 4500]];
const SUGGESTED_BY_KIND = { truck: 6500, bus: 6000, loader: 8500, mower: 3500, utv: 2500, golf_cart: 1500, boat: 3000, generator: 4000, pump: 3000, tool: 1500, snowmobile: 2500, groomer: 15000 };
function suggestedRate(a) {
  for (const [re, cents] of SUGGESTED_BY_NAME) if (re.test(a.name || '')) return cents;
  return SUGGESTED_BY_KIND[a.kind] ?? null;
}
/** The rate an hour of this asset costs a job, and whether it is the asset's own or a suggestion. */
const equipmentRate = (a) => (a.hourly_rate_cents !== null && a.hourly_rate_cents !== undefined ? { cents: Number(a.hourly_rate_cents), suggested: false } : { cents: suggestedRate(a) || 0, suggested: true });

const tzOf = async (conn, t) => (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const isMuniTenant = async (conn, t) => ((await one(conn, 'SELECT org_type FROM tenants WHERE id = ?', [t])) || {}).org_type === 'municipality';
const isManager = (req) => ['owner', 'manager'].includes(req.auth.role);

/** A municipality's departments and funds, made the first time they are needed. Nothing for a ski area. */
async function ensureBooks(conn, t) {
  if (!(await isMuniTenant(conn, t))) return false;
  const have = await one(conn, 'SELECT (SELECT COUNT(*) FROM funds WHERE tenant_id = ?) AS f, (SELECT COUNT(*) FROM departments WHERE tenant_id = ?) AS d', [t, t]);
  if (!Number(have.f)) {
    for (const [i, [name, kind]] of DEFAULT_FUNDS.entries()) await conn.query('INSERT IGNORE INTO funds (tenant_id, name, kind, sort) VALUES (?, ?, ?, ?)', [t, name, kind, (i + 1) * 10]);
  }
  if (!Number(have.d)) {
    const funds = await rows(conn, 'SELECT id, kind FROM funds WHERE tenant_id = ?', [t]);
    for (const [i, [name, kind, fundKind]] of DEFAULT_DEPARTMENTS.entries()) {
      const f = funds.find((x) => x.kind === fundKind) || funds.find((x) => x.kind === 'general') || null;
      await conn.query('INSERT IGNORE INTO departments (tenant_id, name, kind, fund_id, sort) VALUES (?, ?, ?, ?, ?)', [t, name, kind, f ? f.id : null, (i + 1) * 10]);
    }
  }
  return true;
}

async function books(conn, t) {
  const [departments, funds] = await Promise.all([
    rows(conn, 'SELECT d.id, d.name, d.kind, d.fund_id, f.name AS fund, d.active, d.sort FROM departments d LEFT JOIN funds f ON f.tenant_id = d.tenant_id AND f.id = d.fund_id WHERE d.tenant_id = ? ORDER BY d.sort, d.name', [t]),
    rows(conn, 'SELECT id, name, code, kind, active, sort FROM funds WHERE tenant_id = ? ORDER BY sort, name', [t]),
  ]);
  const b = (x) => ({ ...x, id: Number(x.id), active: Boolean(x.active), ...(x.fund_id !== undefined ? { fund_id: x.fund_id === null ? null : Number(x.fund_id) } : {}) });
  return { departments: departments.map(b), funds: funds.map(b) };
}

// ---------------------------------------------------------------- filling in a work order's department, fund and street
/** The department kind a map item's system belongs to. */
function deptKindOfFeature(kind) {
  const MF = require('./mapfeatures');
  const k = MF.kindOf(kind);
  if (!k) return null;
  const sys = MF.systemFor(k, 'municipality');
  if (sys === 'potable') return 'water';
  if (sys === 'sewer') return 'sewer';
  if (sys === 'storm' || sys === 'drainage') return 'stormwater';
  return 'streets';
}
/** The department kind a request category's name suggests (the default categories and anything worded like them). */
function deptKindOfWords(text) {
  const s = String(text || '').toLowerCase();
  if (/\b(sewer|sanitary|manhole)/.test(s)) return 'sewer';
  if (/\b(storm|drain|flood|inlet|outfall)/.test(s)) return 'stormwater';
  if (/\b(water|hydrant|leak|pressure|main break)/.test(s)) return 'water';
  if (/\b(trash|recycl|bulk|garbage|refuse|leaf|leaves|brush|yard waste)/.test(s)) return 'sanitation';
  if (/\b(parks?|playground|field|trees?|branch)\b/.test(s)) return 'parks';
  return 'streets';
}
const NOTICE_KIND = { water_outage: 'water', boil_water: 'water', sewer: 'sewer', trash_change: 'sanitation', leaf_collection: 'sanitation' };
/** The street a free-text place names: the longest street name or alias found in it, as whole words. */
function streetIn(text, streets) {
  const s = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')} `;
  let best = null; let len = 0;
  for (const st of streets) {
    for (const name of [st.name, ...String(st.aliases || '').split(',')].map((x) => x.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ')).filter(Boolean)) {
      if (name.length > len && s.includes(` ${name} `)) { best = Number(st.id); len = name.length; }
    }
  }
  return best;
}

/**
 * Fills in the department, fund and street of a municipality's work orders that have not been filled in yet (every way
 * a work order is made: by hand, from a request, a program, an inspection, a notice). Once per work order: what is set
 * stays, and a person's change afterwards is never undone. Returns how many were filled.
 */
async function fillBooks(conn, t, { ids = null } = {}) {
  if (!(await ensureBooks(conn, t))) return 0;
  const list = await rows(conn, `SELECT w.id, w.department_id, w.fund_id, w.street_id, w.location, w.title, w.source,
      a.department_id AS a_dept, a.fund_id AS a_fund, a.category AS a_cat, mf.kind AS f_kind,
      rq.street_id AS r_street, rc.name AS r_cat, (SELECT n.type FROM street_notices n WHERE n.tenant_id = w.tenant_id AND n.work_order_id = w.id LIMIT 1) AS n_type
    FROM work_orders w
    LEFT JOIN ops_assets a ON a.tenant_id = w.tenant_id AND a.id = w.asset_id
    LEFT JOIN map_features mf ON mf.tenant_id = w.tenant_id AND mf.id = w.map_feature_id
    LEFT JOIN requests rq ON rq.tenant_id = w.tenant_id AND rq.id = w.request_id
    LEFT JOIN request_categories rc ON rc.tenant_id = rq.tenant_id AND rc.id = rq.category_id
    WHERE w.tenant_id = ? AND w.books_checked = 0 ${ids ? 'AND w.id IN (?)' : ''} ORDER BY w.id LIMIT 2000`, ids ? [t, ids] : [t]);
  if (!list.length) return 0;
  const { departments } = await books(conn, t);
  const deptByKind = new Map(departments.filter((d) => d.active && d.kind).map((d) => [d.kind, d]));
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const streets = await rows(conn, 'SELECT id, name, aliases FROM streets WHERE tenant_id = ?', [t]);
  for (const w of list) {
    let dept = w.department_id ? deptById.get(Number(w.department_id)) : null;
    if (!dept && w.a_dept) dept = deptById.get(Number(w.a_dept));
    if (!dept) {
      let kind = null;
      if (w.a_cat) kind = w.a_cat === 'facility' ? 'buildings' : ['fleet', 'equipment'].includes(w.a_cat) ? 'fleet' : null;
      if (!kind && w.f_kind) kind = deptKindOfFeature(w.f_kind);
      if (!kind && w.r_cat) kind = deptKindOfWords(w.r_cat);
      if (!kind && w.n_type) kind = NOTICE_KIND[w.n_type] || 'streets';
      if (!kind) kind = deptKindOfWords(`${w.title} ${w.location || ''}`);
      dept = deptByKind.get(kind) || null;
    }
    const fund = w.fund_id || w.a_fund || (dept ? dept.fund_id : null) || null;
    const street = w.street_id || w.r_street || streetIn(`${w.location || ''}`, streets) || streetIn(w.title, streets) || null;
    await conn.query('UPDATE work_orders SET department_id = COALESCE(department_id, ?), fund_id = COALESCE(fund_id, ?), street_id = COALESCE(street_id, ?), books_checked = 1 WHERE tenant_id = ? AND id = ?',
      [dept ? dept.id : null, fund, street, t, w.id]);
  }
  return list.length;
}

// ---------------------------------------------------------------- what a work order's costs are
async function orderFor(conn, t, id) {
  const w = await one(conn, 'SELECT id, asset_id, status FROM work_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
  if (!w) throw notFound('Work order');
  return w;
}
const sameDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

/** A crew member's labor rate (cents an hour) and whether it is their own: their own rate, else the shop labor rate. */
async function laborRate(conn, t, staffId) {
  if (staffId) {
    const r = await one(conn, 'SELECT rate_cents FROM staff_labor_rates WHERE tenant_id = ? AND staff_id = ?', [t, staffId]);
    if (r) return { cents: Number(r.rate_cents), personal: true };
  }
  const A = require('./assets');
  const s = await A.ensureSettings(conn, t);
  return { cents: Number(s.labor_rate_cents), personal: false };
}

const recountHours = (conn, t, id) => conn.query('UPDATE work_orders SET labor_hours = (SELECT SUM(hours) FROM work_order_labor WHERE tenant_id = ? AND work_order_id = ?) WHERE tenant_id = ? AND id = ?', [t, id, t, id]);

/** Hours by one person (staff_id) or a named helper (worker). Inside the caller's transaction. */
async function addLabor(conn, req, id, b) {
  const t = req.auth.tenantId;
  if ((await orderFor(conn, t, id)).status === 'cancelled') throw conflict('This work order was canceled');
  if (b.staff_id && !(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, b.staff_id]))) throw notFound('Staff member');
  const rate = await laborRate(conn, t, b.staff_id);
  const [r] = await conn.query('INSERT INTO work_order_labor (tenant_id, work_order_id, staff_id, worker, hours, rate_cents, personal, worked_on, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [t, id, b.staff_id ?? null, b.worker ?? null, b.hours, rate.cents, rate.personal ? 1 : 0, b.worked_on || todayIn(await tzOf(conn, t)), b.note ?? null, req.auth.userId]);
  await recountHours(conn, t, id);
  return Number(r.insertId);
}

/** Equipment hours on a job, at the asset's rate now. */
async function addEquipment(conn, req, id, b) {
  const t = req.auth.tenantId;
  if ((await orderFor(conn, t, id)).status === 'cancelled') throw conflict('This work order was canceled');
  const a = await one(conn, 'SELECT id, name, kind, hourly_rate_cents FROM ops_assets WHERE tenant_id = ? AND id = ?', [t, b.asset_id]);
  if (!a) throw notFound('Equipment');
  const [r] = await conn.query('INSERT INTO work_order_equipment (tenant_id, work_order_id, asset_id, hours, rate_cents, used_on, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [t, id, a.id, b.hours, equipmentRate(a).cents, b.used_on || todayIn(await tzOf(conn, t)), b.note ?? null, req.auth.userId]);
  return Number(r.insertId);
}

/** A one-off material not kept in stock: what, how many, unit, unit cost. */
async function addMaterial(conn, req, id, b) {
  const t = req.auth.tenantId;
  if ((await orderFor(conn, t, id)).status === 'cancelled') throw conflict('This work order was canceled');
  const [r] = await conn.query('INSERT INTO work_order_materials (tenant_id, work_order_id, description, qty, unit, unit_cost_cents, used_on, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [t, id, b.description, b.qty, b.unit ?? null, b.unit_cost_cents ?? 0, b.used_on || todayIn(await tzOf(conn, t)), req.auth.userId]);
  return Number(r.insertId);
}

/**
 * Parts taken from stock for a work order, at today's cost, charged to its asset. A negative qty returns parts, credited
 * at what they cost when issued. Returns still work on a canceled order, so parts never get stuck on it.
 */
async function issuePart(conn, req, id, b) {
  const t = req.auth.tenantId;
  const w = await orderFor(conn, t, id);
  if (w.status === 'cancelled' && b.qty > 0) throw conflict('This work order was canceled');
  const p = await one(conn, 'SELECT id, name, qty_on_hand, unit_cost_cents, unit FROM parts WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, b.part_id]);
  if (!p) throw notFound('Part');
  if (b.qty > 0 && Number(p.qty_on_hand) < b.qty) throw bad(`Only ${Number(p.qty_on_hand)} ${p.unit} of ${p.name} on hand`);
  let cost = p.unit_cost_cents;
  if (b.qty < 0) {
    const used = await one(conn, "SELECT COALESCE(SUM(-qty), 0) AS n, SUM(-qty * unit_cost_cents) AS c FROM part_moves WHERE tenant_id = ? AND work_order_id = ? AND part_id = ? AND kind IN ('issue','return')", [t, id, p.id]);
    if (-b.qty > Number(used.n)) throw bad(`Only ${Number(used.n)} ${p.unit} were used on this work order`);
    cost = Math.round(Number(used.c) / Number(used.n));
  }
  await conn.query('UPDATE parts SET qty_on_hand = qty_on_hand - ? WHERE tenant_id = ? AND id = ?', [b.qty, t, p.id]);
  await conn.query('INSERT INTO part_moves (tenant_id, part_id, kind, qty, unit_cost_cents, work_order_id, asset_id, note, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [t, p.id, b.qty > 0 ? 'issue' : 'return', -b.qty, cost, id, w.asset_id, b.note ?? null, req.auth.userId, nowIn(await tzOf(conn, t))]);
}

/** Removes a line someone logged: the person who logged it, or a manager. table: labor, equipment or materials. */
async function removeLine(conn, req, id, table, rowId) {
  const t = req.auth.tenantId;
  const name = { labor: 'work_order_labor', equipment: 'work_order_equipment', materials: 'work_order_materials' }[table];
  const row = await one(conn, `SELECT user_id FROM ${name} WHERE tenant_id = ? AND work_order_id = ? AND id = ?`, [t, id, rowId]);
  if (!row) throw notFound('That line');
  if (row.user_id !== req.auth.userId && !isManager(req)) throw forbidden('Only the person who logged it, or a manager, can remove it');
  await conn.query(`DELETE FROM ${name} WHERE tenant_id = ? AND id = ?`, [t, rowId]);
  if (table === 'labor') await recountHours(conn, t, id);
  await audit(conn, req, `remove_${table}`, 'work_orders', id, { row: rowId });
}

/** Each work order's cost by kind, in cents, and its hours: Map id -> { labor_cents, labor_hours, equipment_cents, ... }. */
async function orderCosts(conn, t, ids) {
  const out = new Map(ids.map((id) => [Number(id), { labor_cents: 0, labor_hours: 0, equipment_cents: 0, equipment_hours: 0, parts_cents: 0, materials_cents: 0, vendor_cents: 0, total_cents: 0 }]));
  if (!ids.length) return out;
  const [labor, equip, parts, mats, vendor] = await Promise.all([
    rows(conn, 'SELECT work_order_id AS id, SUM(ROUND(hours * rate_cents)) AS c, SUM(hours) AS h FROM work_order_labor WHERE tenant_id = ? AND work_order_id IN (?) GROUP BY work_order_id', [t, ids]),
    rows(conn, 'SELECT work_order_id AS id, SUM(ROUND(hours * rate_cents)) AS c, SUM(hours) AS h FROM work_order_equipment WHERE tenant_id = ? AND work_order_id IN (?) GROUP BY work_order_id', [t, ids]),
    rows(conn, "SELECT work_order_id AS id, SUM(ROUND(-qty * unit_cost_cents)) AS c FROM part_moves WHERE tenant_id = ? AND work_order_id IN (?) AND kind IN ('issue','return') GROUP BY work_order_id", [t, ids]),
    rows(conn, 'SELECT work_order_id AS id, SUM(ROUND(qty * unit_cost_cents)) AS c FROM work_order_materials WHERE tenant_id = ? AND work_order_id IN (?) GROUP BY work_order_id', [t, ids]),
    rows(conn, 'SELECT id, vendor_cost_cents AS c FROM work_orders WHERE tenant_id = ? AND id IN (?) AND vendor_cost_cents IS NOT NULL', [t, ids]),
  ]);
  const put = (list, key, hoursKey) => { for (const r of list) { const o = out.get(Number(r.id)); if (!o) continue; o[key] = Math.round(Number(r.c || 0)); if (hoursKey) o[hoursKey] = Number(r.h || 0); } };
  put(labor, 'labor_cents', 'labor_hours'); put(equip, 'equipment_cents', 'equipment_hours'); put(parts, 'parts_cents'); put(mats, 'materials_cents'); put(vendor, 'vendor_cents');
  for (const o of out.values()) o.total_cents = o.labor_cents + o.equipment_cents + o.parts_cents + o.materials_cents + o.vendor_cents;
  return out;
}

/**
 * Every cost line dated from..to (YYYY-MM-DD, both days in), each with the work order it is on: labor by the day worked,
 * equipment and materials by the day used, parts by the day issued, outside work by the day the work order was completed.
 * [{ work_order_id, kind, day, hours, cents, asset_id (equipment) }]
 */
async function costLines(conn, t, from, to) {
  const [labor, equip, parts, mats, vendor] = await Promise.all([
    rows(conn, "SELECT work_order_id, 'labor' AS kind, worked_on AS day, hours, ROUND(hours * rate_cents) AS cents, NULL AS asset_id FROM work_order_labor WHERE tenant_id = ? AND worked_on BETWEEN ? AND ?", [t, from, to]),
    rows(conn, "SELECT work_order_id, 'equipment' AS kind, used_on AS day, hours, ROUND(hours * rate_cents) AS cents, asset_id FROM work_order_equipment WHERE tenant_id = ? AND used_on BETWEEN ? AND ?", [t, from, to]),
    rows(conn, "SELECT work_order_id, 'parts' AS kind, at AS day, 0 AS hours, ROUND(-qty * unit_cost_cents) AS cents, NULL AS asset_id FROM part_moves WHERE tenant_id = ? AND work_order_id IS NOT NULL AND kind IN ('issue','return') AND at BETWEEN ? AND ?", [t, `${from} 00:00:00`, `${to} 23:59:59`]),
    rows(conn, "SELECT work_order_id, 'materials' AS kind, used_on AS day, 0 AS hours, ROUND(qty * unit_cost_cents) AS cents, NULL AS asset_id FROM work_order_materials WHERE tenant_id = ? AND used_on BETWEEN ? AND ?", [t, from, to]),
    rows(conn, "SELECT id AS work_order_id, 'outside' AS kind, completed_at AS day, 0 AS hours, vendor_cost_cents AS cents, NULL AS asset_id FROM work_orders WHERE tenant_id = ? AND status = 'done' AND vendor_cost_cents IS NOT NULL AND completed_at BETWEEN ? AND ?", [t, `${from} 00:00:00`, `${to} 23:59:59`]),
  ]);
  return [...labor, ...equip, ...parts, ...mats, ...vendor].map((l) => ({ work_order_id: Number(l.work_order_id), kind: l.kind, day: sameDay(l.day), hours: Number(l.hours || 0), cents: Math.round(Number(l.cents || 0)), asset_id: l.asset_id ? Number(l.asset_id) : null }));
}

/** What kind of job a work order is, for the report: the request's category, else where it came from. */
function categoryOf(w) {
  if (w.request_category) return w.request_category;
  if (w.source === 'preventive') return 'Service plans';
  if (w.source === 'program') return 'Programs';
  if (w.source === 'inspection') return 'Failed inspections';
  if (w.source === 'notice') return 'Street notices';
  if (w.feature_kind_label) return w.feature_kind_label;
  if (w.asset_category) return ['fleet', 'equipment'].includes(w.asset_category) ? 'Vehicle and equipment repair' : w.asset_category === 'facility' ? 'Building repair' : 'Equipment repair';
  return 'Other work';
}

module.exports = {
  DEFAULT_FUNDS, DEFAULT_DEPARTMENTS, DEPT_KINDS, FUND_KINDS, suggestedRate, equipmentRate, ensureBooks, books, fillBooks,
  deptKindOfFeature, deptKindOfWords, streetIn, laborRate, addLabor, addEquipment, addMaterial, issuePart, removeLine,
  orderCosts, costLines, categoryOf, isMuniTenant, sameDay,
};
