'use strict';

// Assets and fleet, Map (lib/mapfeatures.js): the crew puts what lies where on the mountain's map, from the snow with a
// phone's GPS or by tapping the map: points (valves, hydrants, pumps), lines (water, air and power lines) and areas
// (ponds, buildings). Staff and managers add, move and edit; only a manager deletes. Every change is audited.
// Mounted inside the assets router, so it is part of the Assets and fleet add-on and patrol does not see it.
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const config = require('../config');
const MF = require('../lib/mapfeatures');

const router = express.Router();
const manager = requireRole('manager');
const nullable = (s) => s.nullable().optional();
const point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const fields = {
  kind: z.enum(MF.KIND_KEYS),
  points: z.array(point).min(1).max(2000),
  name: nullable(z.string().trim().max(100)),
  size: nullable(z.string().trim().max(40)),
  material: nullable(z.string().trim().max(40)),
  depth_ft: nullable(z.number().min(0).max(999)),
  installed_year: nullable(z.number().int().min(1900).max(2100)),
  status: z.enum(['in_service', 'out_of_service', 'abandoned', 'planned']).optional(),
  notes: nullable(z.string().trim().max(1000)),
  asset_id: nullable(z.number().int().positive()),
  accuracy_m: nullable(z.number().min(0).max(5000)),
  placed_how: z.enum(['gps', 'map', 'walk']).optional(),
};
const EDIT = ['name', 'size', 'material', 'depth_ft', 'installed_year', 'status', 'notes', 'asset_id', 'accuracy_m', 'placed_how'];

const SQL = `SELECT f.*, a.name AS asset_name, a.asset_tag FROM map_features f
  LEFT JOIN ops_assets a ON a.tenant_id = f.tenant_id AND a.id = f.asset_id WHERE f.tenant_id = ?`;
const blank = (v) => (typeof v === 'string' && !v.trim() ? null : v);

async function checkAsset(tenantId, assetId) {
  if (assetId && !(await one(pool, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND id = ?', [tenantId, assetId]))) throw notFound('Asset');
}

/** Where the map opens: the mountain's saved view, else the middle of what is already on it, else nowhere. */
async function centerOf(tenantId) {
  const t = await one(pool, 'SELECT map_lat, map_lng, map_zoom FROM tenants WHERE id = ?', [tenantId]);
  if (t && t.map_lat !== null && t.map_lng !== null) return { lat: Number(t.map_lat), lng: Number(t.map_lng), zoom: t.map_zoom || 16 };
  const a = await one(pool, 'SELECT AVG(lat) AS lat, AVG(lng) AS lng FROM map_features WHERE tenant_id = ?', [tenantId]);
  return a && a.lat !== null ? { lat: Number(a.lat), lng: Number(a.lng), zoom: 16 } : null;
}

router.get('/', async (req, res) => {
  const t = req.auth.tenantId;
  const [center, features, assets] = await Promise.all([
    centerOf(t),
    rows(pool, `${SQL} ORDER BY f.id`, [t]),
    rows(pool, "SELECT id, name, asset_tag, kind FROM ops_assets WHERE tenant_id = ? AND status <> 'retired' ORDER BY name", [t]),
  ]);
  res.json({
    layers: config.map.layers, max_zoom: config.map.maxZoom, center, kinds: MF.KINDS, systems: MF.SYSTEMS,
    features: features.map(MF.shape), assets, can_delete: ['owner', 'manager'].includes(req.auth.role),
  });
});

router.post('/features', validate(z.object(fields)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const k = MF.kindOf(b.kind);
  const clean = MF.cleanPoints(k.geometry, b.points);
  if (clean.error) throw bad(clean.error);
  await checkAsset(t, b.asset_id);
  const [lat, lng] = MF.anchorOf(k.geometry, clean.points);
  const [r] = await pool.query(`INSERT INTO map_features (tenant_id, kind, geometry, name, points, lat, lng, size, material, depth_ft, installed_year, status, notes, asset_id, accuracy_m, placed_how, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [t, b.kind, k.geometry, blank(b.name) ?? null, JSON.stringify(clean.points), lat, lng, blank(b.size) ?? null, blank(b.material) ?? null, b.depth_ft ?? null,
    b.installed_year ?? null, b.status || 'in_service', blank(b.notes) ?? null, b.asset_id ?? null, b.accuracy_m ?? null, b.placed_how || 'map', req.auth.userId || null]);
  await audit(pool, req, 'create', 'map_features', r.insertId, { kind: b.kind, points: clean.points.length, how: b.placed_how || 'map' });
  res.status(201).json(MF.shape(await one(pool, `${SQL} AND f.id = ?`, [t, r.insertId])));
});

router.patch('/features/:id', validate(z.object({ ...fields, kind: fields.kind.optional(), points: fields.points.optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const cur = await one(pool, 'SELECT * FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!cur) throw notFound('Map item');
  // A kind can change within the same geometry only (a valve can become a hydrant; a valve cannot become a pipe).
  const kind = b.kind ? MF.kindOf(b.kind) : MF.kindOf(cur.kind) || { geometry: cur.geometry };
  if (b.kind && kind.geometry !== cur.geometry) throw bad(`A ${cur.geometry} can only change to another kind of ${cur.geometry}`);
  const set = []; const vals = [];
  if (b.kind) { set.push('kind = ?'); vals.push(b.kind); }
  if (b.points) {
    const clean = MF.cleanPoints(cur.geometry, b.points);
    if (clean.error) throw bad(clean.error);
    const [lat, lng] = MF.anchorOf(cur.geometry, clean.points);
    set.push('points = ?', 'lat = ?', 'lng = ?'); vals.push(JSON.stringify(clean.points), lat, lng);
  }
  if (b.asset_id) await checkAsset(t, b.asset_id);
  for (const k of EDIT) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(blank(b[k])); }
  if (!set.length) throw bad('Nothing to change');
  await pool.query(`UPDATE map_features SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t, id]);
  await audit(pool, req, b.points ? 'move' : 'update', 'map_features', id, Object.keys(b));
  res.json(MF.shape(await one(pool, `${SQL} AND f.id = ?`, [t, id])));
});

router.delete('/features/:id', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const cur = await one(pool, 'SELECT kind, name FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!cur) throw notFound('Map item');
  await pool.query('DELETE FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  await audit(pool, req, 'delete', 'map_features', id, cur);
  res.json({ ok: true });
});

/** A manager sets where every map opens for this mountain (the same view the patrol and park maps use). */
router.put('/view', manager, validate(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), zoom: z.number().int().min(1).max(22) })), async (req, res) => {
  await pool.query('UPDATE tenants SET map_lat = ?, map_lng = ?, map_zoom = ? WHERE id = ?', [req.body.lat, req.body.lng, req.body.zoom, req.auth.tenantId]);
  await audit(pool, req, 'set_map_view', 'tenants', req.auth.tenantId, req.body);
  res.json({ ok: true });
});

/** Everything on the map as a GeoJSON file, for GIS software, an engineer or a contractor's locate request. */
router.get('/export.geojson', async (req, res) => {
  const t = req.auth.tenantId;
  const [features, tenant] = await Promise.all([rows(pool, `${SQL} ORDER BY f.kind, f.id`, [t]), one(pool, 'SELECT name, slug FROM tenants WHERE id = ?', [t])]);
  await audit(pool, req, 'export', 'map_features', null, { rows: features.length });
  res.set({ 'Content-Type': 'application/geo+json; charset=utf-8', 'Content-Disposition': `attachment; filename="${tenant.slug}-asset-map.geojson"` })
    .send(JSON.stringify(MF.geojson(features.map(MF.shape), tenant.name), null, 1));
});

module.exports = router;
