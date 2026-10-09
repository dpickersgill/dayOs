'use strict';

// The time clock kiosk: device pairing, PINs, QR badges and the short-lived confirmation token.
// Nothing here is a login. A paired device can only list names, identify a person with their PIN or badge, and punch.

const crypto = require('crypto');
const config = require('../config');
const { pool, rows, one } = require('../db');
const { localTime } = require('./util');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (label, text) => crypto.createHmac('sha256', `${config.jwtSecret}:${label}`).update(text).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const b64u = (s) => Buffer.from(s).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

const MAX_TRIES = 5;
const LOCK_MINUTES = 10;
const SESSION_MS = 90_000;
const PAIR_MINUTES = 30;
const LONG_OPEN_HOURS = 14;

// ---- pairing codes and device tokens
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0, O, 1, I
function newPairCode() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += ALPHABET[b % ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const pairHash = (code) => sha256(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
const newDeviceToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = (t) => sha256(t);

// ---- PINs
function pinProblem(pin) {
  if (!/^\d{4,6}$/.test(String(pin))) return 'A PIN is 4 to 6 digits';
  if (/^(\d)\1+$/.test(pin)) return 'Pick a PIN that is not one digit repeated';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Pick a PIN that is not a run of digits';
  return null;
}
function randomPin() {
  for (;;) {
    const p = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!pinProblem(p)) return p;
  }
}

// ---- badges: derived from the server secret, so nothing secret is stored and a badge can be printed again.
// Issuing a new one bumps the version, which makes the old card stop working.
const badgeMac = (tenantId, staffId, version) => hmac('badge', `${tenantId}.${staffId}.${version}`).slice(0, 20);
const badgeCode = (tenantId, staffId, version) => `SO1.${staffId}.${version}.${badgeMac(tenantId, staffId, version)}`;
function parseBadge(text) {
  const m = /^SO1\.(\d{1,12})\.(\d{1,5})\.([0-9a-f]{20})$/.exec(String(text || '').trim());
  return m ? { staffId: Number(m[1]), version: Number(m[2]), mac: m[3] } : null;
}

// ---- the confirmation token that links "who are you" to "clock in or out"
function signSession({ tenantId, deviceId, staffId, method }) {
  const body = `${tenantId}.${deviceId}.${staffId}.${method}.${Date.now() + SESSION_MS}`;
  return `${b64u(body)}.${hmac('session', body).slice(0, 32)}`;
}
function readSession(token, tenantId, deviceId) {
  const [p, mac] = String(token || '').split('.');
  if (!p || !mac) return null;
  const body = unb64u(p);
  if (!safeEq(mac, hmac('session', body).slice(0, 32))) return null;
  const [t, d, s, method, exp] = body.split('.');
  if (Number(t) !== tenantId || Number(d) !== deviceId || Number(exp) < Date.now()) return null;
  return { staffId: Number(s), method };
}

// ---- time zones: shifts and screens use the mountain's local clock; time_entries use the database clock
function offsetAt(timeZone, ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}
/** A local wall-clock time ('YYYY-MM-DD HH:MM:SS') in a zone, as the database clock (UTC) string. */
function localToDb(local, timeZone) {
  const g = Date.parse(`${String(local).replace(' ', 'T').slice(0, 19)}Z`);
  let t = g - offsetAt(timeZone, g);
  t = g - offsetAt(timeZone, t);
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}
async function tenantOf(db, tenantId) {
  return one(db, 'SELECT id, name, slug, timezone, kiosk_photos, kiosk_photo_days FROM tenants WHERE id = ?', [tenantId]);
}
const shownName = (r) => `${r.first_name} ${String(r.last_name || '').slice(0, 1)}${r.last_name ? '.' : ''}`.trim();

/** Delete snapshots older than each mountain's retention. Run from the daily job. */
async function purgePhotos() {
  const [r] = await pool.query(
    `DELETE ph FROM time_photos ph JOIN tenants t ON t.id = ph.tenant_id WHERE ph.taken_at < DATE_SUB(NOW(), INTERVAL t.kiosk_photo_days DAY)`,
  );
  return r.affectedRows || 0;
}

const validJpeg = (s) => typeof s === 'string' && s.length <= 120_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s);

module.exports = {
  MAX_TRIES, LOCK_MINUTES, PAIR_MINUTES, LONG_OPEN_HOURS,
  sha256, safeEq, newPairCode, pairHash, newDeviceToken, tokenHash, pinProblem, randomPin,
  badgeCode, badgeMac, parseBadge, signSession, readSession, localToDb, localTime, tenantOf, shownName, purgePhotos, validJpeg, rows, one,
};
