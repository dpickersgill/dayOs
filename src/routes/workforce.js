'use strict';

const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { crud } = require('../lib/crud');
const { requireRole, isManager } = require('../middleware/auth');
const { partialOf, z, dateStr, dateTimeStr, timeStr, validate, paramId, normDateTime, setClause } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { staffProblems } = require('../lib/workforce');
const { audit } = require('../lib/audit');
const { tenantOf, localTime } = require('../lib/kiosk');
const { dayRange, addDays, nowIn, todayIn } = require('../lib/util');
const SH = require('../lib/shifts');

const router = express.Router();
const mgr = ['manager'];
const selfRoles = ['staff', 'counter', 'instructor', 'patrol'];

/**
 * Staff may only act on their own staff record. Managers pass any id (or fall back to their own).
 * Returns the staff id to use, or throws if a non-manager's login is not linked to a staff record.
 */
function actingStaffId(req, requested) {
  if (isManager(req)) {
    const id = requested ?? req.auth.staffId;
    if (!id) throw bad('staff_id is required');
    return id;
  }
  if (!req.auth.staffId) throw forbidden('Your login is not linked to a staff record. Ask a manager to link it.');
  if (requested && requested !== req.auth.staffId) throw forbidden('You can only do this for yourself');
  return req.auth.staffId;
}

// ---------------------------------------------------------------- positions & certifications
const positionFields = {
  name: z.string().min(1).max(100),
  department: z.enum(['lifts', 'rentals', 'ski_school', 'patrol', 'food', 'guest_services', 'grooming', 'maintenance', 'admin']),
  visits_per_staff: z.number().int().min(1).nullable().optional(),
};
router.use('/positions', crud({ table: 'positions', entity: 'Position', createSchema: z.object(positionFields), updateSchema: partialOf(positionFields), columns: ['name', 'department', 'visits_per_staff'], filters: ['department'], orderBy: 'department, name', readRoles: ['staff', 'counter', 'instructor', 'patrol'], writeRoles: mgr }));

const certFields = { name: z.string().min(1).max(100) };
router.use('/certifications', crud({ table: 'certifications', entity: 'Certification', createSchema: z.object(certFields), updateSchema: partialOf(certFields), columns: ['name'], orderBy: 'name', readRoles: ['staff', 'counter', 'instructor', 'patrol'], writeRoles: mgr }));

/** What a position requires, read before it is edited (saving replaces the list, so the form must start from it). */
router.get('/positions/:id/requirements', requireRole(...mgr), async (req, res) => {
  const pid = paramId(req);
  if (!(await one(pool, 'SELECT id FROM positions WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, pid]))) throw notFound('Position');
  const r = await rows(pool, 'SELECT certification_id FROM position_certifications WHERE tenant_id = ? AND position_id = ?', [req.auth.tenantId, pid]);
  res.json({ certification_ids: r.map((x) => Number(x.certification_id)) });
});

/** Positions with what each requires and who is trained for it, for the Setup tab. */
router.get('/positions-overview', requireRole(...mgr), async (req, res) => {
  const t = req.auth.tenantId;
  const [positions, reqs, trained] = await Promise.all([
    rows(pool, 'SELECT id, name, department, visits_per_staff FROM positions WHERE tenant_id = ? ORDER BY department, name', [t]),
    rows(pool, 'SELECT pc.position_id, c.id, c.name FROM position_certifications pc JOIN certifications c ON c.tenant_id = pc.tenant_id AND c.id = pc.certification_id WHERE pc.tenant_id = ? ORDER BY c.name', [t]),
    rows(pool, "SELECT sp.position_id, COUNT(*) AS n FROM staff_positions sp JOIN staff s ON s.tenant_id = sp.tenant_id AND s.id = sp.staff_id AND s.status = 'active' WHERE sp.tenant_id = ? GROUP BY sp.position_id", [t]),
  ]);
  const n = new Map(trained.map((r) => [Number(r.position_id), Number(r.n)]));
  res.json({ data: positions.map((p) => ({ ...p, requires: reqs.filter((r) => Number(r.position_id) === Number(p.id)).map((r) => ({ id: Number(r.id), name: r.name })), trained: n.get(Number(p.id)) || 0 })) });
});

router.put('/positions/:id/requirements', requireRole(...mgr), validate(z.object({ certification_ids: z.array(z.number().int().positive()).max(20) })), async (req, res) => {
  const pid = paramId(req);
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM positions WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, pid]))) throw notFound('Position');
    await conn.query('DELETE FROM position_certifications WHERE tenant_id = ? AND position_id = ?', [req.auth.tenantId, pid]);
    for (const cid of req.body.certification_ids) {
      await conn.query('INSERT INTO position_certifications (tenant_id, position_id, certification_id) VALUES (?, ?, ?)', [req.auth.tenantId, pid, cid]);
    }
    await audit(conn, req, 'set_requirements', 'positions', pid, req.body);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- staff
/** Create a staff record. Pass an existing person_id or a new person's details. */
router.post(
  '/staff',
  requireRole(...mgr),
  validate(
    z.object({
      person_id: z.number().int().positive().optional(),
      person: z.object({ first_name: z.string().min(1), last_name: z.string().min(1), email: z.string().email().optional(), phone: z.string().optional() }).optional(),
      status: z.enum(['applicant', 'onboarding', 'active', 'inactive']).default('onboarding'),
      hired_on: dateStr.optional(),
      needs_housing: z.boolean().default(false),
      employee: z.boolean().default(true), // false: a volunteer (not paid: no time clock, hours or payroll)
    }),
  ),
  async (req, res) => {
    const { tenantId } = req.auth;
    const b = req.body;
    if (!b.person_id && !b.person) throw bad('Provide person_id or person');
    const id = await tx(async (conn) => {
      let personId = b.person_id;
      if (!personId) {
        const [p] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)', [tenantId, b.person.first_name, b.person.last_name, b.person.email ?? null, b.person.phone ?? null]);
        personId = p.insertId;
      }
      const [s] = await conn.query('INSERT INTO staff (tenant_id, person_id, status, hired_on, needs_housing, in_workforce) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, personId, b.status, b.hired_on ?? null, b.needs_housing ? 1 : 0, b.employee ? 1 : 0]);
      await audit(conn, req, 'create', 'staff', s.insertId);
      return s.insertId;
    });
    res.status(201).json({ id });
  },
);

router.get('/staff', requireRole(...mgr), async (req, res) => {
  const t = req.auth.tenantId;
  // Everyone is on the staff list: employees (paid) and volunteers. ?type=employee or ?type=volunteer narrows it.
  const where = ['s.tenant_id = ?'];
  const params = [t];
  if (req.query.type === 'employee') where.push('s.in_workforce = 1');
  if (req.query.type === 'volunteer') where.push('s.in_workforce = 0');
  if (req.query.patrol === '1') where.push('EXISTS (SELECT 1 FROM patrol_members m WHERE m.tenant_id = s.tenant_id AND m.staff_id = s.id)');
  if (req.query.status) { where.push('s.status = ?'); params.push(String(req.query.status)); }
  if (req.query.q) {
    const q = `%${String(req.query.q).trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(CONCAT(p.first_name, ' ', p.last_name) LIKE ? OR p.email LIKE ? OR p.phone LIKE ?)"); params.push(q, q, q);
  }
  if (req.query.position_id) { where.push('EXISTS (SELECT 1 FROM staff_positions sp WHERE sp.tenant_id = s.tenant_id AND sp.staff_id = s.id AND sp.position_id = ?)'); params.push(Number(req.query.position_id)); }
  const data = await rows(
    pool,
    `SELECT s.*, p.first_name, p.last_name, p.email, p.phone, (SELECT COALESCE(u.username, u.email) FROM users u WHERE u.tenant_id = s.tenant_id AND u.staff_id = s.id AND u.active = 1 ORDER BY u.id LIMIT 1) AS login_name,
     EXISTS (SELECT 1 FROM patrol_members m WHERE m.tenant_id = s.tenant_id AND m.staff_id = s.id) AS on_patrol
     FROM staff s JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
     WHERE ${where.join(' AND ')} ORDER BY p.last_name, p.first_name LIMIT 500`,
    params,
  );
  const pos = await rows(pool, 'SELECT sp.staff_id, pos.id, pos.name FROM staff_positions sp JOIN positions pos ON pos.tenant_id = sp.tenant_id AND pos.id = sp.position_id WHERE sp.tenant_id = ? ORDER BY pos.name', [t]);
  const by = new Map();
  for (const r of pos) { const k = Number(r.staff_id); if (!by.has(k)) by.set(k, []); by.get(k).push({ id: Number(r.id), name: r.name }); }
  res.json({ data: data.map((r) => ({ ...r, employee: Boolean(r.in_workforce), on_patrol: Boolean(Number(r.on_patrol)), positions: by.get(Number(r.id)) || [] })) });
});

/** One person: everything about them in one place, whichever app they work in (one roster). */
router.get('/staff/:id', requireRole(...mgr), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  const s = await one(pool, 'SELECT s.*, p.first_name, p.last_name, p.email, p.phone FROM staff s JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND s.id = ?', [t, id]);
  if (!s) throw notFound('Staff member');
  const tz = (await tenantOf(pool, t)).timezone;
  const now = nowIn(tz);
  const week = SH.weekOf(todayIn(tz));
  const [positions, certs, windows, login, patrol, instructor, openDates, upcoming, future, worked] = await Promise.all([
    rows(pool, 'SELECT pos.id, pos.name, pos.department FROM staff_positions sp JOIN positions pos ON pos.tenant_id = sp.tenant_id AND pos.id = sp.position_id WHERE sp.tenant_id = ? AND sp.staff_id = ? ORDER BY pos.name', [t, id]),
    rows(pool, 'SELECT c.id, c.name, sc.issued_on, sc.expires_on FROM staff_certifications sc JOIN certifications c ON c.id = sc.certification_id AND c.tenant_id = sc.tenant_id WHERE sc.tenant_id = ? AND sc.staff_id = ? ORDER BY c.name', [t, id]),
    rows(pool, 'SELECT weekday, start_time, end_time FROM availability WHERE tenant_id = ? AND staff_id = ? ORDER BY weekday, start_time', [t, id]),
    one(pool, 'SELECT id, email, username, role FROM users WHERE tenant_id = ? AND staff_id = ? AND active = 1 ORDER BY id LIMIT 1', [t, id]),
    one(pool, 'SELECT level, callsign, access_level, patrol_number, (SELECT COUNT(*) FROM patrol_member_access a WHERE a.tenant_id = m.tenant_id AND a.staff_id = m.staff_id) AS exceptions FROM patrol_members m WHERE tenant_id = ? AND staff_id = ?', [t, id]),
    one(pool, 'SELECT is_public, display_name, disciplines, levels FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [t, id]),
    rows(pool, 'SELECT open_date, start_time, end_time FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date >= ? ORDER BY open_date, start_time LIMIT 10', [t, id, now.slice(0, 10)]),
    rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.status, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.staff_id = ? AND s.status <> 'cancelled' AND s.ends_at >= ?
      UNION ALL SELECT ps.id, ps.starts_at, ps.ends_at, ps.status, CONCAT('Patrol', IF(st.name IS NULL, '', CONCAT(', ', st.name))) AS position FROM patrol_shifts ps LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id
      WHERE ps.tenant_id = ? AND ps.staff_id = ? AND ps.status <> 'cancelled' AND ps.ends_at >= ? ORDER BY starts_at LIMIT 20`, [t, id, now, t, id, now]),
    one(pool, "SELECT COUNT(*) AS n FROM shifts WHERE tenant_id = ? AND staff_id = ? AND status <> 'cancelled' AND starts_at >= ?", [t, id, now]),
    rows(pool, 'SELECT clock_in, clock_out FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_in >= ? AND clock_in < ?', [t, id, dayRange(tz, week)[0], dayRange(tz, addDays(week, 6))[1]]),
  ]);
  const scheduled = (await SH.weekMinutes(pool, t, week)).get(id) || 0;
  const workedMin = worked.reduce((n, e) => n + SH.minutesBetween(e.clock_in, e.clock_out || nowIn('UTC')), 0);
  res.json({
    ...s, employee: Boolean(s.in_workforce), positions, certifications: certs, availability: windows, login: login || null,
    patrol: patrol || null, instructor: instructor ? { ...instructor, open_dates: openDates } : null,
    upcoming, future_shifts: Number(future.n), week: { start: week, scheduled_minutes: scheduled, worked_minutes: workedMin },
  });
});

router.put('/staff/:id/positions', requireRole(...mgr), validate(z.object({ position_ids: z.array(z.number().int().positive()).max(50) })), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Staff member');
    const ids = [...new Set(req.body.position_ids)];
    if (ids.length && (await rows(conn, 'SELECT id FROM positions WHERE tenant_id = ? AND id IN (?)', [t, ids])).length !== ids.length) throw bad('Unknown position');
    await conn.query('DELETE FROM staff_positions WHERE tenant_id = ? AND staff_id = ?', [t, id]);
    for (const pid of ids) await conn.query('INSERT INTO staff_positions (tenant_id, staff_id, position_id) VALUES (?, ?, ?)', [t, id, pid]);
    await audit(conn, req, 'set_positions', 'staff', id, { position_ids: ids });
  });
  res.json({ ok: true });
});

router.patch(
  '/staff/:id',
  requireRole(...mgr),
  validate(z.object({
    status: z.enum(['applicant', 'onboarding', 'active', 'inactive']).optional(), hired_on: dateStr.nullable().optional(), needs_housing: z.boolean().optional(), employee: z.boolean().optional(),
    first_name: z.string().trim().min(1).max(100).optional(), last_name: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().email().max(255).nullable().optional().or(z.literal('').transform(() => null)), phone: z.string().trim().max(40).nullable().optional(),
  })),
  async (req, res) => {
    const t = req.auth.tenantId;
    const id = paramId(req);
    const b = req.body;
    let unassigned = 0;
    await tx(async (conn) => {
      const st = await one(conn, 'SELECT id, person_id, status FROM staff WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
      if (!st) throw notFound('Staff member');
      const set = setClause({ ...b, needs_housing: b.needs_housing === undefined ? undefined : b.needs_housing ? 1 : 0, in_workforce: b.employee === undefined ? undefined : b.employee ? 1 : 0 }, ['status', 'hired_on', 'needs_housing', 'in_workforce']);
      const pset = setClause(b, ['first_name', 'last_name', 'email', 'phone']);
      if (!set && !pset) throw bad('No updatable fields supplied');
      if (set) await conn.query(`UPDATE staff SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, t, id]);
      if (pset) await conn.query(`UPDATE people SET ${pset.sql} WHERE tenant_id = ? AND id = ?`, [...pset.values, t, st.person_id]);
      // Someone who stops working here comes off every shift still ahead, which are left unfilled for someone else.
      if (b.status && b.status !== 'active' && st.status === 'active') {
        const now = nowIn((await tenantOf(conn, t)).timezone);
        const ahead = await rows(conn, "SELECT s.*, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.staff_id = ? AND s.status <> 'cancelled' AND s.starts_at >= ?", [t, id, now]);
        for (const sh of ahead) {
          await conn.query('UPDATE shifts SET staff_id = NULL WHERE tenant_id = ? AND id = ?', [t, sh.id]);
          await SH.notifyChange(conn, t, req.auth.userId, sh, { ...sh, staff_id: null });
        }
        unassigned = ahead.length;
      }
      await audit(conn, req, 'update', 'staff', id, { ...b, unassigned });
    });
    res.json({ ok: true, unassigned });
  },
);

router.put('/staff/:id/certifications', requireRole(...mgr), validate(z.object({ certification_id: z.number().int().positive(), issued_on: dateStr.optional(), expires_on: dateStr.nullable().optional() })), async (req, res) => {
  const b = req.body;
  await pool.query(
    `INSERT INTO staff_certifications (tenant_id, staff_id, certification_id, issued_on, expires_on) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE issued_on = VALUES(issued_on), expires_on = VALUES(expires_on)`,
    [req.auth.tenantId, paramId(req), b.certification_id, b.issued_on ?? null, b.expires_on ?? null],
  );
  await audit(pool, req, 'set_certification', 'staff', paramId(req), b);
  res.json({ ok: true });
});

router.delete('/staff/:id/certifications/:cid', requireRole(...mgr), async (req, res) => {
  const [r] = await pool.query('DELETE FROM staff_certifications WHERE tenant_id = ? AND staff_id = ? AND certification_id = ?', [req.auth.tenantId, paramId(req), paramId(req, 'cid')]);
  if (!r.affectedRows) throw notFound('Certification');
  await audit(pool, req, 'remove_certification', 'staff', paramId(req), { certification_id: paramId(req, 'cid') });
  res.status(204).end();
});

/** Someone's weekly availability, read before it is edited (saving replaces the whole pattern). */
router.get('/staff/:id/availability', requireRole(...selfRoles, ...mgr), async (req, res) => {
  const staffId = paramId(req);
  actingStaffId(req, staffId);
  if (!(await one(pool, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, staffId]))) throw notFound('Staff member');
  const windows = await rows(pool, 'SELECT weekday, TIME_FORMAT(start_time, \'%H:%i\') AS start_time, TIME_FORMAT(end_time, \'%H:%i\') AS end_time FROM availability WHERE tenant_id = ? AND staff_id = ? ORDER BY weekday, start_time', [req.auth.tenantId, staffId]);
  res.json({ windows });
});

router.get('/staff/:id/certifications', requireRole(...selfRoles, ...mgr), async (req, res) => {
  actingStaffId(req, paramId(req));
  res.json({
    data: await rows(
      pool,
      `SELECT c.id, c.name, sc.issued_on, sc.expires_on FROM staff_certifications sc JOIN certifications c ON c.id = sc.certification_id AND c.tenant_id = sc.tenant_id
       WHERE sc.tenant_id = ? AND sc.staff_id = ? ORDER BY c.name`,
      [req.auth.tenantId, paramId(req)],
    ),
  });
});

/** Certifications expiring within N days (default 30): the list a manager needs before the season starts. */
router.get('/certifications-expiring', requireRole(...mgr), async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 365);
  res.json({
    data: await rows(
      pool,
      `SELECT sc.staff_id, p.first_name, p.last_name, c.name AS certification, sc.expires_on
       FROM staff_certifications sc
       JOIN staff s ON s.id = sc.staff_id AND s.tenant_id = sc.tenant_id AND s.status = 'active'
       JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
       JOIN certifications c ON c.id = sc.certification_id AND c.tenant_id = sc.tenant_id
       WHERE sc.tenant_id = ? AND sc.expires_on IS NOT NULL AND sc.expires_on <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
       ORDER BY sc.expires_on`,
      [req.auth.tenantId, days],
    ),
  });
});

router.put(
  '/staff/:id/availability',
  requireRole(...selfRoles, ...mgr),
  validate(z.object({ windows: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_time: timeStr, end_time: timeStr })).max(21) })),
  async (req, res) => {
    const staffId = paramId(req);
    actingStaffId(req, staffId);
    for (const w of req.body.windows) if (w.end_time <= w.start_time) throw bad('end_time must be after start_time');
    await tx(async (conn) => {
      if (!(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, staffId]))) throw notFound('Staff member');
      await conn.query('DELETE FROM availability WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, staffId]);
      for (const w of req.body.windows) await conn.query('INSERT INTO availability (tenant_id, staff_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, staffId, w.weekday, w.start_time, w.end_time]);
    });
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------- shifts
const shiftSchema = z.object({
  position_id: z.number().int().positive(),
  staff_id: z.number().int().positive().optional(),
  starts_at: dateTimeStr.transform(normDateTime),
  ends_at: dateTimeStr.transform(normDateTime),
  notes: z.string().trim().max(200).optional(),
  override_availability: z.boolean().default(false),
});
const tooLong = (a, b) => SH.minutesBetween(a, b) > 24 * 60;

/** Patrol is scheduled in Patrol (its own roster and schedule), so a Patrol-department position cannot get work shifts. */
async function notPatrol(conn, tenantId, positionId) {
  const pos = await one(conn, 'SELECT department FROM positions WHERE tenant_id = ? AND id = ?', [tenantId, positionId]);
  if (!pos) throw notFound('Position');
  if (pos.department === 'patrol') throw bad('Patrol shifts are scheduled in Patrol, on its Schedule tab');
}

router.post('/shifts', requireRole(...mgr), validate(shiftSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  if (b.ends_at <= b.starts_at) throw bad('The shift must end after it starts');
  if (tooLong(b.starts_at, b.ends_at)) throw bad('A shift can be at most 24 hours');
  const id = await tx(async (conn) => {
    await notPatrol(conn, tenantId, b.position_id);
    if (b.staff_id) {
      const problems = await staffProblems(conn, tenantId, { staffId: b.staff_id, positionId: b.position_id, startsAt: b.starts_at, endsAt: b.ends_at, skipAvailability: b.override_availability });
      if (problems.length) throw conflict('Cannot assign this person to the shift', problems);
    }
    const [r] = await conn.query('INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at, notes) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, b.position_id, b.staff_id ?? null, b.starts_at, b.ends_at, b.notes || null]);
    await audit(conn, req, 'create', 'shifts', r.insertId);
    return r.insertId;
  });
  res.status(201).json({ id, status: 'draft' });
});

/**
 * Change a shift: its time, position, person or note. Every check runs again for whoever is on it afterwards. When the
 * shift is already published, the people it affects are told in the Inbox.
 */
async function changeShift(req, shiftId, changes, override) {
  const { tenantId } = req.auth;
  return tx(async (conn) => {
    const before = await one(conn, 'SELECT s.*, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.id = ? FOR UPDATE', [tenantId, shiftId]);
    if (!before) throw notFound('Shift');
    if (before.status === 'cancelled') throw conflict('This shift is cancelled');
    const next = { ...before, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
    if (next.ends_at <= next.starts_at) throw bad('The shift must end after it starts');
    if (tooLong(next.starts_at, next.ends_at)) throw bad('A shift can be at most 24 hours');
    if (changes.position_id) await notPatrol(conn, tenantId, changes.position_id);
    if (next.staff_id) {
      const problems = await staffProblems(conn, tenantId, { staffId: next.staff_id, positionId: next.position_id, startsAt: next.starts_at, endsAt: next.ends_at, ignoreShiftId: shiftId, skipAvailability: override });
      if (problems.length) throw conflict('Cannot assign this person to the shift', problems);
    }
    await conn.query('UPDATE shifts SET position_id = ?, staff_id = ?, starts_at = ?, ends_at = ?, notes = ? WHERE tenant_id = ? AND id = ?', [next.position_id, next.staff_id || null, next.starts_at, next.ends_at, next.notes || null, tenantId, shiftId]);
    const after = await SH.shiftRow(conn, tenantId, shiftId);
    await SH.notifyChange(conn, tenantId, req.auth.userId, before, after);
    await audit(conn, req, 'update', 'shifts', shiftId, changes);
    return after;
  });
}

router.patch('/shifts/:id', requireRole(...mgr), validate(z.object({
  position_id: z.number().int().positive().optional(),
  staff_id: z.number().int().positive().nullable().optional(),
  starts_at: dateTimeStr.transform(normDateTime).optional(),
  ends_at: dateTimeStr.transform(normDateTime).optional(),
  notes: z.string().trim().max(200).nullable().optional(),
  override_availability: z.boolean().default(false),
})), async (req, res) => {
  const { override_availability: o, ...changes } = req.body;
  res.json(await changeShift(req, paramId(req), changes, o));
});

router.patch('/shifts/:id/assign', requireRole(...mgr), validate(z.object({ staff_id: z.number().int().positive().nullable(), override_availability: z.boolean().default(false) })), async (req, res) => {
  await changeShift(req, paramId(req), { staff_id: req.body.staff_id }, req.body.override_availability);
  res.json({ ok: true });
});

/** Who could work this shift, best first, with the reasons anyone cannot. An unsaved shift can be checked too. */
router.get('/shifts/:id/candidates', requireRole(...mgr), async (req, res) => {
  const s = await SH.shiftRow(pool, req.auth.tenantId, paramId(req));
  if (!s) throw notFound('Shift');
  res.json({ data: await SH.candidates(pool, req.auth.tenantId, s) });
});
router.post('/shifts/candidates', requireRole(...mgr), validate(z.object({ position_id: z.number().int().positive(), starts_at: dateTimeStr.transform(normDateTime), ends_at: dateTimeStr.transform(normDateTime) })), async (req, res) => {
  if (req.body.ends_at <= req.body.starts_at) throw bad('The shift must end after it starts');
  res.json({ data: await SH.candidates(pool, req.auth.tenantId, { ...req.body, id: 0, staff_id: null }) });
});

router.post('/shifts/publish', requireRole(...mgr), validate(z.object({ from: dateStr, to: dateStr })), async (req, res) => {
  const out = await tx(async (conn) => {
    const [r] = await conn.query("UPDATE shifts SET status = 'published' WHERE tenant_id = ? AND status = 'draft' AND DATE(starts_at) BETWEEN ? AND ?", [req.auth.tenantId, req.body.from, req.body.to]);
    await audit(conn, req, 'publish', 'shifts', null, req.body);
    const told = r.affectedRows ? await SH.notifyPublished(conn, req.auth.tenantId, req.auth.userId, req.body.from, req.body.to) : 0;
    return { published: r.affectedRows, notified: told };
  });
  res.json(out);
});

router.delete('/shifts/:id', requireRole(...mgr), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const before = await one(conn, 'SELECT s.*, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.id = ? FOR UPDATE', [t, paramId(req)]);
    if (!before) throw notFound('Shift');
    await conn.query("UPDATE shifts SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [t, paramId(req)]);
    if (before.status !== 'cancelled') await SH.notifyChange(conn, t, req.auth.userId, before, null);
    await audit(conn, req, 'cancel', 'shifts', paramId(req));
  });
  res.status(204).end();
});

router.get('/shifts', requireRole('staff', 'counter', 'instructor', 'patrol', ...mgr), async (req, res) => {
  const where = ["s.tenant_id = ?", "s.status <> 'cancelled'"];
  const params = [req.auth.tenantId];
  if (req.query.from) { where.push('DATE(s.starts_at) >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('DATE(s.starts_at) <= ?'); params.push(String(req.query.to)); }
  if (req.query.staff_id) { where.push('s.staff_id = ?'); params.push(Number(req.query.staff_id)); }
  if (req.query.unfilled === 'true') where.push('s.staff_id IS NULL');
  // Non-managers only see published shifts.
  if (!['owner', 'manager'].includes(req.auth.role)) where.push("s.status = 'published'");
  const data = await rows(
    pool,
    `SELECT s.*, pos.name AS position, pos.department, p.first_name, p.last_name
     FROM shifts s JOIN positions pos ON pos.id = s.position_id AND pos.tenant_id = s.tenant_id
     LEFT JOIN staff st ON st.id = s.staff_id AND st.tenant_id = s.tenant_id
     LEFT JOIN people p ON p.id = st.person_id AND p.tenant_id = st.tenant_id
     WHERE ${where.join(' AND ')} ORDER BY s.starts_at, pos.name LIMIT 1000`,
    params,
  );
  res.json({ data });
});

/** Copy one week's shifts into another as drafts. People are kept where they can still work the shift. */
router.post('/shifts/copy', requireRole(...mgr), validate(z.object({ from: dateStr, to: dateStr, keep_people: z.boolean().default(true) })), async (req, res) => {
  const t = req.auth.tenantId;
  const from = SH.weekOf(req.body.from); const to = SH.weekOf(req.body.to);
  if (from === to) throw bad('Choose a different week to copy into');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const out = await tx(async (conn) => {
    const src = await rows(conn, "SELECT position_id, staff_id, starts_at, ends_at, notes FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ? ORDER BY starts_at", [t, `${from} 00:00:00`, `${addDays(from, 7)} 00:00:00`]);
    if (!src.length) throw bad('That week has no shifts to copy');
    const list = src.map((s) => ({ ...s, staff_id: req.body.keep_people ? s.staff_id : null, starts_at: SH.plusMinutes(s.starts_at, days * 1440), ends_at: SH.plusMinutes(s.ends_at, days * 1440) }));
    const r = await SH.makeDrafts(conn, t, list);
    await audit(conn, req, 'copy_week', 'shifts', null, { from, to, ...r, left_open: undefined });
    return r;
  });
  res.json(out);
});

/** Patrol coverage for the schedule grid: read only here, because patrol is scheduled in Patrol. */
router.get('/patrol-coverage', requireRole(...mgr), async (req, res) => {
  const from = String(req.query.from || ''); const to = String(req.query.to || '');
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('from and to are required');
  res.json({ data: await rows(pool, `SELECT ps.id, ps.staff_id, ps.starts_at, ps.ends_at, ps.status, ps.role_label, st.name AS station, p.first_name, p.last_name, s.in_workforce
    FROM patrol_shifts ps LEFT JOIN staff s ON s.tenant_id = ps.tenant_id AND s.id = ps.staff_id LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id
    WHERE ps.tenant_id = ? AND ps.status <> 'cancelled' AND DATE(ps.starts_at) BETWEEN ? AND ? ORDER BY ps.starts_at`, [req.auth.tenantId, from, to]) });
});

// ---------------------------------------------------------------- week templates
router.get('/shift-templates', requireRole(...mgr), async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT t.id, t.name, t.created_at, COUNT(i.id) AS shifts FROM shift_templates t LEFT JOIN shift_template_items i ON i.tenant_id = t.tenant_id AND i.template_id = t.id WHERE t.tenant_id = ? GROUP BY t.id ORDER BY t.name', [req.auth.tenantId]) });
});

/** Save a week's shifts (Monday to Sunday) as a template. Saving under an existing name replaces it. */
router.post('/shift-templates', requireRole(...mgr), validate(z.object({ name: z.string().trim().min(1).max(80), from: dateStr, keep_people: z.boolean().default(true) })), async (req, res) => {
  const t = req.auth.tenantId;
  const week = SH.weekOf(req.body.from);
  const id = await tx(async (conn) => {
    const src = await rows(conn, "SELECT position_id, staff_id, starts_at, ends_at, notes FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ? ORDER BY starts_at", [t, `${week} 00:00:00`, `${addDays(week, 7)} 00:00:00`]);
    if (!src.length) throw bad('That week has no shifts to save');
    await conn.query('INSERT INTO shift_templates (tenant_id, name, created_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE created_by = VALUES(created_by), created_at = CURRENT_TIMESTAMP', [t, req.body.name, req.auth.userId]);
    const tpl = await one(conn, 'SELECT id FROM shift_templates WHERE tenant_id = ? AND name = ?', [t, req.body.name]);
    await conn.query('DELETE FROM shift_template_items WHERE tenant_id = ? AND template_id = ?', [t, tpl.id]);
    for (const s of src) {
      const offset = Math.round((Date.parse(String(s.starts_at).slice(0, 10)) - Date.parse(week)) / 86_400_000);
      await conn.query('INSERT INTO shift_template_items (tenant_id, template_id, day_offset, start_time, minutes, position_id, staff_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [t, tpl.id, offset, String(s.starts_at).slice(11, 19), SH.minutesBetween(s.starts_at, s.ends_at), s.position_id, req.body.keep_people ? s.staff_id : null, s.notes]);
    }
    await audit(conn, req, 'save_template', 'shift_templates', tpl.id, { name: req.body.name, week, shifts: src.length });
    return tpl.id;
  });
  res.status(201).json({ id });
});

router.post('/shift-templates/:id/apply', requireRole(...mgr), validate(z.object({ week: dateStr })), async (req, res) => {
  const t = req.auth.tenantId;
  const week = SH.weekOf(req.body.week);
  const out = await tx(async (conn) => {
    const tpl = await one(conn, 'SELECT id, name FROM shift_templates WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
    if (!tpl) throw notFound('Template');
    const items = await rows(conn, 'SELECT * FROM shift_template_items WHERE tenant_id = ? AND template_id = ? ORDER BY day_offset, start_time', [t, tpl.id]);
    const list = items.map((i) => { const starts = SH.shiftDt(addDays(week, i.day_offset), i.start_time); return { position_id: i.position_id, staff_id: i.staff_id, notes: i.notes, starts_at: starts, ends_at: SH.plusMinutes(starts, i.minutes) }; });
    const r = await SH.makeDrafts(conn, t, list);
    await audit(conn, req, 'apply_template', 'shift_templates', tpl.id, { week, ...r, left_open: undefined });
    return r;
  });
  res.json(out);
});

router.delete('/shift-templates/:id', requireRole(...mgr), async (req, res) => {
  const [r] = await pool.query('DELETE FROM shift_templates WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Template');
  await audit(pool, req, 'delete', 'shift_templates', paramId(req));
  res.status(204).end();
});

// ---------------------------------------------------------------- time clock
router.post('/time/clock-in', requireRole(...selfRoles, ...mgr), validate(z.object({ staff_id: z.number().int().positive().optional(), shift_id: z.number().int().positive().optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const staffId = actingStaffId(req, req.body.staff_id);
  // The person's row is locked while we look, so two taps at once cannot both clock them in (and the database refuses a second open punch anyway).
  const id = await tx(async (conn) => {
    const st = await one(conn, 'SELECT id, in_workforce FROM staff WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, staffId]);
    if (!st) throw notFound('Staff member');
    if (!st.in_workforce) throw bad('Volunteers do not clock in. Patrol counts their days from the patrol schedule and Today\'s posts.');
    if (await one(conn, 'SELECT id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [tenantId, staffId])) throw conflict('Already clocked in');
    try {
      // Link the punch to the shift it is for (as the kiosk does): the published shift closest to now, starting up to 3 hours ahead.
      let link = { shift_id: req.body.shift_id ?? null, patrol_shift_id: null };
      if (!link.shift_id) link = await SH.shiftForPunch(conn, tenantId, staffId, nowIn((await tenantOf(conn, tenantId)).timezone));
      const [r] = await conn.query("INSERT INTO time_entries (tenant_id, staff_id, shift_id, patrol_shift_id, clock_in, in_method) VALUES (?, ?, ?, ?, NOW(), 'login')", [tenantId, staffId, link.shift_id, link.patrol_shift_id]);
      return r.insertId;
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('Already clocked in'); throw e; }
  });
  res.status(201).json({ id });
});

router.post('/time/clock-out', requireRole(...selfRoles, ...mgr), validate(z.object({ staff_id: z.number().int().positive().optional() })), async (req, res) => {
  const staffId = actingStaffId(req, req.body.staff_id);
  const [r] = await pool.query("UPDATE time_entries SET clock_out = NOW(), out_method = 'login' WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL", [req.auth.tenantId, staffId]);
  if (!r.affectedRows) throw conflict('Not clocked in');
  res.json({ ok: true });
});

/** Everything a staff member needs on their own phone: clock state and their upcoming published shifts. */
router.get('/me', requireRole(...selfRoles, ...mgr), async (req, res) => {
  const { tenantId, staffId } = req.auth;
  if (!staffId) return res.json({ linked: false, open_entry: null, shifts: [] });
  const [open, shifts] = await Promise.all([
    one(pool, 'SELECT id, clock_in FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [tenantId, staffId]),
    rows(
      pool,
      `SELECT s.id, s.starts_at, s.ends_at, pos.name AS position, 'work' AS kind FROM shifts s
       JOIN positions pos ON pos.id = s.position_id AND pos.tenant_id = s.tenant_id
       WHERE s.tenant_id = ? AND s.staff_id = ? AND s.status = 'published' AND s.ends_at >= NOW() - INTERVAL 1 DAY
       UNION ALL
       SELECT ps.id, ps.starts_at, ps.ends_at, CONCAT('Patrol', IF(st.name IS NULL, '', CONCAT(', ', st.name)), IF(ps.role_label IS NULL, '', CONCAT(', ', ps.role_label))) AS position, 'patrol' AS kind
       FROM patrol_shifts ps LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id
       WHERE ps.tenant_id = ? AND ps.staff_id = ? AND ps.status = 'published' AND ps.ends_at >= NOW() - INTERVAL 1 DAY
       ORDER BY starts_at LIMIT 30`,
      [tenantId, staffId, tenantId, staffId],
    ),
  ]);
  // Clock times are kept on the database clock; show them as the mountain's local time.
  const t = await tenantOf(pool, tenantId);
  res.json({ linked: true, staff_id: staffId, open_entry: open ? { ...open, clock_in: localTime(open.clock_in, t.timezone) } : null, shifts });
});

router.get('/time/entries', requireRole(...mgr), async (req, res) => {
  const t = await tenantOf(pool, req.auth.tenantId);
  const where = ['tenant_id = ?'];
  const params = [req.auth.tenantId];
  if (req.query.staff_id) { where.push('staff_id = ?'); params.push(Number(req.query.staff_id)); }
  // The dates are the mountain's local days; the database clock is UTC, so convert the edges.
  if (req.query.from) { where.push('clock_in >= ?'); params.push(dayRange(t.timezone, String(req.query.from))[0]); }
  if (req.query.to) { where.push('clock_in < ?'); params.push(dayRange(t.timezone, String(req.query.to))[1]); }
  const data = await rows(pool, `SELECT *, TIMESTAMPDIFF(MINUTE, clock_in, COALESCE(clock_out, NOW())) AS minutes FROM time_entries WHERE ${where.join(' AND ')} ORDER BY clock_in DESC LIMIT 1000`, params);
  res.json({ data: data.map((e) => ({ ...e, clock_in: localTime(e.clock_in, t.timezone), clock_out: e.clock_out ? localTime(e.clock_out, t.timezone) : null })) });
});

// ---------------------------------------------------------------- demand-aware staffing
/**
 * Suggested headcount per position for a date, from expected guests: day tickets sold for that date plus pass holders
 * (the average number of passes scanned on the same weekday over the last four weeks). Pass `forecast` to use your own
 * number. Only filled shifts count as staffed; empty ones are listed apart. Positions need "guests per staff member".
 */
router.get('/staffing-suggestion', requireRole(...mgr), async (req, res) => {
  const date = String(req.query.date || '');
  if (!dateStr.safeParse(date).success) throw bad('date=YYYY-MM-DD is required');
  const { tenantId } = req.auth;
  const tz = (await tenantOf(pool, tenantId)).timezone;

  let forecast = Number(req.query.forecast);
  let basis = 'override';
  let tickets = null; let passes = null;
  if (!Number.isFinite(forecast) || req.query.forecast === '' || req.query.forecast === undefined) {
    tickets = Number((await one(pool, "SELECT COUNT(*) AS n FROM tickets t JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND t.status = 'active' AND p.kind IN ('day_ticket','multi_day') AND ? BETWEEN t.valid_from AND t.valid_to", [tenantId, date])).n);
    let total = 0;
    for (let w = 1; w <= 4; w += 1) {
      const [a, b] = dayRange(tz, addDays(date, -7 * w));
      total += Number((await one(pool, "SELECT COUNT(DISTINCT sc.ticket_id) AS n FROM scans sc JOIN tickets t ON t.tenant_id = sc.tenant_id AND t.id = sc.ticket_id JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id WHERE sc.tenant_id = ? AND sc.result = 'ok' AND sc.scanned_at >= ? AND sc.scanned_at < ? AND p.kind IN ('season_pass','punch_card')", [tenantId, a, b])).n);
    }
    passes = Math.round(total / 4);
    forecast = tickets + passes;
    basis = 'tickets_and_passes';
  }
  const positions = await rows(pool, 'SELECT id, name, department, visits_per_staff FROM positions WHERE tenant_id = ? AND visits_per_staff IS NOT NULL ORDER BY department, name', [tenantId]);
  const scheduled = await rows(pool, "SELECT position_id, SUM(staff_id IS NOT NULL) AS filled, SUM(staff_id IS NULL) AS empty FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND DATE(starts_at) = ? GROUP BY position_id", [tenantId, date]);
  const have = new Map(scheduled.map((s) => [Number(s.position_id), s]));
  // Patrol positions are staffed from the patrol schedule.
  const pat = await one(pool, "SELECT SUM(staff_id IS NOT NULL) AS filled, SUM(staff_id IS NULL) AS empty FROM patrol_shifts WHERE tenant_id = ? AND status <> 'cancelled' AND DATE(starts_at) = ?", [tenantId, date]);
  for (const p of positions) if (p.department === 'patrol') have.set(Number(p.id), { filled: Number(pat.filled || 0), empty: Number(pat.empty || 0) });
  const data = positions.map((p) => {
    const suggested = forecast > 0 ? Math.max(1, Math.ceil(forecast / p.visits_per_staff)) : 0;
    const h = have.get(Number(p.id)) || { filled: 0, empty: 0 };
    return { position_id: p.id, position: p.name, department: p.department, suggested, scheduled: Number(h.filled), unfilled: Number(h.empty), gap: suggested - Number(h.filled) };
  });
  res.json({ date, forecast_visits: forecast, tickets, pass_estimate: passes, basis, data });
});

module.exports = router;
