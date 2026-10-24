#!/usr/bin/env node
'use strict';

// Builds our own copy of every US ski area with its lifts and runs, for demos built on the visitor's own mountain.
// The public map servers are too busy to ask live, so the demo page searches this file instead.
//
//   node scripts/ski-areas-build.js data/ski-areas-us.json.gz     (default: ./ski-areas-us.json.gz)
// Written into data/ before `bash deploy.sh`, it goes live with that deploy (deploy.sh uploads the folder).
//
// It downloads OpenSkiData's three GeoJSON files (ski areas, lifts, runs; rebuilt daily from OpenStreetMap by
// OpenSkiMap.org), reads them as a stream so memory stays small, keeps US ski areas with downhill skiing and the lifts and
// runs that belong to them, trims each line to a few points, and writes one gzipped JSON file of a few megabytes.
// Run it in Cloud Shell (it needs the internet), then attach the file in the chat so it is added to the app.
// OpenSkiData allows automated downloads at most once a day. Data under the Open Database License:
// "Data from OpenSkiData / OpenSkiMap.org, © OpenStreetMap contributors (ODbL), Skimap.org, Who's On First, © Mapterhorn".
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { Readable } = require('stream');

const BASE = (process.env.OPENSKIDATA_URL || 'https://tiles.openskimap.org/geojson').replace(/\/$/, '');
const OUT = path.resolve(process.argv[2] || 'ski-areas-us.json.gz');
const UA = 'Verdynt/OS ski area import (https://www.runmyresort.com; hello@runmyresort.com)';
const COUNTRY = (process.env.SKI_COUNTRY || 'US').toUpperCase();
const KEEP_LIFTS = new Set(['cable_car', 'gondola', 'chair_lift', 'mixed_lift', 'drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow', 'magic_carpet']);
const POINTS = 12; // per line, enough for a small drawing and a pin on the run
const r5 = (n) => Math.round(Number(n) * 1e5) / 1e5;

/**
 * Each GeoJSON feature in a downloaded file, one at a time, however the file is laid out. A small scanner finds every
 * object that sits directly inside the root's arrays, so the whole file is never held in memory.
 */
async function* features(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  let stream = Readable.fromWeb(res.body);
  // Served gzipped either way: decompressed by fetch when sent as an encoding, or here when it is a .gz file.
  const first = await new Promise((resolve, reject) => { stream.once('readable', () => resolve(stream.read(2))); stream.once('error', reject); });
  if (first) stream.unshift(first);
  if (first && first[0] === 0x1f && first[1] === 0x8b) stream = stream.pipe(zlib.createGunzip());
  let depth = 0; let inStr = false; let esc = false; let parts = null; let startAt = -1;
  for await (const chunk of stream) {
    startAt = parts ? 0 : -1;
    for (let i = 0; i < chunk.length; i += 1) {
      const c = chunk[i];
      if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue; }
      if (c === 0x22) { inStr = true; continue; }
      if (c === 0x7b || c === 0x5b) { // { or [
        depth += 1;
        if (c === 0x7b && depth === 3 && !parts) { parts = []; startAt = i; }
      } else if (c === 0x7d || c === 0x5d) { // } or ]
        if (c === 0x7d && depth === 3 && parts) {
          parts.push(chunk.subarray(startAt, i + 1));
          const text = Buffer.concat(parts).toString('utf8');
          parts = null; startAt = -1;
          let f = null;
          try { f = JSON.parse(text); } catch (_) { f = null; }
          if (f && f.type === 'Feature') yield f;
        }
        depth -= 1;
      }
    }
    if (parts) parts.push(chunk.subarray(startAt === -1 ? 0 : startAt));
  }
}

/** The line's points as [lat, lng], at most POINTS of them, first and last kept. */
function line(geometry) {
  if (!geometry) return [];
  let pts = [];
  if (geometry.type === 'LineString') pts = geometry.coordinates;
  else if (geometry.type === 'MultiLineString') pts = geometry.coordinates.flat();
  else if (geometry.type === 'Polygon') pts = geometry.coordinates[0] || [];
  else if (geometry.type === 'MultiPolygon') pts = (geometry.coordinates[0] || [])[0] || [];
  if (!pts.length) return [];
  const step = Math.max(1, Math.ceil(pts.length / POINTS));
  return pts.filter((_p, i) => i % step === 0 || i === pts.length - 1).map((p) => [r5(p[1]), r5(p[0])]);
}
const placeOf = (places) => (places || []).find((p) => p && p.iso3166_1Alpha2 === COUNTRY) || null;
const refOf = (props) => {
  const s = (props.sources || []).find((x) => x.type === 'openstreetmap') || (props.sources || [])[0];
  if (!s) return null;
  const id = String(s.id);
  if (s.type === 'openstreetmap') return /^(way|relation|node)\/\d+$/.test(id) ? id : /^\d+$/.test(id) ? `osm/${id}` : null;
  return /^\d+$/.test(id) ? `skimap/${id}` : null;
};

async function main() {
  const started = Date.now();
  const areas = new Map(); // OpenSkiData id -> our record
  let seen = 0;
  console.log(`Reading ski areas from ${BASE}/ski_areas.geojson`);
  for await (const f of features(`${BASE}/ski_areas.geojson`)) {
    seen += 1;
    const p = f.properties || {};
    const place = placeOf(p.places);
    if (!place || !p.name || !(p.activities || []).includes('downhill')) continue;
    if (p.status && p.status !== 'operating') continue;
    const ref = refOf(p);
    if (!ref) continue;
    const vc = p.viewportHint && Array.isArray(p.viewportHint.center) ? p.viewportHint.center : null;
    const g = f.geometry && f.geometry.type === 'Point' ? f.geometry.coordinates : null;
    const center = vc || g || (line(f.geometry)[0] ? [line(f.geometry)[0][1], line(f.geometry)[0][0]] : null);
    if (!center) continue;
    const loc = place.localized && place.localized.en ? place.localized.en : {};
    areas.set(p.id, { ref, name: String(p.name).slice(0, 80), state: place.iso3166_2 ? String(place.iso3166_2).split('-').pop() : null, city: loc.locality || null,
      lat: r5(center[1]), lng: r5(center[0]), website: (p.websites || [])[0] || null, lifts: [], runs: [] });
  }
  console.log(`  ${seen} ski areas in the file, ${areas.size} in ${COUNTRY} with downhill skiing`);

  const owner = (p) => (p.skiAreas || []).map((s) => (s.properties || {}).id).find((id) => areas.has(id));
  let lifts = 0;
  console.log('Reading lifts');
  for await (const f of features(`${BASE}/lifts.geojson`)) {
    const p = f.properties || {};
    if (!KEEP_LIFTS.has(p.liftType) || (p.status && p.status !== 'operating') || p.access === 'private') continue;
    const id = owner(p);
    if (!id) continue;
    areas.get(id).lifts.push([p.name ? String(p.name).slice(0, 100) : null, p.liftType, p.occupancy || null, line(f.geometry)]);
    lifts += 1;
  }
  console.log(`  ${lifts} lifts kept`);
  let runs = 0;
  console.log('Reading runs (the biggest file: a few minutes)');
  for await (const f of features(`${BASE}/runs.geojson`)) {
    const p = f.properties || {};
    if (!(p.uses || []).includes('downhill')) continue;
    const id = owner(p);
    if (!id) continue;
    areas.get(id).runs.push([p.name ? String(p.name).slice(0, 100) : null, p.difficulty || null, line(f.geometry)]);
    runs += 1;
    if (runs % 5000 === 0) console.log(`  ${runs} runs so far`);
  }
  console.log(`  ${runs} runs kept`);

  const list = [...areas.values()].filter((a) => a.state && a.lifts.length + a.runs.length > 0).sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
  const data = { built_at: new Date().toISOString(), country: COUNTRY, credit: 'Data from OpenSkiData / OpenSkiMap.org, © OpenStreetMap contributors (ODbL), Skimap.org, Who’s On First, © Mapterhorn', areas: list };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 }));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`\nWrote ${list.length} ski areas to ${OUT} (${kb} KB) in ${Math.round((Date.now() - started) / 1000)} seconds.`);
  const sample = list.filter((a) => a.state === 'PA').slice(0, 8);
  for (const a of sample) console.log(`  ${a.name}, ${a.city || '?'} ${a.state}: ${a.lifts.length} lifts, ${a.runs.filter((x) => x[0]).length} named runs`);
  console.log('\nNext: run bash deploy.sh from this folder so it goes live, and attach the file in the chat so every later release keeps it.');
}

if (require.main === module) main().catch((e) => { console.error(`Stopped: ${e.message}`); process.exit(1); });
module.exports = { features, line };
