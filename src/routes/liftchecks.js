'use strict';

// Lift inspections by lift type (2026.11.10, SLIM 7d), mounted under /ops beside the older one-step form.
//   GET  /lift-types                      the types, the two kinds, and every list (the mountain's copy or the built-in one)
//   PUT  /lift-templates/:type/:kind      a manager edits the mountain's copy; null goes back to the built-in list
//   PATCH /lifts/:id/type                 a manager sets a lift's type
//   GET  /lift-inspections/day            every lift with today's daily inspection and its last weekly one
//   POST /lifts/:id/inspections           start (or pick up) an inspection from the type's list, words and all
//   PATCH /lift-inspections/:id           tick items: pass, fail (with a note) or not applicable (optional items only)
//   POST /lift-inspections/:id/finish     sign off. A failed required item fails it: the lift cannot be set to open
//                                         until a new inspection of that kind passes (lib/ops.js openBlock)
// A finished inspection is also written to lift_checks, so the board, the daily report and the open check read it.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, nowIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const L = require('../lib/liftchecks');

const router = express.Router();
const crew = requireRole('staff', 'manager', 'patrol');
const manager = requireRole('manager');

const tzOf = async (db, tenantId) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
async function whoIs(db, req) {
  const u = await one(db, "SELECT COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), u.email, u.username) AS name FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE u.tenant_id = ? AND u.id = ?", [req.auth.tenantId, req.auth.userId]);
  return u ? String(u.name || '').slice(0, 100) : null;
}

/** The list a lift of this type uses for this kind: the mountain's copy, or the built-in one. */
async function listFor(db, tenantId, type, kind) {
  if (type) {
    const t = await one(db, 'SELECT items FROM lift_check_templates WHERE tenant_id = ? AND lift_type = ? AND kind = ?', [tenantId, type, kind]);
    const own = t && L.parseItems(t.items);
    if (own) return { items: own, custom: true };
  }
  return { items: L.builtIn(type, kind), custom: false };
}

const out = (c) => (c ? {
  id: Number(c.id), lift_id: Number(c.lift_id), kind: c.kind, kind_label: L.kindOf(c.kind).long, lift_type: c.lift_type, check_date: ymd(c.check_date), status: c.status,
  items: JSON.parse(c.items), note: c.note, started_by: c.started_by_name, started_at: c.started_at, finished_by: c.finished_by_name, finished_at: c.finished_at,
  work_order_id: c.work_order_id ? Number(c.work_order_id) : null,
} : null);

// ---------------------------------------------------------------- types and lists
router.get('/lift-types', crew, async (req, res) => {
  const own = await rows(pool, 'SELECT lift_type, kind, items, updated_at FROM lift_check_templates WHERE tenant_id = ?', [req.auth.tenantId]);
  res.json({
    kinds: L.KINDS,
    types: L.TYPES.map((t) => ({
      key: t.key, label: t.label,
      lists: Object.fromEntries(L.KIND_KEYS.map((k) => {
        const mine = own.find((r) => r.lift_type === t.key && r.kind === k);
        const items = mine && L.parseItems(mine.items);
        return [k, { items: items || L.builtIn(t.key, k), custom: Boolean(items), built_in: L.builtIn(t.key, k) }];
      })),
    })),
    untyped: Object.fromEntries(L.KIND_KEYS.map((k) => [k, L.builtIn(null, k)])),
  });
});

const itemsSchema = z.array(z.object({ key: z.string().max(40).optional(), label: z.string().trim().min(1).max(200), required: z.boolean().optional() })).min(1).max(60);
router.put('/lift-templates/:type/:kind', manager, validate(z.object({ items: itemsSchema.nullable() })), async (req, res) => {
  const { type, kind } = req.params;
  if (!L.TYPE_KEYS.includes(type)) throw notFound('Lift type');
  if (!L.KIND_KEYS.includes(kind)) throw notFound('Inspection kind');
  const t = req.auth.tenantId;
  if (req.body.items) {
    const items = L.normalize(req.body.items);
    await pool.query('INSERT INTO lift_check_templates (tenant_id, lift_type, kind, items, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE items = VALUES(items), updated_by = VALUES(updated_by)',
      [t, type, kind, JSON.stringify(items), req.auth.userId]);
    await audit(pool, req, 'set_lift_checklist', 'lift_check_templates', null, { type, kind, items: items.map((i) => `${i.required ? '' : '(optional) '}${i.label}`) });
  } else {
    await pool.query('DELETE FROM lift_check_templates WHERE tenant_id = ? AND lift_type = ? AND kind = ?', [t, type, kind]);
    await audit(pool, req, 'set_lift_checklist', 'lift_check_templates', null, { type, kind, items: 'built-in list' });
  }
  const list = await listFor(pool, t, type, kind);
  res.json({ type, kind, ...list });
});

router.patch('/lifts/:id/type', manager, validate(z.object({ lift_type: z.enum(L.TYPE_KEYS).nullable() })), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const cur = await one(pool, 'SELECT id, lift_type FROM lifts WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!cur) throw notFound('Lift');
  await pool.query('UPDATE lifts SET lift_type = ? WHERE tenant_id = ? AND id = ?', [req.body.lift_type, t, id]);
  await audit(pool, req, 'set_lift_type', 'lifts', id, { from: cur.lift_type, to: req.body.lift_type });
  res.json({ id, lift_type: req.body.lift_type, lift_type_label: L.typeLabel(req.body.lift_type) });
});

// ---------------------------------------------------------------- the day
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** Every lift with its type, the day's latest daily inspection (started or finished), and its latest weekly one. */
router.get('/lift-inspections/day', crew, async (req, res) => {
  const t = req.auth.tenantId;
  const today = todayIn(await tzOf(pool, t));
  const date = req.query.date ? String(req.query.date) : today;
  if (!dateStr.safeParse(date).success) throw bad('Use YYYY-MM-DD');
  const [lifts, daily, weekly, oldChecks, weeklyChecks] = await Promise.all([
    rows(pool, 'SELECT id, name, status, lift_type FROM lifts WHERE tenant_id = ? ORDER BY name', [t]),
    rows(pool, "SELECT * FROM lift_inspections WHERE tenant_id = ? AND kind = 'daily' AND check_date = ? ORDER BY id", [t, date]),
    rows(pool, "SELECT * FROM lift_inspections WHERE tenant_id = ? AND kind = 'periodic' AND check_date <= ? AND id IN (SELECT MAX(id) FROM lift_inspections WHERE tenant_id = ? AND kind = 'periodic' AND check_date <= ? GROUP BY lift_id)", [t, date, t, date]),
    // Inspections saved with the older one-step form still count for the day.
    rows(pool, "SELECT lift_id, result, inspector, checked_at FROM lift_checks WHERE tenant_id = ? AND kind = 'pre_open' AND check_date = ? ORDER BY id", [t, date]),
    // The signed-off weekly results, newest per lift: what the open check reads (lib/ops.js openBlock).
    rows(pool, "SELECT c.lift_id, c.result, c.check_date FROM lift_checks c JOIN (SELECT lift_id, MAX(id) AS id FROM lift_checks WHERE tenant_id = ? AND kind = 'periodic' AND check_date <= ? GROUP BY lift_id) m ON m.id = c.id WHERE c.tenant_id = ?", [t, date, t]),
  ]);
  const data = lifts.map((l) => {
    const mine = daily.filter((c) => Number(c.lift_id) === Number(l.id));
    const latest = mine[mine.length - 1] || null;
    const finished = [...mine].reverse().find((c) => c.status !== 'in_progress');
    const old = [...oldChecks].reverse().find((c) => Number(c.lift_id) === Number(l.id));
    const w = weekly.find((c) => Number(c.lift_id) === Number(l.id)) || null;
    const wk = weeklyChecks.find((c) => Number(c.lift_id) === Number(l.id)) || null;
    const dailyResult = finished && (!old || new Date(finished.finished_at) >= new Date(old.checked_at)) ? finished.status : old ? old.result : null;
    return {
      id: Number(l.id), name: l.name, status: l.status, lift_type: l.lift_type, lift_type_label: L.typeLabel(l.lift_type),
      daily: out(latest), daily_result: dailyResult,
      weekly: out(w), weekly_result: wk ? wk.result : null, weekly_date: wk ? ymd(wk.check_date) : null,
      weekly_due: !wk || wk.result === 'fail' || daysBetween(ymd(wk.check_date), date) >= 7,
      blocked: dailyResult === 'fail' || Boolean(wk && wk.result === 'fail'),
    };
  });
  res.json({ date, today: date === today, data });
});

// ---------------------------------------------------------------- one inspection
/** Start the lift's inspection of a kind for today, or pick up the one already started. */
router.post('/lifts/:id/inspections', crew, validate(z.object({ kind: z.enum(L.KIND_KEYS).default('daily') })), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId; const { kind } = req.body;
  const result = await tx(async (conn) => {
    const lift = await one(conn, 'SELECT id, name, lift_type FROM lifts WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!lift) throw notFound('Lift');
    const tz = await tzOf(conn, t);
    const today = todayIn(tz);
    const open = await one(conn, "SELECT * FROM lift_inspections WHERE tenant_id = ? AND lift_id = ? AND kind = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1", [t, id, kind]);
    // A weekly walk can take more than a day, so it is picked up where it was left. A daily one left unfinished on an
    // earlier day stays as it was (never signed off, so it never counts) and today's starts fresh.
    if (open && (kind === 'periodic' || ymd(open.check_date) === today)) return { check: out(open), created: false };
    const list = await listFor(conn, t, lift.lift_type, kind);
    const items = list.items.map((i) => ({ key: i.key, label: i.label, required: i.required, result: null, note: null, at: null, by: null }));
    const name = await whoIs(conn, req);
    const [r] = await conn.query("INSERT INTO lift_inspections (tenant_id, lift_id, kind, lift_type, check_date, status, items, started_by, started_by_name, started_at) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)",
      [t, id, kind, lift.lift_type, today, JSON.stringify(items), req.auth.userId, name, nowIn(tz)]);
    await audit(conn, req, 'start_inspection', 'lift_inspections', r.insertId, { lift_id: id, kind });
    return { check: out(await one(conn, 'SELECT * FROM lift_inspections WHERE tenant_id = ? AND id = ?', [t, r.insertId])), created: true };
  });
  res.status(result.created ? 201 : 200).json(result.check);
});

router.get('/lifts/:id/inspections', crew, async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  if (!(await one(pool, 'SELECT id FROM lifts WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Lift');
  const where = ['tenant_id = ?', 'lift_id = ?']; const params = [t, id];
  if (req.query.kind && L.KIND_KEYS.includes(String(req.query.kind))) { where.push('kind = ?'); params.push(String(req.query.kind)); }
  const data = await rows(pool, `SELECT * FROM lift_inspections WHERE ${where.join(' AND ')} ORDER BY check_date DESC, id DESC LIMIT 100`, params);
  res.json({ data: data.map(out) });
});

router.get('/lift-inspections/:id', crew, async (req, res) => {
  const c = await one(pool, 'SELECT * FROM lift_inspections WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!c) throw notFound('Inspection');
  res.json(out(c));
});

const tickBody = z.object({ items: z.array(z.object({ key: z.string().min(1).max(40), result: z.enum(['pass', 'fail', 'na']).nullable(), note: z.string().trim().max(300).nullable().optional() })).min(1).max(60) });
/** Tick items on an inspection still in progress. Each tick keeps who and when. */
router.patch('/lift-inspections/:id', crew, validate(tickBody), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const result = await tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM lift_inspections WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!c) throw notFound('Inspection');
    if (c.status !== 'in_progress') throw conflict('This inspection is signed off. Start a new one to check again.');
    const items = JSON.parse(c.items);
    const name = await whoIs(conn, req);
    const now = nowIn(await tzOf(conn, t));
    for (const x of req.body.items) {
      const it = items.find((i) => i.key === x.key);
      if (!it) throw bad(`Unknown inspection item: ${x.key}`);
      if (x.result === 'na' && it.required) throw bad(`This item is required, so it cannot be marked not applicable: ${it.label}`);
      it.result = x.result; it.note = x.note || null; it.at = x.result ? now : null; it.by = x.result ? name : null;
    }
    await conn.query('UPDATE lift_inspections SET items = ? WHERE tenant_id = ? AND id = ?', [JSON.stringify(items), t, id]);
    return out({ ...c, items: JSON.stringify(items) });
  });
  res.json(result);
});

/**
 * Sign off. A failed required item fails the inspection, even before the rest are answered. Otherwise every item must
 * be answered. Any failed item (with a note saying what is wrong) opens a work order for the lift. A failed inspection
 * keeps the lift from being set to open until a new inspection of the same kind passes.
 */
router.post('/lift-inspections/:id/finish', crew, validate(z.object({ note: z.string().trim().max(500).nullable().optional() })), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId;
  const result = await tx(async (conn) => {
    const head = await one(conn, 'SELECT lift_id FROM lift_inspections WHERE tenant_id = ? AND id = ?', [t, id]);
    if (!head) throw notFound('Inspection');
    const lift = await one(conn, 'SELECT id, name, status FROM lifts WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, head.lift_id]);
    const c = await one(conn, 'SELECT * FROM lift_inspections WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (c.status !== 'in_progress') throw conflict('This inspection is already signed off.');
    const items = JSON.parse(c.items);
    const failed = items.filter((i) => i.result === 'fail');
    if (failed.some((i) => !i.note)) throw bad(`Say what is wrong: ${failed.filter((i) => !i.note).map((i) => i.label).join('; ')}`);
    const failedRequired = failed.filter((i) => i.required);
    if (!failedRequired.length) {
      const open = items.filter((i) => !i.result);
      if (open.length) throw bad(`Answer every item before signing off. Still to check: ${open.map((i) => i.label).join('; ')}`);
    }
    const status = failedRequired.length ? 'fail' : 'pass';
    const tz = await tzOf(conn, t);
    const now = nowIn(tz);
    const name = await whoIs(conn, req);
    const kindWord = L.kindOf(c.kind).long.toLowerCase();
    let orderId = null;
    if (failed.length) {
      const [w] = await conn.query("INSERT INTO work_orders (tenant_id, title, description, priority, lift_id, source, opened_by) VALUES (?, ?, ?, ?, ?, 'inspection', ?)",
        [t, `${status === 'fail' ? 'Failed' : 'Problems found on'} ${kindWord}: ${lift.name}`.slice(0, 200), failed.map((i) => `${i.label}: ${i.note}`).join('\n'), status === 'fail' ? 'high' : 'normal', lift.id, req.auth.userId]);
      orderId = w.insertId;
      await audit(conn, req, 'create', 'work_orders', orderId, { source: 'inspection' });
    }
    const [k] = await conn.query('INSERT INTO lift_checks (tenant_id, lift_id, check_date, kind, result, items, inspector, user_id, note, work_order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, lift.id, ymd(c.check_date), c.kind === 'periodic' ? 'periodic' : 'pre_open', status, JSON.stringify(items.map((i) => ({ key: i.key, label: i.label, required: i.required, result: i.result || 'na', note: i.note }))), name, req.auth.userId, req.body.note || null, orderId]);
    await conn.query('UPDATE lift_inspections SET status = ?, note = ?, finished_by = ?, finished_by_name = ?, finished_at = ?, lift_check_id = ?, work_order_id = ? WHERE tenant_id = ? AND id = ?',
      [status, req.body.note || null, req.auth.userId, name, now, k.insertId, orderId, t, id]);
    await audit(conn, req, 'inspect', 'lift_inspections', id, { lift_id: Number(lift.id), kind: c.kind, result: status, failed: failed.map((i) => i.key), work_order_id: orderId });
    return { ...out({ ...c, status, note: req.body.note || null, finished_by_name: name, finished_at: now, work_order_id: orderId }), lift_open: status === 'fail' && lift.status === 'open' };
  });
  res.json(result);
});

module.exports = { router };
