'use strict';

// Reports for managers: the day (Today screen) and the week (Money > Weekly report).
const express = require('express');
const { pool, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { dateStr, todayIn, addDays, z, validate } = require('../lib/util');
const { audit } = require('../lib/audit');
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
  const r = await mailer.send({ tenantId: req.auth.tenantId, to: me.email, fromName: t.name, subject: m.subject, text: m.text, html: m.html, tag: 'weekly-report-test' });
  if (!r.ok) throw conflict('The email could not be sent. Please try again.');
  res.json({ ok: true, to: me.email });
});

// ---------------------------------------------------------------- forecast data (Money, Forecast data; lib/snapshots.js)
/**
 * What is being collected for the forecast: which of the last 28 days have snapshots, this morning's presales for the
 * next 14 days beside the same days last year (52 weeks back, so the same weekdays) at the same days ahead, and today's
 * hourly wind. Counts and weather only.
 */
router.get('/forecast-data', requireRole('manager'), async (req, res) => {
  const S = require('../lib/snapshots');
  const t = await one(pool, 'SELECT timezone, map_lat, map_lng, wx_summit_lat, wx_summit_lng FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const today = todayIn(t.timezone);
  const [days, pre, wx, total] = await Promise.all([
    S.coverage(pool, req.auth.tenantId, addDays(today, -27), today),
    S.latest(pool, req.auth.tenantId, today, 'presales'),
    S.latest(pool, req.auth.tenantId, today, 'forecast'),
    one(pool, 'SELECT COUNT(*) AS n, MIN(on_date) AS since, SUM(backfilled) AS rebuilt FROM daily_snapshots WHERE tenant_id = ?', [req.auth.tenantId]),
  ]);
  const ly = pre ? await S.latest(pool, req.auth.tenantId, addDays(pre.on_date, -364), 'presales') : null;
  const lastYear = ly && ly.on_date === addDays(pre.on_date, -364) ? ly : null;
  const units = (d) => d.tickets.sold + d.lessons.sold + d.rentals.sold;
  const presales = pre ? {
    on_date: pre.on_date, stale: pre.stale, last_year_on: lastYear ? lastYear.on_date : null,
    days: pre.data.days.map((d, i) => {
      const was = lastYear && lastYear.data.days[i];
      return { date: d.date, days_ahead: d.days_ahead, sold: units(d), tickets: d.tickets.sold, lessons: d.lessons.sold, rentals: d.rentals.sold, online_share: d.online_share,
        last_year: was ? { date: was.date, sold: units(was) } : null };
    }),
  } : null;
  const wind = wx && !wx.stale && wx.data.resolution === 'hourly' ? {
    on_date: wx.on_date,
    points: wx.data.points.map((p) => {
      const hours = [];
      p.hourly.time.forEach((time, i) => { if (time.slice(0, 10) === today) hours.push({ time, wind_mph: p.hourly.wind_mph[i], gust_mph: p.hourly.gust_mph[i] }); });
      return { role: p.role, elevation_m: p.elevation_m, hours };
    }),
  } : null;
  const point = (a, b) => (a === null || b === null ? null : { lat: Number(a), lng: Number(b) });
  res.json({ today, days, presales, wind, total: Number(total.n), rebuilt: Number(total.rebuilt || 0), since: total.since ? String(total.since).slice(0, 10) : null,
    points: { map: point(t.map_lat, t.map_lng), summit: point(t.wx_summit_lat, t.wx_summit_lng) } });
});

/** The second weather point, at the top of the mountain (the map point is the base). null clears it. */
router.put('/forecast-data/summit', requireRole('manager'), validate(z.object({ lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable() })), async (req, res) => {
  const { lat, lng } = req.body;
  if ((lat === null) !== (lng === null)) throw bad('Give both latitude and longitude, or neither');
  await pool.query('UPDATE tenants SET wx_summit_lat = ?, wx_summit_lng = ? WHERE id = ?', [lat, lng, req.auth.tenantId]);
  await audit(pool, req, 'update', 'tenants', req.auth.tenantId, { wx_summit_lat: lat, wx_summit_lng: lng });
  res.json({ ok: true });
});

module.exports = router;
