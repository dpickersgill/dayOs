'use strict';

// Photos on an asset or a map item (muni release 1): an outfall's dry-weather screening, a broken valve box, a hydrant
// hit by a car. Each file is kept exactly as taken, with its SHA-256 recorded at upload, the way patrol photos are
// (routes/patrolmedia.js); the original downloads with its fingerprint, and Verify recomputes it from the stored bytes.
// When and where it was taken come from the photo itself (EXIF), else from the phone. These photos are for the crew and
// managers, never shown on a public page. A photo taken for an inspection item is tied to that inspection when it is saved.
//
// Mounted at /assets/photos inside the assets router (staff and managers); uploads go to /assets/register/:id/photos and
// /assets/map/features/:id/photos.
const crypto = require('crypto');
const express = require('express');
const { pool, rows, one } = require('../db');
const { z, paramId, nowIn, dateTimeStr } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { photoFacts, sniff } = require('../lib/exif');

const router = express.Router();
const MAX_BYTES = 15 * 1024 * 1024; // a phone photo at full size is 2 to 8 MB
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const raw = express.raw({ type: () => true, limit: MAX_BYTES });
const META = 'id, asset_id, map_feature_id, inspection_id, mime, file_name, bytes, sha256, caption, taken_at, taken_lat, taken_lng, uploaded_by, uploaded_at';
const shape = (p) => ({ ...p, taken_lat: p.taken_lat === null ? null : Number(p.taken_lat), taken_lng: p.taken_lng === null ? null : Number(p.taken_lng) });

/** The photos of one asset or map item, newest first, without their bytes. target: { type: 'asset'|'feature', id }. */
async function listFor(conn, tenantId, target) {
  const col = target.type === 'asset' ? 'asset_id' : 'map_feature_id';
  return (await rows(conn, `SELECT ${META} FROM asset_photos WHERE tenant_id = ? AND ${col} = ? ORDER BY id DESC LIMIT 60`, [tenantId, target.id])).map(shape);
}

/**
 * Adds a photo: the body is the file itself, untouched. Query: caption, client_ref (so a repeated upload is kept once),
 * file_name, and the phone's own lat, lng and taken_at for a photo whose file carries none.
 */
async function upload(req, res, target) {
  const t = req.auth.tenantId;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose a photo');
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  const q = z.object({
    caption: z.string().trim().max(255).optional(),
    client_ref: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional(),
    file_name: z.string().trim().max(200).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(),
    taken_at: dateTimeStr.optional(),
  }).safeParse(req.query);
  if (!q.success) throw bad('Something about that photo upload was not right');
  const b = q.data;
  const table = target.type === 'asset' ? 'ops_assets' : 'map_features';
  if (!(await one(pool, `SELECT id FROM ${table} WHERE tenant_id = ? AND id = ?`, [t, target.id]))) throw notFound(target.type === 'asset' ? 'Asset' : 'Map item');
  if (b.client_ref) {
    const seen = await one(pool, 'SELECT id, sha256 FROM asset_photos WHERE tenant_id = ? AND client_ref = ?', [t, b.client_ref]);
    if (seen) { res.json({ id: seen.id, sha256: seen.sha256, repeat: true }); return; }
  }
  const facts = photoFacts(buf);
  const now = nowIn((await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone);
  const phoneAt = b.taken_at ? b.taken_at.replace('T', ' ').slice(0, 19).padEnd(19, ':00').slice(0, 19) : null;
  const hash = sha(buf);
  const [r] = await pool.query(`INSERT INTO asset_photos (tenant_id, asset_id, map_feature_id, mime, file_name, bytes, sha256, original, caption, taken_at, taken_lat, taken_lng, client_ref, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [t, target.type === 'asset' ? target.id : null, target.type === 'feature' ? target.id : null, mime, b.file_name || null, buf.length, hash, buf, b.caption || null,
    facts.taken_at || phoneAt, facts.lat ?? b.lat ?? null, facts.lng ?? b.lng ?? null, b.client_ref || null, req.auth.userId, now]);
  await audit(pool, req, 'add_photo', table, target.id, { photo_id: r.insertId, sha256: hash, bytes: buf.length });
  res.status(201).json({ id: r.insertId, sha256: hash, bytes: buf.length, taken_at: facts.taken_at || phoneAt });
}

/** The original, byte for byte, with its recorded fingerprint. */
router.get('/:id', async (req, res) => {
  const id = paramId(req);
  const r = await one(pool, 'SELECT original, mime, sha256 FROM asset_photos WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!r) throw notFound('Photo');
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[r.mime] || 'bin';
  res.set({ 'Content-Type': r.mime, 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="photo-${id}.${ext}"`, 'X-Content-SHA256': r.sha256, 'Cache-Control': 'private, no-store' }).send(r.original);
});

/** Recomputes the fingerprint from the stored bytes and compares it with the one recorded at upload. */
router.get('/:id/verify', async (req, res) => {
  const r = await one(pool, 'SELECT original, sha256, uploaded_at FROM asset_photos WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r) throw notFound('Photo');
  const now = sha(r.original);
  res.json({ unchanged: now === r.sha256, recorded: r.sha256, computed: now, uploaded_at: r.uploaded_at });
});

router.listFor = listFor;
router.upload = upload;
router.raw = raw;
module.exports = router;
