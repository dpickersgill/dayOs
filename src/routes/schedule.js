'use strict';

const express = require('express');
const { pool, rows, one } = require('../db');
const { crud } = require('../lib/crud');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, dateTimeStr, timeStr, validate, normDateTime, addDays, todayIn } = require('../lib/util');
const { notFound, conflict } = require('../lib/errors');
const ops = require('../lib/ops');
const { audit } = require('../lib/audit');

const schedule = express.Router();
const publicRouter = express.Router();

// ---- operating calendar ----
schedule.get('/days', requireRole('staff', 'counter', 'instructor', 'patrol', 'manager'), async (req, res) => {
  const from = String(req.query.from || '0000-01-01');
  const to = String(req.query.to || '9999-12-31');
  res.json({ data: await rows(pool, 'SELECT * FROM calendar_days WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date LIMIT 400', [req.auth.tenantId, from, to]) });
});

schedule.put(
  '/days/:date',
  requireRole('manager'),
  validate(z.object({ status: z.enum(['open', 'limited', 'closed']), open_time: timeStr.nullable().optional(), close_time: timeStr.nullable().optional(), notes: z.string().max(500).nullable().optional() })),
  async (req, res) => {
    if (!dateStr.safeParse(req.params.date).success) return res.status(400).json({ error: 'Use YYYY-MM-DD' });
    const b = req.body;
    await pool.query(
      `INSERT INTO calendar_days (tenant_id, on_date, status, open_time, close_time, notes) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), open_time = VALUES(open_time), close_time = VALUES(close_time), notes = VALUES(notes)`,
      [req.auth.tenantId, req.params.date, b.status, b.open_time ?? null, b.close_time ?? null, b.notes ?? null],
    );
    await audit(pool, req, 'set_day', 'calendar_days', null, { date: req.params.date, ...b });
    return res.json({ on_date: req.params.date, ...b });
  },
);

// ---- lifts, trails, events ----
const liftFields = { name: z.string().min(1).max(100), status: z.enum(['open', 'hold', 'wind_hold', 'closed']).optional() };
const trailFields = {
  name: z.string().min(1).max(100),
  difficulty: z.enum(['green', 'blue', 'black', 'double_black', 'park']).optional(),
  status: z.enum(['open', 'closed']).optional(),
  groomed: z.coerce.number().int().min(0).max(1).optional(),
};
const eventFields = {
  title: z.string().min(1).max(255),
  starts_at: dateTimeStr.transform(normDateTime),
  ends_at: dateTimeStr.transform(normDateTime).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
};

// Lift and trail status changes are routine operations, so patrol and general staff may update them too.
// A lift with a failed pre-opening inspection today cannot be opened until a new inspection passes. Status changes also keep the
// downtime log in step, so the daily report knows how long each lift was down.
schedule.patch('/lifts/:id', async (req, res, next) => {
  try {
    const status = req.body && req.body.status;
    const id = Number(req.params.id);
    if (!status || !Number.isInteger(id) || !['owner', 'manager', 'patrol', 'staff'].includes(req.auth.role)) return next();
    const cur = await one(pool, 'SELECT status FROM lifts WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
    if (!cur || cur.status === status) return next();
    if (status === 'open') {
      const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
      const check = await ops.latestCheck(pool, req.auth.tenantId, id, todayIn(tz));
      if (check && check.result === 'fail') throw conflict('This lift failed its inspection today. Pass a new inspection before opening it.');
    }
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      ops.syncDowntime(pool, req.auth.tenantId, id, cur.status, status, { userId: req.auth.userId }).catch(() => {});
    });
    return next();
  } catch (err) { return next(err); }
});
schedule.use('/lifts', crud({ table: 'lifts', entity: 'Lift', createSchema: z.object(liftFields), updateSchema: partialOf(liftFields), columns: ['name', 'status'], filters: ['status'], orderBy: 'name', readRoles: 'any', writeRoles: ['manager', 'patrol', 'staff'] }));
schedule.use('/trails', crud({ table: 'trails', entity: 'Trail', createSchema: z.object(trailFields), updateSchema: partialOf(trailFields), columns: ['name', 'difficulty', 'status', 'groomed'], filters: ['status', 'difficulty'], orderBy: 'name', readRoles: 'any', writeRoles: ['manager', 'patrol', 'staff'] }));
schedule.use('/events', crud({ table: 'events', entity: 'Event', createSchema: z.object(eventFields), updateSchema: partialOf(eventFields), columns: ['title', 'starts_at', 'ends_at', 'description'], orderBy: 'starts_at', readRoles: 'any', writeRoles: ['manager'] }));

/**
 * Public, unauthenticated conditions feed for a mountain's website or app.
 * Exposes only operating status; no people, prices or internal notes beyond the public day note.
 */
publicRouter.get('/:slug/conditions', async (req, res) => {
  const tenant = await one(pool, 'SELECT id, name, timezone FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!tenant) throw notFound('Mountain');
  const today = todayIn(tenant.timezone);
  const [day, lifts, trails, events] = await Promise.all([
    one(pool, 'SELECT status, open_time, close_time, notes FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [tenant.id, today]),
    rows(pool, 'SELECT name, status, updated_at FROM lifts WHERE tenant_id = ? ORDER BY name', [tenant.id]),
    rows(pool, 'SELECT name, difficulty, status, groomed FROM trails WHERE tenant_id = ? ORDER BY name', [tenant.id]),
    rows(pool, 'SELECT title, starts_at, ends_at FROM events WHERE tenant_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at LIMIT 10', [tenant.id, today, addDays(today, 8)]),
  ]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    mountain: tenant.name,
    date: today,
    day: day || { status: 'closed' },
    lifts_open: lifts.filter((l) => l.status === 'open').length,
    lifts,
    trails_open: trails.filter((t) => t.status === 'open').length,
    trails,
    upcoming_events: events,
  });
});

module.exports = { schedule, publicRouter };
