'use strict';

// Street notices and resident alerts (muni release 1). The Resident requests app (module key requests).
//
// router, at /api/v1/street-notices (signed in):
//   GET  /setup                  types and their templates, topics, streets, operators, who may send, what is set up
//   GET  /today                  the Today cards: active notices, sign-ups this week
//   GET  /                       notices (?status=active|scheduled|draft|ended|all)
//   POST /preview                how many residents a type and set of streets would reach, by text and email
//   POST /                       a new draft; GET/PUT/DELETE /:id read, change (until it is sent) or delete a draft
//   POST /:id/send               send now, or at a time; optionally open a work order for an outage
//   POST /:id/unschedule         a scheduled notice goes back to a draft
//   POST /:id/updates            a follow-up to the same list ("Water is back on")
//   POST /:id/end                closes the notice, with an optional last message to the same list
//   GET  /:id/problems           messages that could not be delivered (managers)
//   GET  /export                 every notice as CSV: a public record, no resident contact details
//   GET  /residents/streets      sign-ups by street, with counts
//   GET  /residents              the sign-ups on a street (managers and front desk)
//   GET  /residents/export       CSV without contact details; ?contacts=1 adds them (managers, audited)
//   POST /residents/import       residents who already agreed elsewhere, from CSV (managers, the agreement confirmed, audited)
//   POST /residents/signups/:id/end   takes one sign-up off the list (a resident who called)
//   GET/PUT /settings            Crew logins who may send, and the municipality's own texting number (managers)
// Sending is for managers and owners, and the Crew logins a manager lists in settings.
//
// publicRouter, at /api/v1/public (no sign-in; the page word 'alerts' belongs to the requests app, lib/modules.js):
//   GET  /:slug/alerts                    the sign-up form's streets and topics, and the notices now active
//   POST /:slug/alerts                    sign up one address; a 6-digit code goes by text, a link by email
//   POST /:slug/alerts/confirm, /resend   the code (5 wrong tries per code; 5 codes an hour per phone)
//   POST /:slug/alerts/email              the email link (the page posts it, so a mail scanner opening the link does not)
//   GET/POST /:slug/alerts/manage/:token  the link in every message: topics, remove an address, stop texts or emails
//   GET  /:slug/alerts/:code              a notice's public page: its words and updates, never anyone's name or contact
const express = require('express');
const crypto = require('crypto');
const { pool, rows, one, tx } = require('../db');
const config = require('../config');
const { requireRole, isManager } = require('../middleware/auth');
const { z, validate, paramId, planDateTimeStr, normDateTime } = require('../lib/util');
const { notFound, conflict, bad, forbidden, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { toCsv } = require('../lib/csv');
const sms = require('../lib/sms');
const mailer = require('../lib/mailer');
const modules = require('../lib/modules');
const quiet = require('../lib/quiet');
const { todayRoute, card } = require('../lib/today');
const RES = require('../lib/residents');
const { upsertResident } = RES;
const SN = require('../lib/streetnotices');

const router = express.Router();
const publicRouter = express.Router();
const anyone = requireRole('manager', 'counter', 'staff');
const desk = requireRole('manager', 'counter');
const mgr = requireRole('manager');

const NAME = "COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, sp.first_name, ''), ' ', COALESCE(p.last_name, sp.last_name, ''))), ''), u.username, u.email)";
const USER_JOIN = 'LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id LEFT JOIN staff s ON s.tenant_id = u.tenant_id AND s.id = u.staff_id LEFT JOIN people sp ON sp.tenant_id = s.tenant_id AND sp.id = s.person_id';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const sentNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---------------------------------------------------------------- who may send
const idList = (v) => String(v || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
async function settingsOf(tenantId) {
  const s = await one(pool, 'SELECT crew_senders, certified_operators, from_number FROM street_notice_settings WHERE tenant_id = ?', [tenantId]);
  return { crew_senders: idList(s && s.crew_senders), certified_operators: idList(s && s.certified_operators), from_number: (s && s.from_number) || null };
}
/** The active logins a manager marked as certified water operators (Settings): [{ id, name }]. Only they can be named as issuing a boil water advisory. */
async function certifiedOperators(db, tenantId) {
  const ids = (await settingsOf(tenantId)).certified_operators;
  if (!ids.length) return [];
  return rows(db, `SELECT u.id, ${NAME} AS name FROM users u ${USER_JOIN} WHERE u.tenant_id = ? AND u.active = 1 AND u.id IN (?) ORDER BY name`, [tenantId, ids]);
}
async function canSend(req) {
  if (isManager(req)) return true;
  if (req.auth.role !== 'staff') return false;
  return (await settingsOf(req.auth.tenantId)).crew_senders.includes(Number(req.auth.userId));
}
async function mayIssue(req) {
  if (!(await canSend(req))) throw forbidden('Only managers send street notices. A manager can let a Crew lead send them in Street notices, Settings.');
}

const tenantOf = (req) => one(pool, 'SELECT id, slug, name, timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
async function noticeOf(req, { lock = false } = {}) {
  const n = await one(pool, `SELECT * FROM street_notices WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [req.auth.tenantId, paramId(req)]);
  if (!n) throw notFound('Notice');
  return n;
}

// ---------------------------------------------------------------- setup and Today
router.get('/setup', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const tenant = await tenantOf(req);
  const streets = await rows(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]);
  const operators = await certifiedOperators(pool, t);
  const on = await modules.enabledKeys(t);
  res.json({
    types: SN.TYPES.map((x) => ({ key: x.key, label: x.label, topic: x.topic, urgent: x.urgent, work_order: x.workOrder, operator: Boolean(x.operator), sms: x.sms, body: x.body })),
    topics: SN.TOPICS.map(([key, label]) => ({ key, label })), streets, operators, operator_rule: SN.OPERATOR_RULE,
    can_send: await canSend(req), is_manager: isManager(req), sms_ready: sms.enabled(), email_ready: mailer.enabled(), assets_on: on.includes('assets'),
    quiet_hours: { from: '8 AM', until: '9 PM' }, signup_link: `${baseUrl(req)}/alerts/${encodeURIComponent(tenant.slug)}`,
    // 2026.11.22: Trash and recycling's collection zones, to aim a schedule change or leaf notice at.
    collection_zones: on.includes('solidwaste') ? (await rows(pool, 'SELECT id, name FROM collection_zones WHERE tenant_id = ? AND active = 1 ORDER BY sort, name', [t])).map((x) => ({ id: Number(x.id), name: x.name })) : [],
  });
});

router.get('/today', anyone, todayRoute(async (req) => {
  const t = req.auth.tenantId;
  const [[a]] = await pool.query("SELECT COUNT(*) AS n FROM street_notices WHERE tenant_id = ? AND status = 'active'", [t]);
  const [[w]] = await pool.query("SELECT COUNT(DISTINCT resident_id) AS n FROM alert_signups WHERE tenant_id = ? AND status = 'active' AND confirmed_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY", [t]);
  const [[all]] = await pool.query("SELECT COUNT(DISTINCT resident_id) AS n FROM alert_signups WHERE tenant_id = ? AND status = 'active'", [t]);
  const out = [];
  if (Number(a.n)) out.push(card({ title: 'Active street notices', count: Number(a.n), text: 'Send an update or end each one when the work is done.', href: '#/notices?tab=active' }));
  if (Number(w.n)) out.push(card({ title: 'Alert sign-ups this week', count: Number(w.n), text: `${Number(all.n)} residents get street alerts in all.`, href: '#/notices?tab=residents' }));
  return out;
}));

// ---------------------------------------------------------------- notices
const intOrNull = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(0).max(9999999).nullable());
const areaSchema = z.object({ street_id: z.coerce.number().int().positive(), from_no: intOrNull.optional(), to_no: intOrNull.optional(), side: z.enum(['both', 'odd', 'even']).default('both') })
  .refine((a) => a.from_no == null || a.to_no == null || a.from_no <= a.to_no, { message: 'The first house number must not be higher than the last', path: ['to_no'] });
const areasSchema = z.array(areaSchema).min(1, 'Pick at least one street').max(100);
const noticeBody = z.object({
  type: z.enum(SN.TYPE_KEYS),
  title: z.string().trim().min(1).max(120),
  sms_text: z.string().trim().min(1).max(320),
  body: z.string().trim().max(4000).nullable().optional(),
  areas: areasSchema.optional(),
  // 2026.11.22: aimed at collection zones (Trash and recycling): the notice's streets are those zones' streets.
  collection_zone_ids: z.array(z.coerce.number().int().positive()).max(50).optional(),
  starts_at: planDateTimeStr.nullable().optional(),
  ends_expected_at: planDateTimeStr.nullable().optional(),
  issued_by_user_id: z.coerce.number().int().positive().nullable().optional(),
});

/** Checks the streets are this municipality's and the operator is an active login here. Returns the operator's name. */
async function checkNotice(db, tenantId, b) {
  // Aimed at collection zones (2026.11.22): the zones' streets, whole or by range, become the notice's streets.
  if (b.collection_zone_ids && b.collection_zone_ids.length) {
    const ids = [...new Set(b.collection_zone_ids)];
    const [[zc]] = await db.query('SELECT COUNT(*) AS n FROM collection_zones WHERE tenant_id = ? AND id IN (?)', [tenantId, ids]);
    if (Number(zc.n) !== ids.length) throw bad('One of the collection zones is not yours. Reload the page and pick again.');
    b.collection_zone_ids = ids;
    b.areas = await require('../lib/collection').zoneAreas(db, tenantId, ids);
    if (!b.areas.length) throw bad('Those collection zones have no streets yet. Add streets to them in Trash and recycling, Schedule.');
  } else b.collection_zone_ids = null;
  if (!b.areas || !b.areas.length) throw bad('Pick at least one street');
  const ids = [...new Set(b.areas.map((a) => Number(a.street_id)))];
  const [[c]] = await db.query('SELECT COUNT(*) AS n FROM streets WHERE tenant_id = ? AND id IN (?)', [tenantId, ids]);
  if (Number(c.n) !== ids.length) throw bad('One of the streets is not on your street list. Reload the page and pick again.');
  if (b.starts_at && b.ends_expected_at && normDateTime(b.ends_expected_at) < normDateTime(b.starts_at)) throw bad('The expected end is before the start. Check both times.');
  if (!SN.TYPE[b.type].operator) return null;
  if (!b.issued_by_user_id) throw bad(`Pick the certified operator who issued this boil water advisory. ${SN.OPERATOR_RULE}`, [{ path: 'issued_by_user_id', label: 'Issued by', message: 'Pick the certified operator who issued it' }]);
  // Only a login a manager listed as a certified operator (Street notices, Settings) can be named as issuing it.
  const op = (await certifiedOperators(db, tenantId)).find((o) => Number(o.id) === Number(b.issued_by_user_id));
  if (!op) throw bad('Pick one of your certified operators. A manager lists them in Street notices, Settings, Certified operators.', [{ path: 'issued_by_user_id', label: 'Issued by', message: 'Pick a certified operator' }]);
  return op;
}
async function writeAreas(conn, tenantId, noticeId, areas) {
  await conn.query('DELETE FROM street_notice_areas WHERE tenant_id = ? AND notice_id = ?', [tenantId, noticeId]);
  for (const a of areas) {
    await conn.query('INSERT INTO street_notice_areas (tenant_id, notice_id, street_id, from_no, to_no, side) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, noticeId, a.street_id, a.from_no ?? null, a.to_no ?? null, a.side || 'both']);
  }
}

/** Counts per update and status: { [updateId]: { queued, sending, sent, failed, opted_out, texts, emails } }. */
async function summaries(tenantId, noticeIds) {
  if (!noticeIds.length) return {};
  const found = await rows(pool, `SELECT update_id, notice_id, channel, status, COUNT(*) AS n FROM street_notice_deliveries WHERE tenant_id = ? AND notice_id IN (?)
    GROUP BY update_id, notice_id, channel, status`, [tenantId, noticeIds]);
  const out = {};
  for (const r of found) {
    for (const key of [`u${r.update_id}`, `n${r.notice_id}`]) {
      const s = out[key] || (out[key] = { queued: 0, sending: 0, sent: 0, failed: 0, opted_out: 0, texts_sent: 0, emails_sent: 0 });
      s[r.status] += Number(r.n);
      if (r.status === 'sent') s[r.channel === 'sms' ? 'texts_sent' : 'emails_sent'] += Number(r.n);
    }
  }
  return out;
}
const EMPTY = { queued: 0, sending: 0, sent: 0, failed: 0, opted_out: 0, texts_sent: 0, emails_sent: 0 };

router.get('/', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const status = String(req.query.status || 'all');
  const where = { active: "status = 'active'", scheduled: "status = 'scheduled'", draft: "status = 'draft'", ended: "status IN ('ended','cancelled')" }[status] || '1 = 1';
  const list = await rows(pool, `SELECT id, code, type, title, status, starts_at, ends_expected_at, sent_at, ended_at, created_at FROM street_notices WHERE tenant_id = ? AND ${where} ORDER BY id DESC LIMIT 200`, [t]);
  const sums = await summaries(t, list.map((n) => n.id));
  const areas = list.length ? await rows(pool, `SELECT a.notice_id, a.street_id, st.name AS street_name, a.from_no, a.to_no, a.side FROM street_notice_areas a JOIN streets st ON st.tenant_id = a.tenant_id AND st.id = a.street_id
    WHERE a.tenant_id = ? AND a.notice_id IN (?) ORDER BY a.id`, [t, list.map((n) => n.id)]) : [];
  const scheduled = list.length ? await rows(pool, "SELECT notice_id, send_at FROM street_notice_updates WHERE tenant_id = ? AND notice_id IN (?) AND kind = 'first' AND status = 'scheduled'", [t, list.map((n) => n.id)]) : [];
  res.json({ data: list.map((n) => ({ ...n, type_label: SN.TYPE[n.type].label, streets: SN.areasWords(areas.filter((a) => a.notice_id === n.id)),
    send_at: (scheduled.find((s) => s.notice_id === n.id) || {}).send_at || null, summary: sums[`n${n.id}`] || EMPTY })) });
});

router.post('/preview', anyone, validate(z.object({ type: z.enum(SN.TYPE_KEYS), areas: areasSchema.optional(), collection_zone_ids: z.array(z.coerce.number().int().positive()).max(50).optional() })), async (req, res) => {
  const areas = req.body.collection_zone_ids && req.body.collection_zone_ids.length ? await require('../lib/collection').zoneAreas(pool, req.auth.tenantId, req.body.collection_zone_ids) : req.body.areas || [];
  const aud = await SN.audienceOf(req.auth.tenantId, req.body.type, areas);
  const when = await SN.sendAfterFor(req.auth.tenantId, req.body.type);
  res.json({ ...SN.countsOf(aud), held_until: when.held ? when.at : null });
});

router.post('/', anyone, validate(noticeBody), async (req, res) => {
  await mayIssue(req);
  const t = req.auth.tenantId; const b = req.body;
  const id = await tx(async (conn) => {
    const op = await checkNotice(conn, t, b);
    let r;
    for (let i = 0; ; i += 1) {
      try {
        [r] = await conn.query(`INSERT INTO street_notices (tenant_id, code, type, title, sms_text, body, starts_at, ends_expected_at, issued_by_user_id, issued_by_name, created_by, collection_zone_ids)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, newCode(), b.type, b.title, b.sms_text, b.body || null, b.starts_at ? normDateTime(b.starts_at) : null,
          b.ends_expected_at ? normDateTime(b.ends_expected_at) : null, op ? op.id : null, op ? String(op.name).slice(0, 120) : null, req.auth.userId, b.collection_zone_ids ? JSON.stringify(b.collection_zone_ids) : null]);
        break;
      } catch (err) { if (err.code !== 'ER_DUP_ENTRY' || i > 4) throw err; }
    }
    await writeAreas(conn, t, r.insertId, b.areas);
    await audit(conn, req, 'create', 'street_notices', r.insertId, { type: b.type, streets: b.areas.length, issued_by_user_id: op ? op.id : null });
    return r.insertId;
  });
  res.status(201).json(await detail(req, id));
});

async function detail(req, id) {
  const t = req.auth.tenantId;
  const n = await one(pool, 'SELECT * FROM street_notices WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!n) throw notFound('Notice');
  const tenant = await tenantOf(req);
  const areas = await SN.areasOf(pool, t, id);
  const updates = await rows(pool, 'SELECT id, kind, sms_text, body, status, send_at, created_at, queued_at FROM street_notice_updates WHERE tenant_id = ? AND notice_id = ? ORDER BY id', [t, id]);
  const sums = await summaries(t, [id]);
  const out = {
    ...n, type_label: SN.TYPE[n.type].label, urgent: SN.TYPE[n.type].urgent, areas: areas.map((a) => ({ ...a, words: SN.areaWords(a) })), streets: SN.areasWords(areas),
    updates: updates.map((u) => ({ ...u, summary: sums[`u${u.id}`] || EMPTY })), summary: sums[`n${id}`] || EMPTY,
    public_link: SN.publicLink(baseUrl(req), tenant.slug, n.code), can_send: await canSend(req), blanks: SN.blanksIn(n.sms_text, n.body || ''),
  };
  if (['draft', 'scheduled'].includes(n.status)) {
    const aud = await SN.audienceOf(t, n.type, areas);
    const when = await SN.sendAfterFor(t, n.type);
    out.preview = { ...SN.countsOf(aud), held_until: when.held ? when.at : null };
  }
  return out;
}

router.get('/export', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const list = await rows(pool, 'SELECT id, code, type, title, status, starts_at, ends_expected_at, sent_at, ended_at, issued_by_name, work_order_id FROM street_notices WHERE tenant_id = ? ORDER BY id', [t]);
  const sums = await summaries(t, list.map((n) => n.id));
  const areas = list.length ? await rows(pool, `SELECT a.notice_id, st.name AS street_name, a.from_no, a.to_no, a.side FROM street_notice_areas a JOIN streets st ON st.tenant_id = a.tenant_id AND st.id = a.street_id
    WHERE a.tenant_id = ? AND a.notice_id IN (?) ORDER BY a.id`, [t, list.map((n) => n.id)]) : [];
  const updates = list.length ? await rows(pool, "SELECT notice_id, COUNT(*) AS n FROM street_notice_updates WHERE tenant_id = ? AND notice_id IN (?) AND kind <> 'first' AND status IN ('queued','done') GROUP BY notice_id", [t, list.map((n) => n.id)]) : [];
  const data = list.map((n) => {
    const s = sums[`n${n.id}`] || EMPTY;
    return { notice: n.code, type: SN.TYPE[n.type].label, title: n.title, streets: SN.areasWords(areas.filter((a) => a.notice_id === n.id)), status: n.status,
      starts: n.starts_at || '', expected_end: n.ends_expected_at || '', sent_utc: n.sent_at || '', ended_utc: n.ended_at || '', issued_by_operator: n.issued_by_name || '',
      work_order: n.work_order_id || '', updates: (updates.find((u) => u.notice_id === n.id) || {}).n || 0, texts_sent: s.texts_sent, emails_sent: s.emails_sent, failed: s.failed, opted_out: s.opted_out };
  });
  await audit(pool, req, 'export', 'street_notices', null, { rows: data.length, contacts: false });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="street-notices.csv"')
    .send(toCsv(['notice', 'type', 'title', 'streets', 'status', 'starts', 'expected_end', 'sent_utc', 'ended_utc', 'issued_by_operator', 'work_order', 'updates', 'texts_sent', 'emails_sent', 'failed', 'opted_out'], data));
});

// ---------------------------------------------------------------- residents signed up
router.get('/residents/streets', anyone, async (req, res) => {
  const data = await rows(pool, `SELECT st.id AS street_id, st.name, st.active,
      COUNT(DISTINCT CASE WHEN s.status = 'active' THEN s.resident_id END) AS residents,
      COUNT(DISTINCT CASE WHEN s.status = 'active' AND s.by_text = 1 THEN s.phone END) AS phones,
      COUNT(DISTINCT CASE WHEN s.status = 'active' AND s.by_email = 1 THEN LOWER(s.email) END) AS emails,
      COUNT(DISTINCT CASE WHEN s.status = 'pending' THEN s.id END) AS waiting
    FROM streets st LEFT JOIN alert_signups s ON s.tenant_id = st.tenant_id AND s.street_id = st.id
    WHERE st.tenant_id = ? GROUP BY st.id, st.name, st.active HAVING st.active = 1 OR residents > 0 ORDER BY st.name`, [req.auth.tenantId]);
  const total = await one(pool, "SELECT COUNT(DISTINCT resident_id) AS n FROM alert_signups WHERE tenant_id = ? AND status = 'active'", [req.auth.tenantId]);
  res.json({ data: data.map((r) => ({ ...r, residents: Number(r.residents), phones: Number(r.phones), emails: Number(r.emails), waiting: Number(r.waiting) })), total: Number(total.n) });
});

const signupList = (tenantId, streetId) => rows(pool, `SELECT s.id, s.resident_id, s.name, s.phone, s.email, s.house_number, s.unit, s.topics, s.by_text, s.by_email, s.status, s.source, s.created_at, s.confirmed_at,
    st.name AS street, (SELECT a.stopped_at FROM alert_addresses a WHERE a.tenant_id = s.tenant_id AND a.channel = 'sms' AND a.addr = RIGHT(REGEXP_REPLACE(COALESCE(s.phone, ''), '[^0-9]', ''), 10)) AS texts_stopped_at,
    (SELECT a.stopped_at FROM alert_addresses a WHERE a.tenant_id = s.tenant_id AND a.channel = 'email' AND a.addr = LOWER(s.email)) AS emails_stopped_at
  FROM alert_signups s JOIN streets st ON st.tenant_id = s.tenant_id AND st.id = s.street_id
  WHERE s.tenant_id = ? AND s.status IN ('active','pending') ${streetId ? 'AND s.street_id = ?' : ''} ORDER BY st.name, s.house_no IS NULL, s.house_no, s.house_number, s.id LIMIT 5000`, streetId ? [tenantId, streetId] : [tenantId]);

router.get('/residents', desk, async (req, res) => {
  const street = Number(req.query.street_id);
  if (!Number.isInteger(street) || street <= 0) throw bad('Pick a street');
  res.json({ data: (await signupList(req.auth.tenantId, street)).map((s) => ({ ...s, topics: String(s.topics || '').split(',').filter(Boolean) })) });
});

router.get('/residents/export', anyone, async (req, res) => {
  const contacts = String(req.query.contacts || '') === '1';
  if (contacts && !isManager(req)) throw forbidden('Only managers can export contact details. The list without them is a public record anyone here can export.');
  const list = await signupList(req.auth.tenantId, null);
  const data = list.map((s) => ({
    street: s.street, topics: String(s.topics || '').replace(/,/g, ' '), by_text: s.by_text && !s.texts_stopped_at ? 'yes' : 'no', by_email: s.by_email && !s.emails_stopped_at ? 'yes' : 'no',
    status: s.status, source: s.source, signed_up: String(s.created_at instanceof Date ? s.created_at.toISOString() : s.created_at || '').slice(0, 10),
    ...(contacts ? { name: s.name || '', phone: s.phone || '', email: s.email || '', house_number: s.house_number || '', unit: s.unit || '' } : {}),
  }));
  const cols = ['street', 'topics', 'by_text', 'by_email', 'status', 'source', 'signed_up', ...(contacts ? ['name', 'phone', 'email', 'house_number', 'unit'] : [])];
  await audit(pool, req, contacts ? 'export_contacts' : 'export', 'alert_signups', null, { rows: data.length, contacts });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="alert-sign-ups${contacts ? '-with-contacts' : ''}.csv"`).send(toCsv(cols, data));
});

const importBody = z.object({
  csv: z.string().min(1, 'Paste the list').max(2_000_000),
  consent: z.literal(true, { message: 'Confirm that every resident on the list agreed to get alerts' }),
  consent_note: z.string().trim().min(5, 'Say where they agreed, for example "Paper forms at the 2025 open house"').max(300),
});
const HEADS = { name: 'name', phone: 'phone', cell: 'phone', mobile: 'phone', email: 'email', street: 'street', house_number: 'house_number', house: 'house_number', number: 'house_number', unit: 'unit', apt: 'unit', topics: 'topics' };
router.post('/residents/import', mgr, validate(importBody), async (req, res) => {
  const t = req.auth.tenantId;
  const table = require('../lib/places').parseCsv(req.body.csv);
  if (table.length < 2) throw bad('The list needs a header row (name, phone, email, street, house_number, unit, topics) and at least one resident.');
  const head = table[0].map((h) => HEADS[String(h).trim().toLowerCase().replace(/[\s-]+/g, '_')] || null);
  if (!head.includes('street') || (!head.includes('phone') && !head.includes('email'))) throw bad('The header row needs a street column and a phone or email column.');
  if (table.length > 5001) throw bad('Import at most 5,000 residents at a time.');
  const streets = await rows(pool, 'SELECT id, name, aliases FROM streets WHERE tenant_id = ?', [t]);
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  const byName = new Map();
  for (const s of streets) { byName.set(norm(s.name), s.id); for (const a of String(s.aliases || '').split(/[,;]/)) if (norm(a)) byName.set(norm(a), s.id); }
  const out = { added: 0, already: 0, skipped: [], stopped: 0 };
  const undef = (v) => String(v ?? '').trim().replace(/^'(?=[=+\-@])/, '');
  for (let i = 1; i < table.length; i += 1) {
    const row = {}; head.forEach((k, j) => { if (k) row[k] = undef(table[i][j]); });
    const line = i + 1;
    const streetId = byName.get(norm(row.street));
    if (!streetId) { out.skipped.push({ line, reason: 'Street not on your street list' }); continue; }
    const phone = row.phone ? SN.phoneAddr(row.phone) : null; const email = row.email ? SN.emailAddr(row.email) : null;
    if (row.phone && !phone) { out.skipped.push({ line, reason: 'Phone is not a US number with an area code' }); continue; }
    if (row.email && !email) { out.skipped.push({ line, reason: 'Email is not a valid address' }); continue; }
    if (!phone && !email) { out.skipped.push({ line, reason: 'No phone or email' }); continue; }
    const topics = ['water', ...String(row.topics || '').toLowerCase().split(/[\s,;]+/).filter((x) => SN.TOPIC_KEYS.includes(x))];
    const r = await tx(async (conn) => {
      const residentId = await upsertResident(conn, t, { name: row.name || null, phone, email, streetId, houseNumber: row.house_number || null, unit: row.unit || null }, { source: 'import', userId: req.auth.userId });
      // One sign-up for each phone or email, like the public page: a manage link reaches only its own.
      let added = 0; let stopped = false;
      for (const [channel, v] of [['sms', phone], ['email', email]]) {
        if (!v) continue;
        const dup = await one(conn, `SELECT id FROM alert_signups WHERE tenant_id = ? AND street_id = ? AND status = 'active' AND COALESCE(house_number, '') = ? AND COALESCE(unit, '') = ?
          AND ${channel === 'sms' ? 'by_text = 1 AND phone = ?' : 'by_email = 1 AND LOWER(email) = ?'} LIMIT 1`, [t, streetId, (row.house_number || '').slice(0, 20), (row.unit || '').slice(0, 20), v]);
        if (dup) continue;
        const a = await SN.addressRow(conn, t, channel, v);
        // A phone that texted STOP, or an address that used the stop link, stays stopped: the import is not a new yes.
        if (a.stopped_at) stopped = true;
        else if (channel === 'sms' && await RES.stoppedByText(conn, t, v)) { await SN.stopAddress(conn, t, 'sms', v, 'text_reply'); stopped = true; }
        else {
          if (!a.confirmed_at) await conn.query("UPDATE alert_addresses SET confirmed_at = UTC_TIMESTAMP(), confirmed_by = 'import' WHERE tenant_id = ? AND id = ?", [t, a.id]);
          await SN.recordAnswer(conn, t, a.id, 'opted_in', 'import', req.auth.userId);
          const cur = await one(conn, 'SELECT texts_ok, emails_ok FROM residents WHERE tenant_id = ? AND id = ?', [t, residentId]);
          if (!Number(cur[channel === 'sms' ? 'texts_ok' : 'emails_ok'])) await RES.recordConsent(conn, t, residentId, channel, true, 'import', req.auth.userId);
        }
        await conn.query(`INSERT INTO alert_signups (tenant_id, resident_id, name, street_id, house_number, house_no, unit, phone, email, topics, by_text, by_email, status, source, consent_note, created_by, confirmed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'import', ?, ?, UTC_TIMESTAMP())`, [t, residentId, row.name ? row.name.slice(0, 120) : null, streetId, row.house_number ? row.house_number.slice(0, 20) : null, SN.houseNo(row.house_number),
          row.unit ? row.unit.slice(0, 20) : null, channel === 'sms' ? v : null, channel === 'email' ? v : null, [...new Set(topics)].join(','), channel === 'sms' ? 1 : 0, channel === 'email' ? 1 : 0, req.body.consent_note, req.auth.userId]);
        added += 1;
      }
      if (!added) return 'already';
      return stopped ? 'stopped' : 'added';
    });
    if (r === 'already') out.already += 1; else { out.added += 1; if (r === 'stopped') out.stopped += 1; }
  }
  await audit(pool, req, 'import', 'alert_signups', null, { rows: table.length - 1, added: out.added, already: out.already, skipped: out.skipped.length, stopped: out.stopped, consent_confirmed: true });
  res.json({ ...out, skipped: out.skipped.slice(0, 200) });
});

router.post('/residents/signups/:id/end', desk, async (req, res) => {
  const [r] = await pool.query("UPDATE alert_signups SET status = 'ended', ended_at = UTC_TIMESTAMP(), code_hash = NULL WHERE tenant_id = ? AND id = ? AND status <> 'ended'", [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Sign-up');
  await audit(pool, req, 'end', 'alert_signups', paramId(req), null);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- settings
const OWN_NUMBER_WORDS = 'Ask Verdynt to set up your own texting number.';
router.get('/settings', mgr, async (req, res) => {
  const s = await settingsOf(req.auth.tenantId);
  const crew = await rows(pool, `SELECT u.id, ${NAME} AS name FROM users u ${USER_JOIN} WHERE u.tenant_id = ? AND u.active = 1 AND u.role = 'staff' ORDER BY name`, [req.auth.tenantId]);
  const logins = await rows(pool, `SELECT u.id, ${NAME} AS name, u.role FROM users u ${USER_JOIN} WHERE u.tenant_id = ? AND u.active = 1 AND u.role IN ('owner','manager','staff') ORDER BY name`, [req.auth.tenantId]);
  // The texting number is shown, never changed here: only Verdynt sets a municipality's own number (platform console).
  res.json({ ...s, crew, logins, own_number_words: OWN_NUMBER_WORDS, default_from: RES.sayNumber((await RES.textingNumber(pool, req.auth.tenantId)) || '') || null });
});
router.put('/settings', mgr, validate(z.object({
  crew_senders: z.array(z.coerce.number().int().positive()).max(50).default([]),
  certified_operators: z.array(z.coerce.number().int().positive()).max(50).optional(),
  from_number: z.string().trim().max(30).nullable().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const cur = await settingsOf(t);
  if (b.from_number !== undefined && (b.from_number || null) !== cur.from_number && (require('../lib/sms').e164(b.from_number || '') || null) !== cur.from_number) throw forbidden(`Only Verdynt sets a municipality's texting number. ${OWN_NUMBER_WORDS}`);
  const ids = [...new Set(b.crew_senders)];
  if (ids.length) {
    const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'staff' AND active = 1 AND id IN (?)", [t, ids]);
    if (Number(c.n) !== ids.length) throw bad('Only active Crew logins can be picked to send notices.');
  }
  const ops = b.certified_operators === undefined ? cur.certified_operators : [...new Set(b.certified_operators)];
  if (ops.length) {
    const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role IN ('owner','manager','staff') AND active = 1 AND id IN (?)", [t, ops]);
    if (Number(c.n) !== ops.length) throw bad('Only active owner, manager and Crew logins can be marked as certified operators.');
  }
  await pool.query('INSERT INTO street_notice_settings (tenant_id, crew_senders, certified_operators, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE crew_senders = VALUES(crew_senders), certified_operators = VALUES(certified_operators), updated_by = VALUES(updated_by)',
    [t, ids.join(',') || null, ops.join(',') || null, req.auth.userId]);
  await audit(pool, req, 'settings', 'street_notice_settings', t, { crew_senders: ids, certified_operators: ops });
  res.json(await settingsOf(t));
});

// ---------------------------------------------------------------- one notice (after the fixed paths above)
router.get('/:id', anyone, async (req, res) => res.json(await detail(req, paramId(req))));

router.put('/:id', anyone, validate(noticeBody), async (req, res) => {
  await mayIssue(req);
  const t = req.auth.tenantId; const b = req.body;
  await tx(async (conn) => {
    const n = await one(conn, 'SELECT id, status FROM street_notices WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!n) throw notFound('Notice');
    if (n.status !== 'draft') throw conflict(n.status === 'scheduled' ? 'Unschedule the notice first, then change it.' : 'A notice that has gone out cannot be changed. Send an update instead.');
    const op = await checkNotice(conn, t, b);
    await conn.query('UPDATE street_notices SET type = ?, title = ?, sms_text = ?, body = ?, starts_at = ?, ends_expected_at = ?, issued_by_user_id = ?, issued_by_name = ?, collection_zone_ids = ? WHERE tenant_id = ? AND id = ?',
      [b.type, b.title, b.sms_text, b.body || null, b.starts_at ? normDateTime(b.starts_at) : null, b.ends_expected_at ? normDateTime(b.ends_expected_at) : null, op ? op.id : null, op ? String(op.name).slice(0, 120) : null, b.collection_zone_ids ? JSON.stringify(b.collection_zone_ids) : null, t, n.id]);
    await writeAreas(conn, t, n.id, b.areas);
    await audit(conn, req, 'update', 'street_notices', n.id, { type: b.type, streets: b.areas.length, issued_by_user_id: op ? op.id : null });
  });
  res.json(await detail(req, paramId(req)));
});

router.delete('/:id', anyone, async (req, res) => {
  await mayIssue(req);
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const n = await one(conn, 'SELECT id, status FROM street_notices WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!n) throw notFound('Notice');
    if (n.status !== 'draft') throw conflict('Only a draft can be deleted. A notice that went out stays on record.');
    await conn.query('DELETE FROM street_notice_updates WHERE tenant_id = ? AND notice_id = ?', [t, n.id]);
    await conn.query('DELETE FROM street_notice_areas WHERE tenant_id = ? AND notice_id = ?', [t, n.id]);
    await conn.query('DELETE FROM street_notices WHERE tenant_id = ? AND id = ?', [t, n.id]);
    await audit(conn, req, 'delete', 'street_notices', n.id, null);
  });
  res.json({ ok: true });
});

/** Opens a work order for an outage notice (source 'notice'), with the Assets and fleet app on. Returns its id. */
async function openWorkOrder(conn, req, n, areas) {
  if (!(await modules.enabledKeys(req.auth.tenantId)).includes('assets')) throw bad('Work orders need the Assets and fleet app. Send the notice without a work order, or ask for the app to be turned on.');
  const where = SN.areasWords(areas);
  const [r] = await conn.query("INSERT INTO work_orders (tenant_id, title, description, priority, location, source, opened_by) VALUES (?, ?, ?, ?, ?, 'notice', ?)",
    [req.auth.tenantId, `${SN.TYPE[n.type].label}: ${n.title}`.slice(0, 150), `Opened with street notice ${n.code}. Streets: ${where}`.slice(0, 2000), n.type === 'water_outage' ? 'urgent' : 'high', where.slice(0, 120), req.auth.userId]);
  await audit(conn, req, 'create', 'work_orders', r.insertId, { source: 'notice', notice_id: n.id });
  return r.insertId;
}

const sendBody = z.object({ confirm: z.literal(true, { message: 'Confirm the send' }), send_at: planDateTimeStr.nullable().optional(), work_order: z.boolean().optional() });
router.post('/:id/send', anyone, validate(sendBody), async (req, res) => {
  await mayIssue(req);
  const t = req.auth.tenantId; const b = req.body;
  const tenant = await tenantOf(req);
  if (!sms.enabled() && !mailer.enabled()) throw conflict('Text messages and email are not set up yet, so nothing can be sent. See Help, "Set up email and text messages".');
  let sendAt = null;
  if (b.send_at) {
    sendAt = quiet.utcOf(tenant.timezone || 'America/New_York', normDateTime(b.send_at));
    if (sendAt <= sentNow()) sendAt = null; // a time already past means now
  }
  const out = await tx(async (conn) => {
    const n = await one(conn, 'SELECT * FROM street_notices WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!n) throw notFound('Notice');
    if (n.status !== 'draft') throw conflict(n.status === 'scheduled' ? 'This notice is already scheduled. Unschedule it to change the time.' : 'This notice has already gone out. Send an update instead.');
    const blanks = SN.blanksIn(n.sms_text, n.body || '');
    if (blanks.length) throw bad(`Fill in the blanks in the message first: ${blanks.join(', ')}`);
    if (SN.TYPE[n.type].operator && !n.issued_by_user_id) throw bad(`Pick the certified operator who issued this boil water advisory. ${SN.OPERATOR_RULE}`);
    // Checked again now: the operator may have been taken off the certified list since the draft was saved.
    if (SN.TYPE[n.type].operator && !(await SN.operatorCertified(conn, t, n.issued_by_user_id))) throw bad(SN.NOT_CERTIFIED(n.issued_by_name), [{ path: 'issued_by_user_id', label: 'Issued by', message: 'Pick a certified operator' }]);
    const areas = await SN.areasOf(conn, t, n.id);
    if (!areas.length) throw bad('Pick at least one street');
    let wo = null;
    if (b.work_order && SN.TYPE[n.type].workOrder && !n.work_order_id) wo = await openWorkOrder(conn, req, n, areas);
    const [u] = await conn.query('INSERT INTO street_notice_updates (tenant_id, notice_id, kind, sms_text, body, status, send_at, base_url, created_by) VALUES (?, ?, \'first\', ?, ?, ?, ?, ?, ?)',
      [t, n.id, n.sms_text, n.body || null, sendAt ? 'scheduled' : 'queued', sendAt, baseUrl(req).slice(0, 200), req.auth.userId]);
    // Marked at once, so a second press of Send finds it already gone.
    await conn.query('UPDATE street_notices SET status = ?, sent_at = ?, work_order_id = COALESCE(?, work_order_id), held_note = NULL WHERE tenant_id = ? AND id = ?', [sendAt ? 'scheduled' : 'active', sendAt ? null : sentNow(), wo, t, n.id]);
    await audit(conn, req, sendAt ? 'schedule' : 'send', 'street_notices', n.id, { send_at_utc: sendAt, work_order_id: wo });
    return { updateId: u.insertId, wo };
  });
  if (sendAt) return res.json({ scheduled: true, send_at: sendAt, work_order_id: out.wo });
  const counts = await SN.queueUpdate(t, out.updateId);
  setImmediate(() => { SN.kick(); });
  res.json({ scheduled: false, ...counts, work_order_id: out.wo });
});

router.post('/:id/unschedule', anyone, async (req, res) => {
  await mayIssue(req);
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const n = await one(conn, 'SELECT id, status FROM street_notices WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!n) throw notFound('Notice');
    const [u] = await conn.query("UPDATE street_notice_updates SET status = 'cancelled' WHERE tenant_id = ? AND notice_id = ? AND kind = 'first' AND status = 'scheduled'", [t, n.id]);
    if (n.status !== 'scheduled' || !u.affectedRows) throw conflict('This notice is not waiting to go out. It may have just been sent.');
    await conn.query("UPDATE street_notices SET status = 'draft' WHERE tenant_id = ? AND id = ?", [t, n.id]);
    await audit(conn, req, 'unschedule', 'street_notices', n.id, null);
  });
  res.json(await detail(req, paramId(req)));
});

const followBody = z.object({ sms_text: z.string().trim().min(1).max(320), body: z.string().trim().max(4000).nullable().optional() });
/** Writes a follow-up or "Ended" message to the same list and starts sending it. */
async function followUp(req, kind, b) {
  const t = req.auth.tenantId;
  const blanks = SN.blanksIn(b.sms_text, b.body || '');
  if (blanks.length) throw bad(`Fill in the blanks in the message first: ${blanks.join(', ')}`);
  const [u] = await pool.query('INSERT INTO street_notice_updates (tenant_id, notice_id, kind, sms_text, body, status, base_url, created_by) VALUES (?, ?, ?, ?, ?, \'queued\', ?, ?)',
    [t, paramId(req), kind, b.sms_text, b.body || null, baseUrl(req).slice(0, 200), req.auth.userId]);
  const counts = await SN.queueUpdate(t, u.insertId);
  setImmediate(() => { SN.kick(); });
  return { update_id: u.insertId, ...counts };
}

router.post('/:id/updates', anyone, validate(followBody), async (req, res) => {
  await mayIssue(req);
  const n = await noticeOf(req);
  if (n.status !== 'active') throw conflict(n.status === 'ended' ? 'This notice has ended. Start a new notice instead.' : 'Send the notice first. An update goes to the people who got it.');
  const out = await followUp(req, 'update', req.body);
  await audit(pool, req, 'send_update', 'street_notices', n.id, { update_id: out.update_id, texts: out.texts, emails: out.emails });
  res.json(out);
});

router.post('/:id/end', anyone, validate(z.object({ sms_text: z.string().trim().max(320).nullable().optional(), body: z.string().trim().max(4000).nullable().optional() })), async (req, res) => {
  await mayIssue(req);
  const t = req.auth.tenantId;
  const [r] = await pool.query("UPDATE street_notices SET status = 'ended', ended_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND status = 'active'", [t, paramId(req)]);
  if (!r.affectedRows) { await noticeOf(req); throw conflict('Only a notice that has gone out can be ended. Delete a draft, or unschedule a scheduled one.'); }
  let out = { texts: 0, emails: 0 };
  if (req.body.sms_text) out = await followUp(req, 'ended', { sms_text: req.body.sms_text, body: req.body.body });
  await audit(pool, req, 'end', 'street_notices', paramId(req), { last_message: Boolean(req.body.sms_text), texts: out.texts || 0, emails: out.emails || 0 });
  res.json({ ok: true, ...out });
});

router.get('/:id/problems', mgr, async (req, res) => {
  const n = await noticeOf(req);
  res.json({ data: await rows(pool, "SELECT d.id, d.update_id, d.channel, d.to_addr, d.error, d.sent_at FROM street_notice_deliveries d WHERE d.tenant_id = ? AND d.notice_id = ? AND d.status = 'failed' ORDER BY d.id LIMIT 200", [req.auth.tenantId, n.id]) });
});

// ================================================================ public pages
const CODE_MINUTES = 15;
const MAX_TRIES = 5;
const CODES_PER_HOUR = 5;
const codeHash = (signupId, code) => crypto.createHmac('sha256', config.linkSecret).update(`alerts-code:${signupId}:${code}`).digest('hex');

async function town(req) {
  const t = await one(pool, "SELECT id, slug, name, timezone, reply_to FROM tenants WHERE slug = ? AND status = 'active' AND org_type = 'municipality'", [String(req.params.slug || '')]);
  if (!t) throw new AppError(404, 'Page not found');
  return t;
}
const textingNumber = (tenantId) => RES.textingNumber(pool, tenantId);
const says = RES.sayNumber;
const phoneHint = (p) => { const k = sms.phoneKey(p); return k ? `ending in ${k.slice(-4)}` : null; };
const emailHint = (e) => { const m = /^(.)[^@]*(@.+)$/.exec(String(e || '')); return m ? `${m[1]}…${m[2]}` : null; };

/** Public words of a notice (never a name, phone, email or the delivery counts). */
async function publicNotice(t, n) {
  const areas = await SN.areasOf(pool, t.id, n.id);
  const updates = await rows(pool, "SELECT kind, sms_text, body, COALESCE(queued_at, created_at) AS at FROM street_notice_updates WHERE tenant_id = ? AND notice_id = ? AND kind <> 'first' AND status IN ('queued','done') ORDER BY id", [t.id, n.id]);
  return {
    municipality: t.name, timezone: t.timezone, code: n.code, type: n.type, type_label: SN.TYPE[n.type].label, title: n.title, summary: n.sms_text, body: n.body || null,
    status: n.status === 'ended' ? 'ended' : 'active', starts_at: n.starts_at, ends_expected_at: n.ends_expected_at, sent_at: n.sent_at, ended_at: n.ended_at,
    streets: areas.map((a) => SN.areaWords(a)), operator_note: SN.TYPE[n.type].operator ? 'Issued by our certified water operator.' : null,
    updates: updates.map((u) => ({ kind: u.kind, at: u.at, text: u.body || u.sms_text })),
  };
}

publicRouter.get('/:slug/alerts', async (req, res) => {
  const t = await town(req);
  const streets = await rows(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t.id]);
  const list = await rows(pool, "SELECT * FROM street_notices WHERE tenant_id = ? AND (status = 'active' OR (status = 'ended' AND ended_at >= UTC_TIMESTAMP() - INTERVAL 3 DAY)) ORDER BY id DESC LIMIT 20", [t.id]);
  const notices = [];
  for (const n of list) { const p = await publicNotice(t, n); notices.push({ code: p.code, type_label: p.type_label, title: p.title, status: p.status, streets: p.streets, sent_at: p.sent_at }); }
  res.set('Cache-Control', 'no-store').json({ municipality: t.name, streets, topics: SN.TOPICS.map(([key, label]) => ({ key, label, always: key === 'water' })), notices, texting_number: says(await textingNumber(t.id)) || null });
});

const signupBody = z.object({
  street_id: z.coerce.number().int().positive(),
  house_number: z.string().trim().min(1, 'Enter your house number').max(20),
  unit: z.string().trim().max(20).nullable().optional(),
  name: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().max(255).nullable().optional(),
  topics: z.array(z.enum(SN.TOPIC_KEYS)).max(10).default([]),
  streams: z.array(z.coerce.number().int().positive()).max(20).optional(), // 2026.11.22: a reminder the night before these collection streams
  website: z.string().max(200).optional(),
});

/** Claims one code for this phone (5 an hour). Throws 429 past that. */
async function claimCode(conn, tenantId, phone) {
  const a = await SN.addressRow(conn, tenantId, 'sms', phone);
  const [r] = await conn.query(`UPDATE alert_addresses SET codes_sent = IF(codes_from IS NULL OR codes_from < UTC_TIMESTAMP() - INTERVAL 1 HOUR, 1, codes_sent + 1),
      codes_from = IF(codes_from IS NULL OR codes_from < UTC_TIMESTAMP() - INTERVAL 1 HOUR, UTC_TIMESTAMP(), codes_from)
    WHERE tenant_id = ? AND id = ? AND (codes_from IS NULL OR codes_from < UTC_TIMESTAMP() - INTERVAL 1 HOUR OR codes_sent < ?)`, [tenantId, a.id, CODES_PER_HOUR]);
  if (!r.affectedRows) throw new AppError(429, 'Too many codes sent to this phone. Try again in an hour.');
  return a;
}
/** A new code on the sign-up, texted to its phone. */
async function sendCode(t, signup) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query('UPDATE alert_signups SET code_hash = ?, code_expires_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE, code_tries = 0 WHERE tenant_id = ? AND id = ?', [codeHash(signup.id, code), CODE_MINUTES, t.id, signup.id]);
  const from = (await settingsOf(t.id)).from_number;
  const r = await sms.send({ tenantId: t.id, to: signup.phone, body: `${t.name} alerts: your code is ${code}. It works for ${CODE_MINUTES} minutes. If you did not ask for it, ignore this text.`, from, tag: 'alert-code' });
  if (!r.ok) {
    await pool.query('UPDATE alert_signups SET code_hash = NULL WHERE tenant_id = ? AND id = ?', [t.id, signup.id]);
    throw new AppError(502, 'We could not send a text to that number. Check it, or sign up with your email instead.');
  }
}
async function sendEmailLink(req, t, signup) {
  const link = `${baseUrl(req)}/alerts/${encodeURIComponent(t.slug)}/email/${SN.emailToken(t.id, signup.id, signup.email)}`;
  const r = await mailer.send({ tenantId: t.id, to: signup.email, fromName: t.name, replyTo: t.reply_to || undefined, tag: 'alert-confirm', subject: `Confirm your email for ${t.name} alerts`,
    text: `Press this link to get ${t.name} street alerts by email:\n\n${link}\n\nIf you did not sign up, ignore this email and nothing more is sent.`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#12303a;line-height:1.55"><p>Press the button to get ${require('../lib/format').esc(t.name)} street alerts by email.</p><p><a href="${require('../lib/format').esc(link)}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#1b5fc1;color:#fff;text-decoration:none;font-weight:700">Confirm my email</a></p><p style="font-size:12px;color:#55687a">If you did not sign up, ignore this email and nothing more is sent.</p></div>` });
  return r.ok;
}

publicRouter.post('/:slug/alerts', validate(signupBody), async (req, res) => {
  const t = await town(req); const b = req.body;
  if (b.website) throw bad('Could not sign up');
  const phone = b.phone ? SN.phoneAddr(b.phone) : null;
  const email = b.email ? SN.emailAddr(b.email) : null;
  if (b.phone && !phone) throw bad('Enter a US cell phone number with its area code, like 610-555-0123.');
  if (b.email && !email) throw bad('Enter a full email address, like name@example.com.');
  if (!phone && !email) throw bad('Give a cell phone number for texts, an email address, or both.');
  if (phone && !sms.enabled()) throw new AppError(503, 'Text alerts are not available yet. Sign up with your email instead.');
  if (!phone && !mailer.enabled()) throw new AppError(503, 'Email alerts are not available yet. Please call the municipal office.');
  const street = await one(pool, 'SELECT id FROM streets WHERE tenant_id = ? AND id = ? AND active = 1', [t.id, b.street_id]);
  if (!street) throw bad('Pick your street from the list.');
  if (phone) {
    // The one STOP rule (lib/residents.js): a phone that texted STOP gets no code; only a texted START turns texts back on.
    if (await RES.stoppedByText(pool, t.id, phone) || await sms.phoneSaidNo(t.id, sms.phoneKey(phone))) {
      throw conflict(`${RES.textsOffWords(await textingNumber(t.id))} Then sign up again.`, { code: 'texts_off' });
    }
  }
  // Night-before collection reminders (2026.11.22): the streams must be this municipality's, and they bring the trash topic.
  const streams = b.streams && b.streams.length ? (await rows(pool, 'SELECT id FROM collection_streams WHERE tenant_id = ? AND active = 1 AND id IN (?)', [t.id, b.streams])).map((x) => Number(x.id)) : [];
  if (b.streams && b.streams.length && streams.length !== new Set(b.streams).size) throw bad('Pick what you want a reminder for from the list.');
  const topics = [...new Set(['water', ...b.topics, ...(streams.length ? ['trash'] : [])])].join(',');
  // Nobody is joined to a resident here: the phone joins only once its code is entered, and the email only once its link
  // is pressed (residentForConfirmed). A phone and an email given together are two sign-ups, one for each, so neither can
  // see or change what came in through the other.
  const made = await tx(async (conn) => {
    if (phone) await claimCode(conn, t.id, phone);
    const out = {};
    for (const [channel, v] of [['sms', phone], ['email', email]]) {
      if (!v) continue;
      const [r] = await conn.query(`INSERT INTO alert_signups (tenant_id, resident_id, name, street_id, house_number, house_no, unit, phone, email, topics, collection_streams, status, source)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'web')`, [t.id, b.name || null, street.id, b.house_number, SN.houseNo(b.house_number), b.unit || null,
        channel === 'sms' ? v : null, channel === 'email' ? v : null, topics, streams.length ? streams.join(',') : null]);
      out[channel] = { id: r.insertId, phone: channel === 'sms' ? v : null, email: channel === 'email' ? v : null };
    }
    return out;
  });
  if (made.sms) await sendCode(t, made.sms);
  const emailSent = made.email ? await sendEmailLink(req, t, made.email) : false;
  if (!phone && !emailSent) throw new AppError(502, 'We could not send an email to that address. Check it and try again.');
  res.status(201).json({ ref: SN.signupRef(t.id, (made.sms || made.email).id), needs_code: Boolean(phone), phone_hint: phone ? phoneHint(phone) : null, email_sent: emailSent, minutes: CODE_MINUTES });
});

async function signupOf(t, ref) {
  const tok = SN.readToken('signup', ref);
  if (!tok || tok.tenantId !== t.id || !tok.check()) throw bad('This sign-up link does not work. Start again.');
  const s = await one(pool, 'SELECT * FROM alert_signups WHERE tenant_id = ? AND id = ?', [t.id, tok.id]);
  if (!s || s.status === 'ended') throw bad('This sign-up has ended. Start again.');
  return s;
}
/**
 * The sign-up's phone (channel 'sms') or email is confirmed: it joins the resident with that same phone or email (or a new
 * one with only what was confirmed; lib/residents.js residentForConfirmed, which never changes a resident), turns active,
 * and an older copy of the same address through the same phone or email ends (the new one replaces it). Returns the
 * alert_addresses row of what was confirmed: the manage link belongs to it.
 */
async function activate(conn, t, s, channel) {
  const residentId = s.resident_id || await RES.residentForConfirmed(conn, t.id, channel, { name: s.name, phone: s.phone, email: s.email, streetId: s.street_id, houseNumber: s.house_number, unit: s.unit });
  await conn.query(`UPDATE alert_signups SET resident_id = ?, status = 'active', confirmed_at = COALESCE(confirmed_at, UTC_TIMESTAMP()), ${channel === 'sms' ? 'by_text = 1, code_hash = NULL, code_tries = 0' : 'by_email = 1'}
    WHERE tenant_id = ? AND id = ?`, [residentId, t.id, s.id]);
  const same = channel === 'sms' ? ["by_text = 1 AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', ''), 10) = ?", sms.phoneKey(s.phone)] : ['by_email = 1 AND LOWER(email) = ?', String(s.email).toLowerCase()];
  await conn.query(`UPDATE alert_signups SET status = 'ended', ended_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id <> ? AND status = 'active' AND street_id = ?
    AND COALESCE(house_number, '') = ? AND COALESCE(unit, '') = ? AND ${same[0]} AND (${channel === 'sms' ? 'by_email' : 'by_text'} = 0)`, [t.id, s.id, s.street_id, s.house_number || '', s.unit || '', same[1]]);
  return SN.addressRow(conn, t.id, channel, channel === 'sms' ? s.phone : s.email);
}
const manageUrl = (req, t, a) => SN.manageLink(baseUrl(req), t.slug, t.id, a.id);

publicRouter.post('/:slug/alerts/confirm', validate(z.object({ ref: z.string().max(80), code: z.string().trim().max(12) })), async (req, res) => {
  const t = await town(req);
  const s = await signupOf(t, req.body.ref);
  const code = req.body.code.replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) throw bad('Enter the 6-digit code we texted you.');
  if (!s.code_hash) throw bad(s.by_text ? 'This phone is already confirmed.' : 'That code has expired. Press Send a new code.');
  // Each try is counted before the code is compared, so guesses sent all at once get 5 tries in all.
  const [claim] = await pool.query('UPDATE alert_signups SET code_tries = code_tries + 1 WHERE tenant_id = ? AND id = ? AND code_hash IS NOT NULL AND code_tries < ?', [t.id, s.id, MAX_TRIES]);
  if (!claim.affectedRows) throw new AppError(429, 'Too many wrong codes. Press Send a new code.');
  const now = await one(pool, 'SELECT code_tries, code_expires_at > UTC_TIMESTAMP() AS live FROM alert_signups WHERE tenant_id = ? AND id = ?', [t.id, s.id]);
  if (!Number(now.live)) throw bad('That code has expired. Press Send a new code.');
  const want = Buffer.from(s.code_hash); const got = Buffer.from(codeHash(s.id, code));
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    const left = MAX_TRIES - Number(now.code_tries);
    if (left <= 0) throw new AppError(429, 'Too many wrong codes. Press Send a new code.');
    throw bad(`That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  }
  const a = await tx(async (conn) => {
    const row = await activate(conn, t, s, 'sms');
    await SN.confirmAddress(conn, t.id, 'sms', s.phone, 'code', 'signup_code');
    return row;
  });
  // The welcome text says what was agreed and how to stop (carrier rules for recurring texts).
  const street = await one(pool, 'SELECT name FROM streets WHERE tenant_id = ? AND id = ?', [t.id, s.street_id]);
  await sms.send({ tenantId: t.id, to: s.phone, from: (await settingsOf(t.id)).from_number, tag: 'alert-welcome',
    body: `${t.name}: you will get alerts for ${street ? street.name : 'your street'} by text. How often depends on what happens. Msg and data rates may apply. Reply STOP to stop.` });
  res.json({ ok: true, manage: manageUrl(req, t, a) });
});

publicRouter.post('/:slug/alerts/resend', validate(z.object({ ref: z.string().max(80) })), async (req, res) => {
  const t = await town(req);
  const s = await signupOf(t, req.body.ref);
  if (!s.phone) throw bad('This sign-up has no phone number.');
  if (s.by_text) throw bad('This phone is already confirmed.');
  await claimCode(pool, t.id, s.phone);
  await sendCode(t, s);
  res.json({ ok: true, phone_hint: phoneHint(s.phone), minutes: CODE_MINUTES });
});

publicRouter.post('/:slug/alerts/email', validate(z.object({ token: z.string().max(80) })), async (req, res) => {
  const t = await town(req);
  const tok = SN.readToken('email', req.body.token);
  const s = tok && tok.tenantId === t.id ? await one(pool, 'SELECT * FROM alert_signups WHERE tenant_id = ? AND id = ?', [t.id, tok.id]) : null;
  if (!s || !s.email || !tok.check(String(s.email).toLowerCase()) || s.status === 'ended') throw bad('This link does not work any more. Sign up again on the alerts page.');
  // The link went to this email, so pressing it proves the email only: the manage link it gives is for the email alone.
  const a = await tx(async (conn) => {
    const row = s.by_email ? await SN.addressRow(conn, t.id, 'email', s.email) : await activate(conn, t, s, 'email');
    if (!s.by_email) await SN.confirmAddress(conn, t.id, 'email', s.email, 'link', 'signup_link');
    return row;
  });
  res.json({ ok: true, manage: manageUrl(req, t, a) });
});

/**
 * The manage link: it belongs to one confirmed phone or email (an alert_addresses row), and reaches only the sign-ups
 * confirmed through that same phone or email. Never a sign-up that came in through another phone or email, and never the
 * resident record behind it.
 */
async function managed(req) {
  const t = await town(req);
  const tok = SN.readToken('manage-addr', req.params.token);
  const gone = () => new AppError(404, 'This link does not work. Use the link in your latest alert, or sign up again.');
  if (!tok || tok.tenantId !== t.id || !tok.check()) throw gone();
  const a = await one(pool, 'SELECT * FROM alert_addresses WHERE tenant_id = ? AND id = ?', [t.id, tok.id]);
  if (!a || !a.confirmed_at) throw gone();
  return { t, a };
}
/** SQL that picks the sign-ups confirmed through this address: [where, params]. */
const throughAddress = (a) => (a.channel === 'sms'
  ? ["s.by_text = 1 AND s.phone IS NOT NULL AND RIGHT(REGEXP_REPLACE(s.phone, '[^0-9]', ''), 10) = ?", [a.addr]]
  : ['s.by_email = 1 AND LOWER(s.email) = ?', [a.addr]]);
async function manageView(t, a) {
  const [where, params] = throughAddress(a);
  const list = await rows(pool, `SELECT s.id, st.name AS street, s.house_number, s.unit, s.topics
    FROM alert_signups s JOIN streets st ON st.tenant_id = s.tenant_id AND st.id = s.street_id WHERE s.tenant_id = ? AND s.status = 'active' AND ${where} ORDER BY s.id`, [t.id, ...params]);
  const state = a.stopped_at ? 'stopped' : 'on';
  const hint = a.channel === 'sms' ? phoneHint(a.addr) : emailHint(a.addr);
  return {
    municipality: t.name, channel: a.channel, hint, topics: SN.TOPICS.map(([key, label]) => ({ key, label, always: key === 'water' })),
    signups: list.map((s) => ({ id: s.id, street: s.street, house_number: s.house_number, unit: s.unit, topics: String(s.topics || '').split(',').filter(Boolean),
      texts: a.channel === 'sms' ? state : null, emails: a.channel === 'email' ? state : null, phone_hint: a.channel === 'sms' ? hint : null, email_hint: a.channel === 'email' ? hint : null })),
  };
}
/**
 * The sign-up, reached through this address, as one that has only this phone or email on it: an older sign-up that holds
 * both a confirmed phone and a confirmed email (an import) is split in two first, so a change through one never touches
 * the other. Returns the id, or null when the address does not reach it.
 */
async function ownRow(conn, t, a, signupId) {
  const [where, params] = throughAddress(a);
  const s = await one(conn, `SELECT s.* FROM alert_signups s WHERE s.tenant_id = ? AND s.id = ? AND s.status = 'active' AND ${where} FOR UPDATE`, [t.id, signupId, ...params]);
  if (!s) return null;
  const other = a.channel === 'sms' ? Number(s.by_email) : Number(s.by_text);
  if (!other) return Number(s.id);
  const [r] = await conn.query(`INSERT INTO alert_signups (tenant_id, resident_id, name, street_id, house_number, house_no, unit, phone, email, topics, by_text, by_email, status, source, consent_note, created_by, created_at, confirmed_at)
    SELECT tenant_id, resident_id, name, street_id, house_number, house_no, unit, ${a.channel === 'sms' ? 'phone, NULL, topics, 1, 0' : 'NULL, email, topics, 0, 1'}, status, source, consent_note, created_by, created_at, confirmed_at
    FROM alert_signups WHERE tenant_id = ? AND id = ?`, [t.id, s.id]);
  await conn.query(`UPDATE alert_signups SET ${a.channel === 'sms' ? 'by_text = 0, phone = NULL' : 'by_email = 0, email = NULL'} WHERE tenant_id = ? AND id = ?`, [t.id, s.id]);
  return Number(r.insertId);
}
publicRouter.get('/:slug/alerts/manage/:token', async (req, res) => {
  const { t, a } = await managed(req);
  res.set('Cache-Control', 'no-store').json(await manageView(t, a));
});
const manageBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('topics'), signup_id: z.coerce.number().int().positive(), topics: z.array(z.enum(SN.TOPIC_KEYS)).max(10) }),
  z.object({ action: z.literal('remove'), signup_id: z.coerce.number().int().positive() }),
  z.object({ action: z.literal('stop'), channel: z.enum(['sms', 'email']).optional() }),
]);
publicRouter.post('/:slug/alerts/manage/:token', validate(manageBody), async (req, res) => {
  const { t, a } = await managed(req);
  const b = req.body;
  if (b.action === 'stop') {
    // The link stops only its own phone or email.
    if (b.channel && b.channel !== a.channel) throw bad(a.channel === 'sms' ? 'This link is for texts to one phone. Use the link in an alert email to stop emails.' : 'This link is for emails to one address. Reply STOP to a text to stop texts.');
    await SN.stopAddress(pool, t.id, a.channel, a.addr, 'manage_link');
  } else {
    await tx(async (conn) => {
      const id = await ownRow(conn, t, a, b.signup_id);
      if (!id) throw new AppError(404, 'That address is not on your alerts any more.');
      if (b.action === 'topics') await conn.query('UPDATE alert_signups SET topics = ? WHERE tenant_id = ? AND id = ?', [[...new Set(['water', ...b.topics])].join(','), t.id, id]);
      else await conn.query("UPDATE alert_signups SET status = 'ended', ended_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [t.id, id]);
    });
  }
  res.json(await manageView(t, await one(pool, 'SELECT * FROM alert_addresses WHERE tenant_id = ? AND id = ?', [t.id, a.id])));
});

publicRouter.get('/:slug/alerts/:code', async (req, res) => {
  const t = await town(req);
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new AppError(404, 'Notice not found');
  const n = await one(pool, "SELECT * FROM street_notices WHERE tenant_id = ? AND code = ? AND status IN ('active','ended')", [t.id, code]);
  if (!n) throw new AppError(404, 'Notice not found');
  res.set('Cache-Control', 'no-store').json(await publicNotice(t, n));
});

module.exports = { router, publicRouter, canSend }; // canSend: the + New menu asks the same question (lib/navcounts.js)
