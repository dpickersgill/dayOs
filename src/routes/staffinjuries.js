'use strict';

// The staff injury register (mounted under /staff-injuries): the owner's private record of work injuries and
// illnesses. Only the owner and those the owner names can open it; every look at a record is logged. See
// lib/injuryregister for the numbering, the patrol link and the yearly summary.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { authenticate } = require('../middleware/auth');
const { z, validate, paramId, dateStr, dateTimeStr, normDateTime } = require('../lib/util');
const { notFound, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const IR = require('../lib/injuryregister');

const router = express.Router();
router.use(authenticate);
const me = (req) => ({ id: req.auth.userId, role: req.auth.role });
const allowed = async (req, _res, next) => {
  try {
    if (!(await IR.canSee(pool, req.auth.tenantId, me(req)))) throw forbidden('Only the owner, and those the owner names, can open the staff injury register');
    next();
  } catch (err) { next(err); }
};
const ownerOnly = (req, _res, next) => next(req.auth.role === 'owner' ? undefined : forbidden('Only the owner chooses who can see the staff injury register'));
router.use(allowed);

const number = (r) => `${r.year}-${String(r.seq).padStart(3, '0')}`;
const shape = (r) => ({
  ...r, id: Number(r.id), number: number(r), year: Number(r.year), seq: Number(r.seq), incident_id: r.incident_id ? Number(r.incident_id) : null,
  staff_id: r.staff_id ? Number(r.staff_id) : null, volunteer: Boolean(Number(r.volunteer)), privacy_case: Boolean(Number(r.privacy_case)), er: Boolean(Number(r.er)), overnight: Boolean(Number(r.overnight)),
  days_away: Number(r.days_away), days_restricted: Number(r.days_restricted), case_number: r.case_season ? `${r.case_season}-${String(r.case_seq).padStart(4, '0')}` : null,
});
const SELECT = 'SELECT si.*, i.season AS case_season, i.seq AS case_seq FROM staff_injuries si LEFT JOIN incidents i ON i.tenant_id = si.tenant_id AND i.id = si.incident_id';

/** The year's records (newest first), the years with records, and, for the owner, who else can see the register. */
router.get('/', async (req, res) => {
  const t = req.auth.tenantId;
  const years = (await rows(pool, 'SELECT DISTINCT year FROM staff_injuries WHERE tenant_id = ? ORDER BY year DESC', [t])).map((r) => Number(r.year));
  const year = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : years[0] || new Date().getUTCFullYear();
  const list = await rows(pool, `${SELECT} WHERE si.tenant_id = ? AND si.year = ? ORDER BY si.seq DESC`, [t, year]);
  const access = req.auth.role === 'owner' ? await rows(pool, `SELECT a.user_id, COALESCE(u.email, u.username) AS login, u.role FROM staff_injury_access a JOIN users u ON u.id = a.user_id AND u.tenant_id = a.tenant_id WHERE a.tenant_id = ? ORDER BY login`, [t]) : null;
  await audit(pool, req, 'view_list', 'staff_injuries', null, { year });
  res.json({ year, years: [...new Set([year, ...years])].sort((a, b) => b - a), data: list.map(shape), kinds: IR.KINDS, outcomes: IR.OUTCOMES, is_owner: req.auth.role === 'owner', access });
});

router.get('/summary', async (req, res) => {
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  res.json(await IR.summary(pool, req.auth.tenantId, year));
});

/** The year's log as a spreadsheet, in the Form 300 columns. A privacy case shows "Privacy case" instead of the name. */
router.get('/log.csv', async (req, res) => {
  const t = req.auth.tenantId;
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  const list = (await rows(pool, `${SELECT} WHERE si.tenant_id = ? AND si.year = ? AND si.outcome IN (?) ORDER BY si.seq`, [t, year, IR.RECORDABLE])).map(shape);
  await audit(pool, req, 'download', 'staff_injuries', null, { year });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="osha-300-log-${year}.csv"`);
  const outcome = (o) => (IR.OUTCOMES.find((x) => x[0] === o) || [o, o])[1];
  const kind = (k) => (IR.KINDS.find((x) => x[0] === k) || [k, k])[1];
  res.send(toCsv(['case_no', 'employee_name', 'job_title', 'date_of_injury', 'where', 'description', 'outcome', 'days_away', 'days_restricted', 'injury_or_illness'],
    list.map((r) => ({ case_no: r.number, employee_name: r.privacy_case ? 'Privacy case' : r.employee_name, job_title: r.job_title || '', date_of_injury: String(r.occurred_at).slice(0, 10), where: r.place || '', description: r.description || '', outcome: outcome(r.outcome), days_away: r.days_away, days_restricted: r.days_restricted, injury_or_illness: kind(r.kind) }))));
});

router.get('/:id', async (req, res) => {
  const r = await one(pool, `${SELECT} WHERE si.tenant_id = ? AND si.id = ?`, [req.auth.tenantId, paramId(req)]);
  if (!r) throw notFound('Record');
  await audit(pool, req, 'view', 'staff_injuries', r.id); // each look is logged
  res.json(shape(r));
});

const fields = {
  employee_name: z.string().trim().min(1).max(150),
  staff_id: z.number().int().positive().nullable().optional(),
  volunteer: z.boolean().optional(),
  job_title: z.string().trim().max(100).nullable().optional(),
  occurred_at: dateTimeStr.transform(normDateTime),
  place: z.string().trim().max(150).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  kind: z.enum(IR.KINDS.map((k) => k[0])).optional(),
  outcome: z.enum(IR.OUTCOMES.map((k) => k[0])).nullable().optional(),
  days_away: z.number().int().min(0).max(180).optional(),
  days_restricted: z.number().int().min(0).max(180).optional(),
  privacy_case: z.boolean().optional(),
  began_work_at: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  activity: z.string().trim().max(500).nullable().optional(),
  how_happened: z.string().trim().max(1000).nullable().optional(),
  object: z.string().trim().max(255).nullable().optional(),
  treated_by: z.string().trim().max(150).nullable().optional(),
  facility: z.string().trim().max(200).nullable().optional(),
  er: z.boolean().optional(),
  overnight: z.boolean().optional(),
  died_on: dateStr.nullable().optional(),
  status: z.enum(['open', 'closed']).optional(),
};
const COLS = Object.keys(fields);
const val = (k, v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === '' ? null : v);
// OSHA counts at most 180 days away or restricted for one case.
const check = (b) => { if (b.outcome === 'death' && !b.died_on) throw bad('Give the date of death'); };

router.post('/', validate(z.object(fields)), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  check(b);
  if (b.staff_id && !(await one(pool, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [t, b.staff_id]))) throw notFound('Staff member');
  const id = await tx(async (conn) => {
    const year = Number(b.occurred_at.slice(0, 4));
    const seq = await IR.nextSeq(conn, t, year);
    const keys = COLS.filter((k) => b[k] !== undefined);
    const [r] = await conn.query(`INSERT INTO staff_injuries (tenant_id, year, seq, source, created_by, ${keys.join(', ')}) VALUES (?, ?, ?, 'manual', ?, ${keys.map(() => '?').join(', ')})`, [t, year, seq, req.auth.userId, ...keys.map((k) => val(k, b[k]))]);
    await audit(conn, req, 'create', 'staff_injuries', r.insertId);
    return r.insertId;
  });
  res.status(201).json(shape(await one(pool, `${SELECT} WHERE si.tenant_id = ? AND si.id = ?`, [t, id])));
});

router.patch('/:id', validate(z.object(fields).partial()), async (req, res) => {
  const t = req.auth.tenantId;
  const id = paramId(req);
  const before = await one(pool, 'SELECT * FROM staff_injuries WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!before) throw notFound('Record');
  const b = req.body;
  check({ ...before, ...b });
  if (b.occurred_at && Number(b.occurred_at.slice(0, 4)) !== Number(before.year)) throw bad('The date must stay in the same calendar year, so the log number stays the same. Add a new record for another year.');
  const keys = COLS.filter((k) => b[k] !== undefined);
  if (!keys.length) throw bad('Nothing to change');
  await pool.query(`UPDATE staff_injuries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => val(k, b[k])), t, id]);
  await audit(pool, req, 'update', 'staff_injuries', id, { fields: keys });
  res.json(shape(await one(pool, `${SELECT} WHERE si.tenant_id = ? AND si.id = ?`, [t, id])));
});

/** The hours worked and average employees for the year's summary, and who certified it. */
router.put('/years/:year', validate(z.object({ hours_worked: z.number().int().min(0).max(100_000_000).nullable(), avg_employees: z.number().int().min(0).max(100_000).nullable(), certified_by: z.string().trim().max(150).nullable().optional(), certified_at: dateStr.nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const year = Number(req.params.year);
  if (!(year >= 2000 && year <= 2100)) throw bad('Choose a year');
  const b = req.body;
  await pool.query(`INSERT INTO staff_injury_years (tenant_id, year, hours_worked, avg_employees, certified_by, certified_at) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE hours_worked = VALUES(hours_worked), avg_employees = VALUES(avg_employees), certified_by = VALUES(certified_by), certified_at = VALUES(certified_at)`, [t, year, b.hours_worked, b.avg_employees, b.certified_by || null, b.certified_at || null]);
  await audit(pool, req, 'update_year', 'staff_injuries', null, { year });
  res.json(await IR.summary(pool, t, year));
});

/** Who else can open the register (the owner always can). */
router.get('/access/users', ownerOnly, async (req, res) => {
  const list = await rows(pool, "SELECT u.id, COALESCE(u.email, u.username) AS login, u.role, (a.user_id IS NOT NULL) AS granted FROM users u LEFT JOIN staff_injury_access a ON a.tenant_id = u.tenant_id AND a.user_id = u.id WHERE u.tenant_id = ? AND u.active = 1 AND u.role <> 'owner' ORDER BY FIELD(u.role, 'manager') DESC, login", [req.auth.tenantId]);
  res.json({ data: list.map((u) => ({ ...u, id: Number(u.id), granted: Boolean(Number(u.granted)) })) });
});
router.put('/access', ownerOnly, validate(z.object({ user_ids: z.array(z.number().int().positive()).max(20) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const ok = (await rows(conn, 'SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND id IN (?)', [t, req.body.user_ids.length ? req.body.user_ids : [0]])).map((u) => Number(u.id));
    if (ok.length !== req.body.user_ids.length) throw bad('Someone chosen is not an active login here');
    await conn.query('DELETE FROM staff_injury_access WHERE tenant_id = ?', [t]);
    for (const u of ok) await conn.query('INSERT INTO staff_injury_access (tenant_id, user_id, granted_by) VALUES (?, ?, ?)', [t, u, req.auth.userId]);
    await audit(conn, req, 'access', 'staff_injuries', null, { users: ok });
  });
  res.json({ ok: true });
});

module.exports = router;
