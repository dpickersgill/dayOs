'use strict';

// Shared patrol operations helpers: the mountain's patrol settings, who is on duty, and days patrolled this season.
const { rows, one } = require('../db');
const { nowIn, todayIn, addDays, seasonFor } = require('./util');

const DEFAULTS = {
  min_days: null, min_days_candidate: null, self_signup: false, remind_dates: '01-15,03-01', last_reminded: null,
  medical_director: null, protocol_version: null, sweep_late_minutes: 45, controlled_counts: false, avalanche: false,
  sms_critical: true, o2_refill_psi: 500, story_fill: false, signup_approval: false, short_alert: true, kit_seals: false,
};
const BOOLS = ['self_signup', 'controlled_counts', 'avalanche', 'sms_critical', 'story_fill', 'signup_approval', 'short_alert', 'kit_seals'];

async function settingsOf(db, t) {
  const s = await one(db, 'SELECT * FROM patrol_settings WHERE tenant_id = ?', [t]);
  const out = { ...DEFAULTS };
  if (s) for (const k of Object.keys(DEFAULTS)) if (s[k] !== undefined) out[k] = BOOLS.includes(k) ? Boolean(Number(s[k])) : s[k];
  for (const k of ['min_days', 'min_days_candidate', 'sweep_late_minutes', 'o2_refill_psi']) if (out[k] !== null) out[k] = Number(out[k]);
  return out;
}

const tzOf = async (db, t) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const clock = async (db, t) => { const tz = await tzOf(db, t); return { tz, now: nowIn(tz), today: todayIn(tz) }; };

/**
 * Close sign-ins left open from an earlier day (somebody forgot to sign out): at the end of their linked shift if it
 * ended that day, otherwise at 23:59:59 that day. They are marked auto_closed so the log shows it.
 */
async function closeStale(db, t, today) {
  const stale = await rows(db, `SELECT d.id, d.on_date, ps.ends_at FROM patrol_duty d LEFT JOIN patrol_shifts ps ON ps.tenant_id = d.tenant_id AND ps.id = d.patrol_shift_id
    WHERE d.tenant_id = ? AND d.signed_out_at IS NULL AND d.on_date < ?`, [t, today]);
  for (const d of stale) {
    const day = String(d.on_date).slice(0, 10);
    const end = d.ends_at && String(d.ends_at).slice(0, 10) === day ? d.ends_at : `${day} 23:59:59`;
    await db.query('UPDATE patrol_duty SET signed_out_at = ?, auto_closed = 1 WHERE tenant_id = ? AND id = ?', [end, t, d.id]);
  }
  return stale.length;
}

/** Everyone signed in right now (today, not signed out), with name, call sign, station and radio. */
async function onDuty(db, t) {
  const { today } = await clock(db, t);
  await closeStale(db, t, today);
  return rows(db, `SELECT d.id, d.staff_id, d.signed_in_at, d.station_id, d.radio, d.patrol_shift_id, d.source, st.name AS station,
      p.first_name, p.last_name, m.callsign, m.level, m.patrol_number, s.in_workforce
    FROM patrol_duty d JOIN staff s ON s.tenant_id = d.tenant_id AND s.id = d.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    LEFT JOIN patrol_members m ON m.tenant_id = d.tenant_id AND m.staff_id = d.staff_id
    LEFT JOIN patrol_stations st ON st.tenant_id = d.tenant_id AND st.id = d.station_id
    WHERE d.tenant_id = ? AND d.signed_out_at IS NULL AND d.on_date = ? ORDER BY p.last_name, p.first_name`, [t, today]);
}

/** Staff ids on duty now. */
const onDutyIds = async (db, t) => (await onDuty(db, t)).map((d) => Number(d.staff_id));

/**
 * Days and hours patrolled in a season (Aug 1 to Jul 31), per staff id. A day counts when the person signed in on duty,
 * posted on Today's posts, or (for days before sign-in was in use at this mountain) was on a published patrol shift that
 * has ended. Hours are signed-in time, or the shift's length on those earlier days.
 */
async function seasonDays(db, t, season) {
  const { now, today } = await clock(db, t);
  const start = `${season.slice(0, 4)}-08-01`; const end = `${Number(season.slice(0, 4)) + 1}-08-01`;
  const first = await one(db, 'SELECT MIN(on_date) AS d FROM patrol_duty WHERE tenant_id = ?', [t]);
  const cutoff = first && first.d ? String(first.d).slice(0, 10) : '9999-12-31'; // shifts count only before sign-in began
  const [duty, shifts, posts] = await Promise.all([
    rows(db, 'SELECT staff_id, on_date, signed_in_at, COALESCE(signed_out_at, ?) AS out_at FROM patrol_duty WHERE tenant_id = ? AND on_date >= ? AND on_date < ?', [now, t, start, end]),
    rows(db, `SELECT staff_id, starts_at, ends_at FROM patrol_shifts WHERE tenant_id = ? AND status = 'published' AND staff_id IS NOT NULL AND starts_at >= ? AND starts_at < ? AND ends_at <= ? AND DATE(starts_at) < ?
      UNION ALL
      SELECT s.staff_id, s.starts_at, s.ends_at FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id AND pos.department = 'patrol'
      WHERE s.tenant_id = ? AND s.status = 'published' AND s.staff_id IS NOT NULL AND s.starts_at >= ? AND s.starts_at < ? AND s.ends_at <= ? AND DATE(s.starts_at) < ?`, [t, start, end, now, cutoff, t, start, end, now, cutoff]),
    rows(db, 'SELECT staff_id, on_date FROM patrol_deployments WHERE tenant_id = ? AND on_date >= ? AND on_date < ? AND on_date <= ?', [t, start, end, today]),
  ]);
  const mins = (a, b) => Math.max(0, Math.round((Date.parse(`${String(b).replace(' ', 'T')}Z`) - Date.parse(`${String(a).replace(' ', 'T')}Z`)) / 60000));
  const days = new Map(); const minutes = new Map();
  const addDay = (id, d) => { if (!days.has(id)) days.set(id, new Set()); days.get(id).add(String(d).slice(0, 10)); };
  for (const d of duty) { const id = Number(d.staff_id); addDay(id, d.on_date); minutes.set(id, (minutes.get(id) || 0) + mins(d.signed_in_at, d.out_at)); }
  for (const s of shifts) { const id = Number(s.staff_id); addDay(id, s.starts_at); minutes.set(id, (minutes.get(id) || 0) + mins(s.starts_at, s.ends_at)); }
  for (const p of posts) addDay(Number(p.staff_id), p.on_date);
  return { days, minutes };
}

/** The volunteer day target for a roster member (null when there is none, or they are paid). */
function targetFor(settings, member) {
  if (member.in_workforce && Number(member.in_workforce)) return null;
  if (member.level === 'candidate' && settings.min_days_candidate !== null) return settings.min_days_candidate;
  return settings.min_days;
}

module.exports = { settingsOf, DEFAULTS, tzOf, clock, closeStale, onDuty, onDutyIds, seasonDays, targetFor, seasonFor, addDays };
