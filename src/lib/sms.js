'use strict';

// Sends text messages through Twilio's REST API (no SDK). Nothing is sent unless all three settings exist.
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   from the Twilio console
//   TWILIO_FROM                             a Twilio number (+1...) or messaging service id (MG...)
//   TWILIO_API_BASE                         only for automated tests
const env = process.env;
const { isSandbox } = require('./sandbox');
const { logFailure } = require('./jobs');
const quiet = require('./quiet');
const base = () => env.TWILIO_API_BASE || 'https://api.twilio.com';
const enabled = () => Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);

/** A US or Canadian number as +1XXXXXXXXXX, or null when it is not a number we can text. */
function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  return null;
}

/**
 * Returns { ok: true, id } or { ok: false, error } and never throws. Demo (sandbox) mountains never send. Failures are logged.
 * promotional: a marketing text (a campaign, a recap, "book the next lesson"). It never goes to a phone whose latest
 * answer, on any record at the mountain with that number, is "no"; and between 9 PM and 8 AM at the mountain it is held
 * and sent at 8 AM by the 5-minute guests job ({ ok: true, held: true }).
 */
async function send({ tenantId, to, body, promotional = false, tag = null, logId = null }) {
  if (!enabled()) return { ok: false, error: 'Text messages are not set up' };
  if (!tenantId) { logFailure({ job: 'sms', message: 'send without a mountain' }); return { ok: false, error: 'No mountain given' }; }
  if (await isSandbox(tenantId)) return { ok: false, error: 'Demo mountains do not send text messages' };
  if (promotional) {
    const key = phoneKey(to);
    if (!key) return { ok: false, error: 'Not a number we can text' };
    if (await phoneSaidNo(tenantId, key)) return { ok: false, error: 'This phone asked not to get these texts', refused: true };
    const t = await quiet.forTenant(tenantId);
    if (t.quiet) {
      const { pool } = require('../db');
      const [r] = await pool.query('INSERT INTO sms_held (tenant_id, phone_key, body, tag, log_id, send_after) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, key, String(body).slice(0, 700), tag, logId, t.sendAfter]);
      return { ok: true, held: true, id: `held-${r.insertId}`, send_after: t.sendAfter };
    }
  }
  const r = await post({ to, body });
  if (!r.ok) logFailure({ job: 'sms', tenant: tenantId, message: r.error });
  return r;
}

async function post({ to: named, body: written }) {
  // On staging, texts go to STAGING_SMS_TO, saying who they were for, or nowhere. Never to a real guest or patroller.
  let to = named; let body = written;
  if (env.STAGE === 'staging') {
    if (!env.STAGING_SMS_TO) return { ok: false, error: 'Staging sends no text messages unless STAGING_SMS_TO is set' };
    to = env.STAGING_SMS_TO; body = `[Staging, for ${named}] ${written}`;
  }
  const number = e164(to);
  if (!number) return { ok: false, error: 'Not a number we can text' };
  const form = new URLSearchParams({ To: number, Body: body });
  form.set(/^MG/.test(env.TWILIO_FROM) ? 'MessagingServiceSid' : 'From', env.TWILIO_FROM);
  try {
    const res = await fetch(`${base()}/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15000), // a slow Twilio never holds a request or a job for minutes
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: String(json.message || `Twilio said ${res.status}`).slice(0, 200) };
    return { ok: true, id: json.sid };
  } catch (_) {
    return { ok: false, error: 'Twilio could not be reached' };
  }
}

/** The 10-digit US/Canada key of a phone number, or null. */
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const k = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return k.length === 10 ? k : null;
}

/** Is the latest text answer for this phone, on any customer record at the mountain, "no"? */
async function phoneSaidNo(tenantId, key) {
  const { one } = require('../db');
  const last = await one(require('../db').pool, `SELECT c.status FROM consent_events c JOIN people p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
    WHERE c.tenant_id = ? AND c.channel = 'sms' AND p.phone_key = ? ORDER BY c.id DESC LIMIT 1`, [tenantId, key]);
  return Boolean(last && last.status === 'opted_out');
}

/**
 * Sends the held marketing texts that are due (8 AM at the mountain or later), checking again that the phone has not said
 * no since. Run by the 5-minute guests job. Returns { sent, dropped, failed }.
 */
async function sendHeld() {
  const { pool, rows } = require('../db');
  const out = { sent: 0, dropped: 0, failed: 0 };
  const due = await rows(pool, "SELECT id, tenant_id, phone_key, body, log_id FROM sms_held WHERE status = 'held' AND send_after <= UTC_TIMESTAMP() ORDER BY id LIMIT 500");
  for (const h of due) {
    const [claim] = await pool.query("UPDATE sms_held SET status = 'sending' WHERE id = ? AND status = 'held'", [h.id]);
    if (!claim.affectedRows) continue;
    const t = await quiet.forTenant(h.tenant_id);
    if (t.quiet) { await pool.query("UPDATE sms_held SET status = 'held', send_after = ? WHERE id = ?", [t.sendAfter, h.id]); continue; }
    let r;
    if (await phoneSaidNo(h.tenant_id, h.phone_key)) r = { ok: false, error: 'The phone said no before 8 AM', dropped: true };
    else r = await send({ tenantId: h.tenant_id, to: h.phone_key, body: h.body });
    const status = r.ok ? 'sent' : r.dropped ? 'dropped' : 'failed';
    await pool.query('UPDATE sms_held SET status = ?, note = ? WHERE id = ?', [status, r.ok ? null : String(r.error || '').slice(0, 200), h.id]);
    if (h.log_id) await pool.query('UPDATE message_log SET status = ?, error = ? WHERE tenant_id = ? AND id = ?', [r.ok ? 'sent' : 'failed', r.ok ? null : String(r.error || '').slice(0, 200), h.tenant_id, h.log_id]);
    out[status === 'sent' ? 'sent' : status === 'dropped' ? 'dropped' : 'failed'] += 1;
  }
  // Sent or dropped texts are kept a week for questions, then deleted (they hold a phone number and the words).
  await pool.query("DELETE FROM sms_held WHERE status IN ('sent','dropped','failed') AND created_at < UTC_TIMESTAMP() - INTERVAL 7 DAY");
  return out;
}

module.exports = { send, enabled, e164, phoneKey, phoneSaidNo, sendHeld };
