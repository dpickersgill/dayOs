'use strict';

// The demo borough's costs (release 2026.11.20, workstream "money"; run by db/demo-municipal.js after every other file):
// departments and funds (road work charged to Liquid Fuels), each crew member's labor rate, an hourly rate on every
// truck and machine, parts in stock with prices, a fuel log, and a year of completed work orders across the departments
// and funds with their crew hours, equipment hours, parts, materials and outside bills, so the Costs tab and the monthly
// report look real. Work orders the other demo files completed get their hours costed too. Every name is made up.
// Safe to run again: rates and parts are set only where missing, each generated work order is found by its own key
// (the note on its first labor line), and work orders that already have labor lines are left alone.
const W = require('../../src/lib/workcosts');

// [staff full name, labor cost an hour in cents: pay plus benefits]
const RATES = [['Luis Ortega', 3850], ['Kevin Brandt', 3675], ['Tom Kowalski', 4120], ['Rachel Moore', 3140], ['Marcus Hale', 5200]];
// [asset name, hourly rate on jobs in cents]
const EQUIPMENT = [['Plow 1', 8500], ['Plow 2', 8000], ['Packer 7', 9000], ['Pickup 4', 4000], ['Loader 1', 8500], ['Sweeper 1', 9500], ['Jet-Vac 1', 15000], ['Generator 1', 4000]];
// [sku, name, unit, unit cost in cents, on hand, reorder point]
const PARTS = [
  ['CP-50', 'Cold patch asphalt, 50 lb bag', 'bag', 1450, 60, 20], ['SG-STOP30', 'Stop sign, 30 in', 'each', 6800, 6, 2], ['SG-POST10', 'Sign post, 10 ft U-channel', 'each', 4200, 12, 4],
  ['HY-HOSE', 'Hydraulic hose assembly', 'each', 8600, 4, 2], ['OIL-1540', 'Engine oil 15W-40', 'gal', 1800, 40, 10], ['FLT-OIL', 'Oil filter, heavy truck', 'each', 2400, 10, 4],
  ['FLT-FUEL', 'Fuel filter, heavy truck', 'each', 3100, 8, 3], ['WB-22', 'Wiper blade, 22 in', 'each', 1600, 12, 4], ['LT-TAIL', 'Tail light lens', 'each', 2200, 6, 2],
  ['VB-LID', 'Valve box lid', 'each', 6500, 8, 3], ['HY-CAP', 'Hydrant nozzle cap', 'each', 4800, 6, 2], ['MH-RING', 'Manhole riser ring', 'each', 12000, 4, 2],
  ['IN-GRATE', 'Storm inlet grate', 'each', 31000, 2, 1], ['SL-LED', 'Streetlight LED head', 'each', 24500, 4, 2], ['RC-6', 'Repair clamp, 6 in', 'each', 9500, 6, 2],
  ['CUT-EDGE', 'Plow cutting edge, 11 ft', 'each', 38500, 2, 1],
];
// [name, contact]
const VENDORS = [['Keystone Paving Co.', 'Dispatch'], ['Valley Truck and Equipment', 'Service desk'], ['Tri-County Electric', 'Office'], ['Brookside Concrete', 'Orders']];
const ARTERIAL = ['Main Street', 'Bridge Street', 'Nutt Road', 'Ridge Avenue'];

// The jobs a small borough's public works does, and when.
// [title (street filled in), department kind, fund kind or null (the department's), months it happens (1-12), crew size, hours each [min, max],
//  equipment [[name, share of crew hours]], parts [[sku, min, max]], materials [[what, unit, cents each, min, max]], vendor [name, min $, max $, chance] or null,
//  on a street, the fleet asset it repairs or null]
const JOBS = [
  ['Plow and salt {street}', 'streets', 'liquid_fuels', [1, 2, 3, 12], 2, [4, 9], [['Plow 1', 1], ['Plow 2', 0.8]], [], [['Road salt', 'ton', 7400, 3, 9]], null, true, null],
  ['Fill potholes on {street}', 'streets', 'liquid_fuels', [2, 3, 4, 5, 10, 11], 2, [2, 5], [['Pickup 4', 1]], [['CP-50', 4, 14]], [], null, true, null],
  ['Sweep {street}', 'streets', 'liquid_fuels', [4, 5, 9, 10], 1, [3, 6], [['Sweeper 1', 1]], [], [], null, true, null],
  ['Mill and overlay {street}', 'streets', 'liquid_fuels', [6, 7, 8], 3, [6, 9], [['Loader 1', 0.5], ['Pickup 4', 0.4]], [], [['Hot mix asphalt', 'ton', 9800, 20, 60], ['Tack coat', 'gal', 1800, 10, 30]], ['Keystone Paving Co.', 9000, 26000, 1], true, null],
  ['Replace sign on {street}', 'streets', 'liquid_fuels', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 1, [1, 2], [['Pickup 4', 1]], [['SG-STOP30', 1, 1], ['SG-POST10', 1, 1]], [], null, true, null],
  ['Repaint crosswalks on {street}', 'streets', 'liquid_fuels', [5, 6, 7], 2, [3, 5], [['Pickup 4', 0.5]], [], [['Traffic paint', 'gal', 4200, 3, 8], ['Glass beads', 'bag', 3100, 1, 3]], null, true, null],
  ['Fix streetlight on {street}', 'streets', 'general', [1, 3, 5, 7, 9, 11], 1, [1, 2], [['Pickup 4', 1]], [['SL-LED', 1, 1]], [], ['Tri-County Electric', 350, 900, 0.5], true, null],
  ['Repair sidewalk on {street}', 'streets', 'general', [5, 6, 7, 8, 9], 2, [4, 7], [['Pickup 4', 0.5]], [], [['Concrete', 'cu yd', 16500, 1, 4]], ['Brookside Concrete', 600, 2400, 0.4], true, null],
  ['Water main break on {street}', 'water', null, [1, 2, 3, 12], 3, [5, 10], [['Loader 1', 0.6], ['Pickup 4', 0.5]], [['RC-6', 1, 2]], [['Stone, 2A modified', 'ton', 2400, 4, 12], ['Hot mix asphalt', 'ton', 9800, 2, 4]], null, true, null],
  ['Repair valve box on {street}', 'water', null, [3, 4, 5, 6, 7, 8, 9, 10], 1, [1, 3], [['Pickup 4', 1]], [['VB-LID', 1, 1]], [['Stone, 2A modified', 'ton', 2400, 1, 1]], null, true, null],
  ['Repair hydrant on {street}', 'water', null, [4, 5, 6, 7, 8, 9, 10], 2, [2, 4], [['Pickup 4', 1]], [['HY-CAP', 1, 2]], [['Hydrant paint', 'gal', 3600, 1, 2]], null, true, null],
  ['Jet sewer main on {street}', 'sewer', null, [2, 4, 6, 8, 10, 11], 2, [4, 7], [['Jet-Vac 1', 1]], [], [], null, true, null],
  ['Raise manhole on {street}', 'sewer', null, [5, 6, 7, 8, 9], 2, [3, 5], [['Pickup 4', 0.5]], [['MH-RING', 1, 2]], [['Mortar mix', 'bag', 1250, 2, 4]], null, true, null],
  ['Clear storm inlets on {street}', 'stormwater', null, [3, 4, 10, 11, 12], 2, [2, 4], [['Jet-Vac 1', 0.8]], [], [], null, true, null],
  ['Replace inlet grate on {street}', 'stormwater', null, [4, 6, 8, 10], 2, [2, 4], [['Pickup 4', 0.5]], [['IN-GRATE', 1, 1]], [], null, true, null],
  ['Leaf collection on {street}', 'sanitation', null, [10, 11, 12], 2, [5, 8], [['Packer 7', 1]], [], [], null, true, null],
  ['Bulk and brush route', 'sanitation', null, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 2, [5, 7], [['Packer 7', 1]], [], [['Tipping fee', 'ton', 7200, 2, 6]], null, false, null],
  ['Mow Riverside Park and the ball fields', 'parks', null, [5, 6, 7, 8, 9], 2, [5, 7], [['Pickup 4', 0.3]], [], [['Trimmer line and fuel mix', 'each', 2800, 1, 2]], null, false, null],
  ['Fix playground swing at Library Park', 'parks', null, [4, 6, 8], 1, [1, 3], [], [], [['Swing hanger set', 'each', 8900, 1, 2]], null, false, null],
  ['Borough hall boiler service', 'buildings', null, [10, 11], 1, [2, 3], [], [], [], ['Tri-County Electric', 450, 1200, 1], false, null],
  ['Plow 1 hydraulic repair', 'fleet', null, [1, 2, 12], 1, [3, 6], [], [['HY-HOSE', 1, 2], ['OIL-1540', 2, 5]], [], ['Valley Truck and Equipment', 300, 1800, 0.5], false, 'Plow 1'],
  ['Plow 2 cutting edge', 'fleet', null, [1, 2, 3, 11], 1, [2, 4], [], [['CUT-EDGE', 1, 1]], [], null, false, 'Plow 2'],
  ['Packer 7 brake job', 'fleet', null, [3, 7, 11], 1, [4, 7], [], [], [['Brake shoes and drums', 'set', 46000, 1, 1]], ['Valley Truck and Equipment', 900, 2600, 0.6], false, 'Packer 7'],
  ['Pickup 4 oil change', 'fleet', null, [2, 5, 8, 11], 1, [1, 1.5], [], [['OIL-1540', 2, 2], ['FLT-OIL', 1, 1], ['WB-22', 0, 2]], [], null, false, 'Pickup 4'],
  ['Sweeper 1 broom replacement', 'fleet', null, [4, 9], 1, [3, 5], [], [], [['Main broom', 'each', 52000, 1, 1]], null, false, 'Sweeper 1'],
  ['Jet-Vac 1 pump rebuild', 'fleet', null, [6], 1, [6, 10], [], [['OIL-1540', 3, 3]], [], ['Valley Truck and Equipment', 2800, 5200, 1], false, 'Jet-Vac 1'],
  ['Loader 1 service and tires', 'fleet', null, [9], 1, [3, 5], [], [['OIL-1540', 4, 4], ['FLT-OIL', 1, 1], ['FLT-FUEL', 1, 1]], [], ['Valley Truck and Equipment', 1600, 3200, 1], false, 'Loader 1'],
];

// A small fixed sequence, so every run spreads the same numbers the same way.
function seq(seed) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

module.exports = async function money(conn, T, { today, addDays, daysAgo, staffIds, userIds, ids, log }) {
  const q = async (sql, p) => (await conn.query(sql, p))[0];
  const one = async (sql, p) => (await q(sql, p))[0] || null;
  await W.ensureBooks(conn, T);
  const funds = new Map((await q('SELECT id, kind FROM funds WHERE tenant_id = ?', [T])).map((f) => [f.kind, Number(f.id)]));
  const depts = new Map((await q('SELECT id, kind, fund_id FROM departments WHERE tenant_id = ?', [T])).map((d) => [d.kind, { id: Number(d.id), fund_id: d.fund_id ? Number(d.fund_id) : null }]));
  // Riverbend charges its road work to Liquid Fuels: the Streets department's default fund.
  if (depts.get('streets') && depts.get('streets').fund_id === funds.get('general')) {
    await conn.query('UPDATE departments SET fund_id = ? WHERE tenant_id = ? AND id = ?', [funds.get('liquid_fuels'), T, depts.get('streets').id]);
    depts.get('streets').fund_id = funds.get('liquid_fuels');
  }

  // ---- labor rates, equipment rates, parts and vendors (only where missing)
  const staff = await staffIds();
  let rates = 0;
  for (const [name, cents] of RATES) {
    if (!staff.has(name)) continue;
    const [r] = await conn.query('INSERT IGNORE INTO staff_labor_rates (tenant_id, staff_id, rate_cents) VALUES (?, ?, ?)', [T, staff.get(name), cents]);
    rates += r.affectedRows;
  }
  const assets = await ids('ops_assets');
  for (const [name, cents] of EQUIPMENT) if (assets.has(name)) await conn.query('UPDATE ops_assets SET hourly_rate_cents = COALESCE(hourly_rate_cents, ?) WHERE tenant_id = ? AND id = ?', [cents, T, assets.get(name)]);
  const partIds = await ids('parts', 'sku');
  let partsMade = 0;
  for (const [sku, name, unit, cents, onHand, reorder] of PARTS) {
    if (partIds.has(sku)) continue;
    const [r] = await conn.query('INSERT INTO parts (tenant_id, sku, name, unit, unit_cost_cents, qty_on_hand, reorder_point, reorder_qty) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [T, sku, name, unit, cents, onHand, reorder, reorder * 2]);
    await conn.query("INSERT INTO part_moves (tenant_id, part_id, kind, qty, unit_cost_cents, note, at) VALUES (?, ?, 'count', ?, ?, 'Starting count', ?)", [T, r.insertId, onHand, cents, daysAgo(370)]);
    partIds.set(sku, Number(r.insertId)); partsMade += 1;
  }
  const partCost = new Map(PARTS.map((p) => [p[0], p[3]]));
  const vendorIds = await ids('vendors');
  for (const [name, contact] of VENDORS) if (!vendorIds.has(name)) vendorIds.set(name, Number((await q('INSERT INTO vendors (tenant_id, name, contact, notes) VALUES (?, ?, ?, ?)', [T, name, contact, 'Demo vendor'])).insertId));
  log(`${rates} labor rate${rates === 1 ? '' : 's'}, equipment rates on the fleet, ${partsMade} new part${partsMade === 1 ? '' : 's'} with prices`);

  // ---- a fuel log for the fleet: a fill-up every week or two for a year (only for machines with none)
  let fills = 0;
  const rnd0 = seq(11);
  for (const [name, gal, every] of [['Plow 1', 38, 9], ['Plow 2', 34, 10], ['Packer 7', 42, 7], ['Pickup 4', 22, 8], ['Loader 1', 30, 14], ['Sweeper 1', 26, 12], ['Jet-Vac 1', 36, 12], ['Generator 1', 18, 45]]) {
    if (!assets.has(name)) continue;
    if (Number((await one('SELECT COUNT(*) AS n FROM asset_fuel WHERE tenant_id = ? AND asset_id = ?', [T, assets.get(name)])).n)) continue;
    for (let d = 360; d >= 1; d -= every) {
      const g = Math.round(gal * (0.7 + rnd0() * 0.5) * 10) / 10;
      const ppg = name === 'Pickup 4' ? 329 : 389; // gasoline, diesel (cents a gallon)
      await conn.query('INSERT INTO asset_fuel (tenant_id, asset_id, filled_at, gallons, cost_cents, fuel_type) VALUES (?, ?, ?, ?, ?, ?)', [T, assets.get(name), daysAgo(d, 7, 15), g, Math.round(g * ppg), name === 'Pickup 4' ? 'gasoline' : 'diesel']);
      fills += 1;
    }
  }
  log(`${fills} fuel fill-up${fills === 1 ? '' : 's'}`);

  // ---- costs on the work orders the other demo files completed (those with no labor lines yet)
  const users = await userIds();
  const crewIds = ['Luis Ortega', 'Kevin Brandt', 'Rachel Moore'].map((n) => staff.get(n)).filter(Boolean);
  const mechanic = staff.get('Tom Kowalski') || crewIds[0] || null;
  const shop = Number((await one('SELECT labor_rate_cents FROM asset_settings WHERE tenant_id = ?', [T]) || { labor_rate_cents: 4500 }).labor_rate_cents);
  const rateOf = new Map((await q('SELECT staff_id, rate_cents FROM staff_labor_rates WHERE tenant_id = ?', [T])).map((r) => [Number(r.staff_id), Number(r.rate_cents)]));
  const equipRate = new Map((await q('SELECT id, hourly_rate_cents FROM ops_assets WHERE tenant_id = ?', [T])).map((a) => [Number(a.id), a.hourly_rate_cents === null ? null : Number(a.hourly_rate_cents)]));
  const labor = (wo, staffId, hours, day, note = null) => conn.query('INSERT INTO work_order_labor (tenant_id, work_order_id, staff_id, hours, rate_cents, personal, worked_on, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [T, wo, staffId, hours, rateOf.has(staffId) ? rateOf.get(staffId) : shop, rateOf.has(staffId) ? 1 : 0, day, note, users.get('manager') || null]);
  const equip = (wo, assetId, hours, day) => conn.query('INSERT INTO work_order_equipment (tenant_id, work_order_id, asset_id, hours, rate_cents, used_on, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [T, wo, assetId, hours, equipRate.get(assetId) || 0, day, users.get('manager') || null]);
  const part = (wo, assetId, sku, qty, at) => conn.query("INSERT INTO part_moves (tenant_id, part_id, kind, qty, unit_cost_cents, work_order_id, asset_id, at) VALUES (?, ?, 'issue', ?, ?, ?, ?, ?)", [T, partIds.get(sku), -qty, partCost.get(sku), wo, assetId, at]);
  const material = (wo, what, qty, unit, cents, day) => conn.query('INSERT INTO work_order_materials (tenant_id, work_order_id, description, qty, unit, unit_cost_cents, used_on, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [T, wo, what, qty, unit, cents, day, users.get('manager') || null]);
  // Two fixed sequences: one for the earlier work orders, one for the year, so a second run draws the same numbers.
  let rnd = seq(2026);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const between = (a, b) => Math.round((a + rnd() * (b - a)) * 4) / 4;

  const earlier = await q(`SELECT w.id, w.asset_id, w.assigned_staff_id, w.labor_hours, w.completed_at, w.title, a.name AS asset, rc.name AS category FROM work_orders w
      LEFT JOIN ops_assets a ON a.tenant_id = w.tenant_id AND a.id = w.asset_id LEFT JOIN requests rq ON rq.tenant_id = w.tenant_id AND rq.id = w.request_id LEFT JOIN request_categories rc ON rc.tenant_id = rq.tenant_id AND rc.id = rq.category_id
    WHERE w.tenant_id = ? AND w.status = 'done' AND NOT EXISTS (SELECT 1 FROM work_order_labor l WHERE l.tenant_id = w.tenant_id AND l.work_order_id = w.id)`, [T]);
  for (const w of earlier) {
    const day = String(w.completed_at || daysAgo(1)).slice(0, 10);
    const hours = Number(w.labor_hours) || between(1, 3);
    const who = w.assigned_staff_id ? Number(w.assigned_staff_id) : w.asset_id ? mechanic : pick(crewIds);
    if (who) await labor(w.id, who, hours, day);
    const cat = String(w.category || w.title || '');
    if (/pothole/i.test(cat)) { await part(w.id, null, 'CP-50', Math.max(2, Math.round(hours * 2)), `${day} 12:00:00`); if (assets.has('Pickup 4')) await equip(w.id, assets.get('Pickup 4'), hours, day); }
    else if (/sign/i.test(cat)) { await part(w.id, null, 'SG-POST10', 1, `${day} 12:00:00`); }
    else if (/light/i.test(cat)) { await part(w.id, null, 'SL-LED', 1, `${day} 12:00:00`); }
    else if (/storm|drain/i.test(cat) && assets.has('Jet-Vac 1')) await equip(w.id, assets.get('Jet-Vac 1'), Math.min(hours, 2), day);
    else if (/sewer/i.test(cat) && assets.has('Jet-Vac 1')) await equip(w.id, assets.get('Jet-Vac 1'), hours, day);
    else if (/tree|branch/i.test(cat) && assets.has('Packer 7')) await equip(w.id, assets.get('Packer 7'), hours, day);
    else if (w.asset_id && /oil|filter/i.test(w.title)) { await part(w.id, w.asset_id, 'OIL-1540', 3, `${day} 12:00:00`); await part(w.id, w.asset_id, 'FLT-OIL', 1, `${day} 12:00:00`); }
    else if (w.asset_id && /wiper/i.test(w.title)) await part(w.id, w.asset_id, 'WB-22', 2, `${day} 12:00:00`);
    else if (w.asset_id && /tail light/i.test(w.title)) await part(w.id, w.asset_id, 'LT-TAIL', 1, `${day} 12:00:00`);
    await conn.query('UPDATE work_orders SET labor_hours = (SELECT SUM(hours) FROM work_order_labor WHERE tenant_id = ? AND work_order_id = ?) WHERE tenant_id = ? AND id = ?', [T, w.id, T, w.id]);
  }
  log(`${earlier.length} completed work order${earlier.length === 1 ? '' : 's'} from the other demo files given their costs`);

  // ---- a year of completed, costed work orders
  rnd = seq(1938);
  const streets = (await q('SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1', [T])).map((s) => ({ id: Number(s.id), name: s.name }));
  if (!streets.length) { log('No streets yet: skipped the year of work orders.'); return; }
  const weighted = [...streets, ...streets.filter((s) => ARTERIAL.includes(s.name)), ...streets.filter((s) => ARTERIAL.includes(s.name))];
  const seen = new Set((await q("SELECT note FROM work_order_labor WHERE tenant_id = ? AND note LIKE 'demo-money:%'", [T])).map((r) => r.note));
  const opener = users.get('manager') || users.get('owner') || null;
  let made = 0; let n = 0;
  for (let back = 364; back >= 2; back -= 1) {
    const day = addDays(today, -back);
    const month = Number(day.slice(5, 7));
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue; // the crew works weekdays
    // About one job a working day, a few more in winter (snow) and spring (potholes).
    const count = (rnd() < ([1, 2, 3, 4, 12].includes(month) ? 0.55 : 0.35) ? 2 : 1);
    for (let k = 0; k < count; k += 1) {
      const options = JOBS.filter((j) => j[3].includes(month));
      const job = pick(options);
      n += 1;
      const key = `demo-money:${n}`;
      // Every number is drawn before checking the key, so a second run draws the same ones.
      const [titleT, deptKind, fundKind, , crewSize, [hMin, hMax], gear, parts, mats, vendor, onStreet, fleetAsset] = job;
      const street = onStreet ? pick(weighted) : null;
      const title = titleT.replace('{street}', street ? street.name : '').slice(0, 150);
      const dept = depts.get(deptKind);
      const assetId = fleetAsset && assets.has(fleetAsset) ? assets.get(fleetAsset) : null;
      const fund = fundKind ? funds.get(fundKind) : (dept ? dept.fund_id : null);
      const shuffled = crewIds.map((c) => [rnd(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      const crew = assetId ? [mechanic] : shuffled.slice(0, Math.max(1, Math.min(crewSize, crewIds.length)));
      const hours = between(hMin, hMax);
      const vendorRoll = rnd(); const vendorAmount = vendor ? Math.round(between(vendor[1], vendor[2])) * 100 : 0;
      const v = vendor && vendorRoll < vendor[3] ? [vendorIds.get(vendor[0]), vendorAmount] : null;
      const down = between(8, 60);
      const partQty = parts.map(([, a, b]) => Math.round(a + rnd() * (b - a)));
      const matQty = mats.map(([, , , a, b]) => Math.round(a + rnd() * (b - a)));
      if (seen.has(key)) continue;
      const [w] = await conn.query(`INSERT INTO work_orders (tenant_id, title, priority, status, asset_id, location, source, assigned_staff_id, due_date, opened_at, opened_by, completed_at, resolution,
          department_id, fund_id, street_id, books_checked, vendor_id, vendor_cost_cents, downtime_hours) VALUES (?, ?, ?, 'done', ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [T, title, /main break/i.test(title) ? 'urgent' : 'normal', assetId, street ? street.name : (assetId ? 'Public works garage' : null), crew[0] || null, day, `${addDays(day, -1)} 08:00:00`, opener, `${day} ${String(13 + (n % 4)).padStart(2, '0')}:30:00`,
        'Done as planned.', dept ? dept.id : null, fund, street ? street.id : null, v ? v[0] : null, v ? v[1] : null, assetId ? down : null]);
      const wo = Number(w.insertId);
      for (const [i, s] of crew.entries()) if (s) await labor(wo, s, hours, day, i === 0 ? key : null);
      for (const [name, share] of gear) if (assets.has(name)) await equip(wo, assets.get(name), Math.max(0.5, Math.round(hours * share * 4) / 4), day);
      for (const [i, [sku]] of parts.entries()) if (partQty[i] > 0 && partIds.has(sku)) await part(wo, assetId, sku, partQty[i], `${day} 12:00:00`);
      for (const [i, [what, unit, cents]] of mats.entries()) await material(wo, what, matQty[i], unit, cents, day);
      await conn.query('UPDATE work_orders SET labor_hours = (SELECT SUM(hours) FROM work_order_labor WHERE tenant_id = ? AND work_order_id = ?) WHERE tenant_id = ? AND id = ?', [T, wo, T, wo]);
      made += 1;
    }
  }
  // Departments, funds and streets for every other work order (open ones too), the way the app fills them in.
  await W.fillBooks(conn, T);
  log(`${made} new costed work order${made === 1 ? '' : 's'} over the last year`);
};
