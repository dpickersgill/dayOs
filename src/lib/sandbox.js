'use strict';

// Self-serve demo mountains ("sandboxes"). A visitor asks for one on the public /try page; it is a real mountain with every app
// switched on and made-up data, and it removes itself after a few days. Nothing in one can send email or take a card payment.
const { pool } = require('../db');

const DAYS = Number(process.env.SANDBOX_DAYS) || 7;
const MAX_ACTIVE = Number(process.env.SANDBOX_MAX_ACTIVE) || 40;
const STORAGE_MB = 25;

/** True when this mountain is a demo (so email and card payments must stay off). */
async function isSandbox(tenantId) {
  const [r] = await pool.query('SELECT sandbox_expires_at IS NOT NULL AS s FROM tenants WHERE id = ?', [tenantId]);
  return Boolean(r.length && Number(r[0].s));
}

async function activeCount() {
  const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE sandbox_expires_at IS NOT NULL');
  return Number(r.n);
}

/** Removes one demo mountain and everything in it. Refuses to touch a real mountain. */
async function purgeTenant(id) {
  const conn = await pool.getConnection();
  try {
    const [[t]] = await conn.query('SELECT id FROM tenants WHERE id = ? AND sandbox_expires_at IS NOT NULL', [id]);
    if (!t) return false;
    const [tables] = await conn.query(
      `SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
       WHERE c.table_schema = DATABASE() AND c.column_name = 'tenant_id' AND x.table_type = 'BASE TABLE' AND c.table_name NOT IN ('tenants', 'sandbox_signups', 'platform_audit')`,
    );
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
      await conn.query('DELETE FROM user_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)', [id]);
      for (const { t: name } of tables) await conn.query('DELETE FROM `' + String(name).replace(/`/g, '') + '` WHERE tenant_id = ?', [id]);
      await conn.query('DELETE FROM platform_audit WHERE tenant_id = ?', [id]);
      await conn.query('DELETE FROM tenants WHERE id = ? AND sandbox_expires_at IS NOT NULL', [id]);
    } finally {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    await conn.query('UPDATE sandbox_signups SET tenant_id = NULL WHERE tenant_id = ?', [id]);
    require('./modules').invalidate(id);
    return true;
  } finally {
    conn.release();
  }
}

/** Removes every demo whose time is up. Returns how many went. */
async function purgeExpired() {
  const [due] = await pool.query('SELECT id FROM tenants WHERE sandbox_expires_at IS NOT NULL AND sandbox_expires_at < NOW()');
  let n = 0;
  for (const { id } of due) {
    try { if (await purgeTenant(id)) n += 1; } catch (e) { console.error('Could not remove demo mountain', id, e.message); }
  }
  return n;
}

module.exports = { DAYS, MAX_ACTIVE, STORAGE_MB, isSandbox, activeCount, purgeTenant, purgeExpired };
