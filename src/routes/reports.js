'use strict';

// Reports for managers: the day (Today screen) and the week (Money > Weekly report).
const express = require('express');
const { pool, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { dateStr, todayIn, addDays } = require('../lib/util');
const { bad, conflict } = require('../lib/errors');
const { dailyReport } = require('../lib/daily');
const weekly = require('../lib/weekly');
const mailer = require('../lib/mailer');

const router = express.Router();

/** One-call dashboard for the general manager: the numbers they check every morning and every night. */
router.get('/daily', requireRole('manager'), async (req, res) => {
  res.json(await dailyReport(req.auth.tenantId, req.query.date ? String(req.query.date) : null));
});

/** The week's numbers (Monday to Sunday). week: any date in the week; omitted means last week. */
router.get('/weekly', requireRole('manager'), async (req, res) => {
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const asked = req.query.week ? String(req.query.week) : null;
  if (asked && !dateStr.safeParse(asked).success) throw bad('week must be YYYY-MM-DD');
  const start = weekly.weekStartOf(asked || addDays(todayIn(tenant.timezone), -7));
  res.json(await weekly.buildWeek(req.auth.tenantId, start));
});

/** Email the chosen week's report to the person asking, so they can see exactly what owners get on Monday. */
router.post('/weekly/email-me', requireRole('manager'), async (req, res) => {
  if (!mailer.enabled()) throw conflict('Email is not set up yet (see Help, "Set up email and text messages")');
  const week = req.body && req.body.week ? String(req.body.week) : null;
  if (week && !dateStr.safeParse(week).success) throw bad('week must be YYYY-MM-DD');
  const t = await one(pool, 'SELECT name, timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const me = await one(pool, 'SELECT email FROM users WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, req.auth.userId]);
  const m = weekly.renderEmail(await weekly.buildWeek(req.auth.tenantId, weekly.weekStartOf(week || addDays(todayIn(t.timezone), -7))), t);
  const r = await mailer.send({ to: me.email, fromName: t.name, subject: m.subject, text: m.text, html: m.html, tag: 'weekly-report-test' });
  if (!r.ok) throw conflict('The email could not be sent. Please try again.');
  res.json({ ok: true, to: me.email });
});

module.exports = router;
