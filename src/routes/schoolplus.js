'use strict';

// Ski school, the rest of it: levels and skills, report cards, the instructors' day board and hours, lesson packages,
// and the queue of requests that come in from the public booking page.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { staffProblems } = require('../lib/workforce');
const { audit } = require('../lib/audit');
const { ensureLadder, ladder, studentCard, DISCIPLINES } = require('../lib/school');
const { confirmRequest, parse: parseRequest } = require('../lib/onlinesale');

const router = express.Router();
const school = ['instructor', 'manager', 'counter'];
const MAX_LEVELS = 12;

// ---------------------------------------------------------------- levels and skills
router.get('/levels', requireRole(...school), async (req, res) => {
  const { tenantId } = req.auth;
  await tx((conn) => ensureLadder(conn, tenantId));
  res.json({ data: await ladder(pool, tenantId) });
});

router.post('/levels', requireRole('manager'), validate(z.object({ discipline: z.enum(DISCIPLINES), name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  const { n } = await one(pool, 'SELECT COALESCE(MAX(rank_no), 0) AS n FROM school_levels WHERE tenant_id = ? AND discipline = ?', [tenantId, b.discipline]);
  if (n >= MAX_LEVELS) throw bad(`A ladder can have up to ${MAX_LEVELS} levels`);
  const [r] = await pool.query('INSERT INTO school_levels (tenant_id, discipline, rank_no, name, description) VALUES (?, ?, ?, ?, ?)', [tenantId, b.discipline, n + 1, b.name, b.description ?? null]);
  res.status(201).json({ id: r.insertId, rank_no: n + 1 });
});

router.patch('/levels/:id', requireRole('manager'), validate(z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(300).nullable().optional() })), async (req, res) => {
  const set = []; const vals = [];
  for (const k of ['name', 'description']) if (req.body[k] !== undefined) { set.push(`${k} = ?`); vals.push(req.body[k] || null); }
  if (!set.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE school_levels SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Level');
  res.json({ ok: true });
});

router.post('/levels/:id/skills', requireRole('manager'), validate(z.object({ name: z.string().trim().min(1).max(160) })), async (req, res) => {
  const { tenantId } = req.auth;
  const level = await one(pool, 'SELECT id FROM school_levels WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!level) throw notFound('Level');
  const { n } = await one(pool, 'SELECT COALESCE(MAX(sort_no), 0) AS n FROM school_skills WHERE tenant_id = ? AND level_id = ?', [tenantId, level.id]);
  const [r] = await pool.query('INSERT INTO school_skills (tenant_id, level_id, name, sort_no) VALUES (?, ?, ?, ?)', [tenantId, level.id, req.body.name, n + 1]);
  res.status(201).json({ id: r.insertId });
});

router.patch('/skills/:id', requireRole('manager'), validate(z.object({ name: z.string().trim().min(1).max(160) })), async (req, res) => {
  const [r] = await pool.query('UPDATE school_skills SET name = ? WHERE tenant_id = ? AND id = ?', [req.body.name, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Skill');
  res.json({ ok: true });
});

router.delete('/skills/:id', requireRole('manager'), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const used = await one(pool, 'SELECT COUNT(*) AS n FROM student_skills WHERE tenant_id = ? AND skill_id = ?', [tenantId, id]);
  if (Number(used.n) > 0) throw conflict(`${used.n} student${Number(used.n) === 1 ? ' has' : 's have'} already passed this skill, so it is kept. Rename it instead.`);
  const [r] = await pool.query('DELETE FROM school_skills WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!r.affectedRows) throw notFound('Skill');
  res.json({ ok: true });
});

// ---------------------------------------------------------------- report card
router.get('/students/:id/card', requireRole(...school), async (req, res) => {
  const card = await tx((conn) => studentCard(conn, req.auth.tenantId, paramId(req)));
  if (!card) throw notFound('Student');
  res.json(card);
});

router.put('/students/:id/skills/:skillId', requireRole('instructor', 'manager'), validate(z.object({ passed: z.boolean(), date: dateStr.optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const personId = paramId(req);
  const skillId = Number(req.params.skillId);
  if (!(await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]))) throw notFound('Student');
  if (!(await one(pool, 'SELECT id FROM school_skills WHERE tenant_id = ? AND id = ?', [tenantId, skillId]))) throw notFound('Skill');
  if (req.body.passed) {
    const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
    await pool.query('INSERT INTO student_skills (tenant_id, person_id, skill_id, passed_on, user_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE passed_on = VALUES(passed_on), user_id = VALUES(user_id)', [tenantId, personId, skillId, req.body.date || todayIn(tz), req.auth.userId]);
  } else {
    await pool.query('DELETE FROM student_skills WHERE tenant_id = ? AND person_id = ? AND skill_id = ?', [tenantId, personId, skillId]);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- notes, tips and details on a session or booking
router.patch('/sessions/:id/details', requireRole('instructor', 'manager'), validate(z.object({
  notes: z.string().trim().max(1000).nullable().optional(),
  meeting_place: z.string().trim().max(120).nullable().optional(),
  tip_cents: z.number().int().min(0).max(1_000_000).optional(),
})), async (req, res) => {
  const { tenantId, role, staffId } = req.auth;
  const s = await one(pool, 'SELECT id, instructor_id FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!s) throw notFound('Lesson session');
  if (role === 'instructor' && s.instructor_id !== staffId) throw bad('Instructors can only change their own lessons');
  const set = []; const vals = [];
  for (const k of ['notes', 'meeting_place']) if (req.body[k] !== undefined) { set.push(`${k} = ?`); vals.push(req.body[k] || null); }
  if (req.body.tip_cents !== undefined) { set.push('tip_cents = ?'); vals.push(req.body.tip_cents); }
  if (!set.length) throw bad('Nothing to change');
  await pool.query(`UPDATE lesson_sessions SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, tenantId, s.id]);
  res.json({ ok: true });
});

router.patch('/bookings/:id/notes', requireRole('instructor', 'manager'), validate(z.object({ instructor_notes: z.string().trim().max(1000).nullable() })), async (req, res) => {
  const { tenantId, role, staffId } = req.auth;
  const b = await one(pool, 'SELECT b.id, s.instructor_id FROM lesson_bookings b JOIN lesson_sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id WHERE b.tenant_id = ? AND b.id = ?', [tenantId, paramId(req)]);
  if (!b) throw notFound('Booking');
  if (role === 'instructor' && b.instructor_id !== staffId) throw bad('Instructors can only write notes on their own lessons');
  await pool.query('UPDATE lesson_bookings SET instructor_notes = ? WHERE tenant_id = ? AND id = ?', [req.body.instructor_notes || null, tenantId, b.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the instructors' day
/** One day's lessons with who teaches them and who is booked, plus who is still free. */
router.get('/board', requireRole(...school), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const date = req.query.date ? String(req.query.date) : todayIn(tz);
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  const sessions = await rows(pool,
    `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.ability_level, s.format, s.age_group, s.meeting_place, s.notes, s.capacity, s.status, s.instructor_id, s.tip_cents, pr.name AS product,
            pe.first_name AS instructor_first, pe.last_name AS instructor_last
     FROM lesson_sessions s JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
     LEFT JOIN staff st ON st.id = s.instructor_id AND st.tenant_id = s.tenant_id LEFT JOIN people pe ON pe.id = st.person_id AND pe.tenant_id = st.tenant_id
     WHERE s.tenant_id = ? AND DATE(s.starts_at) = ? AND s.status <> 'cancelled' ORDER BY s.starts_at, s.id`, [tenantId, date]);
  const ids = sessions.map((s) => s.id);
  const students = ids.length ? await rows(pool,
    `SELECT b.id AS booking_id, b.session_id, b.status, b.unpaid, b.instructor_notes, b.requested_instructor_id, p.id AS person_id, p.first_name, p.last_name, p.date_of_birth,
       (SELECT level FROM student_progress sp WHERE sp.tenant_id = p.tenant_id AND sp.person_id = p.id AND sp.discipline = s.discipline ORDER BY sp.recorded_at DESC, sp.id DESC LIMIT 1) AS level
     FROM lesson_bookings b JOIN lesson_sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id JOIN people p ON p.id = b.person_id AND p.tenant_id = b.tenant_id
     WHERE b.tenant_id = ? AND b.session_id IN (?) AND b.status <> 'cancelled' ORDER BY p.last_name, p.first_name`, [tenantId, ids]) : [];
  const out = sessions.map((s) => ({ ...s, instructor: s.instructor_id ? `${s.instructor_first} ${s.instructor_last}` : null, students: students.filter((x) => x.session_id === s.id) }));
  // Instructors who have lessons today, and their hours.
  const byInstr = new Map();
  for (const s of out) {
    if (!s.instructor_id) continue;
    const e = byInstr.get(s.instructor_id) || { staff_id: s.instructor_id, name: s.instructor, lessons: 0, minutes: 0 };
    e.lessons += 1;
    e.minutes += Math.max(0, Math.round((new Date(s.ends_at.replace(' ', 'T') + 'Z') - new Date(s.starts_at.replace(' ', 'T') + 'Z')) / 60000));
    byInstr.set(s.instructor_id, e);
  }
  res.json({ date, sessions: out, instructors: [...byInstr.values()], unassigned: out.filter((s) => s.status === 'scheduled' && !s.instructor_id).length });
});

/** Staff who could teach a session: certified, available, and not already teaching. Those a guest asked for come first. */
router.get('/sessions/:id/eligible-instructors', requireRole('manager'), async (req, res) => {
  const { tenantId } = req.auth;
  const s = await one(pool, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!s) throw notFound('Lesson session');
  const staff = await rows(pool, "SELECT st.id, p.first_name, p.last_name FROM staff st JOIN people p ON p.id = st.person_id AND p.tenant_id = st.tenant_id WHERE st.tenant_id = ? AND st.status = 'active' ORDER BY p.last_name, p.first_name LIMIT 200", [tenantId]);
  const asked = await rows(pool, "SELECT requested_instructor_id AS id, COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status <> 'cancelled' AND requested_instructor_id IS NOT NULL GROUP BY requested_instructor_id", [tenantId, s.id]);
  const out = [];
  for (const m of staff) {
    const problems = await staffProblems(pool, tenantId, { staffId: m.id, certificationIds: s.required_certification_id ? [s.required_certification_id] : [], startsAt: s.starts_at, endsAt: s.ends_at, ignoreLessonId: s.id });
    if (problems.length) continue;
    out.push({ id: m.id, name: `${m.first_name} ${m.last_name}`, requested_by: Number((asked.find((a) => a.id === m.id) || {}).n || 0) });
  }
  out.sort((a, b) => b.requested_by - a.requested_by || a.name.localeCompare(b.name));
  res.json({ data: out });
});

/** Hours and lessons taught per instructor over a date range, for payroll and tips. */
router.get('/hours', requireRole('manager'), async (req, res) => {
  const { tenantId } = req.auth;
  const from = String(req.query.from || ''); const to = String(req.query.to || '');
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('from and to must be YYYY-MM-DD');
  const data = await rows(pool,
    `SELECT st.id AS staff_id, p.first_name, p.last_name, COUNT(*) AS lessons, COALESCE(SUM(TIMESTAMPDIFF(MINUTE, s.starts_at, s.ends_at)), 0) AS minutes, COALESCE(SUM(s.tip_cents), 0) AS tip_cents,
       COALESCE(SUM((SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status = 'attended')), 0) AS students,
       COALESCE(SUM((SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status = 'no_show')), 0) AS no_shows
     FROM lesson_sessions s JOIN staff st ON st.id = s.instructor_id AND st.tenant_id = s.tenant_id JOIN people p ON p.id = st.person_id AND p.tenant_id = st.tenant_id
     WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND DATE(s.starts_at) >= ? AND DATE(s.starts_at) <= ? GROUP BY st.id, p.first_name, p.last_name ORDER BY p.last_name`, [tenantId, from, to]);
  res.json({ data: data.map((r) => ({ staff_id: r.staff_id, name: `${r.first_name} ${r.last_name}`, lessons: Number(r.lessons), hours: Math.round((Number(r.minutes) / 60) * 100) / 100, students: Number(r.students), no_shows: Number(r.no_shows), tip_cents: Number(r.tip_cents) })) });
});

// ---------------------------------------------------------------- packages
router.get('/credits', requireRole(...school), async (req, res) => {
  const personId = Number(req.query.person_id);
  if (!personId) throw bad('person_id is required');
  const data = await rows(pool, "SELECT c.id, c.total, c.used, c.expires_on, pr.name AS product FROM lesson_credits c JOIN products pr ON pr.id = c.product_id AND pr.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.person_id = ? AND c.status = 'active' ORDER BY c.id DESC", [req.auth.tenantId, personId]);
  res.json({ data: data.map((c) => ({ ...c, left: c.total - c.used })) });
});

// ---------------------------------------------------------------- requests from the public booking page

router.get('/requests', requireRole('manager', 'counter'), async (req, res) => {
  const status = ['pending', 'confirmed', 'declined', 'cancelled', 'awaiting_payment', 'expired'].includes(req.query.status) ? req.query.status : 'pending';
  const data = await rows(pool,
    `SELECT r.*, s.starts_at, s.ends_at, s.discipline, s.format, pr.name AS product
     FROM lesson_requests r JOIN lesson_sessions s ON s.id = r.session_id AND s.tenant_id = r.tenant_id JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
     WHERE r.tenant_id = ? AND r.status = ? ORDER BY r.created_at DESC LIMIT 200`, [req.auth.tenantId, status]);
  const { n } = await one(pool, "SELECT COUNT(*) AS n FROM lesson_requests WHERE tenant_id = ? AND status = 'pending'", [req.auth.tenantId]);
  res.json({ data: data.map(parseRequest), pending: Number(n) });
});

router.post('/requests/:id/decline', requireRole('manager', 'counter'), validate(z.object({ staff_note: z.string().trim().max(300).optional() })), async (req, res) => {
  const [r] = await pool.query("UPDATE lesson_requests SET status = 'declined', staff_note = ?, decided_at = NOW() WHERE tenant_id = ? AND id = ? AND status = 'pending'", [req.body.staff_note ?? null, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw conflict('That request is not waiting for an answer');
  await audit(pool, req, 'decline', 'lesson_requests', paramId(req));
  res.json({ ok: true });
});

/**
 * Confirm a request: the contact and each student go on file, minors are linked to the contact as guardian, the waiver is
 * recorded where the contact can legitimately sign it, and each student is booked and marked "unpaid" until they pay at the
 * desk (the checkout picks up the unpaid booking instead of booking twice).
 */
router.post('/requests/:id/confirm', requireRole('manager', 'counter'), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const out = await tx(async (conn) => {
    const raw = await one(conn, 'SELECT * FROM lesson_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!raw) throw notFound('Request');
    if (raw.status !== 'pending') throw conflict(`That request is already ${raw.status}`);
    return confirmRequest(conn, tenantId, raw, { paid: false, auditReq: req });
  });
  res.json(out);
});

module.exports = router;
