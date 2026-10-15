'use strict';

// Maintenance and mountain operations: the fleet, work orders, recurring jobs, lift inspections, lift downtime,
// shift handoffs and the daily mountain report. Staff, patrol and managers read and write; a manager removes records.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, dateTimeStr, validate, paramId, normDateTime, setClause, todayIn, nowIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const O = require('../lib/ops');

const router = express.Router();
const crew = requireRole('staff', 'manager', 'patrol');
const manager = requireRole('manager');
router.use(crew);

const tenantTz = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const first = (v) => String(Array.isArray(v) ? v[0] : v);
const nullable = (s) => s.nullable().optional();
const when = dateTimeStr.transform(normDateTime);
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const stamp = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v ? String(v).slice(0, 19).replace('T', ' ') : null);

router.get('/meta', (_req, res) => res.json({ asset_kinds: O.ASSET_KINDS, surfaces: O.SURFACES, downtime_reasons: O.DOWNTIME_REASONS, departments: O.DEPARTMENTS, lift_checklist: O.LIFT_CHECKLIST }));

async function whoIs(conn, req) {
  const u = await one(conn, "SELECT COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), u.email, u.username) AS name FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE u.tenant_id = ? AND u.id = ?", [req.auth.tenantId, req.auth.userId]);
  return u ? u.name : null;
}
async function mustExist(conn, table, tenantId, id, what) {
  if (id && !(await one(conn, `SELECT id FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [tenantId, id]))) throw notFound(what);
}

// ---------------------------------------------------------------- fleet
const assetFields = {
  name: z.string().min(1).max(100),
  kind: z.string().refine((k) => O.ASSET_KIND_KEYS.includes(k), 'Unknown equipment type'),
  make_model: nullable(z.string().max(100)),
  serial: nullable(z.string().max(80)),
  hours: z.number().min(0).max(9999999).optional(),
  status: z.enum(['in_service', 'needs_service', 'out_of_service', 'retired']).optional(),
  notes: nullable(z.string().max(500)),
};
const ASSET_COLS = ['name', 'kind', 'make_model', 'serial', 'hours', 'status', 'notes'];
// Only the core columns: purchase prices, VINs and the rest of the Assets add-on stay behind its own (gated) routes.
const CORE_ASSET = 'a.id, a.tenant_id, a.name, a.kind, a.make_model, a.serial, a.hours, a.status, a.notes, a.asset_tag';

router.get('/assets', async (req, res) => {
  const where = ['a.tenant_id = ?']; const params = [req.auth.tenantId];
  if (req.query.kind) { where.push('a.kind = ?'); params.push(first(req.query.kind)); }
  if (req.query.all !== '1') where.push("a.status <> 'retired'");
  const data = await rows(pool, `SELECT ${CORE_ASSET} , (SELECT COUNT(*) FROM work_orders w WHERE w.tenant_id = a.tenant_id AND w.asset_id = a.id AND w.status NOT IN ('done','cancelled')) AS open_orders
    FROM ops_assets a WHERE ${where.join(' AND ')} ORDER BY a.kind, a.name`, params);
  res.json({ data: data.map((a) => ({ ...a, hours: Number(a.hours) })) });
});

router.post('/assets', validate(z.object(assetFields)), async (req, res) => {
  const keys = Object.keys(req.body).filter((k) => ASSET_COLS.includes(k));
  try {
    const [r] = await pool.query(`INSERT INTO ops_assets (tenant_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`, [req.auth.tenantId, ...keys.map((k) => req.body[k])]);
    await audit(pool, req, 'create', 'ops_assets', r.insertId);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already equipment with that name');
    throw err;
  }
});

router.patch('/assets/:id', validate(partialOf(assetFields)), async (req, res) => {
  const id = paramId(req);
  const set = setClause(req.body, ASSET_COLS);
  if (!set) throw bad('No updatable fields supplied');
  try {
    if (req.body.hours !== undefined) {
      const a = await one(pool, 'SELECT hours FROM ops_assets WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
      if (!a) throw notFound('Equipment');
      if (req.body.hours < Number(a.hours) && req.auth.role !== 'owner' && req.auth.role !== 'manager') throw bad('The hour meter only goes up. Ask a manager to correct it.');
    }
    const [r] = await pool.query(`UPDATE ops_assets SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    if (!r.affectedRows) throw notFound('Equipment');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already equipment with that name');
    throw err;
  }
  await audit(pool, req, 'update', 'ops_assets', id, req.body);
  res.json({ ok: true });
});

/** Record a new hour meter reading. */
router.post('/assets/:id/hours', validate(z.object({ hours: z.number().min(0).max(9999999) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const a = await one(conn, 'SELECT hours FROM ops_assets WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!a) throw notFound('Equipment');
    if (req.body.hours < Number(a.hours)) throw bad(`The meter reads ${Number(a.hours)} hours already. It only goes up.`);
    await conn.query('UPDATE ops_assets SET hours = ? WHERE tenant_id = ? AND id = ?', [req.body.hours, req.auth.tenantId, id]);
    await audit(conn, req, 'meter', 'ops_assets', id, { hours: req.body.hours });
  });
  res.json({ ok: true });
});

router.delete('/assets/:id', manager, async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM ops_assets WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
    if (!r.affectedRows) throw notFound('Equipment');
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') throw conflict('This equipment has a history. Mark it retired instead.');
    throw err;
  }
  res.status(204).end();
});

// ---------------------------------------------------------------- work orders
const orderFields = {
  title: z.string().min(1).max(150),
  description: nullable(z.string().max(5000)),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  asset_id: nullable(z.number().int().positive()),
  lift_id: nullable(z.number().int().positive()),
  location: nullable(z.string().max(120)),
  assigned_staff_id: nullable(z.number().int().positive()),
  due_date: nullable(dateStr),
};
const ORDER_SQL = `SELECT w.id, w.tenant_id, w.title, w.description, w.priority, w.status, w.asset_id, w.lift_id, w.location, w.source, w.assigned_staff_id,
    w.due_date, w.opened_at, w.opened_by, w.completed_at, w.labor_hours, w.parts_note, w.resolution, w.pm_task_id, a.name AS asset, l.name AS lift, CONCAT(p.first_name, ' ', p.last_name) AS assignee
  FROM work_orders w
  LEFT JOIN ops_assets a ON a.tenant_id = w.tenant_id AND a.id = w.asset_id
  LEFT JOIN lifts l ON l.tenant_id = w.tenant_id AND l.id = w.lift_id
  LEFT JOIN staff s ON s.tenant_id = w.tenant_id AND s.id = w.assigned_staff_id
  LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id`;

async function createOrder(conn, req, b, source = 'manual') {
  await mustExist(conn, 'ops_assets', req.auth.tenantId, b.asset_id, 'Equipment');
  await mustExist(conn, 'lifts', req.auth.tenantId, b.lift_id, 'Lift');
  await mustExist(conn, 'staff', req.auth.tenantId, b.assigned_staff_id, 'Staff member');
  const [r] = await conn.query('INSERT INTO work_orders (tenant_id, title, description, priority, asset_id, lift_id, location, source, assigned_staff_id, due_date, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.title, b.description ?? null, b.priority || 'normal', b.asset_id ?? null, b.lift_id ?? null, b.location ?? null, source, b.assigned_staff_id ?? null, b.due_date ?? null, req.auth.userId]);
  await audit(conn, req, 'create', 'work_orders', r.insertId, { source });
  return r.insertId;
}

router.get('/work-orders', async (req, res) => {
  const where = ['w.tenant_id = ?']; const params = [req.auth.tenantId];
  const status = first(req.query.status || 'open');
  if (status === 'open') where.push("w.status NOT IN ('done','cancelled')");
  else if (status === 'closed') where.push("w.status IN ('done','cancelled')");
  else if (status !== 'all') { where.push('w.status = ?'); params.push(status); }
  if (req.query.asset_id) { where.push('w.asset_id = ?'); params.push(Number(first(req.query.asset_id))); }
  if (req.query.lift_id) { where.push('w.lift_id = ?'); params.push(Number(first(req.query.lift_id))); }
  if (req.query.mine === '1' && req.auth.staffId) { where.push('w.assigned_staff_id = ?'); params.push(req.auth.staffId); }
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  res.json({ data: await rows(pool, `${ORDER_SQL} WHERE ${where.join(' AND ')} ORDER BY FIELD(w.priority, 'urgent', 'high', 'normal', 'low'), w.opened_at DESC LIMIT ?`, [...params, limit]) });
});

router.get('/work-orders/:id', async (req, res) => {
  const id = paramId(req);
  const w = await one(pool, `${ORDER_SQL} WHERE w.tenant_id = ? AND w.id = ?`, [req.auth.tenantId, id]);
  if (!w) throw notFound('Work order');
  const notes = await rows(pool, "SELECT n.id, n.at, n.body, COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), u.email, u.username) AS author FROM work_order_notes n LEFT JOIN users u ON u.tenant_id = n.tenant_id AND u.id = n.user_id LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE n.tenant_id = ? AND n.work_order_id = ? ORDER BY n.id", [req.auth.tenantId, id]);
  res.json({ ...w, notes });
});

router.post('/work-orders', validate(z.object(orderFields)), async (req, res) => {
  const id = await tx((conn) => createOrder(conn, req, req.body));
  res.status(201).json({ id });
});

router.patch('/work-orders/:id', validate(partialOf(orderFields)), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await mustExist(conn, 'ops_assets', req.auth.tenantId, req.body.asset_id, 'Equipment');
    await mustExist(conn, 'lifts', req.auth.tenantId, req.body.lift_id, 'Lift');
    await mustExist(conn, 'staff', req.auth.tenantId, req.body.assigned_staff_id, 'Staff member');
    const set = setClause(req.body, Object.keys(orderFields));
    if (!set) throw bad('No updatable fields supplied');
    const [r] = await conn.query(`UPDATE work_orders SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    if (!r.affectedRows) throw notFound('Work order');
    await audit(conn, req, 'update', 'work_orders', id, Object.keys(req.body));
  });
  res.json({ ok: true });
});

const STATUS_TEXT = { open: 'Reopened', in_progress: 'Work started', waiting_parts: 'Waiting for parts', done: 'Completed', cancelled: 'Cancelled' };
router.post('/work-orders/:id/status', validate(z.object({
  status: z.enum(['open', 'in_progress', 'waiting_parts', 'done', 'cancelled']),
  labor_hours: nullable(z.number().min(0).max(999)), parts_note: nullable(z.string().max(255)), resolution: nullable(z.string().max(500)),
})), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const w = await one(conn, 'SELECT status, pm_task_id, meter_hours, meter_miles FROM work_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!w) throw notFound('Work order');
    const b = req.body;
    if (b.status === 'done' && !b.resolution && !(await one(conn, 'SELECT 1 AS x FROM work_orders WHERE tenant_id = ? AND id = ? AND resolution IS NOT NULL', [req.auth.tenantId, id]))) throw bad('Say what was done before completing the work order');
    const done = b.status === 'done' || b.status === 'cancelled';
    await conn.query('UPDATE work_orders SET status = ?, completed_at = ?, labor_hours = COALESCE(?, labor_hours), parts_note = COALESCE(?, parts_note), resolution = COALESCE(?, resolution) WHERE tenant_id = ? AND id = ?',
      [b.status, done ? nowIn(await tenantTz(req.auth.tenantId)) : null, b.labor_hours ?? null, b.parts_note ?? null, b.resolution ?? null, req.auth.tenantId, id]);
    await conn.query('INSERT INTO work_order_notes (tenant_id, work_order_id, user_id, body) VALUES (?, ?, ?, ?)', [req.auth.tenantId, id, req.auth.userId, `${STATUS_TEXT[b.status]}${b.resolution ? `: ${b.resolution}` : ''}`]);
    // A preventive work order that is completed marks its service plan done, at the meters recorded on the order.
    // Only once per order: an order reopened and completed again does not count as a second service.
    if (b.status === 'done' && w.pm_task_id && w.status !== 'done') {
      const t = await one(conn, 'SELECT * FROM pm_tasks WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, w.pm_task_id]);
      const already = await one(conn, 'SELECT id FROM pm_log WHERE tenant_id = ? AND work_order_id = ?', [req.auth.tenantId, id]);
      if (t && !already) await markPmDone(conn, req, t, { on: todayIn(await tenantTz(req.auth.tenantId)), hours: w.meter_hours === null ? undefined : Number(w.meter_hours), miles: w.meter_miles === null ? undefined : Number(w.meter_miles), note: `Work order ${id}`, workOrderId: id });
    }
    await audit(conn, req, 'status', 'work_orders', id, { from: w.status, to: b.status });
  });
  res.json({ ok: true });
});

router.post('/work-orders/:id/notes', validate(z.object({ body: z.string().min(1).max(1000) })), async (req, res) => {
  const id = paramId(req);
  await mustExist(pool, 'work_orders', req.auth.tenantId, id, 'Work order');
  await pool.query('INSERT INTO work_order_notes (tenant_id, work_order_id, user_id, body) VALUES (?, ?, ?, ?)', [req.auth.tenantId, id, req.auth.userId, req.body.body]);
  res.status(201).json({ ok: true });
});

router.delete('/work-orders/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM work_orders WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Work order');
  res.status(204).end();
});

// ---------------------------------------------------------------- recurring (preventive) jobs
const pmFields = {
  name: z.string().min(1).max(150),
  asset_id: nullable(z.number().int().positive()),
  lift_id: nullable(z.number().int().positive()),
  interval_days: nullable(z.number().int().min(1).max(3650)),
  interval_hours: nullable(z.number().min(1).max(100000)),
  interval_miles: nullable(z.number().min(1).max(1000000)),
  checklist: nullable(z.string().max(2000)),
  notes: nullable(z.string().max(500)),
  active: z.boolean().optional(),
};
const needsInterval = (b) => { if (!b.interval_days && !b.interval_hours && !b.interval_miles) throw bad('Say how often: every so many days, hours or miles'); if ((b.interval_hours || b.interval_miles) && !b.asset_id) throw bad('An hour or mile based job needs the machine it is counted on'); };
const PM_SQL = `SELECT t.*, a.name AS asset, a.hours AS asset_hours, a.miles AS asset_miles, l.name AS lift FROM pm_tasks t
  LEFT JOIN ops_assets a ON a.tenant_id = t.tenant_id AND a.id = t.asset_id LEFT JOIN lifts l ON l.tenant_id = t.tenant_id AND l.id = t.lift_id`;
const RANK = { overdue: 0, soon: 1, never: 2, ok: 3 };
/** The machine's meters for pmStatus, from a row with asset_hours and asset_miles. */
const meters = (t) => (t.asset_id ? { hours: t.asset_hours === null ? null : Number(t.asset_hours), miles: t.asset_miles === null || t.asset_miles === undefined ? null : Number(t.asset_miles) } : null);

router.get('/pm', async (req, res) => {
  const today = todayIn(await tenantTz(req.auth.tenantId));
  const data = (await rows(pool, `${PM_SQL} WHERE t.tenant_id = ? ${req.query.all === '1' ? '' : 'AND t.active = 1'}`, [req.auth.tenantId])).map((t) => ({
    ...t, last_done_on: ymd(t.last_done_on), asset_hours: t.asset_hours === null ? null : Number(t.asset_hours), asset_miles: t.asset_miles === null ? null : Number(t.asset_miles),
    ...O.pmStatus(t, meters(t), today),
  }));
  data.sort((a, b) => RANK[a.state] - RANK[b.state] || String(a.due_on || '9').localeCompare(String(b.due_on || '9')) || a.name.localeCompare(b.name));
  res.json({ data });
});

router.post('/pm', validate(z.object(pmFields)), async (req, res) => {
  needsInterval(req.body);
  const b = req.body;
  await mustExist(pool, 'ops_assets', req.auth.tenantId, b.asset_id, 'Equipment');
  await mustExist(pool, 'lifts', req.auth.tenantId, b.lift_id, 'Lift');
  const [r] = await pool.query('INSERT INTO pm_tasks (tenant_id, name, asset_id, lift_id, interval_days, interval_hours, interval_miles, checklist, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.name, b.asset_id ?? null, b.lift_id ?? null, b.interval_days ?? null, b.interval_hours ?? null, b.interval_miles ?? null, b.checklist ?? null, b.notes ?? null]);
  await audit(pool, req, 'create', 'pm_tasks', r.insertId);
  res.status(201).json({ id: r.insertId });
});

router.patch('/pm/:id', validate(partialOf(pmFields)), async (req, res) => {
  const id = paramId(req);
  const cur = await one(pool, 'SELECT * FROM pm_tasks WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!cur) throw notFound('Recurring job');
  needsInterval({ ...cur, ...req.body });
  await mustExist(pool, 'ops_assets', req.auth.tenantId, req.body.asset_id, 'Equipment');
  await mustExist(pool, 'lifts', req.auth.tenantId, req.body.lift_id, 'Lift');
  const set = setClause(req.body, [...Object.keys(pmFields)]);
  if (!set) throw bad('No updatable fields supplied');
  await pool.query(`UPDATE pm_tasks SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
  res.json({ ok: true });
});

/** Marks a service plan done: on a date, at the machine's meter readings. Used by "done" and by completing its work order. */
async function markPmDone(conn, req, t, { on, hours, miles, note, workOrderId = null }) {
  const a = t.asset_id ? await one(conn, 'SELECT hours, miles FROM ops_assets WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, t.asset_id]) : null;
  const h = hours ?? (a ? Number(a.hours) : null);
  const m = miles ?? (a && a.miles !== null ? Number(a.miles) : null);
  await conn.query('INSERT INTO pm_log (tenant_id, pm_task_id, done_on, hours, user_id, note, work_order_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, t.id, on, h, req.auth.userId, note ?? null, workOrderId]);
  await conn.query('UPDATE pm_tasks SET last_done_on = ?, last_done_hours = ?, last_done_miles = ? WHERE tenant_id = ? AND id = ?', [on, h, m, req.auth.tenantId, t.id]);
}

/** Record that the job was done. Hours and miles default to the machine's current meters, the date to today. */
router.post('/pm/:id/done', validate(z.object({ done_on: nullable(dateStr), hours: z.number().min(0).max(9999999).nullable().optional(), miles: z.number().min(0).max(99999999).nullable().optional(), note: nullable(z.string().max(255)) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const t = await one(conn, 'SELECT * FROM pm_tasks WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!t) throw notFound('Recurring job');
    const on = req.body.done_on || todayIn(await tenantTz(req.auth.tenantId));
    await markPmDone(conn, req, t, { on, hours: req.body.hours, miles: req.body.miles, note: req.body.note });
    await audit(conn, req, 'done', 'pm_tasks', id, { on });
  });
  res.json({ ok: true });
});

router.get('/pm/:id/log', async (req, res) => {
  const id = paramId(req);
  await mustExist(pool, 'pm_tasks', req.auth.tenantId, id, 'Recurring job');
  res.json({ data: (await rows(pool, 'SELECT id, done_on, hours, note FROM pm_log WHERE tenant_id = ? AND pm_task_id = ? ORDER BY done_on DESC, id DESC LIMIT 50', [req.auth.tenantId, id])).map((r) => ({ ...r, done_on: ymd(r.done_on) })) });
});

/** Turn a job that has come due into a work order someone can pick up. */
router.post('/pm/:id/work-order', async (req, res) => {
  const id = paramId(req);
  const out = await tx(async (conn) => {
    // Locked, so two quick taps make one work order, not two.
    const t = await one(conn, 'SELECT * FROM pm_tasks WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!t) throw notFound('Recurring job');
    const open = await one(conn, "SELECT id FROM work_orders WHERE tenant_id = ? AND pm_task_id = ? AND status NOT IN ('done','cancelled')", [req.auth.tenantId, id]);
    if (open) return open.id; // one open work order per plan
    const description = [t.notes, t.checklist ? `Checklist:\n${t.checklist}` : null].filter(Boolean).join('\n\n') || null;
    const woId = await createOrder(conn, req, { title: t.name, description, priority: 'normal', asset_id: t.asset_id, lift_id: t.lift_id }, 'preventive');
    await conn.query('UPDATE work_orders SET pm_task_id = ? WHERE tenant_id = ? AND id = ?', [id, req.auth.tenantId, woId]);
    return woId;
  });
  res.status(201).json({ id: out });
});

router.delete('/pm/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM pm_tasks WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Recurring job');
  res.status(204).end();
});

// ---------------------------------------------------------------- lift inspections
const itemSchema = z.object({ key: z.string(), result: z.enum(['pass', 'fail', 'na']), note: nullable(z.string().max(255)) });
const checkSchema = z.object({
  lift_id: z.number().int().positive(),
  check_date: nullable(dateStr),
  kind: z.enum(['pre_open', 'post_close']).default('pre_open'),
  inspector: nullable(z.string().max(100)),
  note: nullable(z.string().max(500)),
  items: z.array(itemSchema).min(1),
});

/** Every lift with its latest pre-opening inspection on the date (today by default). */
router.get('/lift-checks/day', async (req, res) => {
  const date = req.query.date ? first(req.query.date) : todayIn(await tenantTz(req.auth.tenantId));
  if (!dateStr.safeParse(date).success) throw bad('Use YYYY-MM-DD');
  const data = await rows(pool, `SELECT l.id AS lift_id, l.name, l.status, c.id AS check_id, c.result, c.inspector, c.checked_at, c.work_order_id
    FROM lifts l LEFT JOIN lift_checks c ON c.tenant_id = l.tenant_id AND c.lift_id = l.id AND c.check_date = ? AND c.kind = 'pre_open'
      AND c.id = (SELECT MAX(x.id) FROM lift_checks x WHERE x.tenant_id = l.tenant_id AND x.lift_id = l.id AND x.check_date = ? AND x.kind = 'pre_open')
    WHERE l.tenant_id = ? ORDER BY l.name`, [date, date, req.auth.tenantId]);
  res.json({ data, date });
});

router.get('/lift-checks', async (req, res) => {
  const where = ['c.tenant_id = ?']; const params = [req.auth.tenantId];
  if (req.query.lift_id) { where.push('c.lift_id = ?'); params.push(Number(first(req.query.lift_id))); }
  if (req.query.from) { where.push('c.check_date >= ?'); params.push(first(req.query.from)); }
  if (req.query.to) { where.push('c.check_date <= ?'); params.push(first(req.query.to)); }
  const data = await rows(pool, `SELECT c.id, c.lift_id, l.name AS lift, c.check_date, c.kind, c.result, c.inspector, c.checked_at, c.note, c.work_order_id, c.items
    FROM lift_checks c JOIN lifts l ON l.tenant_id = c.tenant_id AND l.id = c.lift_id WHERE ${where.join(' AND ')} ORDER BY c.check_date DESC, c.id DESC LIMIT ?`, [...params, Math.min(Number(req.query.limit) || 100, 500)]);
  res.json({ data: data.map((c) => ({ ...c, check_date: ymd(c.check_date), items: JSON.parse(c.items) })) });
});

router.post('/lift-checks', validate(checkSchema), async (req, res) => {
  const b = req.body;
  const out = await tx(async (conn) => {
    const lift = await one(conn, 'SELECT id, name FROM lifts WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, b.lift_id]);
    if (!lift) throw notFound('Lift');
    const keys = O.LIFT_CHECKLIST.map((i) => i.key);
    const given = new Map(b.items.map((i) => [i.key, i]));
    if ([...given.keys()].some((k) => !keys.includes(k))) throw bad('Unknown inspection item');
    const missing = O.LIFT_CHECKLIST.filter((i) => !given.has(i.key));
    if (missing.length) throw bad(`Answer every item. Missing: ${missing.map((m) => m.label).join('; ')}`);
    const items = O.LIFT_CHECKLIST.map((i) => ({ key: i.key, label: i.label, result: given.get(i.key).result, note: given.get(i.key).note || null }));
    const failed = items.filter((i) => i.result === 'fail');
    if (failed.some((i) => !i.note)) throw bad('Say what is wrong with each item that failed');
    const date = b.check_date || todayIn(await tenantTz(req.auth.tenantId));
    const inspector = b.inspector || (await whoIs(conn, req));
    let orderId = null;
    if (failed.length) {
      orderId = await createOrder(conn, req, {
        title: `Failed inspection: ${lift.name}`, description: failed.map((i) => `${i.label}: ${i.note}`).join('\n'), priority: 'high', lift_id: lift.id,
      }, 'inspection');
    }
    const [r] = await conn.query('INSERT INTO lift_checks (tenant_id, lift_id, check_date, kind, result, items, inspector, user_id, note, work_order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.auth.tenantId, lift.id, date, b.kind, failed.length ? 'fail' : 'pass', JSON.stringify(items), inspector, req.auth.userId, b.note ?? null, orderId]);
    await audit(conn, req, 'inspect', 'lift_checks', r.insertId, { lift_id: lift.id, result: failed.length ? 'fail' : 'pass' });
    return { id: r.insertId, result: failed.length ? 'fail' : 'pass', work_order_id: orderId };
  });
  res.status(201).json(out);
});

// ---------------------------------------------------------------- lift downtime
const downFields = {
  lift_id: z.number().int().positive(),
  started_at: when,
  ended_at: nullable(when),
  reason: z.enum(['wind', 'mechanical', 'electrical', 'weather', 'rescue', 'staffing', 'inspection', 'scheduled', 'other']).default('other'),
  note: nullable(z.string().max(255)),
  work_order_id: nullable(z.number().int().positive()),
};
const MINUTES = 'TIMESTAMPDIFF(MINUTE, d.started_at, COALESCE(d.ended_at, ?))';

router.get('/downtime', async (req, res) => {
  const now = nowIn(await tenantTz(req.auth.tenantId));
  const where = ['d.tenant_id = ?']; const params = [now, req.auth.tenantId];
  if (req.query.lift_id) { where.push('d.lift_id = ?'); params.push(Number(first(req.query.lift_id))); }
  if (req.query.from) { where.push('DATE(COALESCE(d.ended_at, ?)) >= ?'); params.push(now, first(req.query.from)); }
  if (req.query.to) { where.push('DATE(d.started_at) <= ?'); params.push(first(req.query.to)); }
  if (req.query.open === '1') where.push('d.ended_at IS NULL');
  const data = await rows(pool, `SELECT d.*, l.name AS lift, ${MINUTES} AS minutes FROM lift_downtime d JOIN lifts l ON l.tenant_id = d.tenant_id AND l.id = d.lift_id WHERE ${where.join(' AND ')} ORDER BY d.started_at DESC, d.id DESC LIMIT 300`, params);
  res.json({ data });
});

/** Total minutes down per lift and per reason, for a date range (defaults to the last 30 days). */
router.get('/downtime/summary', async (req, res) => {
  const tz = await tenantTz(req.auth.tenantId);
  const now = nowIn(tz);
  const to = req.query.to ? first(req.query.to) : todayIn(tz);
  const from = req.query.from ? first(req.query.from) : (() => { const d = new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 29); return d.toISOString().slice(0, 10); })();
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('Use YYYY-MM-DD');
  const base = `FROM lift_downtime d JOIN lifts l ON l.tenant_id = d.tenant_id AND l.id = d.lift_id WHERE d.tenant_id = ? AND DATE(d.started_at) BETWEEN ? AND ?`;
  const byLift = await rows(pool, `SELECT l.id AS lift_id, l.name AS lift, COUNT(*) AS events, SUM(${MINUTES}) AS minutes ${base} GROUP BY l.id, l.name ORDER BY minutes DESC`, [now, req.auth.tenantId, from, to]);
  const byReason = await rows(pool, `SELECT d.reason, COUNT(*) AS events, SUM(${MINUTES}) AS minutes ${base} GROUP BY d.reason ORDER BY minutes DESC`, [now, req.auth.tenantId, from, to]);
  res.json({ from, to, by_lift: byLift.map((r) => ({ ...r, minutes: Number(r.minutes) })), by_reason: byReason.map((r) => ({ ...r, minutes: Number(r.minutes) })) });
});

router.post('/downtime', validate(z.object(downFields)), async (req, res) => {
  const b = req.body;
  if (b.ended_at && b.ended_at < b.started_at) throw bad('The lift cannot restart before it stopped');
  await mustExist(pool, 'lifts', req.auth.tenantId, b.lift_id, 'Lift');
  await mustExist(pool, 'work_orders', req.auth.tenantId, b.work_order_id, 'Work order');
  const [r] = await pool.query('INSERT INTO lift_downtime (tenant_id, lift_id, started_at, ended_at, reason, note, work_order_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.lift_id, b.started_at, b.ended_at ?? null, b.reason, b.note ?? null, b.work_order_id ?? null, req.auth.userId]);
  res.status(201).json({ id: r.insertId });
});

router.patch('/downtime/:id', validate(partialOf({ started_at: when, ended_at: nullable(when), reason: downFields.reason, note: downFields.note, work_order_id: downFields.work_order_id })), async (req, res) => {
  const id = paramId(req);
  const cur = await one(pool, 'SELECT started_at, ended_at FROM lift_downtime WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!cur) throw notFound('Downtime entry');
  const start = req.body.started_at || stamp(cur.started_at);
  const end = req.body.ended_at !== undefined ? req.body.ended_at : stamp(cur.ended_at);
  if (end && end < start) throw bad('The lift cannot restart before it stopped');
  await mustExist(pool, 'work_orders', req.auth.tenantId, req.body.work_order_id, 'Work order');
  const set = setClause(req.body, ['started_at', 'ended_at', 'reason', 'note', 'work_order_id']);
  if (!set) throw bad('No updatable fields supplied');
  await pool.query(`UPDATE lift_downtime SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
  res.json({ ok: true });
});

router.delete('/downtime/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM lift_downtime WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Downtime entry');
  res.status(204).end();
});

// ---------------------------------------------------------------- shift handoffs
const handoffFields = {
  dept: z.enum(['grooming', 'lifts', 'snowmaking', 'maintenance', 'park', 'general']).default('general'),
  shift_date: nullable(dateStr),
  shift: z.enum(['day', 'night']).default('day'),
  body: z.string().min(1).max(2000),
};

router.get('/handoffs', async (req, res) => {
  const tz = await tenantTz(req.auth.tenantId);
  const today = todayIn(tz);
  const from = req.query.from ? first(req.query.from) : (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 2); return d.toISOString().slice(0, 10); })();
  const to = req.query.to ? first(req.query.to) : today;
  const where = ['tenant_id = ?', 'shift_date BETWEEN ? AND ?']; const params = [req.auth.tenantId, from, to];
  if (req.query.dept) { where.push('dept = ?'); params.push(first(req.query.dept)); }
  if (req.query.unacked === '1') where.push('ack_at IS NULL');
  const data = await rows(pool, `SELECT * FROM ops_handoffs WHERE ${where.join(' AND ')} ORDER BY shift_date DESC, id DESC LIMIT 200`, params);
  res.json({ data: data.map((r) => ({ ...r, shift_date: ymd(r.shift_date) })), from, to });
});

router.post('/handoffs', validate(z.object(handoffFields)), async (req, res) => {
  const b = req.body;
  const date = b.shift_date || todayIn(await tenantTz(req.auth.tenantId));
  const [r] = await pool.query('INSERT INTO ops_handoffs (tenant_id, dept, shift_date, shift, body, user_id, author) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, b.dept, date, b.shift, b.body, req.auth.userId, await whoIs(pool, req)]);
  await audit(pool, req, 'create', 'ops_handoffs', r.insertId);
  res.status(201).json({ id: r.insertId });
});

router.post('/handoffs/:id/ack', async (req, res) => {
  const id = paramId(req);
  const [r] = await pool.query('UPDATE ops_handoffs SET ack_by = ?, ack_at = ? WHERE tenant_id = ? AND id = ? AND ack_at IS NULL', [await whoIs(pool, req), nowIn(await tenantTz(req.auth.tenantId)), req.auth.tenantId, id]);
  if (!r.affectedRows) throw conflict('That note was already acknowledged, or does not exist');
  res.json({ ok: true });
});

router.delete('/handoffs/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM ops_handoffs WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Handoff note');
  res.status(204).end();
});

// ---------------------------------------------------------------- the daily mountain report
const WEATHER_SKY = { clear: 'Clear', partly: 'Partly cloudy', overcast: 'Overcast', snow: 'Snowing', rain: 'Raining', mixed: 'Mixed precipitation', fog: 'Fog' };
const num1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

router.get('/report', async (req, res) => {
  const t = req.auth.tenantId;
  const tz = await tenantTz(t);
  const today = todayIn(tz);
  const date = req.query.date ? first(req.query.date) : today;
  if (!dateStr.safeParse(date).success) throw bad('Use YYYY-MM-DD');
  const live = date === today;
  const now = nowIn(tz);
  const tenant = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [t]);

  const day = await one(pool, 'SELECT status, open_time, close_time, notes FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [t, date]);
  const lifts = await rows(pool, `SELECT l.id, l.name, l.status,
      COALESCE((SELECT SUM(TIMESTAMPDIFF(MINUTE, GREATEST(d.started_at, ?), LEAST(COALESCE(d.ended_at, ?), ?))) FROM lift_downtime d
        WHERE d.tenant_id = l.tenant_id AND d.lift_id = l.id AND d.started_at < ? AND COALESCE(d.ended_at, ?) > ?), 0) AS down_minutes,
      (SELECT c.result FROM lift_checks c WHERE c.tenant_id = l.tenant_id AND c.lift_id = l.id AND c.check_date = ? AND c.kind = 'pre_open' ORDER BY c.id DESC LIMIT 1) AS inspection
    FROM lifts l WHERE l.tenant_id = ? ORDER BY l.name`,
  [`${date} 00:00:00`, now, `${date} 23:59:59`, `${date} 23:59:59`, now, `${date} 00:00:00`, date, t]);
  const trails = await rows(pool, 'SELECT status, groomed, difficulty FROM trails WHERE tenant_id = ?', [t]);
  const plan = await rows(pool, `SELECT g.status, t.name AS trail FROM groom_plans g JOIN trails t ON t.tenant_id = g.tenant_id AND t.id = g.trail_id WHERE g.tenant_id = ? AND g.plan_date = ? ORDER BY g.priority`, [t, date]);
  const snow = await one(pool, 'SELECT base_in, new_snow_in, surface, quality, read_at FROM snow_readings WHERE tenant_id = ? AND trail_id IS NULL AND DATE(read_at) <= ? ORDER BY read_at DESC, id DESC LIMIT 1', [t, date]);
  const wx = await one(pool, 'SELECT MAX(temp_f) AS high, MIN(temp_f) AS low, MAX(wind_mph) AS wind, MAX(gust_mph) AS gust, COUNT(*) AS n FROM weather_logs WHERE tenant_id = ? AND DATE(logged_at) = ?', [t, date]);
  const wxLast = await one(pool, 'SELECT temp_f, wind_mph, wind_dir, sky, place, logged_at FROM weather_logs WHERE tenant_id = ? AND DATE(logged_at) = ? ORDER BY logged_at DESC, id DESC LIMIT 1', [t, date]);
  const making = await one(pool, `SELECT COUNT(*) AS runs, COALESCE(SUM(water_gal), 0) AS water, COALESCE(SUM(TIMESTAMPDIFF(MINUTE, started_at, COALESCE(ended_at, ?))), 0) AS minutes FROM snowmaking_runs WHERE tenant_id = ? AND DATE(started_at) = ?`, [now, t, date]);
  const orders = await rows(pool, "SELECT priority, title, status FROM work_orders WHERE tenant_id = ? AND status NOT IN ('done','cancelled') ORDER BY FIELD(priority, 'urgent', 'high', 'normal', 'low') LIMIT 200", [t]);
  const failed = await rows(pool, "SELECT l.name FROM lift_checks c JOIN lifts l ON l.tenant_id = c.tenant_id AND l.id = c.lift_id WHERE c.tenant_id = ? AND c.check_date = ? AND c.result = 'fail'", [t, date]);
  const pmRows = await rows(pool, `${PM_SQL} WHERE t.tenant_id = ? AND t.active = 1`, [t]);
  const pmOver = pmRows.filter((p) => O.pmStatus(p, meters(p), today).state === 'overdue').length;
  const notes = await rows(pool, 'SELECT dept, shift, body, author, ack_by FROM ops_handoffs WHERE tenant_id = ? AND shift_date = ? ORDER BY id', [t, date]);

  const liftsOpen = lifts.filter((l) => l.status === 'open').length;
  const trailsOpen = trails.filter((x) => x.status === 'open').length;
  const report = {
    date, live, mountain: tenant.name,
    day: day ? { status: day.status, open_time: day.open_time, close_time: day.close_time, notes: day.notes } : null,
    lifts: lifts.map((l) => ({ ...l, down_minutes: Number(l.down_minutes) })), lifts_open: liftsOpen, lifts_total: lifts.length,
    trails_open: trailsOpen, trails_total: trails.length, trails_groomed: trails.filter((x) => x.groomed).length,
    grooming: { planned: plan.length, done: plan.filter((p) => p.status === 'done').length, in_progress: plan.filter((p) => p.status === 'in_progress').length, skipped: plan.filter((p) => p.status === 'skipped').length, trails_done: plan.filter((p) => p.status === 'done').map((p) => p.trail) },
    snow: snow ? { base_in: num1(snow.base_in), new_snow_in: num1(snow.new_snow_in), surface: snow.surface, quality: snow.quality } : null,
    weather: wx && wx.n ? { high_f: num1(wx.high), low_f: num1(wx.low), max_wind_mph: wx.wind, max_gust_mph: wx.gust, latest: wxLast ? { temp_f: num1(wxLast.temp_f), wind_mph: wxLast.wind_mph, wind_dir: wxLast.wind_dir, sky: wxLast.sky, place: wxLast.place } : null } : null,
    snowmaking: { runs: Number(making.runs), hours: Math.round((Number(making.minutes) / 60) * 10) / 10, water_gal: Number(making.water) },
    maintenance: { open_orders: orders.length, urgent: orders.filter((o) => o.priority === 'urgent').length, high: orders.filter((o) => o.priority === 'high').length, failed_inspections: failed.map((f) => f.name), pm_overdue: pmOver },
    handoffs: notes,
  };
  report.text = reportText(report);
  res.json(report);
});

function reportText(r) {
  const L = [];
  L.push(`${r.mountain}: mountain report for ${r.date}`);
  if (r.day) L.push(`Status: ${r.day.status}${r.day.open_time ? `, ${String(r.day.open_time).slice(0, 5)} to ${r.day.close_time ? String(r.day.close_time).slice(0, 5) : '?'}` : ''}${r.day.notes ? `. ${r.day.notes}` : ''}`);
  if (r.live) L.push(`Lifts open: ${r.lifts_open} of ${r.lifts_total}. Trails open: ${r.trails_open} of ${r.trails_total}, ${r.trails_groomed} groomed.`);
  else L.push(`Lifts: ${r.lifts_total}. Trails: ${r.trails_total}.`);
  const down = r.lifts.filter((l) => l.down_minutes > 0);
  if (down.length) L.push(`Lift downtime: ${down.map((l) => `${l.name} ${Math.floor(l.down_minutes / 60)}h ${l.down_minutes % 60}m`).join(', ')}.`);
  if (r.grooming.planned) L.push(`Grooming: ${r.grooming.done} of ${r.grooming.planned} planned trails done${r.grooming.skipped ? `, ${r.grooming.skipped} skipped` : ''}.`);
  if (r.snow) L.push(`Snow: ${r.snow.base_in !== null ? `${r.snow.base_in} in base` : ''}${r.snow.new_snow_in ? `, ${r.snow.new_snow_in} in new` : ''}${r.snow.surface ? `, ${r.snow.surface.replace(/_/g, ' ')}` : ''}.`.replace(/^Snow: ,/, 'Snow:'));
  if (r.weather) L.push(`Weather: ${r.weather.low_f !== null ? `low ${r.weather.low_f}°F, ` : ''}${r.weather.high_f !== null ? `high ${r.weather.high_f}°F, ` : ''}${r.weather.max_wind_mph !== null ? `wind up to ${r.weather.max_wind_mph} mph` : ''}${r.weather.latest && r.weather.latest.sky ? `, ${WEATHER_SKY[r.weather.latest.sky].toLowerCase()}` : ''}.`.replace(/, \./, '.'));
  if (r.snowmaking.runs) L.push(`Snowmaking: ${r.snowmaking.runs} run${r.snowmaking.runs === 1 ? '' : 's'}, ${r.snowmaking.hours} hours.`);
  if (r.maintenance.failed_inspections.length) L.push(`Failed inspections: ${r.maintenance.failed_inspections.join(', ')}.`);
  if (r.maintenance.open_orders) L.push(`Open work orders: ${r.maintenance.open_orders}${r.maintenance.urgent ? ` (${r.maintenance.urgent} urgent)` : ''}.`);
  for (const n of r.handoffs) L.push(`Note (${n.dept}): ${n.body}`);
  return L.join('\n');
}

router.createOrder = createOrder;
router.markPmDone = markPmDone;
module.exports = router;
