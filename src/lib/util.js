'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { bad } = require('./errors');

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const dateTimeStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/, 'Use YYYY-MM-DDTHH:MM[:SS]');
const timeStr = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM[:SS]');
const id = z.coerce.number().int().positive();
// A guest type's code (lib/guesttypes.js): each mountain has its own list; routes check the code is one of them.
const tierEnum = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,30}$/, 'Choose a guest type');

/** Express middleware: validate req.body with a zod schema and replace it with the parsed value. */
function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return next(bad('Validation failed', details));
    }
    req.body = result.data;
    return next();
  };
}

/** Parse a numeric URL param such as :id. */
function paramId(req, name = 'id') {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw bad(`Invalid ${name}`);
  return n;
}

/** '2026-12-24T09:00' -> '2026-12-24 09:00:00' */
function normDateTime(s) {
  const t = s.replace('T', ' ');
  return t.length === 16 ? `${t}:00` : t;
}

/** Today's date (YYYY-MM-DD) in a given IANA time zone. */
function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Current wall-clock time ('YYYY-MM-DD HH:MM:SS') in a given IANA time zone, the way the database stores times. */
function nowIn(timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * The database stamps rows with its own clock (UTC), but a mountain's "today" is its local day. dayRange gives the
 * UTC start and end of a local day ('YYYY-MM-DD HH:MM:SS'), so an evening sale still lands on the day it was made.
 */
function dayRange(timeZone, date) {
  const offset = (ms) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  const midnight = (d) => { const g = Date.parse(`${d}T00:00:00Z`); let t = g - offset(g); t = g - offset(t); return new Date(t).toISOString().slice(0, 19).replace('T', ' '); };
  return [midnight(date), midnight(addDays(date, 1))];
}

/** The local calendar date ('YYYY-MM-DD') of a database timestamp (UTC) in a time zone. */
function localDay(dbTime, timeZone) {
  const ms = Date.parse(`${String(dbTime).replace(' ', 'T').slice(0, 19)}Z`);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** A database timestamp (UTC) as local wall-clock time ('YYYY-MM-DD HH:MM:SS') in a time zone. */
function localTime(dbTime, timeZone) {
  const ms = Date.parse(`${String(dbTime).replace(' ', 'T').slice(0, 19)}Z`);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Add days to a YYYY-MM-DD string (UTC arithmetic, no DST surprises). */
function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday for a YYYY-MM-DD date. */
function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Ski season label: Aug-Dec belongs to year/year+1, Jan-Jul to year-1/year. '2026-12-01' -> '2026-27'. */
function seasonFor(date) {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 8 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** 20-character uppercase hex code for tickets and passes. */
function newCode() {
  return crypto.randomBytes(10).toString('hex').toUpperCase();
}

/** Build "SET a=?, b=?" from an object, restricted to allowed keys. Returns null if nothing to update. */
function setClause(obj, allowed) {
  const keys = Object.keys(obj).filter((k) => allowed.includes(k) && obj[k] !== undefined);
  if (!keys.length) return null;
  return { sql: keys.map((k) => `\`${k}\` = ?`).join(', '), values: keys.map((k) => obj[k]) };
}

/** Like z.object(shape).partial(), but fields with .default() stay absent instead of being filled in.
 *  (zod 4's .partial() still applies defaults, which silently reset untouched columns on PATCH.) */
const partialOf = (shape) => z.object(Object.fromEntries(
  Object.entries(shape).map(([k, v]) => [k, (v instanceof z.ZodDefault ? v.unwrap() : v).optional()]),
));

/**
 * fn over every item, at most `limit` at a time, results in the items' order. For read-only checks against the pool
 * (not a transaction's single connection): 200 people checked 6 at a time instead of one after another.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = {
  mapLimit, partialOf, z, dateStr, dateTimeStr, timeStr, id, tierEnum,
  validate, paramId, normDateTime, todayIn, nowIn, dayRange, localDay, localTime, addDays, weekdayOf, seasonFor, newCode, setClause,
};
