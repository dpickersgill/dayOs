'use strict';

// A patrol case linked to a terrain park feature (mounted under /patrol). When the case's location is freestyle terrain,
// patrol picks the feature from that day's placed list instead of typing it from memory. The case keeps a snapshot of the
// feature as it was (name, type, size, dimensions, area and its rating, status, and the last inspection before the
// incident with its time and inspector), so later changes in the park app never change what the case says. The typed
// "Park feature name, number and size" stays as a fallback.
//
// "Close for post-incident inspection" closes the feature, tells the park supervisor (Inbox and phone), and the feature
// reopens only through an inspection of type post-incident. Linking follows the case's own rules (not on an approved
// report or one on legal hold); closing the feature works on any case, because the feature is not part of the report.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, utcFromLocal } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const OPS = require('../lib/parkops');
const { parseForm, mergeForm, isEmpty } = require('../lib/nsaar');
const cases = require('./patrol');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (f, m) => PA.needs(pool, f, m);
const reasonField = z.string().trim().min(3, 'Say why, in a few words').max(255);
const js = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** The features placed on a day (the case's day), for the picker. Only what is on the park map: no inspection notes. */
router.get('/park/placed', patrol, needs('view_cases'), async (req, res) => {
  const t = req.auth.tenantId;
  const date = req.query.date && dateStr.safeParse(String(req.query.date)).success ? String(req.query.date) : (await OPS.phoneTime(pool, t)).today;
  const list = await rows(pool, `SELECT f.id, f.name, f.kind, f.size, f.dimensions, f.status, a.name AS area, a.level AS area_level, p.lat, p.lng
    FROM park_placements p JOIN park_features f ON f.tenant_id = p.tenant_id AND f.id = p.feature_id LEFT JOIN park_areas a ON a.tenant_id = p.tenant_id AND a.id = p.area_id
    WHERE p.tenant_id = ? AND p.on_date = ? AND p.voided_at IS NULL ORDER BY a.name, f.name`, [t, date]);
  res.json({ date, data: list.map((f) => ({ ...f, lat: Number(f.lat), lng: Number(f.lng), kind_label: OPS.kindLabel(f.kind), size_label: OPS.sizeLabel(f.size), status_label: OPS.statusLabel(f.status), area_level_label: f.area_level ? OPS.levelLabel(f.area_level) : null })) });
});

const linkRows = (t, id) => rows(pool, `SELECT l.id, l.feature_id, l.on_date, l.snapshot, l.linked_at, l.closed_at, l.voided_at, l.void_reason, COALESCE(u.email, u.username) AS linked_by
  FROM incident_park_links l LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.linked_by WHERE l.tenant_id = ? AND l.incident_id = ? ORDER BY l.id`, [t, id]);

router.get('/incidents/:id/park-links', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  if (!(await one(pool, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Incident');
  res.json({ data: (await linkRows(t, id)).map((l) => ({ ...l, snapshot: js(l.snapshot) })) });
});

/** Link a placed feature to the case, keeping a snapshot of it. Fills the typed park feature field if it is still empty. */
router.post('/incidents/:id/park-links', patrol, needs('create_case'), validate(z.object({ feature_id: z.number().int().positive() })), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const inc = await cases.editableCase(conn, req, id);
    const day = String(inc.occurred_at).slice(0, 10);
    const tz = await OPS.tzOf(conn, t);
    if (!(await one(conn, 'SELECT id FROM park_features WHERE tenant_id = ? AND id = ?', [t, req.body.feature_id]))) throw notFound('Park feature');
    if (await one(conn, 'SELECT id FROM incident_park_links WHERE tenant_id = ? AND incident_id = ? AND feature_id = ? AND voided_at IS NULL', [t, id, req.body.feature_id])) throw conflict('That feature is already linked to this case');
    const snap = await OPS.snapshot(conn, t, req.body.feature_id, day, utcFromLocal(String(inc.occurred_at).replace('T', ' ').slice(0, 19), tz));
    if (!snap.placed) throw bad('That feature was not on the park map that day. Type the feature instead.');
    const [r] = await conn.query('INSERT INTO incident_park_links (tenant_id, incident_id, feature_id, on_date, snapshot, linked_by) VALUES (?, ?, ?, ?, ?, ?)', [t, id, req.body.feature_id, day, JSON.stringify(snap), req.auth.userId]);
    const form = parseForm(inc.form);
    if (isEmpty(form.park_feature)) {
      const words = [snap.name, snap.kind_label, `size ${snap.size_label}`, snap.dimensions, snap.area ? `in ${snap.area}` : null].filter(Boolean).join(', ');
      await conn.query('UPDATE incidents SET form = ? WHERE tenant_id = ? AND id = ?', [mergeForm(inc.form, { park_feature: words.slice(0, 300) }), t, id]);
    }
    await audit(conn, req, 'link_park_feature', 'incidents', id, { link: r.insertId, feature_id: req.body.feature_id });
    return { id: r.insertId, snapshot: snap };
  });
  res.status(201).json(out);
});

/** A wrong link is never deleted: it is marked entered in error with the reason, like the rest of the case. */
router.post('/incidents/:id/park-links/:lid/void', patrol, needs('create_case'), validate(z.object({ reason: reasonField })), async (req, res) => {
  const id = paramId(req); const lid = paramId(req, 'lid'); const t = req.auth.tenantId;
  await tx(async (conn) => {
    await cases.editableCase(conn, req, id);
    const l = await one(conn, 'SELECT id, voided_at FROM incident_park_links WHERE tenant_id = ? AND incident_id = ? AND id = ? FOR UPDATE', [t, id, lid]);
    if (!l) throw notFound('Link');
    if (l.voided_at) throw conflict('Already marked entered in error');
    await conn.query('UPDATE incident_park_links SET voided_at = UTC_TIMESTAMP(), voided_by = ?, void_reason = ? WHERE tenant_id = ? AND id = ?', [req.auth.userId, req.body.reason, t, lid]);
    await audit(conn, req, 'void_park_link', 'incidents', id, { link: lid });
  });
  res.json({ ok: true });
});

/** Close the linked feature for a post-incident inspection, and tell the park supervisor. */
router.post('/incidents/:id/park-links/:lid/close', patrol, needs('create_case'), async (req, res) => {
  const id = paramId(req); const lid = paramId(req, 'lid'); const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const inc = await one(conn, 'SELECT id, season, seq FROM incidents WHERE tenant_id = ? AND id = ?', [t, id]);
    if (!inc) throw notFound('Incident');
    const l = await one(conn, 'SELECT id, feature_id, voided_at FROM incident_park_links WHERE tenant_id = ? AND incident_id = ? AND id = ? FOR UPDATE', [t, id, lid]);
    if (!l || l.voided_at) throw notFound('Link');
    const caseNumber = inc.seq ? `${inc.season}-${String(inc.seq).padStart(4, '0')}` : `Case ${inc.id}`;
    const f = await OPS.closeForIncident(conn, req, l.feature_id, { incidentId: id, reason: `Closed by patrol after case ${caseNumber}` });
    await conn.query('UPDATE incident_park_links SET closed_at = COALESCE(closed_at, UTC_TIMESTAMP()) WHERE tenant_id = ? AND id = ?', [t, lid]);
    await audit(conn, req, 'close_park_feature', 'incidents', id, { link: lid, feature_id: Number(l.feature_id) });
    return { name: f.name, caseNumber, featureId: Number(l.feature_id) };
  });
  await OPS.tellSupervisors(pool, req, `${out.name} was closed by patrol after case ${out.caseNumber}, for a post-incident inspection. It reopens only after a post-incident inspection passes.`, { tag: `park-${out.featureId}` });
  res.json({ ok: true, status: 'closed' });
});

module.exports = router;
