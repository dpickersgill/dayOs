'use strict';

// PHASE 1 STAND-IN for src/lib/collection.js (workstream "schedule" owns the real one). Same signatures as the release
// spec, simplified: weekly / every-other-week / monthly streams with an anchor date and a season, the holiday rule
// 'shift' / 'skip' / 'none', and collection_changes (moved or canceled). lib/collectionroutes.js uses the real library
// when it is there and this file only when it is not, so nothing changes when the two are merged; the assembler deletes
// this file.
const { rows, one, pool } = require('../db');
const { addDays, weekdayOf } = require('./util');
const { AppError } = require('./errors');

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const wd17 = (date) => { const w = weekdayOf(date); return w === 0 ? 7 : w; }; // 1 = Monday .. 7 = Sunday
const zoneIdsOf = (v) => { if (!v) return []; try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number) : []; } catch { return []; } };
const inZones = (ids, zoneId) => !ids.length || ids.includes(Number(zoneId));
const houseNo = (s) => { const m = /^\s*(\d{1,7})/.exec(String(s || '')); return m ? Number(m[1]) : null; };

function sideOk(row, n) {
  if (n === null) return row.from_no === null && row.to_no === null;
  if (row.from_no !== null && n < Number(row.from_no)) return false;
  if (row.to_no !== null && n > Number(row.to_no)) return false;
  if (row.side === 'odd' && n % 2 === 0) return false;
  if (row.side === 'even' && n % 2 === 1) return false;
  return true;
}

async function zoneFor(conn, tenantId, { streetId, houseNo: no }) {
  const list = await rows(conn, `SELECT s.zone_id, s.from_no, s.to_no, s.side, s.not_collected, z.name AS zone_name FROM collection_zone_streets s
    LEFT JOIN collection_zones z ON z.tenant_id = s.tenant_id AND z.id = s.zone_id WHERE s.tenant_id = ? AND s.street_id = ? ORDER BY (s.from_no IS NULL AND s.to_no IS NULL AND s.side = 'both'), s.id`, [tenantId, streetId]);
  const n = houseNo(no);
  const hit = list.find((r) => sideOk(r, n)) || list.find((r) => r.from_no === null && r.to_no === null);
  if (!hit) return null;
  if (Number(hit.not_collected) || !hit.zone_id) return { notCollected: true };
  return { zoneId: Number(hit.zone_id), zoneName: hit.zone_name };
}

function inSeason(s, date) {
  if (!s.season_start || !s.season_end) return true;
  const md = date.slice(5);
  return s.season_start <= s.season_end ? md >= s.season_start && md <= s.season_end : md >= s.season_start || md <= s.season_end;
}
/** Does the stream run in the week of this (original) date? */
function runsOn(s, date) {
  if (!inSeason(s, date)) return false;
  if (s.frequency === 'weekly' || !s.anchor_date) return true;
  const a = iso(s.anchor_date);
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  if (s.frequency === 'biweekly') return ((Math.floor(days / 7) % 2) + 2) % 2 === 0;
  return Math.floor((Number(a.slice(8)) - 1) / 7) === Math.floor((Number(date.slice(8)) - 1) / 7); // monthly: the same week of the month
}

async function plan(conn, tenantId, from, to) {
  const [streams, days, holidays, changes, settings] = await Promise.all([
    rows(conn, 'SELECT * FROM collection_streams WHERE tenant_id = ? AND active = 1 ORDER BY sort, id', [tenantId]),
    rows(conn, 'SELECT d.zone_id, d.stream_id, d.weekday, z.name AS zone_name, z.sort FROM collection_zone_days d JOIN collection_zones z ON z.tenant_id = d.tenant_id AND z.id = d.zone_id AND z.active = 1 WHERE d.tenant_id = ?', [tenantId]),
    rows(conn, 'SELECT on_date FROM collection_holidays WHERE tenant_id = ? AND on_date BETWEEN ? AND ?', [tenantId, addDays(from, -7), addDays(to, 7)]),
    rows(conn, 'SELECT on_date, moved_to, zone_ids, reason FROM collection_changes WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY id', [tenantId, addDays(from, -14), addDays(to, 14)]),
    one(conn, 'SELECT holiday_rule FROM collection_settings WHERE tenant_id = ?', [tenantId]),
  ]);
  const rule = (settings && settings.holiday_rule) || 'shift';
  const hol = new Set(holidays.map((h) => iso(h.on_date)));
  const byId = new Map(streams.map((s) => [Number(s.id), s]));
  const out = [];
  // Every original day from a week before to the end, so a day moved forward into the range is found.
  for (let d = addDays(from, -7); d <= to; d = addDays(d, 1)) {
    const w = wd17(d);
    for (const zd of days) {
      if (Number(zd.weekday) !== w) continue;
      const s = byId.get(Number(zd.stream_id));
      if (!s || !runsOn(s, d)) continue;
      let date = d; let moved = false; let reason;
      if (rule !== 'none' && w <= 6) {
        // A holiday on or before this day in the same Monday-Saturday week.
        let hit = false;
        for (let k = 0; k < w; k += 1) if (hol.has(addDays(d, -k))) hit = true;
        if (hit && rule === 'skip' && hol.has(d)) continue;
        if (hit && rule === 'shift') { date = addDays(d, 1); moved = true; reason = 'holiday'; }
      }
      const ch = changes.filter((c) => iso(c.on_date) === d && inZones(zoneIdsOf(c.zone_ids), zd.zone_id)).pop();
      if (ch) {
        if (!ch.moved_to) continue;
        date = iso(ch.moved_to); moved = true; reason = ch.reason;
      }
      if (date < from || date > to) continue;
      out.push({ date, zoneId: Number(zd.zone_id), zoneName: zd.zone_name, zoneSort: Number(zd.sort || 0), streamId: Number(s.id), streamName: s.name, kind: s.kind, original: d, moved, ...(reason ? { reason } : {}) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.zoneSort - b.zoneSort || a.streamId - b.streamId);
}

async function collectionDays(conn, tenantId, { zoneId, from, to }) {
  return (await plan(conn, tenantId, from, to)).filter((x) => x.zoneId === Number(zoneId)).map(({ date, streamId, streamName, kind, original, moved, reason }) => ({ date, streamId, streamName, kind, original, moved, ...(reason ? { reason } : {}) }));
}

async function nextFor(conn, tenantId, { zoneId, today }) {
  const list = await collectionDays(conn, tenantId, { zoneId, from: today, to: addDays(today, 62) });
  const out = new Map();
  for (const x of list) if (!out.has(x.streamId)) out.set(x.streamId, x);
  return [...out.values()];
}

async function dayRoutes(conn, tenantId, date) {
  const list = (await plan(conn, tenantId, date, date));
  if (!list.length) return [];
  const zoneIds = [...new Set(list.map((x) => x.zoneId))];
  const streets = await rows(conn, `SELECT s.zone_id, s.street_id, s.from_no, s.to_no, s.side, st.name FROM collection_zone_streets s JOIN streets st ON st.tenant_id = s.tenant_id AND st.id = s.street_id
    WHERE s.tenant_id = ? AND s.zone_id IN (?) AND s.not_collected = 0`, [tenantId, zoneIds]);
  // The bulk route order for the weekday (0 = Sunday), else by name.
  const order = new Map((await rows(conn, 'SELECT street_id, position FROM bulk_route_order WHERE tenant_id = ? AND weekday = ?', [tenantId, weekdayOf(date)])).map((r) => [Number(r.street_id), Number(r.position)]));
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const key = `${x.zoneId}|${x.streamId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const st = streets.filter((s) => Number(s.zone_id) === x.zoneId).map((s) => ({ streetId: Number(s.street_id), name: s.name, fromNo: s.from_no === null ? null : Number(s.from_no), toNo: s.to_no === null ? null : Number(s.to_no), side: s.side }))
      .sort((a, b) => { const pa = order.get(a.streetId); const pb = order.get(b.streetId); if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb; if (pa !== undefined && pb === undefined) return -1; if (pb !== undefined && pa === undefined) return 1; return a.name.localeCompare(b.name) || (a.fromNo || 0) - (b.fromNo || 0); });
    out.push({ zoneId: x.zoneId, zoneName: x.zoneName, streamId: x.streamId, streamName: x.streamName, kind: x.kind, streets: st });
  }
  return out;
}

/** 403 module_disabled unless this add-on is on (and Trash and recycling with it); never for a ski area. */
function requireAddon(key) {
  return (req, _res, next) => {
    (async () => {
      if (!(await addonOn(req.auth.tenantId, key))) {
        const M = require('./modules');
        const s = await M.stateOf(req.auth.tenantId);
        const labels = { collectionroutes: 'Collection routes (add-on)', hauler: 'Hauler oversight (add-on)' };
        const e = new AppError(403, `${labels[key] || key} is not turned on for your ${s.org === 'municipality' ? 'municipality' : 'mountain'}`);
        e.details = { code: 'module_disabled', module: key };
        throw e;
      }
    })().then(() => next(), next);
  };
}
/** Is the add-on on? Until "schedule" adds the keys to lib/modules.js, an unknown key is read from tenant_modules. */
async function addonOn(tenantId, key) {
  const M = require('./modules');
  const s = await M.stateOf(tenantId);
  if (s.org !== 'municipality' || s.status !== 'active' || !s.on.has('solidwaste')) return false;
  if (M.MODULES.some((m) => m.key === key)) return s.on.has(key);
  const r = await one(pool, 'SELECT enabled FROM tenant_modules WHERE tenant_id = ? AND module = ?', [tenantId, key]);
  return Boolean(r && Number(r.enabled));
}

module.exports = { zoneFor, collectionDays, nextFor, dayRoutes, requireAddon, addonOn };
