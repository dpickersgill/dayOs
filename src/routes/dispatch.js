'use strict';

// Ski patrol dispatch: a call board with a timestamped timeline, responders, and the guest Help page.
//
// Calls come from patrollers (radio, phone) or from guests who scan a trail-sign QR code. A guest call is
// only a request: it lands on the board as "new" and a dispatcher decides what to do. The guest page is
// off for every mountain until a manager turns it on, and it tells guests to call 911 for emergencies.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId, nowIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const patrolCases = require('./patrol');
const OPS = require('../lib/patrolops');
const PUSH = require('../lib/push');
const SMS = require('../lib/sms');

const router = express.Router();
const publicRouter = express.Router();
const patrol = requireRole('patrol', 'manager');
const PA = require('../lib/patrolaccess');
const needs = (feature, message) => PA.needs(pool, feature, message);

const ACTIVE = ['new', 'dispatched', 'on_scene', 'transporting'];
// Timeline event -> the call status it sets. Notes and "at aid room" leave the status alone.
const STATUS_FOR = { dispatched: 'dispatched', on_scene: 'on_scene', transporting: 'transporting', closed: 'closed', cancelled: 'cancelled' };
const callNo = (c) => `${String(c.call_date).slice(5).replace('-', '')}-${String(c.seq).padStart(2, '0')}`; // 1215-03

/** Creates the call and its first timeline entry. Call numbers restart each day; a collision retries. */
async function createCall(tenant, b, { source, userId = null, staffId = null }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tx(async (conn) => {
        const now = nowIn(tenant.timezone);
        const date = now.slice(0, 10);
        const { n } = await one(conn, 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM dispatch_calls WHERE tenant_id = ? AND call_date = ?', [tenant.id, date]);
        const [r] = await conn.query(
          `INSERT INTO dispatch_calls (tenant_id, call_date, seq, source, priority, location, description, caller_name, caller_phone, gps_lat, gps_lng, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [tenant.id, date, n, source, b.priority ?? 'normal', b.location, b.description ?? null, b.caller_name ?? null, b.caller_phone ?? null, b.gps_lat ?? null, b.gps_lng ?? null, now],
        );
        await conn.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, 'received', ?, ?, ?)", [tenant.id, r.insertId, now, staffId, source === 'guest' ? 'Guest help request' : null, userId]);
        return { id: r.insertId, call_no: callNo({ call_date: date, seq: n }) };
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
}

const withNo = (c) => ({ ...c, call_no: callNo(c) });

// ---------------------------------------------------------------- the board
router.get('/dispatch', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const where = ['c.tenant_id = ?'];
  const params = [tenantId];
  if (req.query.status === 'active' || !req.query.status) { where.push(`c.status IN (${ACTIVE.map(() => '?').join(',')})`); params.push(...ACTIVE); }
  else if (req.query.status !== 'all') { where.push('c.status = ?'); params.push(String(req.query.status)); }
  if (req.query.date) {
    if (!dateStr.safeParse(String(req.query.date)).success) throw bad('date must be YYYY-MM-DD');
    where.push('c.call_date = ?'); params.push(String(req.query.date));
  }
  const calls = await rows(pool, `SELECT c.* FROM dispatch_calls c WHERE ${where.join(' AND ')} ORDER BY FIELD(c.priority,'critical','high','normal','low'), c.received_at DESC LIMIT 200`, params);
  const ids = calls.map((c) => c.id);
  const responders = ids.length
    ? await rows(pool, `SELECT r.call_id, r.staff_id, p.first_name, p.last_name, m.callsign FROM dispatch_responders r
                        JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                        LEFT JOIN patrol_members m ON m.staff_id = r.staff_id AND m.tenant_id = r.tenant_id
                        WHERE r.tenant_id = ? AND r.call_id IN (?)`, [tenantId, ids])
    : [];
  res.json({ data: calls.map((c) => ({ ...withNo(c), responders: responders.filter((r) => r.call_id === c.id) })) });
});

/**
 * Patrollers on duty right now: signed in on Patrol (volunteers and paid alike), or clocked in on the time clock for a
 * patrol shift. Each says whether they are already out on a call.
 */
router.get('/dispatch/available', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const duty = await OPS.onDuty(pool, tenantId);
  const clocked = await rows(pool, `SELECT DISTINCT s.id AS staff_id, p.first_name, p.last_name, m.callsign, te.clock_in
     FROM time_entries te JOIN staff s ON s.id = te.staff_id AND s.tenant_id = te.tenant_id AND s.status = 'active'
     JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
     LEFT JOIN patrol_members m ON m.staff_id = s.id AND m.tenant_id = s.tenant_id
     LEFT JOIN shifts sh ON sh.id = te.shift_id AND sh.tenant_id = te.tenant_id
     LEFT JOIN positions pos ON pos.id = sh.position_id AND pos.tenant_id = sh.tenant_id
     WHERE te.tenant_id = ? AND te.clock_out IS NULL AND (m.id IS NOT NULL OR pos.department = 'patrol')`, [tenantId]);
  const byId = new Map();
  for (const d of duty) byId.set(Number(d.staff_id), { staff_id: Number(d.staff_id), first_name: d.first_name, last_name: d.last_name, callsign: d.callsign, radio: d.radio, station: d.station, since: d.signed_in_at, via: 'signed_in' });
  for (const c of clocked) if (!byId.has(Number(c.staff_id))) byId.set(Number(c.staff_id), { staff_id: Number(c.staff_id), first_name: c.first_name, last_name: c.last_name, callsign: c.callsign, since: c.clock_in, via: 'time_clock' });
  const ids = [...byId.keys()];
  const busy = ids.length ? await rows(pool, `SELECT r.staff_id, c.id FROM dispatch_responders r JOIN dispatch_calls c ON c.id = r.call_id AND c.tenant_id = r.tenant_id
     WHERE r.tenant_id = ? AND r.staff_id IN (?) AND c.status IN ('dispatched','on_scene','transporting')`, [tenantId, ids]) : [];
  const onCall = new Map(busy.map((b) => [Number(b.staff_id), b.id]));
  const data = [...byId.values()].map((a) => ({ ...a, on_call_id: onCall.get(a.staff_id) || null, state: onCall.has(a.staff_id) ? 'on_call' : 'available' }))
    .sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`));
  res.json({ data });
});

/** Alert the people sent to a call on their phones, and text them too on a critical call when the mountain allows it. */
async function alertResponders(tenantId, call, staffIds, { text = false } = {}) {
  const msg = { title: `${call.priority === 'critical' ? 'CRITICAL: ' : ''}Patrol call ${callNo(call)}`, body: `${call.location}${call.description ? `. ${call.description}` : ''}`, url: '#/patrol/dispatch', tag: `call-${call.id}` };
  await PUSH.notifyStaff(tenantId, staffIds, msg);
  await pool.query('UPDATE dispatch_responders SET notified_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND call_id = ? AND staff_id IN (?)', [tenantId, call.id, staffIds]);
  if (!text) return 0;
  let texted = 0;
  if (!(SMS.enabled())) return 0;
  const phones = await rows(pool, 'SELECT s.id, p.phone FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id IN (?) AND p.phone IS NOT NULL', [tenantId, staffIds]);
  for (const ph of phones) {
    const r = await SMS.send({ tenantId, to: ph.phone, body: `${msg.title}: ${msg.body}`.slice(0, 300) });
    if (!r.ok) continue;
    await pool.query('UPDATE dispatch_responders SET texted_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND call_id = ? AND staff_id = ?', [tenantId, call.id, ph.id]);
    texted += 1;
  }
  return texted;
}

const callFields = z.object({
  location: z.string().min(1).max(255),
  description: z.string().max(500).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  source: z.enum(['patrol', 'radio', 'phone']).default('radio'),
  caller_name: z.string().max(100).nullable().optional(),
  caller_phone: z.string().max(40).nullable().optional(),
  gps_lat: z.number().min(-90).max(90).nullable().optional(),
  gps_lng: z.number().min(-180).max(180).nullable().optional(),
});

router.post('/dispatch', patrol, needs('dispatch'), validate(callFields), async (req, res) => {
  const tenant = await one(pool, 'SELECT id, timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const out = await createCall(tenant, req.body, { source: req.body.source, userId: req.auth.userId, staffId: req.auth.staffId });
  await audit(pool, req, 'create', 'dispatch_calls', out.id, { source: req.body.source, priority: req.body.priority });
  // A critical call goes to everyone on duty at once, so the nearest can answer on the radio.
  if (req.body.priority === 'critical') {
    const call = await loadCall(pool, tenant.id, out.id);
    out.alerted = await PUSH.notifyStaff(tenant.id, await OPS.onDutyIds(pool, tenant.id), { title: `CRITICAL: Patrol call ${callNo(call)}`, body: `${call.location}${call.description ? `. ${call.description}` : ''}`, url: '#/patrol/dispatch', tag: `call-${call.id}` });
  }
  res.status(201).json(out);
});

async function loadCall(conn, tenantId, id, lock = false) {
  const c = await one(conn, `SELECT * FROM dispatch_calls WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!c) throw notFound('Call');
  return c;
}

router.get('/dispatch/:id', patrol, needs('dispatch'), async (req, res) => {
  const id = paramId(req);
  const c = await loadCall(pool, req.auth.tenantId, id);
  const [events, responders, incident] = await Promise.all([
    rows(pool, `SELECT e.id, e.at, e.kind, e.note, e.staff_id, p.first_name, p.last_name FROM dispatch_events e
                LEFT JOIN staff s ON s.id = e.staff_id AND s.tenant_id = e.tenant_id LEFT JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                WHERE e.tenant_id = ? AND e.call_id = ? ORDER BY e.at, e.id`, [req.auth.tenantId, id]),
    rows(pool, `SELECT r.staff_id, r.notified_at, r.acked_at, r.texted_at, p.first_name, p.last_name, m.callsign FROM dispatch_responders r JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id
                JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id LEFT JOIN patrol_members m ON m.staff_id = r.staff_id AND m.tenant_id = r.tenant_id
                WHERE r.tenant_id = ? AND r.call_id = ?`, [req.auth.tenantId, id]),
    c.incident_id ? one(pool, 'SELECT id, season, seq FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, c.incident_id]) : null,
  ]);
  res.json({ ...withNo(c), events, responders, case: incident ? { id: incident.id, case_number: `${incident.season}-${String(incident.seq).padStart(4, '0')}` } : null });
});

router.patch('/dispatch/:id', patrol, needs('dispatch'), validate(z.object({ priority: z.enum(['low', 'normal', 'high', 'critical']).optional(), location: z.string().min(1).max(255).optional(), description: z.string().max(500).nullable().optional() })), async (req, res) => {
  const c = await loadCall(pool, req.auth.tenantId, paramId(req));
  if (!ACTIVE.includes(c.status)) throw conflict('This call is closed');
  const keys = Object.keys(req.body);
  if (!keys.length) throw bad('No updatable fields supplied');
  await pool.query(`UPDATE dispatch_calls SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => req.body[k]), req.auth.tenantId, c.id]);
  await audit(pool, req, 'update', 'dispatch_calls', c.id, req.body);
  res.json({ ok: true });
});

/** Adds a timeline entry. Moving the call along (on scene, transporting, closed) also sets its status. */
router.post(
  '/dispatch/:id/events',
  patrol, needs('dispatch'),
  validate(z.object({ kind: z.enum(['dispatched', 'on_scene', 'transporting', 'at_aid_room', 'note', 'closed', 'cancelled']), note: z.string().max(500).nullable().optional(), staff_id: z.number().int().positive().nullable().optional() })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const b = req.body;
    if (b.kind === 'note' && !b.note) throw bad('A note needs some text');
    const out = await tx(async (conn) => {
      const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
      const c = await loadCall(conn, tenantId, paramId(req), true);
      if (!ACTIVE.includes(c.status)) throw conflict('This call is already closed');
      if (b.staff_id && !(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [tenantId, b.staff_id]))) throw notFound('Staff member');
      const now = nowIn(tenant.timezone);
      await conn.query('INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, c.id, now, b.kind, b.staff_id ?? null, b.note ?? null, req.auth.userId]);
      const next = STATUS_FOR[b.kind];
      if (next) await conn.query('UPDATE dispatch_calls SET status = ?, closed_at = ? WHERE tenant_id = ? AND id = ?', [next, ['closed', 'cancelled'].includes(next) ? now : null, tenantId, c.id]);
      await audit(conn, req, 'event', 'dispatch_calls', c.id, { kind: b.kind });
      return { status: next || c.status };
    });
    res.status(201).json(out);
  },
);

/** Sends a patroller. Anyone not active is refused; a call that is still "new" becomes "dispatched". */
router.post('/dispatch/:id/responders', patrol, needs('dispatch'), validate(z.object({ staff_id: z.number().int().positive() })), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
    const c = await loadCall(conn, tenantId, paramId(req), true);
    if (!ACTIVE.includes(c.status)) throw conflict('This call is already closed');
    if (!(await one(conn, "SELECT id FROM staff WHERE tenant_id = ? AND id = ? AND status = 'active'", [tenantId, req.body.staff_id]))) throw conflict('That person is not an active staff member');
    const [r] = await conn.query('INSERT IGNORE INTO dispatch_responders (tenant_id, call_id, staff_id) VALUES (?, ?, ?)', [tenantId, c.id, req.body.staff_id]);
    if (!r.affectedRows) throw conflict('Already sent to this call');
    await conn.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, user_id) VALUES (?, ?, ?, 'dispatched', ?, ?)", [tenantId, c.id, nowIn(tenant.timezone), req.body.staff_id, req.auth.userId]);
    if (c.status === 'new') await conn.query("UPDATE dispatch_calls SET status = 'dispatched' WHERE tenant_id = ? AND id = ?", [tenantId, c.id]);
    await audit(conn, req, 'dispatch', 'dispatch_calls', c.id, { staff_id: req.body.staff_id });
  });
  const call = await loadCall(pool, tenantId, paramId(req));
  const settings = await OPS.settingsOf(pool, tenantId);
  await alertResponders(tenantId, call, [req.body.staff_id], { text: call.priority === 'critical' && settings.sms_critical });
  res.status(201).json({ ok: true });
});

/** "On my way": the responder acknowledges the alert, so dispatch knows it was seen. */
router.post('/dispatch/:id/ack', patrol, async (req, res) => {
  const { tenantId, staffId } = req.auth;
  if (!staffId) throw bad('Your login is not linked to anyone on the roster');
  const c = await loadCall(pool, tenantId, paramId(req));
  const [r] = await pool.query('UPDATE dispatch_responders SET acked_at = COALESCE(acked_at, UTC_TIMESTAMP()) WHERE tenant_id = ? AND call_id = ? AND staff_id = ?', [tenantId, c.id, staffId]);
  if (!r.affectedRows) throw notFound('You are not sent to this call');
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  await pool.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, 'note', ?, 'On the way', ?)", [tenantId, c.id, nowIn(tz), staffId, req.auth.userId]);
  res.json({ ok: true });
});

/** My calls: the ones I am sent to that are still open, for the alert screen and my phone. */
router.get('/dispatch-mine', patrol, async (req, res) => {
  const { tenantId, staffId } = req.auth;
  if (!staffId) return res.json({ data: [] });
  const list = await rows(pool, `SELECT c.*, r.acked_at FROM dispatch_responders r JOIN dispatch_calls c ON c.tenant_id = r.tenant_id AND c.id = r.call_id
    WHERE r.tenant_id = ? AND r.staff_id = ? AND c.status IN ('new','dispatched','on_scene','transporting') ORDER BY c.received_at DESC`, [tenantId, staffId]);
  res.json({ data: list.map(withNo) });
});

/** Text a responder who has not acknowledged (the dispatcher's backup when the phone alert was missed). */
router.post('/dispatch/:id/responders/:staffId/text', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await loadCall(pool, tenantId, paramId(req));
  const sid = paramId(req, 'staffId');
  if (!(await one(pool, 'SELECT staff_id FROM dispatch_responders WHERE tenant_id = ? AND call_id = ? AND staff_id = ?', [tenantId, c.id, sid]))) throw notFound('Responder');
  if (!(SMS.enabled())) throw bad('Text messages are not set up for DAY/OS yet');
  const n = await alertResponders(tenantId, c, [sid], { text: true });
  if (!n) throw bad('Could not text them: check the phone number on their staff record');
  await audit(pool, req, 'text_responder', 'dispatch_calls', c.id, { staff_id: sid });
  res.json({ ok: true });
});

router.delete('/dispatch/:id/responders/:staffId', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const [r] = await pool.query('DELETE FROM dispatch_responders WHERE tenant_id = ? AND call_id = ? AND staff_id = ?', [tenantId, paramId(req), paramId(req, 'staffId')]);
  if (!r.affectedRows) throw notFound('Responder');
  res.status(204).end();
});

/** Opens a patient care report from the call and links the two. Their times seed the case timeline. */
router.post('/dispatch/:id/case', patrol, needs('dispatch'), validate(z.object({ category: z.enum(['injury', 'collision', 'lost_person', 'equipment', 'medical', 'conduct', 'other']).default('injury'), severity: z.enum(['minor', 'moderate', 'serious', 'critical']).default('minor') })), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await loadCall(pool, tenantId, paramId(req));
  if (c.incident_id) throw conflict('This call already has a case');
  const made = await patrolCases.createCase(req, {
    occurred_at: String(c.received_at), location: c.location, category: req.body.category, severity: req.body.severity,
    summary: (c.description || `Call ${callNo(c)}`).slice(0, 500),
  });
  const [r] = await pool.query('UPDATE dispatch_calls SET incident_id = ? WHERE tenant_id = ? AND id = ? AND incident_id IS NULL', [made.id, tenantId, c.id]);
  if (!r.affectedRows) throw conflict('This call already has a case');
  await audit(pool, req, 'link_case', 'dispatch_calls', c.id, { incident_id: made.id });
  res.status(201).json(made);
});

// ---------------------------------------------------------------- guest help settings
router.get('/guest-help', patrol, needs('manage_settings'), async (req, res) => {
  const t = await one(pool, 'SELECT slug, guest_help_enabled, guest_help_message FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.json({ enabled: Boolean(t.guest_help_enabled), message: t.guest_help_message, path: `/help/${t.slug}` });
});

router.put('/guest-help', patrol, needs('manage_settings'), validate(z.object({ enabled: z.boolean(), message: z.string().max(300).nullable().optional() })), async (req, res) => {
  await pool.query('UPDATE tenants SET guest_help_enabled = ?, guest_help_message = ? WHERE id = ?', [req.body.enabled ? 1 : 0, req.body.message ?? null, req.auth.tenantId]);
  await audit(pool, req, 'set_guest_help', 'tenants', req.auth.tenantId, { enabled: req.body.enabled });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- public: guest help request
// No sign-in. Anyone with the link can send a request, so the endpoint is small, rate limited, ignores
// anything not listed, and creates only a "new" call for patrol to review. It never returns patrol data.
publicRouter.get('/:slug/help', async (req, res) => {
  const t = await one(pool, 'SELECT id, name, guest_help_enabled, guest_help_message FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t || !t.guest_help_enabled) throw notFound('Help page');
  const places = await rows(pool, 'SELECT name FROM trails WHERE tenant_id = ? ORDER BY name LIMIT 200', [t.id]);
  res.set('Cache-Control', 'no-store');
  res.json({ mountain: t.name, message: t.guest_help_message, places: places.map((p) => p.name) });
});

publicRouter.post(
  '/:slug/help',
  validate(z.object({
    location: z.string().trim().min(2).max(120),
    description: z.string().trim().max(300).optional(),
    name: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(30).optional(),
    website: z.string().max(200).optional(), // hidden field: real people leave it empty, form-filling bots do not
  })),
  async (req, res) => {
    const t = await one(pool, 'SELECT id, timezone, guest_help_enabled FROM tenants WHERE slug = ?', [req.params.slug]);
    if (!t || !t.guest_help_enabled) throw notFound('Help page');
    res.set('Cache-Control', 'no-store');
    if (req.body.website) return res.status(202).json({ ok: true }); // pretend success, create nothing
    // Beyond the per-address limit, never let a flood bury the board: at most 20 untouched guest calls at once.
    const { n } = await one(pool, "SELECT COUNT(*) AS n FROM dispatch_calls WHERE tenant_id = ? AND source = 'guest' AND status = 'new'", [t.id]);
    if (n >= 20) return res.status(503).json({ error: 'Patrol is busy. Please call the patrol phone number or flag down a patroller.' });
    const out = await createCall(t, { location: req.body.location, description: req.body.description, caller_name: req.body.name, caller_phone: req.body.phone, priority: 'normal' }, { source: 'guest' });
    return res.status(201).json({ ok: true, reference: out.call_no });
  },
);

module.exports = { router, publicRouter, createCall };
