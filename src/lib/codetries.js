'use strict';

// Wrong emailed codes, counted per login on their own (feat/auth-hardening). Before, a wrong emailed code bumped the same
// count as the authenticator-app step, so anyone who knew a mountain and a username could ask for codes, guess wrong five
// times and lock the real person's app code, recovery codes and second step out for five minutes at a time.
//
// Now: 5 wrong emailed codes in a row lock emailed codes (signing in by email, the reset code, and the code emailed for a
// new device) for 15 minutes, for that login only. The app code, recovery codes and passkeys are never touched by it.
// Both kinds still count toward the day's total (code_day_failures), whose 50th wrong code stops signing in with an
// emailed code (codes_blocked_at) until a full sign-in another way, as before.
// Each try is counted BEFORE it is checked, by one UPDATE that only succeeds while emailed codes are not locked (MySQL and
// MariaDB apply SET left to right, so the lock line sees the new count).
const { pool, one } = require('../db');
const { AppError } = require('./errors');

const EMAIL_LOCK_AFTER = 5;
const EMAIL_LOCK_MINUTES = 15;
const CODE_DAY_CAP = 50;
const CODES_STOPPED = 'Too many wrong codes for this login today, so signing in with an emailed code is stopped. Sign in with your password or a passkey, or ask your manager to set a new password for you.';

/**
 * Counts one emailed-code try. signIn: the code stands in for the password (sign in by email, reset), so the day's stop
 * applies. Returns the day's count for this try; throws 429 while locked or stopped.
 */
async function claimEmailCode(id, wait, { signIn = false } = {}) {
  const [r] = await pool.query(`UPDATE users SET email_code_failures = IF(email_code_locked_until IS NOT NULL, 1, email_code_failures + 1),
      email_code_locked_until = IF(email_code_failures >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), NULL),
      code_day_failures = LAST_INSERT_ID(IF(code_day_from IS NULL OR code_day_from < UTC_TIMESTAMP() - INTERVAL 1 DAY, 1, code_day_failures + 1)),
      code_day_from = IF(code_day_from IS NULL OR code_day_from < UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP(), code_day_from),
      codes_blocked_at = IF(code_day_failures >= ?, COALESCE(codes_blocked_at, UTC_TIMESTAMP()), codes_blocked_at)
    WHERE id = ? ${signIn ? 'AND codes_blocked_at IS NULL' : ''} AND (email_code_locked_until IS NULL OR email_code_locked_until < UTC_TIMESTAMP())`, [EMAIL_LOCK_AFTER, EMAIL_LOCK_MINUTES, CODE_DAY_CAP, id]);
  if (r.affectedRows === 1) return Number(r.insertId);
  const u = await one(pool, 'SELECT codes_blocked_at FROM users WHERE id = ?', [id]);
  throw new AppError(429, signIn && u && u.codes_blocked_at ? CODES_STOPPED : `Too many wrong codes. ${wait}`);
}

/** A right emailed code: its own count starts again (the app-code count is left as it is). */
const clearEmail = (id) => pool.query('UPDATE users SET email_code_failures = 0, email_code_locked_until = NULL WHERE id = ?', [id]);

// App codes and recovery codes: 5 wrong in a row lock them for 5 minutes, wherever they are typed: the sign-in second
// step, the second check (step-up), turning two-step on or off, and quick resume (feat/auth-hardening: before, the second
// check and turning two-step on were limited only per address). They count toward the day's total too, but never stop
// emailed codes on their own account: someone guessing app codes already has the password or a session.
const APP_LOCK_AFTER = 5;
async function claimAppCode(id, wait) {
  const [r] = await pool.query(`UPDATE users SET mfa_failures = IF(mfa_locked_until IS NOT NULL, 1, mfa_failures + 1),
      mfa_locked_until = IF(mfa_failures >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE), NULL),
      code_day_failures = LAST_INSERT_ID(IF(code_day_from IS NULL OR code_day_from < UTC_TIMESTAMP() - INTERVAL 1 DAY, 1, code_day_failures + 1)),
      code_day_from = IF(code_day_from IS NULL OR code_day_from < UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP(), code_day_from),
      codes_blocked_at = IF(code_day_failures >= ?, COALESCE(codes_blocked_at, UTC_TIMESTAMP()), codes_blocked_at)
    WHERE id = ? AND (mfa_locked_until IS NULL OR mfa_locked_until < UTC_TIMESTAMP())`, [APP_LOCK_AFTER, CODE_DAY_CAP, id]);
  if (r.affectedRows === 1) return Number(r.insertId);
  throw new AppError(429, `Too many wrong codes. ${wait}`);
}

/** After a wrong code: the one that stops emailed codes for the day goes to the audit log (and its outside copy). */
async function wrongCode(req, user, dayCount) {
  if (dayCount !== CODE_DAY_CAP) return;
  await require('./audit').securityEvent(req, { tenantId: user.tenant_id, userId: user.id, actor: null, action: 'codes_stopped', row: true, after: CODE_DAY_CAP });
}

// A right app code, a passkey or a reset clears every code count and turns emailed-code sign-in back on.
const CLEAR_CODES = 'mfa_failures = 0, mfa_locked_until = NULL, email_code_failures = 0, email_code_locked_until = NULL, code_day_failures = 0, code_day_from = NULL, codes_blocked_at = NULL';
const cleared = (id) => pool.query(`UPDATE users SET ${CLEAR_CODES} WHERE id = ?`, [id]);

module.exports = { claimEmailCode, clearEmail, claimAppCode, wrongCode, cleared, CLEAR_CODES, EMAIL_LOCK_AFTER, EMAIL_LOCK_MINUTES, APP_LOCK_AFTER, CODE_DAY_CAP, CODES_STOPPED };
