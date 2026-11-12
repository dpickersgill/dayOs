'use strict';

// The crew's day (release 2026.11.20), for a municipality's public works:
//   under /workforce (Staff and schedule):
//     GET  /crew-board                     the manager's crew board on Today (lib/crewday.js board)
//     GET  /my-day                         a crew member's "My work today": clock, on call, work orders, programs, route, rounds
//     GET  /oncall/now                     who is on call now and tonight, per rotation (everyone: the front desk dispatches with it)
//     GET  /oncall                         rotations and the calendar for 4 weeks (?from=YYYY-MM-DD&days=7..56)
//     POST /oncall/rotations, PATCH|DELETE /oncall/rotations/:id         managers
//     POST /oncall/overrides, DELETE /oncall/overrides/:id               a swap, holiday or cover (managers)
//     GET|POST /oncall/holidays, DELETE /oncall/holidays/:id, POST /oncall/holidays/usual   the holidays (managers)
//     POST /oncall/callout                 clock in for a call-out (or mark the open punch as one)
//     GET  /overtime                       hours over 40 a week per person, and call-outs (?start=&weeks=1..13, managers)
//     GET  /overtime/export                the same as a spreadsheet (managers, with the second check, like the payroll export)
//     PATCH /overtime/entries/:id          mark a punch as a call-out, or not (managers, audited)
//     GET  /licenses?kind=water|wastewater the people holding an unexpired operator license, with their logins (managers)
//   under /ops (the work orders' own paths, reached with Assets and fleet on):
//     POST /work-orders/assign             assign several work orders to one person and day at once (managers)
//     GET  /work-orders/map                open work orders that have a place, for the Work orders map
// The Staff and schedule module gates /workforce, Assets and fleet the work order paths (lib/modules.js).
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { z, dateStr, timeStr, validate, paramId, addDays, nowIn, dayRange, localTime } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { stepUp } = require('../lib/stepup');
const { toCsv } = require('../lib/csv');
const SH = require('../lib/shifts');
const OC = require('../lib/oncall');
const CD = require('../lib/crewday');

const router = express.Router();
const works = express.Router();
const mgr = requireRole('manager');
const everyone = requireRole('staff', 'counter', 'instructor', 'patrol', 'manager');
const OVERTIME_AFTER = 40 * 60;
const tzOf = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const csvIds = (list) => [...new Set(list)].join(',');

async function staffMust(conn, t, list) {
  const want = [...new Set(list.filter(Boolean).map(Number))];
  if (!want.length) return;
  const got = await rows(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id IN (?)', [t, want]);
  if (got.length !== want.length) throw notFound('Staff member');
}
async function categoriesMust(conn, t, list) {
  const want = [...new Set(list)];
  if (!want.length) return;
  const got = await rows(conn, 'SELECT id FROM request_categories WHERE tenant_id = ? AND id IN (?)', [t, want]);
  if (got.length !== want.length) throw notFound('Request category');
}

// ---------------------------------------------------------------- Today
router.get('/crew-board', mgr, async (req, res) => { res.json(await CD.board(req.auth.tenantId)); });
router.get('/my-day', everyone, async (req, res) => { res.json(await CD.myDay(req.auth.tenantId, req.auth.staffId || null, req.auth.role)); });

// ---------------------------------------------------------------- on call
router.get('/oncall/now', everyone, async (req, res) => { res.json(await OC.onCallNow(pool, req.auth.tenantId)); });

router.get('/oncall', everyone, async (req, res) => {
  const t = req.auth.tenantId;
  const today = nowIn(await tzOf(t)).slice(0, 10);
  const from = dateStr.safeParse(String(req.query.from || '')).success ? String(req.query.from) : SH.weekOf(today);
  const days = Math.min(Math.max(Number(req.query.days) || 28, 7), 56);
  await OC.linkDepartments(pool, t); // a municipality picks the rotation's department from its list (2026.11.20)
  const cal = await OC.calendar(pool, t, from, days);
  const categories = await rows(pool, 'SELECT id, name, after_hours FROM request_categories WHERE tenant_id = ? AND active = 1 ORDER BY sort, name', [t]).catch(() => []);
  const departments = await rows(pool, 'SELECT id, name, active FROM departments WHERE tenant_id = ? ORDER BY sort, name', [t]);
  res.json({ ...cal, today, can_manage: isManager(req), categories: categories.map((c) => ({ id: Number(c.id), name: c.name, after_hours: Boolean(c.after_hours) })),
    departments: departments.map((d) => ({ id: Number(d.id), name: d.name, active: Boolean(d.active) })) });
});

const rotationFields = {
  name: z.string().trim().min(1, 'Give the rotation a name').max(80),
  department: z.string().trim().max(60).nullable().optional(),
  department_id: z.number().int().positive().nullable().optional(), // a municipality's department (2026.11.20)
  members: z.array(z.number().int().positive()).max(40),
  starts_on: dateStr,
  period_days: z.number().int().min(1).max(31).default(7),
  handover: timeStr.default('07:00'),
  workday_start: timeStr.default('07:00'),
  workday_end: timeStr.default('15:30'),
  category_ids: z.array(z.number().int().positive()).max(50).default([]),
  active: z.boolean().optional(),
};
const rotationSchema = z.object(rotationFields).refine((b) => b.workday_end > b.workday_start, { message: 'The working day must end after it starts', path: ['workday_end'] });
const rotationPatch = z.object(Object.fromEntries(Object.entries(rotationFields).map(([k, v]) => [k, v.optional()])));

function rotationCols(b) {
  const out = {};
  for (const k of ['name', 'department', 'starts_on', 'period_days', 'handover', 'workday_start', 'workday_end']) if (b[k] !== undefined) out[k] = b[k] === '' ? null : b[k];
  if (b.department_id !== undefined) { out.department_id = b.department_id; if (b.department === undefined) out.department = null; } // the picked department replaces a typed name
  if (b.members !== undefined) out.members = b.members.join(','); // the order is the rotation's order; a person may appear once
  if (b.category_ids !== undefined) out.category_ids = csvIds(b.category_ids) || null;
  if (b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}
/** A municipality's rotation is for one of its own departments; a ski area has none to pick. */
async function departmentMust(conn, t, id) {
  if (id === undefined || id === null) return;
  if (!(await one(conn, 'SELECT id FROM departments WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Department');
}
const dupMembers = (m) => { if (m && new Set(m).size !== m.length) throw bad('Each person can be in a rotation once'); };

router.post('/oncall/rotations', mgr, validate(rotationSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  dupMembers(b.members);
  const id = await tx(async (conn) => {
    await staffMust(conn, t, b.members);
    await categoriesMust(conn, t, b.category_ids);
    await departmentMust(conn, t, b.department_id);
    const c = rotationCols(b);
    try {
      const [r] = await conn.query(`INSERT INTO oncall_rotations (tenant_id, ${Object.keys(c).join(', ')}, created_by) VALUES (?, ${Object.keys(c).map(() => '?').join(', ')}, ?)`, [t, ...Object.values(c), req.auth.userId]);
      await audit(conn, req, 'create', 'oncall_rotations', r.insertId, { name: b.name, members: b.members.length });
      return r.insertId;
    } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a rotation with that name'); throw err; }
  });
  res.status(201).json({ id });
});

router.patch('/oncall/rotations/:id', mgr, validate(rotationPatch), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  dupMembers(b.members);
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM oncall_rotations WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur) throw notFound('Rotation');
    if (b.members) await staffMust(conn, t, b.members);
    if (b.category_ids) await categoriesMust(conn, t, b.category_ids);
    await departmentMust(conn, t, b.department_id);
    const start = String(b.workday_start || cur.workday_start).slice(0, 5); const end = String(b.workday_end || cur.workday_end).slice(0, 5);
    if (end <= start) throw bad('The working day must end after it starts');
    const c = rotationCols(b);
    if (!Object.keys(c).length) throw bad('Nothing to change');
    try { await conn.query(`UPDATE oncall_rotations SET ${Object.keys(c).map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...Object.values(c), t, id]); } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a rotation with that name'); throw err; }
    await audit(conn, req, 'update', 'oncall_rotations', id, Object.keys(c));
  });
  res.json({ ok: true });
});

router.delete('/oncall/rotations/:id', mgr, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const [r] = await pool.query('DELETE FROM oncall_rotations WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!r.affectedRows) throw notFound('Rotation');
  await audit(pool, req, 'delete', 'oncall_rotations', id);
  res.status(204).end();
});

const overrideSchema = z.object({
  rotation_id: z.number().int().positive(), starts_on: dateStr, ends_on: dateStr, staff_id: z.number().int().positive(),
  reason: z.enum(['swap', 'holiday', 'cover']).default('swap'), note: z.string().trim().max(200).nullable().optional(),
}).refine((b) => b.ends_on >= b.starts_on, { message: 'The last day must not be before the first', path: ['ends_on'] })
  .refine((b) => b.ends_on <= addDays(b.starts_on, 92), { message: 'A swap or cover can be up to three months. Change the rotation for longer.', path: ['ends_on'] });

router.post('/oncall/overrides', mgr, validate(overrideSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const id = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM oncall_rotations WHERE tenant_id = ? AND id = ?', [t, b.rotation_id]))) throw notFound('Rotation');
    await staffMust(conn, t, [b.staff_id]);
    const [r] = await conn.query('INSERT INTO oncall_overrides (tenant_id, rotation_id, starts_on, ends_on, staff_id, reason, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [t, b.rotation_id, b.starts_on, b.ends_on, b.staff_id, b.reason, b.note || null, req.auth.userId]);
    await audit(conn, req, 'create', 'oncall_overrides', r.insertId, { rotation_id: b.rotation_id, starts_on: b.starts_on, ends_on: b.ends_on, staff_id: b.staff_id, reason: b.reason });
    return r.insertId;
  });
  res.status(201).json({ id });
});

router.delete('/oncall/overrides/:id', mgr, async (req, res) => {
  const id = paramId(req);
  const [r] = await pool.query('DELETE FROM oncall_overrides WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Swap or cover');
  await audit(pool, req, 'delete', 'oncall_overrides', id);
  res.status(204).end();
});

router.get('/oncall/holidays', everyone, async (req, res) => {
  const year = Number(req.query.year) || Number(nowIn(await tzOf(req.auth.tenantId)).slice(0, 4));
  res.json({ year, data: (await rows(pool, 'SELECT id, day, name FROM oncall_holidays WHERE tenant_id = ? AND day >= ? AND day <= ? ORDER BY day', [req.auth.tenantId, `${year}-01-01`, `${year}-12-31`])).map((x) => ({ id: Number(x.id), day: String(x.day).slice(0, 10), name: x.name })) });
});

router.post('/oncall/holidays', mgr, validate(z.object({ day: dateStr, name: z.string().trim().min(1).max(80) })), async (req, res) => {
  try {
    const [r] = await pool.query('INSERT INTO oncall_holidays (tenant_id, day, name) VALUES (?, ?, ?)', [req.auth.tenantId, req.body.day, req.body.name]);
    await audit(pool, req, 'create', 'oncall_holidays', r.insertId, req.body);
    res.status(201).json({ id: r.insertId });
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('That day is already a holiday'); throw err; }
});

/** The holidays most Pennsylvania municipalities close for, in a year, moved to the Friday or Monday when they fall on a weekend. */
function usualHolidays(year) {
  const d = (m, day) => `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const nth = (m, wd, n) => { let x = 1; let c = 0; for (;;) { if (OC.weekday(d(m, x)) === wd) { c += 1; if (c === n) return d(m, x); } x += 1; } };
  const last = (m, wd) => { let x = new Date(Date.UTC(year, m, 0)).getUTCDate(); while (OC.weekday(d(m, x)) !== wd) x -= 1; return d(m, x); };
  const observed = (day) => { const w = OC.weekday(day); return w === 6 ? addDays(day, -1) : w === 0 ? addDays(day, 1) : day; };
  const thanks = nth(11, 4, 4);
  return [
    [observed(d(1, 1)), 'New Year’s Day'], [nth(1, 1, 3), 'Martin Luther King Jr. Day'], [nth(2, 1, 3), 'Presidents’ Day'], [last(5, 1), 'Memorial Day'],
    [observed(d(6, 19)), 'Juneteenth'], [observed(d(7, 4)), 'Independence Day'], [nth(9, 1, 1), 'Labor Day'], [observed(d(11, 11)), 'Veterans Day'],
    [thanks, 'Thanksgiving'], [addDays(thanks, 1), 'Day after Thanksgiving'], [observed(d(12, 25)), 'Christmas Day'],
  ];
}

router.post('/oncall/holidays/usual', mgr, validate(z.object({ year: z.number().int().min(2000).max(2100) })), async (req, res) => {
  let added = 0;
  for (const [day, name] of usualHolidays(req.body.year)) { const [r] = await pool.query('INSERT IGNORE INTO oncall_holidays (tenant_id, day, name) VALUES (?, ?, ?)', [req.auth.tenantId, day, name]); added += r.affectedRows; }
  await audit(pool, req, 'create', 'oncall_holidays', null, { year: req.body.year, added });
  res.json({ added });
});

router.delete('/oncall/holidays/:id', mgr, async (req, res) => {
  const [r] = await pool.query('DELETE FROM oncall_holidays WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Holiday');
  await audit(pool, req, 'delete', 'oncall_holidays', paramId(req));
  res.status(204).end();
});

/** A call-out: clock in now marked as one, or mark the punch already open. A manager may do it for someone (staff_id). */
router.post('/oncall/callout', everyone, validate(z.object({ staff_id: z.number().int().positive().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  let staffId = req.auth.staffId;
  if (req.body.staff_id && req.body.staff_id !== req.auth.staffId) { if (!isManager(req)) throw forbidden('You can only do this for yourself'); staffId = req.body.staff_id; }
  if (!staffId) throw forbidden('Your login is not linked to a staff record. Ask a manager to link it.');
  const out = await tx(async (conn) => {
    const st = await one(conn, 'SELECT id, in_workforce FROM staff WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, staffId]);
    if (!st) throw notFound('Staff member');
    if (!st.in_workforce) throw bad('Volunteers do not clock in');
    const open = await one(conn, 'SELECT id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [t, staffId]);
    if (open) { await conn.query('UPDATE time_entries SET callout = 1 WHERE tenant_id = ? AND id = ?', [t, open.id]); await audit(conn, req, 'callout', 'time_entries', open.id, { marked: true }); return { id: Number(open.id), already_in: true }; }
    try {
      const [r] = await conn.query("INSERT INTO time_entries (tenant_id, staff_id, clock_in, in_method, callout) VALUES (?, ?, NOW(), ?, 1)", [t, staffId, isManager(req) && staffId !== req.auth.staffId ? 'manager' : 'login']);
      await audit(conn, req, 'callout', 'time_entries', r.insertId, { clock_in: true });
      return { id: r.insertId, already_in: false };
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('Already clocked in'); throw e; }
  });
  res.status(out.already_in ? 200 : 201).json(out);
});

// ---------------------------------------------------------------- overtime
/** Hours per person per week (Monday to Sunday) from the time clock: worked, regular, over 40, and call-outs. */
async function overtimeOf(t, start, weeks) {
  const tz = await tzOf(t);
  const end = addDays(start, weeks * 7 - 1);
  const [from, to] = [dayRange(tz, start)[0], dayRange(tz, end)[1]];
  const [entries, people] = await Promise.all([
    rows(pool, 'SELECT id, staff_id, clock_in, clock_out, callout, edited_at FROM time_entries WHERE tenant_id = ? AND clock_in >= ? AND clock_in < ? ORDER BY clock_in', [t, from, to]),
    rows(pool, "SELECT s.id, CONCAT(p.first_name, ' ', p.last_name) AS name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ?", [t]),
  ]);
  const names = new Map(people.map((p) => [Number(p.id), String(p.name || '').trim()]));
  const dbNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const by = new Map();
  for (const e of entries) {
    const local = localTime(e.clock_in, tz);
    const week = SH.weekOf(local.slice(0, 10));
    const key = `${e.staff_id}|${week}`;
    if (!by.has(key)) by.set(key, { staff_id: Number(e.staff_id), name: names.get(Number(e.staff_id)) || `Staff #${e.staff_id}`, week, worked_minutes: 0, callouts: 0, callout_minutes: 0, open: false, entries: [] });
    const r = by.get(key);
    const minutes = SH.minutesBetween(e.clock_in, e.clock_out || dbNow);
    r.worked_minutes += minutes;
    if (!e.clock_out) r.open = true;
    if (Number(e.callout)) { r.callouts += 1; r.callout_minutes += minutes; }
    r.entries.push({ id: Number(e.id), clock_in: local, clock_out: e.clock_out ? localTime(e.clock_out, tz) : null, minutes, callout: Boolean(Number(e.callout)) });
  }
  const list = [...by.values()].map((r) => ({ ...r, regular_minutes: Math.min(r.worked_minutes, OVERTIME_AFTER), overtime_minutes: Math.max(0, r.worked_minutes - OVERTIME_AFTER) }));
  list.sort((a, b) => a.week.localeCompare(b.week) || b.overtime_minutes - a.overtime_minutes || a.name.localeCompare(b.name));
  const totals = { worked_minutes: 0, overtime_minutes: 0, callouts: 0, callout_minutes: 0 };
  for (const r of list) for (const k of Object.keys(totals)) totals[k] += r[k];
  return { start, end, weeks, overtime_after_minutes: OVERTIME_AFTER, data: list, totals };
}
const overtimeRange = (q) => {
  const start = SH.weekOf(dateStr.safeParse(String(q.start || '')).success ? String(q.start) : new Date().toISOString().slice(0, 10));
  const weeks = Math.min(Math.max(Number(q.weeks) || 1, 1), 13);
  return [start, weeks];
};

router.get('/overtime', mgr, async (req, res) => {
  const [start, weeks] = overtimeRange(req.query);
  res.json(await overtimeOf(req.auth.tenantId, start, weeks));
});

router.get('/overtime/export', mgr, stepUp('download hours for payroll'), async (req, res) => {
  const [start, weeks] = overtimeRange(req.query);
  const o = await overtimeOf(req.auth.tenantId, start, weeks);
  const hrs = (m) => (m / 60).toFixed(2);
  const csv = toCsv(['name', 'staff_id', 'week_starting', 'worked_hours', 'regular_hours', 'overtime_hours', 'callouts', 'callout_hours'],
    o.data.map((r) => ({ name: r.name, staff_id: r.staff_id, week_starting: r.week, worked_hours: hrs(r.worked_minutes), regular_hours: hrs(r.regular_minutes), overtime_hours: hrs(r.overtime_minutes), callouts: r.callouts, callout_hours: hrs(r.callout_minutes) })));
  await audit(pool, req, 'export_overtime', 'time_entries', null, { start, weeks });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="overtime-${start}${weeks > 1 ? `-${weeks}-weeks` : ''}.csv"`, 'Cache-Control': 'private, no-store' }).send(csv);
});

router.patch('/overtime/entries/:id', mgr, validate(z.object({ callout: z.boolean() })), async (req, res) => {
  const id = paramId(req);
  const [r] = await pool.query('UPDATE time_entries SET callout = ? WHERE tenant_id = ? AND id = ?', [req.body.callout ? 1 : 0, req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Punch');
  await audit(pool, req, 'callout', 'time_entries', id, { callout: req.body.callout });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- licenses
router.get('/licenses', mgr, async (req, res) => {
  const kind = String(req.query.kind || 'water');
  if (!['water', 'wastewater'].includes(kind)) throw bad('kind is water or wastewater');
  res.json({ kind, data: await CD.licenseHolders(req.auth.tenantId, kind) });
});

// ---------------------------------------------------------------- work orders: assign several, and the map
const worksCrew = requireRole('staff', 'manager');
works.post('/work-orders/assign', mgr, validate(z.object({
  ids: z.array(z.number().int().positive()).min(1, 'Pick at least one work order').max(200),
  assigned_staff_id: z.number().int().positive().nullable(),
  due_date: dateStr.nullable().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const list = [...new Set(b.ids)];
  const changed = await tx(async (conn) => {
    await staffMust(conn, t, [b.assigned_staff_id]);
    const found = await rows(conn, "SELECT id, status FROM work_orders WHERE tenant_id = ? AND id IN (?) FOR UPDATE", [t, list]);
    if (found.length !== list.length) throw notFound('Work order');
    const closed = found.filter((w) => ['done', 'cancelled'].includes(w.status));
    if (closed.length) throw conflict(`${closed.length === 1 ? 'One of these is' : `${closed.length} of these are`} done or canceled. Pick open work orders only.`);
    const sets = ['assigned_staff_id = ?']; const vals = [b.assigned_staff_id];
    if (b.due_date !== undefined) { sets.push('due_date = ?'); vals.push(b.due_date); }
    const [r] = await conn.query(`UPDATE work_orders SET ${sets.join(', ')} WHERE tenant_id = ? AND id IN (?)`, [...vals, t, list]);
    for (const id of list) await audit(conn, req, 'assign', 'work_orders', id, { assigned_staff_id: b.assigned_staff_id, ...(b.due_date !== undefined ? { due_date: b.due_date } : {}), bulk: list.length });
    return r.affectedRows;
  });
  res.json({ updated: changed });
});

/**
 * Open work orders with a place on the map: on a map item (its point, or the middle of its line), on an asset that is on
 * the map, or from a resident request with the phone's location. No resident details: the title and the street only.
 */
works.get('/work-orders/map', worksCrew, async (req, res) => {
  const t = req.auth.tenantId;
  const where = ["w.tenant_id = ?", "w.status NOT IN ('done','cancelled')"]; const params = [t];
  if (req.query.mine === '1') { where.push('w.assigned_staff_id = ?'); params.push(req.auth.staffId || 0); }
  CD.systemFilter(req, where, params);
  const list = await rows(pool, `SELECT w.id, w.title, w.priority, w.status, w.due_date, w.assigned_staff_id, CONCAT(p.first_name, ' ', p.last_name) AS assignee,
      mf.lat AS f_lat, mf.lng AS f_lng, mf.tag AS feature_tag, mf.name AS feature_name,
      (SELECT af.lat FROM map_features af WHERE af.tenant_id = w.tenant_id AND af.asset_id = w.asset_id ORDER BY af.id LIMIT 1) AS a_lat,
      (SELECT af.lng FROM map_features af WHERE af.tenant_id = w.tenant_id AND af.asset_id = w.asset_id ORDER BY af.id LIMIT 1) AS a_lng,
      rq.lat AS r_lat, rq.lng AS r_lng, st.name AS street
    FROM work_orders w
    LEFT JOIN map_features mf ON mf.tenant_id = w.tenant_id AND mf.id = w.map_feature_id
    LEFT JOIN requests rq ON rq.tenant_id = w.tenant_id AND rq.id = w.request_id
    LEFT JOIN streets st ON st.tenant_id = rq.tenant_id AND st.id = rq.street_id
    LEFT JOIN staff s ON s.tenant_id = w.tenant_id AND s.id = w.assigned_staff_id
    LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE ${where.join(' AND ')} ORDER BY FIELD(w.priority, 'urgent', 'high', 'normal', 'low'), w.id DESC LIMIT 1000`, params);
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  const placed = []; let unplaced = 0;
  for (const w of list) {
    const lat = n(w.f_lat) ?? n(w.a_lat) ?? n(w.r_lat); const lng = n(w.f_lng) ?? n(w.a_lng) ?? n(w.r_lng);
    if (lat === null || lng === null) { unplaced += 1; continue; }
    placed.push({ id: Number(w.id), title: w.title, priority: w.priority, status: w.status, due_date: w.due_date ? String(w.due_date).slice(0, 10) : null, assignee: w.assignee ? w.assignee.trim() : null, lat, lng, place: w.feature_tag || w.feature_name || w.street || null });
  }
  res.json({ data: placed, unplaced });
});

module.exports = { router, works, usualHolidays };
