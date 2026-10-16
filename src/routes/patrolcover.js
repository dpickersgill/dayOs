'use strict';

// Shift cover (mounted under /patrol): a patroller who cannot work one of their published patrol shifts asks for cover,
// the request is announced in the patrol's "Patrol shift cover" Inbox conversation, and anyone else on the roster who is
// free at that time takes it. The shift moves to them at once, or, with approval on, when someone who builds the patrol
// schedule approves. Everyone involved gets an Inbox message at each step. Requests are never deleted: the history shows
// who covered for whom.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, nowIn } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { span } = require('../lib/workforce');
const { postSystem, direct } = require('../lib/review');
const SH = require('../lib/shifts');
const PA = require('../lib/patrolaccess');
const { problemsFor } = require('./patrolschedule');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const THREAD_NAME = 'Patrol shift cover';
const NAME = "CONCAT(p.first_name, ' ', p.last_name)";
const tzOf = async (db, t) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;

const SELECT = `SELECT r.*, ps.starts_at, ps.ends_at, ps.station_id, ps.role_label, ps.notes AS shift_notes, ps.staff_id AS shift_staff_id, ps.status AS shift_status,
    st.name AS station, ${NAME} AS name, CONCAT(tp.first_name, ' ', tp.last_name) AS taken_by_name
  FROM patrol_cover_requests r JOIN patrol_shifts ps ON ps.tenant_id = r.tenant_id AND ps.id = r.patrol_shift_id
  LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id
  JOIN staff s ON s.tenant_id = r.tenant_id AND s.id = r.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
  LEFT JOIN staff ts ON ts.tenant_id = r.tenant_id AND ts.id = r.taken_by LEFT JOIN people tp ON tp.tenant_id = ts.tenant_id AND tp.id = ts.person_id`;
const requestOf = (db, t, id, lock = false) => one(db, `${SELECT} WHERE r.tenant_id = ? AND r.id = ?${lock ? ' FOR UPDATE' : ''}`, [t, id]);
/** "Sat, Oct 17 8:00 AM to 4:30 PM at Summit hut, Sweep" */
const when = (s) => `${span(s.starts_at, s.ends_at)}${s.station ? ` at ${s.station}` : ''}${s.role_label ? `, ${s.role_label}` : ''}`;

async function settingsOf(db, t) {
  const s = await one(db, 'SELECT needs_approval, thread_id FROM patrol_cover_settings WHERE tenant_id = ?', [t]);
  return { needs_approval: Boolean(s && Number(s.needs_approval)), thread_id: s && s.thread_id ? Number(s.thread_id) : null };
}

/** Logins of active roster members (the people who can cover), by staff id. */
async function rosterLogins(db, t) {
  const list = await rows(db, `SELECT m.staff_id, m.access_level, MIN(u.id) AS user_id FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id
    JOIN users u ON u.tenant_id = m.tenant_id AND u.staff_id = m.staff_id AND u.active = 1 WHERE m.tenant_id = ? AND s.status = 'active' GROUP BY m.staff_id, m.access_level`, [t]);
  return list.map((r) => ({ staff_id: Number(r.staff_id), level: r.access_level, user_id: Number(r.user_id) }));
}

/**
 * The patrol's cover conversation, made the first time it is needed, with every active roster member who has a login
 * in it (people who join see it from then on; people who leave the roster leave it).
 */
async function syncThread(conn, t, byUser) {
  const ids = (await rosterLogins(conn, t)).map((r) => r.user_id);
  await conn.query('INSERT IGNORE INTO patrol_cover_settings (tenant_id) VALUES (?)', [t]);
  let threadId = (await settingsOf(conn, t)).thread_id;
  if (threadId && !(await one(conn, 'SELECT id FROM chat_threads WHERE tenant_id = ? AND id = ?', [t, threadId]))) threadId = null;
  if (!threadId && ids.length) {
    const [r] = await conn.query("INSERT INTO chat_threads (tenant_id, kind, name, created_by) VALUES (?, 'group', ?, ?)", [t, THREAD_NAME, byUser]);
    threadId = r.insertId;
    await conn.query('UPDATE patrol_cover_settings SET thread_id = ? WHERE tenant_id = ?', [threadId, t]);
  }
  if (!threadId) return null;
  const { top } = await one(conn, 'SELECT COALESCE(MAX(id), 0) AS top FROM chat_messages WHERE tenant_id = ? AND thread_id = ?', [t, threadId]);
  const current = new Set((await rows(conn, 'SELECT user_id FROM chat_members WHERE tenant_id = ? AND thread_id = ? AND left_at IS NULL', [t, threadId])).map((r) => Number(r.user_id)));
  for (const u of ids) {
    if (current.has(u)) continue;
    await conn.query(`INSERT INTO chat_members (thread_id, tenant_id, user_id, visible_from_id, last_read_id) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE left_at = NULL, visible_from_id = VALUES(visible_from_id), last_read_id = VALUES(last_read_id)`, [threadId, t, u, top, top]);
  }
  for (const u of current) if (!ids.includes(u)) await conn.query('UPDATE chat_members SET left_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND thread_id = ? AND user_id = ?', [t, threadId, u]);
  return threadId;
}

/** Post to the cover conversation. Never fails the change it reports. */
async function announce(conn, t, byUser, text) {
  try { await postSystem(conn, t, await syncThread(conn, t, byUser), text); } catch (err) { console.warn('Could not post to the cover conversation:', err.message); }
}

/** Logins that build the patrol schedule (roster members whose access includes it); owners and managers if none. */
async function schedulers(db, t) {
  const m = await PA.matrix(db, t);
  const out = [];
  for (const r of await rosterLogins(db, t)) {
    const ex = await PA.exceptionsOf(db, t, r.staff_id);
    if (PA.effective(m[r.level] || {}, r.level, ex).has('manage_schedule')) out.push(r.user_id);
  }
  if (out.length) return out;
  return (await rows(db, "SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner', 'manager')", [t])).map((u) => Number(u.id));
}

async function tellUsers(conn, t, from, users, text) {
  for (const u of users) { try { await direct(conn, t, from, u, text); } catch (err) { console.warn('Could not send a cover message:', err.message); } }
}

const started = (r, now) => String(r.starts_at) <= now;
/** The status people see: an open or pending request whose shift has started is expired. */
const shown = (r, now) => ((r.status === 'open' || r.status === 'pending') && started(r, now) ? 'expired' : r.status);
const shape = (r, now) => ({
  id: Number(r.id), patrol_shift_id: Number(r.patrol_shift_id), staff_id: Number(r.staff_id), name: r.name, reason: r.reason, status: shown(r, now),
  taken_by: r.taken_by ? Number(r.taken_by) : null, taken_by_name: r.taken_by ? r.taken_by_name : null, taken_at: r.taken_at, decided_note: r.decided_note,
  starts_at: r.starts_at, ends_at: r.ends_at, station: r.station, role_label: r.role_label, shift_notes: r.shift_notes, created_at: r.created_at, updated_at: r.updated_at,
});

/**
 * The cover board: requests waiting for someone (with whether I can take each, and why not), my upcoming published
 * shifts with any request on them, requests waiting for approval (schedule builders), and the last two weeks' history.
 */
router.get('/cover', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const me = req.auth.staffId ? Number(req.auth.staffId) : null;
  const now = nowIn(await tzOf(pool, t));
  const [canManage, settings, onRoster] = await Promise.all([
    PA.can(pool, req, 'manage_schedule'), settingsOf(pool, t),
    me ? one(pool, "SELECT m.staff_id FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id WHERE m.tenant_id = ? AND m.staff_id = ? AND s.status = 'active'", [t, me]) : null,
  ]);
  const live = await rows(pool, `${SELECT} WHERE r.tenant_id = ? AND r.status IN ('open', 'pending') AND ps.starts_at > ? ORDER BY ps.starts_at, r.id`, [t, now]);
  const open = [];
  for (const r of live.filter((x) => x.status === 'open')) {
    const out = shape(r, now);
    out.mine = me === Number(r.staff_id);
    out.problems = out.mine ? [] : !onRoster ? ['You are not an active member of the patrol roster'] : await problemsFor(pool, t, me, r.starts_at, r.ends_at, Number(r.patrol_shift_id));
    out.can_take = !out.mine && !out.problems.length;
    open.push(out);
  }
  const pending = live.filter((x) => x.status === 'pending').filter((x) => canManage || me === Number(x.staff_id) || me === Number(x.taken_by)).map((x) => shape(x, now));
  const myShifts = me ? await rows(pool, `SELECT ps.id, ps.starts_at, ps.ends_at, ps.role_label, ps.notes, st.name AS station,
      (SELECT r.id FROM patrol_cover_requests r WHERE r.tenant_id = ps.tenant_id AND r.patrol_shift_id = ps.id AND r.status IN ('open', 'pending') ORDER BY r.id DESC LIMIT 1) AS request_id
    FROM patrol_shifts ps LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id
    WHERE ps.tenant_id = ? AND ps.staff_id = ? AND ps.status = 'published' AND ps.starts_at > ? ORDER BY ps.starts_at LIMIT 60`, [t, me, now]) : [];
  const history = await rows(pool, `${SELECT} WHERE r.tenant_id = ? AND (r.status IN ('covered', 'withdrawn', 'closed') OR ps.starts_at <= ?) AND r.updated_at >= UTC_TIMESTAMP() - INTERVAL 14 DAY
    ${canManage ? '' : 'AND (r.staff_id = ? OR r.taken_by = ? OR r.status = \'covered\')'} ORDER BY r.updated_at DESC LIMIT 40`, canManage ? [t, now] : [t, now, me || 0, me || 0]);
  res.json({
    me, on_roster: Boolean(onRoster), can_manage: canManage, needs_approval: settings.needs_approval,
    open, pending, history: history.map((x) => shape(x, now)),
    my_shifts: myShifts.map((s) => ({ ...s, id: Number(s.id), request_id: s.request_id ? Number(s.request_id) : null })),
  });
});

/** Ask for cover on one of my published patrol shifts that has not started (schedule builders can ask for anyone). */
router.post('/cover', patrol, validate(z.object({ patrol_shift_id: z.number().int().positive(), reason: z.string().trim().max(200).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const canManage = await PA.can(pool, req, 'manage_schedule');
  const out = await tx(async (conn) => {
    const s = await one(conn, 'SELECT ps.*, st.name AS station FROM patrol_shifts ps LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id WHERE ps.tenant_id = ? AND ps.id = ? FOR UPDATE', [t, req.body.patrol_shift_id]);
    if (!s) throw notFound('Patrol shift');
    if (!s.staff_id) throw bad('This shift is open, so there is no one to cover for. Anyone can be put on it from the schedule.');
    const mine = req.auth.staffId && Number(req.auth.staffId) === Number(s.staff_id);
    if (!mine && !canManage) throw forbidden('You can only ask for cover on your own shifts');
    if (s.status !== 'published') throw bad(s.status === 'draft' ? 'This shift is not published yet. Change it on the schedule instead.' : 'This shift is cancelled');
    if (String(s.starts_at) <= nowIn(await tzOf(conn, t))) throw bad('This shift has already started');
    if (await one(conn, "SELECT id FROM patrol_cover_requests WHERE tenant_id = ? AND patrol_shift_id = ? AND status IN ('open', 'pending')", [t, s.id])) throw conflict('Cover has already been asked for on this shift');
    const [r] = await conn.query('INSERT INTO patrol_cover_requests (tenant_id, patrol_shift_id, staff_id, reason, created_by) VALUES (?, ?, ?, ?, ?)', [t, s.id, s.staff_id, req.body.reason || null, req.auth.userId]);
    await audit(conn, req, 'request_cover', 'patrol_cover_requests', r.insertId, { patrol_shift_id: Number(s.id) });
    const row = await requestOf(conn, t, r.insertId);
    await announce(conn, t, req.auth.userId, `Cover needed: ${when(row)}, for ${row.name}.${row.reason ? ` "${row.reason}"` : ''}\nOpen Patrol, Team, Cover to take it.`);
    if (!mine) await SH.tell(conn, t, req.auth.userId, Number(s.staff_id), `Cover has been asked for on your patrol shift ${when(row)}. You stay on it until someone takes it.`);
    return { id: r.insertId, status: 'open' };
  });
  res.status(201).json(out);
});

/** Move the shift to the person covering it, close the request and tell everyone. Inside the caller's transaction. */
async function handOver(conn, req, r, takerId, approver) {
  const t = req.auth.tenantId;
  const problems = await problemsFor(conn, t, takerId, r.starts_at, r.ends_at, Number(r.patrol_shift_id));
  if (problems.length) throw conflict(approver ? 'They can no longer take this shift' : 'You cannot take this shift', problems);
  await conn.query('UPDATE patrol_shifts SET staff_id = ? WHERE tenant_id = ? AND id = ?', [takerId, t, r.patrol_shift_id]);
  await conn.query("UPDATE patrol_cover_requests SET status = 'covered', taken_by = ?, taken_at = COALESCE(taken_at, UTC_TIMESTAMP()), decided_by = ? WHERE tenant_id = ? AND id = ?", [takerId, approver ? req.auth.userId : null, t, r.id]);
  const done = await requestOf(conn, t, r.id);
  await SH.tell(conn, t, req.auth.userId, Number(r.staff_id), `${done.taken_by_name} is covering your patrol shift ${when(done)}. You are off it.`);
  if (approver) await SH.tell(conn, t, req.auth.userId, takerId, `Approved: you are covering ${done.name}'s patrol shift ${when(done)}.${done.shift_notes ? ` Note: ${done.shift_notes}` : ''}`);
  await announce(conn, t, req.auth.userId, `Covered: ${when(done)}. ${done.taken_by_name} is covering for ${done.name}.`);
  return done;
}

/** Take a shift someone asked cover for. It moves to me now, or waits for a schedule builder when approval is on. */
router.post('/cover/:id/take', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const me = req.auth.staffId ? Number(req.auth.staffId) : null;
  if (!me) throw forbidden('Your login is not linked to anyone on the patrol roster');
  const out = await tx(async (conn) => {
    const r = await requestOf(conn, t, paramId(req), true);
    if (!r) throw notFound('Cover request');
    await conn.query('SELECT id FROM patrol_shifts WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, r.patrol_shift_id]);
    if (Number(r.staff_id) === me) throw bad('This is your own shift. Withdraw the request instead.');
    if (r.status !== 'open') throw conflict(r.status === 'pending' ? 'Someone has already offered to take this shift' : 'This shift no longer needs cover');
    if (String(r.starts_at) <= nowIn(await tzOf(conn, t))) throw conflict('This shift has already started');
    const settings = await settingsOf(conn, t);
    if (!settings.needs_approval) {
      const done = await handOver(conn, req, r, me, false);
      await audit(conn, req, 'take_cover', 'patrol_cover_requests', r.id, { patrol_shift_id: Number(r.patrol_shift_id) });
      return { status: 'covered', shift: done };
    }
    const problems = await problemsFor(conn, t, me, r.starts_at, r.ends_at, Number(r.patrol_shift_id));
    if (problems.length) throw conflict('You cannot take this shift', problems);
    await conn.query("UPDATE patrol_cover_requests SET status = 'pending', taken_by = ?, taken_at = UTC_TIMESTAMP(), decided_note = NULL WHERE tenant_id = ? AND id = ?", [me, t, r.id]);
    await audit(conn, req, 'offer_cover', 'patrol_cover_requests', r.id);
    const row = await requestOf(conn, t, r.id);
    await SH.tell(conn, t, req.auth.userId, Number(r.staff_id), `${row.taken_by_name} offered to cover your patrol shift ${when(row)}. It is yours until it is approved.`);
    await tellUsers(conn, t, req.auth.userId, (await schedulers(conn, t)).filter((u) => u !== req.auth.userId),
      `Shift cover to approve: ${row.taken_by_name} offered to cover ${row.name}'s patrol shift ${when(row)}. Approve or decline it in Patrol, Team, Cover.`);
    return { status: 'pending' };
  });
  res.json(out);
});

/** A schedule builder approves an offer: the shift moves to the person who offered. */
router.post('/cover/:id/approve', patrol, PA.needs(pool, 'manage_schedule', 'Only those who build the patrol schedule can approve cover'), async (req, res) => {
  const t = req.auth.tenantId;
  const done = await tx(async (conn) => {
    const r = await requestOf(conn, t, paramId(req), true);
    if (!r) throw notFound('Cover request');
    await conn.query('SELECT id FROM patrol_shifts WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, r.patrol_shift_id]);
    if (r.status !== 'pending') throw conflict('There is no offer to approve on this request');
    if (String(r.starts_at) <= nowIn(await tzOf(conn, t))) throw conflict('This shift has already started');
    const out = await handOver(conn, req, r, Number(r.taken_by), true);
    await audit(conn, req, 'approve_cover', 'patrol_cover_requests', r.id);
    return out;
  });
  res.json({ status: 'covered', shift: done });
});

/** A schedule builder declines an offer: the request is open again for someone else. */
router.post('/cover/:id/decline', patrol, PA.needs(pool, 'manage_schedule', 'Only those who build the patrol schedule can decline cover'), validate(z.object({ note: z.string().trim().max(200).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await requestOf(conn, t, paramId(req), true);
    if (!r) throw notFound('Cover request');
    if (r.status !== 'pending') throw conflict('There is no offer to decline on this request');
    await conn.query("UPDATE patrol_cover_requests SET status = 'open', taken_by = NULL, taken_at = NULL, decided_by = ?, decided_note = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, req.body.note || null, t, r.id]);
    await audit(conn, req, 'decline_cover', 'patrol_cover_requests', r.id, { note: req.body.note || null });
    const note = req.body.note ? ` "${req.body.note}"` : '';
    await SH.tell(conn, t, req.auth.userId, Number(r.taken_by), `Your offer to cover ${r.name}'s patrol shift ${when(r)} was not approved.${note}`);
    await SH.tell(conn, t, req.auth.userId, Number(r.staff_id), `${r.taken_by_name}'s offer to cover your patrol shift ${when(r)} was not approved.${note} It is open for someone else to take.`);
  });
  res.json({ status: 'open' });
});

/** The patroller who asked (or a schedule builder) takes the request back: they stay on the shift. */
router.post('/cover/:id/withdraw', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const canManage = await PA.can(pool, req, 'manage_schedule');
  await tx(async (conn) => {
    const r = await requestOf(conn, t, paramId(req), true);
    if (!r) throw notFound('Cover request');
    const mine = req.auth.staffId && Number(req.auth.staffId) === Number(r.staff_id);
    if (!mine && !canManage) throw forbidden('Only the patroller who asked can withdraw this request');
    if (!['open', 'pending'].includes(r.status)) throw conflict('This request is already closed');
    await conn.query("UPDATE patrol_cover_requests SET status = 'withdrawn', decided_by = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, t, r.id]);
    await audit(conn, req, 'withdraw_cover', 'patrol_cover_requests', r.id);
    if (r.status === 'pending') await SH.tell(conn, t, req.auth.userId, Number(r.taken_by), `${r.name} no longer needs cover for ${when(r)}, so you are not on it. Thanks for offering.`);
    if (!mine) await SH.tell(conn, t, req.auth.userId, Number(r.staff_id), `The cover request on your patrol shift ${when(r)} was withdrawn. You are still on it.`);
    await announce(conn, t, req.auth.userId, `No longer needed: ${when(r)} (${r.name}).`);
  });
  res.json({ status: 'withdrawn' });
});

/** Whether a schedule builder approves each swap before the shift moves. */
router.put('/cover/settings', patrol, PA.needs(pool, 'manage_schedule', 'Only those who build the patrol schedule can change how cover works'), validate(z.object({ needs_approval: z.boolean() })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    await conn.query('INSERT INTO patrol_cover_settings (tenant_id, needs_approval, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE needs_approval = VALUES(needs_approval), updated_by = VALUES(updated_by)', [t, req.body.needs_approval ? 1 : 0, req.auth.userId]);
    await audit(conn, req, 'update', 'patrol_cover_settings', null, req.body);
  });
  res.json({ needs_approval: req.body.needs_approval });
});

/**
 * The schedule changed a shift under a live request (cancelled it, or put someone else on it): the request no longer
 * applies. Called from the schedule routes inside their transaction. When the schedule gives the shift to someone other
 * than the person who asked, that counts as covered by them.
 */
async function afterShiftChange(conn, req, before, after) {
  const t = req.auth.tenantId;
  const live = await rows(conn, "SELECT id, status, staff_id, taken_by FROM patrol_cover_requests WHERE tenant_id = ? AND patrol_shift_id = ? AND status IN ('open', 'pending') FOR UPDATE", [t, before.id]);
  if (!live.length) return;
  const cancelled = !after || after.status === 'cancelled';
  const newStaff = !cancelled && after.staff_id ? Number(after.staff_id) : null;
  if (!cancelled && newStaff === Number(before.staff_id)) return; // times or station changed; the request still applies
  for (const r of live) {
    if (!cancelled && newStaff && newStaff !== Number(r.staff_id)) {
      await conn.query("UPDATE patrol_cover_requests SET status = 'covered', taken_by = ?, taken_at = UTC_TIMESTAMP(), decided_by = ? WHERE tenant_id = ? AND id = ?", [newStaff, req.auth.userId, t, r.id]);
    } else {
      await conn.query("UPDATE patrol_cover_requests SET status = 'closed', decided_by = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, t, r.id]);
    }
    if (r.status === 'pending' && Number(r.taken_by) !== newStaff) {
      await SH.tell(conn, t, req.auth.userId, Number(r.taken_by), `The patrol shift ${when({ ...before })} you offered to cover was ${cancelled ? 'cancelled' : 'changed on the schedule'}, so your offer is closed.`);
    }
  }
}

module.exports = { router, afterShiftChange, syncThread, THREAD_NAME };
