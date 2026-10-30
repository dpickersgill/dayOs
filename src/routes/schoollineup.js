'use strict';

// The ski school, round 2: the 9:45 lineup, check-in and the counter (Track LINEUP).
// router is mounted at /skischool (staff); publicRouter under /public (no sign-in).
// tick() runs every few minutes (POST /jobs/lessons) and daily() once a day (POST /jobs/daily): return a small summary.
//
// Staff:
//   GET  /skischool/checkin?date=&q=          the day's students by lesson time, with a search (name, phone, order number)
//   POST /skischool/checkin/scan              { code }: 'L' + booking number (confirmation, label) or 'ORD-' + order number (receipt)
//   POST /skischool/bookings/:id/checkin      the desk checks one student in; DELETE undoes it
//   GET  /skischool/lineups?date=             the day's lineups (made on the fly from the lessons), and the next one
//   GET  /skischool/lineups/:id               the board: each class with its instructor, level range and students
//   PATCH /skischool/lineups/:id              { ratio } for this lineup only (managers)
//   POST /skischool/lineups/:id/suggest       { from: 'checked_in'|'booked' }: the suggested split, nothing saved
//   POST /skischool/lineups/:id/apply         { classes: [{ session_id|null, booking_ids, instructor_id, level_min, level_max }] }
//   GET  /skischool/bookings/:id/move-options the classes this student can move to (same day, same time)
//   POST /skischool/bookings/:id/move         { session_id, reason? }: same booking row, family and instructor told
//   GET  /skischool/labels?session_id=|lineup_id=|booking_ids=
// Public:
//   POST /public/:slug/lesson/:token/here     the family's "We're here" (lesson day, from 90 minutes before the start)
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, nowIn } = require('../lib/util');
const { notFound, conflict, bad, forbidden, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const LL = require('../lib/lessonlineup');
const links = require('../lib/lessonlinks');
const modules = require('../lib/modules');
const S = require('../lib/schoolsettings');

const router = express.Router();
const publicRouter = express.Router();
const desk = ['manager', 'counter'];
const isManager = (req) => ['owner', 'manager'].includes(req.auth.role);
const dayOf = async (req) => {
  const d = String(req.query.date || '');
  if (d && !dateStr.safeParse(d).success) throw bad('date must be YYYY-MM-DD');
  return d || todayIn(await LL.tzOf(pool, req.auth.tenantId));
};

// ---------------------------------------------------------------- check-in
router.get('/checkin', requireRole(...desk), async (req, res) => {
  const date = await dayOf(req);
  res.json({ date, data: await LL.checkinList(pool, req.auth.tenantId, { date, q: String(req.query.q || '').slice(0, 60) }) });
});

/** One student checked in at the desk. The answer carries the flags to act on: no waiver, unpaid. */
async function deskCheckIn(req, bookingId) {
  const { tenantId } = req.auth;
  const b = await one(pool, `SELECT b.id, b.status, b.person_id, s.starts_at, s.status AS session_status FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    WHERE b.tenant_id = ? AND b.id = ?`, [tenantId, bookingId]);
  if (!b) throw notFound('Booking');
  if (b.session_status === 'cancelled' || !['booked', 'attended'].includes(b.status)) throw conflict('That booking is not active');
  const done = await tx(async (conn) => {
    const ok = await LL.checkIn(conn, tenantId, b.id, { via: 'desk', userId: req.auth.userId });
    if (ok) await audit(conn, req, 'check_in', 'lesson_bookings', b.id, { via: 'desk' });
    return ok;
  });
  const [row] = await LL.checkinList(pool, tenantId, { date: String(b.starts_at).slice(0, 10), q: LL.bookingCode(b.id) });
  return { ...row, already: !done };
}

router.post('/bookings/:id/checkin', requireRole(...desk), async (req, res) => {
  res.json(await deskCheckIn(req, paramId(req)));
});
router.delete('/bookings/:id/checkin', requireRole(...desk), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const b = await one(conn, 'SELECT id FROM lesson_bookings WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
    if (!b) throw notFound('Booking');
    await conn.query('UPDATE lesson_bookings SET checked_in_at = NULL, checked_in_via = NULL, checked_in_by = NULL WHERE tenant_id = ? AND id = ?', [tenantId, b.id]);
    await audit(conn, req, 'undo_check_in', 'lesson_bookings', b.id);
  });
  res.json({ ok: true });
});

router.post('/checkin/scan', requireRole(...desk), validate(z.object({ code: z.string().trim().min(1).max(40) })), async (req, res) => {
  const { tenantId } = req.auth;
  const code = LL.readCode(req.body.code);
  if (!code) throw bad('That code is not a lesson or a receipt. Search by name instead.');
  const today = todayIn(await LL.tzOf(pool, tenantId));
  let ids;
  if (code.booking_id) ids = [code.booking_id];
  else {
    ids = (await rows(pool, `SELECT DISTINCT b.id FROM order_items i JOIN lesson_bookings b ON b.tenant_id = i.tenant_id AND b.session_id = i.session_id AND b.person_id = i.person_id
      JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      WHERE i.tenant_id = ? AND i.order_id = ? AND i.refunded_at IS NULL AND DATE(s.starts_at) = ? AND b.status IN ('booked','attended')`, [tenantId, code.order_id, today])).map((r) => r.id);
    if (!ids.length) throw new AppError(404, 'No lesson today on that receipt');
  }
  const out = [];
  for (const id of ids) {
    const b = await one(pool, 'SELECT s.starts_at FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id WHERE b.tenant_id = ? AND b.id = ?', [tenantId, id]);
    if (!b) throw notFound('Booking');
    if (String(b.starts_at).slice(0, 10) !== today) throw conflict(`That lesson is on ${String(b.starts_at).slice(0, 10)}, not today`);
    out.push(await deskCheckIn(req, id));
  }
  res.json({ data: out });
});

// ---------------------------------------------------------------- the window: a student's level and last safety details
/**
 * For Sell: the student's level per discipline and age (to show the lessons that fit), and their safety details from
 * their last lesson booking (or their emergency contact on file), to prefill a lesson line. Desk and managers only.
 */
router.get('/lesson-safety/:id', requireRole(...desk), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await one(pool, 'SELECT id, first_name, last_name, date_of_birth, ski_level, snowboard_level, emergency_name, emergency_phone, email, phone FROM people WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!p) throw notFound('Person');
  const last = await one(pool, `SELECT allergies, medical, pickup, contact_name, contact_phone, contact_email, text_ok, photo_ok FROM lesson_bookings
    WHERE tenant_id = ? AND person_id = ? ORDER BY id DESC LIMIT 1`, [tenantId, p.id]);
  const today = todayIn(await LL.tzOf(pool, tenantId));
  res.json({
    person_id: p.id, first_name: p.first_name, age: LL.ageOn(p.date_of_birth, today), ski_level: p.ski_level, snowboard_level: p.snowboard_level,
    safety: last ? { ...last, text_ok: Boolean(last.text_ok), photo_ok: Boolean(last.photo_ok) } : { contact_name: p.emergency_name || null, contact_phone: p.emergency_phone || null },
  });
});

// ---------------------------------------------------------------- the lineup board
router.get('/lineups', requireRole(...desk), async (req, res) => {
  const date = await dayOf(req);
  const list = await tx((conn) => LL.ensureLineups(conn, req.auth.tenantId, date));
  const now = nowIn(await LL.tzOf(pool, req.auth.tenantId));
  // the next lineup: the first that has not started, else the last one today
  const next = list.find((l) => String(l.starts_at) > now) || list[list.length - 1] || null;
  res.json({ date, now, next_id: next ? next.id : null, data: list });
});

router.get('/lineups/:id', requireRole(...desk), async (req, res) => {
  res.json(await LL.board(pool, req.auth.tenantId, paramId(req)));
});

router.patch('/lineups/:id', requireRole('manager'), validate(z.object({ ratio: z.number().int().min(1).max(20).nullable() })), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const [r] = await conn.query('UPDATE lesson_lineups SET ratio = ? WHERE tenant_id = ? AND id = ?', [req.body.ratio, tenantId, paramId(req)]);
    if (!r.affectedRows) throw notFound('Lineup');
    await audit(conn, req, 'update', 'lesson_lineups', paramId(req), req.body);
  });
  res.json(await LL.board(pool, tenantId, paramId(req)));
});

router.post('/lineups/:id/suggest', requireRole(...desk), validate(z.object({ from: z.enum(['checked_in', 'booked']).default('checked_in') })), async (req, res) => {
  res.json(await LL.suggestSplit(pool, req.auth.tenantId, paramId(req), { from: req.body.from }));
});

const classSchema = z.object({
  session_id: z.number().int().positive().nullable(),
  booking_ids: z.array(z.number().int().positive()).max(60),
  instructor_id: z.number().int().positive().nullable().optional(),
  level_min: z.number().int().min(1).max(9).nullable().optional(),
  level_max: z.number().int().min(1).max(9).nullable().optional(),
  meeting_place: z.string().trim().max(120).optional(),
});
router.post('/lineups/:id/apply', requireRole('manager'), validate(z.object({ classes: z.array(classSchema).min(1).max(30) })), async (req, res) => {
  const { tenantId } = req.auth;
  const classes = req.body.classes.filter((c) => c.session_id || c.booking_ids.length);
  for (const c of classes) if (c.level_min && c.level_max && c.level_min > c.level_max) throw bad('A class has its lowest level above its highest');
  const moves = await tx((conn) => LL.applySplit(conn, req, paramId(req), classes, { isManager: isManager(req) }));
  await require('../lib/lessonspots').after(tenantId, { sessionIds: [...classes.map((c) => c.session_id), ...moves.flatMap((m) => [m.from && m.from.id, m.to && m.to.id])].filter(Boolean) }, req); // Track STAFF
  const told = [];
  for (const m of moves) told.push(await LL.tellMoved(pool, tenantId, m));
  res.json({ moved: moves.length, board: await LL.board(pool, tenantId, paramId(req)), told: told.length });
});

/** The instructors for a lineup's time, each with why they cannot take a class at its highest level (null when they can). */
router.get('/lineup-teachers', requireRole(...desk), async (req, res) => {
  const { tenantId } = req.auth;
  const b = await LL.board(pool, tenantId, Number(req.query.lineup_id) || 0);
  const first = b.classes[0];
  if (!first) return res.json({ data: [] });
  const top = Math.max(...b.classes.map((c) => Number(c.level_max) || 0), 0) || null;
  const mine = new Set(b.classes.map((c) => c.instructor_id).filter(Boolean));
  const out = [];
  for (const t of await LL.teachers(pool, tenantId)) {
    const problem = mine.has(t.id) ? null : await LL.teacherProblem(pool, tenantId, t, { discipline: b.lineup.discipline, levelMax: null, kids: b.lineup.kids, startsAt: first.starts_at, endsAt: first.ends_at });
    const max = Number(b.lineup.discipline === 'snowboard' ? t.snowboard_level_max : t.ski_level_max) || null;
    out.push({ id: t.id, name: `${t.first_name} ${t.last_name}`, max, problem, covers_top: !top || !max || max >= top });
  }
  res.json({ data: out });
});

// ---------------------------------------------------------------- moving one student
/** The instructor may move a student only out of their own lesson; the desk and managers any. */
async function mayMove(req, bookingId) {
  const b = await one(pool, `SELECT b.id, b.session_id, s.instructor_id, s.starts_at, s.ends_at, s.discipline, s.product_id FROM lesson_bookings b
    JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id WHERE b.tenant_id = ? AND b.id = ?`, [req.auth.tenantId, bookingId]);
  if (!b) throw notFound('Booking');
  if (req.auth.role === 'instructor' && (!req.auth.staffId || Number(b.instructor_id) !== Number(req.auth.staffId))) throw forbidden('You can move students only from your own lesson');
  return b;
}

router.get('/bookings/:id/move-options', requireRole('instructor', ...desk), async (req, res) => {
  const { tenantId } = req.auth;
  const b = await mayMove(req, paramId(req));
  // classes that overlap this lesson's time on the same day, for the same discipline (the board's columns, and a lesson
  // starting at another time the same morning is not a move a family expects)
  const data = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.level_min, s.level_max, s.meeting_place, s.capacity, s.instructor_id, pr.name AS product, ip.first_name AS instructor_first,
      (SELECT COUNT(*) FROM lesson_bookings x WHERE x.tenant_id = s.tenant_id AND x.session_id = s.id AND x.status IN ('booked','attended')) AS booked
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id
    WHERE s.tenant_id = ? AND s.id <> ? AND s.status = 'scheduled' AND s.discipline = ? AND DATE(s.starts_at) = ? AND s.starts_at < ? AND s.ends_at > ? AND s.format = 'group'
    ORDER BY COALESCE(s.level_min, 0), s.starts_at`, [tenantId, b.session_id, b.discipline, String(b.starts_at).slice(0, 10), b.ends_at, b.starts_at]);
  const L = require('../lib/levels');
  res.json({ data: data.map((s) => ({ ...s, level_words: L.range(s.level_min, s.level_max), spots_left: Math.max(s.capacity - Number(s.booked), 0) })) });
});

router.post('/bookings/:id/move', requireRole('instructor', ...desk), validate(z.object({ session_id: z.number().int().positive(), reason: z.string().trim().min(3).max(300).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  await mayMove(req, paramId(req));
  const moved = await tx((conn) => LL.moveBooking(conn, req, paramId(req), req.body.session_id, { reason: req.body.reason, isManager: isManager(req) }));
  await require('../lib/lessonspots').after(tenantId, { sessionIds: [moved.from.id, moved.to.id] }, req); // Track STAFF
  const told = await LL.tellMoved(pool, tenantId, moved);
  res.json({ ok: true, booking_id: moved.booking.id, from_session_id: moved.from.id, to_session_id: moved.to.id, over_by_one: moved.over, told: { family: Boolean(told.family && told.family.email), instructor: Boolean(told.instructor) } });
});

// ---------------------------------------------------------------- labels
router.get('/labels', requireRole('instructor', ...desk), async (req, res) => {
  const { tenantId } = req.auth;
  const ids = (s) => String(s || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 300);
  let sessionIds = ids(req.query.session_id);
  if (req.query.lineup_id) sessionIds = (await rows(pool, "SELECT id FROM lesson_sessions WHERE tenant_id = ? AND lineup_id = ? AND status <> 'cancelled'", [tenantId, Number(req.query.lineup_id)])).map((r) => r.id);
  const bookingIds = ids(req.query.booking_ids);
  if (!sessionIds.length && !bookingIds.length) throw bad('Choose a lesson, a lineup or students');
  // an instructor prints only their own lessons' labels
  if (req.auth.role === 'instructor') {
    const own = await rows(pool, `SELECT DISTINCT s.id FROM lesson_sessions s ${bookingIds.length ? 'JOIN lesson_bookings b ON b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.id IN (?)' : ''}
      WHERE s.tenant_id = ? ${sessionIds.length ? 'AND s.id IN (?)' : ''} AND (s.instructor_id IS NULL OR s.instructor_id <> ?)`,
    [...(bookingIds.length ? [bookingIds] : []), tenantId, ...(sessionIds.length ? [sessionIds] : []), req.auth.staffId || 0]);
    if (own.length) throw forbidden('You can print labels only for your own lessons');
  }
  res.json({ data: await LL.labels(pool, tenantId, { sessionIds, bookingIds }) });
});

// ---------------------------------------------------------------- the family's "We're here"
publicRouter.post('/:slug/lesson/:token/here', async (req, res) => {
  const t = await one(pool, 'SELECT id, timezone FROM tenants WHERE slug = ?', [String(req.params.slug)]);
  if (!t || !links.looksRight(req.params.token)) throw notFound('Lesson');
  try { await modules.requireModule(t.id, 'school'); } catch (_) { throw notFound('Lesson'); }
  const b = await links.find(pool, t.id, req.params.token);
  if (!b) throw notFound('Lesson');
  const settings = await S.get(pool, t.id);
  if (!settings.checkin_link) throw conflict('Check in at the ski school desk.');
  if (b.checked_in_at) return res.json({ ok: true, checked_in: true, already: true });
  if (!LL.checkinOpen(b, nowIn(t.timezone))) throw conflict('Check-in opens 90 minutes before the lesson, on the lesson day.');
  await tx(async (conn) => {
    await LL.checkIn(conn, t.id, b.id, { via: 'link' });
    await audit(conn, { auth: { tenantId: t.id, userId: null }, ip: req.ip }, 'check_in', 'lesson_bookings', b.id, { via: 'link' });
  });
  res.json({ ok: true, checked_in: true });
});

async function tick() { return { locked: await LL.lockStarted(pool) }; }
async function daily() { return {}; }

module.exports = { router, publicRouter, tick, daily };
