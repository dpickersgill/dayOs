'use strict';

// The demo borough's utilities (release 2026.11.20, run by db/demo-municipal.js after 20-assets.js and 40-trash.js):
// the street each main, valve, hydrant and manhole is on; main breaks with the valves shut (Main Street's old cast iron
// main has three in five years); a water customer list imported with consent (fictional 555-01xx phones and example.com
// emails only); the pump stations' rated flows, connections and an overflow for Chapter 94; OF-07's failed screening as an
// illicit discharge case, and a year of MS4 records; the bulk pickup driving order; and an open pothole work order at
// 111 Market Street, so a new pothole call there shows the duplicate warning. Safe to run again: each part is added only
// when it is not there.
const SW = require('../../src/lib/stormwater');
const SA = require('../../src/lib/serviceaddresses');

const EW = ['Main Street', 'Bridge Street', 'Church Street', 'High Street', 'Mill Street', 'Market Street', 'Chestnut Street', 'Walnut Street'];
const NS = ['First Avenue', 'Second Avenue', 'Third Avenue', 'Fourth Avenue', 'Fifth Avenue', 'Park Avenue', 'Franklin Avenue', 'Lincoln Avenue'];

module.exports = async function utilities(conn, T, { today, addDays, daysAgo, userIds, staffIds, log }) {
  const q = async (sql, params) => (await conn.query(sql, params))[0];
  const users = await userIds();
  const manager = users.get('manager') || users.get('owner') || null;
  const crew = users.get('crew1') || manager;
  const staff = await staffIds();
  const streets = new Map((await q('SELECT id, name FROM streets WHERE tenant_id = ?', [T])).map((r) => [r.name, Number(r.id)]));
  const feat = new Map((await q('SELECT id, tag, kind, name, lat, lng FROM map_features WHERE tenant_id = ? AND tag IS NOT NULL', [T])).map((r) => [r.tag, r]));
  const id = (tag) => (feat.get(tag) ? Number(feat.get(tag).id) : null);

  // ---- the street each item is on (the grid in 20-assets.js: row i is EW[i], column j is NS[j])
  let placed = 0;
  const setStreet = async (tag, name) => { const s = streets.get(name); if (!s || !id(tag)) return; const [r] = await conn.query('UPDATE map_features SET street_id = ? WHERE tenant_id = ? AND id = ? AND street_id IS NULL', [s, T, id(tag)]); placed += r.affectedRows; };
  for (const [i, st] of EW.entries()) await setStreet(`WM-${i + 1}`, st);
  for (const [n, j] of [[1, 0], [2, 3], [3, 7]]) await setStreet(`WM-${8 + n}`, NS[j]);
  let v = 0;
  for (let i = 0; i < 8; i += 1) for (let j = 0; j < 8; j += 1) { if ((i === 0 || i === 7) && (j === 0 || j === 7)) continue; v += 1; await setStreet(`V-${100 + v}`, EW[i]); }
  for (let n = 0; n < 35; n += 1) await setStreet(`H-${201 + n}`, EW[n % 8]);
  for (let n = 0; n < 40; n += 1) await setStreet(`MH-${301 + n}`, EW[n % 8]);
  for (const [n, i] of [[1, 0], [2, 2], [3, 4], [4, 6]]) await setStreet(`SM-${n}`, EW[i]);
  if (placed) log(`${placed} map items given their street`);

  // ---- main breaks
  const [[{ n: breaks }]] = await conn.query('SELECT COUNT(*) AS n FROM main_breaks WHERE tenant_id = ?', [T]);
  if (!Number(breaks) && id('WM-1')) {
    const valvesNear = (row, cols) => cols.map((j) => { let k = 0; for (let i = 0; i < 8; i += 1) for (let jj = 0; jj < 8; jj += 1) { if ((i === 0 || i === 7) && (jj === 0 || jj === 7)) continue; k += 1; if (i === row && jj === j) return id(`V-${100 + k}`); } return null; }).filter(Boolean);
    const add = async ({ main, row, at, cause, out, off, on, repair, valves, boil = false, open = false, location, note }) => {
      const m = feat.get(main);
      const [r] = await conn.query(`INSERT INTO main_breaks (tenant_id, main_id, street_id, location, lat, lng, broke_at, cause, pipe_material, pipe_size, customers_out, boil_water, water_off_at, water_on_at, repair, repaired_at, status, notes, created_by)
        SELECT ?, f.id, f.street_id, ?, f.lat, f.lng, ?, ?, f.material, f.size, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM map_features f WHERE f.tenant_id = ? AND f.id = ?`,
      [T, location, at, cause, out, boil ? 1 : 0, off, open ? null : on, open ? null : repair, open ? null : on, open ? 'open' : 'repaired', note || null, crew, T, m.id]);
      const bid = Number(r.insertId);
      for (const vid of valves) await conn.query('INSERT INTO main_break_valves (tenant_id, break_id, valve_id, closed_at, opened_at, turns) VALUES (?, ?, ?, ?, ?, ?)', [T, bid, vid, off, open ? null : on, 24]);
      const [w] = await conn.query("INSERT INTO work_orders (tenant_id, title, description, priority, status, map_feature_id, location, source, assigned_staff_id, opened_at, opened_by, completed_at, labor_hours, resolution) VALUES (?, ?, ?, 'urgent', ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)",
        [T, `Main break: ${m.name}, ${location}`.slice(0, 150), `Water main break recorded ${at.slice(0, 16)}.`, open ? 'in_progress' : 'done', m.id, location, staff.get('Luis Ortega') || null, at, crew, open ? null : on, open ? null : 9.5, open ? null : repair]);
      await conn.query('UPDATE main_breaks SET work_order_id = ? WHERE tenant_id = ? AND id = ?', [w.insertId, T, bid]);
    };
    await add({ main: 'WM-1', row: 0, at: daysAgo(1460, 4, 20), cause: 'frost', out: 22, off: daysAgo(1460, 5, 10), on: daysAgo(1460, 11, 40), repair: 'Full-circle repair clamp, 8 in', valves: valvesNear(0, [2, 3]), location: 'In front of 140 Main Street' });
    await add({ main: 'WM-1', row: 0, at: daysAgo(610, 23, 5), cause: 'corrosion', out: 31, off: daysAgo(609, 0, 15), on: daysAgo(609, 7, 30), repair: 'Replaced 6 ft of cast iron with ductile iron', valves: valvesNear(0, [4, 5]), boil: true, location: 'Main Street at Fourth Avenue', note: 'Pressure dropped below 20 psi; the certified operator issued a boil water advisory.' });
    await add({ main: 'WM-1', row: 0, at: daysAgo(38, 6, 10), cause: 'corrosion', out: 18, off: daysAgo(38, 6, 40), on: daysAgo(38, 12, 5), repair: 'Full-circle repair clamp, 8 in', valves: valvesNear(0, [1, 2]), location: 'In front of 118 Main Street' });
    await add({ main: 'WM-2', row: 1, at: daysAgo(2, 5, 45), cause: 'unknown', out: 14, off: daysAgo(2, 6, 20), on: null, repair: null, valves: valvesNear(1, [5, 6]), open: true, location: 'In front of 214 Bridge Street', note: 'Water coming up through the asphalt. Paving restoration after the repair.' });
    await conn.query('UPDATE map_features SET condition_score = GREATEST(COALESCE(condition_score, 0), 4) WHERE tenant_id = ? AND id = ?', [T, id('WM-1')]);
    log('4 main breaks (Main Street’s main: 3 in 5 years, condition raised to Poor; one open on Bridge Street)');
  }

  // ---- the water customer list, imported with consent (fictional contacts)
  const [[{ n: imps }]] = await conn.query('SELECT COUNT(*) AS n FROM service_address_imports WHERE tenant_id = ?', [T]);
  if (!Number(imps)) {
    const [imp] = await conn.query("INSERT INTO service_address_imports (tenant_id, file_name, rows_in, consent, consent_note, replace_all, created_by, created_at) VALUES (?, 'utility-billing-export.csv', 0, 1, 'Water bill sign-up card: text and email boxes ticked', 1, ?, ?)", [T, manager, daysAgo(21, 14, 0)]);
    let rowsIn = 0; let withC = 0; let phoneN = 0;
    for (const [s, name] of EW.entries()) {
      const sid = streets.get(name);
      if (!sid) continue;
      for (let hn = 100; hn <= 196; hn += 4) {
        rowsIn += 1;
        const k = s * 100 + hn;
        const contact = k % 5 < 3; // about 3 in 5 have a phone or email on file with consent
        const phone = contact && k % 3 === 0 && phoneN < 100 ? `+1610555${String(100 + (phoneN++)).padStart(4, '0')}` : null;
        const email = contact && !phone ? `customer${k}@example.com` : null;
        const acct = `${String(s + 10).padStart(2, '0')}-${String(hn).padStart(4, '0')}`;
        await conn.query('INSERT INTO service_addresses (tenant_id, street_id, house_number, house_no, unit, account_number, match_key, phone, email, contact_ok, import_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)',
          [T, sid, String(hn), hn, SA.accountLast4(acct), SA.matchKey({ account: acct }), phone, email, phone || email ? 1 : 0, imp.insertId]);
        for (const [ch, addr] of [['sms', phone && phone.slice(2)], ['email', email]]) {
          if (!addr) continue;
          withC += 1;
          await conn.query("INSERT IGNORE INTO alert_addresses (tenant_id, channel, addr, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?, 'import')", [T, ch, addr, daysAgo(21, 14, 0)]);
        }
      }
    }
    await conn.query('UPDATE service_address_imports SET rows_in = ?, added = ?, with_contacts = ? WHERE tenant_id = ? AND id = ?', [rowsIn, rowsIn, withC, T, imp.insertId]);
    log(`${rowsIn} water customer addresses, ${withC} with a phone or email kept with consent`);
  }

  // ---- Chapter 94: rated flows, connections, an overflow
  if (id('PS-1')) await conn.query("UPDATE map_features SET pump_gpm = '{\"pump1_hours\":350,\"pump2_hours\":350}' WHERE tenant_id = ? AND id = ? AND pump_gpm IS NULL", [T, id('PS-1')]);
  if (id('PS-2')) await conn.query("UPDATE map_features SET pump_gpm = '{\"pump1_hours\":220,\"pump2_hours\":220}' WHERE tenant_id = ? AND id = ? AND pump_gpm IS NULL", [T, id('PS-2')]);
  const y = Number(today.slice(0, 4));
  for (const [yy, edus, proj, note] of [[y - 2, 18, 140, 'Infill on Walnut Street'], [y - 1, 42, 180, 'Riverside Commons, phase 1'], [y, 27, 160, 'Riverside Commons, phase 2 (part)']]) {
    await conn.query('INSERT IGNORE INTO sewer_ch94_years (tenant_id, year, new_edus, projected_edus, notes, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [T, yy, edus, proj, note, manager]);
  }
  const [[{ n: ssos }]] = await conn.query('SELECT COUNT(*) AS n FROM sewer_overflows WHERE tenant_id = ?', [T]);
  if (!Number(ssos)) {
    await conn.query("INSERT INTO sewer_overflows (tenant_id, map_feature_id, location, started_at, ended_at, gallons, cause, reached_water, reported_to_dep_at, notes, created_by) VALUES (?, ?, NULL, ?, ?, 3500, 'power', 1, ?, 'Storm knocked out power; the generator did not start. Generator serviced the next day.', ?)",
      [T, id('PS-1'), daysAgo(150, 2, 0), daysAgo(150, 5, 30), daysAgo(150, 7, 15), manager]);
    await conn.query("INSERT INTO sewer_overflows (tenant_id, map_feature_id, location, started_at, ended_at, gallons, cause, reached_water, reported_to_dep_at, notes, created_by) VALUES (?, ?, NULL, ?, ?, 400, 'grease', 0, ?, 'Grease blockage downstream; jetted and the area cleaned and limed.', ?)",
      [T, id('MH-304'), daysAgo(64, 10, 0), daysAgo(64, 12, 0), daysAgo(64, 13, 0), manager]);
    log('2 sewer overflows, connections for three years, rated flows on both pump stations');
  }

  // ---- stormwater: OF-07's case, MS4 records
  const of7 = id('OF-07');
  const [[{ n: cases }]] = await conn.query('SELECT COUNT(*) AS n FROM idd_cases WHERE tenant_id = ?', [T]);
  if (of7 && !Number(cases)) {
    await conn.query('UPDATE map_features SET condition_score = GREATEST(COALESCE(condition_score, 0), ?) WHERE tenant_id = ? AND id = ?', [SW.FAILED_SCREENING_CONDITION, T, of7]);
    const ins = (await q("SELECT id, done_at FROM asset_inspections WHERE tenant_id = ? AND map_feature_id = ? AND result = 'fail' ORDER BY done_at DESC LIMIT 1", [T, of7]))[0];
    const opened = ins ? (ins.done_at instanceof Date ? ins.done_at.toISOString().slice(0, 19).replace('T', ' ') : String(ins.done_at)) : daysAgo(4, 10);
    const ref = `IDD-${opened.slice(0, 4)}-01`;
    const [c] = await conn.query("INSERT INTO idd_cases (tenant_id, reference, outfall_id, inspection_id, opened_at, status, description, suspected_source, created_by) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)",
      [T, ref, of7, ins ? ins.id : null, opened, 'Dry-weather screening of OF-07 found a suspected illicit discharge. Color: Gray; Odor: Chemical or soapy; floatables present.', 'A floor drain or wash water upstream on Second Avenue', crew]);
    for (const [k, d, body] of [['note', 4, 'Case opened from the dry-weather screening.'], ['upstream', 3, 'Opened inlets IN-403 and IN-409: gray water at IN-409, none at IN-403.'], ['trace', 2, 'Dye test from the car wash floor drain on Second Avenue: dye reached IN-409 in 6 minutes.'], ['notice', 1, 'Notice of violation hand-delivered to the car wash owner, 10 days to disconnect the floor drain.']]) {
      await conn.query('INSERT INTO idd_case_entries (tenant_id, case_id, kind, on_date, body, user_id) VALUES (?, ?, ?, ?, ?, ?)', [T, c.insertId, k, addDays(today, -d), body, crew]);
    }
    await conn.query("UPDATE idd_cases SET status = 'source_found', responsible_party = 'Second Avenue car wash (the business)' WHERE tenant_id = ? AND id = ?", [T, c.insertId]);
    log(`Illicit discharge case ${ref} on OF-07, source found; OF-07 condition set to Poor`);
  }
  // Ten outfalls screened clean earlier this permit year (OF-07's failure is from 20-assets.js).
  const tpl = (await q("SELECT id, items FROM inspection_templates WHERE tenant_id = ? AND name = 'Outfall dry-weather screening'", [T]))[0];
  const [[{ n: clean }]] = await conn.query("SELECT COUNT(*) AS n FROM asset_inspections i JOIN map_features f ON f.tenant_id = i.tenant_id AND f.id = i.map_feature_id WHERE i.tenant_id = ? AND f.kind = 'storm_outfall' AND i.result = 'pass'", [T]);
  if (tpl && !Number(clean)) {
    const items = JSON.stringify([['flow', 'Flow present after 72 hours without rain', 'no'], ['color', 'Color of any flow', 'No flow'], ['odor', 'Odor', 'None'], ['floatables', 'Floatables, foam or oil sheen', 'no'], ['illicit', 'Suspected illicit discharge', 'no']]
      .map(([key, label, value]) => ({ key, label, value, result: 'pass' })));
    let k = 0;
    for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11]) {
      const fid = id(`OF-${String(n).padStart(2, '0')}`);
      if (!fid) continue;
      await conn.query("INSERT INTO asset_inspections (tenant_id, map_feature_id, template_id, template_name, result, items, inspector, user_id, done_at) VALUES (?, ?, ?, 'Outfall dry-weather screening', 'pass', ?, 'Luis Ortega', ?, ?)",
        [T, fid, tpl.id, items, crew, daysAgo(60 - n * 3, 9, 30)]);
      k += 1;
    }
    log(`${k} outfalls screened clean this permit year`);
  }
  const [[{ n: acts }]] = await conn.query('SELECT COUNT(*) AS n FROM ms4_activities WHERE tenant_id = ?', [T]);
  if (!Number(acts)) {
    await conn.query('INSERT IGNORE INTO ms4_settings (tenant_id, permit_number, updated_by) VALUES (?, ?, ?)', [T, 'PAG13-DEMO1', manager]);
    const list = [
      ['education', 70, 'Stormwater article in the borough newsletter', 'Every household', 2900, null, null],
      ['education', 41, 'Storm drain markers with Scout Troop 12', 'Scouts and parents', 22, 'Mill Street and Market Street', null],
      ['education', 12, 'Leaf collection and storm drains mailer', 'Every household', 2900, null, null],
      ['involvement', 55, 'Creek cleanup day', 'Residents', 37, 'Riverside Park', null],
      ['involvement', 20, 'Stormwater management plan at the council meeting', 'Council and public', 18, 'Borough Hall', null],
      ['construction', 33, 'E&S controls at Riverside Commons, phase 2', null, null, 'Riverside Commons', 'pass'],
      ['construction', 9, 'Silt fence down at 412 Walnut Street addition', null, null, '412 Walnut Street', 'fail'],
      ['housekeeping', 47, 'Public works yard: salt dome, fuel area, wash bay', null, null, 'Public works yard', 'pass'],
      ['training', 61, 'Spill response and illicit discharge spotting', null, null, 'Public works garage', null],
    ];
    for (const [kind, d, title, audience, people, location, result] of list) {
      await conn.query('INSERT INTO ms4_activities (tenant_id, kind, on_date, title, audience, people, location, attendees, result, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [T, kind, addDays(today, -d), title, audience, people, location, kind === 'training' ? ['Luis Ortega', 'Kevin Brandt', 'Dana Kim', 'Sam Whitfield'].join('\n') : null, result || 'na', manager]);
    }
    log(`${list.length} MS4 records this permit year`);
  }

  // ---- the bulk pickup driving order (Mondays)
  const [[{ n: route }]] = await conn.query('SELECT COUNT(*) AS n FROM bulk_route_order WHERE tenant_id = ?', [T]);
  if (!Number(route)) {
    const order = [['Main Street', 'up'], ['Bridge Street', 'down'], ['Church Street', 'up'], ['High Street', 'down'], ['Mill Street', 'up'], ['Market Street', 'down'], ['Chestnut Street', 'up'], ['Walnut Street', 'down']].filter(([n]) => streets.has(n));
    // Then every other street, by name, so no street with a stop is left at the end.
    for (const name of [...streets.keys()].sort()) if (!order.some(([n]) => n === name)) order.push([name, 'up']);
    for (const [i, [name, dir]] of order.entries()) await conn.query('INSERT IGNORE INTO bulk_route_order (tenant_id, weekday, street_id, position, direction, updated_by) VALUES (?, 1, ?, ?, ?, ?)', [T, streets.get(name), i + 1, dir, manager]);
    log(`Bulk pickup route order for Mondays: ${order.length} streets, the downtown loop first`);
  }

  // ---- an open pothole job at 111 Market Street (a new pothole call there shows it)
  const [[have]] = await conn.query("SELECT COUNT(*) AS n FROM work_orders WHERE tenant_id = ? AND title = 'Patch pothole at 111 Market Street'", [T]);
  if (!Number(have.n)) {
    await conn.query("INSERT INTO work_orders (tenant_id, title, description, priority, status, location, source, assigned_staff_id, due_date, opened_at, opened_by) VALUES (?, 'Patch pothole at 111 Market Street', 'Crew noticed it on the way back from the yard. About 2 ft across by the curb.', 'normal', 'open', '111 Market Street', 'manual', ?, ?, ?, ?)",
      [T, staff.get('Kevin Brandt') || null, addDays(today, 3), daysAgo(2, 15, 10), crew]);
    log('An open pothole work order at 111 Market Street');
  }
};
