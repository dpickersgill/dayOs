'use strict';

// The morning brief's facts: small JSON for one mountain, one day and one kind of brief, gathered by code (no AI).
//   ops     owners, managers and the GM: everything below, revenue too
//   patrol  the patrol director: weather and wind holds, lift problems, the park, patrol shifts, yesterday's case counts
//   school  the ski school Director: weather, lessons against instructors, classes over their ratio, school shifts
// Each kind holds only what that role can see on screen, and only for the apps the mountain has on.
//
// Patrol: yesterday's cases as COUNTS BY AREA from one aggregate query (patrolCounts). Never a name, age, injury, story,
// case number or time. test/evals/brief.test.js proves the brief's input holds nothing else from patrol.
//
// The daily snapshots (lib/snapshots.js, table daily_snapshots) are read when they exist: the hourly forecast and the
// presales taken that morning. The daily job takes them at 7:30 AM Eastern, after 6:00 AM in an Eastern mountain, so when
// today's is not there yet the brief takes it (it is then kept as that day's snapshot until the daily job replaces it).
// A snapshot from an earlier day is never used. Without one, the same facts come from small live queries.
//
// Wind: the gusts compared with each lift's wind hold limit are the hourly forecast gusts during the day's operating
// hours (the calendar's open and close) at the base and summit points, the highest of them. The forecast is at 10 m and
// smooths ridges, so it can read low at lift height: every comparison carries WIND_CAVEAT, and the brief never says a lift
// can open or is safe to run.
const { rows, one } = require('../db');
const { addDays, weekdayOf, dayRange, clock } = require('./util');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KINDS = ['ops', 'patrol', 'school'];
const KIND_LABEL = { ops: 'Operations', patrol: 'Patrol', school: 'Ski school' };
const DEPT_LABEL = { lifts: 'Lifts', rentals: 'Rentals', ski_school: 'Ski school', patrol: 'Patrol', food: 'Food', guest_services: 'Guest services', grooming: 'Grooming', maintenance: 'Maintenance', admin: 'Office', attractions: 'Attractions' };

// WMO weather codes (Open-Meteo) in plain words.
function sky(code) {
  const c = Number(code);
  if (code == null || Number.isNaN(c)) return null;
  if (c === 0) return 'Clear';
  if (c <= 2) return 'Partly cloudy';
  if (c === 3) return 'Overcast';
  if (c <= 48) return 'Fog';
  if (c <= 57) return 'Drizzle';
  if (c <= 67) return 'Rain';
  if (c <= 77) return 'Snow';
  if (c <= 82) return 'Rain showers';
  if (c <= 86) return 'Snow showers';
  return 'Thunderstorms';
}

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// ---------------------------------------------------------------- daily snapshots, when that branch is in
let snapCheck = { at: 0, ok: false };
/** Is the daily_snapshots table there (and lib/snapshots.js)? Checked at most every 10 minutes. */
async function hasSnapshots(db) {
  if (Date.now() - snapCheck.at < 600000) return snapCheck.ok;
  let ok = false;
  try {
    require.resolve('./snapshots');
    const r = await one(db, "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'daily_snapshots'");
    ok = Number(r.n) > 0;
  } catch (_) { ok = false; }
  snapCheck = { at: Date.now(), ok };
  return ok;
}
const resetSnapshotCheck = () => { snapCheck = { at: 0, ok: false }; };

/**
 * Today's snapshot of a kind (taken on the mountain's date `today`), as its data, or null (none, no table, or any error).
 * When today's is not there yet (the daily job runs at 7:30 AM Eastern), it is taken now. One from an earlier day is not used.
 */
async function snapshot(db, tenantId, today, kind) {
  if (!(await hasSnapshots(db))) return null;
  const S = require('./snapshots');
  const fresh = async () => { const r = await S.latest(db, tenantId, today, kind); return r && !r.stale ? r : null; };
  try {
    let r = await fresh();
    if (!r && String(process.env.SNAPSHOTS || 'on').toLowerCase() !== 'off') {
      const t = await S.tenantRow(db, tenantId);
      if (t && S.dateIn(t.timezone, new Date()) === today) { // only today's can be taken now
        const took = await S.take(db, tenantId, kind, { tenant: t }).catch(() => null);
        if (took && took.status === 'taken') r = await fresh();
      }
    }
    if (!r) return null;
    const d = r.data !== undefined ? r.data : r;
    return typeof d === 'string' ? JSON.parse(d) : d;
  } catch (_) { return null; }
}

const POINT_NAME = { base: 'base point', summit: 'summit point', map_point: 'map point' };
const hhmm = (t) => String(t || '').slice(11, 16);
const WIND_CAVEAT_TAIL = '10 m above the ground. The forecast smooths ridges, so wind at a lift can be stronger. This is an early warning only, not a reading at the lift.';
/** The line that goes with every comparison of gusts and a lift's wind hold limit. */
const windCaveat = (point) => `These gusts are the forecast at the ${POINT_NAME[point] || 'map point'}, ${WIND_CAVEAT_TAIL}`;
const WIND_CAVEAT = windCaveat('map_point'); // the shape of the line, for tests and the writer

/**
 * The forecast snapshot boiled down to one day: { high_f, low_f, snow_in, precip_in, wind_mph, gust_mph, code } and, for
 * the wind holds, gusts per point during the operating hours: wind: { window: 'open_hours' | 'all_day', points: [...] }.
 * Reads the daily job's shape ({ points: [{ role, hourly: { time: [], temp_f: [], gust_mph: [] ... } }] }), the
 * backfill's ({ days: [...] }, daily values only) and a plain list of hours. hours: { open: 'HH:MM', close: 'HH:MM' }.
 */
function dayFromForecast(snap, date, hours = null) {
  if (!snap) return null;
  const max = (a) => (a.length ? Math.max(...a) : null); const min = (a) => (a.length ? Math.min(...a) : null); const sum = (a) => (a.length ? round1(a.reduce((x, y) => x + y, 0)) : null);
  // The backfill's daily values (what was seen, not an hourly forecast).
  if (Array.isArray(snap.days) && !snap.hourly && !(snap.points || []).some((p) => p && p.hourly)) {
    const d = snap.days.find((x) => String(x.date || '').slice(0, 10) === date);
    if (!d) return null;
    const role = ((snap.points || [])[0] || {}).role || 'map_point';
    return { high_f: num(d.high_f), low_f: num(d.low_f), snow_in: num(d.snow_in), precip_in: num(d.precip_in), wind_mph: num(d.wind_mph), gust_mph: num(d.gust_mph), code: num(d.weather_code),
      wind: { window: 'all_day', points: num(d.gust_mph) == null ? [] : [{ point: role, gust_mph: num(d.gust_mph) }] } };
  }
  // Hours per point: [{ role, hours: [{ time, temp_f, ... }] }].
  let pts;
  if (Array.isArray(snap.points) && snap.points.some((p) => p && p.hourly)) {
    pts = snap.points.filter((p) => p && p.hourly && Array.isArray(p.hourly.time)).map((p) => ({ role: p.role || 'map_point',
      hours: p.hourly.time.map((time, i) => Object.fromEntries([['time', time], ...Object.keys(p.hourly).filter((k) => k !== 'time').map((k) => [k, Array.isArray(p.hourly[k]) ? p.hourly[k][i] : null])])) }));
  } else {
    const list = Array.isArray(snap) ? snap : snap.hours || snap.hourly || [];
    pts = [{ role: 'map_point', hours: Array.isArray(list) ? list : [] }];
  }
  for (const p of pts) p.hours = p.hours.filter((h) => String(h.time || h.at || '').slice(0, 10) === date);
  pts = pts.filter((p) => p.hours.length);
  if (!pts.length) return null;
  const vals = (hrs, ...keys) => hrs.map((h) => num(keys.map((k) => h[k]).find((v) => v != null))).filter((v) => v != null);
  // The day's weather from the lower point (the base, or the one point there is): what guests meet at the lodge.
  const low = pts.find((p) => p.role !== 'summit') || pts[0];
  const temps = vals(low.hours, 'temp_f', 'temperature_f', 'temperature');
  const codes = vals(low.hours, 'weather_code', 'code');
  // Wind holds: the hourly gusts while the lifts run (the calendar's hours), at every point; the whole day when unknown.
  const inHours = (h) => { const t = hhmm(String(h.time || h.at || '').replace(' ', 'T')); return t >= hours.open && t < hours.close; };
  const open = hours && hours.open && hours.close ? pts.map((p) => ({ role: p.role, hours: p.hours.filter(inHours) })) : null;
  const useOpen = open && open.every((p) => p.hours.length);
  const windPts = (useOpen ? open : pts).map((p) => ({ point: p.role, gust_mph: max(vals(p.hours, 'gust_mph', 'gusts_mph', 'gust')), wind_mph: max(vals(p.hours, 'wind_mph', 'wind')) })).filter((p) => p.gust_mph != null);
  const allHours = pts.flatMap((p) => p.hours);
  return { high_f: max(temps), low_f: min(temps), snow_in: sum(vals(low.hours, 'snow_in', 'snowfall_in', 'snowfall')), precip_in: sum(vals(low.hours, 'precip_in', 'precipitation_in', 'precipitation')),
    wind_mph: max(vals(allHours, 'wind_mph', 'wind')), gust_mph: max(vals(allHours, 'gust_mph', 'gusts_mph', 'gust')), code: max(codes),
    wind: { window: useOpen ? 'open_hours' : 'all_day', points: windPts.map((p) => ({ point: p.point, gust_mph: round1(p.gust_mph), wind_mph: round1(p.wind_mph) })) } };
}

/** Tickets sold so far for a day from the presales snapshot, or null. ({ days: [{ date, tickets: { sold } }] }) */
function ticketsFromPresales(snap, date) {
  if (!snap) return null;
  const days = snap.days || snap;
  const d = Array.isArray(days) ? days.find((x) => String(x.date || x.on_date || '').slice(0, 10) === date) : days[date];
  if (!d || d.tickets == null) return null;
  return typeof d.tickets === 'object' ? num(d.tickets.sold) : num(d.tickets);
}

// ---------------------------------------------------------------- the parts
async function weather(db, t, date, today, hours) {
  const snap = await snapshot(db, t.id, today, 'forecast');
  let day = snap ? dayFromForecast(snap, date, hours) : null;
  let source = day ? 'snapshot' : null;
  if (!day && t.map_lat !== null && t.map_lng !== null) {
    const wx = (await require('./dayrecord').fetchWeather(Number(t.map_lat), Number(t.map_lng), date, date, today))[date];
    if (wx) { day = { high_f: wx.high_f, low_f: wx.low_f, snow_in: wx.snowfall_in, precip_in: wx.precip_in, wind_mph: wx.wind_mph, gust_mph: wx.gust_mph, code: wx.weather_code }; source = 'forecast'; }
  }
  // What the crew wrote down: the latest snow report from the day before or the day itself.
  const snow = await one(db, 'SELECT new_snow_in, base_in FROM snow_readings WHERE tenant_id = ? AND trail_id IS NULL AND read_at >= ? AND read_at < ? ORDER BY read_at DESC, id DESC LIMIT 1', [t.id, `${addDays(date, -1)} 00:00:00`, `${addDays(date, 1)} 00:00:00`]).catch(() => null);
  const out = { source: source || 'none' };
  if (day) Object.assign(out, { sky: sky(day.code), high_f: round1(num(day.high_f)), low_f: round1(num(day.low_f)), snow_in: round1(num(day.snow_in)), precip_in: round1(num(day.precip_in)), wind_mph: round1(num(day.wind_mph)), gust_mph: round1(num(day.gust_mph)) });
  // For the wind holds (not shown as weather): gusts per point, during the operating hours when the hourly forecast has them.
  Object.defineProperty(out, 'windPoints', { value: day && day.wind ? day.wind : (day && num(day.gust_mph) != null ? { window: 'all_day', points: [{ point: 'map_point', gust_mph: round1(num(day.gust_mph)) }] } : null), enumerable: false });
  if (snow && (snow.new_snow_in != null || snow.base_in != null)) out.crew_snow_report = { new_snow_in: num(snow.new_snow_in), base_in: num(snow.base_in) };
  return out;
}

/**
 * Each lift's wind hold limit against the forecast gusts: the highest gust at any point (base or summit) during the
 * operating hours. wp: { window, points: [{ point, gust_mph }] } from weather(). Every comparison carries `caveat`.
 */
async function wind(db, tenantId, wp, hours) {
  const lifts = await rows(db, "SELECT name, wind_hold_mph FROM lifts WHERE tenant_id = ? AND status <> 'closed' ORDER BY name", [tenantId]);
  const set = lifts.filter((l) => l.wind_hold_mph != null);
  const out = { limits_set: set.length, limits_not_set: lifts.length - set.length, lifts_over_limit: [], lifts_near_limit: [] };
  const top = wp && wp.points.length ? wp.points.reduce((a, b) => (b.gust_mph > a.gust_mph ? b : a)) : null;
  if (!top) { out.note = 'No gust forecast for the day.'; return out; }
  const gust = top.gust_mph;
  out.gusts_from = POINT_NAME[top.point] || 'map point';
  out.gusts_during = wp.window === 'open_hours' && hours ? `from ${clock(hours.open)} to ${clock(hours.close)}` : 'during the day';
  if (wp.points.length > 1) out.gusts_by_point = wp.points.map((p) => ({ point: POINT_NAME[p.point] || p.point, gust_mph: p.gust_mph }));
  out.caveat = windCaveat(top.point);
  for (const l of set) {
    const lim = Number(l.wind_hold_mph);
    if (gust >= lim) out.lifts_over_limit.push({ lift: l.name, limit_mph: lim, gust_mph: gust });
    else if (gust >= lim - 5) out.lifts_near_limit.push({ lift: l.name, limit_mph: lim, gust_mph: gust });
  }
  if (!set.length) out.note = 'No lift has a wind hold limit set.';
  return out;
}

/** Tickets sold ahead for the day, and the simple estimate of visits from the day records. */
async function visits(db, tenantId, date, today) {
  let presold = ticketsFromPresales(await snapshot(db, tenantId, today, 'presales'), date);
  if (presold == null) {
    const r = await one(db, `SELECT COALESCE(SUM(i.quantity), 0) AS n FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.line_kind = 'ticket' AND i.valid_on = ? AND i.refunded_at IS NULL AND o.status IN ('paid','refunded')`, [tenantId, date]);
    presold = Number(r.n) || 0;
  }
  const wd = weekdayOf(date);
  const past = await rows(db, "SELECT on_date, visits FROM day_records WHERE tenant_id = ? AND weekday = ? AND on_date < ? AND on_date >= ? AND status IN ('open','limited') AND visits IS NOT NULL ORDER BY on_date DESC LIMIT 4",
    [tenantId, wd, date, addDays(date, -28)]);
  const expected = past.length ? Math.round(past.reduce((n, r) => n + Number(r.visits), 0) / past.length) : null;
  return {
    presold_tickets: presold,
    expected_visits: expected,
    expected_basis: past.length ? `Simple estimate: the average of the last ${past.length} open ${WEEKDAYS[wd]}${past.length === 1 ? '' : 's'} in the past 4 weeks.` : 'No open days on this weekday in the past 4 weeks to estimate from.',
  };
}

/** Yesterday's revenue (owners and managers only). */
async function revenue(tenantId, yesterday) {
  const rep = await require('./daily').dailyReport(tenantId, yesterday);
  return { day: yesterday, revenue_dollars: Math.round(Number(rep.sales.revenue_cents) / 100), orders: Number(rep.sales.orders) || 0 };
}

/** Lessons booked against instructors scheduled, and classes over their age band ratio. */
async function lessons(db, tenantId, date) {
  const SS = require('./schoolsafety'); const S = require('./schoolsettings');
  const sessions = await rows(db, `SELECT s.*, p.name AS product, (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS students
    FROM lesson_sessions s LEFT JOIN products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
    WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at, s.id LIMIT 200`, [tenantId, `${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`]);
  const sched = await one(db, `SELECT COUNT(DISTINCT sh.staff_id) AS n FROM shifts sh JOIN positions pos ON pos.tenant_id = sh.tenant_id AND pos.id = sh.position_id
    WHERE sh.tenant_id = ? AND pos.department = 'ski_school' AND sh.status <> 'cancelled' AND sh.staff_id IS NOT NULL AND sh.starts_at >= ? AND sh.starts_at < ?`, [tenantId, `${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`]);
  const booked = sessions.filter((s) => Number(s.students) > 0);
  const settings = await S.get(db, tenantId);
  const over = [];
  for (const s of booked.slice(0, 60)) {
    if (!SS.ratioApplies(s)) continue;
    const ages = await SS.bookedAges(db, tenantId, s);
    const lim = SS.classLimit(s, ages, settings);
    if (lim && ages.length > lim.size) over.push({ lesson: `${clock(s.starts_at)} ${s.product || 'lesson'}`, students: ages.length, limit: lim.size, band: lim.label });
  }
  return {
    lessons: booked.length,
    students: booked.reduce((n, s) => n + Number(s.students), 0),
    lessons_without_instructor: booked.filter((s) => !s.instructor_id).length,
    instructors_assigned: new Set(booked.filter((s) => s.instructor_id).map((s) => Number(s.instructor_id))).size,
    instructors_scheduled: Number(sched.n) || 0,
    classes_over_ratio: over.slice(0, 8),
  };
}

/** Lifts with open work orders, a failed check, or a weekly check overdue. */
async function liftProblems(db, tenantId, date) {
  const wos = await rows(db, `SELECT l.name AS lift, w.title FROM work_orders w JOIN lifts l ON l.tenant_id = w.tenant_id AND l.id = w.lift_id
    WHERE w.tenant_id = ? AND w.status IN ('open','in_progress','waiting_parts') ORDER BY l.name, FIELD(w.priority, 'urgent','high','normal','low'), w.id`, [tenantId]);
  const byLift = new Map();
  for (const w of wos) { const e = byLift.get(w.lift) || { lift: w.lift, open_work_orders: 0, titles: [] }; e.open_work_orders += 1; if (e.titles.length < 2) e.titles.push(String(w.title || '').slice(0, 80)); byLift.set(w.lift, e); }
  // The newest signed-off daily inspection (either form) of the last two days, per lift. The two tables were made with
  // different collations on some databases, so both sides of the UNION name one.
  const daily = await rows(db, `SELECT l.name AS lift, x.result, x.on_date FROM (
      SELECT lift_id, status COLLATE utf8mb4_unicode_ci AS result, check_date AS on_date, finished_at AS at FROM lift_inspections WHERE tenant_id = ? AND kind = 'daily' AND status <> 'in_progress' AND check_date BETWEEN ? AND ?
      UNION ALL SELECT lift_id, result COLLATE utf8mb4_unicode_ci, check_date, checked_at FROM lift_checks WHERE tenant_id = ? AND kind = 'pre_open' AND check_date BETWEEN ? AND ?) x
    JOIN lifts l ON l.tenant_id = ? AND l.id = x.lift_id ORDER BY x.at`, [tenantId, addDays(date, -2), date, tenantId, addDays(date, -2), date, tenantId]);
  const lastDaily = new Map(); for (const d of daily) lastDaily.set(d.lift, d);
  const failed = [...lastDaily.values()].filter((d) => d.result === 'fail').map((d) => ({ lift: d.lift, check: 'daily', date: ymd(d.on_date) }));
  const usesChecks = await one(db, 'SELECT (SELECT COUNT(*) FROM lift_checks WHERE tenant_id = ? AND check_date >= ?) + (SELECT COUNT(*) FROM lift_inspections WHERE tenant_id = ? AND check_date >= ?) AS n', [tenantId, addDays(date, -30), tenantId, addDays(date, -30)]);
  const weeklyDue = [];
  if (Number(usesChecks.n)) {
    const lifts = await rows(db, "SELECT id, name FROM lifts WHERE tenant_id = ? AND status <> 'closed' ORDER BY name", [tenantId]);
    const weekly = await rows(db, "SELECT c.lift_id, c.result, c.check_date FROM lift_checks c JOIN (SELECT lift_id, MAX(id) AS id FROM lift_checks WHERE tenant_id = ? AND kind = 'periodic' AND check_date <= ? GROUP BY lift_id) m ON m.id = c.id WHERE c.tenant_id = ?", [tenantId, date, tenantId]);
    for (const l of lifts) {
      const w = weekly.find((x) => Number(x.lift_id) === Number(l.id));
      if (w && w.result === 'fail') failed.push({ lift: l.name, check: 'weekly', date: ymd(w.check_date) });
      else if (!w || ymd(w.check_date) <= addDays(date, -7)) weeklyDue.push(l.name);
    }
  }
  return { with_open_work_orders: [...byLift.values()].slice(0, 8), failed_checks: failed.slice(0, 8), weekly_check_due: weeklyDue.slice(0, 8), weekly_check_due_count: weeklyDue.length };
}

async function park(db, tenantId) {
  const closed = await rows(db, "SELECT name FROM park_features WHERE tenant_id = ? AND status = 'closed' ORDER BY name", [tenantId]);
  const attention = await one(db, "SELECT COUNT(*) AS n FROM park_features WHERE tenant_id = ? AND status = 'needs_attention'", [tenantId]);
  return { closed_count: closed.length, closed: closed.slice(0, 8).map((f) => f.name), needs_attention_count: Number(attention.n) || 0 };
}

/** Shifts with nobody on them, and shifts still in draft (not confirmed), by department. */
async function shifts(db, tenantId, date, kind, modules) {
  const range = [`${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`];
  const byDept = new Map();
  const add = (dept, r) => { const e = byDept.get(dept) || { department: DEPT_LABEL[dept] || dept, shifts: 0, uncovered: 0, not_confirmed: 0 }; e.shifts += Number(r.n); e.uncovered += Number(r.uncovered || 0); e.not_confirmed += Number(r.draft || 0); byDept.set(dept, e); };
  if (kind !== 'patrol' && modules.has('workforce')) {
    const list = await rows(db, `SELECT pos.department, COUNT(*) AS n, SUM(sh.staff_id IS NULL) AS uncovered, SUM(sh.status = 'draft') AS draft FROM shifts sh JOIN positions pos ON pos.tenant_id = sh.tenant_id AND pos.id = sh.position_id
      WHERE sh.tenant_id = ? AND sh.status <> 'cancelled' AND sh.starts_at >= ? AND sh.starts_at < ? ${kind === 'school' ? "AND pos.department = 'ski_school'" : ''} GROUP BY pos.department`, [tenantId, ...range]);
    for (const r of list) add(r.department, r);
  }
  if (kind !== 'school' && modules.has('patrol')) {
    const r = await one(db, "SELECT COUNT(*) AS n, SUM(staff_id IS NULL) AS uncovered, SUM(status = 'draft') AS draft FROM patrol_shifts WHERE tenant_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?", [tenantId, ...range]);
    if (Number(r.n)) add('patrol', r);
  }
  const list = [...byDept.values()].sort((a, b) => b.uncovered - a.uncovered || b.not_confirmed - a.not_confirmed);
  return { shifts: list.reduce((n, d) => n + d.shifts, 0), uncovered: list.reduce((n, d) => n + d.uncovered, 0), not_confirmed: list.reduce((n, d) => n + d.not_confirmed, 0), by_department: list };
}

/**
 * Yesterday's patrol cases: COUNTS BY AREA ONLY, from one aggregate query. The area is the run's or lift's name (the
 * mountain's own place names), never the free-text location. Nothing else about a case is read: no name, age, injury,
 * story, case number or time.
 */
const PATROL_AREAS = 12; // areas named in the brief; the rest are counted under "Other places"
const OTHER_PLACES = 'Other places';
async function patrolCounts(db, tenantId, day) {
  const list = await rows(db, `SELECT COALESCE(t.name, l.name, '${OTHER_PLACES}') AS area, COUNT(*) AS n FROM incidents i
    LEFT JOIN trails t ON t.tenant_id = i.tenant_id AND t.id = i.trail_id LEFT JOIN lifts l ON l.tenant_id = i.tenant_id AND l.id = i.lift_id
    WHERE i.tenant_id = ? AND i.occurred_at >= ? AND i.occurred_at < ? GROUP BY area ORDER BY n DESC, area`, [tenantId, `${day} 00:00:00`, `${addDays(day, 1)} 00:00:00`]);
  // The total counts every case (2026.11.15 review: it counted only the top 12 areas). The busiest areas are named; the
  // rest, and cases with no run or lift, are one "Other places" line, last.
  const total = list.reduce((n, r) => n + Number(r.n), 0);
  const named = list.filter((r) => String(r.area) !== OTHER_PLACES);
  const lines = named.length + (named.length < list.length ? 1 : 0); // one line per area, and one for cases with no run or lift
  const shown = lines > PATROL_AREAS ? named.slice(0, PATROL_AREAS - 1) : named;
  const other = total - shown.reduce((n, r) => n + Number(r.n), 0);
  const byArea = shown.map((r) => ({ area: String(r.area), count: Number(r.n) }));
  if (other > 0) byArea.push({ area: OTHER_PLACES, count: other });
  return { day, total, by_area: byArea };
}

/** Refunds above normal, waitlists growing, the online shop near a daily limit. */
async function unusual(db, t, date, yesterday, kind, modules) {
  const out = {};
  if (kind === 'ops' && modules.has('sell')) {
    const [from, to] = dayRange(t.timezone, yesterday);
    const [before] = dayRange(t.timezone, addDays(yesterday, -28));
    const y = await one(db, 'SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM order_refunds WHERE tenant_id = ? AND created_at >= ? AND created_at < ?', [t.id, from, to]);
    const usual = await one(db, 'SELECT COUNT(*) AS n FROM order_refunds WHERE tenant_id = ? AND created_at >= ? AND created_at < ?', [t.id, before, from]);
    const avg = Math.round((Number(usual.n) / 28) * 10) / 10;
    const n = Number(y.n);
    if (n >= 3 && n >= 2 * avg) out.refunds_above_normal = { day: yesterday, refunds: n, refunded_dollars: Math.round(Number(y.c) / 100), usual_per_day: avg };
  }
  if ((kind === 'ops' || kind === 'school') && modules.has('school')) {
    const w = await one(db, `SELECT COUNT(*) AS n, SUM(w.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)) AS added FROM lesson_waitlist w JOIN lesson_sessions s ON s.tenant_id = w.tenant_id AND s.id = w.session_id
      WHERE w.tenant_id = ? AND w.status = 'waiting' AND s.starts_at >= ?`, [t.id, `${date} 00:00:00`]);
    if (Number(w.added || 0) >= 3) out.lesson_waitlist_growing = { waiting: Number(w.n), added_last_day: Number(w.added) };
  }
  if (kind === 'ops' && modules.has('shop')) {
    const w = await one(db, "SELECT COUNT(*) AS n, SUM(created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)) AS added FROM fair_waitlist WHERE tenant_id = ? AND status = 'waiting'", [t.id]).catch(() => ({ n: 0, added: 0 }));
    if (Number(w.added || 0) >= 3) out.ticket_waitlist_growing = { waiting: Number(w.n), added_last_day: Number(w.added) };
    if (t.online_shop) {
      const SH = require('./shopsale');
      const use = await SH.usage(db, t.id, date, date);
      const u = use.get(date) || { all: 0, by: new Map() };
      const over = use.over || new Map();
      const near = [];
      const tLimit = over.has(`${date}|0`) ? over.get(`${date}|0`) : num(t.online_daily_limit);
      if (tLimit) { const used = u.all; if (used >= 0.9 * tLimit) near.push({ what: 'All day tickets', sold: used, limit: tLimit }); }
      for (const p of await rows(db, "SELECT id, name, online_daily_limit FROM products WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind IN ('day_ticket','multi_day')", [t.id])) {
        const lim = over.has(`${date}|${p.id}`) ? over.get(`${date}|${p.id}`) : num(p.online_daily_limit);
        const used = u.by.get(p.id) || u.by.get(Number(p.id)) || 0;
        if (lim && used >= 0.9 * lim) near.push({ what: p.name, sold: used, limit: lim });
      }
      if (near.length) out.shop_near_daily_limit = near.slice(0, 5);
    }
  }
  return out;
}

/** The screens a brief of this kind may link to (each one this role can open), for the suggested actions. */
function screensFor(kind, modules) {
  const s = [];
  const add = (mod, href, label) => { if (!mod || modules.has(mod)) s.push({ href, label }); };
  if (kind === 'ops') {
    add('conditions', '#/conditions', 'Mountain status'); add('conditions', '#/conditions?tab=maint', 'Maintenance'); add('conditions', '#/conditions?tab=snow', 'Snow and weather');
    add('park', '#/park', 'Terrain park'); add('workforce', '#/workforce', 'Staff and schedule'); add('school', '#/school', 'Lessons');
    add('shop', '#/shop', 'Online shop'); add('money', '#/money', 'Money'); add('patrol', '#/patrol', 'Patrol'); add(null, '#/calendar', 'Calendar');
  } else if (kind === 'patrol') {
    add('patrol', '#/patrol', 'Patrol'); add('conditions', '#/conditions', 'Mountain status'); add('conditions', '#/conditions?tab=maint', 'Maintenance'); add('park', '#/park', 'Terrain park'); add(null, '#/calendar', 'Calendar');
  } else {
    add('school', '#/school', 'Lessons'); add(null, '#/calendar', 'Calendar');
  }
  return s;
}

/**
 * The brief's facts for one mountain and kind. t: the tenant row (id, name, timezone, map_lat, map_lng, online_shop,
 * online_daily_limit). day: { date, today, opening_day, opening_tomorrow, hours }. modules: Set of the apps on.
 */
async function assemble(db, t, kind, day, modules) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown brief kind ${kind}`);
  const { date, today } = day;
  const yesterday = addDays(date, -1);
  const data = {
    mountain: t.name, brief: KIND_LABEL[kind], date, weekday: WEEKDAYS[weekdayOf(date)],
    opening_day: Boolean(day.opening_day), day_before_opening: Boolean(day.opening_tomorrow),
    hours: day.hours || null,
  };
  data.weather = await weather(db, t, date, today, day.hours || null);
  const conditions = modules.has('conditions');
  if (kind !== 'school' && conditions) data.wind_holds = await wind(db, t.id, data.weather.windPoints, day.hours || null);
  if (kind === 'ops') data.visitors = await visits(db, t.id, date, today);
  if (kind === 'ops' && modules.has('sell')) data.revenue_yesterday = await revenue(t.id, yesterday);
  if (kind !== 'patrol' && modules.has('school')) data.lessons = await lessons(db, t.id, date);
  if (kind !== 'school' && conditions) data.lifts = await liftProblems(db, t.id, date);
  if (kind !== 'school' && modules.has('park')) data.park = await park(db, t.id);
  data.shifts = await shifts(db, t.id, date, kind, modules);
  if (kind !== 'school' && modules.has('patrol')) data.patrol_yesterday = await patrolCounts(db, t.id, yesterday);
  data.unusual = await unusual(db, t, date, yesterday, kind, modules);
  data.screens = screensFor(kind, modules);
  return data;
}

module.exports = { assemble, patrolCounts, screensFor, sky, KINDS, KIND_LABEL, WEEKDAYS, hasSnapshots, resetSnapshotCheck, dayFromForecast, ticketsFromPresales, windCaveat, WIND_CAVEAT, WIND_CAVEAT_TAIL, POINT_NAME };
