'use strict';

// A seasonal login's last day (users.access_ends_on) is a day at the mountain, so it ends at midnight there, not at
// midnight UTC (2026.11.11). Before, the sign-in check, the calendar feed and the daily job compared it with the UTC date
// (CURDATE() on a UTC database), which cut a US mountain's staff off at 7 or 8 pm on their last day.
// The database has no time zone tables, so the mountain's date is worked out here (lib/util todayIn).
const { todayIn } = require('./util');

/** Is the login past its last day, at this mountain? endsOn: a DATE (or 'YYYY-MM-DD'); timeZone: tenants.timezone. */
function over(endsOn, timeZone) {
  if (!endsOn) return false;
  const day = endsOn instanceof Date ? endsOn.toISOString().slice(0, 10) : String(endsOn).slice(0, 10);
  return day < todayIn(timeZone || 'America/New_York');
}

/**
 * The daily job: ends the sessions of logins past their last day, mountain by mountain (each in its own date). Returns
 * how many sessions it ended.
 */
async function endSessions(pool) {
  const [tz] = await pool.query("SELECT DISTINCT t.id, t.timezone FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.access_ends_on IS NOT NULL");
  let n = 0;
  for (const t of tz) {
    const [r] = await pool.query("UPDATE user_sessions s JOIN users u ON u.id = s.user_id SET s.ended_at = UTC_TIMESTAMP(), s.ended_why = 'access_ended' WHERE s.ended_at IS NULL AND u.tenant_id = ? AND u.access_ends_on IS NOT NULL AND u.access_ends_on < ?", [t.id, todayIn(t.timezone || 'America/New_York')]);
    n += r.affectedRows;
  }
  return n;
}

module.exports = { over, endSessions };
