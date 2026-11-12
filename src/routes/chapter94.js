'use strict';

// Sewer, Chapter 94 (release 2026.11.20, the Sewer add-on). Mounted at /api/v1/sewer next to the Sewer Today cards.
// Pennsylvania's Chapter 94 wasteload management report asks a sewer system for its monthly flows, its new connections and
// its overflows each year. This screen gathers what the app already records:
//   flow:   for each pump station, its run hours by month (from the hour meters read on its rounds, lib/assetinspect.js
//           runHours) times each pump's rated flow (gpm, entered here) = an estimated flow, in gallons and in million
//           gallons a day (MGD). It is an estimate from run time, not a metered flow, and the screen and the file say so.
//   connections: new connections (EDUs) entered per year, and the projection the engineer gives.
//   overflows: each sanitary sewer overflow (SSO) recorded here.
// The numbers are a starting point for the engineer who signs the report; the app does not file anything with DEP.
//   GET  /ch94?year=               the year: stations by month, the system by month, annual totals and the peak month,
//                                  connections, overflows
//   GET  /ch94.csv?year=           the flows as a spreadsheet (columns in RUNBOOK.md, Chapter 94 file)
//   PUT  /ch94/stations/:id/pumps  { pumps: { pump1_hours: 350, ... } } each pump's rated flow in gpm (managers)
//   PUT  /ch94/years/:year         { new_edus, projected_edus, notes } (managers)
//   GET  /overflows?year=, POST /overflows, PATCH /overflows/:id, DELETE /overflows/:id (managers delete)
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateTimeStr, normDateTime, nowIn } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const AI = require('../lib/assetinspect');

const router = express.Router();
const crew = requireRole('staff', 'manager');
const manager = requireRole('manager');
const STATION_KINDS = ['lift_station'];
const CAUSES = [['rain', 'Heavy rain (inflow and infiltration)'], ['blockage', 'Blockage'], ['grease', 'Grease'], ['roots', 'Roots'], ['pump_failure', 'Pump station failure'], ['power', 'Power outage'], ['other', 'Other']]
  .map(([value, label]) => ({ value, label }));
const CAUSE_WORDS = Object.fromEntries(CAUSES.map((c) => [c.value, c.label]));

const tzOf = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const daysIn = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const stamp = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v ? String(v).slice(0, 19).replace('T', ' ') : null);
const ratesOf = (f) => { try { const o = JSON.parse(f.pump_gpm || '{}'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } };
const yearOf = async (req) => {
  const y = Number(req.query.year);
  if (Number.isInteger(y) && y >= 2000 && y <= 2100) return y;
  return Number((nowIn(await tzOf(req.auth.tenantId))).slice(0, 4));
};

/** The Chapter 94 numbers for a year. */
async function report(t, year) {
  const stations = await rows(pool, "SELECT id, name, tag, pump_gpm, status FROM map_features WHERE tenant_id = ? AND kind IN (?) AND status <> 'abandoned' ORDER BY name, tag", [t, STATION_KINDS]);
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const system = Object.fromEntries(months.map((m) => [m, { hours: 0, gallons: 0, missing_rate: false, readings: false }]));
  const out = [];
  for (const s of stations) {
    const rates = ratesOf(s);
    const data = await AI.runHours(pool, t, { type: 'feature', id: Number(s.id) });
    const pumps = data.pumps.map((p) => ({ key: p.key, label: p.label, gpm: rates[p.key] === undefined ? null : Number(rates[p.key]) }));
    const byMonth = months.map((m) => {
      const row = data.months.find((x) => x.month === m);
      const perPump = pumps.map((p) => {
        const hours = row ? row.hours[p.key] : null;
        const gallons = hours !== null && hours !== undefined && p.gpm !== null ? round(hours * 60 * p.gpm) : null;
        return { key: p.key, hours: hours === undefined ? null : hours, gallons };
      });
      const hours = round(perPump.reduce((a, p) => a + (p.hours || 0), 0), 1);
      const missing = perPump.some((p) => p.hours !== null && p.gallons === null);
      const gallons = perPump.reduce((a, p) => a + (p.gallons || 0), 0);
      const sys = system[m];
      sys.hours = round(sys.hours + hours, 1); sys.gallons += gallons; sys.missing_rate = sys.missing_rate || missing; sys.readings = sys.readings || Boolean(row);
      return { month: m, pumps: perPump, hours, gallons: row ? round(gallons) : null, mgd: row ? round(gallons / daysIn(m) / 1e6, 4) : null, missing_rate: missing, readings: Boolean(row) };
    });
    const withFlow = byMonth.filter((m) => m.gallons !== null);
    const total = withFlow.reduce((a, m) => a + m.gallons, 0);
    const peak = withFlow.reduce((best, m) => (!best || m.gallons > best.gallons ? m : best), null);
    out.push({ id: Number(s.id), name: s.name || (s.tag ? `Pump station ${s.tag}` : `Pump station ${s.id}`), tag: s.tag, pumps, months: byMonth,
      annual: { hours: round(byMonth.reduce((a, m) => a + m.hours, 0), 1), gallons: round(total), mgd: withFlow.length ? round(total / withFlow.reduce((a, m) => a + daysIn(m.month), 0) / 1e6, 4) : null,
        peak_month: peak && peak.gallons ? peak.month : null, peak_mgd: peak && peak.gallons ? peak.mgd : null } });
  }
  const sysMonths = months.map((m) => ({ month: m, hours: system[m].hours, gallons: system[m].readings ? round(system[m].gallons) : null, mgd: system[m].readings ? round(system[m].gallons / daysIn(m) / 1e6, 4) : null, missing_rate: system[m].missing_rate }));
  const withFlow = sysMonths.filter((m) => m.gallons);
  const peak = withFlow.reduce((best, m) => (!best || m.gallons > best.gallons ? m : best), null);
  const total = withFlow.reduce((a, m) => a + m.gallons, 0);
  const years = await rows(pool, 'SELECT year, new_edus, projected_edus, notes FROM sewer_ch94_years WHERE tenant_id = ? AND year BETWEEN ? AND ? ORDER BY year DESC', [t, year - 5, year + 5]);
  const overflows = await overflowList(t, year);
  return {
    year, months, stations: out,
    system: { months: sysMonths, annual: { gallons: round(total), mgd: withFlow.length ? round(total / withFlow.reduce((a, m) => a + daysIn(m.month), 0) / 1e6, 4) : null, peak_month: peak ? peak.month : null, peak_mgd: peak ? peak.mgd : null,
      peak_ratio: peak && withFlow.length ? round(peak.mgd / (total / withFlow.reduce((a, m) => a + daysIn(m.month), 0) / 1e6), 2) : null } },
    connections: years.map((y) => ({ year: Number(y.year), new_edus: Number(y.new_edus), projected_edus: y.projected_edus === null ? null : Number(y.projected_edus), notes: y.notes })),
    overflows, overflow_causes: CAUSES,
    missing_rates: out.filter((s) => s.pumps.some((p) => p.gpm === null)).map((s) => s.name),
    basis: 'Estimated flow = hours each pump ran (from its hour meter on the station rounds) x the pump’s rated flow in gallons a minute x 60. It is an estimate from run time, not a metered flow.',
  };
}

async function overflowList(t, year) {
  const list = await rows(pool, `SELECT o.*, f.name AS feature_name, f.tag AS feature_tag, f.kind AS feature_kind FROM sewer_overflows o LEFT JOIN map_features f ON f.tenant_id = o.tenant_id AND f.id = o.map_feature_id
    WHERE o.tenant_id = ? AND o.started_at >= ? AND o.started_at < ? ORDER BY o.started_at`, [t, `${year}-01-01`, `${year + 1}-01-01`]);
  return list.map((o) => ({ id: Number(o.id), map_feature_id: o.map_feature_id === null ? null : Number(o.map_feature_id), where: o.feature_tag || o.feature_name || null, location: o.location,
    started_at: stamp(o.started_at), ended_at: stamp(o.ended_at), gallons: o.gallons === null ? null : Number(o.gallons), cause: o.cause, cause_words: CAUSE_WORDS[o.cause],
    reached_water: Boolean(o.reached_water), reported_to_dep_at: stamp(o.reported_to_dep_at), notes: o.notes }));
}

router.use(crew);

router.get('/ch94', async (req, res) => res.json(await report(req.auth.tenantId, await yearOf(req))));

/**
 * The flows as a spreadsheet, one row per station, month and pump, then an "All pumps" row for each station and month,
 * an "All stations" row for each month, and a "Year" row for each station and the system. Columns: year, month, station,
 * station_tag, pump, run_hours, rated_flow_gpm, estimated_gallons, days, average_daily_flow_mgd.
 */
router.get('/ch94.csv', async (req, res) => {
  const t = req.auth.tenantId;
  const r = await report(t, await yearOf(req));
  const data = [];
  for (const s of r.stations) {
    for (const m of s.months) {
      if (!m.readings) continue;
      for (const p of m.pumps) {
        const pump = s.pumps.find((x) => x.key === p.key);
        data.push({ year: r.year, month: m.month, station: s.name, station_tag: s.tag || '', pump: pump.label, run_hours: p.hours ?? '', rated_flow_gpm: pump.gpm ?? '', estimated_gallons: p.gallons ?? '', days: daysIn(m.month), average_daily_flow_mgd: p.gallons === null ? '' : round(p.gallons / daysIn(m.month) / 1e6, 4) });
      }
      data.push({ year: r.year, month: m.month, station: s.name, station_tag: s.tag || '', pump: 'All pumps', run_hours: m.hours, rated_flow_gpm: '', estimated_gallons: m.gallons ?? '', days: daysIn(m.month), average_daily_flow_mgd: m.mgd ?? '' });
    }
    data.push({ year: r.year, month: 'Year', station: s.name, station_tag: s.tag || '', pump: 'All pumps', run_hours: s.annual.hours, rated_flow_gpm: '', estimated_gallons: s.annual.gallons, days: '', average_daily_flow_mgd: s.annual.mgd ?? '' });
  }
  for (const m of r.system.months) if (m.gallons !== null) data.push({ year: r.year, month: m.month, station: 'All stations', station_tag: '', pump: 'All pumps', run_hours: m.hours, rated_flow_gpm: '', estimated_gallons: m.gallons, days: daysIn(m.month), average_daily_flow_mgd: m.mgd });
  data.push({ year: r.year, month: 'Year', station: 'All stations', station_tag: '', pump: 'All pumps', run_hours: '', rated_flow_gpm: '', estimated_gallons: r.system.annual.gallons, days: '', average_daily_flow_mgd: r.system.annual.mgd ?? '' });
  await audit(pool, req, 'export', 'chapter94', null, { year: r.year, rows: data.length });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="chapter-94-flows-${r.year}.csv"` })
    .send(toCsv(['year', 'month', 'station', 'station_tag', 'pump', 'run_hours', 'rated_flow_gpm', 'estimated_gallons', 'days', 'average_daily_flow_mgd'], data));
});

router.put('/ch94/stations/:id/pumps', manager, validate(z.object({ pumps: z.record(z.string().regex(/^[a-z0-9_]{1,30}$/), z.number().min(0).max(100000).nullable()) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const f = await one(pool, 'SELECT id, kind, pump_gpm FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!f) throw notFound('Pump station');
  if (!STATION_KINDS.includes(f.kind)) throw bad('Rated flows are for a pump station');
  const next = { ...ratesOf(f) };
  for (const [k, v] of Object.entries(req.body.pumps)) { if (v === null) delete next[k]; else next[k] = v; }
  const json = JSON.stringify(next);
  if (json.length > 300) throw bad('Too many pumps');
  await pool.query('UPDATE map_features SET pump_gpm = ? WHERE tenant_id = ? AND id = ?', [json, t, id]);
  await audit(pool, req, 'pump_rates', 'map_features', id, next);
  res.json({ pumps: next });
});

router.put('/ch94/years/:year', manager, validate(z.object({ new_edus: z.number().int().min(0).max(1000000), projected_edus: z.number().int().min(0).max(1000000).nullable().optional(), notes: z.string().trim().max(500).nullable().optional() })), async (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad('Pick a year from 2000 to 2100');
  const b = req.body;
  await pool.query(`INSERT INTO sewer_ch94_years (tenant_id, year, new_edus, projected_edus, notes, updated_by) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE new_edus = VALUES(new_edus), projected_edus = VALUES(projected_edus), notes = VALUES(notes), updated_by = VALUES(updated_by)`,
  [req.auth.tenantId, year, b.new_edus, b.projected_edus ?? null, b.notes || null, req.auth.userId || null]);
  await audit(pool, req, 'connections', 'sewer_ch94_years', year, { new_edus: b.new_edus, projected_edus: b.projected_edus ?? null });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- overflows
const overflowFields = {
  map_feature_id: z.number().int().positive().nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  started_at: dateTimeStr,
  ended_at: dateTimeStr.nullable().optional(),
  gallons: z.number().int().min(0).max(100000000).nullable().optional(),
  cause: z.enum(CAUSES.map((c) => c.value)).optional(),
  reached_water: z.boolean().optional(),
  reported_to_dep_at: dateTimeStr.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
};
async function checkFeature(t, id) { if (id && !(await one(pool, 'SELECT id FROM map_features WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Map item'); }
const dt = (v) => (v ? normDateTime(v) : v === null ? null : undefined);

router.get('/overflows', async (req, res) => res.json({ data: await overflowList(req.auth.tenantId, await yearOf(req)), causes: CAUSES }));

router.post('/overflows', validate(z.object(overflowFields)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await checkFeature(t, b.map_feature_id);
  if (!b.map_feature_id && !b.location) throw bad('Say where: pick the manhole or pump station, or describe the place');
  if (b.ended_at && normDateTime(b.ended_at) < normDateTime(b.started_at)) throw bad('It cannot end before it started');
  const [r] = await pool.query(`INSERT INTO sewer_overflows (tenant_id, map_feature_id, location, started_at, ended_at, gallons, cause, reached_water, reported_to_dep_at, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t, b.map_feature_id || null, b.location || null, normDateTime(b.started_at), dt(b.ended_at) ?? null, b.gallons ?? null, b.cause || 'other', b.reached_water ? 1 : 0, dt(b.reported_to_dep_at) ?? null, b.notes || null, req.auth.userId || null]);
  await audit(pool, req, 'create', 'sewer_overflows', r.insertId, { cause: b.cause || 'other', gallons: b.gallons ?? null, reached_water: Boolean(b.reached_water) });
  res.status(201).json({ id: r.insertId });
});

router.patch('/overflows/:id', validate(z.object(overflowFields).partial()), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  if (!(await one(pool, 'SELECT id FROM sewer_overflows WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Overflow');
  await checkFeature(t, b.map_feature_id);
  const set = []; const vals = [];
  for (const k of ['map_feature_id', 'location', 'gallons', 'cause', 'notes']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(b[k]); }
  for (const k of ['started_at', 'ended_at', 'reported_to_dep_at']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(dt(b[k])); }
  if (b.reached_water !== undefined) { set.push('reached_water = ?'); vals.push(b.reached_water ? 1 : 0); }
  if (!set.length) throw bad('Nothing to change');
  await pool.query(`UPDATE sewer_overflows SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t, id]);
  await audit(pool, req, 'update', 'sewer_overflows', id, Object.keys(b));
  res.json({ ok: true });
});

router.delete('/overflows/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM sewer_overflows WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Overflow');
  await audit(pool, req, 'delete', 'sewer_overflows', paramId(req));
  res.json({ ok: true });
});

module.exports = { router, report };
