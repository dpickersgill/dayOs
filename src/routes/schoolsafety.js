'use strict';

// Ski school safety (feat/school-safety). router is mounted at /skischool (staff), publicRouter under /public (the
// family's lesson link). tick() and daily() run with the lessons job (lib/schooltick.js).
//
// Who sees what:
//   - pickup lists, adaptive notes and released-to: the lesson's own instructor, the desk (counter) and managers
//     (owners, managers, school supervisors and directors). Never another instructor, never in anyone else's email.
//   - where each group was last seen: the desk and managers only, for today. No family sees a location.
//
// Staff:
//   GET  /skischool/safety/board?date=          per lesson: class size by age band, over ratio, last place; who waits for pickup; lost child reports
//   GET  /skischool/pickup?date=                the day's children who must be released at pickup, by class (the desk's Pickup view)
//   GET  /skischool/bookings/:id/pickup         the pickup list for one booking (audited)
//   PUT  /skischool/bookings/:id/pickup         { pickup_adults, pickup_photo_consent }: the desk changes it
//   GET  /skischool/pickup-adults/:id/photo     an adult's photo
//   POST /skischool/bookings/:id/release        { adult_id | other_name, id_seen, override_reason? }; DELETE undoes it (managers, with a reason)
//   PATCH /skischool/bookings/:id/colors        { jacket_color, helmet_color }
//   POST /skischool/bookings/:id/lost           { jacket_color?, helmet_color?, last_seen? }: opens a patrol dispatch call "Lost child"
//   GET  /skischool/lost?date=                  the school's lost child reports with the call's status
//   GET  /skischool/lost/:id                    one report with the child's photo (also for patrol on the dispatch board)
//   POST /skischool/lost/:id/found              { found_by, found_where, found_at? }
//   GET  /skischool/bookings/:id/adaptive       the adaptive intake; PUT changes it
//   GET  /skischool/sessions/:id/updates        the live updates posted to a lesson; POST { body?, photo? } posts one
//   POST /skischool/sessions/:id/at             { place }: "We're at" a spot the school named
// Public (the family's lesson link):
//   PUT  /public/:slug/lesson/:token/pickup     the family changes who may pick up (with photos and their consent)
//   PATCH /public/:slug/lesson/:token/safety    { updates_off?, jacket_color?, helmet_color? }
//   GET  /public/:slug/lesson/:token/updates/:id/photo   a live update's photo, only for a family that allowed photos
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const SA = require('../lib/schoolaccess');
const { z, validate, paramId, dateStr, todayIn, nowIn } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const S = require('../lib/schoolsettings');
const SS = require('../lib/schoolsafety');
const L = require('../lib/levels');
const familynotify = require('../lib/familynotify');
const modules = require('../lib/modules');

const router = express.Router();
const publicRouter = express.Router();
const isDesk = (req) => req.auth.role === 'counter' || SA.atLeast(req, 'supervisor');
const desk = SA.school('supervisor', 'counter');
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const MAX_UPDATES = 12; // live updates per lesson
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const KEEP_UPDATE_DAYS = 90;

/** 'YYYY-MM-DD HH:MM:SS' in the mountain's zone for a UTC time string. */
function localOf(utc, tz) {
  if (!utc) return null;
  const d = new Date(`${String(utc).slice(0, 19).replace(' ', 'T')}Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const plus = (dt, minutes) => new Date(Date.parse(`${String(dt).slice(0, 19).replace(' ', 'T')}Z`) + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
const clock = (dt) => { const [hh, mm] = String(dt).slice(11, 16).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };

/** A booking with its lesson, for the access checks. */
async function bookingRow(db, tenantId, id, lock = false) {
  const b = await one(db, `SELECT b.*, s.instructor_id, s.starts_at, s.ends_at, s.age_min, s.age_max, s.age_group, s.discipline, s.meeting_place, s.status AS session_status, s.format, s.product_id,
      p.first_name, p.last_name, p.date_of_birth, p.email AS person_email, p.phone AS person_phone, pr.name AS product
    FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE b.tenant_id = ? AND b.id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!b) throw notFound('Booking');
  return b;
}
/** The lesson's own instructor, the desk and managers. Everyone else is refused. */
function mayActOn(req, b, what = 'this') {
  if (isDesk(req)) return;
  if (req.auth.role === 'instructor' && req.auth.staffId && Number(b.instructor_id) === Number(req.auth.staffId)) return;
  throw forbidden(`Only the lesson's instructor, the desk and managers can see ${what}`);
}
const staffOnly = requireRole('instructor', 'manager', 'counter');

// ---------------------------------------------------------------- the family's chosen channel
/** The family's email and phone for a booking: the booking's contact, then the guardian, then the student. */
async function familyContact(db, tenantId, b) {
  const g = await one(db, `SELECT g.email, g.phone FROM person_links l JOIN people g ON g.tenant_id = l.tenant_id AND g.id = l.adult_id
    WHERE l.tenant_id = ? AND l.member_id = ? AND l.relation = 'guardian' ORDER BY g.id LIMIT 1`, [tenantId, b.person_id]);
  return { email: b.contact_email || (g && g.email) || b.person_email || null, phone: b.contact_phone || (g && g.phone) || b.person_phone || null, textOk: Boolean(b.text_ok) };
}
async function tellFamily(tenantId, b, { subject, text, smsText, tag }) {
  try {
    const tenant = await one(pool, 'SELECT id, name FROM tenants WHERE id = ?', [tenantId]);
    return await familynotify.notify({ tenant, to: await familyContact(pool, tenantId, b), subject, text: `Hello,\n\n${text}\n\n${tenant.name}`, smsText: `${tenant.name}: ${smsText || text}`.slice(0, 300), tag });
  } catch (err) { return { error: err.message }; }
}

// ---------------------------------------------------------------- the board: ratios, places, pickup, lost children
/**
 * Everything the board adds for a day: per lesson the class size by age band and whether it is over (with the reason),
 * the staff an adaptive lesson needs, and the last place the group was seen (a lift gate scan of a student's ticket or
 * lesson code, or the instructor's "We're at"); the children still waiting for pickup; the lost child reports.
 */
async function dayBoard(tenantId, date) {
  const tz = await tzOf(tenantId);
  const now = nowIn(tz);
  const settings = await S.get(pool, tenantId);
  const sessions = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.format, s.kind, s.age_min, s.age_max, s.age_group, s.capacity, s.instructor_id, s.meeting_place, s.lineup_id, l.ratio AS lineup_ratio, pr.name AS product,
      ip.first_name AS instructor_first
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id LEFT JOIN lesson_lineups l ON l.tenant_id = s.tenant_id AND l.id = s.lineup_id
    LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id
    WHERE s.tenant_id = ? AND DATE(s.starts_at) = ? AND s.status <> 'cancelled' ORDER BY s.starts_at, s.id`, [tenantId, date]);
  const ids = sessions.map((s) => s.id);
  const students = ids.length ? await rows(pool, `SELECT b.id AS booking_id, b.session_id, b.person_id, b.status, b.released_at, b.released_to, b.checked_in_at, p.first_name, p.last_name, p.date_of_birth,
      (SELECT COUNT(*) FROM lesson_pickup_adults a WHERE a.tenant_id = b.tenant_id AND a.booking_id = b.id) AS adults,
      COALESCE((SELECT extra_staff FROM lesson_adaptive_intake ai WHERE ai.tenant_id = b.tenant_id AND ai.booking_id = b.id), 0) AS extra_staff
    FROM lesson_bookings b JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND b.session_id IN (?) AND b.status IN ('booked','attended','no_show') ORDER BY p.first_name, p.last_name`, [tenantId, ids]) : [];
  // the places: instructor taps today, and lift gate scans of the students' tickets or lesson codes today
  const taps = ids.length ? await rows(pool, 'SELECT session_id, place, at FROM school_group_places WHERE tenant_id = ? AND on_date = ? AND session_id IN (?) ORDER BY at', [tenantId, date, ids]) : [];
  const personIds = [...new Set(students.map((x) => x.person_id))];
  const codes = students.map((x) => `L${x.booking_id}`);
  const scans = personIds.length ? await rows(pool, `SELECT sc.location, sc.scanned_at, sc.code, k.person_id FROM scans sc LEFT JOIN tickets k ON k.tenant_id = sc.tenant_id AND k.id = sc.ticket_id
    WHERE sc.tenant_id = ? AND sc.location IS NOT NULL AND sc.location <> '' AND sc.scanned_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY)
      AND ((sc.result = 'ok' AND k.person_id IN (?)) OR sc.code IN (?)) ORDER BY sc.scanned_at`, [tenantId, personIds, codes]) : [];
  const out = {};
  const waiting = [];
  for (const s of sessions) {
    const day = String(s.starts_at).slice(0, 10);
    const mine = students.filter((x) => x.session_id === s.id);
    const live = mine.filter((x) => x.status !== 'no_show');
    const ages = live.map((x) => SS.ageOn(x.date_of_birth, day));
    const lim = s.lineup_ratio ? { size: Number(s.lineup_ratio), label: 'This lineup' } : SS.ratioApplies(s) || s.discipline === 'adaptive' ? SS.classLimit(s, ages, settings) : null;
    const extra = live.reduce((n, x) => n + Number(x.extra_staff || 0), 0);
    const staffNeeded = s.discipline === 'adaptive' ? SS.adaptiveStaff(live.length, extra, settings) : (live.length ? 1 : 0);
    let reason = null;
    if (lim && live.length > lim.size) reason = lim.adaptive ? `${live.length} students: adaptive lessons take ${lim.size} per instructor` : `${live.length} students: ${lim.label} classes take ${lim.size}`;
    else if (s.discipline === 'adaptive' && staffNeeded > 1) reason = `Needs ${staffNeeded} staff (adaptive ratio and extra staff), 1 instructor assigned`;
    // the last place: the latest of the taps and the scans in the lesson's time (from 30 minutes before the start)
    let place = null;
    for (const t of taps.filter((x) => x.session_id === s.id)) if (!place || t.at >= place.at) place = { place: t.place, at: t.at, source: 'instructor' };
    const from = plus(s.starts_at, -30);
    const mineIds = new Set(mine.map((x) => x.person_id));
    const mineCodes = new Set(mine.map((x) => `L${x.booking_id}`));
    for (const sc of scans) {
      if (!(mineIds.has(sc.person_id) || mineCodes.has(String(sc.code)))) continue;
      const at = localOf(sc.scanned_at, tz);
      if (at < from || at > s.ends_at || at.slice(0, 10) !== day) continue;
      if (!place || at >= place.at) place = { place: sc.location, at, source: 'gate' };
    }
    // pickup: children who must be released, after the lesson ends; late once their window has passed
    for (const x of live) {
      const age = SS.ageOn(x.date_of_birth, day);
      if (!SS.needsRelease(age, s) || x.released_at) continue;
      const due = plus(s.ends_at, SS.pickupMinutes(age, settings));
      if (now < s.ends_at) continue;
      waiting.push({ booking_id: x.booking_id, session_id: s.id, first_name: x.first_name, last_name: x.last_name, age, ends_at: s.ends_at, due_at: due, late: now > due, product: s.product, instructor_first: s.instructor_first || null, adults: Number(x.adults) });
    }
    out[s.id] = { limit: lim ? lim.size : null, limit_label: lim ? lim.label : null, count: live.length, over_ratio: Boolean(reason), ratio_reason: reason, staff_needed: staffNeeded, place,
      waiting: waiting.filter((w) => w.session_id === s.id).length };
  }
  const lost = await lostList(tenantId, date);
  return { date, now, sessions: out, waiting, lost, places: settings.group_places };
}

router.get('/safety/board', desk, async (req, res) => {
  const tz = await tzOf(req.auth.tenantId);
  const date = String(req.query.date || todayIn(tz));
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  res.set('Cache-Control', 'no-store');
  res.json(await dayBoard(req.auth.tenantId, date));
});

// ---------------------------------------------------------------- pickup
/** The day's children who must be released at pickup, by lesson, with their status (the desk's Pickup view). */
router.get('/pickup', desk, async (req, res) => {
  const { tenantId } = req.auth;
  const tz = await tzOf(tenantId);
  const date = String(req.query.date || todayIn(tz));
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  const now = nowIn(tz);
  const settings = await S.get(pool, tenantId);
  const list = await rows(pool, `SELECT b.id AS booking_id, b.session_id, b.status, b.released_at, b.released_to, b.checked_in_at, b.jacket_color, b.helmet_color, p.first_name, p.last_name, p.date_of_birth,
      s.starts_at, s.ends_at, s.age_min, s.age_max, s.age_group, s.meeting_place, pr.name AS product, ip.first_name AS instructor_first,
      (SELECT COUNT(*) FROM lesson_pickup_adults a WHERE a.tenant_id = b.tenant_id AND a.booking_id = b.id) AS adults
    FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id
    WHERE b.tenant_id = ? AND DATE(s.starts_at) = ? AND s.status <> 'cancelled' AND b.status IN ('booked','attended') ORDER BY s.starts_at, s.id, p.first_name`, [tenantId, date]);
  const data = [];
  for (const x of list) {
    const age = SS.ageOn(x.date_of_birth, date);
    if (!SS.needsRelease(age, x)) continue;
    const due = plus(x.ends_at, SS.pickupMinutes(age, settings));
    data.push({ booking_id: x.booking_id, session_id: x.session_id, first_name: x.first_name, last_name: x.last_name, age, product: x.product, starts_at: x.starts_at, ends_at: x.ends_at, meeting_place: x.meeting_place,
      instructor_first: x.instructor_first, adults: Number(x.adults), checked_in: Boolean(x.checked_in_at), released_at: x.released_at ? localOf(x.released_at, tz) : null, released_to: x.released_to,
      due_at: due, state: x.released_at ? 'released' : now < x.ends_at ? 'in_lesson' : now > due ? 'late' : 'waiting' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ date, now, data });
});

router.get('/bookings/:id/pickup', staffOnly, async (req, res) => {
  const { tenantId } = req.auth;
  const b = await bookingRow(pool, tenantId, paramId(req));
  mayActOn(req, b, 'the pickup list');
  const tz = await tzOf(tenantId);
  const adults = await SS.pickupFor(pool, tenantId, b.id);
  await audit(pool, req, 'pickup_view', 'lesson_bookings', b.id, { adults: adults.length });
  const age = SS.ageOn(b.date_of_birth, String(b.starts_at).slice(0, 10));
  res.set('Cache-Control', 'no-store');
  res.json({ booking_id: b.id, first_name: b.first_name, last_name: b.last_name, age, needs_release: SS.needsRelease(age, b), adults, may_override: SS.mayOverride(req),
    released: b.released_at ? { at: localOf(b.released_at, tz), to: b.released_to, adult_id: b.released_adult_id, id_seen: Boolean(b.released_id_seen), reason: b.release_reason } : null });
});

router.put('/bookings/:id/pickup', desk, validate(z.object({ pickup_adults: SS.pickupList, pickup_photo_consent: z.boolean().optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const b = await bookingRow(conn, tenantId, paramId(req), true);
    await SS.savePickup(conn, tenantId, b.id, req.body.pickup_adults, { consent: Boolean(req.body.pickup_photo_consent), via: 'desk' });
    await audit(conn, req, 'pickup_list', 'lesson_bookings', b.id, { adults: req.body.pickup_adults.length, photos: req.body.pickup_adults.filter((a) => a.photo).length }); // never the names
  });
  res.json({ ok: true, adults: await SS.pickupFor(pool, tenantId, paramId(req)) });
});

router.get('/pickup-adults/:id/photo', staffOnly, async (req, res) => {
  const { tenantId } = req.auth;
  const a = await one(pool, 'SELECT id, booking_id, photo FROM lesson_pickup_adults WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!a) throw notFound('Photo');
  mayActOn(req, await bookingRow(pool, tenantId, a.booking_id), 'the pickup list');
  res.set('Cache-Control', 'private, no-store');
  res.json({ photo: a.photo || null });
});

const releaseSchema = z.object({
  adult_id: z.number().int().positive().optional(),
  other_name: z.string().trim().min(2).max(150).optional(),
  id_seen: z.literal(true, { errorMap: () => ({ message: 'Confirm that you saw their photo ID' }) }),
  override_reason: z.string().trim().min(3).max(300).optional(),
}).refine((b) => b.adult_id || b.other_name, { message: 'Pick the adult from the list, or name someone else' });

/**
 * Releases a child at pickup: the instructor (their own lesson) or the desk taps the child, picks the adult from the
 * list and confirms the photo ID. Someone not on the list needs a manager and a reason (audited). The family is told.
 */
router.post('/bookings/:id/release', staffOnly, validate(releaseSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = await tzOf(tenantId);
  const out = await tx(async (conn) => {
    const b = await bookingRow(conn, tenantId, paramId(req), true);
    mayActOn(req, b, 'this child');
    if (!['booked', 'attended'].includes(b.status) || b.session_status === 'cancelled') throw conflict('That booking is not active');
    if (b.released_at) throw conflict(`${b.first_name} was already picked up by ${b.released_to}`);
    let name; let adultId = null; let reason = null;
    if (req.body.adult_id) {
      const a = await one(conn, 'SELECT id, name FROM lesson_pickup_adults WHERE tenant_id = ? AND booking_id = ? AND id = ?', [tenantId, b.id, req.body.adult_id]);
      if (!a) throw bad('That adult is not on this child\'s pickup list');
      name = a.name; adultId = a.id;
    } else {
      if (!SS.mayOverride(req)) throw forbidden(`${req.body.other_name} is not on ${b.first_name}'s pickup list. A manager must release ${b.first_name} to someone else, with a reason.`);
      if (!req.body.override_reason) throw conflict(`${req.body.other_name} is not on the pickup list. Give a reason to release ${b.first_name} anyway.`, { needs_reason: true });
      name = req.body.other_name; reason = req.body.override_reason;
    }
    await conn.query('UPDATE lesson_bookings SET released_at = UTC_TIMESTAMP(), released_to = ?, released_adult_id = ?, released_by = ?, released_id_seen = 1, release_reason = ? WHERE tenant_id = ? AND id = ?',
      [name, adultId, req.auth.userId, reason, tenantId, b.id]);
    await audit(conn, req, reason ? 'release_override' : 'release', 'lesson_bookings', b.id, { adult_id: adultId, id_seen: true, ...(reason ? { reason } : {}) });
    return { b, name };
  });
  const at = nowIn(tz);
  const told = await tellFamily(tenantId, out.b, { subject: `${out.b.first_name} was picked up`, text: `Picked up by ${out.name} at ${clock(at)}.`, smsText: `${out.b.first_name} was picked up by ${out.name} at ${clock(at)}.`, tag: 'lesson-pickup' });
  res.json({ ok: true, released_to: out.name, at, told: { email: Boolean(told.email && told.email.ok !== false), text: Boolean(told.text && told.text.ok !== false) } });
});

router.delete('/bookings/:id/release', SA.school('supervisor'), validate(z.object({ reason: z.string().trim().min(3).max(300) })), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const b = await bookingRow(conn, tenantId, paramId(req), true);
    if (!b.released_at) throw conflict('That child has not been released');
    await conn.query('UPDATE lesson_bookings SET released_at = NULL, released_to = NULL, released_adult_id = NULL, released_by = NULL, released_id_seen = 0, release_reason = NULL WHERE tenant_id = ? AND id = ?', [tenantId, b.id]);
    await audit(conn, req, 'undo_release', 'lesson_bookings', b.id, { reason: req.body.reason });
  });
  res.json({ ok: true });
});

router.patch('/bookings/:id/colors', staffOnly, validate(z.object({ jacket_color: z.string().trim().max(40).nullable().optional(), helmet_color: z.string().trim().max(40).nullable().optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const b = await bookingRow(pool, tenantId, paramId(req));
  mayActOn(req, b, 'this child');
  await pool.query('UPDATE lesson_bookings SET jacket_color = COALESCE(?, jacket_color), helmet_color = COALESCE(?, helmet_color) WHERE tenant_id = ? AND id = ?', [req.body.jacket_color ?? null, req.body.helmet_color ?? null, tenantId, b.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- lost child
/** The last place and time a student was known: a check-in, a lift scan of their ticket or lesson code, a "We're at". */
async function lastSeen(tenantId, b, tz) {
  const day = String(b.starts_at).slice(0, 10);
  const seen = [];
  if (b.checked_in_at) seen.push({ at: localOf(b.checked_in_at, tz), place: b.checked_in_via === 'link' ? 'Checked in by the family' : `Checked in at ${b.checked_in_via === 'desk' ? 'the desk' : 'the lineup'}` });
  const scans = await rows(pool, `SELECT sc.location, sc.scanned_at FROM scans sc LEFT JOIN tickets k ON k.tenant_id = sc.tenant_id AND k.id = sc.ticket_id
    WHERE sc.tenant_id = ? AND sc.location IS NOT NULL AND sc.scanned_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 DAY) AND ((sc.result = 'ok' AND k.person_id = ?) OR sc.code = ?) ORDER BY sc.scanned_at DESC LIMIT 5`, [tenantId, b.person_id, `L${b.id}`]);
  for (const sc of scans) { const at = localOf(sc.scanned_at, tz); if (at.slice(0, 10) === day) seen.push({ at, place: `Lift scan at ${sc.location}` }); }
  const tap = await one(pool, 'SELECT place, at FROM school_group_places WHERE tenant_id = ? AND session_id = ? AND on_date = ? ORDER BY at DESC LIMIT 1', [tenantId, b.session_id, day]);
  if (tap) seen.push({ at: tap.at, place: `Class at ${tap.place}` });
  seen.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return seen[0] || null;
}

/** The people told about a lost child: the desk (counter logins), managers and owners, school directors and supervisors. */
async function schoolLeads(tenantId) {
  return (await rows(pool, `SELECT u.id FROM users u LEFT JOIN instructor_profiles ip ON ip.tenant_id = u.tenant_id AND ip.staff_id = u.staff_id
    WHERE u.tenant_id = ? AND u.active = 1 AND (u.role IN ('owner','manager','counter') OR (u.role = 'instructor' AND ip.school_access IN ('director','supervisor')))`, [tenantId])).map((u) => u.id);
}

router.post('/bookings/:id/lost', staffOnly, validate(z.object({
  jacket_color: z.string().trim().max(40).nullable().optional(), helmet_color: z.string().trim().max(40).nullable().optional(), last_seen: z.string().trim().max(200).nullable().optional(),
})), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = await tzOf(tenantId);
  const b = await bookingRow(pool, tenantId, paramId(req));
  mayActOn(req, b, 'this child');
  const open = await one(pool, "SELECT id, call_id FROM school_lost_children WHERE tenant_id = ? AND booking_id = ? AND status = 'open'", [tenantId, b.id]);
  if (open) throw conflict(`${b.first_name} is already reported lost. Patrol has the call.`, { lost_id: open.id });
  const day = String(b.starts_at).slice(0, 10);
  const age = SS.ageOn(b.date_of_birth, day);
  const jacket = req.body.jacket_color || b.jacket_color || null;
  const helmet = req.body.helmet_color || b.helmet_color || null;
  const seen = await lastSeen(tenantId, b, tz);
  const instr = b.instructor_id ? await one(pool, 'SELECT p.first_name, p.last_name FROM staff st JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE st.tenant_id = ? AND st.id = ?', [tenantId, b.instructor_id]) : null;
  const me = req.auth.staffId ? await one(pool, 'SELECT p.first_name, p.last_name FROM staff st JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE st.tenant_id = ? AND st.id = ?', [tenantId, req.auth.staffId]) : null;
  const hasPhoto = Boolean((await one(pool, 'SELECT photo IS NOT NULL AS has FROM people WHERE tenant_id = ? AND id = ?', [tenantId, b.person_id])).has);
  // The call's words: what patrol needs to look, and nothing else (no last name, no pickup list, no medical notes).
  const description = [`Lost child: ${b.first_name}${age != null ? `, age ${age}` : ''}.`, jacket ? `Jacket ${jacket}.` : null, helmet ? `Helmet ${helmet}.` : null,
    `Class: ${b.product} ${clock(b.starts_at)}${instr ? ` with ${instr.first_name}` : ''}.`, b.meeting_place ? `Meeting place ${b.meeting_place}.` : null,
    req.body.last_seen ? `Last seen: ${req.body.last_seen}.` : seen ? `Last known: ${seen.place} at ${clock(seen.at)}.` : null, hasPhoto ? 'Photo on the call.' : null].filter(Boolean).join(' ').slice(0, 500);
  const location = (req.body.last_seen || (seen && seen.place) || b.meeting_place || 'Ski school').slice(0, 255);
  const tenant = { id: tenantId, timezone: tz };
  const call = await require('./dispatch').createCall(tenant, { location, description, priority: 'high', caller_name: me ? `${me.first_name} ${me.last_name} (ski school)` : 'Ski school' }, { source: 'school', userId: req.auth.userId, staffId: req.auth.staffId || null });
  const lostId = await tx(async (conn) => {
    await conn.query("UPDATE dispatch_calls SET call_type = 'lost_child' WHERE tenant_id = ? AND id = ?", [tenantId, call.id]);
    const [r] = await conn.query('INSERT INTO school_lost_children (tenant_id, booking_id, session_id, call_id, jacket_color, helmet_color, last_seen, reported_by, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, b.id, b.session_id, call.id, jacket, helmet, req.body.last_seen || (seen ? `${seen.place} at ${clock(seen.at)}` : null), req.auth.userId, nowIn(tz)]);
    if (jacket || helmet) await conn.query('UPDATE lesson_bookings SET jacket_color = ?, helmet_color = ? WHERE tenant_id = ? AND id = ?', [jacket, helmet, tenantId, b.id]);
    await audit(conn, req, 'lost_child', 'lesson_bookings', b.id, { call_id: call.id });
    return r.insertId;
  });
  // The director and the desk are told on their phones (where to look, not the child's details).
  let alerted = 0;
  try { alerted = await require('../lib/push').notifyUsers(tenantId, await schoolLeads(tenantId), { title: `Lost child: ${b.first_name}`, body: `Patrol call ${call.call_no}. ${b.product} ${clock(b.starts_at)}. Open Lessons for the status.`, url: '#/school?tab=day&view=pickup', tag: `lost-${lostId}` }); } catch (_) { alerted = 0; }
  res.status(201).json({ id: lostId, call_id: call.id, call_no: call.call_no, description, location, alerted });
});

async function lostList(tenantId, date) {
  const tz = await tzOf(tenantId);
  const list = await rows(pool, `SELECT lc.*, c.status AS call_status, c.seq, c.call_date, c.closed_at, p.first_name, p.date_of_birth, s.starts_at, pr.name AS product, ip.first_name AS instructor_first, s.instructor_id
    FROM school_lost_children lc JOIN lesson_bookings b ON b.tenant_id = lc.tenant_id AND b.id = lc.booking_id JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    JOIN lesson_sessions s ON s.tenant_id = lc.tenant_id AND s.id = lc.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    LEFT JOIN dispatch_calls c ON c.tenant_id = lc.tenant_id AND c.id = lc.call_id LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id
    WHERE lc.tenant_id = ? AND (lc.status = 'open' OR DATE(lc.reported_at) = ?) ORDER BY lc.status = 'open' DESC, lc.reported_at DESC LIMIT 50`, [tenantId, date]);
  return list.map((x) => ({ id: x.id, booking_id: x.booking_id, session_id: x.session_id, first_name: x.first_name, age: SS.ageOn(x.date_of_birth, String(x.starts_at).slice(0, 10)), product: x.product, starts_at: x.starts_at,
    instructor_first: x.instructor_first, instructor_id: x.instructor_id, jacket_color: x.jacket_color, helmet_color: x.helmet_color, last_seen: x.last_seen, status: x.status, reported_at: x.reported_at,
    call_id: x.call_id, call_no: x.call_date ? `${String(x.call_date).slice(5).replace('-', '')}-${String(x.seq).padStart(2, '0')}` : null, call_status: x.call_status || null,
    found_by: x.found_by, found_where: x.found_where, found_at: x.found_at, tz }));
}

router.get('/lost', staffOnly, async (req, res) => {
  const tz = await tzOf(req.auth.tenantId);
  const date = String(req.query.date || todayIn(tz));
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  let list = await lostList(req.auth.tenantId, date);
  if (!isDesk(req)) list = list.filter((x) => Number(x.instructor_id) === Number(req.auth.staffId)); // an instructor: their own classes
  res.set('Cache-Control', 'no-store');
  res.json({ data: list });
});

/** One report with the child's photo: the school (as above) and patrol on the dispatch board. */
router.get('/lost/:id', requireRole('instructor', 'manager', 'counter', 'patrol'), async (req, res) => {
  const { tenantId } = req.auth;
  const lc = await one(pool, 'SELECT * FROM school_lost_children WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!lc) throw notFound('Report');
  const b = await bookingRow(pool, tenantId, lc.booking_id);
  if (req.auth.role !== 'patrol') mayActOn(req, b, 'this report');
  else {
    // Patrol reads a report (and the child's photo) only while the search is on: the report open, or its dispatch call
    // still active. Once the child is found or the report closed, patrol's access ends (2026.11.13 review).
    const call = lc.call_id ? await one(pool, 'SELECT status FROM dispatch_calls WHERE tenant_id = ? AND id = ?', [tenantId, lc.call_id]) : null;
    const callActive = Boolean(call) && !['closed', 'cancelled'].includes(call.status);
    if (lc.status !== 'open' && !callActive) throw forbidden('This child has been found and the report is closed. Patrol can no longer open it.');
  }
  const p = await one(pool, 'SELECT photo FROM people WHERE tenant_id = ? AND id = ?', [tenantId, b.person_id]);
  await audit(pool, req, 'lost_child_view', 'school_lost_children', lc.id);
  res.set('Cache-Control', 'private, no-store');
  res.json({ id: lc.id, call_id: lc.call_id, status: lc.status, first_name: b.first_name, age: SS.ageOn(b.date_of_birth, String(b.starts_at).slice(0, 10)), photo: (p && p.photo) || null,
    jacket_color: lc.jacket_color, helmet_color: lc.helmet_color, last_seen: lc.last_seen, product: b.product, starts_at: b.starts_at, meeting_place: b.meeting_place, found_by: lc.found_by, found_where: lc.found_where, found_at: lc.found_at });
});

/** For the dispatch board: the lost child report behind a call, if any (patrol). */
router.get('/lost-by-call/:id', requireRole('patrol', 'manager'), async (req, res) => {
  const lc = await one(pool, 'SELECT id FROM school_lost_children WHERE tenant_id = ? AND call_id = ? ORDER BY id DESC LIMIT 1', [req.auth.tenantId, paramId(req)]);
  if (!lc) throw notFound('Report');
  res.json({ id: lc.id });
});

router.post('/lost/:id/found', staffOnly, validate(z.object({ found_by: z.string().trim().min(2).max(150), found_where: z.string().trim().min(2).max(200), found_at: z.string().regex(/^\d{2}:\d{2}$/).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = await tzOf(tenantId);
  const now = nowIn(tz);
  const out = await tx(async (conn) => {
    const lc = await one(conn, 'SELECT * FROM school_lost_children WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, paramId(req)]);
    if (!lc) throw notFound('Report');
    const b = await bookingRow(conn, tenantId, lc.booking_id);
    mayActOn(req, b, 'this report');
    if (lc.status !== 'open') throw conflict('That report is already closed');
    const at = req.body.found_at ? `${now.slice(0, 10)} ${req.body.found_at}:00` : now;
    if (at > now) throw bad('The time found cannot be later than now');
    await conn.query("UPDATE school_lost_children SET status = 'found', found_by = ?, found_where = ?, found_at = ?, closed_by = ? WHERE tenant_id = ? AND id = ?", [req.body.found_by, req.body.found_where, at, req.auth.userId, tenantId, lc.id]);
    // The patrol call gets a note on its timeline. Patrol's own rules decide the rest: a call with a case stays open for patrol.
    if (lc.call_id) {
      const c = await one(conn, 'SELECT id, status, incident_id FROM dispatch_calls WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, lc.call_id]);
      if (c) {
        await conn.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, 'note', ?, ?, ?)", [tenantId, c.id, now, req.auth.staffId || null, `Found by ${req.body.found_by} at ${req.body.found_where}, ${clock(at)} (ski school)`.slice(0, 500), req.auth.userId]);
        if (!c.incident_id && !['closed', 'cancelled'].includes(c.status)) {
          await conn.query("UPDATE dispatch_calls SET status = 'closed', closed_at = ? WHERE tenant_id = ? AND id = ?", [now, tenantId, c.id]);
          await conn.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, 'closed', ?, 'Child found', ?)", [tenantId, c.id, now, req.auth.staffId || null, req.auth.userId]);
        }
      }
    }
    await audit(conn, req, 'lost_child_found', 'school_lost_children', lc.id, { call_id: lc.call_id });
    return { lc, at };
  });
  try { await require('../lib/push').notifyUsers(tenantId, await schoolLeads(tenantId), { title: 'Child found', body: `Found at ${req.body.found_where}, ${clock(out.at)}.`, url: '#/school?tab=day&view=pickup', tag: `lost-${out.lc.id}` }); } catch (_) { /* the board shows it */ }
  res.json({ ok: true, found_at: out.at });
});

// ---------------------------------------------------------------- adaptive intake
router.get('/bookings/:id/adaptive', staffOnly, async (req, res) => {
  const { tenantId } = req.auth;
  const b = await bookingRow(pool, tenantId, paramId(req));
  mayActOn(req, b, 'the adaptive notes');
  const r = await one(pool, 'SELECT * FROM lesson_adaptive_intake WHERE tenant_id = ? AND booking_id = ?', [tenantId, b.id]);
  await audit(pool, req, 'adaptive_view', 'lesson_bookings', b.id);
  res.set('Cache-Control', 'no-store');
  res.json({ booking_id: b.id, first_name: b.first_name, adaptive: b.discipline === 'adaptive', intake: SS.intakeOut(r), equipment_options: SS.EQUIPMENT });
});
router.put('/bookings/:id/adaptive', staffOnly, validate(SS.adaptiveIntake), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const b = await bookingRow(conn, tenantId, paramId(req), true);
    mayActOn(req, b, 'the adaptive notes');
    if (b.discipline !== 'adaptive') throw conflict('That is not an adaptive lesson');
    await SS.saveAdaptive(conn, tenantId, b.id, req.body, req.auth.userId);
    await audit(conn, req, 'adaptive_intake', 'lesson_bookings', b.id, { fields: Object.keys(req.body) });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- live updates
async function sessionFor(req, id) {
  const s = await one(pool, `SELECT s.id, s.instructor_id, s.starts_at, s.ends_at, s.status, pr.name AS product, ip.first_name AS instructor_first FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id WHERE s.tenant_id = ? AND s.id = ?`, [req.auth.tenantId, id]);
  if (!s) throw notFound('Lesson');
  return s;
}
const ownOrLead = (req, s, what) => {
  if (SA.atLeast(req, 'supervisor')) return;
  if (req.auth.role === 'instructor' && Number(s.instructor_id) === Number(req.auth.staffId)) return;
  throw forbidden(`Only the lesson's instructor and managers can ${what}`);
};

router.get('/sessions/:id/updates', staffOnly, async (req, res) => {
  const s = await sessionFor(req, paramId(req));
  if (!isDesk(req)) ownOrLead(req, s, 'see its updates');
  const list = await rows(pool, 'SELECT id, body, data IS NOT NULL AS has_photo, created_at FROM lesson_live_updates WHERE tenant_id = ? AND session_id = ? ORDER BY id', [req.auth.tenantId, s.id]);
  res.json({ data: list.map((u) => ({ ...u, has_photo: Boolean(Number(u.has_photo)) })) });
});

const updateSchema = z.object({
  body: z.string().trim().max(280).optional(),
  photo: z.string().regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'A photo').max(Math.ceil(MAX_PHOTO_BYTES * 1.4)).optional(),
}).refine((b) => (b.body && b.body.length) || b.photo, { message: 'Write a line or add a photo' });

/**
 * The instructor posts a photo or one line to the class. It shows on each family's lesson page and goes to them by
 * their chosen channel; a photo only to families who allowed photos. Families who turned updates off get nothing.
 */
router.post('/sessions/:id/updates', requireRole('instructor', 'manager'), validate(updateSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = await tzOf(tenantId);
  const s = await sessionFor(req, paramId(req));
  ownOrLead(req, s, 'post an update');
  if (s.status === 'cancelled') throw conflict('That lesson is canceled');
  const now = nowIn(tz);
  if (now.slice(0, 10) !== String(s.starts_at).slice(0, 10) || now < plus(s.starts_at, -30) || now > plus(s.ends_at, 30)) throw conflict('Live updates are for during the lesson.');
  const set = await S.get(pool, tenantId);
  if (req.body.photo && !set.recap_photos) throw conflict('The school does not take lesson photos. Post a line instead.');
  const { n } = await one(pool, 'SELECT COUNT(*) AS n FROM lesson_live_updates WHERE tenant_id = ? AND session_id = ?', [tenantId, s.id]);
  if (Number(n) >= MAX_UPDATES) throw conflict(`A lesson takes up to ${MAX_UPDATES} updates.`);
  let mime = null; let data = null;
  if (req.body.photo) {
    data = Buffer.from(req.body.photo.slice(req.body.photo.indexOf(',') + 1), 'base64');
    if (data.length > MAX_PHOTO_BYTES) throw bad('That photo is too large');
    mime = require('../lib/exif').sniff(data); // the bytes say what it is, as for recap photos (the phone resizes and re-encodes it)
    if (!mime || mime === 'image/heic') throw bad('That file is not a photo we can show (JPEG, PNG or WebP)');
  }
  const [r] = await pool.query('INSERT INTO lesson_live_updates (tenant_id, session_id, staff_id, body, mime, bytes, data, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, s.id, req.auth.staffId || null, req.body.body || null, mime, data ? data.length : null, data, req.auth.userId]);
  await audit(pool, req, 'live_update', 'lesson_sessions', s.id, { update_id: r.insertId, photo: Boolean(data) });
  // who hears about it
  const fams = await rows(pool, `SELECT b.*, p.first_name, p.email AS person_email, p.phone AS person_phone FROM lesson_bookings b JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND b.session_id = ? AND b.status IN ('booked','attended') AND b.updates_off = 0`, [tenantId, s.id]);
  let sent = 0; let skipped = 0;
  for (const b of fams) {
    if (data && !b.photo_ok) { skipped += 1; continue; }
    const who = s.instructor_first || 'The instructor';
    const words = req.body.body ? `${who}: "${req.body.body}"` : `${who} posted a photo of the class.`;
    await tellFamily(tenantId, b, { subject: `Update from ${b.first_name}'s lesson`, text: `${words}\n\nOpen your lesson link to see it. You can turn these updates off there.`, smsText: `Update from ${b.first_name}'s lesson. ${words}`, tag: 'lesson-live' });
    sent += 1;
  }
  res.status(201).json({ id: r.insertId, sent, skipped_no_photo_ok: skipped });
});

// ---------------------------------------------------------------- where are my groups
router.post('/sessions/:id/at', staffOnly, validate(z.object({ place: z.string().trim().min(1).max(80) })), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = await tzOf(tenantId);
  const s = await sessionFor(req, paramId(req));
  if (!isDesk(req)) ownOrLead(req, s, 'say where the class is');
  const places = (await S.get(pool, tenantId)).group_places;
  if (!places.includes(req.body.place)) throw bad('Pick one of the spots the school named in Settings');
  const now = nowIn(tz);
  if (now.slice(0, 10) !== String(s.starts_at).slice(0, 10)) throw conflict('"We\'re at" is for today\'s lessons');
  await pool.query('INSERT INTO school_group_places (tenant_id, session_id, on_date, place, at, staff_id) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, s.id, now.slice(0, 10), req.body.place, now, req.auth.staffId || null]);
  res.status(201).json({ ok: true, place: req.body.place, at: now });
});

// ---------------------------------------------------------------- the family's lesson link
async function familyBooking(req, { change = false } = {}) {
  const t = await one(pool, 'SELECT id, name, slug, timezone FROM tenants WHERE slug = ?', [String(req.params.slug)]);
  if (!t || !(await modules.enabledKeys(t.id)).includes('school')) throw notFound('Lesson');
  const F = require('../lib/lessonfamily');
  const b = await F.bookingByToken(pool, t.id, req.params.token);
  if (!b) throw notFound('Lesson');
  if (change && b.via_recap) throw forbidden('This link from the recap email shows the lesson only. To change it, use the link in the booking email, or call the ski school.');
  return { t, b };
}

publicRouter.put('/:slug/lesson/:token/pickup', validate(z.object({ pickup_adults: SS.pickupList, pickup_photo_consent: z.boolean().optional() })), async (req, res) => {
  const { t, b } = await familyBooking(req, { change: true });
  res.set('Cache-Control', 'no-store');
  if (b.released_at) throw conflict('Your child has already been picked up.');
  await tx(async (conn) => {
    await SS.savePickup(conn, t.id, b.id, req.body.pickup_adults, { consent: Boolean(req.body.pickup_photo_consent), via: 'family' });
    await audit(conn, { auth: { tenantId: t.id, userId: null }, ip: req.ip }, 'pickup_list', 'lesson_bookings', b.id, { adults: req.body.pickup_adults.length, via: 'family' });
  });
  res.json({ ok: true, adults: await SS.pickupFor(pool, t.id, b.id) });
});

publicRouter.patch('/:slug/lesson/:token/safety', validate(z.object({ updates_off: z.boolean().optional(), jacket_color: z.string().trim().max(40).nullable().optional(), helmet_color: z.string().trim().max(40).nullable().optional() })), async (req, res) => {
  const { t, b } = await familyBooking(req, { change: true });
  res.set('Cache-Control', 'no-store');
  const sets = []; const vals = [];
  if (req.body.updates_off !== undefined) { sets.push('updates_off = ?'); vals.push(req.body.updates_off ? 1 : 0); }
  for (const k of ['jacket_color', 'helmet_color']) if (req.body[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.body[k] || null); }
  if (sets.length) await pool.query(`UPDATE lesson_bookings SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t.id, b.id]);
  res.json({ ok: true });
});

publicRouter.get('/:slug/lesson/:token/updates/:uid/photo', async (req, res) => {
  const { t, b } = await familyBooking(req);
  if (!b.photo_ok || b.updates_off) throw notFound('Photo');
  const u = await one(pool, 'SELECT mime, data FROM lesson_live_updates WHERE tenant_id = ? AND session_id = ? AND id = ? AND data IS NOT NULL', [t.id, b.session_id, Number(req.params.uid) || 0]);
  if (!u) throw notFound('Photo');
  res.set('Cache-Control', 'private, no-store').type(u.mime).send(u.data);
});

/**
 * What the family lesson page adds (lib/lessonfamily.familyView): the live updates (photos only with photo_ok), who
 * picked the child up, the family's own pickup list and the colors. Never a location.
 */
async function familyPart(t, b) {
  const tz = t.timezone || (await tzOf(t.id));
  const updates = b.updates_off ? [] : await rows(pool, 'SELECT id, body, data IS NOT NULL AS has_photo, created_at FROM lesson_live_updates WHERE tenant_id = ? AND session_id = ? ORDER BY id DESC LIMIT 20', [t.id, b.session_id]);
  const age = SS.ageOn(b.date_of_birth || (await one(pool, 'SELECT date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [t.id, b.person_id]) || {}).date_of_birth, String(b.starts_at).slice(0, 10));
  return {
    updates_off: Boolean(b.updates_off),
    updates: updates.filter((u) => !Number(u.has_photo) || b.photo_ok).map((u) => ({ id: u.id, body: u.body, photo: Boolean(Number(u.has_photo)), at: localOf(u.created_at, tz) })),
    needs_release: SS.needsRelease(age, b),
    released: b.released_at ? { to: b.released_to, at: localOf(b.released_at, tz) } : null,
    pickup_adults: await SS.pickupFor(pool, t.id, b.id),
    jacket_color: b.jacket_color || null, helmet_color: b.helmet_color || null,
  };
}

// ---------------------------------------------------------------- jobs
async function tick() { return {}; }
/** Once a day: "We're at" taps from before today go; live update photos go after 90 days, like recap photos. */
async function daily() {
  let places = 0;
  for (const t of await rows(pool, 'SELECT DISTINCT g.tenant_id, t.timezone FROM school_group_places g JOIN tenants t ON t.id = g.tenant_id')) {
    const [a] = await pool.query('DELETE FROM school_group_places WHERE tenant_id = ? AND on_date < ?', [t.tenant_id, todayIn(t.timezone)]);
    places += a.affectedRows;
  }
  const [u] = await pool.query('DELETE FROM lesson_live_updates WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)', [KEEP_UPDATE_DAYS]);
  return { places, updates: u.affectedRows };
}

module.exports = { router, publicRouter, tick, daily, familyPart, dayBoard, localOf };
