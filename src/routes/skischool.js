'use strict';

const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const SA = require('../lib/schoolaccess'); // 2026.11.9: the school director and supervisor
const { z, dateStr, dateTimeStr, validate, paramId, normDateTime, todayIn, addDays } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { personFields, resolvePerson } = require('../lib/customers');
const LV = require('../lib/levels');
const { bookStudent, saveDetails, lastDetails, safetyShape } = require('../lib/lessonbooking');
const { sendConfirmation } = require('../lib/lessonconfirm');
const { instructorFit, NOT_SET_UP } = require('../lib/school');
const { baseUrl } = require('../lib/baseurl');
const LS = require('../lib/lessonspots'); // 2026.11.9 Track STAFF: spots that follow staff recount after a change

const router = express.Router();
const school = ['instructor', 'manager', 'counter'];

const disciplines = ['ski', 'snowboard', 'telemark', 'adaptive'];
const levels = ['first_timer', 'beginner', 'intermediate', 'advanced'];

const formats = ['group', 'semi_private', 'private'];
const ageGroups = ['all', 'kids', 'teens', 'adults'];
const MAX_SEATS = { private: 6, semi_private: 4, group: 60 };
const DEFAULT_SEATS = { private: 1, semi_private: 3, group: 6 };

const level = z.number().int().min(LV.MIN).max(LV.MAX);
const age = z.number().int().min(0).max(99);
const sessionBase = {
  product_id: z.number().int().positive(),
  discipline: z.enum(disciplines).default('ski'),
  // The nine levels (lib/levels.js). ability_level and age_group are the old words, still accepted from older screens.
  level_min: level.nullable().optional(),
  level_max: level.nullable().optional(),
  age_min: age.nullable().optional(),
  age_max: age.nullable().optional(),
  ability_level: z.enum(levels).optional(),
  format: z.enum(formats).default('group'),
  age_group: z.enum(ageGroups).optional(),
  meeting_place: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  capacity: z.number().int().min(1).max(60).optional(),
  instructor_id: z.number().int().positive().optional(),
  required_certification_id: z.number().int().positive().optional(),
  override_reason: z.string().trim().min(3).max(300).optional(), // a manager assigning someone with a problem anyway
};
const sessionSchema = z.object({ ...sessionBase, starts_at: dateTimeStr.transform(normDateTime), ends_at: dateTimeStr.transform(normDateTime) });
// The same lesson at the same time on several days (a week of mornings, every weekend of the season).
const seriesSchema = z.object({ ...sessionBase, dates: z.array(dateStr).min(1).max(60), start_time: z.string().regex(/^\d{2}:\d{2}$/), end_time: z.string().regex(/^\d{2}:\d{2}$/) });

const AGE_FROM_GROUP = { kids: [4, 12], teens: [13, 17], adults: [18, null], all: [null, null] };
/** The old age group words for an age range, so older screens and reports keep working. */
function ageGroupFor(min, max) {
  if (max != null && max <= 12) return 'kids';
  if (min != null && min >= 18) return 'adults';
  if (min != null && min >= 13 && max != null && max <= 17) return 'teens';
  return 'all';
}
/** Fills levels and ages from whichever was given (the nine levels win), and the old words from them. */
function levelsAndAges(b) {
  let lmin = b.level_min ?? null; let lmax = b.level_max ?? null;
  if (lmin == null && lmax == null && b.ability_level) [lmin, lmax] = LV.fromLegacy(b.ability_level);
  if (lmin != null && lmax != null && lmin > lmax) throw bad('The lowest level must not be above the highest');
  let amin = b.age_min ?? null; let amax = b.age_max ?? null;
  if (amin == null && amax == null && b.age_group) [amin, amax] = AGE_FROM_GROUP[b.age_group];
  if (amin != null && amax != null && amin > amax) throw bad('The youngest age must not be above the oldest');
  return { level_min: lmin, level_max: lmax, age_min: amin, age_max: amax,
    ability_level: LV.toLegacy(lmax || lmin) || b.ability_level || 'beginner', age_group: ageGroupFor(amin, amax) };
}
/** The level range in plain words, added to every lesson the screens and the booking page get. */
const withWords = (s) => ({ ...s, level_words: LV.range(s.level_min, s.level_max) });

/** Seats for a lesson: the format's usual number unless one was chosen, never more than the format allows. */
function seatsFor(b, product) {
  // A product sold as a private lesson is never a big group (a 60-seat "Private" was possible before).
  if (product && /private/i.test(product.name) && b.format === 'group') throw bad(`${product.name} is a private lesson. Choose Private or Semi-private as the type.`);
  const cap = b.capacity ?? DEFAULT_SEATS[b.format];
  if (cap > MAX_SEATS[b.format]) throw bad(`A ${b.format.replace('_', ' ')} lesson holds at most ${MAX_SEATS[b.format]} students`);
  return cap;
}

async function lessonProduct(conn, tenantId, productId) {
  const product = await one(conn, "SELECT id, name, uses FROM products WHERE tenant_id = ? AND id = ? AND kind = 'lesson'", [tenantId, productId]);
  if (!product) throw bad('product_id must be a lesson product for this mountain');
  if (product.uses && product.uses > 1) throw bad('That product is a lesson package. Pick a single-lesson product for a session.');
  return product;
}

/**
 * Can this instructor teach this lesson? Throws 409 with the problems (a clash, a missing certification, not cleared for
 * the level, kids or adaptive, outside their availability) unless a manager gave a reason to assign anyway, which is audited.
 */
async function checkInstructor(conn, req, s, staffId, overrideReason) {
  const [fit] = await instructorFit(conn, req.auth.tenantId, s, { onlyStaffId: staffId, ignoreLessonId: s.id || null });
  if (!fit) throw notFound('Instructor');
  // "Not set up" (no teaching profile yet) is a soft problem: the picker shows it and asks for Assign anyway, and a
  // manager assigning without a reason is still recorded as assigning anyway. Every other problem needs the reason.
  const hard = fit.problems.filter((p) => p !== NOT_SET_UP);
  if (hard.length && !overrideReason) throw conflict(`Cannot assign ${fit.name} on ${String(s.starts_at).slice(0, 10)}`, fit.problems);
  if (fit.problems.length) await audit(conn, req, 'assign_anyway', 'lesson_sessions', s.id || null, { staff_id: staffId, problems: fit.problems, reason: overrideReason || 'No teaching profile yet' });
  return fit;
}

async function insertSession(conn, req, b, startsAt, endsAt, product) {
  const { tenantId } = req.auth;
  if (endsAt <= startsAt) throw bad('ends_at must be after starts_at');
  const la = levelsAndAges(b);
  if (b.instructor_id) await checkInstructor(conn, req, { ...b, ...la, starts_at: startsAt, ends_at: endsAt }, b.instructor_id, b.override_reason);
  const [r] = await conn.query(
    'INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, level_min, level_max, age_min, age_max, format, age_group, meeting_place, notes, starts_at, ends_at, capacity, instructor_id, required_certification_id, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, b.product_id, b.discipline, la.ability_level, la.level_min, la.level_max, la.age_min, la.age_max, b.format, la.age_group, b.meeting_place ?? null, b.notes ?? null, startsAt, endsAt, seatsFor(b, product), b.instructor_id ?? null, b.required_certification_id ?? null, b.origin || 'manual'],
  );
  await audit(conn, req, 'create', 'lesson_sessions', r.insertId);
  return r.insertId;
}

router.post('/sessions', SA.school('director'), validate(sessionSchema), async (req, res) => {
  const b = req.body;
  const id = await tx(async (conn) => {
    const product = await lessonProduct(conn, req.auth.tenantId, b.product_id);
    return insertSession(conn, req, b, b.starts_at, b.ends_at, product);
  });
  res.status(201).json({ id });
});

router.post('/sessions/series', SA.school('director'), validate(seriesSchema), async (req, res) => {
  const b = req.body;
  const dates = [...new Set(b.dates)].sort();
  const ids = await tx(async (conn) => {
    const product = await lessonProduct(conn, req.auth.tenantId, b.product_id);
    const out = [];
    for (const d of dates) out.push(await insertSession(conn, req, { ...b, origin: 'series' }, `${d} ${b.start_time}:00`, `${d} ${b.end_time}:00`, product));
    return out;
  });
  res.status(201).json({ ids, count: ids.length });
});

router.patch('/sessions/:id/instructor', SA.school('supervisor'), validate(z.object({ instructor_id: z.number().int().positive().nullable(), override_reason: z.string().trim().min(3).max(300).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const sid = paramId(req);
  await tx(async (conn) => {
    const s = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, sid]);
    if (!s) throw notFound('Lesson session');
    if (req.body.instructor_id) await checkInstructor(conn, req, s, req.body.instructor_id, req.body.override_reason);
    await conn.query('UPDATE lesson_sessions SET instructor_id = ? WHERE tenant_id = ? AND id = ?', [req.body.instructor_id, tenantId, sid]);
    await audit(conn, req, 'assign_instructor', 'lesson_sessions', sid, req.body);
  });
  await LS.after(tenantId, { sessionIds: [sid] }, req);
  res.json({ ok: true });
});

/** Edit a lesson: levels, ages, meeting place, spots, type. Times and the product stay (cancel and add a new one instead). */
router.patch('/sessions/:id', SA.school('director'), validate(z.object({
  level_min: level.nullable().optional(), level_max: level.nullable().optional(), age_min: age.nullable().optional(), age_max: age.nullable().optional(),
  meeting_place: z.string().trim().max(120).nullable().optional(), capacity: z.number().int().min(1).max(60).optional(), format: z.enum(formats).optional(),
})), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const s = await one(conn, 'SELECT s.*, pr.name AS product_name FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE s.tenant_id = ? AND s.id = ? FOR UPDATE', [tenantId, paramId(req)]);
    if (!s) throw notFound('Lesson session');
    const b = { ...s, ...req.body };
    const la = levelsAndAges({ level_min: b.level_min, level_max: b.level_max, age_min: b.age_min, age_max: b.age_max });
    const cap = seatsFor({ format: b.format, capacity: b.capacity }, { name: s.product_name });
    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, s.id]);
    if (cap < Number(n)) throw conflict(`${n} students are booked, so the lesson needs at least ${n} spots`);
    await conn.query('UPDATE lesson_sessions SET level_min = ?, level_max = ?, age_min = ?, age_max = ?, ability_level = ?, age_group = ?, meeting_place = ?, capacity = ?, format = ? WHERE tenant_id = ? AND id = ?',
      [la.level_min, la.level_max, la.age_min, la.age_max, la.ability_level, la.age_group, b.meeting_place ?? null, cap, b.format, tenantId, s.id]);
    await audit(conn, req, 'update', 'lesson_sessions', s.id, req.body);
  });
  await LS.after(tenantId, { sessionIds: [paramId(req)] }, req);
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
    `SELECT s.*, pr.name AS product, NULLIF(TRIM(CONCAT(pe.first_name, ' ', pe.last_name)), '') AS instructor_name, pe.first_name AS instructor_first,
       (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
     FROM lesson_sessions s JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
     LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people pe ON pe.tenant_id = st.tenant_id AND pe.id = st.person_id
     WHERE ${where.join(' AND ')} ORDER BY s.starts_at LIMIT 500`,
    params,
  );
  res.json({ data: data.map((d) => withWords({ ...d, spots_left: Math.max(d.capacity - d.booked, 0) })) });
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
  validate(z.object({
    person_id: z.number().int().positive().optional(), student: studentSchema.optional(), sign_waiver: z.boolean().optional(), use_credit_id: z.number().int().positive().optional(), requested_instructor_id: z.number().int().positive().optional(),
    ...safetyShape, send_confirmation: z.boolean().optional(),
  }).refine((b) => b.person_id || b.student, { message: 'Choose a student or enter their details' })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const sid = paramId(req);
    const exists = await one(pool, 'SELECT id FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, sid]);
    if (!exists) throw notFound('Lesson session');
    // The customer is saved first and on its own: if the booking then fails (no waiver yet, class full, a clash) their
    // details are not lost, and the screen retries with their person_id.
    const who = await tx((conn) => resolvePerson(conn, tenantId, { personId: req.body.person_id, details: req.body.student, scope: 'lesson', source: 'lesson' }));
    if (who.notFound || !who.id) throw notFound('Person');
    const details = {};
    for (const k of Object.keys(safetyShape)) if (req.body[k] !== undefined) details[k] = req.body[k];
    const { bookingId } = await tx((conn) => bookStudent(conn, req, {
      sessionId: sid, personId: who.id, details, signWaiver: Boolean(req.body.sign_waiver), useCreditId: req.body.use_credit_id || null, requestedInstructorId: req.body.requested_instructor_id || null,
    }));
    const confirmation = req.body.send_confirmation === false ? null : await sendConfirmation(pool, tenantId, bookingId, baseUrl(req));
    res.status(201).json({ id: bookingId, session_id: sid, person_id: who.id, status: 'booked', customer: { created: who.created, matched: who.matched }, confirmation: confirmation ? { ok: confirmation.ok, to: confirmation.to || null, error: confirmation.error || null } : null });
  },
);

/** The details to fill the counter's booking form with: the student's last booking, else their emergency contact. */
router.get('/students/:id/safety', SA.school('supervisor', 'counter'), async (req, res) => {
  const d = await lastDetails(pool, req.auth.tenantId, paramId(req));
  if (!d) throw notFound('Student');
  res.json(d);
});

/** Change a booking's safety details and consents (from the roster). The desk, managers and the lesson's own instructor. */
router.patch('/bookings/:id/safety', requireRole(...school), validate(z.object(safetyShape)), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const b = await one(conn, 'SELECT b.id, b.person_id, s.instructor_id FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id WHERE b.tenant_id = ? AND b.id = ? FOR UPDATE', [tenantId, paramId(req)]);
    if (!b) throw notFound('Booking');
    if (SA.ownOnly(req) && b.instructor_id !== req.auth.staffId) throw forbidden('Instructors can only change their own lessons');
    await saveDetails(conn, req, b.id, b.person_id, req.body);
    await audit(conn, req, 'safety_details', 'lesson_bookings', b.id, { fields: Object.keys(req.body) }); // the fields changed, never the details
  });
  res.json({ ok: true });
});

/** Send the confirmation again (the family lost it, or the email was wrong). Sends even when automatic emails are off. */
router.post('/bookings/:id/confirmation', SA.school('supervisor', 'counter'), async (req, res) => {
  const b = await one(pool, 'SELECT id FROM lesson_bookings WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!b) throw notFound('Booking');
  const out = await sendConfirmation(pool, req.auth.tenantId, b.id, baseUrl(req), { force: true });
  if (!out.ok) throw conflict(out.error || 'The confirmation was not sent');
  await audit(pool, req, 'resend_confirmation', 'lesson_bookings', b.id);
  res.json({ ok: true, to: out.to });
});

// ---------------------------------------------------------------- canceling and deleting lessons (lib/lessoncancel.js)
const LC = require('../lib/lessoncancel');
const reasonSchema = z.object({ reason: z.string().trim().min(3, 'Say why the lesson is canceled').max(300) });

/** What canceling one lesson would do: bookings, package lessons and online payments on it. */
router.get('/sessions/:id/cancel-preview', SA.school('director'), async (req, res) => {
  const [s] = await LC.preview(req.auth.tenantId, 's.id = ?', [paramId(req)]);
  if (!s) throw notFound('Lesson');
  res.json(s);
});
router.post('/sessions/:id/cancel', SA.school('director'), validate(reasonSchema), async (req, res) => {
  const out = await LC.cancelSession(req.auth.tenantId, paramId(req), req.body.reason, req);
  await LS.after(req.auth.tenantId, { sessionIds: [paramId(req)] }, req);
  res.json(out);
});
router.delete('/sessions/:id', SA.school('director'), async (req, res) => {
  await LC.deleteSession(req.auth.tenantId, paramId(req), req);
  res.json({ ok: true });
});

/** A storm day: every lesson from one date to another. preview: true lists them; otherwise each is canceled in turn. */
router.post('/sessions/cancel-days', SA.school('director'), validate(reasonSchema.extend({
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
    const b = await one(conn, 'SELECT b.id, b.status, b.credit_id, b.session_id, s.instructor_id FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id WHERE b.tenant_id = ? AND b.id = ? FOR UPDATE', [tenantId, paramId(req)]);
    if (!b) throw notFound('Booking');
    // An instructor marks attendance only on their own lessons (the desk and managers on any), and cannot cancel a booking.
    if (SA.ownOnly(req) && (b.instructor_id !== req.auth.staffId || req.body.status === 'cancelled')) throw forbidden('Instructors can only mark attendance on their own lessons');
    // Bringing a canceled booking back takes a seat again: lock the lesson and check it still has one.
    if (b.status === 'cancelled' && req.body.status !== 'cancelled') {
      const s = await one(conn, 'SELECT capacity, status FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, b.session_id]);
      if (s.status !== 'scheduled') throw conflict(`Session is ${s.status}`);
      const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, b.session_id]);
      if (n >= s.capacity) throw conflict('Session is full');
    }
    await conn.query('UPDATE lesson_bookings SET status = ? WHERE tenant_id = ? AND id = ?', [req.body.status, tenantId, b.id]);
    await audit(conn, req, 'attendance', 'lesson_bookings', b.id, { from: b.status, to: req.body.status });
    // Canceling gives a package lesson back.
    if (req.body.status === 'cancelled' && b.status !== 'cancelled' && b.credit_id) {
      await conn.query('UPDATE lesson_credits SET used = GREATEST(used - 1, 0) WHERE tenant_id = ? AND id = ?', [tenantId, b.credit_id]);
      await conn.query('UPDATE lesson_bookings SET credit_id = NULL WHERE tenant_id = ? AND id = ?', [tenantId, b.id]);
    }
  });
  res.json({ ok: true });
});

/** Mark everyone booked on a lesson as there, in one tap (the instructor at lineup, or the desk). */
router.post('/sessions/:id/all-present', requireRole(...school), async (req, res) => {
  const { tenantId } = req.auth;
  const n = await tx(async (conn) => {
    const s = await one(conn, 'SELECT id, instructor_id FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, paramId(req)]);
    if (!s) throw notFound('Lesson session');
    if (SA.ownOnly(req) && s.instructor_id !== req.auth.staffId) throw forbidden('Instructors can only mark attendance on their own lessons');
    const [r] = await conn.query("UPDATE lesson_bookings SET status = 'attended' WHERE tenant_id = ? AND session_id = ? AND status = 'booked'", [tenantId, s.id]);
    await audit(conn, req, 'all_present', 'lesson_sessions', s.id, { marked: r.affectedRows });
    return r.affectedRows;
  });
  res.json({ ok: true, marked: n });
});

/** Can this signed-in person see the children's details on this lesson? The desk, managers, and its own instructor. */
const seesDetails = (req, s) => !SA.ownOnly(req) || (s && s.instructor_id === req.auth.staffId);
const DETAIL_KEYS = ['allergies', 'medical', 'pickup', 'contact_name', 'contact_phone', 'contact_email'];

router.get('/sessions/:id/roster', requireRole(...school), async (req, res) => {
  const s = await one(pool, 'SELECT id, instructor_id, discipline FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!s) throw notFound('Lesson session');
  const data = await rows(
    pool,
    `SELECT b.id AS booking_id, b.status, b.unpaid, b.credit_id, b.instructor_notes, b.level AS booked_level, b.allergies, b.medical, b.pickup, b.contact_name, b.contact_phone, b.contact_email,
       b.text_ok, b.photo_ok, b.checked_in_at, b.checked_in_via, b.confirmed_at, p.id AS person_id, p.first_name, p.last_name, p.date_of_birth, p.ski_level, p.snowboard_level,
       (SELECT level FROM student_progress sp WHERE sp.tenant_id = p.tenant_id AND sp.person_id = p.id ORDER BY sp.recorded_at DESC, sp.id DESC LIMIT 1) AS latest_level
     FROM lesson_bookings b JOIN people p ON p.id = b.person_id AND p.tenant_id = b.tenant_id
     WHERE b.tenant_id = ? AND b.session_id = ? AND b.status <> 'cancelled' ORDER BY p.last_name`,
    [req.auth.tenantId, s.id],
  );
  const show = seesDetails(req, s);
  res.json({
    details: show,
    data: data.map((r) => {
      const out = { ...r, level: LV.personLevel(r, s.discipline) || r.booked_level || r.latest_level || null, has_allergies: Boolean(r.allergies), has_medical: Boolean(r.medical), text_ok: Boolean(r.text_ok), photo_ok: Boolean(r.photo_ok) };
      if (!show) for (const k of [...DETAIL_KEYS, 'instructor_notes']) delete out[k];
      return out;
    }),
  });
});

router.post(
  '/progress',
  requireRole('instructor', 'manager'),
  validate(z.object({ person_id: z.number().int().positive(), discipline: z.enum(disciplines), level: z.number().int().min(1).max(9), notes: z.string().max(1000).optional() })),
  async (req, res) => {
    const b = req.body;
    const id = await tx(async (conn) => {
      if (!(await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, b.person_id]))) throw notFound('Person');
      const [r] = await conn.query('INSERT INTO student_progress (tenant_id, person_id, discipline, level, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?)', [req.auth.tenantId, b.person_id, b.discipline, b.level, b.notes ?? null, req.auth.userId]);
      // The guest's level follows them to the next lesson, season and program (Contracts: level_source 'instructor').
      await conn.query(`UPDATE people SET ${LV.personColumn(b.discipline)} = ?, level_source = 'instructor', level_set_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?`, [b.level, req.auth.tenantId, b.person_id]);
      await audit(conn, req, 'level', 'people', b.person_id, { discipline: b.discipline, level: b.level });
      return r.insertId;
    });
    res.status(201).json({ id });
  },
);

// ---------------------------------------------------------------- the instructor's My day
const ageOn = (dob, day) => {
  if (!dob) return null;
  const d = String(dob instanceof Date ? dob.toISOString() : dob).slice(0, 10);
  let a = Number(day.slice(0, 4)) - Number(d.slice(0, 4));
  if (day.slice(5) < d.slice(5)) a -= 1;
  return a;
};
const pickupWords = (v) => {
  if (!v) return null;
  let list = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch (_) { return v; } }
  if (!Array.isArray(list)) return String(v);
  return list.map((x) => (typeof x === 'string' ? x : [x.name, x.phone].filter(Boolean).join(' '))).filter(Boolean).join(', ') || null;
};

/**
 * One instructor's lessons and program meetings from one day to another, in time order. withRoster adds each one's
 * students with what the instructor needs on the hill: age, level, allergy and medical notes, pickup, the parent's phone,
 * check-in and attendance. Only ever for the instructor's own lessons and meetings.
 */
async function myItems(tenantId, staffId, from, to, withRoster) {
  const lessons = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.age_min, s.age_max, s.format, s.meeting_place, s.notes, s.delay_minutes, s.status, s.product_id, s.capacity, pr.name AS product
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE s.tenant_id = ? AND s.instructor_id = ? AND s.status <> 'cancelled' AND DATE(s.starts_at) BETWEEN ? AND ? ORDER BY s.starts_at`, [tenantId, staffId, from, to]);
  const meetings = await rows(pool, `SELECT ps.id, ps.starts_at, ps.ends_at, ps.group_id, ps.term_id, ps.program_id, ps.status, p.name AS program, p.meeting_place, g.discipline AS group_discipline,
      (SELECT GROUP_CONCAT(l.id) FROM program_levels l WHERE l.tenant_id = ps.tenant_id AND l.group_id = ps.group_id AND l.coach_staff_id = ?) AS my_levels,
      (ps.coach_staff_id = ? OR (ps.coach_staff_id IS NULL AND g.coach_staff_id = ?)) AS whole_day
    FROM program_sessions ps JOIN programs p ON p.tenant_id = ps.tenant_id AND p.id = ps.program_id LEFT JOIN program_groups g ON g.tenant_id = ps.tenant_id AND g.id = ps.group_id
    WHERE ps.tenant_id = ? AND ps.status = 'scheduled' AND DATE(ps.starts_at) BETWEEN ? AND ?
      AND (ps.coach_staff_id = ? OR (ps.coach_staff_id IS NULL AND g.coach_staff_id = ?) OR EXISTS (SELECT 1 FROM program_levels l WHERE l.tenant_id = ps.tenant_id AND l.group_id = ps.group_id AND l.coach_staff_id = ?))
    ORDER BY ps.starts_at`, [staffId, staffId, staffId, tenantId, from, to, staffId, staffId, staffId]);
  const items = [
    ...lessons.map((s) => ({ kind: 'lesson', ...s, level_words: LV.range(s.level_min, s.level_max) })),
    ...meetings.map((m) => ({ kind: 'program', id: m.id, starts_at: m.starts_at, ends_at: m.ends_at, product: m.program, program_id: m.program_id, group_id: m.group_id, discipline: m.group_discipline, meeting_place: m.meeting_place, delay_minutes: 0, status: m.status,
      levels_only: m.whole_day ? null : String(m.my_levels || '').split(',').filter(Boolean).map(Number) })),
  ].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  if (!withRoster) return items;
  for (const it of items) {
    const day = String(it.starts_at).slice(0, 10);
    if (it.kind === 'lesson') {
      const students = await rows(pool, `SELECT b.id AS booking_id, b.status, b.allergies, b.medical, b.pickup, b.contact_name, b.contact_phone, b.checked_in_at, b.checked_in_via, b.instructor_notes, b.photo_ok, b.level AS booked_level, b.unpaid,
          p.id AS person_id, p.first_name, p.last_name, p.date_of_birth, p.ski_level, p.snowboard_level, p.phone, p.photo IS NOT NULL AS has_photo,
          (SELECT g.phone FROM person_links l JOIN people g ON g.tenant_id = l.tenant_id AND g.id = l.adult_id WHERE l.tenant_id = b.tenant_id AND l.member_id = b.person_id AND l.relation = 'guardian' ORDER BY g.id LIMIT 1) AS guardian_phone
        FROM lesson_bookings b JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
        WHERE b.tenant_id = ? AND b.session_id = ? AND b.status <> 'cancelled' ORDER BY p.first_name, p.last_name`, [tenantId, it.id]);
      it.students = students.map((x) => {
        const lvl = LV.personLevel(x, it.discipline) || x.booked_level || null;
        return { booking_id: x.booking_id, person_id: x.person_id, first_name: x.first_name, last_name: x.last_name, age: ageOn(x.date_of_birth, day), level: lvl, level_words: lvl ? LV.name(lvl, it.discipline) : null,
          has_photo: Boolean(x.has_photo), allergies: x.allergies, medical: x.medical, pickup: x.pickup, contact_name: x.contact_name, phone: x.contact_phone || x.guardian_phone || x.phone || null,
          status: x.status, checked_in_at: x.checked_in_at, checked_in_via: x.checked_in_via, note: x.instructor_notes, photo_ok: Boolean(x.photo_ok), unpaid: Boolean(x.unpaid) };
      });
    } else {
      const lvlFilter = it.levels_only && it.levels_only.length ? it.levels_only : null;
      const students = await rows(pool, `SELECT e.id AS enrollment_id, e.allergies, e.medical, e.pickup, e.discipline, e.level_id, p.id AS person_id, p.first_name, p.last_name, p.date_of_birth, p.ski_level, p.snowboard_level, p.phone, p.photo IS NOT NULL AS has_photo,
          g.phone AS guardian_phone, g.first_name AS guardian_first, a.present
        FROM program_sessions ps JOIN program_enrollments e ON e.tenant_id = ps.tenant_id AND e.program_id = ps.program_id AND e.status = 'enrolled'
          AND (e.term_id IS NULL OR ps.term_id IS NULL OR e.term_id = ps.term_id) AND (ps.group_id IS NULL OR e.group_id = ps.group_id OR e.any_day = 1)
        JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id LEFT JOIN people g ON g.tenant_id = e.tenant_id AND g.id = e.guardian_id
        LEFT JOIN attendance a ON a.tenant_id = ps.tenant_id AND a.session_id = ps.id AND a.person_id = e.person_id
        WHERE ps.tenant_id = ? AND ps.id = ? ${lvlFilter ? 'AND e.level_id IN (?)' : ''} ORDER BY p.first_name, p.last_name`, lvlFilter ? [tenantId, it.id, lvlFilter] : [tenantId, it.id]);
      it.students = students.map((x) => {
        const disc = x.discipline || it.discipline;
        const lvl = LV.personLevel(x, disc === 'snowboard' ? 'snowboard' : 'ski');
        return { person_id: x.person_id, first_name: x.first_name, last_name: x.last_name, age: ageOn(x.date_of_birth, day), level: lvl, level_words: lvl ? LV.name(lvl, disc) : null, has_photo: Boolean(x.has_photo),
          allergies: x.allergies, medical: x.medical, pickup: pickupWords(x.pickup), contact_name: x.guardian_first || null, phone: x.guardian_phone || x.phone || null,
          present: x.present == null ? null : Boolean(x.present) };
      });
    }
  }
  return items;
}

/** Whose day: your own, or (managers) the instructor named by staff_id. */
function whose(req) {
  const asked = Number(req.query.staff_id) || null;
  if (asked && asked !== req.auth.staffId && SA.ownOnly(req)) throw forbidden('You can only see your own day');
  const id = asked || req.auth.staffId;
  if (!id) throw bad('Your login is not linked to a staff record yet. Ask a manager to link it in Account.');
  return id;
}
router.get('/my-day', requireRole(...school), async (req, res) => {
  const { tenantId } = req.auth;
  const staffId = whose(req);
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const date = req.query.date ? String(req.query.date) : todayIn(tz);
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  const me = await one(pool, 'SELECT st.id, p.first_name, p.last_name FROM staff st JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE st.tenant_id = ? AND st.id = ?', [tenantId, staffId]);
  if (!me) throw notFound('Staff member');
  res.set('Cache-Control', 'no-store');
  res.json({ date, today: todayIn(tz), staff: { id: me.id, name: `${me.first_name} ${me.last_name}` }, items: await myItems(tenantId, staffId, date, date, true) });
});
/** Lessons and program meetings for My shifts: the next two weeks, without the rosters. */
router.get('/my-schedule', requireRole(...school), async (req, res) => {
  const { tenantId } = req.auth;
  const staffId = whose(req);
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const from = todayIn(tz);
  res.json({ data: (await myItems(tenantId, staffId, from, addDays(from, 14), false)).map((x) => ({ kind: x.kind, id: x.id, starts_at: x.starts_at, ends_at: x.ends_at, title: x.product, level_words: x.level_words || null, meeting_place: x.meeting_place })) });
});

module.exports = router;
