'use strict';

// The annual recycling report (release 2026.11.22, Trash and recycling): Pennsylvania Act 101. See lib/recyclingreport.js.
// Staff side, mounted at /solid-waste (managers; the app on):
//   GET  /recycling-report                       the years, and the reporters list
//   POST /recycling-report/reporters, PUT /recycling-report/reporters/:id   haulers and businesses that must report
//   POST /recycling-report/:year/open            opens the year (December does it by itself)
//   GET  /recycling-report/:year, PUT /recycling-report/:year   the year's report: forms, follow-up list, settings
//   POST /recycling-report/:year/send            emails each reporter not yet answered its own link
//   GET  /recycling-report/:year/forms/:id, POST .../answer, POST .../link   one reporter's answer; the office types one in; a new link
//   POST /recycling-report/:year/close | reopen
//   GET  /recycling-report/:year/report(.csv)    the municipal report in the DEP / county columns
//   GET  /recycling-report/:year/packet(.zip)    the Section 904 grant packet
// Public side (no sign-in; the link is the key): /public/<slug>/hauler-report/:token, GET and POST.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId, todayIn } = require('../lib/util');
const { notFound, conflict, bad, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const R = require('../lib/recyclingreport');
const T = require('../lib/tonnage');

const router = express.Router();
const publicRouter = express.Router();
const managers = requireRole('manager');
const townOf = (tenantId) => one(pool, 'SELECT id, name, slug, phone, timezone FROM tenants WHERE id = ?', [tenantId]);
const yearOf = (req) => {
  const y = Number(req.params.year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw bad('Pick a year');
  return y;
};
async function reportOrThrow(db, tenantId, year, opts) {
  const r = await R.reportOf(db, tenantId, year, opts);
  if (!r) throw notFound(`The ${year} report`);
  return r;
}

const reporterShape = (p) => ({ id: Number(p.id), name: p.name, kind: p.kind, form: R.FORM_WORDS[p.kind], contact_name: p.contact_name, email: p.email, phone: p.phone, active: Boolean(p.active) });

router.get('/recycling-report', managers, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const today = todayIn(t.timezone);
  const years = await rows(pool, 'SELECT * FROM recycling_reports WHERE tenant_id = ? ORDER BY year DESC', [t.id]);
  const reporters = await rows(pool, 'SELECT * FROM recycling_reporters WHERE tenant_id = ? ORDER BY active DESC, kind, name', [t.id]);
  // The year being reported: last year until the end of November, then this year (its report opens in December).
  const current = today.slice(5) >= '12-01' ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  res.json({ today, current_year: current, years: years.map(R.shapeReport), reporters: reporters.map(reporterShape) });
});

const reporterBody = z.object({
  name: z.string().trim().min(2, 'Give the hauler’s or business’s name').max(120),
  kind: z.enum(['hauler', 'business']),
  contact_name: z.string().trim().max(120).optional().nullable(),
  email: z.string().trim().toLowerCase().email('Check the email address').max(255).optional().nullable().or(z.literal('')),
  phone: z.string().trim().max(40).optional().nullable(),
  active: z.boolean().default(true),
});
async function addToOpenReports(conn, tenantId, reporterId) {
  for (const r of await rows(conn, "SELECT id FROM recycling_reports WHERE tenant_id = ? AND status = 'open'", [tenantId])) await R.ensureForm(conn, tenantId, r.id, reporterId);
}
router.post('/recycling-report/reporters', managers, validate(reporterBody), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  const id = await tx(async (conn) => {
    if (await one(conn, 'SELECT id FROM recycling_reporters WHERE tenant_id = ? AND name = ?', [t, b.name])) throw conflict('That name is already on the list');
    const [r] = await conn.query('INSERT INTO recycling_reporters (tenant_id, name, kind, contact_name, email, phone, active) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, b.name, b.kind, b.contact_name || null, b.email || null, b.phone || null, b.active ? 1 : 0]);
    if (b.active) await addToOpenReports(conn, t, r.insertId);
    await audit(conn, req, 'recycling_reporter', 'recycling_reporters', r.insertId, { name: b.name, kind: b.kind });
    return Number(r.insertId);
  });
  res.status(201).json({ id });
});
router.put('/recycling-report/reporters/:id', managers, validate(reporterBody), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  await tx(async (conn) => {
    if (await one(conn, 'SELECT id FROM recycling_reporters WHERE tenant_id = ? AND name = ? AND id <> ?', [t, b.name, paramId(req)])) throw conflict('That name is already on the list');
    const [r] = await conn.query('UPDATE recycling_reporters SET name = ?, kind = ?, contact_name = ?, email = ?, phone = ?, active = ? WHERE tenant_id = ? AND id = ?', [b.name, b.kind, b.contact_name || null, b.email || null, b.phone || null, b.active ? 1 : 0, t, paramId(req)]);
    if (!r.affectedRows) throw notFound('Reporter');
    if (b.active) await addToOpenReports(conn, t, paramId(req));
    await audit(conn, req, 'recycling_reporter_change', 'recycling_reporters', paramId(req), { name: b.name, kind: b.kind, active: b.active });
  });
  res.json({ ok: true });
});

router.post('/recycling-report/:year/open', managers, async (req, res) => {
  const y = yearOf(req); const t = await townOf(req.auth.tenantId);
  if (y > Number(todayIn(t.timezone).slice(0, 4))) throw bad('A report opens for this year or an earlier one');
  const r = await tx((conn) => R.open(conn, t.id, y, { by: req.auth.userId }));
  res.status(201).json(R.shapeReport(r));
});

router.get('/recycling-report/:year', managers, async (req, res) => {
  const y = yearOf(req); const t = await townOf(req.auth.tenantId);
  const r = await reportOrThrow(pool, t.id, y);
  const forms = await R.formsOf(pool, t.id, r.id);
  const today = todayIn(t.timezone);
  const rep = await R.build(pool, t.id, y);
  res.json({ ...R.shapeReport(r), today, forms, followup_due: today >= String(r.followup_on).slice(0, 10), followup: await R.followupList(pool, t.id, r.id),
    summary: { total: rep.totals.total, residue: rep.totals.residue, trash_tons: rep.trash_tons, recycling_rate: rep.recycling_rate, answered: forms.filter((f) => f.answered_at).length, forms: forms.filter((f) => f.active).length } });
});

router.put('/recycling-report/:year', managers, validate(z.object({
  county: z.string().trim().min(2).max(60),
  due_on: dateStr, followup_on: dateStr,
  households: z.number().int().min(0).max(10_000_000).optional().nullable(),
  population: z.number().int().min(0).max(100_000_000).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
})), async (req, res) => {
  const y = yearOf(req); const b = req.body; const t = req.auth.tenantId;
  if (b.followup_on > b.due_on) throw bad('The follow-up day comes before the day the report is due');
  const r = await reportOrThrow(pool, t, y);
  await pool.query('UPDATE recycling_reports SET county = ?, due_on = ?, followup_on = ?, households = ?, population = ?, notes = ? WHERE tenant_id = ? AND id = ?',
    [b.county, b.due_on, b.followup_on, b.households || null, b.population || null, b.notes || null, t, r.id]);
  await audit(pool, req, 'recycling_report_change', 'recycling_reports', r.id, { year: y, county: b.county, due_on: b.due_on, followup_on: b.followup_on, households: b.households || null });
  res.json({ ok: true });
});

router.post('/recycling-report/:year/send', managers, validate(z.object({ reporter_ids: z.array(z.number().int().positive()).max(500).optional(), kind: z.enum(['send', 'remind']).default('send') })), async (req, res) => {
  const y = yearOf(req);
  await reportOrThrow(pool, req.auth.tenantId, y);
  res.json(await R.mailForms(req.auth.tenantId, y, baseUrl(req), { reporterIds: req.body.reporter_ids || null, kind: req.body.kind, by: req.auth.userId }));
});

async function formOf(db, tenantId, reportId, id) {
  const f = await one(db, `SELECT f.*, p.name, p.kind FROM recycling_report_forms f JOIN recycling_reporters p ON p.tenant_id = f.tenant_id AND p.id = f.reporter_id
    WHERE f.tenant_id = ? AND f.report_id = ? AND f.id = ?`, [tenantId, reportId, id]);
  if (!f) throw notFound('Form');
  return f;
}
router.get('/recycling-report/:year/forms/:id', managers, async (req, res) => {
  const t = req.auth.tenantId; const r = await reportOrThrow(pool, t, yearOf(req));
  const f = await formOf(pool, t, r.id, paramId(req));
  res.json({ id: Number(f.id), reporter: f.name, kind: f.kind, form: R.FORM_WORDS[f.kind], answered_at: f.answered_at, answered_by: f.answered_by, answer_name: f.answer_name, none_to_report: Boolean(f.none_to_report),
    lines: await R.linesOf(pool, t, f.id), materials: R.REPORTABLE, columns: R.COLUMNS.map((c) => ({ key: c, label: T.SECTORS[c] })) });
});
const lineSchema = z.object({
  material: z.string().max(30),
  res_curb: z.number().min(0).max(100000).default(0), res_dropoff: z.number().min(0).max(100000).default(0),
  com_curb: z.number().min(0).max(100000).default(0), com_dropoff: z.number().min(0).max(100000).default(0),
  residue: z.number().min(0).max(100000).default(0),
  processor: z.string().trim().max(160).default(''),
});
const answerSchema = z.object({ lines: z.array(lineSchema).max(40).default([]), none: z.boolean().default(false), name: z.string().trim().max(120).optional().nullable(), website: z.string().max(200).optional() });
router.post('/recycling-report/:year/forms/:id/answer', managers, validate(answerSchema), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await reportOrThrow(conn, t, yearOf(req), { lock: true });
    if (r.status !== 'open') throw conflict('This report is closed. Open it again to change an answer.');
    const f = await formOf(conn, t, r.id, paramId(req));
    await R.saveAnswer(conn, t, f.id, { lines: req.body.lines, none: req.body.none, name: req.body.name, by: 'office', userId: req.auth.userId });
  });
  res.json({ ok: true });
});
/** A fresh link for one reporter, to give by phone or paste into an email (the one before it stops working). */
router.post('/recycling-report/:year/forms/:id/link', managers, async (req, res) => {
  const t = await townOf(req.auth.tenantId); const r = await reportOrThrow(pool, t.id, yearOf(req));
  if (r.status !== 'open') throw conflict('This report is closed. Open it again to give out a link.');
  const f = await formOf(pool, t.id, r.id, paramId(req));
  const tok = R.newToken();
  await pool.query('UPDATE recycling_report_forms SET token_hash = ?, sent_at = COALESCE(sent_at, UTC_TIMESTAMP()) WHERE tenant_id = ? AND id = ?', [R.hash(tok), t.id, f.id]);
  await audit(pool, req, 'recycling_form_link', 'recycling_report_forms', f.id, { year: r.year });
  res.json({ link: R.formLink(baseUrl(req), t.slug, tok) });
});

router.post('/recycling-report/:year/close', managers, async (req, res) => {
  const t = req.auth.tenantId; const r = await reportOrThrow(pool, t, yearOf(req));
  // Closing ends every form link of the year: a reporter's link opens nothing after this.
  await pool.query("UPDATE recycling_reports SET status = 'closed', closed_at = UTC_TIMESTAMP(), closed_by = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, t, r.id]);
  await pool.query('UPDATE recycling_report_forms SET token_hash = NULL WHERE tenant_id = ? AND report_id = ?', [t, r.id]);
  await audit(pool, req, 'recycling_report_close', 'recycling_reports', r.id, { year: r.year });
  res.json({ ok: true });
});
router.post('/recycling-report/:year/reopen', managers, async (req, res) => {
  const t = req.auth.tenantId; const r = await reportOrThrow(pool, t, yearOf(req));
  await pool.query("UPDATE recycling_reports SET status = 'open', closed_at = NULL, closed_by = NULL WHERE tenant_id = ? AND id = ?", [t, r.id]);
  await audit(pool, req, 'recycling_report_reopen', 'recycling_reports', r.id, { year: r.year });
  res.json({ ok: true });
});

router.get('/recycling-report/:year/report', managers, async (req, res) => res.json(await R.build(pool, req.auth.tenantId, yearOf(req))));
router.get('/recycling-report/:year/report.csv', managers, async (req, res) => {
  const y = yearOf(req);
  const rep = await R.build(pool, req.auth.tenantId, y);
  await audit(pool, req, 'recycling_report_export', 'recycling_reports', rep.report ? rep.report.id : null, { year: y });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="recycling-report-${y}.csv"`).send(R.csvOf(rep));
});
router.get('/recycling-report/:year/packet', managers, async (req, res) => res.json(await R.packet(pool, req.auth.tenantId, yearOf(req))));
router.get('/recycling-report/:year/packet.zip', managers, async (req, res) => {
  const y = yearOf(req);
  const out = await R.packetZip(pool, req.auth.tenantId, y);
  await audit(pool, req, 'recycling_packet_zip', 'recycling_reports', null, { year: y, photos: out.photos });
  res.set('Content-Type', 'application/zip').set('Content-Disposition', `attachment; filename="section-904-${y}.zip"`).set('Cache-Control', 'private, no-store').send(out.zip);
});

// ---------------------------------------------------------------- public: the reporter's form
const ENDED = () => new AppError(404, 'This link has ended or is not right. Please ask the municipal office for a new one.');
const noStore = (res) => res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
async function formView(f) {
  return {
    town: f.town, phone: f.town_phone, year: Number(f.year), reporter: f.reporter, kind: f.reporter_kind, form: R.FORM_WORDS[f.reporter_kind], due_on: String(f.due_on).slice(0, 10),
    due_words: require('../lib/bulkpickup').longDay(f.due_on), answered_at: f.answered_at, none_to_report: Boolean(f.none_to_report), answer_name: f.answer_name,
    lines: await R.linesOf(pool, f.tenant_id, f.id), materials: R.REPORTABLE, columns: R.COLUMNS.map((c) => ({ key: c, label: T.SECTORS[c] })),
  };
}
publicRouter.get('/:slug/hauler-report/:token', async (req, res) => {
  noStore(res);
  const f = await R.formByToken(req.params.slug, req.params.token);
  if (!f) throw ENDED();
  res.json(await formView(f));
});
publicRouter.post('/:slug/hauler-report/:token', validate(answerSchema), async (req, res) => {
  noStore(res);
  if (req.body.website) return res.status(202).json({ ok: true });
  const f = await R.formByToken(req.params.slug, req.params.token);
  if (!f) throw ENDED();
  if (!req.body.name) throw bad('Give your name, as the person sending this report');
  await tx((conn) => R.saveAnswer(conn, f.tenant_id, f.id, { lines: req.body.lines, none: req.body.none, name: req.body.name, by: 'reporter' }));
  res.json(await formView(await R.formByToken(req.params.slug, req.params.token)));
});

module.exports = { router, publicRouter };
