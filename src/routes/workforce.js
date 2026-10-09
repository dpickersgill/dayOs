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
const { dayRange } = require('../lib/util');

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
      const [s] = await conn.query('INSERT INTO staff (tenant_id, person_id, status, hired_on, needs_housing) VALUES (?, ?, ?, ?, ?)', [tenantId, personId, b.status, b.hired_on ?? null, b.needs_housing ? 1 : 0]);
      await audit(conn, req, 'create', 'staff', s.insertId);
      return s.insertId;
    });
    res.status(201).json({ id });
  },
);

router.get('/staff', requireRole(...mgr), async (req, res) => {
  const where = ['s.tenant_id = ?'];
  const params = [req.auth.tenantId];
  if (req.query.status) {
    where.push('s.status = ?');
    params.push(String(req.query.status));
  }
  const data = await rows(
    pool,
    `SELECT s.*, p.first_name, p.last_name, p.email, p.phone FROM staff s JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
     WHERE ${where.join(' AND ')} ORDER BY p.last_name, p.first_name LIMIT 500`,
    params,
  );
  res.json({ data });
});

router.patch(
  '/staff/:id',
  requireRole(...mgr),
  validate(z.object({ status: z.enum(['applicant', 'onboarding', 'active', 'inactive']).optional(), hired_on: dateStr.nullable().optional(), needs_housing: z.boolean().optional() }).transform((v) => ({ ...v, needs_housing: v.needs_housing === undefined ? undefined : v.needs_housing ? 1 : 0 }))),
  async (req, res) => {
    const set = setClause(req.body, ['status', 'hired_on', 'needs_housing']);
    if (!set) throw bad('No updatable fields supplied');
    const [r] = await pool.query(`UPDATE staff SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
    if (!r.affectedRows) throw notFound('Staff member');
    await audit(pool, req, 'update', 'staff', paramId(req), req.body);
    res.json({ ok: true });
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
  override_availability: z.boolean().default(false),
});

router.post('/shifts', requireRole(...mgr), validate(shiftSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  if (b.ends_at <= b.starts_at) throw bad('ends_at must be after starts_at');
  const id = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM positions WHERE tenant_id = ? AND id = ?', [tenantId, b.position_id]))) throw notFound('Position');
    if (b.staff_id) {
      const problems = await staffProblems(conn, tenantId, { staffId: b.staff_id, positionId: b.position_id, startsAt: b.starts_at, endsAt: b.ends_at, skipAvailability: b.override_availability });
      if (problems.length) throw conflict('Cannot assign this person to the shift', problems);
    }
    const [r] = await conn.query('INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)', [tenantId, b.position_id, b.staff_id ?? null, b.starts_at, b.ends_at]);
    await audit(conn, req, 'create', 'shifts', r.insertId);
    return r.insertId;
  });
  res.status(201).json({ id, status: 'draft' });
});

router.patch(
  '/shifts/:id/assign',
  requireRole(...mgr),
  validate(z.object({ staff_id: z.number().int().positive().nullable(), override_availability: z.boolean().default(false) })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const shiftId = paramId(req);
    await tx(async (conn) => {
      const shift = await one(conn, 'SELECT * FROM shifts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, shiftId]);
      if (!shift) throw notFound('Shift');
      if (req.body.staff_id) {
        const problems = await staffProblems(conn, tenantId, { staffId: req.body.staff_id, positionId: shift.position_id, startsAt: shift.starts_at, endsAt: shift.ends_at, ignoreShiftId: shiftId, skipAvailability: req.body.override_availability });
        if (problems.length) throw conflict('Cannot assign this person to the shift', problems);
      }
      await conn.query('UPDATE shifts SET staff_id = ? WHERE tenant_id = ? AND id = ?', [req.body.staff_id, tenantId, shiftId]);
      await audit(conn, req, 'assign', 'shifts', shiftId, { staff_id: req.body.staff_id });
    });
    res.json({ ok: true });
  },
);

router.post('/shifts/publish', requireRole(...mgr), validate(z.object({ from: dateStr, to: dateStr })), async (req, res) => {
  const [r] = await pool.query("UPDATE shifts SET status = 'published' WHERE tenant_id = ? AND status = 'draft' AND DATE(starts_at) BETWEEN ? AND ?", [req.auth.tenantId, req.body.from, req.body.to]);
  await audit(pool, req, 'publish', 'shifts', null, req.body);
  res.json({ published: r.affectedRows });
});

router.delete('/shifts/:id', requireRole(...mgr), async (req, res) => {
  const [r] = await pool.query("UPDATE shifts SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Shift');
  await audit(pool, req, 'cancel', 'shifts', paramId(req));
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

// ---------------------------------------------------------------- time clock
router.post('/time/clock-in', requireRole(...selfRoles, ...mgr), validate(z.object({ staff_id: z.number().int().positive().optional(), shift_id: z.number().int().positive().optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const staffId = actingStaffId(req, req.body.staff_id);
  // The person's row is locked while we look, so two taps at once cannot both clock them in (and the database refuses a second open punch anyway).
  const id = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, staffId]))) throw notFound('Staff member');
    if (await one(conn, 'SELECT id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [tenantId, staffId])) throw conflict('Already clocked in');
    try {
      const [r] = await conn.query('INSERT INTO time_entries (tenant_id, staff_id, shift_id, clock_in) VALUES (?, ?, ?, NOW())', [tenantId, staffId, req.body.shift_id ?? null]);
      return r.insertId;
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('Already clocked in'); throw e; }
  });
  res.status(201).json({ id });
});

router.post('/time/clock-out', requireRole(...selfRoles, ...mgr), validate(z.object({ staff_id: z.number().int().positive().optional() })), async (req, res) => {
  const staffId = actingStaffId(req, req.body.staff_id);
  const [r] = await pool.query('UPDATE time_entries SET clock_out = NOW() WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [req.auth.tenantId, staffId]);
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
      `SELECT s.id, s.starts_at, s.ends_at, pos.name AS position FROM shifts s
       JOIN positions pos ON pos.id = s.position_id AND pos.tenant_id = s.tenant_id
       WHERE s.tenant_id = ? AND s.staff_id = ? AND s.status = 'published' AND s.ends_at >= NOW() - INTERVAL 1 DAY
       ORDER BY s.starts_at LIMIT 30`,
      [tenantId, staffId],
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
 * Suggested headcount per position for a date, from forecast visits.
 * Forecast = tickets valid that day (sold, not void) + season passes' average usage is not modeled here;
 * pass a `forecast` query value to override. Positions need visits_per_staff set to be included.
 */
router.get('/staffing-suggestion', requireRole(...mgr), async (req, res) => {
  const date = String(req.query.date || '');
  if (!dateStr.safeParse(date).success) throw bad('date=YYYY-MM-DD is required');
  const { tenantId } = req.auth;

  let forecast = Number(req.query.forecast);
  let basis = 'override';
  if (!Number.isFinite(forecast)) {
    const sold = await one(pool, "SELECT COUNT(*) AS n FROM tickets t JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND t.status = 'active' AND p.kind IN ('day_ticket','multi_day') AND ? BETWEEN t.valid_from AND t.valid_to", [tenantId, date]);
    forecast = sold.n;
    basis = 'tickets_sold_for_date';
  }
  const positions = await rows(pool, 'SELECT id, name, department, visits_per_staff FROM positions WHERE tenant_id = ? AND visits_per_staff IS NOT NULL ORDER BY department, name', [tenantId]);
  const scheduled = await rows(pool, "SELECT position_id, COUNT(*) AS n FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND DATE(starts_at) = ? GROUP BY position_id", [tenantId, date]);
  const have = new Map(scheduled.map((s) => [s.position_id, s.n]));
  const data = positions.map((p) => {
    const suggested = Math.max(1, Math.ceil(forecast / p.visits_per_staff));
    const scheduledCount = have.get(p.id) || 0;
    return { position_id: p.id, position: p.name, department: p.department, suggested, scheduled: scheduledCount, gap: suggested - scheduledCount };
  });
  res.json({ date, forecast_visits: forecast, basis, data });
});

module.exports = router;
