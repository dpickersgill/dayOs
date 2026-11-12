'use strict';

// Programs (muni release 1): one job over many assets or map features, such as "Exercise zone 3 valves", "Spring hydrant
// flushing, north side" or "Screen 25% of outfalls". A manager names it, picks the checklist, picks the targets (from a
// list, by kind, or by a box drawn on the map), sets a due date and who leads it. The crew opens it on a phone, sees the
// targets on a map and as a list nearest first, and does the inspection for each; a target can be skipped with a reason.
// A failure opens a work order on that target (source 'program', with the program's id). A manager closes the program
// when it is done and copies it for next year.
//
// Mounted at /assets/programs inside the assets router: Assets and fleet, staff and managers. Managers plan, change,
// close and copy; the crew does the targets.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, nowIn, addDays } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { card, todayRoute } = require('../lib/today');
const { progressWords } = require('../lib/programprogress');
const MF = require('../lib/mapfeatures');
const CR = require('../lib/checkrules');
const AI = require('../lib/assetinspect');

const router = express.Router();
const manager = requireRole('manager');
const nullable = (s) => s.nullable().optional();
const first = (v) => String(Array.isArray(v) ? v[0] : v);
const MAX_TARGETS = 3000;
const tzOf = async (conn, tenantId) => (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
const fmtDue = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

// The targets: asset ids, map item ids, and/or a pick of map items by kind, inside a box drawn on the map.
const box = z.object({ south: z.number().min(-90).max(90), west: z.number().min(-180).max(180), north: z.number().min(-90).max(90), east: z.number().min(-180).max(180) })
  .refine((b) => b.south <= b.north && b.west <= b.east, 'The box is upside down');
const targetsSchema = z.object({
  assets: z.array(z.number().int().positive()).max(MAX_TARGETS).optional(),
  features: z.array(z.number().int().positive()).max(MAX_TARGETS).optional(),
  pick: z.object({ kinds: z.array(z.enum(MF.KIND_KEYS)).min(1).max(30), box: box.optional() }).optional(),
});
const fields = {
  name: z.string().trim().min(3).max(120),
  template_id: z.number().int().positive(),
  due_on: nullable(dateStr),
  assigned_staff_id: nullable(z.number().int().positive()),
  crew: nullable(z.string().trim().max(120)),
  notes: nullable(z.string().trim().max(1000)),
};

async function mustExist(conn, table, tenantId, id, what) {
  if (id && !(await one(conn, `SELECT id FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [tenantId, id]))) throw notFound(what);
}

/** The asset and map item ids a targets object names, checked to be this tenant's. Returns { assets: [], features: [] }. */
async function resolveTargets(conn, tenantId, t = {}) {
  const assets = [...new Set(t.assets || [])];
  let features = [...new Set(t.features || [])];
  if (assets.length) {
    const found = await rows(conn, "SELECT id FROM ops_assets WHERE tenant_id = ? AND id IN (?) AND status <> 'retired'", [tenantId, assets]);
    if (found.length !== assets.length) throw notFound('Asset');
  }
  if (features.length) {
    const found = await rows(conn, 'SELECT id FROM map_features WHERE tenant_id = ? AND id IN (?)', [tenantId, features]);
    if (found.length !== features.length) throw notFound('Map item');
  }
  if (t.pick) {
    const where = ['tenant_id = ?', 'kind IN (?)', "status IN ('in_service','out_of_service')"]; const params = [tenantId, t.pick.kinds];
    if (t.pick.box) { where.push('lat BETWEEN ? AND ?', 'lng BETWEEN ? AND ?'); params.push(t.pick.box.south, t.pick.box.north, t.pick.box.west, t.pick.box.east); }
    const picked = await rows(conn, `SELECT id FROM map_features WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${MAX_TARGETS + 1}`, params);
    features = [...new Set([...features, ...picked.map((r) => Number(r.id))])];
  }
  if (assets.length + features.length > MAX_TARGETS) throw bad(`A program can hold up to ${MAX_TARGETS} targets. Split it into smaller programs.`);
  return { assets, features };
}

/** Adds targets to a program, skipping ones already in it. Returns how many were added. */
async function addTargets(conn, tenantId, programId, { assets, features }) {
  let added = 0;
  for (const id of assets) { const [r] = await conn.query('INSERT IGNORE INTO asset_program_targets (tenant_id, program_id, asset_id) VALUES (?, ?, ?)', [tenantId, programId, id]); added += r.affectedRows; }
  for (const id of features) { const [r] = await conn.query('INSERT IGNORE INTO asset_program_targets (tenant_id, program_id, map_feature_id) VALUES (?, ?, ?)', [tenantId, programId, id]); added += r.affectedRows; }
  return added;
}

const PROGRAM_SQL = `SELECT p.*, t.name AS template_name, CONCAT(pe.first_name, ' ', pe.last_name) AS assignee,
    (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id) AS total,
    (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.status = 'done') AS done,
    (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.status = 'skipped') AS skipped,
    (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.result = 'fail') AS failed
  FROM asset_programs p
  JOIN inspection_templates t ON t.tenant_id = p.tenant_id AND t.id = p.template_id
  LEFT JOIN staff s ON s.tenant_id = p.tenant_id AND s.id = p.assigned_staff_id
  LEFT JOIN people pe ON pe.tenant_id = s.tenant_id AND pe.id = s.person_id`;
function programOut(p, today) {
  const total = Number(p.total); const done = Number(p.done); const skipped = Number(p.skipped);
  const due = ymd(p.due_on);
  return {
    id: Number(p.id), name: p.name, template_id: Number(p.template_id), template_name: p.template_name, due_on: due, assigned_staff_id: p.assigned_staff_id === null ? null : Number(p.assigned_staff_id),
    assignee: p.assignee && p.assignee.trim() ? p.assignee.trim() : null, crew: p.crew, notes: p.notes, status: p.status, copied_from: p.copied_from === null ? null : Number(p.copied_from),
    created_at: p.created_at, closed_at: p.closed_at,
    progress: { total, done, skipped, todo: total - done - skipped, failed: Number(p.failed), percent: total ? Math.round(((done + skipped) / total) * 100) : 0,
      words: progressWords({ total, done, skipped, failed: Number(p.failed) }) }, // the same words on Today and the program page (2026.11.20)
    overdue: Boolean(p.status === 'open' && due && today && due < today && total - done - skipped > 0),
  };
}

async function programFor(conn, tenantId, id, lock = false) {
  const p = await one(conn, `SELECT * FROM asset_programs WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!p) throw notFound('Program');
  return p;
}
const mustBeOpen = (p) => { if (p.status !== 'open') throw conflict('This program is closed. Copy it to run it again.'); };

// ---------------------------------------------------------------- Today (lib/today.js): programs due this week and their progress
router.get('/today', todayRoute(async (req) => {
  const t = req.auth.tenantId;
  const today = todayIn(await tzOf(pool, t));
  const week = addDays(today, 7);
  const due = (await rows(pool, `${PROGRAM_SQL} WHERE p.tenant_id = ? AND p.status = 'open' AND p.due_on IS NOT NULL AND p.due_on <= ? ORDER BY p.due_on, p.id`, [t, week]))
    .map((p) => programOut(p, today)).filter((p) => p.progress.todo > 0);
  const cards = due.slice(0, 4).map((p) => card({
    title: p.name.slice(0, 80), count: p.progress.todo,
    text: `${p.progress.words}. ${p.overdue ? `Was due ${fmtDue(p.due_on)}` : `Due ${fmtDue(p.due_on)}`}.`,
    href: `#/assetprograms/${p.id}`,
  }));
  if (due.length > 4) cards.push(card({ title: 'More programs due this week', count: due.length - 4, text: 'Open Programs to see them all', href: '#/assetprograms' }));
  return cards;
}));

// ---------------------------------------------------------------- the list
router.get('/', async (req, res) => {
  const t = req.auth.tenantId;
  const today = todayIn(await tzOf(pool, t));
  const where = ['p.tenant_id = ?']; const params = [t];
  const st = first(req.query.status || 'open');
  if (st === 'open' || st === 'closed') { where.push('p.status = ?'); params.push(st); } else if (st !== 'all') throw bad('Status is open, closed or all');
  if (req.query.mine === '1') { where.push('p.assigned_staff_id = ?'); params.push(req.auth.staffId || 0); }
  const list = await rows(pool, `${PROGRAM_SQL} WHERE ${where.join(' AND ')} ORDER BY p.status = 'closed', p.due_on IS NULL, p.due_on, p.id DESC LIMIT 300`, params);
  res.json({ data: list.map((p) => programOut(p, today)), today, can_manage: ['owner', 'manager'].includes(req.auth.role) });
});

router.post('/', manager, validate(z.object({ ...fields, targets: targetsSchema.optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const out = await tx(async (conn) => {
    await mustExist(conn, 'inspection_templates', t, b.template_id, 'Checklist');
    await mustExist(conn, 'staff', t, b.assigned_staff_id, 'Staff member');
    const targets = await resolveTargets(conn, t, b.targets);
    const [r] = await conn.query('INSERT INTO asset_programs (tenant_id, name, template_id, due_on, assigned_staff_id, crew, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [t, b.name, b.template_id, b.due_on ?? null, b.assigned_staff_id ?? null, b.crew ?? null, b.notes ?? null, req.auth.userId]);
    const added = await addTargets(conn, t, r.insertId, targets);
    await audit(conn, req, 'create', 'asset_programs', r.insertId, { name: b.name, targets: added });
    return { id: r.insertId, targets: added };
  });
  res.status(201).json(out);
});

// ---------------------------------------------------------------- one program
/** The targets with where each is (for the map and "nearest first"), their state, and any failure's work order. */
async function targetsOf(conn, tenantId, programId, org) {
  const list = await rows(conn, `SELECT g.id, g.asset_id, g.map_feature_id, g.status, g.result, g.skip_reason, g.inspection_id, g.work_order_id, g.done_at,
      COALESCE(NULLIF(CONCAT(pe.first_name, ' ', pe.last_name), ' '), u.email, u.username) AS done_by_name,
      f.kind AS f_kind, f.name AS f_name, f.tag AS f_tag, f.geometry AS f_geometry, f.lat AS f_lat, f.lng AS f_lng, f.points AS f_points, f.status AS f_status,
      a.name AS a_name, a.asset_tag AS a_tag, a.kind AS a_kind,
      (SELECT af.lat FROM map_features af WHERE af.tenant_id = g.tenant_id AND af.asset_id = g.asset_id ORDER BY af.id LIMIT 1) AS a_lat,
      (SELECT af.lng FROM map_features af WHERE af.tenant_id = g.tenant_id AND af.asset_id = g.asset_id ORDER BY af.id LIMIT 1) AS a_lng,
      w.title AS wo_title, w.status AS wo_status
    FROM asset_program_targets g
    LEFT JOIN map_features f ON f.tenant_id = g.tenant_id AND f.id = g.map_feature_id
    LEFT JOIN ops_assets a ON a.tenant_id = g.tenant_id AND a.id = g.asset_id
    LEFT JOIN work_orders w ON w.tenant_id = g.tenant_id AND w.id = g.work_order_id
    LEFT JOIN users u ON u.tenant_id = g.tenant_id AND u.id = g.done_by
    LEFT JOIN people pe ON pe.tenant_id = u.tenant_id AND pe.id = u.person_id
    WHERE g.tenant_id = ? AND g.program_id = ? ORDER BY g.id`, [tenantId, programId]);
  const O = require('../lib/ops');
  return list.map((g) => {
    const isFeature = g.map_feature_id !== null;
    const k = isFeature ? (MF.kindOf(g.f_kind) || { label: g.f_kind, system: 'other' }) : null;
    const lat = isFeature ? g.f_lat : g.a_lat; const lng = isFeature ? g.f_lng : g.a_lng;
    return {
      id: Number(g.id), type: isFeature ? 'feature' : 'asset', asset_id: g.asset_id === null ? null : Number(g.asset_id), map_feature_id: isFeature ? Number(g.map_feature_id) : null,
      name: isFeature ? (g.f_name || (g.f_tag ? `${k.label} ${g.f_tag}` : `${k.label} ${g.map_feature_id}`)) : g.a_name,
      tag: isFeature ? g.f_tag : g.a_tag, kind: isFeature ? g.f_kind : g.a_kind,
      kind_label: isFeature ? k.label : (O.ASSET_KINDS.find((x) => x.value === g.a_kind) || { label: g.a_kind }).label,
      system: isFeature ? MF.systemFor(k, org) : null, geometry: isFeature ? g.f_geometry : null,
      points: isFeature && g.f_geometry !== 'point' ? JSON.parse(g.f_points) : null,
      lat: lat === null || lat === undefined ? null : Number(lat), lng: lng === null || lng === undefined ? null : Number(lng),
      status: g.status, result: g.result, skip_reason: g.skip_reason, inspection_id: g.inspection_id === null ? null : Number(g.inspection_id),
      work_order_id: g.work_order_id === null ? null : Number(g.work_order_id), work_order: g.work_order_id ? { id: Number(g.work_order_id), title: g.wo_title, status: g.wo_status } : null,
      done_at: g.done_at, done_by: g.done_by_name || null,
    };
  });
}

router.get('/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const raw = await one(pool, `${PROGRAM_SQL} WHERE p.tenant_id = ? AND p.id = ?`, [t, id]);
  if (!raw) throw notFound('Program');
  const today = todayIn(await tzOf(pool, t));
  const { org } = await require('../lib/modules').stateOf(t);
  const [targets, tpl] = await Promise.all([
    targetsOf(pool, t, id, org),
    one(pool, 'SELECT id, name, items, sets_condition, active FROM inspection_templates WHERE tenant_id = ? AND id = ?', [t, raw.template_id]),
  ]);
  const p = programOut(raw, today);
  res.json({
    ...p, targets,
    template: tpl ? { id: Number(tpl.id), name: tpl.name, items: JSON.parse(tpl.items).map((s) => ({ ...s, rule: CR.ruleText(s) })), sets_condition: Boolean(tpl.sets_condition) } : null,
    failures: targets.filter((g) => g.result === 'fail'),
    systems: MF.SYSTEMS, can_manage: ['owner', 'manager'].includes(req.auth.role),
  });
});

router.patch('/:id', manager, validate(z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])))), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  await tx(async (conn) => {
    const p = await programFor(conn, t, id, true);
    mustBeOpen(p);
    await mustExist(conn, 'inspection_templates', t, b.template_id, 'Checklist');
    await mustExist(conn, 'staff', t, b.assigned_staff_id, 'Staff member');
    const keys = Object.keys(fields).filter((k) => b[k] !== undefined);
    if (!keys.length) throw bad('Nothing to change');
    await conn.query(`UPDATE asset_programs SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => b[k]), t, id]);
    await audit(conn, req, 'update', 'asset_programs', id, keys);
  });
  res.json({ ok: true });
});

router.post('/:id/targets', manager, validate(targetsSchema), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const added = await tx(async (conn) => {
    mustBeOpen(await programFor(conn, t, id, true));
    const targets = await resolveTargets(conn, t, req.body);
    if (!targets.assets.length && !targets.features.length) throw bad('Choose what to add: assets, map items, or a kind of map item');
    const { n } = await one(conn, 'SELECT COUNT(*) AS n FROM asset_program_targets WHERE tenant_id = ? AND program_id = ?', [t, id]);
    if (Number(n) + targets.assets.length + targets.features.length > MAX_TARGETS) throw bad(`A program can hold up to ${MAX_TARGETS} targets. Start another program for the rest.`);
    const a = await addTargets(conn, t, id, targets);
    await audit(conn, req, 'add_targets', 'asset_programs', id, { added: a });
    return a;
  });
  res.status(201).json({ added });
});

router.delete('/:id/targets/:tid', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const tid = paramId(req, 'tid');
  await tx(async (conn) => {
    mustBeOpen(await programFor(conn, t, id, true));
    const g = await one(conn, 'SELECT status FROM asset_program_targets WHERE tenant_id = ? AND program_id = ? AND id = ? FOR UPDATE', [t, id, tid]);
    if (!g) throw notFound('Target');
    if (g.status === 'done') throw conflict('This one has been inspected, so it stays in the program');
    await conn.query('DELETE FROM asset_program_targets WHERE tenant_id = ? AND id = ?', [t, tid]);
    await audit(conn, req, 'remove_target', 'asset_programs', id, { target: tid });
  });
  res.status(204).end();
});

/** The open target inside an open program, locked for the rest of the transaction. */
async function openTarget(conn, tenantId, programId, targetId) {
  const p = await programFor(conn, tenantId, programId, true);
  mustBeOpen(p);
  const g = await one(conn, 'SELECT * FROM asset_program_targets WHERE tenant_id = ? AND program_id = ? AND id = ? FOR UPDATE', [tenantId, programId, targetId]);
  if (!g) throw notFound('Target');
  if (g.status === 'done') throw conflict('This one is already done');
  return { p, g };
}

/** The crew does the inspection for one target. A failure opens a work order (source 'program'); the target is done. */
router.post('/:id/targets/:tid/inspect', validate(z.object({
  template_id: z.number().int().positive().optional(),
  items: z.array(CR.answerSchema).min(1),
  hours: nullable(z.number().min(0).max(9999999)), miles: nullable(z.number().min(0).max(99999999)),
  inspector: nullable(z.string().max(100)), note: nullable(z.string().max(500)),
})), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const tid = paramId(req, 'tid');
  const out = await tx(async (conn) => {
    const { p, g } = await openTarget(conn, t, id, tid);
    const target = await AI.targetOf(conn, t, { assetId: g.asset_id, featureId: g.map_feature_id }, true);
    const r = await AI.record(conn, req, target, { ...req.body, template_id: req.body.template_id || p.template_id }, { programId: id, recordMeter: g.asset_id ? require('./assets').recordMeter : null });
    await conn.query("UPDATE asset_program_targets SET status = 'done', result = ?, skip_reason = NULL, inspection_id = ?, work_order_id = ?, done_at = ?, done_by = ? WHERE tenant_id = ? AND id = ?",
      [r.result, r.id, r.work_order_id, nowIn(await tzOf(conn, t)), req.auth.userId, t, tid]);
    return { ...r, target_id: tid };
  });
  res.status(201).json(out);
});

/** Skipped, with the reason: a valve paved over, a hydrant behind a fence, an outfall under water. */
router.post('/:id/targets/:tid/skip', validate(z.object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(255) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const tid = paramId(req, 'tid');
  await tx(async (conn) => {
    await openTarget(conn, t, id, tid);
    await conn.query("UPDATE asset_program_targets SET status = 'skipped', skip_reason = ?, done_at = ?, done_by = ? WHERE tenant_id = ? AND id = ?", [req.body.reason, nowIn(await tzOf(conn, t)), req.auth.userId, t, tid]);
    await audit(conn, req, 'skip_target', 'asset_programs', id, { target: tid, reason: req.body.reason });
  });
  res.json({ ok: true });
});

/** A skipped target goes back on the list (a manager, when the reason no longer holds). */
router.post('/:id/targets/:tid/reopen', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const tid = paramId(req, 'tid');
  await tx(async (conn) => {
    const { g } = await openTarget(conn, t, id, tid);
    if (g.status !== 'skipped') throw conflict('Only a skipped one can go back on the list');
    await conn.query("UPDATE asset_program_targets SET status = 'todo', skip_reason = NULL, done_at = NULL, done_by = NULL WHERE tenant_id = ? AND id = ?", [t, tid]);
    await audit(conn, req, 'reopen_target', 'asset_programs', id, { target: tid });
  });
  res.json({ ok: true });
});

/**
 * Closes the program. Everything must be done or skipped; skip_rest_reason skips whatever is left with that reason
 * (the end of the season, the rest moved to next year's program).
 */
router.post('/:id/close', manager, validate(z.object({ skip_rest_reason: z.string().trim().min(3, 'Say why the rest are skipped').max(255).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const out = await tx(async (conn) => {
    mustBeOpen(await programFor(conn, t, id, true));
    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM asset_program_targets WHERE tenant_id = ? AND program_id = ? AND status = 'todo'", [t, id]);
    const left = Number(n);
    const at = nowIn(await tzOf(conn, t));
    if (left && !req.body.skip_rest_reason) throw conflict(`${left} ${left === 1 ? 'target is' : 'targets are'} still to do. Do or skip ${left === 1 ? 'it' : 'them'}, or close with a reason to skip the rest.`);
    if (left) await conn.query("UPDATE asset_program_targets SET status = 'skipped', skip_reason = ?, done_at = ?, done_by = ? WHERE tenant_id = ? AND program_id = ? AND status = 'todo'", [req.body.skip_rest_reason, at, req.auth.userId, t, id]);
    await conn.query("UPDATE asset_programs SET status = 'closed', closed_at = ?, closed_by = ? WHERE tenant_id = ? AND id = ?", [at, req.auth.userId, t, id]);
    await audit(conn, req, 'close', 'asset_programs', id, { skipped_at_close: left });
    return { skipped_at_close: left };
  });
  res.json({ ok: true, ...out });
});

/** A new program with the same checklist, crew and targets, every target to do: next year's flushing. */
router.post('/:id/copy', manager, validate(z.object({ name: fields.name, due_on: fields.due_on })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const out = await tx(async (conn) => {
    const p = await programFor(conn, t, id);
    const [r] = await conn.query('INSERT INTO asset_programs (tenant_id, name, template_id, due_on, assigned_staff_id, crew, notes, copied_from, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, req.body.name, p.template_id, req.body.due_on ?? null, p.assigned_staff_id, p.crew, p.notes, id, req.auth.userId]);
    // Retired assets and abandoned map items are left behind.
    const [a] = await conn.query(`INSERT INTO asset_program_targets (tenant_id, program_id, asset_id, map_feature_id)
      SELECT g.tenant_id, ?, g.asset_id, g.map_feature_id FROM asset_program_targets g
        LEFT JOIN ops_assets a ON a.tenant_id = g.tenant_id AND a.id = g.asset_id
        LEFT JOIN map_features f ON f.tenant_id = g.tenant_id AND f.id = g.map_feature_id
      WHERE g.tenant_id = ? AND g.program_id = ? AND (g.asset_id IS NULL OR a.status <> 'retired') AND (g.map_feature_id IS NULL OR (f.id IS NOT NULL AND f.status <> 'abandoned'))
      ORDER BY g.id`, [r.insertId, t, id]);
    await audit(conn, req, 'copy', 'asset_programs', r.insertId, { from: id, targets: a.affectedRows });
    return { id: r.insertId, targets: a.affectedRows };
  });
  res.status(201).json(out);
});

/** The program's progress as a spreadsheet: each target, its state, result, reason and work order. No resident data. */
router.get('/:id/export.csv', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const p = await programFor(pool, t, id);
  const { org } = await require('../lib/modules').stateOf(t);
  const list = await targetsOf(pool, t, id, org);
  // Coordinates and readings stay numbers; only text that starts like a formula is defused (lib/csv.js).
  const esc = (v) => { const x = require('../lib/csv').defuse(v === null || v === undefined ? '' : String(v)); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const head = ['Tag', 'Name', 'Kind', 'Latitude', 'Longitude', 'State', 'Result', 'Skipped because', 'Done', 'By', 'Work order'];
  const body = list.map((g) => [g.tag, g.name, g.kind_label, g.lat, g.lng, { todo: 'To do', done: 'Done', skipped: 'Skipped' }[g.status], g.result, g.skip_reason, g.done_at ? String(g.done_at instanceof Date ? g.done_at.toISOString() : g.done_at).slice(0, 16).replace('T', ' ') : '', g.done_by, g.work_order_id].map(esc).join(','));
  await audit(pool, req, 'export', 'asset_programs', id, { rows: list.length });
  const file = String(p.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || `program-${id}`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}.csv"` }).send([head.join(','), ...body].join('\n'));
});

module.exports = router;
