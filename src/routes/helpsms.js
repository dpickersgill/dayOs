'use strict';

// Text HELP (help/sms): guests text the mountain's help number to reach patrol (the conversation is lib/helpline.js).
//
// publicRouter, at /api/v1/public:
//   POST /sms/inbound   Twilio's "A message comes in" webhook for every mountain's help number (form-encoded). Every
//                       request must carry Twilio's signature (X-Twilio-Signature, made with TWILIO_AUTH_TOKEN over
//                       PUBLIC_URL plus this path and the posted fields); anything else gets 403. A text to a number no
//                       mountain uses, or to a mountain that is not active,
//                       is not taken; the answer says "If this is an emergency, call 911." The answer is TwiML: the reply, or nothing.
//                       A text to the shared Verdynt/OS help number goes to lib/sharedhelp.js, which finds the mountain.
//   GET/POST /help-locate/:token   the shared locate page's link (a text to the shared number that did not say which ski
//                       area): the position goes to the nearest mountain within 50 km. Keyed by the link's token only.
// router, at /api/v1/patrol (patrol and managers):
//   GET/PUT /text-help                   Text HELP in Patrol settings: the shared number or the mountain's own, the own
//                                        help number, the patrol phone, and the mountain's tag (the tag: owners only)
//   GET /dispatch/:id/sms                the call's text conversation facts: phone, language, STOP, texts used, photos
//   GET /dispatch/:id/sms-photo/:n       a photo the guest texted, fetched from Twilio for the signed-in viewer and
//                                        never stored
// The /dispatch/:id addresses sit behind dispatch.js's patient-record guard (it is mounted first, on the same /patrol).
const crypto = require('crypto');
const express = require('express');
const { pool, one } = require('../db');
const config = require('../config');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { logFailure } = require('../lib/jobs');
const HL = require('../lib/helpline');
const PA = require('../lib/patrolaccess');
const PX = require('../lib/patientaccess');

const PATH = '/api/v1/public/sms/inbound';

// ---------------------------------------------------------------- Twilio's signature
/**
 * Twilio's documented algorithm: the full address Twilio posted to, then each posted field name followed by its value,
 * with the names sorted (a name sent more than once: each value, sorted), HMAC-SHA1 with the auth token, base64.
 */
function signature(token, url, params) {
  let data = url;
  for (const k of Object.keys(params || {}).sort()) {
    const v = params[k];
    for (const one1 of (Array.isArray(v) ? [...v].map(String).sort() : [String(v)])) data += k + one1;
  }
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

/**
 * The addresses Twilio may have signed. Behind Cloud Run and the load balancer the request arrives on another host and
 * protocol, so the address is PUBLIC_URL plus the path as posted (query string and all), never the Host header. Only a
 * local run without PUBLIC_URL falls back to the address the request came in on (the protocol from the trusted proxy).
 * Like Twilio's own libraries, the same address with the default port written in (or taken out) is accepted too.
 */
function signedUrls(req) {
  const base = config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`;
  const url = `${base}${req.originalUrl}`;
  const m = url.match(/^(https?):\/\/([^/:]+)(:\d+)?(.*)$/);
  if (!m) return [url];
  const port = m[1] === 'https' ? ':443' : ':80';
  return m[3] ? [url, `${m[1]}://${m[2]}${m[4]}`] : [url, `${m[1]}://${m[2]}${port}${m[4]}`];
}
function signedByTwilio(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const given = String(req.get('x-twilio-signature') || '');
  if (!token || !given) return false;
  return signedUrls(req).some((u) => {
    const want = signature(token, u, req.body || {});
    return given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const twiml = (res, text) => res.type('text/xml').set('Cache-Control', 'no-store')
  .send(`<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${esc(text)}</Message>` : ''}</Response>`);

const SH = require('../lib/sharedhelp');

const NO_LINE = (body) => (HL.isSpanish(body) || /^\s*ayuda\b/i.test(body) ? 'Si es una emergencia, llame al 911. If this is an emergency, call 911.' : 'If this is an emergency, call 911.');
const publicRouter = express.Router();
publicRouter.post('/sms/inbound', express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 200 }), async (req, res) => {
  if (!process.env.TWILIO_AUTH_TOKEN) return res.status(404).type('text/plain').send('Text messages are not set up');
  if (!signedByTwilio(req)) return res.status(403).type('text/plain').send('Not signed by Twilio');
  const b = req.body || {};
  const to = HL.normalNumber(Array.isArray(b.To) ? b.To[0] : b.To);
  if (to && await HL.isShared(to)) {
    // The shared number: lib/sharedhelp.js finds the mountain (a tag, an open call, a position, or it asks).
    const params = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    try {
      const out = await SH.inbound(params, config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`);
      return twiml(res, out.reply);
    } catch (err) {
      logFailure({ job: 'help_shared', message: err.message });
      return res.status(500).type('text/plain').send('Try again');
    }
  }
  // A text to a number no mountain uses, or to a mountain that is not active, is not taken as a call (no one would see
  // it), but the sender is always told where to turn.
  const line = await HL.lineByNumber(Array.isArray(b.To) ? b.To[0] : b.To);
  const body = String(Array.isArray(b.Body) ? b.Body[0] : b.Body || '');
  if (!line) return twiml(res, NO_LINE(body));
  if (line.status !== 'active') { logFailure({ job: 'help_sms', tenant: line.tenant_id, message: 'text to the help line of a mountain that is not active' }); return twiml(res, NO_LINE(body)); }
  const params = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  try {
    const out = await HL.inbound(line, params, config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`);
    return twiml(res, out.reply);
  } catch (err) {
    // Twilio then tries the fallback address, if one is set (RUNBOOK.md, Text HELP set-up). A repeat is taken once.
    logFailure({ job: 'help_sms', tenant: line.tenant_id, message: err.message });
    return res.status(500).type('text/plain').send('Try again');
  }
});

// The shared locate page (/help-locate/<token>): a guest whose text did not say which ski area sends their position.
const locateBody = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).optional() });
publicRouter.get('/help-locate/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = await SH.locateState(String(req.params.token).replace(/(\.|%2E)+$/i, ''));
  if (!s || s.state === 'expired') throw notFound('This link has expired');
  res.json(s);
});
publicRouter.post('/help-locate/:token', validate(locateBody), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const acc = req.body.accuracy === undefined ? null : Math.round(req.body.accuracy);
  const out = await SH.locate(String(req.params.token).replace(/(\.|%2E)+$/i, ''), req.body.lat, req.body.lng, acc, config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`);
  if (!out) throw notFound('This link has expired');
  res.json(out);
});

// ---------------------------------------------------------------- settings and the call's texts
const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (feature, message) => PA.needs(pool, feature, message);

router.get('/text-help', patrol, needs('manage_settings'), async (req, res) => {
  const n = await HL.numbersOf(pool, req.auth.tenantId);
  res.json({
    mode: n.mode, number: n.number, help_number: n.own_number, shared_number: n.shared_number, patrol_phone: n.patrol_phone,
    tag: n.tag, can_edit_tag: req.auth.role === 'owner',
    webhook_url: `${require('../lib/baseurl').baseUrl(req)}${PATH}`, texts_ready: require('../lib/sms').enabled(),
  });
});

const numberField = z.string().trim().max(30).nullable().optional();
/**
 * mode: 'shared' (the default) or 'own'. Without a mode (a client from before help/shared), a help number means own and
 * none means shared. Clearing both numbers on the shared number removes the row (shared is the default). The
 * tag is changed by the owner only (or the platform operator): it changes every sign, which must be printed again.
 */
router.put('/text-help', patrol, needs('manage_settings'), validate(z.object({ mode: z.enum(['shared', 'own']).optional(), help_number: numberField, patrol_phone: numberField, tag: z.string().trim().max(3).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const help = req.body.help_number ? HL.normalNumber(req.body.help_number) : null;
  if (req.body.help_number && !help) throw bad('The help number must be a full phone number, like +16105550100');
  const phone = req.body.patrol_phone ? HL.normalNumber(req.body.patrol_phone) : null;
  if (req.body.patrol_phone && !phone) throw bad('The patrol phone must be a full phone number, like +16105550100');
  if (help && await require('../lib/sandbox').isSandbox(tenantId)) throw bad('Demo mountains cannot have a help number');
  if (help && await HL.isShared(help)) throw conflict('That is the shared Verdynt/OS help number. Choose Use the shared Verdynt/OS number instead.');
  const mode = req.body.mode || (help ? 'own' : 'shared');
  if (req.body.tag !== undefined) {
    const now = await HL.ensureTag(pool, tenantId);
    if (String(req.body.tag).toUpperCase() !== now) {
      if (req.auth.role !== 'owner') throw forbidden('Only the owner can change the mountain\'s tag');
      const tag = await HL.setTag(pool, tenantId, req.body.tag);
      await audit(pool, req, 'set_help_tag', 'tenants', tenantId, { from: now, to: tag });
    }
  }
  if (!help && !phone && mode === 'shared') {
    await pool.query('DELETE FROM patrol_help_lines WHERE tenant_id = ?', [tenantId]);
  } else {
    // A patrol phone alone is fine (the guest page shows Call patrol). On their own number with none set, Text HELP is off.
    const taken = help ? await one(pool, 'SELECT tenant_id FROM patrol_help_lines WHERE help_number = ? AND tenant_id <> ?', [help, tenantId]) : null;
    if (taken) throw conflict('That number is already the help number of another mountain. Each mountain needs its own.');
    try {
      await pool.query(`INSERT INTO patrol_help_lines (tenant_id, help_number, patrol_phone, help_mode, updated_by) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE help_number = VALUES(help_number), patrol_phone = VALUES(patrol_phone), help_mode = VALUES(help_mode), updated_by = VALUES(updated_by)`, [tenantId, help, phone, mode, req.auth.userId]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('That number is already the help number of another mountain. Each mountain needs its own.');
      throw err;
    }
  }
  await audit(pool, req, 'set_text_help', 'patrol_help_lines', tenantId, { mode, help_number: help, patrol_phone: Boolean(phone) });
  const n = await HL.numbersOf(pool, tenantId);
  res.json({ ok: true, mode: n.mode, number: n.number, help_number: help, patrol_phone: phone, tag: n.tag });
});

async function smsCall(req) {
  const c = await one(pool, 'SELECT id, tenant_id, source, incident_id FROM dispatch_calls WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!c) throw notFound('Call');
  return c;
}
/** A call with a case: its photos follow the case's rule, like the call's words on the board. */
async function mayOpen(req, c) {
  if (!c.incident_id) return true;
  return (await PX.openable(pool, req, [Number(c.incident_id)])).has(Number(c.incident_id));
}

router.get('/dispatch/:id/sms', patrol, needs('dispatch'), async (req, res) => {
  const c = await smsCall(req);
  const v = c.source === 'sms' ? await HL.threadView(req.auth.tenantId, c.id) : null;
  if (!v) return res.json({ by_text: false });
  if (!(await mayOpen(req, c))) { v.photos = []; v.photos_hidden = true; }
  res.json({ by_text: true, ...v });
});

router.get('/dispatch/:id/sms-photo/:n', patrol, needs('dispatch'), async (req, res) => {
  const c = await smsCall(req);
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 0 || n > 50) throw notFound('Photo');
  if (!(await mayOpen(req, c))) throw forbidden('Open the case to see this photo');
  const url = await HL.photoUrl(req.auth.tenantId, c.id, n);
  if (!url) throw notFound('Photo');
  let up;
  try {
    up = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}` }, signal: AbortSignal.timeout(15000) });
  } catch (_) { throw bad('Twilio could not be reached. Try again.'); }
  if (!up.ok) throw notFound('Photo (Twilio no longer has it)');
  const type = String(up.headers.get('content-type') || '');
  if (!/^image\/(jpeg|png|gif|webp|heic|heif)$/i.test(type.split(';')[0].trim())) throw bad('That attachment is not a photo');
  const buf = Buffer.from(await up.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) throw bad('That photo is too large to show');
  await audit(pool, req, 'view_sms_photo', 'dispatch_calls', c.id, { n });
  res.set({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' }).send(buf);
});

module.exports = { publicRouter, router, signature, signedUrls, PATH };
