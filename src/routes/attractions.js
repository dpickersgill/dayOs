'use strict';

// Attractions: a mountain's other things to do (zipline, mountain coaster, tubing, ice rink and so on), run like a lift.
//   GET  /attractions                 the active list, for every signed-in screen (Sell, Patrol, Staff read it too)
//   POST, PATCH, archive, restore     managers set them up (Settings, Attractions), each with its own opening checks
//   PATCH /attractions/:id/status     open, hold (with a note) or closed: the people who may change a lift's status
//   opening inspections               one a day per attraction from its checks, item by item; a failed one blocks opening
//   downtime                          kept in step with the status, with a reason; entries are edited, never deleted
// Staff suggestions (positions and certifications per type) are under /workforce/attraction-staff (workforceRouter).
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { z, validate, paramId, dateStr, dateTimeStr, normDateTime, todayIn, nowIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const A = require('../lib/attractions');

const router = express.Router();
const workforceRouter = express.Router();
const manager = requireRole('manager');
// The same people who may change a lift's status (routes/schedule.js): staff, patrol and managers (owners always).
const crew = requireRole('manager', 'patrol', 'staff');

const first = (v) => String(Array.isArray(v) ? v[0] : v);
const tzOf = async (db, tenantId) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
async function whoIs(db, req) {
  const u = await one(db, "SELECT COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), u.email, u.username) AS name FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE u.tenant_id = ? AND u.id = ?", [req.auth.tenantId, req.auth.userId]);
  return u ? String(u.name || '').slice(0, 100) : null;
}
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** An attraction as the screens read it. `full` adds its opening checks (for the people who edit or run them). */
function shape(a, { full = false } = {}) {
  const out = {
    id: Number(a.id), name: a.name, type: a.type, type_label: A.typeLabel(a.type), activity: A.activityFor(a.type), activity_label: A.activityLabel(A.activityFor(a.type)),
    status: a.status, status_note: a.status_note || null,
    min_height_in: num(a.min_height_in), min_weight_lb: num(a.min_weight_lb), max_weight_lb: num(a.max_weight_lb), min_age: num(a.min_age),
    waiver_required: Boolean(Number(a.waiver_required)), sort: Number(a.sort), active: Boolean(Number(a.active)),
  };
  if (full) { out.checklist = A.checklistOf(a); out.checklist_custom = Boolean(A.parseChecklist(a.checklist)); }
  return out;
}
const ORDER = 'ORDER BY sort, name';

// ---------------------------------------------------------------- reading
router.get('/', async (req, res) => {
  const all = req.query.all === '1' && isManager(req);
  const data = await rows(pool, `SELECT * FROM attractions WHERE tenant_id = ? ${all ? '' : 'AND active = 1'} ${ORDER}`, [req.auth.tenantId]);
  res.json({ data: data.map((a) => shape(a, { full: all })) });
});

/** The types (with their default checks and the staff each usually needs), and the downtime reasons. */
router.get('/meta', (_req, res) => {
  res.json({
    types: A.TYPES.map((t) => ({ key: t.key, label: t.label, season: t.season, group: t.group, activity: t.activity, checks: A.templateFor(t.key), staff: A.staffFor(t.key) })),
    downtime_reasons: A.DOWNTIME_REASONS,
  });
});

const checkOut = (c) => (c ? {
  id: Number(c.id), attraction_id: Number(c.attraction_id), check_date: c.check_date, attempt: Number(c.attempt), status: c.status, items: JSON.parse(c.items), note: c.note,
  started_by: c.started_by_name, started_at: c.started_at, finished_by: c.finished_by_name, finished_at: c.finished_at,
} : null);

/**
 * Mountain status: every active attraction with today's opening inspection (the latest attempt), whether a failed one
 * blocks opening, and the downtime entry still open.
 */
router.get('/today', async (req, res) => {
  const t = req.auth.tenantId;
  const tz = await tzOf(pool, t);
  const today = todayIn(tz);
  const [list, checks, downs] = await Promise.all([
    rows(pool, `SELECT * FROM attractions WHERE tenant_id = ? AND active = 1 ${ORDER}`, [t]),
    rows(pool, 'SELECT * FROM attraction_checks WHERE tenant_id = ? AND check_date = ? ORDER BY attempt', [t, today]),
    rows(pool, 'SELECT id, attraction_id, started_at, reason, note FROM attraction_downtime WHERE tenant_id = ? AND ended_at IS NULL ORDER BY started_at', [t]),
  ]);
  res.json({
    date: today,
    data: list.map((a) => {
      const mine = checks.filter((c) => Number(c.attraction_id) === Number(a.id));
      const latest = mine[mine.length - 1] || null;
      const finished = [...mine].reverse().find((c) => c.status !== 'in_progress');
      const d = downs.find((x) => Number(x.attraction_id) === Number(a.id));
      return { ...shape(a), check: checkOut(latest), attempts: mine.length, blocked: Boolean(finished && finished.status === 'fail'), down: d ? { id: Number(d.id), started_at: d.started_at, reason: d.reason, note: d.note } : null };
    }),
  });
});

// ---------------------------------------------------------------- downtime
const reason = z.enum(A.DOWNTIME_KEYS);
const when = dateTimeStr.transform(normDateTime);
const MINUTES = 'TIMESTAMPDIFF(MINUTE, d.started_at, COALESCE(d.ended_at, ?))';

router.get('/downtime', crew, async (req, res) => {
  const t = req.auth.tenantId;
  const tz = await tzOf(pool, t);
  const now = nowIn(tz);
  const where = ['d.tenant_id = ?']; const params = [now, t];
  if (req.query.attraction_id) { where.push('d.attraction_id = ?'); params.push(Number(first(req.query.attraction_id))); }
  if (req.query.from) { if (!dateStr.safeParse(first(req.query.from)).success) throw bad('Use YYYY-MM-DD'); where.push('DATE(COALESCE(d.ended_at, ?)) >= ?'); params.push(now, first(req.query.from)); }
  if (req.query.to) { if (!dateStr.safeParse(first(req.query.to)).success) throw bad('Use YYYY-MM-DD'); where.push('DATE(d.started_at) <= ?'); params.push(first(req.query.to)); }
  if (req.query.open === '1') where.push('d.ended_at IS NULL');
  const data = await rows(pool, `SELECT d.id, d.attraction_id, a.name AS attraction, d.started_at, d.ended_at, d.reason, d.note, ${MINUTES} AS minutes
    FROM attraction_downtime d JOIN attractions a ON a.tenant_id = d.tenant_id AND a.id = d.attraction_id WHERE ${where.join(' AND ')} ORDER BY d.started_at DESC, d.id DESC LIMIT 300`, params);
  res.json({ data: data.map((d) => ({ ...d, id: Number(d.id), attraction_id: Number(d.attraction_id), minutes: Number(d.minutes) })) });
});

const downFields = { attraction_id: z.number().int().positive(), started_at: when, ended_at: when.nullable().optional(), reason: reason.default('other'), note: z.string().trim().max(255).nullable().optional() };
router.post('/downtime', crew, validate(z.object(downFields)), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  if (b.ended_at && b.ended_at < b.started_at) throw bad('It cannot restart before it stopped');
  if (!(await one(pool, 'SELECT id FROM attractions WHERE tenant_id = ? AND id = ?', [t, b.attraction_id]))) throw notFound('Attraction');
  const [r] = await pool.query('INSERT INTO attraction_downtime (tenant_id, attraction_id, started_at, ended_at, reason, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [t, b.attraction_id, b.started_at, b.ended_at ?? null, b.reason, b.note || null, req.auth.userId]);
  await audit(pool, req, 'create', 'attraction_downtime', r.insertId, b);
  res.status(201).json({ id: r.insertId });
});

router.patch('/downtime/:id', crew, validate(z.object({ started_at: when.optional(), ended_at: when.nullable().optional(), reason: reason.optional(), note: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId; const b = req.body;
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM attraction_downtime WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur) throw notFound('Downtime entry');
    const start = b.started_at || cur.started_at; const end = b.ended_at !== undefined ? b.ended_at : cur.ended_at;
    if (end && end < start) throw bad('It cannot restart before it stopped');
    const keys = ['started_at', 'ended_at', 'reason', 'note'].filter((k) => b[k] !== undefined);
    if (!keys.length) throw bad('No updatable fields supplied');
    await conn.query(`UPDATE attraction_downtime SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => b[k] || null), t, id]);
    // What it said before stays in the audit trail.
    await audit(conn, req, 'update', 'attraction_downtime', id, { before: Object.fromEntries(keys.map((k) => [k, cur[k]])), after: b });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- setting up (managers)
const limit = (max) => z.number().int().min(0).max(max).nullable().optional();
const itemsSchema = z.array(z.object({ key: z.string().max(40).optional(), label: z.string().trim().min(1).max(200) })).min(1).max(40);
const fields = {
  name: z.string().trim().min(1).max(100),
  type: z.enum(A.TYPE_KEYS),
  min_height_in: limit(96),
  min_weight_lb: limit(600),
  max_weight_lb: limit(600),
  min_age: limit(99),
  waiver_required: z.boolean().optional(),
  sort: z.number().int().min(-1000).max(1000).optional(),
};
const COLS = ['name', 'type', 'min_height_in', 'min_weight_lb', 'max_weight_lb', 'min_age', 'waiver_required', 'sort'];
const weights = (b, cur = {}) => {
  const lo = b.min_weight_lb !== undefined ? b.min_weight_lb : cur.min_weight_lb; const hi = b.max_weight_lb !== undefined ? b.max_weight_lb : cur.max_weight_lb;
  if (lo !== null && lo !== undefined && hi !== null && hi !== undefined && Number(hi) < Number(lo)) throw bad('The most a rider can weigh must be more than the least');
};
const dupName = (err) => { if (err && err.code === 'ER_DUP_ENTRY') throw conflict('There is already an attraction with that name. Archived ones keep their name: restore it instead.'); throw err; };
const asDb = (k, v) => (k === 'waiver_required' ? (v ? 1 : 0) : v ?? null);

router.get('/:id', async (req, res) => {
  const a = await one(pool, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!a || (!Number(a.active) && !isManager(req))) throw notFound('Attraction');
  res.json(shape(a, { full: true }));
});

router.post('/', manager, validate(z.object({ ...fields, checklist: itemsSchema.optional() })), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  weights(b);
  const keys = COLS.filter((k) => b[k] !== undefined);
  const checklist = b.checklist ? JSON.stringify(A.normalizeChecklist(b.checklist)) : null;
  if (b.sort === undefined) { keys.push('sort'); b.sort = Number((await one(pool, 'SELECT COALESCE(MAX(sort), 0) + 10 AS n FROM attractions WHERE tenant_id = ?', [t])).n); }
  let id;
  try {
    const [r] = await pool.query(`INSERT INTO attractions (tenant_id, ${keys.join(', ')}, checklist) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)`, [t, ...keys.map((k) => asDb(k, b[k])), checklist]);
    id = r.insertId;
  } catch (err) { dupName(err); }
  await audit(pool, req, 'create', 'attractions', id, { name: b.name, type: b.type });
  res.status(201).json(shape(await one(pool, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ?', [t, id]), { full: true }));
});

router.patch('/:id', manager, validate(z.object(fields).partial()), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId; const b = req.body;
  const keys = COLS.filter((k) => b[k] !== undefined);
  if (!keys.length) throw bad('No updatable fields supplied');
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur) throw notFound('Attraction');
    weights(b, cur);
    try { await conn.query(`UPDATE attractions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => asDb(k, b[k])), t, id]); } catch (err) { dupName(err); }
    await audit(conn, req, 'update', 'attractions', id, { before: Object.fromEntries(keys.map((k) => [k, cur[k]])), after: b });
  });
  res.json(shape(await one(pool, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ?', [t, id]), { full: true }));
});

/** The attraction's own opening checks. null goes back to its type's defaults. Inspections already done keep their words. */
router.put('/:id/checklist', manager, validate(z.object({ items: itemsSchema.nullable() })), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const items = req.body.items ? A.normalizeChecklist(req.body.items) : null;
  const [r] = await pool.query('UPDATE attractions SET checklist = ? WHERE tenant_id = ? AND id = ?', [items ? JSON.stringify(items) : null, t, id]);
  if (!r.affectedRows) throw notFound('Attraction');
  await audit(pool, req, 'set_checklist', 'attractions', id, { items: items ? items.map((i) => i.label) : 'type defaults' });
  res.json(shape(await one(pool, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ?', [t, id]), { full: true }));
});

/** Archived, never deleted: patrol reports, inspections and sales keep pointing at it. It closes first. */
router.post('/:id/archive', manager, async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur) throw notFound('Attraction');
    if (!Number(cur.active)) return;
    const now = nowIn(await tzOf(conn, t));
    await conn.query("UPDATE attractions SET active = 0, status = 'closed' WHERE tenant_id = ? AND id = ?", [t, id]);
    await syncDowntime(conn, t, id, cur.status, 'closed', { reason: 'day_end', now, userId: req.auth.userId });
    await audit(conn, req, 'archive', 'attractions', id, { name: cur.name, status_was: cur.status });
  });
  res.json({ ok: true });
});
router.post('/:id/restore', manager, async (req, res) => {
  const id = paramId(req);
  const [r] = await pool.query('UPDATE attractions SET active = 1 WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Attraction');
  await audit(pool, req, 'restore', 'attractions', id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- status
/**
 * Keep the downtime log in step with the status, like a lift's (lib/ops.js syncDowntime). Leaving open starts an entry
 * with the reason given (closed for the day starts none); going back to open ends it; closing for the day while on hold
 * ends it. A new reason or note while it stays down updates the entry.
 */
async function syncDowntime(conn, tenantId, attractionId, from, to, { reason: why = null, note = null, now, userId = null }) {
  const openRow = await one(conn, 'SELECT id, reason FROM attraction_downtime WHERE tenant_id = ? AND attraction_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE', [tenantId, attractionId]);
  if (to === 'open') {
    if (openRow) await conn.query('UPDATE attraction_downtime SET ended_at = ? WHERE tenant_id = ? AND id = ?', [now, tenantId, openRow.id]);
    return;
  }
  if (from === 'open' && !openRow) {
    if (why === 'day_end') return;
    await conn.query('INSERT INTO attraction_downtime (tenant_id, attraction_id, started_at, reason, note, user_id) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, attractionId, now, why || 'other', note, userId]);
    return;
  }
  if (!openRow) return;
  if (why === 'day_end') { await conn.query('UPDATE attraction_downtime SET ended_at = ? WHERE tenant_id = ? AND id = ?', [now, tenantId, openRow.id]); return; }
  if (why || note) await conn.query('UPDATE attraction_downtime SET reason = COALESCE(?, reason), note = COALESCE(?, note) WHERE tenant_id = ? AND id = ?', [why, note, tenantId, openRow.id]);
}

/** The last finished opening inspection today, read under the attraction's lock. */
const lastFinished = (conn, t, id, date) => one(conn, "SELECT id, status FROM attraction_checks WHERE tenant_id = ? AND attraction_id = ? AND check_date = ? AND status <> 'in_progress' ORDER BY attempt DESC LIMIT 1", [t, id, date]);

const statusBody = z.object({ status: z.enum(['open', 'hold', 'closed']), note: z.string().trim().max(255).nullable().optional(), reason: reason.optional() })
  .refine((b) => b.status !== 'hold' || (b.note && b.note.length), { message: 'Say why it is on hold', path: ['note'] });

// The attraction's row is locked first, then today's inspection is read: an inspection that fails and an open at the same
// moment cannot both win (the inspection takes the same lock before it writes its result).
router.patch('/:id/status', crew, validate(statusBody), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId; const b = req.body;
  const out = await tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur || !Number(cur.active)) throw notFound('Attraction');
    const tz = await tzOf(conn, t);
    if (b.status === 'open') {
      const last = await lastFinished(conn, t, id, todayIn(tz));
      if (last && last.status === 'fail') throw conflict('This attraction failed its opening inspection today. Pass a new inspection before opening it.');
    }
    const note = b.note || null;
    await conn.query('UPDATE attractions SET status = ?, status_note = ? WHERE tenant_id = ? AND id = ?', [b.status, note, t, id]);
    await syncDowntime(conn, t, id, cur.status, b.status, { reason: b.reason || (b.status === 'hold' ? 'other' : null), note, now: nowIn(tz), userId: req.auth.userId });
    await audit(conn, req, 'status', 'attractions', id, { from: cur.status, to: b.status, note, reason: b.reason || null });
    return { ...shape(cur), status: b.status, status_note: note };
  });
  res.json(out);
});

// ---------------------------------------------------------------- opening inspections
/** Start today's opening inspection: the items are copied from the attraction's checks, words and all. */
router.post('/:id/checks', crew, async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const a = await one(conn, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!a || !Number(a.active)) throw notFound('Attraction');
    const tz = await tzOf(conn, t);
    const today = todayIn(tz);
    const latest = await one(conn, 'SELECT * FROM attraction_checks WHERE tenant_id = ? AND attraction_id = ? AND check_date = ? ORDER BY attempt DESC LIMIT 1', [t, id, today]);
    if (latest && latest.status === 'in_progress') return { check: checkOut(latest), created: false };
    if (latest && latest.status === 'pass') throw conflict('Today\'s opening inspection has already passed.');
    const items = A.checklistOf(a).map((i) => ({ key: i.key, label: i.label, result: null, note: null, at: null, by: null }));
    const attempt = latest ? Number(latest.attempt) + 1 : 1;
    const name = await whoIs(conn, req);
    const [r] = await conn.query('INSERT INTO attraction_checks (tenant_id, attraction_id, check_date, attempt, status, items, started_by, started_by_name, started_at) VALUES (?, ?, ?, ?, \'in_progress\', ?, ?, ?, ?)',
      [t, id, today, attempt, JSON.stringify(items), req.auth.userId, name, nowIn(tz)]);
    await audit(conn, req, 'start_inspection', 'attraction_checks', r.insertId, { attraction_id: id, attempt });
    return { check: checkOut(await one(conn, 'SELECT * FROM attraction_checks WHERE tenant_id = ? AND id = ?', [t, r.insertId])), created: true };
  });
  res.status(out.created ? 201 : 200).json(out.check);
});

router.get('/:id/checks', crew, async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const where = ['tenant_id = ?', 'attraction_id = ?']; const params = [t, id];
  for (const [k, op] of [['from', '>='], ['to', '<=']]) {
    if (!req.query[k]) continue;
    if (!dateStr.safeParse(first(req.query[k])).success) throw bad('Use YYYY-MM-DD');
    where.push(`check_date ${op} ?`); params.push(first(req.query[k]));
  }
  const data = await rows(pool, `SELECT * FROM attraction_checks WHERE ${where.join(' AND ')} ORDER BY check_date DESC, attempt DESC LIMIT 200`, params);
  res.json({ data: data.map(checkOut) });
});

const tickBody = z.object({ items: z.array(z.object({ key: z.string().min(1).max(40), result: z.enum(['pass', 'fail']).nullable(), note: z.string().trim().max(300).nullable().optional() })).min(1).max(40) });
/** Tick items on an inspection still in progress. Each tick keeps who and when. */
router.patch('/checks/:checkId', crew, validate(tickBody), async (req, res) => {
  const cid = paramId(req, 'checkId'); const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM attraction_checks WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, cid]);
    if (!c) throw notFound('Inspection');
    if (c.status !== 'in_progress') throw conflict('This inspection is finished. Start a new one to check again.');
    const items = JSON.parse(c.items);
    const name = await whoIs(conn, req);
    const now = nowIn(await tzOf(conn, t));
    for (const x of req.body.items) {
      const it = items.find((i) => i.key === x.key);
      if (!it) throw bad(`Unknown inspection item: ${x.key}`);
      it.result = x.result; it.note = x.note || null; it.at = x.result ? now : null; it.by = x.result ? name : null;
    }
    await conn.query('UPDATE attraction_checks SET items = ? WHERE tenant_id = ? AND id = ?', [JSON.stringify(items), t, cid]);
    return checkOut({ ...c, items: JSON.stringify(items) });
  });
  res.json(out);
});

/**
 * Finish the inspection. Every item passed: it passes. Any item failed (with a note saying what is wrong): it fails,
 * even before the rest are answered, and an attraction that is open closes. A failed inspection blocks opening today
 * until a new one passes.
 */
router.post('/checks/:checkId/finish', crew, validate(z.object({ note: z.string().trim().max(500).nullable().optional() })), async (req, res) => {
  const cid = paramId(req, 'checkId'); const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const head = await one(conn, 'SELECT attraction_id FROM attraction_checks WHERE tenant_id = ? AND id = ?', [t, cid]);
    if (!head) throw notFound('Inspection');
    const a = await one(conn, 'SELECT * FROM attractions WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, head.attraction_id]); // the lock an open takes
    const c = await one(conn, 'SELECT * FROM attraction_checks WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, cid]);
    if (c.status !== 'in_progress') throw conflict('This inspection is already finished.');
    const items = JSON.parse(c.items);
    const failed = items.filter((i) => i.result === 'fail');
    if (failed.some((i) => !i.note)) throw bad(`Say what is wrong: ${failed.filter((i) => !i.note).map((i) => i.label).join('; ')}`);
    if (!failed.length) {
      const open = items.filter((i) => i.result !== 'pass');
      if (open.length) throw bad(`Answer every item before it can pass. Still to check: ${open.map((i) => i.label).join('; ')}`);
    }
    const result = failed.length ? 'fail' : 'pass';
    const tz = await tzOf(conn, t);
    const now = nowIn(tz);
    const name = await whoIs(conn, req);
    await conn.query('UPDATE attraction_checks SET status = ?, note = ?, finished_by = ?, finished_by_name = ?, finished_at = ? WHERE tenant_id = ? AND id = ?',
      [result, req.body.note || null, req.auth.userId, name, now, t, cid]);
    let closed = false;
    if (result === 'fail' && a.status === 'open') {
      const why = `Failed its opening inspection: ${failed.map((i) => i.label).join('; ')}`.slice(0, 255);
      await conn.query("UPDATE attractions SET status = 'closed', status_note = ? WHERE tenant_id = ? AND id = ?", [why, t, a.id]);
      await syncDowntime(conn, t, a.id, 'open', 'closed', { reason: 'inspection', note: why, now, userId: req.auth.userId });
      closed = true;
    }
    await audit(conn, req, 'inspect', 'attraction_checks', cid, { attraction_id: Number(a.id), result, failed: failed.map((i) => i.key), closed });
    return { ...checkOut({ ...c, status: result, note: req.body.note || null, finished_by_name: name, finished_at: now }), closed };
  });
  res.json(out);
});

// ---------------------------------------------------------------- staff (mounted under /workforce)
/**
 * Suggested positions and certifications for each attraction type the mountain runs (or any type asked for), and
 * which of them it has already. Nothing is made until a manager asks.
 */
workforceRouter.get('/attraction-staff', manager, async (req, res) => {
  const t = req.auth.tenantId;
  const [list, positions, certs] = await Promise.all([
    rows(pool, `SELECT type, GROUP_CONCAT(name ORDER BY sort, name SEPARATOR ', ') AS names FROM attractions WHERE tenant_id = ? AND active = 1 GROUP BY type`, [t]),
    rows(pool, 'SELECT id, name, department FROM positions WHERE tenant_id = ?', [t]),
    rows(pool, 'SELECT id, name FROM certifications WHERE tenant_id = ?', [t]),
  ]);
  const has = (all, name) => all.some((x) => x.name.toLowerCase() === name.toLowerCase());
  const used = new Map(list.map((r) => [r.type, r.names]));
  const types = A.TYPE_KEYS.filter((k) => used.has(k));
  res.json({
    data: types.map((k) => {
      const s = A.staffFor(k);
      return {
        type: k, type_label: A.typeLabel(k), attractions: used.get(k),
        positions: s.positions.map((p) => ({ ...p, exists: has(positions, p.name) })),
        certifications: s.certifications.map((n) => ({ name: n, exists: has(certs, n) })),
      };
    }),
  });
});

/**
 * Add a type's suggested positions (Attractions department) and the certifications they require, in one step. Only
 * what is missing is made; a position the mountain already has keeps its own requirements. `positions` picks some.
 */
workforceRouter.post('/attraction-staff', manager, validate(z.object({ type: z.enum(A.TYPE_KEYS), positions: z.array(z.string().max(100)).max(10).optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const s = A.staffFor(req.body.type);
  const want = req.body.positions ? s.positions.filter((p) => req.body.positions.includes(p.name)) : s.positions;
  if (!want.length) throw bad('Pick at least one of the suggested positions');
  const made = await tx(async (conn) => {
    const out = { positions: [], certifications: [] };
    const certId = new Map();
    for (const name of [...new Set(want.flatMap((p) => p.requires))]) {
      const c = await one(conn, 'SELECT id FROM certifications WHERE tenant_id = ? AND LOWER(name) = LOWER(?) FOR UPDATE', [t, name]);
      if (c) { certId.set(name, Number(c.id)); continue; }
      const [r] = await conn.query('INSERT INTO certifications (tenant_id, name) VALUES (?, ?)', [t, name]);
      certId.set(name, r.insertId); out.certifications.push(name);
    }
    for (const p of want) {
      if (await one(conn, 'SELECT id FROM positions WHERE tenant_id = ? AND LOWER(name) = LOWER(?) FOR UPDATE', [t, p.name])) continue;
      const [r] = await conn.query("INSERT INTO positions (tenant_id, name, department) VALUES (?, ?, 'attractions')", [t, p.name]);
      for (const n of p.requires) await conn.query('INSERT INTO position_certifications (tenant_id, position_id, certification_id) VALUES (?, ?, ?)', [t, r.insertId, certId.get(n)]);
      out.positions.push(p.name);
    }
    await audit(conn, req, 'add_attraction_staff', 'positions', null, { type: req.body.type, ...out });
    return out;
  });
  res.status(201).json(made);
});

module.exports = { router, workforceRouter, syncDowntime };
