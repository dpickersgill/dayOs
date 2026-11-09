// STAND-IN, replaced at merge.
'use strict';

// The real module comes from help/places (table mountain_places). This file exists only so
// help/sms builds and tests against the agreed interface; the merge takes help/places' file whole.
//   describe(db, tenantId, lat, lng, accuracyM) -> { text, text_es, place_id, distance_m, confidence } or null
//   byCode(db, tenantId, code)                  -> the place or null
//   list(db, tenantId)                          -> the mountain's places
// Here the places live in memory (_add, for tests), or in mountain_places when that table exists.

const mem = new Map(); // tenantId -> [place]

async function hasTable(db) {
  try { const [r] = await db.query("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'mountain_places'"); return r.length > 0; } catch (_) { return false; }
}

async function list(db, tenantId) {
  if (await hasTable(db)) { const [r] = await db.query('SELECT * FROM mountain_places WHERE tenant_id = ? AND active = 1 ORDER BY name', [tenantId]); return r; }
  return (mem.get(Number(tenantId)) || []).filter((p) => p.active !== 0);
}

async function byCode(db, tenantId, code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(c)) return null;
  return (await list(db, tenantId)).find((p) => String(p.code || '').toUpperCase() === c) || null;
}

function metres(aLat, aLng, bLat, bLng) {
  const R = 6371000; const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat); const dLng = rad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function describe(db, tenantId, lat, lng, accuracyM) {
  let best = null;
  for (const p of await list(db, tenantId)) {
    if (p.lat == null || p.lng == null) continue;
    const d = metres(Number(lat), Number(lng), Number(p.lat), Number(p.lng));
    if (!best || d < best.d) best = { p, d };
  }
  if (!best || best.d > 300) return null;
  const m = Math.max(5, Math.round(best.d / 5) * 5);
  return { text: `Near ${best.p.name}, about ${m} m`, text_es: `Cerca de ${best.p.name}, a unos ${m} m`, place_id: best.p.id, distance_m: Math.round(best.d), confidence: (accuracyM || 0) > 100 ? 'low' : 'high' };
}

/** Tests only: add a place to a mountain (in memory). */
function _add(tenantId, place) {
  const all = mem.get(Number(tenantId)) || [];
  const p = { id: 900000 + all.length + mem.size * 100, tenant_id: tenantId, kind: 'sign', active: 1, ...place };
  all.push(p); mem.set(Number(tenantId), all);
  return p;
}

module.exports = { describe, byCode, list, _add };
