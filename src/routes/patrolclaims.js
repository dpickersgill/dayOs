'use strict';

// Claim files, the documentation score, the season risk report, and secure links for an insurer or a broker.
//
// router (mounted at /api/v1/patrol):
//   the claim file of one case (everything an adjuster or the mountain's attorney asks for, on one printable page),
//   the documentation score of a case and of the season, the season risk report for insurance renewal, and the links.
// publicRouter (mounted at /api/v1/public): what a link opens at /c/<token>.
//
// A claim file goes outside only through the records-request flow: a released request (so the authority is on file) and
// only the approved, frozen version it released. A risk report link carries counts only, never a name.
const crypto = require('crypto');
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, addDays, seasonFor } = require('../lib/util');
const { notFound, bad, conflict, forbidden, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const { stepUp } = require('../lib/stepup');
const OPS = require('../lib/patrolops');
const DS = require('../lib/docscore');
const S = require('../lib/safety');
const K = require('../lib/patrolkits');
const config = require('../config');

const router = express.Router();
const publicRouter = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (f, m) => PA.needs(pool, f, m);
const loadCase = (...a) => require('./patrol').loadCase(...a); // late: routes/patrol.js is loaded first by app.js
const caseNo = (i) => (i.seq ? `${i.season}-${String(i.seq).padStart(4, '0')}` : `Case ${i.id}`);

/** Any one of these patrol features. */
const anyOf = (features, message) => async (req, _res, next) => {
  try {
    for (const f of features) if (await PA.can(pool, req, f)) return next();
    throw forbidden(message || 'Your patrol access level cannot do that');
  } catch (err) { return next(err); }
};

const CLAIM_DAYS = 14;
const RISK_DAYS = 30;
const MAX_TRIES = 10;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hasTable = async (db, name) => Boolean(await one(db, 'SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]));
const parseJSON = (s) => { if (!s) return null; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch (_) { return null; } };
/** audit_log.at is a UTC timestamp; every other time on a case is the mountain's wall clock. */
function localOf(utc, tz) {
  if (!utc) return utc;
  const d = new Date(`${String(utc).replace(' ', 'T').slice(0, 19)}Z`);
  if (Number.isNaN(d.getTime())) return utc;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const plusDays = (now, days) => `${addDays(now.slice(0, 10), days)} ${now.slice(11, 19) || '00:00:00'}`;

// ================================================================ claim file
/**
 * The report a claim file shows: the approved version, frozen, when there is one. Otherwise the case as it stands,
 * clearly marked (a draft or a signed-off report not yet approved can still change).
 */
async function reportOf(db, t, id, live) {
  const v = await one(db, "SELECT id, version_no, kind, snapshot, created_at FROM incident_versions WHERE tenant_id = ? AND incident_id = ? AND kind = 'approved' ORDER BY version_no DESC LIMIT 1", [t, id]);
  const snap = v && parseJSON(v.snapshot);
  if (snap && snap.id) return { report: snap, basis: 'approved', version: { id: Number(v.id), version_no: v.version_no, created_at: v.created_at } };
  return { report: live, basis: live.report_state === 'submitted' ? 'submitted' : live.report_state === 'approved' ? 'approved_live' : 'draft', version: null };
}

async function sceneOf(db, t, id) {
  if (!(await hasTable(db, 'patrol_scenes'))) return null;
  const s = await one(db, 'SELECT svg, updated_at, updated_by FROM patrol_scenes WHERE tenant_id = ? AND incident_id = ?', [t, id]).catch(() => null);
  return s && s.svg ? { svg: s.svg, updated_at: s.updated_at } : null;
}

async function sharesOf(db, t, where, params) {
  const list = await rows(db, `SELECT s.id, s.kind, s.incident_id, s.request_id, s.season, s.shared_with, s.expires_at, s.revoked_at, s.created_at, (s.passcode_hash IS NOT NULL) AS has_code, s.failed_attempts,
      COALESCE(u.email, u.username) AS created_by_name, r.release_no, i.season AS i_season, i.seq,
      (SELECT COUNT(*) FROM claim_share_views v WHERE v.share_id = s.id) AS views, (SELECT MAX(v.at) FROM claim_share_views v WHERE v.share_id = s.id) AS last_view_at
    FROM claim_shares s LEFT JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.created_by
    LEFT JOIN patrol_records_requests r ON r.tenant_id = s.tenant_id AND r.id = s.request_id
    LEFT JOIN incidents i ON i.tenant_id = s.tenant_id AND i.id = s.incident_id
    WHERE s.tenant_id = ? ${where} ORDER BY s.id DESC LIMIT 200`, [t, ...params]);
  const { now } = await OPS.clock(db, t);
  const ids = list.map((s) => s.id);
  const views = ids.length ? await rows(db, 'SELECT share_id, at, ip, user_agent FROM claim_share_views WHERE share_id IN (?) ORDER BY at DESC, id DESC', [ids]) : [];
  return list.map((s) => ({
    id: Number(s.id), kind: s.kind, incident_id: s.incident_id ? Number(s.incident_id) : null, request_id: s.request_id ? Number(s.request_id) : null,
    case_number: s.incident_id ? caseNo({ id: s.incident_id, season: s.i_season, seq: s.seq }) : null, season: s.season, release_no: s.release_no,
    shared_with: s.shared_with, expires_at: s.expires_at, revoked_at: s.revoked_at, created_at: s.created_at, created_by: s.created_by_name,
    has_code: Boolean(Number(s.has_code)), locked: Number(s.failed_attempts) >= MAX_TRIES,
    state: s.revoked_at ? 'revoked' : Number(s.failed_attempts) >= MAX_TRIES ? 'locked' : s.expires_at <= now ? 'expired' : 'active',
    views: Number(s.views), last_view_at: s.last_view_at,
    view_log: views.filter((v) => Number(v.share_id) === Number(s.id)).slice(0, 25).map((v) => ({ at: v.at, ip: v.ip, user_agent: v.user_agent })),
  }));
}

/** Everything about one case an adjuster, broker or attorney asks for. */
async function claimFile(db, req, id) {
  const t = req.auth.tenantId;
  const live = await loadCase(db, t, id);
  if (!live) throw notFound('Case');
  const { report, basis, version } = await reportOf(db, t, id, live);
  const [score, scene, records, trail, canRecords, canAudit] = await Promise.all([
    DS.forCase(db, t, report),
    sceneOf(db, t, id),
    rows(db, `SELECT r.id, r.requester_kind, r.requester_name, r.received_on, r.authorization, r.status, r.release_no, r.released_at, r.version_id, v.version_no
      FROM patrol_records_requests r LEFT JOIN incident_versions v ON v.tenant_id = r.tenant_id AND v.id = r.version_id WHERE r.tenant_id = ? AND r.incident_id = ? ORDER BY r.id`, [t, id]),
    rows(db, `SELECT a.at, a.action, a.detail, COALESCE(u.email, u.username) AS user FROM audit_log a LEFT JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id
      WHERE a.tenant_id = ? AND a.entity = 'incidents' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 400`, [t, id]),
    PA.can(db, req, 'records'),
    PA.can(db, req, 'view_access_log'),
  ]);
  const showTrail = canRecords || canAudit;
  const { tz } = await OPS.clock(db, t);
  return {
    id, case_number: live.case_number || caseNo(live), basis, version,
    report_state: live.report_state, legal_hold: Boolean(Number(live.legal_hold)), legal_hold_note: live.legal_hold_note || null,
    resort: live.resort,
    report, score, scene,
    records: records.map((r) => ({ ...r, id: Number(r.id), version_id: r.version_id ? Number(r.version_id) : null })),
    shares: canRecords ? await sharesOf(db, t, 'AND s.incident_id = ?', [id]) : [],
    audit: showTrail ? trail.map((a) => ({ at: localOf(a.at, tz), action: a.action, user: a.user, detail: parseJSON(a.detail) })) : null,
    can: { records: canRecords },
  };
}

router.get('/incidents/:id/claim-file', patrol, anyOf(['view_cases', 'records']), async (req, res) => {
  const id = paramId(req);
  const out = await claimFile(pool, req, id);
  await audit(pool, req, 'claim_file_view', 'incidents', id, { basis: out.basis, version: out.version ? out.version.version_no : null });
  res.json(out);
});

/** The panel on a case's Record view: its score, red flags, and links shared outside. Light: no audit trail. */
router.get('/incidents/:id/doc-score', patrol, anyOf(['view_cases', 'records']), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const live = await loadCase(pool, t, id);
  if (!live) throw notFound('Case');
  const { report, basis } = await reportOf(pool, t, id, live);
  const canRecords = await PA.can(pool, req, 'records');
  res.json({ ...(await DS.forCase(pool, t, report)), basis, shares: canRecords ? await sharesOf(pool, t, 'AND s.incident_id = ?', [id]) : [], can: { records: canRecords } });
});

// ================================================================ documentation score, the season
const seasonParam = (req, today) => {
  const s = String(req.query.season || '') || seasonFor(today);
  if (!/^\d{4}-\d{2}$/.test(s) || Number(s.slice(5)) !== (Number(s.slice(0, 4)) + 1) % 100) throw bad('Season looks like 2026-27');
  return s;
};

/** Owners, managers and patrol admins: the score card on Today and the Patrol page. */
const scoreReaders = anyOf(['reports', 'records'], 'The documentation score is for patrol admins, the owner and managers');
router.get('/doc-score', patrol, scoreReaders, async (req, res) => {
  const t = req.auth.tenantId;
  const { now, today } = await OPS.clock(pool, t);
  const season = seasonParam(req, today);
  const s = await DS.season(pool, t, { season, today: now, loadCase });
  const brief = String(req.query.brief || '') === '1';
  res.json(brief ? DS.brief(s) : s);
});

// ================================================================ season risk report
const prevSeason = (s) => { const y = Number(s.slice(0, 4)) - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };

async function compliance(db, t, today) {
  const out = {};
  try {
    const kits = await rows(db, 'SELECT k.status, k.earliest_expiry, k.last_check_at, t.every_days FROM patrol_kits k JOIN patrol_kit_types t ON t.id = k.type_id AND t.tenant_id = k.tenant_id WHERE k.tenant_id = ? AND k.active = 1', [t]);
    const st = kits.map((k) => K.standing(k, k, today));
    out.kits = { total: kits.length, ready: st.filter((x) => x === 'ready').length, check_due: st.filter((x) => x === 'check_due').length, expired: st.filter((x) => x === 'expired').length, not_ready: st.filter((x) => ['not_ready', 'needs_restock', 'out_of_service'].includes(x)).length };
  } catch (_) { out.kits = null; }
  try {
    const eq = await rows(db, "SELECT kind, status, expires_on, pads_expire_on, battery_expire_on FROM patrol_equipment WHERE tenant_id = ? AND status <> 'retired'", [t]);
    const lapsed = (e) => [e.expires_on, e.pads_expire_on, e.battery_expire_on].some((d) => d && String(d).slice(0, 10) < today);
    const aeds = eq.filter((e) => e.kind === 'aed');
    out.equipment = { total: eq.length, in_service: eq.filter((e) => e.status === 'in_service' && !lapsed(e)).length, attention: eq.filter((e) => e.status !== 'in_service' || lapsed(e)).length };
    out.aeds = { total: aeds.length, ready: aeds.filter((e) => e.status === 'in_service' && !lapsed(e)).length, pads_or_battery_expired: aeds.filter(lapsed).length };
  } catch (_) { out.equipment = null; out.aeds = null; }
  return out;
}

const BREAKDOWNS = ['cause', 'location', 'outcome', 'activity', 'month'];
const countsOnly = (own) => (own ? {
  patients: own.patients, visits: own.visits, per_1000: own.per_1000,
  breakdowns: Object.fromEntries(BREAKDOWNS.filter((k) => own.breakdowns && own.breakdowns[k]).map((k) => [k, { title: own.breakdowns[k].title, cells: own.breakdowns[k].cells.filter((c) => c.n).map((c) => ({ label: c.label, n: c.n, pct: c.pct })) }])),
} : null);

/**
 * The season risk report: counts only, never a name, for a broker or insurer at renewal. Injury rate per 1,000 visits
 * against last season (to the same date and in full), the network comparison when the mountain shares and the network
 * is big enough, the documentation score and timeliness, red-flag handling, staff injuries, and kit and AED readiness.
 */
async function riskReport(db, t, season, { now, today }) {
  const period = S.periodOf({ season }, today);
  const lastSeason = prevSeason(season);
  const lastFull = S.periodOf({ season: lastSeason }, today);
  const inSeason = today >= period.from && today <= period.to;
  const md = today.slice(5, 10) === '02-29' ? '02-28' : today.slice(5, 10);
  const lastToDate = inSeason ? { ...lastFull, to: `${Number(today.slice(0, 4)) - 1}-${md}` } : null;
  const [mine, prevFull, prevToDate, docs, prevDocs, staff, tenant, comp] = await Promise.all([
    S.benchmark(db, t, { period: inSeason ? { ...period, to: today } : period }),
    S.benchmark(db, t, { period: lastFull }),
    lastToDate ? S.benchmark(db, t, { period: lastToDate }) : null,
    DS.season(db, t, { season, today: now, loadCase }),
    DS.season(db, t, { season: lastSeason, today: now, loadCase }),
    rows(db, `SELECT outcome, COUNT(*) AS n FROM staff_injuries WHERE tenant_id = ? AND occurred_at >= ? AND occurred_at < ? GROUP BY outcome`, [t, `${period.from} 00:00:00`, `${addDays(period.to, 1)} 00:00:00`]).catch(() => []),
    one(db, 'SELECT name, legal_name FROM tenants WHERE id = ?', [t]),
    compliance(db, t, today),
  ]);
  const staffOf = (k) => staff.filter((r) => (k ? r.outcome === k : true)).reduce((n, r) => n + Number(r.n), 0);
  const network = mine.sharing.share && mine.peers && !mine.peers.too_few_mountains && mine.peers.per_1000 !== undefined
    ? { mountains: mine.peers.mountains, per_1000: mine.peers.per_1000 ?? null } : null;
  return {
    resort: { name: tenant.name, legal_name: tenant.legal_name },
    season, period: { from: period.from, to: inSeason ? today : period.to, partial: inSeason },
    made_at: now,
    injuries: countsOnly(mine.own),
    last_season: { season: lastSeason, to_date: prevToDate ? countsOnly(prevToDate.own) : null, full: countsOnly(prevFull.own) },
    network, network_note: network ? null : mine.sharing.share ? 'The safety network does not have enough mountains this season to compare.' : 'This mountain does not share with the safety network, so there is no comparison.',
    documentation: DS.brief(docs),
    documentation_last_season: { score: prevDocs.score, on_time_pct: prevDocs.on_time_pct, reports: prevDocs.reports },
    red_flags: { cases: docs.red_flags, management_told: docs.red_flags_management, insurer_told: docs.red_flags_insurer, by_kind: Object.entries(DS.FLAG_LABEL).map(([key, label]) => ({ key, label, n: docs.cases.filter((c) => c.red_flags.some((f) => f.key === key)).length })).filter((x) => x.n) },
    staff_injuries: { total: staffOf(), recordable: staff.filter((r) => r.outcome && r.outcome !== 'not_recordable').reduce((n, r) => n + Number(r.n), 0), days_away: staffOf('days_away'), restricted: staffOf('restricted') },
    compliance: comp,
  };
}

router.get('/risk-report', patrol, needs('reports'), async (req, res) => {
  const t = req.auth.tenantId;
  const clock = await OPS.clock(pool, t);
  const season = seasonParam(req, clock.today);
  const out = await riskReport(pool, t, season, clock);
  await audit(pool, req, 'risk_report_view', 'claim_shares', null, { season });
  res.json({ ...out, shares: await sharesOf(pool, t, "AND s.kind = 'risk'", []) });
});

// ================================================================ secure links
function newToken() { return crypto.randomBytes(24).toString('base64url'); }
const codeHash = (token, code) => sha(`${token}:${code}`);
const linkOf = (req, token) => `${(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/c/${token}`;

const shareBody = z.object({
  shared_with: z.string().trim().min(2).max(150),
  days: z.number().int().min(1).max(90).optional(),
  passcode: z.boolean().optional(),
});

/** A broker's link to the season risk report: counts only. 30 days unless set otherwise. */
router.post('/risk-report/share', patrol, needs('reports'), validate(shareBody.extend({ season: z.string().regex(/^\d{4}-\d{2}$/).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const { now, today } = await OPS.clock(pool, t);
  const season = b.season || seasonFor(today);
  if (!S.periodOf({ season }, today)) throw bad('Season looks like 2026-27');
  const token = newToken(); const code = b.passcode ? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0') : null;
  const expires = plusDays(now, b.days || RISK_DAYS);
  const [r] = await pool.query('INSERT INTO claim_shares (tenant_id, kind, season, shared_with, token_hash, passcode_hash, expires_at, created_by, created_at) VALUES (?, \'risk\', ?, ?, ?, ?, ?, ?, ?)',
    [t, season, b.shared_with, sha(token), code ? codeHash(token, code) : null, expires, req.auth.userId, now]);
  await audit(pool, req, 'risk_report_share', 'claim_shares', r.insertId, { season, shared_with: b.shared_with, expires_at: expires, passcode: Boolean(code) });
  res.status(201).json({ id: r.insertId, url: linkOf(req, token), passcode: code, expires_at: expires });
});

/**
 * An insurer's link to a released claim file. Only a released request (the authority is on file) and only the approved
 * version it released. 14 days unless set otherwise, revocable, with an optional 6-digit passcode sent separately.
 */
router.post('/records/:id/share', patrol, needs('records'), stepUp('share a patient record outside'), validate(shareBody.partial({ shared_with: true })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const r = await one(pool, 'SELECT * FROM patrol_records_requests WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
  if (!r) throw notFound('Request');
  if (r.status !== 'released' || !r.version_id) throw conflict('Release the request first. A secure link carries only the approved report a release sent.');
  if (r.authorization === 'none') throw conflict('This request has no authorization on file');
  const { now } = await OPS.clock(pool, t);
  const token = newToken(); const code = b.passcode === false ? null : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const expires = plusDays(now, b.days || CLAIM_DAYS);
  const who = b.shared_with || r.requester_name;
  const [ins] = await pool.query('INSERT INTO claim_shares (tenant_id, kind, incident_id, request_id, shared_with, token_hash, passcode_hash, expires_at, created_by, created_at) VALUES (?, \'claim\', ?, ?, ?, ?, ?, ?, ?, ?)',
    [t, r.incident_id, r.id, who, sha(token), code ? codeHash(token, code) : null, expires, req.auth.userId, now]);
  await audit(pool, req, 'claim_share', 'incidents', r.incident_id, { request: Number(r.id), release_no: r.release_no, share: ins.insertId, shared_with: who, expires_at: expires, passcode: Boolean(code) });
  res.status(201).json({ id: ins.insertId, url: linkOf(req, token), passcode: code, expires_at: expires });
});

/** Every link made, with its views: for the Patrol Director. */
router.get('/shares', patrol, anyOf(['records', 'reports']), async (req, res) => {
  const canRecords = await PA.can(pool, req, 'records');
  res.json({ data: await sharesOf(pool, req.auth.tenantId, canRecords ? '' : "AND s.kind = 'risk'", []) });
});

router.get('/incidents/:id/shares', patrol, needs('records'), async (req, res) => {
  res.json({ data: await sharesOf(pool, req.auth.tenantId, 'AND s.incident_id = ?', [paramId(req)]) });
});

router.post('/shares/:id/revoke', patrol, anyOf(['records', 'reports']), async (req, res) => {
  const t = req.auth.tenantId;
  const s = await one(pool, 'SELECT * FROM claim_shares WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
  if (!s) throw notFound('Link');
  if (s.kind === 'claim' && !(await PA.can(pool, req, 'records'))) throw forbidden('Only a patrol admin can stop a claim file link');
  if (s.revoked_at) return res.json({ ok: true, already: true });
  const { now } = await OPS.clock(pool, t);
  await pool.query('UPDATE claim_shares SET revoked_at = ?, revoked_by = ? WHERE tenant_id = ? AND id = ?', [now, req.auth.userId, t, s.id]);
  await audit(pool, req, `${s.kind}_share_revoke`, s.incident_id ? 'incidents' : 'claim_shares', s.incident_id || s.id, { share: Number(s.id) });
  res.json({ ok: true });
});

// ================================================================ what a link opens (no sign-in)
// A view key lets the page load its photos without the passcode in every image address: signed, for one link, an hour.
const VIEW_KEY_MS = 3_600_000;
const viewKey = (shareId) => { const exp = Date.now() + VIEW_KEY_MS; const mac = crypto.createHmac('sha256', config.linkSecret).update(`claim-share:${shareId}:${exp}`).digest('base64url'); return `${exp}.${mac}`; };
const viewKeyOk = (shareId, k) => {
  const [exp, mac] = String(k || '').split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac('sha256', config.linkSecret).update(`claim-share:${shareId}:${exp}`).digest('base64url');
  return want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac));
};

const gone = (msg) => new AppError(410, msg);
async function openShare(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token))) throw notFound('Link');
  const s = await one(pool, 'SELECT * FROM claim_shares WHERE token_hash = ?', [sha(token)]);
  if (!s) throw notFound('Link');
  await require('../lib/modules').requireModule(s.tenant_id, 'patrol').catch(() => { throw notFound('Link'); });
  const { now } = await OPS.clock(pool, s.tenant_id);
  if (s.revoked_at) throw gone('This link was stopped by the mountain. Ask them for a new one.');
  if (s.expires_at <= now) throw gone('This link has expired. Ask the mountain for a new one.');
  if (Number(s.failed_attempts) >= MAX_TRIES) throw new AppError(423, 'Too many wrong passcodes. Ask the mountain for a new link.');
  return { s, now };
}

/** The frozen version a released request sent, for the insurer: no audit trail, no other requests, no other links. */
async function sharedClaim(s) {
  const t = s.tenant_id;
  const r = await one(pool, 'SELECT r.release_no, r.released_at, r.requester_name, r.requester_kind, r.version_id, r.status FROM patrol_records_requests r WHERE r.tenant_id = ? AND r.id = ?', [t, s.request_id]);
  if (!r || r.status !== 'released' || !r.version_id) throw gone('This release was withdrawn. Ask the mountain.');
  const v = await one(pool, 'SELECT id, version_no, kind, snapshot, created_at FROM incident_versions WHERE tenant_id = ? AND id = ?', [t, r.version_id]);
  const report = v && parseJSON(v.snapshot);
  if (!report || !report.id) throw gone('The released report could not be found. Ask the mountain.');
  const tenant = await one(pool, 'SELECT name, legal_name FROM tenants WHERE id = ?', [t]);
  return {
    kind: 'claim', resort: { name: tenant.name, legal_name: tenant.legal_name },
    case_number: report.case_number || caseNo(report), basis: 'approved', version: { version_no: v.version_no, created_at: v.created_at },
    release: { release_no: r.release_no, released_at: r.released_at, to: r.requester_name, kind: r.requester_kind },
    report: { ...report, photos: (report.photos || []).filter((p) => !p.voided_at) },
  };
}

async function logView(req, s, now) {
  const ip = String(req.ip || '').slice(0, 64) || null;
  const ua = String(req.get('user-agent') || '').slice(0, 255) || null;
  await pool.query('INSERT INTO claim_share_views (tenant_id, share_id, at, ip, user_agent) VALUES (?, ?, ?, ?, ?)', [s.tenant_id, s.id, now, ip, ua]);
  await pool.query('INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, NULL, ?, ?, ?, ?)',
    [s.tenant_id, `${s.kind}_share_view`, s.incident_id ? 'incidents' : 'claim_shares', s.incident_id || s.id, JSON.stringify({ share: Number(s.id), shared_with: s.shared_with, ip })]);
}

publicRouter.get('/claim-share/:token', async (req, res) => {
  const token = String(req.params.token);
  const { s, now } = await openShare(token);
  if (s.passcode_hash) {
    const code = String(req.get('x-share-code') || '').replace(/\D/g, '');
    if (!code) return res.status(401).json({ error: 'Enter the 6-digit passcode the mountain sent you', needs_code: true, kind: s.kind });
    const want = Buffer.from(s.passcode_hash); const got = Buffer.from(codeHash(token, code));
    if (!crypto.timingSafeEqual(want, got)) {
      await pool.query('UPDATE claim_shares SET failed_attempts = failed_attempts + 1 WHERE id = ?', [s.id]);
      const left = MAX_TRIES - Number(s.failed_attempts) - 1;
      if (left <= 0) return res.status(423).json({ error: 'Too many wrong passcodes. Ask the mountain for a new link.' });
      return res.status(401).json({ error: `That passcode is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, needs_code: true, kind: s.kind });
    }
  }
  const data = s.kind === 'claim' ? await sharedClaim(s) : { kind: 'risk', ...(await riskReport(pool, s.tenant_id, s.season, await OPS.clock(pool, s.tenant_id))) };
  await logView(req, s, now);
  res.set('Cache-Control', 'no-store').json({ ...data, shared_with: s.shared_with, expires_at: s.expires_at, view_key: s.kind === 'claim' ? viewKey(s.id) : null });
});

/** A photo's preview, for a claim link: only the photos in the released version. */
publicRouter.get('/claim-share/:token/photos/:mid', async (req, res) => {
  const { s } = await openShare(String(req.params.token));
  if (s.kind !== 'claim' || !viewKeyOk(s.id, req.query.k)) throw notFound('Photo');
  const r = await one(pool, 'SELECT r.version_id FROM patrol_records_requests r WHERE r.tenant_id = ? AND r.id = ?', [s.tenant_id, s.request_id]);
  const v = r && await one(pool, 'SELECT snapshot FROM incident_versions WHERE tenant_id = ? AND id = ?', [s.tenant_id, r.version_id]);
  const report = v && parseJSON(v.snapshot);
  const mid = paramId(req, 'mid');
  if (!report || !(report.photos || []).some((p) => Number(p.id) === mid && !p.voided_at)) throw notFound('Photo');
  const m = await one(pool, 'SELECT preview FROM incident_media WHERE tenant_id = ? AND incident_id = ? AND id = ?', [s.tenant_id, s.incident_id, mid]);
  if (!m || !m.preview) throw notFound('Photo');
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600' }).send(m.preview);
});

module.exports = { router, publicRouter, claimFile, riskReport };
