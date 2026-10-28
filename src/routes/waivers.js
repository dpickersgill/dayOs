'use strict';

// Waivers: the public signing page (/waiver/<mountain>), signing on the counter screen, the list of everything signed, the
// signed copy exactly as it was signed, voiding a mistake, changing the wording (optionally asking everyone to sign again),
// emailing a guest a link to sign, and a spreadsheet of it all.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { stepUp } = require('../lib/stepup');
const { z, validate, paramId, todayIn, seasonFor, dateStr, dayRange } = require('../lib/util');
const { notFound, bad, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { toCsv } = require('../lib/csv');
const mailer = require('../lib/mailer');
const { esc } = require('../lib/format');
const W = require('../lib/waivers');

const router = express.Router();
const publicRouter = express.Router();

// Patrol is left out on purpose: the register holds contact details, and patrol look people up through /people/lookup.
const readers = requireRole('manager', 'counter', 'instructor');
const signers = requireRole('manager', 'counter', 'instructor');
const managers = requireRole('manager');

const METHOD = { signed_online: 'Signed online', signed_counter: 'Signed at the counter', accepted_online: 'Accepted online', recorded_by_staff: 'Recorded by staff' };
// Rows from before methods were kept: a fingerprint means the guest accepted the wording on a screen; without one, staff recorded it.
const methodOf = (r) => METHOD[r.method] || (r.text_sha ? 'Accepted online' : 'Recorded by staff');

const person = z.object({
  first_name: z.string().trim().max(100),
  last_name: z.string().trim().max(100),
  date_of_birth: dateStr,
  email: z.string().trim().max(255).email('Please check the email address').optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
});
const season = z.string().regex(/^\d{4}-\d{2}$/).optional();
// The public page never names an existing record; only the counter (staff, with the record open) may.
const signBody = z.object({
  sha: z.string().length(64),
  season,
  signer: person,
  self: z.boolean().default(true),
  children: z.array(person.omit({ email: true, phone: true })).max(10).default([]),
  typed_name: z.string().trim().min(1, 'Type your full name to sign').max(200),
  signature: z.string().max(W.MAX_SIGNATURE_CHARS + 100),
  agree: z.literal(true, { message: 'Please tick the box to say you have read and agree to the waiver' }),
});
const withId = { person_id: z.number().int().positive().optional() };
const counterBody = signBody.extend({
  signer: person.extend(withId),
  children: z.array(person.omit({ email: true, phone: true }).extend(withId)).max(10).default([]),
});

// ---------------------------------------------------------------- public: the signing page
async function publicTenant(slug) {
  const t = await one(pool, 'SELECT id, slug, name, phone, timezone, status, waiver_text, season_ends_on FROM tenants WHERE slug = ?', [slug]);
  if (!t || t.status !== 'active') throw new AppError(404, 'Page not found');
  return t;
}

publicRouter.get('/:slug/waiver', async (req, res) => {
  const t = await publicTenant(req.params.slug);
  const today = todayIn(t.timezone);
  res.json({ mountain: t.name, phone: t.phone, season: seasonFor(today), today, open: Boolean(t.waiver_text), text: t.waiver_text || null, sha: t.waiver_text ? W.shaOf(t.waiver_text) : null });
});

publicRouter.post('/:slug/waiver/sign', validate(signBody), async (req, res) => {
  const t = await publicTenant(req.params.slug);
  const out = await tx((conn) => W.sign(conn, t, req.body, { source: 'online', ip: req.ip, userAgent: req.get('user-agent') }));
  const mail = await W.emailCopy(pool, t, out, baseUrl(req));
  res.status(201).json({ token: out.token, season: out.season, covered: out.covered.map((c) => c.name), emailed: mail.ok });
});

publicRouter.get('/:slug/waiver/copy/:token', async (req, res) => {
  const t = await publicTenant(req.params.slug);
  if (!/^[a-f0-9]{32}$/.test(req.params.token)) throw notFound('Signed waiver');
  const d = await W.signingDetail(pool, t.id, ...W.byToken(req.params.token));
  if (!d) throw notFound('Signed waiver');
  const s = d.signing;
  // The link stops working once the season it was signed for is over. Staff still see the copy from Waivers in the app.
  if (todayIn(t.timezone) > W.copyLinkEnds(t, s)) throw new AppError(410, 'This link has expired. The season it was signed for has ended; ask the mountain for a copy.');
  // Names as the signer typed them (never what is on file for those records), in the order they were signed for.
  let typed = []; try { typed = JSON.parse(s.covered_names || '[]'); } catch (_) { typed = []; }
  res.json({
    mountain: t.name, season: s.season, signed_at: s.created_at, signer: s.signer_name, typed_name: s.typed_name, signature: s.signature, text: d.text,
    covered: d.covered.map((c, i) => ({ name: (typed[i] && typed[i].name) || s.signer_name, relation: c.signer_relation, voided: Boolean(c.voided_at) })),
  });
});

// ---------------------------------------------------------------- staff
router.get('/summary', readers, async (req, res) => {
  const t = await one(pool, 'SELECT slug, timezone, waiver_text, waiver_resign_at FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const today = todayIn(t.timezone);
  const season = seasonFor(today);
  const [from, to] = dayRange(t.timezone, today); // signed_at is database time (UTC); "today" is the mountain's day
  const counts = await one(pool, `SELECT COUNT(DISTINCT w.person_id) AS people, COUNT(DISTINCT w.signing_id) AS signings,
      COUNT(DISTINCT CASE WHEN w.signed_at >= ? AND w.signed_at < ? THEN w.person_id END) AS today
    FROM waivers w WHERE w.tenant_id = ? AND w.season = ? AND ${W.VALID('w')}`, [from, to, req.auth.tenantId, season]);
  const versions = await rows(pool, `SELECT x.sha, x.created_at, LEFT(x.body, 140) AS opening, (x.sha = SHA2(?, 256)) AS current,
      (SELECT COUNT(*) FROM waivers w WHERE w.tenant_id = x.tenant_id AND w.text_sha = x.sha) AS signed
    FROM waiver_texts x WHERE x.tenant_id = ? ORDER BY x.created_at DESC, x.id DESC LIMIT 20`, [t.waiver_text || '', req.auth.tenantId]);
  res.json({
    season, next_season: W.nextSeason(season), text: t.waiver_text || null, sha: t.waiver_text ? W.shaOf(t.waiver_text) : null, resign_at: t.waiver_resign_at,
    people: Number(counts.people), signings: Number(counts.signings), today: Number(counts.today),
    link: `${baseUrl(req)}/waiver/${t.slug}`, email_ready: mailer.enabled(),
    versions: versions.map((v) => ({ ...v, current: Boolean(v.current), signed: Number(v.signed) })),
  });
});

router.get('/', readers, async (req, res) => {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const season = String(req.query.season || seasonFor(todayIn(t.timezone))).slice(0, 20);
  const q = String(req.query.q || '').trim().slice(0, 100);
  const page = Math.max(0, Number(req.query.page) || 0);
  const where = ['w.tenant_id = ?', 'w.season = ?']; const params = [req.auth.tenantId, season];
  if (q) {
    where.push("(CONCAT(p.first_name, ' ', p.last_name) LIKE ? OR p.email LIKE ? OR w.signed_by_name LIKE ?)");
    params.push(`%${q}%`, `${q}%`, `%${q}%`);
  }
  const data = await rows(pool, `SELECT w.id, w.person_id, w.season, w.signed_at, w.signed_by_name, w.signer_relation, w.method, w.text_sha, w.signing_id, w.voided_at,
      p.first_name, p.last_name, p.date_of_birth, (${W.VALID('w')}) AS counts
    FROM waivers w LEFT JOIN people p ON p.tenant_id = w.tenant_id AND p.id = w.person_id
    WHERE ${where.join(' AND ')} ORDER BY w.signed_at DESC, w.id DESC LIMIT 51 OFFSET ?`, [...params, page * 50]);
  res.json({ season, more: data.length > 50, data: data.slice(0, 50).map((r) => ({ ...r, counts: Boolean(r.counts), method_label: methodOf(r), has_signature: Boolean(r.signing_id) })) });
});

router.get('/export.csv', managers, stepUp('download signed waivers'), async (req, res) => {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const season = String(req.query.season || seasonFor(todayIn(t.timezone))).slice(0, 20);
  const data = await rows(pool, `SELECT w.id, w.season, w.signed_at, p.first_name, p.last_name, p.date_of_birth, w.signed_by_name AS signed_by, w.signer_relation AS relation,
      w.method, w.text_sha, s.signer_email, s.typed_name, s.ip, w.voided_at, w.void_reason, (${W.VALID('w')}) AS counts
    FROM waivers w LEFT JOIN people p ON p.tenant_id = w.tenant_id AND p.id = w.person_id LEFT JOIN waiver_signings s ON s.tenant_id = w.tenant_id AND s.id = w.signing_id
    WHERE w.tenant_id = ? AND w.season = ? ORDER BY w.signed_at`, [req.auth.tenantId, season]);
  const out = data.map((r) => ({ ...r, method: methodOf(r), counts: r.counts ? 'yes' : 'no', date_of_birth: r.date_of_birth ? String(r.date_of_birth).slice(0, 10) : '' }));
  await audit(pool, req, 'export', 'waivers', null, { season, rows: out.length });
  const cols = ['id', 'season', 'signed_at', 'first_name', 'last_name', 'date_of_birth', 'signed_by', 'relation', 'method', 'signer_email', 'typed_name', 'ip', 'text_sha', 'counts', 'voided_at', 'void_reason'];
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="waivers-${season}.csv"`).send(toCsv(cols, out));
});

router.get('/:id', readers, async (req, res) => {
  const w = await one(pool, `SELECT w.*, p.first_name, p.last_name, p.date_of_birth, (${W.VALID('w')}) AS counts FROM waivers w LEFT JOIN people p ON p.tenant_id = w.tenant_id AND p.id = w.person_id WHERE w.tenant_id = ? AND w.id = ?`, [req.auth.tenantId, paramId(req)]);
  if (!w) throw notFound('Waiver');
  const text = w.text_sha ? await one(pool, 'SELECT body FROM waiver_texts WHERE tenant_id = ? AND sha = ?', [req.auth.tenantId, w.text_sha]) : null;
  let signing = null; let covered = [];
  if (w.signing_id) {
    const d = await W.signingDetail(pool, req.auth.tenantId, 'id = ?', [w.signing_id]);
    if (d) {
      const s = d.signing;
      signing = { id: s.id, source: s.source, signer: s.signer_name, email: s.signer_email, phone: s.signer_phone, typed_name: s.typed_name, signature: s.signature, ip: s.ip, user_agent: s.user_agent, created_at: s.created_at, emailed_at: s.emailed_at };
      covered = d.covered.map((c) => ({ id: c.id, name: c.name, relation: c.signer_relation, voided: Boolean(c.voided_at) }));
    }
  }
  await audit(pool, req, 'view', 'waivers', w.id, null);
  res.json({ ...w, counts: Boolean(w.counts), method_label: methodOf(w), text: text ? text.body : null, signing, covered });
});

router.post('/:id/void', managers, validate(z.object({ reason: z.string().trim().min(3, 'Say why it is being voided').max(300) })), async (req, res) => {
  const [r] = await pool.query('UPDATE waivers SET voided_at = NOW(), void_reason = ?, voided_by = ? WHERE tenant_id = ? AND id = ? AND voided_at IS NULL', [req.body.reason, req.auth.userId, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Waiver');
  await audit(pool, req, 'void', 'waivers', paramId(req), { reason: req.body.reason });
  res.json({ ok: true });
});

/** Signing on the counter screen: the guest signs on the staff device, with a member of staff there. */
router.post('/sign', signers, validate(counterBody), async (req, res) => {
  const t = await one(pool, 'SELECT id, slug, name, timezone, waiver_text FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const out = await tx((conn) => W.sign(conn, t, req.body, { source: 'counter', ip: req.ip, userAgent: req.get('user-agent'), userId: req.auth.userId }));
  await audit(pool, req, 'sign', 'waiver_signings', out.id, { people: out.covered.map((c) => c.id) });
  const mail = await W.emailCopy(pool, t, out, baseUrl(req));
  res.status(201).json({ id: out.id, season: out.season, covered: out.covered, emailed: mail.ok });
});

/** Email a guest the link to sign. */
router.post('/send-link', signers, validate(z.object({ person_id: z.number().int().positive(), email: z.string().trim().email().max(255).optional() })), async (req, res) => {
  const t = await one(pool, 'SELECT id, slug, name, waiver_text FROM tenants WHERE id = ?', [req.auth.tenantId]);
  if (!t.waiver_text) throw bad('Add your waiver wording first (Waivers, Wording)');
  const p = await one(pool, 'SELECT id, first_name, email FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, req.body.person_id]);
  if (!p) throw notFound('Customer');
  const to = req.body.email || p.email;
  if (!to) throw bad('There is no email address on file. Type one in, or have them sign on this screen.');
  if (!mailer.enabled()) throw bad('Email is not set up yet, so the link cannot be sent. Have them sign on this screen instead.');
  const link = `${baseUrl(req)}/waiver/${t.slug}`;
  const r = await mailer.send({ tenantId: t.id, to, fromName: t.name, subject: `Please sign the ${t.name} waiver`, tag: 'waiver-link',
    text: `Hi ${p.first_name || 'there'},\n\nPlease read and sign the ${t.name} waiver before you ski or ride. It takes about two minutes on a phone, and a parent or guardian can sign for children at the same time.\n\n${link}\n`,
    html: `<p>Hi ${esc(p.first_name || 'there')},</p><p>Please read and sign the ${esc(t.name)} waiver before you ski or ride. It takes about two minutes on a phone, and a parent or guardian can sign for children at the same time.</p><p><a href="${link}">Read and sign the waiver</a></p>` });
  if (!r.ok) throw bad(`The email could not be sent: ${r.error}`);
  await audit(pool, req, 'send_link', 'waivers', null, { person_id: p.id });
  res.json({ sent: true, to });
});

/** Change the wording. Every version is kept; ask_again means waivers signed before now no longer count. */
router.put('/text', managers, validate(z.object({ text: z.string().trim().max(20000).nullable(), ask_again: z.boolean().default(false) })), async (req, res) => {
  const text = req.body.text || null;
  await tx(async (conn) => {
    await conn.query(`UPDATE tenants SET waiver_text = ?${req.body.ask_again ? ', waiver_resign_at = NOW(), waiver_resign_id = (SELECT COALESCE(MAX(id), 0) FROM waivers)' : ''} WHERE id = ?`, [text, req.auth.tenantId]);
    await W.archive(conn, req.auth.tenantId, text, req.auth.userId);
  });
  await audit(pool, req, 'update', 'waiver_text', null, { sha: text ? W.shaOf(text) : null, ask_again: req.body.ask_again });
  res.json({ sha: text ? W.shaOf(text) : null, ask_again: req.body.ask_again });
});

router.get('/texts/:sha', readers, async (req, res) => {
  const x = await one(pool, 'SELECT sha, body, created_at FROM waiver_texts WHERE tenant_id = ? AND sha = ?', [req.auth.tenantId, String(req.params.sha).slice(0, 64)]);
  if (!x) throw notFound('Wording');
  res.json(x);
});

module.exports = { router, publicRouter };
