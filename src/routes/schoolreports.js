'use strict';
// The owner's ski school reports (feat/school-pay, lib/ownerreports.js). Owners and managers only: a ski school Director
// or Supervisor (an instructor login) never reads them. Each has a CSV download (?format=csv). Mounted at /skischool.
//   GET /owner-reports/revenue-per-hour?from&to    lesson revenue per instructor hour
//   GET /owner-reports/cost?from&to                instructor cost against lesson revenue, by day and by product
//   GET /owner-reports/return-rate?season          instructors who taught last season and this season
//   GET /owner-reports/conversion?season           first-timer conversion within 30 days, 60 days and the season
const express = require('express');
const { pool, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { dateStr, todayIn, seasonFor } = require('../lib/util');
const { bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const OR = require('../lib/ownerreports');

const router = express.Router();
const owners = requireRole('manager'); // owners pass every requireRole; instructor logins (any school level) do not
const first = (v) => (Array.isArray(v) ? v[0] : v);

async function range(req) {
  const today = todayIn((await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone);
  const from = req.query.from ? String(first(req.query.from)) : OR.seasonDays(seasonFor(today)).from;
  const to = req.query.to ? String(first(req.query.to)) : today;
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('Use dates such as 2026-12-19');
  if (to < from) throw bad('The last day is before the first');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 370) throw bad('Choose up to a year');
  return { from, to, today };
}
async function season(req) {
  const { today } = await range({ ...req, query: {} });
  const s = req.query.season ? String(first(req.query.season)) : seasonFor(today);
  if (!/^\d{4}-\d{2}$/.test(s)) throw bad('Use a season such as 2026-27');
  return s;
}
function send(req, res, kind, r, name) {
  if (req.query.format !== 'csv') return res.json(r);
  const { cols, data } = OR.csvOf(kind, r);
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename="lessons-${kind}-${name}.csv"`);
  return res.send(toCsv(cols, data));
}

router.get('/owner-reports/revenue-per-hour', owners, async (req, res) => {
  const { from, to } = await range(req);
  const r = await OR.revenuePerHour(pool, req.auth.tenantId, from, to);
  if (req.query.format === 'csv') await audit(pool, req, 'export', 'owner_reports', 0, { report: 'revenue-per-hour', from, to });
  send(req, res, 'revenue-per-hour', r, `${from}-to-${to}`);
});
router.get('/owner-reports/cost', owners, async (req, res) => {
  const { from, to } = await range(req);
  const r = await OR.costVsRevenue(pool, req.auth.tenantId, from, to);
  if (req.query.format === 'csv') await audit(pool, req, 'export', 'owner_reports', 0, { report: 'cost', from, to });
  send(req, res, 'cost', r, `${from}-to-${to}`);
});
router.get('/owner-reports/return-rate', owners, async (req, res) => {
  const s = await season(req);
  const r = await OR.returnRate(pool, req.auth.tenantId, s);
  if (req.query.format === 'csv') await audit(pool, req, 'export', 'owner_reports', 0, { report: 'return-rate', season: s });
  send(req, res, 'return-rate', r, s);
});
router.get('/owner-reports/conversion', owners, async (req, res) => {
  const s = await season(req);
  const r = await OR.conversion(pool, req.auth.tenantId, s);
  if (req.query.format === 'csv') await audit(pool, req, 'export', 'owner_reports', 0, { report: 'conversion', season: s });
  send(req, res, 'conversion', r, s);
});

module.exports = { router };
