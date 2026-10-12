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
const { FIELDS, SECTIONS, formSchema, parseForm, mergeForm, isEmpty, applies } = require('../lib/nsaar');
const { requiredFields } = require('../lib/formconfig');
const { buildPull, ageOn } = require('../lib/patrolpull');
const { derive, parseDetail } = require('../lib/carederive');

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
router.get('/patients.csv', patrol, needs('reports'), async (req, res) => {
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
    one(pool, `SELECT COUNT(*) AS cases, (SELECT COUNT(*) FROM incident_patients p JOIN incidents x ON x.id = p.incident_id AND x.tenant_id = p.tenant_id WHERE x.tenant_id = ? AND DATE(x.occurred_at) BETWEEN ? AND ? AND p.voided_at IS NULL) AS patients FROM incidents i WHERE ${inRange}`, [...range, ...range]),
    group(`SELECT category AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY category ORDER BY n DESC`),
    group(`SELECT severity AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY severity ORDER BY n DESC`),
    group(`SELECT HOUR(occurred_at) AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY label ORDER BY label`),
    group(`SELECT DAYOFWEEK(occurred_at) - 1 AS label, COUNT(*) AS n FROM incidents i WHERE ${inRange} GROUP BY label ORDER BY label`),
    group(`SELECT COALESCE(t.name, i.location) AS label, COUNT(*) AS n FROM incidents i LEFT JOIN trails t ON t.id = i.trail_id AND t.tenant_id = i.tenant_id WHERE ${inRange} GROUP BY COALESCE(t.name, i.location) ORDER BY n DESC LIMIT 10`),
    group(`SELECT COALESCE(p.disposition, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.activity')), p.activity, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.ability')), p.ability, 'not_recorded') AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL GROUP BY label ORDER BY n DESC`),
    group(`SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.helmet')), p.helmet) AS label, COUNT(*) AS n FROM incident_patients p JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id WHERE ${inRange} AND p.voided_at IS NULL AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.activity')), p.activity) IN ('ski','snowboard','other_snow','alpine','telemark','nordic','touring')) GROUP BY label`),
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
const VOIDED_BY = (t) => `LEFT JOIN users vu ON vu.id = ${t}.voided_by AND vu.tenant_id = ${t}.tenant_id`;
/**
 * Everything on one case, as the case page and the frozen versions show it. Rows marked entered in error are included
 * (with who marked them and why) so the record shows them struck through. Each patient carries `derived`: the form
 * answers that can be worked out from the bedside entries.
 */
async function loadCase(conn, tenantId, id) {
  const incident = await one(conn, 'SELECT i.*, t.name AS trail FROM incidents i LEFT JOIN trails t ON t.id = i.trail_id AND t.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND i.id = ?', [tenantId, id]);
  if (!incident) return null;
  const [notes, patients, events, responders, witnesses, signatures, collisionRow, parties, checklist, versions] = await Promise.all([
    rows(conn, 'SELECT n.id, n.author_user, u.email AS author, n.body, n.created_at FROM incident_notes n LEFT JOIN users u ON u.id = n.author_user AND u.tenant_id = n.tenant_id WHERE n.tenant_id = ? AND n.incident_id = ? ORDER BY n.id', [tenantId, id]),
    rows(conn, `SELECT p.*, vu.email AS voided_by_email FROM incident_patients p ${VOIDED_BY('p')} WHERE p.tenant_id = ? AND p.incident_id = ? ORDER BY p.id`, [tenantId, id]),
    rows(conn, `SELECT e.id, e.kind, e.at, e.note, e.patient_id, e.entered_at, e.voided_at, e.void_reason, vu.email AS voided_by_email FROM incident_events e ${VOIDED_BY('e')} WHERE e.tenant_id = ? AND e.incident_id = ? ORDER BY e.at, e.id`, [tenantId, id]),
    rows(conn, `SELECT r.id, r.staff_id, r.role, p.first_name, p.last_name, m.patrol_number, m.callsign FROM incident_responders r JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id LEFT JOIN patrol_members m ON m.staff_id = r.staff_id AND m.tenant_id = r.tenant_id WHERE r.tenant_id = ? AND r.incident_id = ? ORDER BY FIELD(r.role, 'lead', 'assist', 'transport', 'dispatch'), r.id`, [tenantId, id]),
    rows(conn, 'SELECT id, relation, name, phone, email, address, city, region, postal, statement FROM incident_witnesses WHERE tenant_id = ? AND incident_id = ? ORDER BY id', [tenantId, id]),
    rows(conn, 'SELECT id, patient_id, kind, signer_name, signer_role, signed_at FROM incident_signatures WHERE tenant_id = ? AND incident_id = ? ORDER BY id', [tenantId, id]),
    one(conn, 'SELECT * FROM incident_collisions WHERE tenant_id = ? AND incident_id = ?', [tenantId, id]),
    rows(conn, 'SELECT * FROM incident_parties WHERE tenant_id = ? AND incident_id = ? ORDER BY id', [tenantId, id]),
    rows(conn, 'SELECT c.patient_id, c.item_key, c.done_at, u.email AS done_by FROM incident_checklist c LEFT JOIN users u ON u.id = c.done_by AND u.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.incident_id = ? ORDER BY c.id', [tenantId, id]),
    rows(conn, 'SELECT v.id, v.version_no, v.kind, v.created_at, u.email AS created_by FROM incident_versions v LEFT JOIN users u ON u.id = v.created_by AND u.tenant_id = v.tenant_id WHERE v.tenant_id = ? AND v.incident_id = ? ORDER BY v.version_no', [tenantId, id]),
  ]);
  const ids = patients.map((p) => p.id);
  const byPatient = async (sql) => (ids.length ? rows(conn, sql, [tenantId, ids]) : []);
  const [vitals, injuries, treatments] = await Promise.all([
    byPatient(`SELECT x.*, vu.email AS voided_by_email FROM incident_vitals x ${VOIDED_BY('x')} WHERE x.tenant_id = ? AND x.patient_id IN (?) ORDER BY x.taken_at, x.id`),
    byPatient(`SELECT x.*, vu.email AS voided_by_email FROM incident_injuries x ${VOIDED_BY('x')} WHERE x.tenant_id = ? AND x.patient_id IN (?) ORDER BY x.id`),
    byPatient(`SELECT x.*, vu.email AS voided_by_email, CONCAT(pp.first_name, ' ', pp.last_name) AS performed_by_name FROM incident_treatments x ${VOIDED_BY('x')}
      LEFT JOIN staff st ON st.id = x.performed_by_staff AND st.tenant_id = x.tenant_id LEFT JOIN people pp ON pp.id = st.person_id AND pp.tenant_id = st.tenant_id
      WHERE x.tenant_id = ? AND x.patient_id IN (?) ORDER BY x.performed_at, x.id`),
  ]);
  for (const t of treatments) t.detail = parseDetail(t.detail);
  const mine = (list, pid) => list.filter((x) => x.patient_id === pid);
  const tenant = await one(conn, 'SELECT name, legal_name FROM tenants WHERE id = ?', [tenantId]);
  const c = {
    ...withNumber(incident), form: parseForm(incident.form), resort: { name: tenant.name, legal_name: tenant.legal_name }, notes, events, responders, witnesses, signatures,
    collision: collisionRow || null, parties, checklist, versions,
    patients: patients.map((p) => ({ ...p, form: parseForm(p.form), vitals: mine(vitals, p.id), injuries: mine(injuries, p.id), treatments: mine(treatments, p.id) })),
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
  res.json(c);
});

/** The frozen copies kept each time the report was submitted or approved. */
router.get('/incidents/:id/versions/:vid', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req);
  const v = await one(pool, 'SELECT v.id, v.version_no, v.kind, v.snapshot, v.created_at, u.email AS created_by FROM incident_versions v LEFT JOIN users u ON u.id = v.created_by AND u.tenant_id = v.tenant_id WHERE v.tenant_id = ? AND v.incident_id = ? AND v.id = ?', [req.auth.tenantId, id, paramId(req, 'vid')]);
  if (!v) throw notFound('Version');
  await audit(pool, req, 'view_version', 'incidents', id, { version: v.version_no });
  res.json({ id: v.id, version_no: v.version_no, kind: v.kind, created_at: v.created_at, created_by: v.created_by, case: JSON.parse(v.snapshot) });
});

/**
 * Loads a case for editing. Approved reports are locked. A submitted report is waiting for a manager, so only
 * managers change it until it is sent back. Row-locks the case so two phones cannot interleave a state change.
 */
async function editableCase(conn, req, id) {
  const inc = await one(conn, 'SELECT * FROM incidents WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
  if (!inc) throw notFound('Incident');
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
    await conn.query(`UPDATE incidents SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    await audit(conn, req, 'update', 'incidents', id, { fields: Object.keys(req.body).map((k) => (k === 'form' ? `form:${Object.keys(req.body.form).join('|')}` : k)) });
  });
  res.json({ ok: true });
});

router.post('/incidents/:id/notes', patrol, needs('create_case'), validate(z.object({ body: z.string().min(1).max(5000) })), async (req, res) => {
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Incident');
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
  const [r] = await pool.query('INSERT INTO incident_notes (tenant_id, incident_id, author_user, body, created_at) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, id, req.auth.userId, req.body.body, nowIn(tz)]);
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
  const c = await loadCase(conn, tenantId, inc.id);
  const patients = c.patients.filter((p) => !p.voided_at); // a patient entered in error is not part of the report
  if (!patients.length) problem('Add at least one patient', { area: 'patients' });
  const { signatures } = c;
  const title = new Map(SECTIONS.map((x) => [x.id, x.title]));

  // Case-level fields (location, conditions, witnesses, sign-off)
  const caseForm = parseForm(inc.form);
  const caseVals = Object.fromEntries(FIELDS.filter((f) => f.scope === 'case').map((f) => [f.key, fieldValue(f, inc, caseForm)]));
  for (const f of FIELDS.filter((x) => x.scope === 'case' && required.case.has(x.key))) {
    if (!applies(f, caseVals)) continue;
    let missing;
    if (f.type === 'witnesses') missing = !c.witnesses.length && !caseForm.witnesses_none;
    else if (f.type === 'signature') missing = !signatures.some((s) => s.kind === f.kind);
    else missing = isEmpty(caseVals[f.key]);
    if (missing) problem(`${title.get(f.section)}: ${f.label}`, { scope: 'case', section: f.section, field: f.key });
  }

  // Patient-level fields. An answer worked out from the bedside entries counts as given.
  for (const p of patients) {
    const who = `${p.first_name} ${p.last_name}`.trim();
    const form = { ...p.derived, ...p.form };
    const vals = Object.fromEntries(FIELDS.filter((f) => f.scope === 'patient').map((f) => [f.key, fieldValue(f, p, form)]));
    for (const f of FIELDS.filter((x) => x.scope === 'patient' && required.patient.has(x.key))) {
      if (!applies(f, vals)) continue;
      let missing;
      if (f.type === 'signature') missing = !signatures.some((s) => s.kind === f.kind && (s.patient_id === p.id || s.patient_id === null));
      else missing = isEmpty(vals[f.key]);
      if (missing) problem(`${who}: ${f.label}`, { scope: 'patient', patient_id: p.id, section: f.section, field: f.key });
    }
    // Safety rules that no setting can switch off.
    if (p.disposition === 'refused_care') {
      const pf = p.form || {};
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
  if (!c.responders.some((r) => r.role === 'lead')) problem('Add the patroller who led the response', { area: 'responders' });
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

async function setState(req, res, { from, to, check, extra, version }) {
  const id = paramId(req);
  let out = { ok: true };
  await tx(async (conn) => {
    const inc = await one(conn, 'SELECT * FROM incidents WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!inc) throw notFound('Incident');
    if (!from.includes(inc.report_state)) throw conflict(`This report is ${inc.report_state}`);
    if (check) {
      const problems = await reportProblems(conn, req.auth.tenantId, inc);
      if (problems.length) throw conflict('The report is not complete yet', problems);
    }
    const filled = check ? await fillFromBedside(conn, req, inc) : [];
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
    const result = await extra(conn, inc, nowIn(tenant.timezone));
    const vk = typeof version === 'function' ? version(result) : version;
    const v = vk ? await keepVersion(conn, req, id, vk) : null;
    await audit(conn, req, to, 'incidents', id, { ...(v ? { version: v } : {}), ...(filled.length ? { filled_from_bedside: filled } : {}), ...(result && result.audit ? result.audit : {}) });
    out = { ok: true, ...(result && result.reply ? result.reply : {}) };
  });
  res.json(out);
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
  from: ['draft'], to: 'submit', check: true, version: (r) => (r && r.reply && r.reply.review === 'not_required' ? 'approved' : 'submitted'),
  extra: async (conn, inc, now) => {
    await conn.query("UPDATE incidents SET report_state = 'submitted', submitted_by = ?, submitted_at = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, now, inc.tenant_id, inc.id]);
    const routed = await R.afterSubmit(conn, req, { ...inc, submitted_by: req.auth.userId }, now);
    return { reply: { review: routed }, audit: { review: routed } };
  },
}));

const checklist = z.record(z.enum(R.CHECK_KEYS), z.boolean());
router.post('/incidents/:id/approve', patrol, reviewer, validate(z.object({ checklist: checklist.optional(), note: z.string().trim().max(1000).optional() }).default({})), async (req, res, next) => {
  const s = await R.settingsOf(pool, req.auth.tenantId);
  if (s.enabled && R.CHECK_KEYS.some((k) => !(req.body.checklist || {})[k])) return next(bad('Tick every review check before approving. If a check does not apply, it is fine: tick it.'));
  return setState(req, res, {
    // With a review group, only a signed-off report can be approved, and never by the person who signed it off.
    from: s.enabled ? ['submitted'] : ['draft', 'submitted'], to: 'approve', check: true, version: 'approved',
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
    await audit(conn, req, 'update_patient', 'incidents', id, { patient_id: pid, fields: Object.keys(req.body) });
  });
  res.json({ ok: true });
});

// Nothing clinical is deleted. A patient added by mistake is marked "entered in error" with a reason, and stays on the
// record struck through; their vitals, injuries and treatments go with them. Follow-up emails that have not gone are dropped.
const voidSchema = z.object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(255) });
router.post('/incidents/:id/patients/:pid/void', patrol, needs('create_case'), validate(voidSchema), async (req, res) => {
  const id = paramId(req);
  const pid = paramId(req, 'pid');
  await tx(async (conn) => {
    await editableCase(conn, req, id);
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
      kind: z.enum(['splint', 'spinal_motion_restriction', 'bandage', 'ice', 'oxygen', 'aed', 'cpr', 'airway', 'medication', 'warming', 'rosc', 'other']),
      description: z.string().max(255).optional(), medication: z.string().max(100).optional(), dose: z.string().max(50).optional(), route: z.string().max(30).optional(),
      performed_by_staff: z.number().int().positive().optional(),
      detail: treatmentDetail.optional(), client_ref: clientRef,
    }).refine((v) => v.kind !== 'medication' || (v.medication && v.dose), 'A medication needs a name and a dose')
      .transform((v) => (v.detail ? { ...v, detail: Object.keys(v.detail).length ? JSON.stringify(v.detail) : undefined } : v)),
    cols: ['performed_at', 'kind', 'description', 'medication', 'dose', 'route', 'performed_by_staff', 'detail', 'client_ref'], recorder: 'recorded_by', entered: true, voidable: true,
  },
  events: {
    table: 'incident_events', level: 'incident', time: 'at',
    schema: z.object({ ...optionalTime('at'), kind: z.enum(['call_received', 'dispatched', 'on_scene', 'patient_contact', 'transport_started', 'at_aid_room', 'handoff', 'cleared', 'other']), note: z.string().max(255).optional(), patient_id: z.number().int().positive().optional(), client_ref: clientRef }),
    cols: ['at', 'kind', 'note', 'patient_id', 'client_ref'], recorder: 'recorded_by', entered: true, voidable: true,
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
      if (def.entered) data.entered_at = now; // when it was typed in; a reading taken earlier shows as entered late
      const keys = Object.keys(data).filter((k) => def.cols.includes(k) || (k === 'entered_at' && def.entered));
      const extraCols = def.recorder ? [def.recorder] : [];
      const [r] = await conn.query(
        `INSERT INTO \`${def.table}\` (tenant_id, ${parentCol}, ${[...keys, ...extraCols].map((k) => `\`${k}\``).join(', ')}) VALUES (?, ?, ${[...keys, ...extraCols].map(() => '?').join(', ')})`,
        [req.auth.tenantId, parent, ...keys.map((k) => data[k]), ...(def.recorder ? [req.auth.userId] : [])],
      );
      if (def.after) await def.after(conn, req, parent, data, now);
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
    // Clinical rows are never deleted: a wrong entry is marked "entered in error" with a reason and stays on the record, struck through.
    router.post(`${base}/:rowId/void`, patrol, needs('create_case'), validate(voidSchema), async (req, res) => {
      const id = paramId(req);
      await tx(async (conn) => {
        await editableCase(conn, req, id);
        const parent = await parentId(conn, req, id);
        const rowId = paramId(req, 'rowId');
        const row = await one(conn, `SELECT id, voided_at FROM \`${def.table}\` WHERE tenant_id = ? AND ${parentCol} = ? AND id = ?`, [req.auth.tenantId, parent, rowId]);
        if (!row) throw notFound('Record');
        if (row.voided_at) throw conflict('Already marked entered in error');
        const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
        await conn.query(`UPDATE \`${def.table}\` SET voided_at = ?, void_reason = ?, voided_by = ? WHERE tenant_id = ? AND id = ?`, [nowIn(tenant.timezone), req.body.reason, req.auth.userId, req.auth.tenantId, rowId]);
        await audit(conn, req, `void_${name}`, 'incidents', id, { row: rowId, reason: req.body.reason });
      });
      res.json({ ok: true });
    });
  } else {
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
    kind: z.enum(['refusal_of_care', 'patient_acknowledgment', 'witness', 'patroller', 'receiving_provider']),
    signer_name: z.string().min(1).max(150),
    signer_role: z.string().max(150).optional(),
    patient_id: z.number().int().positive().optional(),
    image: z.string().max(MAX_SIGNATURE_CHARS).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, 'The signature must be a PNG image'),
  })),
  async (req, res) => {
    const id = paramId(req);
    const b = req.body;
    const newId = await tx(async (conn) => {
      await editableCase(conn, req, id);
      const p = b.patient_id ? await one(conn, 'SELECT id, form, voided_at FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, b.patient_id]) : null;
      if (b.patient_id && !p) throw notFound('Patient');
      if (p && p.voided_at) throw conflict('This patient was marked entered in error');
      if ((b.kind === 'refusal_of_care' || b.kind === 'receiving_provider') && !p) throw bad('Say which patient this signature is for');
      // A patient who cannot make the decision cannot refuse: care continues under implied consent.
      if (b.kind === 'refusal_of_care' && parseForm(p.form).refusal_capacity === 'no') throw conflict('This patient is recorded as not able to decide, so they cannot refuse care. Treat under implied consent and escalate to the lead or EMS.');
      const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
      // signed_at is kept on the mountain clock, like every other time on the report.
      const [r] = await conn.query('INSERT INTO incident_signatures (tenant_id, incident_id, patient_id, kind, signer_name, signer_role, image, recorded_by, signed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, id, b.patient_id ?? null, b.kind, b.signer_name, b.signer_role ?? null, b.image, req.auth.userId, nowIn(tz)]);
      await audit(conn, req, 'add_signature', 'incidents', id, { kind: b.kind, row: r.insertId });
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
module.exports = router;
