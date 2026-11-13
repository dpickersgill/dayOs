'use strict';

// The annual recycling report (release 2026.11.22, Trash and recycling): Pennsylvania Act 101.
//
// Each year a municipality reports the previous calendar year's recycling to its county recycling coordinator, who reports
// to DEP. The app follows the DEP / county municipal report: tons by material in four columns (residential curbside,
// residential drop-off, commercial curbside, commercial drop-off), residue deducted, and the processor or market named.
// Chester County's form came first (Phoenixville); the categories are the same across counties, and lib/tonnage.js
// MATERIALS holds the list, so another county's wording is a small change.
//
//   December   the year's report opens by itself (the daily job), or a manager opens it any time.
//   Reporters  the haulers (DEP forms FM-12, FM-13) and businesses (FM-11) the municipality keeps on its list. Sending the
//              forms emails each one a link to its own online form: no login, an unguessable link (32 random bytes,
//              only its SHA-256 kept), good until the report is closed, opening only that reporter's form for that year.
//   Reminders  January 15 to those that have not answered; on February 1 a last reminder and the follow-up list (the
//              ones still not answered, with how to reach them) for the office to call.
//   The report own weigh tickets (recycled materials only; the processor's residue share deducted) plus every answer,
//              by material and column; printable and a spreadsheet for the county coordinator.
//   Section 904  the recycling performance grant packet: the totals plus the backing documents (each weigh ticket and
//              each reporter's answer), printable, and a zip of the ticket photos.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { bad, conflict, notFound } = require('./errors');
const { audit } = require('./audit');
const { todayIn } = require('./util');
const T = require('./tonnage');

const COLUMNS = T.SECTOR_KEYS; // res_curb, res_dropoff, com_curb, com_dropoff
const REPORTABLE = T.MATERIALS.filter(([k]) => k !== 'msw').map(([k, label]) => ({ key: k, label }));
const REPORTABLE_KEYS = new Set(REPORTABLE.map((m) => m.key));
const FORM_WORDS = { hauler: 'Hauler report (DEP forms FM-12 / FM-13)', business: 'Business report (DEP form FM-11)' };
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const hash = (tok) => crypto.createHash('sha256').update(String(tok)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const formLink = (base, slug, tok) => `${base}/hauler-report/${encodeURIComponent(slug)}/${tok}`;

const reportOf = async (db, tenantId, year, { lock = false } = {}) => one(db, `SELECT * FROM recycling_reports WHERE tenant_id = ? AND year = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, year]);
const shapeReport = (r) => (r ? { id: Number(r.id), year: Number(r.year), status: r.status, county: r.county, due_on: String(r.due_on).slice(0, 10), followup_on: String(r.followup_on).slice(0, 10),
  households: r.households === null ? null : Number(r.households), population: r.population === null ? null : Number(r.population), notes: r.notes || '', opened_at: r.opened_at, closed_at: r.closed_at } : null);

/** Opens the year's report (once) with a form for every active reporter. Returns the report row. */
async function open(conn, tenantId, year, { by = null } = {}) {
  const have = await reportOf(conn, tenantId, year);
  if (have) return have;
  await conn.query('INSERT IGNORE INTO recycling_reports (tenant_id, year, due_on, followup_on, opened_at, opened_by) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ?)',
    [tenantId, year, `${year + 1}-02-15`, `${year + 1}-02-01`, by]);
  const r = await reportOf(conn, tenantId, year);
  await conn.query(`INSERT IGNORE INTO recycling_report_forms (tenant_id, report_id, reporter_id) SELECT tenant_id, ?, id FROM recycling_reporters WHERE tenant_id = ? AND active = 1`, [r.id, tenantId]);
  await audit(conn, { auth: { tenantId, userId: by } }, 'recycling_report_open', 'recycling_reports', r.id, { year });
  return r;
}

/** The forms of a report, with each reporter: [{ id, reporter_id, name, kind, email, phone, contact_name, sent_at, reminded_at, followup_at, answered_at, answered_by, none_to_report, lines, tons }]. */
async function formsOf(db, tenantId, reportId) {
  const list = await rows(db, `SELECT f.id, f.reporter_id, p.name, p.kind, p.email, p.phone, p.contact_name, p.active, f.sent_at, f.reminded_at, f.followup_at, f.answered_at, f.answered_by, f.answer_name, f.none_to_report,
      (SELECT COUNT(*) FROM recycling_report_lines l WHERE l.tenant_id = f.tenant_id AND l.form_id = f.id) AS line_count,
      (SELECT COALESCE(SUM(l.res_curb + l.res_dropoff + l.com_curb + l.com_dropoff - l.residue), 0) FROM recycling_report_lines l WHERE l.tenant_id = f.tenant_id AND l.form_id = f.id) AS tons
    FROM recycling_report_forms f JOIN recycling_reporters p ON p.tenant_id = f.tenant_id AND p.id = f.reporter_id WHERE f.tenant_id = ? AND f.report_id = ? ORDER BY p.kind, p.name`, [tenantId, reportId]);
  return list.map((f) => ({ ...f, id: Number(f.id), reporter_id: Number(f.reporter_id), active: Boolean(f.active), none_to_report: Boolean(f.none_to_report), lines: Number(f.line_count), tons: r2(f.tons), form: FORM_WORDS[f.kind] }));
}

/** Adds a form for a reporter added after the report opened (while it is open). */
async function ensureForm(conn, tenantId, reportId, reporterId) {
  await conn.query('INSERT IGNORE INTO recycling_report_forms (tenant_id, report_id, reporter_id) VALUES (?, ?, ?)', [tenantId, reportId, reporterId]);
  return one(conn, 'SELECT * FROM recycling_report_forms WHERE tenant_id = ? AND report_id = ? AND reporter_id = ?', [tenantId, reportId, reporterId]);
}

/** The email asking a reporter for its numbers (or reminding it). kind: 'send', 'remind', 'last'. */
function mailWords(kind, { town, year, reporter, link, due, phone }) {
  const ask = `${town} needs your ${year} recycling tonnage for its Pennsylvania Act 101 report to the county. Please give the tons you collected in ${town} by material, the residue, and the processor or market each went to.`;
  const how = `Your form (no sign-in; this link is only for ${reporter}): ${link}`;
  const by = `Please answer by ${due}.${phone ? ` Questions? Call ${phone}.` : ''}`;
  if (kind === 'send') return { subject: `${town}: your ${year} recycling report`, text: [`Hello ${reporter},`, '', ask, '', how, '', by].join('\n') };
  if (kind === 'remind') return { subject: `Reminder: ${town} ${year} recycling report`, text: [`Hello ${reporter},`, '', `A reminder: we have not had your ${year} recycling numbers yet. ${ask}`, '', how, '', by].join('\n') };
  return { subject: `Last reminder: ${town} ${year} recycling report`, text: [`Hello ${reporter},`, '', `We still need your ${year} recycling numbers for our report to the county, which is due ${due}. If you have nothing to report for ${town}, the form has a box for that.`, '', how, '', phone ? `Questions? Call ${phone}.` : ''].join('\n') };
}
const dueWords = (d) => require('./bulkpickup').longDay(d);

/**
 * Emails each form not yet answered (or only those of reporterIds) a fresh link, through the mailer. A new link replaces
 * the one before it. kind 'send' marks sent_at; 'remind' and 'last' mark reminded_at / followup_at. Returns
 * { sent, no_email: [names], failed: [names] }.
 */
async function mailForms(tenantId, year, base, { reporterIds = null, kind = 'send', by = null } = {}) {
  const t = await one(pool, 'SELECT name, slug, phone FROM tenants WHERE id = ?', [tenantId]);
  const r = await reportOf(pool, tenantId, year);
  if (!r) throw notFound('Report');
  if (r.status !== 'open') throw conflict('This report is closed. Open it again to send forms.');
  const forms = (await formsOf(pool, tenantId, r.id)).filter((f) => !f.answered_at && f.active && (!reporterIds || reporterIds.includes(f.reporter_id)));
  const out = { sent: 0, no_email: [], failed: [] };
  const mailer = require('./mailer');
  for (const f of forms) {
    if (!f.email) { out.no_email.push(f.name); continue; }
    const tok = newToken();
    const col = kind === 'send' ? 'sent_at' : kind === 'remind' ? 'reminded_at' : 'followup_at';
    await pool.query(`UPDATE recycling_report_forms SET token_hash = ?, ${col} = UTC_TIMESTAMP()${kind !== 'send' ? ', sent_at = COALESCE(sent_at, UTC_TIMESTAMP())' : ''} WHERE tenant_id = ? AND id = ?`, [hash(tok), tenantId, f.id]);
    const w = mailWords(kind, { town: t.name, year, reporter: f.name, link: formLink(base, t.slug, tok), due: dueWords(r.due_on), phone: t.phone });
    const sent = await mailer.send({ tenantId, to: f.email, fromName: t.name, subject: w.subject, text: w.text, tag: `recycling-report-${kind}` }).catch(() => ({ ok: false }));
    if (sent && sent.ok) out.sent += 1; else out.failed.push(f.name);
  }
  await audit(pool, { auth: { tenantId, userId: by } }, 'recycling_forms_sent', 'recycling_reports', r.id, { year, kind, sent: out.sent, no_email: out.no_email.length });
  return out;
}

/** The form a link opens: { form, report, reporter, tenant } or null (unknown, replaced, or the report is closed). */
async function formByToken(slug, tok) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(tok || ''))) return null;
  const f = await one(pool, `SELECT f.*, r.year, r.status AS report_status, r.due_on, p.name AS reporter, p.kind AS reporter_kind, t.name AS town, t.phone AS town_phone, t.slug
    FROM recycling_report_forms f JOIN recycling_reports r ON r.tenant_id = f.tenant_id AND r.id = f.report_id
    JOIN recycling_reporters p ON p.tenant_id = f.tenant_id AND p.id = f.reporter_id JOIN tenants t ON t.id = f.tenant_id
    WHERE f.token_hash = ? AND t.slug = ?`, [hash(tok), String(slug)]);
  if (!f || f.report_status !== 'open') return null;
  return f;
}

const linesOf = (db, tenantId, formId) => rows(db, 'SELECT material, res_curb, res_dropoff, com_curb, com_dropoff, residue, processor FROM recycling_report_lines WHERE tenant_id = ? AND form_id = ? ORDER BY id', [tenantId, formId])
  .then((l) => l.map((x) => ({ material: x.material, res_curb: r2(x.res_curb), res_dropoff: r2(x.res_dropoff), com_curb: r2(x.com_curb), com_dropoff: r2(x.com_dropoff), residue: r2(x.residue), processor: x.processor })));

/**
 * Saves a reporter's answer (replacing an earlier one), inside the caller's transaction. lines: [{ material, res_curb,
 * res_dropoff, com_curb, com_dropoff, residue, processor }]. none: nothing collected in the municipality that year.
 */
async function saveAnswer(conn, tenantId, formId, { lines = [], none = false, name = null, by = 'reporter', userId = null }) {
  if (!none && !lines.length) throw bad('Add at least one material, or tick the box that you have nothing to report this year');
  if (none && lines.length) throw bad('You ticked that you have nothing to report. Take out the materials, or untick it.');
  const seen = new Set();
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    if (!REPORTABLE_KEYS.has(l.material)) throw bad(`Line ${n}: pick the material from the list`);
    const cols = COLUMNS.map((c) => Number(l[c] || 0));
    if (cols.some((v) => !Number.isFinite(v) || v < 0 || v > 100000)) throw bad(`Line ${n}: tons must be numbers from 0 to 100,000`);
    const total = cols.reduce((s, v) => s + v, 0);
    if (total <= 0) throw bad(`Line ${n}: give the tons in at least one column`);
    const residue = Number(l.residue || 0);
    if (!Number.isFinite(residue) || residue < 0) throw bad(`Line ${n}: residue must be 0 or more`);
    if (residue > total) throw bad(`Line ${n}: the residue cannot be more than the tons collected`);
    if (!String(l.processor || '').trim()) throw bad(`Line ${n}: name the processor or market it went to`);
    const key = `${l.material}|${String(l.processor).trim().toLowerCase()}`;
    if (seen.has(key)) throw bad(`Line ${n}: that material and processor are already on another line. Add them together.`);
    seen.add(key);
  }
  await conn.query('DELETE FROM recycling_report_lines WHERE tenant_id = ? AND form_id = ?', [tenantId, formId]);
  for (const l of lines) {
    await conn.query('INSERT INTO recycling_report_lines (tenant_id, form_id, material, res_curb, res_dropoff, com_curb, com_dropoff, residue, processor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, formId, l.material, r2(l.res_curb), r2(l.res_dropoff), r2(l.com_curb), r2(l.com_dropoff), r2(l.residue), String(l.processor).trim().slice(0, 160)]);
  }
  await conn.query('UPDATE recycling_report_forms SET answered_at = UTC_TIMESTAMP(), answered_by = ?, answer_name = ?, none_to_report = ? WHERE tenant_id = ? AND id = ?',
    [by, name ? String(name).slice(0, 120) : null, none ? 1 : 0, tenantId, formId]);
  await audit(conn, { auth: { tenantId, userId } }, 'recycling_answer', 'recycling_report_forms', formId, { by, lines: lines.length, none: Boolean(none) });
}

/**
 * The municipal report for a year. rows: one per material with the four columns net of residue, the residue deducted,
 * the total, and the processors named. sources: the same broken down by where each number came from (own tickets by
 * facility, each reporter), for the spreadsheet. Own tickets: recycled materials only, each facility's residue share
 * deducted; columns from each ticket's sector.
 */
async function build(db, tenantId, year) {
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  const tick = await rows(db, `SELECT t.material, t.sector, f.name AS facility, f.residue_pct, SUM(t.net_lb) AS lb, COUNT(*) AS n FROM weigh_tickets t
    JOIN tonnage_facilities f ON f.tenant_id = t.tenant_id AND f.id = t.facility_id
    WHERE t.tenant_id = ? AND t.on_date BETWEEN ? AND ? AND t.voided_at IS NULL AND ${T.RECYCLED_SQL} GROUP BY t.material, t.sector, f.name, f.residue_pct`, [tenantId, from, to]);
  // Disposal: trash, and anything (yard waste too) taken to a landfill, transfer station or other facility.
  const trash = await one(db, `SELECT COALESCE(SUM(t.net_lb), 0) AS lb FROM weigh_tickets t JOIN tonnage_facilities f ON f.tenant_id = t.tenant_id AND f.id = t.facility_id
    WHERE t.tenant_id = ? AND t.on_date BETWEEN ? AND ? AND t.voided_at IS NULL AND NOT ${T.RECYCLED_SQL}`, [tenantId, from, to]);
  const sources = [];
  const own = new Map();
  for (const x of tick) {
    const key = `${x.material}|${x.facility}`;
    const cur = own.get(key) || { source: 'Own weigh tickets', kind: 'tickets', material: x.material, processor: x.facility, residue_pct: Number(x.residue_pct), gross: Object.fromEntries(COLUMNS.map((c) => [c, 0])) };
    cur.gross[x.sector] += Number(x.lb) / 2000;
    own.set(key, cur);
  }
  for (const o of own.values()) {
    const total = COLUMNS.reduce((s, c) => s + o.gross[c], 0);
    sources.push({ source: o.source, kind: o.kind, material: o.material, processor: o.processor, gross: o.gross, residue: total * (o.residue_pct / 100) });
  }
  const r = await reportOf(db, tenantId, year);
  if (r) {
    const lines = await rows(db, `SELECT l.*, p.name AS reporter, p.kind FROM recycling_report_lines l JOIN recycling_report_forms f ON f.tenant_id = l.tenant_id AND f.id = l.form_id
      JOIN recycling_reporters p ON p.tenant_id = f.tenant_id AND p.id = f.reporter_id WHERE l.tenant_id = ? AND f.report_id = ? ORDER BY p.name, l.id`, [tenantId, r.id]);
    for (const l of lines) sources.push({ source: l.reporter, kind: l.kind, material: l.material, processor: l.processor, gross: Object.fromEntries(COLUMNS.map((c) => [c, Number(l[c])])), residue: Number(l.residue) });
  }
  // Residue comes off each column in proportion, so the four columns still add up to the total.
  for (const s of sources) {
    const total = COLUMNS.reduce((n, c) => n + s.gross[c], 0);
    const keep = total > 0 ? Math.max(total - s.residue, 0) / total : 0;
    s.net = Object.fromEntries(COLUMNS.map((c) => [c, r2(s.gross[c] * keep)]));
    s.residue = r2(s.residue); s.total = r2(COLUMNS.reduce((n, c) => n + s.net[c], 0));
    s.label = (T.MATERIAL[s.material] || { label: s.material }).label;
  }
  const byMat = new Map();
  for (const s of sources) {
    const cur = byMat.get(s.material) || { material: s.material, label: s.label, ...Object.fromEntries(COLUMNS.map((c) => [c, 0])), residue: 0, total: 0, processors: new Set() };
    for (const c of COLUMNS) cur[c] = r2(cur[c] + s.net[c]);
    cur.residue = r2(cur.residue + s.residue); cur.total = r2(cur.total + s.total); cur.processors.add(s.processor);
    byMat.set(s.material, cur);
  }
  const order = new Map(T.MATERIAL_KEYS.map((k, i) => [k, i]));
  const out = [...byMat.values()].sort((a, b) => order.get(a.material) - order.get(b.material)).map((m) => ({ ...m, processors: [...m.processors].sort() }));
  const totals = { ...Object.fromEntries(COLUMNS.map((c) => [c, r2(out.reduce((s, m) => s + m[c], 0))])), residue: r2(out.reduce((s, m) => s + m.residue, 0)), total: r2(out.reduce((s, m) => s + m.total, 0)) };
  const trashTons = r2(Number(trash.lb) / 2000);
  const t = await one(db, 'SELECT name FROM tenants WHERE id = ?', [tenantId]);
  return {
    year, town: t.name, report: shapeReport(r), columns: COLUMNS.map((c) => ({ key: c, label: T.SECTORS[c] })), rows: out, totals, trash_tons: trashTons,
    recycling_rate: T.rate(totals.total, totals.total + trashTons),
    sources: sources.map((s) => ({ source: s.source, kind: s.kind, material: s.material, label: s.label, processor: s.processor, ...s.net, residue: s.residue, total: s.total })),
  };
}

/** The report as the county coordinator's spreadsheet: the material rows, then where each number came from. */
function csvOf(rep) {
  const { toCsv } = require('./csv');
  const cols = ['part', 'material', 'residential_curbside_tons', 'residential_dropoff_tons', 'commercial_curbside_tons', 'commercial_dropoff_tons', 'residue_deducted_tons', 'total_tons', 'processor', 'source'];
  const line = (part, m, processor, source) => ({ part, material: m.label, residential_curbside_tons: m.res_curb.toFixed(2), residential_dropoff_tons: m.res_dropoff.toFixed(2), commercial_curbside_tons: m.com_curb.toFixed(2),
    commercial_dropoff_tons: m.com_dropoff.toFixed(2), residue_deducted_tons: m.residue.toFixed(2), total_tons: m.total.toFixed(2), processor, source });
  const data = rep.rows.map((m) => line('Report', m, m.processors.join('; '), ''));
  data.push(line('Report', { label: 'Total recycled', ...rep.totals }, '', ''));
  for (const s of rep.sources) data.push(line('Source', s, s.processor, s.source));
  return toCsv(cols, data);
}

/** The Section 904 packet: totals, and the backing documents (every ticket of the year, every reporter's answer). */
async function packet(db, tenantId, year) {
  const rep = await build(db, tenantId, year);
  const tickets = await rows(db, `SELECT t.id, t.on_date, t.ticket_no, f.name AS facility, f.kind AS facility_kind, t.stream_kind, t.material, t.sector, t.net_lb, t.source, t.hauler,
      (SELECT COUNT(*) FROM weigh_ticket_photos p WHERE p.tenant_id = t.tenant_id AND p.ticket_id = t.id) AS photos
    FROM weigh_tickets t JOIN tonnage_facilities f ON f.tenant_id = t.tenant_id AND f.id = t.facility_id
    WHERE t.tenant_id = ? AND t.on_date BETWEEN ? AND ? AND t.voided_at IS NULL ORDER BY t.on_date, t.id`, [tenantId, `${year}-01-01`, `${year}-12-31`]);
  const forms = rep.report ? (await formsOf(db, tenantId, rep.report.id)).filter((f) => f.answered_at) : [];
  return {
    ...rep,
    documents: {
      tickets: tickets.map((x) => ({ id: Number(x.id), on_date: String(x.on_date).slice(0, 10), ticket_no: x.ticket_no, facility: x.facility, stream_kind: x.stream_kind, material: (T.MATERIAL[x.material] || {}).label || x.material,
        sector: T.SECTORS[x.sector], net_tons: T.tons(x.net_lb), counts_as: T.isRecycled(x.facility_kind, x.material) ? 'recycled' : 'disposal', source: x.source, hauler: x.hauler, photos: Number(x.photos) })),
      reports: forms.map((f) => ({ reporter: f.name, kind: f.kind, form: f.form, answered_at: f.answered_at, answered_by: f.answered_by, none_to_report: f.none_to_report, lines: f.lines, tons: f.tons })),
    },
  };
}

/** The packet's zip: each ticket photo (named by date, facility and ticket), the tickets and the report as spreadsheets. */
async function packetZip(db, tenantId, year) {
  const { zipSync, strToU8 } = require('fflate');
  const { toCsv } = require('./csv');
  const p = await packet(db, tenantId, year);
  const files = {};
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
  const ext = (m) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[m] || 'bin');
  const photos = await rows(db, `SELECT p.id, p.ticket_id, p.mime, p.sha256, p.original, t.on_date, t.ticket_no, f.name AS facility FROM weigh_ticket_photos p
    JOIN weigh_tickets t ON t.tenant_id = p.tenant_id AND t.id = p.ticket_id JOIN tonnage_facilities f ON f.tenant_id = t.tenant_id AND f.id = t.facility_id
    WHERE p.tenant_id = ? AND t.on_date BETWEEN ? AND ? AND t.voided_at IS NULL ORDER BY t.on_date, p.id`, [tenantId, `${year}-01-01`, `${year}-12-31`]);
  const sums = [];
  for (const ph of photos) {
    const name = `ticket-photos/${String(ph.on_date).slice(0, 10)}_${safe(ph.facility)}_${safe(ph.ticket_no || `ticket-${ph.ticket_id}`)}_${ph.id}.${ext(ph.mime)}`;
    // The packet leaves the municipality, so where the photo was taken comes out (lib/exif.js, as for public photos). The
    // SHA-256 listed is of the copy in the zip; the original, as taken, stays in the app with its own.
    const copy = require('./exif').stripGps(Buffer.from(ph.original));
    if (!copy) continue; // a photo whose location cannot be taken out is not sent
    files[name] = [new Uint8Array(copy), { level: 0 }];
    sums.push(`${require('crypto').createHash('sha256').update(copy).digest('hex')}  ${name}`);
  }
  files['tickets.csv'] = strToU8(toCsv(['id', 'on_date', 'ticket_no', 'facility', 'stream_kind', 'material', 'sector', 'net_tons', 'counts_as', 'source', 'hauler', 'photos'], p.documents.tickets));
  files['recycling-report.csv'] = strToU8(csvOf(p));
  files['SHA256SUMS.txt'] = strToU8(`${sums.join('\n')}\n`);
  return { zip: Buffer.from(zipSync(files)), photos: sums.length };
}

/**
 * The daily job: opens each municipality's report for its year in December; on January 15 reminds reporters that have
 * not answered; on February 1 (the follow-up day) sends the last reminder and marks the follow-up list ready. Each step
 * is claimed in the database first, so a second run never sends twice.
 */
async function daily(base, { today: forced = null, tenantId = null } = {}) { // forced/tenantId: tests run one day for one municipality
  const out = { opened: 0, reminded: 0, followups: 0 };
  const towns = await rows(pool, `SELECT id, timezone FROM tenants WHERE org_type = 'municipality' AND status = 'active'${tenantId ? ' AND id = ?' : ''}`, tenantId ? [tenantId] : []);
  for (const t of towns) {
    const st = await require('./modules').stateOf(t.id);
    if (!st.on.has('solidwaste')) continue;
    const today = forced || todayIn(t.timezone);
    const y = Number(today.slice(0, 4)); const md = today.slice(5);
    if (md >= '12-01') {
      const had = await reportOf(pool, t.id, y);
      if (!had) { await tx((conn) => open(conn, t.id, y)); out.opened += 1; }
    }
    // Reminders are for last year's report, between January 15 and the follow-up day, then the follow-up day itself.
    const r = await reportOf(pool, t.id, y - 1);
    if (!r || r.status !== 'open') continue;
    const followOn = String(r.followup_on).slice(0, 10);
    if (today >= `${y}-01-15` && today < followOn) {
      const due = await rows(pool, 'SELECT id, reporter_id FROM recycling_report_forms WHERE tenant_id = ? AND report_id = ? AND answered_at IS NULL AND sent_at IS NOT NULL AND reminded_at IS NULL', [t.id, r.id]);
      const ids = [];
      for (const f of due) {
        const [claim] = await pool.query('UPDATE recycling_report_forms SET reminded_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND reminded_at IS NULL', [t.id, f.id]);
        if (claim.affectedRows) ids.push(Number(f.reporter_id));
      }
      if (ids.length) out.reminded += (await mailForms(t.id, y - 1, base, { reporterIds: ids, kind: 'remind' })).sent;
    }
    if (today >= followOn && !r.followup_done_at) {
      const [claim] = await pool.query('UPDATE recycling_reports SET followup_done_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND followup_done_at IS NULL', [t.id, r.id]);
      if (claim.affectedRows) {
        const ids = (await rows(pool, 'SELECT reporter_id FROM recycling_report_forms WHERE tenant_id = ? AND report_id = ? AND answered_at IS NULL AND sent_at IS NOT NULL', [t.id, r.id])).map((x) => Number(x.reporter_id));
        if (ids.length) out.followups += (await mailForms(t.id, y - 1, base, { reporterIds: ids, kind: 'last' })).sent;
      }
    }
  }
  return out;
}

/** The follow-up list: reporters still not answered once the follow-up day has come (or now, when asked). */
async function followupList(db, tenantId, reportId) {
  return (await formsOf(db, tenantId, reportId)).filter((f) => !f.answered_at && f.active).map((f) => ({ reporter_id: f.reporter_id, name: f.name, kind: f.kind, contact_name: f.contact_name, email: f.email, phone: f.phone, sent_at: f.sent_at, reminded_at: f.reminded_at, followup_at: f.followup_at }));
}

module.exports = { COLUMNS, REPORTABLE, FORM_WORDS, hash, newToken, formLink, reportOf, shapeReport, open, formsOf, ensureForm, mailForms, formByToken, linesOf, saveAnswer, build, csvOf, packet, packetZip, daily, followupList, mailWords };
