'use strict';

// Mountain places (help/places): patrol marks trail signs, lift towers and junctions from a phone, prints help signs with
// a short code, and every call shows where the caller is in the words patrollers use. Also "Guest needs help here": one
// tap by lift, rental or any other staff makes a dispatch call at their phone's position.
//
//   GET    /patrol/places                 the list (retired ones too), lifts and trails          map_places
//   POST   /patrol/places/code            a free sign code for what is being marked                 map_places
//   POST   /patrol/places                 mark a spot from the phone's GPS (within 30 m)             map_places
//   PATCH  /patrol/places/:id             name, kind, code, lift, tower, trail                       map_places
//   PUT    /patrol/places/:id/position    move it: a new GPS mark (within 30 m)                      map_places
//   POST   /patrol/places/:id/retire|restore                                                         map_places
//   GET    /patrol/places/export          CSV: kind, name, code, lift, tower, trail, lat, lng        map_places
//   POST   /patrol/places/import          the same CSV back: added or updated by code, all or none   map_places
//   GET    /patrol/places/signs           what the sign sheets print (the help link for each code)   map_places
//   GET    /patrol/places/describe        a position in words (patrol's own New call)                dispatch
//   GET    /patrol/dispatch/:id/where     the call's location panel                                  dispatch
//   POST   /patrol/staff-help             "Guest needs help here"                                    any staff login
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, nowIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const P = require('../lib/places');
const PA = require('../lib/patrolaccess');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (feature, message) => PA.needs(pool, feature, message);
const mapping = needs('map_places', 'Mapping the mountain is for patrol Admins and Managers');
// A spot is marked only from a GPS fix this close; the screen waits for it, as the terrain park pins do.
const GPS_MAX_M = 30;

const tzOf = async (tenantId) => ((await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])) || {}).timezone || 'America/New_York';
const codeField = z.string().trim().transform((s) => s.toUpperCase()).refine((s) => P.CODE_RE.test(s), 'A sign code is 2 to 5 letters and digits, such as R7');
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const gpsAccuracy = z.number({ error: 'Mark the spot from the phone’s GPS' }).min(0).max(100000);
const fields = {
  kind: z.enum(P.KINDS),
  name: z.string().trim().max(100).nullable().optional(),
  code: codeField.nullable().optional(),
  lift_id: z.number().int().positive().nullable().optional(),
  tower_no: z.number().int().min(0).max(999).nullable().optional(),
  trail_id: z.number().int().positive().nullable().optional(),
};

/** The lift and trail must be this mountain's. Returns their names. */
async function partsOf(tenantId, b) {
  const lift = b.lift_id ? await one(pool, 'SELECT id, name FROM lifts WHERE tenant_id = ? AND id = ?', [tenantId, b.lift_id]) : null;
  if (b.lift_id && !lift) throw notFound('Lift');
  const trail = b.trail_id ? await one(pool, 'SELECT id, name FROM trails WHERE tenant_id = ? AND id = ?', [tenantId, b.trail_id]) : null;
  if (b.trail_id && !trail) throw notFound('Trail');
  return { liftName: lift ? lift.name : null, trailName: trail ? trail.name : null };
}

/** What the place is called when nobody typed a name: a tower by its lift and number, a sign by its trail. */
function nameFor(b, parts) {
  if (b.name) return b.name;
  if (b.kind === 'tower' && parts.liftName && b.tower_no !== null && b.tower_no !== undefined) return `${parts.liftName} tower ${b.tower_no}`;
  if (b.kind === 'lift_top' && parts.liftName) return `${parts.liftName} top`;
  if (b.kind === 'lift_bottom' && parts.liftName) return `${parts.liftName} bottom`;
  if (parts.trailName) return parts.trailName;
  return null;
}
function checkShape(b) {
  if (b.kind === 'tower' && (!b.lift_id || b.tower_no === null || b.tower_no === undefined)) throw bad('A lift tower needs its lift and tower number');
  if ((b.kind === 'lift_top' || b.kind === 'lift_bottom') && !b.lift_id) throw bad('Choose the lift');
}
const gpsGate = (acc) => {
  if (acc === null || acc === undefined || !Number.isFinite(Number(acc))) throw bad('Mark the spot from the phone’s GPS');
  if (Number(acc) >= GPS_MAX_M) throw bad(`The GPS is not close enough yet (within ${Math.round(acc)} m). Wait for under ${GPS_MAX_M} m: step into the open, away from trees and buildings.`);
};
const dupCode = (err) => { if (err && err.code === 'ER_DUP_ENTRY') throw conflict('That sign code is already used on this mountain. Choose another.'); throw err; };

// ---------------------------------------------------------------- map orientation
// Who may turn the mountain's maps: owners and managers, and the patrol Director or Admin (access level Admin).
const mayTurn = async (req) => PA.isSystemAdmin(req) || (await PA.levelOf(pool, req)) === 'admin';
router.get('/places/orientation', patrol, async (req, res) => {
  res.json({ ...(await P.orientationOf(pool, req.auth.tenantId)), can_turn: await mayTurn(req) });
});
// { rotation_deg } sets a manual turn that sticks; { auto: true } goes back to uphill up (the base at the bottom).
router.put('/places/orientation', patrol, validate(z.object({ rotation_deg: z.number().int().min(0).max(359).optional(), auto: z.literal(true).optional() })
  .refine((b) => (b.auto === true) !== (b.rotation_deg !== undefined), 'Send a rotation, or auto to go back to uphill up')), async (req, res) => {
  if (!(await mayTurn(req))) throw require('../lib/errors').forbidden('Turning the map is for owners, managers and the patrol Director or Admin');
  const before = await P.orientationOf(pool, req.auth.tenantId);
  await pool.query('UPDATE tenants SET map_rotation_deg = ? WHERE id = ?', [req.body.auto ? null : req.body.rotation_deg, req.auth.tenantId]);
  await audit(pool, req, 'set_map_rotation', 'tenants', req.auth.tenantId, { from: before.manual_deg, to: req.body.auto ? 'uphill' : req.body.rotation_deg });
  res.json(await P.orientationOf(pool, req.auth.tenantId));
});

// ---------------------------------------------------------------- the list and marking
router.get('/places', patrol, mapping, async (req, res) => {
  const { tenantId } = req.auth;
  const [data, lifts, trails] = await Promise.all([
    P.list(pool, tenantId, { all: true }),
    rows(pool, 'SELECT id, name FROM lifts WHERE tenant_id = ? ORDER BY name', [tenantId]),
    rows(pool, 'SELECT id, name FROM trails WHERE tenant_id = ? ORDER BY name', [tenantId]),
  ]);
  res.json({ data, lifts, trails, kinds: P.KINDS.map((k) => ({ key: k, label: P.KIND_LABEL[k] })), gps_max_m: GPS_MAX_M,
    orientation: await P.orientationOf(pool, tenantId), can_turn: await mayTurn(req) });
});

router.post('/places/code', patrol, mapping, validate(z.object({ ...fields, except: z.number().int().positive().nullable().optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const parts = await partsOf(tenantId, req.body);
  const taken = await P.takenCodes(pool, tenantId);
  if (req.body.except) { const own = await one(pool, 'SELECT code FROM mountain_places WHERE tenant_id = ? AND id = ?', [tenantId, req.body.except]); if (own) taken.delete(own.code); }
  res.json({ code: P.suggestCode({ kind: req.body.kind, name: req.body.name, liftName: parts.liftName, trailName: parts.trailName, towerNo: req.body.tower_no }, taken) });
});

router.post('/places', patrol, mapping, validate(z.object({ ...fields, lat, lng, accuracy_m: gpsAccuracy })), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  checkShape(b);
  gpsGate(b.accuracy_m);
  const parts = await partsOf(tenantId, b);
  const name = nameFor(b, parts);
  if (!name) throw bad('Give the place a name, or choose its trail or lift');
  const code = b.code || P.suggestCode({ kind: b.kind, name, liftName: parts.liftName, trailName: parts.trailName, towerNo: b.tower_no }, await P.takenCodes(pool, tenantId));
  const now = nowIn(await tzOf(tenantId));
  const [r] = await pool.query(`INSERT INTO mountain_places (tenant_id, kind, name, code, lift_id, tower_no, trail_id, lat, lng, accuracy_m, marked_by, marked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, b.kind, name, code, b.lift_id ?? null, b.tower_no ?? null, b.trail_id ?? null, b.lat, b.lng, Math.round(b.accuracy_m), req.auth.userId, now]).catch(dupCode);
  await audit(pool, req, 'create', 'mountain_places', r.insertId, { kind: b.kind, code });
  res.status(201).json(await one(pool, 'SELECT id, code, name FROM mountain_places WHERE tenant_id = ? AND id = ?', [tenantId, r.insertId]));
});

async function loadPlace(tenantId, id) {
  const p = await one(pool, 'SELECT * FROM mountain_places WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!p) throw notFound('Place');
  return p;
}

router.patch('/places/:id', patrol, mapping, validate(z.object({ ...fields, kind: fields.kind.optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await loadPlace(tenantId, paramId(req));
  const keys = Object.keys(req.body);
  if (!keys.length) throw bad('No updatable fields supplied');
  const next = { kind: p.kind, name: p.name, code: p.code, lift_id: p.lift_id, tower_no: p.tower_no, trail_id: p.trail_id, ...req.body };
  checkShape(next);
  const parts = await partsOf(tenantId, next);
  next.name = req.body.name === undefined ? p.name : nameFor(next, parts);
  if (!next.name) throw bad('Give the place a name, or choose its trail or lift');
  if (!next.code) throw bad('Every place needs a sign code');
  await pool.query('UPDATE mountain_places SET kind = ?, name = ?, code = ?, lift_id = ?, tower_no = ?, trail_id = ? WHERE tenant_id = ? AND id = ?',
    [next.kind, next.name, next.code, next.lift_id ?? null, next.tower_no ?? null, next.trail_id ?? null, tenantId, p.id]).catch(dupCode);
  await audit(pool, req, 'update', 'mountain_places', p.id, { fields: keys });
  res.json({ ok: true });
});

router.put('/places/:id/position', patrol, mapping, validate(z.object({ lat, lng, accuracy_m: gpsAccuracy })), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await loadPlace(tenantId, paramId(req));
  gpsGate(req.body.accuracy_m);
  const now = nowIn(await tzOf(tenantId));
  await pool.query('UPDATE mountain_places SET lat = ?, lng = ?, accuracy_m = ?, marked_by = ?, marked_at = ? WHERE tenant_id = ? AND id = ?',
    [req.body.lat, req.body.lng, Math.round(req.body.accuracy_m), req.auth.userId, now, tenantId, p.id]);
  await audit(pool, req, 'move', 'mountain_places', p.id, { accuracy_m: Math.round(req.body.accuracy_m) });
  res.json({ ok: true });
});

const setActive = (action, active) => async (req, res) => {
  const { tenantId } = req.auth;
  const p = await loadPlace(tenantId, paramId(req));
  await pool.query('UPDATE mountain_places SET active = ? WHERE tenant_id = ? AND id = ?', [active, tenantId, p.id]);
  await audit(pool, req, action, 'mountain_places', p.id, { code: p.code });
  res.json({ ok: true });
};
router.post('/places/:id/retire', patrol, mapping, setActive('retire', 0));
router.post('/places/:id/restore', patrol, mapping, setActive('restore', 1));

// ---------------------------------------------------------------- CSV
router.get('/places/export', patrol, mapping, async (req, res) => {
  const list = await P.list(pool, req.auth.tenantId, { all: false });
  const data = list.map((p) => ({ kind: p.kind, name: p.name, code: p.code, lift: p.lift_name || '', tower: p.tower_no ?? '', trail: p.trail_name || '', lat: p.lat.toFixed(6), lng: p.lng.toFixed(6) }));
  await audit(pool, req, 'export', 'mountain_places', null, { rows: data.length });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="mountain-places.csv"');
  res.send(toCsv(P.CSV_COLS, data));
});

/**
 * Imports the CSV the export makes (kind, name, code, lift, tower, trail, lat, lng). A row whose code is already on the
 * mountain updates that place; any other row adds one (a blank code gets a suggested one). Lifts and trails are matched by
 * name. Every row is checked first: one bad row and nothing is imported, and each problem is listed with its line.
 */
router.post('/places/import', patrol, mapping, validate(z.object({ csv: z.string().min(1).max(900000) })), async (req, res) => {
  const { tenantId } = req.auth;
  const table = P.parseCsv(req.body.csv);
  if (!table.length) throw bad('The file is empty');
  const head = table[0].map((c) => P.undefuse(c).toLowerCase());
  const at = Object.fromEntries(P.CSV_COLS.map((c) => [c, head.indexOf(c)]));
  const missing = ['kind', 'lat', 'lng'].filter((c) => at[c] < 0);
  if (missing.length) throw bad(`The first row must name the columns: ${P.CSV_COLS.join(', ')} (missing ${missing.join(', ')})`);
  if (table.length - 1 > 5000) throw bad('Import up to 5,000 places at a time');
  const lifts = new Map((await rows(pool, 'SELECT id, name FROM lifts WHERE tenant_id = ?', [tenantId])).map((l) => [l.name.toLowerCase(), l]));
  const trails = new Map((await rows(pool, 'SELECT id, name FROM trails WHERE tenant_id = ?', [tenantId])).map((t) => [t.name.toLowerCase(), t]));
  const existing = new Map((await rows(pool, 'SELECT id, code FROM mountain_places WHERE tenant_id = ?', [tenantId])).map((p) => [p.code, p.id]));
  const taken = new Set(existing.keys());
  const seen = new Set();
  const errors = []; const plan = [];
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (c) => (at[c] >= 0 ? P.undefuse(cells[at[c]]) : '');
    const kind = get('kind').toLowerCase().replace(/\s+/g, '_');
    const latV = Number(get('lat')); const lngV = Number(get('lng'));
    const towerText = get('tower'); const tower = towerText === '' ? null : Number(towerText);
    const liftName = get('lift'); const trailName = get('trail');
    let code = P.normalCode(get('code'));
    const problems = [];
    if (!P.KINDS.includes(kind)) problems.push(`kind "${get('kind')}" is not one of ${P.KINDS.join(', ')}`);
    if (!(get('lat') !== '' && Number.isFinite(latV) && Math.abs(latV) <= 90)) problems.push('lat is not a latitude');
    if (!(get('lng') !== '' && Number.isFinite(lngV) && Math.abs(lngV) <= 180)) problems.push('lng is not a longitude');
    if (tower !== null && !(Number.isInteger(tower) && tower >= 0 && tower <= 999)) problems.push('tower is not a whole number');
    const lift = liftName ? lifts.get(liftName.toLowerCase()) : null;
    if (liftName && !lift) problems.push(`no lift called "${liftName}"`);
    const trail = trailName ? trails.get(trailName.toLowerCase()) : null;
    if (trailName && !trail) problems.push(`no trail called "${trailName}"`);
    if (kind === 'tower' && (!lift || tower === null)) problems.push('a tower needs its lift and tower number');
    if (code && !P.validCode(code)) problems.push(`code "${code}" must be 2 to 5 letters and digits`);
    if (code && seen.has(code)) problems.push(`code ${code} is in the file twice`);
    const name = nameFor({ kind, name: get('name') || null, tower_no: tower }, { liftName: lift ? lift.name : null, trailName: trail ? trail.name : null });
    if (!name) problems.push('it needs a name, a trail or a lift');
    if (name && name.length > 100) problems.push('the name is longer than 100 characters');
    if (problems.length) { errors.push({ line, error: problems.join('; ') }); return; }
    if (code) seen.add(code);
    plan.push({ kind, name, code, lift, tower, trail, lat: latV, lng: lngV, line });
  });
  if (errors.length) { const err = bad(`${errors.length} row${errors.length === 1 ? '' : 's'} could not be read. Nothing was imported.`); err.details = { errors: errors.slice(0, 50) }; throw err; }
  // Blank codes get one now, after every code in the file is known.
  for (const p of plan) if (p.code) taken.add(p.code);
  for (const p of plan) if (!p.code) { p.code = P.suggestCode({ kind: p.kind, name: p.name, liftName: p.lift && p.lift.name, trailName: p.trail && p.trail.name, towerNo: p.tower }, taken); taken.add(p.code); seen.add(p.code); }
  const now = nowIn(await tzOf(tenantId));
  let added = 0; let updated = 0;
  await tx(async (conn) => {
    for (const p of plan) {
      const vals = [p.kind, p.name, p.lift ? p.lift.id : null, p.tower, p.trail ? p.trail.id : null, p.lat, p.lng];
      if (existing.has(p.code)) {
        await conn.query('UPDATE mountain_places SET kind = ?, name = ?, lift_id = ?, tower_no = ?, trail_id = ?, lat = ?, lng = ?, accuracy_m = NULL, active = 1 WHERE tenant_id = ? AND id = ?', [...vals, tenantId, existing.get(p.code)]);
        updated += 1;
      } else {
        await conn.query(`INSERT INTO mountain_places (tenant_id, kind, name, lift_id, tower_no, trail_id, lat, lng, code, accuracy_m, marked_by, marked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`, [tenantId, ...vals, p.code, req.auth.userId, now]);
        added += 1;
      }
    }
  }).catch(dupCode);
  await audit(pool, req, 'import', 'mountain_places', null, { added, updated });
  res.json({ added, updated });
});

// ---------------------------------------------------------------- sign sheets
/** The mountain's help number for texts (help/sms adds the setting): any tenants column named help..number or help..phone. */
async function helpNumber(tenantId) {
  // help/guest and help/sms name it guest_help_sms (the number guests text); any other help..number or help..sms column after.
  const cols = (await rows(pool, `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tenants'
    AND column_name REGEXP '^(guest_)?help_([a-z]+_)?(sms|text|number)$'`)).map((r) => r.c);
  const col = ['guest_help_sms', 'help_sms_number', 'help_text_number', 'help_number'].find((c) => cols.includes(c)) || cols.sort()[0];
  if (!col) return null;
  const t = await one(pool, `SELECT \`${String(col).replace(/`/g, '')}\` AS n FROM tenants WHERE id = ?`, [tenantId]);
  const n = t && t.n ? String(t.n).trim() : '';
  return n || null;
}
const helpUrl = (req, slug, code) => `${require('../lib/baseurl').baseUrl(req)}/help/${encodeURIComponent(slug)}?c=${encodeURIComponent(code)}`;

router.get('/places/signs', patrol, mapping, async (req, res) => {
  const { tenantId } = req.auth;
  const t = await one(pool, 'SELECT slug, name FROM tenants WHERE id = ?', [tenantId]);
  const ids = String(req.query.ids || '').split(',').map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0).slice(0, 500);
  const liftId = Number(req.query.lift) || null;
  let list = await P.list(pool, tenantId);
  if (ids.length) list = list.filter((p) => ids.includes(Number(p.id)));
  if (liftId) list = list.filter((p) => Number(p.lift_id) === liftId && p.kind === 'tower').sort((a, b) => a.tower_no - b.tower_no);
  res.json({ mountain: t.name, slug: t.slug, help_number: await helpNumber(tenantId), lift: liftId ? ((await one(pool, 'SELECT name FROM lifts WHERE tenant_id = ? AND id = ?', [tenantId, liftId])) || {}).name || null : null,
    places: list.map((p) => ({ id: p.id, kind: p.kind, name: P.placeName(p), code: p.code, tower_no: p.tower_no, lift_name: p.lift_name, url: helpUrl(req, t.slug, p.code) })) });
});

// ---------------------------------------------------------------- where a caller is
router.get('/places/describe', patrol, needs('dispatch'), async (req, res) => {
  const la = Number(req.query.lat); const ln = Number(req.query.lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) throw bad('lat and lng are needed');
  const acc = req.query.acc === undefined || req.query.acc === '' ? null : Number(req.query.acc);
  res.json({ words: await P.describe(pool, req.auth.tenantId, la, ln, Number.isFinite(acc) ? acc : null) });
});

// What help/guest adds (the place a guest scanned, the trail of positions) is read when it is there.
async function columnsOf(table) {
  return new Set((await rows(pool, 'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?', [table])).map((r) => r.c));
}
async function positionTable() {
  const t = await one(pool, `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()
    AND table_name REGEXP '^dispatch_(call_)?(positions|locations|fixes|pings)$' ORDER BY table_name LIMIT 1`);
  if (!t) return null;
  const cols = await columnsOf(t.t);
  const pick = (...names) => names.find((n) => cols.has(n)) || null;
  const m = { table: t.t, lat: pick('lat', 'gps_lat', 'latitude'), lng: pick('lng', 'gps_lng', 'longitude'), acc: pick('accuracy_m', 'accuracy'), at: pick('taken_at', 'at', 'recorded_at', 'created_at', 'received_at'), call: pick('call_id'), id: cols.has('id') };
  return m.lat && m.lng && m.call && cols.has('tenant_id') ? m : null;
}
const q = (n) => `\`${String(n).replace(/`/g, '')}\``;
const minutesBetween = (a, b) => Math.max(0, Math.round((Date.parse(`${String(b).replace(' ', 'T')}Z`) - Date.parse(`${String(a).replace(' ', 'T')}Z`)) / 60000));
const asText = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v === null || v === undefined ? null : String(v).slice(0, 19).replace('T', ' '));

router.get('/dispatch/:id/where', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await one(pool, 'SELECT * FROM dispatch_calls WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!c) throw notFound('Call');
  const tz = await tzOf(tenantId);
  // The last 10 positions, oldest first (help/guest keeps them; a mountain without that table has only the call's own).
  let trail = [];
  const pt = await positionTable();
  if (pt) {
    const got = await rows(pool, `SELECT ${q(pt.lat)} AS lat, ${q(pt.lng)} AS lng${pt.acc ? `, ${q(pt.acc)} AS acc` : ', NULL AS acc'}${pt.at ? `, ${q(pt.at)} AS at` : ', NULL AS at'}
      FROM ${q(pt.table)} WHERE tenant_id = ? AND ${q(pt.call)} = ? ORDER BY ${[pt.at ? `${q(pt.at)} DESC` : null, pt.id ? 'id DESC' : null].filter(Boolean).join(', ') || '1'} LIMIT 10`, [tenantId, c.id]);
    trail = got.reverse().filter((p) => p.lat !== null && p.lng !== null).map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), accuracy_m: p.acc === null ? null : Math.round(Number(p.acc)), at: asText(p.at) }));
  }
  const own = c.gps_lat !== null && c.gps_lng !== null ? { lat: Number(c.gps_lat), lng: Number(c.gps_lng), accuracy_m: c.located_accuracy_m === null ? null : Number(c.located_accuracy_m), at: asText(c.located_at || c.received_at) } : null;
  const last = trail[trail.length - 1];
  const position = last && (!own || !own.at || !last.at || last.at >= own.at) ? last : own;
  if (own && !trail.length) trail = [own];
  // When the phone last moved: the newest step further than its own accuracy (and at least 20 m).
  let movedAt = trail.length ? trail[0].at : position ? position.at : null;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1]; const b = trail[i];
    if (P.haversine(a.lat, a.lng, b.lat, b.lng) > Math.max(20, a.accuracy_m || 0, b.accuracy_m || 0)) movedAt = b.at;
  }
  const cols = await columnsOf('dispatch_calls');
  let scanned = null;
  if (cols.has('place_id') && c.place_id) {
    const p = await one(pool, 'SELECT code, name FROM mountain_places WHERE tenant_id = ? AND id = ?', [tenantId, c.place_id]);
    if (p) scanned = { code: p.code, name: p.name };
  }
  for (const k of ['sign_code', 'scan_code']) if (!scanned && cols.has(k) && c[k]) scanned = { code: String(c[k]), name: null };
  const now = nowIn(tz);
  res.json({
    position,
    words: position ? await P.describe(pool, tenantId, position.lat, position.lng, position.accuracy_m) : null,
    place_text: cols.has('place_text') ? c.place_text || null : null,
    places: position ? (await P.near(pool, tenantId, position.lat, position.lng, 800, { limit: 60 })).map((p) => ({ id: p.id, kind: p.kind, code: p.code, name: P.placeName(p), lat: p.lat, lng: p.lng, distance_m: Math.round(p.distance_m) })) : [],
    trail,
    scanned,
    last_moved_at: movedAt,
    minutes_since_move: movedAt ? minutesBetween(movedAt, now) : null,
    rotation_deg: await P.rotationOf(pool, tenantId),
    maps_url: position ? `https://www.google.com/maps/search/?api=1&query=${position.lat},${position.lng}` : null,
  });
});

// ---------------------------------------------------------------- Guest needs help here (staff)
// Any staff login: lift and mountain staff, the ticket window and rentals, instructors, patrol and managers. Not the ski
// area's read-only login. The call follows the radio call's rules: it lands on the board as New, and the patrollers a
// dispatcher sends get their phone alert as usual.
router.post('/staff-help', requireRole('manager', 'staff', 'counter', 'instructor', 'patrol'), validate(z.object({
  lat: lat.nullable().optional(), lng: lng.nullable().optional(), accuracy_m: z.number().min(0).max(100000).nullable().optional(),
  location: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  who: z.string().trim().max(100).nullable().optional(),
})), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  const hasGps = b.lat !== null && b.lat !== undefined && b.lng !== null && b.lng !== undefined;
  if (!hasGps && !b.location) throw bad('Your phone did not share its location. Say where the guest is.');
  const tenant = await one(pool, 'SELECT id, timezone FROM tenants WHERE id = ?', [tenantId]);
  const words = hasGps ? await P.describe(pool, tenantId, b.lat, b.lng, b.accuracy_m ?? null) : null;
  const acc = b.accuracy_m === null || b.accuracy_m === undefined ? null : Math.round(b.accuracy_m);
  const location = (words ? words.text : b.location || `Staff phone position${acc !== null ? ` (within about ${acc} m)` : ''}`).slice(0, 255);
  const me = req.auth.staffId ? await one(pool, 'SELECT p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?', [tenantId, req.auth.staffId]) : null;
  const user = await one(pool, 'SELECT email, username FROM users WHERE tenant_id = ? AND id = ?', [tenantId, req.auth.userId]);
  const byName = me ? `${me.first_name} ${me.last_name}`.trim() : (user && (user.username || user.email)) || 'Staff';
  const description = [b.who ? `Who: ${b.who}` : null, b.note || null, words && b.location ? `Staff said: ${b.location}` : null].filter(Boolean).join('. ').slice(0, 500) || 'Guest needs help (staff saw it)';
  const { createCall } = require('./dispatch');
  const out = await createCall(tenant, { location, description, priority: 'normal', caller_name: `Staff: ${byName}`.slice(0, 100), gps_lat: hasGps ? b.lat : null, gps_lng: hasGps ? b.lng : null },
    { source: 'staff', userId: req.auth.userId, staffId: req.auth.staffId || null });
  // The position's accuracy, and the place words where help/guest keeps them.
  const cols = await columnsOf('dispatch_calls');
  const sets = []; const vals = [];
  if (hasGps) { sets.push('located_accuracy_m = ?', 'located_at = received_at'); vals.push(acc); }
  if (words && cols.has('place_id')) { sets.push('place_id = ?'); vals.push(words.place_id); }
  if (words && cols.has('place_text')) { sets.push('place_text = ?'); vals.push(words.text.slice(0, 255)); }
  if (sets.length) await pool.query(`UPDATE dispatch_calls SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, tenantId, out.id]);
  await audit(pool, req, 'staff_help', 'dispatch_calls', out.id, { gps: hasGps, accuracy_m: acc, confidence: words ? words.confidence : null });
  res.status(201).json({ id: out.id, call_no: out.call_no, location });
});

/** The staff member who pressed it adds who needs help and a short note afterwards (the call is already on the board). */
router.post('/staff-help/:id/details', requireRole('manager', 'staff', 'counter', 'instructor', 'patrol'), validate(z.object({
  note: z.string().trim().max(200).nullable().optional(), who: z.string().trim().max(100).nullable().optional(),
})), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await one(pool, `SELECT c.id, c.description, c.status FROM dispatch_calls c WHERE c.tenant_id = ? AND c.id = ? AND c.source = 'staff'
    AND EXISTS (SELECT 1 FROM dispatch_events e WHERE e.tenant_id = c.tenant_id AND e.call_id = c.id AND e.kind = 'received' AND e.user_id = ?)`, [tenantId, paramId(req), req.auth.userId]);
  if (!c) throw notFound('Call');
  if (!['new', 'dispatched', 'on_scene', 'transporting'].includes(c.status)) throw conflict('This call is closed');
  const add = [req.body.who ? `Who: ${req.body.who}` : null, req.body.note || null].filter(Boolean).join('. ');
  if (!add) throw bad('Say who needs help, or add a note');
  const base = c.description && c.description !== 'Guest needs help (staff saw it)' ? `${c.description}. ` : '';
  await pool.query('UPDATE dispatch_calls SET description = ? WHERE tenant_id = ? AND id = ?', [`${base}${add}`.slice(0, 500), tenantId, c.id]);
  await pool.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, 'note', ?, ?, ?)", [tenantId, c.id, nowIn(await tzOf(tenantId)), req.auth.staffId || null, `Staff added: ${add}`.slice(0, 500), req.auth.userId]);
  await audit(pool, req, 'staff_help_details', 'dispatch_calls', c.id, { who: Boolean(req.body.who), note: Boolean(req.body.note) });
  res.json({ ok: true });
});

module.exports = { router, helpNumber, GPS_MAX_M };
