'use strict';

// The ski school, round 2: instructor pay, private lessons asked for by name, payroll (Track PAY).
// router is mounted at /skischool (staff); publicRouter under /public (no sign-in).
// tick() runs every few minutes (POST /jobs/lessons) and daily() once a day (POST /jobs/daily): return a small summary.
const express = require('express');
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { z, dateStr, validate, paramId, todayIn, nowIn, addDays, seasonFor } = require('../lib/util');
const { notFound, conflict, bad, forbidden, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv, dollars } = require('../lib/csv');
const { baseUrl } = require('../lib/baseurl');
const { staffProblems } = require('../lib/workforce');
const { studentClash, clashWords } = require('../lib/lessonrules');
const { ON_FILE } = require('../lib/waivers');
const S = require('../lib/schoolsettings');
const P = require('../lib/lessonpay');
const PR = require('../lib/lessonprivate');
const levels = require('../lib/levels');
const modules = require('../lib/modules');
const connect = require('../lib/connect');
const stripe = require('../lib/stripe');
const mailer = require('../lib/mailer');
const familynotify = require('../lib/familynotify');
const { isSandbox } = require('../lib/sandbox');
const { policyText, policyTiers } = require('../lib/onlinesale');

const router = express.Router();
const publicRouter = express.Router();
const SA = require('../lib/schoolaccess'); // 2026.11.9: the school director and supervisor
const manager = SA.school('director');
const desk = SA.school('supervisor', 'counter');
const school = requireRole('instructor', 'manager', 'counter');
const NAME = "TRIM(CONCAT(p.first_name, ' ', p.last_name))";
const DISCIPLINES = ['ski', 'snowboard', 'telemark', 'adaptive'];
const first = (v) => (Array.isArray(v) ? v[0] : v);
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const dateQ = (v, dflt) => { const s = v === undefined ? dflt : String(first(v)); if (!dateStr.safeParse(s).success) throw bad('Use a date such as 2026-12-19'); return s; };

/** Whose pay or requests: your own; a manager may name an instructor with staff_id. */
function whoseStaff(req, asked) {
  const wanted = asked ? Number(first(asked)) : req.auth.staffId;
  if (!wanted) throw bad(SA.atLeast(req, 'director') ? 'Choose an instructor' : 'Your login is not linked to a staff record yet. Ask a manager to link it.');
  if (wanted !== req.auth.staffId && !SA.atLeast(req, 'director')) throw forbidden('You can only see your own pay');
  return wanted;
}

// ================================================================ pay rates
const rateSchema = z.object({
  staff_id: z.number().int().positive().nullable(),
  kind: z.enum(P.KINDS),
  cents: z.number().int().min(0).max(1000000),
  effective_from: dateStr.optional(),
});

router.get('/pay/rates', manager, async (req, res) => {
  const t = req.auth.tenantId;
  const [rates, staff] = await Promise.all([
    rows(pool, `SELECT r.id, r.staff_id, r.kind, r.cents, r.effective_from, ${NAME} AS name FROM instructor_pay_rates r
      LEFT JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.staff_id LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
      WHERE r.tenant_id = ? ORDER BY r.staff_id IS NOT NULL, name, r.kind, r.effective_from DESC`, [t]),
    rows(pool, `SELECT s.id, ${NAME} AS name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
      WHERE s.tenant_id = ? AND s.status = 'active' AND (EXISTS (SELECT 1 FROM instructor_profiles ip WHERE ip.tenant_id = s.tenant_id AND ip.staff_id = s.id)
        OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = s.tenant_id AND u.staff_id = s.id AND u.role = 'instructor')
        OR EXISTS (SELECT 1 FROM lesson_sessions l WHERE l.tenant_id = s.tenant_id AND l.instructor_id = s.id)) ORDER BY name`, [t]),
  ]);
  res.json({ rates, instructors: staff, settings: await S.get(pool, t), today: todayIn(await tzOf(t)) });
});

router.post('/pay/rates', manager, validate(rateSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.staff_id && !(await one(pool, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, b.staff_id]))) throw notFound('Instructor');
  const from = b.effective_from || todayIn(await tzOf(t));
  const id = await tx(async (conn) => {
    const [r] = await conn.query(`INSERT INTO instructor_pay_rates (tenant_id, staff_id, kind, cents, effective_from, created_by) VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE cents = VALUES(cents), created_by = VALUES(created_by), id = LAST_INSERT_ID(id)`, [t, b.staff_id, b.kind, b.cents, from, req.auth.userId]);
    await audit(conn, req, 'pay_rate', 'instructor_pay_rates', r.insertId, { ...b, effective_from: from });
    return r.insertId;
  });
  res.status(201).json({ id });
});

router.delete('/pay/rates/:id', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const r = await one(pool, 'SELECT * FROM instructor_pay_rates WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!r) throw notFound('Rate');
  await tx(async (conn) => {
    await conn.query('DELETE FROM instructor_pay_rates WHERE tenant_id = ? AND id = ?', [t, id]);
    await audit(conn, req, 'pay_rate_delete', 'instructor_pay_rates', id, { staff_id: r.staff_id, kind: r.kind, cents: r.cents });
  });
  res.json({ ok: true });
});

// ================================================================ private lengths sold online
const offerSchema = z.object({
  product_id: z.number().int().positive(),
  minutes: z.number().int().min(30).max(480),
  max_students: z.number().int().min(1).max(6).default(1),
  extra_student_cents: z.number().int().min(0).max(100000).default(0),
  meeting_place: z.string().trim().max(120).nullable().optional(),
  active: z.boolean().optional(),
});
router.get('/pay/private-offers', desk, async (req, res) => {
  const t = req.auth.tenantId;
  res.json({
    offers: await rows(pool, 'SELECT o.*, pr.name AS product, pr.base_price_cents FROM private_offers o JOIN products pr ON pr.tenant_id = o.tenant_id AND pr.id = o.product_id WHERE o.tenant_id = ? ORDER BY o.active DESC, o.minutes', [t]),
    products: await rows(pool, "SELECT id, name, base_price_cents FROM products WHERE tenant_id = ? AND kind = 'lesson' AND active = 1 AND (uses IS NULL OR uses <= 1) ORDER BY name", [t]),
    slug: (await one(pool, 'SELECT slug FROM tenants WHERE id = ?', [t])).slug,
  });
});
async function checkProduct(t, id) {
  if (!(await one(pool, "SELECT id FROM products WHERE tenant_id = ? AND id = ? AND kind = 'lesson' AND (uses IS NULL OR uses <= 1)", [t, id]))) throw bad('Pick a single lesson product');
}
router.post('/pay/private-offers', manager, validate(offerSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await checkProduct(t, b.product_id);
  const [r] = await pool.query('INSERT INTO private_offers (tenant_id, product_id, minutes, max_students, extra_student_cents, meeting_place, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [t, b.product_id, b.minutes, b.max_students, b.extra_student_cents, b.meeting_place ?? null, b.active === false ? 0 : 1]);
  await audit(pool, req, 'create', 'private_offers', r.insertId, b);
  res.status(201).json({ id: r.insertId });
});
router.patch('/pay/private-offers/:id', manager, validate(offerSchema.partial()), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  if (!(await one(pool, 'SELECT id FROM private_offers WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Private lesson length');
  if (b.product_id) await checkProduct(t, b.product_id);
  const keys = ['product_id', 'minutes', 'max_students', 'extra_student_cents', 'meeting_place', 'active'].filter((k) => b[k] !== undefined);
  if (keys.length) await pool.query(`UPDATE private_offers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => (k === 'active' ? (b[k] ? 1 : 0) : b[k])), t, id]);
  await audit(pool, req, 'update', 'private_offers', id, b);
  res.json({ ok: true });
});

// ================================================================ the instructor's day and pay
/** What a private request would pay this instructor (the pay line shown before they accept). */
async function requestPay(db, tenantId, staffId, r, settings) {
  const rates = await rows(db, 'SELECT staff_id, kind, cents, effective_from FROM instructor_pay_rates WHERE tenant_id = ?', [tenantId]);
  const day = String(r.starts_at).slice(0, 10);
  const parts = [];
  const pr = P.rateFrom(rates, staffId, 'private', day);
  const hr = P.rateFrom(rates, staffId, 'hourly', day);
  if (settings.pay_mode !== 'hourly' && pr !== null) parts.push({ label: 'private', cents: pr });
  if (settings.pay_mode !== 'per_lesson' && hr !== null) parts.push({ label: `${Math.round((r.minutes / 60) * 100) / 100} h`, cents: Math.round((hr * r.minutes) / 60) });
  if (settings.pay_mode === 'hourly' && pr) parts.push({ label: 'private', cents: pr });
  if (r.staff_id && settings.request_bonus_cents > 0) parts.push({ label: 'request', cents: Number(settings.request_bonus_cents) });
  return { cents: parts.reduce((n, p) => n + p.cents, 0), parts, words: P.wordsOf(parts) };
}

/** The private requests an instructor can answer now: sent to them by name, or to any instructor who teaches it. */
async function requestsFor(db, tenantId, staffId) {
  const list = await rows(db, `SELECT r.* FROM private_requests r WHERE r.tenant_id = ? AND r.status = 'waiting' AND (r.staff_id = ? OR (r.staff_id IS NULL AND r.any_instructor = 1))
    ORDER BY r.deadline_at, r.starts_at LIMIT 50`, [tenantId, staffId]);
  const prof = await one(db, 'SELECT disciplines, ski_level_max, snowboard_level_max, teaches_kids, teaches_adaptive FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [tenantId, staffId]);
  const settings = await S.get(db, tenantId);
  const out = [];
  for (const r of list) {
    const st = PR.parseStudents(r);
    // A request open to any instructor shows only to those cleared for it: the discipline, the level, and children when
    // there are any (an instructor with no teaching profile is not cleared yet).
    if (!r.staff_id && (PR.ids(r.declined_ids).includes(staffId) || !PR.teaches(prof, r.discipline, Math.max(...st.map((s) => Number(s.level) || 1)), { kids: PR.kidsIn(r) }))) continue;
    out.push({ ...shapeRequest(r), pay: await requestPay(db, tenantId, staffId, r, settings) });
  }
  return out;
}

/** A request as staff see it: no card details, only first names and levels of the students, and the family contact. */
function shapeRequest(r, names = null) {
  const st = PR.parseStudents(r);
  return {
    id: r.id, reference: r.reference, status: r.status, source: r.source, starts_at: r.starts_at, ends_at: PR.plusMinutes(r.starts_at, r.minutes), minutes: r.minutes, discipline: r.discipline,
    staff_id: r.staff_id, staff_name: names && r.staff_id ? names.get(r.staff_id) || null : undefined, any_instructor: Boolean(r.any_instructor) && !r.staff_id,
    deadline_at: r.deadline_at ? `${String(r.deadline_at).replace(' ', 'T')}Z` : null,
    students: st.map((s) => ({ first_name: s.first_name, last_name: s.last_name, level: Number(s.level) || null, level_words: s.level ? levels.name(s.level, r.discipline) : '' })),
    level_words: levels.range(Math.min(...st.map((s) => Number(s.level) || 1)), Math.max(...st.map((s) => Number(s.level) || 1))),
    note: r.note, contact_name: r.contact_name, contact_phone: r.contact_phone, amount_cents: r.amount_cents, pay_at_desk: Boolean(r.pay_at_desk),
    session_id: r.session_id, refund_cents: r.refund_cents, staff_note: r.staff_note, declined: PR.ids(r.declined_ids).length,
  };
}

// The pay line on My day (Contracts: { lessons: { [session_id]: { cents, words } }, waiting_requests }).
router.get('/pay/my-day', school, async (req, res) => {
  const t = req.auth.tenantId;
  const date = dateQ(req.query.date, todayIn(await tzOf(t)));
  if (!req.auth.staffId && !req.query.staff_id) return res.json({ date, lessons: {}, waiting_requests: 0, requests: [] });
  const staffId = whoseStaff(req, req.query.staff_id);
  const { lines } = await P.lines(pool, t, { from: date, to: date, staffId });
  const requests = await requestsFor(pool, t, staffId);
  res.json({ date, lessons: P.forMyDay(lines), waiting_requests: requests.length, requests });
});

// My pay: this week (or any range) line by line, with tips by lesson, and the season total.
router.get('/pay/mine', school, async (req, res) => {
  const t = req.auth.tenantId;
  const today = todayIn(await tzOf(t));
  const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = addDays(today, -((wd + 6) % 7));
  const from = dateQ(req.query.from, monday); const to = dateQ(req.query.to, addDays(monday, 6));
  if (to < from) throw bad('The last day is before the first');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 200) throw bad('Choose up to 200 days');
  const staffId = whoseStaff(req, req.query.staff_id);
  const { lines, settings } = await P.lines(pool, t, { from, to, staffId });
  const [g] = P.byInstructor(lines);
  // The season so far: from the start of the season (August 1, as seasonFor counts it) to today.
  const season = seasonFor(today); const seasonStart = `${String(season).slice(0, 4)}-08-01`;
  const seasonEnd = to > today ? to : today; // the season to the end of the week shown, so booked lessons ahead count too
  const all = await P.lines(pool, t, { from: seasonStart, to: seasonEnd, staffId });
  const [sg] = P.byInstructor(all.lines);
  const exported = new Set((await rows(pool, 'SELECT line_key FROM payroll_items WHERE tenant_id = ? AND staff_id = ?', [t, staffId])).map((x) => x.line_key));
  res.json({ from, to, pay_mode: settings.pay_mode, lineup_paid: Boolean(settings.lineup_paid),
    lines: lines.map((l) => ({ ...l, paid: exported.has(l.key) })),
    total_cents: g ? g.pay_cents : 0, tips_cents: g ? g.tips_cents : 0, minutes: g ? g.minutes : 0,
    season: { from: seasonStart, to: seasonEnd, total_cents: sg ? sg.pay_cents : 0, tips_cents: sg ? sg.tips_cents : 0, minutes: sg ? sg.minutes : 0 } });
});

// "Ask a question" about a pay line: an email to the school's managers with the line in it.
router.post('/pay/question', school, validate(z.object({ line: z.string().trim().min(1).max(300), message: z.string().trim().min(3).max(1000) })), async (req, res) => {
  const t = req.auth.tenantId;
  const me = req.auth.staffId ? await PR.staffContact(pool, t, req.auth.staffId) : null;
  const who = me ? `${me.first_name} ${me.last_name}` : 'An instructor';
  const managers = await rows(pool, "SELECT email FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner','manager') AND email IS NOT NULL LIMIT 10", [t]);
  const tn = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [t]);
  let sent = 0;
  for (const m of managers) {
    const r = await mailer.send({ tenantId: t, to: m.email, fromName: tn.name, replyTo: me && me.email ? me.email : undefined, tag: 'pay-question',
      subject: `Pay question from ${who}`, text: `${who} has a question about this pay line:\n\n${req.body.line}\n\n"${req.body.message}"\n\nOpen Ski school, Payroll to check it.` });
    if (r && r.ok) sent += 1;
  }
  await audit(pool, req, 'pay_question', 'staff', req.auth.staffId || 0, { line: req.body.line });
  res.json({ ok: true, sent });
});

// ================================================================ private requests (staff)
router.get('/pay/requests', school, async (req, res) => {
  const t = req.auth.tenantId;
  const all = req.query.scope === 'all' && (SA.atLeast(req, 'supervisor') || req.auth.role === 'counter');
  if (!all) {
    const staffId = whoseStaff(req, req.query.staff_id);
    const waiting = await requestsFor(pool, t, staffId);
    const recent = await rows(pool, "SELECT * FROM private_requests WHERE tenant_id = ? AND staff_id = ? AND status <> 'waiting' AND created_at > UTC_TIMESTAMP() - INTERVAL 30 DAY ORDER BY starts_at DESC LIMIT 30", [t, staffId]);
    return res.json({ waiting, recent: recent.map((r) => shapeRequest(r)) });
  }
  const status = req.query.status ? String(first(req.query.status)) : 'open';
  const where = status === 'open' ? "r.status IN ('waiting','offered')" : status === 'all' ? '1 = 1' : 'r.status = ?';
  const list = await rows(pool, `SELECT r.* FROM private_requests r WHERE r.tenant_id = ? AND ${where} AND r.status <> 'awaiting_payment' ORDER BY r.status = 'waiting' DESC, r.starts_at LIMIT 200`, status === 'open' || status === 'all' ? [t] : [t, status]);
  const names = new Map((await rows(pool, `SELECT s.id, ${NAME} AS name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ?`, [t])).map((s) => [s.id, s.name]));
  res.json({ requests: list.map((r) => shapeRequest(r, names)) });
});

router.post('/pay/requests/:id/accept', requireRole('instructor', 'manager'), async (req, res) => {
  if (!req.auth.staffId) throw bad('Your login is not linked to a staff record yet. Ask a manager to link it.');
  const r = await one(pool, 'SELECT id, staff_id, any_instructor, discipline, starts_at, students, declined_ids FROM private_requests WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r) throw notFound('Private request');
  if (!r.staff_id) {
    const prof = await one(pool, 'SELECT disciplines, ski_level_max, snowboard_level_max, teaches_kids, teaches_adaptive FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, req.auth.staffId]);
    if (!prof) throw conflict('Your teaching profile is not set up yet. Ask the ski school director to set what you teach.');
    if (!PR.teaches(prof, r.discipline, Math.max(...PR.parseStudents(r).map((s) => Number(s.level) || 1)), { kids: PR.kidsIn(r) })) throw conflict('You are not cleared for this lesson. Ask the ski school director.');
  }
  res.json(await PR.accept(req, r.id, req.auth.staffId));
});

router.post('/pay/requests/:id/decline', requireRole('instructor', 'manager'), validate(z.object({ reason: z.string().trim().max(300).optional() })), async (req, res) => {
  if (!req.auth.staffId) throw bad('Your login is not linked to a staff record yet. Ask a manager to link it.');
  res.json(await PR.decline(req.auth.tenantId, paramId(req), { staffId: req.auth.staffId, why: req.body.reason || 'the instructor declined', auditReq: req }));
});

// The desk or a manager gives the private to an instructor by hand (any open request).
router.post('/pay/requests/:id/assign', desk, validate(z.object({ staff_id: z.number().int().positive() })), async (req, res) => {
  res.json(await PR.accept(req, paramId(req), req.body.staff_id, { byHand: true }));
});

// A manager cancels an open request and refunds it in full.
router.post('/pay/requests/:id/refund', manager, async (req, res) => {
  const r = await one(pool, 'SELECT id FROM private_requests WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r) throw notFound('Private request');
  const out = await PR.refundByFamily(req.auth.tenantId, r.id);
  await audit(pool, req, 'private_staff_refund', 'private_requests', r.id, out);
  res.json(out);
});

// ================================================================ rebook my guests
/** The instructor's past private guests (and guests who asked for them), latest first. */
router.get('/pay/guests', requireRole('instructor', 'manager'), async (req, res) => {
  const t = req.auth.tenantId;
  const staffId = whoseStaff(req, req.query.staff_id);
  const today = todayIn(await tzOf(t));
  const list = await rows(pool, `SELECT p.id AS person_id, p.first_name, p.last_name, p.ski_level, p.snowboard_level, MAX(s.starts_at) AS last_at, COUNT(*) AS lessons,
      SUBSTRING_INDEX(GROUP_CONCAT(s.discipline ORDER BY s.starts_at DESC), ',', 1) AS discipline,
      MAX(COALESCE(b.contact_email, p.email) IS NOT NULL) AS reachable,
      (SELECT MIN(s2.starts_at) FROM lesson_bookings b2 JOIN lesson_sessions s2 ON s2.tenant_id = b2.tenant_id AND s2.id = b2.session_id
        WHERE b2.tenant_id = b.tenant_id AND b2.person_id = p.id AND b2.status = 'booked' AND s2.status = 'scheduled' AND s2.instructor_id = ? AND s2.starts_at >= ?) AS next_at
    FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND s.instructor_id = ? AND (s.format <> 'group' OR b.requested_instructor_id = s.instructor_id) AND b.status IN ('booked','attended') AND s.starts_at < ?
    GROUP BY p.id, p.first_name, p.last_name, p.ski_level, p.snowboard_level ORDER BY last_at DESC LIMIT 100`, [staffId, today, t, staffId, today]);
  res.json({ guests: list.map((g) => ({ ...g, reachable: Boolean(Number(g.reachable)), level_words: levels.name(g.discipline === 'snowboard' ? g.snowboard_level : g.ski_level, g.discipline) || null })) });
});

/** Who to write to about a guest: the contact on their latest booking, else their own email and phone. */
async function guestContact(t, personId, staffId) {
  return one(pool, `SELECT p.first_name, COALESCE(b.contact_email, p.email) AS email, COALESCE(b.contact_phone, p.phone) AS phone, b.contact_name, b.text_ok
    FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND b.person_id = ? AND s.instructor_id = ? AND b.status IN ('booked','attended') ORDER BY COALESCE(b.contact_email, p.email) IS NULL, s.starts_at DESC LIMIT 1`, [t, personId, staffId]);
}

router.post('/pay/guests/:id/offer', requireRole('instructor', 'manager'), validate(z.object({ staff_id: z.number().int().positive().optional(), message: z.string().trim().max(500).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const personId = paramId(req);
  const staffId = whoseStaff(req, req.body.staff_id);
  const c = await guestContact(t, personId, staffId);
  if (!c) throw notFound('Guest');
  if (!c.email && !(c.phone && c.text_ok)) throw conflict('We have no email for this guest. Ask the desk to add one.');
  const me = await PR.staffContact(pool, t, staffId);
  const tn = await one(pool, 'SELECT id, slug, name, phone FROM tenants WHERE id = ?', [t]);
  const link = `${baseUrl(req)}/private/${encodeURIComponent(tn.slug)}?i=${staffId}`;
  const out = await familynotify.notify({ tenant: tn, to: { email: c.email, phone: c.phone, textOk: Boolean(c.text_ok) }, tag: 'private-rebook',
    subject: `${me.first_name} would love to ski with ${c.first_name} again`,
    text: `Hi${c.contact_name ? ` ${String(c.contact_name).split(' ')[0]}` : ''},\n\n${req.body.message ? `${req.body.message}\n\n` : ''}${me.first_name} has open times for another private lesson with ${c.first_name}. Pick a time that suits you here:\n${link}\n\n${tn.name}${tn.phone ? `, ${tn.phone}` : ''}`,
    smsText: `${me.first_name} at ${tn.name} has times for another private with ${c.first_name}: ${link}` });
  await audit(pool, req, 'private_rebook_offer', 'people', personId, { staff_id: staffId });
  res.json({ ok: true, email: Boolean(out.email && out.email.ok), text: Boolean(out.text && out.text.ok) });
});

// A manager books a past guest straight into a new private with the instructor (origin 'rebook'; paid at the desk).
router.post('/pay/guests/:id/book', manager, validate(z.object({ staff_id: z.number().int().positive(), offer_id: z.number().int().positive(), starts_at: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/), sign_waiver: z.boolean().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const personId = paramId(req); const b = req.body;
  const startsAt = `${b.starts_at.slice(0, 10)} ${b.starts_at.slice(11, 16)}:00`;
  const out = await tx(async (conn) => {
    // The student's row is locked first (lib/lessonrules.js), so two bookings of one guest wait for each other.
    const person = await one(conn, 'SELECT id, first_name, ski_level, snowboard_level FROM people WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, personId]);
    if (!person) throw notFound('Guest');
    const offer = await one(conn, 'SELECT * FROM private_offers WHERE tenant_id = ? AND id = ?', [t, b.offer_id]);
    if (!offer) throw notFound('Private lesson length');
    const last = await one(conn, `SELECT b.*, s.discipline FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      WHERE b.tenant_id = ? AND b.person_id = ? AND s.instructor_id = ? ORDER BY (b.contact_email IS NULL AND b.allergies IS NULL AND b.medical IS NULL), s.starts_at DESC LIMIT 1`, [t, personId, b.staff_id]);
    const discipline = last ? last.discipline : 'ski';
    const lv = levels.personLevel(person, discipline);
    const endsAt = PR.plusMinutes(startsAt, offer.minutes);
    const problems = await staffProblems(conn, t, { staffId: b.staff_id, startsAt, endsAt });
    if (problems.length) throw conflict('That instructor cannot take this lesson', problems);
    const c = await studentClash(conn, t, personId, startsAt, endsAt, { lock: true });
    if (c) throw conflict(`${person.first_name}: ${clashWords(c)}`);
    const season = seasonFor(startsAt.slice(0, 10));
    let waiver = await one(conn, ON_FILE, [t, personId, season]);
    if (!waiver && b.sign_waiver) {
      await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, method, recorded_by) VALUES (?, ?, ?, 'general', 'recorded_by_staff', ?)", [t, personId, season, req.auth.userId]);
      waiver = { id: 1 };
    }
    if (!waiver) throw conflict(`${person.first_name} needs a signed waiver for this season before booking`, { needs_waiver: true });
    const [s] = await conn.query(`INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, format, age_group, meeting_place, starts_at, ends_at, capacity, instructor_id, level_min, level_max, origin)
      VALUES (?, ?, ?, ?, 'private', 'all', ?, ?, ?, 1, ?, ?, ?, 'rebook')`, [t, offer.product_id, discipline, levels.toLegacy(lv || 1) || 'beginner', offer.meeting_place, startsAt, endsAt, b.staff_id, lv || null, lv || null]);
    // The family's safety details and consents carry over from their last lesson with this instructor.
    const [bk] = await conn.query(`INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, unpaid, requested_instructor_id, allergies, medical, pickup, contact_name, contact_phone, contact_email, text_ok, photo_ok, level)
      VALUES (?, ?, ?, 'booked', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, s.insertId, personId, b.staff_id, last ? last.allergies : null, last ? last.medical : null, last ? last.pickup : null,
      last ? last.contact_name : null, last ? last.contact_phone : null, last ? last.contact_email : null, last ? last.text_ok : 0, last ? last.photo_ok : 0, lv || null]);
    await audit(conn, req, 'private_rebook', 'lesson_sessions', s.insertId, { person_id: personId, staff_id: b.staff_id });
    return { session_id: s.insertId, booking_id: bk.insertId };
  });
  try { await require('../lib/lessonconfirm').sendConfirmation(pool, t, out.booking_id, baseUrl(req)); } catch (_) { /* never stops the booking */ }
  res.status(201).json(out);
});

// ================================================================ payroll
async function runFor(conn, t, from, to, userId, create = false) {
  let run = await one(conn, 'SELECT * FROM payroll_runs WHERE tenant_id = ? AND period_from = ? AND period_to = ?', [t, from, to]);
  if (!run && create) {
    await conn.query('INSERT IGNORE INTO payroll_runs (tenant_id, period_from, period_to, created_by) VALUES (?, ?, ?, ?)', [t, from, to, userId]);
    run = await one(conn, 'SELECT * FROM payroll_runs WHERE tenant_id = ? AND period_from = ? AND period_to = ?', [t, from, to]);
  }
  return run;
}
function period(req, src) {
  const from = dateQ(src.from); const to = dateQ(src.to);
  if (to < from) throw bad('The last day is before the first');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 62) throw bad('A pay period is at most 62 days');
  return { from, to };
}

/** Every instructor's lines for the period, with what is approved and what an earlier export already paid. */
async function payroll(db, t, from, to) {
  const { lines: all, settings } = await P.lines(db, t, { from, to, tipsMode: 'unpaid' });
  // Only work that has happened is paid: a lesson that has not ended yet (or a time card for today) waits for a later
  // export of this period. Canceled lessons have no line.
  const nowLocal = nowIn((await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone);
  const lines = all.filter((l) => P.lineDone(l, nowLocal));
  const later = all.length - lines.length;
  const run = await runFor(db, t, from, to);
  const exported = await rows(db, 'SELECT staff_id, line_key, run_id FROM payroll_items WHERE tenant_id = ?', [t]);
  const done = new Map(exported.map((e) => [`${e.staff_id}|${e.line_key}`, e.run_id]));
  const approvals = run ? await rows(db, 'SELECT staff_id, cents, approved_at FROM payroll_approvals WHERE tenant_id = ? AND run_id = ?', [t, run.id]) : [];
  const names = new Map((await rows(db, `SELECT s.id, ${NAME} AS name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ?`, [t])).map((s) => [s.id, s.name]));
  const fresh = []; const already = [];
  for (const l of lines) {
    const runId = done.get(`${l.staff_id}|${l.key}`);
    if (runId && (!run || runId !== run.id)) already.push(l); else fresh.push({ ...l, exported: Boolean(runId) });
  }
  const people = P.byInstructor(fresh).map((g) => {
    const a = approvals.find((x) => x.staff_id === g.staff_id);
    return { ...g, name: names.get(g.staff_id) || `Staff ${g.staff_id}`, approved: Boolean(a), approved_cents: a ? a.cents : null, changed: Boolean(a && a.cents !== g.pay_cents + g.tips_cents) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { from, to, pay_mode: settings.pay_mode, run: run ? { id: run.id, status: run.status, exported_at: run.exported_at } : null, instructors: people, earlier: already.length, later };
}

router.get('/pay/payroll', manager, async (req, res) => {
  const { from, to } = period(req, req.query);
  res.json(await payroll(pool, req.auth.tenantId, from, to));
});

router.post('/pay/payroll/approve', manager, validate(z.object({ from: dateStr, to: dateStr, staff_ids: z.array(z.number().int().positive()).min(1).max(500), approved: z.boolean() })), async (req, res) => {
  const t = req.auth.tenantId; const { from, to } = period(req, req.body);
  const now = await payroll(pool, t, from, to);
  await tx(async (conn) => {
    const run = await runFor(conn, t, from, to, req.auth.userId, true);
    if (run.status === 'exported') throw conflict('This pay period is already exported');
    for (const sid of req.body.staff_ids) {
      if (!req.body.approved) { await conn.query('DELETE FROM payroll_approvals WHERE tenant_id = ? AND run_id = ? AND staff_id = ?', [t, run.id, sid]); continue; }
      const g = now.instructors.find((x) => x.staff_id === sid);
      if (!g) continue;
      await conn.query('INSERT INTO payroll_approvals (tenant_id, run_id, staff_id, cents, approved_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE cents = VALUES(cents), approved_by = VALUES(approved_by), approved_at = CURRENT_TIMESTAMP',
        [t, run.id, sid, g.pay_cents + g.tips_cents, req.auth.userId]);
    }
    await audit(conn, req, req.body.approved ? 'payroll_approve' : 'payroll_unapprove', 'payroll_runs', run.id, { staff_ids: req.body.staff_ids });
  });
  res.json(await payroll(pool, t, from, to));
});

const LINE_COLS = ['instructor', 'staff_id', 'kind', 'day', 'what', 'hours', 'amount', 'details'];
const SUM_COLS = ['instructor', 'staff_id', 'hours', 'lessons', 'lineup', 'hourly', 'program', 'request_bonus', 'pay_total', 'tips_pass_through'];
/** The two CSV files for one export: one row per instructor per kind of line, and a summary per instructor. */
function csvFiles(items) {
  const lineRows = []; const sums = new Map();
  const byKind = new Map();
  for (const it of items) {
    const k = `${it.staff_id}|${it.kind}`;
    if (!byKind.has(k)) byKind.set(k, { instructor: it.name, staff_id: it.staff_id, kind: it.kind, days: new Set(), count: 0, minutes: 0, cents: 0 });
    const g = byKind.get(k); g.days.add(it.work_day); g.count += 1; g.minutes += it.kind === 'tip' ? 0 : Number(it.minutes); g.cents += Number(it.cents);
    if (!sums.has(it.staff_id)) sums.set(it.staff_id, { instructor: it.name, staff_id: it.staff_id, minutes: 0, lessons: 0, lineup: 0, hourly: 0, program: 0, request_bonus: 0, pay: 0, tips: 0 });
    const s = sums.get(it.staff_id);
    if (it.kind === 'tip') { s.tips += Number(it.cents); continue; }
    s.pay += Number(it.cents);
    for (const p of it.parts || []) {
      if (p.label === 'request') s.request_bonus += p.cents;
      else if (p.label === 'lineup') s.lineup += p.cents;
      else if (/ h /.test(` ${p.label} `) || /clocked|lesson time|coaching/.test(p.label)) s.hourly += p.cents;
      else if (p.label === 'program meeting') s.program += p.cents;
      else s.lessons += p.cents;
    }
  }
  for (const it of items) { const s = sums.get(it.staff_id); if (it.kind !== 'tip') s.minutes += it.kind === 'clock' ? Number(it.minutes) : 0; }
  for (const g of byKind.values()) {
    lineRows.push({ instructor: g.instructor, staff_id: g.staff_id, kind: g.kind === 'tip' ? 'tips (pass-through)' : g.kind, day: [...g.days].sort().join(' '), what: `${g.count} line${g.count === 1 ? '' : 's'}`,
      hours: g.kind === 'tip' ? '' : (g.minutes / 60).toFixed(2), amount: dollars(g.cents), details: '' });
  }
  const sumRows = [...sums.values()].map((s) => {
    const mins = items.filter((i) => i.staff_id === s.staff_id && i.kind !== 'tip').reduce((n, i) => n + (i.kind === 'lineup' && items.some((x) => x.staff_id === s.staff_id && x.kind === 'clock' && x.work_day === i.work_day) ? 0 : Number(i.minutes)), 0);
    return { instructor: s.instructor, staff_id: s.staff_id, hours: (mins / 60).toFixed(2), lessons: dollars(s.lessons), lineup: dollars(s.lineup), hourly: dollars(s.hourly), program: dollars(s.program), request_bonus: dollars(s.request_bonus), pay_total: dollars(s.pay), tips_pass_through: dollars(s.tips) };
  });
  lineRows.sort((a, b) => a.instructor.localeCompare(b.instructor) || a.kind.localeCompare(b.kind));
  sumRows.sort((a, b) => a.instructor.localeCompare(b.instructor));
  return { lines_csv: toCsv(LINE_COLS, lineRows), summary_csv: toCsv(SUM_COLS, sumRows) };
}

// Export: every approved instructor's lines are written down as paid (so the next period cannot pay them again), their
// tips are marked paid out, and the two CSV files come back.
router.post('/pay/payroll/export', manager, validate(z.object({ from: dateStr, to: dateStr })), async (req, res) => {
  const t = req.auth.tenantId; const { from, to } = period(req, req.body);
  const now = await payroll(pool, t, from, to);
  const out = await tx(async (conn) => {
    const run = await runFor(conn, t, from, to, req.auth.userId, true);
    await conn.query('SELECT id FROM payroll_runs WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, run.id]);
    const ok = new Map((await rows(conn, 'SELECT staff_id, cents FROM payroll_approvals WHERE tenant_id = ? AND run_id = ?', [t, run.id])).map((a) => [a.staff_id, a.cents]));
    if (!ok.size) throw conflict('Approve at least one instructor first');
    const changed = now.instructors.filter((g) => ok.has(g.staff_id) && ok.get(g.staff_id) !== g.pay_cents + g.tips_cents);
    if (changed.length) throw conflict(`Pay changed after it was approved for ${changed.map((g) => g.name).join(', ')}. Check and approve again.`);
    let n = 0; const tips = [];
    for (const g of now.instructors) {
      if (!ok.has(g.staff_id)) continue;
      for (const l of g.lines) {
        const [r] = await conn.query('INSERT IGNORE INTO payroll_items (tenant_id, run_id, staff_id, line_key, kind, work_day, minutes, cents, words) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [t, run.id, g.staff_id, l.key, l.kind, l.day, l.minutes || 0, l.cents, String(`${l.title}${l.words ? `: ${l.words}` : ''}`).slice(0, 255)]);
        n += r.affectedRows;
        if (l.tip) tips.push(l.tip_id);
      }
    }
    if (tips.length) await conn.query("UPDATE lesson_tips SET paid_out_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id IN (?) AND status = 'paid' AND paid_out_at IS NULL", [t, tips]);
    // The period closes only when everyone is approved and no lesson in it is still to come.
    const all = now.instructors.every((g) => ok.has(g.staff_id)) && !now.later;
    await conn.query(`UPDATE payroll_runs SET exported_by = ?, exported_at = UTC_TIMESTAMP()${all ? ", status = 'exported'" : ''} WHERE tenant_id = ? AND id = ?`, [req.auth.userId, t, run.id]);
    await audit(conn, req, 'payroll_export', 'payroll_runs', run.id, { lines: n, tips: tips.length, instructors: ok.size });
    return { run_id: run.id, lines: n, tips: tips.length };
  });
  res.json({ ...out, ...(await runCsv(t, out.run_id)) });
});

async function runCsv(t, runId) {
  const items = await rows(pool, `SELECT i.*, ${NAME} AS name FROM payroll_items i JOIN staff s ON s.tenant_id = i.tenant_id AND s.id = i.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE i.tenant_id = ? AND i.run_id = ? ORDER BY name, i.work_day`, [t, runId]);
  // The parts of each line are worked out again from its words ("private 36.00 + request 6.00"), so the summary splits them.
  for (const it of items) {
    const words = String(it.words || '').split(': ').slice(1).join(': ');
    it.parts = words ? words.split(' + ').map((w) => { const m = w.match(/^(.*) (\d+\.\d{2})$/); return m ? { label: m[1], cents: Math.round(Number(m[2]) * 100) } : null; }).filter(Boolean) : [];
    if (it.kind === 'lineup') it.parts = [{ label: 'lineup', cents: Number(it.cents) }];
    if (it.kind === 'clock') it.parts = [{ label: 'clocked', cents: Number(it.cents) }];
  }
  return csvFiles(items);
}

router.get('/pay/payroll/runs', manager, async (req, res) => {
  res.json({ runs: await rows(pool, `SELECT r.id, r.period_from, r.period_to, r.status, r.exported_at, (SELECT COUNT(DISTINCT staff_id) FROM payroll_items i WHERE i.tenant_id = r.tenant_id AND i.run_id = r.id) AS instructors,
      (SELECT COALESCE(SUM(IF(kind = 'tip', 0, cents)), 0) FROM payroll_items i WHERE i.tenant_id = r.tenant_id AND i.run_id = r.id) AS pay_cents
    FROM payroll_runs r WHERE r.tenant_id = ? AND r.exported_at IS NOT NULL ORDER BY r.period_from DESC LIMIT 50`, [req.auth.tenantId]) });
});
router.get('/pay/payroll/runs/:id/:kind.csv', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const run = await one(pool, 'SELECT * FROM payroll_runs WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!run) throw notFound('Pay period');
  const files = await runCsv(t, id);
  const kind = req.params.kind === 'summary' ? 'summary' : 'lines';
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename="payroll-${run.period_from}-to-${run.period_to}-${kind}.csv"`);
  res.send(kind === 'summary' ? files.summary_csv : files.lines_csv);
});

// ================================================================ level placement questions (2026.11.9, Track GUEST)
// The three questions per discipline guests answer when they book (lib/placement.js). Everyone who sells or runs lessons
// reads them (Sell's "Ask 3 questions"); the director changes the wording and where each answer leads, or goes back to
// the built-in ones with { questions: null }.
const PL = require('../lib/placement');
const { school: schoolLevel } = require('../lib/schoolaccess');
router.get('/placement', requireRole('instructor', 'manager', 'counter'), async (req, res) => {
  const s = await S.get(pool, req.auth.tenantId);
  res.json({ questions: PL.questionsFrom(s), built_in: PL.BUILT_IN, custom: Boolean(s.placement_questions), levels: { ski: levels.list('ski'), snowboard: levels.list('snowboard') } });
});
router.put('/placement', schoolLevel('director'), validate(PL.schema), async (req, res) => {
  await tx(async (conn) => {
    await S.save(conn, req.auth.tenantId, { placement_questions: req.body.questions ? JSON.stringify(req.body.questions) : null });
    await audit(conn, req, 'update', 'school_settings', req.auth.tenantId, { placement_questions: req.body.questions ? 'custom' : 'built-in' });
  });
  const s = await S.get(pool, req.auth.tenantId);
  res.json({ questions: PL.questionsFrom(s), custom: Boolean(s.placement_questions) });
});

// ================================================================ the public page: /private/<mountain>
const publicLimit = rateLimit({ windowMs: 3_600_000, max: Number(process.env.BOOKING_RATE_LIMIT) || 8, message: 'Too many requests from this address. Please call the ski school.' });
const lookLimit = rateLimit({ windowMs: 60_000, max: 60, message: 'Too many requests. Please wait a minute.' });

async function tenantFor(slug, { forWrite = false } = {}) {
  const t = await one(pool, 'SELECT id, slug, name, phone, timezone, waiver_text, booking_notice_hours, online_payment, refund_full_hours, refund_half_hours, refund_half_percent, cancel_note, stripe_account, stripe_charges_enabled FROM tenants WHERE slug = ?', [String(slug)]);
  if (!t) throw notFound('Page');
  const st = await modules.stateOf(t.id);
  if (st.status !== 'active' || !st.on.has('school')) throw notFound('Page');
  if (forWrite && await require('../lib/billing').publicBlocked(t.id, 'POST')) throw new AppError(409, 'This mountain is not taking online bookings right now. Please contact them directly.');
  t.pay_online = Boolean(t.online_payment) && connect.readyRow(t) && !(await isSandbox(t.id));
  delete t.stripe_account; delete t.stripe_charges_enabled;
  return t;
}
const offersOf = (t) => rows(pool, 'SELECT o.id, o.product_id, o.minutes, o.max_students, o.extra_student_cents, o.meeting_place, pr.base_price_cents, pr.name AS product FROM private_offers o JOIN products pr ON pr.tenant_id = o.tenant_id AND pr.id = o.product_id AND pr.active = 1 WHERE o.tenant_id = ? AND o.active = 1 ORDER BY o.minutes', [t.id]);
const earliestFor = (t) => PR.plusMinutes(nowIn(t.timezone), (t.booking_notice_hours || 12) * 60);
const publicIns = (i) => ({ id: i.id, name: PR.shortName(i), bio: i.bio || null, disciplines: String(i.disciplines || '').split(',').filter(Boolean), kids: i.teaches_kids !== 0, ski_level_max: i.ski_level_max || null, snowboard_level_max: i.snowboard_level_max || null });

publicRouter.get('/:slug/private', lookLimit, async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const offers = await offersOf(t);
  if (!offers.length) throw new AppError(404, 'Private lessons are not offered online here. Please call the ski school.');
  const s = await S.get(pool, t.id);
  const today = todayIn(t.timezone);
  res.set('Cache-Control', 'no-store');
  res.json({ mountain: t.name, phone: t.phone, today, earliest: earliestFor(t), last_day: addDays(today, 60), pay_online: t.pay_online, waiver_text: t.waiver_text,
    policy: policyText(t), policy_tiers: policyTiers(t), accept_minutes: s.private_accept_minutes, decline: s.private_decline, texts: await familynotify.textsOn(t.id), photos: Boolean(s.recap_photos),
    offers: offers.map((o) => ({ id: o.id, minutes: o.minutes, max_students: o.max_students, price_cents: o.base_price_cents, extra_student_cents: o.extra_student_cents, meeting_place: o.meeting_place })),
    instructors: (await PR.publicInstructors(pool, t.id)).map(publicIns),
    levels: { ski: levels.list('ski'), snowboard: levels.list('snowboard') } });
});

/** Open start times on a day for one instructor, or for anyone ("any"): [{ time, instructors: [ids] }]. */
publicRouter.get('/:slug/private/times', lookLimit, async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const date = dateQ(req.query.date);
  const offer = await one(pool, 'SELECT * FROM private_offers WHERE tenant_id = ? AND id = ? AND active = 1', [t.id, Number(first(req.query.offer_id)) || 0]);
  if (!offer) throw notFound('Lesson length');
  const discipline = DISCIPLINES.includes(String(first(req.query.discipline))) ? String(first(req.query.discipline)) : 'ski';
  const level = Math.min(Math.max(Number(first(req.query.level)) || 1, 1), 9);
  const kids = String(first(req.query.kids || '')) === '1';
  const today = todayIn(t.timezone);
  if (date < today || date > addDays(today, 60)) return res.json({ date, times: [] });
  const wanted = req.query.instructor && req.query.instructor !== 'any' ? Number(first(req.query.instructor)) : null;
  const list = wanted ? [await PR.publicInstructor(pool, t.id, wanted)].filter(Boolean) : await PR.publicInstructors(pool, t.id);
  const by = new Map();
  for (const ins of list) {
    if (!PR.teaches(ins, discipline, level, { kids })) continue;
    for (const tm of await PR.freeTimes(pool, t.id, ins.id, date, offer.minutes, earliestFor(t))) {
      if (!by.has(tm)) by.set(tm, []);
      by.get(tm).push(ins.id);
    }
  }
  // 2026.11.9 (Track GUEST): the day's private hours from the season plan: only inside them, only the lengths offered,
  // nothing on a closed day, and no more privates at once than the plan allows.
  const hours = await PR.dayHours(pool, t.id, date);
  const allowed = new Set(await PR.allowedTimes(pool, t.id, date, offer.minutes, [...by.keys()], hours));
  // The days in the next two weeks this instructor (or anyone) has open, so the page can point at them.
  const open = await rows(pool, `SELECT DISTINCT o.open_date FROM instructor_open o JOIN instructor_profiles ip ON ip.tenant_id = o.tenant_id AND ip.staff_id = o.staff_id AND ip.is_public = 1
    WHERE o.tenant_id = ? AND o.open_date BETWEEN ? AND ?${wanted ? ' AND o.staff_id = ?' : ''} ORDER BY o.open_date`, wanted ? [t.id, today, addDays(today, 60), wanted] : [t.id, today, addDays(today, 60)]);
  const shut = await rows(pool, 'SELECT on_date, lengths, closed FROM lesson_private_hours WHERE tenant_id = ? AND on_date BETWEEN ? AND ?', [t.id, today, addDays(today, 60)]);
  const noLength = new Set(shut.filter((h) => Number(h.closed) || (String(h.lengths || '') && !String(h.lengths).split(',').map(Number).includes(offer.minutes))).map((h) => String(h.on_date).slice(0, 10)));
  res.set('Cache-Control', 'no-store');
  res.json({ date, times: [...by].filter(([time]) => allowed.has(time)).sort().map(([time, ins]) => ({ time, instructors: ins })),
    open_days: open.map((o) => String(o.open_date).slice(0, 10)).filter((d) => !noLength.has(d)),
    hours: hours ? { start: hours.start, end: hours.end, lengths: hours.lengths, closed: hours.closed } : null, note: PR.lengthProblem(hours, offer.minutes) });
});

const studentSchema = z.object({
  first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), date_of_birth: dateStr,
  sex: z.enum(['female', 'male', 'other']), level: z.number().int().min(1).max(9),
  allergies: z.string().trim().max(300).optional(), medical: z.string().trim().max(500).optional(), photo_ok: z.boolean().optional(),
});
const requestSchema = z.object({
  offer_id: z.number().int().positive(), discipline: z.enum(DISCIPLINES), date: dateStr, time: z.string().regex(/^\d{2}:\d{2}$/),
  instructor: z.union([z.number().int().positive(), z.literal('any')]),
  contact_first_name: z.string().trim().min(1).max(100), contact_last_name: z.string().trim().min(1).max(100),
  contact_email: z.string().trim().email().max(255), contact_phone: z.string().trim().min(7).max(40), text_ok: z.boolean().optional(),
  students: z.array(studentSchema).min(1).max(6), waiver_accepted: z.boolean(), policy_accepted: z.boolean().optional(),
  note: z.string().trim().max(500).optional(), website: z.string().max(200).optional(),
});

publicRouter.post('/:slug/private', publicLimit, validate(requestSchema), async (req, res) => {
  const t = await tenantFor(req.params.slug, { forWrite: true });
  const b = req.body;
  res.set('Cache-Control', 'no-store');
  if (b.website) return res.status(202).json({ ok: true }); // a form-filling bot: pretend, make nothing
  if (!b.waiver_accepted) throw bad('Please read and accept the waiver to ask for a lesson');
  if (t.pay_online && !b.policy_accepted) throw bad('Please read and accept the cancellation policy');
  const offer = await one(pool, 'SELECT * FROM private_offers WHERE tenant_id = ? AND id = ? AND active = 1', [t.id, b.offer_id]);
  if (!offer) throw notFound('Lesson length');
  if (b.students.length > offer.max_students) throw bad(`This lesson takes up to ${offer.max_students} student${offer.max_students === 1 ? '' : 's'}`);
  const startsAt = `${b.date} ${b.time}:00`;
  if (startsAt < earliestFor(t)) throw conflict(`Online requests close ${t.booking_notice_hours} hours before the lesson. Please call the ski school.`);
  const levelMax = Math.max(...b.students.map((s) => s.level));
  const kids = b.students.some((s) => require('../lib/family').isMinor(s.date_of_birth, b.date) && Number(b.date.slice(0, 4)) - Number(s.date_of_birth.slice(0, 4)) <= 12);
  const s = await S.get(pool, t.id);
  const textsOn = await familynotify.textsOn(t.id);
  const token = PR.newToken();
  const out = await tx(async (conn) => {
    // The day's private hours first (its row locked, so two families cannot take the last private at once).
    await PR.checkHours(conn, t.id, b.date, b.time, offer.minutes);
    // The time must still be open: for a named instructor, them; for "any", at least one instructor who teaches it.
    let staffId = null;
    if (b.instructor !== 'any') {
      const ins = await PR.publicInstructor(conn, t.id, b.instructor);
      if (!ins || !PR.teaches(ins, b.discipline, levelMax, { kids })) throw bad('That instructor does not teach this lesson. Please pick another.');
      await conn.query('SELECT id FROM staff WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, ins.id]); // one request at a time for this instructor
      if (!(await PR.freeTimes(conn, t.id, ins.id, b.date, offer.minutes, null)).includes(b.time)) throw conflict('That time was just taken. Please pick another.');
      staffId = ins.id;
    } else if (!(await PR.freeInstructors(conn, t.id, { discipline: b.discipline, levelMax, kids, startsAt, minutes: offer.minutes })).length) throw conflict('Nobody is free then. Please pick another time.');
    const quote = await PR.quote(conn, t.id, offer, b.students, b.date);
    if (t.pay_online && quote.total <= 0) throw bad('This lesson has no price set. Please call the ski school.');
    const sha = t.waiver_text ? crypto.createHash('sha256').update(t.waiver_text).digest('hex') : null;
    const students = JSON.stringify({ contact: { first_name: b.contact_first_name, last_name: b.contact_last_name },
      students: b.students.map((x) => ({ ...x, photo_ok: Boolean(x.photo_ok && s.recap_photos) })) });
    for (let attempt = 0; ; attempt += 1) {
      const ref = PR.reference();
      try {
        const [r] = await conn.query(`INSERT INTO private_requests (tenant_id, reference, token_sha, status, source, staff_id, any_instructor, offer_id, product_id, discipline, starts_at, minutes, students,
            contact_name, contact_email, contact_phone, text_ok, note, waiver_accepted, waiver_text_sha, amount_cents, quote_json, pay_at_desk, deadline_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [t.id, ref, PR.sha(token), t.pay_online ? 'awaiting_payment' : 'waiting', req.query.i ? 'rebook' : 'public', staffId, staffId ? 0 : 1, offer.id, offer.product_id, b.discipline, startsAt, offer.minutes, students,
          `${b.contact_first_name} ${b.contact_last_name}`, b.contact_email, b.contact_phone, b.text_ok && textsOn ? 1 : 0, b.note ?? null, sha, quote.total, JSON.stringify(quote), t.pay_online ? 0 : 1,
          t.pay_online ? null : PR.utcIn(s.private_accept_minutes)]);
        return { id: r.insertId, ref, quote };
      } catch (err) { if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue; throw err; }
    }
  });
  const pageUrl = PR.familyLink(baseUrl(req), t.slug, token);
  if (!t.pay_online) {
    const after = await PR.afterWaiting(t.id, out.id); // with "confirm automatically" on, it may be booked already
    return res.status(201).json({ ok: true, reference: out.ref, token, status: after && after.auto ? 'accepted' : 'waiting', amount_cents: out.quote.total, page: pageUrl });
  }
  let co;
  try {
    const pay = connect.checkoutFor(await connect.payeeOrThrow(t.id), out.quote.total, { tenant_id: String(t.id), private_id: String(out.id), reference: out.ref, kind: 'private' });
    co = await stripe.createCheckout({ amountCents: out.quote.total, name: `${PR.lengthWords(offer.minutes)} private lesson`, description: `${t.name}: ${PR.dayWords(startsAt)} at ${PR.clock(startsAt)}`,
      email: b.contact_email, reference: out.ref, ...pay, idempotencyKey: `private-${out.id}`, successUrl: `${pageUrl}&paid=1`, cancelUrl: `${pageUrl}&cancelled=1` });
  } catch (err) {
    await pool.query("UPDATE private_requests SET status = 'expired' WHERE tenant_id = ? AND id = ?", [t.id, out.id]);
    throw err;
  }
  await pool.query('UPDATE private_requests SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [co.id, t.id, out.id]);
  res.status(201).json({ ok: true, reference: out.ref, token, status: 'awaiting_payment', checkout_url: co.url, amount_cents: out.quote.total });
});

/** The family's view of their request (by its private link). */
async function familyView(t, r) {
  const st = PR.parseStudents(r);
  const ins = r.staff_id ? await PR.publicInstructor(pool, t.id, r.staff_id) || await one(pool, 'SELECT p.first_name, p.last_name, NULL AS display_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?', [t.id, r.staff_id]) : null;
  const others = r.status === 'offered' ? await PR.freeInstructors(pool, t.id, { discipline: r.discipline, levelMax: Math.max(...st.map((x) => Number(x.level) || 1)), kids: PR.kidsIn(r), startsAt: r.starts_at, minutes: r.minutes, exclude: PR.ids(r.declined_ids) }) : [];
  return { mountain: t.name, phone: t.phone, timezone: t.timezone, reference: r.reference, status: r.status, starts_at: r.starts_at, minutes: r.minutes, discipline: r.discipline,
    instructor: ins ? PR.shortName(ins) : null, any_instructor: !r.staff_id, students: st.map((s) => ({ first_name: s.first_name, level: s.level })),
    amount_cents: r.amount_cents, refund_cents: r.refund_cents, pay_at_desk: Boolean(r.pay_at_desk), deadline_at: r.deadline_at ? `${String(r.deadline_at).replace(' ', 'T')}Z` : null,
    choices: others.map(publicIns), booked_reference: r.status === 'accepted' ? r.reference : null };
}
publicRouter.get('/:slug/private/r/:token', lookLimit, async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const r = await PR.byToken(pool, t.id, req.params.token);
  if (!r) throw notFound('Request');
  res.set('Cache-Control', 'no-store');
  res.json(await familyView(t, r));
});
// Back from Stripe: ask Stripe whether the page was paid, in case the webhook has not arrived yet.
publicRouter.post('/:slug/private/r/:token/check', lookLimit, async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const r = await PR.byToken(pool, t.id, req.params.token);
  if (!r) throw notFound('Request');
  if (r.status === 'awaiting_payment' && r.stripe_session_id) {
    const acct = (await one(pool, 'SELECT stripe_account FROM tenants WHERE id = ?', [t.id])).stripe_account || null;
    let s = null;
    try { s = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(r.stripe_session_id)}`, { account: acct }); } catch (_) { s = null; }
    if (s && s.status === 'complete' && s.payment_status === 'paid' && s.payment_intent) await PR.markPaid(t.id, r.id, { ...s, id: r.stripe_session_id }, acct);
  }
  res.set('Cache-Control', 'no-store');
  res.json(await familyView(t, await one(pool, 'SELECT * FROM private_requests WHERE id = ?', [r.id])));
});
publicRouter.post('/:slug/private/r/:token/pick', publicLimit, validate(z.object({ instructor: z.number().int().positive() })), async (req, res) => {
  const t = await tenantFor(req.params.slug, { forWrite: true });
  const r = await PR.byToken(pool, t.id, req.params.token);
  if (!r) throw notFound('Request');
  await PR.pick(t.id, r.id, req.body.instructor);
  res.json(await familyView(t, await one(pool, 'SELECT * FROM private_requests WHERE id = ?', [r.id])));
});
publicRouter.post('/:slug/private/r/:token/refund', publicLimit, async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const r = await PR.byToken(pool, t.id, req.params.token);
  if (!r) throw notFound('Request');
  const out = await PR.refundByFamily(t.id, r.id);
  res.json({ ...out, ...(await familyView(t, await one(pool, 'SELECT * FROM private_requests WHERE id = ?', [r.id]))) });
});

/** Stripe told us a private's card page finished or lapsed (routed here from lessonbook's webhook by metadata.kind). */
async function handleWebhook(event, obj) {
  const tenantId = Number(obj.metadata.tenant_id); const id = Number(obj.metadata.private_id);
  if (!tenantId || !id) return { ignored: true };
  if (event.type === 'checkout.session.expired') {
    await pool.query("UPDATE private_requests SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND (stripe_session_id = ? OR stripe_session_id IS NULL)", [tenantId, id, obj.id]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  return PR.markPaid(tenantId, id, obj, connect.paidTo(event).account);
}

async function tick() { return PR.tick(); }
async function daily() { return {}; }

module.exports = { router, publicRouter, tick, daily, handleWebhook };
