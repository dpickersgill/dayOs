'use strict';

// The asset map (Assets and fleet, Map): what lies where on the mountain. Points for things in one place (a valve, a
// hydrant, a pump house, a transformer), lines for what runs between places (a snowmaking water or air line, a power
// line, a sewer or fibre run) and areas for what covers ground (a pond, a building). Each belongs to a system, drawn in
// that system's color and toggled as a layer. A point or area can be tied to an asset in the register, so the map and
// the asset's record point at each other.

// [key, label, geometry, system]. Every kind is for both kinds of tenant unless it says otherwise below.
const KINDS = [
  ['valve', 'Valve', 'point', 'water'], ['hydrant', 'Snowmaking hydrant', 'point', 'water'], ['pump', 'Pump', 'point', 'water'],
  ['pump_house', 'Pump house', 'point', 'water'], ['meter', 'Meter', 'point', 'water'], ['vault', 'Vault or manhole', 'point', 'water'],
  ['intake', 'Intake or well', 'point', 'water'], ['tank', 'Tank', 'point', 'water'], ['drain', 'Drain or low-point bleed', 'point', 'water'],
  ['water_line', 'Snowmaking water line', 'line', 'water'], ['potable_line', 'Drinking water line', 'line', 'potable'],
  ['air_line', 'Snowmaking air line', 'line', 'air'], ['compressor', 'Compressor', 'point', 'air'], ['air_valve', 'Air valve', 'point', 'air'],
  ['power_line', 'Power line', 'line', 'power'], ['transformer', 'Transformer', 'point', 'power'], ['panel', 'Electrical panel or disconnect', 'point', 'power'],
  ['junction', 'Junction or pull box', 'point', 'power'], ['pole', 'Utility pole', 'point', 'power'],
  ['sewer_line', 'Sewer line', 'line', 'sewer'], ['septic', 'Septic tank or field', 'point', 'sewer'], ['cleanout', 'Sewer cleanout', 'point', 'sewer'],
  ['gas_line', 'Gas line', 'line', 'fuel'], ['fuel_tank', 'Fuel or propane tank', 'point', 'fuel'], ['gas_shutoff', 'Gas shutoff', 'point', 'fuel'],
  ['comms_line', 'Phone, fibre or data line', 'line', 'comms'], ['comms_box', 'Comms box or antenna', 'point', 'comms'],
  ['culvert', 'Culvert', 'line', 'drainage'], ['ditch', 'Ditch or swale', 'line', 'drainage'], ['catch_basin', 'Catch basin', 'point', 'drainage'],
  ['pond', 'Pond or reservoir', 'area', 'water'], ['building', 'Building', 'area', 'structures'], ['structure', 'Structure or shed', 'point', 'structures'],
  ['road', 'Road or cat track', 'line', 'structures'], ['fence', 'Fence', 'line', 'structures'], ['area', 'Area', 'area', 'other'],
  ['other_point', 'Other point', 'point', 'other'], ['other_line', 'Other line', 'line', 'other'],
  // Municipal edition (muni release 1): a public water, sewer and stormwater system, and the streets. Each belongs to a group
  // whose add-on (water, sewer, stormwater) turns it on for a municipality; the streets group is part of the core plan.
  ['fire_hydrant', 'Fire hydrant', 'point', 'potable'], ['water_service', 'Service line', 'line', 'potable'], ['curb_stop', 'Curb stop', 'point', 'potable'],
  ['sewer_manhole', 'Sewer manhole', 'point', 'sewer'], ['lift_station', 'Pump station', 'point', 'sewer'], ['force_main', 'Force main', 'line', 'sewer'],
  ['storm_outfall', 'Storm outfall', 'point', 'storm'], ['storm_inlet', 'Storm inlet', 'point', 'storm'], ['storm_pipe', 'Storm pipe', 'line', 'storm'],
  ['bmp', 'Stormwater facility', 'area', 'storm'],
  ['streetlight', 'Streetlight', 'point', 'power'], ['sign', 'Street sign', 'point', 'structures'],
].map(([key, name, geometry, system]) => ({ key, label: name, geometry, geometries: [geometry], system, orgs: ['mountain', 'municipality'], group: null }));

// Snowmaking kinds are a ski area's only; a municipality's water valve, meter and vault are drinking water (blue).
const SKI_ONLY = ['hydrant', 'water_line', 'air_line', 'compressor', 'air_valve', 'drain'];
const MUNI_SYSTEM = { valve: 'potable', meter: 'potable', vault: 'potable', pump: 'potable', pump_house: 'potable', intake: 'potable', tank: 'potable', pond: 'storm' };
const GROUP = {
  fire_hydrant: 'water', water_service: 'water', curb_stop: 'water',
  sewer_manhole: 'sewer', lift_station: 'sewer', force_main: 'sewer',
  storm_outfall: 'stormwater', storm_inlet: 'stormwater', storm_pipe: 'stormwater', bmp: 'stormwater',
  streetlight: 'streets', sign: 'streets',
};
// The add-on that turns each group on for a municipality (streets: none, part of the core plan).
const GROUP_MODULE = { water: 'water', sewer: 'sewer', stormwater: 'stormwater', streets: null };
const GROUPS = [['water', 'Water'], ['sewer', 'Sewer'], ['stormwater', 'Stormwater'], ['streets', 'Streets']].map(([key, name]) => ({ key, label: name, module: GROUP_MODULE[key] }));
for (const k of KINDS) {
  if (SKI_ONLY.includes(k.key)) k.orgs = ['mountain'];
  if (GROUP[k.key]) { k.group = GROUP[k.key]; k.orgs = ['municipality']; }
  if (MUNI_SYSTEM[k.key]) k.muni_system = MUNI_SYSTEM[k.key];
}
// A stormwater facility (a basin, a rain garden) is drawn as an area, or put down as a point when it is small.
KINDS.find((k) => k.key === 'bmp').geometries = ['area', 'point'];

// Colors follow the common utility-marking colors where there is one (APWA): blue drinking water, red power,
// yellow gas and fuel, orange comms, green sewer and storm drains, purple reclaimed and pond water.
const SYSTEMS = [
  ['water', 'Snowmaking water', '#7B3FA0'], ['air', 'Snowmaking air', '#0E8FA6'], ['potable', 'Drinking water', '#1F5FD1'],
  ['power', 'Power', '#D12F2F'], ['fuel', 'Gas and fuel', '#C79A00'], ['comms', 'Comms and data', '#E07400'],
  ['sewer', 'Sewer and septic', '#2E8B3E'], ['storm', 'Stormwater', '#5E8F1F'], ['drainage', 'Drainage', '#6B7F8A'], ['structures', 'Buildings and roads', '#3E4A52'],
  ['other', 'Other', '#8A6D3B'],
].map(([key, name, color]) => ({ key, label: name, color }));

const KIND_KEYS = KINDS.map((k) => k.key);
const kindOf = (key) => KINDS.find((k) => k.key === key);
const orgOf = (org) => (org === 'municipality' ? 'municipality' : 'mountain');
/** The system (layer and color) a kind is drawn in for this kind of tenant. */
const systemFor = (k, org) => (orgOf(org) === 'municipality' && k.muni_system ? k.muni_system : k.system);

/**
 * May this tenant put this kind on its map? org: 'mountain' or 'municipality'; on: the apps that are on (a Set or array).
 * A kind in the water, sewer or stormwater group needs that add-on; a snowmaking kind is a ski area's only.
 * Returns null when it may, or the reason it may not, in words.
 */
function kindRefusal(key, org, on) {
  const k = kindOf(key);
  if (!k) return 'Unknown kind of map item';
  const o = orgOf(org);
  if (!k.orgs.includes(o)) return o === 'municipality' ? `${k.label} is for a ski area's map` : `${k.label} is for a municipality's map`;
  const module = k.group ? GROUP_MODULE[k.group] : null;
  const has = (m) => (on instanceof Set ? on.has(m) : (on || []).includes(m));
  if (module && !has(module)) return `${k.label} is part of the ${GROUPS.find((g) => g.key === k.group).label} add-on, which is not turned on for your municipality`;
  return null;
}
/** The kinds this tenant may put on its map, each with the system it is drawn in for this tenant. */
const kindsFor = (org, on) => KINDS.filter((k) => !kindRefusal(k.key, org, on)).map((k) => ({ ...k, system: systemFor(k, org) }));

// ---------------------------------------------------------------- condition, criticality and risk
// Condition: 1 new or like new, 2 good, 3 fair, 4 poor, 5 failed or failing. Criticality: what happens if it fails, from
// 1 low to 5 severe. Risk is the two multiplied (1 to 25), worked out every time and never stored.
const CONDITIONS = [[1, 'New or like new'], [2, 'Good'], [3, 'Fair'], [4, 'Poor'], [5, 'Failed or failing']].map(([value, name]) => ({ value, label: name }));
const CRITICALITIES = [[1, 'Low'], [2, 'Minor'], [3, 'Moderate'], [4, 'High'], [5, 'Severe']].map(([value, name]) => ({ value, label: name }));
const OWNERSHIP = [['own', 'Ours'], ['authority', 'The authority'], ['private', 'Private (the property owner)'], ['state', 'The state (PennDOT)'], ['other', 'Someone else']].map(([value, name]) => ({ value, label: name }));
// [lowest score, key, words]
const RISK_LEVELS = [[20, 'very_high', 'Very high'], [12, 'high', 'High'], [6, 'medium', 'Medium'], [1, 'low', 'Low']];
const RISK_MIN = Object.fromEntries(RISK_LEVELS.map(([min, key]) => [key, min]));
/** { score, level, label } from a condition and a criticality, or null when either is not set. */
function riskOf(condition, criticality) {
  const c = Number(condition); const k = Number(criticality);
  if (!condition || !criticality || !(c >= 1 && c <= 5) || !(k >= 1 && k <= 5)) return null;
  const score = c * k;
  const [, level, words] = RISK_LEVELS.find(([min]) => score >= min);
  return { score, level, label: words };
}

const R = 6371008.8; // meters
const rad = (d) => (d * Math.PI) / 180;
/** Great-circle distance in meters between two [lat, lng] points. */
function distance(a, b) {
  const dLat = rad(b[0] - a[0]); const dLng = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
/** Length of a line in meters. */
const lengthOf = (pts) => pts.slice(1).reduce((m, p, i) => m + distance(pts[i], p), 0);
/** Area of a small polygon in square metres (flat-earth approximation, fine at ski-area scale). */
function areaOf(pts) {
  if (pts.length < 3) return 0;
  const lat0 = rad(pts.reduce((s, p) => s + p[0], 0) / pts.length);
  const xy = pts.map((p) => [rad(p[1]) * R * Math.cos(lat0), rad(p[0]) * R]);
  let s = 0;
  for (let i = 0; i < xy.length; i += 1) { const a = xy[i]; const b = xy[(i + 1) % xy.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
/** The point a feature is listed and searched by: the point itself, the middle vertex of a line, the average of an area. */
function anchorOf(geometry, pts) {
  if (geometry === 'line') return pts[Math.floor(pts.length / 2)];
  if (geometry === 'area') return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  return pts[0];
}

/** Checks the points for the kind's geometry; returns them rounded to 7 places (about 1 cm). */
function cleanPoints(geometry, pts) {
  const out = pts.map((p) => [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7]);
  const need = { point: [1, 1], line: [2, 2000], area: [3, 2000] }[geometry];
  if (out.length < need[0] || out.length > need[1]) {
    return { error: geometry === 'point' ? 'A point has exactly one position' : geometry === 'line' ? 'A line needs at least two points' : 'An area needs at least three points' };
  }
  return { points: out };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
/**
 * A feature as the screens use it: points parsed, length or area worked out, the linked asset's name, condition,
 * criticality and risk. org: the tenant's kind (a municipality's valve is drawn as drinking water). Rows may carry
 * open_orders and last_inspected (from the map's query).
 */
function shape(f, org) {
  const pts = typeof f.points === 'string' ? JSON.parse(f.points) : f.points;
  const k = kindOf(f.kind) || { geometry: f.geometry, system: 'other', label: f.kind };
  return {
    id: Number(f.id), kind: f.kind, kind_label: k.label, geometry: f.geometry, system: systemFor(k, org), group: k.group || null, name: f.name, tag: f.tag || null, points: pts,
    length_m: f.geometry === 'line' ? Math.round(lengthOf(pts) * 10) / 10 : null,
    area_m2: f.geometry === 'area' ? Math.round(areaOf(pts)) : null,
    size: f.size, material: f.material, depth_ft: num(f.depth_ft), installed_year: f.installed_year === null ? null : Number(f.installed_year),
    status: f.status, notes: f.notes, asset_id: f.asset_id === null ? null : Number(f.asset_id), asset_name: f.asset_name || null, asset_tag: f.asset_tag || null,
    accuracy_m: num(f.accuracy_m), placed_how: f.placed_how, updated_at: f.updated_at,
    condition_score: num(f.condition_score), criticality: num(f.criticality), ownership: f.ownership || null, risk: riskOf(f.condition_score, f.criticality),
    open_orders: f.open_orders === undefined ? undefined : Number(f.open_orders || 0), last_inspected: f.last_inspected === undefined ? undefined : f.last_inspected,
    // The street it is on (2026.11.20), when set.
    street_id: f.street_id === null || f.street_id === undefined ? null : Number(f.street_id), street: f.street_name || null,
  };
}

/** The features as GeoJSON (longitude first, as GeoJSON wants), for GIS software and engineers. */
function geojson(features, mountain) {
  return {
    type: 'FeatureCollection', name: `${mountain} asset map`,
    features: features.map((f) => ({
      type: 'Feature', id: f.id,
      geometry: f.geometry === 'point' ? { type: 'Point', coordinates: [f.points[0][1], f.points[0][0]] }
        : f.geometry === 'line' ? { type: 'LineString', coordinates: f.points.map((p) => [p[1], p[0]]) }
          : { type: 'Polygon', coordinates: [[...f.points, f.points[0]].map((p) => [p[1], p[0]])] },
      properties: { name: f.name, tag: f.tag, kind: f.kind_label, system: (SYSTEMS.find((s) => s.key === f.system) || {}).label, size: f.size, material: f.material,
        depth_ft: f.depth_ft, installed_year: f.installed_year, status: f.status, notes: f.notes, asset_tag: f.asset_tag,
        condition: f.condition_score, criticality: f.criticality, risk: f.risk ? f.risk.score : null, ownership: f.ownership, length_ft: f.length_m === null ? null : Math.round(f.length_m * 3.281) },
    })),
  };
}

module.exports = { KINDS, SYSTEMS, GROUPS, KIND_KEYS, kindOf, systemFor, kindRefusal, kindsFor, distance, lengthOf, areaOf, anchorOf, cleanPoints, shape, geojson,
  CONDITIONS, CRITICALITIES, OWNERSHIP, RISK_LEVELS, RISK_MIN, riskOf };
