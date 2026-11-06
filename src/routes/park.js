'use strict';

// The terrain park: areas, a catalog of features, where the crew puts each one on a given day, and inspections.
// Anyone signed in can look. The park crew (staff logins), managers and owners change things. A past day is a record,
// so only managers and owners change it, and only through corrections that keep what was there before.
//
// Only an inspection opens a feature: status is not something anyone types. A pass ("Inspected, no defects found, open")
// on a feature that was closed or needed attention is a reopening, and needs what was fixed and a photo. A feature closed
// after an incident reopens only through a post-incident inspection. Every change to a feature's size, type, dimensions,
// area or status, and to an area's rating, is kept with its before and after values (park_feature_changes).
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { partialOf, z, dateStr, validate, paramId, setClause, todayIn } = require('../lib/util');
const { notFound, bad, forbidden, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const P = require('../lib/park');
const OPS = require('../lib/parkops');
const config = require('../config');

const router = express.Router();
const crew = requireRole('staff', 'manager');
const DEFAULT_ZOOM = 17;
const reasonField = z.string().trim().min(3, 'Say why, in a few words').max(255);
const clientRef = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional();
const atField = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/).optional();

const areaFields = {
  name: z.string().min(1).max(100),
  level: z.enum(P.LEVEL_KEYS).default('s'),
  notes: z.string().max(255).nullable().optional(),
  active: z.boolean().optional(),
};
const featureFields = {
  name: z.string().min(1).max(100),
  kind: z.string().refine((k) => P.KIND_KEYS.includes(k), 'Unknown feature type'),
  size: z.enum(P.SIZE_KEYS).default('m'),
  dimensions: z.string().max(60).nullable().optional(),
  portable: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
};
const placeSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  area_id: z.number().int().positive().nullable().optional(),
  note: z.string().max(255).nullable().optional(),
  accuracy_m: z.number().min(0).max(5000).nullable().optional(), // how close the GPS fix was, when placed by GPS
  how: z.enum(['gps', 'map', 'drag']).optional(),
  reason: reasonField.optional(), // a past day: why it is being changed (managers only)
  size_override: reasonField.optional(), // a feature larger than its area's rating: why it is there anyway
});
const NO_STATUS = 'A feature\'s status changes only through an inspection. Inspect it to close or reopen it; a manager retires it.';

const tenantToday = async (tenantId) => todayIn(await OPS.tzOf(pool, tenantId));
const dateParam = (req) => {
  const d = req.params.date;
  if (!dateStr.safeParse(d).success) throw bad('Use YYYY-MM-DD');
  return d;
};
/** Past days are a record: only a manager changes them, and only with a reason. Returns true for a past day. */
async function pastDay(req, date) {
  const past = date < (await tenantToday(req.auth.tenantId));
  if (!past) return false;
  if (!isManager(req)) throw forbidden('That day is over. Ask a manager to correct it.');
  if (!req.body || !req.body.reason) throw bad('That day is over. Say why it is being corrected; the original stays in the record.');
  return true;
}

router.get('/kinds', (_req, res) => res.json({ data: P.KINDS.map((k) => ({ ...k, checks: P.checklistFor(k.key) })) }));
/** The words and lists every park screen uses. */
router.get('/meta', (_req, res) => res.json({
  sizes: P.SIZES, levels: P.LEVELS, level_max: P.LEVEL_MAX, results: P.RESULTS, inspection_kinds: P.INSPECTION_KINDS,
  signoff: P.SIGNOFF, close_reasons: P.CLOSE_REASONS, statuses: OPS.STATUS_LABEL,
}));

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
  res.json({ layers: config.map.layers, max_zoom: config.map.maxZoom, center, can_edit: ['owner', 'manager', 'staff'].includes(req.auth.role), can_manage: isManager(req), today: await tenantToday(tenantId) });
});

// ---------------------------------------------------------------- areas
/** Areas with how each one stands today: opened with a sign-off, closed, or not opened yet today. */
router.get('/areas', async (req, res) => {
  const t = req.auth.tenantId;
  const today = await tenantToday(t);
  const list = await rows(pool, 'SELECT id, name, level, status, notes, active FROM park_areas WHERE tenant_id = ? ORDER BY active DESC, name', [t]);
  const days = await rows(pool, `SELECT d.area_id, d.action, d.at, d.supervisor_name, d.reason_kind, d.reason FROM park_area_days d
    WHERE d.tenant_id = ? AND d.on_date = ? ORDER BY d.at, d.id`, [t, today]);
  const last = new Map(); for (const d of days) last.set(Number(d.area_id), d);
  const tz = await OPS.tzOf(pool, t);
  res.json({ data: list.map((a) => { const d = last.get(Number(a.id)); return { ...a, level_label: OPS.levelLabel(a.level), today_status: d ? (d.action === 'open' ? 'open' : 'closed') : 'not_opened', today: d ? OPS.local(d, tz) : null }; }), today });
});

router.post('/areas', crew, validate(z.object(areaFields)), async (req, res) => {
  const b = req.body;
  // A new area starts closed: it opens each day with the opening sign-off.
  const [r] = await pool.query("INSERT INTO park_areas (tenant_id, name, level, status, notes) VALUES (?, ?, ?, 'closed', ?)", [req.auth.tenantId, b.name, b.level, b.notes ?? null]);
  await audit(pool, req, 'create', 'park_areas', r.insertId, { name: b.name, level: b.level });
  res.status(201).json({ id: r.insertId });
});

router.patch('/areas/:id', crew, validate(partialOf({ ...areaFields, reason: reasonField, status: z.any().optional() })), async (req, res) => {
  if (req.body.status !== undefined) throw bad('Open an area with the opening sign-off, and close it with Close the area.');
  const id = paramId(req);
  const out = await tx(async (conn) => {
    const a = await one(conn, 'SELECT id, name, level FROM park_areas WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!a) throw notFound('Park area');
    const body = { ...req.body };
    delete body.reason; delete body.status;
    if (body.active !== undefined) body.active = body.active ? 1 : 0;
    const rating = body.level !== undefined && body.level !== a.level;
    if (rating && !req.body.reason) throw bad('Say why the area\'s rating is changing. The old rating stays in the history.');
    const set = setClause(body, Object.keys(areaFields));
    if (!set) throw bad('No updatable fields supplied');
    await conn.query(`UPDATE park_areas SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    if (rating) await OPS.logChange(conn, req, { areaId: id, field: 'rating', before: a.level, after: body.level, reason: req.body.reason });
    if (body.name !== undefined && body.name !== a.name) await OPS.logChange(conn, req, { areaId: id, field: 'name', before: a.name, after: body.name, reason: req.body.reason || null });
    await audit(conn, req, 'update', 'park_areas', id, { fields: Object.keys(body), ...(rating ? { level: [a.level, body.level] } : {}) });
    return { ok: true };
  });
  res.json(out);
});

// ---------------------------------------------------------------- features
const lastInspection = (col) => `(SELECT i.${col} FROM park_inspections i WHERE i.tenant_id = f.tenant_id AND i.feature_id = f.id AND i.voided_at IS NULL ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1)`;
const featureSelect = `SELECT f.id, f.name, f.kind, f.size, f.dimensions, f.portable, f.status, f.notes, f.needs_post_incident,
    ${lastInspection('result')} AS last_result, ${lastInspection('inspected_at')} AS last_inspected_at, ${lastInspection('notes')} AS last_notes, ${lastInspection('kind')} AS last_kind
  FROM park_features f`;
const featureOut = (f) => ({ ...f, portable: Boolean(f.portable), needs_post_incident: Boolean(Number(f.needs_post_incident)), status_label: OPS.statusLabel(f.status) });

router.get('/features', async (req, res) => {
  const data = await rows(pool, `${featureSelect} WHERE f.tenant_id = ? ORDER BY f.status = 'retired', f.kind, f.name`, [req.auth.tenantId]);
  const tz = await OPS.tzOf(pool, req.auth.tenantId);
  res.json({ data: data.map((f) => featureOut({ ...f, last_inspected_at: f.last_inspected_at ? OPS.local({ at: f.last_inspected_at }, tz).at : null })) });
});

router.post('/features', crew, validate(z.object({ ...featureFields, status: z.any().optional() })), async (req, res) => {
  const b = req.body;
  if (b.status !== undefined) throw bad(NO_STATUS);
  const portable = b.portable ?? P.KINDS.find((k) => k.key === b.kind).portable;
  // Not inspected yet: the first inspection that passes opens it.
  const [r] = await pool.query("INSERT INTO park_features (tenant_id, name, kind, size, dimensions, portable, status, notes) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)",
    [req.auth.tenantId, b.name, b.kind, b.size, b.dimensions ?? null, portable ? 1 : 0, b.notes ?? null]);
  await audit(pool, req, 'create', 'park_features', r.insertId, { name: b.name, kind: b.kind, size: b.size });
  res.status(201).json({ id: r.insertId });
});

// The fields kept in the history, and the ones that need a reason to change.
const TRACKED = ['name', 'kind', 'size', 'dimensions', 'portable'];
const NEEDS_REASON = ['size', 'dimensions'];
router.patch('/features/:id', crew, validate(partialOf({ ...featureFields, reason: reasonField, status: z.any().optional() })), async (req, res) => {
  if (req.body.status !== undefined) throw bad(NO_STATUS);
  const id = paramId(req);
  await tx(async (conn) => {
    const f = await one(conn, 'SELECT id, name, kind, size, dimensions, portable, status FROM park_features WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!f) throw notFound('Park feature');
    const body = { ...req.body };
    delete body.reason; delete body.status;
    if (body.portable !== undefined) body.portable = body.portable ? 1 : 0;
    const norm = (k, v) => (v === undefined ? undefined : k === 'dimensions' ? (v || null) : v);
    const changed = TRACKED.filter((k) => body[k] !== undefined && String(norm(k, body[k]) ?? '') !== String(f[k] ?? ''));
    const why = changed.filter((k) => NEEDS_REASON.includes(k));
    if (why.length && !req.body.reason) throw bad(`Say why the ${why.join(' and ')} ${why.length > 1 ? 'are' : 'is'} changing. The old value stays in the history.`);
    const set = setClause(body, Object.keys(featureFields));
    if (!set) throw bad('No updatable fields supplied');
    await conn.query(`UPDATE park_features SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    for (const k of changed) await OPS.logChange(conn, req, { featureId: id, field: k, before: f[k], after: norm(k, body[k]), reason: req.body.reason || null });
    await audit(conn, req, 'update', 'park_features', id, { fields: Object.keys(body), changed, ...(changed.includes('size') ? { size: [f.size, body.size] } : {}) });
  });
  res.json({ ok: true });
});

/** Retire a feature (a manager, with a reason), or bring a retired one back (it starts as not inspected). */
router.post('/features/:id/retire', crew, validate(z.object({ reason: reasonField })), async (req, res) => {
  if (!isManager(req)) throw forbidden('Only a manager retires a feature');
  const id = paramId(req);
  await tx(async (conn) => {
    const f = await one(conn, 'SELECT id, status FROM park_features WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!f) throw notFound('Park feature');
    if (f.status === 'retired') throw conflict('This feature is already retired');
    await OPS.setStatus(conn, req, f, 'retired', { reason: req.body.reason, source: 'retire' });
    await audit(conn, req, 'retire', 'park_features', id, {});
  });
  res.json({ ok: true });
});
router.post('/features/:id/unretire', crew, validate(z.object({ reason: reasonField })), async (req, res) => {
  if (!isManager(req)) throw forbidden('Only a manager brings back a retired feature');
  const id = paramId(req);
  await tx(async (conn) => {
    const f = await one(conn, 'SELECT id, status FROM park_features WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!f) throw notFound('Park feature');
    if (f.status !== 'retired') throw conflict('This feature is not retired');
    await OPS.setStatus(conn, req, f, 'new', { reason: req.body.reason, source: 'retire' });
    await audit(conn, req, 'unretire', 'park_features', id, {});
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- daily placements
const placementSelect = `SELECT p.id, p.on_date, p.feature_id, p.area_id, p.lat, p.lng, p.note, p.updated_at, p.accuracy_m, p.placed_how, p.roped_off, p.roped_note, p.late, p.late_reason, p.size_override,
    a.name AS area, a.level AS area_level, f.name, f.kind, f.size, f.dimensions, f.status AS feature_status, f.needs_post_incident,
    (SELECT i.result FROM park_inspections i WHERE i.tenant_id = p.tenant_id AND i.feature_id = p.feature_id AND i.inspected_on = p.on_date AND i.voided_at IS NULL ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1) AS inspected_result,
    (SELECT i.inspected_at FROM park_inspections i WHERE i.tenant_id = p.tenant_id AND i.feature_id = p.feature_id AND i.inspected_on = p.on_date AND i.voided_at IS NULL ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1) AS inspected_at
  FROM park_placements p JOIN park_features f ON f.id = p.feature_id AND f.tenant_id = p.tenant_id LEFT JOIN park_areas a ON a.id = p.area_id AND a.tenant_id = p.tenant_id`;
// (Saving a pin: accuracy_m and placed_how are only replaced when the position changes, and are set before lat/lng in
// the update because MySQL assigns left to right. Editing just the area or note keeps how the pin was put down.)
const placementOut = (p) => ({
  ...p, lat: Number(p.lat), lng: Number(p.lng), accuracy_m: p.accuracy_m === null ? null : Number(p.accuracy_m), roped_off: Boolean(Number(p.roped_off)), late: Boolean(Number(p.late)),
  needs_post_incident: Boolean(Number(p.needs_post_incident)), over_rating: P.overRating(p.size, p.area_level), area_level_label: p.area_level ? OPS.levelLabel(p.area_level) : null, status_label: OPS.statusLabel(p.feature_status),
});

/** The layout for one day, plus the features that are free to place (not retired, not already on the map that day). */
router.get('/placements/:date', async (req, res) => {
  const date = dateParam(req);
  const { tenantId } = req.auth;
  const placed = await rows(pool, `${placementSelect} WHERE p.tenant_id = ? AND p.on_date = ? AND p.voided_at IS NULL ORDER BY f.kind, f.name`, [tenantId, date]);
  const unplaced = await rows(pool, `${featureSelect} WHERE f.tenant_id = ? AND f.status <> 'retired' AND f.id NOT IN (SELECT feature_id FROM park_placements WHERE tenant_id = ? AND on_date = ? AND voided_at IS NULL) ORDER BY f.kind, f.name`, [tenantId, tenantId, date]);
  const today = await tenantToday(tenantId);
  const tz = await OPS.tzOf(pool, tenantId);
  res.json({ date, today, placed: OPS.local(placed.map(placementOut), tz), unplaced: unplaced.map(featureOut), editable: date >= today, correctable: isManager(req) });
});

const PLACE_COLS = ['area_id', 'lat', 'lng', 'note'];
const pick = (r) => ({ area_id: r.area_id === null || r.area_id === undefined ? null : Number(r.area_id), lat: Number(r.lat), lng: Number(r.lng), note: r.note ?? null });

/** Put a feature on the map for a day, or move it. A past day: a manager's correction, or a late entry, with a reason. */
router.put('/placements/:date/:featureId', crew, validate(placeSchema), async (req, res) => {
  const date = dateParam(req);
  const featureId = paramId(req, 'featureId');
  const { tenantId } = req.auth;
  const b = req.body;
  const past = await pastDay(req, date);
  const out = await tx(async (conn) => {
    const f = await one(conn, 'SELECT id, name, size, status FROM park_features WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, featureId]);
    if (!f) throw notFound('Park feature');
    if (f.status === 'retired') throw conflict('This feature is retired');
    let area = null;
    if (b.area_id) {
      area = await one(conn, 'SELECT id, name, level FROM park_areas WHERE tenant_id = ? AND id = ?', [tenantId, b.area_id]);
      if (!area) throw notFound('Park area');
    }
    const prior = await one(conn, 'SELECT * FROM park_placements WHERE tenant_id = ? AND on_date = ? AND feature_id = ? FOR UPDATE', [tenantId, date, featureId]);
    const areaMoves = area && (!prior || Number(prior.area_id) !== Number(area.id));
    if (area && P.overRating(f.size, area.level) && !b.size_override && !(prior && !areaMoves && prior.size_override)) {
      throw conflict(`${f.name} is ${OPS.sizeLabel(f.size)}, larger than ${area.name} is rated (${OPS.levelLabel(area.level)}). Say why it goes there, or pick another area.`, { code: 'over_rating', size: f.size, level: area.level });
    }
    const override = area && P.overRating(f.size, area.level) ? (b.size_override || (prior && prior.size_override) || null) : null;
    const how = b.how === 'gps' && b.accuracy_m != null ? Math.round(b.accuracy_m) : null;
    if (prior && past) {
      // A correction: the values before and after are both kept, and the reason.
      const before = pick(prior);
      const after = { ...before, lat: b.lat, lng: b.lng, area_id: b.area_id ?? null, note: b.note ?? null };
      await conn.query(`INSERT INTO park_placement_corrections (tenant_id, placement_id, feature_id, on_date, action, before_json, after_json, reason, corrected_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, prior.id, featureId, date, prior.voided_at ? 'restore' : 'change', JSON.stringify({ ...before, voided: Boolean(prior.voided_at) }), JSON.stringify(after), b.reason, req.auth.userId]);
      await conn.query(`UPDATE park_placements SET area_id = ?, lat = ?, lng = ?, note = ?, size_override = ?, voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE tenant_id = ? AND id = ?`,
        [after.area_id, after.lat, after.lng, after.note, override, tenantId, prior.id]);
    } else {
      await conn.query(
        `INSERT INTO park_placements (tenant_id, on_date, feature_id, area_id, lat, lng, note, placed_by, accuracy_m, placed_how, late, late_reason, size_override) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           accuracy_m = IF(VALUES(lat) = lat AND VALUES(lng) = lng, accuracy_m, VALUES(accuracy_m)),
           placed_how = IF(VALUES(lat) = lat AND VALUES(lng) = lng, placed_how, VALUES(placed_how)),
           lat = VALUES(lat), lng = VALUES(lng), area_id = VALUES(area_id), note = VALUES(note), placed_by = VALUES(placed_by), size_override = VALUES(size_override)`,
        [tenantId, date, featureId, b.area_id ?? null, b.lat, b.lng, b.note ?? null, req.auth.userId, how, b.how || null, past ? 1 : 0, past ? b.reason : null, override],
      );
    }
    if (prior && Number(prior.area_id || 0) !== Number(b.area_id || 0)) {
      const names = new Map((await rows(conn, 'SELECT id, name FROM park_areas WHERE tenant_id = ? AND id IN (?)', [tenantId, [prior.area_id || 0, b.area_id || 0]])).map((a) => [Number(a.id), a.name]));
      await OPS.logChange(conn, req, { featureId, onDate: date, field: 'area', before: names.get(Number(prior.area_id)) || null, after: names.get(Number(b.area_id)) || null, reason: b.reason || b.size_override || null, source: past ? 'correction' : 'edit' });
    }
    await audit(conn, req, prior ? (past ? 'correct' : 'move') : (past ? 'late_place' : 'place'), 'park_placements', featureId, { date, lat: b.lat, lng: b.lng, how: b.how || null, accuracy_m: b.accuracy_m ?? null, ...(override ? { over_rating: true } : {}), ...(past ? { reason_given: true } : {}) });
    return { moved: Boolean(prior), late: past && !prior, corrected: past && Boolean(prior) };
  });
  res.status(out.moved ? 200 : 201).json({ ok: true, ...out });
});

/** Take a feature off the map for a day. A past day keeps the placement, marked entered in error with the reason. */
router.delete('/placements/:date/:featureId', crew, async (req, res) => {
  const date = dateParam(req);
  const featureId = paramId(req, 'featureId');
  if (req.query.reason && !req.body?.reason) req.body = { ...(req.body || {}), reason: String(req.query.reason).slice(0, 255) };
  const past = await pastDay(req, date);
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const p = await one(conn, 'SELECT * FROM park_placements WHERE tenant_id = ? AND on_date = ? AND feature_id = ? AND voided_at IS NULL FOR UPDATE', [tenantId, date, featureId]);
    if (!p) throw notFound('Placement');
    if (past) {
      const reason = String(req.body.reason).trim();
      if (reason.length < 3) throw bad('Say why, in a few words');
      await conn.query('INSERT INTO park_placement_corrections (tenant_id, placement_id, feature_id, on_date, action, before_json, reason, corrected_by) VALUES (?, ?, ?, ?, \'remove\', ?, ?, ?)',
        [tenantId, p.id, featureId, date, JSON.stringify(pick(p)), reason, req.auth.userId]);
      await conn.query('UPDATE park_placements SET voided_at = UTC_TIMESTAMP(), voided_by = ?, void_reason = ? WHERE tenant_id = ? AND id = ?', [req.auth.userId, reason, tenantId, p.id]);
    } else {
      await conn.query('DELETE FROM park_placements WHERE tenant_id = ? AND id = ?', [tenantId, p.id]);
    }
    await audit(conn, req, past ? 'correct_unplace' : 'unplace', 'park_placements', featureId, { date });
  });
  res.json({ ok: true });
});

/** Start a day from another day's layout. Adds to what is already there; never moves or removes anything, never opens anything. */
router.post('/placements/:date/copy', crew, validate(z.object({ from: dateStr, reason: reasonField.optional() })), async (req, res) => {
  const date = dateParam(req);
  const { tenantId } = req.auth;
  if (req.body.from === date) throw bad('Pick a different day to copy from');
  const past = await pastDay(req, date);
  const out = await tx(async (conn) => {
    const [r] = await conn.query(
      `INSERT INTO park_placements (tenant_id, on_date, feature_id, area_id, lat, lng, note, placed_by, accuracy_m, placed_how, late, late_reason, size_override)
       SELECT p.tenant_id, ?, p.feature_id, p.area_id, p.lat, p.lng, p.note, ?, p.accuracy_m, 'copy', ?, ?, p.size_override FROM park_placements p JOIN park_features f ON f.id = p.feature_id AND f.tenant_id = p.tenant_id
       WHERE p.tenant_id = ? AND p.on_date = ? AND p.voided_at IS NULL AND f.status <> 'retired'
         AND p.feature_id NOT IN (SELECT feature_id FROM (SELECT feature_id FROM park_placements WHERE tenant_id = ? AND on_date = ?) already)`,
      [date, req.auth.userId, past ? 1 : 0, past ? req.body.reason : null, tenantId, req.body.from, tenantId, date],
    );
    await audit(conn, req, 'copy_layout', 'park_placements', null, { from: req.body.from, to: date, copied: r.affectedRows, ...(past ? { late: true } : {}) });
    return { copied: r.affectedRows };
  });
  res.json(out);
});

/** Rope off a placed feature today (or take the rope down). A roped-off feature does not stop its area opening. */
router.put('/placements/:date/:featureId/rope', crew, validate(z.object({ roped_off: z.boolean(), note: z.string().trim().max(255).nullable().optional(), at: atField, client_ref: clientRef })), async (req, res) => {
  const date = dateParam(req);
  const featureId = paramId(req, 'featureId');
  const { tenantId } = req.auth;
  const when = await OPS.phoneTime(pool, tenantId, req.body.at);
  if (date !== when.today) throw bad('Rope lines are recorded for today only');
  if (req.body.roped_off && !req.body.note) throw bad('Say why it is roped off');
  await tx(async (conn) => {
    const p = await one(conn, 'SELECT id, roped_off FROM park_placements WHERE tenant_id = ? AND on_date = ? AND feature_id = ? AND voided_at IS NULL FOR UPDATE', [tenantId, date, featureId]);
    if (!p) throw notFound('Placement');
    if (Boolean(Number(p.roped_off)) === req.body.roped_off) return;
    await conn.query('UPDATE park_placements SET roped_off = ?, roped_note = ?, roped_by = ?, roped_at = ? WHERE tenant_id = ? AND id = ?', [req.body.roped_off ? 1 : 0, req.body.note || null, req.auth.userId, when.utc, tenantId, p.id]);
    await OPS.logChange(conn, req, { featureId, onDate: date, field: 'roped', before: Number(p.roped_off) ? 'roped off' : 'not roped', after: req.body.roped_off ? 'roped off' : 'not roped', reason: req.body.note || null, source: 'roped' });
    await audit(conn, req, req.body.roped_off ? 'rope_off' : 'rope_down', 'park_placements', featureId, { date });
  });
  res.json({ ok: true });
});

/** Recent days that have a layout, newest first. */
router.get('/days', async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT on_date, COUNT(*) AS features FROM park_placements WHERE tenant_id = ? AND voided_at IS NULL GROUP BY on_date ORDER BY on_date DESC LIMIT 60', [req.auth.tenantId]) });
});

// ---------------------------------------------------------------- inspections
const checkItem = z.object({ key: z.string().max(30), result: z.enum(['pass', 'fail', 'na']), note: z.string().trim().max(255).nullable().optional() });
const inspectSchema = z.object({
  result: z.enum(['ok', 'needs_attention', 'closed']),
  kind: z.enum(P.INSPECTION_KIND_KEYS),
  checklist: z.array(checkItem).max(20),
  notes: z.string().trim().max(255).nullable().optional(),
  fixed: z.string().trim().max(255).nullable().optional(),
  photo_ids: z.array(z.number().int().positive()).max(10).optional(),
  no_photo_reason: z.string().trim().max(255).nullable().optional(),
  at: atField, client_ref: clientRef,
});

/**
 * Checks one inspection against the rules and returns what it would do. Used by the route and by nothing else, so the
 * rules are in one place:
 *   every item on the feature type's checklist is answered; a fail has a note; a fail cannot pass the feature
 *   anything other than a pass needs a note
 *   a pass on a closed or needs-attention feature reopens it: what was fixed, and a photo
 *   a feature closed after an incident reopens only through a post-incident inspection
 *   closing needs a photo, or why there is none (no signal: the photo follows)
 */
function judge(f, b) {
  const items = P.checklistFor(f.kind);
  const given = new Map(b.checklist.map((c) => [c.key, c]));
  for (const c of b.checklist) if (!items.some((i) => i.key === c.key)) throw bad(`"${c.key}" is not on the checklist for this feature`);
  const missing = items.filter((i) => !given.has(i.key));
  if (missing.length) throw bad(`Answer every item on the checklist: ${missing.map((i) => i.label).join(', ')}`, { code: 'checklist_missing', missing: missing.map((i) => i.key) });
  const noNote = items.filter((i) => given.get(i.key).result === 'fail' && !given.get(i.key).note);
  if (noNote.length) throw bad(`Say what failed: ${noNote.map((i) => i.label).join(', ')}`, { code: 'fail_note', items: noNote.map((i) => i.key) });
  const failed = items.filter((i) => given.get(i.key).result === 'fail');
  if (b.result === 'ok' && failed.length) throw bad('An item failed, so the feature cannot be marked no defects found. Choose Needs attention or Close it.', { code: 'fail_pass' });
  if (b.result !== 'ok' && !b.notes) throw bad('Say what is wrong so the next person knows');
  const reopen = b.result === 'ok' && ['closed', 'needs_attention'].includes(f.status);
  const photos = (b.photo_ids || []).length;
  if (reopen && (!b.fixed || b.fixed.length < 3)) throw bad('Say what was fixed before it reopens', { code: 'fixed_required' });
  if (reopen && !photos) throw bad('Add a photo of the feature as it reopens', { code: 'photo_required' });
  if (b.result === 'ok' && Number(f.needs_post_incident) && b.kind !== 'post_incident') throw bad('This feature was closed after an incident. It reopens only through a post-incident inspection.', { code: 'post_incident_required' });
  if (b.result === 'closed' && !photos && !b.no_photo_reason) throw bad('Add a photo of what is wrong, or say why there is none', { code: 'photo_required' });
  return { checklist: items.map((i) => ({ key: i.key, label: i.label, result: given.get(i.key).result, note: given.get(i.key).note || null })), reopen, failed: failed.length };
}

/** Any crew member can log an inspection. The result moves the feature's status: the only way a feature opens. */
router.post('/features/:id/inspections', crew, validate(inspectSchema), async (req, res) => {
  const id = paramId(req);
  const { tenantId } = req.auth;
  const b = req.body;
  const when = await OPS.phoneTime(pool, tenantId, b.at);
  const save = () => tx(async (conn) => {
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT id, result FROM park_inspections WHERE tenant_id = ? AND client_ref = ?', [tenantId, b.client_ref]);
      if (seen) return { id: seen.id, repeat: true, status: (await one(conn, 'SELECT status FROM park_features WHERE tenant_id = ? AND id = ?', [tenantId, id])).status };
    }
    const f = await one(conn, 'SELECT id, kind, status, needs_post_incident FROM park_features WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!f) throw notFound('Park feature');
    if (f.status === 'retired') throw conflict('This feature is retired');
    const j = judge(f, b);
    const ids = b.photo_ids || [];
    if (ids.length) {
      const found = await rows(conn, 'SELECT id FROM park_photos WHERE tenant_id = ? AND feature_id = ? AND id IN (?) AND inspection_id IS NULL', [tenantId, id, ids]);
      if (found.length !== new Set(ids).size) throw bad('A photo was not found for this feature, or is already on another inspection');
    }
    const [r] = await conn.query(`INSERT INTO park_inspections (tenant_id, feature_id, inspected_on, inspected_at, inspected_by, result, notes, kind, checklist, fixed, no_photo_reason, client_ref, received_at, reopened)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`,
    [tenantId, id, when.date, when.utc, req.auth.userId, b.result, b.notes || null, b.kind, JSON.stringify(j.checklist), b.fixed || null, b.no_photo_reason || null, b.client_ref || null, j.reopen ? 1 : 0]);
    if (ids.length) await conn.query('UPDATE park_photos SET inspection_id = ? WHERE tenant_id = ? AND feature_id = ? AND id IN (?)', [r.insertId, tenantId, id, ids]);
    const status = b.result === 'ok' ? 'ready' : b.result;
    const clearsIncident = b.result === 'ok' && b.kind === 'post_incident' && Number(f.needs_post_incident);
    await OPS.setStatus(conn, req, f, status, { reason: j.reopen ? b.fixed : (b.result === 'ok' ? null : b.notes), source: 'inspection', refId: r.insertId, onDate: when.date, extra: clearsIncident ? ', needs_post_incident = 0' : '' });
    if (clearsIncident && f.status === status) await conn.query('UPDATE park_features SET needs_post_incident = 0 WHERE tenant_id = ? AND id = ?', [tenantId, id]);
    await audit(conn, req, 'inspect', 'park_features', id, { result: b.result, kind: b.kind, reopened: j.reopen, failed_items: j.failed, photos: ids.length, ...(b.at ? { phone_time: true } : {}) });
    return { id: r.insertId, status, reopened: j.reopen };
  });
  let out;
  try { out = await save(); } catch (err) {
    // Two copies of the same entry arrived at once: the second finds the first.
    if (err.code !== 'ER_DUP_ENTRY' || !b.client_ref) throw err;
    out = { id: (await one(pool, 'SELECT id FROM park_inspections WHERE tenant_id = ? AND client_ref = ?', [tenantId, b.client_ref])).id, repeat: true };
  }
  res.status(out.repeat ? 200 : 201).json(out);
});

const inspectionRows = (where, params) => rows(pool, `SELECT i.id, i.feature_id, i.inspected_on, i.inspected_at, i.received_at, i.result, i.kind, i.notes, i.checklist, i.fixed, i.no_photo_reason, i.reopened,
    i.voided_at, i.void_reason, i.corrects_id, COALESCE(u.email, u.username) AS inspected_by, COALESCE(vu.email, vu.username) AS voided_by,
    (SELECT COUNT(*) FROM park_photos ph WHERE ph.tenant_id = i.tenant_id AND ph.inspection_id = i.id) AS photos
  FROM park_inspections i LEFT JOIN users u ON u.id = i.inspected_by AND u.tenant_id = i.tenant_id LEFT JOIN users vu ON vu.id = i.voided_by AND vu.tenant_id = i.tenant_id
  WHERE ${where} ORDER BY i.inspected_at DESC, i.id DESC LIMIT 200`, params);
const inspectionOut = (i) => ({ ...i, checklist: typeof i.checklist === 'string' ? JSON.parse(i.checklist) : i.checklist, reopened: Boolean(Number(i.reopened)), photos: Number(i.photos), result_label: OPS.resultLabel(i.result), kind_label: i.kind ? OPS.inspectionKindLabel(i.kind) : null });

router.get('/features/:id/inspections', async (req, res) => {
  const tz = await OPS.tzOf(pool, req.auth.tenantId);
  res.json({ data: OPS.local((await inspectionRows('i.tenant_id = ? AND i.feature_id = ?', [req.auth.tenantId, paramId(req)])).map(inspectionOut), tz) });
});

/**
 * A manager corrects an inspection: the original stays, marked entered in error with who, when and why, and the corrected
 * one (if any) is a new row pointing at it, at the original's time. A correction never opens or closes a feature: only a
 * new inspection does that.
 */
router.post('/inspections/:iid/correct', crew, validate(z.object({
  reason: reasonField,
  replacement: z.object({ result: z.enum(['ok', 'needs_attention', 'closed']), notes: z.string().trim().max(255).nullable().optional(), kind: z.enum(P.INSPECTION_KIND_KEYS).optional() }).optional(),
})), async (req, res) => {
  if (!isManager(req)) throw forbidden('Only a manager corrects an inspection');
  const iid = paramId(req, 'iid');
  const { tenantId } = req.auth;
  const out = await tx(async (conn) => {
    const i = await one(conn, 'SELECT * FROM park_inspections WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, iid]);
    if (!i) throw notFound('Inspection');
    if (i.voided_at) throw conflict('Already corrected');
    const rep = req.body.replacement;
    if (rep && rep.result !== 'ok' && !rep.notes) throw bad('Say what was wrong');
    await conn.query('UPDATE park_inspections SET voided_at = UTC_TIMESTAMP(), voided_by = ?, void_reason = ? WHERE tenant_id = ? AND id = ?', [req.auth.userId, req.body.reason, tenantId, iid]);
    let newId = null;
    if (rep) {
      const [r] = await conn.query(`INSERT INTO park_inspections (tenant_id, feature_id, inspected_on, inspected_at, inspected_by, result, notes, kind, checklist, received_at, corrects_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?)`, [tenantId, i.feature_id, i.inspected_on, i.inspected_at, req.auth.userId, rep.result, rep.notes || null, rep.kind || i.kind, i.checklist === null ? null : (typeof i.checklist === 'string' ? i.checklist : JSON.stringify(i.checklist)), iid]);
      newId = r.insertId;
    }
    await audit(conn, req, 'correct_inspection', 'park_features', i.feature_id, { inspection: iid, replacement: newId });
    return { ok: true, id: newId };
  });
  res.json(out);
});

router.judge = judge;
module.exports = router;
