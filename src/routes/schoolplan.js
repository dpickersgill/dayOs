'use strict';
// Lesson planning, best of breed (2026.11.9), Track PLAN: the season plan. router is mounted at /skischool (staff).
// tick() runs every 5 minutes (POST /jobs/lessons) and daily() once a day (POST /jobs/daily): return a small summary.
//   /skischool/plans                      list, create (blank, from a saved pattern, or a copy of another plan)
//   /skischool/plans/:id                  get, update (name, dates, the plan itself), delete a draft that never published
//   /skischool/plans/:id/calendar?month=  each day's type, slots and the lessons the plan made (STAFF's fill view reads it)
//   /skischool/plans/:id/day?date=        the lessons already on a day, with how many are booked
//   /skischool/plans/:id/preview|publish  what a publish would do; publish it (one transaction)
//   /skischool/plans/:id/publishes        history; /skischool/plans/publishes/:id/undo
//   /skischool/plan-patterns              saved patterns (day types and weekdays); /skischool/plan-templates day templates
// Directors (and owners and managers) plan; supervisors can read the calendar.
const express = require('express');
const { pool, tx, one, rows } = require('../db');
const { z, dateStr, validate, paramId, localTime } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { school } = require('../lib/schoolaccess');
const LP = require('../lib/lessonplan');
const LC = require('../lib/lessoncopy');
const settings = require('../lib/schoolsettings');
const { teachingStaff } = require('../lib/school');

const router = express.Router();
const director = school('director');
const supervisor = school('supervisor');

const planBody = { name: z.string().trim().min(2, 'Name the plan').max(80), from_on: dateStr, to_on: dateStr };
const span = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
function checkDates(from, to) {
  if (to < from) throw bad('The last day must be on or after the first day');
  if (span(from, to) > LP.MAX_DAYS) throw bad(`A plan covers at most ${LP.MAX_DAYS} days. Split the season into two plans.`);
}

async function planOf(db, tenantId, id, lock = false) {
  const p = await one(db, `SELECT * FROM lesson_plans WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!p) throw notFound('Plan');
  return p;
}

/** The plan as the editor needs it: its doc, whether it changed since its last publish, and its lesson count. */
async function full(tenantId, p) {
  const doc = LP.parseDoc(JSON.parse(p.doc));
  const last = await one(pool, 'SELECT id, doc_sha, created_at, summary FROM lesson_plan_publishes WHERE tenant_id = ? AND plan_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1', [tenantId, p.id]);
  const n = await one(pool, "SELECT COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ? AND plan_id = ? AND status <> 'cancelled'", [tenantId, p.id]);
  const ever = await one(pool, 'SELECT COUNT(*) AS n FROM lesson_plan_publishes WHERE tenant_id = ? AND plan_id = ?', [tenantId, p.id]);
  return { id: p.id, name: p.name, from_on: String(p.from_on).slice(0, 10), to_on: String(p.to_on).slice(0, 10), status: p.status, published_at: p.published_at, updated_at: p.updated_at,
    doc, lessons: Number(n.n), published_ever: Number(ever.n) > 0, last_publish: last ? { id: last.id, at: last.created_at, words: last.summary } : null, unpublished: Boolean(last && last.doc_sha !== LP.shaOf(doc)) };
}

router.get('/plans', supervisor, async (req, res) => {
  const t = req.auth.tenantId;
  const list = await rows(pool, `SELECT p.id, p.name, p.from_on, p.to_on, p.status, p.published_at, p.updated_at,
      (SELECT COUNT(*) FROM lesson_sessions s WHERE s.tenant_id = p.tenant_id AND s.plan_id = p.id AND s.status <> 'cancelled') AS lessons
    FROM lesson_plans p WHERE p.tenant_id = ? ORDER BY p.from_on DESC, p.id DESC LIMIT 100`, [t]);
  res.json({ data: list.map((p) => ({ ...p, from_on: String(p.from_on).slice(0, 10), to_on: String(p.to_on).slice(0, 10), lessons: Number(p.lessons) })) });
});

/** What the editor's pickers need: lesson products (single lessons), instructors, certifications and the school's defaults. */
router.get('/plans/options', director, async (req, res) => {
  const t = req.auth.tenantId;
  const s = await settings.get(pool, t);
  const products = await rows(pool, "SELECT id, name, active, base_price_cents FROM products WHERE tenant_id = ? AND kind = 'lesson' AND (uses IS NULL OR uses <= 1) ORDER BY active DESC, name", [t]);
  const staff = (await teachingStaff(pool, t)).map((m) => ({ id: m.id, name: `${m.first_name} ${m.last_name}` }));
  const certs = await rows(pool, 'SELECT id, name FROM certifications WHERE tenant_id = ? ORDER BY name LIMIT 300', [t]);
  res.json({ products, instructors: staff, certifications: certs, pool_spots_mode: s.pool_spots_mode, ratio_kids: s.ratio_kids, ratio_adults: s.ratio_adults,
    lengths: LP.LENGTHS, colors: LP.COLORS, max_types: LP.MAX_TYPES });
});

router.post('/plans', director, validate(z.object({ ...planBody, pattern_id: z.number().int().positive().optional(), copy_of: z.number().int().positive().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  checkDates(b.from_on, b.to_on);
  let doc = LP.defaults();
  if (b.pattern_id) {
    const pt = await one(pool, 'SELECT doc FROM lesson_patterns WHERE tenant_id = ? AND id = ?', [t, b.pattern_id]);
    if (!pt) throw notFound('Pattern');
    doc = { ...doc, ...JSON.parse(pt.doc), periods: [], exceptions: [] };
  } else if (b.copy_of) {
    const other = await planOf(pool, t, b.copy_of);
    doc = { ...JSON.parse(other.doc), periods: [], exceptions: [] }; // periods and one-off days belong to their own season
  }
  doc = LP.parseDoc(doc);
  await LP.checkCerts(pool, t, doc);
  const id = await tx(async (conn) => {
    const [r] = await conn.query('INSERT INTO lesson_plans (tenant_id, name, from_on, to_on, doc, created_by) VALUES (?, ?, ?, ?, ?, ?)', [t, b.name, b.from_on, b.to_on, JSON.stringify(doc), req.auth.userId || null]);
    await audit(conn, req, 'create', 'lesson_plans', r.insertId, { name: b.name, from_on: b.from_on, to_on: b.to_on, pattern_id: b.pattern_id || null, copy_of: b.copy_of || null });
    return r.insertId;
  });
  res.status(201).json(await full(t, await planOf(pool, t, id)));
});

router.get('/plans/:id', supervisor, async (req, res) => res.json(await full(req.auth.tenantId, await planOf(pool, req.auth.tenantId, paramId(req)))));

router.put('/plans/:id', director, validate(z.object({ name: planBody.name.optional(), from_on: dateStr.optional(), to_on: dateStr.optional(), doc: z.any().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body; const pid = paramId(req);
  await tx(async (conn) => {
    const p = await planOf(conn, t, pid, true);
    const from = b.from_on || String(p.from_on).slice(0, 10); const to = b.to_on || String(p.to_on).slice(0, 10);
    checkDates(from, to);
    const doc = b.doc !== undefined ? LP.parseDoc(b.doc) : null;
    if (doc) await LP.checkCerts(conn, t, doc);
    await conn.query('UPDATE lesson_plans SET name = ?, from_on = ?, to_on = ?, doc = ? WHERE tenant_id = ? AND id = ?', [b.name || p.name, from, to, doc ? JSON.stringify(doc) : p.doc, t, pid]);
    const what = doc ? { day_types: doc.day_types.length, slots: doc.day_types.reduce((n, x) => n + x.slots.length, 0), periods: doc.periods.length, exceptions: doc.exceptions.length } : null;
    await audit(conn, req, 'update', 'lesson_plans', pid, { name: b.name, from_on: b.from_on, to_on: b.to_on, doc: what });
  });
  res.json(await full(t, await planOf(pool, t, pid)));
});

router.delete('/plans/:id', director, async (req, res) => {
  const t = req.auth.tenantId; const pid = paramId(req);
  await tx(async (conn) => {
    const p = await planOf(conn, t, pid, true);
    const pub = await one(conn, 'SELECT COUNT(*) AS n FROM lesson_plan_publishes WHERE tenant_id = ? AND plan_id = ?', [t, pid]);
    if (Number(pub.n)) throw conflict('This plan has been published, so it stays for the record. Undo its publishes to take its lessons away.');
    await conn.query('DELETE FROM lesson_plans WHERE tenant_id = ? AND id = ?', [t, pid]);
    await audit(conn, req, 'delete', 'lesson_plans', pid, { name: p.name });
  });
  res.json({ ok: true });
});

router.get('/plans/:id/calendar', supervisor, async (req, res) => {
  const t = req.auth.tenantId;
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : null;
  const p = await planOf(pool, t, paramId(req));
  const m = month || String(p.from_on).slice(0, 7);
  res.json({ month: m, from_on: String(p.from_on).slice(0, 10), to_on: String(p.to_on).slice(0, 10), days: await LP.calendar(pool, t, p, m) });
});

/** The lessons on a day (from this plan or not), with how many are booked. No student details here. */
router.get('/plans/:id/day', supervisor, async (req, res) => {
  const t = req.auth.tenantId;
  const date = dateStr.safeParse(req.query.date);
  if (!date.success) throw bad('Pick a day');
  const p = await planOf(pool, t, paramId(req));
  const list = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.age_min, s.age_max, s.format, s.kind, s.capacity, s.spots_cap, s.spots_mode, s.plan_id, s.plan_slot, s.status, pr.name AS product,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at, s.id`, [t, `${date.data} 00:00:00`, `${date.data} 23:59:59`]);
  res.json({ date: date.data, data: list.map((l) => ({ ...l, booked: Number(l.booked), from_plan: l.plan_id === p.id })) });
});

router.post('/plans/:id/preview', director, async (req, res) => {
  const t = req.auth.tenantId;
  res.json(LP.shape(await LP.preview(pool, t, await planOf(pool, t, paramId(req)))));
});

router.post('/plans/:id/publish', director, validate(z.object({ remove: z.boolean().default(false) })), async (req, res) => {
  const t = req.auth.tenantId; const pid = paramId(req);
  const out = await tx(async (conn) => {
    const r = await LP.publish(conn, t, pid, { remove: req.body.remove, userId: req.auth.userId || null });
    await audit(conn, req, 'publish', 'lesson_plans', pid, { publish_id: r.publish_id, ...r.counts });
    return r;
  });
  res.status(201).json({ publish_id: out.publish_id, counts: out.counts, words: out.words, kept: out.kept, assign_later: out.assign_later });
});

router.get('/plans/:id/publishes', director, async (req, res) => {
  const t = req.auth.tenantId;
  const list = await rows(pool, `SELECT pp.id, pp.created_n, pp.updated_n, pp.removed_n, pp.kept_n, pp.summary, pp.created_at, pp.undone_at, u.email AS by_email
    FROM lesson_plan_publishes pp LEFT JOIN users u ON u.tenant_id = pp.tenant_id AND u.id = pp.created_by WHERE pp.tenant_id = ? AND pp.plan_id = ? ORDER BY pp.id DESC LIMIT 50`, [t, paramId(req)]);
  const latest = list.find((x) => !x.undone_at);
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
  // Stamped by the database in UTC; shown in the mountain's time.
  res.json({ data: list.map((x) => ({ ...x, created_at: localTime(x.created_at, tz), undone_at: x.undone_at ? localTime(x.undone_at, tz) : null, can_undo: Boolean(latest && latest.id === x.id) })) });
});

router.post('/plans/publishes/:id/undo', director, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const out = await tx(async (conn) => {
    const r = await LP.undo(conn, t, id, req.auth.userId || null);
    await audit(conn, req, 'undo_publish', 'lesson_plans', r.plan_id, { publish_id: id, removed: r.removed, restored: r.restored, kept: r.kept.length });
    return r;
  });
  res.json(out);
});

// ---------------------------------------------------------------- patterns and day templates
router.get('/plan-patterns', director, async (req, res) => {
  const list = await rows(pool, 'SELECT id, name, doc, updated_at FROM lesson_patterns WHERE tenant_id = ? ORDER BY name', [req.auth.tenantId]);
  res.json({ data: list.map((p) => { const d = JSON.parse(p.doc); return { id: p.id, name: p.name, updated_at: p.updated_at, day_types: d.day_types.map((x) => x.name), slots: d.day_types.reduce((n, x) => n + x.slots.length, 0) }; }) });
});
/** Saves a plan's day types and weekday defaults as a named pattern (replacing one with the same name). */
router.post('/plan-patterns', director, validate(z.object({ name: z.string().trim().min(2, 'Name the pattern').max(80), plan_id: z.number().int().positive() })), async (req, res) => {
  const t = req.auth.tenantId;
  const p = await planOf(pool, t, req.body.plan_id);
  const d = LP.parseDoc(JSON.parse(p.doc));
  const doc = { day_types: d.day_types, weekdays: d.weekdays };
  const id = await tx(async (conn) => {
    const [r] = await conn.query('INSERT INTO lesson_patterns (tenant_id, name, doc, created_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE doc = VALUES(doc), id = LAST_INSERT_ID(id)', [t, req.body.name, JSON.stringify(doc), req.auth.userId || null]);
    await audit(conn, req, 'save_pattern', 'lesson_patterns', r.insertId, { name: req.body.name, plan_id: p.id });
    return r.insertId;
  });
  res.status(201).json({ id });
});
router.delete('/plan-patterns/:id', director, async (req, res) => {
  const [r] = await pool.query('DELETE FROM lesson_patterns WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Pattern');
  await audit(pool, req, 'delete', 'lesson_patterns', paramId(req), null);
  res.json({ ok: true });
});
router.get('/plan-templates', director, async (req, res) => res.json({ data: await LC.templates(req.auth.tenantId) }));
router.get('/plan-templates/:id/slots', director, async (req, res) => {
  const s = await settings.get(pool, req.auth.tenantId);
  res.json({ data: await LP.templateSlots(pool, req.auth.tenantId, paramId(req), s.pool_spots_mode) });
});

async function tick() { return {}; }
async function daily() { return {}; }

module.exports = { router, tick, daily };
