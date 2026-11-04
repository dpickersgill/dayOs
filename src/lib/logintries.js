'use strict';

// Wrong passwords and PINs, counted per login in the database (2026.11.11: moved here from routes/auth.js so every
// password check counts, not only the sign-in page). Each try is counted BEFORE it is checked, by one UPDATE that only
// succeeds while the login is not locked, so guesses sent at the same moment still get only LOGIN_LOCK_AFTER checks.
// The try that reaches the limit sets the lock; a right answer clears the count.
// A password typed after sign-in (the second check, changing your password, setting a PIN, turning off two-step) counts
// toward the same lock: before 2026.11.11 someone holding a signed-in session could guess the password there without limit.
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { AppError, forbidden } = require('./errors');

const LOGIN_LOCK_AFTER = () => Number(process.env.LOGIN_LOCK_AFTER || 10); // wrong passwords in a row, then 15 minutes
const PIN_LOCK_AFTER = () => 5; // wrong PINs in a row, then 15 minutes
const COUNTERS = {
  login: ['login_failures', 'login_locked_until', LOGIN_LOCK_AFTER, 15],
  pin: ['pin_failures', 'pin_locked_until', PIN_LOCK_AFTER, 15],
};

/** Counts one try. Returns the try's number, or 0 when the login is locked (the caller answers 429). */
async function claimTry(kind, id) {
  const [count, until, limit, minutes] = COUNTERS[kind];
  // A lock that has run out starts the count again at 1. MySQL applies SET left to right, so the second line sees the new count.
  const [r] = await pool.query(`UPDATE users SET ${count} = LAST_INSERT_ID(IF(${until} IS NOT NULL, 1, ${count} + 1)),
      ${until} = IF(${count} >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), NULL)
    WHERE id = ? AND (${until} IS NULL OR ${until} < UTC_TIMESTAMP())`, [limit(), minutes, id]);
  return r.affectedRows === 1 ? Number(r.insertId) : 0;
}

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 12);
const LOCKED = 'Too many wrong passwords. Wait 15 minutes, or ask your manager to set a new one.';

/**
 * A password typed by someone already signed in. Counts toward the login's lock; throws 429 while locked and 403 (message)
 * when wrong. A right password clears the count.
 */
async function checkPassword(user, given, message = 'That password is not right') {
  const n = await claimTry('login', user.id);
  if (!n) { await bcrypt.compare(String(given || ''), DUMMY_HASH); throw new AppError(429, LOCKED); }
  if (!(await bcrypt.compare(String(given || ''), user.password_hash))) {
    if (n === LOGIN_LOCK_AFTER()) {
      await require('./audit').securityEvent(null, { tenantId: user.tenant_id, userId: user.id, actor: null, action: 'login_locked', row: true, after: n, where: 'signed_in' });
    }
    throw forbidden(message);
  }
  await pool.query('UPDATE users SET login_failures = 0, login_locked_until = NULL WHERE id = ?', [user.id]);
}

module.exports = { claimTry, checkPassword, LOGIN_LOCK_AFTER, PIN_LOCK_AFTER, DUMMY_HASH };
