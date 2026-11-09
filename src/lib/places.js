'use strict';

// Places patrol maps on the mountain (help/places): trail signs, lift towers, junctions, buildings. Each has a short sign
// code ("R7") printed on a help sign, and where it is. describe() turns a phone's position into the words patrollers use
// on the radio: "Near Summit Quad tower 7, about 30 m". No outside map service: the distance is the
// haversine over the mountain's own points, which is quick for a few thousand of them.
const { rows, one } = require('../db');

const KINDS = ['sign', 'tower', 'junction', 'building', 'lift_top', 'lift_bottom', 'park_feature', 'parking', 'other'];
const KIND_LABEL = {
  sign: 'Trail sign', tower: 'Lift tower', junction: 'Junction', building: 'Building', lift_top: 'Top of a lift', lift_bottom: 'Bottom of a lift',
  park_feature: 'Terrain park', parking: 'Parking', other: 'Other',
};
const CODE_RE = /^[A-Z0-9]{2,5}$/;
const R = 6371008.8; // mean earth radius, meters

/** Meters between two points. */
function haversine(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** How far to look: at least 150 m, three times the phone's accuracy, never past 600 m. */
const rangeFor = (accuracyM) => Math.min(600, Math.max(150, 3 * (Number.isFinite(Number(accuracyM)) && accuracyM !== null ? Number(accuracyM) : 50)));

/** A distance as a patroller says it: to 5 m close in, 10 m further out, 50 m past 200 m. */
function rounded(m) {
  const d = Math.max(0, Number(m) || 0);
  if (d < 50) return Math.max(5, Math.round(d / 5) * 5);
  if (d < 200) return Math.round(d / 10) * 10;
  return Math.round(d / 50) * 50;
}

const normalCode = (code) => String(code || '').trim().toUpperCase();
const validCode = (code) => CODE_RE.test(normalCode(code));

const SELECT = `SELECT p.id, p.kind, p.name, p.code, p.lift_id, p.tower_no, p.trail_id, p.lat, p.lng, p.accuracy_m, p.marked_by, p.marked_at, p.active,
  l.name AS lift_name, t.name AS trail_name
  FROM mountain_places p LEFT JOIN lifts l ON l.tenant_id = p.tenant_id AND l.id = p.lift_id LEFT JOIN trails t ON t.tenant_id = p.tenant_id AND t.id = p.trail_id`;
const shape = (p) => (p ? { ...p, lat: Number(p.lat), lng: Number(p.lng), active: Boolean(p.active), tower_no: p.tower_no === null ? null : Number(p.tower_no) } : null);

/** Every place on the mountain (retired ones too when all is set), by kind and name. */
async function list(db, tenantId, { all = false } = {}) {
  return (await rows(db, `${SELECT} WHERE p.tenant_id = ?${all ? '' : ' AND p.active = 1'} ORDER BY p.active DESC, p.kind, l.name, p.tower_no, p.name, p.id`, [tenantId])).map(shape);
}

/** The place a sign code is printed on, or null (a retired place is not found). */
async function byCode(db, tenantId, code) {
  const c = normalCode(code);
  if (!validCode(c)) return null;
  return shape(await one(db, `${SELECT} WHERE p.tenant_id = ? AND p.code = ? AND p.active = 1`, [tenantId, c]));
}

/** Places within `meters` of a point, nearest first, each with distance_m. */
async function near(db, tenantId, lat, lng, meters, { limit = 200 } = {}) {
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
  const found = await rows(db, `${SELECT} WHERE p.tenant_id = ? AND p.active = 1 AND p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?`,
    [tenantId, lat - dLat, lat + dLat, lng - dLng, lng + dLng]);
  return found.map(shape).map((p) => ({ ...p, distance_m: haversine(lat, lng, p.lat, p.lng) }))
    .filter((p) => p.distance_m <= meters).sort((a, b) => a.distance_m - b.distance_m).slice(0, limit);
}

/** What a place is called in the words: a tower by its lift and number, a lift end by its lift. */
function placeName(p, lang = 'en') {
  const es = lang === 'es';
  if (p.kind === 'tower' && p.lift_name && p.tower_no !== null) return es ? `la torre ${p.tower_no} de ${p.lift_name}` : `${p.lift_name} tower ${p.tower_no}`;
  if (p.kind === 'lift_top' && p.lift_name) return es ? `la parte de arriba de ${p.lift_name}` : `the top of ${p.lift_name}`;
  if (p.kind === 'lift_bottom' && p.lift_name) return es ? `la parte de abajo de ${p.lift_name}` : `the bottom of ${p.lift_name}`;
  if (p.kind === 'sign' && p.trail_name && !p.name) return p.trail_name;
  return p.name;
}

// On a tie (the same distance to the meter), a trail sign or junction is named first, then the others in this order.
const KIND_ORDER = ['sign', 'junction', 'building', 'lift_top', 'lift_bottom', 'tower', 'park_feature', 'parking', 'other'];
const kindRank = (p) => { const i = KIND_ORDER.indexOf(p.kind); return i < 0 ? KIND_ORDER.length : i; };
const byNearest = (a, b) => (Math.abs(a.distance_m - b.distance_m) >= 1 ? a.distance_m - b.distance_m : kindRank(a) - kindRank(b) || String(a.name || '').localeCompare(String(b.name || '')) || Number(a.id) - Number(b.id));
// "Between X and Y" only when both are this close and the phone is roughly on the line between them.
const BETWEEN_M = 60;
const BETWEEN_DEG = 140;

/** The angle at the phone between the directions to two places, 0 to 180 degrees (flat-earth, fine within 100 m). */
function angleAt(here, a, b) {
  const k = Math.cos(here.lat * Math.PI / 180);
  const v = (p) => [(p.lat - here.lat), (p.lng - here.lng) * k];
  const [ax, ay] = v(a); const [bx, by] = v(b);
  const la = Math.hypot(ax, ay); const lb = Math.hypot(bx, by);
  if (!la || !lb) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180 / Math.PI;
}

/**
 * A phone's position in the words patrollers use, in English and Spanish:
 *   "Near <nearest place>, about <its own distance> m", or "Between <nearest> (about a m) and <next> (about b m)" when
 *   both are within 60 m and the phone is between them, and "(location rough)" when the phone is out by more than 100 m.
 * A tower is named by its lift and number ("Near Summit Quad tower 7"). With no height data the words never say above or
 * below. When places are mapped but none is within range: "No mapped place within <range> m", with place_id null.
 * Returns { text, text_es, place_id, distance_m, confidence }, or null when the mountain has no mapped places.
 */
async function describe(db, tenantId, lat, lng, accuracyM) {
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const acc = accuracyM === null || accuracyM === undefined || !Number.isFinite(Number(accuracyM)) ? null : Math.max(0, Number(accuracyM));
  const range = rangeFor(acc);
  const found = await near(db, tenantId, lat, lng, range);
  if (found.length) return wordsFor(found, acc, { lat, lng });
  if (!(await one(db, 'SELECT 1 AS x FROM mountain_places WHERE tenant_id = ? AND active = 1 LIMIT 1', [tenantId]))) return null;
  return farWords(range);
}

/** The words when places are mapped but none is within range. */
const farWords = (range) => ({ text: `No mapped place within ${range} m`, text_es: `Ningún lugar marcado a menos de ${range} m`, place_id: null, distance_m: null, confidence: 'none' });

/**
 * The words from places already found (each with distance_m, and lat and lng for "between"). here: the phone's position.
 * Kept apart from the query for tests.
 */
function wordsFor(found, acc, here = null) {
  if (!found.length) return null;
  const list = [...found].sort(byNearest);
  const first = list[0];
  const d1 = first.distance_m;
  const name1 = placeName(first); const name1es = placeName(first, 'es');
  const second = here && d1 <= BETWEEN_M ? list.slice(1).find((p) => p.distance_m <= BETWEEN_M && placeName(p) !== name1
    && Number.isFinite(Number(p.lat)) && angleAt(here, first, p) >= BETWEEN_DEG) : null;
  let en; let es;
  if (second) {
    en = `Between ${name1} (about ${rounded(d1)} m) and ${placeName(second)} (about ${rounded(second.distance_m)} m)`;
    es = `Entre ${name1es} (a unos ${rounded(d1)} m) y ${placeName(second, 'es')} (a unos ${rounded(second.distance_m)} m)`;
  } else {
    en = `Near ${name1}, about ${rounded(d1)} m`;
    es = `Cerca de ${name1es}, a unos ${rounded(d1)} m`;
  }
  if (acc !== null && acc > 100) { en += ' (location rough)'; es += ' (ubicación aproximada)'; }
  const confidence = acc !== null && acc <= 30 && d1 <= 50 ? 'high' : (acc === null || acc <= 100) && d1 <= 200 ? 'medium' : 'low';
  return { text: en, text_es: es, place_id: Number(first.id), distance_m: Math.round(d1), confidence };
}

/** Initials of a name: "Summit Quad" -> "SQ", "Ridge Run" -> "RR". Letters and digits only. */
const initialsOf = (name) => String(name || '').normalize('NFKD').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('');

/**
 * A free sign code: a tower is its lift's initial and the tower number ("S7", or "SQ7" when S7 is taken); anything else
 * the trail's, lift's or its own name's initial and the next free number ("R1", "R2"). taken: Set of codes in use.
 */
function suggestCode({ kind, name, liftName, trailName, towerNo }, taken) {
  const has = (c) => taken.has(c);
  const base = initialsOf(kind === 'tower' || kind === 'lift_top' || kind === 'lift_bottom' ? (liftName || name) : (trailName || name || liftName)) || 'P';
  const one = base[0];
  const two = base.slice(0, 2);
  if (kind === 'tower' && towerNo !== null && towerNo !== undefined) {
    for (const p of [one, two, base.slice(0, 3)]) {
      const c = `${p}${towerNo}`;
      if (c.length >= 2 && c.length <= 5 && !has(c)) return c;
    }
  }
  if (kind === 'lift_top' || kind === 'lift_bottom') {
    const c = `${two}${kind === 'lift_top' ? 'T' : 'B'}`;
    if (c.length >= 2 && !has(c)) return c;
  }
  for (const p of [one, two]) {
    for (let n = 1; `${p}${n}`.length <= 5; n++) if (!has(`${p}${n}`)) return `${p}${n}`;
  }
  for (let n = 1; n < 100000; n++) if (!has(`P${n}`)) return `P${n}`;
  return null;
}

async function takenCodes(db, tenantId) {
  return new Set((await rows(db, 'SELECT code FROM mountain_places WHERE tenant_id = ?', [tenantId])).map((r) => r.code));
}

// ---------------------------------------------------------------- map orientation
// Most trail maps are drawn looking uphill, not north up. A mountain sets the compass direction at the top of its maps
// (tenants.map_rotation_deg): every map that plots GPS points is turned by it, never mirrored.
const norm360 = (d) => ((Math.round(Number(d)) % 360) + 360) % 360;

/** The compass bearing from one point to another, 0 to 360 (0 north, 90 east). */
function bearing(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
/** The average of bearings, as directions (350 and 10 average to 0, not 180). null when they cancel out. */
function meanBearing(list) {
  if (!list.length) return null;
  const r = Math.PI / 180;
  const s = list.reduce((a, d) => a + Math.sin(d * r), 0); const c = list.reduce((a, d) => a + Math.cos(d * r), 0);
  if (Math.hypot(s, c) < 1e-6 * list.length) return null;
  return (Math.atan2(s, c) / r + 360) % 360;
}
/**
 * Uphill: the average bearing from each lift's bottom to its top (mapped lift_bottom and lift_top places on the same lift),
 * or else from the mountain's map point (the base) to its summit weather point. { deg, from: 'lifts'|'weather', count } or null.
 */
async function uphill(db, tenantId) {
  const ends = await rows(db, "SELECT lift_id, kind, lat, lng FROM mountain_places WHERE tenant_id = ? AND active = 1 AND lift_id IS NOT NULL AND kind IN ('lift_bottom','lift_top')", [tenantId]);
  const byLift = new Map();
  for (const e of ends) { const k = Number(e.lift_id); if (!byLift.has(k)) byLift.set(k, {}); byLift.get(k)[e.kind] = e; }
  const lifts = [...byLift.values()].filter((x) => x.lift_bottom && x.lift_top)
    .map((x) => bearing(Number(x.lift_bottom.lat), Number(x.lift_bottom.lng), Number(x.lift_top.lat), Number(x.lift_top.lng)));
  const fromLifts = meanBearing(lifts);
  if (fromLifts !== null) return { deg: norm360(fromLifts), from: 'lifts', count: lifts.length };
  const t = await one(db, 'SELECT * FROM tenants WHERE id = ?', [tenantId]);
  if (t && t.map_lat !== null && t.map_lng !== null && t.wx_summit_lat !== null && t.wx_summit_lat !== undefined && t.wx_summit_lng !== null) {
    const a = [Number(t.map_lat), Number(t.map_lng)]; const b = [Number(t.wx_summit_lat), Number(t.wx_summit_lng)];
    if (haversine(a[0], a[1], b[0], b[1]) > 20) return { deg: norm360(bearing(a[0], a[1], b[0], b[1])), from: 'weather', count: 1 };
  }
  return null;
}
/**
 * How this mountain's maps are turned. By default the base is at the bottom and the summit at the top, as seen standing
 * at the base looking up: uphill, worked out again as lift ends are marked. Until it can be, north is up. A manual turn
 * set by an admin sticks until they go back to uphill up.
 * Returns { rotation_deg, mode: 'uphill'|'manual'|'north', manual_deg, uphill }.
 */
async function orientationOf(db, tenantId) {
  const t = await one(db, 'SELECT map_rotation_deg AS d FROM tenants WHERE id = ?', [tenantId]).catch(() => null);
  const manual = t && t.d !== null && t.d !== undefined ? norm360(t.d) : null;
  const up = await uphill(db, tenantId);
  if (manual !== null) return { rotation_deg: manual, mode: 'manual', manual_deg: manual, uphill: up };
  if (up) return { rotation_deg: up.deg, mode: 'uphill', manual_deg: null, uphill: up };
  return { rotation_deg: 0, mode: 'north', manual_deg: null, uphill: null };
}
/** The compass direction at the top of this mountain's maps. */
const rotationOf = async (db, tenantId) => (await orientationOf(db, tenantId)).rotation_deg;

// ---------------------------------------------------------------- CSV
const CSV_COLS = ['kind', 'name', 'code', 'lift', 'tower', 'trail', 'lat', 'lng'];

/** Rows of cells from CSV text (quotes, doubled quotes, commas and new lines inside quotes). */
function parseCsv(text) {
  const out = []; let row = []; let cell = ''; let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) out.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) out.push(row);
  return out;
}
// lib/csv.js puts a ' before a cell starting with - (a west longitude) so a spreadsheet does not run it: take it off.
const undefuse = (v) => String(v ?? '').trim().replace(/^'(?=[=+\-@])/, '');

module.exports = {
  KINDS, KIND_LABEL, CODE_RE, CSV_COLS, haversine, rangeFor, rounded, normalCode, validCode, list, byCode, near, describe, wordsFor, farWords, placeName,
  suggestCode, takenCodes, initialsOf, parseCsv, undefuse, bearing, meanBearing, uphill, rotationOf, orientationOf, norm360,
};
