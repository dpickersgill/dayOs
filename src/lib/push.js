'use strict';

// Phone alerts (Web Push, RFC 8030 / 8291 / 8292) with Node's own crypto, so there is no extra dependency.
//
// A phone that agrees to alerts gives us an endpoint (the browser maker's push service) and two keys. Each alert is
// encrypted for that phone (aes128gcm) and signed with our VAPID key, so the push service can neither read it nor
// fake it. The VAPID key pair comes from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or is made once and kept in app_secrets.
//
// Alerts never fail the action that caused them: a phone that is gone (404/410) is forgotten, others are retried by
// nobody (an alert that is late is worse than none) and counted.
const crypto = require('crypto');
const { pool, rows, one } = require('../db');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');

let keys = null;
/** { publicKey (65-byte uncompressed point, base64url), privateKey (KeyObject) } */
async function vapid() {
  if (keys) return keys;
  let pub = process.env.VAPID_PUBLIC_KEY; let priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const saved = await one(pool, "SELECT value FROM app_secrets WHERE name = 'vapid'");
    if (saved) ({ pub, priv } = JSON.parse(saved.value));
    else {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      pub = b64u(ecdh.getPublicKey()); priv = b64u(ecdh.getPrivateKey());
      await pool.query("INSERT IGNORE INTO app_secrets (name, value) VALUES ('vapid', ?)", [JSON.stringify({ pub, priv })]);
      ({ pub, priv } = JSON.parse((await one(pool, "SELECT value FROM app_secrets WHERE name = 'vapid'")).value)); // another server may have won
    }
  }
  const point = fromB64u(pub);
  const privateKey = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(fromB64u(priv)), x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) }, format: 'jwk' });
  keys = { publicKey: pub, privateKey };
  return keys;
}

/** The VAPID Authorization header for one push service origin. */
async function authHeader(endpoint) {
  const { publicKey, privateKey } = await vapid();
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${process.env.VAPID_CONTACT || 'alerts@summitops.app'}` }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicKey}`;
}

/**
 * Encrypt a payload for one phone (RFC 8291, aes128gcm). `p256dh` and `auth` are the phone's keys (base64url).
 * Returns the request body. `salt` and `serverKeys` are only passed by tests.
 */
function encrypt(payload, p256dh, auth, { salt = crypto.randomBytes(16), serverKeys } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  const ecdh = serverKeys || crypto.createECDH('prime256v1');
  if (!serverKeys) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const text = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, text]);
}

/** The reverse of encrypt, for tests: what the phone would read. */
function decrypt(body, uaKeys, auth) {
  const salt = body.subarray(0, 16); const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen); const text = body.subarray(21 + idlen);
  const shared = uaKeys.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, fromB64u(auth), Buffer.concat([Buffer.from('WebPush: info\0'), uaKeys.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(text.subarray(text.length - 16));
  const out = Buffer.concat([d.update(text.subarray(0, text.length - 16)), d.final()]);
  return out.subarray(0, out.lastIndexOf(2)).toString();
}

// Tests replace this to see what would be sent without reaching a push service.
/**
 * Alerts go only to the browsers' own push services, so a registered address can never point the server at something
 * else (an internal address, another website). PUSH_EXTRA_HOSTS adds hosts if a browser maker adds a service.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /\.notify\.windows\.com$/, /^push\.services\.mozilla\.com$/];
function pushHostOk(url) {
  let u; try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'https:' || u.port) return false;
  const extra = String(process.env.PUSH_EXTRA_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return PUSH_HOSTS.some((r) => r.test(u.hostname)) || extra.includes(u.hostname);
}
let transport = async (endpoint, init) => fetch(endpoint, init);
const setTransport = (fn) => { transport = fn; };

/** Send one alert to one phone. Returns 'sent', 'gone' or 'failed'. */
async function sendOne(sub, message, { urgency = 'high', ttl = 120 } = {}) {
  try {
    const body = encrypt(JSON.stringify(message), sub.p256dh, sub.auth);
    if (!pushHostOk(sub.endpoint)) { await pool.query('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]); return 'gone'; } // not a push service: never sent
    const res = await transport(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await authHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404 || res.status === 410) { await pool.query('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]); return 'gone'; }
    if (res.status >= 200 && res.status < 300) { await pool.query('UPDATE push_subscriptions SET last_ok_at = UTC_TIMESTAMP(), failures = 0 WHERE id = ?', [sub.id]); return 'sent'; }
    await pool.query('UPDATE push_subscriptions SET failures = LEAST(failures + 1, 255) WHERE id = ?', [sub.id]);
    return 'failed';
  } catch (err) {
    console.warn('Push alert failed:', err.message);
    await pool.query('UPDATE push_subscriptions SET failures = LEAST(failures + 1, 255) WHERE id = ?', [sub.id]).catch(() => {});
    return 'failed';
  }
}

/**
 * Alert logins on their phones. message = { title, body, url, tag }. Returns how many phones were reached.
 * Never throws: an alert is a courtesy on top of the change that caused it.
 */
async function notifyUsers(tenantId, userIds, message, opts) {
  try {
    const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return 0;
    const subs = await rows(pool, 'SELECT * FROM push_subscriptions WHERE tenant_id = ? AND user_id IN (?)', [tenantId, ids]);
    const results = await Promise.all(subs.map((s) => sendOne(s, message, opts)));
    return results.filter((r) => r === 'sent').length;
  } catch (err) { console.warn('Push alerts failed:', err.message); return 0; }
}

/** The same, by staff record (patrollers are addressed by who they are on the roster). */
async function notifyStaff(tenantId, staffIds, message, opts) {
  const ids = [...new Set((staffIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  const users = await rows(pool, 'SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND staff_id IN (?)', [tenantId, ids]);
  return notifyUsers(tenantId, users.map((u) => u.id), message, opts);
}

module.exports = { vapid, encrypt, decrypt, authHeader, notifyUsers, notifyStaff, setTransport, sendOne, pushHostOk };
