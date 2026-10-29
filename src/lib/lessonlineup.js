'use strict';
// The 9:45 lineup (Track LINEUP): check-in, labels, the lineup board with its suggested split, and moving a student
// from one class to another. Lessons that start together for the same product, discipline and ages are one lineup
// (lesson_lineups). Every query is scoped by the mountain. Times are the mountain's wall clock, as lesson times are.
const { rows, one } = require('../db');
const { nowIn, todayIn, seasonFor, addDays } = require('./util');
const { conflict, bad, notFound } = require('./errors');
const { ON_FILE } = require('./waivers');
const { staffProblems } = require('./workforce');
const L = require('./levels');
const S = require('./schoolsettings');
const { studentClash, clashWords, lockStudents, spotsLeft, moveBookingRow } = require('./lessonrules');
const familynotify = require('./familynotify');
const mailer = require('./mailer');
const { audit } = require('./audit');

/** The code on a booking's confirmation and label, read by the desk's scanner: 'L' and the booking number. */
const bookingCode = (bookingId) => `L${bookingId}`;
/** A scanned code: { booking_id } for 'L123', { order_id } for 'ORD-45' (the receipt) or '#45', or null. */
function readCode(code) {
  const c = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  let m = /^L(\d{1,12})$/.exec(c);
  if (m) return { booking_id: Number(m[1]) };
  m = /^(?:ORD-?|#)(\d{1,12})$/.exec(c);
  if (m) return { order_id: Number(m[1]) };
  return null;
}

// The label colors, in the order the classes of a lineup are given them (lowest level first).
const COLORS = ['Red', 'Blue', 'Green', 'Orange', 'Purple', 'Yellow', 'Pink', 'Teal', 'Brown', 'Gray'];

const MIN = 60_000;
/** 'YYYY-MM-DD HH:MM:SS' plus minutes, as the same kind of string. */
function plusMinutes(dt, minutes) {
  const d = new Date(`${String(dt).replace(' ', 'T').slice(0, 19)}Z`);
  return new Date(d.getTime() + minutes * MIN).toISOString().slice(0, 19).replace('T', ' ');
}
const ageOn = (dob, day) => {
  if (!dob) return null;
  const b = String(dob).slice(0, 10);
  let a = Number(day.slice(0, 4)) - Number(b.slice(0, 4));
  if (day.slice(5, 10) < b.slice(5, 10)) a -= 1;
  return a;
};
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * Is check-in open for a booking? On the lesson day, from 90 minutes before the start until the end, while neither the
 * lesson nor the booking is canceled. PARENTS' family page uses the same rule to show "We're here".
 */
function checkinOpen(b, now) {
  if (!b || b.session_status === 'cancelled' || !['booked', 'attended'].includes(b.status)) return false;
  const start = String(b.starts_at).slice(0, 19);
  if (String(now).slice(0, 10) !== start.slice(0, 10)) return false;
  return now >= plusMinutes(start, -90) && now < String(b.ends_at).slice(0, 19);
}

/** Marks a booking checked in (once: a second check-in keeps the first time). via: link, desk or instructor. */
async function checkIn(conn, tenantId, bookingId, { via, userId = null }) {
  const [r] = await conn.query('UPDATE lesson_bookings SET checked_in_at = UTC_TIMESTAMP(), checked_in_via = ?, checked_in_by = ? WHERE tenant_id = ? AND id = ? AND checked_in_at IS NULL', [via, userId, tenantId, bookingId]);
  return r.affectedRows > 0;
}

const tzOf = async (db, tenantId) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

// ---------------------------------------------------------------- the check-in list
/**
 * The day's students by lesson time, for the desk. q searches a name, a phone number or an order number. Each row has
 * the flags the desk needs: checked in, waiver on file for the season, unpaid, and an allergy or medical note (a flag
 * only: the details are on the roster for the people who need them).
 */
async function checkinList(db, tenantId, { date, q = '' }) {
  const where = ['b.tenant_id = ?', 'DATE(s.starts_at) = ?', "b.status IN ('booked','attended','no_show')", "s.status <> 'cancelled'"];
  const params = [tenantId, date];
  const text = String(q || '').trim();
  if (text) {
    const digits = text.replace(/\D/g, '');
    const orderNo = /^#?\d{1,10}$/.test(text) ? Number(text.replace('#', '')) : null;
    const ors = ["CONCAT(p.first_name, ' ', p.last_name) LIKE ?", 'p.last_name LIKE ?'];
    params.push(`%${text}%`, `${text}%`);
    if (digits.length >= 4) { ors.push("REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(p.phone, ''), '-', ''), ' ', ''), '(', ''), ')', '') LIKE ?", "REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(b.contact_phone, ''), '-', ''), ' ', ''), '(', ''), ')', '') LIKE ?"); params.push(`%${digits}%`, `%${digits}%`); }
    if (orderNo) { ors.push('EXISTS (SELECT 1 FROM order_items i WHERE i.tenant_id = b.tenant_id AND i.session_id = b.session_id AND i.person_id = b.person_id AND i.order_id = ?)'); params.push(orderNo); }
    const code = readCode(text);
    if (code && code.booking_id) { ors.push('b.id = ?'); params.push(code.booking_id); }
    where.push(`(${ors.join(' OR ')})`);
  }
  const data = await rows(db, `SELECT b.id AS booking_id, b.session_id, b.person_id, b.status, b.unpaid, b.checked_in_at, b.checked_in_via, b.level,
      (b.allergies IS NOT NULL AND b.allergies <> '') AS has_allergy, (b.medical IS NOT NULL AND b.medical <> '') AS has_medical,
      p.first_name, p.last_name, p.date_of_birth, p.ski_level, p.snowboard_level,
      s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.meeting_place, s.lineup_id, s.delay_minutes, pr.name AS product,
      ip.first_name AS instructor_first
    FROM lesson_bookings b
    JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id
    LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id
    WHERE ${where.join(' AND ')} ORDER BY s.starts_at, pr.name, p.last_name, p.first_name LIMIT 400`, params);
  const season = seasonFor(date);
  for (const r of data) {
    r.waiver_ok = Boolean(await one(db, ON_FILE, [tenantId, r.person_id, season]));
    r.age = ageOn(r.date_of_birth, date);
    r.student_level = r.level || L.personLevel(r, r.discipline);
    r.code = bookingCode(r.booking_id);
    r.has_allergy = Boolean(Number(r.has_allergy)); r.has_medical = Boolean(Number(r.has_medical)); r.unpaid = Boolean(Number(r.unpaid));
    delete r.date_of_birth; delete r.ski_level; delete r.snowboard_level;
  }
  return data;
}

// ---------------------------------------------------------------- lineups
/**
 * Makes sure every group lesson on a day belongs to its lineup: lessons that start at the same time for the same
 * product, discipline and ages. Creates the lesson_lineups rows and sets lesson_sessions.lineup_id. Privates are not in
 * a lineup. Returns the day's lineups with their counts.
 */
async function ensureLineups(conn, tenantId, date) {
  const sessions = await rows(conn, `SELECT id, starts_at, product_id, discipline, age_group, lineup_id FROM lesson_sessions
    WHERE tenant_id = ? AND DATE(starts_at) = ? AND status <> 'cancelled' AND format = 'group'`, [tenantId, date]);
  const keyOf = (s) => `${s.starts_at}|${s.product_id}|${s.discipline}|${s.age_group}`;
  const groups = new Map();
  for (const s of sessions) { if (!groups.has(keyOf(s))) groups.set(keyOf(s), []); groups.get(keyOf(s)).push(s); }
  for (const list of groups.values()) {
    const s = list[0];
    await conn.query('INSERT IGNORE INTO lesson_lineups (tenant_id, starts_at, product_id, discipline, age_group) VALUES (?, ?, ?, ?, ?)', [tenantId, s.starts_at, s.product_id, s.discipline, s.age_group]);
    const lu = await one(conn, 'SELECT id FROM lesson_lineups WHERE tenant_id = ? AND starts_at = ? AND product_id = ? AND discipline = ? AND age_group = ?', [tenantId, s.starts_at, s.product_id, s.discipline, s.age_group]);
    const stale = list.filter((x) => Number(x.lineup_id) !== Number(lu.id)).map((x) => x.id);
    if (stale.length) await conn.query('UPDATE lesson_sessions SET lineup_id = ? WHERE tenant_id = ? AND id IN (?)', [lu.id, tenantId, stale]);
  }
  return rows(conn, `SELECT l.id, l.starts_at, l.product_id, l.discipline, l.age_group, l.ratio, l.status, pr.name AS product,
      (SELECT COUNT(*) FROM lesson_sessions s WHERE s.tenant_id = l.tenant_id AND s.lineup_id = l.id AND s.status <> 'cancelled') AS classes,
      (SELECT COUNT(*) FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
        WHERE b.tenant_id = l.tenant_id AND s.lineup_id = l.id AND s.status <> 'cancelled' AND b.status IN ('booked','attended')) AS students,
      (SELECT COUNT(*) FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
        WHERE b.tenant_id = l.tenant_id AND s.lineup_id = l.id AND s.status <> 'cancelled' AND b.status IN ('booked','attended') AND b.checked_in_at IS NOT NULL) AS checked_in
    FROM lesson_lineups l JOIN products pr ON pr.tenant_id = l.tenant_id AND pr.id = l.product_id
    WHERE l.tenant_id = ? AND DATE(l.starts_at) = ? HAVING classes > 0 ORDER BY l.starts_at, pr.name, l.discipline, l.age_group`, [tenantId, date]);
}

/** Is this a kids lineup (ages 12 and under)? Then the kids ratio applies and instructors must teach kids. */
const isKids = (lineup, sessions) => lineup.age_group === 'kids' || (sessions.length > 0 && sessions.every((s) => s.age_max && Number(s.age_max) <= 12));

/** The lineup's classes (sessions) with their students, and the board's other facts. */
async function board(db, tenantId, lineupId) {
  const lineup = await one(db, `SELECT l.*, pr.name AS product FROM lesson_lineups l JOIN products pr ON pr.tenant_id = l.tenant_id AND pr.id = l.product_id
    WHERE l.tenant_id = ? AND l.id = ?`, [tenantId, lineupId]);
  if (!lineup) throw notFound('Lineup');
  const sessions = await rows(db, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.age_min, s.age_max, s.capacity, s.meeting_place,
      s.instructor_id, s.origin, s.delay_minutes, s.status, ip.first_name AS instructor_first, ip.last_name AS instructor_last
    FROM lesson_sessions s LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id
    WHERE s.tenant_id = ? AND s.lineup_id = ? AND s.status <> 'cancelled' ORDER BY COALESCE(s.level_min, 0), s.id`, [tenantId, lineupId]);
  const day = String(lineup.starts_at).slice(0, 10);
  const students = sessions.length ? await rows(db, `SELECT b.id AS booking_id, b.session_id, b.person_id, b.status, b.checked_in_at, b.checked_in_via, b.level, b.unpaid,
      (b.allergies IS NOT NULL AND b.allergies <> '') AS has_allergy, (b.medical IS NOT NULL AND b.medical <> '') AS has_medical,
      p.first_name, p.last_name, p.date_of_birth, p.ski_level, p.snowboard_level
    FROM lesson_bookings b JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND b.session_id IN (?) AND b.status IN ('booked','attended','no_show') ORDER BY p.first_name, p.last_name`, [tenantId, sessions.map((s) => s.id)]) : [];
  const settings = await S.get(db, tenantId);
  const kids = isKids(lineup, sessions);
  const ratio = Number(lineup.ratio) || (kids ? settings.ratio_kids : settings.ratio_adults);
  const tz = await tzOf(db, tenantId);
  const now = nowIn(tz);
  const shape = (x, s) => ({ booking_id: x.booking_id, session_id: x.session_id, person_id: x.person_id, first_name: x.first_name, last_name: x.last_name, status: x.status,
    checked_in: Boolean(x.checked_in_at), checked_in_via: x.checked_in_via, age: ageOn(x.date_of_birth, day), unpaid: Boolean(Number(x.unpaid)),
    level: Number(x.level) || L.personLevel(x, s.discipline) || null, has_allergy: Boolean(Number(x.has_allergy)), has_medical: Boolean(Number(x.has_medical)), code: bookingCode(x.booking_id) });
  const classes = sessions.map((s, i) => ({ ...s, color: COLORS[i % COLORS.length], level_words: L.range(s.level_min, s.level_max),
    instructor: s.instructor_id ? `${s.instructor_first || ''} ${s.instructor_last || ''}`.trim() : null,
    students: students.filter((x) => x.session_id === s.id).map((x) => shape(x, s)) }));
  const all = classes.flatMap((c) => c.students.filter((x) => x.status !== 'no_show'));
  return {
    lineup: { id: lineup.id, starts_at: lineup.starts_at, product: lineup.product, discipline: lineup.discipline, age_group: lineup.age_group, status: lineup.status, ratio, kids,
      locked: lineup.status === 'locked' || now >= String(lineup.starts_at).slice(0, 19), split_at: lineup.split_at },
    classes,
    counts: { students: all.length, checked_in: all.filter((x) => x.checked_in).length },
    now,
  };
}

/** Teachers for a lineup's time: active staff with an instructor profile or the instructor role, with their profile. */
async function teachers(db, tenantId) {
  return rows(db, `SELECT st.id, p.first_name, p.last_name, ip.ski_level_max, ip.snowboard_level_max, COALESCE(ip.teaches_kids, 1) AS teaches_kids, COALESCE(ip.teaches_adaptive, 0) AS teaches_adaptive,
      ip.disciplines, (ip.staff_id IS NOT NULL) AS has_profile
    FROM staff st JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id
    LEFT JOIN instructor_profiles ip ON ip.tenant_id = st.tenant_id AND ip.staff_id = st.id
    WHERE st.tenant_id = ? AND st.status = 'active'
      AND (ip.staff_id IS NOT NULL OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = st.tenant_id AND u.staff_id = st.id AND u.role = 'instructor'))
    ORDER BY p.first_name, p.last_name`, [tenantId]);
}

/** Why a teacher cannot take this class, in plain words, or null. Uses CORE's rules: staffProblems and the level clearance. */
async function teacherProblem(db, tenantId, t, { discipline, levelMax, kids, startsAt, endsAt, ignoreLessonId = null, certIds = [] }) {
  if (!Number(t.has_profile)) return 'Not set up: set what they teach'; // no teaching profile: never cleared for everything
  if (!L.instructorCovers(t, discipline, levelMax)) return `Not cleared to teach Level ${levelMax}`;
  if (kids && !Number(t.teaches_kids)) return 'Does not teach kids';
  if (discipline === 'adaptive' && !Number(t.teaches_adaptive)) return 'Does not teach adaptive';
  const taught = String(t.disciplines || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (taught.length && !taught.includes(discipline)) return `Does not teach ${discipline}`;
  const p = await staffProblems(db, tenantId, { staffId: t.id, certificationIds: certIds, startsAt, endsAt, ignoreLessonId });
  return p.length ? p[0] : null;
}

/** Splits students sorted by level into n groups of near equal size, keeping the order. */
function chunks(list, n) {
  const out = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = Math.floor(list.length / n) + (i < list.length % n ? 1 : 0);
    out.push(list.slice(at, at + size));
    at += size;
  }
  return out;
}

/**
 * The suggested split: from who is checked in (from 'checked_in') or everyone booked ('booked'), grouped by level then
 * age into classes of at most the ratio. The lineup's own classes are used first (lowest level to the lowest class);
 * extra classes are new (session_id null). Each class keeps its instructor when they are cleared for it; others get a
 * free, cleared instructor who teaches kids when it is a kids lineup. Nothing is saved.
 */
async function suggestSplit(db, tenantId, lineupId, { from = 'checked_in' } = {}) {
  const b = await board(db, tenantId, lineupId);
  if (!b.classes.length) throw conflict('This lineup has no lessons');
  const tmpl = b.classes[0];
  const fallback = (c) => Number(c.level_min) || 1;
  let students = b.classes.flatMap((c) => c.students.filter((x) => x.status !== 'no_show').map((x) => ({ ...x, sortLevel: x.level || fallback(c) })));
  const leftOut = from === 'checked_in' ? students.filter((x) => !x.checked_in) : [];
  if (from === 'checked_in') students = students.filter((x) => x.checked_in);
  students.sort((a, c) => a.sortLevel - c.sortLevel || (a.age ?? 99) - (c.age ?? 99) || String(a.first_name).localeCompare(c.first_name));
  const ratio = b.lineup.ratio;
  const n = Math.max(Math.ceil(students.length / ratio), students.length ? 1 : 0);
  const groups = chunks(students, n);
  const existing = [...b.classes];
  const classes = groups.map((g, i) => {
    const lv = g.map((x) => x.sortLevel);
    const ages = g.map((x) => x.age).filter((a) => a !== null && a !== undefined);
    const s = existing[i] || null;
    return { session_id: s ? s.id : null, color: COLORS[i % COLORS.length], level_min: Math.min(...lv), level_max: Math.max(...lv), age_min: ages.length ? Math.min(...ages) : null, age_max: ages.length ? Math.max(...ages) : null,
      meeting_place: (s || tmpl).meeting_place, instructor_id: s ? s.instructor_id : null, instructor: s ? s.instructor : null, students: g.map(({ sortLevel, ...x }) => x) };
  });
  // classes of the lineup no longer needed stay, empty: the director can cancel them or keep them for walk-ups
  const empty = existing.slice(groups.length).map((s) => ({ session_id: s.id, color: s.color, level_min: s.level_min, level_max: s.level_max, meeting_place: s.meeting_place, instructor_id: s.instructor_id, instructor: s.instructor, students: [] }));
  // instructors: keep the class's own when cleared; fill the rest from the highest class down with the least cleared fit
  const pool = await teachers(db, tenantId);
  const taken = new Set(classes.concat(empty).map((c) => c.instructor_id).filter(Boolean));
  const when = { discipline: b.lineup.discipline, kids: b.lineup.kids, startsAt: tmpl.starts_at, endsAt: tmpl.ends_at };
  const capOf = (t) => Number(b.lineup.discipline === 'snowboard' ? t.snowboard_level_max : t.ski_level_max) || 10;
  for (const c of [...classes].sort((x, y) => y.level_max - x.level_max)) {
    if (c.instructor_id) {
      const t = pool.find((x) => x.id === c.instructor_id);
      const why = t ? await teacherProblem(db, tenantId, t, { ...when, levelMax: c.level_max, ignoreLessonId: c.session_id }) : null;
      if (!why) continue;
      c.instructor_problem = why;
      taken.delete(c.instructor_id);
      c.was_instructor = c.instructor; c.instructor_id = null; c.instructor = null;
    }
    const fits = [];
    for (const t of pool) {
      if (taken.has(t.id)) continue;
      if (!(await teacherProblem(db, tenantId, t, { ...when, levelMax: c.level_max }))) fits.push(t);
    }
    fits.sort((x, y) => capOf(x) - capOf(y));
    if (fits.length) { c.instructor_id = fits[0].id; c.instructor = `${fits[0].first_name} ${fits[0].last_name}`; taken.add(fits[0].id); } else c.needs_instructor = true;
  }
  return { lineup: b.lineup, from, ratio, classes, empty, left_out: leftOut };
}

/** Plain words for a class: "Ian's group, Level 3, meeting at the Magic Carpet". */
function classWords(s, instructorFirst, discipline) {
  const who = instructorFirst ? `${instructorFirst}'s group` : 'a new group';
  const lv = s.level_min && s.level_max ? (Number(s.level_min) === Number(s.level_max) ? L.name(s.level_min, discipline) : L.range(s.level_min, s.level_max)) : null;
  return [who, lv, s.meeting_place ? `meeting at ${s.meeting_place}` : null].filter(Boolean).join(', ');
}

async function instructorFirst(db, tenantId, staffId) {
  if (!staffId) return null;
  const r = await one(db, 'SELECT p.first_name, p.email FROM staff st JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE st.tenant_id = ? AND st.id = ?', [tenantId, staffId]);
  return r || null;
}

/**
 * Moves a student to another class on the same day, keeping the same booking row (its safety details, link and
 * consents): session_id changes, moved_from_session_id and moved_at are set, and the order line follows. Refuses a
 * clash and a full class; a manager may go over by one with a reason (the class gets one more spot). Returns what the
 * notices need. Call inside a transaction.
 */
async function moveBooking(conn, req, bookingId, toSessionId, { reason = null, isManager = false, quiet = false, skipCapacity = false } = {}) {
  const { tenantId } = req.auth;
  // The student first, then the booking and the lesson (lib/lessonrules.js: the lock order every booking path keeps).
  const who = await one(conn, 'SELECT person_id FROM lesson_bookings WHERE tenant_id = ? AND id = ?', [tenantId, bookingId]);
  if (who) await lockStudents(conn, tenantId, [who.person_id]);
  const b = await one(conn, 'SELECT * FROM lesson_bookings WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, bookingId]);
  if (!b) throw notFound('Booking');
  if (!['booked', 'attended'].includes(b.status)) throw conflict('Only a student who is booked can be moved');
  if (Number(b.session_id) === Number(toSessionId)) throw bad('The student is already in that class');
  const from = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, b.session_id]);
  const to = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, toSessionId]);
  if (!to) throw notFound('Lesson');
  if (to.status !== 'scheduled') throw conflict(`That class is ${to.status === 'cancelled' ? 'canceled' : to.status}`);
  if (String(to.starts_at).slice(0, 10) !== String(from.starts_at).slice(0, 10)) throw bad('Move a student to a class on the same day. To change the day, use the family page or cancel and book again.');
  const clash = await studentClash(conn, tenantId, b.person_id, to.starts_at, to.ends_at, { ignoreSessionId: from.id, lock: true });
  if (clash) throw conflict(clashWords(clash));
  // On the day, at the lineup: only the students in the class count (lib/lessonrules.spotsLeft, under the lesson lock).
  const { booked: n } = await spotsLeft(conn, tenantId, to, { holds: false });
  let over = false;
  if (!skipCapacity && Number(n) >= to.capacity) {
    if (!isManager) throw conflict('That class is full. A manager can add one more with a reason.', { full: true });
    if (!reason) throw conflict('That class is full. Give a reason to add one more.', { full: true, needs_reason: true });
    if (Number(n) >= to.capacity + 1) throw conflict('That class is already one over. Pick another class.', { full: true });
    await conn.query('UPDATE lesson_sessions SET capacity = capacity + 1 WHERE tenant_id = ? AND id = ?', [tenantId, to.id]);
    over = true;
  }
  // a canceled booking of the same student in the target class is in the way of the unique key: the moved row takes its place
  const old = await one(conn, 'SELECT id, status FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ?', [tenantId, to.id, b.person_id]);
  if (old && ['booked', 'attended'].includes(old.status)) throw conflict('That student is already in that class');
  if (old) await conn.query('DELETE FROM lesson_bookings WHERE tenant_id = ? AND id = ?', [tenantId, old.id]);
  // The same booking row moves and its sale line follows (a check-in at the lineup stays: same day, same student).
  await moveBookingRow(conn, tenantId, b, from.id, to, { utc: true, resetCheckin: false });
  await audit(conn, req, 'move_student', 'lesson_bookings', b.id, { from_session_id: from.id, to_session_id: to.id, ...(over ? { over_by_one: true, reason } : {}) });
  return { booking: b, from, to, over, quiet };
}

/** After a move commits: tell the family (email, and a text with the add-on) and the new instructor. Never throws. */
async function tellMoved(db, tenantId, moved) {
  try {
    const tenant = await one(db, 'SELECT id, name FROM tenants WHERE id = ?', [tenantId]);
    const p = await one(db, 'SELECT first_name, email, phone FROM people WHERE tenant_id = ? AND id = ?', [tenantId, moved.booking.person_id]);
    const b = await one(db, 'SELECT contact_email, contact_phone, text_ok FROM lesson_bookings WHERE tenant_id = ? AND id = ?', [tenantId, moved.booking.id]);
    const teacher = await instructorFirst(db, tenantId, moved.to.instructor_id);
    const words = `${p.first_name} moved to ${classWords(moved.to, teacher && teacher.first_name, moved.to.discipline)}.`;
    const fam = await familynotify.notify({ tenant, to: { email: b.contact_email || p.email, phone: b.contact_phone || p.phone, textOk: Boolean(b.text_ok) },
      subject: `${p.first_name}'s lesson group changed`, text: `Hello,\n\n${words}\n\nSee you on the snow,\n${tenant.name}`, smsText: `${tenant.name}: ${words}`, tag: 'lesson-move' });
    let staff = null;
    if (teacher && teacher.email) {
      staff = await mailer.send({ tenantId, to: teacher.email, fromName: tenant.name, subject: `${p.first_name} joined your ${String(moved.to.starts_at).slice(11, 16)} group`,
        text: `${p.first_name} is now in your group at ${String(moved.to.starts_at).slice(11, 16)}. Your roster in My day is up to date.`, tag: 'lesson-move-staff' }).catch((e) => ({ ok: false, error: e.message }));
    }
    return { family: fam, instructor: staff };
  } catch (err) { return { error: err.message }; }
}

/**
 * Uses a split: classes [{ session_id|null, booking_ids, instructor_id, level_min, level_max }]. New classes become
 * lessons (origin 'split', same product, time, discipline, ages and meeting place unless given). Every student of the
 * lineup the split names is moved to their class with moveBooking. Call inside a transaction. Returns the moves.
 */
async function applySplit(conn, req, lineupId, classes, { isManager = false } = {}) {
  const { tenantId } = req.auth;
  const lu = await one(conn, 'SELECT * FROM lesson_lineups WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, lineupId]);
  if (!lu) throw notFound('Lineup');
  const tz = await tzOf(conn, tenantId);
  if (lu.status === 'locked' || nowIn(tz) >= String(lu.starts_at).slice(0, 19)) throw conflict('The lineup has started, so it is locked. Move students one at a time instead.');
  const sessions = await rows(conn, "SELECT * FROM lesson_sessions WHERE tenant_id = ? AND lineup_id = ? AND status <> 'cancelled' ORDER BY id", [tenantId, lineupId]);
  if (!sessions.length) throw conflict('This lineup has no lessons');
  const ids = new Set(sessions.map((s) => s.id));
  const bookings = await rows(conn, "SELECT id, session_id, person_id FROM lesson_bookings WHERE tenant_id = ? AND session_id IN (?) AND status IN ('booked','attended')", [tenantId, [...ids]]);
  const bIds = new Set(bookings.map((x) => x.id));
  const seen = new Set();
  for (const c of classes) {
    if (c.session_id && !ids.has(c.session_id)) throw bad('A class in the split is not part of this lineup');
    for (const id of c.booking_ids) {
      if (!bIds.has(id)) throw bad('A student in the split is not booked in this lineup');
      if (seen.has(id)) throw bad('A student is in two classes');
      seen.add(id);
    }
  }
  const tmpl = sessions[0];
  const settings = await S.get(conn, tenantId);
  const kids = isKids(lu, sessions);
  const ratio = Number(lu.ratio) || (kids ? settings.ratio_kids : settings.ratio_adults);
  const moves = [];
  const target = [];
  for (const c of classes) {
    if (c.instructor_id) {
      const t = (await teachers(conn, tenantId)).find((x) => x.id === c.instructor_id);
      if (!t) throw bad('That instructor is not an active instructor');
      const why = await teacherProblem(conn, tenantId, t, { discipline: tmpl.discipline, levelMax: c.level_max, kids, startsAt: tmpl.starts_at, endsAt: tmpl.ends_at, ignoreLessonId: c.session_id || null });
      if (why) throw conflict(`${t.first_name} ${t.last_name} cannot take this class: ${why}`);
    }
    let sid = c.session_id;
    const lv = { level_min: c.level_min ?? null, level_max: c.level_max ?? null };
    const legacy = L.toLegacy(lv.level_max) || tmpl.ability_level;
    if (!sid) {
      const [r] = await conn.query(`INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, format, age_group, meeting_place, notes, starts_at, ends_at, capacity, instructor_id,
          required_certification_id, level_min, level_max, age_min, age_max, origin, lineup_id) VALUES (?, ?, ?, ?, 'group', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'split', ?)`,
      [tenantId, tmpl.product_id, tmpl.discipline, legacy, tmpl.age_group, c.meeting_place || tmpl.meeting_place, tmpl.starts_at, tmpl.ends_at, Math.max(ratio, c.booking_ids.length), c.instructor_id || null,
        tmpl.required_certification_id, lv.level_min, lv.level_max, tmpl.age_min, tmpl.age_max, lineupId]);
      sid = r.insertId;
      await audit(conn, req, 'split_create', 'lesson_sessions', sid, { lineup_id: lineupId });
    } else {
      const s = sessions.find((x) => x.id === sid);
      await conn.query('UPDATE lesson_sessions SET level_min = COALESCE(?, level_min), level_max = COALESCE(?, level_max), ability_level = ?, instructor_id = ?, capacity = GREATEST(capacity, ?), meeting_place = COALESCE(?, meeting_place) WHERE tenant_id = ? AND id = ?',
        [lv.level_min, lv.level_max, L.toLegacy(lv.level_max) || s.ability_level, c.instructor_id === undefined ? s.instructor_id : (c.instructor_id || null), c.booking_ids.length, c.meeting_place || null, tenantId, sid]);
    }
    target.push({ sid, ids: c.booking_ids });
  }
  // the split sets each class's size (capacity was raised to fit above), so the moves do not count seats one by one
  for (const t of target) {
    for (const id of t.ids) {
      const b = bookings.find((x) => x.id === id);
      if (b.session_id === t.sid) continue;
      moves.push(await moveBooking(conn, req, id, t.sid, { isManager, skipCapacity: true }));
    }
  }
  await conn.query("UPDATE lesson_lineups SET status = 'split', split_at = UTC_TIMESTAMP(), split_by = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, tenantId, lineupId]);
  await audit(conn, req, 'split', 'lesson_lineups', lineupId, { classes: classes.length, moved: moves.length });
  return moves;
}

// ---------------------------------------------------------------- labels
/**
 * One label per student: first name and last initial, level, the class color, an allergy or medical mark (never the
 * details), the instructor's first name, the meeting place, the time and the barcode code. sessionIds or bookingIds.
 */
async function labels(db, tenantId, { sessionIds = [], bookingIds = [] }) {
  if (!sessionIds.length && !bookingIds.length) return [];
  const where = sessionIds.length ? 'b.session_id IN (?)' : 'b.id IN (?)';
  const data = await rows(db, `SELECT b.id AS booking_id, b.level, (b.allergies IS NOT NULL AND b.allergies <> '') AS has_allergy, (b.medical IS NOT NULL AND b.medical <> '') AS has_medical,
      p.first_name, p.last_name, p.ski_level, p.snowboard_level, s.id AS session_id, s.lineup_id, s.discipline, s.level_min, s.level_max, s.meeting_place, s.starts_at, pr.name AS product,
      ip.first_name AS instructor_first
    FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id
    WHERE b.tenant_id = ? AND ${where} AND b.status IN ('booked','attended') ORDER BY s.starts_at, COALESCE(s.level_min, 0), s.id, p.first_name`, [tenantId, sessionIds.length ? sessionIds : bookingIds]);
  // the class color: its place in its lineup, lowest level first (as on the board)
  const lineupIds = [...new Set(data.map((d) => d.lineup_id).filter(Boolean))];
  const order = new Map();
  if (lineupIds.length) {
    const ss = await rows(db, "SELECT id, lineup_id FROM lesson_sessions WHERE tenant_id = ? AND lineup_id IN (?) AND status <> 'cancelled' ORDER BY lineup_id, COALESCE(level_min, 0), id", [tenantId, lineupIds]);
    const at = new Map();
    for (const s of ss) { const i = at.get(s.lineup_id) || 0; order.set(s.id, i); at.set(s.lineup_id, i + 1); }
  }
  return data.map((d) => {
    const level = Number(d.level) || L.personLevel(d, d.discipline) || null;
    return { booking_id: d.booking_id, code: bookingCode(d.booking_id), first_name: d.first_name, last_initial: String(d.last_name || '').slice(0, 1).toUpperCase(),
      level, level_words: level ? L.name(level, d.discipline) : L.range(d.level_min, d.level_max), color: order.has(d.session_id) ? COLORS[order.get(d.session_id) % COLORS.length] : null,
      allergy: Boolean(Number(d.has_allergy)) || Boolean(Number(d.has_medical)), instructor: first(d.instructor_first) || null, meeting_place: d.meeting_place, starts_at: d.starts_at, product: d.product };
  });
}

/** tick(): lineups whose start has passed are locked (no more auto-split; single moves still work). */
async function lockStarted(db) {
  const tenants = await rows(db, "SELECT DISTINCT l.tenant_id, t.timezone FROM lesson_lineups l JOIN tenants t ON t.id = l.tenant_id WHERE l.status <> 'locked' AND l.starts_at < DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY)");
  let n = 0;
  for (const t of tenants) {
    const [r] = await db.query("UPDATE lesson_lineups SET status = 'locked' WHERE tenant_id = ? AND status <> 'locked' AND starts_at <= ?", [t.tenant_id, nowIn(t.timezone)]);
    n += r.affectedRows;
  }
  return n;
}

module.exports = {
  COLORS, bookingCode, readCode, plusMinutes, ageOn, checkinOpen, checkIn, checkinList, ensureLineups, board, teachers, teacherProblem, chunks,
  suggestSplit, applySplit, moveBooking, tellMoved, classWords, labels, lockStarted, tzOf, todayIn, addDays,
};
