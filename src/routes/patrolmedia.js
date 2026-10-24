'use strict';

// Photos on a patrol case, kept so they stand up as evidence. Each file is stored exactly as uploaded, with its SHA-256
// recorded at upload; Verify recomputes it from the stored bytes, and the original downloads with its fingerprint in the
// file's headers. When and where the photo was taken come from the photo itself (EXIF), else from the phone at upload.
// The case page shows a small preview first (made on the phone), so a case with many photos opens fast.
//
// Like every care record, a photo is never deleted: a wrong one is marked entered in error, with who and why, and stays
// in the record struck through. Adding photos follows the report's rules (not once approved; a manager reopens it).
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, nowIn } = require('../lib/util');
const { notFound, bad, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const { photoFacts, sniff } = require('../lib/exif');
const cases = require('./patrol');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (feature, message) => PA.needs(pool, feature, message);
const MAX_BYTES = 15 * 1024 * 1024; // a phone photo at full size is 2 to 8 MB
const MAX_PREVIEW = 600 * 1024;
const raw = (limit) => express.raw({ type: () => true, limit });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const META = `m.id, m.incident_id, m.patient_id, m.mime, m.file_name, m.bytes, m.sha256, m.caption, m.taken_at, m.taken_lat, m.taken_lng, m.uploaded_at,
  (m.preview IS NOT NULL) AS has_preview, m.voided_at, m.void_reason, COALESCE(u.email, u.username) AS uploaded_by_name, COALESCE(vu.email, vu.username) AS voided_by_email`;
const JOINS = 'LEFT JOIN users u ON u.id = m.uploaded_by AND u.tenant_id = m.tenant_id LEFT JOIN users vu ON vu.id = m.voided_by AND vu.tenant_id = m.tenant_id';
const shape = (r) => ({ ...r, has_preview: Boolean(r.has_preview), taken_lat: r.taken_lat === null ? null : Number(r.taken_lat), taken_lng: r.taken_lng === null ? null : Number(r.taken_lng) });

/** The photos on a case, newest last, without their bytes. Used by the case page and the frozen versions. */
async function listFor(conn, tenantId, incidentId) {
  return (await rows(conn, `SELECT ${META} FROM incident_media m ${JOINS} WHERE m.tenant_id = ? AND m.incident_id = ? ORDER BY m.id`, [tenantId, incidentId])).map(shape);
}

async function caseOf(tenantId, id) {
  const c = await one(pool, 'SELECT id, report_state FROM incidents WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!c) throw notFound('Incident');
  return c;
}
async function mediaOf(tenantId, incidentId, mid) {
  const m = await one(pool, 'SELECT id, incident_id, mime, file_name, bytes, sha256, voided_at FROM incident_media WHERE tenant_id = ? AND incident_id = ? AND id = ?', [tenantId, incidentId, mid]);
  if (!m) throw notFound('Photo');
  return m;
}

router.get('/incidents/:id/photos', patrol, needs('view_cases'), async (req, res) => {
  await caseOf(req.auth.tenantId, paramId(req));
  res.json({ data: await listFor(pool, req.auth.tenantId, paramId(req)) });
});

/**
 * Adds a photo: the body is the file itself, untouched. Query: caption, patient_id, client_ref (so a repeated upload is
 * kept once), and the phone's own lat, lng and taken_at for a photo whose file carries none.
 */
router.post('/incidents/:id/photos', patrol, needs('create_case'), raw(MAX_BYTES), async (req, res) => {
  const id = paramId(req);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose a photo');
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  const q = z.object({
    caption: z.string().trim().max(255).optional(),
    patient_id: z.coerce.number().int().positive().optional(),
    client_ref: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional(),
    file_name: z.string().trim().max(200).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(),
    taken_at: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/).optional(),
  }).safeParse(req.query);
  if (!q.success) throw bad('Something about that photo upload was not right');
  const b = q.data;
  const out = await tx(async (conn) => {
    await cases.editableCase(conn, req, id);
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT id FROM incident_media WHERE tenant_id = ? AND client_ref = ?', [req.auth.tenantId, b.client_ref]);
      if (seen) return { id: seen.id, repeat: true };
    }
    if (b.patient_id && !(await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, b.patient_id]))) throw notFound('Patient');
    const facts = photoFacts(buf);
    const fromPhoto = Boolean(facts.taken_at || facts.lat !== null);
    const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
    const hash = sha(buf);
    const [r] = await conn.query(`INSERT INTO incident_media (tenant_id, incident_id, patient_id, mime, file_name, bytes, sha256, original, caption, taken_at, taken_lat, taken_lng, client_ref, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.auth.tenantId, id, b.patient_id ?? null, mime, b.file_name || null, buf.length, hash, buf, b.caption || null,
      facts.taken_at || (b.taken_at ? b.taken_at.replace('T', ' ').slice(0, 19) : null), facts.lat ?? b.lat ?? null, facts.lng ?? b.lng ?? null,
      b.client_ref || null, req.auth.userId, nowIn(tz)]);
    await audit(conn, req, 'add_photo', 'incidents', id, { photo_id: r.insertId, sha256: hash, bytes: buf.length, facts_from: fromPhoto ? 'photo' : 'phone' });
    return { id: r.insertId, sha256: hash, bytes: buf.length, taken_at: facts.taken_at, from_photo: fromPhoto };
  });
  res.status(out.repeat ? 200 : 201).json(out);
});

/** The small preview the phone made, shown on the case page before anyone opens the original. Set once. */
router.put('/incidents/:id/photos/:mid/preview', patrol, needs('create_case'), raw(MAX_PREVIEW), async (req, res) => {
  const id = paramId(req); const mid = paramId(req, 'mid');
  await mediaOf(req.auth.tenantId, id, mid);
  if (!Buffer.isBuffer(req.body) || sniff(req.body) !== 'image/jpeg') throw bad('The preview must be a JPEG');
  await pool.query('UPDATE incident_media SET preview = ? WHERE tenant_id = ? AND incident_id = ? AND id = ? AND preview IS NULL', [req.body, req.auth.tenantId, id, mid]);
  res.json({ ok: true });
});

router.get('/incidents/:id/photos/:mid/preview', patrol, needs('view_cases'), async (req, res) => {
  const r = await one(pool, 'SELECT preview, mime FROM incident_media WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, paramId(req), paramId(req, 'mid')]);
  if (!r) throw notFound('Photo');
  if (!r.preview) throw new AppError(404, 'No preview yet');
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' }).send(r.preview);
});

/** The original, byte for byte, with its recorded fingerprint. Every opening is logged, like reading the case. */
router.get('/incidents/:id/photos/:mid/original', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req); const mid = paramId(req, 'mid');
  const r = await one(pool, 'SELECT original, mime, file_name, sha256 FROM incident_media WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, mid]);
  if (!r) throw notFound('Photo');
  await audit(pool, req, 'view_photo', 'incidents', id, { photo_id: mid });
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[r.mime] || 'bin';
  const name = `case-${id}-photo-${mid}.${ext}`;
  res.set({ 'Content-Type': r.mime, 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"`, 'X-Content-SHA256': r.sha256, 'Cache-Control': 'private, no-store' }).send(r.original);
});

/** Recomputes the fingerprint from the stored bytes and compares it with the one recorded at upload. */
router.get('/incidents/:id/photos/:mid/verify', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req); const mid = paramId(req, 'mid');
  const r = await one(pool, 'SELECT original, sha256, uploaded_at FROM incident_media WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, mid]);
  if (!r) throw notFound('Photo');
  const now = sha(r.original);
  res.json({ unchanged: now === r.sha256, recorded: r.sha256, computed: now, uploaded_at: r.uploaded_at });
});

router.post('/incidents/:id/photos/:mid/void', patrol, needs('create_case'), validate(z.object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(255) })), async (req, res) => {
  const id = paramId(req); const mid = paramId(req, 'mid');
  await tx(async (conn) => {
    await cases.editableCase(conn, req, id);
    const m = await mediaOf(req.auth.tenantId, id, mid);
    if (m.voided_at) throw bad('Already marked entered in error');
    const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
    await conn.query('UPDATE incident_media SET voided_at = ?, voided_by = ?, void_reason = ? WHERE tenant_id = ? AND id = ?', [nowIn(tz), req.auth.userId, req.body.reason, req.auth.tenantId, mid]);
    await audit(conn, req, 'void_photo', 'incidents', id, { photo_id: mid, reason: req.body.reason });
  });
  res.json({ ok: true });
});

router.listFor = listFor;
module.exports = router;
