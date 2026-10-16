'use strict';

// Ski patrol team management: roster, stations, daily deployment, equipment checks and training.
// The patrol roster is kept in Patrol. Each patroller has a person record underneath (a staff record, so cases,
// training and posts all point at one id), but a volunteer's record is patrol only (staff.in_workforce = 0) and never
// appears in Staff and schedule. A paid patroller is "on the staff list" too, for pay and the time clock.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { partialOf, z, dateStr, validate, paramId, setClause, seasonFor, todayIn, nowIn, addDays } = require('../lib/util');
const SH = require('../lib/shifts');
const { span } = require('../lib/workforce');
const describe = (s) => `patrol ${span(s.starts_at, s.ends_at)}${s.station ? ` at ${s.station}` : ''}${s.role_label ? `, ${s.role_label}` : ''}`;
const { notFound, bad, forbidden, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const PA = require('../lib/patrolaccess');
const needs = (feature, message) => PA.needs(pool, feature, message);

/** Whether this person may manage training and sign off skills (used where a screen shows or hides edit controls). */
const isLead = (req) => PA.can(pool, req, 'manage_training');

const LEVELS = ['candidate', 'patroller', 'senior', 'leader', 'director'];

// ---------------------------------------------------------------- roster
router.get('/team', patrol, async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const seasonStart = `${seasonFor(today).slice(0, 4)}-08-01`;
  const seeAll = await PA.can(pool, req, 'manage_team');

  const excepted = new Map((await rows(pool, 'SELECT staff_id, COUNT(*) AS n FROM patrol_member_access WHERE tenant_id = ? GROUP BY staff_id', [tenantId])).map((r) => [Number(r.staff_id), Number(r.n)]));
  const [members, certs, training, led] = await Promise.all([
    rows(pool, `SELECT m.staff_id, m.level, m.access_level, m.cert_level, m.callsign, m.patrol_number, m.emergency_contact, m.notes, s.status AS staff_status, s.in_workforce, p.first_name, p.last_name, p.email, p.phone
                FROM patrol_members m JOIN staff s ON s.id = m.staff_id AND s.tenant_id = m.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                WHERE m.tenant_id = ? ORDER BY FIELD(m.level, 'director', 'leader', 'senior', 'patroller', 'candidate'), p.last_name, p.first_name`, [tenantId]),
    rows(pool, `SELECT sc.staff_id, c.name, sc.expires_on FROM staff_certifications sc JOIN certifications c ON c.id = sc.certification_id AND c.tenant_id = sc.tenant_id
                WHERE sc.tenant_id = ? AND sc.staff_id IN (SELECT staff_id FROM patrol_members WHERE tenant_id = ?) ORDER BY c.name`, [tenantId, tenantId]),
    rows(pool, 'SELECT staff_id, SUM(hours) AS hours FROM training_records WHERE tenant_id = ? AND completed_on >= ? GROUP BY staff_id', [tenantId, seasonStart]),
    rows(pool, `SELECT r.staff_id, COUNT(*) AS n FROM incident_responders r JOIN incidents i ON i.id = r.incident_id AND i.tenant_id = r.tenant_id
                WHERE r.tenant_id = ? AND r.role = 'lead' AND DATE(i.occurred_at) >= ? GROUP BY r.staff_id`, [tenantId, seasonStart]),
  ]);
  const soon = addDays(today, 30);
  const data = members.map((m) => ({
    staff_id: m.staff_id, first_name: m.first_name, last_name: m.last_name, level: m.level, access_level: m.access_level, cert_level: m.cert_level, exceptions: excepted.get(Number(m.staff_id)) || 0, callsign: m.callsign, patrol_number: m.patrol_number, staff_status: m.staff_status, on_staff_list: Boolean(m.in_workforce),
    phone: m.phone,
    ...(seeAll ? { email: m.email, emergency_contact: m.emergency_contact, notes: m.notes } : {}),
    certifications: certs.filter((c) => c.staff_id === m.staff_id).map((c) => ({
      name: c.name, expires_on: c.expires_on,
      state: !c.expires_on ? 'no_expiry' : c.expires_on < today ? 'expired' : c.expires_on <= soon ? 'expiring' : 'current',
    })),
    training_hours_season: Number((training.find((t) => t.staff_id === m.staff_id) || { hours: 0 }).hours),
    cases_led_season: Number((led.find((l) => l.staff_id === m.staff_id) || { n: 0 }).n),
  }));
  res.json({ data, season_start: seasonStart });
});

const memberFields = {
  level: z.enum(LEVELS),
  access_level: z.enum(PA.LEVELS).optional(),
  callsign: z.string().max(30).nullable().optional(),
  patrol_number: z.string().max(20).nullable().optional(),
  emergency_contact: z.string().max(255).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  // Highest medical certification: the formulary uses it to say who may give which medication.
  cert_level: z.enum(['none', 'oec', 'emr', 'emt', 'aemt', 'paramedic', 'rn', 'md']).optional(),
};

/** Anyone who can manage the roster may make someone Patrol or Host; the higher levels are set by an Admin. */
async function checkGrant(req, level) {
  if (!level) return;
  const mine = await PA.levelOf(pool, req);
  if (mine !== 'admin' && !['patrol', 'host'].includes(level)) throw forbidden('Only a patrol Admin can give the Admin, Manager or Approver level');
}

/** Only an Admin changes or removes another Admin, so a roster manager cannot lock the Admins out. */
async function checkTarget(req, currentLevel) {
  if (currentLevel === 'admin' && (await PA.levelOf(pool, req)) !== 'admin') throw forbidden('Only a patrol Admin can change or remove an Admin');
}

/**
 * Put someone on the roster: a new person (a volunteer, or anyone not on the staff list: their record is patrol only)
 * or someone already on the staff list (staff_id).
 */
const personFields = { first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), email: z.string().trim().email().max(255).optional().or(z.literal('').transform(() => undefined)), phone: z.string().trim().max(40).optional() };
router.post('/team', patrol, needs('manage_team'), validate(z.object({ staff_id: z.number().int().positive().optional(), person: z.object(personFields).optional(), employee: z.boolean().default(false), ...memberFields, level: memberFields.level.default('patroller') })), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  if (!b.staff_id && !b.person) throw bad('Choose someone on the staff list, or enter a new person');
  const access = b.access_level || PA.levelForRank(b.level);
  await checkGrant(req, access);
  const staffId = await tx(async (conn) => {
    let id = b.staff_id;
    if (id) {
      if (!(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Staff member');
    } else {
      const [p] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)', [t, b.person.first_name, b.person.last_name, b.person.email || null, b.person.phone || null]);
      const [s] = await conn.query("INSERT INTO staff (tenant_id, person_id, status, in_workforce) VALUES (?, ?, 'active', ?)", [t, p.insertId, b.employee ? 1 : 0]);
      id = s.insertId;
    }
    try {
      await conn.query('INSERT INTO patrol_members (tenant_id, staff_id, level, access_level, callsign, patrol_number, emergency_contact, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, id, b.level, access, b.callsign ?? null, b.patrol_number ?? null, b.emergency_contact ?? null, b.notes ?? null]);
    } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('Already on the roster'); throw err; }
    await audit(conn, req, 'add_member', 'patrol_members', id, { level: b.level, access_level: access, new_person: !b.staff_id });
    return id;
  });
  res.status(201).json({ staff_id: staffId, access_level: access });
});

router.patch('/team/:staffId', patrol, needs('manage_team'), validate(partialOf(memberFields).extend({
  first_name: personFields.first_name.optional(), last_name: personFields.last_name.optional(), email: z.string().trim().email().max(255).nullable().optional().or(z.literal('').transform(() => null)), phone: z.string().trim().max(40).nullable().optional(),
  on_staff_list: z.boolean().optional(),
})), async (req, res) => {
  const staffId = paramId(req, 'staffId');
  const { first_name, last_name, email, phone, on_staff_list, ...body } = req.body;
  // The person's name and contact, and whether they are also on the staff list (paid, for pay and the time clock).
  const person = setClause({ first_name, last_name, email, phone }, ['first_name', 'last_name', 'email', 'phone']);
  if (person || on_staff_list !== undefined) {
    const st = await one(pool, 'SELECT s.person_id FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id WHERE m.tenant_id = ? AND m.staff_id = ?', [req.auth.tenantId, staffId]);
    if (!st) throw notFound('Patrol member');
    if (person) await pool.query(`UPDATE people SET ${person.sql} WHERE tenant_id = ? AND id = ?`, [...person.values, req.auth.tenantId, st.person_id]);
    if (on_staff_list !== undefined) await pool.query('UPDATE staff SET in_workforce = ? WHERE tenant_id = ? AND id = ?', [on_staff_list ? 1 : 0, req.auth.tenantId, staffId]);
    await audit(pool, req, 'update_member_person', 'patrol_members', staffId, { first_name, last_name, email, phone, on_staff_list });
    if (!Object.keys(body).length) { res.json({ ok: true }); return; }
  }
  const cur = await one(pool, 'SELECT level, access_level FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, staffId]);
  if (!cur) throw notFound('Patrol member');
  if (body.access_level) { if (body.access_level !== cur.access_level) { await checkGrant(req, body.access_level); await checkTarget(req, cur.access_level); } else delete body.access_level; }
  // A new rank moves the access level with it, but only when the level was still the one the old rank gave.
  else if (body.level && body.level !== cur.level && cur.access_level === PA.levelForRank(cur.level)) {
    const next = PA.levelForRank(body.level);
    if (next !== cur.access_level) { await checkGrant(req, next); await checkTarget(req, cur.access_level); body.access_level = next; }
  }
  const set = setClause(body, Object.keys(memberFields));
  if (!set) throw bad('No updatable fields supplied');
  await pool.query(`UPDATE patrol_members SET ${set.sql} WHERE tenant_id = ? AND staff_id = ?`, [...set.values, req.auth.tenantId, staffId]);
  await audit(pool, req, 'update_member', 'patrol_members', staffId, body);
  res.json({ ok: true });
});

router.delete('/team/:staffId', patrol, needs('manage_team'), async (req, res) => {
  const cur = await one(pool, 'SELECT access_level FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, paramId(req, 'staffId')]);
  if (cur) await checkTarget(req, cur.access_level);
  const t = req.auth.tenantId; const staffId = paramId(req, 'staffId');
  await tx(async (conn) => {
    const [r] = await conn.query('DELETE FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [t, staffId]);
    if (!r.affectedRows) throw notFound('Patrol member');
    // Off the roster means off the patrol shifts still ahead: they are left open for someone else, and the person is told.
    const now = nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone);
    const ahead = await rows(conn, `SELECT ps.*, st.name AS station FROM patrol_shifts ps LEFT JOIN patrol_stations st ON st.tenant_id = ps.tenant_id AND st.id = ps.station_id
      WHERE ps.tenant_id = ? AND ps.staff_id = ? AND ps.status <> 'cancelled' AND ps.starts_at >= ?`, [t, staffId, now]);
    for (const s of ahead) {
      await conn.query('UPDATE patrol_shifts SET staff_id = NULL WHERE tenant_id = ? AND id = ?', [t, s.id]);
      if (s.status === 'published') await SH.tell(conn, t, req.auth.userId, staffId, `You are no longer on ${describe(s)}.`);
      await require('./patrolcover').afterShiftChange(conn, req, s, { ...s, staff_id: null });
    }
    // Offers they made to cover someone else's shift are withdrawn, and those shifts are open for others again.
    await conn.query("UPDATE patrol_cover_requests SET status = 'open', taken_by = NULL, taken_at = NULL WHERE tenant_id = ? AND taken_by = ? AND status = 'pending'", [t, staffId]);
    await audit(conn, req, 'remove_member', 'patrol_members', staffId, { unassigned: ahead.length });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- stations
const stationFields = { name: z.string().min(1).max(100), kind: z.enum(['aid_room', 'hut', 'zone', 'base']).default('zone') };

router.get('/stations', patrol, async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT id, name, kind FROM patrol_stations WHERE tenant_id = ? ORDER BY FIELD(kind, \'aid_room\', \'base\', \'hut\', \'zone\'), name', [req.auth.tenantId]) });
});
router.post('/stations', patrol, needs('manage_equipment'), validate(z.object(stationFields)), async (req, res) => {
  const [r] = await pool.query('INSERT INTO patrol_stations (tenant_id, name, kind) VALUES (?, ?, ?)', [req.auth.tenantId, req.body.name, req.body.kind]);
  await audit(pool, req, 'create', 'patrol_stations', r.insertId);
  res.status(201).json({ id: r.insertId, ...req.body });
});
router.patch('/stations/:id', patrol, needs('manage_equipment'), validate(partialOf(stationFields)), async (req, res) => {
  const set = setClause(req.body, ['name', 'kind']);
  if (!set) throw bad('No updatable fields supplied');
  const [r] = await pool.query(`UPDATE patrol_stations SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Station');
  res.json({ ok: true });
});
router.delete('/stations/:id', patrol, needs('manage_equipment'), async (req, res) => {
  const [r] = await pool.query('DELETE FROM patrol_stations WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Station');
  res.status(204).end();
});

// ---------------------------------------------------------------- daily deployment
router.get('/deployments', patrol, async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const date = req.query.date ? String(req.query.date) : todayIn(tenant.timezone);
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  const [assignments, scheduled] = await Promise.all([
    rows(pool, `SELECT d.staff_id, p.first_name, p.last_name, d.station_id, st.name AS station, d.role_label, d.callsign
                FROM patrol_deployments d JOIN staff s ON s.id = d.staff_id AND s.tenant_id = d.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                LEFT JOIN patrol_stations st ON st.id = d.station_id AND st.tenant_id = d.tenant_id
                WHERE d.tenant_id = ? AND d.on_date = ? ORDER BY st.name, p.last_name`, [tenantId, date]),
    // Who is on the patrol schedule that day (and, for days before patrol had its own schedule, patrol shifts made in Staff and schedule).
    rows(pool, `SELECT ps.staff_id, p.first_name, p.last_name, COALESCE(ps.role_label, 'Patrol') AS position, ps.starts_at, ps.ends_at, ps.station_id
                FROM patrol_shifts ps JOIN staff s ON s.id = ps.staff_id AND s.tenant_id = ps.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                WHERE ps.tenant_id = ? AND ps.status <> 'cancelled' AND DATE(ps.starts_at) = ?
                UNION ALL
                SELECT sh.staff_id, p.first_name, p.last_name, pos.name AS position, sh.starts_at, sh.ends_at, NULL AS station_id
                FROM shifts sh JOIN positions pos ON pos.id = sh.position_id AND pos.tenant_id = sh.tenant_id AND pos.department = 'patrol'
                JOIN staff s ON s.id = sh.staff_id AND s.tenant_id = sh.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                WHERE sh.tenant_id = ? AND sh.status <> 'cancelled' AND sh.staff_id IS NOT NULL AND DATE(sh.starts_at) = ?
                ORDER BY starts_at, last_name`, [tenantId, date, tenantId, date]),
  ]);
  const posted = new Set(assignments.map((a) => a.staff_id));
  res.json({ date, assignments, scheduled: scheduled.map((s) => ({ ...s, deployed: posted.has(s.staff_id) })) });
});

/** Replaces the whole day. Posting someone who is not an active staff member is refused. */
router.put(
  '/deployments/:date',
  patrol, needs('assign_posts'),
  validate(z.object({
    assignments: z.array(z.object({
      staff_id: z.number().int().positive(),
      station_id: z.number().int().positive().nullable().optional(),
      role_label: z.string().max(60).nullable().optional(),
      callsign: z.string().max(30).nullable().optional(),
    })).max(200),
  })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const date = req.params.date;
    if (!dateStr.safeParse(date).success) throw bad('Use YYYY-MM-DD');
    const list = req.body.assignments;
    if (new Set(list.map((a) => a.staff_id)).size !== list.length) throw bad('Each person can be posted once a day');
    await tx(async (conn) => {
      if (list.length) {
        const active = await rows(conn, "SELECT id FROM staff WHERE tenant_id = ? AND status = 'active' AND id IN (?)", [tenantId, list.map((a) => a.staff_id)]);
        if (active.length !== list.length) throw conflict('Everyone posted must be active on the roster');
      }
      await conn.query('DELETE FROM patrol_deployments WHERE tenant_id = ? AND on_date = ?', [tenantId, date]);
      for (const a of list) {
        await conn.query('INSERT INTO patrol_deployments (tenant_id, on_date, staff_id, station_id, role_label, callsign) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, date, a.staff_id, a.station_id ?? null, a.role_label ?? null, a.callsign ?? null]);
      }
      await audit(conn, req, 'set_deployment', 'patrol_deployments', null, { date, count: list.length });
    });
    res.json({ ok: true, count: list.length });
  },
);

// ---------------------------------------------------------------- equipment and checks
const equipmentFields = {
  name: z.string().min(1).max(100),
  kind: z.enum(['toboggan', 'aed', 'oxygen', 'trauma_bag', 'radio', 'splint_kit', 'other']).default('other'),
  station_id: z.number().int().positive().nullable().optional(),
  serial: z.string().max(60).nullable().optional(),
  status: z.enum(['in_service', 'needs_attention', 'out_of_service', 'retired']).optional(),
  expires_on: dateStr.nullable().optional(),        // any item with a date: a trauma bag's earliest expiry, a splint kit
  pads_expire_on: dateStr.nullable().optional(),    // AED
  battery_expire_on: dateStr.nullable().optional(), // AED
  o2_size: z.enum(['M6', 'C', 'D', 'E', 'M60', 'other']).nullable().optional(), // oxygen cylinder
};

router.get('/equipment', patrol, async (req, res) => {
  const { tenantId } = req.auth;
  const data = await rows(
    pool,
    `SELECT e.id, e.name, e.kind, e.serial, e.status, e.station_id, st.name AS station, e.expires_on, e.pads_expire_on, e.battery_expire_on, e.o2_size, e.o2_psi, e.needs_download,
            c.checked_at AS last_checked_at, c.result AS last_result, c.reading AS last_reading, c.notes AS last_notes
     FROM patrol_equipment e LEFT JOIN patrol_stations st ON st.id = e.station_id AND st.tenant_id = e.tenant_id
     LEFT JOIN equipment_checks c ON c.id = (SELECT c2.id FROM equipment_checks c2 WHERE c2.tenant_id = e.tenant_id AND c2.equipment_id = e.id ORDER BY c2.checked_at DESC, c2.id DESC LIMIT 1)
     WHERE e.tenant_id = ? ORDER BY e.kind, e.name`,
    [tenantId],
  );
  res.json({ data });
});

router.post('/equipment', patrol, needs('manage_equipment'), validate(z.object(equipmentFields)), async (req, res) => {
  const b = req.body;
  const [r] = await pool.query('INSERT INTO patrol_equipment (tenant_id, name, kind, station_id, serial, status, expires_on, pads_expire_on, battery_expire_on, o2_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.name, b.kind, b.station_id ?? null, b.serial ?? null, b.status ?? 'in_service', b.expires_on ?? null, b.pads_expire_on ?? null, b.battery_expire_on ?? null, b.o2_size ?? null]);
  await audit(pool, req, 'create', 'patrol_equipment', r.insertId);
  res.status(201).json({ id: r.insertId });
});

router.patch('/equipment/:id', patrol, needs('manage_equipment'), validate(partialOf(equipmentFields)), async (req, res) => {
  const set = setClause(req.body, Object.keys(equipmentFields));
  if (!set) throw bad('No updatable fields supplied');
  const [r] = await pool.query(`UPDATE patrol_equipment SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Equipment');
  await audit(pool, req, 'update', 'patrol_equipment', paramId(req), req.body);
  res.json({ ok: true });
});

/** Any patroller can log a check. The result moves the item's status, so a failed AED shows up for everyone. */
router.post(
  '/equipment/:id/checks',
  patrol,
  validate(z.object({ result: z.enum(['ok', 'needs_attention', 'out_of_service']), reading: z.string().max(40).optional(), notes: z.string().max(255).optional(), psi: z.number().int().min(0).max(3000).optional(), downloaded: z.boolean().optional() })),
  async (req, res) => {
    const id = paramId(req);
    const b = req.body;
    const out = await tx(async (conn) => {
      const e = await one(conn, 'SELECT id, kind, status, needs_download FROM patrol_equipment WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
      if (!e) throw notFound('Equipment');
      if (e.status === 'retired') throw conflict('This item is retired');
      // Oxygen: the pressure is kept on the cylinder, and one below the refill level cannot pass as "ok".
      if (e.kind === 'oxygen' && b.psi !== undefined) {
        const { o2_refill_psi: refill } = await require('../lib/patrolops').settingsOf(conn, req.auth.tenantId);
        await conn.query('UPDATE patrol_equipment SET o2_psi = ? WHERE tenant_id = ? AND id = ?', [b.psi, req.auth.tenantId, id]);
        if (!b.reading) b.reading = `${b.psi} psi`;
        if (b.psi < refill && b.result === 'ok') { b.result = 'needs_attention'; b.notes = [b.notes, `Below ${refill} psi: refill`].filter(Boolean).join('. '); }
      }
      // AED: after use on a patient the data is downloaded for the medical director before it goes back in service.
      if (e.kind === 'aed' && Number(e.needs_download) && b.result === 'ok' && !b.downloaded) throw conflict('This AED was used on a patient. Download its data for the medical director and fit new pads, then tick Downloaded.');
      if (e.kind === 'aed' && b.downloaded) await conn.query('UPDATE patrol_equipment SET needs_download = 0 WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
      if (b.result === 'ok' && ['needs_attention', 'out_of_service'].includes(e.status) && !(await PA.can(pool, req, 'manage_equipment'))) throw forbidden('A flagged item has to be cleared by someone who manages equipment');
      const [r] = await conn.query('INSERT INTO equipment_checks (tenant_id, equipment_id, checked_by, result, reading, notes) VALUES (?, ?, ?, ?, ?, ?)', [req.auth.tenantId, id, req.auth.userId, b.result, b.reading ?? null, b.notes ?? null]);
      const status = b.result === 'ok' ? 'in_service' : b.result;
      await conn.query('UPDATE patrol_equipment SET status = ? WHERE tenant_id = ? AND id = ?', [status, req.auth.tenantId, id]);
      await audit(conn, req, 'check', 'patrol_equipment', id, { result: b.result });
      return { id: r.insertId, status };
    });
    res.status(201).json(out);
  },
);

router.get('/equipment/:id/checks', patrol, async (req, res) => {
  res.json({
    data: await rows(pool, `SELECT c.id, c.checked_at, c.result, c.reading, c.notes, COALESCE(u.email, u.username) AS checked_by FROM equipment_checks c LEFT JOIN users u ON u.id = c.checked_by AND u.tenant_id = c.tenant_id
                            WHERE c.tenant_id = ? AND c.equipment_id = ? ORDER BY c.checked_at DESC, c.id DESC LIMIT 100`, [req.auth.tenantId, paramId(req)]),
  });
});

/** A failed or flagged item stays out of service until a leader clears it with a written reason. */
router.post('/equipment/:id/clear', patrol, needs('manage_equipment'), validate(z.object({ notes: z.string().min(3).max(255) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const e = await one(conn, 'SELECT id, status FROM patrol_equipment WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!e) throw notFound('Equipment');
    if (!['needs_attention', 'out_of_service'].includes(e.status)) throw conflict('This item is not flagged');
    await conn.query("INSERT INTO equipment_checks (tenant_id, equipment_id, checked_by, result, notes) VALUES (?, ?, ?, 'ok', ?)", [req.auth.tenantId, id, req.auth.userId, `Cleared: ${req.body.notes}`]);
    await conn.query("UPDATE patrol_equipment SET status = 'in_service' WHERE tenant_id = ? AND id = ?", [req.auth.tenantId, id]);
    await audit(conn, req, 'clear', 'patrol_equipment', id, { from: e.status });
  });
  res.json({ ok: true, status: 'in_service' });
});

// ---------------------------------------------------------------- training passport
// A mountain defines the skills its patrollers must show (toboggan handling, c-spine, AED...). Each patroller's
// passport lists them, with who signed them off, when, and when the sign-off lapses.
const competencyFields = {
  name: z.string().min(1).max(120),
  category: z.string().max(60).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  valid_months: z.number().int().min(1).max(120).nullable().optional(),
  active: z.boolean().optional(),
};

router.get('/competencies', patrol, async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT id, name, category, description, valid_months, active FROM patrol_competencies WHERE tenant_id = ? ORDER BY category, name', [req.auth.tenantId]) });
});

router.post('/competencies', patrol, needs('manage_training'), validate(z.object(competencyFields)), async (req, res) => {
  const b = req.body;
  try {
    const [r] = await pool.query('INSERT INTO patrol_competencies (tenant_id, name, category, description, valid_months) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, b.name, b.category ?? null, b.description ?? null, b.valid_months ?? null]);
    await audit(pool, req, 'create', 'patrol_competencies', r.insertId);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('A skill with that name already exists');
    throw err;
  }
});

router.patch('/competencies/:id', patrol, needs('manage_training'), validate(partialOf(competencyFields)), async (req, res) => {
  const set = setClause(req.body, Object.keys(competencyFields));
  if (!set) throw bad('No updatable fields supplied');
  const [r] = await pool.query(`UPDATE patrol_competencies SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Skill');
  await audit(pool, req, 'update', 'patrol_competencies', paramId(req), req.body);
  res.json({ ok: true });
});

/** passport state: signed_off, expiring (within 30 days), expired, in_progress, not_started */
function passportState(row, today) {
  if (!row.status) return 'not_started';
  if (row.status === 'in_progress') return 'in_progress';
  if (row.expires_on) {
    const exp = String(row.expires_on).slice(0, 10);
    if (exp < today) return 'expired';
    if (exp <= addDays(today, 30)) return 'expiring';
  }
  return 'signed_off';
}

async function passportFor(tenantId, staffId, tz) {
  const today = todayIn(tz);
  const list = await rows(pool, `SELECT c.id AS competency_id, c.name, c.category, c.description, c.valid_months,
                                        so.status, so.signed_on, so.expires_on, so.notes, COALESCE(u.email, u.username) AS signed_by
                                 FROM patrol_competencies c LEFT JOIN patrol_signoffs so ON so.competency_id = c.id AND so.tenant_id = c.tenant_id AND so.staff_id = ?
                                 LEFT JOIN users u ON u.id = so.signed_by AND u.tenant_id = so.tenant_id
                                 WHERE c.tenant_id = ? AND c.active = 1 ORDER BY c.category, c.name`, [staffId, tenantId]);
  return list.map((r) => ({ ...r, state: passportState(r, today) }));
}

router.get('/passport', patrol, needs('manage_training'), async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const members = await rows(pool, `SELECT m.staff_id, p.first_name, p.last_name FROM patrol_members m JOIN staff s ON s.id = m.staff_id AND s.tenant_id = m.tenant_id
                                    JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id WHERE m.tenant_id = ? AND s.status = 'active' ORDER BY p.last_name, p.first_name`, [tenantId]);
  const total = Number((await one(pool, 'SELECT COUNT(*) AS n FROM patrol_competencies WHERE tenant_id = ? AND active = 1', [tenantId])).n);
  const out = [];
  for (const m of members) {
    const pass = await passportFor(tenantId, m.staff_id, tenant.timezone);
    const count = (st) => pass.filter((x) => x.state === st).length;
    out.push({ ...m, skills: total, signed_off: count('signed_off') + count('expiring'), expiring: count('expiring'), expired: count('expired'), in_progress: count('in_progress') });
  }
  res.json({ data: out });
});

router.get('/passport/:staffId', patrol, async (req, res) => {
  const staffId = paramId(req, 'staffId');
  if (staffId !== req.auth.staffId && !(await isLead(req))) throw forbidden('You can only see your own passport');
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const who = await one(pool, 'SELECT p.first_name, p.last_name FROM staff s JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND s.id = ?', [req.auth.tenantId, staffId]);
  if (!who) throw notFound('Staff member');
  res.json({ staff_id: staffId, ...who, skills: await passportFor(req.auth.tenantId, staffId, tenant.timezone) });
});

/** Leaders sign skills off. Nobody signs off their own skills unless they are a manager. */
router.put(
  '/passport/:staffId/:competencyId',
  patrol, needs('manage_training'),
  validate(z.object({ status: z.enum(['in_progress', 'signed_off']), signed_on: dateStr.optional(), notes: z.string().max(255).nullable().optional() })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const staffId = paramId(req, 'staffId');
    const compId = paramId(req, 'competencyId');
    if (staffId === req.auth.staffId && !isManager(req)) throw forbidden('A leader cannot sign off their own skills');
    const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
    const comp = await one(pool, 'SELECT id, valid_months FROM patrol_competencies WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, compId]);
    if (!comp) throw notFound('Skill');
    if (!(await one(pool, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [tenantId, staffId]))) throw notFound('Staff member');
    const b = req.body;
    const signedOn = b.status === 'signed_off' ? (b.signed_on || todayIn(tenant.timezone)) : null;
    let expires = null;
    if (signedOn && comp.valid_months) {
      const [y, m, d] = signedOn.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1 + comp.valid_months, 1));
      const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      dt.setUTCDate(Math.min(d, last));
      expires = dt.toISOString().slice(0, 10);
    }
    await pool.query(
      `INSERT INTO patrol_signoffs (tenant_id, staff_id, competency_id, status, signed_on, expires_on, signed_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), signed_on = VALUES(signed_on), expires_on = VALUES(expires_on), signed_by = VALUES(signed_by), notes = VALUES(notes)`,
      [tenantId, staffId, compId, b.status, signedOn, expires, b.status === 'signed_off' ? req.auth.userId : null, b.notes ?? null],
    );
    await audit(pool, req, 'signoff', 'patrol_signoffs', compId, { staff_id: staffId, status: b.status });
    res.json({ ok: true, expires_on: expires });
  },
);

// ---------------------------------------------------------------- training log
router.get('/training', patrol, async (req, res) => {
  const where = ['t.tenant_id = ?'];
  const params = [req.auth.tenantId];
  if (req.query.staff_id) { where.push('t.staff_id = ?'); params.push(Number(req.query.staff_id)); }
  res.json({
    data: await rows(pool, `SELECT t.id, t.staff_id, p.first_name, p.last_name, t.kind, t.title, t.hours, t.completed_on, t.notes
                            FROM training_records t JOIN staff s ON s.id = t.staff_id AND s.tenant_id = t.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                            WHERE ${where.join(' AND ')} ORDER BY t.completed_on DESC, t.id DESC LIMIT 500`, params),
  });
});

/** Leaders log training for anyone; a patroller can log their own. */
router.post(
  '/training',
  patrol,
  validate(z.object({
    staff_id: z.number().int().positive().optional(),
    kind: z.enum(['oec', 'refresher', 'ride_evac', 'toboggan', 'avalanche', 'cpr_aed', 'other']).default('other'),
    title: z.string().min(1).max(150),
    hours: z.number().min(0).max(200),
    completed_on: dateStr,
    notes: z.string().max(255).optional(),
  })),
  async (req, res) => {
    const b = req.body;
    const staffId = b.staff_id ?? req.auth.staffId;
    if (!staffId) throw bad('staff_id is required');
    if (staffId !== req.auth.staffId && !(await isLead(req))) throw forbidden('You can only log training for yourself');
    if (!(await one(pool, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, staffId]))) throw notFound('Staff member');
    const [r] = await pool.query('INSERT INTO training_records (tenant_id, staff_id, kind, title, hours, completed_on, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, staffId, b.kind, b.title, b.hours, b.completed_on, b.notes ?? null, req.auth.userId]);
    await audit(pool, req, 'create', 'training_records', r.insertId, { staff_id: staffId });
    res.status(201).json({ id: r.insertId });
  },
);

router.delete('/training/:id', patrol, needs('manage_training'), async (req, res) => {
  const [r] = await pool.query('DELETE FROM training_records WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Training record');
  await audit(pool, req, 'delete', 'training_records', paramId(req));
  res.status(204).end();
});

// Who can lead: the screen uses this to show or hide edit controls.
router.get('/me', patrol, async (req, res) => {
  const access = await PA.accessOf(pool, req);
  // Name and patrol number fill in "Form completed by" on a report.
  const who = req.auth.staffId ? await one(pool, 'SELECT p.first_name, p.last_name, m.patrol_number, m.callsign FROM staff s JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id LEFT JOIN patrol_members m ON m.staff_id = s.id AND m.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND s.id = ?', [req.auth.tenantId, req.auth.staffId]) : null;
  const R = require('../lib/review');
  const rs = await R.settingsOf(pool, req.auth.tenantId);
  res.json({ review_group: rs.enabled, is_reviewer: await R.canReview(pool, req, rs), can_manage_review: await R.canManage(pool, req, rs), name: who ? `${who.first_name} ${who.last_name}` : null, patrol_number: who ? who.patrol_number || who.callsign || null : null, can_lead: access.features.has('manage_training') || access.features.has('manage_equipment'), can_admin_form: access.features.has('manage_settings'), staff_id: req.auth.staffId, access_level: access.level, features: [...access.features], avalanche: (await require('../lib/patrolops').settingsOf(pool, req.auth.tenantId)).avalanche });
});

// ---------------------------------------------------------------- access levels (patrol Admins only)
const adminOnly = async (req, _res, next) => {
  try { if ((await PA.levelOf(pool, req)) !== 'admin') throw forbidden('Only a patrol Admin can change access'); next(); } catch (err) { next(err); }
};

/** Everything the Access screen shows: the levels, the features, what each level can do, and who has which level. */
router.get('/access', patrol, adminOnly, async (req, res) => {
  const { tenantId } = req.auth;
  const people = await rows(pool, `SELECT m.staff_id, m.access_level, m.level AS rank_level, m.callsign, p.first_name, p.last_name
    FROM patrol_members m JOIN staff s ON s.id = m.staff_id AND s.tenant_id = m.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
    WHERE m.tenant_id = ? ORDER BY p.last_name, p.first_name`, [tenantId]);
  res.json({
    levels: PA.LEVELS.map((k) => ({ key: k, label: PA.LEVEL_LABEL[k], about: PA.LEVEL_ABOUT[k] })),
    features: PA.FEATURES.map(([key, label, about, group]) => ({ key, label, about, group, defaults: PA.LEVELS.filter((l) => PA.DEFAULTS[key].has(l)) })),
    matrix: await PA.matrix(pool, tenantId),
    people: people.map((m) => ({ staff_id: m.staff_id, name: `${m.first_name} ${m.last_name}`, access_level: m.access_level, rank_level: m.rank_level, callsign: m.callsign })),
  });
});

/**
 * One patroller's permissions: what their level gives, and their exceptions (a feature added or taken away for them
 * alone). Patrol Admins only, like the levels themselves.
 */
router.get('/team/:staffId/permissions', patrol, adminOnly, async (req, res) => {
  const t = req.auth.tenantId; const staffId = paramId(req, 'staffId');
  const m = await one(pool, `SELECT m.access_level, p.first_name, p.last_name FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE m.tenant_id = ? AND m.staff_id = ?`, [t, staffId]);
  if (!m) throw notFound('Patrol member');
  const level = m.access_level || 'patrol';
  const fromLevel = (await PA.matrix(pool, t))[level];
  const exceptions = await PA.exceptionsOf(pool, t, staffId);
  const has = PA.effective(fromLevel, level, exceptions);
  res.json({
    name: `${m.first_name} ${m.last_name}`, level, level_label: PA.LEVEL_LABEL[level],
    features: PA.FEATURES.map(([key, label, about, group]) => ({ key, label, about, group, from_level: level === 'admin' || Boolean(fromLevel[key]), exception: key in exceptions ? exceptions[key] : null, has: has.has(key) })),
  });
});

router.put('/team/:staffId/permissions', patrol, adminOnly, validate(z.object({
  exceptions: z.array(z.object({ feature: z.string().max(40), allowed: z.boolean().nullable() })).max(50),
})), async (req, res) => {
  const t = req.auth.tenantId; const staffId = paramId(req, 'staffId');
  const m = await one(pool, 'SELECT access_level FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [t, staffId]);
  if (!m) throw notFound('Patrol member');
  if (m.access_level === 'admin') throw bad('A patrol Admin already has every permission');
  for (const e of req.body.exceptions) if (!PA.KEYS.includes(e.feature)) throw bad(`Unknown feature "${e.feature}"`);
  await tx(async (conn) => {
    for (const e of req.body.exceptions) {
      if (e.allowed === null) await conn.query('DELETE FROM patrol_member_access WHERE tenant_id = ? AND staff_id = ? AND feature = ?', [t, staffId, e.feature]);
      else await conn.query('INSERT INTO patrol_member_access (tenant_id, staff_id, feature, allowed, set_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE allowed = VALUES(allowed), set_by = VALUES(set_by)', [t, staffId, e.feature, e.allowed ? 1 : 0, req.auth.userId]);
    }
    await audit(conn, req, 'set_member_permissions', 'patrol_members', staffId, { exceptions: req.body.exceptions });
  });
  res.json({ ok: true });
});

/** Switch features on or off for a level. The Admin level always has everything. */
router.put('/access/rules', patrol, adminOnly, validate(z.object({
  rules: z.array(z.object({ level: z.enum(['manager', 'approver', 'patrol', 'host']), feature: z.string().max(40), allowed: z.boolean() })).min(1).max(200),
})), async (req, res) => {
  const { tenantId } = req.auth;
  for (const r of req.body.rules) if (!PA.KEYS.includes(r.feature)) throw bad(`Unknown feature "${r.feature}"`);
  const before = await PA.matrix(pool, tenantId);
  await tx(async (conn) => {
    for (const r of req.body.rules) {
      // Store only choices that differ from the built-in default, so a reset is just deleting rows.
      if (PA.DEFAULTS[r.feature].has(r.level) === r.allowed) await conn.query('DELETE FROM patrol_access_rules WHERE tenant_id = ? AND level = ? AND feature = ?', [tenantId, r.level, r.feature]);
      else await conn.query('INSERT INTO patrol_access_rules (tenant_id, level, feature, allowed) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)', [tenantId, r.level, r.feature, r.allowed ? 1 : 0]);
    }
  });
  const after = await PA.matrix(pool, tenantId);
  const changes = req.body.rules.filter((r) => before[r.level][r.feature] !== after[r.level][r.feature]).map((r) => ({ level: r.level, feature: r.feature, allowed: r.allowed }));
  if (changes.length) await audit(pool, req, 'patrol_access_rules', 'patrol_access_rules', null, { changes });
  res.json({ matrix: after });
});

/** Put every level back to the built-in defaults. */
router.delete('/access/rules', patrol, adminOnly, async (req, res) => {
  await pool.query('DELETE FROM patrol_access_rules WHERE tenant_id = ?', [req.auth.tenantId]);
  await audit(pool, req, 'patrol_access_reset', 'patrol_access_rules', null, {});
  res.json({ matrix: await PA.matrix(pool, req.auth.tenantId) });
});

/** Change one person's access level. */
router.put('/team/:staffId/access', patrol, adminOnly, validate(z.object({ access_level: z.enum(PA.LEVELS) })), async (req, res) => {
  const staffId = paramId(req, 'staffId');
  const [r] = await pool.query('UPDATE patrol_members SET access_level = ? WHERE tenant_id = ? AND staff_id = ?', [req.body.access_level, req.auth.tenantId, staffId]);
  if (!r.affectedRows) throw notFound('Patrol member');
  await audit(pool, req, 'patrol_access_level', 'patrol_members', staffId, { access_level: req.body.access_level });
  res.json({ ok: true });
});

module.exports = router;
