'use strict';

// Patrol, part two: the collision report, checklists, the patrol home screen, and the follow-up email desk.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, partialOf, setClause, todayIn, addDays } = require('../lib/util');
const { notFound, bad, forbidden, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { LISTS, valid } = require('../lib/checklists');
const followups = require('../lib/followups');
const mailer = require('../lib/mailer');
const patrolRouter = require('./patrol');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const PA = require('../lib/patrolaccess');
const stripe = require('../lib/stripe');
const { baseUrl } = require('../lib/baseurl');
const needs = (feature, message) => PA.needs(pool, feature, message);
const editable = (conn, req, id) => patrolRouter.editableCase(conn, req, id);
const admin = async (req) => { if (!(await PA.can(pool, req, 'followups'))) throw forbidden('Your patrol access level cannot manage follow-up emails'); };
const bool = z.boolean().transform((v) => (v ? 1 : 0));
const txt = (n) => z.string().max(n).nullable().optional();

// ---------------------------------------------------------------- collision report
const collisionSchema = z.object({
  collision_type: z.enum(['skier_skier', 'skier_object', 'skier_lift_structure', 'skier_vehicle', 'skier_animal', 'other']).default('skier_skier'),
  hit_and_run: bool.optional(), unknown_party_description: txt(1000), right_of_way: txt(1000),
  factors: z.array(z.string().max(60)).max(20).transform((a) => a.join(',')).optional(),
  police_notified: bool.optional(), police_agency: txt(150), police_report_no: txt(60), risk_notified: bool.optional(),
  equipment_held: txt(500), property_damage: txt(1000), findings: z.string().max(20000).nullable().optional(), legal_hold: bool.optional(),
});
const collisionCols = Object.keys(collisionSchema.shape);

router.put('/incidents/:id/collision', patrol, needs('create_case'), validate(collisionSchema), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await editable(conn, req, id);
    const keys = Object.keys(req.body).filter((k) => collisionCols.includes(k));
    await conn.query(
      `INSERT INTO incident_collisions (tenant_id, incident_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${keys.map((k) => `\`${k}\` = VALUES(\`${k}\`)`).join(', ')}`,
      [req.auth.tenantId, id, ...keys.map((k) => req.body[k])],
    );
    await audit(conn, req, 'save_collision', 'incidents', id, { fields: keys });
  });
  res.json({ ok: true });
});

const partyFields = {
  role: z.enum(['skier', 'snowboarder', 'other_snow', 'pedestrian', 'employee', 'vehicle', 'unknown']).default('skier'),
  first_name: txt(100), last_name: txt(100), age_years: z.number().int().min(0).max(120).nullable().optional(),
  phone: txt(40), email: z.string().email().max(255).nullable().optional(), address: txt(255),
  helmet: z.enum(['yes', 'no', 'unknown']).optional(), equipment: txt(255), direction: txt(255),
  position: z.enum(['uphill', 'downhill', 'side_by_side', 'crossing', 'stopped', 'unknown']).optional(),
  speed: z.enum(['stopped', 'slow', 'moderate', 'fast', 'unknown']).optional(),
  statement: z.string().max(10000).nullable().optional(), left_scene: bool.optional(), refused_contact_info: bool.optional(),
  patient_id: z.number().int().positive().nullable().optional(),
};
const partyCols = Object.keys(partyFields);

async function checkPatient(conn, req, id, patientId) {
  if (patientId && !(await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, patientId]))) throw notFound('Patient');
}

router.post('/incidents/:id/parties', patrol, needs('create_case'), validate(z.object(partyFields)), async (req, res) => {
  const id = paramId(req);
  const newId = await tx(async (conn) => {
    await editable(conn, req, id);
    await checkPatient(conn, req, id, req.body.patient_id);
    const keys = Object.keys(req.body).filter((k) => partyCols.includes(k));
    const [r] = await conn.query(`INSERT INTO incident_parties (tenant_id, incident_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`, [req.auth.tenantId, id, ...keys.map((k) => req.body[k])]);
    await audit(conn, req, 'add_party', 'incidents', id, { row: r.insertId });
    return r.insertId;
  });
  res.status(201).json({ id: newId });
});

router.patch('/incidents/:id/parties/:rowId', patrol, needs('create_case'), validate(partialOf(partyFields)), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await editable(conn, req, id);
    await checkPatient(conn, req, id, req.body.patient_id);
    const set = setClause(req.body, partyCols);
    if (!set) throw bad('No updatable fields supplied');
    const [r] = await conn.query(`UPDATE incident_parties SET ${set.sql} WHERE tenant_id = ? AND incident_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id, paramId(req, 'rowId')]);
    if (!r.affectedRows) throw notFound('Party');
    await audit(conn, req, 'update_party', 'incidents', id, { row: paramId(req, 'rowId'), fields: Object.keys(req.body) });
  });
  res.json({ ok: true });
});

router.delete('/incidents/:id/parties/:rowId', patrol, needs('create_case'), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await editable(conn, req, id);
    const [r] = await conn.query('DELETE FROM incident_parties WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, paramId(req, 'rowId')]);
    if (!r.affectedRows) throw notFound('Party');
    await audit(conn, req, 'remove_party', 'incidents', id, { row: paramId(req, 'rowId') });
  });
  res.status(204).end();
});

/** The printed collision report goes to insurers and other parties, so printing it is logged. */
router.post('/incidents/:id/collision-printed', patrol, needs('create_case'), async (req, res) => {
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Incident');
  await audit(pool, req, 'collision_print', 'incidents', id);
  res.status(204).end();
});

// ---------------------------------------------------------------- checklists
router.get('/checklists', patrol, needs('view_cases'), (_req, res) => res.json({ data: LISTS.map((l) => ({ id: l.id, scope: l.scope, title: l.title, when: l.when, items: l.items.map(([key, label]) => ({ key, label })) })) }));

router.post('/incidents/:id/checklist', patrol, needs('create_case'), validate(z.object({ key: z.string().max(60), patient_id: z.number().int().positive().optional(), done: z.boolean() })), async (req, res) => {
  const id = paramId(req);
  const { key, done } = req.body;
  if (!valid(key)) throw bad('Unknown checklist item');
  await tx(async (conn) => {
    await editable(conn, req, id);
    await checkPatient(conn, req, id, req.body.patient_id);
    const pid = req.body.patient_id || 0;
    if (done) await conn.query('INSERT IGNORE INTO incident_checklist (tenant_id, incident_id, patient_id, item_key, done_by) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, id, pid, key, req.auth.userId]);
    else await conn.query('DELETE FROM incident_checklist WHERE tenant_id = ? AND incident_id = ? AND patient_id = ? AND item_key = ?', [req.auth.tenantId, id, pid, key]);
    await audit(conn, req, done ? 'check' : 'uncheck', 'incidents', id, { key, patient_id: pid || null });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the patrol home screen
router.get('/home', patrol, async (req, res) => {
  const { tenantId, staffId } = req.auth;
  const access = await PA.accessOf(pool, req);
  const canApprove = access.features.has('approve_case');
  const canView = access.features.has('view_cases');
  const cols = `i.id, i.season, i.seq, i.occurred_at, i.location, i.category, i.severity, i.summary, i.report_state, (SELECT COUNT(*) FROM incident_patients p WHERE p.tenant_id = i.tenant_id AND p.incident_id = i.id AND p.voided_at IS NULL) AS patient_count`;
  const num = (r) => ({ ...r, case_number: r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : null });
  const mine = staffId && canView
    ? await rows(pool, `SELECT ${cols} FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'draft' AND EXISTS (SELECT 1 FROM incident_responders r WHERE r.tenant_id = i.tenant_id AND r.incident_id = i.id AND r.staff_id = ?) ORDER BY i.occurred_at DESC LIMIT 20`, [tenantId, staffId])
    : [];
  const recent = canView ? await rows(pool, `SELECT ${cols} FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'draft' ORDER BY i.occurred_at DESC LIMIT 10`, [tenantId]) : [];
  const waiting = canApprove && canView ? await rows(pool, `SELECT ${cols} FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'submitted' ORDER BY i.submitted_at LIMIT 30`, [tenantId]) : [];
  const [held] = canApprove ? await rows(pool, "SELECT COUNT(*) AS n FROM followups WHERE tenant_id = ? AND status = 'held'", [tenantId]) : [{ n: 0 }];
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const [stale] = !canView ? [{ n: 0 }] : await rows(pool, "SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND report_state = 'draft' AND occurred_at < ? AND category IN ('injury','medical','collision')", [tenantId, `${addDays(today, -1)} 00:00:00`]);
  res.json({ mine: mine.map(num), recent: recent.map(num), waiting: waiting.map(num), followups_held: held.n, stale_drafts: stale.n, can_approve: canApprove, can_view_cases: canView });
});

// ---------------------------------------------------------------- follow-up desk (directors and managers)
const settingsSchema = z.object({
  followup_enabled: bool.optional(), followup_days: z.number().int().min(1).max(30).optional(),
  patrol_org_name: txt(150), mail_address: txt(300), reply_to: z.string().email().max(255).nullable().optional(),
  donate_amounts: z.string().max(60).regex(/^\d{1,4}(,\s*\d{1,4}){0,5}$/, 'Use whole dollar amounts separated by commas, for example 25,50,100,250').optional(),
  donate_blurb: txt(600), tax_note: txt(500),
});
const settingCols = ['followup_enabled', 'followup_days', 'patrol_org_name', 'mail_address', 'reply_to', 'donate_amounts', 'donate_blurb', 'tax_note'];

router.get('/followup-settings', patrol, needs('followups'), async (req, res) => {
  await admin(req);
  const t = await one(pool, `SELECT name, slug, ${settingCols.join(', ')}, (SELECT COUNT(*) FROM donations d WHERE d.tenant_id = tenants.id) AS donation_count FROM tenants WHERE id = ?`, [req.auth.tenantId]);
  res.json({ ...t, followup_enabled: Boolean(t.followup_enabled), email_ready: mailer.enabled(), card_ready: Boolean(stripe.enabled()) });
});

router.put('/followup-settings', patrol, needs('followups'), validate(settingsSchema), async (req, res) => {
  await admin(req);
  const set = setClause(req.body, settingCols);
  if (!set) throw bad('Nothing to save');
  await pool.query(`UPDATE tenants SET ${set.sql} WHERE id = ?`, [...set.values, req.auth.tenantId]);
  await audit(pool, req, 'followup_settings', 'tenants', req.auth.tenantId, { fields: Object.keys(req.body) });
  res.json({ ok: true });
});

router.get('/followups', patrol, needs('followups'), async (req, res) => {
  await admin(req);
  const status = ['held', 'queued', 'sent', 'skipped', 'failed', 'unsubscribed'].includes(req.query.status) ? req.query.status : null;
  const data = await rows(pool, `SELECT f.id, f.incident_id, f.status, f.hold_reason, f.due_on, f.sent_at, f.error, f.for_guardian, f.to_email, f.rating, f.comment, f.responded_at,
      i.season, i.seq, i.severity, i.occurred_at, p.first_name
    FROM followups f JOIN incidents i ON i.tenant_id = f.tenant_id AND i.id = f.incident_id JOIN incident_patients p ON p.tenant_id = f.tenant_id AND p.id = f.patient_id
    WHERE f.tenant_id = ? ${status ? 'AND f.status = ?' : ''} ORDER BY FIELD(f.status, 'held', 'failed', 'queued', 'sent', 'skipped', 'unsubscribed'), f.due_on DESC, f.id DESC LIMIT 300`, status ? [req.auth.tenantId, status] : [req.auth.tenantId]);
  await audit(pool, req, 'view_followups', 'audit_log', null, { rows: data.length });
  res.json({ data: data.map((r) => ({ ...r, case_number: r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : null })) });
});

router.get('/followup-summary', patrol, needs('followups'), async (req, res) => {
  await admin(req);
  const t = req.auth.tenantId;
  const by = await rows(pool, 'SELECT status, COUNT(*) AS n FROM followups WHERE tenant_id = ? GROUP BY status', [t]);
  const [fb] = await rows(pool, 'SELECT COUNT(rating) AS rated, ROUND(AVG(rating), 1) AS avg_rating FROM followups WHERE tenant_id = ?', [t]);
  const [don] = await rows(pool, 'SELECT COUNT(*) AS gifts, COALESCE(SUM(amount_cents), 0) AS cents, SUM(monthly) AS monthly FROM donations WHERE tenant_id = ?', [t]);
  const comments = await rows(pool, "SELECT rating, comment, responded_at FROM followups WHERE tenant_id = ? AND comment IS NOT NULL AND comment <> '' ORDER BY responded_at DESC LIMIT 10", [t]);
  const gifts = await rows(pool, 'SELECT amount_cents, monthly, name, created_at, followup_id IS NOT NULL AS from_email FROM donations WHERE tenant_id = ? ORDER BY id DESC LIMIT 15', [t]);
  res.json({ by_status: Object.fromEntries(by.map((x) => [x.status, x.n])), rated: fb.rated, avg_rating: fb.avg_rating, gifts: don.gifts, total_cents: Number(don.cents), monthly_gifts: Number(don.monthly || 0), comments, recent_gifts: gifts });
});

async function loadFollowup(req) {
  await admin(req);
  const f = await one(pool, 'SELECT * FROM followups WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!f) throw notFound('Follow-up');
  return f;
}
router.post('/followups/:id/approve', patrol, needs('followups'), async (req, res) => {
  const f = await loadFollowup(req);
  if (f.status !== 'held') throw bad('Only a held follow-up can be approved');
  await pool.query("UPDATE followups SET status = 'queued', hold_reason = NULL WHERE id = ?", [f.id]);
  await audit(pool, req, 'followup_approve', 'incidents', f.incident_id, { followup_id: f.id });
  res.json({ ok: true });
});
router.post('/followups/:id/skip', patrol, needs('followups'), async (req, res) => {
  const f = await loadFollowup(req);
  if (!['held', 'queued', 'failed'].includes(f.status)) throw bad('That follow-up has already gone out or been closed');
  await pool.query("UPDATE followups SET status = 'skipped' WHERE id = ?", [f.id]);
  await audit(pool, req, 'followup_skip', 'incidents', f.incident_id, { followup_id: f.id });
  res.json({ ok: true });
});
router.post('/followups/:id/send', patrol, needs('followups'), async (req, res) => {
  const f = await loadFollowup(req);
  if (!['held', 'queued', 'failed'].includes(f.status)) throw bad('That follow-up has already gone out or been closed');
  if (!mailer.enabled()) throw bad('Email is not set up yet. Add the Postmark token and sender address first.');
  const tenant = await one(pool, 'SELECT * FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const status = await followups.sendOne(f, tenant, baseUrl(req));
  if (status === 'busy') throw conflict('That follow-up is already being sent');
  await audit(pool, req, 'followup_send', 'incidents', f.incident_id, { followup_id: f.id, status });
  res.json({ status });
});

module.exports = router;
