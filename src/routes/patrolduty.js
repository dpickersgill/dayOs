'use strict';

// Patrol duty (mounted under /patrol): who is on the hill, the patrol's operating settings, each volunteer's days against
// the season's minimum, and the phones that receive alerts.
//
// Sign-in is what dispatch, the sweep, Today's posts and days patrolled use as "on duty". Volunteers cannot use the time
// clock, so this is their only way on; paid patrollers can clock in at the same time.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const OPS = require('../lib/patrolops');
const CREWS = require('../lib/patrolcrews');
const SH = require('../lib/shifts');
const PUSH = require('../lib/push');
const crypto = require('crypto');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const NAME = "CONCAT(p.first_name, ' ', p.last_name)";

// ---------------------------------------------------------------- settings
/** The patrol's operating settings, as everyone in Patrol sees them. */
router.get('/ops-settings', patrol, async (req, res) => {
  const s = await OPS.settingsOf(pool, req.auth.tenantId);
  const features = (await PA.accessOf(pool, req)).features;
  res.json({ ...s, story_fill_available: require('../lib/storyfill').available(), can: { settings: features.has('manage_settings'), schedule: features.has('manage_schedule'), meds: features.has('manage_meds'), sweep: features.has('run_sweep'), avalanche: features.has('avalanche') } });
});

const nul = (s) => s.nullable().optional();
// Each setting is changed by those who run that part of patrol.
const GROUPS = {
  manage_settings: { medical_director: nul(z.string().trim().max(150)), protocol_version: nul(z.string().trim().max(60)), avalanche: z.boolean().optional(), sms_critical: z.boolean().optional(), story_fill: z.boolean().optional() },
  manage_schedule: { min_days: nul(z.number().int().min(0).max(200)), min_days_candidate: nul(z.number().int().min(0).max(200)), self_signup: z.boolean().optional(), signup_approval: z.boolean().optional(), short_alert: z.boolean().optional(), remind_dates: z.string().regex(/^(\d{2}-\d{2})(,\d{2}-\d{2}){0,5}$/, 'Dates as MM-DD, separated by commas').optional() },
  manage_meds: { controlled_counts: z.boolean().optional(), o2_refill_psi: z.number().int().min(0).max(3000).optional() },
  run_sweep: { sweep_late_minutes: z.number().int().min(5).max(240).optional() },
};
const settingsBody = z.object(Object.assign({}, ...Object.values(GROUPS))).strict();

router.put('/ops-settings', patrol, validate(settingsBody), async (req, res) => {
  const t = req.auth.tenantId;
  const access = (await PA.accessOf(pool, req)).features;
  const b = req.body;
  for (const [feature, fields] of Object.entries(GROUPS)) {
    if (Object.keys(fields).some((k) => b[k] !== undefined) && !access.has(feature)) throw forbidden(`Your patrol access cannot change ${Object.keys(fields).filter((k) => b[k] !== undefined).join(', ').replace(/_/g, ' ')}`);
  }
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to change');
  const vals = keys.map((k) => (typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k] === '' ? null : b[k]));
  await pool.query(`INSERT INTO patrol_settings (tenant_id, ${keys.join(', ')}, updated_by) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)
    ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(', ')}, updated_by = VALUES(updated_by)`, [t, ...vals, req.auth.userId]);
  await audit(pool, req, 'update', 'patrol_settings', null, b);
  res.json(await OPS.settingsOf(pool, t));
});

// ---------------------------------------------------------------- duty
const rosterRow = (db, t, staffId) => one(db, `SELECT m.staff_id, m.level, m.callsign, s.status, s.in_workforce, ${NAME} AS name FROM patrol_members m
  JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE m.tenant_id = ? AND m.staff_id = ?`, [t, staffId]);

/** Signing someone else in or out is for those who post the day's team (the patrol-room screen). */
async function actingFor(req, staffId) {
  if (!staffId || Number(staffId) === Number(req.auth.staffId)) {
    if (!req.auth.staffId) throw forbidden('Your login is not linked to anyone on the patrol roster');
    return Number(req.auth.staffId);
  }
  if (!(await PA.can(pool, req, 'assign_posts'))) throw forbidden('Only those who post the day\'s team can sign someone else in or out');
  return Number(staffId);
}

/**
 * Today on duty: who is signed in, who is scheduled and not signed in yet, the rest of the active roster, and my own
 * state. ?date= shows an earlier day (who was on, with times).
 */
router.get('/duty', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { today, now } = await OPS.clock(pool, t);
  await OPS.closeStale(pool, t, today);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today;
  const [entries, scheduled, roster, stations] = await Promise.all([
    rows(pool, `SELECT d.*, ${NAME} AS name, m.callsign, m.level, st.name AS station FROM patrol_duty d JOIN staff s ON s.tenant_id = d.tenant_id AND s.id = d.staff_id
      JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id LEFT JOIN patrol_members m ON m.tenant_id = d.tenant_id AND m.staff_id = d.staff_id
      LEFT JOIN patrol_stations st ON st.tenant_id = d.tenant_id AND st.id = d.station_id WHERE d.tenant_id = ? AND d.on_date = ? ORDER BY d.signed_in_at`, [t, date]),
    rows(pool, `SELECT ps.id, ps.staff_id, ps.starts_at, ps.ends_at, st.name AS station FROM patrol_shifts ps LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id
      WHERE ps.tenant_id = ? AND ps.status = 'published' AND ps.staff_id IS NOT NULL AND DATE(ps.starts_at) = ?`, [t, date]),
    rows(pool, `SELECT m.staff_id, m.level, m.callsign, s.in_workforce, ${NAME} AS name FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id
      JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE m.tenant_id = ? AND s.status = 'active' ORDER BY p.last_name, p.first_name`, [t]),
    rows(pool, 'SELECT id, name FROM patrol_stations WHERE tenant_id = ? ORDER BY name', [t]),
  ]);
  const open = entries.filter((e) => !e.signed_out_at);
  const onIds = new Set(open.map((e) => Number(e.staff_id)));
  const me = req.auth.staffId ? Number(req.auth.staffId) : null;
  res.json({
    date, today, now, stations,
    on_duty: open.map((e) => ({ ...e, staff_id: Number(e.staff_id) })),
    signed_out: entries.filter((e) => e.signed_out_at).map((e) => ({ ...e, staff_id: Number(e.staff_id) })),
    scheduled_not_in: date === today ? scheduled.filter((s) => !onIds.has(Number(s.staff_id)) && !entries.some((e) => Number(e.staff_id) === Number(s.staff_id))).map((s) => ({ ...s, name: (roster.find((r) => Number(r.staff_id) === Number(s.staff_id)) || {}).name, late: CREWS.isNoShow({ ...s, status: 'published' }, now, false) })) : [],
    roster: roster.map((r) => ({ ...r, staff_id: Number(r.staff_id), on_duty: onIds.has(Number(r.staff_id)), paid: Boolean(Number(r.in_workforce)) })),
    me: me ? { staff_id: me, on_duty: onIds.has(me), entry: open.find((e) => Number(e.staff_id) === me) || null, on_roster: roster.some((r) => Number(r.staff_id) === me) } : null,
    can_sign_others: await PA.can(pool, req, 'assign_posts'),
  });
});

router.post('/duty/sign-in', patrol, validate(z.object({
  staff_id: z.number().int().positive().optional(), station_id: z.number().int().positive().nullable().optional(), radio: z.string().trim().max(30).nullable().optional(),
  source: z.enum(['phone', 'room']).default('phone'), clock_in: z.boolean().default(false),
})), async (req, res) => {
  const t = req.auth.tenantId;
  const staffId = await actingFor(req, req.body.staff_id);
  const b = req.body;
  const out = await tx(async (conn) => {
    const m = await rosterRow(conn, t, staffId);
    if (!m) throw bad('Only people on the patrol roster sign in for patrol');
    if (m.status !== 'active') throw bad(`${m.name}'s record is ${m.status}, not active`);
    if (b.station_id && !(await one(conn, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, b.station_id]))) throw notFound('Station');
    const { now, today } = await OPS.clock(conn, t);
    await OPS.closeStale(conn, t, today);
    if (await one(conn, 'SELECT id FROM patrol_duty WHERE tenant_id = ? AND staff_id = ? AND signed_out_at IS NULL', [t, staffId])) throw conflict(`${m.name} is already signed in`);
    // The published patrol shift this is for: the one under way or starting within 3 hours.
    const shift = await one(conn, "SELECT id, station_id FROM patrol_shifts WHERE tenant_id = ? AND staff_id = ? AND status = 'published' AND ? BETWEEN DATE_SUB(starts_at, INTERVAL 3 HOUR) AND ends_at ORDER BY starts_at LIMIT 1", [t, staffId, now]);
    let r;
    try {
      [r] = await conn.query('INSERT INTO patrol_duty (tenant_id, staff_id, on_date, signed_in_at, station_id, radio, patrol_shift_id, source, signed_in_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [t, staffId, today, now, b.station_id || (shift && shift.station_id) || null, b.radio || null, shift ? shift.id : null, b.source, req.auth.userId]);
    } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict(`${m.name} is already signed in`); throw e; }
    let clocked = false;
    if (b.clock_in && Number(m.in_workforce) && !(await one(conn, 'SELECT id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [t, staffId]))) {
      await conn.query("INSERT INTO time_entries (tenant_id, staff_id, patrol_shift_id, clock_in, in_method) VALUES (?, ?, ?, NOW(), 'login')", [t, staffId, shift ? shift.id : null]);
      clocked = true;
    }
    await audit(conn, req, 'sign_in', 'patrol_duty', r.insertId, { staff_id: staffId, source: b.source, clocked_in: clocked });
    return { id: r.insertId, patrol_shift_id: shift ? Number(shift.id) : null, clocked_in: clocked };
  });
  res.status(201).json(out);
});

router.post('/duty/sign-out', patrol, validate(z.object({ staff_id: z.number().int().positive().optional(), clock_out: z.boolean().default(false) })), async (req, res) => {
  const t = req.auth.tenantId;
  const staffId = await actingFor(req, req.body.staff_id);
  const out = await tx(async (conn) => {
    const { now } = await OPS.clock(conn, t);
    const d = await one(conn, 'SELECT id FROM patrol_duty WHERE tenant_id = ? AND staff_id = ? AND signed_out_at IS NULL FOR UPDATE', [t, staffId]);
    if (!d) throw conflict('Not signed in');
    await conn.query('UPDATE patrol_duty SET signed_out_at = ?, signed_out_by = ? WHERE tenant_id = ? AND id = ?', [now, req.auth.userId, t, d.id]);
    let clockedOut = false;
    if (req.body.clock_out) {
      const [r] = await conn.query("UPDATE time_entries SET clock_out = NOW(), out_method = 'login' WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL", [t, staffId]);
      clockedOut = r.affectedRows > 0;
    }
    await audit(conn, req, 'sign_out', 'patrol_duty', d.id, { staff_id: staffId });
    return { ok: true, clocked_out: clockedOut };
  });
  res.json(out);
});

/** Change the station or radio of someone on duty (they moved huts mid-day). */
router.patch('/duty/:staffId', patrol, validate(z.object({ station_id: z.number().int().positive().nullable().optional(), radio: z.string().trim().max(30).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const staffId = await actingFor(req, Number(req.params.staffId));
  const d = await one(pool, 'SELECT id FROM patrol_duty WHERE tenant_id = ? AND staff_id = ? AND signed_out_at IS NULL', [t, staffId]);
  if (!d) throw conflict('Not signed in');
  if (req.body.station_id && !(await one(pool, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, req.body.station_id]))) throw notFound('Station');
  const sets = Object.keys(req.body).filter((k) => req.body[k] !== undefined);
  if (!sets.length) throw bad('Nothing to change');
  await pool.query(`UPDATE patrol_duty SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...sets.map((k) => req.body[k]), t, d.id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- commitment
/** Each roster member's days this season against the minimum (volunteers), furthest behind first. */
router.get('/commitment', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { today } = await OPS.clock(pool, t);
  const season = /^\d{4}-\d{2}$/.test(String(req.query.season || '')) ? String(req.query.season) : OPS.seasonFor(today);
  const s = await OPS.settingsOf(pool, t);
  const canSeeAll = await PA.can(pool, req, 'manage_schedule') || await PA.can(pool, req, 'manage_team');
  const members = await rows(pool, `SELECT m.staff_id, m.level, s.in_workforce, ${NAME} AS name FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id
    JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE m.tenant_id = ? AND s.status = 'active' ORDER BY p.last_name, p.first_name`, [t]);
  const { days, minutes } = await OPS.seasonDays(pool, t, season);
  const data = members.map((m) => {
    const id = Number(m.staff_id); const target = OPS.targetFor(s, m); const n = (days.get(id) || new Set()).size;
    return { staff_id: id, name: m.name, level: m.level, paid: Boolean(Number(m.in_workforce)), days: n, minutes: minutes.get(id) || 0, target, short: target ? Math.max(0, target - n) : 0 };
  }).sort((a, b) => b.short - a.short || a.name.localeCompare(b.name));
  const me = req.auth.staffId ? data.find((d) => d.staff_id === Number(req.auth.staffId)) || null : null;
  res.json({ season, min_days: s.min_days, min_days_candidate: s.min_days_candidate, self_signup: s.self_signup, me, data: canSeeAll ? data : me ? [me] : [] });
});

/** The daily job: on each reminder date, an Inbox message to every volunteer short of the minimum. */
async function remindAll() {
  const list = await rows(pool, "SELECT s.tenant_id FROM patrol_settings s JOIN tenants t ON t.id = s.tenant_id WHERE t.status = 'active' AND s.min_days IS NOT NULL");
  let sent = 0;
  for (const { tenant_id: t } of list) {
    const st = await OPS.settingsOf(pool, t);
    const { today } = await OPS.clock(pool, t);
    if (!st.remind_dates.split(',').includes(today.slice(5)) || String(st.last_reminded || '').slice(0, 10) === today) continue;
    await pool.query('UPDATE patrol_settings SET last_reminded = ? WHERE tenant_id = ?', [today, t]);
    const season = OPS.seasonFor(today);
    const { days } = await OPS.seasonDays(pool, t, season);
    const members = await rows(pool, "SELECT m.staff_id, m.level, s.in_workforce FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id WHERE m.tenant_id = ? AND s.status = 'active'", [t]);
    const from = await one(pool, "SELECT id FROM users WHERE tenant_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1", [t]);
    if (!from) continue;
    for (const m of members) {
      const target = OPS.targetFor(st, m); const n = (days.get(Number(m.staff_id)) || new Set()).size;
      if (!target || n >= target) continue;
      if (await SH.tell(pool, t, Number(from.id), Number(m.staff_id), `Patrol days this season: you have ${n} of the ${target} the patrol asks for. Open shifts and cover requests are on Patrol, Team, Cover.`)) sent += 1;
    }
  }
  return sent;
}

// ---------------------------------------------------------------- phone alerts
router.get('/alerts/key', patrol, async (_req, res) => { res.json({ key: (await PUSH.vapid()).publicKey }); });

router.post('/alerts/subscribe', patrol, validate(z.object({ endpoint: z.string().url().max(600).refine((u) => require('../lib/push').pushHostOk(u), 'That is not a phone alert service'), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(60) }) })), async (req, res) => {
  const b = req.body;
  const hash = crypto.createHash('sha256').update(b.endpoint).digest('hex');
  await pool.query(`INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id), user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), failures = 0`, [req.auth.tenantId, req.auth.userId, b.endpoint, hash, b.keys.p256dh, b.keys.auth]);
  await audit(pool, req, 'alerts_on', 'push_subscriptions', null);
  res.status(201).json({ ok: true });
});

router.post('/alerts/unsubscribe', patrol, validate(z.object({ endpoint: z.string().max(600) })), async (req, res) => {
  const hash = crypto.createHash('sha256').update(req.body.endpoint).digest('hex');
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?', [hash, req.auth.userId]);
  res.json({ ok: true });
});

/** A test alert to my own phones. */
router.post('/alerts/test', patrol, async (req, res) => {
  const n = await PUSH.notifyUsers(req.auth.tenantId, [req.auth.userId], { title: 'Verdynt/OS alerts are on', body: 'You will be alerted here when you are sent to a call.', url: '#/patrol/duty', tag: 'test' });
  const { c } = await one(pool, 'SELECT COUNT(*) AS c FROM push_subscriptions WHERE tenant_id = ? AND user_id = ?', [req.auth.tenantId, req.auth.userId]);
  res.json({ sent: n, phones: Number(c) });
});

module.exports = { router, remindAll };
