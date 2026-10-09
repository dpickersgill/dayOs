'use strict';

// Two-step sign-in with an authenticator app (RFC 6238: 6 digits, 30 second steps, HMAC-SHA1), plus one-time recovery codes.
// The secret is kept encrypted in the database with a key derived from JWT_SECRET, so a copy of the database alone is not enough.
const crypto = require('crypto');
const config = require('../config');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | ALPHABET.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

const stepAt = (ms) => Math.floor(ms / 1000 / 30);

/** Returns the matching time step (so the caller can refuse to accept it twice) or null. Allows one step either side for clock drift. */
function verify(secret, code, nowMs = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepAt(nowMs);
  let found = null;
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(c))) found = step;
  }
  return found;
}

const key = () => crypto.createHash('sha256').update(`summitops-totp:${config.jwtSecret}`).digest();
function seal(secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}
function open(sealed) {
  const [v, iv, tag, ct] = String(sealed || '').split(':');
  if (v !== 'v1') throw new Error('Bad secret');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

const otpauthUri = (secret, account, issuer) => `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---- recovery codes: ten characters, shown once as xxxxx-xxxxx, stored only as a keyed hash
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => {
    const raw = Array.from(crypto.randomBytes(10), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
const normalizeRecovery = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashRecovery = (c) => crypto.createHmac('sha256', key()).update(normalizeRecovery(c)).digest('hex');
const looksLikeRecovery = (c) => normalizeRecovery(c).length === 10;

module.exports = { newSecret, verify, seal, open, otpauthUri, newRecoveryCodes, hashRecovery, looksLikeRecovery, base32Encode, base32Decode, hotp, stepAt };
