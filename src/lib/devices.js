'use strict';

// The phones and computers each person signs in from. The browser keeps a random id (x-device header on sign-in); the
// server keeps only a keyed hash of it, a plain label ("Chrome on Windows") and when it was first and last seen. A
// sign-in from a device not seen before is written to the audit log and emailed to the person when they have an email.
const crypto = require('node:crypto');
const config = require('../config');
const { pool, one } = require('../db');

/** The keyed hash of the browser's device id, or null when it sent none (or something that is not one). */
function hashOf(req) {
  const raw = String((req.get && req.get('x-device')) || '');
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(raw)) return null;
  return crypto.createHmac('sha256', config.linkSecret).update(`device:${raw}`).digest('hex');
}

/** "Safari on iPhone", "Chrome on Windows": enough for a person to recognise their own device. */
function label(agent) {
  const a = String(agent || '');
  const browser = /Edg\//.test(a) ? 'Edge' : /OPR\//.test(a) ? 'Opera' : /Firefox\//.test(a) ? 'Firefox' : /Chrome\//.test(a) ? 'Chrome' : /Safari\//.test(a) ? 'Safari' : 'A browser';
  const os = /iPhone/.test(a) ? 'iPhone' : /iPad/.test(a) ? 'iPad' : /Android/.test(a) ? 'Android' : /Windows/.test(a) ? 'Windows' : /Mac OS X|Macintosh/.test(a) ? 'Mac' : /CrOS/.test(a) ? 'Chromebook' : /Linux/.test(a) ? 'Linux' : 'an unknown system';
  return `${browser} on ${os}`;
}

/** Has this person used this device before? A person with no devices on record yet is not "new" (their first sign-in after this release). */
async function isNew(user, deviceHash) {
  if (!deviceHash) return false;
  const [[r]] = await pool.query('SELECT COUNT(*) AS n, SUM(device_hash = ?) AS mine FROM user_devices WHERE user_id = ?', [deviceHash, user.id]);
  return Number(r.n) > 0 && !Number(r.mine);
}

/** Notes the device; on a device not seen before, writes the audit log and emails the person. Never throws. */
async function remember(user, req, deviceHash, { method } = {}) {
  if (!deviceHash) return;
  try {
    const fresh = await isNew(user, deviceHash);
    const agent = String(req.get('user-agent') || '');
    await pool.query(`INSERT INTO user_devices (tenant_id, user_id, device_hash, label, first_seen, last_seen) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())
      ON DUPLICATE KEY UPDATE last_seen = UTC_TIMESTAMP(), label = VALUES(label)`, [user.tenant_id, user.id, deviceHash, label(agent)]);
    if (!fresh) return;
    await pool.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, 'new_device', 'users', ?, ?)",
      [user.tenant_id, user.id, user.id, JSON.stringify({ device: label(agent), method: method || null })]).catch(() => {});
    if (!user.email) return;
    const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [user.tenant_id]);
    const when = new Date().toUTCString().replace(' GMT', ' UTC');
    await require('./mailer').send({
      tenantId: user.tenant_id, to: user.email, fromName: `${t ? t.name : 'SummitOps'} (SummitOps)`, tag: 'new-device',
      subject: 'New sign-in to SummitOps',
      text: `Someone signed in to your SummitOps login at ${t ? t.name : 'your mountain'} from a device not used before:\n\n${label(agent)}\n${when}\n\nIf this was you, there is nothing to do.\nIf it was not, sign in, change your password, and in Account, under "Where you're signed in", sign out everywhere else. Then tell your manager.`,
    });
  } catch (e) { console.error('Could not note sign-in device', e.message); }
}

module.exports = { hashOf, label, isNew, remember };
