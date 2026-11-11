'use strict';

// The demo borough's water, sewer and stormwater (run by db/demo-municipal.js): water mains with 60 valves and 35 fire
// hydrants, 40 sewer manholes, 2 pump stations with a year of run hour readings, 18 storm outfalls, 30 inlets and 3
// stormwater basins, on a made-up grid of streets around 40.0, -75.5 (no real town). Condition and criticality are spread
// so the Highest risk list has something to say. A valve exercising program is half done, a hydrant flushing program is
// planned, and a few failed inspections have opened work orders. Safe to run again: map items are found by their tag,
// programs by name, and readings and inspections are only added where there are none.
const MF = require('../../src/lib/mapfeatures');
const CR = require('../../src/lib/checkrules');
const TP = require('../../src/lib/templatepacks');

const LAT0 = 40.0; const LNG0 = -75.5;
const DLAT = 0.0012; const DLNG = -0.0015; // a block north, a block west
const EW = ['Main Street', 'Bridge Street', 'Church Street', 'High Street', 'Mill Street', 'Market Street', 'Chestnut Street', 'Walnut Street'];
const NS = ['First Avenue', 'Second Avenue', 'Third Avenue', 'Fourth Avenue', 'Fifth Avenue', 'Park Avenue', 'Franklin Avenue', 'Lincoln Avenue'];
const at = (i, j, di = 0, dj = 0) => [Math.round((LAT0 + (i + di) * DLAT) * 1e7) / 1e7, Math.round((LNG0 + (j + dj) * DLNG) * 1e7) / 1e7];

// A small fixed sequence, so every run spreads the same scores the same way.
function seq(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

module.exports = async function assets(conn, T, { today, addDays, daysAgo, userIds, staffIds, log }) {
  const users = await userIds();
  const by = users.get('crew1') || users.get('owner') || null;
  const manager = users.get('manager') || users.get('owner') || null;
  const staff = await staffIds();

  // The built-in Water, Sewer and Stormwater checklists (the demo has every add-on on).
  await TP.seed(conn, T);
  const [tplRows] = await conn.query('SELECT id, name, items, sets_condition FROM inspection_templates WHERE tenant_id = ?', [T]);
  const tpl = Object.fromEntries(tplRows.map((t) => [t.name, { id: Number(t.id), name: t.name, items: JSON.parse(t.items), sets: Boolean(t.sets_condition) }]));

  // Where every map opens.
  await conn.query('UPDATE tenants SET map_lat = COALESCE(map_lat, ?), map_lng = COALESCE(map_lng, ?), map_zoom = COALESCE(map_zoom, 16) WHERE id = ?', [LAT0 + 3.5 * DLAT, LNG0 + 3.5 * DLNG, T]);

  // ---- map items, found by tag
  const [haveRows] = await conn.query('SELECT id, tag FROM map_features WHERE tenant_id = ? AND tag IS NOT NULL', [T]);
  const have = new Map(haveRows.map((r) => [r.tag, Number(r.id)]));
  const rnd = seq(42);
  // Most things are fair or good; a few are poor or failing. Criticality by kind, with some spread.
  const condition = () => { const r = rnd(); return r < 0.15 ? 1 : r < 0.5 ? 2 : r < 0.78 ? 3 : r < 0.94 ? 4 : 5; };
  let added = 0;
  async function feature(tag, kind, points, extra = {}) {
    if (have.has(tag)) return have.get(tag);
    const k = MF.kindOf(kind);
    const geometry = extra.geometry || k.geometry;
    const [lat, lng] = MF.anchorOf(geometry, points);
    const [r] = await conn.query(`INSERT INTO map_features (tenant_id, kind, geometry, name, tag, points, lat, lng, size, material, installed_year, status, notes, placed_how, created_by, condition_score, criticality, ownership)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)`,
    [T, kind, geometry, extra.name || null, tag, JSON.stringify(points), lat, lng, extra.size || null, extra.material || null, extra.year || null, extra.status || 'in_service', extra.notes || null, by,
      extra.condition === undefined ? condition() : extra.condition, extra.criticality ?? null, extra.ownership || 'own']);
    have.set(tag, Number(r.insertId));
    added += 1;
    return Number(r.insertId);
  }

  // Water mains: one under each east-west street and three avenues. Older cast iron downtown, ductile iron elsewhere.
  for (const [i, street] of EW.entries()) {
    await feature(`WM-${i + 1}`, 'potable_line', [at(i, 0), at(i, 3.5), at(i, 7)], { name: `${street} water main`, size: i < 3 ? '8 in' : '6 in', material: i < 4 ? 'Cast iron' : 'Ductile iron', year: i < 4 ? 1938 + i * 6 : 1972 + i * 4, criticality: i < 2 ? 5 : 3 });
  }
  for (const [n, j] of [[1, 0], [2, 3], [3, 7]]) {
    await feature(`WM-${8 + n}`, 'potable_line', [at(0, j), at(3.5, j), at(7, j)], { name: `${NS[j]} water main`, size: '8 in', material: 'Ductile iron', year: 1981 + n * 3, criticality: 4 });
  }
  // 60 valves at the intersections (the four corner ones left out), each with its tag.
  let v = 0;
  for (let i = 0; i < 8; i += 1) for (let j = 0; j < 8; j += 1) {
    if ((i === 0 || i === 7) && (j === 0 || j === 7)) continue;
    v += 1;
    await feature(`V-${100 + v}`, 'valve', [at(i, j, 0.04, 0.04)], { size: i < 3 ? '8 in' : '6 in', year: 1950 + ((i * 8 + j) % 50), criticality: i < 2 ? 4 : 2 + ((i + j) % 3) });
  }
  // 35 fire hydrants, mid-block along the mains.
  for (let n = 0; n < 35; n += 1) {
    const i = n % 8; const j = Math.floor(n / 8) * 2 + 0.5;
    await feature(`H-${201 + n}`, 'fire_hydrant', [at(i, j, 0.08, 0)], { year: 1960 + (n * 3) % 60, criticality: n % 7 === 0 ? 5 : 3, notes: n === 4 ? 'Hit by a car in March; replaced the barrel.' : null });
  }
  // 40 sewer manholes, between the water mains.
  for (let n = 0; n < 40; n += 1) {
    const i = n % 8; const j = Math.floor(n / 8) * 1.5 + 0.75;
    await feature(`MH-${301 + n}`, 'sewer_manhole', [at(i, j, -0.12, 0)], { material: n < 15 ? 'Brick' : 'Precast concrete', year: n < 15 ? 1925 : 1978, criticality: n < 8 ? 4 : 3 });
  }
  // Sewer mains along four streets and two force mains to the plant.
  for (const [n, i] of [[1, 0], [2, 2], [3, 4], [4, 6]]) await feature(`SM-${n}`, 'sewer_line', [at(i, 0, -0.12), at(i, 7, -0.12)], { name: `${EW[i]} sewer`, size: '8 in', material: n < 3 ? 'Vitrified clay' : 'PVC', year: n < 3 ? 1925 : 1988, criticality: 4 });
  // Two pump stations, the force main from each.
  const ps1 = await feature('PS-1', 'lift_station', [at(-0.6, 2)], { name: 'Mill Street pump station', year: 1984, condition: 3, criticality: 5, notes: 'Two 15 hp submersible pumps. Generator 1 is its backup.' });
  const ps2 = await feature('PS-2', 'lift_station', [at(-0.6, 6)], { name: 'Riverside Drive pump station', year: 2009, condition: 2, criticality: 5, notes: 'Two 10 hp submersible pumps.' });
  await feature('FM-1', 'force_main', [at(-0.6, 2), at(-1.2, 2), at(-1.2, 4)], { name: 'Mill Street force main', size: '6 in', material: 'Ductile iron', year: 1984, criticality: 5 });
  await feature('FM-2', 'force_main', [at(-0.6, 6), at(-1.2, 6), at(-1.2, 4)], { name: 'Riverside Drive force main', size: '4 in', material: 'HDPE', year: 2009, criticality: 4 });
  // 18 storm outfalls along the creek south of Main Street, 30 inlets at the corners, a few storm pipes, 3 basins.
  for (let n = 0; n < 18; n += 1) await feature(`OF-${String(n + 1).padStart(2, '0')}`, 'storm_outfall', [at(-1.8, n * 0.42, 0, 0)], { size: n % 3 === 0 ? '24 in' : '15 in', material: n % 2 ? 'Corrugated metal' : 'Reinforced concrete', criticality: 2 + (n % 3) });
  for (let n = 0; n < 30; n += 1) {
    const i = n % 6 + 1; const j = Math.floor(n / 6) + 1;
    await feature(`IN-${401 + n}`, 'storm_inlet', [at(i, j, 0.03, -0.06)], { criticality: 2, notes: n === 3 ? 'Leaves pile up every fall.' : null });
  }
  for (let n = 0; n < 5; n += 1) await feature(`SP-${n + 1}`, 'storm_pipe', [at(n + 1, 1, 0.03, -0.06), at(-1.8, 1 + n * 0.8)], { size: '18 in', material: 'Reinforced concrete', year: 1966, criticality: 3 });
  const basin = (i, j, w) => [at(i, j), at(i, j + w), at(i + w * 0.8, j + w), at(i + w * 0.8, j)];
  await feature('BMP-1', 'bmp', basin(8.2, 1, 0.6), { name: 'Orchard Lane detention basin', year: 1996, criticality: 3 });
  await feature('BMP-2', 'bmp', basin(8.2, 5, 0.5), { name: 'Ridge Avenue detention basin', year: 2004, criticality: 3 });
  await feature('BMP-3', 'bmp', [at(3.5, 3.5, 0.1, 0.1)], { geometry: 'point', name: 'Library rain garden', year: 2019, condition: 1, criticality: 1 });
  // Streetlights and signs downtown (part of the core plan).
  for (let n = 0; n < 8; n += 1) await feature(`SL-${n + 1}`, 'streetlight', [at(0, n, 0.06, 0.5)], { criticality: 2, ownership: n < 4 ? 'own' : 'other', notes: n >= 4 ? 'Owned and fixed by the power company.' : null });
  log(`${added} new map item${added === 1 ? '' : 's'} (water, sewer, stormwater and streets)`);

  // ---- inspections, shared by everything below
  // A photo item is answered with a photo in the app; the demo records its screenings without one.
  async function inspect(template, featureId, answers, doneAt, { programId = null, woTitle = null, woPriority = 'high' } = {}) {
    const t = tpl[template];
    const items = CR.evaluateAll(t.items.map((i) => ({ ...i, photo: false })), answers, doneAt.slice(0, 10));
    const failed = items.filter((i) => i.result === 'fail');
    let wo = null;
    if (failed.length) {
      const [w] = await conn.query("INSERT INTO work_orders (tenant_id, title, description, priority, status, map_feature_id, program_id, source, opened_at, opened_by) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)",
        [T, woTitle || `Failed ${template.toLowerCase()}`, failed.map((i) => `${i.label}: ${i.note}`).join('\n'), woPriority, featureId, programId, programId ? 'program' : 'inspection', doneAt, by]);
      wo = Number(w.insertId);
    }
    const score = t.sets ? CR.conditionOf(items) : null;
    const [r] = await conn.query(`INSERT INTO asset_inspections (tenant_id, map_feature_id, program_id, template_id, template_name, result, items, inspector, work_order_id, user_id, done_at, condition_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [T, featureId, programId, t.id, t.name, failed.length ? 'fail' : 'pass', JSON.stringify(items), 'Luis Ortega', wo, by, doneAt, score]);
    if (score !== null) await conn.query('UPDATE map_features SET condition_score = ? WHERE tenant_id = ? AND id = ?', [score, T, featureId]);
    for (const i of items.filter((x) => x.run_hours && typeof x.value === 'number')) {
      await conn.query('INSERT INTO station_run_hours (tenant_id, map_feature_id, inspection_id, item_key, label, hours, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [T, featureId, r.insertId, i.key, i.label, i.value, doneAt]);
    }
    return { id: Number(r.insertId), result: failed.length ? 'fail' : 'pass', wo };
  }

  // ---- a year of pump station rounds, twice a month, with the hour meters climbing
  let rounds = 0;
  for (const [station, start, rate] of [[ps1, [18240, 17910], [7.2, 6.4]], [ps2, [5210, 5480], [4.1, 4.6]]]) {
    const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM station_run_hours WHERE tenant_id = ? AND map_feature_id = ?', [T, station]);
    if (Number(c.n)) continue;
    const meters = [...start];
    for (let d = 364; d >= 0; d -= 15) {
      // Wetter months run the pumps longer.
      const month = Number(addDays(today, -d).slice(5, 7));
      const wet = [3, 4, 5, 9, 10].includes(month) ? 1.35 : 1;
      meters[0] = Math.round((meters[0] + 15 * rate[0] * wet) * 10) / 10; meters[1] = Math.round((meters[1] + 15 * rate[1] * wet) * 10) / 10;
      await inspect('Pump station round', station, [
        { key: 'pump1_hours', value: meters[0] }, { key: 'pump2_hours', value: meters[1] }, { key: 'wet_well', value: 'Normal' }, { key: 'alarms', result: 'pass' },
        { key: 'generator_fuel', value: 70 + (d % 30) }, { key: 'odor', value: 'no' }, { key: 'check_valves', result: 'pass' }, { key: 'security', result: 'pass' },
      ], daysAgo(d, 7, 30));
      rounds += 1;
    }
  }
  log(`${rounds} pump station round${rounds === 1 ? '' : 's'} with hour meter readings`);

  // ---- a few failed inspections with their work orders
  const [haveWo] = await conn.query('SELECT title FROM work_orders WHERE tenant_id = ?', [T]);
  const titles = new Set(haveWo.map((r) => r.title));
  const fails = [
    ['Hydrant H-209 does not drain', 'Hydrant flush and inspection', 'H-209', [{ key: 'static_psi', value: 62 }, { key: 'residual_psi', value: 48 }, { key: 'flow_gpm', value: 980 }, { key: 'chlorine', value: 0.6 }, { key: 'flushed_clear', value: 'yes' }, { key: 'drains', value: 'no', note: 'Still full after 20 minutes' }, { key: 'caps', result: 'pass' }, { key: 'paint', result: 'pass' }, { key: 'out_of_service', value: 'no' }, { key: 'condition', value: 4 }], 9],
    ['Manhole MH-304 has roots and infiltration', 'Manhole inspection', 'MH-304', [{ key: 'cover_frame', result: 'pass' }, { key: 'chimney', result: 'fail', note: 'Rings loose' }, { key: 'walls', result: 'pass' }, { key: 'bench', result: 'pass' }, { key: 'inflow', value: 'yes', note: 'Roots at the inlet pipe, water running in' }, { key: 'h2s', value: 'no' }, { key: 'condition', value: 4 }], 6],
    ['Outfall OF-07 discharging in dry weather', 'Outfall dry-weather screening', 'OF-07', [{ key: 'flow', value: 'yes' }, { key: 'color', value: 'Gray' }, { key: 'odor', value: 'Chemical or soapy' }, { key: 'floatables', value: 'yes' }, { key: 'illicit', value: 'yes' }], 4],
  ];
  let failsMade = 0;
  for (const [title, template, tag, answers, ago] of fails) {
    if (titles.has(title) || !have.has(tag)) continue;
    await inspect(template, have.get(tag), answers, daysAgo(ago, 10), { woTitle: title, woPriority: tag.startsWith('OF') ? 'urgent' : 'high' });
    failsMade += 1;
  }
  log(`${failsMade} failed inspection${failsMade === 1 ? '' : 's'} with work orders`);

  // ---- programs: valve exercising half done, hydrant flushing planned
  const [haveProg] = await conn.query('SELECT name FROM asset_programs WHERE tenant_id = ?', [T]);
  const progNames = new Set(haveProg.map((r) => r.name));
  const lead = staff.get('Luis Ortega') || null;
  const year = today.slice(0, 4);
  const valveName = `Exercise zone 3 valves, ${year}`;
  if (!progNames.has(valveName) && tpl['Valve exercise']) {
    const [p] = await conn.query("INSERT INTO asset_programs (tenant_id, name, template_id, due_on, assigned_staff_id, crew, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [T, valveName, tpl['Valve exercise'].id, addDays(today, 5), lead, 'Water crew: Luis and Kevin', 'Zone 3 is everything north of Mill Street. Close each valve fully and count the turns.', manager, daysAgo(20)]);
    const pid = Number(p.insertId);
    const zone = [...have.entries()].filter(([tag]) => /^V-\d+$/.test(tag) && Number(tag.slice(2)) >= 131).map(([, id]) => id).slice(0, 24);
    for (const [n, fid] of zone.entries()) {
      const [g] = await conn.query('INSERT INTO asset_program_targets (tenant_id, program_id, map_feature_id) VALUES (?, ?, ?)', [T, pid, fid]);
      if (n >= 12) continue; // half done
      const when = daysAgo(12 - n, 9 + (n % 6));
      if (n === 5) { await conn.query("UPDATE asset_program_targets SET status = 'skipped', skip_reason = 'Paved over in the summer overlay; ask the paving contractor to raise the box', done_at = ?, done_by = ? WHERE tenant_id = ? AND id = ?", [when, by, T, g.insertId]); continue; }
      const stuck = n === 3 || n === 9;
      const r = await inspect('Valve exercise', fid, [
        { key: 'turns_expected', value: 24 }, { key: 'turns_counted', value: stuck ? 9 : 24 }, { key: 'direction', value: n % 4 === 0 ? 'Left to close' : 'Right to close' },
        { key: 'operated_fully', value: stuck ? 'no' : 'yes', note: stuck ? 'Stopped at 9 turns; will not go further' : null }, { key: 'box_condition', value: n === 7 ? 'Needs cleaning out' : 'Good' }, { key: 'condition', value: stuck ? 4 : 2 + (n % 2) },
      ], when, { programId: pid, woTitle: stuck ? `Valve will not close fully (program ${valveName})` : null, woPriority: 'high' });
      await conn.query("UPDATE asset_program_targets SET status = 'done', result = ?, inspection_id = ?, work_order_id = ?, done_at = ?, done_by = ? WHERE tenant_id = ? AND id = ?", [r.result, r.id, r.wo, when, by, T, g.insertId]);
    }
    log(`Program "${valveName}": ${zone.length} valves, half done`);
  }
  const flushName = `Spring hydrant flushing, north side, ${Number(year) + (today.slice(5, 7) > '05' ? 1 : 0)}`;
  if (!progNames.has(flushName) && tpl['Hydrant flush and inspection']) {
    const [p] = await conn.query('INSERT INTO asset_programs (tenant_id, name, template_id, due_on, assigned_staff_id, crew, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [T, flushName, tpl['Hydrant flush and inspection'].id, addDays(today, 24), staff.get('Kevin Brandt') || null, 'Water crew', 'Flush from the plant outward. Post the flushing notice on the website a week before.', manager]);
    const north = [...have.entries()].filter(([tag]) => /^H-\d+$/.test(tag)).map(([tag, id]) => [Number(tag.slice(2)), id]).filter(([n]) => (n - 201) % 8 >= 4).map(([, id]) => id);
    for (const fid of north) await conn.query('INSERT INTO asset_program_targets (tenant_id, program_id, map_feature_id) VALUES (?, ?, ?)', [T, Number(p.insertId), fid]);
    log(`Program "${flushName}": ${north.length} hydrants, planned`);
  }
};
