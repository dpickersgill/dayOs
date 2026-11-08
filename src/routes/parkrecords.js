'use strict';

// Terrain park records (mounted under /park beside routes/park.js): photos of a feature, opening and closing an area for
// the day, a feature's full history, closing a feature for a post-incident inspection, and the printable day record.
//
// Photos follow the patrol photo pattern (routes/patrolmedia.js): stored exactly as uploaded, with the SHA-256 taken at
// upload; Verify recomputes it from the stored bytes, and the original downloads with its fingerprint in the headers.
// A photo is never deleted.
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { z, validate, paramId, dateStr, dateTimeStr, dayRange, todayIn } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { photoFacts, sniff } = require('../lib/exif');
const PA = require('../lib/patrolaccess');
const P = require('../lib/park');
const OPS = require('../lib/parkops');

const router = express.Router();
const crew = requireRole('staff', 'manager');
const crewOrPatrol = requireRole('staff', 'manager', 'patrol');
const MAX_BYTES = 15 * 1024 * 1024;
const raw = express.raw({ type: () => true, limit: MAX_BYTES });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const reasonField = z.string().trim().min(3, 'Say why, in a few words').max(255);
const clientRef = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional();
const atField = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/).optional();

// ---------------------------------------------------------------- photos
const PHOTO_META = `ph.id, ph.feature_id, ph.inspection_id, ph.via_inspection, ph.late_reason, ph.mime, ph.file_name, ph.bytes, ph.sha256, ph.caption, ph.taken_at, ph.taken_lat, ph.taken_lng, ph.uploaded_at,
  COALESCE(u.email, u.username) AS uploaded_by_name`;
const PHOTO_JOIN = 'LEFT JOIN users u ON u.id = ph.uploaded_by AND u.tenant_id = ph.tenant_id';

/**
 * Adds a photo of a feature: the body is the file itself, untouched. Query: caption, client_ref (so a repeated upload is
 * kept once), the phone's lat, lng and taken_at, and inspection_id to add it to an inspection already saved (a closing
 * recorded with no signal, whose photo follows; the same day and not entered in error, or a manager with reason), and
 * for=inspection when the inspection screen takes it (only those count as an inspection's photos, and only that day).
 */
router.post('/features/:id/photos', crew, raw, async (req, res) => {
  const id = paramId(req);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose a photo');
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  const q = z.object({
    caption: z.string().trim().max(255).optional(), client_ref: clientRef, file_name: z.string().trim().max(200).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), taken_at: dateTimeStr.optional(),
    inspection_id: z.coerce.number().int().positive().optional(),
    for: z.enum(['inspection']).optional(), reason: z.string().trim().min(3).max(255).optional(),
  }).safeParse(req.query);
  if (!q.success) throw bad('Something about that photo upload was not right');
  const b = q.data;
  const { tenantId } = req.auth;
  const out = await tx(async (conn) => {
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT id, sha256 FROM park_photos WHERE tenant_id = ? AND client_ref = ?', [tenantId, b.client_ref]);
      if (seen) return { id: seen.id, sha256: seen.sha256, repeat: true };
    }
    if (!(await one(conn, 'SELECT id FROM park_features WHERE tenant_id = ? AND id = ?', [tenantId, id]))) throw notFound('Park feature');
    let lateReason = null;
    if (b.inspection_id) {
      // The photo that follows a closing saved with no signal: the crew adds it the same day, to an inspection that
      // stands. Another day's inspection, or one entered in error, is a correction: a manager, with a reason.
      const i = await one(conn, 'SELECT id, inspected_on, voided_at FROM park_inspections WHERE tenant_id = ? AND feature_id = ? AND id = ?', [tenantId, id, b.inspection_id]);
      if (!i) throw notFound('Inspection');
      const today = todayIn(await OPS.tzOf(conn, tenantId));
      if (String(i.inspected_on).slice(0, 10) !== today || i.voided_at) {
        const what = i.voided_at ? 'That inspection was marked entered in error' : 'That inspection was on another day';
        if (!isManager(req)) throw forbidden(`${what}. Ask a manager to add the photo as a correction.`);
        if (!b.reason) throw bad(`${what}. Say why the photo is being added; it is kept with the photo.`, { code: 'reason_required' });
        lateReason = b.reason;
      }
    }
    const facts = photoFacts(buf);
    const hash = sha(buf);
    const [r] = await conn.query(`INSERT INTO park_photos (tenant_id, feature_id, inspection_id, mime, file_name, bytes, sha256, original, caption, taken_at, taken_lat, taken_lng, client_ref, uploaded_by, via_inspection, late_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, id, b.inspection_id || null, mime, b.file_name || null, buf.length, hash, buf, b.caption || null, facts.taken_at || (b.taken_at ? b.taken_at.replace('T', ' ').slice(0, 19) : null),
      facts.lat ?? b.lat ?? null, facts.lng ?? b.lng ?? null, b.client_ref || null, req.auth.userId, b.for === 'inspection' || b.inspection_id ? 1 : 0, lateReason]);
    await audit(conn, req, lateReason ? 'correct_add_photo' : 'add_photo', 'park_features', id, { photo_id: r.insertId, sha256: hash, bytes: buf.length, ...(b.inspection_id ? { inspection: b.inspection_id } : {}), ...(lateReason ? { reason: lateReason } : {}) });
    return { id: r.insertId, sha256: hash, bytes: buf.length };
  });
  res.status(out.repeat ? 200 : 201).json(out);
});

router.get('/features/:id/photos', async (req, res) => {
  if (!(await one(pool, 'SELECT id FROM park_features WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]))) throw notFound('Park feature');
  const tz = await OPS.tzOf(pool, req.auth.tenantId);
  res.json({ data: OPS.local(await rows(pool, `SELECT ${PHOTO_META} FROM park_photos ph ${PHOTO_JOIN} WHERE ph.tenant_id = ? AND ph.feature_id = ? ORDER BY ph.id DESC LIMIT 200`, [req.auth.tenantId, paramId(req)]), tz) });
});

/** The original, byte for byte, with its recorded fingerprint. */
router.get('/photos/:pid/original', async (req, res) => {
  const r = await one(pool, 'SELECT id, original, mime, sha256 FROM park_photos WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req, 'pid')]);
  if (!r) throw notFound('Photo');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[r.mime] || 'bin';
  res.set({ 'Content-Type': r.mime, 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="park-photo-${r.id}.${ext}"`, 'X-Content-SHA256': r.sha256, 'Cache-Control': 'private, no-store' }).send(r.original);
});

/** Recomputes the fingerprint from the stored bytes and compares it with the one recorded at upload. */
router.get('/photos/:pid/verify', async (req, res) => {
  const r = await one(pool, 'SELECT original, sha256, uploaded_at FROM park_photos WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req, 'pid')]);
  if (!r) throw notFound('Photo');
  const now = sha(r.original);
  res.json({ unchanged: now === r.sha256, recorded: r.sha256, computed: now, uploaded_at: r.uploaded_at });
});

// ---------------------------------------------------------------- opening and closing an area for the day
/**
 * The features placed in an area today that stop it opening, each with why and what to do. A feature blocks while it is
 * closed, waits for a post-incident inspection, needs attention, has never passed an inspection, or was not inspected
 * today. Roping it off (which takes a reason) lets the area open around it, the same for every one of these.
 */
const BLOCK = [
  // [key, test, why, what to do], most serious first; the first that applies says why and what to do, and reasons lists all.
  ['post_incident', (f) => Number(f.needs_post_incident), 'Needs a post-incident inspection', 'Do a post-incident inspection that finds no defects, or rope it off with a reason.'],
  ['closed', (f) => f.status === 'closed', 'Closed', 'Fix it and log an inspection that finds no defects, or rope it off with a reason.'],
  ['needs_attention', (f) => f.status === 'needs_attention', 'Needs attention', 'Fix it and log an inspection that finds no defects, or rope it off with a reason.'],
  ['not_inspected', (f) => !Number(f.inspected), 'Not inspected today', 'Inspect it today, or rope it off with a reason.'],
  ['never_passed', (f) => f.status === 'new' || !Number(f.passed), 'Never passed an inspection', 'Log an inspection that finds no defects, or rope it off with a reason.'],
];
async function blockers(db, tenantId, areaId, date) {
  const list = await rows(db, `SELECT f.id, f.name, f.status, f.needs_post_incident, p.roped_off,
      (SELECT COUNT(*) FROM park_inspections i WHERE i.tenant_id = p.tenant_id AND i.feature_id = p.feature_id AND i.inspected_on = p.on_date AND i.voided_at IS NULL) AS inspected,
      (SELECT COUNT(*) FROM park_inspections i WHERE i.tenant_id = p.tenant_id AND i.feature_id = p.feature_id AND i.result = 'ok' AND i.voided_at IS NULL) AS passed
    FROM park_placements p JOIN park_features f ON f.tenant_id = p.tenant_id AND f.id = p.feature_id
    WHERE p.tenant_id = ? AND p.area_id = ? AND p.on_date = ? AND p.voided_at IS NULL ORDER BY f.name`, [tenantId, areaId, date]);
  const out = [];
  for (const f of list) {
    if (Number(f.roped_off)) continue;
    const hits = BLOCK.filter(([, t]) => t(f));
    if (!hits.length) continue;
    out.push({ feature_id: Number(f.id), name: f.name, why: hits[0][2], reasons: hits.map((x) => x[0]), todo: hits[0][3] });
  }
  return out;
}

/** Works out how an area stands today (OPS.areaState) and keeps park_areas.status the same. Inside the caller's transaction. */
async function storeState(conn, tenantId, areaId, date, tz) {
  const days = await rows(conn, 'SELECT id, action, at, received_at FROM park_area_days WHERE tenant_id = ? AND area_id = ? AND on_date = ? ORDER BY at, id', [tenantId, areaId, date]);
  const state = OPS.areaState(days, tz);
  await conn.query('UPDATE park_areas SET status = ? WHERE tenant_id = ? AND id = ?', [state.status === 'open' ? 'open' : 'closed', tenantId, areaId]);
  return state;
}

router.get('/areas/:id/open-check', async (req, res) => {
  const id = paramId(req);
  const a = await one(pool, 'SELECT id FROM park_areas WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!a) throw notFound('Park area');
  const today = (await OPS.phoneTime(pool, req.auth.tenantId)).today;
  res.json({ date: today, blocking: await blockers(pool, req.auth.tenantId, id, today), checklist: P.SIGNOFF });
});

/**
 * Opens an area for the day: every item on the opening checklist, the supervisor's name and the time. Refused while any
 * feature placed in the area today is not inspected today or is closed, unless that feature is recorded as roped off.
 */
router.post('/areas/:id/open', crew, validate(z.object({
  checklist: z.record(z.string().max(30), z.boolean()), supervisor_name: z.string().trim().min(2, 'Who is signing off?').max(100),
  notes: z.string().trim().max(255).nullable().optional(), at: atField, client_ref: clientRef,
})), async (req, res) => {
  const id = paramId(req);
  const { tenantId } = req.auth;
  const b = req.body;
  const when = await OPS.phoneTime(pool, tenantId, b.at);
  if (when.date !== when.today) throw bad('An area is opened for today only');
  const out = await tx(async (conn) => {
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT id FROM park_area_days WHERE tenant_id = ? AND client_ref = ?', [tenantId, b.client_ref]);
      if (seen) return { id: seen.id, repeat: true };
    }
    const a = await one(conn, 'SELECT id, name, active FROM park_areas WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!a) throw notFound('Park area');
    if (!Number(a.active)) throw conflict('This area is not in use');
    const unticked = P.SIGNOFF.filter(([k]) => b.checklist[k] !== true);
    if (unticked.length) throw bad(`Tick every item before opening: ${unticked.map((x) => x[1]).join(', ')}`, { code: 'signoff_missing', missing: unticked.map((x) => x[0]) });
    const blocking = await blockers(conn, tenantId, id, when.today);
    if (blocking.length) throw conflict(`${a.name} cannot open yet. ${blocking.map((x) => `${x.name}: ${x.why}. ${x.todo}`).join(' ')}`, { code: 'area_blocked', blocking });
    const checklist = P.SIGNOFF.map(([key, label]) => ({ key, label, done: true }));
    const [r] = await conn.query(`INSERT INTO park_area_days (tenant_id, area_id, on_date, action, checklist, supervisor_name, reason, at, client_ref, signed_by, received_at) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, id, when.today, JSON.stringify(checklist), b.supervisor_name, b.notes || null, when.utc, b.client_ref || null, req.auth.userId, OPS.utcNow()]);
    const state = await storeState(conn, tenantId, id, when.today, when.tz);
    await audit(conn, req, 'open_area', 'park_areas', id, { signoff: r.insertId, date: when.today, ...(state.status !== 'open' ? { stays_closed: true } : {}) });
    // An opening kept on a phone with no signal that was made before a closing reached the server: the closing wins.
    if (state.status !== 'open') return { id: r.insertId, status: state.status, message: `${a.name} stays closed: a closing reached the server after this opening was made. Open it again to reopen it.` };
    return { id: r.insertId, status: 'open' };
  });
  res.status(out.repeat ? 200 : 201).json(out);
});

/**
 * Closes an area (weather, visibility, wind, hard snow or another reason), with the time. Every feature placed in it
 * today that is not already closed is closed, each with its own record; each reopens through an inspection.
 */
router.post('/areas/:id/close', crew, validate(z.object({
  reason_kind: z.enum(P.CLOSE_REASON_KEYS), reason: reasonField, at: atField, client_ref: clientRef,
})), async (req, res) => {
  const id = paramId(req);
  const { tenantId } = req.auth;
  const b = req.body;
  const when = await OPS.phoneTime(pool, tenantId, b.at);
  const out = await tx(async (conn) => {
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT id, features_closed FROM park_area_days WHERE tenant_id = ? AND client_ref = ?', [tenantId, b.client_ref]);
      if (seen) return { id: seen.id, closed: Number(seen.features_closed), repeat: true };
    }
    const a = await one(conn, 'SELECT id, name FROM park_areas WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!a) throw notFound('Park area');
    const feats = await rows(conn, `SELECT f.id, f.status FROM park_placements p JOIN park_features f ON f.tenant_id = p.tenant_id AND f.id = p.feature_id
      WHERE p.tenant_id = ? AND p.area_id = ? AND p.on_date = ? AND p.voided_at IS NULL AND f.status NOT IN ('closed','retired') FOR UPDATE`, [tenantId, id, when.date]);
    const [r] = await conn.query(`INSERT INTO park_area_days (tenant_id, area_id, on_date, action, reason_kind, reason, at, features_closed, client_ref, signed_by, received_at) VALUES (?, ?, ?, 'close', ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, id, when.date, b.reason_kind, b.reason, when.utc, feats.length, b.client_ref || null, req.auth.userId, OPS.utcNow()]);
    const why = `${(P.CLOSE_REASONS.find((x) => x[0] === b.reason_kind) || [0, ''])[1]}: ${b.reason}`;
    for (const f of feats) await OPS.setStatus(conn, req, f, 'closed', { reason: why, source: 'area_close', refId: r.insertId, onDate: when.date });
    const state = when.date === when.today ? await storeState(conn, tenantId, id, when.today, when.tz) : null;
    await audit(conn, req, 'close_area', 'park_areas', id, { reason_kind: b.reason_kind, features_closed: feats.length, date: when.date });
    const late = state && state.late.find((x) => x.id === Number(r.insertId));
    return { id: r.insertId, closed: feats.length, status: state ? state.status : 'closed', ...(late ? { message: late.message } : {}) };
  });
  res.status(out.repeat ? 200 : 201).json(out);
});

// ---------------------------------------------------------------- closing a feature after an incident
/** Close a feature for a post-incident inspection, from the park screens (the park crew or patrol). */
router.post('/features/:id/close-for-incident', crewOrPatrol, validate(z.object({ reason: reasonField })), async (req, res) => {
  const id = paramId(req);
  const f = await tx(async (conn) => {
    const was = await OPS.closeForIncident(conn, req, id, { reason: req.body.reason });
    if (!was) throw notFound('Park feature');
    await audit(conn, req, 'close_for_incident', 'park_features', id, {});
    return was;
  });
  await OPS.tellSupervisors(pool, req, `${f.name} was closed for a post-incident inspection. It reopens only after a post-incident inspection passes.`, { tag: `park-${id}` });
  res.json({ ok: true, status: 'closed' });
});

// ---------------------------------------------------------------- history
/** May this login see which patrol cases name a feature (case number and date only)? The park crew, and patrol with cases. */
async function seesIncidents(req) {
  if (['owner', 'manager', 'staff'].includes(req.auth.role)) return true;
  if (req.auth.role === 'patrol' || req.auth.onPatrol) return PA.can(pool, req, 'view_cases');
  return false;
}
const caseNo = (i) => (i.seq ? `${i.season}-${String(i.seq).padStart(4, '0')}` : `Case ${i.id}`);

/** Where one feature has been day by day, every change to it with before and after values, and the cases that name it. */
router.get('/features/:id/history', async (req, res) => {
  const id = paramId(req);
  const t = req.auth.tenantId;
  if (!(await one(pool, 'SELECT id FROM park_features WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Park feature');
  const places = await rows(pool, `SELECT p.id, p.on_date, p.lat, p.lng, p.note, p.late, p.late_reason, p.size_override, p.roped_off, p.voided_at, p.void_reason, a.name AS area, p.created_at
    FROM park_placements p LEFT JOIN park_areas a ON a.id = p.area_id AND a.tenant_id = p.tenant_id WHERE p.tenant_id = ? AND p.feature_id = ? ORDER BY p.on_date DESC LIMIT 60`, [t, id]);
  const corrections = await rows(pool, `SELECT c.id, c.on_date, c.action, c.before_json, c.after_json, c.reason, c.corrected_at, COALESCE(u.email, u.username) AS corrected_by
    FROM park_placement_corrections c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.corrected_by WHERE c.tenant_id = ? AND c.feature_id = ? ORDER BY c.id DESC LIMIT 200`, [t, id]);
  const changes = await rows(pool, `SELECT c.id, c.on_date, c.field, c.before_value, c.after_value, c.reason, c.source, c.changed_at, COALESCE(u.email, u.username) AS changed_by
    FROM park_feature_changes c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.changed_by WHERE c.tenant_id = ? AND c.feature_id = ? ORDER BY c.changed_at DESC, c.id DESC LIMIT 300`, [t, id]);
  let incidents = null;
  if (await seesIncidents(req)) {
    incidents = (await rows(pool, `SELECT l.id, l.on_date, i.id AS incident_id, i.season, i.seq, DATE(i.occurred_at) AS occurred_on FROM incident_park_links l
      JOIN incidents i ON i.tenant_id = l.tenant_id AND i.id = l.incident_id WHERE l.tenant_id = ? AND l.feature_id = ? AND l.voided_at IS NULL ORDER BY i.occurred_at DESC LIMIT 100`, [t, id]))
      .map((r) => ({ incident_id: Number(r.incident_id), case_number: caseNo({ ...r, id: r.incident_id }), date: r.occurred_on }));
  }
  const js = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);
  const tz = await OPS.tzOf(pool, t);
  res.json({
    data: OPS.local(places.map((p) => ({ ...p, late: Boolean(Number(p.late)), roped_off: Boolean(Number(p.roped_off)) })), tz),
    corrections: OPS.local(corrections.map((c) => ({ ...c, before: js(c.before_json), after: js(c.after_json), before_json: undefined, after_json: undefined })), tz),
    changes: OPS.local(changes, tz), incidents,
  });
});

/** An area's history: its rating changes, openings and closures. */
router.get('/areas/:id/history', async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  if (!(await one(pool, 'SELECT id FROM park_areas WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Park area');
  const changes = await rows(pool, `SELECT c.field, c.before_value, c.after_value, c.reason, c.changed_at, COALESCE(u.email, u.username) AS changed_by FROM park_feature_changes c
    LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.changed_by WHERE c.tenant_id = ? AND c.area_id = ? ORDER BY c.changed_at DESC LIMIT 200`, [t, id]);
  const days = await rows(pool, `SELECT d.on_date, d.action, d.at, d.supervisor_name, d.reason_kind, d.reason, d.features_closed, COALESCE(u.email, u.username) AS signed_by FROM park_area_days d
    LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.signed_by WHERE d.tenant_id = ? AND d.area_id = ? ORDER BY d.at DESC LIMIT 200`, [t, id]);
  const tz = await OPS.tzOf(pool, t);
  res.json({ changes: OPS.local(changes, tz), days: OPS.local(days, tz) });
});

// ---------------------------------------------------------------- the day record
/**
 * Everything about one area on one day, for printing: the layout, each feature with its size and its status changes with
 * times, the inspections with names, the opening sign-off and closures, and the corrections made since.
 */
router.get('/areas/:id/record/:date', async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const date = req.params.date;
  if (!dateStr.safeParse(date).success) throw bad('Use YYYY-MM-DD');
  const area = await one(pool, 'SELECT id, name, level, notes FROM park_areas WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!area) throw notFound('Park area');
  const tz = await OPS.tzOf(pool, t);
  const [from, to] = dayRange(tz, date);
  const placed = await rows(pool, `SELECT p.id, p.feature_id, p.lat, p.lng, p.note, p.late, p.late_reason, p.size_override, p.roped_off, p.roped_note, p.voided_at, p.void_reason, p.placed_how,
      f.name, f.kind, f.size, f.dimensions, f.status
    FROM park_placements p JOIN park_features f ON f.tenant_id = p.tenant_id AND f.id = p.feature_id WHERE p.tenant_id = ? AND p.area_id = ? AND p.on_date = ? ORDER BY f.name`, [t, id, date]);
  const ids = placed.map((p) => Number(p.feature_id));
  const any = ids.length ? ids : [0];
  const inspections = await rows(pool, `SELECT i.id, i.feature_id, i.inspected_at, i.received_at, i.result, i.kind, i.notes, i.fixed, i.checklist, i.reopened, i.voided_at, i.void_reason, i.corrects_id,
      COALESCE(u.email, u.username) AS inspected_by, COALESCE(vu.email, vu.username) AS voided_by, (SELECT COUNT(*) FROM park_photos ph WHERE ph.tenant_id = i.tenant_id AND ph.inspection_id = i.id) AS photos
    FROM park_inspections i LEFT JOIN users u ON u.tenant_id = i.tenant_id AND u.id = i.inspected_by LEFT JOIN users vu ON vu.tenant_id = i.tenant_id AND vu.id = i.voided_by
    WHERE i.tenant_id = ? AND i.feature_id IN (?) AND i.inspected_on = ? ORDER BY i.inspected_at, i.id`, [t, any, date]);
  const changes = await rows(pool, `SELECT c.feature_id, c.field, c.before_value, c.after_value, c.reason, c.source, c.changed_at, COALESCE(u.email, u.username) AS changed_by
    FROM park_feature_changes c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.changed_by
    WHERE c.tenant_id = ? AND ((c.feature_id IN (?) AND (c.on_date = ? OR (c.on_date IS NULL AND c.changed_at >= ? AND c.changed_at < ?))) OR (c.area_id = ? AND c.changed_at >= ? AND c.changed_at < ?)) ORDER BY c.changed_at, c.id`,
  [t, any, date, from, to, id, from, to]);
  const days = await rows(pool, `SELECT d.id, d.action, d.at, d.received_at, d.checklist, d.supervisor_name, d.reason_kind, d.reason, d.features_closed, COALESCE(u.email, u.username) AS signed_by
    FROM park_area_days d LEFT JOIN users u ON u.tenant_id = d.tenant_id AND u.id = d.signed_by WHERE d.tenant_id = ? AND d.area_id = ? AND d.on_date = ? ORDER BY d.at, d.id`, [t, id, date]);
  const corrections = await rows(pool, `SELECT c.feature_id, c.action, c.before_json, c.after_json, c.reason, c.corrected_at, COALESCE(u.email, u.username) AS corrected_by
    FROM park_placement_corrections c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.corrected_by WHERE c.tenant_id = ? AND c.on_date = ? AND c.feature_id IN (?) ORDER BY c.id`, [t, date, any]);
  const js = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : v);
  const state = OPS.areaState(days, tz); // the same rule as the park screen and the public feed
  await audit(pool, req, 'view_day_record', 'park_areas', id, { date });
  res.json({
    area: { ...area, level_label: OPS.levelLabel(area.level) }, date, timezone: tz, status: state.status, late_notes: state.late.map((x) => x.message),
    features: OPS.local(placed.map((p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng), late: Boolean(Number(p.late)), roped_off: Boolean(Number(p.roped_off)), kind_label: OPS.kindLabel(p.kind), size_label: OPS.sizeLabel(p.size), over_rating: P.overRating(p.size, area.level) })), tz),
    inspections: OPS.local(inspections.map((i) => ({ ...i, checklist: js(i.checklist), reopened: Boolean(Number(i.reopened)), photos: Number(i.photos), result_label: OPS.resultLabel(i.result), kind_label: i.kind ? OPS.inspectionKindLabel(i.kind) : null })), tz),
    changes: OPS.local(changes, tz), days: OPS.local(days.map((d) => ({ ...d, checklist: js(d.checklist), late_message: (state.late.find((x) => x.id === Number(d.id)) || {}).message || null })), tz),
    corrections: OPS.local(corrections.map((c) => ({ ...c, before: js(c.before_json), after: js(c.after_json), before_json: undefined, after_json: undefined })), tz),
    can_correct: isManager(req),
  });
});

router.blockers = blockers;
module.exports = router;
