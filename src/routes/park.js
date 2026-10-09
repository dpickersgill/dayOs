'use strict';

// The terrain park: areas, a catalog of features, where the crew puts each one on a given day, and inspections.
// Anyone signed in can look. The park crew (staff logins), managers and owners change things. A past day is a record,
// so only managers and owners change it.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { partialOf, z, dateStr, validate, paramId, setClause, todayIn } = require('../lib/util');
const { notFound, bad, forbidden, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { KINDS, KIND_KEYS } = require('../lib/park');
const config = require('../config');

const router = express.Router();
const crew = requireRole('staff', 'manager');
const DEFAULT_ZOOM = 17;

const areaFields = {
  name: z.string().min(1).max(100),
  level: z.enum(['learn', 'small', 'medium', 'large', 'pro']).default('small'),
  status: z.enum(['open', 'closed']).default('open'),
  notes: z.string().max(255).nullable().optional(),
  active: z.boolean().optional(),
};
const featureFields = {
  name: z.string().min(1).max(100),
  kind: z.string().refine((k) => KIND_KEYS.includes(k), 'Unknown feature type'),
  size: z.enum(['xs', 's', 'm', 'l', 'xl']).default('m'),
  dimensions: z.string().max(60).nullable().optional(),
  portable: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
  status: z.enum(['ready', 'needs_attention', 'closed', 'retired']).optional(),
};
const placeSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  area_id: z.number().int().positive().nullable().optional(),
  note: z.string().max(255).nullable().optional(),
});

const tenantToday = async (tenantId) => {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  return todayIn(t.timezone);
};
const dateParam = (req) => {
  const d = req.params.date;
  if (!dateStr.safeParse(d).success) throw bad('Use YYYY-MM-DD');
  return d;
};
/** Past days are a record: only a manager changes them. */
async function assertEditableDay(req, date) {
  if (isManager(req)) return;
  if (date < (await tenantToday(req.auth.tenantId))) throw forbidden('That day is over. Ask a manager to change it.');
}

router.get('/kinds', (_req, res) => res.json({ data: KINDS }));

// ---------------------------------------------------------------- map settings
router.get('/map', async (req, res) => {
  const { tenantId } = req.auth;
  const t = await one(pool, 'SELECT map_lat, map_lng, map_zoom FROM tenants WHERE id = ?', [tenantId]);
  let center = null;
  if (t && t.map_lat !== null && t.map_lng !== null) center = { lat: Number(t.map_lat), lng: Number(t.map_lng), zoom: t.map_zoom || DEFAULT_ZOOM, source: 'resort' };
  else {
    const a = await one(pool, 'SELECT AVG(lat) AS lat, AVG(lng) AS lng FROM (SELECT lat, lng FROM park_placements WHERE tenant_id = ? ORDER BY on_date DESC, id DESC LIMIT 50) x', [tenantId]);
    if (a && a.lat !== null) center = { lat: Number(a.lat), lng: Number(a.lng), zoom: DEFAULT_ZOOM, source: 'park' };
  }
  res.json({ layers: config.map.layers, center, can_edit: ['owner', 'manager', 'staff'].includes(req.auth.role), today: await tenantToday(tenantId) });
});

// ---------------------------------------------------------------- areas
router.get('/areas', async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT id, name, level, status, notes, active FROM park_areas WHERE tenant_id = ? ORDER BY active DESC, name', [req.auth.tenantId]) });
});

router.post('/areas', crew, validate(z.object(areaFields)), async (req, res) => {
  const b = req.body;
  const [r] = await pool.query('INSERT INTO park_areas (tenant_id, name, level, status, notes) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, b.name, b.level, b.status, b.notes ?? null]);
  await audit(pool, req, 'create', 'park_areas', r.insertId, { name: b.name });
  res.status(201).json({ id: r.insertId });
});

router.patch('/areas/:id', crew, validate(partialOf(areaFields)), async (req, res) => {
  const body = { ...req.body };
  if (body.active !== undefined) body.active = body.active ? 1 : 0;
  const set = setClause(body, Object.keys(areaFields));
  if (!set) throw bad('No updatable fields supplied');
  const [r] = await pool.query(`UPDATE park_areas SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Park area');
  await audit(pool, req, 'update', 'park_areas', paramId(req), req.body);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- features
const featureSelect = `SELECT f.id, f.name, f.kind, f.size, f.dimensions, f.portable, f.status, f.notes,
    (SELECT i.result FROM park_inspections i WHERE i.tenant_id = f.tenant_id AND i.feature_id = f.id ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1) AS last_result,
    (SELECT i.inspected_at FROM park_inspections i WHERE i.tenant_id = f.tenant_id AND i.feature_id = f.id ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1) AS last_inspected_at,
    (SELECT i.notes FROM park_inspections i WHERE i.tenant_id = f.tenant_id AND i.feature_id = f.id ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1) AS last_notes
  FROM park_features f`;
const featureOut = (f) => ({ ...f, portable: Boolean(f.portable) });

router.get('/features', async (req, res) => {
  const data = await rows(pool, `${featureSelect} WHERE f.tenant_id = ? ORDER BY f.status = 'retired', f.kind, f.name`, [req.auth.tenantId]);
  res.json({ data: data.map(featureOut) });
});

router.post('/features', crew, validate(z.object(featureFields)), async (req, res) => {
  const b = req.body;
  const portable = b.portable ?? KINDS.find((k) => k.key === b.kind).portable;
  const [r] = await pool.query('INSERT INTO park_features (tenant_id, name, kind, size, dimensions, portable, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.name, b.kind, b.size, b.dimensions ?? null, portable ? 1 : 0, b.status ?? 'ready', b.notes ?? null]);
  await audit(pool, req, 'create', 'park_features', r.insertId, { name: b.name, kind: b.kind });
  res.status(201).json({ id: r.insertId });
});

router.patch('/features/:id', crew, validate(partialOf(featureFields)), async (req, res) => {
  const body = { ...req.body };
  if (body.portable !== undefined) body.portable = body.portable ? 1 : 0;
  const set = setClause(body, Object.keys(featureFields));
  if (!set) throw bad('No updatable fields supplied');
  const [r] = await pool.query(`UPDATE park_features SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Park feature');
  await audit(pool, req, 'update', 'park_features', paramId(req), req.body);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- daily placements
const placementSelect = `SELECT p.id, p.on_date, p.feature_id, p.area_id, p.lat, p.lng, p.note, p.updated_at, a.name AS area,
    f.name, f.kind, f.size, f.dimensions, f.status AS feature_status,
    (SELECT i.result FROM park_inspections i WHERE i.tenant_id = p.tenant_id AND i.feature_id = p.feature_id AND i.inspected_on = p.on_date ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1) AS inspected_result
  FROM park_placements p JOIN park_features f ON f.id = p.feature_id AND f.tenant_id = p.tenant_id LEFT JOIN park_areas a ON a.id = p.area_id AND a.tenant_id = p.tenant_id`;
const placementOut = (p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng) });

/** The layout for one day, plus the features that are free to place (ready or flagged, not retired, not already on the map that day). */
router.get('/placements/:date', async (req, res) => {
  const date = dateParam(req);
  const { tenantId } = req.auth;
  const placed = await rows(pool, `${placementSelect} WHERE p.tenant_id = ? AND p.on_date = ? ORDER BY f.kind, f.name`, [tenantId, date]);
  const unplaced = await rows(pool, `${featureSelect} WHERE f.tenant_id = ? AND f.status <> 'retired' AND f.id NOT IN (SELECT feature_id FROM park_placements WHERE tenant_id = ? AND on_date = ?) ORDER BY f.kind, f.name`, [tenantId, tenantId, date]);
  res.json({ date, placed: placed.map(placementOut), unplaced: unplaced.map(featureOut), editable: isManager(req) || date >= (await tenantToday(tenantId)) });
});

/** Put a feature on the map for a day, or move it. */
router.put('/placements/:date/:featureId', crew, validate(placeSchema), async (req, res) => {
  const date = dateParam(req);
  const featureId = paramId(req, 'featureId');
  const { tenantId } = req.auth;
  const b = req.body;
  await assertEditableDay(req, date);
  const out = await tx(async (conn) => {
    const f = await one(conn, 'SELECT id, status FROM park_features WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, featureId]);
    if (!f) throw notFound('Park feature');
    if (f.status === 'retired') throw conflict('This feature is retired');
    if (b.area_id) {
      const a = await one(conn, 'SELECT id FROM park_areas WHERE tenant_id = ? AND id = ?', [tenantId, b.area_id]);
      if (!a) throw notFound('Park area');
    }
    const prior = await one(conn, 'SELECT id FROM park_placements WHERE tenant_id = ? AND on_date = ? AND feature_id = ?', [tenantId, date, featureId]);
    await conn.query(
      `INSERT INTO park_placements (tenant_id, on_date, feature_id, area_id, lat, lng, note, placed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE lat = VALUES(lat), lng = VALUES(lng), area_id = VALUES(area_id), note = VALUES(note), placed_by = VALUES(placed_by)`,
      [tenantId, date, featureId, b.area_id ?? null, b.lat, b.lng, b.note ?? null, req.auth.userId],
    );
    await audit(conn, req, prior ? 'move' : 'place', 'park_placements', featureId, { date, lat: b.lat, lng: b.lng });
    return { moved: Boolean(prior) };
  });
  res.status(out.moved ? 200 : 201).json({ ok: true, ...out });
});

/** Take a feature off the map for a day. */
router.delete('/placements/:date/:featureId', crew, async (req, res) => {
  const date = dateParam(req);
  const featureId = paramId(req, 'featureId');
  await assertEditableDay(req, date);
  const [r] = await pool.query('DELETE FROM park_placements WHERE tenant_id = ? AND on_date = ? AND feature_id = ?', [req.auth.tenantId, date, featureId]);
  if (!r.affectedRows) throw notFound('Placement');
  await audit(pool, req, 'unplace', 'park_placements', featureId, { date });
  res.json({ ok: true });
});

/** Start a day from another day's layout. Adds to what is already there; never moves or removes anything. */
router.post('/placements/:date/copy', crew, validate(z.object({ from: dateStr })), async (req, res) => {
  const date = dateParam(req);
  const { tenantId } = req.auth;
  if (req.body.from === date) throw bad('Pick a different day to copy from');
  await assertEditableDay(req, date);
  const out = await tx(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO park_placements (tenant_id, on_date, feature_id, area_id, lat, lng, note, placed_by)
       SELECT p.tenant_id, ?, p.feature_id, p.area_id, p.lat, p.lng, p.note, ? FROM park_placements p JOIN park_features f ON f.id = p.feature_id AND f.tenant_id = p.tenant_id
       WHERE p.tenant_id = ? AND p.on_date = ? AND f.status <> 'retired'
         AND p.feature_id NOT IN (SELECT feature_id FROM (SELECT feature_id FROM park_placements WHERE tenant_id = ? AND on_date = ?) already)`,
      [date, req.auth.userId, tenantId, req.body.from, tenantId, date],
    );
    await audit(conn, req, 'copy_layout', 'park_placements', null, { from: req.body.from, to: date, copied: r.affectedRows });
    return { copied: r.affectedRows };
  });
  res.json(out);
});

/** Recent days that have a layout, newest first. */
router.get('/days', async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT on_date, COUNT(*) AS features FROM park_placements WHERE tenant_id = ? GROUP BY on_date ORDER BY on_date DESC LIMIT 60', [req.auth.tenantId]) });
});

/** Where one feature has been, day by day. */
router.get('/features/:id/history', async (req, res) => {
  const id = paramId(req);
  res.json({ data: await rows(pool, `SELECT p.on_date, p.lat, p.lng, p.note, a.name AS area FROM park_placements p LEFT JOIN park_areas a ON a.id = p.area_id AND a.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.feature_id = ? ORDER BY p.on_date DESC LIMIT 60`, [req.auth.tenantId, id]) });
});

// ---------------------------------------------------------------- inspections
/** Any crew member can log an inspection. The result moves the feature's status, so a closed feature shows as closed on the map. */
router.post('/features/:id/inspections', crew, validate(z.object({ result: z.enum(['ok', 'needs_attention', 'closed']), notes: z.string().max(255).optional() })), async (req, res) => {
  const id = paramId(req);
  const { tenantId } = req.auth;
  const b = req.body;
  if (b.result !== 'ok' && !b.notes) throw bad('Say what is wrong so the next person knows');
  const today = await tenantToday(tenantId);
  const out = await tx(async (conn) => {
    const f = await one(conn, 'SELECT id, status FROM park_features WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!f) throw notFound('Park feature');
    if (f.status === 'retired') throw conflict('This feature is retired');
    const [r] = await conn.query('INSERT INTO park_inspections (tenant_id, feature_id, inspected_on, inspected_by, result, notes) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, id, today, req.auth.userId, b.result, b.notes ?? null]);
    const status = b.result === 'ok' ? 'ready' : b.result;
    await conn.query('UPDATE park_features SET status = ? WHERE tenant_id = ? AND id = ?', [status, tenantId, id]);
    await audit(conn, req, 'inspect', 'park_features', id, { result: b.result });
    return { id: r.insertId, status };
  });
  res.status(201).json(out);
});

router.get('/features/:id/inspections', async (req, res) => {
  res.json({ data: await rows(pool, `SELECT i.id, i.inspected_at, i.result, i.notes, u.email AS inspected_by FROM park_inspections i LEFT JOIN users u ON u.id = i.inspected_by AND u.tenant_id = i.tenant_id
    WHERE i.tenant_id = ? AND i.feature_id = ? ORDER BY i.inspected_at DESC, i.id DESC LIMIT 100`, [req.auth.tenantId, paramId(req)]) });
});

module.exports = router;
