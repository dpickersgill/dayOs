'use strict';

// Places patrol maps on the mountain (help/places): trail signs, lift towers, junctions, buildings. Each has a short sign
// code ("R7") printed on a help sign, and where it is. describe() turns a phone's position into the words patrollers use
// on the radio: "Near Ridge Run, below Summit Quad tower 7, about 30 m". No outside map service: the distance is the
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

// What a guest or patroller is near, first choice first: a trail sign or junction, then anything but a tower.
const ANCHOR = (p) => p.kind === 'sign' || p.kind === 'junction';

/**
 * A phone's position in the words patrollers use, in English and Spanish:
 *   "Near <trail sign or junction>" (or the nearest other place), ", below <lift> tower <n>" when a tower is in range,
 *   ", about <n> m" from the nearest point, and "(location rough)" when the phone is out by more than 100 m.
 * Returns { text, text_es, place_id, distance_m, confidence }, or null when nothing is mapped near.
 */
async function describe(db, tenantId, lat, lng, accuracyM) {
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const acc = accuracyM === null || accuracyM === undefined || !Number.isFinite(Number(accuracyM)) ? null : Math.max(0, Number(accuracyM));
  const found = await near(db, tenantId, lat, lng, rangeFor(acc));
  return wordsFor(found, acc);
}

/** The words from places already found (nearest first, each with distance_m). Kept apart from the query for tests. */
function wordsFor(found, acc) {
  if (!found.length) return null;
  const nearest = found[0];
  const anchor = found.find(ANCHOR) || found.find((p) => p.kind !== 'tower') || null;
  const tower = found.find((p) => p.kind === 'tower' && p.lift_name && p.tower_no !== null);
  const about = rounded(nearest.distance_m);
  const rough = acc !== null && acc > 100;
  let en; let es;
  if (anchor) {
    en = `Near ${placeName(anchor)}`; es = `Cerca de ${placeName(anchor, 'es')}`;
    if (tower) { en += `, below ${placeName(tower)}`; es += `, debajo de ${placeName(tower, 'es')}`; }
  } else {
    en = `Below ${placeName(tower)}`; es = `Debajo de ${placeName(tower, 'es')}`;
  }
  en += `, about ${about} m`; es += `, a unos ${about} m`;
  if (rough) { en += ' (location rough)'; es += ' (ubicación aproximada)'; }
  const d = nearest.distance_m;
  const confidence = acc !== null && acc <= 30 && d <= 50 ? 'high' : (acc === null || acc <= 100) && d <= 200 ? 'medium' : 'low';
  return { text: en, text_es: es, place_id: Number((anchor || tower).id), distance_m: Math.round(d), confidence };
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
  KINDS, KIND_LABEL, CODE_RE, CSV_COLS, haversine, rangeFor, rounded, normalCode, validCode, list, byCode, near, describe, wordsFor, placeName,
  suggestCode, takenCodes, initialsOf, parseCsv, undefuse,
};
