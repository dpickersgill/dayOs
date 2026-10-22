'use strict';

// How each day went, written down every night (and, once, for the past year): the weather at the mountain, new snow,
// whether it was open, visits, tickets sold and sold ahead online, lesson students and revenue. This is the history the
// visitor forecast will learn from, so it is kept even when nobody looks at it.
//
// Weather comes from Open-Meteo for the mountain's map point (Settings, Map). The last few days use the forecast API,
// older days the historical archive; both answer a whole range of days in one request. Open-Meteo's free API is for
// non-commercial use: set OPEN_METEO_KEY to use the paid customer API. WEATHER=off turns the lookup off (the rest of
// the day is still recorded), and WEATHER_URL points it somewhere else (the tests use a local stand-in).
const { pool, one, rows } = require('../db');
const { todayIn, addDays, weekdayOf, dayRange } = require('./util');
const { dailyReport } = require('./daily');
const { eachTenant } = require('./jobs');

const DAILY = 'temperature_2m_max,temperature_2m_min,snowfall_sum,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,weather_code';
const RECENT_DAYS = 80; // the forecast API keeps about three months behind today; older days come from the archive

const weatherOn = () => String(process.env.WEATHER || 'on').toLowerCase() !== 'off';

/** Daily weather for a point between two dates (inclusive), as { 'YYYY-MM-DD': {...} }. Never throws: {} on any failure. */
async function fetchWeather(lat, lng, from, to, today) {
  if (!weatherOn() || lat === null || lng === null) return {};
  const key = process.env.OPEN_METEO_KEY || '';
  const archive = from < addDays(today, -RECENT_DAYS);
  const host = process.env.WEATHER_URL || (archive ? `https://${key ? 'customer-' : ''}archive-api.open-meteo.com` : `https://${key ? 'customer-' : ''}api.open-meteo.com`);
  const q = new URLSearchParams({ latitude: String(lat), longitude: String(lng), start_date: from, end_date: to, daily: DAILY,
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch', timezone: 'auto' });
  if (key) q.set('apikey', key);
  try {
    const res = await fetch(`${host}/v1/${archive ? 'archive' : 'forecast'}?${q}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`weather lookup answered ${res.status}`);
    const d = (await res.json()).daily || {};
    const out = {};
    const at = (k, i) => (Array.isArray(d[k]) && d[k][i] !== null && d[k][i] !== undefined ? Number(d[k][i]) : null);
    (d.time || []).forEach((day, i) => {
      out[day] = { high_f: at('temperature_2m_max', i), low_f: at('temperature_2m_min', i), snowfall_in: at('snowfall_sum', i), precip_in: at('precipitation_sum', i),
        wind_mph: at('wind_speed_10m_max', i), gust_mph: at('wind_gusts_10m_max', i), weather_code: at('weather_code', i) };
    });
    return out;
  } catch (err) {
    console.log(JSON.stringify({ severity: 'WARNING', job: 'day_records', message: `weather lookup failed: ${err.message}` }));
    return {};
  }
}

const n = (v) => (v === null || v === undefined ? null : Number(v));

/** Records one day for one mountain (replacing what was there), with weather already looked up (or null). */
async function recordDay(t, date, wx) {
  const [from, to] = dayRange(t.timezone, date);
  const [rep, cal, snow, base, sold, forDay, presold] = await Promise.all([
    dailyReport(t.id, date),
    one(pool, 'SELECT status FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [t.id, date]),
    one(pool, 'SELECT MAX(new_snow_in) AS v FROM snow_readings WHERE tenant_id = ? AND trail_id IS NULL AND DATE(read_at) = ?', [t.id, date]),
    one(pool, 'SELECT base_in AS v FROM snow_readings WHERE tenant_id = ? AND trail_id IS NULL AND base_in IS NOT NULL AND DATE(read_at) = ? ORDER BY read_at DESC, id DESC LIMIT 1', [t.id, date]),
    one(pool, `SELECT COALESCE(SUM(i.quantity), 0) AS v FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.line_kind = 'ticket' AND o.status IN ('paid','refunded') AND o.created_at >= ? AND o.created_at < ?`, [t.id, from, to]),
    one(pool, `SELECT COALESCE(SUM(i.quantity), 0) AS v FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.line_kind = 'ticket' AND i.valid_on = ? AND i.refunded_at IS NULL AND o.status IN ('paid','refunded')`, [t.id, date]),
    one(pool, `SELECT COALESCE(SUM(i.quantity), 0) AS v FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.line_kind = 'ticket' AND i.valid_on = ? AND i.refunded_at IS NULL AND o.channel = 'online' AND o.status IN ('paid','refunded') AND o.created_at < ?`, [t.id, date, from]),
  ]);
  const w = wx || {};
  const vals = {
    weekday: weekdayOf(date), status: cal ? cal.status : null,
    high_f: n(w.high_f), low_f: n(w.low_f), snowfall_in: n(w.snowfall_in), precip_in: n(w.precip_in), wind_mph: n(w.wind_mph), gust_mph: n(w.gust_mph), weather_code: n(w.weather_code),
    weather_source: wx ? 'open-meteo' : null,
    crew_new_snow_in: n(snow && snow.v), crew_base_in: n(base && base.v),
    visits: Number(rep.guests_scanned) || 0, tickets_sold: Number(sold.v) || 0, tickets_for_day: Number(forDay.v) || 0, presold_online: Number(presold.v) || 0,
    lesson_students: Number(rep.ski_school.students) || 0, revenue_cents: Number(rep.sales.revenue_cents) || 0,
  };
  const cols = Object.keys(vals);
  // A day already recorded with weather keeps it if this lookup came back empty.
  const keepWx = new Set(['high_f', 'low_f', 'snowfall_in', 'precip_in', 'wind_mph', 'gust_mph', 'weather_code', 'weather_source']);
  const update = cols.map((c) => (keepWx.has(c) && !wx ? `${c} = COALESCE(VALUES(${c}), ${c})` : `${c} = VALUES(${c})`)).join(', ');
  await pool.query(`INSERT INTO day_records (tenant_id, on_date, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${update}`,
    [t.id, date, ...cols.map((c) => vals[c])]);
  return vals;
}

/** Records every day from `from` to `to` (inclusive) for one mountain: one weather request per stretch. */
async function recordRange(tenantId, from, to) {
  const t = await one(pool, 'SELECT id, timezone, map_lat, map_lng, DATE(created_at) AS since FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  if (to >= today) to = addDays(today, -1); // only finished days
  if (from > to) return { days: 0, weather: 0 };
  const lat = t.map_lat === null ? null : Number(t.map_lat); const lng = t.map_lng === null ? null : Number(t.map_lng);
  // The archive and the forecast API cover different stretches; ask each for its part.
  const cut = addDays(today, -RECENT_DAYS);
  const wx = {};
  if (from < cut) Object.assign(wx, await fetchWeather(lat, lng, from, to < cut ? to : addDays(cut, -1), today));
  if (to >= cut) Object.assign(wx, await fetchWeather(lat, lng, from < cut ? cut : from, to, today));
  let days = 0; let weather = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    await recordDay(t, d, wx[d] || null);
    days += 1; if (wx[d]) weather += 1;
  }
  return { days, weather };
}

/**
 * The nightly run: the last three finished days for every real mountain (weather for the last day or two can still
 * settle). DAY_RECORDS=off skips it (the other tests run the daily job against a database of hundreds of mountains).
 */
async function runAll({ only } = {}) {
  if (String(process.env.DAY_RECORDS || 'on').toLowerCase() === 'off') return { skipped: true };
  return eachTenant('day_records', async (t) => {
    const today = todayIn(t.timezone);
    return recordRange(t.id, addDays(today, -3), addDays(today, -1));
  }, { columns: 'id, timezone', where: `sandbox_expires_at IS NULL${only ? ` AND id = ${Number(only)}` : ''}` });
}

/** Recorded days for the screen and, later, the forecast. */
async function list(tenantId, from, to) {
  return (await rows(pool, 'SELECT * FROM day_records WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date DESC', [tenantId, from, to])).map((r) => ({
    ...r, on_date: typeof r.on_date === 'string' ? r.on_date.slice(0, 10) : r.on_date.toISOString().slice(0, 10),
    ...Object.fromEntries(['high_f', 'low_f', 'snowfall_in', 'precip_in', 'wind_mph', 'gust_mph', 'crew_new_snow_in', 'crew_base_in'].map((k) => [k, n(r[k])])),
    revenue_cents: Number(r.revenue_cents),
  }));
}

module.exports = { fetchWeather, recordDay, recordRange, runAll, list };
