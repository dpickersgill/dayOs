'use strict';
// The staffing view: for the next 14 days, students booked per lesson time and discipline against the instructors on
// those lessons, plus the walk-ups to expect, and the gap ("Saturday 10:00: need 3 more kids instructors").
//   Walk-ups: students booked on the day of their lesson, averaged over the same weekday so far this season (school
//   holidays the director lists are compared with past holidays, or counted half again busier when there are none yet).
//   Snow: when the day's record has a snowfall forecast of 6 inches or more, a quarter more walk-ups (hook: day_records).
// Shift offers: the director offers a time to free, cleared instructors by text (staff texts use lib/sms) or email, and
// in the app. The first to accept gets it; the rest are told it is filled.
const { pool, tx, one, rows } = require('../db');
const { bad, conflict, notFound } = require('./errors');
const { audit } = require('./audit');
const { addDays, todayIn, weekdayOf, seasonFor, localDay } = require('./util');
const { staffProblems } = require('./workforce');
const levels = require('./levels');
const SS = require('./schoolsettings');
const mailer = require('./mailer');
const sms = require('./sms');

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (dt) => String(dt).slice(11, 16);
const clock = (t) => { const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const bandOf = (s) => (s.age_max && Number(s.age_max) <= 12 ? 'kids' : 'adults');
const slotKey = (time, discipline, band) => `${time}|${discipline}|${band}`;
const POWDER_IN = 6;

/** Active staff who teach: an instructor profile, or a sign-in with the instructor role. */
async function instructors(db, tenantId) {
  return rows(db, `SELECT s.id, p.first_name, p.last_name, p.phone, p.email, ip.disciplines, ip.ski_level_max, ip.snowboard_level_max, ip.teaches_kids, ip.teaches_adaptive
    FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    LEFT JOIN instructor_profiles ip ON ip.tenant_id = s.tenant_id AND ip.staff_id = s.id
    WHERE s.tenant_id = ? AND s.status = 'active' AND (ip.staff_id IS NOT NULL OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = s.tenant_id AND u.staff_id = s.id AND u.role = 'instructor'))
    ORDER BY p.first_name, p.last_name`, [tenantId]);
}

/** Can this instructor take this kind of lesson (discipline, level, kids)? Their calendar is checked separately. */
function suits(i, { discipline, level_max: levelMax, kids }) {
  const taught = String(i.disciplines || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (taught.length && !taught.includes(discipline)) return false;
  if (discipline === 'adaptive' && i.teaches_adaptive === 0) return false;
  if (kids && i.teaches_kids === 0) return false;
  return levels.instructorCovers(i, discipline, levelMax);
}

/** Free, available and suited instructors for a time. */
async function freeFor(db, tenantId, want, exclude = new Set()) {
  const out = [];
  for (const i of await instructors(db, tenantId)) {
    if (exclude.has(i.id) || !suits(i, want)) continue;
    const problems = await staffProblems(db, tenantId, { staffId: i.id, startsAt: want.starts_at, endsAt: want.ends_at });
    if (!problems.length) out.push(i);
  }
  return out;
}

/** Walk-ups per weekday slot this season: { weekday|holiday: { key: average } }. */
async function walkupHistory(db, tenantId, tz, today) {
  const season = seasonFor(today);
  const start = `${season.slice(0, 4)}-08-01`;
  const list = await rows(db, `SELECT s.starts_at, s.discipline, s.age_max, b.created_at FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    WHERE b.tenant_id = ? AND b.status IN ('booked','attended','no_show') AND s.starts_at >= ? AND s.starts_at < ?`, [tenantId, `${start} 00:00:00`, `${today} 00:00:00`]);
  const days = await rows(db, "SELECT DISTINCT DATE(starts_at) AS d FROM lesson_sessions WHERE tenant_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?", [tenantId, `${start} 00:00:00`, `${today} 00:00:00`]);
  const holidays = new Set((await rows(db, 'SELECT on_date FROM school_holidays WHERE tenant_id = ?', [tenantId])).map((h) => String(h.on_date).slice(0, 10)));
  const groupOf = (d) => (holidays.has(d) ? 'holiday' : String(weekdayOf(d)));
  const opened = {};
  for (const r of days) { const g = groupOf(String(r.d).slice(0, 10)); opened[g] = (opened[g] || 0) + 1; }
  const sums = {};
  for (const r of list) {
    const day = String(r.starts_at).slice(0, 10);
    if (localDay(r.created_at, tz) !== day) continue; // booked ahead, not a walk-up
    const g = groupOf(day); const k = slotKey(hhmm(r.starts_at), r.discipline, bandOf(r));
    sums[g] = sums[g] || {}; sums[g][k] = (sums[g][k] || 0) + 1;
  }
  const avg = {};
  for (const g of Object.keys(sums)) { avg[g] = {}; for (const k of Object.keys(sums[g])) avg[g][k] = sums[g][k] / Math.max(1, opened[g] || 1); }
  return { avg, holidays };
}

/** Expected walk-ups for one slot on a day. */
function expectWalkups(hist, date, key, snowIn) {
  let n;
  if (hist.holidays.has(date)) n = hist.avg.holiday && hist.avg.holiday[key] !== undefined ? hist.avg.holiday[key] : ((hist.avg[String(weekdayOf(date))] || {})[key] || 0) * 1.5;
  else n = (hist.avg[String(weekdayOf(date))] || {})[key] || 0;
  if (snowIn !== null && snowIn >= POWDER_IN) n *= 1.25;
  return Math.round(n);
}

/** The view: each lesson time in the next days with booked, expected, needed, scheduled and the gap. */
async function view(tenantId, { from, days = 14 } = {}) {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const start = from || today;
  const end = addDays(start, Math.min(Math.max(days, 1), 21));
  const set = await SS.get(pool, tenantId);
  const sessions = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.format, s.level_min, s.level_max, s.age_min, s.age_max, s.capacity, s.instructor_id,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
    FROM lesson_sessions s WHERE s.tenant_id = ? AND s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at`, [tenantId, `${start} 00:00:00`, `${end} 00:00:00`]);
  const hist = await walkupHistory(pool, tenantId, t.timezone, today);
  const snow = new Map((await rows(pool, 'SELECT on_date, snowfall_in FROM day_records WHERE tenant_id = ? AND on_date >= ? AND on_date < ?', [tenantId, start, end]).catch(() => []))
    .map((r) => [String(r.on_date).slice(0, 10), r.snowfall_in === null ? null : Number(r.snowfall_in)]));
  const offers = await rows(pool, `SELECT o.starts_at, o.discipline, o.kids, x.staff_id FROM shift_offers o JOIN shift_offer_sends x ON x.tenant_id = o.tenant_id AND x.offer_id = o.id AND x.answer = 'yes'
    WHERE o.tenant_id = ? AND o.starts_at >= ? AND o.starts_at < ?`, [tenantId, `${start} 00:00:00`, `${end} 00:00:00`]);
  const slots = new Map();
  for (const s of sessions) {
    const date = String(s.starts_at).slice(0, 10); const band = bandOf(s);
    const key = `${date}|${slotKey(hhmm(s.starts_at), s.discipline, band)}`;
    const x = slots.get(key) || { date, time: hhmm(s.starts_at), starts_at: s.starts_at, ends_at: s.ends_at, discipline: s.discipline, band, lessons: 0, unassigned: 0, booked: 0, group_booked: 0, privates: 0, capacity: 0, level_min: null, level_max: null, staff: new Set() };
    x.lessons += 1; x.booked += Number(s.booked); x.capacity += Number(s.capacity);
    if (s.ends_at > x.ends_at) x.ends_at = s.ends_at;
    if (s.format === 'group') x.group_booked += Number(s.booked); else if (Number(s.booked) > 0) x.privates += 1;
    if (s.instructor_id) x.staff.add(s.instructor_id); else x.unassigned += 1;
    if (s.level_min && (!x.level_min || s.level_min < x.level_min)) x.level_min = s.level_min;
    if (s.level_max && (!x.level_max || s.level_max > x.level_max)) x.level_max = s.level_max;
    slots.set(key, x);
  }
  const out = [];
  for (const x of slots.values()) {
    const sn = snow.has(x.date) ? snow.get(x.date) : null;
    const walkups = expectWalkups(hist, x.date, slotKey(x.time, x.discipline, x.band), sn);
    const ratio = x.band === 'kids' ? set.ratio_kids : set.ratio_adults;
    const groupStudents = x.group_booked + walkups;
    const need = Math.ceil(groupStudents / Math.max(1, ratio)) + x.privates;
    const accepted = offers.filter((o) => hhmm(o.starts_at) === x.time && String(o.starts_at).slice(0, 10) === x.date && o.discipline === x.discipline && Boolean(o.kids) === (x.band === 'kids'));
    accepted.forEach((o) => x.staff.add(o.staff_id));
    const scheduled = x.staff.size;
    const gap = Math.max(0, need - scheduled);
    const row = {
      date: x.date, time: x.time, starts_at: x.starts_at, ends_at: x.ends_at, discipline: x.discipline, band: x.band, lessons: x.lessons, unassigned: x.unassigned,
      booked: x.booked, walkups, need, scheduled, gap, level_min: x.level_min, level_max: x.level_max, level_words: levels.range(x.level_min, x.level_max),
      holiday: hist.holidays.has(x.date), snow_in: sn, available: null,
      words: gap ? `${WEEKDAY[weekdayOf(x.date)]} ${clock(x.time)}: need ${gap} more ${x.band === 'kids' ? 'kids ' : ''}${x.discipline === 'ski' ? '' : `${x.discipline} `}instructor${gap === 1 ? '' : 's'}` : null,
    };
    if (gap) row.available = (await freeFor(pool, tenantId, { discipline: x.discipline, level_max: x.level_max, kids: x.band === 'kids', starts_at: x.starts_at, ends_at: x.ends_at }, x.staff)).length;
    out.push(row);
  }
  out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.discipline.localeCompare(b.discipline) || a.band.localeCompare(b.band));
  return { from: start, to: addDays(end, -1), ratio_kids: set.ratio_kids, ratio_adults: set.ratio_adults, holidays: [...hist.holidays].filter((d) => d >= start && d < end), slots: out };
}

// ---------------------------------------------------------------- shift offers
const offerWords = (o) => {
  const d = String(o.starts_at).slice(0, 10);
  return `${WEEKDAY[weekdayOf(d)]} ${clock(hhmm(o.starts_at))}${o.kids ? ' kids' : ''}${o.discipline === 'ski' ? '' : ` ${o.discipline}`} ${levels.range(o.level_min, o.level_max)}`;
};

/** Creates an offer and sends it. Returns the offer and who it went to. */
async function createOffer(tenantId, b, req, base) {
  if (b.ends_at <= b.starts_at) throw bad('The end must be after the start');
  const t = await one(pool, 'SELECT id, name, slug FROM tenants WHERE id = ?', [tenantId]);
  const want = { discipline: b.discipline, level_max: b.level_max, kids: Boolean(b.kids), starts_at: b.starts_at, ends_at: b.ends_at };
  let to = await freeFor(pool, tenantId, want);
  if (b.staff_ids && b.staff_ids.length) to = to.filter((i) => b.staff_ids.includes(i.id));
  if (!to.length) throw conflict('Nobody free and cleared for that time. Try another time or level.');
  if (b.session_id && !(await one(pool, "SELECT id FROM lesson_sessions WHERE tenant_id = ? AND id = ? AND status = 'scheduled'", [tenantId, b.session_id]))) throw notFound('Lesson');
  const textOn = sms.enabled();
  const id = await tx(async (conn) => {
    const [r] = await conn.query('INSERT INTO shift_offers (tenant_id, starts_at, ends_at, discipline, level_min, level_max, kids, session_id, spots, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, b.starts_at, b.ends_at, b.discipline, b.level_min || null, b.level_max || null, b.kids ? 1 : 0, b.session_id || null, b.spots || 1, b.note || null, req.auth.userId || null]);
    for (const i of to) await conn.query('INSERT INTO shift_offer_sends (tenant_id, offer_id, staff_id, via) VALUES (?, ?, ?, ?)', [tenantId, r.insertId, i.id, textOn && i.phone ? 'text' : i.email ? 'email' : 'app']);
    await audit(conn, req, 'create', 'shift_offers', r.insertId, { sent_to: to.length, starts_at: b.starts_at });
    return r.insertId;
  });
  const o = await one(pool, 'SELECT * FROM shift_offers WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  const link = `${base}/#/school?tab=offers`;
  const ask = `Can you teach ${offerWords(o)}${o.spots > 1 ? ` (${o.spots} spots)` : ''}? First to say yes gets it. Open the app to say yes: ${link}`;
  let sent = 0;
  for (const i of to) {
    let ok = false;
    if (textOn && i.phone) ok = (await sms.send({ tenantId, to: i.phone, body: `${t.name}: ${ask}`.slice(0, 300) }).catch(() => ({ ok: false }))).ok;
    if (!ok && i.email) ok = (await mailer.send({ tenantId, to: i.email, fromName: t.name, subject: `Can you teach ${offerWords(o)}?`, text: [`Hi ${i.first_name},`, '', ask, o.note ? `\n${o.note}` : null, '', t.name].filter((x) => x !== null).join('\n'), tag: 'shift-offer' }).catch(() => ({ ok: false }))).ok;
    if (ok) sent += 1;
  }
  return { id, sent_to: to.length, messages: sent, words: offerWords(o) };
}

/** Accepts an offer for the signed-in instructor. First come, first served under the row lock. */
async function accept(tenantId, offerId, staffId, req) {
  const out = await tx(async (conn) => {
    const o = await one(conn, 'SELECT * FROM shift_offers WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, offerId]);
    if (!o) throw notFound('Offer');
    const mine = await one(conn, 'SELECT * FROM shift_offer_sends WHERE tenant_id = ? AND offer_id = ? AND staff_id = ? FOR UPDATE', [tenantId, offerId, staffId]);
    if (!mine) throw notFound('Offer');
    if (mine.answer === 'yes') return { already: true };
    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM shift_offer_sends WHERE tenant_id = ? AND offer_id = ? AND answer = 'yes'", [tenantId, offerId]);
    if (o.status !== 'open' || Number(n) >= Number(o.spots)) {
      await conn.query("UPDATE shift_offer_sends SET answer = 'late', answered_at = NOW() WHERE tenant_id = ? AND id = ?", [tenantId, mine.id]);
      throw conflict('Thanks! Someone else already took this one.');
    }
    const problems = await staffProblems(conn, tenantId, { staffId, startsAt: o.starts_at, endsAt: o.ends_at, skipAvailability: true });
    if (problems.length) throw conflict(`You can't take this one: ${problems[0]}`);
    if (o.session_id) {
      const s = await one(conn, 'SELECT id, instructor_id, status FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, o.session_id]);
      if (s && s.status === 'scheduled' && !s.instructor_id) await conn.query('UPDATE lesson_sessions SET instructor_id = ? WHERE tenant_id = ? AND id = ?', [staffId, tenantId, s.id]);
    }
    await conn.query("UPDATE shift_offer_sends SET answer = 'yes', answered_at = NOW() WHERE tenant_id = ? AND id = ?", [tenantId, mine.id]);
    const filled = Number(n) + 1 >= Number(o.spots);
    if (filled) await conn.query("UPDATE shift_offers SET status = 'filled' WHERE tenant_id = ? AND id = ?", [tenantId, o.id]);
    await audit(conn, req, 'accept', 'shift_offers', o.id, { staff_id: staffId, filled });
    return { offer: o, filled };
  });
  if (out.filled) await tellFilled(tenantId, out.offer);
  return { ok: true, filled: Boolean(out.filled), already: Boolean(out.already) };
}

/** Everyone else who was asked hears it is filled. */
async function tellFilled(tenantId, o) {
  const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [tenantId]);
  const rest = await rows(pool, `SELECT x.id, x.via, p.first_name, p.email, p.phone FROM shift_offer_sends x JOIN staff s ON s.tenant_id = x.tenant_id AND s.id = x.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE x.tenant_id = ? AND x.offer_id = ? AND x.answer IN ('none','no') AND x.told_filled = 0`, [tenantId, o.id]);
  for (const r of rest) {
    const msg = `${t.name}: the ${offerWords(o)} spot is filled. Thanks for looking!`;
    if (r.via === 'text' && r.phone) await sms.send({ tenantId, to: r.phone, body: msg }).catch(() => {});
    else if (r.via === 'email' && r.email) await mailer.send({ tenantId, to: r.email, fromName: t.name, subject: 'That shift is filled', text: `Hi ${r.first_name},\n\n${msg}`, tag: 'shift-offer' }).catch(() => {});
    await pool.query('UPDATE shift_offer_sends SET told_filled = 1 WHERE tenant_id = ? AND id = ?', [tenantId, r.id]);
  }
}

async function decline(tenantId, offerId, staffId) {
  const [r] = await pool.query("UPDATE shift_offer_sends SET answer = 'no', answered_at = NOW() WHERE tenant_id = ? AND offer_id = ? AND staff_id = ? AND answer = 'none'", [tenantId, offerId, staffId]);
  if (!r.affectedRows) throw notFound('Offer');
}

async function offersForManager(tenantId, today) {
  const list = await rows(pool, 'SELECT * FROM shift_offers WHERE tenant_id = ? AND starts_at >= ? ORDER BY starts_at LIMIT 100', [tenantId, `${today} 00:00:00`]);
  for (const o of list) {
    o.words = offerWords(o);
    o.sends = await rows(pool, `SELECT x.staff_id, x.via, x.answer, x.answered_at, CONCAT(p.first_name, ' ', p.last_name) AS name FROM shift_offer_sends x JOIN staff s ON s.tenant_id = x.tenant_id AND s.id = x.staff_id
      JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE x.tenant_id = ? AND x.offer_id = ? ORDER BY x.answered_at IS NULL, x.answered_at, p.first_name`, [tenantId, o.id]);
  }
  return list;
}

async function offersForStaff(tenantId, staffId, today) {
  const list = await rows(pool, `SELECT o.*, x.answer FROM shift_offers o JOIN shift_offer_sends x ON x.tenant_id = o.tenant_id AND x.offer_id = o.id AND x.staff_id = ?
    WHERE o.tenant_id = ? AND o.starts_at >= ? ORDER BY o.starts_at LIMIT 50`, [staffId, tenantId, `${today} 00:00:00`]);
  return list.map((o) => ({ id: o.id, starts_at: o.starts_at, ends_at: o.ends_at, words: offerWords(o), note: o.note, status: o.status, answer: o.answer, spots: o.spots }));
}

// ---------------------------------------------------------------- certifications
/** Certifications running out in the next 30 days, and lessons in the next 30 days whose instructor lacks a required one. */
async function certWatch(tenantId) {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone); const until = addDays(today, 30);
  const teach = new Set((await instructors(pool, tenantId)).map((i) => i.id));
  const expiring = (await rows(pool, `SELECT sc.staff_id, sc.expires_on, c.name AS certification, CONCAT(p.first_name, ' ', p.last_name) AS name FROM staff_certifications sc
      JOIN certifications c ON c.tenant_id = sc.tenant_id AND c.id = sc.certification_id JOIN staff s ON s.tenant_id = sc.tenant_id AND s.id = sc.staff_id AND s.status = 'active'
      JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE sc.tenant_id = ? AND sc.expires_on IS NOT NULL AND sc.expires_on <= ? ORDER BY sc.expires_on`, [tenantId, until])).filter((r) => teach.has(r.staff_id))
    .map((r) => ({ ...r, expired: String(r.expires_on).slice(0, 10) < today }));
  const missing = await rows(pool, `SELECT s.id AS session_id, s.starts_at, s.instructor_id, c.name AS certification, pr.name AS product, CONCAT(p.first_name, ' ', p.last_name) AS name
    FROM lesson_sessions s JOIN certifications c ON c.tenant_id = s.tenant_id AND c.id = s.required_certification_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id
    WHERE s.tenant_id = ? AND s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at < ?
      AND NOT EXISTS (SELECT 1 FROM staff_certifications sc WHERE sc.tenant_id = s.tenant_id AND sc.staff_id = s.instructor_id AND sc.certification_id = s.required_certification_id AND (sc.expires_on IS NULL OR sc.expires_on >= DATE(s.starts_at)))
    ORDER BY s.starts_at`, [tenantId, `${today} 00:00:00`, `${addDays(until, 1)} 00:00:00`]);
  return { today, until, expiring, missing };
}

module.exports = { view, instructors, freeFor, suits, walkupHistory, expectWalkups, createOffer, accept, decline, offersForManager, offersForStaff, certWatch, offerWords };
