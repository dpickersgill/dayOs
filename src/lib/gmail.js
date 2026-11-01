'use strict';

// Sending prospect outreach from the operator's own Google Workspace mailbox, and reading its threads for replies and
// bounces. It never uses Postmark: Postmark carries the mountains' own email and does not allow cold outreach.
//
// It signs in as a Google service account with domain-wide delegation, acting as the sender's mailbox:
//   OUTREACH_GMAIL_SA   the outreach service account's email (2026.11.11). No key exists: the app's own account asks
//                       Google (IAM Credentials, signJwt) to sign the sign-in for it, which it may do for this one
//                       account only (scripts/outreach-setup.sh grants that). Nothing to leak or rotate.
//   OUTREACH_GMAIL_KEY  the older way: the service account's JSON key (from Secret Manager), used only when
//                       OUTREACH_GMAIL_SA is not set. outreach-setup.sh moves to the keyless way and deletes the keys.
//   OUTREACH_SENDER     the mailbox it sends as, for example dan@verdynt-mail.com
// In Google Workspace Admin, Security, API controls, Domain-wide delegation, the service account's client ID is given
// the scopes in SCOPES. Tests replace the transport with setTransport().

const crypto = require('crypto');

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function keyFile() {
  const raw = process.env.OUTREACH_GMAIL_KEY || '';
  if (!raw) return null;
  try { const k = JSON.parse(raw); return k.client_email && k.private_key ? k : null; } catch (_) { return null; }
}
const sender = () => String(process.env.OUTREACH_SENDER || '').trim().toLowerCase();
const keylessAccount = () => String(process.env.OUTREACH_GMAIL_SA || '').trim();

// The app's own access token, from the Cloud Run metadata server.
async function runToken() {
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Could not get the app's own Google token (${res.status})`);
  return (await res.json()).access_token;
}
/** The sign-in assertion: signed by Google for the outreach account (keyless), or with its key (the older way). */
async function assertion(claimsObj) {
  const sa = keylessAccount();
  if (sa) {
    const res = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:signJwt`, {
      method: 'POST', headers: { authorization: `Bearer ${await runToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: JSON.stringify({ ...claimsObj, iss: sa }) }), signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google would not sign for ${sa}: ${(j.error && j.error.message) || res.status}. Run bash scripts/outreach-setup.sh again.`);
    return j.signedJwt;
  }
  const k = keyFile();
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ ...claimsObj, iss: k.client_email }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(k.private_key));
  return `${head}.${claims}.${sig}`;
}

let token = { value: null, until: 0 };
async function accessToken() {
  if (token.value && Date.now() < token.until - 60_000) return token.value;
  const now = Math.floor(Date.now() / 1000);
  const signed = await assertion({ sub: sender(), scope: SCOPES.join(' '), aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signed }), signal: AbortSignal.timeout(20000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}. Check domain-wide delegation for the service account.`);
  token = { value: j.access_token, until: Date.now() + Number(j.expires_in || 3600) * 1000 };
  return token.value;
}

async function gmail(method, path, body) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { method, headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail said ${res.status}: ${(j.error && j.error.message) || 'error'}`);
  return j;
}

// Header values: plain ASCII as is, anything else as an RFC 2047 encoded word.
const hval = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

/** An RFC 822 message: plain text, with List-Unsubscribe so mail apps show their own unsubscribe button. */
function compose({ fromName, from, to, subject, text, unsubscribeUrl, inReplyTo }) {
  const lines = [
    `From: ${hval(fromName)} <${from}>`, `To: ${to}`, `Subject: ${hval(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    ...(unsubscribeUrl ? [`List-Unsubscribe: <${unsubscribeUrl}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
  ];
  return `${lines.join('\r\n')}\r\n\r\n${Buffer.from(text).toString('base64').replace(/(.{76})/g, '$1\r\n')}`;
}

const real = {
  ready: () => Boolean((keylessAccount() || keyFile()) && sender()),
  sender,
  /** Sends; a follow-up goes in the same thread. Returns { id, threadId, messageId }. */
  async send(msg) {
    const raw = b64url(compose({ ...msg, from: sender() }));
    const out = await gmail('POST', '/messages/send', { raw, ...(msg.threadId ? { threadId: msg.threadId } : {}) });
    let messageId = null;
    try { const m = await gmail('GET', `/messages/${out.id}?format=metadata&metadataHeaders=Message-ID`); messageId = ((m.payload && m.payload.headers) || []).find((x) => /^message-id$/i.test(x.name))?.value || null; } catch (_) { messageId = null; }
    return { id: out.id, threadId: out.threadId, messageId };
  },
  /** Who wrote in a thread: [{ from, snippet, at }]. */
  async thread(threadId) {
    const t = await gmail('GET', `/threads/${threadId}?format=metadata&metadataHeaders=From`);
    return (t.messages || []).map((m) => ({ from: String(((m.payload && m.payload.headers) || []).find((x) => /^from$/i.test(x.name))?.value || '').toLowerCase(), snippet: m.snippet || '', at: Number(m.internalDate || 0) }));
  },
};

let transport = real;
const setTransport = (t) => { transport = t || real; };
const current = () => transport;

module.exports = { SCOPES, compose, current, setTransport };
