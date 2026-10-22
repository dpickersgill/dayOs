'use strict';

// Grooming, snow and weather, snowmaking. Everything is a record the crew keeps through the shift.
// Staff, patrol and managers can read and write. A manager removes records.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, dateTimeStr, validate, paramId, normDateTime, setClause, todayIn, nowIn, addDays } = require('../lib/util');
const dayrecord = require('../lib/dayrecord');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { SURFACE_KEYS } = require('../lib/ops');

const router = express.Router();
const crew = requireRole('staff', 'manager', 'patrol');
const manager = requireRole('manager');
router.use(crew);

const tenantTz = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const first = (v) => String(Array.isArray(v) ? v[0] : v);
const num = (min, max) => z.number().min(min).max(max).nullable().optional();
const when = dateTimeStr.transform(normDateTime);
const nullable = (s) => s.nullable().optional();

// ---------------------------------------------------------------- grooming plan
const SHIFTS = ['night', 'day'];
const planFields = {
  plan_date: dateStr,
  shift: z.enum(SHIFTS).default('night'),
  trail_id: z.number().int().positive(),
  asset_id: nullable(z.number().int().positive()),
  operator_staff_id: nullable(z.number().int().positive()),
  priority: z.number().int().min(1).max(99).default(5),
  note: nullable(z.string().max(255)),
};
const PLAN_SQL = `SELECT g.id, g.plan_date, g.shift, g.trail_id, g.asset_id, g.operator_staff_id, g.priority, g.status, g.started_at, g.finished_at,
    g.machine_hours, g.fuel_gal, g.note, t.name AS trail, t.difficulty, t.groomed, a.name AS asset, CONCAT(p.first_name, ' ', p.last_name) AS operator
  FROM groom_plans g
  JOIN trails t ON t.tenant_id = g.tenant_id AND t.id = g.trail_id
  LEFT JOIN ops_assets a ON a.tenant_id = g.tenant_id AND a.id = g.asset_id
  LEFT JOIN staff s ON s.tenant_id = g.tenant_id AND s.id = g.operator_staff_id
  LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id`;

async function checkRefs(conn, tenantId, b) {
  if (b.trail_id && !(await one(conn, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ?', [tenantId, b.trail_id]))) throw notFound('Trail');
  if (b.asset_id) {
    const a = await one(conn, 'SELECT id, status FROM ops_assets WHERE tenant_id = ? AND id = ?', [tenantId, b.asset_id]);
    if (!a) throw notFound('Machine');
    if (a.status === 'retired') throw bad('That machine is retired');
  }
  if (b.operator_staff_id && !(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [tenantId, b.operator_staff_id]))) throw notFound('Staff member');
}

router.get('/groom/plan', async (req, res) => {
  const date = req.query.date ? first(req.query.date) : todayIn(await tenantTz(req.auth.tenantId));
  if (!dateStr.safeParse(date).success) throw bad('Use YYYY-MM-DD');
  const shift = SHIFTS.includes(first(req.query.shift || '')) ? first(req.query.shift) : 'night';
  const data = await rows(pool, `${PLAN_SQL} WHERE g.tenant_id = ? AND g.plan_date = ? AND g.shift = ? ORDER BY g.priority, t.name`, [req.auth.tenantId, date, shift]);
  res.json({ data, date, shift });
});

router.post('/groom/plan', validate(z.object(planFields)), async (req, res) => {
  const id = await tx(async (conn) => {
    await checkRefs(conn, req.auth.tenantId, req.body);
    try {
      const [r] = await conn.query('INSERT INTO groom_plans (tenant_id, plan_date, shift, trail_id, asset_id, operator_staff_id, priority, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [req.auth.tenantId, req.body.plan_date, req.body.shift, req.body.trail_id, req.body.asset_id ?? null, req.body.operator_staff_id ?? null, req.body.priority, req.body.note ?? null]);
      await audit(conn, req, 'create', 'groom_plans', r.insertId);
      return r.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('That trail is already in this plan');
      throw err;
    }
  });
  res.status(201).json({ id });
});

/** Add every trail that is not groomed yet (or every trail with all=true) that is not already in the plan. Park trails are left out unless asked for. */
router.post('/groom/plan/fill', validate(z.object({ plan_date: dateStr, shift: z.enum(SHIFTS).default('night'), all: z.boolean().optional(), asset_id: nullable(z.number().int().positive()) })), async (req, res) => {
  const out = await tx(async (conn) => {
    await checkRefs(conn, req.auth.tenantId, { asset_id: req.body.asset_id });
    const trails = await rows(conn, `SELECT t.id, t.difficulty FROM trails t WHERE t.tenant_id = ? ${req.body.all ? '' : 'AND t.groomed = 0'} AND t.difficulty <> 'park'
      AND NOT EXISTS (SELECT 1 FROM groom_plans g WHERE g.tenant_id = t.tenant_id AND g.plan_date = ? AND g.shift = ? AND g.trail_id = t.id) ORDER BY FIELD(t.difficulty, 'green', 'blue', 'black', 'double_black'), t.name`, [req.auth.tenantId, req.body.plan_date, req.body.shift]);
    const { n } = await one(conn, 'SELECT COALESCE(MAX(priority), 0) AS n FROM groom_plans WHERE tenant_id = ? AND plan_date = ? AND shift = ?', [req.auth.tenantId, req.body.plan_date, req.body.shift]);
    let at = Number(n);
    for (const t of trails) {
      at += 1;
      await conn.query('INSERT INTO groom_plans (tenant_id, plan_date, shift, trail_id, asset_id, priority) VALUES (?, ?, ?, ?, ?, ?)', [req.auth.tenantId, req.body.plan_date, req.body.shift, t.id, req.body.asset_id ?? null, Math.min(at, 99)]);
    }
    await audit(conn, req, 'fill', 'groom_plans', null, { added: trails.length, date: req.body.plan_date });
    return trails.length;
  });
  res.json({ added: out });
});

router.patch('/groom/plan/:id', validate(partialOf({ asset_id: planFields.asset_id, operator_staff_id: planFields.operator_staff_id, priority: planFields.priority, note: planFields.note })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await checkRefs(conn, req.auth.tenantId, req.body);
    const set = setClause(req.body, ['asset_id', 'operator_staff_id', 'priority', 'note']);
    if (!set) throw bad('No updatable fields supplied');
    const [r] = await conn.query(`UPDATE groom_plans SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    if (!r.affectedRows) throw notFound('Plan item');
  });
  res.json({ ok: true });
});

const planItem = async (conn, tenantId, id) => {
  const g = await one(conn, 'SELECT * FROM groom_plans WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
  if (!g) throw notFound('Plan item');
  return g;
};

router.post('/groom/plan/:id/start', async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const g = await planItem(conn, req.auth.tenantId, id);
    if (g.status === 'done') throw conflict('This trail is already done');
    if (g.asset_id) {
      const a = await one(conn, 'SELECT status FROM ops_assets WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, g.asset_id]);
      if (a && a.status === 'out_of_service') throw conflict('That machine is out of service. Pick another or fix it first.');
    }
    await conn.query("UPDATE groom_plans SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE tenant_id = ? AND id = ?", [nowIn(await tenantTz(req.auth.tenantId)), req.auth.tenantId, id]);
    await audit(conn, req, 'start', 'groom_plans', id);
  });
  res.json({ ok: true });
});

/** Finishing a trail marks it groomed (what the conditions feed shows) and adds the hours to the machine's meter. */
router.post('/groom/plan/:id/finish', validate(z.object({ machine_hours: num(0, 99), fuel_gal: num(0, 999) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const g = await planItem(conn, req.auth.tenantId, id);
    if (g.status === 'done') throw conflict('This trail is already done');
    const hours = req.body.machine_hours ?? null;
    await conn.query("UPDATE groom_plans SET status = 'done', finished_at = ?, started_at = COALESCE(started_at, ?), machine_hours = ?, fuel_gal = ? WHERE tenant_id = ? AND id = ?",
      [nowIn(await tenantTz(req.auth.tenantId)), nowIn(await tenantTz(req.auth.tenantId)), hours, req.body.fuel_gal ?? null, req.auth.tenantId, id]);
    await conn.query('UPDATE trails SET groomed = 1 WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, g.trail_id]);
    if (g.asset_id && hours) await conn.query('UPDATE ops_assets SET hours = hours + ? WHERE tenant_id = ? AND id = ?', [hours, req.auth.tenantId, g.asset_id]);
    await audit(conn, req, 'finish', 'groom_plans', id, { trail_id: g.trail_id, hours });
  });
  res.json({ ok: true });
});

router.post('/groom/plan/:id/skip', validate(z.object({ note: nullable(z.string().max(255)) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const g = await planItem(conn, req.auth.tenantId, id);
    if (g.status === 'done') throw conflict('This trail is already done');
    await conn.query("UPDATE groom_plans SET status = 'skipped', note = COALESCE(?, note) WHERE tenant_id = ? AND id = ?", [req.body.note ?? null, req.auth.tenantId, id]);
    await audit(conn, req, 'skip', 'groom_plans', id);
  });
  res.json({ ok: true });
});

/** Put a skipped or started item back to planned. */
router.post('/groom/plan/:id/reopen', async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const g = await planItem(conn, req.auth.tenantId, id);
    if (g.status === 'done') throw conflict('A finished trail stays finished. Add it to the plan again if it needs another pass.');
    await conn.query("UPDATE groom_plans SET status = 'planned', started_at = NULL WHERE tenant_id = ? AND id = ?", [req.auth.tenantId, id]);
  });
  res.json({ ok: true });
});

router.delete('/groom/plan/:id', async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const g = await planItem(conn, req.auth.tenantId, id);
    if (g.status === 'done') throw conflict('A finished trail stays on the record');
    await conn.query('DELETE FROM groom_plans WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
    await audit(conn, req, 'delete', 'groom_plans', id);
  });
  res.status(204).end();
});

/** A new grooming day: clear the groomed mark on every trail. */
router.post('/groom/clear-marks', manager, async (req, res) => {
  const [r] = await pool.query('UPDATE trails SET groomed = 0 WHERE tenant_id = ? AND groomed = 1', [req.auth.tenantId]);
  await audit(pool, req, 'clear_marks', 'trails', null, { cleared: r.affectedRows });
  res.json({ cleared: r.affectedRows });
});

// ---------------------------------------------------------------- snow depth and surface
const snowFields = {
  trail_id: nullable(z.number().int().positive()),
  read_at: when.optional(),
  base_in: num(0, 600),
  new_snow_in: num(0, 100),
  surface: nullable(z.string().refine((s) => SURFACE_KEYS.includes(s), 'Unknown surface')),
  quality: nullable(z.enum(['poor', 'fair', 'good', 'excellent'])),
  note: nullable(z.string().max(255)),
};

router.get('/snow', async (req, res) => {
  const where = ['s.tenant_id = ?']; const params = [req.auth.tenantId];
  if (req.query.trail_id) { where.push('s.trail_id = ?'); params.push(Number(first(req.query.trail_id))); }
  if (req.query.from) { where.push('DATE(s.read_at) >= ?'); params.push(first(req.query.from)); }
  if (req.query.to) { where.push('DATE(s.read_at) <= ?'); params.push(first(req.query.to)); }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ data: await rows(pool, `SELECT s.*, t.name AS trail FROM snow_readings s LEFT JOIN trails t ON t.tenant_id = s.tenant_id AND t.id = s.trail_id WHERE ${where.join(' AND ')} ORDER BY s.read_at DESC, s.id DESC LIMIT ?`, [...params, limit]) });
});

/** The newest mountain-wide reading, and the newest reading on each trail that has one. */
router.get('/snow/latest', async (req, res) => {
  const mountain = await one(pool, 'SELECT * FROM snow_readings WHERE tenant_id = ? AND trail_id IS NULL ORDER BY read_at DESC, id DESC LIMIT 1', [req.auth.tenantId]);
  const trails = await rows(pool, `SELECT s.*, t.name AS trail FROM snow_readings s JOIN trails t ON t.tenant_id = s.tenant_id AND t.id = s.trail_id
    WHERE s.tenant_id = ? AND s.id = (SELECT MAX(x.id) FROM snow_readings x WHERE x.tenant_id = s.tenant_id AND x.trail_id = s.trail_id) ORDER BY t.name`, [req.auth.tenantId]);
  res.json({ mountain, trails });
});

router.post('/snow', validate(z.object(snowFields)), async (req, res) => {
  const b = req.body;
  if ([b.base_in, b.new_snow_in, b.surface, b.quality].every((v) => v === null || v === undefined)) throw bad('Enter at least a depth, new snow, surface or quality');
  if (b.trail_id && !(await one(pool, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, b.trail_id]))) throw notFound('Trail');
  const at = b.read_at || nowIn(await tenantTz(req.auth.tenantId));
  const [r] = await pool.query('INSERT INTO snow_readings (tenant_id, trail_id, read_at, base_in, new_snow_in, surface, quality, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.trail_id ?? null, at, b.base_in ?? null, b.new_snow_in ?? null, b.surface ?? null, b.quality ?? null, b.note ?? null, req.auth.userId]);
  await audit(pool, req, 'create', 'snow_readings', r.insertId);
  res.status(201).json({ id: r.insertId });
});

router.delete('/snow/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM snow_readings WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Reading');
  res.status(204).end();
});

// ---------------------------------------------------------------- snowmaking
const makeFields = {
  trail_id: z.number().int().positive(),
  started_at: when.optional(),
  guns: nullable(z.number().int().min(0).max(999)),
  temp_f: num(-60, 80),
  water_gal: nullable(z.number().int().min(0).max(100000000)),
  note: nullable(z.string().max(255)),
};

router.get('/snowmaking', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 300);
  const active = req.query.active === '1' ? 'AND m.ended_at IS NULL' : '';
  res.json({ data: await rows(pool, `SELECT m.*, t.name AS trail FROM snowmaking_runs m JOIN trails t ON t.tenant_id = m.tenant_id AND t.id = m.trail_id WHERE m.tenant_id = ? ${active} ORDER BY m.started_at DESC, m.id DESC LIMIT ?`, [req.auth.tenantId, limit]) });
});

router.post('/snowmaking', validate(z.object(makeFields)), async (req, res) => {
  const b = req.body;
  const id = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, b.trail_id]))) throw notFound('Trail');
    if (await one(conn, 'SELECT id FROM snowmaking_runs WHERE tenant_id = ? AND trail_id = ? AND ended_at IS NULL', [req.auth.tenantId, b.trail_id])) throw conflict('Snowmaking is already running on that trail. Stop it first.');
    const [r] = await conn.query('INSERT INTO snowmaking_runs (tenant_id, trail_id, started_at, guns, temp_f, water_gal, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.auth.tenantId, b.trail_id, b.started_at || nowIn(await tenantTz(req.auth.tenantId)), b.guns ?? null, b.temp_f ?? null, b.water_gal ?? null, b.note ?? null, req.auth.userId]);
    await audit(conn, req, 'start', 'snowmaking_runs', r.insertId);
    return r.insertId;
  });
  res.status(201).json({ id });
});

router.post('/snowmaking/:id/stop', validate(z.object({ ended_at: when.optional(), water_gal: nullable(z.number().int().min(0).max(100000000)), note: nullable(z.string().max(255)) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const m = await one(conn, 'SELECT * FROM snowmaking_runs WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!m) throw notFound('Snowmaking run');
    if (m.ended_at) throw conflict('That run has already stopped');
    const end = req.body.ended_at || nowIn(await tenantTz(req.auth.tenantId));
    if (String(end) < String(m.started_at instanceof Date ? m.started_at.toISOString().slice(0, 19).replace('T', ' ') : m.started_at)) throw bad('The stop time is before the start time');
    await conn.query('UPDATE snowmaking_runs SET ended_at = ?, water_gal = COALESCE(?, water_gal), note = COALESCE(?, note) WHERE tenant_id = ? AND id = ?', [end, req.body.water_gal ?? null, req.body.note ?? null, req.auth.tenantId, id]);
    await audit(conn, req, 'stop', 'snowmaking_runs', id);
  });
  res.json({ ok: true });
});

router.delete('/snowmaking/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM snowmaking_runs WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Snowmaking run');
  res.status(204).end();
});

// ---------------------------------------------------------------- weather log
const weatherFields = {
  logged_at: when.optional(),
  place: z.string().min(1).max(40).default('Base'),
  temp_f: num(-80, 130),
  wind_mph: nullable(z.number().int().min(0).max(250)),
  gust_mph: nullable(z.number().int().min(0).max(300)),
  wind_dir: nullable(z.enum(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])),
  sky: nullable(z.enum(['clear', 'partly', 'overcast', 'snow', 'rain', 'mixed', 'fog'])),
  precip_in: num(0, 99),
  note: nullable(z.string().max(255)),
};

router.get('/weather', async (req, res) => {
  const where = ['tenant_id = ?']; const params = [req.auth.tenantId];
  if (req.query.date) { where.push('DATE(logged_at) = ?'); params.push(first(req.query.date)); }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ data: await rows(pool, `SELECT * FROM weather_logs WHERE ${where.join(' AND ')} ORDER BY logged_at DESC, id DESC LIMIT ?`, [...params, limit]) });
});

router.post('/weather', validate(z.object(weatherFields)), async (req, res) => {
  const b = req.body;
  if ([b.temp_f, b.wind_mph, b.gust_mph, b.sky, b.precip_in].every((v) => v === null || v === undefined)) throw bad('Enter at least a temperature, wind, sky or precipitation');
  const [r] = await pool.query('INSERT INTO weather_logs (tenant_id, logged_at, place, temp_f, wind_mph, gust_mph, wind_dir, sky, precip_in, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.logged_at || nowIn(await tenantTz(req.auth.tenantId)), b.place, b.temp_f ?? null, b.wind_mph ?? null, b.gust_mph ?? null, b.wind_dir ?? null, b.sky ?? null, b.precip_in ?? null, b.note ?? null, req.auth.userId]);
  await audit(pool, req, 'create', 'weather_logs', r.insertId);
  res.status(201).json({ id: r.insertId });
});

// ---------------------------------------------------------------- day by day (lib/dayrecord.js)
// How each day went, recorded every night: weather, new snow, open or closed, visits, tickets and lessons.
router.get('/days', manager, async (req, res) => {
  const tz = await tenantTz(req.auth.tenantId);
  const today = todayIn(tz);
  const to = dateStr.safeParse(first(req.query.to)).success ? first(req.query.to) : addDays(today, -1);
  const from = dateStr.safeParse(first(req.query.from)).success ? first(req.query.from) : addDays(to, -29);
  if (from > to) throw bad('The start date is after the end date');
  if (addDays(from, 400) < to) throw bad('Ask for up to 400 days at a time');
  const t = await one(pool, 'SELECT map_lat FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.json({ from, to, has_location: t.map_lat !== null, days: await dayrecord.list(req.auth.tenantId, from, to) });
});

/** Where the weather is looked up: the mountain's map point. Set here when no map has set it yet. */
router.put('/days/location', manager, validate(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })), async (req, res) => {
  await pool.query('UPDATE tenants SET map_lat = ?, map_lng = ?, map_zoom = COALESCE(map_zoom, 14) WHERE id = ?', [req.body.lat, req.body.lng, req.auth.tenantId]);
  await audit(pool, req, 'update', 'tenants', req.auth.tenantId, { map_lat: req.body.lat, map_lng: req.body.lng });
  res.json({ ok: true });
});

/** Fills in past days (up to a year back) from sales, scans and the weather archive: once, so the forecast has history. */
router.post('/days/backfill', manager, validate(z.object({ days: z.number().int().min(1).max(366).default(365) })), async (req, res) => {
  const tz = await tenantTz(req.auth.tenantId);
  const today = todayIn(tz);
  const out = await dayrecord.recordRange(req.auth.tenantId, addDays(today, -req.body.days), addDays(today, -1));
  await audit(pool, req, 'backfill', 'day_records', null, { days: req.body.days, ...out });
  res.json(out);
});

router.delete('/weather/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM weather_logs WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Weather entry');
  res.status(204).end();
});

module.exports = router;
