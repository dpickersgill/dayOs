'use strict';

// A demo built on the visitor's own mountain. OpenStreetMap volunteers have mapped most ski areas: the area itself
// (landuse=winter_sports), its lifts (aerialway=*) and its runs (piste:type=downhill, with piste:difficulty). We ask the
// public Overpass API for them, by name within a US state, and the demo is then built with those real lifts and runs,
// centred on the real hill. Prices, staff, guests and cases stay made up.
//
//   find(name, state)   -> up to 6 ski areas whose name matches, best first, each with a county or town when known
//   details(ref)        -> { name, lat, lng, zoom, city, state, lifts, trails, preview } (cached for 7 days)
//
// OVERPASS_URLS (comma separated) overrides the servers, tried in order; tests point it at a stub. Data © OpenStreetMap
// contributors, under the Open Database License: the demo and the "is this you?" step both say so.
const { pool, one } = require('../db');
const { logFailure } = require('./jobs');

// Public Overpass servers, tried in order: the main one is often busy, so there are two others behind it.
const SERVERS = () => (process.env.OVERPASS_URLS || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter').split(',').map((s) => s.trim()).filter(Boolean);
const UA = 'Verdynt/OS demo builder (https://www.runmyresort.com; hello@runmyresort.com)';
const CACHE_DAYS = 7;
const MAX_LIFTS = 25;
const MAX_TRAILS = 60;

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
// Good enough for a demo: the zone most of each state's ski areas are in.
const ZONE = { AK: 'America/Anchorage', HI: 'Pacific/Honolulu', AZ: 'America/Phoenix', CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  CO: 'America/Denver', ID: 'America/Boise', MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago', IL: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago',
  ND: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago' };
const zoneOf = (st) => ZONE[st] || 'America/New_York';

// Words that do not tell one ski area from another, left out of the name search (but still used to rank).
const STOP = new Set(['ski', 'skiing', 'area', 'resort', 'resorts', 'the', 'and', 'at', 'of', 'mountain', 'mountains', 'mt', 'mount', 'hill', 'hills', 'valley',
  'adventures', 'snow', 'snowsports', 'sports', 'club', 'center', 'centre', 'park', 'inc', 'llc', 'co', 'company', 'ridge', 'peak', 'lodge', 'bowl']);
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
const keyWords = (s) => { const w = words(s); const k = w.filter((x) => !STOP.has(x) && x.length > 1); return (k.length ? k : w).slice(0, 6); };

/** The search: every named ski area in the state whose name has one of the telling words. */
function searchQuery(name, state) {
  const k = keyWords(name);
  if (!k.length) throw new Error('Type your mountain’s name');
  const re = k.join('|'); // letters and digits only, so nothing to escape
  return `[out:json][timeout:25];
area["ISO3166-2"="US-${state}"]["admin_level"="4"]->.s;
(
  way["landuse"="winter_sports"]["name"~"${re}",i](area.s);
  relation["landuse"="winter_sports"]["name"~"${re}",i](area.s);
);
out center 60;`;
}

/** Ranks matches by how many of the typed words each name has, then by having the whole phrase. */
function rank(typed, elements) {
  const want = words(typed);
  const telling = keyWords(typed);
  const seen = new Map();
  for (const e of elements || []) {
    const name = e.tags && e.tags.name;
    const c = e.center || (e.lat !== undefined ? { lat: e.lat, lon: e.lon } : null);
    if (!name || !c) continue;
    const have = new Set(words(name));
    const score = telling.filter((w) => have.has(w)).length * 10 + want.filter((w) => have.has(w)).length + (String(name).toLowerCase().includes(String(typed).toLowerCase().trim()) ? 5 : 0);
    if (!telling.some((w) => have.has(w))) continue;
    const key = String(name).toLowerCase();
    // One ski area is often several polygons with the same name: keep the first (the search lists bigger ones first often enough)
    if (seen.has(key)) continue;
    seen.set(key, { ref: `${e.type}/${e.id}`, name: String(name).slice(0, 80), lat: round(c.lat), lng: round(c.lon), city: (e.tags['addr:city'] || null), website: e.tags.website || null, score });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 6).map(({ score, ...r }) => r);
}
const round = (n) => Math.round(Number(n) * 1e6) / 1e6;

/** For each match without a town, the town or county it is in (one request for all of them). */
function placesQuery(list) {
  const parts = list.map((r, i) => `is_in(${r.lat},${r.lng})->.p${i};area.p${i}["boundary"="administrative"]["admin_level"~"^(6|7|8)$"];out;make sep i="${i}";out;`);
  return `[out:json][timeout:20];\n${parts.join('\n')}`;
}
function parsePlaces(elements, count) {
  const out = Array(count).fill(null);
  let bucket = [];
  for (const e of elements || []) {
    if (e.type === 'sep') {
      const i = Number(e.tags && e.tags.i);
      const pick = [...bucket].sort((a, b) => Number(b.tags.admin_level) - Number(a.tags.admin_level))[0];
      if (i >= 0 && i < count && pick) out[i] = pick.tags.name;
      bucket = [];
    } else if (e.tags && e.tags.name) bucket.push(e);
  }
  return out;
}

/** Everything inside or near one ski area: the area's own tags, then its lifts and runs with their lines. */
function detailQuery(ref) {
  const m = /^(way|relation)\/(\d{1,12})$/.exec(String(ref));
  if (!m) throw new Error('Not a ski area');
  return `[out:json][timeout:30];
${m[1]}(${m[2]})->.a;
.a out center;
(.a; .a >;)->.g;
.a map_to_area->.aa;
(
  way["piste:type"="downhill"](area.aa);
  way["piste:type"="downhill"](around.g:250);
  way["aerialway"](area.aa);
  way["aerialway"](around.g:250);
);
out geom;`;
}

const LIFT_KINDS = { cable_car: 'Tram', gondola: 'Gondola', mixed_lift: 'Chondola', chair_lift: 'Chairlift', drag_lift: 'Surface lift', 't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'Platter lift', rope_tow: 'Rope tow', magic_carpet: 'Magic carpet' };
const SEATS = { 2: 'Double', 3: 'Triple', 4: 'Quad', 6: 'Six-pack', 8: 'Eight-pack' };
function difficultyOf(tags, name) {
  if (/\b(terrain park|park|jib|rail garden|half ?pipe|superpipe)\b/i.test(name || '')) return 'park';
  const d = String(tags['piste:difficulty'] || '').toLowerCase();
  if (['novice', 'easy'].includes(d)) return 'green';
  if (d === 'intermediate') return 'blue';
  if (d === 'advanced') return 'black';
  if (['expert', 'freeride', 'extreme'].includes(d)) return 'double_black';
  return 'blue';
}
const RANK = { green: 0, blue: 1, park: 1, black: 2, double_black: 3 };
const mid = (g) => (g && g.length ? g[Math.floor(g.length / 2)] : null);

/** The area's name and centre, its lifts and runs (named runs only; segments of one run are joined), and a small drawing. */
function parseDetails(ref, elements, state) {
  const area = (elements || []).find((e) => `${e.type}/${e.id}` === ref);
  if (!area || !area.tags) return null;
  const lifts = []; const trails = new Map(); const lines = [];
  let unnamed = 0;
  const liftN = {};
  for (const e of elements) {
    if (e.type !== 'way' || !e.tags || !Array.isArray(e.geometry)) continue;
    const t = e.tags;
    if (t.aerialway && LIFT_KINDS[t.aerialway]) {
      const occ = Number(t['aerialway:occupancy']);
      const label = t.aerialway === 'chair_lift' && SEATS[occ] ? SEATS[occ] : LIFT_KINDS[t.aerialway];
      if (!t.name) liftN[label] = (liftN[label] || 0) + 1; // an unnamed lift is called by its kind: "Double 1"
      const name = String(t.name || `${label} ${liftN[label]}`).slice(0, 100);
      if (!lifts.some((l) => l.name.toLowerCase() === name.toLowerCase())) lifts.push({ name, kind: t.aerialway, small: ['rope_tow', 'magic_carpet', 'platter', 'j-bar'].includes(t.aerialway) });
      lines.push({ k: 'lift', g: e.geometry });
    } else if (t['piste:type'] === 'downhill') {
      const name = t['piste:name'] || t.name;
      const difficulty = difficultyOf(t, name);
      lines.push({ k: difficulty, g: e.geometry });
      if (!name) { unnamed += 1; continue; }
      const key = String(name).toLowerCase().trim();
      const p = mid(e.geometry);
      const had = trails.get(key);
      if (!had) trails.set(key, { name: String(name).trim().slice(0, 100), difficulty, lat: p ? round(p.lat) : null, lng: p ? round(p.lon) : null });
      else if (had.difficulty !== 'park' && RANK[difficulty] > RANK[had.difficulty]) had.difficulty = difficulty; // a run is as hard as its hardest part
    }
  }
  const c = area.center || {};
  const all = lines.flatMap((l) => l.g);
  const zoom = zoomFor(all) || 15;
  const trailList = [...trails.values()].sort((a, b) => RANK[a.difficulty] - RANK[b.difficulty] || a.name.localeCompare(b.name)).slice(0, MAX_TRAILS);
  return {
    ref, name: String(area.tags.name || 'Ski area').slice(0, 80), lat: round(c.lat), lng: round(c.lon), zoom, state, timezone: zoneOf(state),
    city: area.tags['addr:city'] || null, website: area.tags.website || null,
    lifts: lifts.slice(0, MAX_LIFTS), trails: trailList, unnamed_runs: unnamed,
    preview: drawing(lines),
  };
}

/** A map zoom that fits these points on a phone screen. */
function zoomFor(pts) {
  if (!pts.length) return null;
  const lats = pts.map((p) => p.lat); const lons = pts.map((p) => p.lon);
  const span = Math.max(Math.max(...lats) - Math.min(...lats), (Math.max(...lons) - Math.min(...lons)) * Math.cos((Math.min(...lats) * Math.PI) / 180));
  if (!(span > 0)) return 16;
  return Math.max(12, Math.min(17, Math.floor(Math.log2(0.02 / span) + 16)));
}

/** Lines in a 400 by 300 box, north up, for the "is this you?" picture. Coordinates only: nothing else leaves the server. */
function drawing(lines) {
  const pts = lines.flatMap((l) => l.g);
  if (!pts.length) return { w: 400, h: 300, lines: [] };
  const minLat = Math.min(...pts.map((p) => p.lat)); const maxLat = Math.max(...pts.map((p) => p.lat));
  const minLon = Math.min(...pts.map((p) => p.lon)); const maxLon = Math.max(...pts.map((p) => p.lon));
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = (maxLon - minLon) * kx || 1e-6; const hgt = (maxLat - minLat) || 1e-6;
  const s = Math.min(380 / w, 280 / hgt);
  const ox = (400 - w * s) / 2; const oy = (300 - hgt * s) / 2;
  const at = (p) => [Math.round((ox + (p.lon - minLon) * kx * s) * 10) / 10, Math.round((oy + (maxLat - p.lat) * s) * 10) / 10];
  return {
    w: 400, h: 300,
    lines: lines.slice(0, 400).map((l) => {
      const step = Math.max(1, Math.ceil(l.g.length / 30));
      const keep = l.g.filter((_p, i) => i % step === 0 || i === l.g.length - 1);
      return { k: l.k, d: keep.map((p, i) => `${i ? 'L' : 'M'}${at(p).join(' ')}`).join('') };
    }),
  };
}

/** Why one server did not answer, in a line for the log: its status and the start of what it said, or the network error. */
const plain = (t) => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
async function overpass(query) {
  const tried = [];
  for (const url of SERVERS()) {
    const host = (() => { try { return new URL(url).host; } catch (_) { return url; } })();
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(35_000) });
      const text = await r.text();
      if (!r.ok) { tried.push(`${host} ${r.status}: ${plain(text)}`); continue; }
      let j;
      try { j = JSON.parse(text); } catch (_) { tried.push(`${host} ${r.status}, not JSON: ${plain(text)}`); continue; }
      if (j.remark && !(j.elements || []).length) { tried.push(`${host} remark: ${plain(j.remark)}`); continue; } // a timeout or query error inside a 200
      return j.elements || [];
    } catch (e) {
      tried.push(`${host}: ${e.name === 'TimeoutError' ? 'no answer in 35 seconds' : `${(e.cause && e.cause.code) || e.name} ${e.message}`}`);
    }
  }
  logFailure({ job: 'ski_area_lookup', message: tried.join(' | ') || 'no Overpass server set', query: query.slice(0, 600) });
  const err = new Error('The map service is not answering right now'); err.unavailable = true; throw err;
}

async function find(name, state) {
  if (!STATES[state]) throw new Error('Choose a state');
  const list = rank(name, await overpass(searchQuery(name, state)));
  const need = list.filter((r) => !r.city);
  if (need.length) {
    try {
      const places = parsePlaces(await overpass(placesQuery(need)), need.length);
      need.forEach((r, i) => { r.city = places[i]; });
    } catch (_) { /* the town is a nicety */ }
  }
  return list.map((r) => ({ ...r, state }));
}

/** The details for one area, from the cache when fresh. */
async function details(ref, state) {
  const hit = await one(pool, 'SELECT data FROM ski_area_cache WHERE ref = ? AND fetched_at > NOW() - INTERVAL ? DAY', [ref, CACHE_DAYS]);
  if (hit) { const d = JSON.parse(hit.data); if (!state || d.state === state) return d; }
  const d = parseDetails(ref, await overpass(detailQuery(ref)), state);
  if (!d) return null;
  await pool.query('INSERT INTO ski_area_cache (ref, name, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), data = VALUES(data), fetched_at = NOW()', [ref, d.name, JSON.stringify(d)]);
  return d;
}

/** What the demo loader needs (small enough to pass in an environment variable). */
const forLoader = (d) => ({ name: d.name, lat: d.lat, lng: d.lng, zoom: d.zoom, city: d.city, state: d.state, timezone: d.timezone, lifts: d.lifts, trails: d.trails });

module.exports = { STATES, zoneOf, keyWords, searchQuery, rank, placesQuery, parsePlaces, detailQuery, difficultyOf, parseDetails, drawing, find, details, forLoader };
