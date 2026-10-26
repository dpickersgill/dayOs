'use strict';

// Patrol kits (mounted under /patrol): trauma bags, packed toboggans and lift evacuation kits. Each kind of kit has its
// contents and how often it is checked (set by the patrol); each kit has a number, a place and a QR label. A check marks
// what is there and when it expires; a restock fills it; supplies used on a case come off it and it needs a restock.
// With seals on (Patrol settings), a kit whose seal number is unchanged is signed off in one tap. Checks can be made with
// no signal: they wait on the phone and the client_ref keeps a second send from counting twice.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, dateTimeStr, normDateTime, nowIn, todayIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const OPS = require('../lib/patrolops');
const K = require('../lib/patrolkits');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const manage = PA.needs(pool, 'manage_equipment', 'Only those who manage patrol equipment can change kits');
const clock = async (db, t) => { const tz = (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone; return { now: nowIn(tz), today: todayIn(tz) }; };
const typeShape = (r) => ({ id: Number(r.id), name: r.name, prefix: r.prefix, every_days: Number(r.every_days), contents: K.parse(r.contents, []), active: Boolean(Number(r.active)) });

async function kitList(db, t, today) {
  const types = (await rows(db, 'SELECT * FROM patrol_kit_types WHERE tenant_id = ? ORDER BY active DESC, name', [t])).map(typeShape);
  const kits = await rows(db, `SELECT k.*, st.name AS station, l.name AS lift FROM patrol_kits k LEFT JOIN patrol_stations st ON st.tenant_id = k.tenant_id AND st.id = k.station_id
    LEFT JOIN lifts l ON l.tenant_id = k.tenant_id AND l.id = k.lift_id WHERE k.tenant_id = ? AND k.active = 1 ORDER BY k.label`, [t]);
  const byType = new Map(types.map((x) => [x.id, x]));
  return {
    types,
    kits: kits.map((k) => {
      const type = byType.get(Number(k.type_id)) || { every_days: 7, contents: [] };
      return {
        id: Number(k.id), type_id: Number(k.type_id), type: type.name, label: k.label, location: k.location, station_id: k.station_id ? Number(k.station_id) : null, station: k.station,
        lift_id: k.lift_id ? Number(k.lift_id) : null, lift: k.lift, status: k.status, sealed: Boolean(Number(k.sealed)), seal_no: k.seal_no, stock: K.parse(k.stock, {}),
        earliest_expiry: k.earliest_expiry ? String(k.earliest_expiry).slice(0, 10) : null, last_check_at: k.last_check_at, standing: K.standing(k, type, today),
      };
    }),
  };
}

/** The board: every kit and where it stands, the kinds of kit, and (with none yet) the starting lists to choose from. */
router.get('/kits', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { today } = await clock(pool, t);
  const out = await kitList(pool, t, today);
  const ops = await OPS.settingsOf(pool, t);
  res.json({ ...out, today, seals: ops.kit_seals, can_manage: await PA.can(pool, req, 'manage_equipment'), starters: out.types.length ? [] : K.STARTERS.map((s) => ({ name: s.name, prefix: s.prefix, every_days: s.every_days, count: s.contents.length })) });
});

const item = z.object({ key: z.string().regex(/^[a-z0-9_]{1,30}$/), label: z.string().trim().min(1).max(80), qty: z.number().int().min(1).max(500), expires: z.boolean().default(false) });
const typeFields = { name: z.string().trim().min(1).max(80), prefix: z.string().trim().regex(/^[A-Za-z]{1,8}$/, 'Letters only, up to 8').transform((s) => s.toUpperCase()), every_days: z.number().int().min(1).max(365), contents: z.array(item).min(1).max(60) };
const uniqueKeys = (contents) => { if (new Set(contents.map((c) => c.key)).size !== contents.length) throw bad('Each item needs its own name'); };

/** Start from the suggested lists (any of them), to adjust afterwards. */
router.post('/kits/types/starter', patrol, manage, validate(z.object({ names: z.array(z.string()).min(1).max(3) })), async (req, res) => {
  const t = req.auth.tenantId;
  const picks = K.STARTERS.filter((s) => req.body.names.includes(s.name));
  if (!picks.length) throw bad('Choose a starting list');
  for (const s of picks) {
    if (await one(pool, 'SELECT id FROM patrol_kit_types WHERE tenant_id = ? AND name = ?', [t, s.name])) continue;
    await pool.query('INSERT INTO patrol_kit_types (tenant_id, name, prefix, every_days, contents) VALUES (?, ?, ?, ?, ?)', [t, s.name, s.prefix, s.every_days, JSON.stringify(s.contents)]);
  }
  await audit(pool, req, 'kit_starters', 'patrol_kit_types', null, { names: picks.map((s) => s.name) });
  res.status(201).json({ ok: true });
});

router.post('/kits/types', patrol, manage, validate(z.object(typeFields)), async (req, res) => {
  uniqueKeys(req.body.contents);
  const [r] = await pool.query('INSERT INTO patrol_kit_types (tenant_id, name, prefix, every_days, contents) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, req.body.name, req.body.prefix, req.body.every_days, JSON.stringify(req.body.contents)]);
  await audit(pool, req, 'create', 'patrol_kit_types', r.insertId);
  res.status(201).json({ id: r.insertId });
});

router.patch('/kits/types/:id', patrol, manage, validate(z.object({ ...typeFields, active: z.boolean() }).partial()), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  if (b.contents) uniqueKeys(b.contents);
  const keys = Object.keys(b);
  if (!keys.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE patrol_kit_types SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => (k === 'contents' ? JSON.stringify(b[k]) : typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k])), t, paramId(req)]);
  if (!r.affectedRows) throw notFound('Kind of kit');
  await audit(pool, req, 'update', 'patrol_kit_types', paramId(req), { fields: keys });
  res.json({ ok: true });
});

const kitFields = { location: z.string().trim().max(120).nullable().optional(), station_id: z.number().int().positive().nullable().optional(), lift_id: z.number().int().positive().nullable().optional() };
async function checkPlace(db, t, b) {
  if (b.station_id && !(await one(db, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, b.station_id]))) throw notFound('Station');
  if (b.lift_id && !(await one(db, 'SELECT id FROM lifts WHERE tenant_id = ? AND id = ?', [t, b.lift_id]))) throw notFound('Lift');
}

/** Add kits of one kind: numbered from its prefix (TB-1, TB-2). A new kit needs a full check before it shows ready. */
router.post('/kits', patrol, manage, validate(z.object({ type_id: z.number().int().positive(), count: z.number().int().min(1).max(50).default(1), ...kitFields })), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  await checkPlace(pool, t, b);
  const made = await tx(async (conn) => {
    const type = await one(conn, 'SELECT * FROM patrol_kit_types WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, b.type_id]);
    if (!type) throw notFound('Kind of kit');
    const used = new Set((await rows(conn, 'SELECT label FROM patrol_kits WHERE tenant_id = ?', [t])).map((r) => r.label));
    const out = [];
    for (let n = 1; out.length < b.count && n < 1000; n += 1) {
      const label = `${type.prefix}-${n}`;
      if (used.has(label)) continue;
      const [r] = await conn.query('INSERT INTO patrol_kits (tenant_id, type_id, label, location, station_id, lift_id) VALUES (?, ?, ?, ?, ?, ?)', [t, type.id, label, b.location || null, b.station_id || null, b.lift_id || null]);
      out.push({ id: r.insertId, label });
    }
    await audit(conn, req, 'create', 'patrol_kits', null, { labels: out.map((x) => x.label) });
    return out;
  });
  res.status(201).json({ data: made });
});

router.patch('/kits/:id', patrol, manage, validate(z.object({ ...kitFields, out_of_service: z.boolean().optional(), active: z.boolean().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  await checkPlace(pool, t, b);
  const sets = []; const vals = [];
  for (const k of ['location', 'station_id', 'lift_id']) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k] || null); }
  if (b.out_of_service !== undefined) { sets.push('status = ?'); vals.push(b.out_of_service ? 'out_of_service' : 'not_ready'); }
  if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
  if (!sets.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE patrol_kits SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t, paramId(req)]);
  if (!r.affectedRows) throw notFound('Kit');
  await audit(pool, req, 'update', 'patrol_kits', paramId(req), b);
  res.json({ ok: true });
});

/** One kit with its kind's contents and its last checks. */
router.get('/kits/:id', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { today } = await clock(pool, t);
  const all = await kitList(pool, t, today);
  const kit = all.kits.find((k) => k.id === paramId(req));
  if (!kit) throw notFound('Kit');
  const checks = await rows(pool, `SELECT c.id, c.kind, c.result, c.items, c.seal_no, c.note, c.incident_id, c.done_at, COALESCE(u.email, u.username) AS done_by,
      CONCAT(i.season, '-', LPAD(i.seq, 4, '0')) AS case_number FROM patrol_kit_checks c LEFT JOIN users u ON u.id = c.done_by AND u.tenant_id = c.tenant_id
      LEFT JOIN incidents i ON i.tenant_id = c.tenant_id AND i.id = c.incident_id WHERE c.tenant_id = ? AND c.kit_id = ? ORDER BY c.done_at DESC, c.id DESC LIMIT 30`, [t, kit.id]);
  res.json({ kit, type: all.types.find((x) => x.id === kit.type_id), checks: checks.map((c) => ({ ...c, items: K.parse(c.items, {}) })), seals: (await OPS.settingsOf(pool, t)).kit_seals, today });
});

const stockItem = z.object({ qty: z.number().int().min(0).max(500), expires_on: dateStr.nullable().optional() });
/**
 * Record a check (full), a seal sign-off (seal), a restock, or supplies used on a case (use). The kit's state and stock
 * follow from it. Every patroller can do these.
 */
router.post('/kits/:id/checks', patrol, validate(z.object({
  kind: z.enum(['full', 'seal', 'restock', 'use']),
  items: z.record(z.string(), stockItem).optional(),
  used: z.record(z.string(), z.number().int().min(1).max(500)).optional(),
  seal_no: z.string().trim().max(30).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  incident_id: z.number().int().positive().nullable().optional(),
  at: dateTimeStr.transform(normDateTime).optional(),
  client_ref: z.string().regex(/^[a-z0-9]{6,40}$/).optional(),
})), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  const out = await tx(async (conn) => {
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT id, result FROM patrol_kit_checks WHERE tenant_id = ? AND client_ref = ?', [t, b.client_ref]);
      if (seen) return { id: Number(seen.id), result: seen.result };
    }
    const kit = await one(conn, 'SELECT * FROM patrol_kits WHERE tenant_id = ? AND id = ? AND active = 1 FOR UPDATE', [t, paramId(req)]);
    if (!kit) throw notFound('Kit');
    const type = typeShape(await one(conn, 'SELECT * FROM patrol_kit_types WHERE id = ?', [kit.type_id]));
    const { now, today } = await clock(conn, t);
    // A check made with no signal keeps the time it was made (up to three days back).
    const at = b.at && b.at <= now && b.at >= `${new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10)} 00:00:00` ? b.at : now;
    const seals = (await OPS.settingsOf(conn, t)).kit_seals;
    let result; let stock = K.parse(kit.stock, {}); let earliest = kit.earliest_expiry ? String(kit.earliest_expiry).slice(0, 10) : null;
    let sealed = Number(kit.sealed); let sealNo = kit.seal_no; let status;
    let items = b.items || null;
    if (b.kind === 'use') {
      if (!b.used || !Object.keys(b.used).length) throw bad('Say what was used');
      if (b.incident_id && !(await one(conn, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [t, b.incident_id]))) throw notFound('Case');
      stock = K.afterUse(stock, b.used); items = b.used;
      result = 'needs_restock'; status = 'needs_restock'; sealed = 0;
    } else if (b.kind === 'seal') {
      if (!seals) throw conflict('Seals are not used here. Do a full check.');
      if (!sealed || !kit.seal_no) throw conflict('This kit has no seal on record. Do a full check and seal it.');
      if (String(b.seal_no || '').trim() !== kit.seal_no) throw conflict('The seal number is different, so the kit may have been opened. Do a full check.');
      const expired = earliest && earliest < today;
      result = expired ? 'not_ready' : 'ready'; status = result;
    } else {
      if (!items) throw bad('Say what is in the kit');
      // A restock fills every item; dates given for items that expire are kept, others stay as they were.
      if (b.kind === 'restock') items = Object.fromEntries(type.contents.map((c) => [c.key, { qty: Math.max(c.qty, Number((items[c.key] || {}).qty || 0)), expires_on: (items[c.key] || {}).expires_on ?? (stock[c.key] || {}).expires_on ?? null }]));
      const ev = K.evaluate(type.contents, items, today);
      result = ev.result; status = ev.result; stock = ev.stock; earliest = ev.earliest;
      if (seals && b.seal_no) { sealed = 1; sealNo = b.seal_no; } else { sealed = 0; sealNo = null; }
    }
    const [r] = await conn.query('INSERT INTO patrol_kit_checks (tenant_id, kit_id, kind, result, items, seal_no, note, incident_id, done_by, done_at, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, kit.id, b.kind, result, items ? JSON.stringify(items) : null, b.seal_no || null, b.note || null, b.incident_id || null, req.auth.userId, at, b.client_ref || null]);
    const checked = b.kind === 'use' ? kit.last_check_at : at;
    await conn.query('UPDATE patrol_kits SET status = ?, stock = ?, earliest_expiry = ?, sealed = ?, seal_no = ?, last_check_at = ? WHERE tenant_id = ? AND id = ?',
      [kit.status === 'out_of_service' && b.kind !== 'restock' && b.kind !== 'full' ? 'out_of_service' : status, JSON.stringify(stock), earliest, sealed, sealNo, checked, t, kit.id]);
    await audit(conn, req, `kit_${b.kind}`, 'patrol_kits', kit.id, { result, incident_id: b.incident_id || null });
    return { id: r.insertId, result };
  });
  res.status(201).json(out);
});

/** Supplies used from kits on one case, for the case's report. */
router.get('/incidents/:id/kit-use', patrol, async (req, res) => {
  const list = await rows(pool, `SELECT c.id, c.kit_id, k.label, c.items, c.done_at, t.contents FROM patrol_kit_checks c JOIN patrol_kits k ON k.tenant_id = c.tenant_id AND k.id = c.kit_id
    JOIN patrol_kit_types t ON t.id = k.type_id WHERE c.tenant_id = ? AND c.incident_id = ? AND c.kind = 'use' ORDER BY c.done_at`, [req.auth.tenantId, paramId(req)]);
  res.json({ data: list.map((x) => {
    const names = Object.fromEntries(K.parse(x.contents, []).map((c) => [c.key, c.label]));
    const items = K.parse(x.items, {});
    return { id: Number(x.id), kit_id: Number(x.kit_id), label: x.label, done_at: x.done_at, items, lines: Object.entries(items).map(([key, n]) => ({ key, label: names[key] || key, qty: Number(n) })) };
  }) });
});

module.exports = { router };
