'use strict';
// Instructor pay for the ski school (Track PAY). One function, lines(), works out every pay line for a date range, and
// My day, My pay and payroll all read from it, so the instructor and the payroll export always show the same numbers.
//
// The school chooses how it pays in Settings, Ski school, Pay (school_settings):
//   pay_mode per_lesson: each lesson pays its rate (group, semi_private or private).
//   pay_mode hourly:     each lesson pays the hourly rate for its length, unless the instructor clocked in that day, when
//                        the clocked time is paid instead. A private or semi-private rate, when set, is paid on top.
//   pay_mode both:       the lesson rate and the hourly pay together.
//   lineup_paid:         lineup_minutes at the hourly rate, once per start time of the instructor's group lessons that day
//                        (back-to-back lessons that start at different times are separate lineups; two at once are one).
//                        Not added when clocked time is paid, since the time card already covers it.
//   request_bonus_cents: added to a lesson when a guest on it asked for this instructor by name.
//   program meetings pay the program rate per meeting, plus hourly pay in the hourly and both modes.
// Rates live in instructor_pay_rates: the instructor's own rate when they have one, else the school default, each the
// latest one in force on the day. Tips (lesson_tips, status paid) are listed separately: they pass straight through.
const { rows } = require('../db');
const S = require('./schoolsettings');
const { dayRange, addDays } = require('./util');

const KINDS = ['group', 'semi_private', 'private', 'hourly', 'program'];
const KIND_WORDS = { group: 'group lesson', semi_private: 'semi-private', private: 'private', hourly: 'hourly', program: 'program meeting' };
const amount = (cents) => (Number(cents || 0) / 100).toFixed(2);
const minutesBetween = (a, b) => Math.max(Math.round((Date.parse(`${String(b).replace(' ', 'T').slice(0, 19)}Z`) - Date.parse(`${String(a).replace(' ', 'T').slice(0, 19)}Z`)) / 60000), 0);
const hoursText = (min) => { const h = Math.round((min / 60) * 100) / 100; return `${h} h`; };
const prorate = (cents, minutes) => Math.round((Number(cents) * minutes) / 60);

/** The rate in force for this instructor, kind and day: theirs first, then the school default. null when none is set. */
function rateFrom(rates, staffId, kind, day) {
  let mine = null; let dflt = null;
  for (const r of rates) {
    if (r.kind !== kind || String(r.effective_from).slice(0, 10) > day) continue;
    if (r.staff_id === staffId) { if (!mine || r.effective_from > mine.effective_from) mine = r; } else if (r.staff_id === null) { if (!dflt || r.effective_from > dflt.effective_from) dflt = r; }
  }
  const r = mine || dflt;
  return r ? Number(r.cents) : null;
}
const loadRates = (db, tenantId) => rows(db, 'SELECT staff_id, kind, cents, effective_from FROM instructor_pay_rates WHERE tenant_id = ? ORDER BY effective_from', [tenantId]);

/** A line's parts as words: "private 36.00 + request 6.00". */
const wordsOf = (parts) => parts.filter((p) => p.cents).map((p) => `${p.label} ${amount(p.cents)}`).join(' + ');

/**
 * Every pay line from `from` to `to` (mountain days, inclusive). staffId limits it to one instructor. tipsMode 'lesson'
 * lists tips by the lesson's day (My pay); 'unpaid' lists every paid tip not yet paid out by the end of the period (payroll).
 * Returns { settings, lines: [{ key, staff_id, kind, day, starts_at, ends_at, title, session_id, program_session_id,
 * minutes, cents, parts, words, note, tip }] } in time order. Tips have tip: true and are not part of pay.
 */
async function lines(db, tenantId, { from, to, staffId = null, tipsMode = 'lesson' }) {
  const settings = await S.get(db, tenantId);
  const tz = (await rows(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]))[0].timezone;
  const rates = await loadRates(db, tenantId);
  const mode = settings.pay_mode;
  const hourlyOn = mode === 'hourly' || mode === 'both';
  const lessonRateOn = mode === 'per_lesson' || mode === 'both';
  const who = staffId ? ' AND s.instructor_id = ?' : ' AND s.instructor_id IS NOT NULL';
  const args = staffId ? [tenantId, from, to, staffId] : [tenantId, from, to];

  const lessons = await rows(db, `SELECT s.id, s.instructor_id, s.starts_at, s.ends_at, s.format, s.discipline, s.status, pr.name AS product,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status <> 'cancelled') AS students,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status <> 'cancelled' AND b.requested_instructor_id = s.instructor_id) AS requested
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE s.tenant_id = ? AND DATE(s.starts_at) BETWEEN ? AND ? AND s.status <> 'cancelled'${who} ORDER BY s.starts_at, s.id`, args);

  const meetings = await rows(db, `SELECT ps.id, ps.starts_at, ps.ends_at, p.name AS program, c.staff_id FROM program_sessions ps
      JOIN programs p ON p.tenant_id = ps.tenant_id AND p.id = ps.program_id
      JOIN (SELECT tenant_id, id AS sid, coach_staff_id AS staff_id FROM program_sessions WHERE tenant_id = ? AND coach_staff_id IS NOT NULL
            UNION SELECT ps2.tenant_id, ps2.id, pl.coach_staff_id FROM program_sessions ps2 JOIN program_levels pl ON pl.tenant_id = ps2.tenant_id AND pl.group_id = ps2.group_id
            WHERE ps2.tenant_id = ? AND pl.coach_staff_id IS NOT NULL) c ON c.tenant_id = ps.tenant_id AND c.sid = ps.id
    WHERE ps.tenant_id = ? AND DATE(ps.starts_at) BETWEEN ? AND ? AND ps.status = 'scheduled'${staffId ? ' AND c.staff_id = ?' : ''} ORDER BY ps.starts_at`,
  staffId ? [tenantId, tenantId, tenantId, from, to, staffId] : [tenantId, tenantId, tenantId, from, to]);

  // Clocked time per instructor per day (time_entries are UTC; a day is the mountain's day). Only read when hourly pay is on.
  const clocked = new Map(); // `${staff}|${day}` -> minutes
  if (hourlyOn) {
    const [startUtc] = dayRange(tz, from); const [, endUtc] = dayRange(tz, to);
    const entries = await rows(db, `SELECT staff_id, clock_in, COALESCE(clock_out, UTC_TIMESTAMP()) AS clock_out FROM time_entries WHERE tenant_id = ? AND clock_in >= ? AND clock_in < ?${staffId ? ' AND staff_id = ?' : ''}`,
      staffId ? [tenantId, startUtc, endUtc, staffId] : [tenantId, startUtc, endUtc]);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const [a, b] = dayRange(tz, d);
      for (const e of entries) {
        if (e.clock_in < a || e.clock_in >= b) continue;
        const k = `${e.staff_id}|${d}`;
        clocked.set(k, (clocked.get(k) || 0) + minutesBetween(e.clock_in, e.clock_out));
      }
    }
  }
  const isClocked = (sid, day) => clocked.has(`${sid}|${day}`);

  const out = [];
  // ---- lessons
  for (const l of lessons) {
    const day = l.starts_at.slice(0, 10);
    const minutes = minutesBetween(l.starts_at, l.ends_at);
    const parts = []; const notes = [];
    if (!Number(l.students)) {
      out.push({ key: `lesson:${l.id}`, staff_id: l.instructor_id, kind: 'lesson', day, starts_at: l.starts_at, ends_at: l.ends_at, title: l.product, session_id: l.id, minutes, cents: 0, parts, words: '', note: 'No students booked, so no pay for this lesson yet.' });
      continue;
    }
    const fmtRate = rateFrom(rates, l.instructor_id, l.format, day);
    if (lessonRateOn) {
      if (fmtRate === null) notes.push(`No ${KIND_WORDS[l.format]} rate is set.`);
      else parts.push({ label: KIND_WORDS[l.format], cents: fmtRate });
    }
    if (hourlyOn) {
      const hr = rateFrom(rates, l.instructor_id, 'hourly', day);
      if (isClocked(l.instructor_id, day)) notes.push('Hourly pay comes from your time card today.');
      else if (hr === null) notes.push('No hourly rate is set.');
      else { parts.push({ label: `${hoursText(minutes)} lesson time`, cents: prorate(hr, minutes) }); notes.push('Hours from the lesson time (no time card that day).'); }
      // In hourly mode, a private or semi-private rate is paid on top of the hours.
      if (mode === 'hourly' && l.format !== 'group' && fmtRate) parts.push({ label: KIND_WORDS[l.format], cents: fmtRate });
    }
    if (Number(l.requested) > 0 && settings.request_bonus_cents > 0) parts.push({ label: 'request', cents: Number(settings.request_bonus_cents) });
    const cents = parts.reduce((n, p) => n + p.cents, 0);
    out.push({ key: `lesson:${l.id}`, staff_id: l.instructor_id, kind: 'lesson', day, starts_at: l.starts_at, ends_at: l.ends_at, title: l.product, session_id: l.id, minutes, cents, parts, words: wordsOf(parts), note: notes.join(' ') || null, requested: Number(l.requested) > 0 });
  }

  // ---- lineup time: once per start time of the instructor's group lessons with students
  if (settings.lineup_paid && settings.lineup_minutes > 0) {
    const seen = new Set();
    for (const l of lessons) {
      if (l.format !== 'group' || !Number(l.students)) continue;
      const k = `${l.instructor_id}|${l.starts_at}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const day = l.starts_at.slice(0, 10);
      if (hourlyOn && isClocked(l.instructor_id, day)) continue; // the time card already has it
      const hr = rateFrom(rates, l.instructor_id, 'hourly', day);
      const cents = hr === null ? 0 : prorate(hr, settings.lineup_minutes);
      out.push({ key: `lineup:${l.starts_at.replace(' ', 'T').slice(0, 16)}`, staff_id: l.instructor_id, kind: 'lineup', day, starts_at: l.starts_at, ends_at: l.starts_at, title: `Lineup, ${settings.lineup_minutes} minutes`, session_id: l.id, minutes: settings.lineup_minutes, cents,
        parts: cents ? [{ label: 'lineup', cents }] : [], words: cents ? `lineup ${amount(cents)}` : '', note: hr === null ? 'No hourly rate is set, so lineup time pays nothing.' : null });
    }
  }

  // ---- program meetings
  for (const m of meetings) {
    const day = m.starts_at.slice(0, 10);
    const minutes = minutesBetween(m.starts_at, m.ends_at);
    const parts = []; const notes = [];
    const pr = rateFrom(rates, m.staff_id, 'program', day);
    if (pr !== null) parts.push({ label: 'program meeting', cents: pr });
    if (hourlyOn) {
      const hr = rateFrom(rates, m.staff_id, 'hourly', day);
      if (isClocked(m.staff_id, day)) notes.push('Hourly pay comes from your time card today.');
      else if (hr !== null) parts.push({ label: `${hoursText(minutes)} coaching`, cents: prorate(hr, minutes) });
    }
    if (pr === null && !parts.length && !notes.length) notes.push('No program rate is set.');
    const cents = parts.reduce((n, p) => n + p.cents, 0);
    out.push({ key: `program:${m.id}`, staff_id: m.staff_id, kind: 'program', day, starts_at: m.starts_at, ends_at: m.ends_at, title: m.program, program_session_id: m.id, minutes, cents, parts, words: wordsOf(parts), note: notes.join(' ') || null });
  }

  // ---- clocked time, one line per day, for the instructors who teach in this range (the time clock is shared with
  // every other department, whose hours are paid elsewhere)
  const teachers = new Set([...lessons.map((l) => l.instructor_id), ...meetings.map((m) => m.staff_id)]);
  for (const [k, minutes] of clocked) {
    const [sid, day] = k.split('|'); const staff = Number(sid);
    if (!teachers.has(staff) || minutes < 1) continue;
    const hr = rateFrom(rates, staff, 'hourly', day);
    const cents = hr === null ? 0 : prorate(hr, minutes);
    out.push({ key: `clock:${day}`, staff_id: staff, kind: 'clock', day, starts_at: `${day} 00:00:00`, ends_at: `${day} 00:00:00`, title: `Time card, ${hoursText(minutes)}`, minutes, cents,
      parts: cents ? [{ label: `${hoursText(minutes)} clocked`, cents }] : [], words: cents ? `${hoursText(minutes)} clocked ${amount(cents)}` : '', note: hr === null ? 'No hourly rate is set.' : null });
  }

  // ---- tips: passed through in full, never part of pay
  const tipRows = tipsMode === 'unpaid'
    ? await rows(db, `SELECT t.id, t.staff_id, t.session_id, t.amount_cents, t.paid_at, s.starts_at, pr.name AS product FROM lesson_tips t
        JOIN lesson_sessions s ON s.tenant_id = t.tenant_id AND s.id = t.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
        WHERE t.tenant_id = ? AND t.status = 'paid' AND t.paid_out_at IS NULL AND DATE(s.starts_at) <= ?${staffId ? ' AND t.staff_id = ?' : ''}`, staffId ? [tenantId, to, staffId] : [tenantId, to])
    : await rows(db, `SELECT t.id, t.staff_id, t.session_id, t.amount_cents, t.paid_at, t.paid_out_at, s.starts_at, pr.name AS product FROM lesson_tips t
        JOIN lesson_sessions s ON s.tenant_id = t.tenant_id AND s.id = t.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
        WHERE t.tenant_id = ? AND t.status = 'paid' AND DATE(s.starts_at) BETWEEN ? AND ?${staffId ? ' AND t.staff_id = ?' : ''}`, staffId ? [tenantId, from, to, staffId] : [tenantId, from, to]);
  for (const t of tipRows) {
    out.push({ key: `tip:${t.id}`, staff_id: t.staff_id, kind: 'tip', tip: true, tip_id: t.id, day: t.starts_at.slice(0, 10), starts_at: t.starts_at, ends_at: t.starts_at, title: `Tip, ${t.product}`, session_id: t.session_id, minutes: 0,
      cents: Number(t.amount_cents), parts: [{ label: 'tip', cents: Number(t.amount_cents) }], words: `tip ${amount(t.amount_cents)}`, note: t.paid_out_at ? 'Paid out' : null });
  }
  out.sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : a.kind === 'lineup' ? -1 : 0));
  return { settings, lines: out };
}

/** Lines grouped by instructor with totals: pay (not tips) and tips. */
function byInstructor(list) {
  const map = new Map();
  for (const l of list) {
    if (!map.has(l.staff_id)) map.set(l.staff_id, { staff_id: l.staff_id, lines: [], pay_cents: 0, tips_cents: 0, minutes: 0 });
    const g = map.get(l.staff_id);
    g.lines.push(l);
    if (l.tip) g.tips_cents += l.cents; else g.pay_cents += l.cents;
  }
  // Hours worked: the time card on a day it was used, otherwise lesson, meeting and lineup time.
  for (const g of map.values()) {
    const clockDays = new Set(g.lines.filter((l) => l.kind === 'clock').map((l) => l.day));
    g.minutes = g.lines.reduce((n, l) => n + (l.tip ? 0 : l.kind === 'clock' ? l.minutes : clockDays.has(l.day) ? 0 : l.minutes), 0);
  }
  return [...map.values()];
}

/**
 * The pay line for each lesson on one instructor's day, for My day: { [session_id]: { cents, words, parts, note } }.
 * Lineup pay is folded into the first lesson at that start time.
 */
function forMyDay(list) {
  const out = {};
  for (const l of list) {
    if (l.kind !== 'lesson') continue;
    out[l.session_id] = { cents: l.cents, words: l.words, parts: [...l.parts], note: l.note, requested: Boolean(l.requested) };
  }
  for (const l of list) {
    if (l.kind !== 'lineup' || !out[l.session_id] || !l.cents) continue;
    const o = out[l.session_id];
    o.parts.push(...l.parts); o.cents += l.cents; o.words = wordsOf(o.parts);
  }
  return out;
}

module.exports = { KINDS, KIND_WORDS, lines, byInstructor, forMyDay, rateFrom, wordsOf, amount };
