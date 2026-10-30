'use strict';
// Never lose sold-out demand (2026.11.9, Track STAFF). For each weekday, start time, discipline and age band over the
// season so far: how often its lessons filled, how many days ahead, waitlist sign-ups, booking page searches that found it
// full, and lessons booked. From that, suggestions for the director ("Add a 10:00 AM kids pool on Saturdays"). Suggestions
// only: nothing is ever added by itself. The director adds the slot in the season plan.
//   When a lesson fills: lesson_sessions.full_at (the lessons job, routes/schoolstaff.js tick).
//   Searches that found it full: noteFull(), called by the booking page (Track GUEST) when a guest's lesson is full.
const { pool, one, rows } = require('../db');
const { addDays, todayIn, weekdayOf, seasonFor } = require('./util');

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const bandOf = (s) => (s.age_max != null && Number(s.age_max) <= 12 ? 'kids' : s.age_min != null && Number(s.age_min) >= 13 ? 'adults' : 'all');
const clock = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const plural = (n, one_, many) => `${n} ${n === 1 ? one_ : many || `${one_}s`}`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
const bandWords = (band) => (band === 'kids' ? 'kids ' : band === 'adults' ? 'adult ' : '');
const discWords = (d) => (d === 'ski' ? 'ski' : d);

const MAX_SEARCHES = 200; // per lesson: plenty to show demand, and a ceiling on what one lesson can write

/**
 * A guest looked for this lesson and found it full. visitor: something that tells visitors apart (the booking page passes
 * the address); it is stored only as a hash with the day, so one visitor counts once per lesson per day. Safe to call from
 * anywhere; never throws. Returns true when a search was noted.
 */
async function noteFull(db, tenantId, sessionId, { visitor = null } = {}) {
  try {
    const d = db || pool;
    const sha = visitor ? require('crypto').createHash('sha256').update(`${tenantId}|${visitor}|${new Date().toISOString().slice(0, 10)}`).digest('hex') : null;
    if (sha && await one(d, 'SELECT id FROM lesson_full_searches WHERE tenant_id = ? AND session_id = ? AND visitor_sha = ? LIMIT 1', [tenantId, sessionId, sha])) return false;
    const n = await one(d, 'SELECT COUNT(*) AS n FROM lesson_full_searches WHERE tenant_id = ? AND session_id = ?', [tenantId, sessionId]);
    if (Number(n.n) >= MAX_SEARCHES) return false;
    await d.query('INSERT INTO lesson_full_searches (tenant_id, session_id, visitor_sha) VALUES (?, ?, ?)', [tenantId, sessionId, sha]);
    return true;
  } catch (err) {
    console.error(JSON.stringify({ severity: 'WARNING', part: 'lessondemand', message: err.message }));
    return false;
  }
}

/**
 * Demand per weekday, time, discipline and band from the start of the season through the next 21 days (lessons ahead
 * that already filled count too). Returns { from, to, rows: [...], suggestions: [...] }, busiest first.
 */
async function summary(tenantId, { today: asOf } = {}) {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = asOf || todayIn(t.timezone);
  const from = `${seasonFor(today).slice(0, 4)}-08-01`;
  const to = addDays(today, 21);
  const lessons = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.age_min, s.age_max, s.capacity, s.kind, s.full_at, s.format,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended','no_show')) AS booked,
      (SELECT COUNT(*) FROM lesson_waitlist w WHERE w.tenant_id = s.tenant_id AND w.session_id = s.id) AS waitlist,
      (SELECT COUNT(*) FROM lesson_full_searches f WHERE f.tenant_id = s.tenant_id AND f.session_id = s.id) AS searches
    FROM lesson_sessions s WHERE s.tenant_id = ? AND s.status = 'scheduled' AND s.format = 'group' AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at`,
  [tenantId, `${from} 00:00:00`, `${to} 00:00:00`]);
  const groups = new Map();
  for (const s of lessons) {
    const date = String(s.starts_at).slice(0, 10); const time = String(s.starts_at).slice(11, 16); const band = bandOf(s);
    const key = `${weekdayOf(date)}|${time}|${s.discipline}|${band}`;
    const g = groups.get(key) || { weekday: weekdayOf(date), time, discipline: s.discipline, band, days: new Set(), filled: new Set(), ahead: [], waitlist: 0, searches: 0, booked: 0, capacity: 0, lessons: 0, pools: 0, minutes: 0 };
    if (date < today || s.full_at) g.days.add(date); // a day ahead counts once it has filled
    g.lessons += 1; g.booked += Number(s.booked); g.capacity += Number(s.capacity); g.waitlist += Number(s.waitlist); g.searches += Number(s.searches);
    if (s.kind === 'pool') g.pools += 1;
    g.minutes = Math.max(g.minutes, Math.round((Date.parse(String(s.ends_at).replace(' ', 'T')) - Date.parse(String(s.starts_at).replace(' ', 'T'))) / 60000));
    if (s.full_at) { if (!g.filled.has(date)) g.ahead.push(Math.max(0, daysBetween(String(s.full_at).slice(0, 10), date))); g.filled.add(date); }
    groups.set(key, g);
  }
  const startTimes = new Set([...groups.values()].map((g) => `${g.weekday}|${g.time}|${g.discipline}|${g.band}`));
  const out = [...groups.values()].map((g) => {
    const days = g.days.size; const filled = g.filled.size;
    const ahead = g.ahead.length ? Math.round(g.ahead.reduce((a, b) => a + b, 0) / g.ahead.length) : null;
    const row = { weekday: g.weekday, day_name: WEEKDAY[g.weekday], time: g.time, discipline: g.discipline, band: g.band, days, filled, days_ahead: ahead, waitlist: g.waitlist, searches: g.searches, booked: g.booked, lessons: g.lessons };
    row.words = `${SHORT[g.weekday]} ${clock(g.time)} ${bandWords(g.band)}${discWords(g.discipline)} filled ${filled} of the last ${plural(days, WEEKDAY[g.weekday], `${WEEKDAY[g.weekday]}s`)}${ahead !== null && filled ? `, ${plural(ahead, 'day')} ahead on average` : ''}${g.waitlist ? `, ${g.waitlist} on the waitlist` : ''}${g.searches ? `, ${plural(g.searches, 'search', 'searches')} found it full` : ''}.`;
    // A suggestion when it fills most weeks (at least twice), or turned many guests away.
    const turnedAway = g.waitlist + g.searches;
    if (filled >= 2 && (filled / days >= 0.5 || turnedAway >= 10)) {
      const perDay = turnedAway / Math.max(1, filled);
      const early = ahead !== null && ahead >= 2 ? (g.capacity / Math.max(1, g.lessons)) * 0.25 : 0; // filled days ahead: the late buyers never got to try
      const more = Math.max(1, Math.round(perDay + early));
      let next = null;
      for (const step of [30, 60, 90]) {
        const [hh, mm] = g.time.split(':').map(Number); const m = hh * 60 + mm + step;
        const cand = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        if (!startTimes.has(`${g.weekday}|${cand}|${g.discipline}|${g.band}`) && m < 21 * 60) { next = cand; break; }
      }
      if (next) {
        row.suggestion = {
          time: next, weekday: g.weekday, discipline: g.discipline, band: g.band, more,
          words: `Add a ${clock(next)} ${bandWords(g.band)}${discWords(g.discipline)} ${g.pools ? 'pool' : 'lesson'} on ${WEEKDAY[g.weekday]}s: about ${plural(more, 'more lesson')} each ${WEEKDAY[g.weekday]}.`,
        };
      }
    }
    row.score = filled * 10 + turnedAway;
    return row;
  }).filter((r) => r.filled || r.waitlist || r.searches);
  out.sort((a, b) => b.score - a.score || a.weekday - b.weekday || a.time.localeCompare(b.time));
  return { from, to: addDays(to, -1), rows: out, suggestions: out.filter((r) => r.suggestion).map((r) => ({ ...r.suggestion, why: r.words })) };
}

module.exports = { noteFull, summary, bandOf };
