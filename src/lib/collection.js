'use strict';

// The collection schedule (release 2026.11.22, Trash and recycling). What every part of the app asks the schedule:
// which zone an address is in, which days each stream is collected there, what is collected on a day and on which
// streets, and whether a missed pickup can be reported yet. The routes and tonnage workstreams call these too; the
// signatures are the release spec's and do not change.
//
//   zoneFor(conn, tenantId, { streetId, houseNo })          -> { zoneId, zoneName } | { notCollected: true } | null
//   collectionDays(conn, tenantId, { zoneId, from, to })    -> [{ date, streamId, streamName, kind, original, moved, reason? }]
//   nextFor(conn, tenantId, { zoneId, today })              -> [{ streamId, streamName, kind, color, date, original, moved, reason? }]
//   dayRoutes(conn, tenantId, date)                         -> [{ zoneId, zoneName, streamId, streamName, kind, streets: [...] }]
//   requireAddon(key)                                       Express middleware: 403 module_disabled when the add-on is off
//
// The rules, in the order they apply to each stream of a zone:
//   1. Frequency: weekly; every other week (the weeks of anchor_date, counted Monday to Sunday); monthly (the same
//      numbered weekday as anchor_date: the 2nd Thursday). The weekday is the zone's day for that stream.
//   2. Season: a stream with season_start and season_end ('04-01', '11-30') runs only between them, both days included
//      (a season that crosses New Year, '11-01' to '03-31', works too).
//   3. The holiday rule (collection_settings.holiday_rule): 'shift' (the usual): a holiday on or before a collection day
//      in the same Monday-to-Saturday week moves that day one day later, so the rest of the week slides a day; 'skip':
//      a collection day that is a holiday is dropped; 'none': nothing moves.
//   4. Changes (collection_changes): a day moved for snow, weather or another reason (or canceled), for every zone or
//      the zones listed. A change matches the day as it stands after the holiday rule. The newest change for a day wins.
// Dates are plain YYYY-MM-DD calendar days in the municipality's time zone (tenants.timezone); "today" is always the
// municipality's today, never the server's.
const { pool, rows, one } = require('../db');
const { todayIn, nowIn, addDays } = require('./util');
const { AppError } = require('./errors');

const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const KINDS = ['trash', 'recycling', 'yard', 'food', 'other'];
const KIND_WORDS = { trash: 'Trash', recycling: 'Recycling', yard: 'Yard waste', food: 'Food scraps', other: 'Other' };
const FREQUENCIES = ['weekly', 'biweekly', 'monthly'];
const REASON_WORDS = { holiday: 'moved for the holiday', snow: 'moved for snow', weather: 'moved for the weather', other: 'moved' };
const DEFAULT_ANCHOR = '2026-01-05'; // a Monday: "every other week" with no anchor counts from this week

// ---------------------------------------------------------------- dates
const ms = (d) => Date.parse(`${d}T12:00:00Z`);
/** 1 Monday ... 7 Sunday. */
const isoDay = (d) => { const w = new Date(ms(d)).getUTCDay(); return w === 0 ? 7 : w; };
/** The Monday of the week a date is in. */
const mondayOf = (d) => addDays(d, 1 - isoDay(d));
const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / 86400000);
const nthOfMonth = (d) => Math.ceil(Number(d.slice(8, 10)) / 7);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(ms(d));
const asList = (v) => {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  try { return asList(JSON.parse(v)); } catch (_) { return String(v).split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0); }
};

/** Is this day inside a stream's season? No season means every day. */
function inSeason(date, start, end) {
  if (!start || !end) return true;
  const md = date.slice(5, 10);
  return start <= end ? md >= start && md <= end : md >= start || md <= end;
}
/** Does a stream run in this date's week (or month) at all, on its weekday? */
function runsOn(stream, date) {
  if (stream.frequency === 'biweekly') {
    const weeks = Math.round(daysBetween(mondayOf(stream.anchor_date || DEFAULT_ANCHOR), mondayOf(date)) / 7);
    return ((weeks % 2) + 2) % 2 === 0;
  }
  if (stream.frequency === 'monthly') return nthOfMonth(date) === Math.min(4, nthOfMonth(stream.anchor_date || '2026-01-01'));
  return true;
}

// ---------------------------------------------------------------- reading the setup
const tzOf = async (conn, tenantId) => ((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])) || {}).timezone || 'America/New_York';
/** The municipality's today ('YYYY-MM-DD'), in its own time zone. */
const todayFor = async (conn, tenantId) => todayIn(await tzOf(conn, tenantId));

async function settingsOf(conn, tenantId) {
  const s = await one(conn, 'SELECT * FROM collection_settings WHERE tenant_id = ?', [tenantId]);
  return {
    model: (s && s.model) || 'inhouse', hauler_name: s ? s.hauler_name : null, hauler_phone: s ? s.hauler_phone : null, hauler_email: s ? s.hauler_email : null, hauler_url: s ? s.hauler_url : null,
    holiday_rule: (s && s.holiday_rule) || 'shift', reminder_hour: s ? Number(s.reminder_hour) : 18, setup_done_at: s ? s.setup_done_at : null,
    ordinance_materials: s ? s.ordinance_materials || null : null, curb_by: s ? s.curb_by || null : null,
  };
}
const streamOut = (s) => ({
  id: Number(s.id), name: s.name, kind: s.kind, frequency: s.frequency, anchor_date: s.anchor_date || null, season_start: s.season_start || null, season_end: s.season_end || null,
  color: s.color, materials: s.materials || null, not_accepted: s.not_accepted || null, sort: Number(s.sort), active: Boolean(Number(s.active)),
});
async function streamsOf(conn, tenantId, { all = false } = {}) {
  return (await rows(conn, `SELECT * FROM collection_streams WHERE tenant_id = ?${all ? '' : ' AND active = 1'} ORDER BY sort, id`, [tenantId])).map(streamOut);
}
/** The days each stream is collected in a zone: [{ stream, weekday }], active streams only. */
async function zoneDaysOf(conn, tenantId, zoneId) {
  const list = await rows(conn, `SELECT d.weekday, s.* FROM collection_zone_days d JOIN collection_streams s ON s.tenant_id = d.tenant_id AND s.id = d.stream_id
    WHERE d.tenant_id = ? AND d.zone_id = ? AND s.active = 1 ORDER BY s.sort, s.id`, [tenantId, zoneId]);
  return list.map((r) => ({ stream: streamOut(r), weekday: Number(r.weekday) }));
}

// ---------------------------------------------------------------- zoneFor
/** The number part of a house number ('123A' -> 123, '12-14' -> 12), or null. */
function houseNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const m = /^\s*(\d{1,7})/.exec(String(v));
  return m ? Number(m[1]) : null;
}
/** Does a zone-street row cover this house number? A row with no range and both sides covers the whole street. */
function covers(row, n) {
  const whole = row.from_no === null && row.to_no === null && (row.side || 'both') === 'both';
  if (n === null) return whole;
  if (row.from_no !== null && n < Number(row.from_no)) return false;
  if (row.to_no !== null && n > Number(row.to_no)) return false;
  if (row.side === 'odd' && n % 2 !== 1) return false;
  if (row.side === 'even' && n % 2 !== 0) return false;
  return true;
}
/**
 * The zone an address is in: { zoneId, zoneName }, { notCollected: true } for a street (or part of one) marked not
 * collected, or null when no zone covers it. A row with a house-number range or one side wins over a whole-street row,
 * so a street split between two zones can keep a whole-street row for the rest of it.
 */
async function zoneFor(conn, tenantId, { streetId, houseNo }) {
  if (!streetId) return null;
  const list = await rows(conn, `SELECT r.id, r.zone_id, r.from_no, r.to_no, r.side, r.not_collected, z.name AS zone_name, z.active AS zone_active
    FROM collection_zone_streets r LEFT JOIN collection_zones z ON z.tenant_id = r.tenant_id AND z.id = r.zone_id WHERE r.tenant_id = ? AND r.street_id = ? ORDER BY r.id`, [tenantId, streetId]);
  const n = houseNumber(houseNo);
  const hits = list.filter((r) => covers(r, n) && (Number(r.not_collected) || (r.zone_id && Number(r.zone_active))));
  if (!hits.length) return null;
  const narrow = (r) => (r.from_no !== null || r.to_no !== null || (r.side || 'both') !== 'both' ? 0 : 1);
  hits.sort((a, b) => narrow(a) - narrow(b) || Number(a.id) - Number(b.id));
  const best = hits[0];
  if (Number(best.not_collected)) return { notCollected: true };
  return { zoneId: Number(best.zone_id), zoneName: best.zone_name };
}

// ---------------------------------------------------------------- collectionDays
async function holidaysBetween(conn, tenantId, from, to) {
  return new Map((await rows(conn, 'SELECT on_date, name FROM collection_holidays WHERE tenant_id = ? AND on_date BETWEEN ? AND ?', [tenantId, from, to])).map((h) => [String(h.on_date).slice(0, 10), h.name]));
}
async function changesBetween(conn, tenantId, from, to) {
  return (await rows(conn, `SELECT id, on_date, moved_to, zone_ids, reason, note FROM collection_changes WHERE tenant_id = ? AND (on_date BETWEEN ? AND ? OR moved_to BETWEEN ? AND ?) ORDER BY id DESC`, [tenantId, from, to, from, to]))
    .map((c) => ({ id: Number(c.id), on_date: String(c.on_date).slice(0, 10), moved_to: c.moved_to ? String(c.moved_to).slice(0, 10) : null, zone_ids: asList(c.zone_ids), reason: c.reason, note: c.note }));
}

/**
 * Every collection of a zone's streams between two dates (both included), after the season, the holiday rule and the
 * changes, sorted by date (then the streams' order). Each: { date, streamId, streamName, kind, original, moved, reason? }
 * (reason: 'holiday', 'snow', 'weather' or 'other' when moved). A canceled day is left out.
 */
async function collectionDays(conn, tenantId, { zoneId, from, to }) {
  if (!zoneId || !isDate(from) || !isDate(to) || from > to) return [];
  if (daysBetween(from, to) > 800) throw new AppError(400, 'Ask for two years at most');
  const days = await zoneDaysOf(conn, tenantId, zoneId);
  if (!days.length) return [];
  const settings = await settingsOf(conn, tenantId);
  // A change can bring a day in from outside the range, and a holiday can push one in from the day before.
  let lo = addDays(from, -7); const hi = addDays(to, 7);
  const changes = await changesBetween(conn, tenantId, lo, hi);
  for (const c of changes) if (c.moved_to && c.moved_to >= from && c.moved_to <= to && c.on_date < lo) lo = addDays(c.on_date, -7);
  const holidays = await holidaysBetween(conn, tenantId, addDays(lo, -7), hi);
  const out = [];
  for (let d = lo; d <= hi; d = addDays(d, 1)) {
    const wd = isoDay(d);
    for (const { stream, weekday } of days) {
      if (weekday !== wd || !inSeason(d, stream.season_start, stream.season_end) || !runsOn(stream, d)) continue;
      const item = { date: d, streamId: stream.id, streamName: stream.name, kind: stream.kind, original: d, moved: false, sort: stream.sort };
      if (settings.holiday_rule === 'skip' && holidays.has(d)) continue;
      if (settings.holiday_rule === 'shift' && wd <= 6) {
        // A holiday from Monday up to this day, in the same week, moves it one day later.
        for (let h = mondayOf(d); h <= d; h = addDays(h, 1)) if (holidays.has(h)) { item.date = addDays(d, 1); item.moved = true; item.reason = 'holiday'; break; }
      }
      const change = changes.find((c) => c.on_date === item.date && (!c.zone_ids.length || c.zone_ids.includes(Number(zoneId))));
      if (change) {
        if (!change.moved_to) continue; // canceled
        item.date = change.moved_to; item.moved = true; item.reason = change.reason;
      }
      out.push(item);
    }
  }
  return out.filter((x) => x.date >= from && x.date <= to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sort - b.sort || a.streamId - b.streamId))
    .map(({ sort, ...x }) => x);
}

/**
 * The next collection of each stream of a zone, from today on (today included): [{ streamId, streamName, kind, color,
 * date, original, moved, reason? }] in the streams' order. A stream out of season looks ahead up to a year. today:
 * 'YYYY-MM-DD', the municipality's today when left out.
 */
async function nextFor(conn, tenantId, { zoneId, today } = {}) {
  const from = isDate(today) ? today : await todayFor(conn, tenantId);
  const days = await collectionDays(conn, tenantId, { zoneId, from, to: addDays(from, 380) });
  const streams = await zoneDaysOf(conn, tenantId, zoneId);
  const out = [];
  for (const { stream } of streams) {
    const first = days.find((x) => x.streamId === stream.id);
    if (first) out.push({ ...first, color: stream.color });
  }
  return out;
}

// ---------------------------------------------------------------- dayRoutes
/**
 * What is collected on a day, zone by zone and stream by stream, after the holiday rule and changes:
 * [{ zoneId, zoneName, streamId, streamName, kind, streets: [{ streetId, name, fromNo, toNo, side }] }]. Streets follow the
 * borough's driving order for the zone's usual weekday (the bulk pickup route order, lib/bulkroute.js) when one is set,
 * then any others by name.
 */
async function dayRoutes(conn, tenantId, date) {
  if (!isDate(date)) return [];
  const zones = await rows(conn, 'SELECT id, name FROM collection_zones WHERE tenant_id = ? AND active = 1 ORDER BY sort, name', [tenantId]);
  const out = [];
  for (const z of zones) {
    const items = await collectionDays(conn, tenantId, { zoneId: z.id, from: date, to: date });
    if (!items.length) continue;
    const streets = await rows(conn, `SELECT r.street_id, s.name, r.from_no, r.to_no, r.side FROM collection_zone_streets r JOIN streets s ON s.tenant_id = r.tenant_id AND s.id = r.street_id
      WHERE r.tenant_id = ? AND r.zone_id = ? AND r.not_collected = 0 ORDER BY s.name, r.from_no, r.id`, [tenantId, z.id]);
    for (const it of items) {
      // The driving order of the day the zone is usually collected (bulk_route_order counts 0 Sunday ... 6 Saturday).
      const order = new Map((await rows(conn, 'SELECT street_id, position FROM bulk_route_order WHERE tenant_id = ? AND weekday = ?', [tenantId, isoDay(it.original) % 7])).map((r) => [Number(r.street_id), Number(r.position)]));
      const sorted = [...streets].sort((a, b) => {
        const pa = order.get(Number(a.street_id)); const pb = order.get(Number(b.street_id));
        if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb;
        if (pa !== undefined && pb === undefined) return -1;
        if (pa === undefined && pb !== undefined) return 1;
        return String(a.name).localeCompare(String(b.name)) || (a.from_no ?? -1) - (b.from_no ?? -1);
      });
      out.push({ zoneId: Number(z.id), zoneName: z.name, streamId: it.streamId, streamName: it.streamName, kind: it.kind, ...(it.moved ? { moved: true, original: it.original, reason: it.reason } : {}),
        streets: sorted.map((s) => ({ streetId: Number(s.street_id), name: s.name, fromNo: s.from_no === null ? null : Number(s.from_no), toNo: s.to_no === null ? null : Number(s.to_no), side: s.side })) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- requireAddon
/**
 * Express middleware for the routes of an add-on with no path of its own (Collection routes, Hauler oversight): 403 with
 * the same body the app gate sends (code module_disabled) when it is off for the signed-in municipality. Trash and
 * recycling itself is checked by the gate on /solid-waste first.
 */
function requireAddon(key) {
  const M = require('./modules');
  if (!M.MODULES.some((m) => m.key === key)) throw new Error(`requireAddon: no app called ${key}`);
  return (req, _res, next) => {
    (async () => {
      const { on, org } = await M.stateOf(req.auth.tenantId);
      if (!on.has(key)) throw M.off(key, org);
    })().then(() => next(), next);
  };
}

// ---------------------------------------------------------------- words
const longDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(ms(d)));
const ORDINAL = ['', 'first', 'second', 'third', 'fourth'];
/** "every Thursday", "every other Thursday", "on the second Thursday of each month". */
function howOften(stream, weekday) {
  const day = DAY_NAMES[weekday];
  if (stream.frequency === 'biweekly') return `every other ${day}`;
  if (stream.frequency === 'monthly') return `on the ${ORDINAL[Math.min(4, nthOfMonth(stream.anchor_date || '2026-01-01'))]} ${day} of each month`;
  return `every ${day}`;
}
/** "Friday, November 27 (moved for the holiday)". */
const dayWords = (item) => `${longDay(item.date)}${item.moved ? ` (${REASON_WORDS[item.reason] || 'moved'})` : ''}`;

// ---------------------------------------------------------------- is it your day? (missed pickups)
const LATE_DAYS = 2; // a missed pickup can be reported up to two days after the collection day
const ROUTE_DONE_HOUR = 17; // without route progress, the truck may be out until 5 PM
/**
 * Whether a missed pickup at an address can be reported now. Returns { outcome, message, zone?, next?, at?, reason? }:
 *   not_collected  the address is not on any collection (a private hauler, a business)
 *   not_your_day   no collection of that stream there today or in the last two days (with the next date)
 *   not_yet        today is the day and the truck may not have been yet: from route progress when Collection routes is
 *                  on and the routes workstream answers, otherwise before 5 PM local time
 *   skipped        (routes) the crew skipped the street, with the reason
 *   done           (routes) the crew marked the street done, with the time
 *   ok_to_report   send it
 * A resident may send it only for done, skipped and ok_to_report (SEND_OK). opts.now: 'YYYY-MM-DD HH:MM:SS' local (tests).
 */
const SEND_OK = ['done', 'skipped', 'ok_to_report'];
async function pickupCheck(conn, tenantId, { streetId, houseNo, streamId = null, now = null } = {}) {
  const clock = now || nowIn(await tzOf(conn, tenantId));
  const today = clock.slice(0, 10);
  const zone = await zoneFor(conn, tenantId, { streetId, houseNo });
  if (zone && zone.notCollected) return { outcome: 'not_collected', message: 'This address is not on the borough\'s collection. If you think it should be, call the office.' };
  if (!zone) return { outcome: 'ok_to_report', message: 'We could not find your collection day, so your report goes to the office to check.' };
  const zoneDays = await zoneDaysOf(conn, tenantId, zone.zoneId);
  const wanted = zoneDays.filter((d) => !streamId || d.stream.id === Number(streamId));
  if (!wanted.length) return { outcome: 'not_collected', message: 'That is not collected at this address.', zone: { id: zone.zoneId, name: zone.zoneName } };
  const recent = (await collectionDays(conn, tenantId, { zoneId: zone.zoneId, from: addDays(today, -LATE_DAYS), to: today })).filter((x) => wanted.some((w) => w.stream.id === x.streamId));
  const z = { id: zone.zoneId, name: zone.zoneName };
  const todays = recent.filter((x) => x.date === today);
  const routes = await routeStatus(conn, tenantId, { streetId, houseNo, zoneId: zone.zoneId, items: todays.length ? todays : recent.slice(-1) });
  if (routes) return { ...routes, zone: z };
  if (todays.length) {
    if (Number(clock.slice(11, 13)) < ROUTE_DONE_HOUR) return { outcome: 'not_yet', message: 'The truck is still on its route today. If it has not come by 5 PM, report it then.', zone: z };
    return { outcome: 'ok_to_report', message: 'Thank you. Tell us what was missed.', zone: z };
  }
  if (recent.length) return { outcome: 'ok_to_report', message: 'Thank you. Tell us what was missed.', zone: z };
  // Not their day: say when it is.
  const next = (await nextFor(conn, tenantId, { zoneId: zone.zoneId, today: addDays(today, 1) })).filter((x) => wanted.some((w) => w.stream.id === x.streamId));
  const first = next[0];
  if (!first) return { outcome: 'not_your_day', message: 'That is not collected again this year at this address.', zone: z };
  const w = wanted.find((x) => x.stream.id === first.streamId);
  return { outcome: 'not_your_day', message: `Your ${first.streamName.toLowerCase()} is collected ${howOften(w.stream, w.weekday)}${w.stream.season_start ? ' in season' : ''}; the next one is ${dayWords(first)}.`, zone: z, next: { date: first.date, stream: first.streamName, moved: first.moved } };
}
/**
 * Route progress for the check, from the Collection routes add-on when it is on and its library answers
 * (lib/collectionroutes.js routeCheck(conn, tenantId, { streetId, houseNo, streamId, date }) -> null or
 * { outcome: 'not_yet' | 'done' | 'skipped', at?, reason? }). null when there is none, so the check falls back to the clock.
 */
const ROUTE_WORDS = {
  not_yet: () => 'The truck is still on its route today.',
  done: (r) => `The crew marked your street done${r.at ? ` at ${String(r.at).slice(11, 16)}` : ''}. Tell us what was missed and we will send someone back.`,
  skipped: (r) => `The crew could not collect on your street${r.reason ? `: ${r.reason}` : ''}. You can still report it.`,
};
async function routeStatus(conn, tenantId, args) {
  if (!args.items.length) return null;
  let R;
  try { R = require('./collectionroutes'); } catch (_) { return null; }
  if (!R || typeof R.routeCheck !== 'function') return null;
  if (!(await require('./modules').stateOf(tenantId)).on.has('collectionroutes')) return null;
  const it = args.items[args.items.length - 1];
  let r;
  try { r = await R.routeCheck(conn, tenantId, { streetId: args.streetId, houseNo: args.houseNo, streamId: it.streamId, date: it.date }); } catch (_) { return null; }
  if (!r || !ROUTE_WORDS[r.outcome]) return null;
  return { outcome: r.outcome, message: r.message || ROUTE_WORDS[r.outcome](r), ...(r.at ? { at: r.at } : {}), ...(r.reason ? { reason: r.reason } : {}) };
}

// ---------------------------------------------------------------- holidays and zones as street areas
/**
 * The US federal holidays of a year as observed (a Saturday holiday on the Friday before, a Sunday one on the Monday
 * after): [{ on_date, name }]. A borough removes the ones its crews work.
 */
function federalHolidays(year) {
  const y = Number(year);
  const iso = (m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const observed = (d) => { const w = isoDay(d); return w === 6 ? addDays(d, -1) : w === 7 ? addDays(d, 1) : d; };
  const nth = (m, weekday, n) => { let d = iso(m, 1); while (isoDay(d) !== weekday) d = addDays(d, 1); return addDays(d, 7 * (n - 1)); };
  const last = (m, weekday) => { let d = addDays(iso(m + 1 > 12 ? 1 : m + 1, 1).replace(/^\d{4}/, String(m + 1 > 12 ? y + 1 : y)), -1); while (isoDay(d) !== weekday) d = addDays(d, -1); return d; };
  return [
    [observed(iso(1, 1)), 'New Year\'s Day'], [nth(1, 1, 3), 'Martin Luther King Jr. Day'], [nth(2, 1, 3), 'Presidents\' Day'], [last(5, 1), 'Memorial Day'],
    [observed(iso(6, 19)), 'Juneteenth'], [observed(iso(7, 4)), 'Independence Day'], [nth(9, 1, 1), 'Labor Day'], [nth(10, 1, 2), 'Columbus Day'],
    [observed(iso(11, 11)), 'Veterans Day'], [nth(11, 4, 4), 'Thanksgiving Day'], [observed(iso(12, 25)), 'Christmas Day'],
  ].map(([onDate, name]) => ({ on_date: onDate, name }));
}

/** The streets of these zones as street notice areas: [{ street_id, from_no, to_no, side }] (lib/streetnotices.js). */
async function zoneAreas(conn, tenantId, zoneIds) {
  const ids = asList(zoneIds);
  if (!ids.length) return [];
  return (await rows(conn, `SELECT DISTINCT r.street_id, r.from_no, r.to_no, r.side FROM collection_zone_streets r JOIN collection_zones z ON z.tenant_id = r.tenant_id AND z.id = r.zone_id
    WHERE r.tenant_id = ? AND r.zone_id IN (?) AND r.not_collected = 0 ORDER BY r.street_id, r.from_no`, [tenantId, ids]))
    .map((r) => ({ street_id: Number(r.street_id), from_no: r.from_no === null ? null : Number(r.from_no), to_no: r.to_no === null ? null : Number(r.to_no), side: r.side || 'both' }));
}

// ---------------------------------------------------------------- Today cards (other workstreams add theirs)
const TODAY = [];
/** Another part of the app adds Today cards to Trash and recycling's: fn(req) returns cards (lib/today.js card shape). */
const addTodayCards = (fn) => { TODAY.push(fn); };
/** Every registered maker's cards for this request, in the order they registered. A maker that fails adds nothing. */
async function todayCards(req) {
  const out = [];
  for (const fn of TODAY) { try { out.push(...((await fn(req)) || [])); } catch (err) { console.error(`[collection] a Today card failed: ${err && err.message}`); } }
  return out;
}

module.exports = {
  DAY_NAMES, KINDS, KIND_WORDS, FREQUENCIES, REASON_WORDS, SEND_OK, LATE_DAYS,
  zoneFor, collectionDays, nextFor, dayRoutes, requireAddon,
  pickupCheck, howOften, dayWords, longDay, settingsOf, streamsOf, zoneDaysOf, houseNumber, covers, isoDay, mondayOf, inSeason, runsOn, todayFor, tzOf, asList, isDate,
  addTodayCards, todayCards, federalHolidays, zoneAreas,
};
