'use strict';

// What a map item's panel (routes/assetmap.js GET /features/:id) shows for the utilities (release 2026.11.20):
//   a water main     its breaks, newest first, and how many in the last 5 years (main_breaks)
//   a storm outfall  its illicit discharge cases (idd_cases)
//   a pump station   each pump's rated flow in gpm (map_features.pump_gpm), for Chapter 94
// Each only when its add-on is on; nothing for other items.
const { rows, one } = require('../db');

async function extras(db, tenantId, f) {
  const on = new Set(await require('./modules').enabledKeys(tenantId));
  const out = {};
  if (f.kind === 'potable_line' && on.has('water')) {
    const list = await rows(db, 'SELECT id, broke_at, cause, status, customers_out, boil_water FROM main_breaks WHERE tenant_id = ? AND main_id = ? ORDER BY broke_at DESC LIMIT 50', [tenantId, f.id]);
    const since = Date.now() - 1826 * 86400000;
    out.main_breaks = {
      list: list.map((b) => ({ id: Number(b.id), broke_at: b.broke_at instanceof Date ? b.broke_at.toISOString().slice(0, 19).replace('T', ' ') : String(b.broke_at).slice(0, 19), cause: b.cause, status: b.status,
        customers_out: b.customers_out === null ? null : Number(b.customers_out), boil_water: Boolean(b.boil_water) })),
      total: list.length,
      in_5_years: list.filter((b) => Date.parse(`${String(b.broke_at instanceof Date ? b.broke_at.toISOString() : b.broke_at).slice(0, 10)}T00:00:00Z`) > since).length,
    };
  }
  if (f.kind === 'storm_outfall' && on.has('stormwater')) {
    out.cases = (await rows(db, 'SELECT id, reference, status, opened_at FROM idd_cases WHERE tenant_id = ? AND outfall_id = ? ORDER BY opened_at DESC LIMIT 20', [tenantId, f.id]))
      .map((c) => ({ id: Number(c.id), reference: c.reference, status: c.status, open: ['open', 'source_found'].includes(c.status), opened_at: c.opened_at }));
  }
  if (f.kind === 'lift_station' && on.has('sewer')) {
    const r = await one(db, 'SELECT pump_gpm FROM map_features WHERE tenant_id = ? AND id = ?', [tenantId, f.id]);
    try { out.pump_gpm = JSON.parse((r && r.pump_gpm) || '{}'); } catch (_) { out.pump_gpm = {}; }
  }
  return out;
}

module.exports = { extras };
