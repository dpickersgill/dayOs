'use strict';
// Ski school money and people (feat/school-pay). router is mounted at /skischool (staff), publicRouter under /public.
//   GET  /bookings/:id/payment     a roster booking to take payment for in Sell (the desk)
//   /pay/ladder                    the pay ladder: a rate by certification level, add-ons per specialist credential
//   GET  /pay/setup-check          instructors who have no pay rate yet (the director's Today and Payroll warn)
//   /training                      training sessions the director logs: who came and for how long (a paid line)
//   /pay/period/mine, /pay/flags   My pay for the open pay period, and flagging a line before payroll
//   /ratings                       the family's 0-10 "would you recommend your instructor" (NPS style)
//   /ladders                       learn to ski ladders: a first-timer package that ends with a season pass offer
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { z, dateStr, dateTimeStr, validate, paramId, todayIn, addDays, normDateTime } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const SA = require('../lib/schoolaccess');
const S = require('../lib/schoolsettings');
const P = require('../lib/lessonpay');
const LL = require('../lib/learnladder');
const NPS = require('../lib/lessonratings');

const router = express.Router();
const publicRouter = express.Router();
const director = SA.school('director');
const desk = SA.school('supervisor', 'counter');
const school = requireRole('instructor', 'manager', 'counter');
const ownersAndManagers = requireRole('manager'); // owners pass every requireRole
const NAME = "TRIM(CONCAT(p.first_name, ' ', p.last_name))";
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const first = (v) => (Array.isArray(v) ? v[0] : v);
const dateQ = (v, dflt) => { const s = v === undefined ? dflt : String(first(v)); if (!dateStr.safeParse(s).success) throw bad('Use a date such as 2026-12-19'); return s; };

// ================================================================ take payment for a roster booking
router.get('/bookings/:id/payment', desk, async (req, res) => {
  const t = req.auth.tenantId;
  const b = await one(pool, `SELECT b.id, b.session_id, b.person_id, b.status, b.unpaid, b.credit_id, b.allergies, b.medical, b.pickup, b.contact_name, b.contact_phone, b.contact_email, b.text_ok, b.photo_ok,
      s.starts_at, s.discipline, pr.name AS product, p.first_name, p.last_name, p.date_of_birth, p.email, p.phone, p.sex
    FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id WHERE b.tenant_id = ? AND b.id = ?`, [t, paramId(req)]);
  if (!b) throw notFound('Booking');
  const day = String(b.starts_at).slice(0, 10);
  const dob = b.date_of_birth ? String(b.date_of_birth instanceof Date ? b.date_of_birth.toISOString() : b.date_of_birth).slice(0, 10) : null;
  const tier = dob ? await require('../lib/guesttypes').forBirthday(pool, t, dob, day) : null;
  res.json({ booking_id: b.id, session_id: b.session_id, product: b.product, starts_at: b.starts_at, day, discipline: b.discipline, tier,
    unpaid: Boolean(b.unpaid) && b.status === 'booked' && !b.credit_id,
    person: { id: b.person_id, first_name: b.first_name, last_name: b.last_name, date_of_birth: dob, email: b.email, phone: b.phone, sex: b.sex },
    safety: { allergies: b.allergies, medical: b.medical, pickup: b.pickup, contact_name: b.contact_name, contact_phone: b.contact_phone, contact_email: b.contact_email, text_ok: Boolean(b.text_ok), photo_ok: Boolean(b.photo_ok) } });
});

// ================================================================ the pay ladder
const RUNGS = [...P.CERTS, ...P.CREDENTIALS];
router.get('/pay/ladder', director, async (req, res) => {
  const t = req.auth.tenantId;
  const list = await rows(pool, 'SELECT id, rung, kind, cents, effective_from FROM school_pay_ladder WHERE tenant_id = ? ORDER BY rung, kind, effective_from DESC', [t]);
  const counts = await rows(pool, "SELECT psia_level AS cert, COUNT(*) AS n FROM instructor_profiles WHERE tenant_id = ? AND psia_level <> 'none' GROUP BY psia_level", [t]);
  res.json({ ladder: list, today: todayIn(await tzOf(t)), certs: P.CERTS.map((k) => ({ key: k, words: P.CERT_WORDS[k], instructors: Number((counts.find((c) => c.cert === k) || {}).n || 0) })),
    credentials: P.CREDENTIALS.map((k) => ({ key: k, words: P.CREDENTIAL_WORDS[k] })), can_edit: ['owner', 'manager'].includes(req.auth.role) });
});
// The ladder is everyone's pay, a school Director's too: owners and managers set it.
router.post('/pay/ladder', ownersAndManagers, validate(z.object({
  rung: z.enum(RUNGS), kind: z.enum(['group', 'semi_private', 'private', 'hourly', 'program', 'lesson_addon', 'hourly_addon']),
  cents: z.number().int().min(0).max(1000000).nullable(), effective_from: dateStr.optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const isCred = P.CREDENTIALS.includes(b.rung);
  if (isCred !== ['lesson_addon', 'hourly_addon'].includes(b.kind)) throw bad(isCred ? 'A credential pays an add-on per lesson or per hour' : 'A certification level pays a lesson or hourly rate');
  const from = b.effective_from || todayIn(await tzOf(t));
  await tx(async (conn) => {
    if (b.cents === null) await conn.query('DELETE FROM school_pay_ladder WHERE tenant_id = ? AND rung = ? AND kind = ? AND effective_from >= ?', [t, b.rung, b.kind, from]);
    else await conn.query('INSERT INTO school_pay_ladder (tenant_id, rung, kind, cents, effective_from, created_by) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE cents = VALUES(cents), created_by = VALUES(created_by)', [t, b.rung, b.kind, b.cents, from, req.auth.userId]);
    await audit(conn, req, 'pay_ladder', 'school_pay_ladder', t, { ...b, effective_from: from });
  });
  res.status(201).json({ ok: true });
});

// ================================================================ pay rates not set
/** The instructors with no rate for a kind of line the school pays: their own, the ladder by level, or the default. */
async function setupCheck(tenantId) {
  const settings = await S.get(pool, tenantId);
  const today = todayIn(await tzOf(tenantId));
  const book = await P.rateBook(pool, tenantId);
  const kinds = settings.pay_mode === 'hourly' ? ['hourly'] : settings.pay_mode === 'both' ? ['group', 'semi_private', 'private', 'hourly'] : ['group', 'semi_private', 'private'];
  const staff = await rows(pool, `SELECT s.id, ${NAME} AS name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE s.tenant_id = ? AND s.status = 'active' AND (EXISTS (SELECT 1 FROM instructor_profiles ip WHERE ip.tenant_id = s.tenant_id AND ip.staff_id = s.id)
      OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = s.tenant_id AND u.staff_id = s.id AND u.role = 'instructor')
      OR EXISTS (SELECT 1 FROM lesson_sessions l WHERE l.tenant_id = s.tenant_id AND l.instructor_id = s.id)) ORDER BY name`, [tenantId]);
  const missing = [];
  for (const s of staff) {
    const gaps = kinds.filter((k) => book.rate(s.id, k, today) === null);
    if (gaps.length) missing.push({ staff_id: s.id, name: s.name, kinds: gaps.map((k) => ({ kind: k, words: P.KIND_WORDS[k] })) });
  }
  return { pay_mode: settings.pay_mode, instructors: staff.length, missing };
}
router.get('/pay/setup-check', director, async (req, res) => res.json(await setupCheck(req.auth.tenantId)));

// ================================================================ training time
const trainingSchema = z.object({
  title: z.string().trim().min(2).max(160), starts_at: dateTimeStr.transform(normDateTime), ends_at: dateTimeStr.transform(normDateTime),
  notes: z.string().trim().max(1000).nullable().optional(),
  attendees: z.array(z.object({ staff_id: z.number().int().positive(), minutes: z.number().int().min(1).max(900).nullable().optional() })).min(1).max(200),
});
async function checkAttendees(conn, req, list) {
  const ids = [...new Set(list.map((a) => a.staff_id))];
  if (ids.length !== list.length) throw bad('Someone is listed twice');
  const found = await rows(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id IN (?)', [req.auth.tenantId, ids]);
  if (found.length !== ids.length) throw notFound('Instructor');
  // A school Director does not log paid time for themselves (owners and managers can).
  if (SA.isSchoolDirector(req) && ids.includes(Number(req.auth.staffId))) throw forbidden('You cannot log paid training time for yourself. Ask an owner or manager.');
}
const paidKeys = async (db, tenantId, id) => rows(db, 'SELECT staff_id FROM payroll_items WHERE tenant_id = ? AND line_key = ?', [tenantId, `training:${id}`]);

router.get('/training', director, async (req, res) => {
  const t = req.auth.tenantId; const today = todayIn(await tzOf(t));
  const from = dateQ(req.query.from, addDays(today, -60)); const to = dateQ(req.query.to, addDays(today, 30));
  const list = await rows(pool, `SELECT t.id, t.title, t.starts_at, t.ends_at, t.notes, t.status FROM school_trainings t WHERE t.tenant_id = ? AND DATE(t.starts_at) BETWEEN ? AND ? ORDER BY t.starts_at DESC LIMIT 300`, [t, from, to]);
  const ids = list.map((x) => x.id);
  const who = ids.length ? await rows(pool, `SELECT a.training_id, a.staff_id, a.minutes, ${NAME} AS name FROM school_training_staff a JOIN staff s ON s.tenant_id = a.tenant_id AND s.id = a.staff_id
    JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE a.tenant_id = ? AND a.training_id IN (?) ORDER BY name`, [t, ids]) : [];
  const paid = ids.length ? await rows(pool, "SELECT line_key, staff_id FROM payroll_items WHERE tenant_id = ? AND line_key IN (?)", [t, ids.map((i) => `training:${i}`)]) : [];
  res.json({ from, to, data: list.map((x) => ({ ...x, minutes: P.zoneMinutes(x.starts_at, x.ends_at, null), attendees: who.filter((a) => a.training_id === x.id).map((a) => ({ staff_id: a.staff_id, name: a.name, minutes: a.minutes, paid: paid.some((p) => p.line_key === `training:${x.id}` && p.staff_id === a.staff_id) })) })) });
});
router.post('/training', director, validate(trainingSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.ends_at <= b.starts_at) throw bad('The end must be after the start');
  if (P.zoneMinutes(b.starts_at, b.ends_at, null) > 900) throw bad('A training session is at most 15 hours');
  const id = await tx(async (conn) => {
    await checkAttendees(conn, req, b.attendees);
    const [r] = await conn.query('INSERT INTO school_trainings (tenant_id, title, starts_at, ends_at, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)', [t, b.title, b.starts_at, b.ends_at, b.notes ?? null, req.auth.userId]);
    for (const a of b.attendees) await conn.query('INSERT INTO school_training_staff (tenant_id, training_id, staff_id, minutes) VALUES (?, ?, ?, ?)', [t, r.insertId, a.staff_id, a.minutes ?? null]);
    await audit(conn, req, 'create', 'school_trainings', r.insertId, { title: b.title, attendees: b.attendees.length });
    return r.insertId;
  });
  res.status(201).json({ id });
});
router.put('/training/:id', director, validate(trainingSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body; const id = paramId(req);
  if (b.ends_at <= b.starts_at) throw bad('The end must be after the start');
  await tx(async (conn) => {
    const x = await one(conn, 'SELECT id FROM school_trainings WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!x) throw notFound('Training');
    // Paid lines are never paid twice or changed after payroll: an exported training stays as it was paid.
    if ((await paidKeys(conn, t, id)).length) throw conflict('This training was paid in payroll already, so it cannot change. Log a new session for any time still owed.');
    await checkAttendees(conn, req, b.attendees);
    await conn.query('UPDATE school_trainings SET title = ?, starts_at = ?, ends_at = ?, notes = ? WHERE tenant_id = ? AND id = ?', [b.title, b.starts_at, b.ends_at, b.notes ?? null, t, id]);
    await conn.query('DELETE FROM school_training_staff WHERE tenant_id = ? AND training_id = ?', [t, id]);
    for (const a of b.attendees) await conn.query('INSERT INTO school_training_staff (tenant_id, training_id, staff_id, minutes) VALUES (?, ?, ?, ?)', [t, id, a.staff_id, a.minutes ?? null]);
    await audit(conn, req, 'update', 'school_trainings', id, { title: b.title, attendees: b.attendees.length });
  });
  res.json({ ok: true });
});
router.delete('/training/:id', director, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  await tx(async (conn) => {
    const x = await one(conn, 'SELECT id FROM school_trainings WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!x) throw notFound('Training');
    if ((await paidKeys(conn, t, id)).length) throw conflict('This training was paid in payroll already, so it cannot be removed.');
    await conn.query("UPDATE school_trainings SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [t, id]);
    await audit(conn, req, 'cancel', 'school_trainings', id);
  });
  res.json({ ok: true });
});

// ================================================================ My pay: the pay period, and flagging a line
function whoseStaff(req, asked) {
  const wanted = asked ? Number(first(asked)) : req.auth.staffId;
  if (!wanted) throw bad(SA.atLeast(req, 'director') ? 'Choose an instructor' : 'Your login is not linked to a staff record yet. Ask a manager to link it.');
  if (wanted !== req.auth.staffId && !SA.atLeast(req, 'director')) throw forbidden('You can only see your own pay');
  return wanted;
}
/** The pay period for My pay: the newest payroll period not yet exported that covers today (or the last one before), with whether this instructor is approved. */
router.get('/pay/period/mine', school, async (req, res) => {
  const t = req.auth.tenantId;
  const staffId = whoseStaff(req, req.query.staff_id);
  const today = todayIn(await tzOf(t));
  const run = await one(pool, `SELECT id, period_from, period_to, status FROM payroll_runs WHERE tenant_id = ? AND status <> 'exported' AND period_from <= ?
    ORDER BY period_to >= ? DESC, period_from DESC LIMIT 1`, [t, today, today]);
  const appr = run ? await one(pool, 'SELECT approved_at FROM payroll_approvals WHERE tenant_id = ? AND run_id = ? AND staff_id = ?', [t, run.id, staffId]) : null;
  res.json({ period: run ? { from: String(run.period_from).slice(0, 10), to: String(run.period_to).slice(0, 10), approved: Boolean(appr) } : null,
    flags: await rows(pool, 'SELECT id, line_key, work_day, line_words, message, status, answer, created_at, answered_at FROM pay_line_flags WHERE tenant_id = ? AND staff_id = ? ORDER BY created_at DESC LIMIT 100', [t, staffId]) });
});

router.post('/pay/flags', requireRole('instructor', 'manager'), validate(z.object({ line_key: z.string().trim().min(3).max(80), day: dateStr, message: z.string().trim().min(3).max(1000) })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (!req.auth.staffId) throw bad('Your login is not linked to a staff record yet. Ask a manager to link it.');
  // Only a line of your own, worked out the same way My pay and payroll do.
  const { lines } = await P.lines(pool, t, { from: b.day, to: b.day, staffId: req.auth.staffId });
  const line = lines.find((l) => l.key === b.line_key && !l.tip);
  if (!line) throw notFound('Pay line');
  if (await one(pool, "SELECT id FROM pay_line_flags WHERE tenant_id = ? AND staff_id = ? AND line_key = ? AND work_day = ? AND status = 'open'", [t, req.auth.staffId, b.line_key, b.day])) throw conflict('You already flagged this line. The director will answer it.');
  const words = `${line.title}: ${P.amount(line.cents)}${line.words ? ` (${line.words})` : ''}`.slice(0, 300);
  const [r] = await pool.query('INSERT INTO pay_line_flags (tenant_id, staff_id, line_key, work_day, line_words, message, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, req.auth.staffId, b.line_key, b.day, words, b.message, req.auth.userId]);
  await audit(pool, req, 'pay_flag', 'pay_line_flags', r.insertId, { line_key: b.line_key, day: b.day });
  res.status(201).json({ id: r.insertId });
});
router.get('/pay/flags', school, async (req, res) => {
  const t = req.auth.tenantId;
  const all = SA.atLeast(req, 'director') && !req.query.staff_id;
  const where = ['f.tenant_id = ?']; const args = [t];
  if (!all) { where.push('f.staff_id = ?'); args.push(whoseStaff(req, req.query.staff_id)); }
  if (req.query.from) { where.push('f.work_day >= ?'); args.push(dateQ(req.query.from)); }
  if (req.query.to) { where.push('f.work_day <= ?'); args.push(dateQ(req.query.to)); }
  if (req.query.status === 'open') where.push("f.status = 'open'");
  res.json({ data: await rows(pool, `SELECT f.id, f.staff_id, ${NAME} AS name, f.line_key, f.work_day, f.line_words, f.message, f.status, f.answer, f.created_at, f.answered_at
    FROM pay_line_flags f JOIN staff s ON s.tenant_id = f.tenant_id AND s.id = f.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE ${where.join(' AND ')} ORDER BY f.status = 'open' DESC, f.created_at DESC LIMIT 300`, args) });
});
router.post('/pay/flags/:id/answer', director, validate(z.object({ answer: z.string().trim().min(2).max(1000) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const f = await one(pool, 'SELECT id, staff_id FROM pay_line_flags WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!f) throw notFound('Flag');
  if (SA.isSchoolDirector(req) && Number(f.staff_id) === Number(req.auth.staffId)) throw forbidden('You cannot answer a flag on your own pay. Ask an owner or manager.');
  await pool.query("UPDATE pay_line_flags SET status = 'answered', answer = ?, answered_by = ?, answered_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [req.body.answer, req.auth.userId, t, id]);
  await audit(pool, req, 'pay_flag_answer', 'pay_line_flags', id);
  res.json({ ok: true });
});

// ================================================================ instructor satisfaction (NPS style)
router.get('/ratings/summary', director, async (req, res) => {
  const t = req.auth.tenantId; const today = todayIn(await tzOf(t));
  const from = dateQ(req.query.from, `${Number(today.slice(5, 7)) >= 8 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-08-01`); const to = dateQ(req.query.to, today);
  res.json({ from, to, data: await NPS.summary(pool, t, from, to) });
});
router.get('/ratings/mine', requireRole('instructor', 'manager'), async (req, res) => {
  const t = req.auth.tenantId;
  if (!req.auth.staffId) return res.json({ nps: null, count: 0 });
  const today = todayIn(await tzOf(t));
  const [mine] = await NPS.summary(pool, t, `${Number(today.slice(5, 7)) >= 8 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-08-01`, today, req.auth.staffId);
  res.json(mine ? { nps: mine.nps, count: mine.count } : { nps: null, count: 0 }); // their own number only, never the comments
});
// Comments: owners, managers and the school Director; a Director never reads the comments about themselves.
router.get('/ratings', director, async (req, res) => {
  const t = req.auth.tenantId;
  const staffId = req.query.staff_id ? Number(first(req.query.staff_id)) : null;
  if (SA.isSchoolDirector(req) && staffId && staffId === Number(req.auth.staffId)) throw forbidden('Comments about you are read by an owner or manager');
  const list = await NPS.comments(pool, t, { staffId, exceptStaffId: SA.isSchoolDirector(req) ? req.auth.staffId : null });
  await audit(pool, req, 'ratings_view', 'lesson_ratings', staffId || 0, { count: list.length });
  res.json({ data: list });
});

const rateLimitPublic = rateLimit({ windowMs: 60_000, max: Number(process.env.BOOKING_RATE_LIMIT) > 60 ? Number(process.env.BOOKING_RATE_LIMIT) : 20, message: 'Too many tries. Please wait a minute.' });
publicRouter.post('/:slug/lesson/:token/rating', rateLimitPublic, validate(z.object({ score: z.number().int().min(0).max(10), comment: z.string().trim().max(1000).nullable().optional() })), async (req, res) => {
  const t = await one(pool, 'SELECT id, timezone FROM tenants WHERE slug = ?', [String(req.params.slug)]);
  if (!t || !(await require('../lib/modules').enabledKeys(t.id)).includes('school')) throw notFound('Page');
  const b = await require('../lib/lessonfamily').bookingByToken(pool, t.id, req.params.token);
  if (!b) throw notFound('Lesson');
  res.set('Cache-Control', 'no-store');
  res.json(await NPS.save(pool, t, b, req.body));
});

// ================================================================ learn to ski ladders
router.get('/ladders', desk, async (req, res) => {
  const t = req.auth.tenantId;
  const choices = SA.atLeast(req, 'director') ? {
    tickets: await rows(pool, "SELECT id, name, base_price_cents FROM products WHERE tenant_id = ? AND kind IN ('day_ticket','multi_day') AND active = 1 ORDER BY name", [t]),
    rentals: await rows(pool, "SELECT id, name, base_price_cents FROM products WHERE tenant_id = ? AND kind = 'rental' AND active = 1 ORDER BY name", [t]),
    passes: await rows(pool, "SELECT id, name, base_price_cents FROM products WHERE tenant_id = ? AND kind = 'season_pass' AND active = 1 ORDER BY name", [t]),
  } : null;
  res.json({ data: await LL.list(pool, t), choices });
});
router.post('/ladders', director, validate(LL.schema), async (req, res) => {
  const id = await tx(async (conn) => LL.create(conn, req, req.body));
  res.status(201).json({ id });
});
router.patch('/ladders/:id', director, validate(LL.schema.partial()), async (req, res) => {
  await tx(async (conn) => LL.update(conn, req, paramId(req), req.body));
  res.json({ ok: true });
});
router.get('/ladders/progress/:personId', school, async (req, res) => res.json({ data: await LL.progress(pool, req.auth.tenantId, Number(req.params.personId) || 0) }));

module.exports = { router, publicRouter, setupCheck };
