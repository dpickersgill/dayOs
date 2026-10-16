'use strict';

// The mountain side of patrol (mounted under /patrol): the closing sweep, opening checks (which set runs open, on hold
// or closed on Mountain status), lift evacuation plans and drills, and avalanche observations and control work.
// Each is a record a patrol director is asked for after the fact, so every step is stamped with who and when.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateTimeStr, normDateTime } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const OPS = require('../lib/patrolops');
const PUSH = require('../lib/push');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (f, m) => PA.needs(pool, f, m);
const NAME = "CONCAT(p.first_name, ' ', p.last_name)";
const dateQ = (req, today) => (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today);

// ================================================================ closing sweep
const itemName = `COALESCE(i.label, t.name, l.name)`;
const ITEMS = `SELECT i.id, i.route_id, i.trail_id, i.lift_id, i.sort, ${itemName} AS name, IF(i.lift_id IS NOT NULL, 'lift', IF(i.trail_id IS NOT NULL, 'run', 'place')) AS kind
  FROM patrol_sweep_items i LEFT JOIN trails t ON t.tenant_id = i.tenant_id AND t.id = i.trail_id LEFT JOIN lifts l ON l.tenant_id = i.tenant_id AND l.id = i.lift_id`;

async function routesOf(db, t, { activeOnly = false } = {}) {
  const routes = await rows(db, `SELECT r.*, st.name AS station FROM patrol_sweep_routes r LEFT JOIN patrol_stations st ON st.tenant_id = r.tenant_id AND st.id = r.station_id
    WHERE r.tenant_id = ?${activeOnly ? ' AND r.active = 1' : ''} ORDER BY r.sort, r.name`, [t]);
  const items = await rows(db, `${ITEMS} WHERE i.tenant_id = ? ORDER BY i.route_id, i.sort, i.id`, [t]);
  return routes.map((r) => ({ ...r, id: Number(r.id), active: Boolean(r.active), items: items.filter((i) => Number(i.route_id) === Number(r.id)).map((i) => ({ ...i, id: Number(i.id) })) }));
}

router.get('/sweep/routes', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const [routes, trails, lifts, stations] = await Promise.all([
    routesOf(pool, t),
    rows(pool, 'SELECT id, name, difficulty, status FROM trails WHERE tenant_id = ? ORDER BY name', [t]),
    rows(pool, 'SELECT id, name, status FROM lifts WHERE tenant_id = ? ORDER BY name', [t]),
    rows(pool, 'SELECT id, name FROM patrol_stations WHERE tenant_id = ? ORDER BY name', [t]),
  ]);
  res.json({ data: routes, trails, lifts, stations, can_edit: await PA.can(pool, req, 'run_sweep') });
});

const itemSchema = z.object({ trail_id: z.number().int().positive().optional(), lift_id: z.number().int().positive().optional(), label: z.string().trim().min(1).max(100).optional() })
  .refine((i) => [i.trail_id, i.lift_id, i.label].filter((x) => x !== undefined).length === 1, 'Each stop is one run, one lift or one named place');
const routeSchema = { name: z.string().trim().min(1).max(100), station_id: z.number().int().positive().nullable().optional(), sort: z.number().int().min(0).max(999).optional(), active: z.boolean().optional(), items: z.array(itemSchema).max(80).optional() };

async function saveItems(conn, t, routeId, items) {
  for (const i of items) {
    if (i.trail_id && !(await one(conn, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ?', [t, i.trail_id]))) throw notFound('Run');
    if (i.lift_id && !(await one(conn, 'SELECT id FROM lifts WHERE tenant_id = ? AND id = ?', [t, i.lift_id]))) throw notFound('Lift');
  }
  // Stops already swept today keep their rows (the marks point at them); the route's order is rewritten.
  const used = new Set((await rows(conn, 'SELECT DISTINCT item_id FROM patrol_sweep_marks WHERE tenant_id = ? AND item_id IN (SELECT id FROM patrol_sweep_items WHERE tenant_id = ? AND route_id = ?)', [t, t, routeId])).map((r) => Number(r.item_id)));
  const old = await rows(conn, 'SELECT id, trail_id, lift_id, label FROM patrol_sweep_items WHERE tenant_id = ? AND route_id = ?', [t, routeId]);
  const keep = new Set();
  let sort = 0;
  for (const i of items) {
    const same = old.find((o) => !keep.has(Number(o.id)) && Number(o.trail_id || 0) === Number(i.trail_id || 0) && Number(o.lift_id || 0) === Number(i.lift_id || 0) && (o.label || null) === (i.label || null));
    sort += 10;
    if (same) { keep.add(Number(same.id)); await conn.query('UPDATE patrol_sweep_items SET sort = ? WHERE tenant_id = ? AND id = ?', [sort, t, same.id]); continue; }
    await conn.query('INSERT INTO patrol_sweep_items (tenant_id, route_id, trail_id, lift_id, label, sort) VALUES (?, ?, ?, ?, ?, ?)', [t, routeId, i.trail_id || null, i.lift_id || null, i.label || null, sort]);
  }
  for (const o of old) {
    if (keep.has(Number(o.id))) continue;
    if (used.has(Number(o.id))) await conn.query('UPDATE patrol_sweep_items SET sort = 9999 WHERE tenant_id = ? AND id = ?', [t, o.id]); // history keeps it; it drops to the end
    else await conn.query('DELETE FROM patrol_sweep_items WHERE tenant_id = ? AND id = ?', [t, o.id]);
  }
}

router.post('/sweep/routes', patrol, needs('run_sweep'), validate(z.object(routeSchema)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const id = await tx(async (conn) => {
    if (b.station_id && !(await one(conn, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, b.station_id]))) throw notFound('Station');
    let r;
    try { [r] = await conn.query('INSERT INTO patrol_sweep_routes (tenant_id, name, station_id, sort) VALUES (?, ?, ?, ?)', [t, b.name, b.station_id || null, b.sort || 0]); } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('There is already a route with that name'); throw e; }
    if (b.items) await saveItems(conn, t, r.insertId, b.items);
    await audit(conn, req, 'create', 'patrol_sweep_routes', r.insertId);
    return r.insertId;
  });
  res.status(201).json({ id });
});

router.patch('/sweep/routes/:id', patrol, needs('run_sweep'), validate(z.object(routeSchema).partial()), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM patrol_sweep_routes WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Route');
    if (b.station_id && !(await one(conn, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, b.station_id]))) throw notFound('Station');
    const cols = ['name', 'station_id', 'sort', 'active'].filter((k) => b[k] !== undefined);
    if (cols.length) {
      try { await conn.query(`UPDATE patrol_sweep_routes SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...cols.map((k) => (typeof b[k] === 'boolean' ? Number(b[k]) : b[k])), t, id]); } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('There is already a route with that name'); throw e; }
    }
    if (b.items) await saveItems(conn, t, id, b.items);
    await audit(conn, req, 'update', 'patrol_sweep_routes', id);
  });
  res.json({ ok: true });
});

/** Logins of roster members on duty whose access includes running the sweep. */
async function sweepLeads(db, t) {
  const on = await OPS.onDutyIds(db, t);
  if (!on.length) return [];
  const m = await PA.matrix(db, t);
  const list = await rows(db, 'SELECT m.staff_id, m.access_level, u.id AS user_id FROM patrol_members m JOIN users u ON u.tenant_id = m.tenant_id AND u.staff_id = m.staff_id AND u.active = 1 WHERE m.tenant_id = ? AND m.staff_id IN (?)', [t, on]);
  const out = [];
  for (const r of list) if (PA.effective(m[r.access_level] || {}, r.access_level, await PA.exceptionsOf(db, t, r.staff_id)).has('run_sweep')) out.push(Number(r.user_id));
  return out;
}

async function loadSweep(db, t, date) {
  const s = await one(db, `SELECT s.*, COALESCE(u.email, u.username) AS started_by_name, COALESCE(cu.email, cu.username) AS clear_by_name FROM patrol_sweeps s
    LEFT JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.started_by LEFT JOIN users cu ON cu.tenant_id = s.tenant_id AND cu.id = s.clear_by WHERE s.tenant_id = ? AND s.on_date = ?`, [t, date]);
  if (!s) return null;
  const runs = await rows(db, `SELECT r.*, ro.name AS route, ro.sort AS route_sort, ${NAME} AS staff_name FROM patrol_sweep_runs r JOIN patrol_sweep_routes ro ON ro.tenant_id = r.tenant_id AND ro.id = r.route_id
    LEFT JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.staff_id LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE r.tenant_id = ? AND r.sweep_id = ? ORDER BY ro.sort, ro.name`, [t, s.id]);
  const items = await rows(db, `${ITEMS} WHERE i.tenant_id = ? AND i.route_id IN (SELECT route_id FROM patrol_sweep_runs WHERE tenant_id = ? AND sweep_id = ?) ORDER BY i.sort, i.id`, [t, t, s.id]);
  const marks = await rows(db, `SELECT k.*, ${NAME} AS by_name FROM patrol_sweep_marks k LEFT JOIN staff s ON s.tenant_id = k.tenant_id AND s.id = k.by_staff LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE k.tenant_id = ? AND k.run_id IN (SELECT id FROM patrol_sweep_runs WHERE tenant_id = ? AND sweep_id = ?)`, [t, t, s.id]);
  return {
    ...s, id: Number(s.id),
    runs: runs.map((r) => {
      const mine = marks.filter((k) => Number(k.run_id) === Number(r.id));
      const stops = items.filter((i) => Number(i.route_id) === Number(r.route_id)).filter((i) => i.sort < 9999 || mine.some((k) => Number(k.item_id) === Number(i.id)));
      return { ...r, id: Number(r.id), staff_id: r.staff_id ? Number(r.staff_id) : null, stops: stops.map((i) => ({ ...i, id: Number(i.id), mark: mine.find((k) => Number(k.item_id) === Number(i.id)) || null })) };
    }),
  };
}

/** Today's sweep (or ?date=), the routes and who is on duty to assign. Raises the late alert once when routes are overdue. */
router.get('/sweep', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { now, today } = await OPS.clock(pool, t);
  const date = dateQ(req, today);
  const settings = await OPS.settingsOf(pool, t);
  let sweep = await loadSweep(pool, t, date);
  let late = false;
  if (sweep && sweep.status === 'running') {
    const due = new Date(Date.parse(`${String(sweep.started_at).replace(' ', 'T')}Z`) + settings.sweep_late_minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
    late = now > due && sweep.runs.some((r) => r.status !== 'clear');
    if (late && !sweep.late_alerted_at) {
      const [r] = await pool.query('UPDATE patrol_sweeps SET late_alerted_at = ? WHERE tenant_id = ? AND id = ? AND late_alerted_at IS NULL', [now, t, sweep.id]);
      if (r.affectedRows) {
        const open = sweep.runs.filter((x) => x.status !== 'clear').map((x) => x.route);
        const users = [...new Set([...(await sweepLeads(pool, t)), Number(sweep.started_by)])];
        PUSH.notifyUsers(t, users, { title: 'Sweep running late', body: `Not clear after ${settings.sweep_late_minutes} min: ${open.join(', ')}`, url: '#/patrol/sweep', tag: `sweep-${sweep.id}` });
        PUSH.notifyStaff(t, sweep.runs.filter((x) => x.status !== 'clear' && x.staff_id).map((x) => x.staff_id), { title: 'Sweep running late', body: 'Your route is not marked clear yet. Radio the patrol room.', url: '#/patrol/sweep', tag: `sweep-${sweep.id}` });
        sweep = await loadSweep(pool, t, date);
      }
    }
  }
  const [routes, duty] = await Promise.all([routesOf(pool, t, { activeOnly: true }), date === today ? OPS.onDuty(pool, t) : []]);
  res.json({
    date, today, now, sweep, late, late_minutes: settings.sweep_late_minutes, routes,
    on_duty: duty.map((d) => ({ staff_id: Number(d.staff_id), name: `${d.first_name} ${d.last_name}`, callsign: d.callsign, radio: d.radio })),
    me: req.auth.staffId ? Number(req.auth.staffId) : null, can_run: await PA.can(pool, req, 'run_sweep'),
  });
});

/** Start today's sweep: every active route, with whoever is assigned now (more can be assigned as it runs). */
router.post('/sweep/start', patrol, needs('run_sweep'), validate(z.object({ assignments: z.array(z.object({ route_id: z.number().int().positive(), staff_id: z.number().int().positive().nullable() })).max(80).default([]) })), async (req, res) => {
  const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const { now, today } = await OPS.clock(conn, t);
    const routes = await routesOf(conn, t, { activeOnly: true });
    if (!routes.length) throw bad('Set up sweep routes first (Sweep, Routes)');
    let r;
    try { [r] = await conn.query('INSERT INTO patrol_sweeps (tenant_id, on_date, started_at, started_by) VALUES (?, ?, ?, ?)', [t, today, now, req.auth.userId]); } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict("Today's sweep has already started"); throw e; }
    const given = new Map(req.body.assignments.map((a) => [a.route_id, a.staff_id]));
    const assigned = [];
    for (const ro of routes) {
      const staffId = given.get(ro.id) || null;
      await conn.query('INSERT INTO patrol_sweep_runs (tenant_id, sweep_id, route_id, staff_id, status) VALUES (?, ?, ?, ?, ?)', [t, r.insertId, ro.id, staffId, staffId ? 'sweeping' : 'waiting']);
      if (staffId) assigned.push([staffId, ro.name]);
    }
    await audit(conn, req, 'start', 'patrol_sweeps', r.insertId);
    return { id: r.insertId, assigned };
  });
  for (const [staffId, route] of out.assigned) PUSH.notifyStaff(t, [staffId], { title: 'Sweep: your route', body: `${route}. Mark each stop as you sweep it.`, url: '#/patrol/sweep', tag: 'sweep' });
  res.status(201).json({ id: out.id });
});

async function runFor(conn, req, runId, { lock = false } = {}) {
  const r = await one(conn, `SELECT r.*, s.status AS sweep_status, s.on_date, ro.name AS route FROM patrol_sweep_runs r JOIN patrol_sweeps s ON s.tenant_id = r.tenant_id AND s.id = r.sweep_id
    JOIN patrol_sweep_routes ro ON ro.tenant_id = r.tenant_id AND ro.id = r.route_id WHERE r.tenant_id = ? AND r.id = ?${lock ? ' FOR UPDATE' : ''}`, [req.auth.tenantId, runId]);
  if (!r) throw notFound('Sweep route');
  if (r.sweep_status === 'clear') throw conflict('The mountain is already called clear');
  return r;
}
/** The patroller on the route, or a sweep lead, can mark it. */
async function mayMark(req, run) {
  if (run.staff_id && Number(run.staff_id) === Number(req.auth.staffId)) return;
  if (await PA.can(pool, req, 'run_sweep')) return;
  throw forbidden('Only the patroller on this route or a sweep lead can mark it');
}

router.patch('/sweep/runs/:id', patrol, needs('run_sweep'), validate(z.object({ staff_id: z.number().int().positive().nullable() })), async (req, res) => {
  const t = req.auth.tenantId;
  const run = await tx(async (conn) => {
    const r = await runFor(conn, req, paramId(req), { lock: true });
    if (req.body.staff_id && !(await one(conn, "SELECT s.id FROM staff s JOIN patrol_members m ON m.tenant_id = s.tenant_id AND m.staff_id = s.id WHERE s.tenant_id = ? AND s.id = ? AND s.status = 'active'", [t, req.body.staff_id]))) throw bad('Only active patrollers sweep');
    await conn.query("UPDATE patrol_sweep_runs SET staff_id = ?, status = IF(status = 'clear', 'clear', IF(? IS NULL, 'waiting', 'sweeping')) WHERE tenant_id = ? AND id = ?", [req.body.staff_id, req.body.staff_id, t, r.id]);
    await audit(conn, req, 'assign', 'patrol_sweep_runs', r.id, req.body);
    return r;
  });
  if (req.body.staff_id) PUSH.notifyStaff(t, [req.body.staff_id], { title: 'Sweep: your route', body: `${run.route}. Mark each stop as you sweep it.`, url: '#/patrol/sweep', tag: 'sweep' });
  res.json({ ok: true });
});

/** A stop swept, with anything found: a person, a hazard, a rope or sign down. */
router.post('/sweep/runs/:id/marks', patrol, validate(z.object({ item_id: z.number().int().positive(), flag: z.enum(['none', 'person', 'hazard', 'rope', 'other']).default('none'), note: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.flag !== 'none' && !b.note) throw bad('Say what was found');
  const id = await tx(async (conn) => {
    const r = await runFor(conn, req, paramId(req), { lock: true });
    await mayMark(req, r);
    if (!(await one(conn, 'SELECT id FROM patrol_sweep_items WHERE tenant_id = ? AND id = ? AND route_id = ?', [t, b.item_id, r.route_id]))) throw notFound('Stop on this route');
    const { now } = await OPS.clock(conn, t);
    const [x] = await conn.query(`INSERT INTO patrol_sweep_marks (tenant_id, run_id, item_id, swept_at, by_staff, by_user, flag, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE swept_at = VALUES(swept_at), by_staff = VALUES(by_staff), by_user = VALUES(by_user), flag = VALUES(flag), note = VALUES(note), id = LAST_INSERT_ID(id)`, [t, r.id, b.item_id, now, req.auth.staffId || null, req.auth.userId, b.flag, b.note || null]);
    if (r.status === 'waiting') await conn.query("UPDATE patrol_sweep_runs SET status = 'sweeping', staff_id = COALESCE(staff_id, ?) WHERE tenant_id = ? AND id = ?", [req.auth.staffId || null, t, r.id]);
    await audit(conn, req, 'sweep_mark', 'patrol_sweep_runs', r.id, { item_id: b.item_id, flag: b.flag });
    return x.insertId;
  });
  res.status(201).json({ id });
});

/** Undo a mark (tapped the wrong stop). */
router.delete('/sweep/runs/:id/marks/:itemId', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await runFor(conn, req, paramId(req), { lock: true });
    await mayMark(req, r);
    if (r.status === 'clear') throw conflict('This route is already marked clear');
    await conn.query('DELETE FROM patrol_sweep_marks WHERE tenant_id = ? AND run_id = ? AND item_id = ? AND call_id IS NULL', [t, r.id, paramId(req, 'itemId')]);
  });
  res.status(204).end();
});

/** A person found on the sweep becomes a dispatch call in one tap. */
router.post('/sweep/marks/:id/call', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const k = await one(pool, `SELECT k.*, ${itemName} AS place, r.staff_id AS run_staff FROM patrol_sweep_marks k JOIN patrol_sweep_items i ON i.tenant_id = k.tenant_id AND i.id = k.item_id
    LEFT JOIN trails t ON t.tenant_id = i.tenant_id AND t.id = i.trail_id LEFT JOIN lifts l ON l.tenant_id = i.tenant_id AND l.id = i.lift_id
    JOIN patrol_sweep_runs r ON r.tenant_id = k.tenant_id AND r.id = k.run_id WHERE k.tenant_id = ? AND k.id = ?`, [t, paramId(req)]);
  if (!k) throw notFound('Sweep mark');
  if (k.call_id) return res.json({ call_id: Number(k.call_id) });
  if (!(await PA.can(pool, req, 'dispatch')) && Number(k.run_staff) !== Number(req.auth.staffId)) throw forbidden('Only dispatch or the patroller on this route can call it in');
  const tenant = await one(pool, 'SELECT id, timezone FROM tenants WHERE id = ?', [t]);
  const call = await require('./dispatch').createCall(tenant, { location: `${k.place} (closing sweep)`, description: k.note, priority: 'high' }, { source: 'patrol', userId: req.auth.userId, staffId: req.auth.staffId });
  await pool.query('UPDATE patrol_sweep_marks SET call_id = ? WHERE tenant_id = ? AND id = ?', [call.id, t, k.id]);
  await audit(pool, req, 'sweep_call', 'dispatch_calls', call.id, { mark: k.id });
  res.status(201).json({ call_id: call.id, call_no: call.call_no });
});

/** The route is swept: every stop must be marked. */
router.post('/sweep/runs/:id/clear', patrol, validate(z.object({ note: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await runFor(conn, req, paramId(req), { lock: true });
    await mayMark(req, r);
    const stops = await rows(conn, 'SELECT i.id FROM patrol_sweep_items i WHERE i.tenant_id = ? AND i.route_id = ? AND i.sort < 9999', [t, r.route_id]);
    const marked = new Set((await rows(conn, 'SELECT item_id FROM patrol_sweep_marks WHERE tenant_id = ? AND run_id = ?', [t, r.id])).map((x) => Number(x.item_id)));
    const missing = stops.filter((s) => !marked.has(Number(s.id))).length;
    if (missing) throw conflict(`${missing} stop${missing === 1 ? ' is' : 's are'} not marked swept yet`);
    const { now } = await OPS.clock(conn, t);
    await conn.query("UPDATE patrol_sweep_runs SET status = 'clear', cleared_at = ?, note = ?, staff_id = COALESCE(staff_id, ?) WHERE tenant_id = ? AND id = ?", [now, req.body.note || null, req.auth.staffId || null, t, r.id]);
    await audit(conn, req, 'route_clear', 'patrol_sweep_runs', r.id);
  });
  res.json({ ok: true });
});

/**
 * Mountain clear: every route is clear and no one found is left without a call. Anyone still signed in is signed out
 * (marked as closed by the sweep), so the duty list is right for the night.
 */
router.post('/sweep/clear', patrol, needs('run_sweep'), validate(z.object({ note: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const { now, today } = await OPS.clock(conn, t);
    const s = await one(conn, "SELECT * FROM patrol_sweeps WHERE tenant_id = ? AND on_date = ? FOR UPDATE", [t, today]);
    if (!s) throw notFound("Today's sweep");
    if (s.status === 'clear') throw conflict('The mountain is already called clear');
    const open = await rows(conn, `SELECT ro.name FROM patrol_sweep_runs r JOIN patrol_sweep_routes ro ON ro.tenant_id = r.tenant_id AND ro.id = r.route_id WHERE r.tenant_id = ? AND r.sweep_id = ? AND r.status <> 'clear'`, [t, s.id]);
    if (open.length) throw conflict(`Not every route is clear: ${open.map((o) => o.name).join(', ')}`);
    const people = await one(conn, "SELECT COUNT(*) AS n FROM patrol_sweep_marks k JOIN patrol_sweep_runs r ON r.tenant_id = k.tenant_id AND r.id = k.run_id WHERE k.tenant_id = ? AND r.sweep_id = ? AND k.flag = 'person' AND k.call_id IS NULL", [t, s.id]);
    if (Number(people.n)) throw conflict('Someone was found on the sweep and has no dispatch call yet. Call it in first.');
    await conn.query("UPDATE patrol_sweeps SET status = 'clear', clear_at = ?, clear_by = ?, clear_note = ? WHERE tenant_id = ? AND id = ?", [now, req.auth.userId, req.body.note || null, t, s.id]);
    const [d] = await conn.query('UPDATE patrol_duty SET signed_out_at = ?, auto_closed = 1, signed_out_by = ? WHERE tenant_id = ? AND on_date = ? AND signed_out_at IS NULL', [now, req.auth.userId, t, today]);
    await audit(conn, req, 'mountain_clear', 'patrol_sweeps', s.id, { signed_out: d.affectedRows });
    return { clear_at: now, signed_out: d.affectedRows };
  });
  res.json(out);
});

// ================================================================ opening checks
/** Each run with its status and today's checks, for the morning list. */
router.get('/opening', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { today } = await OPS.clock(pool, t);
  const date = dateQ(req, today);
  const [trails, checks, spots] = await Promise.all([
    rows(pool, 'SELECT id, name, difficulty, status, closure_reason FROM trails WHERE tenant_id = ? ORDER BY name', [t]),
    rows(pool, `SELECT c.*, ${NAME} AS by_name FROM patrol_opening_checks c LEFT JOIN staff s ON s.tenant_id = c.tenant_id AND s.id = c.checked_by LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
      WHERE c.tenant_id = ? AND c.on_date = ? ORDER BY c.checked_at`, [t, date]),
    rows(pool, `SELECT c.trail_id, c.checked_at, c.hazards FROM trail_checks c WHERE c.tenant_id = ? AND DATE(c.checked_at) = ? ORDER BY c.checked_at`, [t, date]),
  ]);
  res.json({
    date, today,
    data: trails.map((tr) => {
      const mine = checks.filter((c) => Number(c.trail_id) === Number(tr.id));
      return { ...tr, id: Number(tr.id), check: mine[mine.length - 1] || null, checks: mine.length, spot_checks: spots.filter((s) => Number(s.trail_id) === Number(tr.id)) };
    }),
    can_check: await PA.can(pool, req, 'trail_checks'), can_override: await PA.can(pool, req, 'run_sweep'),
  });
});

/** A run checked: open (every item ticked), on hold or closed (with a reason). Sets the run on Mountain status. */
router.post('/opening', patrol, needs('trail_checks'), validate(z.object({
  trail_id: z.number().int().positive(), hazards_marked: z.boolean().default(false), ropes_signs: z.boolean().default(false), padding: z.boolean().default(false),
  hazards: z.string().trim().max(500).nullable().optional(), decision: z.enum(['open', 'hold', 'closed']), reason: z.string().trim().max(200).nullable().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.decision === 'open' && !(b.hazards_marked && b.ropes_signs && b.padding)) throw bad('Tick each check before opening the run, or put it on hold');
  if (b.decision !== 'open' && !b.reason) throw bad('Say why the run is on hold or closed');
  const id = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, b.trail_id]))) throw notFound('Run');
    const { now, today } = await OPS.clock(conn, t);
    const [r] = await conn.query(`INSERT INTO patrol_opening_checks (tenant_id, on_date, trail_id, checked_at, checked_by, by_user, hazards_marked, ropes_signs, padding, hazards, decision, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, today, b.trail_id, now, req.auth.staffId || null, req.auth.userId, Number(b.hazards_marked), Number(b.ropes_signs), Number(b.padding), b.hazards || null, b.decision, b.reason || null]);
    await conn.query('UPDATE trails SET status = ?, closure_reason = ?, status_by = ? WHERE tenant_id = ? AND id = ?', [b.decision, b.decision === 'open' ? null : b.reason, req.auth.userId, t, b.trail_id]);
    await audit(conn, req, 'opening_check', 'trails', b.trail_id, { decision: b.decision });
    return r.insertId;
  });
  res.status(201).json({ id });
});

/**
 * Change a run's status from Patrol during the day: closing or holding needs a reason; opening needs a check today, or
 * a sweep lead's override with a reason (kept in the audit log).
 */
router.post('/trails/:id/status', patrol, needs('trail_checks'), validate(z.object({ status: z.enum(['open', 'hold', 'closed']), reason: z.string().trim().max(200).nullable().optional(), override_reason: z.string().trim().max(200).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  if (b.status !== 'open' && !b.reason) throw bad('Say why the run is on hold or closed');
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]))) throw notFound('Run');
    if (b.status === 'open') {
      const { today } = await OPS.clock(conn, t);
      const checked = await one(conn, "SELECT id FROM patrol_opening_checks WHERE tenant_id = ? AND trail_id = ? AND on_date = ? AND hazards_marked = 1 AND ropes_signs = 1 AND padding = 1 LIMIT 1", [t, id, today]);
      if (!checked) {
        if (!b.override_reason) throw conflict('This run has not had an opening check today. Check it first, or a sweep lead can open it with a reason.');
        if (!(await PA.can(pool, req, 'run_sweep'))) throw forbidden('Only a sweep lead can open a run without a check');
      }
    }
    await conn.query('UPDATE trails SET status = ?, closure_reason = ?, status_by = ? WHERE tenant_id = ? AND id = ?', [b.status, b.status === 'open' ? null : b.reason, req.auth.userId, t, id]);
    await audit(conn, req, 'trail_status', 'trails', id, { status: b.status, reason: b.reason || null, override: b.override_reason || null });
  });
  res.json({ ok: true });
});

// ================================================================ lift evacuation
const evacWriter = async (req) => (await PA.can(pool, req, 'manage_training')) || PA.can(pool, req, 'run_sweep');

/** Each lift with its plan, its drills this season, and who on duty is trained for it. */
router.get('/lift-evac', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { today } = await OPS.clock(pool, t);
  const yearAgo = OPS.addDays(today, -365);
  const [lifts, plans, evacs, people, trained, duty] = await Promise.all([
    rows(pool, 'SELECT id, name, status FROM lifts WHERE tenant_id = ? ORDER BY name', [t]),
    rows(pool, 'SELECT * FROM patrol_lift_plans WHERE tenant_id = ?', [t]),
    rows(pool, 'SELECT * FROM patrol_lift_evacs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 300', [t]),
    rows(pool, `SELECT ep.evac_id, ep.staff_id, ${NAME} AS name FROM patrol_lift_evac_people ep JOIN staff s ON s.tenant_id = ep.tenant_id AND s.id = ep.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE ep.tenant_id = ?`, [t]),
    rows(pool, "SELECT DISTINCT staff_id FROM training_records WHERE tenant_id = ? AND kind = 'ride_evac' AND completed_on >= ?", [t, yearAgo]),
    OPS.onDuty(pool, t),
  ]);
  const trainedAll = new Set(trained.map((r) => Number(r.staff_id)));
  res.json({
    can_edit: await evacWriter(req),
    data: lifts.map((l) => {
      const mine = evacs.filter((e) => Number(e.lift_id) === Number(l.id)).map((e) => ({ ...e, id: Number(e.id), people: people.filter((p) => Number(p.evac_id) === Number(e.id)) }));
      // Trained for this lift: an evacuation course in the last year, or a drill on this lift in the last year.
      const drilled = new Set(mine.filter((e) => String(e.started_at).slice(0, 10) >= yearAgo).flatMap((e) => e.people.map((p) => Number(p.staff_id))));
      const ready = duty.filter((d) => trainedAll.has(Number(d.staff_id)) || drilled.has(Number(d.staff_id)));
      const plan = plans.find((p) => Number(p.lift_id) === Number(l.id)) || null;
      return { ...l, id: Number(l.id), plan, evacs: mine.slice(0, 20), last_drill: mine.find((e) => e.kind === 'drill') || null,
        ready_on_duty: ready.map((d) => `${d.first_name} ${d.last_name}`), needed: plan ? plan.patrollers_needed : null };
    }),
  });
});

router.put('/lift-evac/:liftId/plan', patrol, validate(z.object({ plan: z.string().max(20000).nullable().optional(), equipment: z.string().max(500).nullable().optional(), equipment_location: z.string().max(200).nullable().optional(), patrollers_needed: z.number().int().min(0).max(100).nullable().optional() })), async (req, res) => {
  if (!(await evacWriter(req))) throw forbidden('Only those who run training or the sweep can change evacuation plans');
  const t = req.auth.tenantId; const id = paramId(req, 'liftId'); const b = req.body;
  if (!(await one(pool, 'SELECT id FROM lifts WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Lift');
  await pool.query(`INSERT INTO patrol_lift_plans (tenant_id, lift_id, plan, equipment, equipment_location, patrollers_needed, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE plan = VALUES(plan), equipment = VALUES(equipment), equipment_location = VALUES(equipment_location), patrollers_needed = VALUES(patrollers_needed), updated_by = VALUES(updated_by)`,
  [t, id, b.plan ?? null, b.equipment ?? null, b.equipment_location ?? null, b.patrollers_needed ?? null, req.auth.userId]);
  await audit(pool, req, 'update', 'patrol_lift_plans', id);
  res.json({ ok: true });
});

/** A drill or a real evacuation. A drill gives each patroller who took part a training record. */
router.post('/lift-evac/:liftId/evacs', patrol, validate(z.object({
  kind: z.enum(['drill', 'real']), started_at: dateTimeStr.transform(normDateTime), ended_at: dateTimeStr.transform(normDateTime).nullable().optional(),
  guests: z.number().int().min(0).max(5000).nullable().optional(), notes: z.string().max(20000).nullable().optional(), staff_ids: z.array(z.number().int().positive()).max(100).default([]),
})), async (req, res) => {
  if (!(await evacWriter(req)) && !(await PA.can(pool, req, 'dispatch'))) throw forbidden('Your patrol access cannot record evacuations');
  const t = req.auth.tenantId; const id = paramId(req, 'liftId'); const b = req.body;
  if (b.ended_at && b.ended_at <= b.started_at) throw bad('It must end after it starts');
  const out = await tx(async (conn) => {
    const lift = await one(conn, 'SELECT id, name FROM lifts WHERE tenant_id = ? AND id = ?', [t, id]);
    if (!lift) throw notFound('Lift');
    const [r] = await conn.query('INSERT INTO patrol_lift_evacs (tenant_id, lift_id, kind, started_at, ended_at, guests, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, id, b.kind, b.started_at, b.ended_at || null, b.guests ?? null, b.notes || null, req.auth.userId]);
    const hours = b.ended_at ? Math.max(0, Math.round((Date.parse(`${b.ended_at.replace(' ', 'T')}Z`) - Date.parse(`${b.started_at.replace(' ', 'T')}Z`)) / 36e5 * 100) / 100) : 0;
    for (const sid of [...new Set(b.staff_ids)]) {
      if (!(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, sid]))) throw notFound('Staff member');
      await conn.query('INSERT INTO patrol_lift_evac_people (tenant_id, evac_id, staff_id) VALUES (?, ?, ?)', [t, r.insertId, sid]);
      if (b.kind === 'drill') await conn.query("INSERT INTO training_records (tenant_id, staff_id, kind, title, hours, completed_on, notes, recorded_by) VALUES (?, ?, 'ride_evac', ?, ?, ?, ?, ?)", [t, sid, `Lift evacuation drill: ${lift.name}`, hours, b.started_at.slice(0, 10), `Drill record ${r.insertId}`, req.auth.userId]);
    }
    await audit(conn, req, b.kind === 'drill' ? 'evac_drill' : 'evac_real', 'patrol_lift_evacs', r.insertId, { lift_id: id, people: b.staff_ids.length });
    return r.insertId;
  });
  res.status(201).json({ id: out });
});

// ================================================================ avalanche
async function avyOn(req) {
  if (!(await OPS.settingsOf(pool, req.auth.tenantId)).avalanche) throw forbidden('Avalanche work is off for this mountain (Patrol, Admin, Patrol settings)');
}

router.get('/avy', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  await avyOn(req);
  const days = Math.min(60, Math.max(1, Number(req.query.days) || 7));
  const { today } = await OPS.clock(pool, t);
  const since = `${OPS.addDays(today, -days + 1)} 00:00:00`;
  const [paths, obs, shots, trails] = await Promise.all([
    rows(pool, 'SELECT a.*, t.name AS trail FROM patrol_avy_paths a LEFT JOIN trails t ON t.tenant_id = a.tenant_id AND t.id = a.trail_id WHERE a.tenant_id = ? ORDER BY a.name', [t]),
    rows(pool, `SELECT o.*, ${NAME} AS by_name FROM patrol_avy_obs o LEFT JOIN staff s ON s.tenant_id = o.tenant_id AND s.id = o.by_staff LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE o.tenant_id = ? AND o.observed_at >= ? ORDER BY o.observed_at DESC`, [t, since]),
    rows(pool, `SELECT x.*, a.name AS path, ${NAME} AS by_name FROM patrol_avy_shots x JOIN patrol_avy_paths a ON a.tenant_id = x.tenant_id AND a.id = x.path_id LEFT JOIN staff s ON s.tenant_id = x.tenant_id AND s.id = x.by_staff LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE x.tenant_id = ? AND x.shot_at >= ? ORDER BY x.shot_at DESC`, [t, since]),
    rows(pool, 'SELECT id, name FROM trails WHERE tenant_id = ? ORDER BY name', [t]),
  ]);
  res.json({ paths, obs, shots, trails, days, can_edit: await PA.can(pool, req, 'avalanche') });
});

router.post('/avy/paths', patrol, needs('avalanche'), validate(z.object({ name: z.string().trim().min(1).max(100), trail_id: z.number().int().positive().nullable().optional() })), async (req, res) => {
  await avyOn(req);
  const t = req.auth.tenantId;
  if (req.body.trail_id && !(await one(pool, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ?', [t, req.body.trail_id]))) throw notFound('Run');
  try {
    const [r] = await pool.query('INSERT INTO patrol_avy_paths (tenant_id, name, trail_id) VALUES (?, ?, ?)', [t, req.body.name, req.body.trail_id || null]);
    res.status(201).json({ id: r.insertId });
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('There is already a path with that name'); throw e; }
});

const hazard = z.number().int().min(1).max(5).nullable().optional();
router.post('/avy/obs', patrol, needs('avalanche'), validate(z.object({
  observed_at: dateTimeStr.transform(normDateTime).optional(), hn24_cm: z.number().int().min(0).max(500).nullable().optional(), hst_cm: z.number().int().min(0).max(1000).nullable().optional(),
  wind: z.enum(['calm', 'light', 'moderate', 'strong', 'extreme']).nullable().optional(), wind_dir: z.enum(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']).nullable().optional(),
  temp_trend: z.enum(['warming', 'steady', 'cooling']).nullable().optional(), tests: z.string().max(500).nullable().optional(),
  hazard_below: hazard, hazard_near: hazard, hazard_above: hazard, notes: z.string().max(5000).nullable().optional(),
})), async (req, res) => {
  await avyOn(req);
  const t = req.auth.tenantId; const b = req.body;
  const { now } = await OPS.clock(pool, t);
  const [r] = await pool.query(`INSERT INTO patrol_avy_obs (tenant_id, observed_at, by_staff, by_user, hn24_cm, hst_cm, wind, wind_dir, temp_trend, tests, hazard_below, hazard_near, hazard_above, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, b.observed_at || now, req.auth.staffId || null, req.auth.userId, b.hn24_cm ?? null, b.hst_cm ?? null, b.wind || null, b.wind_dir || null, b.temp_trend || null, b.tests || null, b.hazard_below ?? null, b.hazard_near ?? null, b.hazard_above ?? null, b.notes || null]);
  await audit(pool, req, 'create', 'patrol_avy_obs', r.insertId);
  res.status(201).json({ id: r.insertId });
});

/** A control shot or ski cut. Its run can be closed or put on hold in the same step. */
router.post('/avy/shots', patrol, needs('avalanche'), validate(z.object({
  path_id: z.number().int().positive(), shot_at: dateTimeStr.transform(normDateTime).optional(),
  method: z.enum(['hand_charge', 'avalauncher', 'gas', 'ski_cut', 'cornice', 'other']), result: z.enum(['no_result', 'sluff', 'slide']).default('no_result'),
  size_r: z.number().int().min(1).max(5).nullable().optional(), size_d: z.number().min(1).max(5).multipleOf(0.5).nullable().optional(), crown_cm: z.number().int().min(0).max(1000).nullable().optional(),
  notes: z.string().max(500).nullable().optional(), run_status: z.enum(['hold', 'closed']).nullable().optional(),
})), async (req, res) => {
  await avyOn(req);
  const t = req.auth.tenantId; const b = req.body;
  if (b.result === 'slide' && !(b.size_d || b.size_r)) throw bad('Give the size of the slide (R or D)');
  const id = await tx(async (conn) => {
    const path = await one(conn, 'SELECT * FROM patrol_avy_paths WHERE tenant_id = ? AND id = ?', [t, b.path_id]);
    if (!path) throw notFound('Slide path');
    const { now } = await OPS.clock(conn, t);
    const [r] = await conn.query('INSERT INTO patrol_avy_shots (tenant_id, shot_at, path_id, method, by_staff, by_user, result, size_r, size_d, crown_cm, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, b.shot_at || now, b.path_id, b.method, req.auth.staffId || null, req.auth.userId, b.result, b.size_r ?? null, b.size_d ?? null, b.crown_cm ?? null, b.notes || null]);
    if (b.run_status && path.trail_id) await conn.query('UPDATE trails SET status = ?, closure_reason = ?, status_by = ? WHERE tenant_id = ? AND id = ?', [b.run_status, `Avalanche control: ${path.name}`, req.auth.userId, t, path.trail_id]);
    await audit(conn, req, 'create', 'patrol_avy_shots', r.insertId, { path_id: b.path_id, result: b.result });
    return r.insertId;
  });
  res.status(201).json({ id });
});

module.exports = { router };
