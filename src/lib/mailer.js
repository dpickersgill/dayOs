'use strict';

// Sends email through Postmark's HTTP API (no SDK). Nothing is sent unless POSTMARK_SERVER_TOKEN and MAIL_FROM are set.
//   POSTMARK_SERVER_TOKEN   the Server API token of the Postmark server
//   MAIL_FROM               a verified sender address, for example patrol@yourmountain.org
//   POSTMARK_STREAM         message stream, default "outbound" (use a broadcast stream for bulk mail)
//   POSTMARK_API_BASE       only for automated tests
const env = process.env;
const settings = { apiBase: env.POSTMARK_API_BASE || 'https://api.postmarkapp.com' };
const token = () => env.POSTMARK_SERVER_TOKEN || '';
const from = () => env.MAIL_FROM || '';
const enabled = () => Boolean(token() && from());

/** Returns { ok: true, id } or { ok: false, error } and never throws, so one bad address cannot stop a batch. */
async function send({ to, fromName, replyTo, subject, text, html, tag, headers }) {
  if (!enabled()) return { ok: false, error: 'Email is not set up' };
  const safeName = String(fromName || '').replace(/["<>\r\n]/g, '').slice(0, 100);
  try {
    const res = await fetch(`${settings.apiBase}/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-postmark-server-token': token() },
      body: JSON.stringify({
        From: safeName ? `${safeName} <${from()}>` : from(), To: to, ReplyTo: replyTo || undefined, Subject: subject, TextBody: text, HtmlBody: html,
        MessageStream: env.POSTMARK_STREAM || 'outbound', Tag: tag || undefined, Headers: headers || undefined, TrackOpens: false, TrackLinks: 'None',
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (json.ErrorCode && json.ErrorCode !== 0)) return { ok: false, error: String(json.Message || `Postmark said ${res.status}`).slice(0, 200) };
    return { ok: true, id: json.MessageID };
  } catch (_) {
    return { ok: false, error: 'Postmark could not be reached' };
  }
}

module.exports = { send, enabled, settings };
