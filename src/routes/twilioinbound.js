'use strict';

// Replies to Verdynt/OS text messages (2026.11.10). Twilio posts every text a guest sends back to our number here:
//   POST /api/v1/twilio/sms   (set as "A message comes in" on the Twilio number or messaging service, see RUNBOOK.md)
// A message that is exactly STOP (or one of Twilio's other opt-out words, nothing else in it) is written to the consent record of every customer with that phone number, at
// every mountain: all mountains text from the one Verdynt/OS number, and Twilio stops all texts to that phone after a
// STOP, so every mountain's record must say so. START (or UNSTOP) undoes only an opt-out that came from a text reply.
// Twilio itself sends the standard reply to STOP, START and HELP, so this answers with an empty reply.
//
// Every request must carry Twilio's signature (X-Twilio-Signature, made with TWILIO_AUTH_TOKEN); anything else is refused.
// TWILIO_WEBHOOK_URL is the exact address set in Twilio, when it differs from the address the request arrived at.
const crypto = require('crypto');
const express = require('express');
const { pool, rows } = require('../db');
const { recordConsent } = require('../lib/consent');
const { logFailure } = require('../lib/jobs');

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES']);
const SOURCE = 'text_reply';

/** Twilio's signature: HMAC-SHA1 of the full address plus each posted field name and value, sorted by name. */
function signature(token, url, params) {
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
function signedByTwilio(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const given = String(req.get('x-twilio-signature') || '');
  if (!token || !given) return false;
  const url = process.env.TWILIO_WEBHOOK_URL || `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const want = signature(token, url, req.body || {});
  return given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

/** The whole message as one keyword: trimmed, upper case, punctuation and spaces at the ends dropped. Twilio only treats a
 *  message that is exactly one keyword as an opt-out or opt-in ("Stop." counts, "Cancel my lesson" does not). */
function keywordOf(text) {
  const t = String(text || '').trim().toUpperCase().replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
  return /^[A-Z]+$/.test(t) ? t : '';
}

/** What the reply asks for: 'stop', 'start' or null. Twilio's Advanced Opt-Out says it in OptOutType; when Twilio sends
 *  OptOutType it decides (HELP or anything else means no change). Without it, only an exact single keyword counts. */
function intentOf(body) {
  if (body.OptOutType !== undefined && String(body.OptOutType).trim() !== '') {
    const type = String(body.OptOutType).trim().toUpperCase();
    if (type === 'STOP') return 'stop';
    if (type === 'START') return 'start';
    return null;
  }
  const word = keywordOf(body.Body);
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/** Writes the reply to the consent record of every customer with this phone. Returns how many records changed. */
async function applyReply(phone, intent) {
  const digits = String(phone || '').replace(/\D/g, '');
  const key = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (key.length !== 10) return 0;
  const people = await rows(pool, `SELECT p.tenant_id, p.id,
      (SELECT CONCAT(c.status, '|', c.source) FROM consent_events c WHERE c.tenant_id = p.tenant_id AND c.person_id = p.id AND c.channel = 'sms' ORDER BY c.id DESC LIMIT 1) AS latest
    FROM people p WHERE p.phone_key = ?`, [key]);
  let changed = 0;
  for (const p of people) {
    const [status, source] = String(p.latest || '|').split('|');
    if (intent === 'stop' && status !== 'opted_out') { await recordConsent(pool, p.tenant_id, p.id, 'sms', 'opted_out', SOURCE, null); changed += 1; }
    if (intent === 'start' && status === 'opted_out' && source === SOURCE) { await recordConsent(pool, p.tenant_id, p.id, 'sms', 'opted_in', SOURCE, null); changed += 1; }
  }
  return changed;
}

const router = express.Router();
router.post('/sms', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
  if (!process.env.TWILIO_AUTH_TOKEN) return res.status(404).type('text/plain').send('Text messages are not set up');
  if (!signedByTwilio(req)) return res.status(403).type('text/plain').send('Not signed by Twilio');
  const intent = intentOf(req.body || {});
  if (intent) {
    try { await applyReply(req.body.From, intent); } catch (err) { logFailure({ job: 'sms_reply', message: err.message }); return res.status(500).type('text/plain').send('Try again'); }
  }
  return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

module.exports = { router, signature, intentOf, keywordOf, applyReply };
