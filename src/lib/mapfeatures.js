'use strict';

// The asset map (Assets and fleet, Map): what lies where on the mountain. Points for things in one place (a valve, a
// hydrant, a pump house, a transformer), lines for what runs between places (a snowmaking water or air line, a power
// line, a sewer or fibre run) and areas for what covers ground (a pond, a building). Each belongs to a system, drawn in
// that system's colour and toggled as a layer. A point or area can be tied to an asset in the register, so the map and
// the asset's record point at each other.

// [key, label, geometry, system]
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
].map(([key, name, geometry, system]) => ({ key, label: name, geometry, system }));

// Colours follow the common utility-marking colours where there is one (APWA): blue drinking water, red power,
// yellow gas and fuel, orange comms, green sewer, purple reclaimed and pond water.
const SYSTEMS = [
  ['water', 'Snowmaking water', '#7B3FA0'], ['air', 'Snowmaking air', '#0E8FA6'], ['potable', 'Drinking water', '#1F5FD1'],
  ['power', 'Power', '#D12F2F'], ['fuel', 'Gas and fuel', '#C79A00'], ['comms', 'Comms and data', '#E07400'],
  ['sewer', 'Sewer and septic', '#2E8B3E'], ['drainage', 'Drainage', '#6B7F8A'], ['structures', 'Buildings and roads', '#3E4A52'],
  ['other', 'Other', '#8A6D3B'],
].map(([key, name, color]) => ({ key, label: name, color }));

const KIND_KEYS = KINDS.map((k) => k.key);
const kindOf = (key) => KINDS.find((k) => k.key === key);

const R = 6371008.8; // metres
const rad = (d) => (d * Math.PI) / 180;
/** Great-circle distance in metres between two [lat, lng] points. */
function distance(a, b) {
  const dLat = rad(b[0] - a[0]); const dLng = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
/** Length of a line in metres. */
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
/** A feature as the screens use it: points parsed, length or area worked out, the linked asset's name. */
function shape(f) {
  const pts = typeof f.points === 'string' ? JSON.parse(f.points) : f.points;
  const k = kindOf(f.kind) || { geometry: f.geometry, system: 'other', label: f.kind };
  return {
    id: Number(f.id), kind: f.kind, kind_label: k.label, geometry: f.geometry, system: k.system, name: f.name, points: pts,
    length_m: f.geometry === 'line' ? Math.round(lengthOf(pts) * 10) / 10 : null,
    area_m2: f.geometry === 'area' ? Math.round(areaOf(pts)) : null,
    size: f.size, material: f.material, depth_ft: num(f.depth_ft), installed_year: f.installed_year === null ? null : Number(f.installed_year),
    status: f.status, notes: f.notes, asset_id: f.asset_id === null ? null : Number(f.asset_id), asset_name: f.asset_name || null, asset_tag: f.asset_tag || null,
    accuracy_m: num(f.accuracy_m), placed_how: f.placed_how, updated_at: f.updated_at,
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
      properties: { name: f.name, kind: f.kind_label, system: (SYSTEMS.find((s) => s.key === f.system) || {}).label, size: f.size, material: f.material,
        depth_ft: f.depth_ft, installed_year: f.installed_year, status: f.status, notes: f.notes, asset_tag: f.asset_tag, length_ft: f.length_m === null ? null : Math.round(f.length_m * 3.281) },
    })),
  };
}

module.exports = { KINDS, SYSTEMS, KIND_KEYS, kindOf, distance, lengthOf, areaOf, anchorOf, cleanPoints, shape, geojson };
