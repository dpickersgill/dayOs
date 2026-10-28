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
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const R = require('../lib/review');
const { audit } = require('../lib/audit');
const { formSchema, parseForm, mergeForm, isEmpty } = require('../lib/nsaar');
const RQ = require('../lib/requirements');
const LEAVE = require('../lib/leavecheck');
const { buildPull, ageOn } = require('../lib/patrolpull');
const { derive, parseDetail } = require('../lib/carederive');
const MEDS = require('./patrolmeds');
const OPS = require('../lib/patrolops');
const { checkCase } = require('../lib/reportcheck');
const SF = require('../lib/storyfill');
const staffInjury = require('../lib/staffinjury');
const COND = require('../lib/caseconditions');
const { baseUrl } = require('../lib/baseurl');

const router = express.Router();
// Incident records can contain injury details about guests, so access is limited to patrol and managers.
const patrol = requireRole('patrol', 'manager');
const PA = require('../lib/patrolaccess');
const { stepUp } = require('../lib/stepup');
const needs = (feature, message) => PA.needs(pool, feature, message);

const CLINICAL_CATEGORIES = ['injury', 'medical'];
const plusMin = (dt, m) => new Date(Date.parse(`${String(dt).replace(' ', 'T')}Z`) + m * 60000).toISOString().slice(0, 19).replace('T', ' ');
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
  lift_id: z.number().int().positive().nullable().optional(),
  lift_chair: z.string().trim().max(12).nullable().optional(),
  form: formSchema('case').optional(),
};

/**
 * Saves the conditions at the time of the case (lib/caseconditions): what the mountain's records said about the trail,
 * grooming, snow, weather and the lift. Taken when the case is opened and again when its time, trail or lift changes.
 */
async function takeConditions(conn, tenantId, id) {
  const inc = await one(conn, 'SELECT occurred_at, trail_id, lift_id FROM incidents WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  const now = nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
  const snap = await COND.snapshot(conn, tenantId, { at: inc.occurred_at, trailId: inc.trail_id, liftId: inc.lift_id, now });
  await conn.query('UPDATE incidents SET conditions = ? WHERE tenant_id = ? AND id = ?', [JSON.stringify(snap), tenantId, id]);
  return snap;
}
// Started on a phone with no signal: the phone's own id makes a repeat send find the case it already made.
const quickFields = {
  client_ref: z.string().regex(/^[a-z0-9]{6,40}$/).optional(),
  patient: z.object({ first_name: z.string().trim().max(100).optional(), last_name: z.string().trim().max(100).optional(), age_years: z.number().int().min(0).max(120).optional(), chief_complaint: z.string().trim().max(255).optional() }).optional(),
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
  const { n } = await one(conn, 'SELECT COUNT(*) AS n FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND voided_at IS NULL', [tenantId, inc.id]);
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
        const { patient, ...rest } = body;
        if (rest.client_ref) {
          const seen = await one(conn, 'SELECT id, season, seq FROM incidents WHERE tenant_id = ? AND client_ref = ?', [req.auth.tenantId, rest.client_ref]);
          if (seen) {
            const first = await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? ORDER BY id LIMIT 1', [req.auth.tenantId, seen.id]);
            return { id: seen.id, case_number: `${seen.season}-${String(seen.seq).padStart(4, '0')}`, status: 'open', report_state: 'draft', repeat: true, patient_id: first ? first.id : null };
          }
        }
        const data = { ...rest, season, seq: n };
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
        let patientId = null;
        if (patient && (patient.first_name || patient.last_name || patient.chief_complaint)) {
          [{ insertId: patientId }] = await conn.query('INSERT INTO incident_patients (tenant_id, incident_id, first_name, last_name, age_years, chief_complaint) VALUES (?, ?, ?, ?, ?, ?)',
            [req.auth.tenantId, r.insertId, patient.first_name || 'Unknown', patient.last_name || 'Patient', patient.age_years ?? null, patient.chief_complaint || null]);
          if (patient.chief_complaint && !body.summary) await conn.query('UPDATE incidents SET summary = ? WHERE tenant_id = ? AND id = ?', [patient.chief_complaint.slice(0, 500), req.auth.tenantId, r.insertId]);
        }
        await takeConditions(conn, req.auth.tenantId, r.insertId);
        await audit(conn, req, 'create', 'incidents', r.insertId, { category: body.category, severity: body.severity, case: `${season}-${n}`, ...(body.client_ref ? { offline: true } : {}) });
        return { id: r.insertId, case_number: `${season}-${String(n).padStart(4, '0')}`, status: 'open', report_state: 'draft', patient_id: patientId };
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
}

router.post('/incidents', patrol, needs('create_case'), validate(z.object({ ...incidentFields, ...quickFields })), async (req, res) => {
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
            (SELECT COUNT(*) FROM incident_patients p WHERE p.tenant_id = i.tenant_id AND p.incident_id = i.id AND p.voided_at IS NULL) AS patient_count
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
  const data = await rows(pool, `SELECT a.id, a.at, a.action, a.entity, a.entity_id, a.detail, a.user_id, COALESCE(u.email, u.username) AS user_email, i.season, i.seq
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
router.get('/incidents.csv', patrol, needs('reports'), stepUp('download case records'), async (req, res) => {
  const { where, params } = filters(req);
  const data = await rows(
    pool,
    `SELECT i.id, i.season, i.seq, i.occurred_at, i.location, i.category, i.severity, i.disposition, i.status, i.report_state,
            (SELECT COUNT(*) FROM incident_patients p WHERE p.tenant_id = i.tenant_id AND p.incident_id = i.id AND p.voided_at IS NULL) AS patients
     FROM incidents i WHERE ${where} ORDER BY i.occurred_at`,
    params,
  );
  const out = data.map((r) => ({ ...r, case_number: caseNumber(r) }));
  const cols = ['case_number', 'id', 'occurred_at', 'location', 'category', 'severity', 'disposition', 'status', 'report_state', 'patients'];
  await audit(pool, req, 'export', 'incidents', null, { rows: data.length });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="incidents.csv"').send(toCsv(cols, out));
});

/** One row per patient with structured fields only (no names, no free text), for injury statistics. */
router.get('/patients.csv', patrol, needs('reports'), stepUp('download patient statistics'), async (req, res) => {
  const { where, params } = filters(req);
  const data = await rows(
    pool,
    `SELECT i.season, i.seq, i.occurred_at, p.age_years, p.sex, p.activity, p.ability, p.helmet, p.rental_equipment, p.disposition,
            (SELECT GROUP_CONCAT(CONCAT(j.body_region, ':', j.injury_type) SEPARATOR ' | ') FROM incident_injuries j WHERE j.tenant_id = p.tenant_id AND j.patient_id = p.id AND j.voided_at IS NULL) AS injuries
     FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id
     WHERE ${where} AND p.voided_at IS NULL ORDER BY i.occurred_at, p.id`,
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
    one(pool, `SELECT COUNT(*) AS cases, (SELECT COUNT(*) FROM incident_patients p JOIN incidents x ON x.id = p.incident_id AND x.tenant_id = p.tenant_id WHERE x.tenant_id = ? AND DATE(x.occurred_at) BETWEEN ? AND ? AND p.voided_at IS NULL) AS patients,
      (SELECT COUNT(*) FROM incident_patients p JOIN incidents x ON x.id = p.incident_id AND x.tenant_id = p.tenant_id WHERE x.tenant_id = ? AND DATE(x.occurred_at) BETWEEN ? AND ? AND p.voided_at IS NULL AND NOT ${staffInjury.GUEST_SQL}) AS staff_patients FROM incidents i WHERE ${inRange}`, [...range, ...range, ...range]),
    group(`SELECT category AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY category ORDER BY n DESC`),
    group(`SELECT severity AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY severity ORDER BY n DESC`),
    group(`SELECT HOUR(occurred_at) AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY label ORDER BY label`),
    group(`SELECT DAYOFWEEK(occurred_at) - 1 AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY label ORDER BY label`),
    group(`SELECT COALESCE(t.name, i.location) AS label, COUNT(*) AS n FROM incidents i LEFT JOIN trails t ON t.id = i.trail_id AND t.tenant_id = i.tenant_id WHERE ${inRange} GROUP BY COALESCE(t.name, i.location) ORDER BY n DESC LIMIT 10`),
    group(`SELECT COALESCE(p.disposition, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.activity')), p.activity, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL AND ${staffInjury.GUEST_SQL} GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.ability')), p.ability, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL AND ${staffInjury.GUEST_SQL} GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.helmet')), p.helmet) AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL AND ${staffInjury.GUEST_SQL} AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.activity')), p.activity) IN ('ski','snowboard','other_snow','alpine','telemark','nordic','touring')) GROUP BY label`),
    group(`SELECT j.body_region AS label, COUNT(*) AS n FROM incident_injuries j JOIN incident_patients p ON p.id = j.patient_id AND p.tenant_id = j.tenant_id JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL AND j.voided_at IS NULL GROUP BY j.body_region ORDER BY n DESC`),
    group(`SELECT j.injury_type AS label, COUNT(*) AS n FROM incident_injuries j JOIN incident_patients p ON p.id = j.patient_id AND p.tenant_id = j.tenant_id JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL AND j.voided_at IS NULL GROUP BY j.injury_type ORDER BY n DESC`),
    one(pool, `SELECT
        AVG(TIMESTAMPDIFF(SECOND, call_at, scene_at)) / 60 AS call_to_scene_min,
        AVG(TIMESTAMPDIFF(SECOND, scene_at, aid_at)) / 60 AS scene_to_aid_room_min,
        SUM(call_at IS NOT NULL AND scene_at IS NOT NULL) AS timed_cases
      FROM (SELECT i.id,
              MIN(CASE WHEN e.kind = 'call_received' THEN e.at END) AS call_at,
              MIN(CASE WHEN e.kind = 'on_scene' THEN e.at END) AS scene_at,
              MIN(CASE WHEN e.kind = 'at_aid_room' THEN e.at END) AS aid_at
            FROM incidents i JOIN incident_events e ON e.incident_id = i.id AND e.tenant_id = i.tenant_id AND e.voided_at IS NULL
            WHERE ${inRange} GROUP BY i.id) t`, range),
    group(`SELECT CONCAT(pe.first_name, ' ', pe.last_name) AS label, COUNT(*) AS n
           FROM incident_responders r JOIN incidents i ON i.id = r.incident_id AND i.tenant_id = r.tenant_id
           JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id JOIN people pe ON pe.id = s.person_id AND pe.tenant_id = s.tenant_id
           WHERE ${inRange} AND r.role = 'lead' AND r.voided_at IS NULL GROUP BY r.staff_id, pe.first_name, pe.last_name ORDER BY n DESC LIMIT 10`),
    group(`SELECT report_state AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY report_state`),
  ]);
  const round = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
  res.json({
    from, to,
    cases: totals.cases, patients: totals.patients, visits,
    // Staff and volunteers hurt while working are patrol's work too, but they are not guests: they are left out of the
    // rate per 1,000 visits and the guest activity, ability and helmet figures.
    staff_patients_on_duty: Number(totals.staff_patients),
    patients_per_1000_visits: visits ? Math.round(((Number(totals.patients) - Number(totals.staff_patients)) / visits) * 10000) / 10 : null,
    by_category: byCategory, by_severity: bySeverity, by_hour: byHour, by_weekday: byWeekday, top_places: places,
    patients_by_disposition: disposition, patients_by_activity: activity, patients_by_ability: ability, helmet_use_on_snow: helmet,
    injuries_by_region: region, injuries_by_type: injuryType,
    response_times: { call_to_scene_min: round(response.call_to_scene_min), scene_to_aid_room_min: round(response.scene_to_aid_room_min), timed_cases: Number(response.timed_cases || 0) },
    cases_by_lead: byLead, report_states: states,
  });
});

// ---------------------------------------------------------------- one case, in full
/** The name of a login, for "who did this" columns: their person record, then their email or username. */
const PERSON_NAME = (col) => `(SELECT COALESCE(NULLIF(TRIM(CONCAT(COALESCE(pp.first_name, sp.first_name, ''), ' ', COALESCE(pp.last_name, sp.last_name, ''))), ''), uu.email, uu.username)
  FROM users uu LEFT JOIN people pp ON pp.tenant_id = uu.tenant_id AND pp.id = uu.person_id LEFT JOIN staff st2 ON st2.tenant_id = uu.tenant_id AND st2.id = uu.staff_id LEFT JOIN people sp ON sp.tenant_id = st2.tenant_id AND sp.id = st2.person_id
  WHERE uu.id = ${col})`;
const VOIDED_BY = (t) => `LEFT JOIN users vu ON vu.id = ${t}.voided_by AND vu.tenant_id = ${t}.tenant_id`;
/**
 * Everything on one case, as the case page and the frozen versions show it. Rows marked entered in error are included
 * (with who marked them and why) so the record shows them struck through. Each patient carries `derived`: the form
 * answers that can be worked out from the bedside entries.
 */
async function loadCase(conn, tenantId, id) {
  const incident = await one(conn, 'SELECT i.*, t.name AS trail, l.name AS lift FROM incidents i LEFT JOIN trails t ON t.id = i.trail_id AND t.tenant_id = i.tenant_id LEFT JOIN lifts l ON l.id = i.lift_id AND l.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND i.id = ?', [tenantId, id]);
  if (!incident) return null;
  const [notes, patients, events, responders, witnesses, signatures, collisionRow, parties, checklist, versions] = await Promise.all([
    rows(conn, 'SELECT n.id, n.author_user, COALESCE(u.email, u.username) AS author, n.body, n.created_at FROM incident_notes n LEFT JOIN users u ON u.id = n.author_user AND u.tenant_id = n.tenant_id WHERE n.tenant_id = ? AND n.incident_id = ? ORDER BY n.id', [tenantId, id]),
    rows(conn, `SELECT p.*, COALESCE(vu.email, vu.username) AS voided_by_email FROM incident_patients p ${VOIDED_BY('p')} WHERE p.tenant_id = ? AND p.incident_id = ? ORDER BY p.id`, [tenantId, id]),
    rows(conn, `SELECT e.id, e.kind, e.at, e.note, e.patient_id, e.entered_at, e.voided_at, e.void_reason, COALESCE(vu.email, vu.username) AS voided_by_email FROM incident_events e ${VOIDED_BY('e')} WHERE e.tenant_id = ? AND e.incident_id = ? ORDER BY e.at, e.id`, [tenantId, id]),
    rows(conn, `SELECT r.id, r.staff_id, r.role, p.first_name, p.last_name, m.patrol_number, m.callsign, r.voided_at, r.void_reason, COALESCE(vu.email, vu.username) AS voided_by_email FROM incident_responders r JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id LEFT JOIN patrol_members m ON m.staff_id = r.staff_id AND m.tenant_id = r.tenant_id ${VOIDED_BY('r')} WHERE r.tenant_id = ? AND r.incident_id = ? ORDER BY r.voided_at IS NOT NULL, FIELD(r.role, 'lead', 'assist', 'transport', 'dispatch'), r.id`, [tenantId, id]),
    rows(conn, `SELECT w.id, w.relation, w.name, w.phone, w.email, w.address, w.city, w.region, w.postal, w.statement, w.source, w.received_at, w.voided_at, w.void_reason, COALESCE(vu.email, vu.username) AS voided_by_email FROM incident_witnesses w ${VOIDED_BY('w')} WHERE w.tenant_id = ? AND w.incident_id = ? ORDER BY w.id`, [tenantId, id]), // source link: written by the witness (routes/patrolscene.js)
    rows(conn, 'SELECT id, patient_id, kind, signer_name, signer_role, signed_at FROM incident_signatures WHERE tenant_id = ? AND incident_id = ? ORDER BY id', [tenantId, id]),
    one(conn, 'SELECT * FROM incident_collisions WHERE tenant_id = ? AND incident_id = ?', [tenantId, id]),
    rows(conn, `SELECT x.*, COALESCE(vu.email, vu.username) AS voided_by_email FROM incident_parties x ${VOIDED_BY('x')} WHERE x.tenant_id = ? AND x.incident_id = ? ORDER BY x.id`, [tenantId, id]),
    rows(conn, 'SELECT c.patient_id, c.item_key, c.done_at, COALESCE(u.email, u.username) AS done_by FROM incident_checklist c LEFT JOIN users u ON u.id = c.done_by AND u.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.incident_id = ? ORDER BY c.id', [tenantId, id]),
    rows(conn, 'SELECT v.id, v.version_no, v.kind, v.created_at, COALESCE(u.email, u.username) AS created_by FROM incident_versions v LEFT JOIN users u ON u.id = v.created_by AND u.tenant_id = v.tenant_id WHERE v.tenant_id = ? AND v.incident_id = ? ORDER BY v.version_no', [tenantId, id]),
  ]);
  const ids = patients.map((p) => p.id);
  const byPatient = async (sql) => (ids.length ? rows(conn, sql, [tenantId, ids]) : []);
  const [vitals, injuries, treatments] = await Promise.all([
    byPatient(`SELECT x.*, COALESCE(vu.email, vu.username) AS voided_by_email FROM incident_vitals x ${VOIDED_BY('x')} WHERE x.tenant_id = ? AND x.patient_id IN (?) ORDER BY x.taken_at, x.id`),
    byPatient(`SELECT x.*, COALESCE(vu.email, vu.username) AS voided_by_email FROM incident_injuries x ${VOIDED_BY('x')} WHERE x.tenant_id = ? AND x.patient_id IN (?) ORDER BY x.id`),
    byPatient(`SELECT x.*, COALESCE(vu.email, vu.username) AS voided_by_email, CONCAT(pp.first_name, ' ', pp.last_name) AS performed_by_name FROM incident_treatments x ${VOIDED_BY('x')}
      LEFT JOIN staff st ON st.id = x.performed_by_staff AND st.tenant_id = x.tenant_id LEFT JOIN people pp ON pp.id = st.person_id AND pp.tenant_id = st.tenant_id
      WHERE x.tenant_id = ? AND x.patient_id IN (?) ORDER BY x.performed_at, x.id`),
  ]);
  for (const t of treatments) t.detail = parseDetail(t.detail);
  const mine = (list, pid) => list.filter((x) => x.patient_id === pid);
  const tenant = await one(conn, 'SELECT name, legal_name FROM tenants WHERE id = ?', [tenantId]);
  // Photos without their bytes: a frozen version records each one's fingerprint, so the approved report names the exact files.
  const photos = (await rows(conn, `SELECT m.id, m.patient_id, m.mime, m.bytes, m.sha256, m.caption, m.taken_at, m.taken_lat, m.taken_lng, m.uploaded_at, (m.preview IS NOT NULL) AS has_preview, m.preview_sha256,
      m.voided_at, m.void_reason, COALESCE(u.email, u.username) AS uploaded_by_name, COALESCE(vu.email, vu.username) AS voided_by_email
    FROM incident_media m LEFT JOIN users u ON u.id = m.uploaded_by AND u.tenant_id = m.tenant_id ${VOIDED_BY('m')} WHERE m.tenant_id = ? AND m.incident_id = ? ORDER BY m.id`, [tenantId, id]))
    .map((m) => ({ ...m, has_preview: Boolean(m.has_preview), taken_lat: m.taken_lat === null ? null : Number(m.taken_lat), taken_lng: m.taken_lng === null ? null : Number(m.taken_lng) }));
  // Items answered N/A (with the reason), checklist items skipped before the patient left, and items approved with an
  // exception. All three are part of the report: they travel with every frozen copy, including copies released outside.
  const [skips, exceptions, contacts, rentals] = await Promise.all([
    rows(conn, `SELECT s.id, s.patient_id, s.gate, s.item_key, s.reason, s.note, s.skipped_at, ${PERSON_NAME('s.skipped_by')} AS skipped_by FROM incident_skips s WHERE s.tenant_id = ? AND s.incident_id = ? ORDER BY s.id`, [tenantId, id]),
    rows(conn, `SELECT e.id, e.patient_id, e.scope, e.item_key AS \`key\`, e.label, e.reason, e.approved_at, ${PERSON_NAME('e.approved_by')} AS approved_by FROM incident_exceptions e WHERE e.tenant_id = ? AND e.incident_id = ? ORDER BY e.id`, [tenantId, id]),
    rows(conn, `SELECT x.id, x.patient_id, x.who, x.who_name, x.method, x.at, x.note, x.entered_at, x.voided_at, x.void_reason, ${PERSON_NAME('x.recorded_by')} AS recorded_by, COALESCE(vu.email, vu.username) AS voided_by_email
      FROM incident_contacts x ${VOIDED_BY('x')} WHERE x.tenant_id = ? AND x.incident_id = ? ORDER BY x.at, x.id`, [tenantId, id]),
    rows(conn, `SELECT r.id, r.patient_id, r.contract_id, r.rental_item_id, r.detail, r.held, r.released_at, r.inspection_note, r.added_at, ${PERSON_NAME('r.released_by')} AS released_by,
        r.voided_at, r.void_reason, COALESCE(vu.email, vu.username) AS voided_by_email
      FROM incident_rentals r ${VOIDED_BY('r')} WHERE r.tenant_id = ? AND r.incident_id = ? ORDER BY r.id`, [tenantId, id]),
  ]);
  const c = {
    ...withNumber(incident), form: parseForm(incident.form), na: RQ.naOf(incident), resort: { name: tenant.name, legal_name: tenant.legal_name }, notes, events, responders, witnesses, signatures,
    conditions: COND.parse(incident.conditions), contacts: contacts.map((x) => ({ ...x, patient_id: x.patient_id === null ? null : Number(x.patient_id) })),
    rentals: rentals.map((r) => ({ ...r, detail: COND.parse(r.detail) || {}, held: Boolean(Number(r.held)), patient_id: r.patient_id === null ? null : Number(r.patient_id) })),
    collision: collisionRow || null, parties, checklist, versions, photos, skips, exceptions: exceptions.map((e) => ({ ...e, patient_id: e.patient_id === null ? null : Number(e.patient_id) })),
    patients: patients.map((p) => ({ ...p, form: parseForm(p.form), na: RQ.naOf(p), vitals: mine(vitals, p.id), injuries: mine(injuries, p.id), treatments: mine(treatments, p.id) })),
  };
  for (const p of c.patients) p.derived = derive(c, p);
  return c;
}

router.get('/incidents/:id', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req);
  const c = await loadCase(pool, req.auth.tenantId, id);
  if (!c) throw notFound('Incident');
  await audit(pool, req, 'view', 'incidents', id); // reads of sensitive records are logged too
  c.review = await R.caseInfo(pool, req, c);
  c.requirements = await requirementsOf(pool, req, c);
  c.leave = RQ.optionsOf((await RQ.current(pool, req.auth.tenantId)).rules).leave ? LEAVE.items(c) : [];
  c.check = [...checkCase(c), ...recommendedChecks(c.requirements.items)]; // suggestions only: the patroller and the review group decide
  c.story_fill = SF.available() && (await OPS.settingsOf(pool, req.auth.tenantId)).story_fill;
  c.conditions_suggest = COND.suggest(c.conditions); // answers the Conditions section can take, for the patroller to confirm
  res.json(c);
});

/** The report check: gaps worth a second look before submitting. Never blocks; reportProblems decides what is required. */
router.get('/incidents/:id/check', patrol, needs('view_cases'), async (req, res) => {
  const c = await loadCase(pool, req.auth.tenantId, paramId(req));
  if (!c) throw notFound('Incident');
  const reqs = await requirementsOf(pool, req, c);
  res.json({ data: [...checkCase(c), ...recommendedChecks(reqs.items)] });
});

/**
 * What the patrol director requires of this case, answered or not, for the Report tab: counts by section, the next
 * missing item and the N/A answers. A submitted or approved report is shown against the rules it was submitted under.
 */
async function requirementsOf(db, req, c) {
  const set = c.report_state === 'draft' || !c.rules_version_id ? await RQ.current(db, req.auth.tenantId) : await RQ.version(db, req.auth.tenantId, c.rules_version_id);
  const items = RQ.evaluate(set.rules, c, { exceptions: c.exceptions || [] }).map((i) => ({ ...i, where: RQ.where(i), na_allowed: RQ.naAllowed(RQ.TYPE_KEYS.includes(c.category) ? c.category : 'other', i.id) }));
  return { rules_version_id: set.id, items, summary: RQ.summary(items), na_reasons: RQ.N_A.map(([value, label]) => ({ value, label })), can_except: c.report_state === 'submitted' ? await mayExcept(req) : false };
}
/** Recommended fields not answered yet join the report check: a suggestion, never a block. */
const recommendedChecks = (items) => items.filter((i) => i.level === 'recommended' && !i.met)
  .map((i) => ({ message: `${RQ.message(i)} is not filled in`, why: 'Your patrol director recommends this for every report like this one. Fill it in, or leave it if it really cannot be known.', ...RQ.where(i) }));

/**
 * N/A with a reason for a required item ("patient declined to answer", "left before it was asked"). The report shows the
 * reason instead of a blank. reason null takes the N/A away. Works from the outbox, so a phone with no signal can send it later.
 */
router.put('/incidents/:id/na', patrol, needs('create_case'), validate(z.object({
  scope: z.enum(['case', 'patient']), field: z.string().max(40), patient_id: z.number().int().positive().nullable().optional(),
  reason: z.enum(RQ.NA_KEYS).nullable(), note: z.string().trim().max(300).nullable().optional(),
})), async (req, res) => {
  const id = paramId(req);
  const b = req.body;
  await tx(async (conn) => {
    const inc = await editableCase(conn, req, id);
    const type = RQ.TYPE_KEYS.includes(inc.category) ? inc.category : 'other';
    if (!RQ.naAllowed(type, `${b.scope}.${b.field}`)) throw bad('That item cannot be answered N/A');
    if (b.reason === 'other' && !b.note) throw bad('Say why, when the reason is Other');
    const value = b.reason ? { reason: b.reason, ...(b.note ? { note: b.note } : {}), by: req.auth.userId, at: nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [inc.tenant_id])).timezone) } : null;
    let row; let table;
    if (b.scope === 'patient') {
      if (!b.patient_id) throw bad('Say which patient');
      row = await one(conn, 'SELECT id, na FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [inc.tenant_id, id, b.patient_id]);
      if (!row) throw notFound('Patient');
      table = 'incident_patients';
    } else { row = inc; table = 'incidents'; }
    const na = RQ.naOf(row);
    if (value) na[b.field] = value; else delete na[b.field];
    await conn.query(`UPDATE ${table} SET na = ? WHERE tenant_id = ? AND id = ?`, [Object.keys(na).length ? JSON.stringify(na) : null, inc.tenant_id, row.id]);
    await audit(conn, req, b.reason ? 'set_na' : 'clear_na', 'incidents', id, { scope: b.scope, field: b.field, patient_id: b.patient_id || null, reason: b.reason });
  });
  res.json({ ok: true });
});

/**
 * Fill in from the story: proposals for empty patient fields, read from the narrative. Nothing is saved here; the
 * patroller ticks what is right and the screen saves it through the patient update. Off unless the server has a key
 * and the mountain turned it on (Patrol, Settings), because the story is sent to the AI provider.
 */
router.post('/incidents/:id/story-fill', patrol, needs('create_case'), async (req, res) => {
  const id = paramId(req);
  if (!SF.available()) throw forbidden('Filling in from the story is not set up on this server');
  if (!(await OPS.settingsOf(pool, req.auth.tenantId)).story_fill) throw forbidden('Filling in from the story is turned off for this mountain. The patrol director can turn it on in Patrol, Settings.');
  const c = await loadCase(pool, req.auth.tenantId, id);
  if (!c) throw notFound('Incident');
  if (c.report_state === 'approved') throw conflict('This report is approved and locked');
  const data = await SF.propose(c);
  await audit(pool, req, 'story_fill', 'incidents', id, { proposals: data.length }); // the count only: no health details in the log
  res.json({ data });
});

/** The frozen copies kept each time the report was submitted or approved. */
router.get('/incidents/:id/versions/:vid', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req);
  const v = await one(pool, 'SELECT v.id, v.version_no, v.kind, v.snapshot, v.created_at, COALESCE(u.email, u.username) AS created_by FROM incident_versions v LEFT JOIN users u ON u.id = v.created_by AND u.tenant_id = v.tenant_id WHERE v.tenant_id = ? AND v.incident_id = ? AND v.id = ?', [req.auth.tenantId, id, paramId(req, 'vid')]);
  if (!v) throw notFound('Version');
  await audit(pool, req, 'view_version', 'incidents', id, { version: v.version_no });
  res.json({ id: v.id, version_no: v.version_no, kind: v.kind, created_at: v.created_at, created_by: v.created_by, case: JSON.parse(v.snapshot) });
});

/**
 * Loads a case for editing. Approved reports are locked. A submitted report is waiting for a manager, so only
 * managers change it until it is sent back. Row-locks the case so two phones cannot interleave a state change.
 */
// A wrong entry is marked entered in error, with a reason, and stays on the record (voidCaseRow below).
const voidSchema = z.object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(255) });

/**
 * The case, locked for a change, if it may be changed: not on legal hold (only notes are added then), not approved, and
 * not waiting for review. Every write to a case goes through this, except notes.
 */
async function editableCase(conn, req, id) {
  const inc = await one(conn, 'SELECT * FROM incidents WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
  if (!inc) throw notFound('Incident');
  if (Number(inc.legal_hold)) throw conflict('This case is on legal hold: nothing on it can change. Add a note instead.');
  if (inc.report_state === 'approved') throw conflict('This report is approved and locked. Add a note, or ask a manager to reopen it.');
  if (inc.report_state === 'submitted') {
    // With a review group, nobody edits a signed-off report: the reviewer sends it back with comments, so the
    // patroller's own account is never changed by someone else. Without one, approvers may still correct it.
    const s = await R.settingsOf(conn, req.auth.tenantId);
    if (s.enabled) throw conflict('This report is waiting for the review group. A reviewer can send it back with comments if it needs changes.');
    if (!(await PA.can(pool, req, 'approve_case'))) throw conflict('This report is waiting for an approver. Ask them to send it back if it needs changes.');
  }
  return inc;
}

/**
 * Marks one row on a case (a witness, responder, collision party or rental gear) entered in error, with the reason, who
 * and when. Like clinical entries, these are never deleted: the row stays on the record, struck through. Call after
 * editableCase, inside the same transaction. Returns the row as it was.
 */
async function voidCaseRow(conn, req, id, table, rowId, what) {
  const row = await one(conn, `SELECT * FROM \`${table}\` WHERE tenant_id = ? AND incident_id = ? AND id = ? FOR UPDATE`, [req.auth.tenantId, id, rowId]);
  if (!row) throw notFound(what);
  if (row.voided_at) throw conflict('Already marked entered in error');
  const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
  await conn.query(`UPDATE \`${table}\` SET voided_at = ?, void_reason = ?, voided_by = ? WHERE tenant_id = ? AND id = ?`, [nowIn(tz), req.body.reason, req.auth.userId, req.auth.tenantId, rowId]);
  return row;
}

/** After a change that could make a staff patient's case serious, tells the owner and GM if they have not been told. */
async function staffNotices(req, id) {
  for (const p of await rows(pool, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND voided_at IS NULL', [req.auth.tenantId, id])) await staffInjury.notifyIfDue(req.auth.tenantId, id, p.id, baseUrl(req));
}

router.patch('/incidents/:id', patrol, needs('create_case'), validate(partialOf(incidentFields).extend({ status: z.enum(['open', 'closed']).optional() })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const inc = await editableCase(conn, req, id);
    const body = { ...req.body };
    // Once a report has been signed off, its kind of case stays: changing it could take it out of review.
    if (body.category && body.category !== inc.category && Number(inc.review_round) > 0) throw conflict('The type of case cannot change after the report has been signed off. Add a note if it was recorded wrongly.');
    if (body.occurred_at && seasonFor(body.occurred_at.slice(0, 10)) !== inc.season) delete body.occurred_at; // the case number stays with its season
    if (body.trail_id && !(body.form && body.form.run_classification) && !parseForm(inc.form).run_classification) {
      const cls = await runClassFor(conn, req.auth.tenantId, body.trail_id);
      if (cls) body.form = { ...(body.form || {}), run_classification: cls };
    }
    if (body.form) body.form = mergeForm(inc.form, body.form);
    const set = setClause(body, [...Object.keys(incidentFields), 'status']);
    if (!set) throw bad('No updatable fields supplied');
    if (body.lift_id && !(await one(conn, 'SELECT id FROM lifts WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, body.lift_id]))) throw notFound('Lift');
    await conn.query(`UPDATE incidents SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    // A new time, trail or lift: the conditions are taken again for it while the report is still being written.
    if (['occurred_at', 'trail_id', 'lift_id'].some((k) => k in body && String(body[k] ?? '') !== String(inc[k] ?? '')) && inc.report_state === 'draft') await takeConditions(conn, req.auth.tenantId, id);
    await audit(conn, req, 'update', 'incidents', id, { fields: Object.keys(req.body).map((k) => (k === 'form' ? `form:${Object.keys(req.body.form).join('|')}` : k)) });
  });
  if (req.body.severity) await staffNotices(req, id);
  res.json({ ok: true });
});

/** Take the conditions again now (records added since, such as a late weather reading). Only while the report is open. */
router.post('/incidents/:id/conditions', patrol, needs('create_case'), async (req, res) => {
  const id = paramId(req);
  const snap = await tx(async (conn) => { await editableCase(conn, req, id); return takeConditions(conn, req.auth.tenantId, id); });
  res.json({ conditions: snap, suggest: COND.suggest(snap) });
});

// ---------------------------------------------------------------- rental gear on a case
const RENTALS = require('../lib/rentals');
/** One rental item as the report shows it: the gear, its binding setting and who set it, and its last service. */
async function rentalDetail(db, t, itemId, contractId) {
  const it = await one(db, 'SELECT id, sku, category, brand, model, size, status FROM rental_items WHERE tenant_id = ? AND id = ?', [t, itemId]);
  if (!it) return null;
  const line = await one(db, `SELECT ci.contract_id, ci.din_setting, ci.skier_type, ci.boot_sole_mm, ci.tech_name, ci.set_at, ci.test_result, rc.checked_out_at, rc.person_id,
      CONCAT(pp.first_name, ' ', pp.last_name) AS renter FROM rental_contract_items ci JOIN rental_contracts rc ON rc.tenant_id = ci.tenant_id AND rc.id = ci.contract_id
      LEFT JOIN people pp ON pp.tenant_id = rc.tenant_id AND pp.id = rc.person_id
    WHERE ci.tenant_id = ? AND ci.rental_item_id = ? ${contractId ? 'AND ci.contract_id = ?' : ''} ORDER BY ci.id DESC LIMIT 1`, contractId ? [t, itemId, contractId] : [t, itemId]);
  const svc = await one(db, 'SELECT kind, notes, done_by, done_at FROM rental_service_log WHERE tenant_id = ? AND rental_item_id = ? ORDER BY done_at DESC, id DESC LIMIT 1', [t, itemId]);
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    item: { id: Number(it.id), sku: it.sku, category: it.category, brand: it.brand, model: it.model, size: it.size, status: it.status },
    contract: line ? { id: Number(line.contract_id), renter: line.renter, person_id: line.person_id ? Number(line.person_id) : null, checked_out_at: line.checked_out_at } : null,
    binding: line ? { din_setting: num(line.din_setting), skier_type: line.skier_type, boot_sole_mm: num(line.boot_sole_mm), tech_name: line.tech_name, set_at: line.set_at, test_result: line.test_result } : null,
    last_service: svc ? { kind: svc.kind, notes: svc.notes, done_by: svc.done_by, done_at: svc.done_at } : null,
  };
}

/**
 * Find rental gear for a case: by contract number, by the item's number (a scan), or by the patient's name on a contract
 * out today. Each contract comes with its gear and their binding settings.
 */
router.get('/rental-lookup', patrol, needs('create_case'), async (req, res) => {
  const t = req.auth.tenantId;
  const q = String(req.query.q || '').trim();
  if (q.length < 2 && !/^\d+$/.test(q)) throw bad('Type a contract number, an item number, or the renter\'s name'); // contract 7 is one digit
  const ids = new Set();
  if (/^\d+$/.test(q)) for (const r of await rows(pool, 'SELECT id FROM rental_contracts WHERE tenant_id = ? AND id = ?', [t, Number(q)])) ids.add(Number(r.id));
  for (const r of await rows(pool, 'SELECT ci.contract_id FROM rental_contract_items ci JOIN rental_items ri ON ri.tenant_id = ci.tenant_id AND ri.id = ci.rental_item_id WHERE ci.tenant_id = ? AND ri.sku = ? ORDER BY ci.id DESC LIMIT 3', [t, q])) ids.add(Number(r.contract_id));
  if (!/^\d+$/.test(q)) {
    for (const r of await rows(pool, `SELECT rc.id FROM rental_contracts rc JOIN people p ON p.tenant_id = rc.tenant_id AND p.id = rc.person_id
      WHERE rc.tenant_id = ? AND (rc.status IN ('out', 'overdue') OR rc.checked_out_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY) AND CONCAT(p.first_name, ' ', p.last_name) LIKE ? ORDER BY rc.id DESC LIMIT 10`, [t, `%${q}%`])) ids.add(Number(r.id));
  }
  const out = [];
  for (const cid of [...ids].slice(0, 10)) {
    const c = await one(pool, "SELECT rc.id, rc.status, rc.checked_out_at, CONCAT(p.first_name, ' ', p.last_name) AS renter FROM rental_contracts rc JOIN people p ON p.tenant_id = rc.tenant_id AND p.id = rc.person_id WHERE rc.tenant_id = ? AND rc.id = ?", [t, cid]);
    const items = await rows(pool, 'SELECT rental_item_id FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? ORDER BY id', [t, cid]);
    out.push({ ...c, id: Number(c.id), items: await Promise.all(items.map((x) => rentalDetail(pool, t, Number(x.rental_item_id), cid))) });
  }
  res.json({ data: out });
});

/** Put rental gear on the case. The report keeps what it was at the time; the gear is held for inspection (Rentals setting). */
router.post('/incidents/:id/rentals', patrol, needs('create_case'), validate(z.object({ rental_item_id: z.number().int().positive(), contract_id: z.number().int().positive().nullable().optional(), patient_id: z.number().int().positive().nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  const b = req.body;
  const out = await tx(async (conn) => {
    await editableCase(conn, req, id);
    if (b.patient_id && !(await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ? AND voided_at IS NULL', [t, id, b.patient_id]))) throw notFound('Patient');
    const it = await one(conn, 'SELECT id, sku, status FROM rental_items WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, b.rental_item_id]);
    if (!it) throw notFound('Rental item');
    const before = await one(conn, 'SELECT id, voided_at FROM incident_rentals WHERE tenant_id = ? AND incident_id = ? AND rental_item_id = ?', [t, id, it.id]);
    if (before && !before.voided_at) throw conflict(`${it.sku} is already on this case`);
    const detail = await rentalDetail(conn, t, it.id, b.contract_id || null);
    const settings = await RENTALS.getSettings(conn, t);
    const hold = settings.hold_after_incident;
    const now = nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone);
    const vals = [b.patient_id || null, (detail.contract && detail.contract.id) || b.contract_id || null, JSON.stringify(detail), hold ? 1 : 0, it.status, req.auth.userId, now];
    // Gear marked entered in error and then added again: the same row comes back (one row per item per case); the
    // earlier marking stays in the audit trail.
    const [r] = before
      ? await conn.query('UPDATE incident_rentals SET patient_id = ?, contract_id = ?, detail = ?, held = ?, status_before = ?, added_by = ?, added_at = ?, released_at = NULL, released_by = NULL, inspection_note = NULL, voided_at = NULL, void_reason = NULL, voided_by = NULL WHERE tenant_id = ? AND id = ?', [...vals, t, before.id])
      : await conn.query('INSERT INTO incident_rentals (tenant_id, incident_id, rental_item_id, patient_id, contract_id, detail, held, status_before, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [t, id, it.id, ...vals]);
    // Back on the rack only after the shop inspects it. Gear still out on the contract goes to the shop when it is returned.
    if (hold && it.status === 'available') await conn.query("UPDATE rental_items SET status = 'maintenance' WHERE tenant_id = ? AND id = ?", [t, it.id]);
    await audit(conn, req, 'add_rental', 'incidents', id, { rental_item_id: it.id, held: hold });
    return { id: before ? Number(before.id) : r.insertId, held: hold };
  });
  res.status(201).json(out);
});

/**
 * Gear put on the case by mistake is marked entered in error with a reason (it stays on the record, struck through),
 * while the report is open and before the shop has inspected it. Its hold for inspection ends. DELETE does the same.
 */
async function voidRental(req, res) {
  const t = req.auth.tenantId;
  const id = paramId(req);
  await tx(async (conn) => {
    await editableCase(conn, req, id);
    const cur = await one(conn, 'SELECT released_at FROM incident_rentals WHERE tenant_id = ? AND incident_id = ? AND id = ?', [t, id, paramId(req, 'rowId')]);
    if (cur && cur.released_at) throw conflict('The rental shop has already inspected this gear, so it stays on the report');
    const r = await voidCaseRow(conn, req, id, 'incident_rentals', paramId(req, 'rowId'), 'Rental gear on this case');
    if (Number(r.held) && r.status_before === 'available' && !(await RENTALS.patrolHold(conn, t, r.rental_item_id))) {
      await conn.query("UPDATE rental_items SET status = 'available' WHERE tenant_id = ? AND id = ? AND status = 'maintenance'", [t, r.rental_item_id]);
    }
    await audit(conn, req, 'void_rental', 'incidents', id, { row: Number(r.id), rental_item_id: Number(r.rental_item_id), reason: req.body.reason });
  });
  res.json({ ok: true });
}
router.post('/incidents/:id/rentals/:rowId/void', patrol, needs('create_case'), validate(voidSchema), voidRental);
router.delete('/incidents/:id/rentals/:rowId', patrol, needs('create_case'), validate(voidSchema), voidRental);

router.post('/incidents/:id/notes', patrol, needs('create_case'), validate(z.object({ body: z.string().min(1).max(5000) })), async (req, res) => {
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Incident');
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
  const [r] = await pool.query('INSERT INTO incident_notes (tenant_id, incident_id, author_user, body, created_at) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, id, req.auth.userId, req.body.body, nowIn(tz)]);
  await audit(pool, req, 'add_note', 'incidents', id);
  res.status(201).json({ id: r.insertId });
});

// ---------------------------------------------------------------- submit, approve, reopen
/**
 * What a finished report must contain, as a list so the screen can show every gap at once.
 * stage 'submit': items the patrol director made "required to submit"; stage 'approve': those plus "required to approve"
 * (judged against the rules the report was submitted under, so later changes never move the goalposts). Items approved
 * with an exception count as given. The safety rules below are checked whatever the settings.
 * Each problem is { message, level, ...where }; where = { scope, section, field, patient_id } for a form field, or
 * { area, patient_id? } for the summary, patients, responders, signatures or narrative. level 'approve' marks an item the
 * Patrol Director may approve with an exception.
 */
async function reportProblems(conn, tenantId, inc, { stage = 'submit', rules = null } = {}) {
  const problems = [];
  const problem = (message, where = {}, level = 'submit') => problems.push({ message, level, ...where });
  if (!inc.summary || !inc.summary.trim()) problem('Add a one-line summary', { area: 'summary' });
  const c = await loadCase(conn, tenantId, inc.id);
  const set = rules || (stage === 'approve' ? await RQ.version(conn, tenantId, inc.rules_version_id) : await RQ.current(conn, tenantId));
  const blocking = stage === 'approve' ? ['submit', 'approve'] : ['submit'];
  for (const i of RQ.evaluate(set.rules, c, { exceptions: c.exceptions || [] })) {
    if (i.met || i.exception || !blocking.includes(i.level)) continue;
    problem(RQ.message(i), RQ.where(i), i.level);
  }
  // Before the patient left: each item done, or skipped with a reason (patient care cases, when the director asks for it).
  if (RQ.optionsOf(set.rules).leave) for (const x of LEAVE.problems(c)) problems.push(x);
  if (!CLINICAL_CATEGORIES.includes(inc.category)) return problems;
  const patients = c.patients.filter((p) => !p.voided_at); // a patient entered in error is not part of the report
  if (!patients.length) problem('Add at least one patient', { area: 'patients' });
  const { signatures } = c;

  // Safety rules for each patient.
  for (const p of patients) {
    const who = `${p.first_name} ${p.last_name}`.trim();
    // These are checked whatever the settings say.
    const pf0 = p.form || {};
    const liveVitals = (p.vitals || []).filter((v) => !v.voided_at);
    const lastGcs = [...liveVitals].reverse().find((v) => v.gcs !== null && v.gcs !== undefined);
    const headFlags = [pf0.head_loc === 'yes' && 'lost consciousness', (pf0.head_amnesia_before === 'yes' || pf0.head_amnesia_after === 'yes') && 'amnesia', lastGcs && Number(lastGcs.gcs) < 15 && `GCS ${lastGcs.gcs}`].filter(Boolean);
    // A head injury with these signs does not go back to skiing, unless they refused care in writing or a named person cleared them.
    if (headFlags.length && pf0.destination_type === 'return_to_ski' && p.disposition !== 'refused_care' && isEmpty(pf0.return_cleared_note)) {
      problem(`${who}: ${headFlags.join(', ')}, so not back to skiing. Change the destination, record a signed refusal, or say who cleared them and why`, { scope: 'patient', patient_id: p.id, section: 'head', field: 'return_cleared_note' });
    }
    // Serious, critical or sent to higher care: at least one set of vitals, and two when on scene more than 15 minutes.
    const transported = ['transported_ambulance', 'transported_private'].includes(p.disposition);
    if (['serious', 'critical'].includes(inc.severity) || transported) {
      const on = c.events.find((e) => !e.voided_at && ['on_scene', 'patient_contact'].includes(e.kind));
      const off = [...c.events].reverse().find((e) => !e.voided_at && ['handoff', 'transport_started', 'cleared'].includes(e.kind));
      const long = on && off && (Date.parse(`${String(off.at).replace(' ', 'T')}Z`) - Date.parse(`${String(on.at).replace(' ', 'T')}Z`)) > 15 * 60000;
      const need = long ? 2 : 1;
      if (liveVitals.length < need && p.disposition !== 'refused_care') problem(`${who}: ${need === 2 ? 'two sets of vitals (on scene more than 15 minutes)' : 'at least one set of vitals'} for a ${transported ? 'patient sent to higher care' : `${inc.severity} case`}`, { area: 'vitals', patient_id: p.id });
    }
    if (p.disposition === 'refused_care') {
      const pf = p.form || {};
      // Capacity is the point most often challenged: anything that clouds it is shown and needs a note.
      const clouded = [!isEmpty(pf.drugs_alcohol) && !/^(none|no|n\/a)$/i.test(String(pf.drugs_alcohol).trim()) && 'drugs or alcohol', ...headFlags].filter(Boolean);
      if (clouded.length && pf.refusal_capacity === 'yes' && isEmpty(pf.refusal_capacity_note)) {
        problem(`${who}: ${clouded.join(', ')} recorded, so say how you judged they could still decide`, { scope: 'patient', patient_id: p.id, section: 'refusal', field: 'refusal_capacity_note' });
      }
      if (pf.refusal_capacity === 'no') problem(`${who}: not able to decide, so cannot refuse care. Treat under implied consent and escalate`, { scope: 'patient', patient_id: p.id, section: 'refusal', field: 'refusal_capacity' });
      if (p.age_years !== null && p.age_years !== undefined && Number(p.age_years) < 18 && !(pf.refusal_signer === 'guardian' && pf.refusal_guardian_name && pf.refusal_guardian_relation)) {
        problem(`${who}: under 18, so a parent or guardian signs the refusal (name and relationship)`, { scope: 'patient', patient_id: p.id, section: 'refusal', field: 'refusal_signer' });
      }
      const signed = [...signatures].reverse().find((s) => s.kind === 'refusal_of_care' && s.patient_id === p.id);
      if (!signed) problem(`${who}: refused care, so a refusal signature is needed`, { area: 'signatures' });
      else if (p.age_years !== null && p.age_years !== undefined && Number(p.age_years) < 18 && pf.refusal_guardian_name
        && String(signed.signer_name).trim().toLowerCase() !== String(pf.refusal_guardian_name).trim().toLowerCase()) {
        problem(`${who}: the refusal was signed by ${signed.signer_name}, not the parent or guardian. Have ${pf.refusal_guardian_name} sign it`, { area: 'signatures' });
      }
    }
  }
  if (!c.responders.some((r) => r.role === 'lead' && !r.voided_at)) problem('Add the patroller who led the response', { area: 'responders' });
  return problems;
}

/**
 * At submit, answers worked out from the bedside entries are copied into blank form fields (nothing typed is replaced), and
 * "completed by" is filled from the person submitting, so the stored report reads the same without the bedside rows.
 */
async function fillFromBedside(conn, req, inc) {
  const c = await loadCase(conn, req.auth.tenantId, inc.id);
  const filled = [];
  for (const p of c.patients.filter((x) => !x.voided_at)) {
    const add = {};
    for (const [k, v] of Object.entries(p.derived)) if (isEmpty(p.form[k]) && !isEmpty(v)) add[k] = typeof v === 'string' ? v.slice(0, k.startsWith('fa_') ? 20000 : 300) : v;
    if (!Object.keys(add).length) continue;
    await conn.query('UPDATE incident_patients SET form = ? WHERE tenant_id = ? AND id = ?', [mergeForm(p.form, add), req.auth.tenantId, p.id]);
    filled.push({ patient_id: p.id, fields: Object.keys(add) });
  }
  // Which medical director and protocol the care was given under, as they stand when the report is signed off.
  const ops = await OPS.settingsOf(conn, req.auth.tenantId);
  if (ops.medical_director || ops.protocol_version) {
    const stamp = [ops.medical_director && `Medical director: ${ops.medical_director}`, ops.protocol_version && `Protocols: ${ops.protocol_version}`].filter(Boolean).join('. ');
    await conn.query('UPDATE incidents SET protocol_stamp = ? WHERE tenant_id = ? AND id = ?', [stamp.slice(0, 255), req.auth.tenantId, inc.id]);
  }
  if (req.auth.staffId && (isEmpty(c.form.completed_by_name) || isEmpty(c.form.completed_by_number))) {
    const me = await one(conn, 'SELECT p.first_name, p.last_name, m.patrol_number, m.callsign FROM staff s JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id LEFT JOIN patrol_members m ON m.staff_id = s.id AND m.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND s.id = ?', [req.auth.tenantId, req.auth.staffId]);
    if (me) {
      const add = {};
      if (isEmpty(c.form.completed_by_name)) add.completed_by_name = `${me.first_name} ${me.last_name}`;
      if (isEmpty(c.form.completed_by_number) && (me.patrol_number || me.callsign)) add.completed_by_number = me.patrol_number || me.callsign;
      await conn.query('UPDATE incidents SET form = ? WHERE tenant_id = ? AND id = ?', [mergeForm(c.form, add), req.auth.tenantId, inc.id]);
      filled.push({ case: Object.keys(add) });
    }
  }
  return filled;
}

/** Keeps a frozen copy of the whole report as it stands. */
async function keepVersion(conn, req, incidentId, kind) {
  const c = await loadCase(conn, req.auth.tenantId, incidentId);
  delete c.versions;
  const { n } = await one(conn, 'SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM incident_versions WHERE tenant_id = ? AND incident_id = ?', [req.auth.tenantId, incidentId]);
  const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
  await conn.query('INSERT INTO incident_versions (tenant_id, incident_id, version_no, kind, snapshot, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, incidentId, n, kind, JSON.stringify(c), req.auth.userId, nowIn(tz)]);
  return n;
}

/**
 * Moves a report between states. check 'submit' or 'approve' runs reportProblems at that stage first; a report that
 * still has gaps is refused with the list. allowExceptions(conn, inc, problems) may accept some gaps (the Patrol
 * Director approving with an exception) and returns the problems that are left.
 */
async function setState(req, res, { from, to, check, extra, version, allowExceptions }) {
  const id = paramId(req);
  let out = { ok: true };
  await tx(async (conn) => {
    const inc = await one(conn, 'SELECT * FROM incidents WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!inc) throw notFound('Incident');
    if (!from.includes(inc.report_state)) throw conflict(`This report is ${inc.report_state}`);
    let rules = null;
    if (check) {
      // A report is checked, and later approved, against the rules in force when it is submitted.
      if (check === 'submit') { rules = await RQ.ensure(conn, req.auth.tenantId); await conn.query('UPDATE incidents SET rules_version_id = ? WHERE tenant_id = ? AND id = ?', [rules.id, inc.tenant_id, inc.id]); }
      let problems = await reportProblems(conn, req.auth.tenantId, inc, { stage: check, rules });
      if (problems.length && allowExceptions) problems = await allowExceptions(conn, inc, problems);
      if (problems.length) {
        const err = conflict('The report is not complete yet', problems);
        // only "required to approve" gaps left: say whether this reviewer could approve with an exception
        if (check === 'approve' && problems.every((x) => x.level === 'approve')) err.extra = { exceptions_possible: await mayExcept(req) };
        throw err;
      }
    }
    const filled = check ? await fillFromBedside(conn, req, inc) : [];
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
    const result = await extra(conn, inc, nowIn(tenant.timezone));
    const vk = typeof version === 'function' ? version(result) : version;
    const v = vk ? await keepVersion(conn, req, id, vk) : null;
    await audit(conn, req, to, 'incidents', id, { ...(v ? { version: v } : {}), ...(rules ? { rules_version: rules.id } : {}), ...(filled.length ? { filled_from_bedside: filled } : {}), ...(result && result.audit ? result.audit : {}) });
    out = { ok: true, ...(result && result.reply ? result.reply : {}) };
  });
  res.json(out);
}

/** May this login approve a report with an exception? The Patrol Director: the review group's lead, or the patrol admin level. */
async function mayExcept(req) {
  if ((await PA.levelOf(pool, req)) === 'admin') return true;
  const s = await R.settingsOf(pool, req.auth.tenantId);
  return s.reviewers.some((r) => r.user_id === req.auth.userId && r.active && r.lead);
}

/** Review rights: a member of the review group; with no group, the approve_case access level. */
const reviewer = async (req, _res, next) => {
  try {
    if (!(await R.canReview(pool, req))) throw forbidden('Only the review group can review reports');
    next();
  } catch (err) { next(err); }
};

router.post('/incidents/:id/submit', patrol, needs('submit_case'), (req, res) => setState(req, res, {
  // a kind of case the review group does not review is signed off and approved at once: keep the approved copy
  from: ['draft'], to: 'submit', check: 'submit', version: (r) => (r && r.reply && r.reply.review === 'not_required' ? 'approved' : 'submitted'),
  extra: async (conn, inc, now) => {
    await conn.query("UPDATE incidents SET report_state = 'submitted', submitted_by = ?, submitted_at = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, now, inc.tenant_id, inc.id]);
    const routed = await R.afterSubmit(conn, req, { ...inc, submitted_by: req.auth.userId }, now);
    // What the reviewer will still need: "required to approve" items not answered yet. Submitting is not held up by them.
    const later = routed === 'not_required' ? [] : (await reportProblems(conn, req.auth.tenantId, inc, { stage: 'approve' })).filter((x) => x.level === 'approve');
    return { reply: { review: routed, for_approval: later }, audit: { review: routed, for_approval: later.length } };
  },
}));

const checklist = z.record(z.enum(R.CHECK_KEYS), z.boolean());
const exceptionItem = z.object({ scope: z.enum(['case', 'patient']), field: z.string().max(40), patient_id: z.number().int().positive().nullable().optional(), reason: z.string().trim().min(5).max(500) });
router.post('/incidents/:id/approve', patrol, reviewer, validate(z.object({ checklist: checklist.optional(), note: z.string().trim().max(1000).optional(), exceptions: z.array(exceptionItem).max(60).optional() }).default({})), async (req, res, next) => {
  const s = await R.settingsOf(pool, req.auth.tenantId);
  if (s.enabled && R.CHECK_KEYS.some((k) => !(req.body.checklist || {})[k])) return next(bad('Tick every review check before approving. If a check does not apply, it is fine: tick it.'));
  const wanted = req.body.exceptions || [];
  if (wanted.length && !(await mayExcept(req))) return next(forbidden('Only the Patrol Director can approve a report with an exception. Send it back with comments instead.'));
  return setState(req, res, {
    // With a review group, only a signed-off report can be approved, and never by the person who signed it off.
    from: s.enabled ? ['submitted'] : ['draft', 'submitted'], to: 'approve', check: 'approve', version: 'approved',
    // The Patrol Director may accept a missing "required to approve" item with a reason. Each one is kept with the
    // report and shows on every copy, including copies released outside. Nothing else can be excepted.
    allowExceptions: wanted.length ? async (conn, inc, problems) => {
      const now = nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [inc.tenant_id])).timezone);
      const left = [];
      for (const p of problems) {
        const match = p.level === 'approve' && p.field && wanted.find((w) => w.scope === p.scope && w.field === p.field && (w.patient_id || null) === (p.patient_id || null));
        if (!match) { left.push(p); continue; }
        await conn.query('INSERT INTO incident_exceptions (tenant_id, incident_id, patient_id, scope, item_key, label, reason, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [inc.tenant_id, inc.id, p.patient_id || null, p.scope, p.field, p.message.slice(0, 255), match.reason, req.auth.userId, now]);
      }
      if (left.length) throw conflict(left.some((x) => x.level !== 'approve') ? 'Some gaps cannot be approved with an exception. Send the report back with comments.' : 'Give a reason for every missing item, or send the report back with comments.', left);
      return left;
    } : null,
    extra: async (conn, inc, now) => {
      // With a review group, never your own report. (Without one, a small patrol may have a single approver; turning the
      // group off to get round this takes a patrol admin.)
      if (s.enabled && Number(inc.submitted_by) === req.auth.userId) throw forbidden('You signed off this report, so another member of the review group must review it');
      await conn.query("UPDATE incidents SET report_state = 'approved', status = 'closed', approved_by = ?, approved_at = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, now, inc.tenant_id, inc.id]);
      if (!s.enabled) return null;
      await R.record(conn, inc, 'approved', req.auth.userId, { checklist: req.body.checklist, note: req.body.note || null });
      const me = await R.nameOf(conn, inc.tenant_id, req.auth.userId);
      const link = [{ type: 'patrol_case', id: inc.id }];
      await R.direct(conn, inc.tenant_id, req.auth.userId, Number(inc.submitted_by), `Your report, Case ${R.caseNo(inc)}, was reviewed and approved.${req.body.note ? ` Note: ${req.body.note}` : ''}`, link);
      await R.postSystem(conn, inc.tenant_id, s.thread_id, `${me || 'A reviewer'} approved Case ${R.caseNo(inc)}.`, link);
      return { audit: { checklist: req.body.checklist } };
    },
  });
});

const comment = z.object({ section: z.enum(R.SECTIONS), text: z.string().trim().min(3).max(1000) });
router.post('/incidents/:id/return', patrol, reviewer, validate(z.object({ comments: z.array(comment).min(1).max(30), note: z.string().trim().max(1000).optional() })), (req, res) => setState(req, res, {
  from: ['submitted'], to: 'return', check: false,
  extra: async (conn, inc, now) => {
    if (Number(inc.submitted_by) === req.auth.userId) throw forbidden('You signed off this report, so another member of the review group must review it');
    await conn.query("UPDATE incidents SET report_state = 'draft', status = 'open', returned_at = ?, returned_by = ? WHERE tenant_id = ? AND id = ?", [now, req.auth.userId, inc.tenant_id, inc.id]);
    await R.record(conn, inc, 'returned', req.auth.userId, { comments: req.body.comments, note: req.body.note || null });
    const s = await R.settingsOf(conn, inc.tenant_id);
    const me = await R.nameOf(conn, inc.tenant_id, req.auth.userId);
    const link = [{ type: 'patrol_case', id: inc.id }];
    const lines = req.body.comments.map((c) => `• ${c.section}: ${c.text}`).join('\n');
    await R.direct(conn, inc.tenant_id, req.auth.userId, Number(inc.submitted_by), `Your report, Case ${R.caseNo(inc)}, needs changes before it can be approved:\n${lines}${req.body.note ? `\n${req.body.note}` : ''}\nOpen the case, make the changes, then sign off again.`, link);
    await R.postSystem(conn, inc.tenant_id, s.thread_id, `${me || 'A reviewer'} sent Case ${R.caseNo(inc)} back for changes.`, link);
    return { audit: { comments: req.body.comments.length } };
  },
}));

router.post('/incidents/:id/escalate', patrol, reviewer, validate(z.object({ note: z.string().trim().min(3).max(1000) })), (req, res) => setState(req, res, {
  from: ['submitted'], to: 'escalate', check: false,
  extra: async (conn, inc, now) => {
    if (Number(inc.submitted_by) === req.auth.userId) throw forbidden('You signed off this report, so another member of the review group must decide on it');
    if (inc.escalated_at) throw conflict('This report has already been escalated');
    await conn.query('UPDATE incidents SET escalated_at = ?, escalated_by = ?, escalation_note = ? WHERE tenant_id = ? AND id = ?', [now, req.auth.userId, req.body.note, inc.tenant_id, inc.id]);
    await R.record(conn, inc, 'escalated', req.auth.userId, { note: req.body.note });
    const s = await R.settingsOf(conn, inc.tenant_id);
    const me = await R.nameOf(conn, inc.tenant_id, req.auth.userId);
    const link = [{ type: 'patrol_case', id: inc.id }];
    // The owner and managers hear about it directly; the report stays with the review group to finish.
    const bosses = await rows(conn, "SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner','manager') AND id <> ?", [inc.tenant_id, req.auth.userId]);
    for (const b of bosses) await R.direct(conn, inc.tenant_id, req.auth.userId, Number(b.id), `Escalated: Case ${R.caseNo(inc)} (${inc.severity} ${inc.category.replace('_', ' ')}). ${req.body.note}`, link);
    await R.postSystem(conn, inc.tenant_id, s.thread_id, `${me || 'A reviewer'} escalated Case ${R.caseNo(inc)} to the owner and managers. It still needs a review decision.`, link);
    return { reply: { told: bosses.length } };
  },
}));

// Reopen an approved report (its approved copy stays under Record). With a review group, a report waiting for review
// is sent back with comments instead (/return), so this only reopens approved ones.
router.post('/incidents/:id/reopen', patrol, reviewer, validate(z.object({ reason: z.string().min(3).max(500) })), async (req, res) => {
  const s = await R.settingsOf(pool, req.auth.tenantId);
  return setState(req, res, {
    from: s.enabled ? ['approved'] : ['submitted', 'approved'], to: 'reopen', check: false,
    extra: async (conn, inc) => {
      await conn.query("UPDATE incidents SET report_state = 'draft', status = 'open', approved_by = NULL, approved_at = NULL, returned_at = NULL, returned_by = NULL WHERE tenant_id = ? AND id = ?", [inc.tenant_id, inc.id]);
      await conn.query('INSERT INTO incident_notes (tenant_id, incident_id, author_user, body) VALUES (?, ?, ?, ?)', [inc.tenant_id, inc.id, req.auth.userId, `Reopened: ${req.body.reason}`]);
    },
  });
});

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
  vitals_due_at: dateTimeStr.transform(normDateTime).nullable().optional(),
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
    if (pat.voided_at) throw conflict('This patient was marked entered in error');
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
  await staffInjury.notifyIfDue(req.auth.tenantId, id, out, baseUrl(req));
  res.status(201).json({ id: out });
});

router.patch('/incidents/:id/patients/:pid', patrol, needs('create_case'), validate(partialOf(patientFields)), async (req, res) => {
  const id = paramId(req);
  const pid = paramId(req, 'pid');
  await tx(async (conn) => {
    const inc = await editableCase(conn, req, id);
    const body = { ...req.body };
    const cur = await one(conn, 'SELECT form, chief_complaint, age_years, voided_at FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, pid]);
    if (!cur) throw notFound('Patient');
    if (cur.voided_at) throw conflict('This patient was marked entered in error');
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
    // An outcome means care here is over (released, handed off, refused): the vitals timer stops.
    if (body.disposition) await conn.query('UPDATE incident_patients SET vitals_due_at = NULL WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, pid]);
    await audit(conn, req, 'update_patient', 'incidents', id, { patient_id: pid, fields: Object.keys(req.body) });
  });
  if (req.body.form || req.body.disposition || req.body.activity) await staffInjury.notifyIfDue(req.auth.tenantId, id, pid, baseUrl(req));
  res.json({ ok: true });
});

// Nothing clinical is deleted. A patient added by mistake is marked "entered in error" with a reason, and stays on the
// record struck through; their vitals, injuries and treatments go with them. Follow-up emails that have not gone are dropped.
router.post('/incidents/:id/patients/:pid/void', patrol, needs('create_case'), validate(voidSchema), async (req, res) => {
  const id = paramId(req);
  const pid = paramId(req, 'pid');
  await tx(async (conn) => {
    const held = await editableCase(conn, req, id);
    if (Number(held.legal_hold)) throw conflict('This case is on legal hold: nothing on it can be marked entered in error.');
    const p = await one(conn, 'SELECT id, voided_at FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, pid]);
    if (!p) throw notFound('Patient');
    if (p.voided_at) throw conflict('This patient is already marked entered in error');
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
    await conn.query('UPDATE incident_patients SET voided_at = ?, void_reason = ?, voided_by = ?, vitals_due_at = NULL WHERE tenant_id = ? AND id = ?', [nowIn(tenant.timezone), req.body.reason, req.auth.userId, req.auth.tenantId, pid]);
    await conn.query('UPDATE incident_parties SET patient_id = NULL WHERE tenant_id = ? AND patient_id = ?', [req.auth.tenantId, pid]);
    await conn.query("DELETE FROM followups WHERE tenant_id = ? AND patient_id = ? AND status <> 'sent'", [req.auth.tenantId, pid]);
    await audit(conn, req, 'void_patient', 'incidents', id, { patient_id: pid, reason: req.body.reason });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- patient and case sub-records
const optionalTime = (field) => ({ [field]: dateTimeStr.transform(normDateTime).optional() });

const cms = z.object({ c: z.enum(['present', 'absent', 'not_checked']), m: z.enum(['present', 'absent', 'not_checked']), s: z.enum(['present', 'absent', 'not_checked']) }).strict();
// Structured details on a treatment, stored as JSON beside the row.
const treatmentDetail = z.object({
  cms_before: cms.optional(), cms_after: cms.optional(), body_part: z.string().max(60).optional(),
  o2_device: z.enum(['nasal_cannula', 'mask', 'non_rebreather', 'bvm', 'other']).optional(), o2_lpm: z.number().min(0).max(25).optional(),
  dose_value: z.number().min(0).max(100000).optional(), dose_unit: z.enum(['mg', 'mcg', 'g', 'mL', 'units', 'puffs', 'tablets', 'drops']).optional(),
  indication: z.string().max(255).optional(), authorised_by: z.string().max(150).optional(), effect: z.string().max(255).optional(), effect_at: z.string().max(19).optional(),
  action: z.enum(['start', 'stop', 'pads_on', 'shock', 'no_shock', 'rhythm_check']).optional(), joules: z.number().int().min(0).max(400).optional(),
  // medication safety and stock (see routes/patrolmeds checkMedication)
  allergy_checked: z.boolean().optional(), allergy_override: z.string().max(255).optional(), pde5: z.enum(['no', 'yes']).optional(), bp_override: z.string().max(255).optional(),
  stock_id: z.number().int().positive().optional(), stock_amount: z.number().min(0.01).max(1000).optional(), lot: z.string().max(40).optional(),
  equipment_id: z.number().int().positive().optional(), // the AED or oxygen cylinder used
  limb: z.enum(['left_arm', 'right_arm', 'left_leg', 'right_leg', 'junctional']).optional(), // tourniquet
}).strict();
const gcsPart = (max) => z.number().int().min(1).max(max).optional();
const clientRef = z.string().regex(/^[a-z0-9]{6,40}$/).optional(); // set by a phone that may send the same entry twice

const sub = {
  vitals: {
    table: 'incident_vitals', level: 'patient', time: 'taken_at',
    schema: z.object({
      ...optionalTime('taken_at'),
      pulse: z.number().int().min(0).max(300).optional(), resp: z.number().int().min(0).max(80).optional(),
      bp_sys: z.number().int().min(0).max(300).optional(), bp_dia: z.number().int().min(0).max(200).optional(),
      spo2: z.number().int().min(0).max(100).optional(), gcs: z.number().int().min(3).max(15).optional(), pain: z.number().int().min(0).max(10).optional(),
      gcs_e: gcsPart(4), gcs_v: gcsPart(5), gcs_m: gcsPart(6),
      avpu: z.enum(['alert', 'verbal', 'pain', 'unresponsive']).optional(), pupils: z.string().max(40).optional(), skin: z.string().max(60).optional(),
      pupil_left: z.string().max(30).optional(), pupil_right: z.string().max(30).optional(),
      temp_c: z.number().min(20).max(45).optional(), glucose: z.number().int().min(0).max(1500).optional(), notes: z.string().max(255).optional(),
      recheck_minutes: z.number().int().min(0).max(120).optional(), client_ref: clientRef,
    }).refine((v) => Object.keys(v).some((k) => !['taken_at', 'notes', 'recheck_minutes'].includes(k)), 'Record at least one measurement')
      .refine((v) => [v.gcs_e, v.gcs_v, v.gcs_m].every((x) => x === undefined) || [v.gcs_e, v.gcs_v, v.gcs_m].every((x) => x !== undefined), 'Give all three parts of the GCS, or only the total')
      .transform((v) => (v.gcs_e !== undefined ? { ...v, gcs: v.gcs_e + v.gcs_v + v.gcs_m } : v)),
    cols: ['taken_at', 'pulse', 'resp', 'bp_sys', 'bp_dia', 'spo2', 'gcs', 'gcs_e', 'gcs_v', 'gcs_m', 'pain', 'avpu', 'pupils', 'pupil_left', 'pupil_right', 'skin', 'temp_c', 'glucose', 'notes', 'client_ref'], recorder: 'recorded_by', entered: true, voidable: true,
    // The next check is kept on the patient, so every phone on the case sees the same timer.
    after: async (conn, req, parent, body, now) => {
      if (body.recheck_minutes === undefined) return;
      // Due from when the set was taken, so a set entered late or sent after a dead spot does not push the next check back.
      await conn.query('UPDATE incident_patients SET vitals_due_at = IF(? > 0, CAST(? AS DATETIME) + INTERVAL ? MINUTE, NULL) WHERE tenant_id = ? AND id = ?', [body.recheck_minutes, body.taken_at || now, body.recheck_minutes, req.auth.tenantId, parent]);
    },
  },
  injuries: {
    table: 'incident_injuries', level: 'patient',
    schema: z.object({
      body_region: z.enum(['head', 'face', 'neck', 'shoulder', 'arm', 'elbow', 'wrist_hand', 'chest', 'back', 'abdomen', 'pelvis', 'hip', 'thigh', 'knee', 'lower_leg', 'ankle_foot', 'multiple', 'other']),
      side: z.enum(['left', 'right', 'both', 'midline', 'na']).default('na'),
      injury_type: z.enum(['fracture', 'dislocation', 'sprain_strain', 'laceration', 'contusion', 'concussion', 'spinal', 'internal', 'cold_injury', 'illness', 'cardiac', 'other']),
      notes: z.string().max(255).optional(), client_ref: clientRef,
    }),
    cols: ['body_region', 'side', 'injury_type', 'notes', 'client_ref'], voidable: true,
  },
  treatments: {
    table: 'incident_treatments', level: 'patient', time: 'performed_at',
    schema: z.object({
      ...optionalTime('performed_at'),
      kind: z.enum(['splint', 'spinal_motion_restriction', 'bandage', 'ice', 'oxygen', 'aed', 'cpr', 'airway', 'medication', 'warming', 'rosc', 'tourniquet', 'pelvic_binder', 'other']),
      description: z.string().max(255).optional(), medication: z.string().max(100).optional(), dose: z.string().max(50).optional(), route: z.string().max(30).optional(),
      performed_by_staff: z.number().int().positive().optional(),
      detail: treatmentDetail.optional(), client_ref: clientRef,
    }).refine((v) => v.kind !== 'medication' || (v.medication && v.dose), 'A medication needs a name and a dose')
      .refine((v) => v.kind !== 'tourniquet' || (v.detail && v.detail.limb), 'Say which limb the tourniquet is on')
      .transform((v) => (v.detail ? { ...v, detail: Object.keys(v.detail).length ? JSON.stringify(v.detail) : undefined } : v)),
    cols: ['performed_at', 'kind', 'description', 'medication', 'dose', 'route', 'performed_by_staff', 'detail', 'client_ref'], recorder: 'recorded_by', entered: true, voidable: true,
    // A medication is checked against the formulary, the allergies and (nitroglycerin) the blood pressure before it is saved.
    check: async (conn, req, patientId, data) => {
      if (data.kind !== 'medication') return null;
      const p = await one(conn, 'SELECT allergies FROM incident_patients WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, patientId]);
      const vitals = await rows(conn, 'SELECT taken_at, bp_sys, bp_dia, voided_at FROM incident_vitals WHERE tenant_id = ? AND patient_id = ? ORDER BY taken_at, id', [req.auth.tenantId, patientId]);
      const detail = data.detail ? JSON.parse(data.detail) : {};
      const got = await MEDS.checkMedication(conn, req.auth.tenantId, p, { ...data, detail, _recorder_staff: req.auth.staffId }, vitals);
      if (got.stock && got.stock.lot) data.detail = JSON.stringify({ ...detail, lot: got.stock.lot });
      return got;
    },
    // Taking a dose from stock, and an AED used on a patient needing its data downloaded.
    afterInsert: async (conn, req, patientId, data, rowId, checked, incidentId) => {
      const detail = data.detail ? JSON.parse(data.detail) : {};
      if (checked && checked.stock) await MEDS.useStock(conn, req, checked.stock, Number(detail.stock_amount || 1), incidentId, rowId, data.performed_at);
      if ((data.kind === 'aed' || data.kind === 'oxygen') && detail.equipment_id) {
        const e = await one(conn, 'SELECT id, kind FROM patrol_equipment WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, detail.equipment_id]);
        if (!e) throw notFound('Equipment');
        if (e.kind === 'aed') {
          await conn.query("UPDATE patrol_equipment SET needs_download = 1, status = 'needs_attention' WHERE tenant_id = ? AND id = ?", [req.auth.tenantId, e.id]);
          await conn.query("INSERT INTO equipment_checks (tenant_id, equipment_id, checked_by, result, notes) VALUES (?, ?, ?, 'needs_attention', ?)", [req.auth.tenantId, e.id, req.auth.userId, `Used on case ${incidentId}: download the data and fit new pads`]);
        }
      }
    },
  },
  events: {
    table: 'incident_events', level: 'incident', time: 'at',
    schema: z.object({ ...optionalTime('at'), kind: z.enum(['call_received', 'dispatched', 'on_scene', 'patient_contact', 'transport_started', 'at_aid_room', 'handoff', 'cleared', 'other']), note: z.string().max(255).optional(), patient_id: z.number().int().positive().optional(), client_ref: clientRef }),
    cols: ['at', 'kind', 'note', 'patient_id', 'client_ref'], recorder: 'recorded_by', entered: true, voidable: true,
    // Handed off: the vitals timer stops for that patient (or every patient when none is named).
    after: async (conn, req, incidentId, body) => {
      if (body.kind !== 'handoff') return;
      if (body.patient_id) await conn.query('UPDATE incident_patients SET vitals_due_at = NULL WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, body.patient_id]);
      else await conn.query('UPDATE incident_patients SET vitals_due_at = NULL WHERE tenant_id = ? AND incident_id = ?', [req.auth.tenantId, incidentId]);
    },
  },
  // Who was told about the incident, and when: management, the insurer, a parent, EMS, police, the owner.
  contacts: {
    table: 'incident_contacts', level: 'incident', time: 'at',
    schema: z.object({
      ...optionalTime('at'), who: z.enum(['management', 'insurer', 'parent', 'ems', 'police', 'owner', 'other']), who_name: z.string().trim().max(120).optional(),
      method: z.enum(['phone', 'in_person', 'text', 'radio', 'email']).default('phone'), note: z.string().trim().max(300).optional(), patient_id: z.number().int().positive().optional(), client_ref: clientRef,
    }).refine((v) => v.who !== 'other' || v.who_name, 'Say who, when it is someone else'),
    cols: ['at', 'who', 'who_name', 'method', 'note', 'patient_id', 'client_ref'], recorder: 'recorded_by', entered: true, voidable: true,
  },
  witnesses: {
    table: 'incident_witnesses', level: 'incident',
    schema: z.object({
      relation: z.enum(['witnessed_by', 'accompanied_by', 'collided_with', 'other']).optional(),
      name: z.string().min(1).max(150), phone: z.string().max(40).optional(), email: z.string().email().max(255).optional(),
      address: z.string().max(255).optional(), city: z.string().max(100).optional(), region: z.string().max(60).optional(), postal: z.string().max(20).optional(),
      statement: z.string().max(10000).optional(), client_ref: clientRef,
    }),
    cols: ['relation', 'name', 'phone', 'email', 'address', 'city', 'region', 'postal', 'statement', 'client_ref'], voidable: true, deleteVoids: true,
  },
};

for (const [name, def] of Object.entries(sub)) {
  const base = def.level === 'patient' ? `/incidents/:id/patients/:pid/${name}` : `/incidents/:id/${name}`;
  const parentCol = def.level === 'patient' ? 'patient_id' : 'incident_id';

  const parentId = async (conn, req, id) => {
    if (def.level !== 'patient') return id;
    const pid = paramId(req, 'pid');
    const p = await one(conn, 'SELECT id, voided_at FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, pid]);
    if (!p) throw notFound('Patient');
    if (p.voided_at) throw conflict('This patient was marked entered in error');
    return pid;
  };

  router.post(base, patrol, needs('create_case'), validate(def.schema), async (req, res) => {
    const id = paramId(req);
    const save = () => tx(async (conn) => {
      await editableCase(conn, req, id);
      const parent = await parentId(conn, req, id);
      const data = { ...req.body };
      if (data.client_ref) {
        const seen = await one(conn, `SELECT id FROM \`${def.table}\` WHERE tenant_id = ? AND client_ref = ?`, [req.auth.tenantId, data.client_ref]);
        if (seen) return seen.id; // already saved: the phone did not hear the answer the first time
      }
      if (data.patient_id && !(await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ? AND voided_at IS NULL', [req.auth.tenantId, id, data.patient_id]))) throw notFound('Patient');
      const now = nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone);
      if (def.time && !data[def.time]) data[def.time] = now;
      // A time in the future is a typing slip (23:45 for 13:45), and it would put the record out of order.
      // (PATROL_FUTURE_SLACK_MIN only widens the 5 minutes for the test suite, whose cases are written at fixed morning times.)
      if (def.time && data[def.time] > plusMin(now, Number(process.env.PATROL_FUTURE_SLACK_MIN || 5))) throw bad(`That time (${String(data[def.time]).slice(11, 16)}) is in the future. Check the hour.`);
      const checked = def.check ? await def.check(conn, req, parent, data) : null;
      if (def.entered) data.entered_at = now; // when it was typed in; a reading taken earlier shows as entered late
      const keys = Object.keys(data).filter((k) => def.cols.includes(k) || (k === 'entered_at' && def.entered));
      const extraCols = def.recorder ? [def.recorder] : [];
      const [r] = await conn.query(
        `INSERT INTO \`${def.table}\` (tenant_id, ${parentCol}, ${[...keys, ...extraCols].map((k) => `\`${k}\``).join(', ')}) VALUES (?, ?, ${[...keys, ...extraCols].map(() => '?').join(', ')})`,
        [req.auth.tenantId, parent, ...keys.map((k) => data[k]), ...(def.recorder ? [req.auth.userId] : [])],
      );
      if (def.after) await def.after(conn, req, parent, data, now);
      if (def.afterInsert) await def.afterInsert(conn, req, parent, data, r.insertId, checked, id);
      await audit(conn, req, `add_${name}`, 'incidents', id, { row: r.insertId });
      return r.insertId;
    });
    let newId;
    try { newId = await save(); } catch (err) {
      // Two copies of the same entry arrived at once: the second finds the first.
      if (err.code !== 'ER_DUP_ENTRY' || !req.body.client_ref) throw err;
      newId = (await one(pool, `SELECT id FROM \`${def.table}\` WHERE tenant_id = ? AND client_ref = ?`, [req.auth.tenantId, req.body.client_ref])).id;
    }
    res.status(201).json({ id: newId });
  });

  if (def.voidable) {
    // Clinical rows (and witnesses) are never deleted: a wrong entry is marked "entered in error" with a reason and stays
    // on the record, struck through. For witnesses, the older DELETE does the same and needs a reason too.
    const voidRoute = async (req, res) => {
      const id = paramId(req);
      await tx(async (conn) => {
        const held = await editableCase(conn, req, id);
        if (Number(held.legal_hold)) throw conflict('This case is on legal hold: nothing on it can be marked entered in error. Add a note instead.');
        const parent = await parentId(conn, req, id);
        const rowId = paramId(req, 'rowId');
        const row = await one(conn, `SELECT id, voided_at FROM \`${def.table}\` WHERE tenant_id = ? AND ${parentCol} = ? AND id = ?`, [req.auth.tenantId, parent, rowId]);
        if (!row) throw notFound('Record');
        if (row.voided_at) throw conflict('Already marked entered in error');
        const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
        await conn.query(`UPDATE \`${def.table}\` SET voided_at = ?, void_reason = ?, voided_by = ? WHERE tenant_id = ? AND id = ?`, [nowIn(tenant.timezone), req.body.reason, req.auth.userId, req.auth.tenantId, rowId]);
        if (name === 'treatments') await MEDS.returnStock(conn, req, { id: rowId }, nowIn(tenant.timezone));
        await audit(conn, req, `void_${name}`, 'incidents', id, { row: rowId, reason: req.body.reason });
      });
      res.json({ ok: true });
    };
    router.post(`${base}/:rowId/void`, patrol, needs('create_case'), validate(voidSchema), voidRoute);
    if (def.deleteVoids) router.delete(`${base}/:rowId`, patrol, needs('create_case'), validate(voidSchema), voidRoute);
  } else {
    router.delete(`${base}/:rowId`, patrol, needs('create_case'), async (req, res) => {
      const id = paramId(req);
      await tx(async (conn) => {
        await editableCase(conn, req, id);
        const parent = await parentId(conn, req, id);
        // A statement the witness wrote on their own phone is theirs: it is marked entered in error, never removed.
        if (name === 'witnesses' && await one(conn, "SELECT id FROM incident_witnesses WHERE tenant_id = ? AND incident_id = ? AND id = ? AND source = 'link'", [req.auth.tenantId, parent, paramId(req, 'rowId')])) throw conflict('The witness wrote this statement themselves, so it cannot be removed. Mark it entered in error with a reason.');
        const [r] = await conn.query(`DELETE FROM \`${def.table}\` WHERE tenant_id = ? AND ${parentCol} = ? AND id = ?`, [req.auth.tenantId, parent, paramId(req, 'rowId')]);
        if (!r.affectedRows) throw notFound('Record');
        await audit(conn, req, `remove_${name}`, 'incidents', id, { row: paramId(req, 'rowId') });
      });
      res.status(204).end();
    });
  }
}

/** The effect of a medication is seen some minutes after it is given, so it is added to the row afterwards. */
router.post('/incidents/:id/patients/:pid/treatments/:rowId/effect', patrol, needs('create_case'), validate(z.object({ effect: z.string().trim().min(1).max(255) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await editableCase(conn, req, id);
    const t = await one(conn, 'SELECT t.id, t.kind, t.detail, IFNULL(t.voided_at, p.voided_at) AS voided_at FROM incident_treatments t JOIN incident_patients p ON p.id = t.patient_id AND p.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND p.incident_id = ? AND t.patient_id = ? AND t.id = ?', [req.auth.tenantId, id, paramId(req, 'pid'), paramId(req, 'rowId')]);
    if (!t) throw notFound('Treatment');
    if (t.voided_at) throw conflict('This entry was marked entered in error');
    if (t.kind !== 'medication') throw bad('An effect is recorded for a medication');
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
    const detail = { ...parseDetail(t.detail), effect: req.body.effect, effect_at: nowIn(tenant.timezone) };
    await conn.query('UPDATE incident_treatments SET detail = ? WHERE tenant_id = ? AND id = ?', [JSON.stringify(detail), req.auth.tenantId, t.id]);
    await audit(conn, req, 'treatment_effect', 'incidents', id, { row: t.id });
  });
  res.json({ ok: true });
});

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
    if (req.body.role === 'lead') await conn.query("UPDATE incident_responders SET role = 'assist' WHERE tenant_id = ? AND incident_id = ? AND role = 'lead' AND voided_at IS NULL", [req.auth.tenantId, id]);
    // Someone marked entered in error and then added again comes back on the same row (one per person per case); the
    // earlier marking stays in the audit trail.
    const [r] = await conn.query(
      'INSERT INTO incident_responders (tenant_id, incident_id, staff_id, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), voided_at = NULL, void_reason = NULL, voided_by = NULL, id = LAST_INSERT_ID(id)',
      [req.auth.tenantId, id, req.body.staff_id, req.body.role],
    );
    await audit(conn, req, 'add_responders', 'incidents', id, req.body);
    return r.insertId;
  });
  res.status(201).json({ id: newId });
});

/** A responder named by mistake is marked entered in error with a reason, never removed. DELETE does the same. */
async function voidResponder(req, res) {
  const id = paramId(req);
  await tx(async (conn) => {
    await editableCase(conn, req, id);
    const r = await voidCaseRow(conn, req, id, 'incident_responders', paramId(req, 'rowId'), 'Responder');
    await audit(conn, req, 'void_responders', 'incidents', id, { row: Number(r.id), staff_id: Number(r.staff_id), reason: req.body.reason });
  });
  res.json({ ok: true });
}
router.post('/incidents/:id/responders/:rowId/void', patrol, needs('create_case'), validate(voidSchema), voidResponder);
router.delete('/incidents/:id/responders/:rowId', patrol, needs('create_case'), validate(voidSchema), voidResponder);

// ---------------------------------------------------------------- before the patient leaves
/**
 * A checklist item skipped before the patient left (contact details, a guardian for a minor, the refusal signature,
 * witnesses, rental gear), with the reason. Never blocks the outcome or care; the reviewer sees every skip, and an item
 * neither done nor skipped holds up the submit. Works from the outbox: client_ref stops a second copy.
 */
router.post('/incidents/:id/skips', patrol, needs('create_case'), validate(z.object({
  patient_id: z.number().int().positive().nullable().optional(), item: z.enum(LEAVE.ITEM_KEYS), reason: z.enum(RQ.NA_KEYS), note: z.string().trim().max(300).nullable().optional(),
  at: dateTimeStr.transform(normDateTime).optional(), client_ref: clientRef,
})), async (req, res) => {
  const id = paramId(req);
  const b = req.body;
  if (b.reason === 'other' && !b.note) throw bad('Say why, when the reason is Other');
  const newId = await tx(async (conn) => {
    await editableCase(conn, req, id);
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT id FROM incident_skips WHERE tenant_id = ? AND client_ref = ?', [req.auth.tenantId, b.client_ref]);
      if (seen) return seen.id;
    }
    if (b.patient_id && !(await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ? AND voided_at IS NULL', [req.auth.tenantId, id, b.patient_id]))) throw notFound('Patient');
    const now = nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone);
    const at = b.at && b.at <= plusMin(now, 5) && b.at >= plusMin(now, -72 * 60) ? b.at : now;
    const [r] = await conn.query('INSERT INTO incident_skips (tenant_id, incident_id, patient_id, gate, item_key, reason, note, skipped_by, skipped_at, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.auth.tenantId, id, b.patient_id || null, 'leave', b.item, b.reason, b.note || null, req.auth.userId, at, b.client_ref || null]);
    await audit(conn, req, 'skip_leave_item', 'incidents', id, { item: b.item, patient_id: b.patient_id || null, reason: b.reason });
    return r.insertId;
  });
  res.status(201).json({ id: newId });
});

// ---------------------------------------------------------------- signatures (add only, and allowed while a report is open)
const MAX_SIGNATURE_CHARS = 90_000; // a drawn signature is a few KB; this also keeps requests under the 100 KB body limit
router.post(
  '/incidents/:id/signatures',
  patrol, needs('create_case'),
  validate(z.object({
    kind: z.enum(['refusal_of_care', 'patient_acknowledgment', 'witness', 'patroller', 'receiving_provider']),
    signer_name: z.string().min(1).max(150),
    signer_role: z.string().max(150).optional(),
    patient_id: z.number().int().positive().optional(),
    image: z.string().max(MAX_SIGNATURE_CHARS).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, 'The signature must be a PNG image'),
    // A phone with no signal keeps the signature and sends it later: client_ref stops a second copy, signed_at keeps the real time.
    client_ref: clientRef, signed_at: dateTimeStr.transform(normDateTime).optional(),
  })),
  async (req, res) => {
    const id = paramId(req);
    const b = req.body;
    if (b.client_ref) {
      const seen = await one(pool, 'SELECT id FROM incident_signatures WHERE tenant_id = ? AND client_ref = ?', [req.auth.tenantId, b.client_ref]);
      if (seen) return res.status(201).json({ id: seen.id });
    }
    const newId = await tx(async (conn) => {
      await editableCase(conn, req, id);
      const p = b.patient_id ? await one(conn, 'SELECT id, form, voided_at FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, b.patient_id]) : null;
      if (b.patient_id && !p) throw notFound('Patient');
      if (p && p.voided_at) throw conflict('This patient was marked entered in error');
      if ((b.kind === 'refusal_of_care' || b.kind === 'receiving_provider') && !p) throw bad('Say which patient this signature is for');
      // A patient who cannot make the decision cannot refuse: care continues under implied consent.
      if (b.kind === 'refusal_of_care' && parseForm(p.form).refusal_capacity === 'no') throw conflict('This patient is recorded as not able to decide, so they cannot refuse care. Treat under implied consent and escalate to the lead or EMS.');
      const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
      // signed_at is kept on the mountain clock, like every other time on the report. A signature sent late by a phone that
      // had no signal keeps the time it was signed (never in the future, never more than three days back).
      const now = nowIn(tz);
      const late = b.signed_at && b.signed_at <= plusMin(now, 5) && b.signed_at >= plusMin(now, -72 * 60) ? b.signed_at : null;
      const [r] = await conn.query('INSERT INTO incident_signatures (tenant_id, incident_id, patient_id, kind, signer_name, signer_role, image, recorded_by, signed_at, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, id, b.patient_id ?? null, b.kind, b.signer_name, b.signer_role ?? null, b.image, req.auth.userId, late || now, b.client_ref || null]);
      await audit(conn, req, 'add_signature', 'incidents', id, { kind: b.kind, row: r.insertId, ...(late ? { sent_late: true } : {}) });
      return r.insertId;
    });
    res.status(201).json({ id: newId });
  },
);

router.get('/incidents/:id/signatures/:rowId', patrol, needs('view_cases'), async (req, res) => {
  const row = await one(pool, 'SELECT id, patient_id, kind, signer_name, signer_role, image, signed_at FROM incident_signatures WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, paramId(req), paramId(req, 'rowId')]);
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
router.voidCaseRow = voidCaseRow;
router.voidSchema = voidSchema;
router.loadCase = loadCase; // the claim file assembles the same case (routes/patrolclaims.js)
module.exports = router;
