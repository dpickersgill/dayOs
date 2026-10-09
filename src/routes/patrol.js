'use strict';

// Ski patrol patient care reports ("cases").
//
// A case is an incident plus everything a patroller records about the response: patients (with history,
// vitals, injuries and treatments), a timeline, who responded, witnesses and signatures. Reports move
// draft -> submitted -> approved. Approved reports are locked; corrections go in as notes, or a manager
// reopens the report with a recorded reason. Reading a case is audited, because it holds injury details.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, dateTimeStr, validate, paramId, normDateTime, setClause, seasonFor, todayIn, nowIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { FIELDS, SECTIONS, formSchema, parseForm, mergeForm, isEmpty, applies } = require('../lib/nsaar');
const { requiredFields } = require('../lib/formconfig');
const { buildPull, ageOn } = require('../lib/patrolpull');

const router = express.Router();
// Incident records can contain injury details about guests, so access is limited to patrol and managers.
const patrol = requireRole('patrol', 'manager');
const PA = require('../lib/patrolaccess');
const needs = (feature, message) => PA.needs(pool, feature, message);

const CLINICAL_CATEGORIES = ['injury', 'medical'];
const caseNumber = (r) => (r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : null);
const withNumber = (r) => ({ ...r, case_number: caseNumber(r) });

// ---------------------------------------------------------------- the case itself
const incidentFields = {
  occurred_at: dateTimeStr.transform(normDateTime),
  location: z.string().min(1).max(255),
  category: z.enum(['injury', 'collision', 'lost_person', 'equipment', 'medical', 'conduct', 'other']),
  severity: z.enum(['minor', 'moderate', 'serious', 'critical']).default('minor'),
  person_id: z.number().int().positive().nullable().optional(),
  reported_by_staff: z.number().int().positive().nullable().optional(),
  summary: z.string().min(1).max(500),
  narrative: z.string().max(20000).nullable().optional(),
  disposition: z.enum(['treated_released', 'transported', 'refused_care', 'no_injury', 'other']).nullable().optional(),
  weather: z.string().max(100).nullable().optional(),
  gps_lat: z.number().min(-90).max(90).nullable().optional(),
  gps_lng: z.number().min(-180).max(180).nullable().optional(),
  trail_id: z.number().int().positive().nullable().optional(),
  form: formSchema('case').optional(),
};


// ---------------------------------------------------------------- answers the form can work out for itself
const RUN_CLASS = { green: 'easiest', blue: 'more_difficult', black: 'most_difficult', double_black: 'extreme' };
/** The NSAAR run classification for a trail, taken from its difficulty. Terrain park trails have none. */
async function runClassFor(conn, tenantId, trailId) {
  if (!trailId) return null;
  const t = await one(conn, 'SELECT difficulty FROM trails WHERE tenant_id = ? AND id = ?', [tenantId, trailId]);
  return t ? RUN_CLASS[t.difficulty] || null : null;
}
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const catLabel = (c) => { const t = String(c).replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
/** The summary the New case screen writes when nobody types one. Only a summary like this is replaced by the chief complaint. */
const autoSummary = (inc) => `${catLabel(inc.category)} at ${inc.location}`;
/** Use the chief complaint as the case summary while the summary is still the automatic one (or a copy of the previous complaint). */
async function summaryFromComplaint(conn, tenantId, inc, complaint, previous) {
  const text = String(complaint || '').trim();
  if (!text) return;
  if (inc.summary !== autoSummary(inc) && !(previous && inc.summary === String(previous).trim())) return;
  const { n } = await one(conn, 'SELECT COUNT(*) AS n FROM incident_patients WHERE tenant_id = ? AND incident_id = ?', [tenantId, inc.id]);
  if (n !== 1) return;
  await conn.query('UPDATE incidents SET summary = ? WHERE tenant_id = ? AND id = ?', [text.slice(0, 500), tenantId, inc.id]);
}

/** Case numbers run per season (2026-27-0001). The unique key settles races; a collision just retries. */
async function createCase(req, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tx(async (conn) => {
        const season = seasonFor(body.occurred_at.slice(0, 10));
        const { n } = await one(conn, 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM incidents WHERE tenant_id = ? AND season = ?', [req.auth.tenantId, season]);
        const data = { ...body, season, seq: n };
        const cls = body.trail_id && !(body.form && body.form.run_classification) ? await runClassFor(conn, req.auth.tenantId, body.trail_id) : null;
        if (cls) data.form = { ...(data.form || {}), run_classification: cls };
        if ('form' in data) data.form = mergeForm(null, data.form);
        const keys = Object.keys(data);
        const [r] = await conn.query(
          `INSERT INTO incidents (tenant_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`,
          [req.auth.tenantId, ...keys.map((k) => data[k])],
        );
        // The person filing the report is the lead responder unless someone else is named later.
        if (req.auth.staffId) {
          await conn.query("INSERT INTO incident_responders (tenant_id, incident_id, staff_id, role) VALUES (?, ?, ?, 'lead')", [req.auth.tenantId, r.insertId, req.auth.staffId]);
        }
        await audit(conn, req, 'create', 'incidents', r.insertId, { category: body.category, severity: body.severity, case: `${season}-${n}` });
        return { id: r.insertId, case_number: `${season}-${String(n).padStart(4, '0')}`, status: 'open', report_state: 'draft' };
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
}

router.post('/incidents', patrol, needs('create_case'), validate(z.object(incidentFields)), async (req, res) => {
  res.status(201).json(await createCase(req, req.body));
});

const filters = (req) => {
  const where = ['i.tenant_id = ?'];
  const params = [req.auth.tenantId];
  for (const f of ['status', 'category', 'severity', 'report_state']) {
    if (req.query[f]) { where.push(`i.${f} = ?`); params.push(String(req.query[f])); }
  }
  if (req.query.from) { where.push('DATE(i.occurred_at) >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('DATE(i.occurred_at) <= ?'); params.push(String(req.query.to)); }
  if (req.query.q) {
    const like = `%${String(req.query.q)}%`;
    where.push("(i.summary LIKE ? OR i.location LIKE ? OR CONCAT(i.season, '-', LPAD(i.seq, 4, '0')) LIKE ? OR EXISTS (SELECT 1 FROM incident_patients pq WHERE pq.tenant_id = i.tenant_id AND pq.incident_id = i.id AND CONCAT(pq.first_name, ' ', pq.last_name) LIKE ?))");
    params.push(like, like, like, like);
  }
  return { where: where.join(' AND '), params };
};

router.get('/incidents', patrol, needs('view_cases'), async (req, res) => {
  const { where, params } = filters(req);
  const data = await rows(
    pool,
    `SELECT i.id, i.season, i.seq, i.occurred_at, i.location, i.category, i.severity, i.summary, i.disposition, i.status, i.report_state,
            (SELECT COUNT(*) FROM incident_patients p WHERE p.tenant_id = i.tenant_id AND p.incident_id = i.id) AS patient_count
     FROM incidents i WHERE ${where} ORDER BY i.occurred_at DESC, i.id DESC LIMIT 500`,
    params,
  );
  res.json({ data: data.map(withNumber) });
});

// ---------------------------------------------------------------- access log (who looked at patient records)
/**
 * Who opened, changed, exported or searched for patient information, newest first. For patrol administrators.
 * This is the record to review when a guest asks who has seen their information.
 */
router.get('/access-log', patrol, needs('view_access_log'), async (req, res) => {
  const where = ["a.tenant_id = ?", "(a.entity IN ('incidents','incident_patients','incident_pins','audit_log') OR (a.entity = 'people' AND a.action IN ('lookup','pull_preview')))"];
  const params = [req.auth.tenantId];
  if (req.query.from) { where.push('DATE(a.at) >= ?'); params.push(String(req.query.from)); }
  if (req.query.to) { where.push('DATE(a.at) <= ?'); params.push(String(req.query.to)); }
  if (req.query.user_id) { where.push('a.user_id = ?'); params.push(Number(req.query.user_id)); }
  if (req.query.incident_id) { where.push("a.entity = 'incidents' AND a.entity_id = ?"); params.push(Number(req.query.incident_id)); }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const data = await rows(pool, `SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.detail, a.user_id, u.email AS user_email, i.season, i.seq
                                 FROM audit_log a LEFT JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
                                 LEFT JOIN incidents i ON a.entity = 'incidents' AND i.id = a.entity_id AND i.tenant_id = a.tenant_id
                                 WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ?`, [...params, limit]);
  await audit(pool, req, 'view_access_log', 'audit_log', null, { rows: data.length });
  res.json({ data: data.map((r) => ({ id: r.id, at: r.at, action: r.action, entity: r.entity, entity_id: r.entity_id, case_number: r.season ? caseNumber(r) : null, user_id: r.user_id, user_email: r.user_email, detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail })), limit });
});

// ---------------------------------------------------------------- exports (managers)
// Quote every field and neutralize spreadsheet formula injection (cells starting with = + - @).
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const toCsv = (cols, data) => [cols.join(','), ...data.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');

/** CSV for insurers and state reporting. Names and free text (the summary can hold a name) stay out of it. */
router.get('/incidents.csv', patrol, needs('reports'), async (req, res) => {
  const { where, params } = filters(req);
  const data = await rows(
    pool,
    `SELECT i.id, i.season, i.seq, i.occurred_at, i.location, i.category, i.severity, i.disposition, i.status, i.report_state,
            (SELECT COUNT(*) FROM incident_patients p WHERE p.tenant_id = i.tenant_id AND p.incident_id = i.id) AS patients
     FROM incidents i WHERE ${where} ORDER BY i.occurred_at`,
    params,
  );
  const out = data.map((r) => ({ ...r, case_number: caseNumber(r) }));
  const cols = ['case_number', 'id', 'occurred_at', 'location', 'category', 'severity', 'disposition', 'status', 'report_state', 'patients'];
  await audit(pool, req, 'export', 'incidents', null, { rows: data.length });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="incidents.csv"').send(toCsv(cols, out));
});

/** One row per patient with structured fields only (no names, no free text), for injury statistics. */
router.get('/patients.csv', patrol, needs('reports'), async (req, res) => {
  const { where, params } = filters(req);
  const data = await rows(
    pool,
    `SELECT i.season, i.seq, i.occurred_at, p.age_years, p.sex, p.activity, p.ability, p.helmet, p.rental_equipment, p.disposition,
            (SELECT GROUP_CONCAT(CONCAT(j.body_region, ':', j.injury_type) SEPARATOR ' | ') FROM incident_injuries j WHERE j.tenant_id = p.tenant_id AND j.patient_id = p.id) AS injuries
     FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id
     WHERE ${where} ORDER BY i.occurred_at, p.id`,
    params,
  );
  const out = data.map((r) => ({ ...r, case_number: caseNumber(r) }));
  const cols = ['case_number', 'occurred_at', 'age_years', 'sex', 'activity', 'ability', 'helmet', 'rental_equipment', 'disposition', 'injuries'];
  await audit(pool, req, 'export', 'incident_patients', null, { rows: data.length });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="patients.csv"').send(toCsv(cols, out));
});

// ---------------------------------------------------------------- analytics
router.get('/analytics', patrol, needs('reports'), async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const season = seasonFor(today);
  const from = req.query.from ? String(req.query.from) : `${season.slice(0, 4)}-08-01`;
  const to = req.query.to ? String(req.query.to) : today;
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('from and to must be YYYY-MM-DD');
  const range = [tenantId, from, to];
  const inRange = 'i.tenant_id = ? AND DATE(i.occurred_at) BETWEEN ? AND ?';
  const group = (sql) => rows(pool, sql, range);

  // Skier visits = accepted gate scans in the same dates (a rough denominator: one guest can scan more than once).
  const visits = Number((await one(pool, "SELECT COUNT(*) AS n FROM scans WHERE tenant_id = ? AND result = 'ok' AND DATE(scanned_at) BETWEEN ? AND ?", range)).n);
  const [totals, byCategory, bySeverity, byHour, byWeekday, places, disposition, activity, ability, helmet, region, injuryType, response, byLead, states] = await Promise.all([
    one(pool, `SELECT COUNT(*) AS cases, (SELECT COUNT(*) FROM incident_patients p JOIN incidents x ON x.id = p.incident_id AND x.tenant_id = p.tenant_id WHERE x.tenant_id = ? AND DATE(x.occurred_at) BETWEEN ? AND ?) AS patients FROM incidents i WHERE ${inRange}`, [...range, ...range]),
    group(`SELECT category AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY category ORDER BY n DESC`),
    group(`SELECT severity AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY severity ORDER BY n DESC`),
    group(`SELECT HOUR(occurred_at) AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY label ORDER BY label`),
    group(`SELECT DAYOFWEEK(occurred_at) - 1 AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY label ORDER BY label`),
    group(`SELECT COALESCE(t.name, i.location) AS label, COUNT(*) AS n FROM incidents i LEFT JOIN trails t ON t.id = i.trail_id AND t.tenant_id = i.tenant_id WHERE ${inRange} GROUP BY COALESCE(t.name, i.location) ORDER BY n DESC LIMIT 10`),
    group(`SELECT COALESCE(p.disposition, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.activity')), p.activity, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.ability')), p.ability, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.helmet')), p.helmet) AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.activity')), p.activity) IN ('ski','snowboard','other_snow','alpine','telemark','nordic','touring')) GROUP BY label`),
    group(`SELECT j.body_region AS label, COUNT(*) AS n FROM incident_injuries j JOIN incident_patients p ON p.id = j.patient_id AND p.tenant_id = j.tenant_id JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} GROUP BY j.body_region ORDER BY n DESC`),
    group(`SELECT j.injury_type AS label, COUNT(*) AS n FROM incident_injuries j JOIN incident_patients p ON p.id = j.patient_id AND p.tenant_id = j.tenant_id JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} GROUP BY j.injury_type ORDER BY n DESC`),
    one(pool, `SELECT
        AVG(TIMESTAMPDIFF(SECOND, call_at, scene_at)) / 60 AS call_to_scene_min,
        AVG(TIMESTAMPDIFF(SECOND, scene_at, aid_at)) / 60 AS scene_to_aid_room_min,
        SUM(call_at IS NOT NULL AND scene_at IS NOT NULL) AS timed_cases
      FROM (SELECT i.id,
              MIN(CASE WHEN e.kind = 'call_received' THEN e.at END) AS call_at,
              MIN(CASE WHEN e.kind = 'on_scene' THEN e.at END) AS scene_at,
              MIN(CASE WHEN e.kind = 'at_aid_room' THEN e.at END) AS aid_at
            FROM incidents i JOIN incident_events e ON e.incident_id = i.id AND e.tenant_id = i.tenant_id
            WHERE ${inRange} GROUP BY i.id) t`, range),
    group(`SELECT CONCAT(pe.first_name, ' ', pe.last_name) AS label, COUNT(*) AS n
           FROM incident_responders r JOIN incidents i ON i.id = r.incident_id AND i.tenant_id = r.tenant_id
           JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id JOIN people pe ON pe.id = s.person_id AND pe.tenant_id = s.tenant_id
           WHERE ${inRange} AND r.role = 'lead' GROUP BY r.staff_id, pe.first_name, pe.last_name ORDER BY n DESC LIMIT 10`),
    group(`SELECT report_state AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY report_state`),
  ]);
  const round = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
  res.json({
    from, to,
    cases: totals.cases, patients: totals.patients, visits,
    patients_per_1000_visits: visits ? Math.round((Number(totals.patients) / visits) * 10000) / 10 : null,
    by_category: byCategory, by_severity: bySeverity, by_hour: byHour, by_weekday: byWeekday, top_places: places,
    patients_by_disposition: disposition, patients_by_activity: activity, patients_by_ability: ability, helmet_use_on_snow: helmet,
    injuries_by_region: region, injuries_by_type: injuryType,
    response_times: { call_to_scene_min: round(response.call_to_scene_min), scene_to_aid_room_min: round(response.scene_to_aid_room_min), timed_cases: Number(response.timed_cases || 0) },
    cases_by_lead: byLead, report_states: states,
  });
});

// ---------------------------------------------------------------- one case, in full
router.get('/incidents/:id', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req);
  const { tenantId } = req.auth;
  const incident = await one(pool, 'SELECT i.*, t.name AS trail FROM incidents i LEFT JOIN trails t ON t.id = i.trail_id AND t.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND i.id = ?', [tenantId, id]);
  if (!incident) throw notFound('Incident');
  const [notes, patients, events, responders, witnesses, signatures, collisionRow, parties, checklist] = await Promise.all([
    rows(pool, 'SELECT n.id, n.author_user, u.email AS author, n.body, n.created_at FROM incident_notes n LEFT JOIN users u ON u.id = n.author_user AND u.tenant_id = n.tenant_id WHERE n.tenant_id = ? AND n.incident_id = ? ORDER BY n.id', [tenantId, id]),
    rows(pool, 'SELECT * FROM incident_patients WHERE tenant_id = ? AND incident_id = ? ORDER BY id', [tenantId, id]),
    rows(pool, 'SELECT id, kind, at, note FROM incident_events WHERE tenant_id = ? AND incident_id = ? ORDER BY at, id', [tenantId, id]),
    rows(pool, `SELECT r.id, r.staff_id, r.role, p.first_name, p.last_name FROM incident_responders r JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id WHERE r.tenant_id = ? AND r.incident_id = ? ORDER BY FIELD(r.role, 'lead', 'assist', 'transport', 'dispatch'), r.id`, [tenantId, id]),
    rows(pool, 'SELECT id, relation, name, phone, email, address, city, region, postal, statement FROM incident_witnesses WHERE tenant_id = ? AND incident_id = ? ORDER BY id', [tenantId, id]),
    rows(pool, 'SELECT id, patient_id, kind, signer_name, signed_at FROM incident_signatures WHERE tenant_id = ? AND incident_id = ? ORDER BY id', [tenantId, id]),
    one(pool, 'SELECT * FROM incident_collisions WHERE tenant_id = ? AND incident_id = ?', [tenantId, id]),
    rows(pool, 'SELECT * FROM incident_parties WHERE tenant_id = ? AND incident_id = ? ORDER BY id', [tenantId, id]),
    rows(pool, 'SELECT c.patient_id, c.item_key, c.done_at, u.email AS done_by FROM incident_checklist c LEFT JOIN users u ON u.id = c.done_by AND u.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.incident_id = ? ORDER BY c.id', [tenantId, id]),
  ]);
  const ids = patients.map((p) => p.id);
  const byPatient = async (sql) => (ids.length ? rows(pool, sql, [tenantId, ids]) : []);
  const [vitals, injuries, treatments] = await Promise.all([
    byPatient('SELECT * FROM incident_vitals WHERE tenant_id = ? AND patient_id IN (?) ORDER BY taken_at, id'),
    byPatient('SELECT * FROM incident_injuries WHERE tenant_id = ? AND patient_id IN (?) ORDER BY id'),
    byPatient('SELECT * FROM incident_treatments WHERE tenant_id = ? AND patient_id IN (?) ORDER BY performed_at, id'),
  ]);
  const mine = (list, pid) => list.filter((x) => x.patient_id === pid);
  await audit(pool, req, 'view', 'incidents', id); // reads of sensitive records are logged too
  const tenant = await one(pool, 'SELECT name, legal_name FROM tenants WHERE id = ?', [tenantId]);
  res.json({
    ...withNumber(incident), form: parseForm(incident.form), resort: { name: tenant.name, legal_name: tenant.legal_name }, notes, events, responders, witnesses, signatures,
    collision: collisionRow || null, parties, checklist,
    patients: patients.map((p) => ({ ...p, form: parseForm(p.form), vitals: mine(vitals, p.id), injuries: mine(injuries, p.id), treatments: mine(treatments, p.id) })),
  });
});

/**
 * Loads a case for editing. Approved reports are locked. A submitted report is waiting for a manager, so only
 * managers change it until it is sent back. Row-locks the case so two phones cannot interleave a state change.
 */
async function editableCase(conn, req, id) {
  const inc = await one(conn, 'SELECT * FROM incidents WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
  if (!inc) throw notFound('Incident');
  if (inc.report_state === 'approved') throw conflict('This report is approved and locked. Add a note, or ask a manager to reopen it.');
  if (inc.report_state === 'submitted' && !(await PA.can(pool, req, 'approve_case'))) throw conflict('This report is waiting for an approver. Ask them to send it back if it needs changes.');
  return inc;
}

router.patch('/incidents/:id', patrol, needs('create_case'), validate(partialOf(incidentFields).extend({ status: z.enum(['open', 'closed']).optional() })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const inc = await editableCase(conn, req, id);
    const body = { ...req.body };
    if (body.occurred_at && seasonFor(body.occurred_at.slice(0, 10)) !== inc.season) delete body.occurred_at; // the case number stays with its season
    if (body.trail_id && !(body.form && body.form.run_classification) && !parseForm(inc.form).run_classification) {
      const cls = await runClassFor(conn, req.auth.tenantId, body.trail_id);
      if (cls) body.form = { ...(body.form || {}), run_classification: cls };
    }
    if (body.form) body.form = mergeForm(inc.form, body.form);
    const set = setClause(body, [...Object.keys(incidentFields), 'status']);
    if (!set) throw bad('No updatable fields supplied');
    await conn.query(`UPDATE incidents SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    await audit(conn, req, 'update', 'incidents', id, { fields: Object.keys(req.body).map((k) => (k === 'form' ? `form:${Object.keys(req.body.form).join('|')}` : k)) });
  });
  res.json({ ok: true });
});

router.post('/incidents/:id/notes', patrol, needs('create_case'), validate(z.object({ body: z.string().min(1).max(5000) })), async (req, res) => {
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Incident');
  const [r] = await pool.query('INSERT INTO incident_notes (tenant_id, incident_id, author_user, body) VALUES (?, ?, ?, ?)', [req.auth.tenantId, id, req.auth.userId, req.body.body]);
  await audit(pool, req, 'add_note', 'incidents', id);
  res.status(201).json({ id: r.insertId });
});

// ---------------------------------------------------------------- submit, approve, reopen
/** The value the form holds for one field of a case or patient row, whether it lives in a column or in the form JSON. */
function fieldValue(f, row, form) {
  if (f.type === 'gps') return row.gps_lat !== null && row.gps_lat !== undefined && row.gps_lng !== null && row.gps_lng !== undefined ? true : null;
  if (f.col) return row[f.col];
  return form[f.key];
}

/**
 * What a finished report must contain. Returned as a list so the screen can show every gap at once.
 * The patrol administrator decides which form fields are mandatory (see lib/formconfig); a field that depends on
 * another answer (ambulance code only when leaving by ambulance) is only checked when it applies.
 */
async function reportProblems(conn, tenantId, inc) {
  // Each problem is { message, ...where }: the screen turns it into a link that opens and highlights the field.
  //   where = { scope: 'case' | 'patient', section, field, patient_id } for a form field, or { area } for the summary, patients, responders or signatures.
  const problems = [];
  const problem = (message, where = {}) => problems.push({ message, ...where });
  if (!inc.summary || !inc.summary.trim()) problem('Add a one-line summary', { area: 'summary' });
  if (!CLINICAL_CATEGORIES.includes(inc.category)) return problems;
  const required = await requiredFields(conn, tenantId);
  const patients = await rows(conn, 'SELECT * FROM incident_patients WHERE tenant_id = ? AND incident_id = ?', [tenantId, inc.id]);
  if (!patients.length) problem('Add at least one patient', { area: 'patients' });
  const signatures = await rows(conn, 'SELECT patient_id, kind FROM incident_signatures WHERE tenant_id = ? AND incident_id = ?', [tenantId, inc.id]);
  const witnesses = await one(conn, 'SELECT COUNT(*) AS n FROM incident_witnesses WHERE tenant_id = ? AND incident_id = ?', [tenantId, inc.id]);
  const title = new Map(SECTIONS.map((x) => [x.id, x.title]));

  // Case-level fields (location, conditions, witnesses, sign-off)
  const caseForm = parseForm(inc.form);
  const caseVals = Object.fromEntries(FIELDS.filter((f) => f.scope === 'case').map((f) => [f.key, fieldValue(f, inc, caseForm)]));
  for (const f of FIELDS.filter((x) => x.scope === 'case' && required.case.has(x.key))) {
    if (!applies(f, caseVals)) continue;
    let missing;
    if (f.type === 'witnesses') missing = !Number(witnesses.n) && !caseForm.witnesses_none;
    else if (f.type === 'signature') missing = !signatures.some((s) => s.kind === f.kind);
    else missing = isEmpty(caseVals[f.key]);
    if (missing) problem(`${title.get(f.section)}: ${f.label}`, { scope: 'case', section: f.section, field: f.key });
  }

  // Patient-level fields
  for (const p of patients) {
    const who = `${p.first_name} ${p.last_name}`.trim();
    const form = parseForm(p.form);
    const vals = Object.fromEntries(FIELDS.filter((f) => f.scope === 'patient').map((f) => [f.key, fieldValue(f, p, form)]));
    for (const f of FIELDS.filter((x) => x.scope === 'patient' && required.patient.has(x.key))) {
      if (!applies(f, vals)) continue;
      let missing;
      if (f.type === 'signature') missing = !signatures.some((s) => s.kind === f.kind && (s.patient_id === p.id || s.patient_id === null));
      else missing = isEmpty(vals[f.key]);
      if (missing) problem(`${who}: ${f.label}`, { scope: 'patient', patient_id: p.id, section: f.section, field: f.key });
    }
    // Safety rule that no setting can switch off: a refusal of care needs a signed refusal.
    if (p.disposition === 'refused_care' && !signatures.some((s) => s.kind === 'refusal_of_care' && s.patient_id === p.id)) {
      problem(`${who}: refused care, so a refusal signature is needed`, { area: 'signatures' });
    }
  }
  const lead = await one(conn, "SELECT id FROM incident_responders WHERE tenant_id = ? AND incident_id = ? AND role = 'lead'", [tenantId, inc.id]);
  if (!lead) problem('Add the patroller who led the response', { area: 'responders' });
  return problems;
}

async function setState(req, res, { from, to, check, extra }) {
  const id = paramId(req);
  await tx(async (conn) => {
    const inc = await one(conn, 'SELECT * FROM incidents WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!inc) throw notFound('Incident');
    if (!from.includes(inc.report_state)) throw conflict(`This report is ${inc.report_state}`);
    if (check) {
      const problems = await reportProblems(conn, req.auth.tenantId, inc);
      if (problems.length) throw conflict('The report is not complete yet', problems);
    }
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
    await extra(conn, inc, nowIn(tenant.timezone));
    await audit(conn, req, to, 'incidents', id);
  });
  res.json({ ok: true });
}

router.post('/incidents/:id/submit', patrol, needs('submit_case'), (req, res) => setState(req, res, {
  from: ['draft'], to: 'submit', check: true,
  extra: (conn, inc, now) => conn.query("UPDATE incidents SET report_state = 'submitted', submitted_by = ?, submitted_at = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, now, inc.tenant_id, inc.id]),
}));

router.post('/incidents/:id/approve', patrol, needs('approve_case'), (req, res) => setState(req, res, {
  from: ['draft', 'submitted'], to: 'approve', check: true,
  extra: (conn, inc, now) => conn.query("UPDATE incidents SET report_state = 'approved', status = 'closed', approved_by = ?, approved_at = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, now, inc.tenant_id, inc.id]),
}));

router.post('/incidents/:id/reopen', patrol, needs('approve_case'), validate(z.object({ reason: z.string().min(3).max(500) })), (req, res) => setState(req, res, {
  from: ['submitted', 'approved'], to: 'reopen', check: false,
  extra: async (conn, inc) => {
    await conn.query("UPDATE incidents SET report_state = 'draft', status = 'open', approved_by = NULL, approved_at = NULL WHERE tenant_id = ? AND id = ?", [inc.tenant_id, inc.id]);
    await conn.query('INSERT INTO incident_notes (tenant_id, incident_id, author_user, body) VALUES (?, ?, ?, ?)', [inc.tenant_id, inc.id, req.auth.userId, `Reopened by a manager: ${req.body.reason}`]);
  },
}));

// ---------------------------------------------------------------- patients
const patientFields = {
  person_id: z.number().int().positive().nullable().optional(),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  date_of_birth: dateStr.nullable().optional(),
  age_years: z.number().int().min(0).max(120).nullable().optional(),
  sex: z.enum(['female', 'male', 'other', 'unknown']).optional(),
  phone: z.string().max(40).nullable().optional(),
  home_town: z.string().max(100).nullable().optional(),
  activity: z.enum(['ski', 'snowboard', 'other_snow', 'pedestrian', 'staff', 'other']).nullable().optional(),
  ability: z.enum(['beginner', 'intermediate', 'advanced', 'expert']).nullable().optional(),
  helmet: z.enum(['yes', 'no', 'unknown']).optional(),
  rental_equipment: z.enum(['yes', 'no', 'unknown']).optional(),
  chief_complaint: z.string().max(255).nullable().optional(),
  mechanism: z.string().max(500).nullable().optional(),
  allergies: z.string().max(500).nullable().optional(),
  medications: z.string().max(500).nullable().optional(),
  medical_history: z.string().max(1000).nullable().optional(),
  last_oral_intake: z.string().max(255).nullable().optional(),
  assessment: z.string().max(20000).nullable().optional(),
  disposition: z.enum(['treated_released', 'transported_ambulance', 'transported_private', 'refused_care', 'no_injury', 'referred', 'other']).nullable().optional(),
  destination: z.string().max(255).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  guardian_name: z.string().max(150).nullable().optional(),
  guardian_email: z.string().email().max(255).nullable().optional(),
  no_followup: z.boolean().transform((v) => (v ? 1 : 0)).optional(),
  form: formSchema('patient').optional(),
};
const patientCols = Object.keys(patientFields);

// ---------------------------------------------------------------- one-way pull from the customer record
const unset = (v) => v === null || v === undefined || v === '' || v === 'unknown';
/** Patient columns and form values to copy in from a pull. Only blanks are filled: what patrol has entered always wins. */
function fillBlanks(current, pull, currentForm) {
  const cols = {};
  for (const [k, v] of Object.entries(pull.suggested.patient)) {
    if (v === null || v === undefined) continue;
    if (unset(current[k])) cols[k] = v;
  }
  const form = {};
  const have = parseForm(currentForm !== undefined ? currentForm : current.form);
  for (const [k, v] of Object.entries(pull.suggested.form)) if (isEmpty(have[k])) form[k] = v;
  return { cols, form };
}

/** Preview of what patrol can pull in for a guest: their ticket, gear on the incident day, and the details we hold. */
router.get('/pull/:personId', patrol, needs('create_case'), async (req, res) => {
  const personId = paramId(req, 'personId');
  let at = nowIn((await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone);
  if (req.query.incident_id) {
    const inc = await one(pool, 'SELECT occurred_at FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, Number(req.query.incident_id)]);
    if (!inc) throw notFound('Incident');
    at = inc.occurred_at;
  }
  const pull = await buildPull(pool, req.auth.tenantId, personId, at);
  if (!pull) throw notFound('Person');
  await audit(pool, req, 'pull_preview', 'people', personId, req.query.incident_id ? { incident_id: Number(req.query.incident_id) } : null);
  res.json(pull);
});

/** Refresh a patient from their customer record. Blank fields only; nothing patrol entered is replaced. */
router.post('/incidents/:id/patients/:pid/pull', patrol, needs('create_case'), validate(z.object({ person_id: z.number().int().positive().optional() })), async (req, res) => {
  const id = paramId(req);
  const pid = paramId(req, 'pid');
  const out = await tx(async (conn) => {
    const inc = await editableCase(conn, req, id);
    const pat = await one(conn, 'SELECT * FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id, pid]);
    if (!pat) throw notFound('Patient');
    const personId = req.body.person_id || pat.person_id;
    if (!personId) throw bad('Link this patient to a guest on file first');
    const pull = await buildPull(conn, req.auth.tenantId, personId, inc.occurred_at);
    if (!pull) throw notFound('Person');
    const fill = fillBlanks(pat, pull);
    const cols = { ...fill.cols, person_id: personId };
    const set = setClause({ ...cols, ...(Object.keys(fill.form).length ? { form: mergeForm(pat.form, fill.form) } : {}) }, [...patientCols]);
    await conn.query(`UPDATE incident_patients SET ${set.sql} WHERE tenant_id = ? AND incident_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id, pid]);
    const fields = [...Object.keys(fill.cols), ...Object.keys(fill.form).map((k) => `form:${k}`)];
    await audit(conn, req, 'pull_from_customer', 'incidents', id, { patient_id: pid, person_id: personId, fields });
    return fields;
  });
  res.json({ filled: out });
});

router.post('/incidents/:id/patients', patrol, needs('create_case'), validate(z.object({ ...patientFields, first_name: patientFields.first_name.optional(), last_name: patientFields.last_name.optional() })), async (req, res) => {
  const id = paramId(req);
  const out = await tx(async (conn) => {
    const inc = await editableCase(conn, req, id);
    const data = { ...req.body };
    let pulled = [];
    if (data.person_id) {
      const pull = await buildPull(conn, req.auth.tenantId, data.person_id, inc.occurred_at);
      if (!pull) throw notFound('Person');
      const fill = fillBlanks(data, pull);
      Object.assign(data, fill.cols);
      data.form = { ...fill.form, ...(data.form || {}) };
      pulled = [...Object.keys(fill.cols), ...Object.keys(fill.form).map((k) => `form:${k}`)];
    }
    if (data.date_of_birth && (data.age_years === undefined || data.age_years === null)) {
      const age = ageOn(data.date_of_birth, dayOf(inc.occurred_at));
      if (age !== null) data.age_years = age;
    }
    if (inc.category === 'collision' && !(data.form && data.form.collided)) data.form = { ...(data.form || {}), collided: 'yes' };
    if (data.form) data.form = mergeForm(null, data.form);
    if (!data.first_name || !data.last_name) { data.first_name = data.first_name || 'Unknown'; data.last_name = data.last_name || 'Patient'; }
    const keys = Object.keys(data).filter((k) => patientCols.includes(k));
    const [r] = await conn.query(`INSERT INTO incident_patients (tenant_id, incident_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`, [req.auth.tenantId, id, ...keys.map((k) => data[k])]);
    await summaryFromComplaint(conn, req.auth.tenantId, inc, data.chief_complaint, null);
    await audit(conn, req, 'add_patient', 'incidents', id, { patient_id: r.insertId, ...(pulled.length ? { pulled_from_customer: data.person_id, pulled } : {}) });
    return r.insertId;
  });
  res.status(201).json({ id: out });
});

router.patch('/incidents/:id/patients/:pid', patrol, needs('create_case'), validate(partialOf(patientFields)), async (req, res) => {
  const id = paramId(req);
  const pid = paramId(req, 'pid');
  await tx(async (conn) => {
    const inc = await editableCase(conn, req, id);
    const body = { ...req.body };
    const cur = await one(conn, 'SELECT form, chief_complaint, age_years FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, pid]);
    if (!cur) throw notFound('Patient');
    if (body.form) body.form = mergeForm(cur.form, body.form);
    if (body.date_of_birth && body.age_years === undefined) {
      const age = ageOn(body.date_of_birth, dayOf(inc.occurred_at));
      if (age !== null) body.age_years = age;
    }
    const set = setClause(body, patientCols);
    if (!set) throw bad('No updatable fields supplied');
    const [r] = await conn.query(`UPDATE incident_patients SET ${set.sql} WHERE tenant_id = ? AND incident_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id, pid]);
    if (!r.affectedRows) throw notFound('Patient');
    if (body.chief_complaint !== undefined) await summaryFromComplaint(conn, req.auth.tenantId, inc, body.chief_complaint, cur.chief_complaint);
    await audit(conn, req, 'update_patient', 'incidents', id, { patient_id: pid, fields: Object.keys(req.body) });
  });
  res.json({ ok: true });
});

router.delete('/incidents/:id/patients/:pid', patrol, needs('create_case'), async (req, res) => {
  const id = paramId(req);
  const pid = paramId(req, 'pid');
  await tx(async (conn) => {
    await editableCase(conn, req, id);
    const p = await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, pid]);
    if (!p) throw notFound('Patient');
    if (await one(conn, 'SELECT id FROM incident_signatures WHERE tenant_id = ? AND patient_id = ? LIMIT 1', [req.auth.tenantId, pid])) throw conflict('This patient has a signature on file, so the record cannot be removed');
    await conn.query('UPDATE incident_parties SET patient_id = NULL WHERE tenant_id = ? AND patient_id = ?', [req.auth.tenantId, pid]);
    await conn.query('DELETE FROM incident_checklist WHERE tenant_id = ? AND patient_id = ?', [req.auth.tenantId, pid]);
    await conn.query("DELETE FROM followups WHERE tenant_id = ? AND patient_id = ? AND status <> 'sent'", [req.auth.tenantId, pid]);
    for (const t of ['incident_vitals', 'incident_injuries', 'incident_treatments']) await conn.query(`DELETE FROM ${t} WHERE tenant_id = ? AND patient_id = ?`, [req.auth.tenantId, pid]);
    await conn.query('DELETE FROM incident_patients WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, pid]);
    await audit(conn, req, 'remove_patient', 'incidents', id, { patient_id: pid });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- patient and case sub-records
const timeDefault = (field) => async (conn, req, body) => (body[field] ? body[field] : nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone));
const optionalTime = (field) => ({ [field]: dateTimeStr.transform(normDateTime).optional() });

const sub = {
  vitals: {
    table: 'incident_vitals', level: 'patient', time: 'taken_at',
    schema: z.object({
      ...optionalTime('taken_at'),
      pulse: z.number().int().min(0).max(300).optional(), resp: z.number().int().min(0).max(80).optional(),
      bp_sys: z.number().int().min(0).max(300).optional(), bp_dia: z.number().int().min(0).max(200).optional(),
      spo2: z.number().int().min(0).max(100).optional(), gcs: z.number().int().min(3).max(15).optional(), pain: z.number().int().min(0).max(10).optional(),
      avpu: z.enum(['alert', 'verbal', 'pain', 'unresponsive']).optional(), pupils: z.string().max(40).optional(), skin: z.string().max(60).optional(),
      temp_c: z.number().min(20).max(45).optional(), glucose: z.number().int().min(0).max(1500).optional(), notes: z.string().max(255).optional(),
    }).refine((v) => Object.keys(v).some((k) => !['taken_at', 'notes'].includes(k)), 'Record at least one measurement'),
    cols: ['taken_at', 'pulse', 'resp', 'bp_sys', 'bp_dia', 'spo2', 'gcs', 'pain', 'avpu', 'pupils', 'skin', 'temp_c', 'glucose', 'notes'], recorder: 'recorded_by',
  },
  injuries: {
    table: 'incident_injuries', level: 'patient',
    schema: z.object({
      body_region: z.enum(['head', 'face', 'neck', 'shoulder', 'arm', 'elbow', 'wrist_hand', 'chest', 'back', 'abdomen', 'pelvis', 'hip', 'thigh', 'knee', 'lower_leg', 'ankle_foot', 'multiple', 'other']),
      side: z.enum(['left', 'right', 'both', 'midline', 'na']).default('na'),
      injury_type: z.enum(['fracture', 'dislocation', 'sprain_strain', 'laceration', 'contusion', 'concussion', 'spinal', 'internal', 'cold_injury', 'illness', 'cardiac', 'other']),
      notes: z.string().max(255).optional(),
    }),
    cols: ['body_region', 'side', 'injury_type', 'notes'],
  },
  treatments: {
    table: 'incident_treatments', level: 'patient', time: 'performed_at',
    schema: z.object({
      ...optionalTime('performed_at'),
      kind: z.enum(['splint', 'spinal_motion_restriction', 'bandage', 'ice', 'oxygen', 'aed', 'cpr', 'airway', 'medication', 'warming', 'other']),
      description: z.string().max(255).optional(), medication: z.string().max(100).optional(), dose: z.string().max(50).optional(), route: z.string().max(30).optional(),
      performed_by_staff: z.number().int().positive().optional(),
    }).refine((v) => v.kind !== 'medication' || (v.medication && v.dose), 'A medication needs a name and a dose'),
    cols: ['performed_at', 'kind', 'description', 'medication', 'dose', 'route', 'performed_by_staff'], recorder: 'recorded_by',
  },
  events: {
    table: 'incident_events', level: 'incident', time: 'at',
    schema: z.object({ ...optionalTime('at'), kind: z.enum(['call_received', 'dispatched', 'on_scene', 'patient_contact', 'transport_started', 'at_aid_room', 'handoff', 'cleared', 'other']), note: z.string().max(255).optional() }),
    cols: ['at', 'kind', 'note'], recorder: 'recorded_by',
  },
  witnesses: {
    table: 'incident_witnesses', level: 'incident',
    schema: z.object({
      relation: z.enum(['witnessed_by', 'accompanied_by', 'collided_with', 'other']).optional(),
      name: z.string().min(1).max(150), phone: z.string().max(40).optional(), email: z.string().email().max(255).optional(),
      address: z.string().max(255).optional(), city: z.string().max(100).optional(), region: z.string().max(60).optional(), postal: z.string().max(20).optional(),
      statement: z.string().max(10000).optional(),
    }),
    cols: ['relation', 'name', 'phone', 'email', 'address', 'city', 'region', 'postal', 'statement'],
  },
};

for (const [name, def] of Object.entries(sub)) {
  const base = def.level === 'patient' ? `/incidents/:id/patients/:pid/${name}` : `/incidents/:id/${name}`;
  const parentCol = def.level === 'patient' ? 'patient_id' : 'incident_id';

  const parentId = async (conn, req, id) => {
    if (def.level !== 'patient') return id;
    const pid = paramId(req, 'pid');
    if (!(await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, pid]))) throw notFound('Patient');
    return pid;
  };

  router.post(base, patrol, needs('create_case'), validate(def.schema), async (req, res) => {
    const id = paramId(req);
    const newId = await tx(async (conn) => {
      await editableCase(conn, req, id);
      const parent = await parentId(conn, req, id);
      const data = { ...req.body };
      if (def.time) data[def.time] = await timeDefault(def.time)(conn, req, data);
      const keys = Object.keys(data).filter((k) => def.cols.includes(k));
      const extraCols = def.recorder ? [def.recorder] : [];
      const [r] = await conn.query(
        `INSERT INTO \`${def.table}\` (tenant_id, ${parentCol}, ${[...keys, ...extraCols].map((k) => `\`${k}\``).join(', ')}) VALUES (?, ?, ${[...keys, ...extraCols].map(() => '?').join(', ')})`,
        [req.auth.tenantId, parent, ...keys.map((k) => data[k]), ...(def.recorder ? [req.auth.userId] : [])],
      );
      await audit(conn, req, `add_${name}`, 'incidents', id, { row: r.insertId });
      return r.insertId;
    });
    res.status(201).json({ id: newId });
  });

  router.delete(`${base}/:rowId`, patrol, needs('create_case'), async (req, res) => {
    const id = paramId(req);
    await tx(async (conn) => {
      await editableCase(conn, req, id);
      const parent = await parentId(conn, req, id);
      const [r] = await conn.query(`DELETE FROM \`${def.table}\` WHERE tenant_id = ? AND ${parentCol} = ? AND id = ?`, [req.auth.tenantId, parent, paramId(req, 'rowId')]);
      if (!r.affectedRows) throw notFound('Record');
      await audit(conn, req, `remove_${name}`, 'incidents', id, { row: paramId(req, 'rowId') });
    });
    res.status(204).end();
  });
}

/** Printing or copying a hand-off sheet puts patient information in someone else's hands, so it is logged. */
router.post('/incidents/:id/patients/:pid/handoff-printed', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req); const pid = paramId(req, 'pid');
  if (!(await one(pool, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, pid]))) throw notFound('Patient');
  await audit(pool, req, 'handoff_print', 'incidents', id, { patient_id: pid });
  res.status(204).end();
});

// ---------------------------------------------------------------- responders
router.post('/incidents/:id/responders', patrol, needs('create_case'), validate(z.object({ staff_id: z.number().int().positive(), role: z.enum(['lead', 'assist', 'transport', 'dispatch']).default('assist') })), async (req, res) => {
  const id = paramId(req);
  const newId = await tx(async (conn) => {
    await editableCase(conn, req, id);
    if (!(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, req.body.staff_id]))) throw notFound('Staff member');
    // There is exactly one lead. Naming a new lead moves the old one to assist.
    if (req.body.role === 'lead') await conn.query("UPDATE incident_responders SET role = 'assist' WHERE tenant_id = ? AND incident_id = ? AND role = 'lead'", [req.auth.tenantId, id]);
    const [r] = await conn.query(
      'INSERT INTO incident_responders (tenant_id, incident_id, staff_id, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), id = LAST_INSERT_ID(id)',
      [req.auth.tenantId, id, req.body.staff_id, req.body.role],
    );
    await audit(conn, req, 'add_responders', 'incidents', id, req.body);
    return r.insertId;
  });
  res.status(201).json({ id: newId });
});

router.delete('/incidents/:id/responders/:rowId', patrol, needs('create_case'), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await editableCase(conn, req, id);
    const [r] = await conn.query('DELETE FROM incident_responders WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, paramId(req, 'rowId')]);
    if (!r.affectedRows) throw notFound('Responder');
    await audit(conn, req, 'remove_responders', 'incidents', id, { row: paramId(req, 'rowId') });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- signatures (add only, and allowed while a report is open)
const MAX_SIGNATURE_CHARS = 90_000; // a drawn signature is a few KB; this also keeps requests under the 100 KB body limit
router.post(
  '/incidents/:id/signatures',
  patrol, needs('create_case'),
  validate(z.object({
    kind: z.enum(['refusal_of_care', 'patient_acknowledgment', 'witness', 'patroller']),
    signer_name: z.string().min(1).max(150),
    patient_id: z.number().int().positive().optional(),
    image: z.string().max(MAX_SIGNATURE_CHARS).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, 'The signature must be a PNG image'),
  })),
  async (req, res) => {
    const id = paramId(req);
    const b = req.body;
    const newId = await tx(async (conn) => {
      await editableCase(conn, req, id);
      if (b.patient_id && !(await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, b.patient_id]))) throw notFound('Patient');
      const [r] = await conn.query('INSERT INTO incident_signatures (tenant_id, incident_id, patient_id, kind, signer_name, image, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, id, b.patient_id ?? null, b.kind, b.signer_name, b.image, req.auth.userId]);
      await audit(conn, req, 'add_signature', 'incidents', id, { kind: b.kind, row: r.insertId });
      return r.insertId;
    });
    res.status(201).json({ id: newId });
  },
);

router.get('/incidents/:id/signatures/:rowId', patrol, needs('view_cases'), async (req, res) => {
  const row = await one(pool, 'SELECT id, patient_id, kind, signer_name, image, signed_at FROM incident_signatures WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, paramId(req), paramId(req, 'rowId')]);
  if (!row) throw notFound('Signature');
  await audit(pool, req, 'view_signature', 'incidents', paramId(req), { row: row.id });
  res.json(row);
});

// ---------------------------------------------------------------- trail checks
router.post('/trail-checks', patrol, needs('trail_checks'), validate(z.object({ trail_id: z.number().int().positive(), checked_by: z.number().int().positive().optional(), hazards: z.string().max(500).optional() })), async (req, res) => {
  const b = req.body;
  if (!(await one(pool, 'SELECT id FROM trails WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, b.trail_id]))) throw notFound('Trail');
  const [r] = await pool.query('INSERT INTO trail_checks (tenant_id, trail_id, checked_by, hazards) VALUES (?, ?, ?, ?)', [req.auth.tenantId, b.trail_id, b.checked_by ?? req.auth.staffId ?? null, b.hazards ?? null]);
  res.status(201).json({ id: r.insertId });
});

router.get('/trail-checks', patrol, needs('trail_checks'), async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT c.*, t.name AS trail FROM trail_checks c JOIN trails t ON t.id = c.trail_id AND t.tenant_id = c.tenant_id WHERE c.tenant_id = ? ORDER BY c.checked_at DESC LIMIT 200', [req.auth.tenantId]) });
});

router.createCase = createCase;
router.editableCase = editableCase;
module.exports = router;
