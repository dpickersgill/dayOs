'use strict';

const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { crud } = require('../lib/crud');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, dateTimeStr, validate, paramId, normDateTime } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PS = require('../lib/programsessions');
const { instructorBusy } = require('../lib/workforce');

/** Does this staff member coach this program meeting (named on it, on its day, or on a level class of its day)? */
async function coachesMeeting(conn, tenantId, staffId, m) {
  if (!staffId) return false;
  if (m.coach_staff_id === staffId) return true;
  if (!m.group_id) return false;
  const g = await one(conn, 'SELECT coach_staff_id FROM program_groups WHERE tenant_id = ? AND id = ?', [tenantId, m.group_id]);
  if (!m.coach_staff_id && g && g.coach_staff_id === staffId) return true;
  return Boolean(await one(conn, 'SELECT id FROM program_levels WHERE tenant_id = ? AND group_id = ? AND coach_staff_id = ? LIMIT 1', [tenantId, m.group_id, staffId]));
}

const router = express.Router();
const coord = ['manager', 'instructor'];

const programFields = {
  name: z.string().min(1).max(255),
  kind: z.enum(['club', 'race_team', 'school_program', 'camp', 'league']).default('school_program'), // kept for older reports; the type_id is what staff see
  season: z.string().min(4).max(20),
  capacity: z.number().int().min(1).nullable().optional(),
  price_cents: z.number().int().min(0).default(0),
  starts_on: dateStr.nullable().optional(),
  ends_on: dateStr.nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  age_min: z.number().int().min(0).max(99).nullable().optional(),
  age_max: z.number().int().min(0).max(99).nullable().optional(),
  online: z.boolean().optional(),
  active: z.boolean().optional(),
  includes_ticket: z.boolean().optional(),
  ticket_product_id: z.number().int().positive().nullable().optional(),
  includes_rental: z.boolean().optional(),
  rental_product_id: z.number().int().positive().nullable().optional(),
  sibling_mode: z.enum(['none', 'percent', 'amount']).optional(),
  sibling_value: z.number().int().min(0).max(100000).optional(),
  level_mode: z.enum(['on_arrival', 'preset']).optional(),
  type_id: z.number().int().positive().nullable().optional(),
  offers_helmet: z.boolean().optional(),
  meeting_place: z.string().trim().max(160).nullable().optional(),
  what_to_bring: z.string().trim().max(300).nullable().optional(),
  policy_text: z.string().trim().max(1000).nullable().optional(),
  cancel_days: z.number().int().min(0).max(365).nullable().optional(),
  cancel_fee_cents: z.number().int().min(0).max(1000000).optional(),
  allow_switch: z.boolean().optional(),
  late_join: z.enum(['closed', 'prorate', 'full']).optional(),
  disciplines: z.enum(['ski,snowboard', 'ski', 'snowboard']).optional(),
  snowboard_age_min: z.number().int().min(0).max(99).nullable().optional(),
  ask_safety: z.boolean().optional(),
};
const PROGRAM_COLUMNS = ['name', 'kind', 'season', 'capacity', 'price_cents', 'starts_on', 'ends_on', 'description', 'age_min', 'age_max', 'online', 'active', 'includes_ticket', 'ticket_product_id', 'includes_rental', 'rental_product_id', 'sibling_mode', 'sibling_value', 'level_mode', 'type_id', 'offers_helmet', 'meeting_place', 'what_to_bring', 'policy_text', 'cancel_days', 'cancel_fee_cents', 'allow_switch', 'late_join', 'disciplines', 'snowboard_age_min', 'ask_safety'];

/** Enroll a participant. When the program is full they go on the waitlist instead of being rejected. */
router.post('/:id/enrollments', requireRole(...coord, 'counter'), validate(z.object({ person_id: z.number().int().positive(), guardian_id: z.number().int().positive().optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const pid = paramId(req);
  const result = await tx(async (conn) => {
    const program = await one(conn, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, pid]);
    if (!program) throw notFound('Program');
    const person = await one(conn, 'SELECT date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [tenantId, req.body.person_id]);
    if (!person) throw notFound('Person');
    const existing = await one(conn, "SELECT id, status FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND person_id = ?", [tenantId, pid, req.body.person_id]);
    if (existing && existing.status !== 'withdrawn') throw conflict(`Already ${existing.status} in this program`);

    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND status = 'enrolled'", [tenantId, pid]);
    const status = program.capacity !== null && n >= program.capacity ? 'waitlist' : 'enrolled';
    let id;
    if (existing) {
      await conn.query('UPDATE program_enrollments SET status = ?, guardian_id = ? WHERE id = ? AND tenant_id = ?', [status, req.body.guardian_id ?? null, existing.id, tenantId]);
      id = existing.id;
    } else {
      const [r] = await conn.query('INSERT INTO program_enrollments (tenant_id, program_id, person_id, guardian_id, status) VALUES (?, ?, ?, ?, ?)', [tenantId, pid, req.body.person_id, req.body.guardian_id ?? null, status]);
      id = r.insertId;
    }
    await audit(conn, req, 'enroll', 'programs', pid, { person_id: req.body.person_id, status });
    return { id, status };
  });
  res.status(201).json(result);
});

/** Withdraw a participant; the earliest waitlisted person is promoted automatically. */
router.post('/:id/enrollments/:enrollmentId/withdraw', requireRole(...coord), async (req, res) => {
  const { tenantId } = req.auth;
  const pid = paramId(req);
  const eid = paramId(req, 'enrollmentId');
  const promoted = await tx(async (conn) => {
    const program = await one(conn, 'SELECT id FROM programs WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, pid]);
    if (!program) throw notFound('Program');
    const e = await one(conn, 'SELECT * FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND id = ?', [tenantId, pid, eid]);
    if (!e) throw notFound('Enrollment');
    if (e.status === 'withdrawn') throw conflict('Already withdrawn');
    await conn.query("UPDATE program_enrollments SET status = 'withdrawn' WHERE tenant_id = ? AND id = ?", [tenantId, eid]);
    let next = null;
    if (e.status === 'enrolled' && e.group_id) {
      next = await PS.promoteWaitlist(conn, tenantId, await one(conn, 'SELECT * FROM program_groups WHERE tenant_id = ? AND id = ?', [tenantId, e.group_id]));
    } else if (e.status === 'enrolled') {
      next = await one(conn, "SELECT id, person_id FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND term_id IS NULL AND status = 'waitlist' ORDER BY id LIMIT 1", [tenantId, pid]);
      if (next) await conn.query("UPDATE program_enrollments SET status = 'enrolled' WHERE tenant_id = ? AND id = ?", [tenantId, next.id]);
    }
    await audit(conn, req, 'withdraw', 'programs', pid, { enrollment_id: eid, promoted: next ? next.person_id : null });
    return next;
  });
  res.json({ ok: true, promoted_person_id: promoted ? promoted.person_id : null });
});

router.get('/:id/roster', requireRole(...coord), async (req, res) => {
  res.json({
    data: await rows(
      pool,
      `SELECT e.id AS enrollment_id, e.status, e.paid_cents, p.id AS person_id, p.first_name, p.last_name, p.date_of_birth,
              g.first_name AS guardian_first_name, g.last_name AS guardian_last_name, g.email AS guardian_email, g.phone AS guardian_phone
       FROM program_enrollments e JOIN people p ON p.id = e.person_id AND p.tenant_id = e.tenant_id
       LEFT JOIN people g ON g.id = e.guardian_id AND g.tenant_id = e.tenant_id
       WHERE e.tenant_id = ? AND e.program_id = ? AND e.status <> 'withdrawn' ORDER BY e.status, p.last_name`,
      [req.auth.tenantId, paramId(req)],
    ),
  });
});

router.post('/:id/payments', requireRole('manager'), validate(z.object({ enrollment_id: z.number().int().positive(), amount_cents: z.number().int().min(1) })), async (req, res) => {
  const [r] = await pool.query('UPDATE program_enrollments SET paid_cents = paid_cents + ? WHERE tenant_id = ? AND program_id = ? AND id = ?', [req.body.amount_cents, req.auth.tenantId, paramId(req), req.body.enrollment_id]);
  if (!r.affectedRows) throw notFound('Enrollment');
  await audit(pool, req, 'payment', 'programs', paramId(req), req.body);
  res.json({ ok: true });
});

// ---- sessions and attendance ----
router.post('/:id/sessions', requireRole('manager'), validate(z.object({ starts_at: dateTimeStr.transform(normDateTime), ends_at: dateTimeStr.transform(normDateTime), coach_staff_id: z.number().int().positive().optional() })), async (req, res) => {
  const b = req.body;
  if (b.ends_at <= b.starts_at) throw bad('ends_at must be after starts_at');
  if (!(await one(pool, 'SELECT id FROM programs WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]))) throw notFound('Program');
  // One rule with lessons (lib/workforce): a coach cannot be teaching a lesson or coaching another meeting then.
  const busy = b.coach_staff_id && await instructorBusy(pool, req.auth.tenantId, b.coach_staff_id, b.starts_at, b.ends_at);
  if (busy) throw conflict(`That coach is busy: ${busy}`);
  const [r] = await pool.query('INSERT INTO program_sessions (tenant_id, program_id, starts_at, ends_at, coach_staff_id) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, paramId(req), b.starts_at, b.ends_at, b.coach_staff_id ?? null]);
  res.status(201).json({ id: r.insertId });
});

router.get('/:id/sessions', requireRole(...coord), async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT * FROM program_sessions WHERE tenant_id = ? AND program_id = ? ORDER BY starts_at', [req.auth.tenantId, paramId(req)]) });
});

router.put('/sessions/:sessionId/attendance', requireRole(...coord), validate(z.object({ marks: z.array(z.object({ person_id: z.number().int().positive(), present: z.boolean() })).min(1).max(200) })), async (req, res) => {
  const { tenantId } = req.auth;
  const sid = paramId(req, 'sessionId');
  await tx(async (conn) => {
    const meeting = await one(conn, 'SELECT id, group_id, coach_staff_id FROM program_sessions WHERE tenant_id = ? AND id = ?', [tenantId, sid]);
    if (!meeting) throw notFound('Session');
    // An instructor marks attendance only on the meetings they coach (the meeting, its day, or a level class of it).
    if (req.auth.role === 'instructor' && !(await coachesMeeting(conn, tenantId, req.auth.staffId, meeting))) throw forbidden('You can only take attendance for the groups you coach');
    for (const m of req.body.marks) {
      await conn.query('INSERT INTO attendance (tenant_id, session_id, person_id, present) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE present = VALUES(present)', [tenantId, sid, m.person_id, m.present ? 1 : 0]);
    }
  });
  res.json({ ok: true });
});

require('./programterms')(router);

router.use('/', crud({ table: 'programs', entity: 'Program', createSchema: z.object(programFields), updateSchema: partialOf(programFields), columns: PROGRAM_COLUMNS, filters: ['kind', 'season', 'type_id'], orderBy: 'season DESC, name', readRoles: ['counter', ...coord], writeRoles: ['manager'], allowDelete: false }));

module.exports = router;
