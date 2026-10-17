'use strict';

// The ski area's free read-only view of its patrol (role "area"): the day's patrol summary and the approved reports,
// nothing else. It cannot see cases in progress, patrollers' details or anything outside Patrol, cannot change
// anything, and must use two-step sign-in. Every report it opens is written to the audit log like any patient record.
// Owners and managers can open it too.
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { paramId, todayIn, seasonFor } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const modules = require('../lib/modules');

const router = express.Router();
const viewers = requireRole('area', 'manager');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const caseNo = (r) => (r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : `#${r.id}`);

router.use(viewers, async (req, _res, next) => {
  try { await modules.requireModule(req.auth.tenantId, 'patrol'); next(); } catch (e) { next(e); }
});

/** One day of patrol, counts only: who was on, what was checked, what was called, what is approved. */
router.get('/summary', async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await one(pool, 'SELECT timezone, name FROM tenants WHERE id = ?', [t]));
  const today = todayIn(tz.timezone);
  const day = req.query.date ? String(req.query.date) : today;
  if (!DAY.test(day) || day > today) throw bad('Choose a date up to today');
  const season = seasonFor(day);
  const [duty, checked, holds, calls, reports, seasonCalls] = await Promise.all([
    one(pool, 'SELECT COUNT(DISTINCT staff_id) AS n FROM patrol_duty WHERE tenant_id = ? AND on_date = ?', [t, day]),
    one(pool, 'SELECT COUNT(DISTINCT trail_id) AS n FROM patrol_opening_checks WHERE tenant_id = ? AND on_date = ?', [t, day]),
    day === today ? rows(pool, "SELECT name, closure_reason FROM trails WHERE tenant_id = ? AND status = 'hold' ORDER BY name", [t]) : Promise.resolve([]),
    rows(pool, 'SELECT category, severity, disposition FROM incidents WHERE tenant_id = ? AND DATE(occurred_at) = ?', [t, day]),
    one(pool, "SELECT SUM(report_state = 'approved') AS approved, SUM(report_state <> 'approved' OR report_state IS NULL) AS waiting FROM incidents WHERE tenant_id = ? AND DATE(occurred_at) = ?", [t, day]),
    rows(pool, 'SELECT category, COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND season = ? GROUP BY category ORDER BY n DESC', [t, season]),
  ]);
  const count = (key) => calls.reduce((m, c) => { const k = c[key] || 'not_recorded'; m[k] = (m[k] || 0) + 1; return m; }, {});
  res.json({
    mountain: tz.name, date: day, today: day === today, season,
    on_duty: Number(duty.n), runs_checked: Number(checked.n), holds,
    calls: { total: calls.length, by_category: count('category'), by_severity: count('severity'), transported: calls.filter((c) => c.disposition === 'transported').length },
    reports: { approved: Number(reports.approved || 0), waiting: Number(reports.waiting || 0) },
    season_calls: seasonCalls.map((r) => ({ category: r.category, n: Number(r.n) })),
  });
});

/** Approved reports only, newest first; no names in the list. */
router.get('/reports', async (req, res) => {
  const t = req.auth.tenantId;
  const to = DAY.test(String(req.query.to || '')) ? String(req.query.to) : '9999-12-31';
  const from = DAY.test(String(req.query.from || '')) ? String(req.query.from) : '1970-01-01';
  const data = await rows(pool, `SELECT i.id, i.season, i.seq, i.occurred_at, i.category, i.severity, i.location, i.disposition,
      (SELECT MAX(v.created_at) FROM incident_versions v WHERE v.tenant_id = i.tenant_id AND v.incident_id = i.id AND v.kind = 'approved') AS approved_at
    FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'approved' AND DATE(i.occurred_at) BETWEEN ? AND ? ORDER BY i.occurred_at DESC LIMIT 200`, [t, from, to]);
  res.json({ data: data.map((r) => ({ id: r.id, case_number: caseNo(r), occurred_at: r.occurred_at, category: r.category, severity: r.severity, location: r.location, disposition: r.disposition, approved_at: r.approved_at })) });
});

/** One approved report: the frozen copy made when it was approved, never the case as it is being edited. */
router.get('/reports/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const i = await one(pool, "SELECT id, season, seq FROM incidents WHERE tenant_id = ? AND id = ? AND report_state = 'approved'", [t, id]);
  if (!i) throw notFound('Approved report');
  const v = await one(pool, "SELECT version_no, snapshot, created_at FROM incident_versions WHERE tenant_id = ? AND incident_id = ? AND kind = 'approved' ORDER BY version_no DESC LIMIT 1", [t, id]);
  if (!v) throw notFound('Approved report');
  await audit(pool, req, 'area_view', 'incidents', id, { version: v.version_no });
  res.json({ case_number: caseNo(i), version_no: v.version_no, approved_at: v.created_at, case: JSON.parse(v.snapshot) });
});

module.exports = router;
