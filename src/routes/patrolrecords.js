'use strict';

// Patrol records (mounted under /patrol): requests for a report and its release, legal hold, the lost-person search on
// a case, and the daily patrol log.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, dateTimeStr, normDateTime } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const { stepUp } = require('../lib/stepup');
const OPS = require('../lib/patrolops');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (f, m) => PA.needs(pool, f, m);
const NAME = "CONCAT(p.first_name, ' ', p.last_name)";
const caseNo = (i) => (i.seq ? `${i.season}-${String(i.seq).padStart(4, '0')}` : `Case ${i.id}`);

// ================================================================ records requests
const REQ = `SELECT r.*, i.season, i.seq, i.occurred_at, i.category, i.report_state, i.legal_hold, COALESCE(u.email, u.username) AS decided_by_name
  FROM patrol_records_requests r JOIN incidents i ON i.tenant_id = r.tenant_id AND i.id = r.incident_id LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.decided_by`;
const shape = (r) => ({ ...r, id: Number(r.id), incident_id: Number(r.incident_id), case_number: caseNo({ ...r, id: r.incident_id }), legal_hold: Boolean(Number(r.legal_hold)) });

router.get('/records', patrol, needs('records'), async (req, res) => {
  const t = req.auth.tenantId;
  const status = ['open', 'released', 'denied', 'withdrawn'].includes(String(req.query.status)) ? String(req.query.status) : null;
  const list = await rows(pool, `${REQ} WHERE r.tenant_id = ?${status ? ' AND r.status = ?' : ''} ORDER BY r.status = 'open' DESC, r.received_on DESC, r.id DESC LIMIT 300`, status ? [t, status] : [t]);
  const holds = await rows(pool, 'SELECT id, season, seq, occurred_at, category, legal_hold_note FROM incidents WHERE tenant_id = ? AND legal_hold = 1 ORDER BY occurred_at DESC', [t]);
  res.json({ data: list.map(shape), holds: holds.map((h) => ({ ...h, case_number: caseNo(h) })) });
});

/** The requests for one case, for its Record view. */
router.get('/incidents/:id/records', patrol, needs('view_cases'), async (req, res) => {
  const list = await rows(pool, `${REQ} WHERE r.tenant_id = ? AND r.incident_id = ? ORDER BY r.id DESC`, [req.auth.tenantId, paramId(req)]);
  res.json({ data: list.map(shape), can_manage: await PA.can(pool, req, 'records') });
});

router.post('/records', patrol, needs('records'), validate(z.object({
  incident_id: z.number().int().positive(), requester_kind: z.enum(['patient', 'guardian', 'insurer', 'attorney', 'police', 'court', 'other']),
  requester_name: z.string().trim().min(1).max(150), contact: z.string().trim().max(255).nullable().optional(), received_on: dateStr,
  authorization: z.enum(['signed_release', 'subpoena', 'court_order', 'police_request', 'patient_self', 'none']).default('none'), auth_note: z.string().trim().max(255).nullable().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (!(await one(pool, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [t, b.incident_id]))) throw notFound('Case');
  const [r] = await pool.query(`INSERT INTO patrol_records_requests (tenant_id, incident_id, requester_kind, requester_name, contact, received_on, authorization, auth_note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, b.incident_id, b.requester_kind, b.requester_name, b.contact || null, b.received_on, b.authorization, b.auth_note || null, req.auth.userId]);
  await audit(pool, req, 'records_request', 'incidents', b.incident_id, { request: r.insertId, kind: b.requester_kind });
  res.status(201).json({ id: r.insertId });
});

/**
 * Release a report: the approved version, frozen, with a release number. Without an authorization on file (a signed
 * release, a subpoena, a court order, a police request, or the patient asking for their own) it cannot be released.
 */
router.post('/records/:id/release', patrol, needs('records'), stepUp('release a patient record'), validate(z.object({ note: z.string().trim().max(500).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const r = await one(conn, 'SELECT * FROM patrol_records_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!r) throw notFound('Request');
    if (r.status !== 'open') throw conflict(`This request is already ${r.status}`);
    if (r.authorization === 'none') throw conflict('Record the authorization first (a signed release, subpoena, court order, police request, or the patient asking for their own)');
    const v = await one(conn, "SELECT id, version_no FROM incident_versions WHERE tenant_id = ? AND incident_id = ? AND kind = 'approved' ORDER BY version_no DESC LIMIT 1", [t, r.incident_id]);
    if (!v) throw conflict('Only an approved report is released. Approve it first.');
    const { now } = await OPS.clock(conn, t);
    const { n } = await one(conn, "SELECT COUNT(*) + 1 AS n FROM patrol_records_requests WHERE tenant_id = ? AND release_no IS NOT NULL AND YEAR(released_at) = YEAR(?)", [t, now]);
    const releaseNo = `R${now.slice(0, 4)}-${String(n).padStart(3, '0')}`;
    await conn.query("UPDATE patrol_records_requests SET status = 'released', version_id = ?, release_no = ?, released_at = ?, decided_by = ?, decision_note = ? WHERE tenant_id = ? AND id = ?", [v.id, releaseNo, now, req.auth.userId, req.body.note || null, t, r.id]);
    await audit(conn, req, 'records_release', 'incidents', r.incident_id, { request: r.id, release_no: releaseNo, version: v.version_no });
    return { release_no: releaseNo, version_id: Number(v.id) };
  });
  res.json(out);
});

router.post('/records/:id/decide', patrol, needs('records'), validate(z.object({ status: z.enum(['denied', 'withdrawn']), note: z.string().trim().min(1).max(500) })), async (req, res) => {
  const t = req.auth.tenantId;
  const r = await one(pool, 'SELECT * FROM patrol_records_requests WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
  if (!r) throw notFound('Request');
  if (r.status !== 'open') throw conflict(`This request is already ${r.status}`);
  await pool.query('UPDATE patrol_records_requests SET status = ?, decided_by = ?, decision_note = ? WHERE tenant_id = ? AND id = ?', [req.body.status, req.auth.userId, req.body.note, t, r.id]);
  await audit(pool, req, `records_${req.body.status}`, 'incidents', r.incident_id, { request: r.id });
  res.json({ ok: true });
});

router.patch('/records/:id', patrol, needs('records'), validate(z.object({ authorization: z.enum(['signed_release', 'subpoena', 'court_order', 'police_request', 'patient_self', 'none']).optional(), auth_note: z.string().trim().max(255).nullable().optional(), contact: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const cols = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!cols.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE patrol_records_requests SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ? AND status = 'open'`, [...cols.map((k) => b[k]), t, paramId(req)]);
  if (!r.affectedRows) throw conflict('Only an open request can be changed');
  res.json({ ok: true });
});

/** The release pack: the frozen version, its release number and who it went to. Viewing it is logged. */
router.get('/records/:id/pack', patrol, needs('records'), async (req, res) => {
  const t = req.auth.tenantId;
  const r = await one(pool, `${REQ} WHERE r.tenant_id = ? AND r.id = ?`, [t, paramId(req)]);
  if (!r) throw notFound('Request');
  if (r.status !== 'released') throw conflict('This request has not been released');
  const v = await one(pool, 'SELECT id, version_no, kind, snapshot, created_at FROM incident_versions WHERE tenant_id = ? AND id = ?', [t, r.version_id]);
  const tenant = await one(pool, 'SELECT name, legal_name FROM tenants WHERE id = ?', [t]);
  await audit(pool, req, 'records_pack_view', 'incidents', r.incident_id, { request: r.id });
  res.json({ request: shape(r), version: { id: Number(v.id), version_no: v.version_no, created_at: v.created_at, report: JSON.parse(v.snapshot) }, resort: tenant });
});

/** Legal hold: nothing on the case can be marked entered in error, no patient removed, and it is never purged. */
router.put('/incidents/:id/legal-hold', patrol, needs('records'), validate(z.object({ hold: z.boolean(), note: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  if (req.body.hold && !req.body.note) throw bad('Say why the case is on hold (the claim or request)');
  const [r] = await pool.query('UPDATE incidents SET legal_hold = ?, legal_hold_note = ? WHERE tenant_id = ? AND id = ?', [req.body.hold ? 1 : 0, req.body.hold ? req.body.note : null, t, id]);
  if (!r.affectedRows) throw notFound('Case');
  await audit(pool, req, req.body.hold ? 'legal_hold_on' : 'legal_hold_off', 'incidents', id, { note: req.body.note || null });
  res.json({ ok: true });
});

// ================================================================ lost-person search
async function caseFor(conn, req, id) {
  const inc = await one(conn, 'SELECT id, report_state, category FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!inc) throw notFound('Case');
  return inc;
}
const editable = (inc) => { if (inc.report_state !== 'draft') throw conflict('This report is not a draft. Add a note instead.'); };

router.get('/incidents/:id/search', patrol, needs('view_cases'), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  await caseFor(pool, req, id);
  const [s, areas] = await Promise.all([
    one(pool, 'SELECT * FROM incident_search WHERE tenant_id = ? AND incident_id = ?', [t, id]),
    rows(pool, `SELECT a.*, ${NAME} AS staff_name, tr.name AS trail FROM incident_search_areas a LEFT JOIN staff s ON s.tenant_id = a.tenant_id AND s.id = a.staff_id
      LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id LEFT JOIN trails tr ON tr.tenant_id = a.tenant_id AND tr.id = a.trail_id WHERE a.tenant_id = ? AND a.incident_id = ? ORDER BY a.id`, [t, id]),
  ]);
  res.json({ search: s || null, areas });
});

const searchFields = {
  person_name: z.string().trim().max(150).nullable().optional(), age_years: z.number().int().min(0).max(120).nullable().optional(),
  last_seen_at: dateTimeStr.transform(normDateTime).nullable().optional(), last_seen_place: z.string().trim().max(255).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(), clothing: z.string().trim().max(500).nullable().optional(), phone: z.string().trim().max(40).nullable().optional(),
  reported_by: z.string().trim().max(255).nullable().optional(), found_at: dateTimeStr.transform(normDateTime).nullable().optional(), found_place: z.string().trim().max(255).nullable().optional(),
  outcome: z.enum(['found_well', 'found_injured', 'self_returned', 'not_found', 'other']).nullable().optional(),
};
router.put('/incidents/:id/search', patrol, needs('create_case'), validate(z.object(searchFields)), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const inc = await caseFor(pool, req, id); editable(inc);
  if (b.outcome && b.outcome !== 'not_found' && !b.found_at) throw bad('Give the time they were found or returned');
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) throw bad('Nothing to save');
  await pool.query(`INSERT INTO incident_search (tenant_id, incident_id, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(', ')}`, [t, id, ...keys.map((k) => b[k])]);
  await audit(pool, req, 'search_update', 'incidents', id, { fields: keys });
  res.json({ ok: true });
});

router.post('/incidents/:id/search/areas', patrol, needs('create_case'), validate(z.object({ area: z.string().trim().min(1).max(150), trail_id: z.number().int().positive().nullable().optional(), staff_id: z.number().int().positive().nullable().optional(), note: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const inc = await caseFor(pool, req, id); editable(inc);
  if (b.trail_id && !(await one(pool, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ?', [t, b.trail_id]))) throw notFound('Run');
  if (b.staff_id && !(await one(pool, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, b.staff_id]))) throw notFound('Staff member');
  const { now } = await OPS.clock(pool, t);
  const [r] = await pool.query('INSERT INTO incident_search_areas (tenant_id, incident_id, area, trail_id, staff_id, assigned_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, id, b.area, b.trail_id || null, b.staff_id || null, now, b.note || null]);
  if (b.staff_id) require('../lib/push').notifyStaff(t, [b.staff_id], { title: 'Search: your area', body: `${b.area}${b.note ? `. ${b.note}` : ''}`, url: `#/patrol/case/${id}`, tag: `search-${id}` });
  await audit(pool, req, 'search_area', 'incidents', id, { area: b.area });
  res.status(201).json({ id: r.insertId });
});

router.post('/incidents/:id/search/areas/:areaId/searched', patrol, needs('create_case'), validate(z.object({ note: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const inc = await caseFor(pool, req, id); editable(inc);
  const { now } = await OPS.clock(pool, t);
  const [r] = await pool.query("UPDATE incident_search_areas SET status = 'searched', searched_at = ?, note = COALESCE(?, note) WHERE tenant_id = ? AND incident_id = ? AND id = ?", [now, req.body.note || null, t, id, paramId(req, 'areaId')]);
  if (!r.affectedRows) throw notFound('Search area');
  res.json({ ok: true });
});

// ================================================================ daily patrol log
const logWriter = async (req) => (await PA.can(pool, req, 'run_sweep')) || PA.can(pool, req, 'manage_team');

/** One day, assembled from everything recorded that day, plus the leaders' notes, the sign-off and any addenda. */
router.get('/daily-log', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { today } = await OPS.clock(pool, t);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today;
  const from = `${date} 00:00:00`; const to = `${OPS.addDays(date, 1)} 00:00:00`;
  const viewCases = await PA.can(pool, req, 'view_cases');
  const [log, addenda, weather, snow, duty, cases, calls, opening, closures, sweep, flagged, avyObs, avyShots, evacs] = await Promise.all([
    one(pool, 'SELECT l.*, COALESCE(u.email, u.username) AS signed_by_name FROM patrol_daily_log l LEFT JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.signed_by WHERE l.tenant_id = ? AND l.on_date = ?', [t, date]),
    rows(pool, 'SELECT a.*, COALESCE(u.email, u.username) AS by_name FROM patrol_daily_addenda a LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.by_user WHERE a.tenant_id = ? AND a.on_date = ? ORDER BY a.at', [t, date]),
    rows(pool, 'SELECT logged_at, place, temp_f, wind_mph, gust_mph, wind_dir, sky, precip_in, note FROM weather_logs WHERE tenant_id = ? AND logged_at >= ? AND logged_at < ? ORDER BY logged_at', [t, from, to]),
    rows(pool, 'SELECT r.read_at, r.base_in, r.new_snow_in, r.surface, r.note, tr.name AS trail FROM snow_readings r LEFT JOIN trails tr ON tr.tenant_id = r.tenant_id AND tr.id = r.trail_id WHERE r.tenant_id = ? AND r.read_at >= ? AND r.read_at < ? ORDER BY r.read_at', [t, from, to]),
    rows(pool, `SELECT d.signed_in_at, d.signed_out_at, d.auto_closed, d.radio, ${NAME} AS name, st.name AS station FROM patrol_duty d JOIN staff s ON s.tenant_id = d.tenant_id AND s.id = d.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
      LEFT JOIN patrol_stations st ON st.tenant_id = d.tenant_id AND st.id = d.station_id WHERE d.tenant_id = ? AND d.on_date = ? ORDER BY d.signed_in_at`, [t, date]),
    rows(pool, 'SELECT id, season, seq, occurred_at, location, category, severity, summary, report_state FROM incidents WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at', [t, from, to]),
    rows(pool, 'SELECT id, call_date, seq, received_at, closed_at, priority, status, location FROM dispatch_calls WHERE tenant_id = ? AND call_date = ? ORDER BY received_at', [t, date]),
    rows(pool, `SELECT c.checked_at, c.decision, c.reason, c.hazards, tr.name AS trail, ${NAME} AS by_name FROM patrol_opening_checks c JOIN trails tr ON tr.tenant_id = c.tenant_id AND tr.id = c.trail_id
      LEFT JOIN staff s ON s.tenant_id = c.tenant_id AND s.id = c.checked_by LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE c.tenant_id = ? AND c.on_date = ? ORDER BY c.checked_at`, [t, date]),
    date === today ? rows(pool, "SELECT name, status, closure_reason FROM trails WHERE tenant_id = ? AND status <> 'open' AND closure_reason IS NOT NULL ORDER BY name", [t]) : [],
    one(pool, 'SELECT id, status, started_at, clear_at, clear_note FROM patrol_sweeps WHERE tenant_id = ? AND on_date = ?', [t, date]),
    rows(pool, "SELECT c.checked_at, c.result, c.notes, e.name FROM equipment_checks c JOIN patrol_equipment e ON e.tenant_id = c.tenant_id AND e.id = c.equipment_id WHERE c.tenant_id = ? AND c.result <> 'ok' AND c.checked_at >= ? AND c.checked_at < ? ORDER BY c.checked_at", [t, from, to]),
    rows(pool, 'SELECT observed_at, hn24_cm, wind, hazard_below, hazard_near, hazard_above, notes FROM patrol_avy_obs WHERE tenant_id = ? AND observed_at >= ? AND observed_at < ? ORDER BY observed_at', [t, from, to]),
    rows(pool, 'SELECT x.shot_at, x.method, x.result, x.size_r, x.size_d, a.name AS path FROM patrol_avy_shots x JOIN patrol_avy_paths a ON a.tenant_id = x.tenant_id AND a.id = x.path_id WHERE x.tenant_id = ? AND x.shot_at >= ? AND x.shot_at < ? ORDER BY x.shot_at', [t, from, to]),
    rows(pool, 'SELECT e.kind, e.started_at, e.ended_at, e.guests, l.name AS lift FROM patrol_lift_evacs e JOIN lifts l ON l.tenant_id = e.tenant_id AND l.id = e.lift_id WHERE e.tenant_id = ? AND e.started_at >= ? AND e.started_at < ? ORDER BY e.started_at', [t, from, to]),
  ]);
  let sweepRoutes = [];
  if (sweep) sweepRoutes = await rows(pool, `SELECT ro.name AS route, r.status, r.cleared_at, ${NAME} AS by_name, (SELECT COUNT(*) FROM patrol_sweep_marks k WHERE k.tenant_id = r.tenant_id AND k.run_id = r.id AND k.flag <> 'none') AS finds
    FROM patrol_sweep_runs r JOIN patrol_sweep_routes ro ON ro.tenant_id = r.tenant_id AND ro.id = r.route_id LEFT JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.staff_id LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE r.tenant_id = ? AND r.sweep_id = ? ORDER BY ro.sort, ro.name`, [t, sweep.id]);
  res.json({
    date, today, notes: log ? log.notes : null, signed: log && log.signed_at ? { at: log.signed_at, by: log.signed_by_name } : null, addenda,
    weather, snow, duty,
    cases: viewCases ? cases.map((c) => ({ ...c, case_number: caseNo(c) })) : null, case_count: cases.length,
    calls: calls.map((c) => ({ ...c, call_no: `${String(c.call_date).slice(5).replace('-', '')}-${String(c.seq).padStart(2, '0')}` })),
    opening, closures, sweep: sweep ? { ...sweep, routes: sweepRoutes } : null, flagged, avalanche: { obs: avyObs, shots: avyShots }, evacs,
    can_write: Boolean(await logWriter(req)),
  });
});

router.put('/daily-log', patrol, validate(z.object({ date: dateStr, notes: z.string().max(20000).nullable() })), async (req, res) => {
  if (!(await logWriter(req))) throw forbidden('Only sweep leads and those who manage the roster write the daily log');
  const t = req.auth.tenantId; const b = req.body;
  const cur = await one(pool, 'SELECT signed_at FROM patrol_daily_log WHERE tenant_id = ? AND on_date = ?', [t, b.date]);
  if (cur && cur.signed_at) throw conflict('This day is signed off. Add an addendum instead.');
  await pool.query('INSERT INTO patrol_daily_log (tenant_id, on_date, notes, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE notes = VALUES(notes), updated_by = VALUES(updated_by)', [t, b.date, b.notes, req.auth.userId]);
  res.json({ ok: true });
});

router.post('/daily-log/sign', patrol, validate(z.object({ date: dateStr })), async (req, res) => {
  if (!(await logWriter(req))) throw forbidden('Only sweep leads and those who manage the roster sign off the daily log');
  const t = req.auth.tenantId;
  const { now, today } = await OPS.clock(pool, t);
  if (req.body.date > today) throw bad('That day has not happened yet');
  const cur = await one(pool, 'SELECT signed_at FROM patrol_daily_log WHERE tenant_id = ? AND on_date = ?', [t, req.body.date]);
  if (cur && cur.signed_at) throw conflict('Already signed off');
  await pool.query('INSERT INTO patrol_daily_log (tenant_id, on_date, signed_by, signed_at, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE signed_by = VALUES(signed_by), signed_at = VALUES(signed_at)', [t, req.body.date, req.auth.userId, now, req.auth.userId]);
  await audit(pool, req, 'daily_log_sign', 'patrol_daily_log', null, { date: req.body.date });
  res.json({ ok: true });
});

router.post('/daily-log/addenda', patrol, validate(z.object({ date: dateStr, body: z.string().trim().min(1).max(5000) })), async (req, res) => {
  if (!(await logWriter(req))) throw forbidden('Only sweep leads and those who manage the roster add to the daily log');
  const t = req.auth.tenantId;
  const cur = await one(pool, 'SELECT signed_at FROM patrol_daily_log WHERE tenant_id = ? AND on_date = ?', [t, req.body.date]);
  if (!cur || !cur.signed_at) throw conflict('Edit the notes until the day is signed off; addenda are for after');
  const { now } = await OPS.clock(pool, t);
  const [r] = await pool.query('INSERT INTO patrol_daily_addenda (tenant_id, on_date, body, by_user, at) VALUES (?, ?, ?, ?, ?)', [t, req.body.date, req.body.body, req.auth.userId, now]);
  await audit(pool, req, 'daily_log_addendum', 'patrol_daily_log', null, { date: req.body.date });
  res.status(201).json({ id: r.insertId });
});

/** Find days by words in their notes or addenda ("rope line Upper Cascade"). */
router.get('/daily-log/search', patrol, async (req, res) => {
  const t = req.auth.tenantId; const q = String(req.query.q || '').trim();
  if (q.length < 2) throw bad('Type at least 2 letters');
  const like = `%${q}%`;
  const list = await rows(pool, `SELECT on_date, notes AS text, 'notes' AS kind FROM patrol_daily_log WHERE tenant_id = ? AND notes LIKE ?
    UNION ALL SELECT on_date, body AS text, 'addendum' AS kind FROM patrol_daily_addenda WHERE tenant_id = ? AND body LIKE ? ORDER BY on_date DESC LIMIT 50`, [t, like, t, like]);
  const snip = (text) => { const i = text.toLowerCase().indexOf(q.toLowerCase()); return `${i > 40 ? '…' : ''}${text.slice(Math.max(0, i - 40), i + q.length + 60)}${i + q.length + 60 < text.length ? '…' : ''}`; };
  res.json({ data: list.map((r) => ({ date: String(r.on_date).slice(0, 10), kind: r.kind, snippet: snip(r.text) })) });
});

module.exports = { router };
