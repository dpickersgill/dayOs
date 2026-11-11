'use strict';

// Assets and fleet, Map (lib/mapfeatures.js): the crew puts what lies where on the mountain's map, from the snow with a
// phone's GPS or by tapping the map: points (valves, hydrants, pumps), lines (water, air and power lines) and areas
// (ponds, buildings). Staff and managers add, move and edit; only a manager deletes. Every change is audited.
// Mounted inside the assets router, so it is part of the Assets and fleet add-on and patrol does not see it.
//
// Municipal edition (muni release 1): fire hydrants, manholes, pump stations, outfalls, inlets and the rest, each turned
// on by its add-on (Water, Sewer, Stormwater; streetlights and signs come with the core plan). Every feature can have a
// tag ("V-114"), a condition, a criticality and who owns it; risk is condition times criticality. A feature has its own
// panel: inspections (lib/assetinspect.js), photos, work orders, and a pump station's run hours by month.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const nullableNum = (v) => (v === null || v === undefined ? null : Number(v));
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const config = require('../config');
const MF = require('../lib/mapfeatures');
const M = require('../lib/modules');
const AI = require('../lib/assetinspect');
const CR = require('../lib/checkrules');
const photos = require('./assetphotos');

const router = express.Router();
const manager = requireRole('manager');
const nullable = (s) => s.nullable().optional();
const point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const score = nullable(z.number().int().min(1).max(5));
const fields = {
  kind: z.enum(MF.KIND_KEYS),
  geometry: z.enum(['point', 'line', 'area']).optional(),
  points: z.array(point).min(1).max(2000),
  name: nullable(z.string().trim().max(100)),
  tag: nullable(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._#/-]{0,29}$/, 'Letters, numbers, spaces and - . _ # /, up to 30')),
  size: nullable(z.string().trim().max(40)),
  material: nullable(z.string().trim().max(40)),
  depth_ft: nullable(z.number().min(0).max(999)),
  installed_year: nullable(z.number().int().min(1900).max(2100)),
  status: z.enum(['in_service', 'out_of_service', 'abandoned', 'planned']).optional(),
  notes: nullable(z.string().trim().max(1000)),
  asset_id: nullable(z.number().int().positive()),
  accuracy_m: nullable(z.number().min(0).max(5000)),
  placed_how: z.enum(['gps', 'map', 'walk']).optional(),
  condition_score: score,
  criticality: score,
  ownership: nullable(z.enum(['own', 'authority', 'private', 'state', 'other'])),
};
const EDIT = ['name', 'tag', 'size', 'material', 'depth_ft', 'installed_year', 'status', 'notes', 'asset_id', 'accuracy_m', 'placed_how', 'condition_score', 'criticality', 'ownership'];

// Each feature with its open work orders and when it was last inspected (for the map's markers and the panel).
const SQL = `SELECT f.*, a.name AS asset_name, a.asset_tag,
    (SELECT COUNT(*) FROM work_orders w WHERE w.tenant_id = f.tenant_id AND w.map_feature_id = f.id AND w.status NOT IN ('done','cancelled')) AS open_orders,
    (SELECT MAX(i.done_at) FROM asset_inspections i WHERE i.tenant_id = f.tenant_id AND i.map_feature_id = f.id) AS last_inspected
  FROM map_features f
  LEFT JOIN ops_assets a ON a.tenant_id = f.tenant_id AND a.id = f.asset_id WHERE f.tenant_id = ?`;
const dupTag = (err) => { if (err && err.code === 'ER_DUP_ENTRY') throw conflict('That tag is already on another map item'); throw err; };
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

/** The tenant's kind and the apps that are on, for the kinds it may use. */
const appsOf = (tenantId) => M.stateOf(tenantId);
async function mayUse(tenantId, kind) {
  const { org, on } = await appsOf(tenantId);
  const why = MF.kindRefusal(kind, org, on);
  if (why) throw bad(why);
  return org;
}

router.get('/', async (req, res) => {
  const t = req.auth.tenantId;
  const { org, on } = await appsOf(t);
  const [center, features, assets] = await Promise.all([
    centerOf(t),
    rows(pool, `${SQL} ORDER BY f.id`, [t]),
    rows(pool, "SELECT id, name, asset_tag, kind FROM ops_assets WHERE tenant_id = ? AND status <> 'retired' ORDER BY name", [t]),
  ]);
  const kinds = MF.kindsFor(org, on);
  const shaped = features.map((f) => MF.shape(f, org));
  // The layers: every system a kind it may add is drawn in, and any system something already on its map is drawn in.
  const used = new Set([...kinds.map((k) => k.system), ...shaped.map((f) => f.system)]);
  res.json({
    layers: config.map.layers, max_zoom: config.map.maxZoom, center, kinds, systems: MF.SYSTEMS.filter((x) => used.has(x.key)),
    groups: MF.GROUPS.filter((g) => kinds.some((k) => k.group === g.key)),
    conditions: MF.CONDITIONS, criticalities: MF.CRITICALITIES, ownership: MF.OWNERSHIP, risk_levels: MF.RISK_LEVELS.map(([min, key, label]) => ({ key, label, min })),
    features: shaped, assets, can_delete: ['owner', 'manager'].includes(req.auth.role),
  });
});

router.post('/features', validate(z.object(fields)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const org = await mayUse(t, b.kind);
  const k = MF.kindOf(b.kind);
  const geometry = b.geometry || k.geometry;
  if (!k.geometries.includes(geometry)) throw bad(`A ${k.label.toLowerCase()} is a ${k.geometries.join(' or ')}, not a ${geometry}`);
  const clean = MF.cleanPoints(geometry, b.points);
  if (clean.error) throw bad(clean.error);
  await checkAsset(t, b.asset_id);
  const [lat, lng] = MF.anchorOf(geometry, clean.points);
  let r;
  try {
    [r] = await pool.query(`INSERT INTO map_features (tenant_id, kind, geometry, name, tag, points, lat, lng, size, material, depth_ft, installed_year, status, notes, asset_id, accuracy_m, placed_how, created_by, condition_score, criticality, ownership)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t, b.kind, geometry, blank(b.name) ?? null, blank(b.tag) ?? null, JSON.stringify(clean.points), lat, lng, blank(b.size) ?? null, blank(b.material) ?? null, b.depth_ft ?? null,
      b.installed_year ?? null, b.status || 'in_service', blank(b.notes) ?? null, b.asset_id ?? null, b.accuracy_m ?? null, b.placed_how || 'map', req.auth.userId || null,
      b.condition_score ?? null, b.criticality ?? null, b.ownership ?? null]);
  } catch (err) { dupTag(err); }
  await audit(pool, req, 'create', 'map_features', r.insertId, { kind: b.kind, points: clean.points.length, how: b.placed_how || 'map' });
  res.status(201).json(MF.shape(await one(pool, `${SQL} AND f.id = ?`, [t, r.insertId]), org));
});

router.patch('/features/:id', validate(z.object({ ...fields, kind: fields.kind.optional(), points: fields.points.optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const cur = await one(pool, 'SELECT * FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!cur) throw notFound('Map item');
  const { org } = await appsOf(t);
  // A kind can change within the same geometry only (a valve can become a hydrant; a valve cannot become a pipe).
  if (b.kind && b.kind !== cur.kind) {
    await mayUse(t, b.kind);
    const kind = MF.kindOf(b.kind);
    if (!kind.geometries.includes(cur.geometry)) throw bad(`A ${cur.geometry} can only change to another kind of ${cur.geometry}`);
  }
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
  try { await pool.query(`UPDATE map_features SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t, id]); } catch (err) { dupTag(err); }
  const changed = Object.keys(b);
  await audit(pool, req, b.points ? 'move' : 'update', 'map_features', id, ['condition_score', 'criticality'].some((k) => b[k] !== undefined)
    ? { fields: changed, condition_score: b.condition_score, criticality: b.criticality } : changed);
  res.json(MF.shape(await one(pool, `${SQL} AND f.id = ?`, [t, id]), org));
});

/**
 * A map item is deleted only while nothing has been recorded on it. One that has inspections, work orders, photos or is
 * in a program is a record: mark it abandoned instead, so its history stays.
 */
router.delete('/features/:id', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const cur = await one(pool, 'SELECT kind, name FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!cur) throw notFound('Map item');
  const used = await one(pool, `SELECT (SELECT COUNT(*) FROM asset_inspections WHERE tenant_id = ? AND map_feature_id = ?) + (SELECT COUNT(*) FROM work_orders WHERE tenant_id = ? AND map_feature_id = ?)
    + (SELECT COUNT(*) FROM asset_photos WHERE tenant_id = ? AND map_feature_id = ?) + (SELECT COUNT(*) FROM asset_program_targets WHERE tenant_id = ? AND map_feature_id = ?) AS n`, [t, id, t, id, t, id, t, id]);
  if (Number(used.n)) throw conflict('This map item has inspections, work orders, photos or a program on it. Set its status to Abandoned in place instead, so its history stays.');
  await pool.query('DELETE FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  await audit(pool, req, 'delete', 'map_features', id, cur);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- one feature's panel
/**
 * One map item: its facts, condition, criticality and risk, its inspections (newest first), open and recent work orders,
 * photos, the programs it is in, and for a pump station its run hours by month.
 */
router.get('/features/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const raw = await one(pool, `${SQL} AND f.id = ?`, [t, id]);
  if (!raw) throw notFound('Map item');
  const { org } = await appsOf(t);
  const f = MF.shape(raw, org);
  const target = { type: 'feature', id };
  const [inspections, orders, pics, programs, hours] = await Promise.all([
    rows(pool, 'SELECT id, template_name, result, inspector, done_at, work_order_id, program_id, condition_score, items, note FROM asset_inspections WHERE tenant_id = ? AND map_feature_id = ? ORDER BY done_at DESC, id DESC LIMIT 30', [t, id]),
    rows(pool, `SELECT id, title, status, priority, source, opened_at, completed_at, resolution, program_id FROM work_orders WHERE tenant_id = ? AND map_feature_id = ?
      ORDER BY status IN ('done','cancelled'), opened_at DESC, id DESC LIMIT 30`, [t, id]),
    photos.listFor(pool, t, target),
    rows(pool, `SELECT p.id, p.name, p.status, p.due_on, g.status AS target_status FROM asset_program_targets g JOIN asset_programs p ON p.tenant_id = g.tenant_id AND p.id = g.program_id
      WHERE g.tenant_id = ? AND g.map_feature_id = ? ORDER BY p.created_at DESC LIMIT 10`, [t, id]),
    AI.runHours(pool, t, target),
  ]);
  res.json({
    ...f,
    inspections: inspections.map((i) => ({ ...i, items: JSON.parse(i.items), condition_score: nullableNum(i.condition_score) })),
    last_inspection: inspections.length ? { id: inspections[0].id, template_name: inspections[0].template_name, result: inspections[0].result, done_at: inspections[0].done_at, inspector: inspections[0].inspector } : null,
    work_orders: orders, photos: pics, programs,
    run_hours: hours.pumps.length ? hours : null,
  });
});

/** An inspection done on a map item (a valve exercised, a hydrant flushed, a manhole looked at). */
router.post('/features/:id/inspections', validate(z.object({
  template_id: z.number().int().positive(),
  items: z.array(CR.answerSchema).min(1),
  inspector: nullable(z.string().max(100)), note: nullable(z.string().max(500)),
})), async (req, res) => {
  const out = await tx(async (conn) => {
    const target = await AI.targetOf(conn, req.auth.tenantId, { featureId: paramId(req) }, true);
    return AI.record(conn, req, target, req.body);
  });
  res.status(201).json(out);
});

/** Opens a work order on a map item: something wrong with a valve, a hydrant hit by a car, a sunken manhole. */
router.post('/features/:id/work-orders', validate(z.object({
  title: z.string().trim().min(3).max(150), description: nullable(z.string().max(5000)), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  assigned_staff_id: nullable(z.number().int().positive()), due_date: nullable(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  out_of_service: z.boolean().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const woId = await tx(async (conn) => {
    const target = await AI.targetOf(conn, t, { featureId: id }, true);
    const urgent = target.critical || (target.criticality !== null && target.criticality >= 4);
    const w = await require('./maintenance').createOrder(conn, req, { title: b.title, description: b.description, priority: b.priority || (b.out_of_service || urgent ? 'high' : 'normal'),
      assigned_staff_id: b.assigned_staff_id, due_date: b.due_date, map_feature_id: id, location: target.tag ? `${MF.kindOf(target.kind) ? MF.kindOf(target.kind).label : 'Map item'} ${target.tag}` : null });
    if (b.out_of_service) {
      await conn.query("UPDATE map_features SET status = 'out_of_service' WHERE tenant_id = ? AND id = ? AND status = 'in_service'", [t, id]);
      await audit(conn, req, 'out_of_service', 'map_features', id, { work_order_id: w });
    }
    return w;
  });
  res.status(201).json({ id: woId });
});

/** Run hours by month for a pump station, from the hour meter readings on its rounds. format=csv downloads them. */
router.get('/features/:id/run-hours', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const f = await one(pool, 'SELECT id, name, tag, kind FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!f) throw notFound('Map item');
  const data = await AI.runHours(pool, t, { type: 'feature', id });
  if (req.query.format === 'csv') {
    await audit(pool, req, 'export', 'station_run_hours', id, { months: data.months.length });
    const name = String(f.tag || f.name || `station-${f.id}`).replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || `station-${f.id}`;
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}-run-hours.csv"` }).send(AI.runHoursCsv(data));
    return;
  }
  res.json(data);
});

// Photos of a map item, kept as taken with their fingerprint (routes/assetphotos.js).
router.post('/features/:id/photos', photos.raw, async (req, res) => photos.upload(req, res, { type: 'feature', id: paramId(req) }));

/** What a small map needs (a work order's mini map, a program's map): the tile layers, where it opens, and the systems' colors. */
router.get('/view', async (req, res) => {
  const { org, on } = await appsOf(req.auth.tenantId);
  res.json({ layers: config.map.layers, max_zoom: config.map.maxZoom, center: await centerOf(req.auth.tenantId), systems: MF.SYSTEMS, kinds: MF.kindsFor(org, on) });
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
  const [features, tenant, { org }] = await Promise.all([rows(pool, `${SQL} ORDER BY f.kind, f.id`, [t]), one(pool, 'SELECT name, slug FROM tenants WHERE id = ?', [t]), appsOf(t)]);
  await audit(pool, req, 'export', 'map_features', null, { rows: features.length });
  res.set({ 'Content-Type': 'application/geo+json; charset=utf-8', 'Content-Disposition': `attachment; filename="${tenant.slug}-asset-map.geojson"` })
    .send(JSON.stringify(MF.geojson(features.map((f) => MF.shape(f, org)), tenant.name), null, 1));
});

module.exports = router;
