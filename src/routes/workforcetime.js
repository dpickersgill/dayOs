'use strict';

// Staff and schedule > Hours (mounted under /workforce): a week's punches per person beside their scheduled hours,
// fixing a missed or wrong punch (with a reason, kept in the audit log), adding a punch someone forgot, approving the
// week, and the payroll export.
//
// Punches are kept on the database clock (UTC); everything here is shown and typed in the mountain's local time.
// Weeks run Monday to Sunday. Overtime is time over 40 hours in that week (the US federal rule); check state rules.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, dateTimeStr, validate, paramId, normDateTime, dayRange, addDays, localTime } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { tenantOf } = require('../lib/kiosk');
const { toCsv } = require('../lib/csv');
const SH = require('../lib/shifts');

const router = express.Router();
const mgr = requireRole('manager');
const OVERTIME_AFTER = 40 * 60;
const LONG_SHIFT = 14 * 60;

/** A local wall-clock time ('YYYY-MM-DD HH:MM:SS') in the mountain's zone as database (UTC) time. */
function toDb(local, tz) {
  const day = local.slice(0, 10);
  const [start] = dayRange(tz, day); // UTC time of local midnight
  const sinceMidnight = Date.parse(`${local.replace(' ', 'T')}Z`) - Date.parse(`${day}T00:00:00Z`);
  return new Date(Date.parse(`${start.replace(' ', 'T')}Z`) + sinceMidnight).toISOString().slice(0, 19).replace('T', ' ');
}
const dbNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** The week's punches and shifts, per person, with totals and anything that needs a look. */
async function weekOf(t, tz, start) {
  const [from, to] = [dayRange(tz, start)[0], dayRange(tz, addDays(start, 6))[1]];
  const week = [`${start} 00:00:00`, `${addDays(start, 7)} 00:00:00`];
  const [entries, shifts, patrolShifts, people] = await Promise.all([
    rows(pool, 'SELECT * FROM time_entries WHERE tenant_id = ? AND clock_in >= ? AND clock_in < ? ORDER BY clock_in', [t, from, to]),
    rows(pool, "SELECT s.id, s.staff_id, s.starts_at, s.ends_at, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.staff_id IS NOT NULL AND s.status <> 'cancelled' AND s.starts_at >= ? AND s.starts_at < ?", [t, ...week]),
    // a paid patroller's patrol shifts count toward their scheduled hours; volunteers (not on the staff list) are not paid
    rows(pool, "SELECT ps.id, ps.staff_id, ps.starts_at, ps.ends_at, 'Patrol' AS position FROM patrol_shifts ps JOIN staff s ON s.tenant_id = ps.tenant_id AND s.id = ps.staff_id AND s.in_workforce = 1 WHERE ps.tenant_id = ? AND ps.status <> 'cancelled' AND ps.starts_at >= ? AND ps.starts_at < ?", [t, ...week]),
    rows(pool, 'SELECT s.id, s.status, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? ORDER BY p.last_name, p.first_name', [t]),
  ]);
  const shiftById = new Map(shifts.map((s) => [Number(s.id), s]));
  const patrolById = new Map(patrolShifts.map((s) => [Number(s.id), s]));
  const now = dbNow();
  const by = new Map();
  const row = (id) => {
    if (!by.has(id)) by.set(id, { staff_id: id, scheduled_minutes: 0, worked_minutes: 0, entries: [], shifts: [] });
    return by.get(id);
  };
  for (const s of [...shifts, ...patrolShifts]) { const r = row(Number(s.staff_id)); r.scheduled_minutes += SH.minutesBetween(s.starts_at, s.ends_at); r.shifts.push(s); }
  for (const e of entries) {
    const r = row(Number(e.staff_id));
    const minutes = SH.minutesBetween(e.clock_in, e.clock_out || now);
    const shift = e.shift_id ? shiftById.get(Number(e.shift_id)) : e.patrol_shift_id ? patrolById.get(Number(e.patrol_shift_id)) : null;
    const flags = [];
    if (!e.clock_out) flags.push(minutes > LONG_SHIFT ? 'missed_clock_out' : 'clocked_in');
    else if (minutes > LONG_SHIFT) flags.push('long');
    if (!e.shift_id && !e.patrol_shift_id) flags.push('no_shift');
    r.worked_minutes += minutes;
    r.entries.push({
      id: e.id, clock_in: localTime(e.clock_in, tz), clock_out: e.clock_out ? localTime(e.clock_out, tz) : null, minutes, shift: shift ? { id: shift.id, position: shift.position, starts_at: shift.starts_at, ends_at: shift.ends_at } : null,
      approved: Boolean(e.approved_at), edited: Boolean(e.edited_at), edit_note: e.edit_note, in_method: e.in_method, out_method: e.out_method, flags,
    });
  }
  const names = new Map(people.map((p) => [Number(p.id), p]));
  const list = [...by.values()].map((r) => {
    const p = names.get(r.staff_id) || {};
    const closed = r.entries.filter((e) => e.clock_out);
    return {
      ...r, name: p.first_name ? `${p.first_name} ${p.last_name}` : `Staff #${r.staff_id}`, status: p.status || null,
      overtime_minutes: Math.max(0, r.worked_minutes - OVERTIME_AFTER), regular_minutes: Math.min(r.worked_minutes, OVERTIME_AFTER),
      approved: closed.length > 0 && closed.length === r.entries.length && r.entries.every((e) => e.approved),
      needs_attention: r.entries.some((e) => e.flags.includes('missed_clock_out') || e.flags.includes('long')),
      shifts: undefined, shift_count: r.shifts.length,
    };
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

router.get('/time/week', mgr, async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await tenantOf(pool, t)).timezone;
  const start = SH.weekOf(String(req.query.start || '') || new Date().toISOString().slice(0, 10));
  if (!dateStr.safeParse(start).success) throw bad('start=YYYY-MM-DD is required');
  const data = await weekOf(t, tz, start);
  res.json({ start, end: addDays(start, 6), overtime_after_minutes: OVERTIME_AFTER, data });
});

const entryTimes = z.object({ clock_in: dateTimeStr.transform(normDateTime), clock_out: dateTimeStr.transform(normDateTime).nullable(), note: z.string().trim().min(3, 'Say why (at least a few words)').max(200) });

/** No two punches for one person may overlap. */
async function checkOverlap(conn, t, staffId, inDb, outDb, ignoreId = 0) {
  const clash = await one(conn, 'SELECT id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND id <> ? AND clock_in < ? AND COALESCE(clock_out, UTC_TIMESTAMP()) > ? LIMIT 1', [t, staffId, ignoreId, outDb || '9999-12-31 00:00:00', inDb]);
  if (clash) throw conflict('This overlaps another punch for the same person');
}

/** Fix a punch: a missed clock-out, a wrong time. The reason and the old times go in the audit log. Approval is undone. */
router.patch('/time/entries/:id', mgr, validate(entryTimes.partial({ clock_in: true, clock_out: true })), async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await tenantOf(pool, t)).timezone;
  await tx(async (conn) => {
    const e = await one(conn, 'SELECT * FROM time_entries WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!e) throw notFound('Time entry');
    const inDb = req.body.clock_in ? toDb(req.body.clock_in, tz) : e.clock_in;
    const outDb = req.body.clock_out === undefined ? e.clock_out : req.body.clock_out ? toDb(req.body.clock_out, tz) : null;
    if (outDb && outDb <= inDb) throw bad('Clock-out must be after clock-in');
    if (outDb && SH.minutesBetween(inDb, outDb) > 24 * 60) throw bad('A punch can be at most 24 hours');
    if (outDb && outDb > dbNow()) throw bad('Clock-out cannot be in the future');
    await checkOverlap(conn, t, e.staff_id, inDb, outDb, e.id);
    await conn.query("UPDATE time_entries SET clock_in = ?, clock_out = ?, out_method = IF(? IS NULL, out_method, COALESCE(out_method, 'manager')), approved_at = NULL, approved_by = NULL, edited_at = UTC_TIMESTAMP(), edited_by = ?, edit_note = ? WHERE tenant_id = ? AND id = ?",
      [inDb, outDb, outDb, req.auth.userId, req.body.note, t, e.id]);
    await audit(conn, req, 'fix_punch', 'time_entries', e.id, { before: { clock_in: localTime(e.clock_in, tz), clock_out: e.clock_out ? localTime(e.clock_out, tz) : null }, after: { clock_in: localTime(inDb, tz), clock_out: outDb ? localTime(outDb, tz) : null }, note: req.body.note });
  });
  res.json({ ok: true });
});

/** Add a punch someone forgot entirely, linked to their shift that day if there is one. */
router.post('/time/entries', mgr, validate(entryTimes.extend({ staff_id: z.number().int().positive(), clock_out: dateTimeStr.transform(normDateTime) })), async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await tenantOf(pool, t)).timezone;
  const b = req.body;
  const id = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, b.staff_id]))) throw notFound('Staff member');
    const inDb = toDb(b.clock_in, tz); const outDb = toDb(b.clock_out, tz);
    if (outDb <= inDb) throw bad('Clock-out must be after clock-in');
    if (SH.minutesBetween(inDb, outDb) > 24 * 60) throw bad('A punch can be at most 24 hours');
    if (outDb > dbNow()) throw bad('Clock-out cannot be in the future');
    await checkOverlap(conn, t, b.staff_id, inDb, outDb);
    const shift = await one(conn, "SELECT id FROM shifts WHERE tenant_id = ? AND staff_id = ? AND status <> 'cancelled' AND starts_at < ? AND ends_at > ? ORDER BY ABS(TIMESTAMPDIFF(MINUTE, starts_at, ?)) LIMIT 1", [t, b.staff_id, b.clock_out, b.clock_in, b.clock_in]);
    const [r] = await conn.query("INSERT INTO time_entries (tenant_id, staff_id, shift_id, clock_in, clock_out, in_method, out_method, edited_at, edited_by, edit_note) VALUES (?, ?, ?, ?, ?, 'manager', 'manager', UTC_TIMESTAMP(), ?, ?)",
      [t, b.staff_id, shift ? shift.id : null, inDb, outDb, req.auth.userId, b.note]);
    await audit(conn, req, 'add_punch', 'time_entries', r.insertId, { staff_id: b.staff_id, clock_in: b.clock_in, clock_out: b.clock_out, note: b.note });
    return r.insertId;
  });
  res.status(201).json({ id });
});

/** Remove a punch made in error (a double tap, the wrong person). Kept in the audit log with its times and the reason. */
router.delete('/time/entries/:id', mgr, validate(z.object({ note: z.string().trim().min(3).max(200) })), async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await tenantOf(pool, t)).timezone;
  await tx(async (conn) => {
    const e = await one(conn, 'SELECT * FROM time_entries WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!e) throw notFound('Time entry');
    await conn.query('DELETE FROM time_entries WHERE tenant_id = ? AND id = ?', [t, e.id]);
    await audit(conn, req, 'remove_punch', 'time_entries', e.id, { staff_id: e.staff_id, clock_in: localTime(e.clock_in, tz), clock_out: e.clock_out ? localTime(e.clock_out, tz) : null, note: req.body.note });
  });
  res.status(204).end();
});

/** Approve the week for everyone (or the people named). Someone still clocked in, or with a missed clock-out, is skipped. */
router.post('/time/approve', mgr, validate(z.object({ start: dateStr, staff_ids: z.array(z.number().int().positive()).max(500).optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await tenantOf(pool, t)).timezone;
  const start = SH.weekOf(req.body.start);
  const [from, to] = [dayRange(tz, start)[0], dayRange(tz, addDays(start, 6))[1]];
  const out = await tx(async (conn) => {
    const only = req.body.staff_ids && req.body.staff_ids.length ? req.body.staff_ids : null;
    const open = await rows(conn, `SELECT DISTINCT staff_id FROM time_entries WHERE tenant_id = ? AND clock_in >= ? AND clock_in < ? AND clock_out IS NULL${only ? ' AND staff_id IN (?)' : ''}`, only ? [t, from, to, only] : [t, from, to]);
    const skip = open.map((r) => Number(r.staff_id));
    const params = [req.auth.userId, t, from, to];
    let extra = '';
    if (only) { extra += ' AND staff_id IN (?)'; params.push(only); }
    if (skip.length) { extra += ' AND staff_id NOT IN (?)'; params.push(skip); }
    const [r] = await conn.query(`UPDATE time_entries SET approved_at = UTC_TIMESTAMP(), approved_by = ? WHERE tenant_id = ? AND clock_in >= ? AND clock_in < ? AND clock_out IS NOT NULL AND approved_at IS NULL${extra}`, params);
    await audit(conn, req, 'approve_hours', 'time_entries', null, { start, staff_ids: only, approved: r.affectedRows, skipped: skip });
    return { approved: r.affectedRows, skipped_people: skip.length };
  });
  res.json(out);
});

/** Undo approval for a person's week, to fix something after approving. */
router.post('/time/unapprove', mgr, validate(z.object({ start: dateStr, staff_id: z.number().int().positive() })), async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await tenantOf(pool, t)).timezone;
  const start = SH.weekOf(req.body.start);
  const [r] = await pool.query('UPDATE time_entries SET approved_at = NULL, approved_by = NULL WHERE tenant_id = ? AND staff_id = ? AND clock_in >= ? AND clock_in < ?', [t, req.body.staff_id, dayRange(tz, start)[0], dayRange(tz, addDays(start, 6))[1]]);
  await audit(pool, req, 'unapprove_hours', 'time_entries', null, req.body);
  res.json({ reopened: r.affectedRows });
});

/** Payroll export for a week: one row per person (or one per punch with detail=1), hours in decimals. */
router.get('/time/export', mgr, async (req, res) => {
  const t = req.auth.tenantId;
  const tz = (await tenantOf(pool, t)).timezone;
  const start = SH.weekOf(String(req.query.start || ''));
  if (!dateStr.safeParse(start).success) throw bad('start=YYYY-MM-DD is required');
  const data = await weekOf(t, tz, start);
  const h = (m) => (m / 60).toFixed(2);
  let csv;
  if (req.query.detail === '1') {
    csv = toCsv(['name', 'staff_id', 'clock_in', 'clock_out', 'hours', 'shift', 'approved', 'corrected', 'note'],
      data.flatMap((p) => p.entries.map((e) => ({ name: p.name, staff_id: p.staff_id, clock_in: e.clock_in, clock_out: e.clock_out || '', hours: h(e.minutes), shift: e.shift ? e.shift.position : '', approved: e.approved ? 'yes' : 'no', corrected: e.edited ? 'yes' : 'no', note: e.edit_note || '' }))));
  } else {
    csv = toCsv(['name', 'staff_id', 'week_starting', 'scheduled_hours', 'worked_hours', 'regular_hours', 'overtime_hours', 'approved'],
      data.map((p) => ({ name: p.name, staff_id: p.staff_id, week_starting: start, scheduled_hours: h(p.scheduled_minutes), worked_hours: h(p.worked_minutes), regular_hours: h(p.regular_minutes), overtime_hours: h(p.overtime_minutes), approved: p.approved ? 'yes' : 'no' })));
  }
  await audit(pool, req, 'export_hours', 'time_entries', null, { start, detail: req.query.detail === '1' });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="hours-${start}${req.query.detail === '1' ? '-detail' : ''}.csv"`);
  res.send(csv);
});

module.exports = router;
