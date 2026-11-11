'use strict';

// The ski area's free read-only view (role "area"): the day's patrol summary and approved reports, the day's ski school
// summary, or both when a tenant somehow has both on. It cannot see cases in progress, a patroller's or instructor's
// personal details, a student's family or any dollar figure, cannot change anything, and must use two-step sign-in.
// Every patrol report it opens is written to the audit log like any patient record.
// Owners and managers can open it too.
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { paramId, todayIn, seasonFor } = require('../lib/util');
const { notFound, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const modules = require('../lib/modules');
const { VALID: WAIVER_VALID } = require('../lib/waivers');

const router = express.Router();
const viewers = requireRole('area', 'manager');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const caseNo = (r) => (r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : `#${r.id}`);

// Which of Patrol and Ski school this mountain actually has on, worked out once per request and read by every route
// below. A mountain with neither has nothing for this login to see.
router.use(viewers, async (req, _res, next) => {
  try {
    const { on } = await modules.stateOf(req.auth.tenantId);
    req.areaOn = { patrol: on.has('patrol'), school: on.has('school') };
    if (!req.areaOn.patrol && !req.areaOn.school) throw forbidden('Patrol and Ski school are not turned on for your mountain');
    next();
  } catch (e) { next(e); }
});

/** One day of patrol, counts only: who was on, what was checked, what was called, what is approved. */
async function patrolSummary(t, day, today, season) {
  const [duty, checked, holds, calls, reports, seasonCalls] = await Promise.all([
    one(pool, 'SELECT COUNT(DISTINCT staff_id) AS n FROM patrol_duty WHERE tenant_id = ? AND on_date = ?', [t, day]),
    one(pool, 'SELECT COUNT(DISTINCT trail_id) AS n FROM patrol_opening_checks WHERE tenant_id = ? AND on_date = ?', [t, day]),
    day === today ? rows(pool, "SELECT name, closure_reason FROM trails WHERE tenant_id = ? AND status = 'hold' ORDER BY name", [t]) : Promise.resolve([]),
    rows(pool, 'SELECT category, severity, disposition FROM incidents WHERE tenant_id = ? AND DATE(occurred_at) = ?', [t, day]),
    one(pool, "SELECT SUM(report_state = 'approved') AS approved, SUM(report_state <> 'approved' OR report_state IS NULL) AS waiting FROM incidents WHERE tenant_id = ? AND DATE(occurred_at) = ?", [t, day]),
    rows(pool, 'SELECT category, COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND season = ? GROUP BY category ORDER BY n DESC', [t, season]),
  ]);
  const count = (key) => calls.reduce((m, c) => { const k = c[key] || 'not_recorded'; m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    on_duty: Number(duty.n), runs_checked: Number(checked.n), holds,
    calls: { total: calls.length, by_category: count('category'), by_severity: count('severity'), transported: calls.filter((c) => c.disposition === 'transported').length },
    reports: { approved: Number(reports.approved || 0), waiting: Number(reports.waiting || 0) },
    season_calls: seasonCalls.map((r) => ({ category: r.category, n: Number(r.n) })),
  };
}

/**
 * One day of ski school, counts only: lesson slots and how many students are booked into each (by time, level and
 * discipline, never which family), who is rostered to teach (instructors are staff, not customers, so this is shown by
 * name, the same as patrol's who-was-on-duty), and how many of today's students have a waiver on file for this season
 * (never the waiver's wording). Never a dollar figure, a lesson price or a family's contact details.
 */
async function schoolSummary(t, day, season) {
  const sessions = await rows(pool, "SELECT id, starts_at, ability_level, discipline FROM lesson_sessions WHERE tenant_id = ? AND DATE(starts_at) = ? AND status <> 'cancelled'", [t, day]);
  const ids = sessions.map((s) => Number(s.id));
  const bookings = ids.length ? await rows(pool, "SELECT session_id, person_id FROM lesson_bookings WHERE tenant_id = ? AND session_id IN (?) AND status IN ('booked', 'attended')", [t, ids]) : [];
  const perSession = new Map();
  for (const b of bookings) perSession.set(Number(b.session_id), (perSession.get(Number(b.session_id)) || 0) + 1);
  const bySlot = new Map();
  for (const s of sessions) {
    const key = `${s.starts_at}|${s.ability_level}|${s.discipline}`;
    const g = bySlot.get(key) || { starts_at: s.starts_at, level: s.ability_level, discipline: s.discipline, sessions: 0, students: 0 };
    g.sessions += 1;
    g.students += perSession.get(Number(s.id)) || 0;
    bySlot.set(key, g);
  }
  const students = [...new Set(bookings.map((b) => Number(b.person_id)))];
  const onFile = students.length ? await rows(pool, `SELECT DISTINCT person_id FROM waivers w WHERE w.tenant_id = ? AND w.person_id IN (?) AND w.season = ? AND ${WAIVER_VALID('w')}`, [t, students, season]) : [];
  const instructors = await rows(pool, `SELECT DISTINCT p.first_name, p.last_name FROM shifts sh
    JOIN positions pos ON pos.tenant_id = sh.tenant_id AND pos.id = sh.position_id AND pos.department = 'ski_school'
    JOIN staff st ON st.tenant_id = sh.tenant_id AND st.id = sh.staff_id
    JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id
    WHERE sh.tenant_id = ? AND sh.staff_id IS NOT NULL AND sh.status = 'published' AND DATE(sh.starts_at) = ?
    ORDER BY p.first_name, p.last_name`, [t, day]);
  return {
    lessons: sessions.length, students: students.length,
    instructors: instructors.map((i) => `${i.first_name} ${i.last_name}`),
    waivers: { on_file: onFile.length, of: students.length },
    slots: [...bySlot.values()].map((g) => ({ time: String(g.starts_at).slice(11, 16), level: g.level, discipline: g.discipline, sessions: g.sessions, students: g.students })).sort((a, b) => a.time.localeCompare(b.time) || a.level.localeCompare(b.level)),
  };
}

router.get('/summary', async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await one(pool, 'SELECT timezone, name FROM tenants WHERE id = ?', [t]));
  const today = todayIn(tz.timezone);
  const day = req.query.date ? String(req.query.date) : today;
  if (!DAY.test(day) || day > today) throw bad('Choose a date up to today');
  const season = seasonFor(day);
  const out = { mountain: tz.name, date: day, today: day === today, season };
  // Patrol's fields stay at the top level, exactly as before (2026.10.18), so nothing that already reads this
  // response breaks when a mountain adds Ski school. School's own counts sit under their own key.
  if (req.areaOn.patrol) Object.assign(out, await patrolSummary(t, day, today, season));
  if (req.areaOn.school) out.school = await schoolSummary(t, day, season);
  res.json(out);
});

/** Approved reports only, newest first; no names in the list. Patrol's own records, whatever else the mountain has on. */
router.get('/reports', async (req, res) => {
  if (!req.areaOn.patrol) throw forbidden('Patrol is not turned on for your mountain');
  const t = req.auth.tenantId;
  const to = DAY.test(String(req.query.to || '')) ? String(req.query.to) : '9999-12-31';
  const from = DAY.test(String(req.query.from || '')) ? String(req.query.from) : '1970-01-01';
  const data = await rows(pool, `SELECT i.id, i.season, i.seq, i.occurred_at, i.category, i.severity, i.location, i.disposition,
      (SELECT MAX(v.created_at) FROM incident_versions v WHERE v.tenant_id = i.tenant_id AND v.incident_id = i.id AND v.kind = 'approved') AS approved_at
    FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'approved' AND DATE(i.occurred_at) BETWEEN ? AND ? ORDER BY i.occurred_at DESC LIMIT 200`, [t, from, to]);
  res.json({ data: data.map((r) => ({ id: r.id, case_number: caseNo(r), occurred_at: r.occurred_at, category: r.category, severity: r.severity, location: r.location, disposition: r.disposition, approved_at: r.approved_at })) });
});

/**
 * The ski area login reads the report, not the patrol's sign-ins: who typed a note, struck an entry or uploaded a photo is
 * kept as a patrol sign-in (an email) in the frozen copy, and is taken out here (2026.11.11). Responders stay, by name
 * and role, as on any injury report.
 */
const STAFF_KEY = /^(author|author_user|[a-z_]*_email|[a-z_]*_by_name|recorded_by|voided_by|staff_id|reported_by_staff|submitted_by|approved_by|returned_by|escalated_by)$/;
function forArea(v) {
  if (Array.isArray(v)) return v.map(forArea);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = STAFF_KEY.test(k) && k !== 'guardian_email' && k !== 'email' ? null : forArea(x);
  return out;
}

/** One approved report: the frozen copy made when it was approved, never the case as it is being edited. */
router.get('/reports/:id', async (req, res) => {
  if (!req.areaOn.patrol) throw forbidden('Patrol is not turned on for your mountain');
  const t = req.auth.tenantId; const id = paramId(req);
  const i = await one(pool, "SELECT id, season, seq FROM incidents WHERE tenant_id = ? AND id = ? AND report_state = 'approved'", [t, id]);
  if (!i) throw notFound('Approved report');
  // A patient record: the same rule as Patrol (lib/patientaccess.js). The ski area login has no cases of its own, so it
  // makes the fresh check (30 minutes) before opening a report.
  await require('../lib/patientaccess').guard(pool, req, id);
  const v = await one(pool, "SELECT version_no, snapshot, created_at FROM incident_versions WHERE tenant_id = ? AND incident_id = ? AND kind = 'approved' ORDER BY version_no DESC LIMIT 1", [t, id]);
  if (!v) throw notFound('Approved report');
  await audit(pool, req, 'area_view', 'incidents', id, { version: v.version_no });
  const snap = JSON.parse(v.snapshot);
  res.json({ case_number: caseNo(i), version_no: v.version_no, approved_at: v.created_at, case: req.auth.role === 'area' ? forArea(snap) : snap });
});

module.exports = router;
module.exports.forArea = forArea;
