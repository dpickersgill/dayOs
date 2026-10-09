'use strict';

// Sends text messages through Twilio's REST API (no SDK). Nothing is sent unless all three settings exist.
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   from the Twilio console
//   TWILIO_FROM                             a Twilio number (+1...) or messaging service id (MG...)
//   TWILIO_API_BASE                         only for automated tests
const env = process.env;
const base = () => env.TWILIO_API_BASE || 'https://api.twilio.com';
const enabled = () => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);

/** A US or Canadian number as +1XXXXXXXXXX, or null when it is not a number we can text. */
function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return null;
}

/** Returns { ok: true, id } or { ok: false, error } and never throws. */
async function send({ to, body }) {
  if (!enabled()) return { ok: false, error: 'Text messages are not set up' };
  const number = e164(to);
  if (!number) return { ok: false, error: 'Not a number we can text' };
  const form = new URLSearchParams({ To: number, Body: body });
  form.set(/^MG/.test(env.TWILIO_FROM) ? 'MessagingServiceSid' : 'From', env.TWILIO_FROM);
  try {
    const res = await fetch(`${base()}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: String(json.message || `Twilio said ${res.status}`).slice(0, 200) };
    return { ok: true, id: json.sid };
  } catch (_) {
    return { ok: false, error: 'Twilio could not be reached' };
  }
}

module.exports = { send, enabled, e164 };
