'use strict';

// One-time challenges for passkeys and emailed codes, kept in the database so any server can check them. The client holds
// only a random handle; the server keeps its hash. Each is used once and gone after 5 minutes (emailed codes: 10).
const crypto = require('node:crypto');
const { pool } = require('../db');

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

async function put(purpose, challenge, { tenantId = null, userId = null, operatorId = null, minutes = 5 } = {}) {
  const handle = crypto.randomBytes(24).toString('base64url');
  await pool.query('INSERT INTO auth_challenges (id_hash, purpose, tenant_id, user_id, operator_id, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [hash(handle), purpose, tenantId, userId, operatorId, challenge, utc(new Date(Date.now() + minutes * 60_000))]);
  return handle;
}

/** The challenge for a handle, claimed so it cannot be used again; null when unknown, used or out of time. */
async function take(purpose, handle) {
  if (!handle) return null;
  const [r] = await pool.query('UPDATE auth_challenges SET used_at = UTC_TIMESTAMP() WHERE id_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [hash(handle), purpose]);
  if (r.affectedRows !== 1) return null;
  const [[row]] = await pool.query('SELECT challenge, tenant_id, user_id, operator_id FROM auth_challenges WHERE id_hash = ?', [hash(handle)]);
  return row || null;
}

/** For emailed codes: look without claiming, counting a wrong try (5 wrong and it is spent). */
async function peek(purpose, handle) {
  const [[row]] = await pool.query('SELECT challenge, tenant_id, user_id, tries FROM auth_challenges WHERE id_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [hash(handle || ''), purpose]);
  return row || null;
}
async function wrongTry(handle) {
  await pool.query('UPDATE auth_challenges SET tries = tries + 1, used_at = IF(tries >= 5, UTC_TIMESTAMP(), used_at) WHERE id_hash = ?', [hash(handle)]);
}
async function spend(handle) { await pool.query('UPDATE auth_challenges SET used_at = UTC_TIMESTAMP() WHERE id_hash = ?', [hash(handle)]); }

async function prune() {
  const [r] = await pool.query('DELETE FROM auth_challenges WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)');
  return r.affectedRows;
}

module.exports = { put, take, peek, wrongTry, spend, prune, hash };
