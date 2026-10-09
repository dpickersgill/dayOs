'use strict';

// Instructor availability. Each instructor marks the dates and times they are open, whenever plans change, and can choose to be
// listed on a public page with a short bio, the disciplines they teach and their levels. Guests can only look: they cannot
// request or book anything from it. Managers can edit for any instructor, and turn the public page on or off.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { z, dateStr, validate, paramId, todayIn, nowIn, addDays } = require('../lib/util');
const { notFound, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();
const publicRouter = express.Router();
const DISCIPLINES = [['ski', 'Ski'], ['snowboard', 'Snowboard'], ['telemark', 'Telemark'], ['adaptive', 'Adaptive']];
const LEVELS = [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']];
const KEYS = (list) => list.map((x) => x[0]);
const MAX_DAYS_AHEAD = 366;
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a time such as 09:00');
const hhmm = (t) => String(t).slice(0, 5);
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const first = (v) => String(Array.isArray(v) ? v[0] : v);
const csv = (s) => (s ? String(s).split(',').filter(Boolean) : []);
const tz = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const NAME = "NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), '')";

const crew = requireRole('instructor', 'manager');
const lookers = requireRole('instructor', 'manager', 'counter');

/** Whose availability a request is about: your own, or (managers only) the instructor named by staff_id. */
async function target(conn, req, asked) {
  const mine = req.auth.staffId;
  const wanted = asked ? Number(asked) : mine;
  if (!wanted) throw bad(isManager(req) ? 'Choose an instructor' : 'Your login is not linked to a staff record yet. Ask a manager to link it.');
  if (wanted !== mine && !isManager(req)) throw forbidden('You can only change your own availability');
  const s = await one(conn, `SELECT s.id, ${NAME} AS name, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?`, [req.auth.tenantId, wanted]);
  if (!s) throw notFound('Instructor');
  return s;
}
const shortName = (s, p) => (p && p.display_name) || `${s.first_name || ''} ${s.last_name ? `${s.last_name[0]}.` : ''}`.trim();

router.get('/meta', (_req, res) => res.json({ disciplines: DISCIPLINES.map(([value, label]) => ({ value, label })), levels: LEVELS.map(([value, label]) => ({ value, label })) }));

// ---------------------------------------------------------------- the page switch
router.get('/settings', lookers, async (req, res) => {
  const t = await one(pool, 'SELECT slug, show_instructor_availability AS on_ FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.json({ public: Boolean(t.on_), slug: t.slug });
});
router.put('/settings', requireRole('manager'), validate(z.object({ public: z.boolean() })), async (req, res) => {
  await pool.query('UPDATE tenants SET show_instructor_availability = ? WHERE id = ?', [req.body.public ? 1 : 0, req.auth.tenantId]);
  await audit(pool, req, 'update', 'availability_settings', req.auth.tenantId, req.body);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- who the instructors are
router.get('/instructors', lookers, async (req, res) => {
  const data = await rows(pool, `SELECT s.id, ${NAME} AS name, COALESCE(ip.is_public, 0) AS is_public,
      (SELECT COUNT(*) FROM instructor_open o WHERE o.tenant_id = s.tenant_id AND o.staff_id = s.id AND o.open_date >= ?) AS upcoming
    FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id LEFT JOIN instructor_profiles ip ON ip.tenant_id = s.tenant_id AND ip.staff_id = s.id
    WHERE s.tenant_id = ? AND s.status = 'active' AND (ip.staff_id IS NOT NULL OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = s.tenant_id AND u.staff_id = s.id AND u.role = 'instructor'))
    ORDER BY name`, [todayIn(await tz(req.auth.tenantId)), req.auth.tenantId]);
  res.json({ data: data.map((r) => ({ ...r, is_public: Boolean(r.is_public), upcoming: Number(r.upcoming) })) });
});

// ---------------------------------------------------------------- one instructor: profile and open times
router.get('/me', crew, async (req, res) => {
  const s = await target(pool, req, req.query.staff_id);
  const today = todayIn(await tz(req.auth.tenantId));
  const p = await one(pool, 'SELECT is_public, display_name, bio, disciplines, levels FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, s.id]);
  const windows = await rows(pool, 'SELECT id, open_date, start_time, end_time, note FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date >= ? ORDER BY open_date, start_time', [req.auth.tenantId, s.id, today]);
  res.json({
    staff: { id: s.id, name: s.name }, today,
    profile: { is_public: Boolean(p && p.is_public), display_name: p ? p.display_name : null, bio: p ? p.bio : null, disciplines: p ? csv(p.disciplines) : [], levels: p ? csv(p.levels) : [], shown_as: shortName(s, p) },
    windows: windows.map((w) => ({ id: w.id, open_date: ymd(w.open_date), start_time: hhmm(w.start_time), end_time: hhmm(w.end_time), note: w.note })),
  });
});

const profileSchema = z.object({
  staff_id: z.number().int().positive().optional(),
  is_public: z.boolean(),
  display_name: z.string().trim().max(60).nullable().optional(),
  bio: z.string().trim().max(600).nullable().optional(),
  disciplines: z.array(z.string()).max(8).default([]),
  levels: z.array(z.string()).max(8).default([]),
});
router.put('/profile', crew, validate(profileSchema), async (req, res) => {
  const b = req.body;
  if (b.disciplines.some((d) => !KEYS(DISCIPLINES).includes(d)) || b.levels.some((d) => !KEYS(LEVELS).includes(d))) throw bad('Unknown discipline or level');
  if (b.is_public && !b.disciplines.length) throw bad('Choose at least one thing you teach before listing yourself publicly');
  const s = await target(pool, req, b.staff_id);
  await pool.query(`INSERT INTO instructor_profiles (tenant_id, staff_id, is_public, display_name, bio, disciplines, levels) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE is_public = VALUES(is_public), display_name = VALUES(display_name), bio = VALUES(bio), disciplines = VALUES(disciplines), levels = VALUES(levels)`,
  [req.auth.tenantId, s.id, b.is_public ? 1 : 0, b.display_name || null, b.bio || null, [...new Set(b.disciplines)].join(','), [...new Set(b.levels)].join(',')]);
  await audit(pool, req, 'profile', 'instructor_profiles', s.id, { is_public: b.is_public });
  res.json({ ok: true });
});

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;

/** Mark times open on one or more dates. Overlapping or touching times on the same day are joined into one. */
router.post('/windows', crew, validate(z.object({ staff_id: z.number().int().positive().optional(), dates: z.array(dateStr).min(1).max(62), start_time: timeStr, end_time: timeStr, note: z.string().trim().max(120).nullable().optional() })), async (req, res) => {
  const b = req.body;
  const start = toMin(b.start_time); const end = toMin(b.end_time);
  if (end <= start) throw bad('The end time must be after the start time');
  const today = todayIn(await tz(req.auth.tenantId));
  const dates = [...new Set(b.dates)].sort();
  if (dates[0] < today) throw bad('You can only mark dates from today onward');
  if (dates[dates.length - 1] > addDays(today, MAX_DAYS_AHEAD)) throw bad('That is too far ahead. Use dates within the next year.');
  const s = await target(pool, req, b.staff_id);
  await tx(async (conn) => {
    for (const date of dates) {
      const existing = await rows(conn, 'SELECT id, start_time, end_time, note FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date = ? FOR UPDATE', [req.auth.tenantId, s.id, date]);
      let from = start; let to = end; let note = b.note || null;
      for (const w of existing) {
        const ws = toMin(hhmm(w.start_time)); const we = toMin(hhmm(w.end_time));
        if (ws <= to && we >= from) { from = Math.min(from, ws); to = Math.max(to, we); note = note || w.note; await conn.query('DELETE FROM instructor_open WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, w.id]); }
      }
      await conn.query('INSERT INTO instructor_open (tenant_id, staff_id, open_date, start_time, end_time, note) VALUES (?, ?, ?, ?, ?, ?)', [req.auth.tenantId, s.id, date, fromMin(from), fromMin(to), note]);
    }
    await audit(conn, req, 'open_times', 'instructor_open', s.id, { dates: dates.length });
  });
  res.status(201).json({ ok: true, days: dates.length });
});

router.delete('/windows/:id', crew, async (req, res) => {
  const id = paramId(req);
  const w = await one(pool, 'SELECT staff_id FROM instructor_open WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!w) throw notFound('Time');
  if (w.staff_id !== req.auth.staffId && !isManager(req)) throw forbidden('You can only change your own availability');
  await pool.query('DELETE FROM instructor_open WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  res.status(204).end();
});

/** Take every open time off the chosen days. */
router.post('/windows/clear', crew, validate(z.object({ staff_id: z.number().int().positive().optional(), dates: z.array(dateStr).min(1).max(62) })), async (req, res) => {
  const s = await target(pool, req, req.body.staff_id);
  const [r] = await pool.query(`DELETE FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date IN (${req.body.dates.map(() => '?').join(',')}) AND open_date >= ?`, [req.auth.tenantId, s.id, ...req.body.dates, todayIn(await tz(req.auth.tenantId))]);
  res.json({ cleared: r.affectedRows });
});

// ---------------------------------------------------------------- everyone, for the ski school desk
router.get('/overview', lookers, async (req, res) => {
  const today = todayIn(await tz(req.auth.tenantId));
  const from = req.query.from ? first(req.query.from) : today;
  const to = req.query.to ? first(req.query.to) : addDays(from, 13);
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('Use YYYY-MM-DD');
  if (to < from || (new Date(to) - new Date(from)) / 864e5 > 92) throw bad('Choose up to 92 days');
  const data = await rows(pool, `SELECT o.id, o.staff_id, ${NAME} AS name, o.open_date, o.start_time, o.end_time, o.note, COALESCE(ip.is_public, 0) AS is_public
    FROM instructor_open o JOIN staff s ON s.tenant_id = o.tenant_id AND s.id = o.staff_id AND s.status = 'active' JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    LEFT JOIN instructor_profiles ip ON ip.tenant_id = o.tenant_id AND ip.staff_id = o.staff_id
    WHERE o.tenant_id = ? AND o.open_date BETWEEN ? AND ? ORDER BY o.open_date, o.start_time, name`, [req.auth.tenantId, from, to]);
  res.json({ from, to, data: data.map((w) => ({ id: w.id, staff_id: w.staff_id, name: w.name, open_date: ymd(w.open_date), start_time: hhmm(w.start_time), end_time: hhmm(w.end_time), note: w.note, is_public: Boolean(w.is_public) })) });
});

// ---------------------------------------------------------------- the public page (read only)
publicRouter.get('/:slug/instructor-availability', async (req, res) => {
  const t = await one(pool, 'SELECT id, name, phone, timezone, show_instructor_availability AS on_ FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t || !t.on_) throw notFound('Availability page');
  const now = nowIn(t.timezone);
  const today = now.slice(0, 10);
  const profs = await rows(pool, `SELECT s.id, p.first_name, p.last_name, ip.display_name, ip.bio, ip.disciplines, ip.levels FROM instructor_profiles ip
    JOIN staff s ON s.tenant_id = ip.tenant_id AND s.id = ip.staff_id AND s.status = 'active' JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE ip.tenant_id = ? AND ip.is_public = 1`, [t.id]);
  const key = new Map(profs.map((p, i) => [p.id, `i${i + 1}`]));
  const wins = key.size ? await rows(pool, `SELECT staff_id, open_date, start_time, end_time, note FROM instructor_open WHERE tenant_id = ? AND staff_id IN (${[...key.keys()].map(() => '?').join(',')}) AND open_date BETWEEN ? AND ? ORDER BY open_date, start_time`, [t.id, ...key.keys(), today, addDays(today, 60)]) : [];
  const days = new Map();
  for (const w of wins) {
    const date = ymd(w.open_date);
    if (date === today && hhmm(w.end_time) <= now.slice(11, 16)) continue;
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({ instructor: key.get(w.staff_id), start: hhmm(w.start_time), end: hhmm(w.end_time), note: w.note });
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    mountain: t.name, phone: t.phone, today,
    instructors: profs.map((p) => ({ id: key.get(p.id), name: shortName(p, p), bio: p.bio, disciplines: csv(p.disciplines), levels: csv(p.levels) })),
    days: [...days].map(([date, slots]) => ({ date, slots })),
    disciplines: Object.fromEntries(DISCIPLINES), levels: Object.fromEntries(LEVELS),
  });
});

module.exports = { router, publicRouter };
