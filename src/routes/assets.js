'use strict';

// Assets and fleet (a paid add-on, `assets`): the asset register for fleet, lifts, snowmaking and facilities; meter and
// fuel logs; inspections from checklists; parts, stock and purchase orders; labor and outside costs on work orders; and
// the lifecycle numbers. Work orders and service plans themselves live in the Maintenance part of Lifts and trails
// (routes/maintenance.js); this adds what an asset manager needs around them.
//
// Staff and managers read and log (meters, fuel, inspections, parts issued, labor). Managers change money: purchase
// prices, the labor rate, vendors and purchase orders. Patrol does not use this app.
const express = require('express');
const CR = require('../lib/checkrules');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, dateTimeStr, validate, paramId, normDateTime, setClause, todayIn, nowIn, dayRange, localDay } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const O = require('../lib/ops');
const A = require('../lib/assets');
const maintenance = require('./maintenance');

const router = express.Router();
const crew = requireRole('staff', 'manager');
const manager = requireRole('manager');
router.use(crew);
// The asset map: points, lines and areas for what lies where (routes/assetmap.js).
router.use('/map', require('./assetmap'));

const tzOf = async (conn, tenantId) => (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const nullable = (s) => s.nullable().optional();
const first = (v) => String(Array.isArray(v) ? v[0] : v);
const money = z.number().int().min(0).max(100000000000);
const isManager = (req) => ['owner', 'manager'].includes(req.auth.role);
// Stock is kept to 2 decimal places; a finer quantity would round in the count but not in its history.
const qty2 = (schema) => schema.refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Up to 2 decimal places');
// Asset prices are a manager's business; the crew sees everything else.
const hidePrices = (req, a) => (isManager(req) ? a : { ...a, purchase_cents: undefined, salvage_cents: undefined });
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function mustExist(conn, table, tenantId, id, what) {
  if (id && !(await one(conn, `SELECT id FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [tenantId, id]))) throw notFound(what);
}

router.get('/meta', async (req, res) => {
  await A.ensureSettings(pool, req.auth.tenantId);
  const templates = await rows(pool, 'SELECT id, name, kinds, items, active FROM inspection_templates WHERE tenant_id = ? ORDER BY name', [req.auth.tenantId]);
  res.json({
    kinds: O.ASSET_KINDS, categories: A.CATEGORIES,
    fuel_types: ['diesel', 'gasoline', 'propane', 'electric', 'other', 'none'],
    templates: templates.map((t) => ({ ...t, kinds: t.kinds ? t.kinds.split(',') : [], items: JSON.parse(t.items) })),
    can_manage: isManager(req),
  });
});

// ---------------------------------------------------------------- settings
router.get('/settings', async (req, res) => res.json(await A.ensureSettings(pool, req.auth.tenantId)));
router.put('/settings', manager, validate(z.object({ labor_rate_cents: money.max(1000000).optional(), replace_pct: z.number().int().min(5).max(200).optional(), expiry_warn_days: z.number().int().min(1).max(365).optional() })), async (req, res) => {
  await A.ensureSettings(pool, req.auth.tenantId);
  const set = setClause(req.body, ['labor_rate_cents', 'replace_pct', 'expiry_warn_days']);
  if (!set) throw bad('Nothing to change');
  await pool.query(`UPDATE asset_settings SET ${set.sql} WHERE tenant_id = ?`, [...set.values, req.auth.tenantId]);
  await audit(pool, req, 'settings', 'asset_settings', req.auth.tenantId, req.body);
  res.json(await A.ensureSettings(pool, req.auth.tenantId));
});

// ---------------------------------------------------------------- locations
const locFields = { name: z.string().trim().min(1).max(100), kind: z.enum(['building', 'shop', 'yard', 'lift', 'storage', 'area', 'other']).default('area'), parent_id: nullable(z.number().int().positive()), notes: nullable(z.string().max(255)), active: z.boolean().optional() };
router.get('/locations', async (req, res) => {
  res.json({ data: await rows(pool, `SELECT l.*, p.name AS parent, (SELECT COUNT(*) FROM ops_assets a WHERE a.tenant_id = l.tenant_id AND a.location_id = l.id AND a.status <> 'retired') AS assets
    FROM asset_locations l LEFT JOIN asset_locations p ON p.tenant_id = l.tenant_id AND p.id = l.parent_id WHERE l.tenant_id = ? ORDER BY l.name`, [req.auth.tenantId]) });
});
router.post('/locations', validate(z.object(locFields)), async (req, res) => {
  const b = req.body;
  await mustExist(pool, 'asset_locations', req.auth.tenantId, b.parent_id, 'Location');
  try {
    const [r] = await pool.query('INSERT INTO asset_locations (tenant_id, name, kind, parent_id, notes) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, b.name, b.kind, b.parent_id ?? null, b.notes ?? null]);
    res.status(201).json({ id: r.insertId });
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a location with that name'); throw err; }
});
router.patch('/locations/:id', validate(partialOf(locFields)), async (req, res) => {
  const id = paramId(req);
  await mustExist(pool, 'asset_locations', req.auth.tenantId, req.body.parent_id, 'Location');
  // Not inside itself, directly or further down (A in B in A).
  for (let p = req.body.parent_id, n = 0; p && n < 20; n += 1) {
    if (p === id) throw bad('A location cannot be inside itself');
    p = (await one(pool, 'SELECT parent_id FROM asset_locations WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, p]) || {}).parent_id;
  }
  const set = setClause(req.body, Object.keys(locFields));
  if (!set) throw bad('Nothing to change');
  try {
    const [r] = await pool.query(`UPDATE asset_locations SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    if (!r.affectedRows) throw notFound('Location');
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a location with that name'); throw err; }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- vendors (managers)
const vendorFields = { name: z.string().trim().min(1).max(150), contact: nullable(z.string().max(150)), phone: nullable(z.string().max(40)), email: nullable(z.string().email().max(255)), account_no: nullable(z.string().max(60)), notes: nullable(z.string().max(500)), active: z.boolean().optional() };
router.get('/vendors', async (req, res) => {
  const data = await rows(pool, 'SELECT * FROM vendors WHERE tenant_id = ? ORDER BY active DESC, name', [req.auth.tenantId]);
  res.json({ data: isManager(req) ? data : data.map((v) => ({ ...v, account_no: undefined })) });
});
router.post('/vendors', manager, validate(z.object(vendorFields)), async (req, res) => {
  const b = req.body;
  try {
    const [r] = await pool.query('INSERT INTO vendors (tenant_id, name, contact, phone, email, account_no, notes) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, b.name, b.contact ?? null, b.phone ?? null, b.email ?? null, b.account_no ?? null, b.notes ?? null]);
    await audit(pool, req, 'create', 'vendors', r.insertId);
    res.status(201).json({ id: r.insertId });
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a vendor with that name'); throw err; }
});
router.patch('/vendors/:id', manager, validate(partialOf(vendorFields)), async (req, res) => {
  const set = setClause(req.body, Object.keys(vendorFields));
  if (!set) throw bad('Nothing to change');
  try {
    const [r] = await pool.query(`UPDATE vendors SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
    if (!r.affectedRows) throw notFound('Vendor');
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a vendor with that name'); throw err; }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the register
const date = nullable(dateStr);
const assetFields = {
  name: z.string().trim().min(1).max(100),
  kind: z.string().refine((k) => O.ASSET_KIND_KEYS.includes(k), 'Unknown type'),
  asset_tag: nullable(z.string().trim().regex(/^[A-Za-z0-9-]{1,20}$/, 'Letters, numbers and dashes, up to 20')),
  make_model: nullable(z.string().max(100)), serial: nullable(z.string().max(80)),
  status: z.enum(['in_service', 'needs_service', 'out_of_service', 'retired']).optional(),
  notes: nullable(z.string().max(500)),
  parent_id: nullable(z.number().int().positive()), location_id: nullable(z.number().int().positive()), lift_id: nullable(z.number().int().positive()),
  model_year: nullable(z.number().int().min(1900).max(2100)), vin: nullable(z.string().max(40)), plate: nullable(z.string().max(20)),
  fuel_type: nullable(z.enum(['diesel', 'gasoline', 'propane', 'electric', 'other', 'none'])),
  purchased_on: date, purchase_cents: nullable(money), vendor_id: nullable(z.number().int().positive()),
  useful_life_years: nullable(z.number().int().min(1).max(100)), salvage_cents: nullable(money),
  warranty_expires: date, warranty_note: nullable(z.string().max(255)),
  registration_expires: date, insurance_expires: date, inspection_expires: date,
  critical: z.boolean().transform((v) => (v ? 1 : 0)).optional(),
  hours: z.number().min(0).max(9999999).optional(), miles: z.number().min(0).max(99999999).optional(),
};
const COLS = Object.keys(assetFields).filter((k) => !['hours', 'miles'].includes(k));
const MONEY_COLS = ['purchase_cents', 'salvage_cents', 'useful_life_years'];

async function checkLinks(conn, req, b, selfId) {
  const t = req.auth.tenantId;
  await mustExist(conn, 'asset_locations', t, b.location_id, 'Location');
  await mustExist(conn, 'lifts', t, b.lift_id, 'Lift');
  await mustExist(conn, 'vendors', t, b.vendor_id, 'Vendor');
  if (b.parent_id) {
    await mustExist(conn, 'ops_assets', t, b.parent_id, 'Parent asset');
    // A part cannot sit inside itself, directly or further down.
    for (let p = b.parent_id, n = 0; p && n < 20; n += 1) {
      if (p === selfId) throw bad('An asset cannot be a part of itself');
      p = (await one(conn, 'SELECT parent_id FROM ops_assets WHERE tenant_id = ? AND id = ?', [t, p]) || {}).parent_id;
    }
  }
  if (!isManager(req) && MONEY_COLS.some((k) => b[k] !== undefined)) throw forbidden('Only a manager changes purchase cost, salvage value and useful life');
}

const LIST_SQL = `SELECT a.*, loc.name AS location, par.name AS parent, par.asset_tag AS parent_tag, l.name AS lift, v.name AS vendor,
    (SELECT COUNT(*) FROM work_orders w WHERE w.tenant_id = a.tenant_id AND w.asset_id = a.id AND w.status NOT IN ('done','cancelled')) AS open_orders,
    (SELECT MAX(i.done_at) FROM asset_inspections i WHERE i.tenant_id = a.tenant_id AND i.asset_id = a.id) AS last_inspected
  FROM ops_assets a
  LEFT JOIN asset_locations loc ON loc.tenant_id = a.tenant_id AND loc.id = a.location_id
  LEFT JOIN ops_assets par ON par.tenant_id = a.tenant_id AND par.id = a.parent_id
  LEFT JOIN lifts l ON l.tenant_id = a.tenant_id AND l.id = a.lift_id
  LEFT JOIN vendors v ON v.tenant_id = a.tenant_id AND v.id = a.vendor_id`;

/** Service plans with their state, for a set of assets (or all). */
async function plans(conn, tenantId, today, assetId) {
  const list = await rows(conn, `SELECT t.*, a.name AS asset, a.asset_tag, a.hours AS asset_hours, a.miles AS asset_miles, l.name AS lift,
      (SELECT w.id FROM work_orders w WHERE w.tenant_id = t.tenant_id AND w.pm_task_id = t.id AND w.status NOT IN ('done','cancelled') LIMIT 1) AS open_order_id
    FROM pm_tasks t LEFT JOIN ops_assets a ON a.tenant_id = t.tenant_id AND a.id = t.asset_id LEFT JOIN lifts l ON l.tenant_id = t.tenant_id AND l.id = t.lift_id
    WHERE t.tenant_id = ? AND t.active = 1 ${assetId ? 'AND t.asset_id = ?' : ''}`, assetId ? [tenantId, assetId] : [tenantId]);
  return list.map((t) => ({ ...t, last_done_on: A.ymd(t.last_done_on), ...O.pmStatus(t, t.asset_id ? { hours: num(t.asset_hours), miles: num(t.asset_miles) } : null, today) }));
}
const RANK = { overdue: 0, soon: 1, never: 2, ok: 3 };

function shape(a, today, warn) {
  const out = { ...a, category: A.categoryOf(a), hours: Number(a.hours), miles: num(a.miles), open_orders: Number(a.open_orders || 0) };
  for (const k of ['purchased_on', 'warranty_expires', 'registration_expires', 'insurance_expires', 'inspection_expires', 'retired_on']) out[k] = A.ymd(a[k]);
  out.papers = A.papers(out, today, warn);
  return out;
}

router.get('/register', async (req, res) => {
  const t = req.auth.tenantId;
  const settings = await A.ensureSettings(pool, t);
  const today = todayIn(await tzOf(pool, t));
  const where = ['a.tenant_id = ?']; const params = [t];
  if (req.query.status) { where.push('a.status = ?'); params.push(first(req.query.status)); } else if (req.query.all !== '1') where.push("a.status <> 'retired'");
  if (req.query.location_id) { where.push('a.location_id = ?'); params.push(Number(first(req.query.location_id))); }
  if (req.query.q) { const q = `%${first(req.query.q).slice(0, 60)}%`; where.push('(a.name LIKE ? OR a.asset_tag LIKE ? OR a.make_model LIKE ? OR a.serial LIKE ? OR a.vin LIKE ? OR a.plate LIKE ?)'); params.push(q, q, q, q, q, q); }
  let data = (await rows(pool, `${LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY a.name`, params)).map((a) => shape(a, today, settings.expiry_warn_days));
  if (req.query.category) data = data.filter((a) => a.category === first(req.query.category));
  const pm = await plans(pool, t, today);
  for (const a of data) {
    const mine = pm.filter((p) => p.asset_id === a.id).sort((x, y) => RANK[x.state] - RANK[y.state]);
    a.service = mine.length ? { state: mine[0].state, name: mine[0].name, count: mine.length } : null;
  }
  res.json({ data: data.map((a) => hidePrices(req, a)) });
});

router.get('/tag/:tag', async (req, res) => {
  const a = await one(pool, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND asset_tag = ?', [req.auth.tenantId, String(req.params.tag).slice(0, 20)]);
  if (!a) throw notFound('Asset');
  res.json({ id: a.id });
});

router.get('/register/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const settings = await A.ensureSettings(pool, t);
  const tz = await tzOf(pool, t);
  const today = todayIn(tz);
  const raw = await one(pool, `${LIST_SQL} WHERE a.tenant_id = ? AND a.id = ?`, [t, id]);
  if (!raw) throw notFound('Asset');
  const a = shape(raw, today, settings.expiry_warn_days);
  const since = A.addDays(today, -365);
  const [children, meters, fuel, orders, inspections, partsUsed, costMap, pm] = await Promise.all([
    rows(pool, 'SELECT id, name, asset_tag, kind, status FROM ops_assets WHERE tenant_id = ? AND parent_id = ? ORDER BY name', [t, id]),
    rows(pool, 'SELECT id, meter, value, read_at, source FROM asset_meters WHERE tenant_id = ? AND asset_id = ? ORDER BY read_at DESC, id DESC LIMIT 30', [t, id]),
    rows(pool, 'SELECT f.*, v.name AS vendor FROM asset_fuel f LEFT JOIN vendors v ON v.tenant_id = f.tenant_id AND v.id = f.vendor_id WHERE f.tenant_id = ? AND f.asset_id = ? ORDER BY f.filled_at DESC, f.id DESC LIMIT 30', [t, id]),
    rows(pool, `SELECT w.id, w.title, w.status, w.priority, w.source, w.opened_at, w.completed_at, w.resolution, w.vendor_cost_cents, w.meter_hours, w.meter_miles,
        COALESCE((SELECT SUM(l.hours * l.rate_cents) FROM work_order_labor l WHERE l.tenant_id = w.tenant_id AND l.work_order_id = w.id), 0) AS labor_cents,
        COALESCE((SELECT SUM(-m.qty * m.unit_cost_cents) FROM part_moves m WHERE m.tenant_id = w.tenant_id AND m.work_order_id = w.id AND m.kind IN ('issue','return')), 0) AS parts_cents
      FROM work_orders w WHERE w.tenant_id = ? AND w.asset_id = ? ORDER BY w.opened_at DESC, w.id DESC LIMIT 60`, [t, id]),
    rows(pool, 'SELECT id, template_name, result, inspector, done_at, work_order_id, hours, miles, items, note FROM asset_inspections WHERE tenant_id = ? AND asset_id = ? ORDER BY done_at DESC, id DESC LIMIT 20', [t, id]),
    rows(pool, `SELECT m.at, m.kind, m.qty, m.unit_cost_cents, m.work_order_id, p.sku, p.name, p.unit FROM part_moves m JOIN parts p ON p.tenant_id = m.tenant_id AND p.id = m.part_id
      WHERE m.tenant_id = ? AND m.asset_id = ? AND m.kind IN ('issue','return') ORDER BY m.at DESC, m.id DESC LIMIT 50`, [t, id]),
    A.costs(pool, t, [id], since),
    plans(pool, t, today, id),
  ]);
  const c = costMap.get(id);
  const see = isManager(req);
  const onMap = await one(pool, 'SELECT COUNT(*) AS n FROM map_features WHERE tenant_id = ? AND asset_id = ?', [t, id]);
  res.json({
    ...a,
    on_map: Number(onMap.n),
    ...(see ? {} : { purchase_cents: undefined, salvage_cents: undefined }),
    children, meters, fuel: fuel.map((f) => ({ ...f, gallons: Number(f.gallons) })),
    // opened_at is UTC; the day it was opened is given on the mountain's clock.
    work_orders: orders.map((w) => ({ ...w, opened_on: localDay(w.opened_at, tz), labor_cents: Math.round(Number(w.labor_cents)), parts_cents: Math.round(Number(w.parts_cents)) })),
    inspections: inspections.map((i) => ({ ...i, items: JSON.parse(i.items) })),
    parts_used: partsUsed.map((p) => ({ ...p, qty: -Number(p.qty) })),
    service: pm.sort((x, y) => RANK[x.state] - RANK[y.state]),
    costs: c, lifecycle: { ...A.lifecycle(a, c, today, settings.replace_pct), ...(see ? {} : { book_value_cents: undefined }) },
  });
});

router.post('/register', validate(z.object(assetFields)), async (req, res) => {
  const t = req.auth.tenantId;
  const id = await tx(async (conn) => {
    const b = { ...req.body };
    await checkLinks(conn, req, b, null);
    const s = await A.ensureSettings(conn, t);
    if (!b.asset_tag) {
      const row = await one(conn, 'SELECT next_tag FROM asset_settings WHERE tenant_id = ? FOR UPDATE', [t]);
      let n = Number(row.next_tag || s.next_tag);
      while (await one(conn, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND asset_tag = ?', [t, A.tagOf(n)])) n += 1;
      b.asset_tag = A.tagOf(n);
      await conn.query('UPDATE asset_settings SET next_tag = ? WHERE tenant_id = ?', [n + 1, t]);
    }
    b.category = O.CATEGORY_OF[b.kind] || 'other';
    const keys = [...COLS.filter((k) => b[k] !== undefined), 'category', ...['hours', 'miles'].filter((k) => b[k] !== undefined)];
    let r;
    try {
      [r] = await conn.query(`INSERT INTO ops_assets (tenant_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, [t, ...keys.map((k) => b[k])]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict(String(err.message).includes('tag') ? 'That tag is already on another asset' : 'There is already an asset with that name');
      throw err;
    }
    const now = nowIn(await tzOf(conn, t));
    for (const m of ['hours', 'miles']) if (b[m]) await conn.query('INSERT INTO asset_meters (tenant_id, asset_id, meter, value, read_at, source, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, r.insertId, m, b[m], now, 'manual', req.auth.userId]);
    await audit(conn, req, 'create', 'ops_assets', r.insertId, { tag: b.asset_tag });
    return r.insertId;
  });
  res.status(201).json({ id });
});

router.patch('/register/:id', validate(partialOf(assetFields)), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM ops_assets WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur) throw notFound('Asset');
    const b = { ...req.body };
    await checkLinks(conn, req, b, id);
    if (b.kind) b.category = O.CATEGORY_OF[b.kind] || 'other';
    if (b.status === 'retired' && cur.status !== 'retired') b.retired_on = todayIn(await tzOf(conn, t));
    if (b.status && b.status !== 'retired') b.retired_on = null;
    // Meters move only through readings, so they keep a history.
    delete b.hours; delete b.miles;
    const set = setClause(b, [...COLS, 'category', 'retired_on']);
    if (!set) throw bad('Nothing to change');
    try { await conn.query(`UPDATE ops_assets SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, t, id]); } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict(String(err.message).includes('tag') ? 'That tag is already on another asset' : 'There is already an asset with that name');
      throw err;
    }
    await audit(conn, req, 'update', 'ops_assets', id, Object.keys(req.body));
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- meters and fuel
/**
 * Records a meter reading and moves the asset's meter. A meter only goes up; a manager can correct one down with
 * `correct: true` (logged), for a replaced hour meter or a typing mistake.
 */
async function recordMeter(conn, req, assetId, meter, value, source, at, { correct = false } = {}) {
  const a = await one(conn, `SELECT ${meter} AS cur FROM ops_assets WHERE tenant_id = ? AND id = ? FOR UPDATE`, [req.auth.tenantId, assetId]);
  if (!a) throw notFound('Asset');
  const cur = a.cur === null ? null : Number(a.cur);
  if (cur !== null && value < cur) {
    if (!correct) throw bad(`The ${meter} meter reads ${cur} already. It only goes up.`);
    if (!isManager(req)) throw forbidden('Only a manager can correct a meter down');
  }
  await conn.query(`UPDATE ops_assets SET ${meter} = ? WHERE tenant_id = ? AND id = ?`, [value, req.auth.tenantId, assetId]);
  await conn.query('INSERT INTO asset_meters (tenant_id, asset_id, meter, value, read_at, source, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, assetId, meter, value, at, source, req.auth.userId]);
  if (correct && cur !== null && value < cur) await audit(conn, req, 'meter_correct', 'ops_assets', assetId, { meter, from: cur, to: value });
  // A miles plan marked done before the odometer was known counts from the first reading, so it does not sit "on track" forever.
  if (meter === 'miles') await conn.query('UPDATE pm_tasks SET last_done_miles = ? WHERE tenant_id = ? AND asset_id = ? AND interval_miles IS NOT NULL AND last_done_miles IS NULL AND last_done_on IS NOT NULL', [value, req.auth.tenantId, assetId]);
}

router.post('/register/:id/meter', validate(z.object({ hours: z.number().min(0).max(9999999).optional(), miles: z.number().min(0).max(99999999).optional(), correct: z.boolean().optional() })
  .refine((v) => v.hours !== undefined || v.miles !== undefined, 'Give hours, miles or both')), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const at = nowIn(await tzOf(conn, req.auth.tenantId));
    for (const m of ['hours', 'miles']) if (req.body[m] !== undefined) await recordMeter(conn, req, id, m, req.body[m], 'manual', at, { correct: req.body.correct });
  });
  res.json({ ok: true });
});

router.post('/register/:id/fuel', validate(z.object({
  gallons: z.number().positive().max(100000), cost_cents: nullable(money), fuel_type: nullable(z.enum(['diesel', 'gasoline', 'propane', 'electric', 'other'])),
  hours: nullable(z.number().min(0).max(9999999)), miles: nullable(z.number().min(0).max(99999999)), filled_at: nullable(dateTimeStr.transform(normDateTime)),
  vendor_id: nullable(z.number().int().positive()), note: nullable(z.string().max(255)),
})), async (req, res) => {
  const id = paramId(req); const b = req.body;
  const out = await tx(async (conn) => {
    await mustExist(conn, 'vendors', req.auth.tenantId, b.vendor_id, 'Vendor');
    const a = await one(conn, 'SELECT fuel_type FROM ops_assets WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
    if (!a) throw notFound('Asset');
    const at = b.filled_at || nowIn(await tzOf(conn, req.auth.tenantId));
    for (const m of ['hours', 'miles']) if (b[m] !== null && b[m] !== undefined) await recordMeter(conn, req, id, m, b[m], 'fuel', at);
    const [r] = await conn.query('INSERT INTO asset_fuel (tenant_id, asset_id, filled_at, gallons, cost_cents, fuel_type, hours, miles, vendor_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.auth.tenantId, id, at, b.gallons, b.cost_cents ?? null, b.fuel_type || (a.fuel_type && a.fuel_type !== 'none' ? a.fuel_type : null), b.hours ?? null, b.miles ?? null, b.vendor_id ?? null, b.note ?? null, req.auth.userId]);
    return r.insertId;
  });
  res.status(201).json({ id: out });
});

// ---------------------------------------------------------------- inspections
const tplFields = { name: z.string().trim().min(1).max(120), kinds: z.array(z.string().refine((k) => O.ASSET_KIND_KEYS.includes(k), 'Unknown type')).max(30).default([]), items: z.array(CR.stepSchema).min(1).max(60), active: z.boolean().optional() };
router.post('/templates', manager, validate(z.object(tplFields)), async (req, res) => {
  const b = req.body;
  if (new Set(b.items.map((i) => i.key)).size !== b.items.length) throw bad('Each item needs its own key');
  try {
    const [r] = await pool.query('INSERT INTO inspection_templates (tenant_id, name, kinds, items) VALUES (?, ?, ?, ?)', [req.auth.tenantId, b.name, b.kinds.join(',') || null, JSON.stringify(b.items)]);
    res.status(201).json({ id: r.insertId });
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a checklist with that name'); throw err; }
});
router.patch('/templates/:id', manager, validate(partialOf(tplFields)), async (req, res) => {
  const b = { ...req.body };
  if (b.items && new Set(b.items.map((i) => i.key)).size !== b.items.length) throw bad('Each item needs its own key');
  if (b.kinds) b.kinds = b.kinds.join(',') || null;
  if (b.items) b.items = JSON.stringify(b.items);
  const set = setClause(b, ['name', 'kinds', 'items', 'active']);
  if (!set) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE inspection_templates SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Checklist');
  res.json({ ok: true });
});

/** A completed checklist. Every item is answered; a failed one needs a note, opens a work order and flags the asset. */
router.post('/register/:id/inspections', validate(z.object({
  template_id: z.number().int().positive(),
  items: z.array(CR.answerSchema).min(1),
  hours: nullable(z.number().min(0).max(9999999)), miles: nullable(z.number().min(0).max(99999999)),
  inspector: nullable(z.string().max(100)), note: nullable(z.string().max(500)),
})), async (req, res) => {
  const id = paramId(req); const b = req.body; const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const a = await one(conn, 'SELECT id, name, asset_tag, status, critical FROM ops_assets WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!a) throw notFound('Asset');
    const tpl = await one(conn, 'SELECT * FROM inspection_templates WHERE tenant_id = ? AND id = ?', [t, b.template_id]);
    if (!tpl) throw notFound('Checklist');
    // Readings and dates are checked against their rules here: one outside its range fails by itself, with the reason.
    const at = nowIn(await tzOf(conn, t));
    let items;
    try { items = CR.evaluateAll(JSON.parse(tpl.items), b.items, at.slice(0, 10)); } catch (e) { throw bad(e.message); }
    const failed = items.filter((i) => i.result === 'fail');
    for (const m of ['hours', 'miles']) if (b[m] !== null && b[m] !== undefined) await recordMeter(conn, req, id, m, b[m], 'inspection', at);
    let woId = null;
    if (failed.length) {
      woId = await maintenance.createOrder(conn, req, { title: `Failed ${tpl.name.toLowerCase()}: ${a.name}`, description: failed.map((i) => `${i.label}${i.value != null ? ` (${i.value}${i.unit ? ` ${i.unit}` : ''})` : ''}: ${i.note}`).join('\n'), priority: a.critical ? 'urgent' : 'high', asset_id: id }, 'inspection');
      if (a.status === 'in_service') await conn.query("UPDATE ops_assets SET status = 'needs_service' WHERE tenant_id = ? AND id = ?", [t, id]);
    }
    const who = b.inspector || (await one(conn, "SELECT COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), u.email, u.username) AS n FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE u.tenant_id = ? AND u.id = ?", [t, req.auth.userId]) || {}).n || null;
    const [r] = await conn.query('INSERT INTO asset_inspections (tenant_id, asset_id, template_id, template_name, result, items, hours, miles, inspector, note, work_order_id, user_id, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, id, tpl.id, tpl.name, failed.length ? 'fail' : 'pass', JSON.stringify(items), b.hours ?? null, b.miles ?? null, who, b.note ?? null, woId, req.auth.userId, at]);
    await audit(conn, req, 'inspect', 'ops_assets', id, { result: failed.length ? 'fail' : 'pass', work_order_id: woId });
    return { id: r.insertId, result: failed.length ? 'fail' : 'pass', work_order_id: woId };
  });
  res.status(201).json(out);
});

/** Something wrong, reported from the asset page (often after scanning its tag): opens a work order. */
router.post('/register/:id/problem', validate(z.object({ title: z.string().trim().min(3).max(150), description: nullable(z.string().max(5000)), out_of_service: z.boolean().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() })), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const woId = await tx(async (conn) => {
    const a = await one(conn, 'SELECT id, critical FROM ops_assets WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!a) throw notFound('Asset');
    const w = await maintenance.createOrder(conn, req, { title: req.body.title, description: req.body.description, priority: req.body.priority || (req.body.out_of_service || a.critical ? 'high' : 'normal'), asset_id: id });
    await conn.query(`UPDATE ops_assets SET status = ? WHERE tenant_id = ? AND id = ? AND status <> 'retired'`, [req.body.out_of_service ? 'out_of_service' : 'needs_service', t, id]);
    return w;
  });
  res.status(201).json({ id: woId });
});

// ---------------------------------------------------------------- parts and stock
const partFields = {
  sku: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(150), unit: z.string().trim().min(1).max(20).default('each'),
  unit_cost_cents: money.max(100000000).optional(), reorder_point: nullable(z.number().min(0).max(1000000)), reorder_qty: nullable(z.number().min(0).max(1000000)),
  vendor_id: nullable(z.number().int().positive()), vendor_part_no: nullable(z.string().max(60)), location_id: nullable(z.number().int().positive()), bin: nullable(z.string().max(40)),
  fits: nullable(z.string().max(255)), active: z.boolean().optional(),
};
const PART_SQL = `SELECT p.*, v.name AS vendor, l.name AS location FROM parts p LEFT JOIN vendors v ON v.tenant_id = p.tenant_id AND v.id = p.vendor_id LEFT JOIN asset_locations l ON l.tenant_id = p.tenant_id AND l.id = p.location_id`;
const partOut = (p) => ({ ...p, qty_on_hand: Number(p.qty_on_hand), reorder_point: num(p.reorder_point), reorder_qty: num(p.reorder_qty), low: p.reorder_point !== null && Number(p.qty_on_hand) <= Number(p.reorder_point) });

router.get('/parts', async (req, res) => {
  const where = ['p.tenant_id = ?']; const params = [req.auth.tenantId];
  if (req.query.all !== '1') where.push('p.active = 1');
  if (req.query.q) { const q = `%${first(req.query.q).slice(0, 60)}%`; where.push('(p.sku LIKE ? OR p.name LIKE ? OR p.fits LIKE ? OR p.vendor_part_no LIKE ?)'); params.push(q, q, q, q); }
  if (req.query.low === '1') where.push('p.reorder_point IS NOT NULL AND p.qty_on_hand <= p.reorder_point');
  res.json({ data: (await rows(pool, `${PART_SQL} WHERE ${where.join(' AND ')} ORDER BY p.name LIMIT 1000`, params)).map(partOut) });
});
router.get('/parts/:id', async (req, res) => {
  const p = await one(pool, `${PART_SQL} WHERE p.tenant_id = ? AND p.id = ?`, [req.auth.tenantId, paramId(req)]);
  if (!p) throw notFound('Part');
  const moves = await rows(pool, `SELECT m.*, a.name AS asset, a.asset_tag, w.title AS work_order FROM part_moves m LEFT JOIN ops_assets a ON a.tenant_id = m.tenant_id AND a.id = m.asset_id
    LEFT JOIN work_orders w ON w.tenant_id = m.tenant_id AND w.id = m.work_order_id WHERE m.tenant_id = ? AND m.part_id = ? ORDER BY m.at DESC, m.id DESC LIMIT 100`, [req.auth.tenantId, p.id]);
  res.json({ ...partOut(p), moves: moves.map((m) => ({ ...m, qty: Number(m.qty) })) });
});
router.post('/parts', validate(z.object({ ...partFields, qty_on_hand: qty2(z.number().min(0).max(1000000)).optional() })), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  if (b.unit_cost_cents && !isManager(req)) throw forbidden('Only a manager sets a part cost');
  const id = await tx(async (conn) => {
    await mustExist(conn, 'vendors', t, b.vendor_id, 'Vendor');
    await mustExist(conn, 'asset_locations', t, b.location_id, 'Location');
    const keys = Object.keys(partFields).filter((k) => b[k] !== undefined && k !== 'active');
    let r;
    try { [r] = await conn.query(`INSERT INTO parts (tenant_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, [t, ...keys.map((k) => b[k])]); } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a part with that number'); throw err;
    }
    if (b.qty_on_hand) {
      await conn.query('UPDATE parts SET qty_on_hand = ? WHERE tenant_id = ? AND id = ?', [b.qty_on_hand, t, r.insertId]);
      await conn.query("INSERT INTO part_moves (tenant_id, part_id, kind, qty, unit_cost_cents, note, user_id, at) VALUES (?, ?, 'count', ?, ?, 'Starting count', ?, ?)", [t, r.insertId, b.qty_on_hand, b.unit_cost_cents || 0, req.auth.userId, nowIn(await tzOf(conn, t))]);
    }
    return r.insertId;
  });
  res.status(201).json({ id });
});
router.patch('/parts/:id', validate(partialOf(partFields)), async (req, res) => {
  const t = req.auth.tenantId;
  await mustExist(pool, 'vendors', t, req.body.vendor_id, 'Vendor');
  await mustExist(pool, 'asset_locations', t, req.body.location_id, 'Location');
  if (req.body.unit_cost_cents !== undefined && !isManager(req)) throw forbidden('Only a manager changes a part cost');
  const set = setClause(req.body, Object.keys(partFields));
  if (!set) throw bad('Nothing to change');
  try {
    const [r] = await pool.query(`UPDATE parts SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, t, paramId(req)]);
    if (!r.affectedRows) throw notFound('Part');
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a part with that number'); throw err; }
  res.json({ ok: true });
});

/** A stock count (set the number) or an adjustment (add or take away), with a reason. */
router.post('/parts/:id/stock', validate(z.object({ count: qty2(z.number().min(0).max(1000000)).optional(), change: qty2(z.number().min(-1000000).max(1000000)).optional(), note: z.string().trim().min(3).max(255) })
  .refine((v) => (v.count === undefined) !== (v.change === undefined), 'Give a count or a change, not both')), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  await tx(async (conn) => {
    const p = await one(conn, 'SELECT qty_on_hand, unit_cost_cents FROM parts WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!p) throw notFound('Part');
    const cur = Number(p.qty_on_hand);
    const delta = req.body.count !== undefined ? req.body.count - cur : req.body.change;
    if (cur + delta < 0) throw bad(`That would leave ${cur + delta} on hand`);
    await conn.query('UPDATE parts SET qty_on_hand = qty_on_hand + ? WHERE tenant_id = ? AND id = ?', [delta, t, id]);
    await conn.query('INSERT INTO part_moves (tenant_id, part_id, kind, qty, unit_cost_cents, note, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, id, req.body.count !== undefined ? 'count' : 'adjust', delta, p.unit_cost_cents, req.body.note, req.auth.userId, nowIn(await tzOf(conn, t))]);
    await audit(conn, req, 'stock', 'parts', id, { delta, note: req.body.note });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- work order parts, labor and outside costs
async function orderFor(conn, req, id) {
  const w = await one(conn, 'SELECT id, asset_id, status FROM work_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
  if (!w) throw notFound('Work order');
  return w;
}

/**
 * Parts taken from stock for a work order, at today's cost, charged to its asset. A negative qty returns parts, credited
 * at what they cost when issued. Returns still work on a canceled order, so parts never get stuck on it.
 */
router.post('/work-orders/:id/parts', validate(z.object({ part_id: z.number().int().positive(), qty: qty2(z.number().min(-100000).max(100000)).refine((v) => v !== 0, 'Give a quantity'), note: nullable(z.string().max(255)) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  await tx(async (conn) => {
    const w = await orderFor(conn, req, id);
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
  });
  res.status(201).json({ ok: true });
});

router.post('/work-orders/:id/labor', validate(z.object({ staff_id: nullable(z.number().int().positive()), worker: nullable(z.string().max(100)), hours: z.number().positive().max(200), worked_on: nullable(dateStr), note: nullable(z.string().max(255)) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const out = await tx(async (conn) => {
    if ((await orderFor(conn, req, id)).status === 'cancelled') throw conflict('This work order was canceled');
    await mustExist(conn, 'staff', t, b.staff_id, 'Staff member');
    const s = await A.ensureSettings(conn, t);
    const [r] = await conn.query('INSERT INTO work_order_labor (tenant_id, work_order_id, staff_id, worker, hours, rate_cents, worked_on, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, id, b.staff_id ?? null, b.worker ?? null, b.hours, s.labor_rate_cents, b.worked_on || todayIn(await tzOf(conn, t)), b.note ?? null, req.auth.userId]);
    // Keep the work order's own hour total in step, for screens that only show that.
    await conn.query('UPDATE work_orders SET labor_hours = (SELECT SUM(hours) FROM work_order_labor WHERE tenant_id = ? AND work_order_id = ?) WHERE tenant_id = ? AND id = ?', [t, id, t, id]);
    return r.insertId;
  });
  res.status(201).json({ id: out });
});
router.delete('/work-orders/:id/labor/:rowId', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  await tx(async (conn) => {
    const row = await one(conn, 'SELECT user_id FROM work_order_labor WHERE tenant_id = ? AND work_order_id = ? AND id = ?', [t, id, paramId(req, 'rowId')]);
    if (!row) throw notFound('Labor entry');
    if (row.user_id !== req.auth.userId && !isManager(req)) throw forbidden('Only the person who logged it, or a manager, can remove it');
    await conn.query('DELETE FROM work_order_labor WHERE tenant_id = ? AND id = ?', [t, paramId(req, 'rowId')]);
    await conn.query('UPDATE work_orders SET labor_hours = (SELECT SUM(hours) FROM work_order_labor WHERE tenant_id = ? AND work_order_id = ?) WHERE tenant_id = ? AND id = ?', [t, id, t, id]);
    await audit(conn, req, 'remove_labor', 'work_orders', id, { row: paramId(req, 'rowId') });
  });
  res.status(204).end();
});

/** Outside work and the meter reading at service. Vendor costs are a manager's call. */
router.patch('/work-orders/:id/costs', validate(z.object({ vendor_id: nullable(z.number().int().positive()), vendor_cost_cents: nullable(money), meter_hours: nullable(z.number().min(0).max(9999999)), meter_miles: nullable(z.number().min(0).max(99999999)), downtime_hours: nullable(z.number().min(0).max(100000)) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  if ((req.body.vendor_cost_cents !== undefined || req.body.vendor_id !== undefined) && !isManager(req)) throw forbidden('Only a manager records outside costs');
  await tx(async (conn) => {
    const w = await orderFor(conn, req, id);
    await mustExist(conn, 'vendors', t, req.body.vendor_id, 'Vendor');
    const set = setClause(req.body, ['vendor_id', 'vendor_cost_cents', 'meter_hours', 'meter_miles', 'downtime_hours']);
    if (!set) throw bad('Nothing to change');
    await conn.query(`UPDATE work_orders SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, t, id]);
    // A meter reading taken at service also moves the machine's meter (when it is higher).
    if (w.asset_id) {
      const at = nowIn(await tzOf(conn, t));
      for (const [k, m] of [['meter_hours', 'hours'], ['meter_miles', 'miles']]) {
        if (req.body[k] === null || req.body[k] === undefined) continue;
        const a = await one(conn, `SELECT ${m} AS cur FROM ops_assets WHERE tenant_id = ? AND id = ?`, [t, w.asset_id]);
        if (a.cur === null || req.body[k] > Number(a.cur)) await recordMeter(conn, req, w.asset_id, m, req.body[k], 'work_order', at);
      }
    }
    await audit(conn, req, 'costs', 'work_orders', id, Object.keys(req.body));
  });
  res.json({ ok: true });
});

router.get('/work-orders/:id/costs', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const w = await one(pool, 'SELECT w.id, w.asset_id, w.vendor_id, v.name AS vendor, w.vendor_cost_cents, w.meter_hours, w.meter_miles, w.downtime_hours, w.pm_task_id FROM work_orders w LEFT JOIN vendors v ON v.tenant_id = w.tenant_id AND v.id = w.vendor_id WHERE w.tenant_id = ? AND w.id = ?', [t, id]);
  if (!w) throw notFound('Work order');
  const [labor, parts] = await Promise.all([
    rows(pool, `SELECT l.*, COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), l.worker) AS who FROM work_order_labor l LEFT JOIN staff s ON s.tenant_id = l.tenant_id AND s.id = l.staff_id
      LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE l.tenant_id = ? AND l.work_order_id = ? ORDER BY l.worked_on, l.id`, [t, id]),
    rows(pool, `SELECT m.part_id, p.sku, p.name, p.unit, SUM(-m.qty) AS qty, SUM(-m.qty * m.unit_cost_cents) AS cost FROM part_moves m JOIN parts p ON p.tenant_id = m.tenant_id AND p.id = m.part_id
      WHERE m.tenant_id = ? AND m.work_order_id = ? AND m.kind IN ('issue','return') GROUP BY m.part_id, p.sku, p.name, p.unit HAVING SUM(-m.qty) <> 0 ORDER BY p.name`, [t, id]),
  ]);
  const laborCents = Math.round(labor.reduce((s, l) => s + Number(l.hours) * Number(l.rate_cents), 0));
  const partsCents = Math.round(parts.reduce((s, p) => s + Number(p.cost), 0));
  res.json({ ...w, labor: labor.map((l) => ({ ...l, hours: Number(l.hours), worked_on: A.ymd(l.worked_on), mine: l.user_id === req.auth.userId })), parts: parts.map((p) => ({ ...p, qty: Number(p.qty), cost: Math.round(Number(p.cost)) })),
    labor_cents: laborCents, parts_cents: partsCents, total_cents: laborCents + partsCents + Number(w.vendor_cost_cents || 0) });
});

// ---------------------------------------------------------------- purchase orders
const lineSchema = z.object({ part_id: nullable(z.number().int().positive()), description: nullable(z.string().max(200)), qty: qty2(z.number().positive().max(1000000)), unit_cost_cents: money.max(100000000).default(0), work_order_id: nullable(z.number().int().positive()) });
const poSchema = z.object({ vendor_id: z.number().int().positive(), expected_on: nullable(dateStr), notes: nullable(z.string().max(500)), lines: z.array(lineSchema).min(1).max(200) });

async function writeLines(conn, req, poId, lines) {
  const t = req.auth.tenantId;
  await conn.query('DELETE FROM po_lines WHERE tenant_id = ? AND po_id = ?', [t, poId]);
  for (const l of lines) {
    let desc = l.description;
    if (l.part_id) { const p = await one(conn, 'SELECT name, sku FROM parts WHERE tenant_id = ? AND id = ?', [t, l.part_id]); if (!p) throw notFound('Part'); desc = desc || `${p.sku} ${p.name}`; }
    if (!desc) throw bad('Each line needs a part or a description');
    await mustExist(conn, 'work_orders', t, l.work_order_id, 'Work order');
    await conn.query('INSERT INTO po_lines (tenant_id, po_id, part_id, description, qty, unit_cost_cents, work_order_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, poId, l.part_id ?? null, desc, l.qty, l.unit_cost_cents, l.work_order_id ?? null]);
  }
}
const PO_SQL = `SELECT o.*, v.name AS vendor, (SELECT COALESCE(SUM(qty * unit_cost_cents), 0) FROM po_lines x WHERE x.tenant_id = o.tenant_id AND x.po_id = o.id) AS total_cents
  FROM purchase_orders o JOIN vendors v ON v.tenant_id = o.tenant_id AND v.id = o.vendor_id`;

router.get('/purchase-orders', async (req, res) => {
  const where = ['o.tenant_id = ?']; const params = [req.auth.tenantId];
  const st = first(req.query.status || 'open');
  if (st === 'open') where.push("o.status IN ('draft','ordered','partial')"); else if (st !== 'all') { where.push('o.status = ?'); params.push(st); }
  res.json({ data: (await rows(pool, `${PO_SQL} WHERE ${where.join(' AND ')} ORDER BY o.po_number DESC LIMIT 300`, params)).map((o) => ({ ...o, total_cents: Math.round(Number(o.total_cents)) })) });
});
router.get('/purchase-orders/:id', async (req, res) => {
  const o = await one(pool, `${PO_SQL} WHERE o.tenant_id = ? AND o.id = ?`, [req.auth.tenantId, paramId(req)]);
  if (!o) throw notFound('Purchase order');
  const lines = await rows(pool, 'SELECT l.*, p.sku, p.unit FROM po_lines l LEFT JOIN parts p ON p.tenant_id = l.tenant_id AND p.id = l.part_id WHERE l.tenant_id = ? AND l.po_id = ? ORDER BY l.id', [req.auth.tenantId, o.id]);
  res.json({ ...o, total_cents: Math.round(Number(o.total_cents)), lines: lines.map((l) => ({ ...l, qty: Number(l.qty), received_qty: Number(l.received_qty) })) });
});
router.post('/purchase-orders', manager, validate(poSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const out = await tx(async (conn) => {
    await mustExist(conn, 'vendors', t, b.vendor_id, 'Vendor');
    await A.ensureSettings(conn, t);
    const s = await one(conn, 'SELECT next_po FROM asset_settings WHERE tenant_id = ? FOR UPDATE', [t]);
    const [r] = await conn.query('INSERT INTO purchase_orders (tenant_id, po_number, vendor_id, expected_on, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)', [t, s.next_po, b.vendor_id, b.expected_on ?? null, b.notes ?? null, req.auth.userId]);
    await conn.query('UPDATE asset_settings SET next_po = next_po + 1 WHERE tenant_id = ?', [t]);
    await writeLines(conn, req, r.insertId, b.lines);
    await audit(conn, req, 'create', 'purchase_orders', r.insertId, { po: s.next_po });
    return { id: r.insertId, po_number: s.next_po };
  });
  res.status(201).json(out);
});
/** A draft for one vendor holding every part of theirs that is at or below its reorder point. */
router.post('/purchase-orders/reorder', manager, validate(z.object({ vendor_id: z.number().int().positive() })), async (req, res) => {
  const t = req.auth.tenantId;
  const low = await rows(pool, 'SELECT id, qty_on_hand, reorder_point, reorder_qty, unit_cost_cents FROM parts WHERE tenant_id = ? AND vendor_id = ? AND active = 1 AND reorder_point IS NOT NULL AND qty_on_hand <= reorder_point', [t, req.body.vendor_id]);
  if (!low.length) throw bad('Nothing from this vendor is at or below its reorder point');
  req.body = { vendor_id: req.body.vendor_id, lines: low.map((p) => ({ part_id: p.id, qty: Number(p.reorder_qty) || Math.max(1, Number(p.reorder_point) * 2 - Number(p.qty_on_hand)), unit_cost_cents: p.unit_cost_cents })) };
  const out = await tx(async (conn) => {
    await A.ensureSettings(conn, t);
    const s = await one(conn, 'SELECT next_po FROM asset_settings WHERE tenant_id = ? FOR UPDATE', [t]);
    const [r] = await conn.query('INSERT INTO purchase_orders (tenant_id, po_number, vendor_id, notes, created_by) VALUES (?, ?, ?, ?, ?)', [t, s.next_po, req.body.vendor_id, 'Reorder of parts at or below their reorder point', req.auth.userId]);
    await conn.query('UPDATE asset_settings SET next_po = next_po + 1 WHERE tenant_id = ?', [t]);
    await writeLines(conn, req, r.insertId, req.body.lines);
    await audit(conn, req, 'create', 'purchase_orders', r.insertId, { po: s.next_po, reorder: true });
    return { id: r.insertId, po_number: s.next_po, lines: req.body.lines.length };
  });
  res.status(201).json(out);
});
router.put('/purchase-orders/:id', manager, validate(poSchema), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  await tx(async (conn) => {
    const o = await one(conn, 'SELECT status FROM purchase_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!o) throw notFound('Purchase order');
    if (o.status !== 'draft') throw conflict('Only a draft can be changed. Receive it, or cancel it and start again.');
    await mustExist(conn, 'vendors', t, b.vendor_id, 'Vendor');
    await conn.query('UPDATE purchase_orders SET vendor_id = ?, expected_on = ?, notes = ? WHERE tenant_id = ? AND id = ?', [b.vendor_id, b.expected_on ?? null, b.notes ?? null, t, id]);
    await writeLines(conn, req, id, b.lines);
  });
  res.json({ ok: true });
});
router.post('/purchase-orders/:id/order', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const [r] = await pool.query("UPDATE purchase_orders SET status = 'ordered', ordered_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'", [nowIn(await tzOf(pool, t)), t, id]);
  if (!r.affectedRows) throw conflict('Only a draft can be marked as ordered');
  await audit(pool, req, 'order', 'purchase_orders', id);
  res.json({ ok: true });
});
router.post('/purchase-orders/:id/cancel', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const [r] = await pool.query("UPDATE purchase_orders o SET status = 'cancelled' WHERE tenant_id = ? AND id = ? AND status IN ('draft','ordered') AND NOT EXISTS (SELECT 1 FROM po_lines l WHERE l.tenant_id = o.tenant_id AND l.po_id = o.id AND l.received_qty > 0)", [t, id]);
  if (!r.affectedRows) throw conflict('A purchase order with anything received cannot be canceled');
  await audit(pool, req, 'cancel', 'purchase_orders', id);
  res.json({ ok: true });
});
/**
 * What arrived. Parts go into stock at the price on the order (set by a manager), which becomes the part's cost; a line
 * can arrive in pieces. The crew can receive, since they are the ones at the dock.
 */
router.post('/purchase-orders/:id/receive', validate(z.object({ lines: z.array(z.object({ line_id: z.number().int().positive(), qty: qty2(z.number().positive().max(1000000)) })).min(1) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const out = await tx(async (conn) => {
    const o = await one(conn, 'SELECT status FROM purchase_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!o) throw notFound('Purchase order');
    if (!['ordered', 'partial'].includes(o.status)) throw conflict(o.status === 'draft' ? 'Mark it as ordered first' : `This purchase order is ${o.status}`);
    const at = nowIn(await tzOf(conn, t));
    for (const r of req.body.lines) {
      const l = await one(conn, 'SELECT * FROM po_lines WHERE tenant_id = ? AND po_id = ? AND id = ? FOR UPDATE', [t, id, r.line_id]);
      if (!l) throw notFound('Line');
      const left = Number(l.qty) - Number(l.received_qty);
      if (r.qty > left + 1e-9) throw bad(`Only ${left} left to receive on "${l.description}"`);
      await conn.query('UPDATE po_lines SET received_qty = received_qty + ? WHERE tenant_id = ? AND id = ?', [r.qty, t, l.id]);
      if (l.part_id) {
        await conn.query('UPDATE parts SET qty_on_hand = qty_on_hand + ?, unit_cost_cents = ? WHERE tenant_id = ? AND id = ?', [r.qty, l.unit_cost_cents, t, l.part_id]);
        await conn.query('INSERT INTO part_moves (tenant_id, part_id, kind, qty, unit_cost_cents, po_id, note, user_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [t, l.part_id, 'receive', r.qty, l.unit_cost_cents, id, `PO line ${l.id}`, req.auth.userId, at]);
      }
    }
    const left = await one(conn, 'SELECT COUNT(*) AS n FROM po_lines WHERE tenant_id = ? AND po_id = ? AND received_qty < qty', [t, id]);
    const status = Number(left.n) ? 'partial' : 'received';
    await conn.query('UPDATE purchase_orders SET status = ?, received_at = IF(? = \'received\', ?, received_at) WHERE tenant_id = ? AND id = ?', [status, status, at, t, id]);
    await audit(conn, req, 'receive', 'purchase_orders', id, { lines: req.body.lines.length, status });
    return status;
  });
  res.json({ status: out });
});

// ---------------------------------------------------------------- overview and lifecycle
router.get('/overview', async (req, res) => {
  const t = req.auth.tenantId;
  const s = await A.ensureSettings(pool, t);
  const today = todayIn(await tzOf(pool, t));
  const since = A.addDays(today, -365);
  const monthStart = `${today.slice(0, 8)}01`;
  const assets = (await rows(pool, `${LIST_SQL} WHERE a.tenant_id = ? AND a.status <> 'retired'`, [t])).map((a) => shape(a, today, s.expiry_warn_days));
  const pm = await plans(pool, t, today);
  const [low, openPo, openWo, spend] = await Promise.all([
    rows(pool, "SELECT id, sku, name, qty_on_hand, reorder_point, unit FROM parts WHERE tenant_id = ? AND active = 1 AND reorder_point IS NOT NULL AND qty_on_hand <= reorder_point ORDER BY name LIMIT 50", [t]),
    one(pool, "SELECT COUNT(*) AS n FROM purchase_orders WHERE tenant_id = ? AND status IN ('ordered','partial')", [t]),
    one(pool, "SELECT COUNT(*) AS n, SUM(priority = 'urgent') AS urgent FROM work_orders WHERE tenant_id = ? AND status NOT IN ('done','cancelled')", [t]),
    one(pool, `SELECT
        (SELECT COALESCE(SUM(l.hours * l.rate_cents), 0) FROM work_order_labor l WHERE l.tenant_id = ? AND l.worked_on >= ?) AS labor_month,
        (SELECT COALESCE(SUM(-m.qty * m.unit_cost_cents), 0) FROM part_moves m WHERE m.tenant_id = ? AND m.kind IN ('issue','return') AND m.at >= ?) AS parts_month,
        (SELECT COALESCE(SUM(vendor_cost_cents), 0) FROM work_orders WHERE tenant_id = ? AND status <> 'cancelled' AND IF(completed_at IS NULL, opened_at >= ?, completed_at >= ?)) AS vendor_month,
        (SELECT COALESCE(SUM(cost_cents), 0) FROM asset_fuel WHERE tenant_id = ? AND filled_at >= ?) AS fuel_month`, [t, monthStart, t, monthStart, t, dayRange(await tzOf(pool, t), monthStart)[0], monthStart, t, monthStart]),
  ]);
  const costMap = await A.costs(pool, t, assets.map((a) => a.id), since);
  const lc = assets.map((a) => ({ a, c: costMap.get(a.id), l: A.lifecycle(a, costMap.get(a.id), today, s.replace_pct) }));
  const byCat = {};
  for (const a of assets) { const k = a.category; byCat[k] = byCat[k] || { total: 0, down: 0 }; byCat[k].total += 1; if (a.status === 'out_of_service') byCat[k].down += 1; }
  res.json({
    today,
    counts: { assets: assets.length, out_of_service: assets.filter((a) => a.status === 'out_of_service').length, needs_service: assets.filter((a) => a.status === 'needs_service').length, open_orders: Number(openWo.n), urgent_orders: Number(openWo.urgent || 0), open_pos: Number(openPo.n) },
    by_category: A.CATEGORIES.filter((c) => byCat[c.value]).map((c) => ({ ...c, ...byCat[c.value] })),
    service_due: pm.filter((p) => p.state === 'overdue' || p.state === 'soon').sort((x, y) => RANK[x.state] - RANK[y.state]).slice(0, 30),
    papers_due: assets.flatMap((a) => a.papers.filter((p) => p.state === 'expired' || p.state === 'soon').map((p) => ({ asset_id: a.id, asset: a.name, tag: a.asset_tag, ...p }))).sort((x, y) => x.on.localeCompare(y.on)),
    low_stock: low.map((p) => ({ ...p, qty_on_hand: Number(p.qty_on_hand), reorder_point: Number(p.reorder_point) })),
    spend_month_cents: isManager(req) ? Math.round(Number(spend.labor_month) + Number(spend.parts_month) + Number(spend.vendor_month) + Number(spend.fuel_month)) : null,
    replace: isManager(req) ? lc.filter((x) => x.l.replace).map((x) => ({ id: x.a.id, name: x.a.name, tag: x.a.asset_tag, reasons: x.l.reasons })) : [],
    top_cost: isManager(req) ? lc.filter((x) => x.c.maintenance_12 > 0).sort((x, y) => y.c.maintenance_12 - x.c.maintenance_12).slice(0, 5).map((x) => ({ id: x.a.id, name: x.a.name, tag: x.a.asset_tag, maintenance_12: x.c.maintenance_12 })) : [],
  });
});

/** Every asset's costs and lifecycle numbers, for the Costs tab and its spreadsheet download. Managers only. */
router.get('/lifecycle', manager, async (req, res) => {
  const t = req.auth.tenantId;
  const s = await A.ensureSettings(pool, t);
  const today = todayIn(await tzOf(pool, t));
  const assets = (await rows(pool, `${LIST_SQL} WHERE a.tenant_id = ? ${req.query.all === '1' ? '' : "AND a.status <> 'retired'"} ORDER BY a.name`, [t])).map((a) => shape(a, today, s.expiry_warn_days));
  const costMap = await A.costs(pool, t, assets.map((a) => a.id), A.addDays(today, -365));
  const data = assets.map((a) => {
    const c = costMap.get(a.id);
    return { id: a.id, name: a.name, tag: a.asset_tag, category: a.category, kind: a.kind, status: a.status, hours: a.hours, miles: a.miles, purchased_on: a.purchased_on, purchase_cents: a.purchase_cents === null ? null : Number(a.purchase_cents), ...c, ...A.lifecycle(a, c, today, s.replace_pct) };
  });
  if (req.query.format === 'csv') {
    const cols = ['tag', 'name', 'category', 'status', 'hours', 'miles', 'purchased_on', 'purchase_cents', 'book_value_cents', 'age_years', 'labor', 'parts', 'vendor', 'fuel', 'maintenance_12', 'total', 'cost_per_hour_cents', 'cost_per_mile_cents', 'replace'];
    // Text that a spreadsheet would read as a formula (=, +, -, @) is kept as text.
    const esc = (v) => { let x = v === null || v === undefined ? '' : String(v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(x)) x = `'${x}`; return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    await audit(pool, req, 'export', 'ops_assets', null, { rows: data.length });
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="asset-costs.csv"').send([cols.join(','), ...data.map((d) => cols.map((k) => esc(d[k])).join(','))].join('\n'));
    return;
  }
  res.json({ data, settings: s });
});

router.recordMeter = recordMeter;
module.exports = router;
