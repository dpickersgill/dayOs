'use strict';

// Text HELP (help/sms): guests text the mountain's help number to reach patrol (the conversation is lib/helpline.js).
//
// publicRouter, at /api/v1/public:
//   POST /sms/inbound   Twilio's "A message comes in" webhook for every mountain's help number (form-encoded). Every
//                       request must carry Twilio's signature (X-Twilio-Signature, made with TWILIO_AUTH_TOKEN over
//                       PUBLIC_URL plus this path and the posted fields); anything else gets 403. A text to a number no
//                       mountain uses gets an empty 200 and is dropped. The answer is TwiML: the reply, or nothing.
// router, at /api/v1/patrol (patrol and managers):
//   GET/PUT /text-help                   the mountain's help number and patrol phone (Patrol settings)
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

const publicRouter = express.Router();
publicRouter.post('/sms/inbound', express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 200 }), async (req, res) => {
  if (!process.env.TWILIO_AUTH_TOKEN) return res.status(404).type('text/plain').send('Text messages are not set up');
  if (!signedByTwilio(req)) return res.status(403).type('text/plain').send('Not signed by Twilio');
  const b = req.body || {};
  const line = await HL.lineByNumber(Array.isArray(b.To) ? b.To[0] : b.To);
  if (!line) return twiml(res, null); // a number no mountain uses: nothing to do
  if (line.status !== 'active') { logFailure({ job: 'help_sms', tenant: line.tenant_id, message: 'text to the help line of a mountain that is not active' }); return twiml(res, null); }
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

// ---------------------------------------------------------------- settings and the call's texts
const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (feature, message) => PA.needs(pool, feature, message);

router.get('/text-help', patrol, needs('manage_settings'), async (req, res) => {
  const l = await HL.lineOf(pool, req.auth.tenantId);
  res.json({
    help_number: l ? l.help_number : null, patrol_phone: l ? l.patrol_phone : null,
    webhook_url: `${require('../lib/baseurl').baseUrl(req)}${PATH}`, texts_ready: require('../lib/sms').enabled(),
  });
});

const numberField = z.string().trim().max(30).nullable().optional();
router.put('/text-help', patrol, needs('manage_settings'), validate(z.object({ help_number: numberField, patrol_phone: numberField })), async (req, res) => {
  const { tenantId } = req.auth;
  const help = req.body.help_number ? HL.normalNumber(req.body.help_number) : null;
  if (req.body.help_number && !help) throw bad('The help number must be a full phone number, like +16105550100');
  const phone = req.body.patrol_phone ? HL.normalNumber(req.body.patrol_phone) : null;
  if (req.body.patrol_phone && !phone) throw bad('The patrol phone must be a full phone number, like +16105550100');
  if (help && await require('../lib/sandbox').isSandbox(tenantId)) throw bad('Demo mountains cannot have a help number');
  if (!help && !phone) {
    await pool.query('DELETE FROM patrol_help_lines WHERE tenant_id = ?', [tenantId]);
  } else {
    // A patrol phone alone is fine (the guest page shows Call patrol); Text HELP is off until a help number is set.
    const taken = help ? await one(pool, 'SELECT tenant_id FROM patrol_help_lines WHERE help_number = ? AND tenant_id <> ?', [help, tenantId]) : null;
    if (taken) throw conflict('That number is already the help number of another mountain. Each mountain needs its own.');
    try {
      await pool.query(`INSERT INTO patrol_help_lines (tenant_id, help_number, patrol_phone, updated_by) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE help_number = VALUES(help_number), patrol_phone = VALUES(patrol_phone), updated_by = VALUES(updated_by)`, [tenantId, help, phone, req.auth.userId]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('That number is already the help number of another mountain. Each mountain needs its own.');
      throw err;
    }
  }
  await audit(pool, req, 'set_text_help', 'patrol_help_lines', tenantId, { help_number: help, patrol_phone: Boolean(phone) });
  res.json({ ok: true, help_number: help, patrol_phone: phone });
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
