'use strict';

// An inspection, on an asset in the register or on a map feature (a valve, a hydrant, a manhole), from its own page or
// as one target of a program (muni release 1). Every item is answered by its kind (pass or fail, a reading, a date, a
// choice, yes or no, a few words, a condition score); an answer outside its rule fails by itself. Any failure opens a work
// order on the same asset or feature. A checklist that "sets condition" moves the asset's or feature's condition score
// to the one given, and the inspection keeps it, so the history stays. A pump's hour meter readings are kept for the
// station's run hours by month.
const { one, rows } = require('../db');
const { nowIn } = require('./util');
const { notFound, bad, conflict } = require('./errors');
const { audit } = require('./audit');
const CR = require('./checkrules');

/**
 * The thing being inspected: { type: 'asset'|'feature', id, name, kind, critical, criticality, status }. With lock, the
 * row is locked for the rest of the caller's transaction.
 */
async function targetOf(conn, tenantId, { assetId, featureId }, lock = false) {
  const tail = lock ? ' FOR UPDATE' : '';
  if (assetId) {
    const a = await one(conn, `SELECT id, name, asset_tag, kind, status, critical, criticality FROM ops_assets WHERE tenant_id = ? AND id = ?${tail}`, [tenantId, assetId]);
    if (!a) throw notFound('Asset');
    return { type: 'asset', id: Number(a.id), name: a.name, tag: a.asset_tag, kind: a.kind, status: a.status, critical: Boolean(a.critical), criticality: a.criticality === null ? null : Number(a.criticality) };
  }
  const f = await one(conn, `SELECT f.id, f.name, f.tag, f.kind, f.status, f.criticality, f.asset_id, a.critical FROM map_features f
    LEFT JOIN ops_assets a ON a.tenant_id = f.tenant_id AND a.id = f.asset_id WHERE f.tenant_id = ? AND f.id = ?${tail}`, [tenantId, featureId]);
  if (!f) throw notFound('Map item');
  const MF = require('./mapfeatures');
  const label = (MF.kindOf(f.kind) || { label: f.kind }).label;
  return { type: 'feature', id: Number(f.id), name: f.name || (f.tag ? `${label} ${f.tag}` : `${label} ${f.id}`), tag: f.tag, kind: f.kind, status: f.status, critical: Boolean(f.critical), criticality: f.criticality === null ? null : Number(f.criticality) };
}

/** Who did it, in words: the name given, else the signed-in person's name. */
async function whoDid(conn, req, given) {
  if (given) return given;
  const u = await one(conn, "SELECT COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), u.email, u.username) AS n FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE u.tenant_id = ? AND u.id = ?", [req.auth.tenantId, req.auth.userId]);
  return (u && u.n) || null;
}

/**
 * Records one inspection inside the caller's transaction. target: from targetOf (locked). body: { template_id, items,
 * hours, miles, inspector, note }. opts: { programId, recordMeter(conn, req, assetId, meter, value, source, at) }.
 * Returns { id, result, work_order_id, condition_score }.
 */
async function record(conn, req, target, body, { programId = null, recordMeter = null } = {}) {
  const t = req.auth.tenantId;
  const tpl = await one(conn, 'SELECT * FROM inspection_templates WHERE tenant_id = ? AND id = ?', [t, body.template_id]);
  if (!tpl) throw notFound('Checklist');
  const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
  const at = nowIn(tz);
  // Readings, dates, choices and yes-or-no answers are checked against their rules here: one outside its rule fails by itself, with the reason.
  let items;
  try { items = CR.evaluateAll(JSON.parse(tpl.items), body.items, at.slice(0, 10)); } catch (e) { throw bad(e.message); }

  // A photo answers its item only when it was taken of this asset or feature and is not already part of another inspection.
  const photoIds = [...new Set(items.filter((i) => i.photo_id).map((i) => i.photo_id))];
  if (photoIds.length) {
    const col = target.type === 'asset' ? 'asset_id' : 'map_feature_id';
    const found = await rows(conn, `SELECT id, inspection_id FROM asset_photos WHERE tenant_id = ? AND ${col} = ? AND id IN (?)`, [t, target.id, photoIds]);
    if (found.length !== photoIds.length) throw bad(`A photo in this inspection was not taken of this ${target.type === 'asset' ? 'asset' : 'map item'}. Take it again.`);
    if (found.some((p) => p.inspection_id)) throw conflict('A photo in this inspection is already part of another one. Take a new photo.');
  }

  const failed = items.filter((i) => i.result === 'fail');
  if (target.type === 'asset' && recordMeter) {
    for (const m of ['hours', 'miles']) if (body[m] !== null && body[m] !== undefined) await recordMeter(conn, req, target.id, m, body[m], 'inspection', at);
  }
  let woId = null;
  if (failed.length) {
    const maintenance = require('../routes/maintenance');
    const urgent = target.critical || (target.criticality !== null && target.criticality >= 4);
    woId = await maintenance.createOrder(conn, req, {
      title: `Failed ${tpl.name.toLowerCase()}: ${target.name}`.slice(0, 150),
      description: failed.map((i) => `${i.label}${i.value != null && i.type === 'number' ? ` (${i.value}${i.unit ? ` ${i.unit}` : ''})` : ''}: ${i.note}`).join('\n').slice(0, 5000),
      priority: urgent ? 'urgent' : 'high',
      asset_id: target.type === 'asset' ? target.id : null,
      map_feature_id: target.type === 'feature' ? target.id : null,
      program_id: programId,
    }, programId ? 'program' : 'inspection');
    if (target.type === 'asset' && target.status === 'in_service') await conn.query("UPDATE ops_assets SET status = 'needs_service' WHERE tenant_id = ? AND id = ?", [t, target.id]);
  }
  const score = tpl.sets_condition ? CR.conditionOf(items) : null;
  const who = await whoDid(conn, req, body.inspector);
  const [r] = await conn.query(`INSERT INTO asset_inspections (tenant_id, asset_id, map_feature_id, program_id, template_id, template_name, result, items, hours, miles, inspector, note, work_order_id, user_id, done_at, condition_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [t, target.type === 'asset' ? target.id : null, target.type === 'feature' ? target.id : null, programId, tpl.id, tpl.name, failed.length ? 'fail' : 'pass', JSON.stringify(items),
    target.type === 'asset' ? body.hours ?? null : null, target.type === 'asset' ? body.miles ?? null : null, who, body.note ?? null, woId, req.auth.userId, at, score]);
  const id = r.insertId;
  if (photoIds.length) await conn.query('UPDATE asset_photos SET inspection_id = ? WHERE tenant_id = ? AND id IN (?) AND inspection_id IS NULL', [id, t, photoIds]);
  // The latest inspection's score is the condition now; each inspection keeps its own.
  if (score !== null) await conn.query(`UPDATE ${target.type === 'asset' ? 'ops_assets' : 'map_features'} SET condition_score = ? WHERE tenant_id = ? AND id = ?`, [score, t, target.id]);
  for (const i of items.filter((x) => x.run_hours && x.result !== 'na' && typeof x.value === 'number')) {
    await conn.query('INSERT INTO station_run_hours (tenant_id, asset_id, map_feature_id, inspection_id, item_key, label, hours, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [t, target.type === 'asset' ? target.id : null, target.type === 'feature' ? target.id : null, id, i.key, i.label.slice(0, 150), i.value, at]);
  }
  // A storm outfall's screening (2026.11.20, lib/stormwater.js): a failure sets its condition to at least Poor, and a
  // suspected illicit discharge opens a case on the outfall (or adds to the one open).
  const storm = await require('./stormwater').afterScreening(conn, req, target, items, id, failed.length > 0, at);
  await audit(conn, req, 'inspect', target.type === 'asset' ? 'ops_assets' : 'map_features', target.id, { inspection_id: id, result: failed.length ? 'fail' : 'pass', work_order_id: woId, ...(programId ? { program_id: programId } : {}), ...(score !== null ? { condition_score: score } : {}) });
  return { id, result: failed.length ? 'fail' : 'pass', work_order_id: woId, condition_score: score ?? (storm && storm.condition_score) ?? null, ...(storm && storm.case_id ? { case_id: storm.case_id } : {}) };
}

/**
 * Run hours by month for a station: each pump's hour meter readings, in order, and the hours run between one reading and
 * the next, counted in the month of the later reading. A meter that reads lower than before (replaced or reset) starts
 * counting again from its new reading. target: { type, id }. Returns { pumps: [{ key, label }], months: [{ month, hours:
 * { key: n }, total }] }, newest month first.
 */
async function runHours(conn, tenantId, target) {
  const col = target.type === 'asset' ? 'asset_id' : 'map_feature_id';
  const list = await rows(conn, `SELECT item_key, label, hours, read_at FROM station_run_hours WHERE tenant_id = ? AND ${col} = ? ORDER BY item_key, read_at, id`, [tenantId, target.id]);
  const pumps = []; const byMonth = new Map();
  let prev = null;
  for (const r of list) {
    if (!pumps.some((p) => p.key === r.item_key)) { pumps.push({ key: r.item_key, label: r.label }); prev = null; }
    const v = Number(r.hours);
    const month = (r.read_at instanceof Date ? r.read_at.toISOString() : String(r.read_at)).slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, {});
    const m = byMonth.get(month);
    if (prev !== null && prev.key === r.item_key && v >= prev.v) m[r.item_key] = Math.round(((m[r.item_key] || 0) + (v - prev.v)) * 10) / 10;
    else if (m[r.item_key] === undefined) m[r.item_key] = 0;
    prev = { key: r.item_key, v };
  }
  const months = [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, hours]) => {
    for (const p of pumps) if (hours[p.key] === undefined) hours[p.key] = null;
    return { month, hours, total: Math.round(Object.values(hours).reduce((s, n) => s + (n || 0), 0) * 10) / 10 };
  });
  return { pumps, months };
}

/** Run hours as a spreadsheet: Month, then each pump, then Total. */
function runHoursCsv(data) {
  const esc = (v) => { const x = require('./csv').defuse(v === null || v === undefined ? '' : String(v)); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  return [['Month', ...data.pumps.map((p) => `${p.label} (hours run)`), 'Total hours run'].map(esc).join(','),
    ...data.months.map((m) => [m.month, ...data.pumps.map((p) => m.hours[p.key]), m.total].map(esc).join(','))].join('\n');
}

module.exports = { targetOf, record, runHours, runHoursCsv, whoDid };
