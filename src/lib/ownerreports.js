'use strict';
// The owner's ski school reports (feat/school-pay), for owners and managers only (routes/schoolreports.js):
//   revenuePerHour   lesson revenue per instructor hour, per instructor
//   costVsRevenue    instructor cost (the pay lines, as payroll counts them) against lesson revenue, by day and by product
//   returnRate       instructors who taught last season and came back this season
//   conversion       first-timers (first lesson at Level 1) who then booked another lesson, bought a lesson pack, started a
//                    learn to ski ladder, or bought a season pass, within 30 days, 60 days and the season
// Revenue is lib/lessonreports.lessonsIn: only money paid for a seat (an unpaid booking counts nothing). Cost is
// lib/lessonpay.lines, the same lines My pay and payroll use (tips are never cost: they pass through).
const { rows } = require('../db');
const { addDays, seasonFor } = require('./util');
const LR = require('./lessonreports');
const P = require('./lessonpay');

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const hours = (min) => Math.round((min / 60) * 100) / 100;
/** The first and last day of a season ('2026-27': August 1 2026 to July 31 2027). */
const seasonDays = (season) => { const y = Number(String(season).slice(0, 4)); return { from: `${y}-08-01`, to: `${y + 1}-07-31` }; };
const prevSeason = (season) => { const y = Number(String(season).slice(0, 4)) - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };

async function revenuePerHour(db, tenantId, from, to) {
  const lessons = await LR.lessonsIn(tenantId, from, to);
  const { lines } = await P.lines(db, tenantId, { from, to });
  const pay = P.byInstructor(lines);
  const by = new Map();
  const row = (id, name) => { if (!by.has(id)) by.set(id, { staff_id: id, instructor: name || 'No instructor', lessons: 0, students: 0, revenue_cents: 0, minutes: 0, cost_cents: 0 }); return by.get(id); };
  for (const s of lessons) { const x = row(s.instructor_id || 0, s.instructor); x.lessons += 1; x.students += s.students; x.revenue_cents += s.revenue_cents; }
  for (const g of pay) { const x = row(g.staff_id, null); x.minutes += g.minutes; x.cost_cents += g.pay_cents; }
  const names = new Map((await rows(db, "SELECT s.id, TRIM(CONCAT(p.first_name, ' ', p.last_name)) AS name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ?", [tenantId])).map((r) => [r.id, r.name]));
  const list = [...by.values()].map((x) => ({ ...x, instructor: names.get(x.staff_id) || x.instructor, hours: hours(x.minutes), revenue_per_hour_cents: x.minutes ? Math.round(x.revenue_cents / (x.minutes / 60)) : null }))
    .filter((x) => x.lessons || x.minutes).sort((a, b) => (b.revenue_per_hour_cents ?? -1) - (a.revenue_per_hour_cents ?? -1));
  const tot = list.reduce((a, x) => ({ revenue_cents: a.revenue_cents + x.revenue_cents, minutes: a.minutes + x.minutes }), { revenue_cents: 0, minutes: 0 });
  return { from, to, rows: list, total: { ...tot, hours: hours(tot.minutes), revenue_per_hour_cents: tot.minutes ? Math.round(tot.revenue_cents / (tot.minutes / 60)) : null } };
}

const OTHER = { program: 'Program meetings', training: 'Training', clock: 'Time cards' };
async function costVsRevenue(db, tenantId, from, to) {
  const lessons = await LR.lessonsIn(tenantId, from, to);
  const product = new Map(lessons.map((s) => [s.id, s.product]));
  const { lines } = await P.lines(db, tenantId, { from, to });
  // a lesson or a lineup line is the lesson's product; a lesson with nobody on it (cancelled lessons have no line) too
  const prodOf = async (ids) => new Map((ids.length ? await rows(db, 'SELECT s.id, pr.name FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE s.tenant_id = ? AND s.id IN (?)', [tenantId, ids]) : []).map((r) => [r.id, r.name]));
  const missing = [...new Set(lines.filter((l) => l.session_id && !product.has(l.session_id)).map((l) => l.session_id))];
  for (const [k, v] of await prodOf(missing)) product.set(k, v);
  const day = new Map(); const prod = new Map();
  const add = (m, k, f, c) => { if (!m.has(k)) m.set(k, { key: k, revenue_cents: 0, cost_cents: 0 }); m.get(k)[f] += c; };
  for (const s of lessons) { add(day, String(s.starts_at).slice(0, 10), 'revenue_cents', s.revenue_cents); add(prod, s.product, 'revenue_cents', s.revenue_cents); }
  for (const l of lines) {
    if (l.tip) continue;
    add(day, l.day, 'cost_cents', l.cents);
    add(prod, l.session_id && ['lesson', 'lineup'].includes(l.kind) ? product.get(l.session_id) || 'Lessons' : OTHER[l.kind] || 'Other', 'cost_cents', l.cents);
  }
  const shape = (m) => [...m.values()].map((x) => ({ ...x, margin_cents: x.revenue_cents - x.cost_cents, cost_pct: x.revenue_cents ? pct(x.cost_cents, x.revenue_cents) : null }));
  const byDay = shape(day).sort((a, b) => a.key.localeCompare(b.key));
  const byProduct = shape(prod).sort((a, b) => b.revenue_cents - a.revenue_cents);
  const total = byDay.reduce((a, x) => ({ revenue_cents: a.revenue_cents + x.revenue_cents, cost_cents: a.cost_cents + x.cost_cents }), { revenue_cents: 0, cost_cents: 0 });
  return { from, to, by_day: byDay, by_product: byProduct, total: { ...total, margin_cents: total.revenue_cents - total.cost_cents, cost_pct: total.revenue_cents ? pct(total.cost_cents, total.revenue_cents) : null } };
}

/** Who taught in a season: lessons taught (not cancelled) and program meetings coached, per staff id. */
async function taughtIn(db, tenantId, season) {
  const { from, to } = seasonDays(season);
  const list = await rows(db, `SELECT instructor_id AS staff_id, COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ? AND instructor_id IS NOT NULL AND status <> 'cancelled' AND DATE(starts_at) BETWEEN ? AND ? GROUP BY instructor_id
    UNION ALL SELECT coach_staff_id, COUNT(*) FROM program_sessions WHERE tenant_id = ? AND coach_staff_id IS NOT NULL AND status = 'scheduled' AND DATE(starts_at) BETWEEN ? AND ? GROUP BY coach_staff_id`, [tenantId, from, to, tenantId, from, to]);
  const m = new Map();
  for (const r of list) m.set(Number(r.staff_id), (m.get(Number(r.staff_id)) || 0) + Number(r.n));
  return m;
}
async function returnRate(db, tenantId, season) {
  const last = prevSeason(season);
  const [before, now] = await Promise.all([taughtIn(db, tenantId, last), taughtIn(db, tenantId, season)]);
  const names = new Map((await rows(db, "SELECT s.id, TRIM(CONCAT(p.first_name, ' ', p.last_name)) AS name, s.status FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ?", [tenantId])).map((r) => [Number(r.id), r]));
  const list = [...before.keys()].map((id) => ({ staff_id: id, instructor: (names.get(id) || {}).name || `Staff ${id}`, last_season: before.get(id), this_season: now.get(id) || 0, returned: now.has(id) }))
    .sort((a, b) => Number(b.returned) - Number(a.returned) || a.instructor.localeCompare(b.instructor));
  const back = list.filter((x) => x.returned).length;
  const fresh = [...now.keys()].filter((id) => !before.has(id)).length;
  return { season, last_season: last, rows: list, total: { taught_last_season: list.length, returned: back, return_pct: pct(back, list.length), new_this_season: fresh, taught_this_season: now.size } };
}

const KINDS = [['lesson', 'Booked another lesson'], ['pack', 'Bought a lesson pack'], ['ladder', 'Started a learn to ski ladder'], ['pass', 'Bought a season pass']];
/**
 * First-timers in a season: students whose first lesson ever was in the season and at Level 1 (the level they were
 * booked at, or a lesson for Level 1 only). Converted: within 30 days, 60 days or the rest of the season of that first
 * lesson they booked another lesson, bought a lesson pack, started a learn to ski ladder (a ladder lesson counts from the
 * first one), or bought a season pass.
 */
async function conversion(db, tenantId, season) {
  const { from, to } = seasonDays(season);
  const firsts = await rows(db, `SELECT x.person_id, x.first_at FROM (SELECT b.person_id, MIN(s.starts_at) AS first_at FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      WHERE b.tenant_id = ? AND b.status IN ('booked','attended','no_show') AND s.status <> 'cancelled' GROUP BY b.person_id) x WHERE x.first_at >= ? AND x.first_at < ?`, [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]);
  let ladderProducts = new Set();
  try { ladderProducts = new Set((await rows(db, 'SELECT product_id FROM learn_ladders WHERE tenant_id = ?', [tenantId])).map((r) => Number(r.product_id))); } catch (_) { /* no ladders yet */ }
  const out = { season, first_timers: 0, converted: { d30: 0, d60: 0, season: 0 }, by_kind: Object.fromEntries(KINDS.map(([k]) => [k, { d30: 0, d60: 0, season: 0 }])), by_product: new Map() };
  for (const f of firsts) {
    const first = (await rows(db, `SELECT b.id, b.level, b.credit_id, s.level_min, s.level_max, pr.name AS product, c.product_id AS credit_product FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id LEFT JOIN lesson_credits c ON c.tenant_id = b.tenant_id AND c.id = b.credit_id
      WHERE b.tenant_id = ? AND b.person_id = ? AND s.starts_at = ? AND b.status IN ('booked','attended','no_show') ORDER BY b.id LIMIT 1`, [tenantId, f.person_id, f.first_at]))[0];
    if (!first) continue;
    const level1 = Number(first.level) === 1 || (!first.level && Number(first.level_max) === 1);
    if (!level1) continue;
    out.first_timers += 1;
    const day = String(f.first_at).slice(0, 10);
    const when = {}; // kind -> first day it happened
    const note = (k, d) => { if (d && (!when[k] || d < when[k])) when[k] = d; };
    if (first.credit_product && ladderProducts.has(Number(first.credit_product))) note('ladder', day);
    const nextLesson = (await rows(db, `SELECT MIN(s.starts_at) AS at FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      WHERE b.tenant_id = ? AND b.person_id = ? AND b.status IN ('booked','attended','no_show') AND s.status <> 'cancelled' AND s.starts_at > ?`, [tenantId, f.person_id, f.first_at]))[0];
    if (nextLesson && nextLesson.at) note('lesson', String(nextLesson.at).slice(0, 10));
    for (const c of await rows(db, "SELECT product_id, DATE(created_at) AS d FROM lesson_credits WHERE tenant_id = ? AND person_id = ? AND source = 'package' AND status = 'active' AND created_at >= ?", [tenantId, f.person_id, `${day} 00:00:00`])) {
      note(ladderProducts.has(Number(c.product_id)) ? 'ladder' : 'pack', String(c.d instanceof Date ? c.d.toISOString() : c.d).slice(0, 10));
    }
    const pass = (await rows(db, `SELECT MIN(o.created_at) AS at FROM tickets t JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
      LEFT JOIN order_items i ON i.tenant_id = t.tenant_id AND i.id = t.order_item_id LEFT JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
      WHERE t.tenant_id = ? AND t.person_id = ? AND p.kind = 'season_pass' AND o.created_at >= ?`, [tenantId, f.person_id, `${day} 00:00:00`]))[0];
    if (pass && pass.at) note('pass', String(pass.at instanceof Date ? pass.at.toISOString() : pass.at).slice(0, 10));
    const within = (d, n) => d <= (n ? addDays(day, n) : to);
    const any = (n) => Object.values(when).some((d) => within(d, n));
    if (any(30)) out.converted.d30 += 1;
    if (any(60)) out.converted.d60 += 1;
    if (any(0)) out.converted.season += 1;
    for (const [k] of KINDS) if (when[k]) { if (within(when[k], 30)) out.by_kind[k].d30 += 1; if (within(when[k], 60)) out.by_kind[k].d60 += 1; if (within(when[k], 0)) out.by_kind[k].season += 1; }
    const bp = out.by_product.get(first.product) || { product: first.product, first_timers: 0, d30: 0, d60: 0, season: 0 };
    bp.first_timers += 1; if (any(30)) bp.d30 += 1; if (any(60)) bp.d60 += 1; if (any(0)) bp.season += 1;
    out.by_product.set(first.product, bp);
  }
  const n = out.first_timers;
  return { season, from, to, first_timers: n,
    rows: [{ what: 'Any of these', ...out.converted }, ...KINDS.map(([k, w]) => ({ what: w, kind: k, ...out.by_kind[k] }))].map((r) => ({ ...r, d30_pct: pct(r.d30, n), d60_pct: pct(r.d60, n), season_pct: pct(r.season, n) })),
    by_product: [...out.by_product.values()].map((r) => ({ ...r, season_pct: pct(r.season, r.first_timers) })) };
}

/** CSV columns and rows for each report. */
const money = (c) => (c === null || c === undefined ? '' : (Number(c) / 100).toFixed(2));
function csvOf(kind, r) {
  if (kind === 'revenue-per-hour') return { cols: ['instructor', 'lessons', 'students', 'hours', 'revenue', 'revenue_per_hour', 'instructor_cost'], data: r.rows.map((x) => ({ instructor: x.instructor, lessons: x.lessons, students: x.students, hours: x.hours.toFixed(2), revenue: money(x.revenue_cents), revenue_per_hour: money(x.revenue_per_hour_cents), instructor_cost: money(x.cost_cents) })) };
  if (kind === 'cost') return { cols: ['by', 'key', 'revenue', 'instructor_cost', 'margin', 'cost_percent'], data: [...r.by_day.map((x) => ({ by: 'day', ...x })), ...r.by_product.map((x) => ({ by: 'product', ...x }))].map((x) => ({ by: x.by, key: x.key, revenue: money(x.revenue_cents), instructor_cost: money(x.cost_cents), margin: money(x.margin_cents), cost_percent: x.cost_pct ?? '' })) };
  if (kind === 'return-rate') return { cols: ['instructor', 'taught_last_season', 'taught_this_season', 'returned'], data: r.rows.map((x) => ({ instructor: x.instructor, taught_last_season: x.last_season, taught_this_season: x.this_season, returned: x.returned ? 'yes' : 'no' })) };
  return { cols: ['what', 'first_timers', 'within_30_days', 'within_30_days_percent', 'within_60_days', 'within_60_days_percent', 'within_season', 'within_season_percent'],
    data: r.rows.map((x) => ({ what: x.what, first_timers: r.first_timers, within_30_days: x.d30, within_30_days_percent: x.d30_pct, within_60_days: x.d60, within_60_days_percent: x.d60_pct, within_season: x.season, within_season_percent: x.season_pct })) };
}

module.exports = { revenuePerHour, costVsRevenue, returnRate, conversion, csvOf, seasonDays, prevSeason, seasonFor };
