'use strict';

// The scene diagram and witness statements by link. Mounted at /patrol (router) and /public (publicRouter).
//
// Scene diagram: GET/PUT /patrol/incidents/:id/scene. The drawing is kept as JSON (to edit it again) and as SVG, which
// the server draws itself from the cleaned JSON (public/js/scene-draw.js), so nothing a phone sends is shown as markup.
//
// Witness statements: the patroller sends a link (text, email, or shown on the spot); the witness writes what they saw
// in their own words on their own phone, adds their details and signs. It arrives on the case as a witness marked as
// written by them, which staff never edit (a wrong one is marked entered in error with a reason). When the report has
// already been signed off, the statement arrives as an addendum instead, so the frozen report is not changed.
//   GET  /patrol/incidents/:id/witness-links             the links sent on a case and the statements received
//   POST /patrol/incidents/:id/witness-links             send one: { name, phone?, email?, send: text|email|both|show }
//   POST /patrol/witness-links/:lid/resend, /cancel
//   POST /patrol/incidents/:id/witness-statements/:wid/void   entered in error, with a reason
//   GET  /public/witness-link/:token, POST the same       the witness's page (/w/<token>)

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { z, validate, paramId, nowIn } = require('../lib/util');
const { notFound, bad, conflict, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const { requireModule } = require('../lib/modules');
const { baseUrl } = require('../lib/baseurl');
const sms = require('../lib/sms');
const mailer = require('../lib/mailer');
const cases = require('./patrol');

const router = express.Router();
const publicRouter = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (feature, message) => PA.needs(pool, feature, message);

const LINK_HOURS = 72;
const MAX_SIGNATURE = 90000;
const MAX_SCENE_JSON = 60000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const tokenOk = (t) => /^[A-Za-z0-9_-]{32}$/.test(String(t || ''));
const tzOf = async (db, tenantId) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
/** A mountain-clock "YYYY-MM-DD HH:MM:SS" moved by some hours. */
const plusHours = (s, hours) => new Date(new Date(`${String(s).replace(' ', 'T')}Z`).getTime() + hours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
const drawing = () => import(path.join(__dirname, '..', '..', 'public', 'js', 'scene-draw.js'));

/** When and where, in plain words, for the witness's page and the messages. Never the patient. */
function whenText(occurredAt) {
  const d = new Date(`${String(occurredAt).replace(' ', 'T')}Z`);
  return d.toLocaleString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const placeOf = (inc) => [inc.trail, inc.lift ? `${inc.lift}` : null].filter(Boolean).join(', ') || inc.location || '';

async function incidentOf(db, tenantId, id) {
  const inc = await one(db, 'SELECT i.id, i.report_state, i.legal_hold, i.occurred_at, i.location, t.name AS trail, l.name AS lift FROM incidents i LEFT JOIN trails t ON t.id = i.trail_id AND t.tenant_id = i.tenant_id LEFT JOIN lifts l ON l.id = i.lift_id AND l.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND i.id = ?', [tenantId, id]);
  if (!inc) throw notFound('Incident');
  return inc;
}

// ---------------------------------------------------------------- the scene diagram
router.get('/incidents/:id/scene', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req);
  await incidentOf(pool, req.auth.tenantId, id);
  const s = await one(pool, `SELECT s.data, s.svg, s.updated_at, COALESCE(u.email, u.username) AS updated_by FROM patrol_scenes s LEFT JOIN users u ON u.id = s.updated_by AND u.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND s.incident_id = ?`, [req.auth.tenantId, id]);
  if (!s) { res.json({ data: null, svg: null }); return; }
  let data = null; try { data = JSON.parse(s.data); } catch (_) { data = null; }
  res.json({ data, svg: s.svg, updated_at: s.updated_at, updated_by: s.updated_by });
});

router.put('/incidents/:id/scene', patrol, needs('create_case'), express.json({ limit: '200kb' }), validate(z.object({ data: z.any() })), async (req, res) => {
  const id = paramId(req);
  const { clean, sceneSvg } = await drawing();
  let data;
  try { data = clean(req.body.data); } catch (err) { throw bad(err.message); }
  const json = JSON.stringify(data);
  if (json.length > MAX_SCENE_JSON) throw bad('That drawing is too large to save. Remove some items.');
  const out = await tx(async (conn) => {
    const inc = await cases.editableCase(conn, req, id);
    if (Number(inc.legal_hold)) throw conflict('This case is on legal hold: the scene diagram cannot change. Add a note instead.');
    const full = await incidentOf(conn, req.auth.tenantId, id);
    const svg = sceneSvg(data, { trail: placeOf(full), when: whenText(full.occurred_at) });
    const now = nowIn(await tzOf(conn, req.auth.tenantId));
    await conn.query(`INSERT INTO patrol_scenes (tenant_id, incident_id, data, svg, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE data = VALUES(data), svg = VALUES(svg), updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`, [req.auth.tenantId, id, json, svg, req.auth.userId, now]);
    await audit(conn, req, 'scene_diagram', 'incidents', id, { items: data.items.length, sha256: sha(json) });
    return { svg, updated_at: now };
  });
  res.json({ ok: true, data, ...out });
});

// ---------------------------------------------------------------- witness links (patrol)
const statusOf = (l, now) => (l.status === 'received' || l.status === 'canceled' ? l.status : String(l.expires_at) < now ? 'expired' : l.status);

router.get('/incidents/:id/witness-links', patrol, needs('view_cases'), async (req, res) => {
  const id = paramId(req);
  await incidentOf(pool, req.auth.tenantId, id);
  const now = nowIn(await tzOf(pool, req.auth.tenantId));
  const links = await rows(pool, `SELECT l.id, l.name, l.phone, l.email, l.status, l.sent_by, l.send_note, l.expires_at, l.opened_at, l.received_at, l.witness_id, l.note_id, l.created_at, COALESCE(u.email, u.username) AS created_by_name
    FROM patrol_witness_links l LEFT JOIN users u ON u.id = l.created_by AND u.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND l.incident_id = ? ORDER BY l.id DESC`, [req.auth.tenantId, id]);
  const statements = await rows(pool, `SELECT w.id, w.name, w.statement, w.received_at, w.voided_at, w.void_reason, (w.statement_signature IS NOT NULL) AS signed FROM incident_witnesses w WHERE w.tenant_id = ? AND w.incident_id = ? AND w.source = 'link' ORDER BY w.id`, [req.auth.tenantId, id]);
  res.json({
    links: links.map((l) => ({ ...l, status: statusOf(l, now) })),
    statements: statements.map((s) => ({ ...s, signed: Boolean(Number(s.signed)) })),
    texting: sms.enabled(), email: mailer.enabled(), hours: LINK_HOURS,
  });
});

/** Sends the link by text and/or email. Returns what happened, in words the patroller can act on. */
async function deliver(req, tenantId, l, link, send) {
  const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [tenantId]);
  const out = [];
  const body = `${t.name}: thank you for helping. Please write what you saw in your own words, here: ${link} (works for ${LINK_HOURS} hours)`;
  if ((send === 'text' || send === 'both') && l.phone) {
    const r = await sms.send({ tenantId, to: l.phone, body });
    out.push(r.ok ? 'Texted' : `Text not sent: ${r.error}`);
  }
  if ((send === 'email' || send === 'both') && l.email) {
    const r = await mailer.send({ tenantId, to: l.email, fromName: t.name, subject: `${t.name}: your statement as a witness`, tag: 'witness-link',
      text: [`Hi ${l.name.split(' ')[0]},`, '', `Thank you for staying to help on the mountain. Please write what you saw in your own words. It takes a few minutes, and you can do it on your phone:`, '', link, '', `The link works for ${LINK_HOURS} hours and only once.`, '', t.name].join('\n') });
    out.push(r.ok ? 'Emailed' : `Email not sent: ${r.error}`);
  }
  return out.join('. ');
}

const linkFields = z.object({
  name: z.string().trim().min(1).max(150),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email().max(255).optional(),
  send: z.enum(['text', 'email', 'both', 'show']).default('show'),
}).refine((v) => v.phone || v.email, 'Give the witness\'s cell phone or email address, so the mountain can reach them')
  .refine((v) => v.send === 'show' || (v.send !== 'email' && v.phone) || (v.send !== 'text' && v.email), 'Give a cell phone to text, or an email address to email');

router.post('/incidents/:id/witness-links', patrol, needs('create_case'), validate(linkFields), async (req, res) => {
  const id = paramId(req);
  const tenantId = req.auth.tenantId;
  await incidentOf(pool, tenantId, id);
  const b = req.body;
  if (b.phone && (b.send === 'text' || b.send === 'both') && !sms.e164(b.phone)) throw bad('That cell phone number does not look right');
  const token = newToken();
  const now = nowIn(await tzOf(pool, tenantId));
  const [r] = await pool.query('INSERT INTO patrol_witness_links (tenant_id, incident_id, token_hash, name, phone, email, sent_by, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, id, sha(token), b.name, b.phone || null, b.email || null, b.send, plusHours(now, LINK_HOURS), req.auth.userId, now]);
  const link = `${baseUrl(req)}/w/${token}`;
  const l = { name: b.name, phone: b.phone, email: b.email };
  const note = b.send === 'show' ? 'Shown on the spot' : await deliver(req, tenantId, l, link, b.send);
  await pool.query('UPDATE patrol_witness_links SET send_note = ? WHERE id = ?', [note.slice(0, 255), r.insertId]);
  await audit(pool, req, 'witness_link', 'incidents', id, { link: r.insertId, send: b.send }); // never the token
  res.status(201).json({ id: r.insertId, link, note, expires_at: plusHours(now, LINK_HOURS) });
});

async function linkFor(req) {
  const l = await one(pool, 'SELECT * FROM patrol_witness_links WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req, 'lid')]);
  if (!l) throw notFound('Link');
  return l;
}

// A new link (the old one stops working), sent again or shown on the spot. The 72 hours start again.
router.post('/witness-links/:lid/resend', patrol, needs('create_case'), validate(z.object({ send: z.enum(['text', 'email', 'both', 'show']).default('show') })), async (req, res) => {
  const l = await linkFor(req);
  if (l.status === 'received') throw conflict('This witness has already sent their statement');
  if (l.status === 'canceled') throw conflict('This link was canceled. Send a new one.');
  const send = req.body.send;
  if ((send === 'text' && !l.phone) || (send === 'email' && !l.email) || (send === 'both' && !(l.phone && l.email))) throw bad(send === 'text' ? 'There is no cell phone for this witness' : 'There is no email address for this witness');
  const token = newToken();
  const now = nowIn(await tzOf(pool, req.auth.tenantId));
  const link = `${baseUrl(req)}/w/${token}`;
  const note = send === 'show' ? 'Shown on the spot' : await deliver(req, req.auth.tenantId, l, link, send);
  await pool.query("UPDATE patrol_witness_links SET token_hash = ?, status = 'sent', sent_by = ?, send_note = ?, expires_at = ?, opened_at = NULL WHERE id = ?", [sha(token), send, note.slice(0, 255), plusHours(now, LINK_HOURS), l.id]);
  await audit(pool, req, 'witness_link_resend', 'incidents', l.incident_id, { link: l.id, send });
  res.json({ id: l.id, link, note });
});

router.post('/witness-links/:lid/cancel', patrol, needs('create_case'), async (req, res) => {
  const l = await linkFor(req);
  if (l.status === 'received') throw conflict('This witness has already sent their statement');
  await pool.query("UPDATE patrol_witness_links SET status = 'canceled' WHERE id = ?", [l.id]);
  await audit(pool, req, 'witness_link_cancel', 'incidents', l.incident_id, { link: l.id });
  res.json({ ok: true });
});

// A statement written by the witness is never edited or removed by staff: a wrong one is marked entered in error.
router.post('/incidents/:id/witness-statements/:wid/void', patrol, needs('create_case'), validate(z.object({ reason: z.string().trim().min(3).max(255) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const inc = await cases.editableCase(conn, req, id);
    if (Number(inc.legal_hold)) throw conflict('This case is on legal hold: nothing on it can be marked entered in error. Add a note instead.');
    const w = await one(conn, "SELECT id, voided_at FROM incident_witnesses WHERE tenant_id = ? AND incident_id = ? AND id = ? AND source = 'link'", [req.auth.tenantId, id, paramId(req, 'wid')]);
    if (!w) throw notFound('Statement');
    if (w.voided_at) throw conflict('Already marked entered in error');
    await conn.query('UPDATE incident_witnesses SET voided_at = ?, void_reason = ?, voided_by = ? WHERE id = ?', [nowIn(await tzOf(conn, req.auth.tenantId)), req.body.reason, req.auth.userId, w.id]);
    await audit(conn, req, 'void_witness_statement', 'incidents', id, { row: w.id, reason: req.body.reason });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the witness's page (/w/<token>)
async function publicLink(conn, token, { lock = false } = {}) {
  if (!tokenOk(token)) throw notFound('Link');
  const l = await one(conn, `SELECT * FROM patrol_witness_links WHERE token_hash = ?${lock ? ' FOR UPDATE' : ''}`, [sha(token)]);
  if (!l) throw notFound('Link');
  try { await requireModule(l.tenant_id, 'patrol'); } catch (_) { throw notFound('Link'); }
  const tenant = await one(conn, 'SELECT name, timezone FROM tenants WHERE id = ?', [l.tenant_id]);
  const now = nowIn(tenant.timezone);
  const status = statusOf(l, now);
  return { l, tenant, now, status };
}
const closed = (status) => (status === 'received' ? new AppError(410, 'Thank you: your statement has already been sent.')
  : status === 'canceled' ? new AppError(410, 'This link is no longer in use. If you still want to give a statement, please contact the ski patrol.')
    : new AppError(410, 'This link has expired. If you still want to give a statement, please contact the ski patrol.'));

publicRouter.get('/witness-link/:token', async (req, res) => {
  const { l, tenant, now, status } = await publicLink(pool, req.params.token);
  if (!['sent', 'opened'].includes(status)) throw closed(status);
  const inc = await incidentOf(pool, l.tenant_id, l.incident_id);
  if (l.status === 'sent') await pool.query("UPDATE patrol_witness_links SET status = 'opened', opened_at = ? WHERE id = ? AND status = 'sent'", [now, l.id]);
  res.json({ mountain: tenant.name, when: whenText(inc.occurred_at), where: placeOf(inc), name: l.name, phone: l.phone, email: l.email });
});

const statementSchema = z.object({
  name: z.string().trim().min(2, 'Give your full name').max(150),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().email('That email address does not look right').max(255).optional().or(z.literal('').transform(() => undefined)),
  address: z.string().trim().max(255).optional(),
  city: z.string().trim().max(100).optional(),
  region: z.string().trim().max(60).optional(),
  postal: z.string().trim().max(20).optional(),
  statement: z.string().trim().min(10, 'Write what you saw, in a few sentences at least').max(10000),
  signature: z.string().max(MAX_SIGNATURE).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Sign in the box'),
  confirm: z.literal(true, { message: 'Confirm that this is true to the best of your knowledge' }),
}).refine((v) => v.phone || v.email, 'Give a phone number or an email address, so the mountain can reach you if needed');

publicRouter.post('/witness-link/:token', rateLimit({ windowMs: 10 * 60_000, max: Number(process.env.HELP_RATE_LIMIT) || 10, message: 'Too many tries from here. Please contact the ski patrol.' }), express.json({ limit: '150kb' }), validate(statementSchema), async (req, res) => {
  const b = req.body;
  const out = await tx(async (conn) => {
    const { l, tenant, now, status } = await publicLink(conn, req.params.token, { lock: true });
    if (!['sent', 'opened'].includes(status)) throw closed(status);
    const inc = await one(conn, 'SELECT id, report_state FROM incidents WHERE tenant_id = ? AND id = ? FOR UPDATE', [l.tenant_id, l.incident_id]);
    const ip = String(req.ip || '').slice(0, 45);
    let witnessId = null; let noteId = null;
    const contact = [b.phone, b.email, [b.address, b.city, b.region, b.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (inc.report_state === 'draft') {
      const [w] = await conn.query(`INSERT INTO incident_witnesses (tenant_id, incident_id, relation, name, phone, email, address, city, region, postal, statement, source, statement_signature, received_at, received_ip)
        VALUES (?, ?, 'witnessed_by', ?, ?, ?, ?, ?, ?, ?, ?, 'link', ?, ?, ?)`,
      [l.tenant_id, l.incident_id, b.name, b.phone || null, b.email || null, b.address || null, b.city || null, b.region || null, b.postal || null, b.statement, b.signature, now, ip]);
      witnessId = w.insertId;
      const [n] = await conn.query('INSERT INTO incident_notes (tenant_id, incident_id, author_user, body, created_at) VALUES (?, ?, ?, ?, ?)',
        [l.tenant_id, l.incident_id, l.created_by, `Witness statement received from ${b.name}, written and signed by them on their own phone (link sent to ${l.name}).`, now]);
      noteId = n.insertId;
    } else {
      // The report has been signed off: the statement goes in as an addendum, and the frozen report stays as it was.
      const [n] = await conn.query('INSERT INTO incident_notes (tenant_id, incident_id, author_user, body, created_at) VALUES (?, ?, ?, ?, ?)',
        [l.tenant_id, l.incident_id, l.created_by, `Addendum: witness statement received after the report was signed off, from ${b.name}, written and signed by them on their own phone.\nContact: ${contact}\n\nIn their own words:\n${b.statement}`, now]);
      noteId = n.insertId;
    }
    await conn.query("UPDATE patrol_witness_links SET status = 'received', received_at = ?, witness_id = ?, note_id = ?, statement = ?, signature = ?, received_ip = ? WHERE id = ?", [now, witnessId, noteId, b.statement, b.signature, ip, l.id]);
    await audit(conn, { auth: { tenantId: l.tenant_id, userId: null }, ip: req.ip }, 'witness_statement_received', 'incidents', l.incident_id, { link: l.id, witness: witnessId, note: noteId, addendum: !witnessId });
    return { mountain: tenant.name };
  });
  res.status(201).json({ ok: true, mountain: out.mountain });
});

module.exports = { router, publicRouter, plusHours, whenText };
