'use strict';

// Quiet hours for marketing texts (2026.11.11): only between 8 AM and 9 PM at the mountain (its time zone, which is the
// guests' time zone for a local ski area). Outside them a text is held and sent at 8 AM.
const { one, pool } = require('../db');
const { addDays } = require('./util');

const FROM = 8; const UNTIL = 21;
const clock = { now: () => new Date() }; // tests set clock.now to try a night-time send

/** The UTC time ('YYYY-MM-DD HH:MM:SS') of a wall-clock time in a zone (two passes, right across a DST change). */
function utcOf(timeZone, local) {
  const offset = (ms) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  const g = Date.parse(`${local.replace(' ', 'T')}Z`);
  let t = g - offset(g); t = g - offset(t);
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/** { quiet, sendAfter } for a zone at a moment: sendAfter is the next 8 AM there, in UTC, when quiet. */
function at(timeZone, now = clock.now()) {
  const local = localNow(timeZone, now);
  const hour = Number(local.slice(11, 13));
  if (hour >= FROM && hour < UNTIL) return { quiet: false, sendAfter: null, local };
  const day = hour < FROM ? local.slice(0, 10) : addDays(local.slice(0, 10), 1);
  return { quiet: true, sendAfter: utcOf(timeZone, `${day} 0${FROM}:00:00`), local };
}
function localNow(timeZone, now) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

async function forTenant(tenantId, now = clock.now()) {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  return at((t && t.timezone) || 'America/New_York', now);
}

module.exports = { FROM, UNTIL, at, forTenant, utcOf, clock };
