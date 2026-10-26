'use strict';

// Conditions at the time of a patrol case: what the mountain's own records said when it happened. The trail and its
// grooming, the latest snow reading and weather reading, and the lift when one was involved. Saved on the case as a
// snapshot (incidents.conditions) when the case is opened, and taken again if the time, trail or lift changes while the
// report is still a draft, so the report keeps what was known then even after the records move on.
//
// Times in these tables are the mountain's wall clock, like occurred_at. A trail's or lift's open/closed status has no
// history, so it is only kept when the case is opened within three hours of the incident.
const { one } = require('../db');

const FRESH_MIN = 180; // how close to "now" the incident must be for current trail and lift status to count
const toMs = (s) => Date.parse(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);
const minus = (s, min) => new Date(toMs(s) - min * 60000).toISOString().slice(0, 19).replace('T', ' ');
const str = (v) => (v === null || v === undefined ? null : String(v).replace('T', ' ').slice(0, 19));
/** '2026-12-05 09:40:00' as '9:40 AM'. */
const clock = (v) => { const [hh, mm] = String(v).slice(11, 16).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * The snapshot for a case at `at` (its occurred_at), taken `now` (the mountain's current time). trailId and liftId may
 * be empty. Every part is null when there is no record close enough to the time.
 */
async function snapshot(db, t, { at, trailId = null, liftId = null, now }) {
  const fresh = Math.abs(toMs(now) - toMs(at)) <= FRESH_MIN * 60000;
  const out = { for_time: str(at), taken_at: str(now), trail: null, snow: null, weather: null, lift: null };
  if (trailId) {
    const tr = await one(db, 'SELECT id, name, difficulty, status, groomed FROM trails WHERE tenant_id = ? AND id = ?', [t, trailId]);
    if (tr) {
      // Groomed: a finished grooming run on this trail in the 24 hours before; or planned for that night and not done.
      const g = await one(db, "SELECT shift, finished_at FROM groom_plans WHERE tenant_id = ? AND trail_id = ? AND status = 'done' AND finished_at <= ? AND finished_at >= ? ORDER BY finished_at DESC LIMIT 1", [t, trailId, at, minus(at, 24 * 60)]);
      const planned = g ? null : await one(db, "SELECT status FROM groom_plans WHERE tenant_id = ? AND trail_id = ? AND plan_date BETWEEN DATE(?) - INTERVAL 1 DAY AND DATE(?) LIMIT 1", [t, trailId, at, at]);
      const check = await one(db, 'SELECT checked_at, hazards FROM trail_checks WHERE tenant_id = ? AND trail_id = ? AND checked_at <= ? AND checked_at >= ? ORDER BY checked_at DESC LIMIT 1', [t, trailId, at, minus(at, 24 * 60)]);
      out.trail = {
        id: Number(tr.id), name: tr.name, difficulty: tr.difficulty,
        status: fresh ? tr.status : null,
        groomed: g ? { at: str(g.finished_at), shift: g.shift } : planned ? false : fresh ? Boolean(Number(tr.groomed)) : null,
        checked: check ? { at: str(check.checked_at), hazards: check.hazards || null } : null,
      };
    }
  }
  // Snow: the trail's own reading first, then the mountain's, from the 36 hours before.
  const snow = await one(db, `SELECT trail_id, read_at, base_in, new_snow_in, surface, quality FROM snow_readings WHERE tenant_id = ? AND read_at <= ? AND read_at >= ? AND (trail_id IS NULL ${trailId ? 'OR trail_id = ?' : ''})
    ORDER BY ${trailId ? '(trail_id <=> ?) DESC, ' : ''}read_at DESC LIMIT 1`, trailId ? [t, at, minus(at, 36 * 60), trailId, trailId] : [t, at, minus(at, 36 * 60)]);
  if (snow) out.snow = { at: str(snow.read_at), on_trail: Boolean(snow.trail_id), base_in: num(snow.base_in), new_snow_in: num(snow.new_snow_in), surface: snow.surface || null, quality: snow.quality || null };
  const w = await one(db, 'SELECT logged_at, place, temp_f, wind_mph, gust_mph, wind_dir, sky, precip_in FROM weather_logs WHERE tenant_id = ? AND logged_at <= ? AND logged_at >= ? ORDER BY logged_at DESC LIMIT 1', [t, at, minus(at, 12 * 60)]);
  if (w) out.weather = { at: str(w.logged_at), place: w.place, temp_f: num(w.temp_f), wind_mph: num(w.wind_mph), gust_mph: num(w.gust_mph), wind_dir: w.wind_dir || null, sky: w.sky || null, precip_in: num(w.precip_in) };
  if (liftId) {
    const l = await one(db, 'SELECT id, name, status FROM lifts WHERE tenant_id = ? AND id = ?', [t, liftId]);
    if (l) {
      // A stop under way at the time, or one that started in the hour before.
      const stop = await one(db, 'SELECT started_at, ended_at, reason, note FROM lift_downtime WHERE tenant_id = ? AND lift_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC LIMIT 1', [t, liftId, at, minus(at, 60)]);
      // A real evacuation of this lift within three hours either side.
      const evac = await one(db, "SELECT id, started_at, ended_at, guests FROM patrol_lift_evacs WHERE tenant_id = ? AND lift_id = ? AND kind <> 'drill' AND started_at <= ? AND COALESCE(ended_at, started_at) >= ? ORDER BY started_at DESC LIMIT 1", [t, liftId, minus(at, -180), minus(at, 180)]);
      out.lift = {
        id: Number(l.id), name: l.name, status: fresh ? l.status : null,
        stop: stop ? { started_at: str(stop.started_at), ended_at: str(stop.ended_at), reason: stop.reason, note: stop.note || null } : null,
        evac: evac ? { id: Number(evac.id), started_at: str(evac.started_at), ended_at: str(evac.ended_at), guests: num(evac.guests) } : null,
      };
    }
  }
  return out;
}

/** The snapshot as stored on the case (JSON), or null. */
function parse(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Answers the report's Conditions section can take from the snapshot, for the patroller to confirm (never filled in
 * without them): weather, temperature, new snow and surface, in the NSAA form's own choices.
 */
function suggest(s) {
  if (!s) return {};
  const out = {};
  const w = s.weather;
  if (w && w.sky) {
    const sky = { clear: 'clear', partly: 'clear', overcast: 'overcast', snow: 'snowing', rain: 'raining', mixed: 'snowing', fog: 'fog' }[w.sky];
    if (sky) out.weather = { value: sky, from: `weather log, ${clock(w.at)}` };
  }
  if (w && w.temp_f !== null) {
    const f = w.temp_f;
    const v = f > 50 ? 'above_10' : f >= 32 ? '0_to_10' : f >= 14 ? 'minus10_to_0' : f >= -4 ? 'minus20_to_minus11' : 'below_minus20';
    out.temperature = { value: v, from: `weather log, ${f} °F` };
  }
  if (s.snow && s.snow.new_snow_in !== null) {
    const n = s.snow.new_snow_in;
    const v = n <= 0 ? 'none' : n <= 2 ? '0_to_5' : n <= 4 ? '5_to_10' : n <= 6 ? '10_to_15' : 'over_15';
    out.snow = { value: v, from: `snow reading, ${n} in new` };
  }
  if (s.trail && s.trail.groomed && typeof s.trail.groomed === 'object') out.surface = { value: 'groomed', from: `groomed, finished ${clock(s.trail.groomed.at)}` };
  return out;
}

module.exports = { snapshot, parse, suggest, clock, FRESH_MIN };
