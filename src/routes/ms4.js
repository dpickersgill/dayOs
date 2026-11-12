'use strict';

// Stormwater, MS4 and illicit discharge cases (release 2026.11.20, the Stormwater add-on). Mounted at /api/v1/stormwater
// next to the Stormwater Today cards. lib/stormwater.js has the permit year and the outfall screening hook.
// The MS4 screen lays the permit year (July 1 to June 30) out by the six minimum control measures, with the records the app
// holds for each: education and involvement activities, outfall screenings done against those required (and their map),
// illicit discharge cases, construction and post-construction BMP inspections, and good housekeeping (yard inspections and
// staff training sign-in). The annual report pack (printable, and as a spreadsheet) is for the engineer who writes the
// report: the app records what staff did, it does not file or certify anything.
//   GET    /ms4?year=              the permit year starting July 1 of `year` (default: the one today is in)
//   GET    /ms4.csv?year=          every record of the permit year as one spreadsheet
//   PUT    /ms4/settings           { permit_number, screenings_required } (managers)
//   POST   /ms4/activities, PATCH /ms4/activities/:id, DELETE /ms4/activities/:id (managers delete)
//   GET    /cases?status=open|closed|all, GET /cases/:id
//   POST   /cases                  a case opened by hand (a resident's report, a crew member's find)
//   PATCH  /cases/:id              status, suspected source, responsible party, resolution
//   POST   /cases/:id/entries      source tracing, an upstream inspection, a sample, a notice sent, a note
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, nowIn } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const SW = require('../lib/stormwater');

const router = express.Router();
const crew = requireRole('staff', 'manager');
const manager = requireRole('manager');
const OUTFALL = 'storm_outfall';
const BMP_KINDS = ['bmp', 'pond'];

const tzOf = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const stamp = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v ? String(v).slice(0, 19).replace('T', ' ') : null);
const NAME = "COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), u.username, u.email)";
const STATUS_WORDS = { open: 'Open', source_found: 'Source found', resolved: 'Resolved', closed: 'Closed' };
const ENTRY_WORDS = { trace: 'Source tracing', upstream: 'Upstream inspection', sample: 'Sample taken', notice: 'Notice sent', note: 'Note' };

async function yearOf(req) {
  const y = Number(req.query.year);
  if (Number.isInteger(y) && y >= 2000 && y <= 2100) return SW.permitYear(y);
  return SW.permitYearOf(nowIn(await tzOf(req.auth.tenantId)).slice(0, 10));
}
const lastAttendees = (s) => String(s || '').split(/\r?\n|;/).map((x) => x.trim()).filter(Boolean);

async function pack(t, py) {
  const from = `${py.start} 00:00:00`; const to = `${py.end} 23:59:59`;
  const settings = (await one(pool, 'SELECT permit_number, screenings_required FROM ms4_settings WHERE tenant_id = ?', [t])) || {};
  const acts = await rows(pool, `SELECT a.*, f.tag AS feature_tag, f.name AS feature_name FROM ms4_activities a LEFT JOIN map_features f ON f.tenant_id = a.tenant_id AND f.id = a.map_feature_id
    WHERE a.tenant_id = ? AND a.on_date BETWEEN ? AND ? ORDER BY a.on_date, a.id`, [t, py.start, py.end]);
  const outfalls = await rows(pool, "SELECT id, tag, name, lat, lng, condition_score, criticality, status FROM map_features WHERE tenant_id = ? AND kind = ? AND status <> 'abandoned' ORDER BY tag, id", [t, OUTFALL]);
  const screenings = await rows(pool, `SELECT i.id, i.map_feature_id, i.result, i.done_at, i.inspector, i.items FROM asset_inspections i JOIN map_features f ON f.tenant_id = i.tenant_id AND f.id = i.map_feature_id
    WHERE i.tenant_id = ? AND f.kind = ? AND i.done_at BETWEEN ? AND ? ORDER BY i.done_at`, [t, OUTFALL, from, to]);
  const bmpChecks = await rows(pool, `SELECT i.id, i.map_feature_id, i.result, i.done_at, i.inspector, i.template_name, f.tag, f.name FROM asset_inspections i JOIN map_features f ON f.tenant_id = i.tenant_id AND f.id = i.map_feature_id
    WHERE i.tenant_id = ? AND f.kind IN (?) AND i.done_at BETWEEN ? AND ? ORDER BY i.done_at`, [t, BMP_KINDS, from, to]);
  const cases = await caseList(t, { from, to });
  const MF = require('../lib/mapfeatures');
  const byOutfall = new Map();
  for (const s of screenings) { const k = Number(s.map_feature_id); if (!byOutfall.has(k)) byOutfall.set(k, []); byOutfall.get(k).push(s); }
  const outfallRows = outfalls.map((o) => {
    const list = byOutfall.get(Number(o.id)) || [];
    const last = list[list.length - 1];
    const illicit = list.some((s) => { try { return JSON.parse(s.items).some((i) => i.key === 'illicit' && String(i.value).toLowerCase() === 'yes'); } catch (_) { return false; } });
    return { id: Number(o.id), tag: o.tag, name: o.name, lat: Number(o.lat), lng: Number(o.lng), screened: list.length > 0, screenings: list.length, last_screened: last ? stamp(last.done_at) : null,
      last_result: last ? last.result : null, failed: list.some((s) => s.result === 'fail'), illicit, risk: MF.riskOf(o.condition_score, o.criticality) };
  });
  const required = settings.screenings_required === null || settings.screenings_required === undefined ? outfalls.length : Number(settings.screenings_required);
  const act = (kinds) => acts.filter((a) => kinds.includes(a.kind)).map((a) => ({
    id: Number(a.id), kind: a.kind, kind_words: SW.KIND_WORDS[a.kind], on_date: ymd(a.on_date), title: a.title, audience: a.audience, people: a.people === null ? null : Number(a.people), location: a.location,
    attendees: lastAttendees(a.attendees), result: a.result, map_feature_id: a.map_feature_id === null ? null : Number(a.map_feature_id), map_item: a.feature_tag || a.feature_name || null, notes: a.notes }));
  const sections = SW.MCMS.map((m) => ({ mcm: m.mcm, key: m.key, title: m.title, activities: act(m.kinds) }));
  return {
    permit_year: py, settings: { permit_number: settings.permit_number || null, screenings_required: settings.screenings_required === undefined ? null : settings.screenings_required, required_default: outfalls.length },
    sections,
    screenings: { required, done: outfallRows.filter((o) => o.screened).length, total_outfalls: outfalls.length, failed: outfallRows.filter((o) => o.failed).length, illicit: outfallRows.filter((o) => o.illicit).length, outfalls: outfallRows },
    cases,
    bmp_inspections: bmpChecks.map((i) => ({ id: Number(i.id), map_feature_id: Number(i.map_feature_id), map_item: i.tag || i.name, template: i.template_name, result: i.result, done_at: stamp(i.done_at), inspector: i.inspector })),
    kinds: SW.KINDS.map((k) => ({ value: k, label: SW.KIND_WORDS[k], mcm: SW.MCMS.find((m) => m.kinds.includes(k)).mcm })),
  };
}

async function caseList(t, { status = 'all', from = null, to = null } = {}) {
  const where = ['c.tenant_id = ?']; const params = [t];
  if (status === 'open') where.push("c.status IN ('open','source_found')");
  if (status === 'closed') where.push("c.status IN ('resolved','closed')");
  // In a permit year: opened in it, or still open, or closed in it.
  if (from && to) { where.push("(c.opened_at BETWEEN ? AND ? OR (c.opened_at < ? AND (c.status IN ('open','source_found') OR COALESCE(c.closed_at, c.resolved_at) >= ?)))"); params.push(from, to, from, from); }
  const list = await rows(pool, `SELECT c.*, f.tag AS outfall_tag, f.name AS outfall_name, f.lat, f.lng, (SELECT COUNT(*) FROM idd_case_entries e WHERE e.tenant_id = c.tenant_id AND e.case_id = c.id) AS entries
    FROM idd_cases c LEFT JOIN map_features f ON f.tenant_id = c.tenant_id AND f.id = c.outfall_id WHERE ${where.join(' AND ')} ORDER BY c.status IN ('resolved','closed'), c.opened_at DESC LIMIT 500`, params);
  return list.map(caseShape);
}
const caseShape = (c) => ({
  id: Number(c.id), reference: c.reference, outfall_id: c.outfall_id === null ? null : Number(c.outfall_id), outfall: c.outfall_tag || c.outfall_name || null, outfall_name: c.outfall_name || null,
  lat: c.lat === null || c.lat === undefined ? null : Number(c.lat), lng: c.lng === null || c.lng === undefined ? null : Number(c.lng),
  inspection_id: c.inspection_id === null ? null : Number(c.inspection_id), opened_at: stamp(c.opened_at), status: c.status, status_words: STATUS_WORDS[c.status], description: c.description,
  suspected_source: c.suspected_source, responsible_party: c.responsible_party, resolution: c.resolution, resolved_at: stamp(c.resolved_at), closed_at: stamp(c.closed_at), entries: c.entries === undefined ? undefined : Number(c.entries),
});

router.use(crew);

router.get('/ms4', async (req, res) => res.json(await pack(req.auth.tenantId, await yearOf(req))));

/** The annual report pack as one spreadsheet: section, measure, date, what, who or how many, result, map item, notes. */
router.get('/ms4.csv', async (req, res) => {
  const t = req.auth.tenantId;
  const py = await yearOf(req);
  const p = await pack(t, py);
  const data = [];
  for (const s of p.sections) {
    for (const a of s.activities) data.push({ measure: `MCM ${s.mcm}`, section: s.title, date: a.on_date, record: a.kind_words, what: a.title, audience: a.audience || '', people: a.kind === 'training' ? a.attendees.length || a.people || '' : a.people ?? '', result: a.result === 'na' ? '' : a.result, map_item: a.map_item || '', notes: a.notes || '' });
    if (s.mcm === 3) {
      for (const o of p.screenings.outfalls) data.push({ measure: 'MCM 3', section: s.title, date: o.last_screened ? o.last_screened.slice(0, 10) : '', record: 'Outfall screening', what: `${o.tag || o.name || `Outfall ${o.id}`}: ${o.screened ? `${o.screenings} screening${o.screenings === 1 ? '' : 's'}` : 'not screened this permit year'}`, audience: '', people: '', result: o.screened ? (o.failed ? 'fail' : 'pass') : '', map_item: o.tag || '', notes: o.illicit ? 'Suspected illicit discharge' : '' });
      for (const c of p.cases) data.push({ measure: 'MCM 3', section: s.title, date: c.opened_at.slice(0, 10), record: 'Illicit discharge case', what: `${c.reference}: ${c.status_words}${c.suspected_source ? `, ${c.suspected_source}` : ''}`, audience: '', people: '', result: '', map_item: c.outfall || '', notes: c.resolution || '' });
    }
    if (s.mcm === 5) for (const i of p.bmp_inspections) data.push({ measure: 'MCM 5', section: s.title, date: i.done_at.slice(0, 10), record: 'Stormwater facility inspection', what: i.template, audience: '', people: '', result: i.result, map_item: i.map_item || '', notes: '' });
  }
  data.unshift({ measure: '', section: 'Summary', date: `${py.start} to ${py.end}`, record: 'Outfall screenings', what: `${p.screenings.done} of ${p.screenings.required} required screened`, audience: '', people: '', result: '', map_item: '', notes: p.settings.permit_number ? `Permit ${p.settings.permit_number}` : '' });
  await audit(pool, req, 'export', 'ms4', null, { permit_year: py.year, rows: data.length });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ms4-${py.year}-${py.year + 1}.csv"` })
    .send(toCsv(['measure', 'section', 'date', 'record', 'what', 'audience', 'people', 'result', 'map_item', 'notes'], data));
});

router.put('/ms4/settings', manager, validate(z.object({ permit_number: z.string().trim().max(40).nullable().optional(), screenings_required: z.number().int().min(0).max(100000).nullable().optional() })), async (req, res) => {
  const b = req.body;
  await pool.query(`INSERT INTO ms4_settings (tenant_id, permit_number, screenings_required, updated_by) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE permit_number = VALUES(permit_number), screenings_required = VALUES(screenings_required), updated_by = VALUES(updated_by)`,
  [req.auth.tenantId, b.permit_number || null, b.screenings_required ?? null, req.auth.userId || null]);
  await audit(pool, req, 'settings', 'ms4_settings', req.auth.tenantId, b);
  res.json({ ok: true });
});

const actFields = {
  kind: z.enum(SW.KINDS),
  on_date: dateStr,
  title: z.string().trim().min(3, 'Say what it was, in a few words').max(200),
  audience: z.string().trim().max(200).nullable().optional(),
  people: z.number().int().min(0).max(1000000).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  attendees: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  result: z.enum(['pass', 'fail', 'na']).optional(),
  map_feature_id: z.number().int().positive().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
};
async function checkFeature(t, id) { if (id && !(await one(pool, 'SELECT id FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Map item'); }

router.post('/ms4/activities', validate(z.object(actFields)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await checkFeature(t, b.map_feature_id);
  const [r] = await pool.query('INSERT INTO ms4_activities (tenant_id, kind, on_date, title, audience, people, location, attendees, result, map_feature_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [t, b.kind, b.on_date, b.title, b.audience || null, b.people ?? null, b.location || null, b.attendees && b.attendees.length ? b.attendees.join('\n') : null, b.result || 'na', b.map_feature_id || null, b.notes || null, req.auth.userId || null]);
  await audit(pool, req, 'create', 'ms4_activities', r.insertId, { kind: b.kind, on_date: b.on_date });
  res.status(201).json({ id: r.insertId });
});

router.patch('/ms4/activities/:id', validate(z.object(actFields).partial()), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  if (!(await one(pool, 'SELECT id FROM ms4_activities WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Record');
  await checkFeature(t, b.map_feature_id);
  const set = []; const vals = [];
  for (const k of ['kind', 'on_date', 'title', 'audience', 'people', 'location', 'result', 'map_feature_id', 'notes']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(b[k]); }
  if (b.attendees !== undefined) { set.push('attendees = ?'); vals.push(b.attendees.length ? b.attendees.join('\n') : null); }
  if (!set.length) throw bad('Nothing to change');
  await pool.query(`UPDATE ms4_activities SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t, id]);
  await audit(pool, req, 'update', 'ms4_activities', id, Object.keys(b));
  res.json({ ok: true });
});

router.delete('/ms4/activities/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM ms4_activities WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Record');
  await audit(pool, req, 'delete', 'ms4_activities', paramId(req));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- illicit discharge cases
router.get('/cases', async (req, res) => {
  const status = ['open', 'closed', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'all';
  const outfall = Number(req.query.outfall_id);
  let list = await caseList(req.auth.tenantId, { status });
  if (Number.isInteger(outfall) && outfall > 0) list = list.filter((c) => c.outfall_id === outfall);
  res.json({ data: list, statuses: Object.entries(STATUS_WORDS).map(([value, label]) => ({ value, label })), entry_kinds: Object.entries(ENTRY_WORDS).map(([value, label]) => ({ value, label })) });
});

router.get('/cases/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const c = await one(pool, `SELECT c.*, f.tag AS outfall_tag, f.name AS outfall_name, f.lat, f.lng FROM idd_cases c LEFT JOIN map_features f ON f.tenant_id = c.tenant_id AND f.id = c.outfall_id WHERE c.tenant_id = ? AND c.id = ?`, [t, id]);
  if (!c) throw notFound('Case');
  const entries = await rows(pool, `SELECT e.id, e.kind, e.on_date, e.body, e.map_feature_id, f.tag AS feature_tag, f.name AS feature_name, ${NAME} AS author FROM idd_case_entries e
    LEFT JOIN map_features f ON f.tenant_id = e.tenant_id AND f.id = e.map_feature_id LEFT JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.user_id LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id
    WHERE e.tenant_id = ? AND e.case_id = ? ORDER BY e.on_date, e.id`, [t, id]);
  res.json({ ...caseShape(c), entries: entries.map((e) => ({ id: Number(e.id), kind: e.kind, kind_words: ENTRY_WORDS[e.kind], on_date: ymd(e.on_date), body: e.body, map_item: e.feature_tag || e.feature_name || null, map_feature_id: e.map_feature_id === null ? null : Number(e.map_feature_id), author: e.author })),
    statuses: Object.entries(STATUS_WORDS).map(([value, label]) => ({ value, label })), entry_kinds: Object.entries(ENTRY_WORDS).map(([value, label]) => ({ value, label })) });
});

const caseFields = {
  outfall_id: z.number().int().positive().nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  suspected_source: z.string().trim().max(200).nullable().optional(),
  responsible_party: z.string().trim().max(200).nullable().optional(),
};
router.post('/cases', validate(z.object({ ...caseFields, description: z.string().trim().min(3, 'Say what was found').max(1000) })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.outfall_id) {
    const f = await one(pool, 'SELECT kind FROM map_features WHERE tenant_id = ? AND id = ?', [t, b.outfall_id]);
    if (!f) throw notFound('Outfall');
    if (f.kind !== OUTFALL) throw bad('Pick a storm outfall');
  }
  const at = nowIn(await tzOf(t));
  const id = await tx(async (conn) => {
    const ref = await SW.nextCaseRef(conn, t, Number(at.slice(0, 4)));
    const [r] = await conn.query("INSERT INTO idd_cases (tenant_id, reference, outfall_id, opened_at, status, description, suspected_source, responsible_party, created_by) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)",
      [t, ref, b.outfall_id || null, at, b.description, b.suspected_source || null, b.responsible_party || null, req.auth.userId || null]);
    await audit(conn, req, 'create', 'idd_cases', r.insertId, { reference: ref, outfall_id: b.outfall_id || null });
    return r.insertId;
  });
  res.status(201).json({ id });
});

router.patch('/cases/:id', validate(z.object({ ...caseFields, status: z.enum(Object.keys(STATUS_WORDS)).optional(), resolution: z.string().trim().max(1000).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  await tx(async (conn) => {
    const c = await one(conn, 'SELECT id, status FROM idd_cases WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!c) throw notFound('Case');
    if (b.outfall_id) {
      const f = await one(conn, 'SELECT kind FROM map_features WHERE tenant_id = ? AND id = ?', [t, b.outfall_id]);
      if (!f || f.kind !== OUTFALL) throw bad('Pick a storm outfall');
    }
    if (['resolved', 'closed'].includes(b.status) && !b.resolution && !(await one(conn, 'SELECT 1 AS x FROM idd_cases WHERE tenant_id = ? AND id = ? AND resolution IS NOT NULL', [t, id]))) throw bad('Say how it was resolved before closing the case');
    const at = nowIn(await tzOf(t));
    const set = []; const vals = [];
    for (const k of ['outfall_id', 'description', 'suspected_source', 'responsible_party', 'resolution', 'status']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(b[k]); }
    if (b.status === 'resolved') { set.push('resolved_at = COALESCE(resolved_at, ?)'); vals.push(at); }
    if (b.status === 'closed') { set.push('closed_at = COALESCE(closed_at, ?)', 'resolved_at = COALESCE(resolved_at, ?)'); vals.push(at, at); }
    if (['open', 'source_found'].includes(b.status)) set.push('resolved_at = NULL', 'closed_at = NULL');
    if (!set.length) throw bad('Nothing to change');
    await conn.query(`UPDATE idd_cases SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t, id]);
    if (b.status && b.status !== c.status) await conn.query("INSERT INTO idd_case_entries (tenant_id, case_id, kind, on_date, body, user_id) VALUES (?, ?, 'note', ?, ?, ?)", [t, id, at.slice(0, 10), `Status: ${STATUS_WORDS[b.status]}.${b.resolution ? ` ${b.resolution}` : ''}`.slice(0, 2000), req.auth.userId || null]);
    await audit(conn, req, 'update', 'idd_cases', id, { fields: Object.keys(b), ...(b.status ? { from: c.status, to: b.status } : {}) });
  });
  res.json({ ok: true });
});

router.post('/cases/:id/entries', validate(z.object({ kind: z.enum(Object.keys(ENTRY_WORDS)), on_date: dateStr.optional(), body: z.string().trim().min(2).max(2000), map_feature_id: z.number().int().positive().nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  if (!(await one(pool, 'SELECT id FROM idd_cases WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Case');
  await checkFeature(t, b.map_feature_id);
  const day = b.on_date || nowIn(await tzOf(t)).slice(0, 10);
  const [r] = await pool.query('INSERT INTO idd_case_entries (tenant_id, case_id, kind, on_date, body, map_feature_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, id, b.kind, day, b.body, b.map_feature_id || null, req.auth.userId || null]);
  await audit(pool, req, 'case_entry', 'idd_cases', id, { kind: b.kind, entry_id: r.insertId });
  res.status(201).json({ id: r.insertId });
});

module.exports = { router, pack };
