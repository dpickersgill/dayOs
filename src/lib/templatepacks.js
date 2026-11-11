'use strict';

// Built-in inspection checklists for a municipality's water, sewer and stormwater systems (muni release 1). A pack is
// given to a municipality once, when its add-on (Water, Sewer or Stormwater) is on: when the platform operator or a
// plan turns the add-on on, and again (for safety) whenever the Assets screens load. After that the checklists are the
// municipality's own to change, rename or stop using: a pack is never given twice (asset_template_packs), so an edited
// or retired checklist does not come back. A checklist whose name is already taken is left out of the pack.
//
// The ranges in these packs are common starting points, not rules the app decides: a manager changes them to the
// system's own standards. Nothing here certifies anything; the crew records what they found.
const { one, rows } = require('../db');
const M = require('./modules');

const pf = (key, label, extra = {}) => ({ key, label, type: 'pass', ...extra });
const num = (key, label, unit, extra = {}) => ({ key, label, type: 'number', unit, min: null, max: null, ...extra });
const yn = (key, label, failOn = null, extra = {}) => ({ key, label, type: 'yesno', fail_on: failOn, ...extra });
const choice = (key, label, options, failOptions = [], extra = {}) => ({ key, label, type: 'choice', options, fail_options: failOptions, ...extra });
const cond = (key = 'condition', label = 'Condition score') => ({ key, label, type: 'condition' });

// [pack (the add-on), name, map kinds, sets the condition score, items]
const PACKS = {
  water: [
    ['Valve exercise', ['valve'], true, [
      num('turns_expected', 'Turns expected (from the record)', 'turns'),
      num('turns_counted', 'Turns counted, fully closed to fully open', 'turns', { min: 0 }),
      choice('direction', 'Direction to close', ['Right to close', 'Left to close']),
      yn('operated_fully', 'Operated fully, open to closed and back', 'no'),
      choice('box_condition', 'Valve box', ['Good', 'Needs cleaning out', 'Damaged or tilted', 'Paved over or buried', 'Could not find it'], ['Damaged or tilted', 'Paved over or buried', 'Could not find it']),
      cond(),
    ]],
    ['Hydrant flush and inspection', ['fire_hydrant'], true, [
      num('static_psi', 'Static pressure', 'psi', { min: 20 }),
      num('residual_psi', 'Residual pressure while flowing', 'psi', { min: 20 }),
      num('flow_gpm', 'Flow', 'gpm', { min: 0 }),
      num('chlorine', 'Chlorine residual', 'mg/L', { min: 0.2, max: 4 }),
      yn('flushed_clear', 'Flushed until the water ran clear', 'no'),
      yn('drains', 'Barrel drains properly after closing', 'no'),
      pf('caps', 'Caps, nozzles and chains'),
      pf('paint', 'Paint, markers and clearance around it'),
      yn('out_of_service', 'Out of service (bag it and tell the fire company)', 'yes'),
      cond(),
    ]],
  ],
  sewer: [
    ['Manhole inspection', ['sewer_manhole', 'vault'], true, [
      pf('cover_frame', 'Cover and frame'),
      pf('chimney', 'Chimney and adjusting rings'),
      pf('walls', 'Walls'),
      pf('bench', 'Bench and channel'),
      yn('inflow', 'Signs of inflow or infiltration (stains, roots, running water)', 'yes'),
      yn('h2s', 'Hydrogen sulfide corrosion', 'yes'),
      cond(),
    ]],
    ['Pump station round', ['lift_station'], false, [
      num('pump1_hours', 'Pump 1 run hour meter', 'h', { min: 0, run_hours: true }),
      num('pump2_hours', 'Pump 2 run hour meter', 'h', { min: 0, run_hours: true }),
      choice('wet_well', 'Wet well level', ['Normal', 'Low', 'High', 'At the alarm level'], ['At the alarm level']),
      pf('alarms', 'Alarms and the call-out tested'),
      num('generator_fuel', 'Generator fuel', '%', { min: 50, max: 100 }),
      yn('odor', 'Odor outside the station'),
      pf('check_valves', 'Check valves'),
      pf('security', 'Fence, gate, locks and hatches'),
    ]],
  ],
  stormwater: [
    ['Outfall dry-weather screening', ['storm_outfall'], false, [
      yn('flow', 'Flow present after 72 hours without rain', null, { photo: true }),
      choice('color', 'Color of any flow', ['No flow', 'Clear', 'Cloudy', 'Brown', 'Gray', 'Green', 'Other']),
      choice('odor', 'Odor', ['None', 'Sewage', 'Rotten eggs', 'Chemical or soapy', 'Oil or gasoline', 'Other']),
      yn('floatables', 'Floatables, foam or oil sheen'),
      yn('illicit', 'Suspected illicit discharge', 'yes'),
    ]],
    ['Inlet inspection', ['storm_inlet', 'catch_basin'], true, [
      pf('grate', 'Grate and frame'),
      choice('debris', 'Debris in the inlet', ['None', 'Light', 'Half full', 'Full or blocked'], ['Full or blocked']),
      yn('cleaned', 'Cleaned out today'),
      cond(),
    ]],
    ['Stormwater facility inspection', ['bmp', 'pond'], true, [
      pf('structures', 'Inlet and outlet structures'),
      pf('vegetation', 'Vegetation'),
      pf('sediment', 'Sediment'),
      pf('erosion', 'Erosion'),
      yn('standing_water', 'Standing water 72 hours after rain', 'yes'),
      cond(),
    ]],
  ],
};
const PACK_KEYS = Object.keys(PACKS);

/** The apps on for a tenant, read inside the caller's transaction (no cache: a change being saved counts). */
async function stateIn(conn, tenantId) {
  const t = await one(conn, 'SELECT org_type FROM tenants WHERE id = ?', [tenantId]);
  if (!t) return null;
  const want = {};
  for (const r of await rows(conn, 'SELECT module, enabled FROM tenant_modules WHERE tenant_id = ?', [tenantId])) want[r.module] = Boolean(r.enabled);
  return { org: t.org_type === 'municipality' ? 'municipality' : 'mountain', on: new Set(M.settle(want, t.org_type)) };
}

/**
 * Gives a municipality each pack whose add-on is on and that it has not had yet. Returns the names of the checklists
 * added. A mountain never gets one.
 */
async function seed(conn, tenantId) {
  const s = await stateIn(conn, tenantId);
  if (!s || s.org !== 'municipality') return [];
  const want = PACK_KEYS.filter((p) => s.on.has(p));
  if (!want.length) return [];
  const had = new Set((await rows(conn, 'SELECT pack FROM asset_template_packs WHERE tenant_id = ?', [tenantId])).map((r) => r.pack));
  const added = [];
  for (const pack of want.filter((p) => !had.has(p))) {
    // Claim the pack first, so two screens loading at once cannot both add it.
    const [claim] = await conn.query('INSERT IGNORE INTO asset_template_packs (tenant_id, pack) VALUES (?, ?)', [tenantId, pack]);
    if (!claim.affectedRows) continue;
    let n = 0;
    for (const [name, mapKinds, setsCondition, items] of PACKS[pack]) {
      const [r] = await conn.query('INSERT IGNORE INTO inspection_templates (tenant_id, name, kinds, map_kinds, items, sets_condition, pack) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        [tenantId, name, mapKinds.join(','), JSON.stringify(items), setsCondition ? 1 : 0, pack]);
      if (r.affectedRows) { n += 1; added.push(name); }
    }
    await conn.query('UPDATE asset_template_packs SET templates = ? WHERE tenant_id = ? AND pack = ?', [n, tenantId, pack]);
  }
  return added;
}

module.exports = { PACKS, PACK_KEYS, seed };
