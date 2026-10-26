'use strict';

// Patrol crews (mounted under /patrol): the repeating shifts a patrol runs (the Saturday day crew), how many each needs
// and the roles it must have, its standing members, and generating the season's spots from it. Also the sign-ups waiting
// for approval, the storm-day call for extra patrollers, and the Thursday check of the coming weekend.
//
// A generated spot is an ordinary patrol shift (patrol_shifts) with crew_id set, so publishing, cover, sign-in and days
// patrolled work on it as on any other shift. The rules (dates, spots, coverage, who fits a role) are in lib/patrolcrews.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId } = require('../lib/util');
const { notFound, bad, conflict, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { span } = require('../lib/workforce');
const PA = require('../lib/patrolaccess');
const OPS = require('../lib/patrolops');
const SH = require('../lib/shifts');
const C = require('../lib/patrolcrews');
const { problemsFor } = require('./patrolschedule');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const editor = PA.needs(pool, 'manage_schedule', 'Only those who build the patrol schedule can change crews');
const NAME = "CONCAT(p.first_name, ' ', p.last_name)";
const cover = () => require('./patrolcover');
const when = (s) => `${span(s.starts_at, s.ends_at)}${s.station ? ` at ${s.station}` : ''}${s.role_label ? `, ${s.role_label}` : ''}`;

const shape = (c) => ({
  id: Number(c.id), name: c.name, days: C.daysOf(c), start_time: String(c.start_time).slice(0, 5), end_time: String(c.end_time).slice(0, 5),
  station_id: c.station_id ? Number(c.station_id) : null, station: c.station || null, target: Number(c.target), minimum: Number(c.minimum), roles: C.rolesOf(c),
  from_date: c.from_date ? String(c.from_date).slice(0, 10) : null, to_date: c.to_date ? String(c.to_date).slice(0, 10) : null,
  skip_dates: [...C.skipsOf(c)].sort(), active: Boolean(Number(c.active)), summary: C.summary(c), rotation: C.rotationOf(c),
});
const crewsOf = async (db, t, all = false) => (await rows(db, `SELECT c.*, st.name AS station FROM patrol_crews c LEFT JOIN patrol_stations st ON st.tenant_id = c.tenant_id AND st.id = c.station_id
  WHERE c.tenant_id = ? ${all ? '' : 'AND c.active = 1'} ORDER BY c.active DESC, c.start_time, c.name`, [t])).map(shape);
const crewOf = async (db, t, id) => {
  const c = await one(db, 'SELECT c.*, st.name AS station FROM patrol_crews c LEFT JOIN patrol_stations st ON st.tenant_id = c.tenant_id AND st.id = c.station_id WHERE c.tenant_id = ? AND c.id = ?', [t, id]);
  if (!c) throw notFound('Crew');
  return shape(c);
};
const membersOf = async (db, t) => new Map((await rows(db, 'SELECT staff_id, level, cert_level FROM patrol_members WHERE tenant_id = ?', [t])).map((m) => [Number(m.staff_id), m]));

/**
 * Each crew's coverage on each of its days in [from, to] (the days it runs, plus any day with its spots), from the shifts
 * given or read here. Drafts count for those who build the schedule; patrollers see published spots only.
 */
async function coverageRange(db, t, from, to, { shifts = null, drafts = true } = {}) {
  const crews = await crewsOf(db, t);
  if (!crews.length) return { crews: [], days: [] };
  const list = shifts || await rows(db, `SELECT id, crew_id, staff_id, status, role_label, starts_at FROM patrol_shifts WHERE tenant_id = ? AND crew_id IS NOT NULL AND status ${drafts ? "<> 'cancelled'" : "= 'published'"} AND DATE(starts_at) BETWEEN ? AND ?`, [t, from, to]);
  const members = await membersOf(db, t);
  const teamNames = new Map((await rows(db, 'SELECT id, name FROM patrol_teams WHERE tenant_id = ?', [t])).map((x) => [Number(x.id), x.name]));
  const days = [];
  for (const crew of crews) {
    const mine = list.filter((s) => Number(s.crew_id) === crew.id);
    const dates = new Set([...C.datesFor(crew, from, to), ...mine.map((s) => String(s.starts_at).slice(0, 10))]);
    for (const date of [...dates].sort()) {
      const spots = mine.filter((s) => String(s.starts_at).startsWith(date));
      const team = C.teamFor(crew, date);
      days.push({ date, crew_id: crew.id, crew: crew.name, team_id: team, team: team ? (teamNames.get(team) || null) : null, generated: spots.length > 0, ...C.coverage(crew, spots, members) });
    }
  }
  days.sort((a, b) => a.date.localeCompare(b.date) || a.crew.localeCompare(b.crew));
  return { crews, days };
}

/**
 * What the week view adds to the schedule: each crew's coverage by day, a no-show mark on spots nobody signed in for
 * (15 minutes after the start), the sign-ups waiting for approval, and the sign-up settings.
 */
async function weekExtras(db, t, from, to, shifts, canEdit) {
  const { now } = await OPS.clock(db, t);
  const duty = await rows(db, 'SELECT staff_id, on_date, patrol_shift_id FROM patrol_duty WHERE tenant_id = ? AND on_date BETWEEN ? AND ?', [t, from, to]);
  const inDay = new Set(duty.map((d) => `${Number(d.staff_id)}|${String(d.on_date).slice(0, 10)}`));
  for (const s of shifts) {
    const signedIn = s.staff_id && inDay.has(`${Number(s.staff_id)}|${String(s.starts_at).slice(0, 10)}`);
    s.signed_in = Boolean(signedIn);
    s.no_show = C.isNoShow(s, now, signedIn);
  }
  const cov = await coverageRange(db, t, from, to, { shifts: shifts.filter((s) => s.crew_id), drafts: canEdit });
  const ops = await OPS.settingsOf(db, t);
  const signups = canEdit ? await pendingSignups(db, t) : [];
  return { crews: cov.crews, coverage: cov.days, signups, self_signup: ops.self_signup, signup_approval: ops.signup_approval, now };
}

async function pendingSignups(db, t) {
  const list = await rows(db, `SELECT su.id, su.staff_id, su.created_at, ${NAME} AS name, m.level, ps.id AS shift_id, ps.starts_at, ps.ends_at, ps.role_label, ps.staff_id AS taken_by, st.name AS station, cr.name AS crew
    FROM patrol_signups su JOIN patrol_shifts ps ON ps.tenant_id = su.tenant_id AND ps.id = su.patrol_shift_id
    JOIN staff s ON s.tenant_id = su.tenant_id AND s.id = su.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    LEFT JOIN patrol_members m ON m.tenant_id = su.tenant_id AND m.staff_id = su.staff_id
    LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id LEFT JOIN patrol_crews cr ON cr.tenant_id = ps.tenant_id AND cr.id = ps.crew_id
    WHERE su.tenant_id = ? AND su.status = 'pending' AND ps.status = 'published' AND ps.starts_at > UTC_TIMESTAMP() - INTERVAL 1 DAY ORDER BY ps.starts_at, su.id LIMIT 200`, [t]);
  return list.map((x) => ({ ...x, id: Number(x.id), staff_id: Number(x.staff_id), shift_id: Number(x.shift_id), taken: Boolean(x.taken_by) }));
}

// ---------------------------------------------------------------- crews
const time = z.string().regex(/^\d{2}:\d{2}$/, 'Times as HH:MM');
const role = z.object({
  label: z.string().trim().min(1).max(60),
  count: z.number().int().min(1).max(20).default(1),
  rank: z.enum(C.RANKS).nullable().optional(),
  cert: z.enum(C.CERTS).nullable().optional(),
});
const crewFields = {
  name: z.string().trim().min(1).max(80),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start_time: time,
  end_time: time,
  station_id: z.number().int().positive().nullable().optional(),
  target: z.number().int().min(1).max(60),
  minimum: z.number().int().min(0).max(60),
  roles: z.array(role).max(10).default([]),
  from_date: dateStr.nullable().optional(),
  to_date: dateStr.nullable().optional(),
  skip_dates: z.array(dateStr).max(120).default([]),
  rotation: z.object({ teams: z.array(z.number().int().positive()).min(2).max(12), start: dateStr, every: z.enum(['week', 'day']) }).nullable().optional(),
};

async function checkCrew(conn, t, c) {
  if (c.minimum > c.target) throw bad('The fewest it can run with cannot be more than the number it needs');
  if (c.start_time === c.end_time) throw bad('The crew must end after it starts');
  if (c.from_date && c.to_date && c.to_date < c.from_date) throw bad('The season must end after it starts');
  if (c.station_id && !(await one(conn, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, c.station_id]))) throw notFound('Station');
  if (c.rotation) {
    if (new Set(c.rotation.teams).size !== c.rotation.teams.length) throw bad('Each team takes one turn in the rotation');
    const found = await rows(conn, 'SELECT id FROM patrol_teams WHERE tenant_id = ? AND id IN (?)', [t, c.rotation.teams]);
    if (found.length !== c.rotation.teams.length) throw notFound('Team');
  }
  const labels = c.roles.map((r) => r.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw bad('Each role needs its own name');
}
const row = (c) => [c.name, [...new Set(c.days)].sort().join(','), `${c.start_time}:00`, `${c.end_time}:00`, c.station_id || null, c.target, c.minimum, JSON.stringify(c.roles || []), c.from_date || null, c.to_date || null, [...new Set(c.skip_dates || [])].sort().join(',') || null, c.rotation ? JSON.stringify(c.rotation) : null];

/** The crews, each with its standing members, and what the forms need (roster with rank and certification, stations). */
router.get('/crews', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const [crews, standing, roster, stations] = await Promise.all([
    crewsOf(pool, t, req.query.all === '1'),
    rows(pool, `SELECT cm.crew_id, cm.staff_id, cm.role_label, ${NAME} AS name FROM patrol_crew_members cm JOIN staff s ON s.tenant_id = cm.tenant_id AND s.id = cm.staff_id
      JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE cm.tenant_id = ? ORDER BY p.last_name, p.first_name`, [t]),
    rows(pool, `SELECT m.staff_id, m.level, m.cert_level, ${NAME} AS name FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id
      JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE m.tenant_id = ? AND s.status = 'active' ORDER BY p.last_name, p.first_name`, [t]),
    rows(pool, 'SELECT id, name FROM patrol_stations WHERE tenant_id = ? ORDER BY name', [t]),
  ]);
  const teams = await teamsOf(pool, t);
  res.json({
    can_edit: await PA.can(pool, req, 'manage_schedule'),
    teams,
    crews: crews.map((c) => ({ ...c, members: standing.filter((m) => Number(m.crew_id) === c.id).map((m) => ({ staff_id: Number(m.staff_id), name: m.name, role_label: m.role_label })) })),
    roster: roster.map((r) => ({ ...r, staff_id: Number(r.staff_id) })), stations,
    ranks: C.RANKS.map((k) => [k, C.RANK_LABEL[k]]), certs: C.CERTS.filter((k) => k !== 'none').map((k) => [k, C.CERT_LABEL[k]]),
  });
});

router.post('/crews', patrol, editor, validate(z.object(crewFields)), async (req, res) => {
  const t = req.auth.tenantId;
  const id = await tx(async (conn) => {
    await checkCrew(conn, t, req.body);
    const [r] = await conn.query('INSERT INTO patrol_crews (tenant_id, name, days, start_time, end_time, station_id, target, minimum, roles, from_date, to_date, skip_dates, rotation, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [t, ...row(req.body), req.auth.userId]);
    await audit(conn, req, 'create', 'patrol_crews', r.insertId, { name: req.body.name });
    return r.insertId;
  });
  res.status(201).json(await crewOf(pool, t, id));
});

/**
 * Change a crew. Spots already generated keep their times; a change applies to days generated after it (the reply
 * says how many upcoming draft days there are, so they can be cleared and made again).
 */
router.patch('/crews/:id', patrol, editor, validate(z.object({ ...crewFields, active: z.boolean() }).partial()), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  await tx(async (conn) => {
    const before = await crewOf(conn, t, id);
    const next = { ...before, ...Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)) };
    await checkCrew(conn, t, next);
    await conn.query('UPDATE patrol_crews SET name = ?, days = ?, start_time = ?, end_time = ?, station_id = ?, target = ?, minimum = ?, roles = ?, from_date = ?, to_date = ?, skip_dates = ?, rotation = ?, active = ? WHERE tenant_id = ? AND id = ?',
      [...row(next), next.active ? 1 : 0, t, id]);
    await audit(conn, req, 'update', 'patrol_crews', id, req.body);
  });
  res.json(await crewOf(pool, t, id));
});

/** Retire a crew: no more days are made from it. Its spots stay on the schedule. */
router.delete('/crews/:id', patrol, editor, async (req, res) => {
  const t = req.auth.tenantId;
  const [r] = await pool.query('UPDATE patrol_crews SET active = 0 WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
  if (!r.affectedRows) throw notFound('Crew');
  await audit(pool, req, 'retire', 'patrol_crews', paramId(req));
  res.status(204).end();
});

// ---------------------------------------------------------------- rotating teams
async function teamsOf(db, t) {
  const teams = await rows(db, 'SELECT id, name, active FROM patrol_teams WHERE tenant_id = ? ORDER BY active DESC, name', [t]);
  const mem = await rows(db, `SELECT tm.team_id, tm.staff_id, tm.role_label, ${NAME} AS name FROM patrol_team_members tm JOIN staff s ON s.tenant_id = tm.tenant_id AND s.id = tm.staff_id
    JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE tm.tenant_id = ? ORDER BY p.last_name, p.first_name`, [t]);
  return teams.map((x) => ({ id: Number(x.id), name: x.name, active: Boolean(Number(x.active)), members: mem.filter((m) => Number(m.team_id) === Number(x.id)).map((m) => ({ staff_id: Number(m.staff_id), name: m.name, role_label: m.role_label })) }));
}
router.get('/teams', patrol, async (req, res) => { res.json({ data: await teamsOf(pool, req.auth.tenantId) }); });
router.post('/teams', patrol, editor, validate(z.object({ name: z.string().trim().min(1).max(60) })), async (req, res) => {
  try {
    const [r] = await pool.query('INSERT INTO patrol_teams (tenant_id, name) VALUES (?, ?)', [req.auth.tenantId, req.body.name]);
    await audit(pool, req, 'create', 'patrol_teams', r.insertId);
    res.status(201).json({ id: r.insertId });
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('There is already a team with that name'); throw e; }
});
router.patch('/teams/:id', patrol, editor, validate(z.object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional() })), async (req, res) => {
  const sets = []; const vals = [];
  if (req.body.name) { sets.push('name = ?'); vals.push(req.body.name); }
  if (req.body.active !== undefined) { sets.push('active = ?'); vals.push(req.body.active ? 1 : 0); }
  if (!sets.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE patrol_teams SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Team');
  res.json({ ok: true });
});
/** A team's members, each with the role they hold when it is their turn (a team's own hill captain, say). */
router.put('/teams/:id/members', patrol, editor, validate(z.object({ members: z.array(z.object({ staff_id: z.number().int().positive(), role_label: z.string().trim().max(60).nullable().optional() })).max(80) })), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM patrol_teams WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Team');
    for (const m of req.body.members) if (!(await one(conn, 'SELECT staff_id FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [t, m.staff_id]))) throw bad('Everyone on a team must be on the patrol roster');
    await conn.query('DELETE FROM patrol_team_members WHERE tenant_id = ? AND team_id = ?', [t, id]);
    for (const m of req.body.members) await conn.query('INSERT IGNORE INTO patrol_team_members (tenant_id, team_id, staff_id, role_label) VALUES (?, ?, ?, ?)', [t, id, m.staff_id, m.role_label || null]);
    await audit(conn, req, 'team_members', 'patrol_teams', id, { count: req.body.members.length });
  });
  res.json({ ok: true });
});

/** The crew's standing members: put on its spots first whenever its days are generated (each to their role, if any). */
router.put('/crews/:id/members', patrol, editor, validate(z.object({ members: z.array(z.object({ staff_id: z.number().int().positive(), role_label: z.string().trim().max(60).nullable().optional() })).max(60) })), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  await tx(async (conn) => {
    const crew = await crewOf(conn, t, id);
    const roles = new Set(crew.roles.map((r) => r.label));
    for (const m of req.body.members) {
      if (!(await one(conn, 'SELECT staff_id FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [t, m.staff_id]))) throw bad('Everyone on a crew must be on the patrol roster');
      if (m.role_label && !roles.has(m.role_label)) throw bad(`${crew.name} has no role called ${m.role_label}`);
    }
    await conn.query('DELETE FROM patrol_crew_members WHERE tenant_id = ? AND crew_id = ?', [t, id]);
    for (const m of req.body.members) await conn.query('INSERT IGNORE INTO patrol_crew_members (tenant_id, crew_id, staff_id, role_label) VALUES (?, ?, ?, ?)', [t, id, m.staff_id, m.role_label || null]);
    await audit(conn, req, 'standing_members', 'patrol_crews', id, { count: req.body.members.length });
  });
  res.json({ ok: true });
});

/**
 * Make the crew's spots for its days in [from, to] as drafts. A day that already has the crew's spots is skipped. Each
 * standing member goes on a spot that fits them (their role's spot first) when they are free; anyone who cannot be put
 * on is listed with why, and their spot is left open for sign-up.
 */
router.post('/crews/:id/generate', patrol, editor, validate(z.object({ from: dateStr, to: dateStr })), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  const { from, to } = req.body;
  if (to < from) throw bad('Choose an end date after the start');
  const out = await tx(async (conn) => {
    const crew = await crewOf(conn, t, id);
    if (!crew.active) throw conflict('This crew is retired');
    const { today } = await OPS.clock(conn, t);
    const dates = C.datesFor(crew, from < today ? today : from, to);
    if (dates.length > 250) throw bad('Generate at most 250 days at a time');
    const members = await membersOf(conn, t);
    const standing = (await rows(conn, `SELECT cm.staff_id, cm.role_label, ${NAME} AS name FROM patrol_crew_members cm JOIN staff s ON s.tenant_id = cm.tenant_id AND s.id = cm.staff_id
      JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE cm.tenant_id = ? AND cm.crew_id = ? AND s.status = 'active'`, [t, id]))
      .map((m) => ({ ...m, staff_id: Number(m.staff_id), ...members.get(Number(m.staff_id)) }));
    // Rotating teams: each team's members, put on their crew's days in turn alongside the standing members.
    const teamMembers = new Map();
    if (crew.rotation) {
      for (const r of await rows(conn, `SELECT tm.team_id, tm.staff_id, tm.role_label, ${NAME} AS name FROM patrol_team_members tm JOIN patrol_teams pt ON pt.id = tm.team_id AND pt.active = 1
        JOIN staff s ON s.tenant_id = tm.tenant_id AND s.id = tm.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE tm.tenant_id = ? AND tm.team_id IN (?) AND s.status = 'active'`, [t, crew.rotation.teams])) {
        const k = Number(r.team_id);
        if (!teamMembers.has(k)) teamMembers.set(k, []);
        teamMembers.get(k).push({ ...r, staff_id: Number(r.staff_id), ...members.get(Number(r.staff_id)) });
      }
    }
    const spots = C.spotsFor(crew);
    let made = 0; let created = 0; let filled = 0; let skipped = 0;
    const notPut = [];
    for (const date of dates) {
      if (await one(conn, "SELECT id FROM patrol_shifts WHERE tenant_id = ? AND crew_id = ? AND extra = 0 AND status <> 'cancelled' AND DATE(starts_at) = ? LIMIT 1", [t, id, date])) { skipped += 1; continue; }
      const { starts_at: s, ends_at: e } = C.timesOn(crew, date);
      // Standing members by preference: their own role's spot, then any plain spot they fit.
      const who = new Array(spots.length).fill(null);
      const left = [];
      const team = C.teamFor(crew, date);
      const todays = [...standing, ...(teamMembers.get(team) || []).filter((m) => !standing.some((x) => x.staff_id === m.staff_id))];
      for (const m of todays) {
        const problems = await problemsFor(conn, t, m.staff_id, s, e, 0, { need_rank: null, need_cert: null });
        if (problems.length) { notPut.push({ date, staff_id: m.staff_id, name: m.name, reason: problems[0] }); continue; }
        left.push(m);
      }
      const place = (m, test) => { const i = spots.findIndex((sp, k) => who[k] === null && test(sp) && C.fits(m, sp)); if (i >= 0) { who[i] = m; return true; } return false; };
      for (const m of left.filter((x) => x.role_label)) if (!place(m, (sp) => sp.role_label === m.role_label)) place(m, (sp) => !sp.role_label);
      for (const m of left.filter((x) => !x.role_label)) place(m, (sp) => !sp.role_label);
      for (const m of left) if (!who.includes(m)) notPut.push({ date, staff_id: m.staff_id, name: m.name, reason: 'Every spot they fit was already taken' });
      for (let k = 0; k < spots.length; k += 1) {
        const sp = spots[k];
        await conn.query('INSERT INTO patrol_shifts (tenant_id, staff_id, starts_at, ends_at, station_id, role_label, crew_id, team_id, need_rank, need_cert, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [t, who[k] ? who[k].staff_id : null, s, e, crew.station_id, sp.role_label, id, team || null, sp.need_rank, sp.need_cert, req.auth.userId]);
        created += 1; if (who[k]) filled += 1;
      }
      made += 1;
    }
    await audit(conn, req, 'generate', 'patrol_crews', id, { from, to, days: made, created, filled, skipped });
    return { days: made, created, filled, skipped, not_put: notPut.slice(0, 80) };
  });
  res.json(out);
});

/** Take back the crew's draft spots in [from, to] (made by mistake, or the crew changed). Published spots stay. */
router.post('/crews/:id/clear', patrol, editor, validate(z.object({ from: dateStr, to: dateStr })), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  await crewOf(pool, t, id);
  const [r] = await pool.query("DELETE FROM patrol_shifts WHERE tenant_id = ? AND crew_id = ? AND status = 'draft' AND DATE(starts_at) BETWEEN ? AND ?", [t, id, req.body.from, req.body.to]);
  await audit(pool, req, 'clear_drafts', 'patrol_crews', id, { ...req.body, removed: r.affectedRows });
  res.json({ removed: r.affectedRows });
});

/** Each crew's coverage by day for a range (the season view): filled against needed, roles with nobody, and the tone. */
router.get('/crews/coverage', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const from = String(req.query.from || ''); const to = String(req.query.to || '');
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('from and to (YYYY-MM-DD) are required');
  if (Date.parse(to) - Date.parse(from) > 200 * 86_400_000) throw bad('Look at 200 days at most');
  res.json(await coverageRange(pool, t, from, to, { drafts: await PA.can(pool, req, 'manage_schedule') }));
});

/**
 * The storm-day call: add extra open spots to a crew's day (published at once) and message everyone on the roster who is
 * free that day and not already on it. They sign up on Team, Cover as for any open shift.
 */
router.post('/crews/call', patrol, editor, validate(z.object({ crew_id: z.number().int().positive(), date: dateStr, extra: z.number().int().min(1).max(20), note: z.string().trim().max(200).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  const out = await tx(async (conn) => {
    const crew = await crewOf(conn, t, b.crew_id);
    const { today } = await OPS.clock(conn, t);
    if (b.date < today) throw bad('That day has passed');
    const { starts_at: s, ends_at: e } = C.timesOn(crew, b.date);
    for (let i = 0; i < b.extra; i += 1) {
      await conn.query("INSERT INTO patrol_shifts (tenant_id, starts_at, ends_at, station_id, notes, crew_id, extra, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, 'published', ?)", [t, s, e, crew.station_id, b.note || 'Extra patrollers needed', b.crew_id, req.auth.userId]);
    }
    const roster = await rows(conn, "SELECT m.staff_id FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id WHERE m.tenant_id = ? AND s.status = 'active'", [t]);
    const ops = await OPS.settingsOf(conn, t);
    const how = ops.self_signup ? 'Sign up on Patrol, Team, Cover.' : 'Reply here or tell whoever builds the schedule.';
    const text = `Extra patrollers needed: ${crew.name}, ${C.DAY_LABEL[C.dayOf(b.date)]} ${b.date.slice(5).replace('-', '/')}, ${span(s, e)}. ${b.extra} more spot${b.extra === 1 ? '' : 's'}.${b.note ? ` ${b.note}` : ''} ${how}`;
    let told = 0;
    for (const r of roster) {
      const problems = await problemsFor(conn, t, Number(r.staff_id), s, e);
      if (problems.length) continue; // already on patrol, working or teaching then
      if (await SH.tell(conn, t, req.auth.userId, Number(r.staff_id), text)) told += 1;
    }
    await cover().announce(conn, t, req.auth.userId, text);
    await audit(conn, req, 'storm_call', 'patrol_crews', b.crew_id, { date: b.date, extra: b.extra, told });
    return { added: b.extra, told };
  });
  res.json(out);
});

// ---------------------------------------------------------------- sign-ups waiting for approval
router.get('/signups', patrol, editor, async (req, res) => { res.json({ data: await pendingSignups(pool, req.auth.tenantId) }); });

/** Approve a sign-up: the patroller goes on the spot; anyone else waiting on that spot is told it went to someone else. */
router.post('/signups/:id/approve', patrol, editor, async (req, res) => {
  const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const su = await one(conn, "SELECT * FROM patrol_signups WHERE tenant_id = ? AND id = ? AND status = 'pending' FOR UPDATE", [t, paramId(req)]);
    if (!su) throw notFound('Sign-up waiting for approval');
    const s = await one(conn, 'SELECT ps.*, st.name AS station FROM patrol_shifts ps LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id WHERE ps.tenant_id = ? AND ps.id = ? FOR UPDATE', [t, su.patrol_shift_id]);
    if (!s || s.status !== 'published') throw conflict('This shift is no longer on the schedule');
    if (s.staff_id) throw conflict('Someone is already on this shift. Decline this sign-up, or find them another spot.');
    const problems = await problemsFor(conn, t, Number(su.staff_id), s.starts_at, s.ends_at, Number(s.id));
    if (problems.length) throw conflict('They cannot take this shift now', problems);
    await conn.query('UPDATE patrol_shifts SET staff_id = ? WHERE tenant_id = ? AND id = ?', [su.staff_id, t, s.id]);
    await conn.query("UPDATE patrol_signups SET status = 'approved', decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [req.auth.userId, t, su.id]);
    await SH.tell(conn, t, req.auth.userId, Number(su.staff_id), `Approved: you are on the patrol shift ${when(s)}.`);
    // Others who asked for this same spot: offer them another open spot that day if there is one, else tell them.
    const others = await rows(conn, "SELECT id, staff_id FROM patrol_signups WHERE tenant_id = ? AND patrol_shift_id = ? AND status = 'pending' AND id <> ?", [t, s.id, su.id]);
    for (const o of others) {
      await conn.query("UPDATE patrol_signups SET status = 'declined', decided_by = ?, decided_at = UTC_TIMESTAMP(), note = 'Filled by someone else' WHERE tenant_id = ? AND id = ?", [req.auth.userId, t, o.id]);
      await SH.tell(conn, t, req.auth.userId, Number(o.staff_id), `The patrol shift ${when(s)} you asked for went to someone else. Other open shifts are on Patrol, Team, Cover.`);
    }
    await audit(conn, req, 'signup_approve', 'patrol_shifts', s.id, { staff_id: Number(su.staff_id) });
    return { ok: true };
  });
  res.json(out);
});

router.post('/signups/:id/decline', patrol, editor, validate(z.object({ note: z.string().trim().max(200).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const su = await one(conn, "SELECT su.*, ps.starts_at, ps.ends_at, ps.role_label, st.name AS station FROM patrol_signups su JOIN patrol_shifts ps ON ps.tenant_id = su.tenant_id AND ps.id = su.patrol_shift_id LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id WHERE su.tenant_id = ? AND su.id = ? AND su.status = 'pending' FOR UPDATE", [t, paramId(req)]);
    if (!su) throw notFound('Sign-up waiting for approval');
    await conn.query("UPDATE patrol_signups SET status = 'declined', decided_by = ?, decided_at = UTC_TIMESTAMP(), note = ? WHERE tenant_id = ? AND id = ?", [req.auth.userId, req.body.note || null, t, su.id]);
    await SH.tell(conn, t, req.auth.userId, Number(su.staff_id), `Not approved: the patrol shift ${when(su)}.${req.body.note ? ` ${req.body.note}` : ''}`);
    await audit(conn, req, 'signup_decline', 'patrol_shifts', su.patrol_shift_id, { staff_id: Number(su.staff_id) });
  });
  res.json({ ok: true });
});

/** Withdraw my own sign-up while it waits. */
router.delete('/signups/:id', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const su = await one(pool, "SELECT id, staff_id FROM patrol_signups WHERE tenant_id = ? AND id = ? AND status = 'pending'", [t, paramId(req)]);
  if (!su) throw notFound('Sign-up waiting for approval');
  if (Number(su.staff_id) !== Number(req.auth.staffId)) throw forbidden('Only the patroller who asked can withdraw it');
  await pool.query("UPDATE patrol_signups SET status = 'withdrawn', decided_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [t, su.id]);
  res.status(204).end();
});

// ---------------------------------------------------------------- the Thursday check
/**
 * The daily job: on Thursday, each patrol with the check on looks at Saturday and Sunday. Any crew below what it needs
 * (published spots) is messaged to those who build the schedule, and the open spots are posted to the cover conversation
 * so patrollers see them. Runs once per Thursday.
 */
async function shortAlertAll({ force = null, today: on = null } = {}) {
  const list = await rows(pool, "SELECT t.id AS tenant_id FROM tenants t WHERE t.status = 'active' AND EXISTS (SELECT 1 FROM patrol_crews c WHERE c.tenant_id = t.id AND c.active = 1)");
  let sent = 0;
  for (const { tenant_id: t } of list) {
    if (force && Number(force) !== Number(t)) continue;
    const st = await OPS.settingsOf(pool, t);
    const today = (force && on) || (await OPS.clock(pool, t)).today;
    const last = await one(pool, 'SELECT short_alert_last FROM patrol_settings WHERE tenant_id = ?', [t]);
    if (!force && (!st.short_alert || C.dayOf(today) !== 4 || (last && String(last.short_alert_last || '').slice(0, 10) === today))) continue;
    const from = await one(pool, "SELECT id FROM users WHERE tenant_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1", [t]);
    if (!from) continue;
    await pool.query('INSERT INTO patrol_settings (tenant_id, short_alert_last) VALUES (?, ?) ON DUPLICATE KEY UPDATE short_alert_last = VALUES(short_alert_last)', [t, today]);
    const { days } = await coverageRange(pool, t, C.addDays(today, 2), C.addDays(today, 3), { drafts: false });
    const short = days.filter((d) => d.tone !== 'good');
    if (!short.length) continue;
    const line = (d) => `- ${C.DAY_LABEL[C.dayOf(d.date)]} ${d.crew}: ${d.filled} of ${d.target}${d.filled < d.minimum ? ` (below the ${d.minimum} it can run with)` : ''}${d.missing.length ? `, no ${d.missing.join(', no ')}` : ''}${d.published ? '' : ', not published yet'}`;
    const conn = await pool.getConnection();
    try {
      await cover().tellUsers(conn, t, Number(from.id), await cover().schedulers(conn, t), `This weekend's patrol is short:\n${short.map(line).join('\n')}\nSee Patrol, Team, Schedule.`);
      const open = short.filter((d) => d.published && d.open);
      if (open.length && st.self_signup) await cover().announce(conn, t, Number(from.id), `Open patrol spots this weekend:\n${open.map((d) => `- ${C.DAY_LABEL[C.dayOf(d.date)]} ${d.crew}: ${d.open} open`).join('\n')}\nSign up on Patrol, Team, Cover.`);
      sent += 1;
    } finally { conn.release(); }
  }
  return sent;
}

module.exports = { router, weekExtras, coverageRange, shortAlertAll };
