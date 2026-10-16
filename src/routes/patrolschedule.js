'use strict';

// The patrol schedule (mounted under /patrol): kept apart from Staff and schedule, built in Patrol by those with the
// "Patrol schedule" permission (patrol Admins and Managers by default; owners and managers always). Anyone on the roster
// can be scheduled, volunteers included. Patrollers see published shifts; editors see drafts too. Publishing and later
// changes are messaged to the patrollers they affect, as in Staff and schedule. Days and hours patrolled per season
// come from published shifts that have ended and from Today's posts.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, dateTimeStr, validate, paramId, normDateTime, addDays, todayIn, nowIn, seasonFor } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { span } = require('../lib/workforce');
const { toCsv } = require('../lib/csv');
const SH = require('../lib/shifts');
const PA = require('../lib/patrolaccess');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
// Shift cover requests on a shift close when the schedule cancels it or puts someone else on it (required late: the
// cover routes use problemsFor from here).
const coverAfterChange = (...a) => require('./patrolcover').afterShiftChange(...a);
const editor = PA.needs(pool, 'manage_schedule', 'Only those who build the patrol schedule can change it');
const tzOf = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const NAME = "CONCAT(p.first_name, ' ', p.last_name)";

const SELECT = `SELECT ps.*, ${NAME} AS name, st.name AS station,
    (SELECT cr.status FROM patrol_cover_requests cr WHERE cr.tenant_id = ps.tenant_id AND cr.patrol_shift_id = ps.id AND cr.status IN ('open', 'pending') ORDER BY cr.id DESC LIMIT 1) AS cover_status
  FROM patrol_shifts ps
  LEFT JOIN staff s ON s.tenant_id = ps.tenant_id AND s.id = ps.staff_id LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
  LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id`;
const shiftOf = (db, t, id) => one(db, `${SELECT} WHERE ps.tenant_id = ? AND ps.id = ?`, [t, id]);
/** "8:00 AM to 4:30 PM on Sat, Oct 17 at Summit hut, Patrol leader" */
const describe = (s) => `patrol ${span(s.starts_at, s.ends_at)}${s.station ? ` at ${s.station}` : ''}${s.role_label ? `, ${s.role_label}` : ''}`;

/**
 * Why this person cannot take this patrol shift (empty when they can): on the roster and active, and not already on
 * another patrol shift, a work shift (a paid patroller) or a lesson at the same time. There is no availability check:
 * patrol keeps its own sign-up habits.
 */
async function problemsFor(db, t, staffId, startsAt, endsAt, ignoreId = 0) {
  const out = [];
  const m = await one(db, 'SELECT s.status FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id WHERE m.tenant_id = ? AND m.staff_id = ?', [t, staffId]);
  if (!m) return ['Not on the patrol roster'];
  if (m.status !== 'active') out.push(`Their record is ${m.status}, not active`);
  const p = await one(db, "SELECT starts_at, ends_at FROM patrol_shifts WHERE tenant_id = ? AND staff_id = ? AND status <> 'cancelled' AND id <> ? AND starts_at < ? AND ends_at > ? LIMIT 1", [t, staffId, ignoreId, endsAt, startsAt]);
  if (p) out.push(`Already on patrol ${span(p.starts_at, p.ends_at)}`);
  const w = await one(db, "SELECT s.starts_at, s.ends_at, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.staff_id = ? AND s.status <> 'cancelled' AND s.starts_at < ? AND s.ends_at > ? LIMIT 1", [t, staffId, endsAt, startsAt]);
  if (w) out.push(`Working ${w.position} ${span(w.starts_at, w.ends_at)}`);
  const l = await one(db, "SELECT starts_at, ends_at FROM lesson_sessions WHERE tenant_id = ? AND instructor_id = ? AND status <> 'cancelled' AND starts_at < ? AND ends_at > ? LIMIT 1", [t, staffId, endsAt, startsAt]);
  if (l) out.push(`Teaching a lesson ${span(l.starts_at, l.ends_at)}`);
  return out;
}

async function tellChange(conn, t, from, before, after) {
  if (before.status !== 'published') return;
  const was = before.staff_id ? Number(before.staff_id) : null;
  const now = after && after.status !== 'cancelled' && after.staff_id ? Number(after.staff_id) : null;
  if (!after || after.status === 'cancelled') { if (was) await SH.tell(conn, t, from, was, `Your ${describe(before)} is cancelled.`); return; }
  if (was && was !== now) await SH.tell(conn, t, from, was, `You are no longer on ${describe(before)}.`);
  if (now && was !== now) await SH.tell(conn, t, from, now, `You are on ${describe(after)}.${after.notes ? ` Note: ${after.notes}` : ''}`);
  if (now && was === now && (before.starts_at !== after.starts_at || before.ends_at !== after.ends_at || before.station_id !== after.station_id || before.role_label !== after.role_label)) {
    await SH.tell(conn, t, from, now, `Your patrol shift changed. It was ${describe(before).slice(7)}. It is now ${describe(after).slice(7)}.`);
  }
}

const range = (req) => {
  const from = String(req.query.from || ''); const to = String(req.query.to || '');
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('from and to (YYYY-MM-DD) are required');
  return [from, to];
};

/** The schedule for a range, the roster to schedule from, the stations, and whether this person can change it. */
router.get('/schedule', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const [from, to] = range(req);
  const canEdit = await PA.can(pool, req, 'manage_schedule');
  const [shifts, roster, stations] = await Promise.all([
    rows(pool, `${SELECT} WHERE ps.tenant_id = ? AND ps.status ${canEdit ? "<> 'cancelled'" : "= 'published'"} AND DATE(ps.starts_at) BETWEEN ? AND ? ORDER BY ps.starts_at, name`, [t, from, to]),
    rows(pool, `SELECT m.staff_id, m.level, m.callsign, s.in_workforce, s.status, ${NAME} AS name FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
      WHERE m.tenant_id = ? ORDER BY FIELD(m.level, 'director', 'leader', 'senior', 'patroller', 'candidate'), p.last_name, p.first_name`, [t]),
    rows(pool, 'SELECT id, name FROM patrol_stations WHERE tenant_id = ? ORDER BY name', [t]),
  ]);
  res.json({ can_edit: canEdit, me: req.auth.staffId || null, shifts, roster: roster.map((r) => ({ ...r, in_workforce: Boolean(r.in_workforce) })), stations });
});

/** Who on the roster could take a shift at this time, best first (free, fewest patrol hours that week), with reasons. */
router.post('/schedule/candidates', patrol, editor, validate(z.object({ starts_at: dateTimeStr.transform(normDateTime), ends_at: dateTimeStr.transform(normDateTime), shift_id: z.number().int().positive().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  if (b.ends_at <= b.starts_at) throw bad('The shift must end after it starts');
  const roster = await rows(pool, `SELECT m.staff_id, m.level, ${NAME} AS name FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE m.tenant_id = ? AND s.status = 'active' ORDER BY p.last_name, p.first_name`, [t]);
  const week = SH.weekOf(b.starts_at.slice(0, 10));
  const mins = await SH.weekMinutes(pool, t, week);
  const current = b.shift_id ? await one(pool, 'SELECT staff_id FROM patrol_shifts WHERE tenant_id = ? AND id = ?', [t, b.shift_id]) : null;
  const out = [];
  for (const r of roster) {
    const problems = await problemsFor(pool, t, Number(r.staff_id), b.starts_at, b.ends_at, b.shift_id || 0);
    out.push({ staff_id: Number(r.staff_id), name: r.name, level: r.level, ok: !problems.length, problems, week_minutes: mins.get(Number(r.staff_id)) || 0, current: Boolean(current && Number(current.staff_id) === Number(r.staff_id)) });
  }
  out.sort((a, c) => (a.ok === c.ok ? 0 : a.ok ? -1 : 1) || a.week_minutes - c.week_minutes || a.name.localeCompare(c.name));
  res.json({ data: out });
});

const fields = {
  staff_id: z.number().int().positive().nullable().optional(),
  starts_at: dateTimeStr.transform(normDateTime),
  ends_at: dateTimeStr.transform(normDateTime),
  station_id: z.number().int().positive().nullable().optional(),
  role_label: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(200).nullable().optional(),
};

async function check(conn, t, s, ignoreId = 0) {
  if (s.ends_at <= s.starts_at) throw bad('The shift must end after it starts');
  if (SH.minutesBetween(s.starts_at, s.ends_at) > 24 * 60) throw bad('A shift can be at most 24 hours');
  if (s.station_id && !(await one(conn, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, s.station_id]))) throw notFound('Station');
  if (s.staff_id) {
    const problems = await problemsFor(conn, t, Number(s.staff_id), s.starts_at, s.ends_at, ignoreId);
    if (problems.length) throw conflict('Cannot put this patroller on the shift', problems);
  }
}

router.post('/schedule', patrol, editor, validate(z.object(fields)), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  const id = await tx(async (conn) => {
    await check(conn, t, b);
    const [r] = await conn.query('INSERT INTO patrol_shifts (tenant_id, staff_id, starts_at, ends_at, station_id, role_label, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [t, b.staff_id || null, b.starts_at, b.ends_at, b.station_id || null, b.role_label || null, b.notes || null, req.auth.userId]);
    await audit(conn, req, 'create', 'patrol_shifts', r.insertId);
    return r.insertId;
  });
  res.status(201).json({ id, status: 'draft' });
});

router.patch('/schedule/:id', patrol, editor, validate(z.object(fields).partial()), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  const after = await tx(async (conn) => {
    const before = await one(conn, `${SELECT} WHERE ps.tenant_id = ? AND ps.id = ? FOR UPDATE`, [t, id]);
    if (!before) throw notFound('Patrol shift');
    if (before.status === 'cancelled') throw conflict('This shift is cancelled');
    const next = { ...before, ...Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)) };
    await check(conn, t, next, id);
    await conn.query('UPDATE patrol_shifts SET staff_id = ?, starts_at = ?, ends_at = ?, station_id = ?, role_label = ?, notes = ? WHERE tenant_id = ? AND id = ?',
      [next.staff_id || null, next.starts_at, next.ends_at, next.station_id || null, next.role_label || null, next.notes || null, t, id]);
    const now = await shiftOf(conn, t, id);
    await tellChange(conn, t, req.auth.userId, before, now);
    await coverAfterChange(conn, req, before, now);
    await audit(conn, req, 'update', 'patrol_shifts', id, req.body);
    return now;
  });
  res.json(after);
});

router.delete('/schedule/:id', patrol, editor, async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const before = await one(conn, `${SELECT} WHERE ps.tenant_id = ? AND ps.id = ? FOR UPDATE`, [t, paramId(req)]);
    if (!before) throw notFound('Patrol shift');
    await conn.query("UPDATE patrol_shifts SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [t, before.id]);
    if (before.status !== 'cancelled') await tellChange(conn, t, req.auth.userId, before, null);
    await coverAfterChange(conn, req, before, null);
    await audit(conn, req, 'cancel', 'patrol_shifts', before.id);
  });
  res.status(204).end();
});

/** Publish the drafts in a range; each patroller on them gets one Inbox message listing theirs. */
router.post('/schedule/publish', patrol, editor, validate(z.object({ from: dateStr, to: dateStr })), async (req, res) => {
  const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const [r] = await conn.query("UPDATE patrol_shifts SET status = 'published' WHERE tenant_id = ? AND status = 'draft' AND DATE(starts_at) BETWEEN ? AND ?", [t, req.body.from, req.body.to]);
    await audit(conn, req, 'publish', 'patrol_shifts', null, req.body);
    let told = 0;
    if (r.affectedRows) {
      const list = await rows(conn, `${SELECT} WHERE ps.tenant_id = ? AND ps.status = 'published' AND ps.staff_id IS NOT NULL AND DATE(ps.starts_at) BETWEEN ? AND ? ORDER BY ps.starts_at`, [t, req.body.from, req.body.to]);
      const by = new Map();
      for (const s of list) { const k = Number(s.staff_id); if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
      for (const [staffId, mine] of by) {
        const text = `The patrol schedule is published. You are on ${mine.length} patrol shift${mine.length === 1 ? '' : 's'}:\n${mine.map((s) => `- ${describe(s).slice(7)}`).join('\n')}\nSee them any time in Patrol, Schedule, or My shifts.`;
        if (await SH.tell(conn, t, req.auth.userId, staffId, text)) told += 1;
      }
    }
    return { published: r.affectedRows, notified: told };
  });
  res.json(out);
});

/** Copy one week into another as drafts. People stay where they can still take the shift; otherwise it is left open. */
router.post('/schedule/copy', patrol, editor, validate(z.object({ from: dateStr, to: dateStr })), async (req, res) => {
  const t = req.auth.tenantId;
  const from = SH.weekOf(req.body.from); const to = SH.weekOf(req.body.to);
  if (from === to) throw bad('Choose a different week to copy into');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const out = await tx(async (conn) => {
    const src = await rows(conn, "SELECT * FROM patrol_shifts WHERE tenant_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ? ORDER BY starts_at", [t, `${from} 00:00:00`, `${addDays(from, 7)} 00:00:00`]);
    if (!src.length) throw bad('That week has no patrol shifts to copy');
    let created = 0; let unfilled = 0; let skipped = 0;
    const leftOpen = [];
    for (const s of src) {
      const starts = SH.plusMinutes(s.starts_at, days * 1440); const ends = SH.plusMinutes(s.ends_at, days * 1440);
      let staffId = s.staff_id ? Number(s.staff_id) : null;
      if (await one(conn, "SELECT id FROM patrol_shifts WHERE tenant_id = ? AND starts_at = ? AND ends_at = ? AND status <> 'cancelled' AND (staff_id <=> ?) AND (station_id <=> ?) LIMIT 1", [t, starts, ends, staffId, s.station_id])) { skipped += 1; continue; }
      if (staffId) {
        const problems = await problemsFor(conn, t, staffId, starts, ends);
        if (problems.length) { leftOpen.push({ staff_id: staffId, starts_at: starts, reason: problems[0] }); staffId = null; }
      }
      await conn.query('INSERT INTO patrol_shifts (tenant_id, staff_id, starts_at, ends_at, station_id, role_label, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, staffId, starts, ends, s.station_id, s.role_label, s.notes, req.auth.userId]);
      created += 1; if (!staffId) unfilled += 1;
    }
    await audit(conn, req, 'copy_week', 'patrol_shifts', null, { from, to, created, unfilled, skipped });
    return { created, unfilled, skipped, left_open: leftOpen.slice(0, 50) };
  });
  res.json(out);
});

/**
 * Days and hours patrolled this season (Aug 1 to Jul 31), per person on the roster: a day counts when they were on a
 * published patrol shift that has ended, or posted on Today's posts. Hours are those shifts' lengths. ?format=csv
 * downloads it (for volunteer credit and the season report).
 */
router.get('/schedule/days', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const tz = await tzOf(t);
  const today = todayIn(tz);
  const season = /^\d{4}-\d{2}$/.test(String(req.query.season || '')) ? String(req.query.season) : seasonFor(today);
  const start = `${season.slice(0, 4)}-08-01`; const end = `${Number(season.slice(0, 4)) + 1}-08-01`;
  const now = nowIn(tz);
  const [members, shifts, posts] = await Promise.all([
    rows(pool, `SELECT m.staff_id, m.level, m.patrol_number, s.in_workforce, ${NAME} AS name FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE m.tenant_id = ? ORDER BY p.last_name, p.first_name`, [t]),
    rows(pool, `SELECT staff_id, starts_at, ends_at FROM patrol_shifts WHERE tenant_id = ? AND status = 'published' AND staff_id IS NOT NULL AND starts_at >= ? AND starts_at < ? AND ends_at <= ?
      UNION ALL
      SELECT s.staff_id, s.starts_at, s.ends_at FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id AND pos.department = 'patrol'
      WHERE s.tenant_id = ? AND s.status = 'published' AND s.staff_id IS NOT NULL AND s.starts_at >= ? AND s.starts_at < ? AND s.ends_at <= ?`, [t, start, end, now, t, start, end, now]), // and patrol shifts made in Staff and schedule before patrol had its own
    rows(pool, 'SELECT staff_id, on_date FROM patrol_deployments WHERE tenant_id = ? AND on_date >= ? AND on_date < ? AND on_date <= ?', [t, start, end, today]),
  ]);
  const days = new Map(); const mins = new Map();
  const addDay = (id, d) => { if (!days.has(id)) days.set(id, new Set()); days.get(id).add(d); };
  for (const s of shifts) { const id = Number(s.staff_id); addDay(id, String(s.starts_at).slice(0, 10)); mins.set(id, (mins.get(id) || 0) + SH.minutesBetween(s.starts_at, s.ends_at)); }
  for (const d of posts) addDay(Number(d.staff_id), String(d.on_date).slice(0, 10));
  const data = members.map((m) => ({ staff_id: Number(m.staff_id), name: m.name, level: m.level, patrol_number: m.patrol_number, paid: Boolean(m.in_workforce), days: (days.get(Number(m.staff_id)) || new Set()).size, minutes: mins.get(Number(m.staff_id)) || 0 }));
  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="patrol-days-${season}.csv"`);
    return res.send(toCsv(['name', 'patrol_number', 'rank', 'paid', 'days_patrolled', 'hours_scheduled'], data.map((d) => ({ name: d.name, patrol_number: d.patrol_number || '', rank: d.level, paid: d.paid ? 'yes' : 'no', days_patrolled: d.days, hours_scheduled: (d.minutes / 60).toFixed(2) }))));
  }
  res.json({ season, data });
});

module.exports = { router, describe, problemsFor };
