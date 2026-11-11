'use strict';

// Limits on what anyone can make the municipality send to one phone or email from a public page (review fix, 2026.11.19).
// The report page and the bulk pickup page take a phone and email that nobody has checked, so without limits they could
// be used to text or email a stranger again and again in the municipality's name.
//   submits   at most 3 new reports an hour giving the same phone, and the same for the same email, at one municipality,
//             and separately at most 3 bookings. More are refused with a plain message (submitAllowed throws 429).
//   messages  at most 6 texts and 6 emails a day to one phone or email at one municipality, of the messages a public form
//             sends with no staff involved: the immediate confirmation of a report ("received") or an online booking.
//             Messages caused by staff (scheduled, fixed, not out) and reminders are not counted. More are skipped, never
//             queued for later (allow returns false), and the request or booking says so for staff.
// Alert sign-up codes have their own limit (5 codes an hour per phone, routes/streetnotices.js); this does not change it.
// public_sends keeps a keyed hash of the phone or email, never the address, and is cleared after 2 days (lib/retention.js).
const crypto = require('crypto');
const { pool, one } = require('../db');
const config = require('../config');
const { AppError } = require('./errors');
const { logFailure } = require('./jobs');
const sms = require('./sms');

const SUBMITS_PER_HOUR = 3;
const MESSAGES_PER_DAY = 6;
const KEEP_DAYS = 2;

/** The key a phone (its 10 digits) or an email (lower case) is counted under, or null. */
function destOf(channel, value) {
  const v = channel === 'sms' ? sms.phoneKey(value) : String(value || '').trim().toLowerCase();
  if (!v || (channel === 'email' && !/^[^\s@]+@[^\s@]+$/.test(v))) return null;
  return crypto.createHmac('sha256', config.linkSecret).update(`public-sends:${channel}:${v}`).digest('hex');
}

async function countSince(tenantId, dest, kind, hours, tag = null) {
  const r = await one(pool, `SELECT COUNT(*) AS n FROM public_sends WHERE tenant_id = ? AND dest = ? AND kind = ?${tag ? ' AND tag = ?' : ''} AND created_at >= UTC_TIMESTAMP() - INTERVAL ${Number(hours)} HOUR`,
    tag ? [tenantId, dest, kind, tag] : [tenantId, dest, kind]);
  return Number(r.n);
}
const record = (tenantId, kind, channel, dest, tag) => pool.query('INSERT INTO public_sends (tenant_id, kind, channel, dest, tag) VALUES (?, ?, ?, ?, ?)', [tenantId, kind, channel, dest, tag ? String(tag).slice(0, 40) : null]);

/**
 * A new report or booking from a public page that gives this phone and/or email: refused (429) past 3 an hour for either,
 * otherwise counted. what: 'reports' or 'bookings', for the message.
 */
async function submitAllowed(tenantId, { phone, email }, what = 'reports') {
  const dests = [['sms', destOf('sms', phone)], ['email', destOf('email', email)]].filter((d) => d[1]);
  for (const [channel, dest] of dests) {
    if (await countSince(tenantId, dest, 'submit', 1, what) >= SUBMITS_PER_HOUR) {
      throw new AppError(429, `Too many ${what} with this ${channel === 'sms' ? 'phone number' : 'email address'} in the last hour. Please try again later, or call the office.`);
    }
  }
  for (const [channel, dest] of dests) await record(tenantId, 'submit', channel, dest, what);
}

/**
 * May one more message a public form set off go to this phone (channel 'sms') or email today? True and counted, or false
 * (skipped and logged, never sent later) past 6 a day.
 */
async function allow(tenantId, channel, value, tag) {
  const dest = destOf(channel, value);
  if (!dest) return false;
  if (await countSince(tenantId, dest, channel, 24) >= MESSAGES_PER_DAY) {
    await record(tenantId, 'skipped', channel, dest, tag);
    logFailure({ job: 'public_sends', tenant: tenantId, message: `skipped a ${channel === 'sms' ? 'text' : 'email'} (${tag || 'message'}): ${MESSAGES_PER_DAY} a day to one ${channel === 'sms' ? 'phone' : 'email'} already sent` });
    return false;
  }
  await record(tenantId, channel, channel, dest, tag);
  return true;
}

/** Clears counts older than 2 days. Returns how many rows went. */
async function purge() {
  const [r] = await pool.query(`DELETE FROM public_sends WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${KEEP_DAYS} DAY LIMIT 50000`);
  return r.affectedRows;
}

/** What staff see on the request or booking when a message was skipped for the limit. */
const skippedWords = (channel) => (channel === 'sms' ? 'Text not sent: daily limit for this phone' : 'Email not sent: daily limit for this email');

module.exports = { submitAllowed, allow, purge, destOf, skippedWords, SUBMITS_PER_HOUR, MESSAGES_PER_DAY };
