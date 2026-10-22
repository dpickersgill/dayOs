'use strict';

const { ON_FILE } = require('../lib/waivers');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, dateTimeStr, validate, paramId, normDateTime, seasonFor } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { staffProblems } = require('../lib/workforce');
const { audit } = require('../lib/audit');
const { personFields, resolvePerson } = require('../lib/customers');

const router = express.Router();
const school = ['instructor', 'manager', 'counter'];

const disciplines = ['ski', 'snowboard', 'telemark', 'adaptive'];
const levels = ['first_timer', 'beginner', 'intermediate', 'advanced'];

const formats = ['group', 'semi_private', 'private'];
const ageGroups = ['all', 'kids', 'teens', 'adults'];
const MAX_SEATS = { private: 6, semi_private: 4, group: 60 };
const DEFAULT_SEATS = { private: 1, semi_private: 3, group: 6 };

const sessionBase = {
  product_id: z.number().int().positive(),
  discipline: z.enum(disciplines).default('ski'),
  ability_level: z.enum(levels).default('beginner'),
  format: z.enum(formats).default('group'),
  age_group: z.enum(ageGroups).default('all'),
  meeting_place: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  capacity: z.number().int().min(1).max(60).optional(),
  instructor_id: z.number().int().positive().optional(),
  required_certification_id: z.number().int().positive().optional(),
};
const sessionSchema = z.object({ ...sessionBase, starts_at: dateTimeStr.transform(normDateTime), ends_at: dateTimeStr.transform(normDateTime) });
// The same lesson at the same time on several days (a week of mornings, every weekend of the season).
const seriesSchema = z.object({ ...sessionBase, dates: z.array(dateStr).min(1).max(60), start_time: z.string().regex(/^\d{2}:\d{2}$/), end_time: z.string().regex(/^\d{2}:\d{2}$/) });

/** Seats for a lesson: the format's usual number unless one was chosen, never more than the format allows. */
function seatsFor(b) {
  const cap = b.capacity ?? DEFAULT_SEATS[b.format];
  if (cap > MAX_SEATS[b.format]) throw bad(`A ${b.format.replace('_', ' ')} lesson holds at most ${MAX_SEATS[b.format]} students`);
  return cap;
}

async function lessonProduct(conn, tenantId, productId) {
  const product = await one(conn, "SELECT id, uses FROM products WHERE tenant_id = ? AND id = ? AND kind = 'lesson'", [tenantId, productId]);
  if (!product) throw bad('product_id must be a lesson product for this mountain');
  if (product.uses && product.uses > 1) throw bad('That product is a lesson package. Pick a single-lesson product for a session.');
  return product;
}

async function insertSession(conn, req, b, startsAt, endsAt) {
  const { tenantId } = req.auth;
  if (endsAt <= startsAt) throw bad('ends_at must be after starts_at');
  if (b.instructor_id) {
    const problems = await staffProblems(conn, tenantId, {
      staffId: b.instructor_id, certificationIds: b.required_certification_id ? [b.required_certification_id] : [], startsAt, endsAt, skipAvailability: false,
    });
    if (problems.length) throw conflict(`Cannot assign this instructor on ${startsAt.slice(0, 10)}`, problems);
  }
  const [r] = await conn.query(
    'INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, format, age_group, meeting_place, notes, starts_at, ends_at, capacity, instructor_id, required_certification_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, b.product_id, b.discipline, b.ability_level, b.format, b.age_group, b.meeting_place ?? null, b.notes ?? null, startsAt, endsAt, seatsFor(b), b.instructor_id ?? null, b.required_certification_id ?? null],
  );
  await audit(conn, req, 'create', 'lesson_sessions', r.insertId);
  return r.insertId;
}

router.post('/sessions', requireRole('manager'), validate(sessionSchema), async (req, res) => {
  const b = req.body;
  const id = await tx(async (conn) => {
    await lessonProduct(conn, req.auth.tenantId, b.product_id);
    return insertSession(conn, req, b, b.starts_at, b.ends_at);
  });
  res.status(201).json({ id });
});

router.post('/sessions/series', requireRole('manager'), validate(seriesSchema), async (req, res) => {
  const b = req.body;
  const dates = [...new Set(b.dates)].sort();
  const ids = await tx(async (conn) => {
    await lessonProduct(conn, req.auth.tenantId, b.product_id);
    const out = [];
    for (const d of dates) out.push(await insertSession(conn, req, b, `${d} ${b.start_time}:00`, `${d} ${b.end_time}:00`));
    return out;
  });
  res.status(201).json({ ids, count: ids.length });
});

router.patch('/sessions/:id/instructor', requireRole('manager'), validate(z.object({ instructor_id: z.number().int().positive().nullable() })), async (req, res) => {
  const { tenantId } = req.auth;
  const sid = paramId(req);
  await tx(async (conn) => {
    const s = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, sid]);
    if (!s) throw notFound('Lesson session');
    if (req.body.instructor_id) {
      const problems = await staffProblems(conn, tenantId, {
        staffId: req.body.instructor_id, certificationIds: s.required_certification_id ? [s.required_certification_id] : [], startsAt: s.starts_at, endsAt: s.ends_at, ignoreLessonId: sid,
      });
      if (problems.length) throw conflict('Cannot assign this instructor', problems);
    }
    await conn.query('UPDATE lesson_sessions SET instructor_id = ? WHERE tenant_id = ? AND id = ?', [req.body.instructor_id, tenantId, sid]);
    await audit(conn, req, 'assign_instructor', 'lesson_sessions', sid, req.body);
  });
  res.json({ ok: true });
});

router.get('/sessions', requireRole(...school), async (req, res) => {
  const where = ['s.tenant_id = ?'];
  const params = [req.auth.tenantId];
  if (req.query.from) { where.push('DATE(s.starts_at) >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('DATE(s.starts_at) <= ?'); params.push(String(req.query.to)); }
  if (req.query.instructor_id) { where.push('s.instructor_id = ?'); params.push(Number(req.query.instructor_id)); }
  if (req.query.open === 'true') where.push("s.status = 'scheduled'");
  const data = await rows(
    pool,
    `SELECT s.*, pr.name AS product,
       (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
     FROM lesson_sessions s JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
     WHERE ${where.join(' AND ')} ORDER BY s.starts_at LIMIT 500`,
    params,
  );
  res.json({ data: data.map((d) => ({ ...d, spots_left: Math.max(d.capacity - d.booked, 0) })) });
});

/**
 * Book a student. Send person_id for someone already on file, or a student object with their details; the
 * student goes into the shared customer record (an existing customer is matched, otherwise created).
 * Capacity is enforced under a row lock so two counters cannot oversell a class.
 */
const studentSchema = z.object({ ...personFields, first_name: personFields.first_name.optional(), last_name: personFields.last_name.optional() });
router.post(
  '/sessions/:id/bookings',
  requireRole(...school),
  validate(z.object({ person_id: z.number().int().positive().optional(), student: studentSchema.optional(), sign_waiver: z.boolean().optional(), use_credit_id: z.number().int().positive().optional(), requested_instructor_id: z.number().int().positive().optional() }).refine((b) => b.person_id || b.student, { message: 'Choose a student or enter their details' })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const sid = paramId(req);
    const exists = await one(pool, 'SELECT id FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, sid]);
    if (!exists) throw notFound('Lesson session');
    // The customer is saved first and on its own: if the booking then fails (no waiver yet, class full) their details are
    // not lost, and the screen retries with their person_id.
    const who = await tx((conn) => resolvePerson(conn, tenantId, { personId: req.body.person_id, details: req.body.student, scope: 'lesson', source: 'lesson' }));
    if (who.notFound || !who.id) throw notFound('Person');
    const id = await tx(async (conn) => {
      const s = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, sid]);
      if (s.status !== 'scheduled') throw conflict(`Session is ${s.status}`);
      const season = seasonFor(s.starts_at.slice(0, 10));
      let waiver = await one(conn, ON_FILE, [tenantId, who.id, season]);
      if (!waiver && req.body.sign_waiver) {
        const [w] = await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, method, recorded_by) VALUES (?, ?, ?, 'general', 'recorded_by_staff', ?)", [tenantId, who.id, season, req.auth.userId]);
        await audit(conn, req, 'sign_waiver', 'waivers', w.insertId, { person_id: who.id, season });
        waiver = { id: w.insertId };
      }
      if (!waiver) throw conflict('Student needs a signed waiver for this season before booking', { person_id: who.id });
      const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, sid]);
      if (n >= s.capacity) throw conflict('Session is full', { person_id: who.id });
      let creditId = null;
      if (req.body.use_credit_id) {
        const credit = await one(conn, "SELECT * FROM lesson_credits WHERE tenant_id = ? AND id = ? AND person_id = ? FOR UPDATE", [tenantId, req.body.use_credit_id, who.id]);
        if (!credit || credit.status !== 'active') throw conflict('That lesson package is not available for this student');
        if (credit.used >= credit.total) throw conflict('That lesson package has no lessons left');
        if (credit.expires_on && credit.expires_on < s.starts_at.slice(0, 10)) throw conflict(`That lesson package expires on ${credit.expires_on}, before this lesson`);
        creditId = credit.id;
      }
      const prior = await one(conn, 'SELECT id, status FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ?', [tenantId, sid, who.id]);
      if (prior && ['booked', 'attended'].includes(prior.status) && creditId) throw conflict('That student is already booked into this lesson');
      // A cancelled booking can be revived; otherwise insert.
      const [r] = await conn.query(
        `INSERT INTO lesson_bookings (tenant_id, session_id, person_id, credit_id, requested_instructor_id) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = IF(status = 'cancelled', 'booked', status), credit_id = IF(status = 'booked' AND credit_id IS NULL, VALUES(credit_id), credit_id),
           requested_instructor_id = COALESCE(VALUES(requested_instructor_id), requested_instructor_id), id = LAST_INSERT_ID(id)`,
        [tenantId, sid, who.id, creditId, req.body.requested_instructor_id ?? null],
      );
      if (creditId) await conn.query('UPDATE lesson_credits SET used = used + 1 WHERE tenant_id = ? AND id = ?', [tenantId, creditId]);
      await audit(conn, req, 'book', 'lesson_sessions', sid, { person_id: who.id, credit_id: creditId });
      return r.insertId;
    });
    res.status(201).json({ id, session_id: sid, person_id: who.id, status: 'booked', customer: { created: who.created, matched: who.matched } });
  },
);

// ---------------------------------------------------------------- cancelling and deleting lessons (lib/lessoncancel.js)
const LC = require('../lib/lessoncancel');
const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Say why the lesson is cancelled').max(300) });

/** What cancelling one lesson would do: bookings, package lessons and online payments on it. */
router.get('/sessions/:id/cancel-preview', requireRole('manager'), async (req, res) => {
  const [s] = await LC.preview(req.auth.tenantId, 's.id = ?', [paramId(req)]);
  if (!s) throw notFound('Lesson');
  res.json(s);
});
router.post('/sessions/:id/cancel', requireRole('manager'), validate(reasonSchema), async (req, res) => {
  res.json(await LC.cancelSession(req.auth.tenantId, paramId(req), req.body.reason, req));
});
router.delete('/sessions/:id', requireRole('manager'), async (req, res) => {
  await LC.deleteSession(req.auth.tenantId, paramId(req), req);
  res.json({ ok: true });
});

/** A storm day: every lesson from one date to another. preview: true lists them; otherwise each is cancelled in turn. */
router.post('/sessions/cancel-days', requireRole('manager'), validate(reasonSchema.extend({
  from: dateStr, to: dateStr, preview: z.boolean().optional(),
})), async (req, res) => {
  const { from, to } = req.body;
  if (to < from) throw bad('The last day is before the first');
  const list = await LC.preview(req.auth.tenantId, 'DATE(s.starts_at) BETWEEN ? AND ?', [from, to]);
  if (req.body.preview) return res.json({ sessions: list });
  if (!list.length) throw bad('No lessons are scheduled on those days');
  const done = [];
  for (const s of list) done.push(await LC.cancelSession(req.auth.tenantId, s.id, req.body.reason, req));
  res.json({ cancelled: done.length, sessions: done });
});

router.patch('/bookings/:id', requireRole(...school), validate(z.object({ status: z.enum(['booked', 'attended', 'no_show', 'cancelled']) })), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const b = await one(conn, 'SELECT id, status, credit_id, session_id FROM lesson_bookings WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, paramId(req)]);
    if (!b) throw notFound('Booking');
    // Bringing a cancelled booking back takes a seat again: lock the lesson and check it still has one.
    if (b.status === 'cancelled' && req.body.status !== 'cancelled') {
      const s = await one(conn, 'SELECT capacity, status FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, b.session_id]);
      if (s.status !== 'scheduled') throw conflict(`Session is ${s.status}`);
      const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, b.session_id]);
      if (n >= s.capacity) throw conflict('Session is full');
    }
    await conn.query('UPDATE lesson_bookings SET status = ? WHERE tenant_id = ? AND id = ?', [req.body.status, tenantId, b.id]);
    // Cancelling gives a package lesson back.
    if (req.body.status === 'cancelled' && b.status !== 'cancelled' && b.credit_id) {
      await conn.query('UPDATE lesson_credits SET used = GREATEST(used - 1, 0) WHERE tenant_id = ? AND id = ?', [tenantId, b.credit_id]);
      await conn.query('UPDATE lesson_bookings SET credit_id = NULL WHERE tenant_id = ? AND id = ?', [tenantId, b.id]);
    }
  });
  res.json({ ok: true });
});

router.get('/sessions/:id/roster', requireRole(...school), async (req, res) => {
  res.json({
    data: await rows(
      pool,
      `SELECT b.id AS booking_id, b.status, b.unpaid, b.credit_id, b.instructor_notes, p.id AS person_id, p.first_name, p.last_name, p.date_of_birth,
         (SELECT level FROM student_progress sp WHERE sp.tenant_id = p.tenant_id AND sp.person_id = p.id ORDER BY sp.recorded_at DESC, sp.id DESC LIMIT 1) AS latest_level
       FROM lesson_bookings b JOIN people p ON p.id = b.person_id AND p.tenant_id = b.tenant_id
       WHERE b.tenant_id = ? AND b.session_id = ? AND b.status <> 'cancelled' ORDER BY p.last_name`,
      [req.auth.tenantId, paramId(req)],
    ),
  });
});

router.post(
  '/progress',
  requireRole('instructor', 'manager'),
  validate(z.object({ person_id: z.number().int().positive(), discipline: z.enum(disciplines), level: z.number().int().min(1).max(9), notes: z.string().max(1000).optional() })),
  async (req, res) => {
    const b = req.body;
    if (!(await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, b.person_id]))) throw notFound('Person');
    const [r] = await pool.query('INSERT INTO student_progress (tenant_id, person_id, discipline, level, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?)', [req.auth.tenantId, b.person_id, b.discipline, b.level, b.notes ?? null, req.auth.userId]);
    res.status(201).json({ id: r.insertId });
  },
);

module.exports = router;
