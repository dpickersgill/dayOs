'use strict';

// Sends email through Postmark's HTTP API (no SDK). Nothing is sent unless POSTMARK_SERVER_TOKEN and MAIL_FROM are set.
//   POSTMARK_SERVER_TOKEN   the Server API token of the Postmark server
//   MAIL_FROM               a verified sender address, for example patrol@yourmountain.org
//   POSTMARK_STREAM         message stream, default "outbound" (use a broadcast stream for bulk mail)
//   POSTMARK_API_BASE       only for automated tests
const env = process.env;
const { isSandbox } = require('./sandbox');
const { logFailure } = require('./jobs');
const settings = { apiBase: env.POSTMARK_API_BASE || 'https://api.postmarkapp.com' };
const token = () => env.POSTMARK_SERVER_TOKEN || '';
const from = () => env.MAIL_FROM || '';
const enabled = () => Boolean(token() && from());

/**
 * Returns { ok: true, id } or { ok: false, error } and never throws, so one bad address cannot stop a batch.
 * tenantId is required: demo (sandbox) mountains never send, whoever asks. stream 'broadcast' is for marketing campaigns,
 * which Postmark requires to be kept apart from tickets, reminders and patrol mail. Every failure is logged.
 */
async function send({ tenantId, to, fromName, replyTo, subject, text, html, tag, headers, stream }) {
  if (!enabled()) return { ok: false, error: 'Email is not set up' };
  if (!tenantId) { logFailure({ job: 'email', tag, message: 'send without a mountain' }); return { ok: false, error: 'No mountain given' }; }
  if (await isSandbox(tenantId)) return { ok: false, error: 'Demo mountains do not send email' };
  const r = await post({ to, fromName, replyTo, subject, text, html, tag, headers, stream });
  if (!r.ok) logFailure({ job: 'email', tenant: tenantId, tag, message: r.error });
  return r;
}

/**
 * On staging, every email goes to STAGING_INBOX instead of the person it names, with that person in the subject, so a
 * release can be checked end to end without mailing a real guest. No inbox set: nothing is sent at all.
 */
function stagingRoute(to, subject) {
  if (env.STAGE !== 'staging') return { to, subject };
  const inbox = env.STAGING_INBOX || '';
  if (!inbox) return null;
  return { to: inbox, subject: `[Staging, for ${String(to).replace(/[\r\n]/g, '').slice(0, 200)}] ${subject}` };
}

async function post({ to: named, fromName, replyTo, subject: asked, text, html, tag, headers, stream }) {
  const route = stagingRoute(named, asked);
  if (!route) return { ok: false, error: 'Staging sends no email until STAGING_INBOX is set' };
  const { to, subject } = route;
  const safeName = String(fromName || '').replace(/["<>\r\n]/g, '').slice(0, 100);
  try {
    const res = await fetch(`${settings.apiBase}/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-postmark-server-token': token() },
      body: JSON.stringify({
        From: safeName ? `${safeName} <${from()}>` : from(), To: to, ReplyTo: replyTo || undefined, Subject: subject, TextBody: text, HtmlBody: html,
        MessageStream: stream === 'broadcast' ? (env.POSTMARK_BROADCAST_STREAM || 'broadcast') : (env.POSTMARK_STREAM || 'outbound'), Tag: tag || undefined, Headers: headers || undefined, TrackOpens: false, TrackLinks: 'None',
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (json.ErrorCode && json.ErrorCode !== 0)) return { ok: false, error: String(json.Message || `Postmark said ${res.status}`).slice(0, 200) };
    return { ok: true, id: json.MessageID };
  } catch (_) {
    return { ok: false, error: 'Postmark could not be reached' };
  }
}

/** Mail from Verdynt/OS itself, not from a mountain (the website's contact form, operator notices). */
async function sendPlatform({ to, replyTo, subject, text, tag }) {
  if (!enabled()) return { ok: false, error: 'Email is not set up' };
  const r = await post({ to, fromName: 'Verdynt/OS', replyTo: replyTo || require('../config').site.supportEmail, subject, text, tag });
  if (!r.ok) logFailure({ job: 'email', tag, message: r.error });
  return r;
}

module.exports = { send, sendPlatform, enabled, settings, stagingRoute };
