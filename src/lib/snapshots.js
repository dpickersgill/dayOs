'use strict';

// Forecast data (ai/data): what each morning looked like, written down by the daily job so next season's demand
// forecast, pricing and staffing can learn from it. One row per mountain, kind and day, kept 3 years:
//
//   presales  for each of the next 14 days: lift tickets, lessons (by product and age band), rentals and online shop
//             orders sold so far, and the share bought online
//   forecast  the hourly weather forecast for the next 72 hours at the mountain (base and summit when both are set,
//             otherwise the map point), as it stood that morning (Open-Meteo, the same service as lib/dayrecord.js)
//   staffing  today's shifts by department, and hours worked yesterday by department
//   prices    the online, day-first ticket prices offered for each of the next 14 days, by product and guest type
//
// Snapshots hold counts, prices and weather only: never a name, email, phone or a person's id (test/snapshots.test.js
// checks every kind). The morning brief reads them with latest(); scripts/snapshot-backfill.js rebuilds what the
// tables allow for the past season, marked backfilled. SNAPSHOTS=off skips the daily run (other tests run the daily job
// against hundreds of mountains).
const { pool, rows, one } = require('../db');
const { addDays, dayRange, weekdayOf } = require('./util');
const { logFailure } = require('./jobs');
const { allowedOn } = require('./saledays');
const { priceFrom } = require('./pricing');

const KINDS = ['presales', 'forecast', 'staffing', 'prices'];
const DAYS_AHEAD = 14;
const FORECAST_HOURS = 72;
const KEEP_YEARS = 3;
const TIERS = ['child', 'youth', 'adult', 'senior']; // the guest types the online shop prices (lib/shopsale.js dayMenu)
const TICKET_KINDS = ['day_ticket', 'multi_day'];
const BUDGET_MS = () => Number(process.env.SNAPSHOT_BUDGET_SECONDS || 240) * 1000; // well inside the daily job's 900 seconds
const CONCURRENCY = 3; // mountains at a time: each runs its queries one after another, so the pool keeps room for the app

// ---------------------------------------------------------------- time
/** The mountain's date ('YYYY-MM-DD') at an instant. */
function dateIn(timeZone, at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
/** An instant as the database stores it (UTC, 'YYYY-MM-DD HH:MM:SS'). */
const dbTime = (at) => at.toISOString().slice(0, 19).replace('T', ' ');
const dstr = (d) => String(d).slice(0, 10);
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** The lesson's age band, as a short key: '4-12', '18+', 'to 6', or 'all'. */
function ageBand(min, max) {
  const a = num(min); const b = num(max);
  if (a !== null && b !== null) return `${a}-${b}`;
  if (a !== null) return `${a}+`;
  if (b !== null) return `to ${b}`;
  return 'all';
}

// ---------------------------------------------------------------- presales
/**
 * Everything sold or booked for days from..to, with when it was sold, in one pass (the backfill asks for a whole season
 * once). Only what is needed to count: no person, contact or order number leaves this function.
 */
async function presaleRows(db, tenantId, from, to) {
  const [items, lessons, holds] = await Promise.all([
    rows(db, `SELECT i.line_kind, i.valid_on, i.product_id, p.name AS product, i.quantity, o.channel, o.id AS order_ref, o.created_at, i.refunded_at
      FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id LEFT JOIN products p ON p.id = i.product_id AND p.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.valid_on BETWEEN ? AND ? AND i.line_kind NOT IN ('gift_card','fee') AND o.status IN ('paid','refunded')`, [tenantId, from, to]),
    // A booking is a lesson sold; it counts as online when an online order paid for that place.
    rows(db, `SELECT LEFT(s.starts_at, 10) AS on_date, s.product_id, p.name AS product, s.age_min, s.age_max, b.created_at,
        EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
          WHERE oi.tenant_id = b.tenant_id AND oi.session_id = b.session_id AND oi.person_id = b.person_id AND oi.line_kind = 'lesson' AND o.channel = 'online') AS online
      FROM lesson_bookings b JOIN lesson_sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id LEFT JOIN products p ON p.id = s.product_id AND p.tenant_id = s.tenant_id
      WHERE b.tenant_id = ? AND s.starts_at >= ? AND s.starts_at < ? AND s.status <> 'cancelled' AND b.status <> 'cancelled'`, [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]),
    rows(db, "SELECT pickup_on, created_at FROM rental_reservations WHERE tenant_id = ? AND pickup_on BETWEEN ? AND ? AND status <> 'cancelled'", [tenantId, from, to]),
  ]);
  return { items, lessons, holds };
}

/**
 * The presale counts for the 14 days from onDate, as sold before asOf (UTC 'YYYY-MM-DD HH:MM:SS'). Pure: works on rows
 * from presaleRows. A refund given after asOf still counts as sold at asOf. Lessons and reservations cancelled later
 * cannot be told apart from ones never made, so a rebuilt past is a little low on those.
 */
function presalesFrom(r, onDate, asOf) {
  const last = addDays(onDate, DAYS_AHEAD - 1);
  const days = new Map();
  for (let d = onDate, i = 0; d <= last; d = addDays(d, 1), i += 1) {
    days.set(d, { date: d, days_ahead: i, tickets: { sold: 0, online: 0, by_product: {} }, lessons: { sold: 0, online: 0, by_product: [] },
      rentals: { sold: 0, online: 0, reserved: 0 }, online_orders: 0, online_share: null, _orders: new Set(), _lessons: new Map() });
  }
  const sold = (createdAt, refundedAt) => String(createdAt) < asOf && (!refundedAt || String(refundedAt) >= asOf);
  for (const it of r.items) {
    const d = days.get(dstr(it.valid_on));
    if (!d || !sold(it.created_at, it.refunded_at)) continue;
    const q = Number(it.quantity) || 0; const online = it.channel === 'online';
    if (online) d._orders.add(it.order_ref);
    if (it.line_kind === 'ticket') {
      d.tickets.sold += q; if (online) d.tickets.online += q;
      const k = String(it.product_id || 0);
      const p = d.tickets.by_product[k] || (d.tickets.by_product[k] = { product: it.product || 'Other', sold: 0 });
      p.sold += q;
    } else if (it.line_kind === 'rental') {
      d.rentals.sold += q; if (online) d.rentals.online += q;
    }
  }
  for (const b of r.lessons) {
    const d = days.get(dstr(b.on_date));
    if (!d || !(String(b.created_at) < asOf)) continue;
    const band = ageBand(b.age_min, b.age_max);
    const k = `${b.product_id}|${band}`;
    const l = d._lessons.get(k) || { product_id: Number(b.product_id), product: b.product || 'Lesson', age_band: band, sold: 0, online: 0 };
    l.sold += 1; d.lessons.sold += 1;
    if (Number(b.online)) { l.online += 1; d.lessons.online += 1; }
    d._lessons.set(k, l);
  }
  for (const h of r.holds) {
    const d = days.get(dstr(h.pickup_on));
    if (d && String(h.created_at) < asOf) d.rentals.reserved += 1;
  }
  const out = [];
  for (const d of days.values()) {
    d.online_orders = d._orders.size;
    d.lessons.by_product = [...d._lessons.values()].sort((a, b) => a.product.localeCompare(b.product) || a.age_band.localeCompare(b.age_band));
    d.tickets.by_product = Object.entries(d.tickets.by_product).map(([id, p]) => ({ product_id: Number(id), product: p.product, sold: p.sold }));
    const all = d.tickets.sold + d.lessons.sold + d.rentals.sold;
    d.online_share = all ? Math.round(((d.tickets.online + d.lessons.online + d.rentals.online) / all) * 1000) / 1000 : null;
    delete d._orders; delete d._lessons;
    out.push(d);
  }
  return { as_of: `${asOf.replace(' ', 'T')}Z`, days: out };
}

async function presales(db, t, { onDate, asOf }) {
  return presalesFrom(await presaleRows(db, t.id, onDate, addDays(onDate, DAYS_AHEAD - 1)), onDate, asOf);
}

// ---------------------------------------------------------------- weather
/** The points to ask about: base and summit when both are set, otherwise the one point there is, and which it is. */
function weatherPoints(t) {
  const has = (a, b) => a !== null && a !== undefined && b !== null && b !== undefined;
  const base = has(t.map_lat, t.map_lng) ? { lat: Number(t.map_lat), lng: Number(t.map_lng) } : null;
  const top = has(t.wx_summit_lat, t.wx_summit_lng) ? { lat: Number(t.wx_summit_lat), lng: Number(t.wx_summit_lng) } : null;
  if (base && top) return [{ role: 'base', ...base }, { role: 'summit', ...top }];
  if (base) return [{ role: 'map_point', ...base }];
  if (top) return [{ role: 'summit', ...top }];
  return [];
}

class Skipped extends Error {}

// The weather breaker (lib/wxrun.js): after 3 failed lookups in one run the rest of the run stops asking (each can wait
// 10 seconds). The daily job shares one run between the day records, these snapshots and the morning brief.
const WX = require('./wxrun');

async function forecast(db, t, { now, run = null }) {
  const dayrecord = require('./dayrecord');
  if (!dayrecord.weatherOn()) throw new Skipped('weather lookup is off');
  const points = weatherPoints(t);
  if (!points.length) throw new Skipped('no map point set');
  if (WX.down(run)) throw new Error('weather service not answering: not asked again this run');
  const got = await dayrecord.fetchHourly(points, t.timezone, { hours: FORECAST_HOURS, run }); // a failure counts against the run
  if (!got) throw new Error('hourly weather lookup failed');
  return { source: 'open-meteo', resolution: 'hourly', hours: FORECAST_HOURS, timezone: t.timezone, as_of: now.toISOString(),
    units: { temp: 'F', precip: 'in', snow: 'in', wind: 'mph' }, points: got };
}

/** The backfill's stand-in: the day record's daily weather for the 3 days from onDate (what was seen, not forecast). */
async function forecastFromRecords(db, t, onDate) {
  const recs = await rows(db, 'SELECT on_date, high_f, low_f, snowfall_in, precip_in, wind_mph, gust_mph, weather_code FROM day_records WHERE tenant_id = ? AND on_date BETWEEN ? AND ? AND weather_source IS NOT NULL ORDER BY on_date', [t.id, onDate, addDays(onDate, 2)]);
  if (!recs.length) return null;
  return { source: 'day_record', resolution: 'daily', timezone: t.timezone, units: { temp: 'F', precip: 'in', snow: 'in', wind: 'mph' },
    points: [{ role: 'map_point', lat: num(t.map_lat), lng: num(t.map_lng), elevation_m: null }],
    days: recs.map((r) => ({ date: dstr(r.on_date), high_f: num(r.high_f), low_f: num(r.low_f), snow_in: num(r.snowfall_in), precip_in: num(r.precip_in), wind_mph: num(r.wind_mph), gust_mph: num(r.gust_mph), weather_code: num(r.weather_code) })) };
}

// ---------------------------------------------------------------- staffing
const round1 = (v) => Math.round(Number(v || 0) * 10) / 10;
/** Today's shifts by department (shifts are on the mountain's clock) and yesterday's hours worked (clocked in UTC). */
async function staffing(db, t, { onDate }) {
  const from = `${onDate} 00:00:00`; const to = `${addDays(onDate, 1)} 00:00:00`;
  const [yFrom, yTo] = dayRange(t.timezone, addDays(onDate, -1));
  const shifts = await rows(db, `SELECT p.department, COUNT(*) AS shifts, SUM(s.staff_id IS NULL) AS unfilled, SUM(s.status = 'published') AS published,
      SUM(TIMESTAMPDIFF(MINUTE, s.starts_at, s.ends_at)) AS minutes
    FROM shifts s JOIN positions p ON p.id = s.position_id AND p.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND s.starts_at >= ? AND s.starts_at < ? GROUP BY p.department`, [t.id, from, to]);
  const patrol = await one(db, `SELECT COUNT(*) AS shifts, SUM(staff_id IS NULL) AS unfilled, SUM(status = 'published') AS published, SUM(TIMESTAMPDIFF(MINUTE, starts_at, ends_at)) AS minutes
    FROM patrol_shifts WHERE tenant_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?`, [t.id, from, to]).catch(() => null);
  const worked = await rows(db, `SELECT COALESCE(p.department, IF(e.patrol_shift_id IS NULL, 'unscheduled', 'patrol')) AS department,
      COUNT(*) AS entries, COUNT(DISTINCT e.staff_id) AS headcount, SUM(TIMESTAMPDIFF(SECOND, e.clock_in, e.clock_out)) AS seconds
    FROM time_entries e LEFT JOIN shifts s ON s.id = e.shift_id AND s.tenant_id = e.tenant_id LEFT JOIN positions p ON p.id = s.position_id AND p.tenant_id = s.tenant_id
    WHERE e.tenant_id = ? AND e.clock_out IS NOT NULL AND e.clock_in >= ? AND e.clock_in < ? GROUP BY 1`, [t.id, yFrom, yTo]);
  const today = {};
  for (const s of shifts) today[s.department] = { shifts: Number(s.shifts), unfilled: Number(s.unfilled || 0), published: Number(s.published || 0), hours: round1(Number(s.minutes || 0) / 60) };
  if (patrol && Number(patrol.shifts)) {
    const p = today.patrol || { shifts: 0, unfilled: 0, published: 0, hours: 0 };
    today.patrol = { shifts: p.shifts + Number(patrol.shifts), unfilled: p.unfilled + Number(patrol.unfilled || 0), published: p.published + Number(patrol.published || 0), hours: round1(p.hours + Number(patrol.minutes || 0) / 60) };
  }
  const yesterday = {};
  for (const w of worked) yesterday[w.department] = { entries: Number(w.entries), headcount: Number(w.headcount), hours: round1(Number(w.seconds || 0) / 3600) };
  const sum = (o, k) => round1(Object.values(o).reduce((a, x) => a + x[k], 0));
  return { date: onDate, today: { by_department: today, shifts: sum(today, 'shifts'), unfilled: sum(today, 'unfilled'), hours: sum(today, 'hours') },
    yesterday: { date: addDays(onDate, -1), by_department: yesterday, hours: sum(yesterday, 'hours'), headcount: Object.values(yesterday).reduce((a, x) => a + x.headcount, 0) } };
}

// ---------------------------------------------------------------- prices
/** The early-buy price as the shop works it out (lib/shopsale.js advance): percent off when the day is far enough ahead. */
function online(product, today, day, cents) {
  const days = Number(product.advance_days); const pct = Number(product.advance_percent);
  if (!days || !pct || pct > 90) return { cents, early: false };
  const gap = Math.round((new Date(`${day}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 864e5);
  if (gap < days) return { cents, early: false };
  return { cents: cents - Math.round(cents * pct / 100), early: true };
}

/** The online ticket prices for the next 14 days, by product and guest type, in a few queries (like the shop's month view). */
async function prices(db, t, { onDate }) {
  const last = addDays(onDate, DAYS_AHEAD - 1);
  const prods = await rows(db, `SELECT id, kind, name, base_price_cents, valid_days, sale_days, advance_days, advance_percent FROM products
    WHERE tenant_id = ? AND active = 1 AND online = 1 AND kind IN (?) ORDER BY FIELD(kind, 'day_ticket','multi_day'), name, id`, [t.id, TICKET_KINDS]);
  const ids = prods.map((p) => p.id);
  const cal = ids.length ? await rows(db, 'SELECT product_id, on_date, tier, price_cents, blackout FROM price_calendar WHERE tenant_id = ? AND product_id IN (?) AND on_date BETWEEN ? AND ?', [t.id, ids, onDate, last]) : [];
  const tiers = ids.length ? await rows(db, 'SELECT product_id, tier, price_cents FROM price_tiers WHERE tenant_id = ? AND product_id IN (?)', [t.id, ids]) : [];
  const calOn = new Map();
  for (const c of cal) { const k = `${c.product_id}|${dstr(c.on_date)}`; if (!calOn.has(k)) calOn.set(k, []); calOn.get(k).push(c); }
  const tierOf = new Map(tiers.map((x) => [`${x.product_id}|${x.tier}`, x.price_cents]));
  const days = [];
  for (let d = onDate, i = 0; d <= last; d = addDays(d, 1), i += 1) {
    const by = [];
    for (const p of prods) {
      if (!allowedOn(p.sale_days, d)) { by.push({ product_id: p.id, status: 'not_sold' }); continue; }
      const dayCal = calOn.get(`${p.id}|${d}`) || [];
      if (dayCal.some((c) => c.blackout && c.tier === null)) { by.push({ product_id: p.id, status: 'blackout' }); continue; }
      const out = { product_id: p.id, status: 'on_sale', cents: {}, list_cents: {}, early: false };
      for (const tier of TIERS) {
        const pr = priceFrom(p, dayCal, tierOf.has(`${p.id}|${tier}`) ? tierOf.get(`${p.id}|${tier}`) : null, tier);
        if (pr.blackout) continue;
        const o = online(p, onDate, d, pr.cents);
        out.cents[tier] = o.cents; out.list_cents[tier] = pr.cents; out.early = out.early || o.early;
      }
      by.push(out);
    }
    days.push({ date: d, days_ahead: i, weekday: weekdayOf(d), by_product: by });
  }
  return { products: prods.map((p) => ({ product_id: p.id, product: p.name, kind: p.kind, valid_days: Number(p.valid_days), early_days: num(p.advance_days), early_percent: num(p.advance_percent) })), days };
}

const BUILD = { presales, forecast, staffing, prices };

// ---------------------------------------------------------------- storage
/**
 * Writes one snapshot. A live one replaces that day's row; a backfilled one is written only where nothing live is,
 * so the backfill can run any number of times and never overwrites what the daily job took.
 */
async function save(db, tenantId, onDate, kind, data, { backfilled = false, takenAt = null } = {}) {
  const json = JSON.stringify(data);
  if (backfilled) {
    await db.query(`INSERT INTO daily_snapshots (tenant_id, on_date, kind, taken_at, backfilled, data) VALUES (?, ?, ?, ?, 1, ?)
      ON DUPLICATE KEY UPDATE data = IF(backfilled = 1, VALUES(data), data), taken_at = IF(backfilled = 1, VALUES(taken_at), taken_at)`, [tenantId, onDate, kind, takenAt || dbTime(new Date()), json]);
  } else {
    await db.query(`INSERT INTO daily_snapshots (tenant_id, on_date, kind, taken_at, backfilled, data) VALUES (?, ?, ?, ?, 0, ?)
      ON DUPLICATE KEY UPDATE data = VALUES(data), taken_at = VALUES(taken_at), backfilled = 0`, [tenantId, onDate, kind, takenAt || dbTime(new Date()), json]);
  }
}

const tenantRow = (db, tenantId) => one(db, 'SELECT id, timezone, map_lat, map_lng, wx_summit_lat, wx_summit_lng FROM tenants WHERE id = ?', [tenantId]);

/**
 * Takes one kind of snapshot for one mountain now (opts.now: another instant, for tests), on the mountain's date.
 * Returns { kind, on_date, status: 'taken' | 'skipped', reason? }. Throws when the kind failed (the caller isolates it).
 */
async function take(db, tenantId, kind, { now = new Date(), tenant = null, run = null } = {}) {
  if (!BUILD[kind]) throw new Error(`unknown snapshot kind ${kind}`);
  const t = tenant || await tenantRow(db, tenantId);
  if (!t) throw new Error('no such mountain');
  const onDate = dateIn(t.timezone, now);
  try {
    const data = await BUILD[kind](db, t, { onDate, asOf: dbTime(now), now, run });
    await save(db, t.id, onDate, kind, data, { takenAt: dbTime(now) });
    return { kind, on_date: onDate, status: 'taken' };
  } catch (err) {
    if (err instanceof Skipped) return { kind, on_date: onDate, status: 'skipped', reason: err.message };
    throw err;
  }
}

/** Every kind for one mountain, each on its own: one failing is logged and the others are still taken. */
async function takeAll(db, t, { now = new Date(), kinds = KINDS, run = null } = {}) {
  // The weather lookup waits on the network, not the database, so it runs beside the others.
  const one1 = async (kind) => {
    try { return await take(db, t.id, kind, { now, tenant: t, run }); } catch (err) {
      logFailure({ job: 'snapshots', tenant: t.id, kind, message: err.message });
      return { kind, status: 'failed', reason: err.message };
    }
  };
  const wx = kinds.includes('forecast') ? one1('forecast') : null;
  const out = [];
  for (const k of kinds.filter((x) => x !== 'forecast')) out.push(await one1(k));
  if (wx) out.push(await wx);
  return out;
}

/**
 * The morning run, from the daily job: every real mountain, a few at a time, inside a time budget (SNAPSHOT_BUDGET_SECONDS,
 * 240 by default). Mountains not reached in time are counted and logged, and the job carries on. After 3 failed weather
 * lookups the rest of the run does not ask again. Logs how long it took.
 */
async function runAll({ only = null, now = new Date(), budgetMs = BUDGET_MS(), concurrency = CONCURRENCY, run = WX.newRun() } = {}) {
  if (String(process.env.SNAPSHOTS || 'on').toLowerCase() === 'off') return { skipped: true };
  const started = Date.now();
  const tenants = await rows(pool, `SELECT id, timezone, map_lat, map_lng, wx_summit_lat, wx_summit_lng FROM tenants
    WHERE status = 'active' AND sandbox_expires_at IS NULL${only ? ' AND id = ?' : ''} ORDER BY id`, only ? [Number(only)] : []);
  const out = { mountains: tenants.length, taken: 0, skipped: 0, failed: 0, not_reached: 0, seconds: 0 };
  let next = 0;
  // run: shared by this run's mountains (and the daily job's other weather stages): a service that is down is not waited on 500 times
  const worker = async () => {
    while (next < tenants.length) {
      if (Date.now() - started > budgetMs) return;
      const t = tenants[next++];
      for (const r of await takeAll(pool, t, { now, run })) out[r.status === 'taken' ? 'taken' : r.status === 'skipped' ? 'skipped' : 'failed'] += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  out.not_reached = tenants.length - Math.min(next, tenants.length);
  out.seconds = Math.round((Date.now() - started) / 100) / 10;
  if (out.not_reached) logFailure({ job: 'snapshots', message: `time budget reached: ${out.not_reached} mountain(s) not reached today` });
  console.log(JSON.stringify({ severity: 'INFO', job: 'snapshots', message: 'snapshots taken', ...out }));
  return out;
}

/** Deletes snapshots older than 3 years (the daily job's retention run). */
async function purge(db = pool, { today = dbTime(new Date()).slice(0, 10) } = {}) {
  const [r] = await db.query('DELETE FROM daily_snapshots WHERE on_date < ? - INTERVAL ? YEAR LIMIT 50000', [today, KEEP_YEARS]);
  return r.affectedRows;
}

// ---------------------------------------------------------------- the backfill (scripts/snapshot-backfill.js)
/**
 * Rebuilds what the tables allow for one mountain, for each day from..to (default: the start of last season to
 * yesterday), as if taken when the day began on the mountain's clock. Marked backfilled; a day the daily job already took
 * is left alone, and running it again gives the same rows.
 *   presales  from when each order and booking was made (refunds count until they were given)
 *   forecast  the day record's weather for the day and the 2 after it: daily values seen, not an hourly forecast
 *   staffing  shifts as they stand now (a shift deleted since is gone) and the hours clocked the day before
 *   prices    not rebuilt: a price changed since is not kept, so the past prices cannot be known
 */
async function backfill(db, tenantId, { from = null, to = null } = {}) {
  const t = await tenantRow(db, tenantId);
  if (!t) throw new Error('no such mountain');
  const today = dateIn(t.timezone);
  const { seasonRange } = require('./guestvisits');
  const { seasonFor } = require('./util');
  const start = from || seasonRange(seasonFor(addDays(today, -365)))[0];
  let end = to || addDays(today, -1);
  if (end >= today) end = addDays(today, -1); // only finished days: today is the daily job's
  const out = { tenant: t.id, from: start, to: end, days: 0, presales: 0, forecast: 0, staffing: 0 };
  if (start > end) return out;
  const sales = await presaleRows(db, t.id, start, addDays(end, DAYS_AHEAD - 1));
  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await db.query(`INSERT INTO daily_snapshots (tenant_id, on_date, kind, taken_at, backfilled, data) VALUES ${batch.map(() => '(?, ?, ?, ?, 1, ?)').join(', ')}
      ON DUPLICATE KEY UPDATE data = IF(backfilled = 1, VALUES(data), data), taken_at = IF(backfilled = 1, VALUES(taken_at), taken_at)`, batch.flat());
    batch.length = 0;
  };
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const asOf = dayRange(t.timezone, d)[0];
    const add = async (kind, data) => { batch.push([t.id, d, kind, asOf, JSON.stringify(data)]); out[kind] += 1; if (batch.length >= 100) await flush(); };
    out.days += 1;
    await add('presales', presalesFrom(sales, d, asOf));
    const wx = await forecastFromRecords(db, t, d);
    if (wx) await add('forecast', wx);
    await add('staffing', await staffing(db, t, { onDate: d }));
  }
  await flush();
  return out;
}

// ---------------------------------------------------------------- reading
const parse = (r) => (r ? { on_date: dstr(r.on_date), kind: r.kind, taken_at: r.taken_at, backfilled: Boolean(Number(r.backfilled)), data: JSON.parse(r.data) } : null);

/**
 * The newest snapshot of a kind taken on or before onDate, or null. `stale` is true when it is from an earlier day
 * than onDate (today's was not taken), so a caller can decide to read live instead.
 */
async function latest(db, tenantId, onDate, kind) {
  const r = parse(await one(db, 'SELECT on_date, kind, taken_at, backfilled, data FROM daily_snapshots WHERE tenant_id = ? AND kind = ? AND on_date <= ? ORDER BY on_date DESC LIMIT 1', [tenantId, kind, onDate]));
  if (r) r.stale = r.on_date !== onDate;
  return r;
}

/** Snapshots of a kind for days from..to (inclusive), oldest first. */
async function range(db, tenantId, kind, from, to) {
  return (await rows(db, 'SELECT on_date, kind, taken_at, backfilled, data FROM daily_snapshots WHERE tenant_id = ? AND kind = ? AND on_date BETWEEN ? AND ? ORDER BY on_date', [tenantId, kind, from, to])).map(parse);
}

/** Which kinds were taken on each day from..to: [{ date, kinds: { presales: 'live' | 'backfilled', ... } }], newest first. */
async function coverage(db, tenantId, from, to) {
  const got = await rows(db, 'SELECT on_date, kind, backfilled FROM daily_snapshots WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date DESC', [tenantId, from, to]);
  const by = new Map();
  for (const g of got) { const d = dstr(g.on_date); if (!by.has(d)) by.set(d, {}); by.get(d)[g.kind] = Number(g.backfilled) ? 'backfilled' : 'live'; }
  const out = [];
  for (let d = to; d >= from; d = addDays(d, -1)) out.push({ date: d, kinds: by.get(d) || {} });
  return out;
}

module.exports = {
  KINDS, DAYS_AHEAD, FORECAST_HOURS, KEEP_YEARS, take, takeAll, runAll, purge, latest, range, coverage, save, backfill,
  presaleRows, presalesFrom, forecastFromRecords, staffing, weatherPoints, ageBand, dateIn, dbTime, tenantRow,
  _build: BUILD, // the tests swap one kind for a failing one
};
