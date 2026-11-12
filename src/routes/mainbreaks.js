'use strict';

// Main breaks (release 2026.11.20, the Water add-on). Mounted at /api/v1/water next to the Water Today cards.
//   GET    /mains                    the water mains on the map, with their breaks in the last 5 years and in all
//   GET    /main-breaks              the breaks, newest first (?main_id=, ?year=, ?status=open|repaired)
//   GET    /main-breaks/valves       the valves to shut for a break: the mapped valves within 150 m of the break, those
//                                    along the same main or street first (?main_id=, ?lat=&lng=)
//   POST   /main-breaks              a new break: opens an urgent work order on the main (its costs are the work order's)
//   GET    /main-breaks/:id          one break, with the valves operated and its work order and notice
//   PATCH  /main-breaks/:id          change it: the repair, water back on, valves, customers out, boil water and its notice
//   DELETE /main-breaks/:id          a break entered by mistake (managers); its work order stays
//   GET    /main-breaks/export.csv   every break as a spreadsheet (a public record: no resident is named on a break)
// A main's breaks feed its condition: more than 2 breaks in 5 years raises its condition to at least 4 (Poor), so its
// risk shows it. A person can lower it again on the map; the next break raises it again.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateTimeStr, normDateTime, nowIn, addDays } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const MF = require('../lib/mapfeatures');

const router = express.Router();
const crew = requireRole('staff', 'manager');
const manager = requireRole('manager');

const MAIN_KINDS = ['potable_line'];
const VALVE_KINDS = ['valve'];
const NEAR_M = 150;
const ON_MAIN_M = 15;
const BREAKS_RAISE = 2; // more than this many in 5 years
const RAISED_TO = 4;
const CAUSES = [['age', 'Age and wear'], ['corrosion', 'Corrosion'], ['frost', 'Frost or a freeze-thaw'], ['ground_movement', 'Ground movement or settling'], ['pressure', 'Pressure surge or water hammer'],
  ['joint', 'Joint failure'], ['third_party', 'Hit by a contractor or another utility'], ['unknown', 'Not known yet'], ['other', 'Other']].map(([value, label]) => ({ value, label }));
const CAUSE_KEYS = CAUSES.map((c) => c.value);
const CAUSE_WORDS = Object.fromEntries(CAUSES.map((c) => [c.value, c.label]));

const tzOf = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const stamp = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v ? String(v).slice(0, 19).replace('T', ' ') : null);

/** Distance in meters from point p to the polyline pts (flat-earth, fine across a borough). */
function toLine(p, pts) {
  if (!pts || !pts.length) return Infinity;
  if (pts.length === 1) return MF.distance(p, pts[0]);
  const lat0 = (p[0] * Math.PI) / 180; const R = 6371008.8;
  const xy = (q) => [((q[1] * Math.PI) / 180) * R * Math.cos(lat0), ((q[0] * Math.PI) / 180) * R];
  const P = xy(p); let best = Infinity;
  for (let i = 1; i < pts.length; i += 1) {
    const A = xy(pts[i - 1]); const B = xy(pts[i]);
    const dx = B[0] - A[0]; const dy = B[1] - A[1]; const len = dx * dx + dy * dy;
    const k = len ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(P[0] - (A[0] + k * dx), P[1] - (A[1] + k * dy)));
  }
  return best;
}

async function mainOf(db, t, id) {
  const f = await one(db, 'SELECT id, kind, name, tag, points, lat, lng, size, material, street_id, condition_score FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!f) throw notFound('Water main');
  if (!MAIN_KINDS.includes(f.kind)) throw bad('Pick a water main (a drinking water line on the map)');
  return { ...f, points: JSON.parse(f.points) };
}
async function checkStreet(db, t, id) { if (id && !(await one(db, 'SELECT id FROM streets WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Street'); }
async function checkNotice(db, t, id) { if (id && !(await one(db, 'SELECT id FROM street_notices WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Street notice'); }
async function checkValves(db, t, list) {
  const ids = [...new Set(list.map((v) => v.valve_id))];
  if (!ids.length) return;
  const found = await rows(db, 'SELECT id, kind FROM map_features WHERE tenant_id = ? AND id IN (?)', [t, ids]);
  if (found.length !== ids.length) throw notFound('Valve');
  if (found.some((f) => !VALVE_KINDS.includes(f.kind))) throw bad('Only valves can be listed as operated');
}

/** Breaks on a main in the 5 years up to `at` (a local 'YYYY-MM-DD HH:MM:SS'). */
const breaksIn5 = async (db, t, mainId, at) => Number((await one(db, 'SELECT COUNT(*) AS n FROM main_breaks WHERE tenant_id = ? AND main_id = ? AND broke_at > ? AND broke_at <= ?', [t, mainId, `${addDays(String(at).slice(0, 10), -1826)} 00:00:00`, at])).n);

/**
 * More than 2 breaks in the last 5 years (counted up to now, so a break entered late counts too): the main's condition is
 * raised to at least Poor. Returns the new score, or null.
 */
async function raiseCondition(conn, req, mainId) {
  const t = req.auth.tenantId;
  const n = await breaksIn5(conn, t, mainId, nowIn(await tzOf(t)));
  if (n <= BREAKS_RAISE) return null;
  const [r] = await conn.query('UPDATE map_features SET condition_score = ? WHERE tenant_id = ? AND id = ? AND (condition_score IS NULL OR condition_score < ?)', [RAISED_TO, t, mainId, RAISED_TO]);
  if (!r.affectedRows) return null;
  await audit(conn, req, 'condition', 'map_features', mainId, { condition_score: RAISED_TO, why: `${n} breaks in 5 years` });
  return RAISED_TO;
}

const LIST_SQL = `SELECT b.*, f.name AS main_name, f.tag AS main_tag, st.name AS street_name, w.status AS work_order_status, n.code AS notice_code, n.title AS notice_title, n.status AS notice_status,
    (SELECT COUNT(*) FROM main_break_valves v WHERE v.tenant_id = b.tenant_id AND v.break_id = b.id) AS valves
  FROM main_breaks b LEFT JOIN map_features f ON f.tenant_id = b.tenant_id AND f.id = b.main_id LEFT JOIN streets st ON st.tenant_id = b.tenant_id AND st.id = b.street_id
  LEFT JOIN work_orders w ON w.tenant_id = b.tenant_id AND w.id = b.work_order_id LEFT JOIN street_notices n ON n.tenant_id = b.tenant_id AND n.id = b.notice_id`;
const shape = (b) => ({
  id: Number(b.id), main_id: num(b.main_id), main: b.main_name || (b.main_tag ? `Main ${b.main_tag}` : null), main_tag: b.main_tag || null, street_id: num(b.street_id), street: b.street_name || null,
  location: b.location, lat: num(b.lat), lng: num(b.lng), broke_at: stamp(b.broke_at), cause: b.cause, cause_words: CAUSE_WORDS[b.cause], pipe_material: b.pipe_material, pipe_size: b.pipe_size,
  customers_out: num(b.customers_out), boil_water: Boolean(b.boil_water), notice_id: num(b.notice_id), notice: b.notice_code ? { id: num(b.notice_id), code: b.notice_code, title: b.notice_title, status: b.notice_status } : null,
  work_order_id: num(b.work_order_id), work_order_status: b.work_order_status || null, water_off_at: stamp(b.water_off_at), water_on_at: stamp(b.water_on_at), repair: b.repair, repaired_at: stamp(b.repaired_at),
  status: b.status, notes: b.notes, valves: b.valves === undefined ? undefined : Number(b.valves),
  hours_out: b.water_off_at && b.water_on_at ? Math.round(((Date.parse(`${stamp(b.water_on_at).replace(' ', 'T')}Z`) - Date.parse(`${stamp(b.water_off_at).replace(' ', 'T')}Z`)) / 3600000) * 10) / 10 : null,
});

router.use(crew);

router.get('/mains', async (req, res) => {
  const t = req.auth.tenantId;
  const since = `${addDays((nowIn(await tzOf(t))).slice(0, 10), -1826)} 00:00:00`;
  const list = await rows(pool, `SELECT f.id, f.name, f.tag, f.size, f.material, f.installed_year, f.condition_score, f.criticality, f.street_id, st.name AS street_name,
      (SELECT COUNT(*) FROM main_breaks b WHERE b.tenant_id = f.tenant_id AND b.main_id = f.id) AS breaks,
      (SELECT COUNT(*) FROM main_breaks b WHERE b.tenant_id = f.tenant_id AND b.main_id = f.id AND b.broke_at > ?) AS breaks_5y,
      (SELECT MAX(b.broke_at) FROM main_breaks b WHERE b.tenant_id = f.tenant_id AND b.main_id = f.id) AS last_break
    FROM map_features f LEFT JOIN streets st ON st.tenant_id = f.tenant_id AND st.id = f.street_id
    WHERE f.tenant_id = ? AND f.kind IN (?) AND f.status <> 'abandoned' ORDER BY breaks_5y DESC, f.name, f.tag`, [since, t, MAIN_KINDS]);
  res.json({ data: list.map((f) => ({ id: Number(f.id), name: f.name || (f.tag ? `Main ${f.tag}` : `Main ${f.id}`), tag: f.tag, size: f.size, material: f.material, installed_year: num(f.installed_year),
    street_id: num(f.street_id), street: f.street_name || null, condition_score: num(f.condition_score), criticality: num(f.criticality), risk: MF.riskOf(f.condition_score, f.criticality),
    breaks: Number(f.breaks), breaks_5y: Number(f.breaks_5y), last_break: stamp(f.last_break) })), causes: CAUSES, rule: `More than ${BREAKS_RAISE} breaks in 5 years raises a main's condition to at least ${RAISED_TO} (Poor).` });
});

router.get('/main-breaks', async (req, res) => {
  const t = req.auth.tenantId;
  const where = ['b.tenant_id = ?']; const params = [t];
  const mainId = Number(req.query.main_id);
  if (Number.isInteger(mainId) && mainId > 0) { where.push('b.main_id = ?'); params.push(mainId); }
  const year = Number(req.query.year);
  if (Number.isInteger(year) && year > 1900 && year < 2200) { where.push('b.broke_at >= ? AND b.broke_at < ?'); params.push(`${year}-01-01`, `${year + 1}-01-01`); }
  if (['open', 'repaired'].includes(String(req.query.status))) { where.push('b.status = ?'); params.push(String(req.query.status)); }
  res.json({ data: (await rows(pool, `${LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY b.broke_at DESC, b.id DESC LIMIT 500`, params)).map(shape), causes: CAUSES });
});

/**
 * The valves to shut: every mapped valve within 150 m of the break, those on the main's line (within 15 m) or on the same
 * street first, then nearest first. Without a break point the main's middle is used. Also the number of water customers
 * on the break's street (the service address list), as a starting point for customers out.
 */
router.get('/main-breaks/valves', async (req, res) => {
  const t = req.auth.tenantId;
  const mainId = Number(req.query.main_id);
  const main = Number.isInteger(mainId) && mainId > 0 ? await mainOf(pool, t, mainId) : null;
  const lat = Number(req.query.lat); const lng = Number(req.query.lng);
  const point = Number.isFinite(lat) && Number.isFinite(lng) && req.query.lat !== undefined && req.query.lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng]
    : main ? [Number(main.lat), Number(main.lng)] : null;
  if (!point) throw bad('Pick the main or put the break on the map');
  const streetId = Number(req.query.street_id) || (main && main.street_id) || null;
  const box = 0.002; // about 200 m, then the exact distance
  const list = await rows(pool, `SELECT f.id, f.tag, f.name, f.lat, f.lng, f.size, f.status, f.street_id, st.name AS street_name, f.condition_score
    FROM map_features f LEFT JOIN streets st ON st.tenant_id = f.tenant_id AND st.id = f.street_id
    WHERE f.tenant_id = ? AND f.kind IN (?) AND f.status <> 'abandoned' AND f.lat BETWEEN ? AND ? AND f.lng BETWEEN ? AND ?`, [t, VALVE_KINDS, point[0] - box, point[0] + box, point[1] - box * 1.4, point[1] + box * 1.4]);
  const out = list.map((v) => {
    const p = [Number(v.lat), Number(v.lng)];
    const d = MF.distance(point, p);
    const onMain = main ? toLine(p, main.points) <= ON_MAIN_M : false;
    return { id: Number(v.id), tag: v.tag, name: v.name, lat: p[0], lng: p[1], size: v.size, status: v.status, street: v.street_name || null, condition_score: num(v.condition_score),
      distance_m: Math.round(d), on_main: onMain, same_street: Boolean(streetId && Number(v.street_id) === Number(streetId)) };
  }).filter((v) => v.distance_m <= NEAR_M)
    .sort((a, b) => Number(b.on_main || b.same_street) - Number(a.on_main || a.same_street) || a.distance_m - b.distance_m);
  const customers = streetId ? Number((await one(pool, 'SELECT COUNT(*) AS n FROM service_addresses WHERE tenant_id = ? AND street_id = ? AND active = 1', [t, streetId])).n) : null;
  res.json({ point, within_m: NEAR_M, valves: out, customers_on_street: customers });
});

router.get('/main-breaks/export.csv', async (req, res) => {
  const list = (await rows(pool, `${LIST_SQL} WHERE b.tenant_id = ? ORDER BY b.broke_at`, [req.auth.tenantId])).map(shape);
  await audit(pool, req, 'export', 'main_breaks', null, { rows: list.length });
  const cols = ['broke_at', 'main', 'main_tag', 'street', 'location', 'cause', 'pipe_material', 'pipe_size', 'customers_out', 'water_off_at', 'water_on_at', 'hours_out', 'boil_water', 'notice', 'valves_operated', 'repair', 'repaired_at', 'status', 'work_order'];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="main-breaks.csv"' }).send(toCsv(cols, list.map((b) => ({
    ...b, cause: b.cause_words, boil_water: b.boil_water ? 'yes' : 'no', notice: b.notice ? b.notice.code : '', valves_operated: b.valves, work_order: b.work_order_id || '',
  }))));
});

const valveSchema = z.object({ valve_id: z.number().int().positive(), closed_at: dateTimeStr.nullable().optional(), opened_at: dateTimeStr.nullable().optional(), turns: z.number().min(0).max(999).nullable().optional(), note: z.string().trim().max(255).nullable().optional() });
const fields = {
  main_id: z.number().int().positive(),
  broke_at: dateTimeStr,
  street_id: z.number().int().positive().nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  cause: z.enum(CAUSE_KEYS).optional(),
  pipe_material: z.string().trim().max(40).nullable().optional(),
  pipe_size: z.string().trim().max(40).nullable().optional(),
  customers_out: z.number().int().min(0).max(1000000).nullable().optional(),
  boil_water: z.boolean().optional(),
  notice_id: z.number().int().positive().nullable().optional(),
  water_off_at: dateTimeStr.nullable().optional(),
  water_on_at: dateTimeStr.nullable().optional(),
  repair: z.string().trim().max(1000).nullable().optional(),
  repaired_at: dateTimeStr.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  valves: z.array(valveSchema).max(40).optional(),
};
const dt = (v) => (v ? normDateTime(v) : v === null ? null : undefined);

async function writeValves(conn, t, breakId, list) {
  await conn.query('DELETE FROM main_break_valves WHERE tenant_id = ? AND break_id = ?', [t, breakId]);
  const seen = new Set();
  for (const v of list) {
    if (seen.has(v.valve_id)) continue;
    seen.add(v.valve_id);
    await conn.query('INSERT INTO main_break_valves (tenant_id, break_id, valve_id, closed_at, opened_at, turns, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [t, breakId, v.valve_id, dt(v.closed_at) ?? null, dt(v.opened_at) ?? null, v.turns ?? null, v.note || null]);
  }
}

router.post('/main-breaks', validate(z.object({ ...fields, work_order: z.boolean().optional(), assigned_staff_id: z.number().int().positive().nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const brokeAt = normDateTime(b.broke_at);
  if (brokeAt > `${addDays(nowIn(await tzOf(t)).slice(0, 10), 1)} 00:00:00`) throw bad('That time is in the future');
  const out = await tx(async (conn) => {
    const main = await mainOf(conn, t, b.main_id);
    await checkStreet(conn, t, b.street_id);
    await checkNotice(conn, t, b.notice_id);
    await checkValves(conn, t, b.valves || []);
    const streetId = b.street_id ?? (main.street_id ? Number(main.street_id) : null);
    const street = streetId ? await one(conn, 'SELECT name FROM streets WHERE tenant_id = ? AND id = ?', [t, streetId]) : null;
    const [r] = await conn.query(`INSERT INTO main_breaks (tenant_id, main_id, street_id, location, lat, lng, broke_at, cause, pipe_material, pipe_size, customers_out, boil_water, notice_id, water_off_at, water_on_at, repair, repaired_at, status, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t, main.id, streetId, b.location || null, b.lat ?? null, b.lng ?? null, brokeAt, b.cause || 'unknown', b.pipe_material || main.material || null, b.pipe_size || main.size || null,
      b.customers_out ?? null, b.boil_water ? 1 : 0, b.notice_id || null, dt(b.water_off_at) ?? null, dt(b.water_on_at) ?? null, b.repair || null, dt(b.repaired_at) ?? null,
      b.repaired_at ? 'repaired' : 'open', b.notes || null, req.auth.userId || null]);
    const id = r.insertId;
    await writeValves(conn, t, id, b.valves || []);
    let woId = null;
    if (b.work_order !== false) {
      const label = main.name || (main.tag ? `main ${main.tag}` : 'water main');
      woId = await require('./maintenance').createOrder(conn, req, {
        title: `Main break: ${label}${b.location ? `, ${b.location}` : ''}`.slice(0, 150), priority: 'urgent', map_feature_id: main.id, assigned_staff_id: b.assigned_staff_id || null,
        location: (b.location || (street ? street.name : null) || null)?.slice(0, 120) || null,
        description: [`Water main break recorded ${brokeAt.slice(0, 16)}.`, b.notes || null, 'Record the crew, equipment and materials on this work order: they are the cost of the break.'].filter(Boolean).join('\n'),
      });
      await conn.query('UPDATE main_breaks SET work_order_id = ? WHERE tenant_id = ? AND id = ?', [woId, t, id]);
    }
    const raised = await raiseCondition(conn, req, main.id);
    await audit(conn, req, 'create', 'main_breaks', id, { main_id: Number(main.id), work_order_id: woId, valves: (b.valves || []).length, boil_water: Boolean(b.boil_water), ...(raised ? { condition_raised: raised } : {}) });
    return { id, work_order_id: woId, condition_raised: raised };
  });
  const row = await one(pool, `${LIST_SQL} WHERE b.tenant_id = ? AND b.id = ?`, [t, out.id]);
  res.status(201).json({ ...shape(row), condition_raised: out.condition_raised });
});

router.get('/main-breaks/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const b = await one(pool, `${LIST_SQL} WHERE b.tenant_id = ? AND b.id = ?`, [t, id]);
  if (!b) throw notFound('Main break');
  const valves = await rows(pool, `SELECT v.valve_id, v.closed_at, v.opened_at, v.turns, v.note, f.tag, f.name, f.lat, f.lng FROM main_break_valves v
    LEFT JOIN map_features f ON f.tenant_id = v.tenant_id AND f.id = v.valve_id WHERE v.tenant_id = ? AND v.break_id = ? ORDER BY v.id`, [t, id]);
  const history = b.main_id ? (await rows(pool, `${LIST_SQL} WHERE b.tenant_id = ? AND b.main_id = ? ORDER BY b.broke_at DESC LIMIT 50`, [t, b.main_id])).map(shape) : [];
  res.json({ ...shape(b), valve_list: valves.map((v) => ({ valve_id: Number(v.valve_id), tag: v.tag, name: v.name, lat: num(v.lat), lng: num(v.lng), closed_at: stamp(v.closed_at), opened_at: stamp(v.opened_at), turns: num(v.turns), note: v.note })),
    history, breaks_5y: b.main_id ? await breaksIn5(pool, t, b.main_id, nowIn(await tzOf(t))) : null, causes: CAUSES });
});

router.patch('/main-breaks/:id', validate(z.object(fields).partial()), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM main_breaks WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur) throw notFound('Main break');
    if (b.main_id) await mainOf(conn, t, b.main_id);
    await checkStreet(conn, t, b.street_id);
    await checkNotice(conn, t, b.notice_id);
    if (b.valves) await checkValves(conn, t, b.valves);
    const set = []; const vals = [];
    for (const k of ['main_id', 'street_id', 'location', 'lat', 'lng', 'cause', 'pipe_material', 'pipe_size', 'customers_out', 'notice_id', 'repair', 'notes']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(b[k] === '' ? null : b[k]); }
    for (const k of ['broke_at', 'water_off_at', 'water_on_at', 'repaired_at']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(dt(b[k])); }
    if (b.boil_water !== undefined) { set.push('boil_water = ?'); vals.push(b.boil_water ? 1 : 0); }
    if (b.repaired_at !== undefined) { set.push('status = ?'); vals.push(b.repaired_at ? 'repaired' : 'open'); }
    if (set.length) await conn.query(`UPDATE main_breaks SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t, id]);
    if (b.valves) await writeValves(conn, t, id, b.valves);
    if (!set.length && !b.valves) throw bad('Nothing to change');
    const mainId = b.main_id || cur.main_id;
    if (mainId) await raiseCondition(conn, req, mainId);
    await audit(conn, req, 'update', 'main_breaks', id, Object.keys(b));
  });
  res.json(shape(await one(pool, `${LIST_SQL} WHERE b.tenant_id = ? AND b.id = ?`, [t, id])));
});

router.delete('/main-breaks/:id', manager, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT id, main_id, broke_at FROM main_breaks WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur) throw notFound('Main break');
    await conn.query('DELETE FROM main_break_valves WHERE tenant_id = ? AND break_id = ?', [t, id]);
    await conn.query('DELETE FROM main_breaks WHERE tenant_id = ? AND id = ?', [t, id]);
    await audit(conn, req, 'delete', 'main_breaks', id, { main_id: num(cur.main_id), broke_at: stamp(cur.broke_at) });
  });
  res.json({ ok: true });
});

module.exports = { router, toLine, CAUSES };
