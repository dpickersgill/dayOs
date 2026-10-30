'use strict';
// Lesson planning, best of breed (2026.11.9), Track STAFF. router is mounted at /skischool (staff).
//   GET  /staff/fill?month=YYYY-MM      the fill view's month: per day students booked, spots open, instructors needed
//                                       and available, a red, amber or green mark, the waitlist (supervisor and up)
//   GET  /staff/fill/day?date=          one day: each lesson time with the same numbers, why each staff-following lesson
//                                       has the spots it has, and the Fill the gap asks sent for that day
//   POST /staff/fill/ask                Fill the gap: a shift offer to every free, cleared instructor for that time (director)
//   GET  /staff/demand                  sold-out demand and suggestions to add a slot (director)
//   GET  /staff/needs                   the staffing target for My day: days ahead short of instructors (instructors and up)
//   POST /staff/needs/can-work          "I can work": marks the instructor open for that time, then recounts spots
//   GET  /staff/spots/:id               why one lesson has the spots it has (supervisor and up)
//   POST /staff/sync                    recount spots now for some days (director)
// tick() runs every 5 minutes (POST /jobs/lessons) and daily() once a day (POST /jobs/daily): return a small summary.
const express = require('express');
const { pool, tx, one, rows } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId, todayIn, nowIn, addDays, weekdayOf } = require('../lib/util');
const { bad, conflict, notFound, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { school } = require('../lib/schoolaccess');
const { baseUrl } = require('../lib/baseurl');
const LS = require('../lib/lessonspots');
const LD = require('../lib/lessondemand');
const ST = require('../lib/lessonstaffing');
const levels = require('../lib/levels');

const router = express.Router();
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (dt) => String(dt).slice(0, 10);
const hhmm = (dt) => String(dt).slice(11, 16);
const clock = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
/** 'Sat, Jan 9, 2027' (lib/format dayText style) and 'Saturday, Jan 9' for the My day card. */
const dayText = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${WEEKDAY[weekdayOf(d)].slice(0, 3)}, ${MONTHS[m - 1]} ${dd}, ${y}`; };
const dayLong = (d) => { const [, m, dd] = d.split('-').map(Number); return `${WEEKDAY[weekdayOf(d)]}, ${MONTHS[m - 1]} ${dd}`; };
const bandOf = (s) => (s.age_max != null && Number(s.age_max) <= 12 ? 'kids' : s.age_min != null && Number(s.age_min) >= 13 ? 'adults' : 'all');
const groupName = (g) => `${g.band === 'kids' ? 'kids ' : g.band === 'adults' ? 'adult ' : ''}${g.discipline === 'ski' ? 'ski' : g.discipline}`;
const plural = (n, a, b) => `${n} ${n === 1 ? a : b || `${a}s`}`;
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const SPARE = 2; // fewer spare instructors than this at a time: amber

/**
 * The fill numbers for some dates. Lessons at one time are grouped by start time, discipline and age band (as the lineup
 * and the staffing view do). Per group: need (from students booked: ceil(booked / ratio), plus one per booked private),
 * need_full (the same if every open spot sells), have (instructors it gets once overlapping times share them),
 * available (have plus free instructors nobody else needs), short (need - have), mark red, amber or green.
 */
async function fill(tenantId, dates) {
  const P = await LS.plan(pool, tenantId, dates);
  const { L, counts } = P;
  const ids = L.lessons.map((s) => s.id);
  const waiting = new Map();
  if (ids.length) for (const r of await rows(pool, "SELECT session_id, COUNT(*) AS n FROM lesson_waitlist WHERE tenant_id = ? AND session_id IN (?) AND status IN ('waiting','offered') GROUP BY session_id", [tenantId, ids])) waiting.set(Number(r.session_id), Number(r.n));
  const meta = new Map();
  if (ids.length) for (const r of await rows(pool, `SELECT s.id, pr.name AS product, CONCAT(p.first_name, ' ', p.last_name) AS instructor FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
      LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE s.tenant_id = ? AND s.id IN (?)`, [tenantId, ids])) meta.set(Number(r.id), r);
  const out = [];
  for (const date of L.dates) {
    const todays = L.lessons.filter((s) => day(s.starts_at) === date);
    if (!todays.length) continue;
    const byKey = new Map();
    for (const s of todays) {
      const band = bandOf(s); const key = `${hhmm(s.starts_at)}|${s.discipline}|${band}`;
      const g = byKey.get(key) || { key, time: hhmm(s.starts_at), discipline: s.discipline, band, s: String(s.starts_at), e: String(s.ends_at), lessons: [], pre: [], cands: new Set(), booked: 0, held: 0, capacity: 0, groupBooked: 0, groupCap: 0, privates: 0, privatesBooked: 0, waitlist: 0, level_max: null, adaptive: s.discipline === 'adaptive' };
      if (String(s.ends_at) > g.e) g.e = String(s.ends_at);
      const k = counts.get(Number(s.id)); const m = meta.get(Number(s.id)) || {};
      g.booked += k.booked; g.held += k.held; g.capacity += Number(s.capacity); g.waitlist += waiting.get(Number(s.id)) || 0;
      if (s.format === 'group') { g.groupBooked += k.booked; g.groupCap += Number(s.capacity); } else { g.privates += 1; if (k.booked) g.privatesBooked += 1; }
      if (s.instructor_id) g.pre.push(Number(s.instructor_id));
      LS.candidates(L, s).forEach((id) => g.cands.add(id));
      if (s.level_max != null && (g.level_max == null || Number(s.level_max) > g.level_max)) g.level_max = Number(s.level_max);
      const why = P.lessons.get(Number(s.id));
      g.lessons.push({ id: Number(s.id), product: m.product || 'Lesson', kind: s.kind, format: s.format, spots_mode: s.spots_mode, starts_at: s.starts_at, ends_at: s.ends_at,
        level_words: levels.range(s.level_min, s.level_max), age_min: s.age_min, age_max: s.age_max, instructor: m.instructor || null,
        capacity: Number(s.capacity), booked: k.booked, held: k.held, open: Math.max(0, Number(s.capacity) - k.booked - k.held), waitlist: waiting.get(Number(s.id)) || 0,
        cap: s.spots_mode === 'staff' ? LS.capOf(s) : null, reason: why ? LS.reasonWords(why) : null, follows_staff: s.spots_mode === 'staff' });
      byKey.set(key, g);
    }
    const ratio = (g) => Math.max(1, Number(g.band === 'kids' ? L.set.ratio_kids : L.set.ratio_adults) || 1);
    const groups = [...byKey.values()].map((g) => ({ ...g, cands: [...g.cands].filter((id) => !g.pre.includes(id)),
      need: Math.ceil(g.groupBooked / ratio(g)) + g.privatesBooked, need_full: Math.ceil(g.groupCap / ratio(g)) + g.privates,
      rank: (g.adaptive ? 0 : g.band === 'kids' ? 100 : 200) }));
    LS.share(groups);
    const past = date < day(L.now);
    for (const g of groups) {
      g.have = g.taken.length; g.available = g.taken.length + g.spare.length; g.short = Math.max(0, g.need - g.have);
      // Spare at that moment, across every lesson time running then (an instructor counts once).
      const at = groups.filter((x) => x.s <= g.s && x.e > g.s);
      const spareAt = new Set(at.flatMap((x) => [...x.taken, ...x.spare])).size - at.reduce((n, x) => n + x.need, 0);
      g.spare_at = spareAt;
      // A lesson that follows staff and is full below its cap is turning guests away for want of instructors.
      g.staff_full = g.lessons.some((l) => l.follows_staff && l.open === 0 && l.capacity < l.cap);
      g.mark = past ? null : g.short > 0 ? 'red' : g.need_full > g.available || g.staff_full || (g.need > 0 && spareAt < SPARE) ? 'amber' : 'green';
      g.words = g.short ? `Short ${plural(g.short, 'instructor')} ${dayText(date)}, ${clock(g.time)}, ${groupName(g)}` : null;
    }
    // The day's peak: the moment the most instructors are needed at once.
    let peak = { need: 0, have: 0, available: 0, time: null };
    for (const g of groups) {
      const at = groups.filter((x) => x.s <= g.s && x.e > g.s);
      const need = at.reduce((n, x) => n + x.need, 0);
      const avail = new Set(at.flatMap((x) => [...x.taken, ...x.spare])).size;
      if (need > peak.need || (need === peak.need && peak.time === null)) peak = { need, have: new Set(at.flatMap((x) => x.taken)).size, available: avail, time: g.time };
    }
    const order = { red: 3, amber: 2, green: 1 };
    const worst = groups.reduce((m, g) => (g.mark && (!m || order[g.mark] > order[m]) ? g.mark : m), null);
    groups.sort((a, b) => a.time.localeCompare(b.time) || a.discipline.localeCompare(b.discipline) || a.band.localeCompare(b.band));
    out.push({
      date, past, advance: P.advance.get(date), mark: worst, lessons: todays.length,
      booked: groups.reduce((n, g) => n + g.booked, 0), open: groups.reduce((n, g) => n + g.lessons.reduce((k, l) => k + l.open, 0), 0),
      waitlist: groups.reduce((n, g) => n + g.waitlist, 0), need: peak.need, available: peak.available, peak_time: peak.time,
      short: groups.reduce((n, g) => n + g.short, 0),
      groups: groups.map((g) => ({ time: g.time, starts_at: g.s, ends_at: g.e, discipline: g.discipline, band: g.band, level_max: g.level_max, booked: g.booked, held: g.held, capacity: g.capacity,
        open: g.lessons.reduce((k, l) => k + l.open, 0), waitlist: g.waitlist, need: g.need, need_full: g.need_full, have: g.have, available: g.available, short: g.short, mark: g.mark, words: g.words,
        ratio: ratio(g), staff_full: g.staff_full, lessons: g.lessons, free_ids: [...g.taken, ...g.spare] })),
    });
  }
  return { L, days: out };
}

const monthDates = (month) => {
  const [y, m] = month.split('-').map(Number);
  const out = []; for (let d = 1; d <= new Date(Date.UTC(y, m, 0)).getUTCDate(); d += 1) out.push(`${month}-${String(d).padStart(2, '0')}`);
  return out;
};
const strip = (d) => ({ ...d, groups: undefined });

router.get('/staff/fill', school('supervisor'), async (req, res) => {
  const tz = await tzOf(req.auth.tenantId);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : todayIn(tz).slice(0, 7);
  const { L, days } = await fill(req.auth.tenantId, monthDates(month));
  res.json({ month, today: todayIn(tz), ratio_kids: L.set.ratio_kids, ratio_adults: L.set.ratio_adults, days: days.map(strip) });
});

router.get('/staff/fill/day', school('supervisor'), async (req, res) => {
  const date = String(req.query.date || '');
  if (!dateStr.safeParse(date).success) throw bad('Pick a day');
  const { L, days } = await fill(req.auth.tenantId, [date]);
  const d = days[0] || { date, lessons: 0, groups: [], advance: LS.anyAvailability(L, date) === false };
  const asks = await rows(pool, `SELECT a.id, a.offer_id, a.start_time, a.discipline, a.band, a.short_n, a.created_at, o.status FROM lesson_fill_asks a JOIN shift_offers o ON o.tenant_id = a.tenant_id AND o.id = a.offer_id
    WHERE a.tenant_id = ? AND a.on_date = ? ORDER BY a.id`, [req.auth.tenantId, date]);
  for (const a of asks) {
    const sends = await rows(pool, `SELECT x.answer, CONCAT(p.first_name, ' ', p.last_name) AS name FROM shift_offer_sends x JOIN staff s ON s.tenant_id = x.tenant_id AND s.id = x.staff_id
      JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE x.tenant_id = ? AND x.offer_id = ? ORDER BY p.first_name, p.last_name`, [req.auth.tenantId, a.offer_id]);
    a.time = String(a.start_time).slice(0, 5);
    a.asked = sends.map((x) => x.name); a.accepted = sends.filter((x) => x.answer === 'yes').map((x) => x.name); a.declined = sends.filter((x) => x.answer === 'no').map((x) => x.name);
  }
  res.json({ ...d, day_text: dayText(date), groups: (d.groups || []).map((g) => ({ ...g, free_ids: undefined })), asks });
});

// ---------------------------------------------------------------- fill the gap
const askSchema = z.object({ date: dateStr, time: z.string().regex(/^\d{2}:\d{2}$/), discipline: z.enum(['ski', 'snowboard', 'telemark', 'adaptive']), band: z.enum(['kids', 'adults', 'all']) });
router.post('/staff/fill/ask', school('director'), validate(askSchema), async (req, res) => {
  const b = req.body; const tenantId = req.auth.tenantId;
  const tz = await tzOf(tenantId);
  if (b.date < todayIn(tz)) throw bad('That day is over');
  const { days } = await fill(tenantId, [b.date]);
  const g = ((days[0] || {}).groups || []).find((x) => x.time === b.time && x.discipline === b.discipline && x.band === b.band);
  if (!g) throw notFound('Lesson time');
  if (!g.short) throw conflict('That time has the instructors it needs now. Nothing to fill.');
  if (String(g.starts_at) <= nowIn(tz)) throw bad('That lesson time has started');
  const spots = Math.min(20, g.short);
  const note = `${plural(g.booked, 'student')} booked, short ${plural(g.short, 'instructor')}.`;
  // Everyone cleared and not busy then who is not counted already (those are on the numbers): their yes makes them count.
  const sent = await ST.createOffer(tenantId, { starts_at: g.starts_at, ends_at: g.ends_at, discipline: g.discipline, level_max: g.level_max || undefined, kids: g.band === 'kids', spots, note, any_time: true, exclude: g.free_ids }, req, baseUrl(req));
  const [r] = await pool.query('INSERT INTO lesson_fill_asks (tenant_id, offer_id, on_date, start_time, discipline, band, short_n, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, sent.id, b.date, `${b.time}:00`, b.discipline, b.band, g.short, req.auth.userId || null]);
  await audit(pool, req, 'fill_gap', 'lesson_fill_asks', r.insertId, { offer_id: sent.id, date: b.date, time: b.time, short: g.short, sent_to: sent.sent_to });
  const asked = await rows(pool, `SELECT CONCAT(p.first_name, ' ', p.last_name) AS name FROM shift_offer_sends x JOIN staff s ON s.tenant_id = x.tenant_id AND s.id = x.staff_id
    JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE x.tenant_id = ? AND x.offer_id = ? ORDER BY p.first_name`, [tenantId, sent.id]);
  res.status(201).json({ id: r.insertId, offer_id: sent.id, sent_to: sent.sent_to, messages: sent.messages, asked: asked.map((x) => x.name), words: g.words });
});

// ---------------------------------------------------------------- demand
router.get('/staff/demand', school('director'), async (req, res) => res.json(await LD.summary(req.auth.tenantId)));

// ---------------------------------------------------------------- the staffing target on My day
/** Times in the next 14 days short of instructors. For an instructor: only times they are cleared to teach. */
async function needs(tenantId, staffId) {
  const tz = await tzOf(tenantId);
  const today = todayIn(tz);
  const dates = []; for (let i = 0; i < 14; i += 1) dates.push(addDays(today, i));
  const { L, days } = await fill(tenantId, dates);
  const me = staffId ? L.teachers.find((i) => i.id === Number(staffId)) : null;
  const out = [];
  for (const d of days) {
    for (const g of d.groups) {
      if (!g.short || String(g.starts_at) <= L.now) continue;
      if (staffId) {
        if (!me || !ST.suits(me, { discipline: g.discipline, level_max: g.level_max, kids: g.band === 'kids' })) continue;
      }
      out.push({ date: d.date, time: g.time, starts_at: g.starts_at, ends_at: g.ends_at, discipline: g.discipline, band: g.band, short: g.short,
        words: `${dayLong(d.date)} needs ${plural(g.short, 'more person', 'more people')} (${groupName(g)}, ${clock(g.time)})`,
        counted: Boolean(staffId && g.free_ids.includes(Number(staffId))) });
    }
  }
  return out;
}

router.get('/staff/needs', requireRole('instructor', 'manager'), async (req, res) => {
  const mine = req.auth.role === 'instructor';
  if (mine && !req.auth.staffId) return res.json({ data: [] });
  res.json({ data: await needs(req.auth.tenantId, mine ? req.auth.staffId : null) });
});

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
/** "I can work": the instructor is open for that time (joined with any open time that touches it), then spots recount. */
router.post('/staff/needs/can-work', requireRole('instructor', 'manager'), validate(z.object({ date: dateStr, time: z.string().regex(/^\d{2}:\d{2}$/), discipline: z.enum(['ski', 'snowboard', 'telemark', 'adaptive']), band: z.enum(['kids', 'adults', 'all']) })), async (req, res) => {
  const tenantId = req.auth.tenantId; const b = req.body;
  if (!req.auth.staffId) throw forbidden('Your sign-in is not linked to a staff member');
  const list = await needs(tenantId, req.auth.staffId);
  const n = list.find((x) => x.date === b.date && x.time === b.time && x.discipline === b.discipline && x.band === b.band);
  if (!n) throw conflict('That time does not need anyone now, or you are not cleared for it. Thanks for offering!');
  const start = toMin(hhmm(n.starts_at)); const end = day(n.ends_at) === b.date ? toMin(hhmm(n.ends_at)) : 24 * 60 - 1;
  await tx(async (conn) => {
    const existing = await rows(conn, 'SELECT id, start_time, end_time, note FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date = ? FOR UPDATE', [tenantId, req.auth.staffId, b.date]);
    let from = start; let to = end; let note = 'I can work (My day)';
    for (const w of existing) {
      const ws = toMin(String(w.start_time)); const we = toMin(String(w.end_time));
      if (ws <= to && we >= from) { from = Math.min(from, ws); to = Math.max(to, we); note = w.note || note; await conn.query('DELETE FROM instructor_open WHERE tenant_id = ? AND id = ?', [tenantId, w.id]); }
    }
    await conn.query('INSERT INTO instructor_open (tenant_id, staff_id, open_date, start_time, end_time, note) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, req.auth.staffId, b.date, fromMin(from), fromMin(to), note]);
    await audit(conn, req, 'can_work', 'instructor_open', req.auth.staffId, { date: b.date, time: b.time });
  });
  const synced = await LS.sync(pool, tenantId, { dates: [b.date] }, { req });
  res.status(201).json({ ok: true, changed: synced.changed });
});

// ---------------------------------------------------------------- one lesson's reason, and a recount by hand
router.get('/staff/spots/:id', school('supervisor'), async (req, res) => {
  const s = await one(pool, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!s) throw notFound('Lesson');
  const r = await LS.staffSpots(pool, req.auth.tenantId, s);
  res.json({ ...r, capacity: Number(s.capacity), follows_staff: s.spots_mode === 'staff', words: LS.reasonWords(r) });
});
router.post('/staff/sync', school('director'), validate(z.object({ from: dateStr, to: dateStr.optional() })), async (req, res) => {
  const to = req.body.to || req.body.from;
  if (to < req.body.from || addDays(req.body.from, 62) < to) throw bad('Pick up to 62 days');
  res.json(await LS.sync(pool, req.auth.tenantId, { from: req.body.from, to }, { req }));
});

// ---------------------------------------------------------------- the lessons job
/** Lessons that just filled, or have room again: full_at (first time), full_since, reopened_at. Mountain local time. */
async function trackFull(tenantId, tz, today) {
  const now = nowIn(tz);
  const list = await rows(pool, "SELECT id, capacity, full_since FROM lesson_sessions WHERE tenant_id = ? AND status = 'scheduled' AND starts_at > ? AND starts_at < ?", [tenantId, now, `${addDays(today, 22)} 00:00:00`]);
  if (!list.length) return { filled: 0, reopened: 0 };
  const c = await LS.counts(pool, tenantId, list.map((s) => s.id));
  const full = []; const open = [];
  for (const s of list) {
    const k = c.get(Number(s.id));
    const isFull = Number(s.capacity) > 0 && k.booked > 0 && k.booked + k.held >= Number(s.capacity);
    if (isFull && !s.full_since) full.push(s.id); else if (!isFull && s.full_since) open.push(s.id);
  }
  if (full.length) await pool.query('UPDATE lesson_sessions SET full_since = ?, full_at = COALESCE(full_at, ?) WHERE tenant_id = ? AND id IN (?)', [now, now, tenantId, full]);
  if (open.length) await pool.query('UPDATE lesson_sessions SET full_since = NULL, reopened_at = ? WHERE tenant_id = ? AND id IN (?)', [now, tenantId, open]);
  return { filled: full.length, reopened: open.length };
}

async function tick() {
  const tenants = await rows(pool, `SELECT DISTINCT s.tenant_id, t.timezone FROM lesson_sessions s JOIN tenants t ON t.id = s.tenant_id
    WHERE s.status = 'scheduled' AND s.starts_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) AND s.starts_at < DATE_ADD(UTC_TIMESTAMP(), INTERVAL 23 DAY)`);
  const out = { tenants: 0, changed: 0, filled: 0, reopened: 0 };
  for (const t of tenants) {
    try {
      const today = todayIn(t.timezone);
      const r = await LS.sync(pool, Number(t.tenant_id), { from: today, to: addDays(today, 21) });
      const f = await trackFull(Number(t.tenant_id), t.timezone, today);
      out.tenants += 1; out.changed += r.changed; out.filled += f.filled; out.reopened += f.reopened;
    } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', job: 'lessons_tick', part: 'staff', tenant: t.tenant_id, message: err.message }));
    }
  }
  return out;
}
async function daily() { return {}; }

module.exports = { router, tick, daily, fill, needs, trackFull };
