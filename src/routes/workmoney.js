'use strict';

// What public works costs (release 2026.11.20, workstream "money"), mounted inside the Assets and fleet router
// (routes/assets.js: staff and managers). lib/workcosts.js has the rules; lib/monthreport.js builds the monthly report.
//   GET    /books                          departments and funds (a municipality's; made the first time)
//   POST   /departments, PATCH /departments/:id, POST /funds, PATCH /funds/:id     managers
//   GET    /labor-rates, PUT /labor-rates/:staffId                                managers: each person's labor cost an hour
//   GET    /cost-pickers                   what Mark done chooses from: crew, equipment, parts in stock, departments, funds, streets
//   POST   /work-orders/:id/equipment      equipment hours on a job;  DELETE /work-orders/:id/equipment/:rowId
//   POST   /work-orders/:id/materials      a one-off material;        DELETE /work-orders/:id/materials/:rowId
//   POST   /work-orders/:id/cost-lines     Add costs: several lines at once (all or nothing)
//   POST   /work-orders/:id/complete       Mark done: what was done, with its crew hours, equipment, materials and outside cost
//   GET    /month-report?month=YYYY-MM     the monthly report (managers); /month-report.csv the same as a spreadsheet
//   GET    /month-report/photos/:kind/:id  a highlight's photo, with where it was taken removed (managers)
// Departments, funds, labor rates and the report are a municipality's only; equipment and materials work for anyone
// with Assets and fleet.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { z, dateStr, validate, paramId, todayIn } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const W = require('../lib/workcosts');
const R = require('../lib/monthreport');

const router = express.Router();
const nullable = (s) => s.nullable().optional();
const money = z.number().int().min(0).max(100000000);
const isManager = (req) => ['owner', 'manager'].includes(req.auth.role);
const manager = (req, _res, next) => (isManager(req) ? next() : next(forbidden('Only a manager can do this')));
const tzOf = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const first = (v) => String(Array.isArray(v) ? v[0] : v);
// Departments, funds, labor rates and the monthly report are for a municipality only.
const muniOnly = async (req, _res, next) => { try { if (!(await W.isMuniTenant(pool, req.auth.tenantId))) throw notFound('Page'); next(); } catch (err) { next(err); } };

// ---------------------------------------------------------------- departments and funds
router.get('/books', muniOnly, async (req, res) => {
  await W.ensureBooks(pool, req.auth.tenantId);
  res.json({ ...(await W.books(pool, req.auth.tenantId)), dept_kinds: W.DEPT_KINDS, can_manage: isManager(req) });
});

const deptFields = { name: z.string().trim().min(1).max(60), fund_id: nullable(z.number().int().positive()), kind: nullable(z.enum(W.DEPT_KINDS)), active: z.boolean().optional(), sort: z.number().int().min(0).max(9999).optional() };
const fundFields = { name: z.string().trim().min(1).max(60), code: nullable(z.string().trim().max(20)), liquid_fuels: z.boolean().optional(), active: z.boolean().optional(), sort: z.number().int().min(0).max(9999).optional() };

async function saveBook(req, table, id, b) {
  const t = req.auth.tenantId;
  await W.ensureBooks(pool, t);
  if (b.fund_id && !(await one(pool, 'SELECT id FROM funds WHERE tenant_id = ? AND id = ?', [t, b.fund_id]))) throw notFound('Fund');
  const v = { ...b };
  if (table === 'funds' && b.liquid_fuels !== undefined) {
    // One kind per fund; the Liquid Fuels report reads every fund marked Liquid Fuels.
    const cur = id ? await one(pool, 'SELECT kind FROM funds WHERE tenant_id = ? AND id = ?', [t, id]) : null;
    v.kind = b.liquid_fuels ? 'liquid_fuels' : (cur && cur.kind === 'liquid_fuels' ? null : (cur ? cur.kind : null));
  }
  delete v.liquid_fuels;
  if (v.active !== undefined) v.active = v.active ? 1 : 0;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  try {
    if (id) {
      if (!keys.length) throw bad('Nothing to change');
      const [r] = await pool.query(`UPDATE ${table} SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => v[k]), t, id]);
      if (!r.affectedRows) throw notFound(table === 'funds' ? 'Fund' : 'Department');
    } else {
      const [r] = await pool.query(`INSERT INTO ${table} (tenant_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, [t, ...keys.map((k) => v[k])]);
      id = Number(r.insertId);
    }
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict(`There is already a ${table === 'funds' ? 'fund' : 'department'} with that name`);
    throw err;
  }
  await audit(pool, req, id ? 'update' : 'create', table, id, b);
  return id;
}
router.post('/departments', muniOnly, manager, validate(z.object(deptFields)), async (req, res) => res.status(201).json({ id: await saveBook(req, 'departments', null, req.body) }));
router.patch('/departments/:id', muniOnly, manager, validate(z.object(deptFields).partial()), async (req, res) => { await saveBook(req, 'departments', paramId(req), req.body); res.json({ ok: true }); });
router.post('/funds', muniOnly, manager, validate(z.object(fundFields)), async (req, res) => res.status(201).json({ id: await saveBook(req, 'funds', null, req.body) }));
router.patch('/funds/:id', muniOnly, manager, validate(z.object(fundFields).partial()), async (req, res) => { await saveBook(req, 'funds', paramId(req), req.body); res.json({ ok: true }); });

// ---------------------------------------------------------------- labor rates (managers: it is pay)
const STAFF_SQL = `SELECT s.id, CONCAT(p.first_name, ' ', p.last_name) AS name, s.status FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
  WHERE s.tenant_id = ? AND s.status IN ('active','onboarding') ORDER BY p.first_name, p.last_name`;
router.get('/labor-rates', muniOnly, manager, async (req, res) => {
  const t = req.auth.tenantId;
  const A = require('../lib/assets');
  const [staff, rates, s] = await Promise.all([rows(pool, STAFF_SQL, [t]), rows(pool, 'SELECT staff_id, rate_cents FROM staff_labor_rates WHERE tenant_id = ?', [t]), A.ensureSettings(pool, t)]);
  const by = new Map(rates.map((r) => [Number(r.staff_id), Number(r.rate_cents)]));
  res.json({ shop_rate_cents: Number(s.labor_rate_cents), data: staff.map((x) => ({ staff_id: Number(x.id), name: x.name, rate_cents: by.has(Number(x.id)) ? by.get(Number(x.id)) : null })) });
});
router.put('/labor-rates/:staffId', muniOnly, manager, validate(z.object({ rate_cents: money.max(1000000).nullable() })), async (req, res) => {
  const t = req.auth.tenantId; const staffId = paramId(req, 'staffId');
  if (!(await one(pool, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, staffId]))) throw notFound('Staff member');
  if (req.body.rate_cents === null) await pool.query('DELETE FROM staff_labor_rates WHERE tenant_id = ? AND staff_id = ?', [t, staffId]);
  else await pool.query('INSERT INTO staff_labor_rates (tenant_id, staff_id, rate_cents, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE rate_cents = VALUES(rate_cents), updated_by = VALUES(updated_by)', [t, staffId, req.body.rate_cents, req.auth.userId]);
  await audit(pool, req, 'labor_rate', 'staff', staffId, { rate_cents: req.body.rate_cents });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- what Mark done chooses from
router.get('/cost-pickers', async (req, res) => {
  const t = req.auth.tenantId;
  const muni = await W.ensureBooks(pool, t);
  const see = isManager(req);
  const [staff, equipment, parts, b, streets, vendors] = await Promise.all([
    rows(pool, STAFF_SQL, [t]),
    rows(pool, "SELECT id, name, asset_tag, kind, hourly_rate_cents FROM ops_assets WHERE tenant_id = ? AND category IN ('fleet','equipment') AND status <> 'retired' ORDER BY name", [t]),
    rows(pool, 'SELECT id, sku, name, unit, qty_on_hand, unit_cost_cents FROM parts WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]),
    muni ? W.books(pool, t) : { departments: [], funds: [] },
    muni ? rows(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]) : [],
    see ? rows(pool, 'SELECT id, name FROM vendors WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]) : [],
  ]);
  res.json({
    staff: staff.map((s) => ({ id: Number(s.id), name: s.name })),
    equipment: equipment.map((a) => { const r = W.equipmentRate(a); return { id: Number(a.id), name: a.name, tag: a.asset_tag, ...(see ? { rate_cents: r.cents, suggested: r.suggested } : {}) }; }),
    parts: parts.map((p) => ({ id: Number(p.id), sku: p.sku, name: p.name, unit: p.unit, qty_on_hand: Number(p.qty_on_hand), ...(see ? { unit_cost_cents: Number(p.unit_cost_cents) } : {}) })),
    departments: b.departments.filter((d) => d.active), funds: b.funds.filter((f) => f.active), streets: streets.map((s) => ({ id: Number(s.id), name: s.name })), vendors,
    is_muni: muni, can_manage: see,
  });
});

// ---------------------------------------------------------------- equipment and materials on a work order
const equipLine = z.object({ asset_id: z.number().int().positive(), hours: z.number().positive().max(500), used_on: nullable(dateStr), note: nullable(z.string().max(255)) });
const materialLine = z.object({ description: z.string().trim().min(1).max(150), qty: z.number().positive().max(1000000), unit: nullable(z.string().trim().max(20)), unit_cost_cents: money.optional(), used_on: nullable(dateStr) });
router.post('/work-orders/:id/equipment', validate(equipLine), async (req, res) => res.status(201).json({ id: await tx((conn) => W.addEquipment(conn, req, paramId(req), req.body)) }));
router.delete('/work-orders/:id/equipment/:rowId', async (req, res) => { await tx((conn) => W.removeLine(conn, req, paramId(req), 'equipment', paramId(req, 'rowId'))); res.status(204).end(); });
router.post('/work-orders/:id/materials', validate(materialLine), async (req, res) => res.status(201).json({ id: await tx((conn) => W.addMaterial(conn, req, paramId(req), req.body)) }));
router.delete('/work-orders/:id/materials/:rowId', async (req, res) => { await tx((conn) => W.removeLine(conn, req, paramId(req), 'materials', paramId(req, 'rowId'))); res.status(204).end(); });

// The lines Mark done and Add costs record together, all or nothing (a part short in stock saves none of it).
const linesFields = {
  worked_on: nullable(dateStr),
  labor: z.array(z.object({ staff_id: nullable(z.number().int().positive()), worker: nullable(z.string().trim().max(100)), hours: z.number().positive().max(200) })
    .refine((l) => l.staff_id || l.worker, 'Say who worked')).max(30).default([]),
  equipment: z.array(equipLine.omit({ used_on: true })).max(30).default([]),
  parts: z.array(z.object({ part_id: z.number().int().positive(), qty: z.number().positive().max(100000) })).max(40).default([]),
  materials: z.array(materialLine.omit({ used_on: true })).max(40).default([]),
  vendor_id: nullable(z.number().int().positive()), vendor_cost_cents: nullable(money),
  downtime_hours: nullable(z.number().min(0).max(100000)),
  department_id: nullable(z.number().int().positive()), fund_id: nullable(z.number().int().positive()), street_id: nullable(z.number().int().positive()),
};

/** Records the lines inside the caller's transaction. The order is locked and must be open. */
async function addLines(conn, req, id, b) {
  const t = req.auth.tenantId;
  if ((b.vendor_cost_cents !== undefined || b.vendor_id !== undefined) && !isManager(req)) throw forbidden('Only a manager records outside costs');
  if ((b.department_id !== undefined || b.fund_id !== undefined) && !isManager(req)) throw forbidden('Only a manager chooses the department and fund');
  const w = await one(conn, 'SELECT id, status FROM work_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
  if (!w) throw notFound('Work order');
  if (w.status === 'cancelled') throw conflict('This work order was canceled');
  const day = b.worked_on || todayIn(await tzOf(t));
  for (const l of b.labor) await W.addLabor(conn, req, id, { ...l, worked_on: day });
  for (const e of b.equipment) await W.addEquipment(conn, req, id, { ...e, used_on: day });
  for (const p of b.parts) await W.issuePart(conn, req, id, p);
  for (const m of b.materials) await W.addMaterial(conn, req, id, { ...m, used_on: day });
  const set = {};
  for (const k of ['vendor_id', 'vendor_cost_cents', 'downtime_hours', 'department_id', 'fund_id', 'street_id']) if (b[k] !== undefined) set[k] = b[k];
  for (const [k, table, what] of [['vendor_id', 'vendors', 'Vendor'], ['department_id', 'departments', 'Department'], ['fund_id', 'funds', 'Fund'], ['street_id', 'streets', 'Street']]) {
    if (b[k] && !(await one(conn, `SELECT id FROM ${table} WHERE tenant_id = ? AND id = ?`, [t, b[k]]))) throw notFound(what);
  }
  if (Object.keys(set).length) {
    await W.fillBooks(conn, t, { ids: [id] });
    const keys = Object.keys(set);
    await conn.query(`UPDATE work_orders SET ${keys.map((k) => `${k} = ?`).join(', ')}${keys.some((k) => ['department_id', 'fund_id', 'street_id'].includes(k)) ? ', books_checked = 1' : ''} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => set[k]), t, id]);
  }
  await audit(conn, req, 'costs', 'work_orders', id, { labor: b.labor.length, equipment: b.equipment.length, parts: b.parts.length, materials: b.materials.length, ...(set.vendor_cost_cents !== undefined ? { vendor: true } : {}) });
  return w;
}
const answer = async (req, id) => {
  const c = (await W.orderCosts(pool, req.auth.tenantId, [id])).get(id);
  return { ok: true, labor_hours: c.labor_hours, ...(isManager(req) ? { total_cents: c.total_cents } : {}) };
};

/** Add costs to a work order (open or done): each person's hours, equipment, parts, materials, the outside bill. */
router.post('/work-orders/:id/cost-lines', validate(z.object(linesFields)), async (req, res) => {
  const id = paramId(req);
  await tx((conn) => addLines(conn, req, id, req.body));
  res.status(201).json(await answer(req, id));
});

/**
 * Mark done, with its costs, in one go: what was done, each person's hours, equipment hours, parts from stock, one-off
 * materials, the outside vendor's bill (a manager's), time out of service, and (a manager's) the department and fund.
 */
router.post('/work-orders/:id/complete', validate(z.object({ resolution: z.string().trim().min(1, 'Say what was done').max(500), ...linesFields })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const maintenance = require('./maintenance');
  const fixed = await tx(async (conn) => {
    const w = await one(conn, 'SELECT status FROM work_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (w && w.status === 'done') throw conflict('This work order is already done');
    await addLines(conn, req, id, req.body);
    return maintenance.changeStatus(conn, req, id, { status: 'done', resolution: req.body.resolution });
  });
  if (fixed.length) await require('../lib/requests').tellFixed(t, fixed, require('../lib/baseurl').baseUrl(req));
  res.json(await answer(req, id));
});

// ---------------------------------------------------------------- the monthly report (managers)
async function report(req) {
  const t = req.auth.tenantId;
  const month = req.query.month ? first(req.query.month) : todayIn(await tzOf(t)).slice(0, 7);
  if (!R.monthDays(month)) throw bad('Month must be like 2026-10');
  const { on } = await require('../lib/modules').stateOf(t);
  return R.build(pool, t, month, on);
}
router.get('/month-report', muniOnly, manager, async (req, res) => {
  const r = await report(req);
  await audit(pool, req, 'report', 'work_orders', null, { month: r.month, format: 'print' });
  res.set('Cache-Control', 'private, no-store').json(r);
});
router.get('/month-report.csv', muniOnly, manager, async (req, res) => {
  const r = await report(req);
  const { cols, data } = R.csvRows(r);
  await audit(pool, req, 'export', 'work_orders', null, { month: r.month, format: 'csv', rows: data.length });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="monthly-report-${r.month}.csv"`, 'Cache-Control': 'private, no-store' }).send(require('../lib/csv').toCsv(cols, data));
});
/** A highlight's photo for the report (which is a public record): where it was taken is removed. */
router.get('/month-report/photos/:kind/:id', muniOnly, manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const table = { request: 'request_photos', asset: 'asset_photos' }[req.params.kind];
  if (!table) throw notFound('Photo');
  const p = await one(pool, `SELECT original, mime FROM ${table} WHERE tenant_id = ? AND id = ?`, [t, id]);
  const clean = p ? require('../lib/exif').stripGps(p.original) : null;
  if (!clean) throw notFound('Photo'); // a kind of picture that cannot be cleaned is not put in the report
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, no-store' }).send(clean);
});

module.exports = router;
