'use strict';

// The patrol map: tile layers, where the map opens for this mountain, and the pins of recorded incidents.
// Coordinates themselves live on the incident (gps_lat, gps_lng); the pin dialog saves them through the normal
// incident update, so every change is audited like any other edit.
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate } = require('../lib/util');
const { forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { isPatrolAdmin } = require('../lib/formconfig');
const config = require('../config');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const PA = require('../lib/patrolaccess');
const needs = (feature, message) => PA.needs(pool, feature, message);
const DEFAULT_ZOOM = 15;

/** Where the map opens: the mountain's chosen view, else the middle of its recent pins, else nowhere (the screen then asks the device). */
async function mapCenter(tenantId) {
  const t = await one(pool, 'SELECT map_lat, map_lng, map_zoom FROM tenants WHERE id = ?', [tenantId]);
  if (t && t.map_lat !== null && t.map_lng !== null) return { lat: Number(t.map_lat), lng: Number(t.map_lng), zoom: t.map_zoom || DEFAULT_ZOOM, source: 'resort' };
  const a = await one(pool, 'SELECT AVG(gps_lat) AS lat, AVG(gps_lng) AS lng FROM (SELECT gps_lat, gps_lng FROM incidents WHERE tenant_id = ? AND gps_lat IS NOT NULL AND gps_lng IS NOT NULL ORDER BY id DESC LIMIT 50) x', [tenantId]);
  if (a && a.lat !== null) return { lat: Number(a.lat), lng: Number(a.lng), zoom: DEFAULT_ZOOM, source: 'cases' };
  return null;
}

router.get('/map', patrol, async (req, res) => {
  const [center, admin] = await Promise.all([mapCenter(req.auth.tenantId), isPatrolAdmin(pool, req)]);
  res.json({ layers: config.map.layers, center, can_admin: admin });
});

router.put(
  '/map-config',
  patrol,
  validate(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), zoom: z.number().int().min(1).max(19) })),
  async (req, res) => {
    if (!(await isPatrolAdmin(pool, req))) throw forbidden('Only a manager or the patrol director can set where the map opens');
    await pool.query('UPDATE tenants SET map_lat = ?, map_lng = ?, map_zoom = ? WHERE id = ?', [req.body.lat, req.body.lng, req.body.zoom, req.auth.tenantId]);
    await audit(pool, req, 'set_map_view', 'tenants', req.auth.tenantId, req.body);
    res.json({ ok: true });
  },
);

/** Every incident with a pin in a date range, for the Map tab. No patient names. */
router.get('/map-pins', patrol, needs('view_cases'), async (req, res) => {
  const q = z.object({ from: dateStr.optional(), to: dateStr.optional(), category: z.string().max(20).optional() }).safeParse(req.query);
  const f = q.success ? q.data : {};
  const where = ['tenant_id = ?', 'gps_lat IS NOT NULL', 'gps_lng IS NOT NULL'];
  const params = [req.auth.tenantId];
  if (f.from) { where.push('occurred_at >= ?'); params.push(`${f.from} 00:00:00`); }
  if (f.to) { where.push('occurred_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(f.to); }
  if (f.category) { where.push('category = ?'); params.push(f.category); }
  const data = await rows(pool, `SELECT id, season, seq, occurred_at, category, severity, location, summary, report_state, gps_lat, gps_lng FROM incidents WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC LIMIT 1000`, params);
  await audit(pool, req, 'read', 'incident_pins', null, { rows: data.length });
  res.json({ data: data.map((r) => ({ ...r, gps_lat: Number(r.gps_lat), gps_lng: Number(r.gps_lng), case_number: r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : null })) });
});

module.exports = router;
