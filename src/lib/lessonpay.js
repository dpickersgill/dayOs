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
/** UTC milliseconds of a mountain wall-clock time ('YYYY-MM-DD HH:MM:SS'), two passes over the zone offset. */
function utcMs(local, tz) {
  const g = Date.parse(`${String(local).replace(' ', 'T').slice(0, 19)}Z`);
  if (!tz) return g;
  const off = (ms) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms; };
  let t = g - off(g); t = g - off(t);
  return t;
}
/** Real minutes between two mountain wall-clock times: a lesson across a daylight saving change is paid for the time it ran (2026.11.11). */
const zoneMinutes = (a, b, tz) => Math.max(Math.round((utcMs(b, tz) - utcMs(a, tz)) / 60000), 0);
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

// ---- the pay ladder (feat/school-pay): a rate by certification level, and add-ons for specialist credentials.
const CERTS = ['psia1', 'psia2', 'psia3', 'psia_te', 'csia1', 'csia2', 'csia3', 'csia4', 'casi1', 'casi2', 'casi3', 'casi4'];
const CERT_WORDS = { none: 'None yet', psia1: 'PSIA-AASI Level 1', psia2: 'PSIA-AASI Level 2', psia3: 'PSIA-AASI Level 3', psia_te: 'PSIA-AASI Trainer/Examiner',
  csia1: 'CSIA Level 1', csia2: 'CSIA Level 2', csia3: 'CSIA Level 3', csia4: 'CSIA Level 4', casi1: 'CASI Level 1', casi2: 'CASI Level 2', casi3: 'CASI Level 3', casi4: 'CASI Level 4' };
const CREDENTIALS = ['kids1', 'kids2', 'freestyle', 'adaptive'];
const CREDENTIAL_WORDS = { kids1: "Children's Specialist 1", kids2: "Children's Specialist 2", freestyle: 'Freestyle Specialist', adaptive: 'Adaptive' };
/** The old certification values (before 2026.11.12's pay ladder) mean PSIA-AASI. */
const certOf = (v) => ({ level1: 'psia1', level2: 'psia2', level3: 'psia3' }[v] || (CERTS.includes(v) ? v : 'none'));
const latest = (list, day) => {
  let r = null;
  for (const x of list) if (String(x.effective_from).slice(0, 10) <= day && (!r || x.effective_from > r.effective_from)) r = x;
  return r;
};

/**
 * Everything that sets an instructor's rate: their own rates, the ladder by their certification level, and the school
 * default, in that order (a person's own rate always wins). rate(staffId, kind, day) -> cents or null; source() says which
 * one applied; addons(staffId, lesson, day, { minutes, hourly }) -> pay parts for credentials that fit the lesson.
 */
async function rateBook(db, tenantId) {
  const own = await loadRates(db, tenantId);
  let ladder = []; let profiles = [];
  try {
    ladder = await rows(db, 'SELECT rung, kind, cents, effective_from FROM school_pay_ladder WHERE tenant_id = ?', [tenantId]);
    profiles = await rows(db, 'SELECT staff_id, psia_level, credentials FROM instructor_profiles WHERE tenant_id = ?', [tenantId]);
  } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE' && err.code !== 'ER_BAD_FIELD_ERROR') throw err; }
  const prof = new Map(profiles.map((p) => [Number(p.staff_id), { cert: certOf(p.psia_level), creds: String(p.credentials || '').split(',').filter(Boolean) }]));
  const ownOf = (staffId, kind, day) => latest(own.filter((r) => r.kind === kind && r.staff_id !== null && Number(r.staff_id) === Number(staffId)), day);
  const ladderOf = (rung, kind, day) => latest(ladder.filter((r) => r.rung === rung && r.kind === kind), day);
  const dfltOf = (kind, day) => latest(own.filter((r) => r.kind === kind && r.staff_id === null), day);
  function source(staffId, kind, day) {
    const o = ownOf(staffId, kind, day);
    if (o) return { cents: Number(o.cents), from: 'own' };
    const p = prof.get(Number(staffId));
    const l = p && p.cert !== 'none' ? ladderOf(p.cert, kind, day) : null;
    if (l) return { cents: Number(l.cents), from: 'ladder', rung: p.cert };
    const d = dfltOf(kind, day);
    return d ? { cents: Number(d.cents), from: 'default' } : null;
  }
  const rate = (staffId, kind, day) => { const x = source(staffId, kind, day); return x ? x.cents : null; };
  /** Credentials that fit the lesson: Children's Specialist (the higher one) on a lesson for under 18s, Adaptive on an adaptive lesson, Freestyle on a park or freestyle lesson. */
  function fitting(staffId, l) {
    const p = prof.get(Number(staffId));
    if (!p || !p.creds.length) return [];
    const out = [];
    const kids = (l.age_max != null && Number(l.age_max) <= 17) || ['kids', 'teens'].includes(l.age_group);
    if (kids && p.creds.includes('kids2')) out.push('kids2'); else if (kids && p.creds.includes('kids1')) out.push('kids1');
    if (l.discipline === 'adaptive' && p.creds.includes('adaptive')) out.push('adaptive');
    if (/park|freestyle|terrain/i.test(`${l.product || ''}`) && p.creds.includes('freestyle')) out.push('freestyle');
    return out;
  }
  /** Add-on parts for a lesson. Not paid on a kind of line where the instructor has their own rate (their rate wins). */
  function addons(staffId, l, day, { minutes = 0, hourly = false, format = null } = {}) {
    const parts = [];
    for (const c of fitting(staffId, l)) {
      const per = ladderOf(c, 'lesson_addon', day);
      if (per && Number(per.cents) && !(format && ownOf(staffId, format, day))) parts.push({ label: `${CREDENTIAL_WORDS[c]} add-on`, cents: Number(per.cents) });
      const hr = hourly ? ladderOf(c, 'hourly_addon', day) : null;
      if (hr && Number(hr.cents) && minutes && !ownOf(staffId, 'hourly', day)) parts.push({ label: `${CREDENTIAL_WORDS[c]} hourly add-on`, cents: prorate(hr.cents, minutes) });
    }
    return parts;
  }
  return { rate, source, addons, profileOf: (id) => prof.get(Number(id)) || { cert: 'none', creds: [] } };
}

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
  const book = await rateBook(db, tenantId);
  const rateFor = (staff, kind, day) => book.rate(staff, kind, day);
  const mode = settings.pay_mode;
  const hourlyOn = mode === 'hourly' || mode === 'both';
  const lessonRateOn = mode === 'per_lesson' || mode === 'both';
  const who = staffId ? ' AND s.instructor_id = ?' : ' AND s.instructor_id IS NOT NULL';
  const args = staffId ? [tenantId, from, to, staffId] : [tenantId, from, to];

  const lessons = await rows(db, `SELECT s.id, s.instructor_id, s.starts_at, s.ends_at, s.format, s.discipline, s.status, s.delay_minutes, s.age_max, s.age_group, pr.name AS product,
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
    const minutes = zoneMinutes(l.starts_at, l.ends_at, tz);
    const parts = []; const notes = [];
    if (!Number(l.students)) {
      out.push({ key: `lesson:${l.id}`, staff_id: l.instructor_id, kind: 'lesson', day, starts_at: l.starts_at, ends_at: l.ends_at, title: l.product, session_id: l.id, minutes, cents: 0, parts, words: '', note: 'No students booked, so no pay for this lesson yet.' });
      continue;
    }
    const fmtRate = rateFor(l.instructor_id, l.format, day);
    if (lessonRateOn) {
      if (fmtRate === null) notes.push(`No ${KIND_WORDS[l.format]} rate is set.`);
      else parts.push({ label: KIND_WORDS[l.format], cents: fmtRate });
    }
    if (hourlyOn) {
      const hr = rateFor(l.instructor_id, 'hourly', day);
      if (isClocked(l.instructor_id, day)) notes.push('Hourly pay comes from your time card today.');
      else if (hr === null) notes.push('No hourly rate is set.');
      else { parts.push({ label: `${hoursText(minutes)} lesson time`, cents: prorate(hr, minutes) }); notes.push('Hours from the lesson time (no time card that day).'); }
      // In hourly mode, a private or semi-private rate is paid on top of the hours.
      if (mode === 'hourly' && l.format !== 'group' && fmtRate) parts.push({ label: KIND_WORDS[l.format], cents: fmtRate });
    }
    // Specialist credential add-ons from the pay ladder (a per-lesson add-on with the lesson rate, an hourly add-on with hourly pay)
    parts.push(...book.addons(l.instructor_id, l, day, { minutes, hourly: hourlyOn, format: lessonRateOn ? l.format : null }));
    if (Number(l.requested) > 0 && settings.request_bonus_cents > 0) parts.push({ label: 'request', cents: Number(settings.request_bonus_cents) });
    const cents = parts.reduce((n, p) => n + p.cents, 0);
    out.push({ key: `lesson:${l.id}`, staff_id: l.instructor_id, kind: 'lesson', day, starts_at: l.starts_at, ends_at: l.ends_at, title: l.product, session_id: l.id, minutes, cents, parts, words: wordsOf(parts), note: notes.join(' ') || null, requested: Number(l.requested) > 0 });
  }

  // ---- lineup time: once per start time of the instructor's group lessons with students
  if (settings.lineup_paid && settings.lineup_minutes > 0) {
    const seen = new Set();
    for (const l of lessons) {
      if (l.format !== 'group' || !Number(l.students)) continue;
      // Keyed by the lineup's first start time: a weather delay moves starts_at (and notes delay_minutes), and must not
      // make a second lineup line for the same lineup, in this export or a later one.
      const first = minusMinutes(l.starts_at, Number(l.delay_minutes || 0));
      const k = `${l.instructor_id}|${first}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const day = l.starts_at.slice(0, 10);
      if (hourlyOn && isClocked(l.instructor_id, day)) continue; // the time card already has it
      const hr = rateFor(l.instructor_id, 'hourly', day);
      const cents = hr === null ? 0 : prorate(hr, settings.lineup_minutes);
      out.push({ key: `lineup:${first.replace(' ', 'T').slice(0, 16)}`, staff_id: l.instructor_id, kind: 'lineup', day, starts_at: l.starts_at, ends_at: l.starts_at, done_at: l.ends_at, title: `Lineup, ${settings.lineup_minutes} minutes`, session_id: l.id, minutes: settings.lineup_minutes, cents,
        parts: cents ? [{ label: 'lineup', cents }] : [], words: cents ? `lineup ${amount(cents)}` : '', note: hr === null ? 'No hourly rate is set, so lineup time pays nothing.' : null });
    }
  }

  // ---- program meetings
  for (const m of meetings) {
    const day = m.starts_at.slice(0, 10);
    const minutes = zoneMinutes(m.starts_at, m.ends_at, tz);
    const parts = []; const notes = [];
    const pr = rateFor(m.staff_id, 'program', day);
    if (pr !== null) parts.push({ label: 'program meeting', cents: pr });
    if (hourlyOn) {
      const hr = rateFor(m.staff_id, 'hourly', day);
      if (isClocked(m.staff_id, day)) notes.push('Hourly pay comes from your time card today.');
      else if (hr !== null) parts.push({ label: `${hoursText(minutes)} coaching`, cents: prorate(hr, minutes) });
    }
    if (pr === null && !parts.length && !notes.length) notes.push('No program rate is set.');
    const cents = parts.reduce((n, p) => n + p.cents, 0);
    out.push({ key: `program:${m.id}`, staff_id: m.staff_id, kind: 'program', day, starts_at: m.starts_at, ends_at: m.ends_at, title: m.program, program_session_id: m.id, minutes, cents, parts, words: wordsOf(parts), note: notes.join(' ') || null });
  }

  // ---- training time (feat/school-pay): each session the director logged, for each instructor there, at the hourly
  // rate. Not added on a day the instructor's time card is paid (the time card already has it), like lineup time.
  let trainings = [];
  try {
    trainings = await rows(db, `SELECT t.id, t.title, t.starts_at, t.ends_at, a.staff_id, a.minutes FROM school_trainings t
        JOIN school_training_staff a ON a.tenant_id = t.tenant_id AND a.training_id = t.id
      WHERE t.tenant_id = ? AND t.status = 'held' AND DATE(t.starts_at) BETWEEN ? AND ?${staffId ? ' AND a.staff_id = ?' : ''} ORDER BY t.starts_at`, staffId ? [tenantId, from, to, staffId] : [tenantId, from, to]);
  } catch (err) { if (err.code !== 'ER_NO_SUCH_TABLE') throw err; }
  for (const tr of trainings) {
    const day = tr.starts_at.slice(0, 10);
    const minutes = tr.minutes != null ? Number(tr.minutes) : zoneMinutes(tr.starts_at, tr.ends_at, tz);
    const clockedDay = hourlyOn && isClocked(tr.staff_id, day);
    const hr = rateFor(tr.staff_id, 'hourly', day);
    const cents = clockedDay || hr === null ? 0 : prorate(hr, minutes);
    out.push({ key: `training:${tr.id}`, staff_id: tr.staff_id, kind: 'training', day, starts_at: tr.starts_at, ends_at: tr.ends_at, title: `Training: ${tr.title}, ${hoursText(minutes)}`, training_id: tr.id, minutes, cents,
      parts: cents ? [{ label: 'training', cents }] : [], words: cents ? `training ${amount(cents)}` : '',
      note: clockedDay ? 'Paid from your time card that day.' : hr === null ? 'No hourly rate is set, so training time pays nothing.' : null });
  }

  // ---- clocked time, one line per day, for the instructors who teach in this range (the time clock is shared with
  // every other department, whose hours are paid elsewhere)
  const teachers = new Set([...lessons.map((l) => l.instructor_id), ...meetings.map((m) => m.staff_id), ...trainings.map((x) => x.staff_id)]);
  for (const [k, minutes] of clocked) {
    const [sid, day] = k.split('|'); const staff = Number(sid);
    if (!teachers.has(staff) || minutes < 1) continue;
    const hr = rateFor(staff, 'hourly', day);
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

/** 'YYYY-MM-DD HH:MM:SS' minus minutes, as wall-clock arithmetic. */
function minusMinutes(dt, minutes) {
  const d = new Date(`${String(dt).replace(' ', 'T').slice(0, 19)}Z`);
  d.setUTCMinutes(d.getUTCMinutes() - minutes);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Has the work on this line happened, so it can be paid? A lesson, lineup or program meeting once its lesson has ended
 * (mountain time); a time card once its day is over; a tip once it is paid (tips come only after a lesson).
 */
function lineDone(l, nowLocal) {
  if (l.tip) return true;
  if (l.kind === 'clock') return l.day < String(nowLocal).slice(0, 10);
  return String(l.done_at || l.ends_at) <= String(nowLocal);
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

module.exports = { KINDS, KIND_WORDS, CERTS, CERT_WORDS, CREDENTIALS, CREDENTIAL_WORDS, certOf, rateBook, lines, byInstructor, forMyDay, rateFrom, wordsOf, amount, lineDone, minusMinutes, zoneMinutes };
