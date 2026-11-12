'use strict';

// The demo borough's foundation (run by db/demo-municipal.js): logins and staff, the street list, the public works fleet
// with meters and service plans, and work orders (6 open, 10 done). Every name is made up. Safe to run again: each row is
// found by its username, name or title first.

const PEOPLE = [
  // [username, role, first, last, position or null]
  ['owner', 'owner', 'Dana', 'Whitfield', null],
  ['manager', 'manager', 'Marcus', 'Hale', 'Public works director'],
  ['crew1', 'staff', 'Luis', 'Ortega', 'Equipment operator'],
  ['crew2', 'staff', 'Kevin', 'Brandt', 'Equipment operator'],
  ['crew3', 'staff', 'Tom', 'Kowalski', 'Mechanic'],
  ['crew4', 'staff', 'Rachel', 'Moore', 'Laborer'],
  ['frontdesk', 'counter', 'Janet', 'Price', 'Front desk clerk'],
];
const POSITIONS = [['Public works director', 'admin'], ['Equipment operator', 'maintenance'], ['Mechanic', 'maintenance'], ['Laborer', 'maintenance'], ['Front desk clerk', 'admin']];

// Forty ordinary street names, the kind found in any small Pennsylvania borough.
const STREETS = [
  ['Main Street', 'Main St'], ['Bridge Street', 'Bridge St'], ['Church Street', 'Church St'], ['High Street', 'High St'], ['Mill Street', 'Mill St'],
  ['Water Street', 'Water St'], ['Market Street', 'Market St'], ['Chestnut Street', 'Chestnut St'], ['Walnut Street', 'Walnut St'], ['Maple Avenue', 'Maple Ave'],
  ['Oak Street', 'Oak St'], ['Pine Street', 'Pine St'], ['Cherry Street', 'Cherry St'], ['Spruce Street', 'Spruce St'], ['Elm Street', 'Elm St'],
  ['Hall Street', 'Hall St'], ['Gay Street', 'Gay St'], ['Dewees Street', 'Dewees St'], ['Morgan Street', 'Morgan St'], ['Nutt Road', 'Nutt Rd'],
  ['First Avenue', '1st Ave'], ['Second Avenue', '2nd Ave'], ['Third Avenue', '3rd Ave'], ['Fourth Avenue', '4th Ave'], ['Fifth Avenue', '5th Ave'],
  ['Prospect Street', 'Prospect St'], ['Franklin Avenue', 'Franklin Ave'], ['Washington Avenue', 'Washington Ave'], ['Lincoln Avenue', 'Lincoln Ave'], ['Jefferson Avenue', 'Jefferson Ave'],
  ['Riverside Drive', 'Riverside Dr'], ['Canal Street', 'Canal St'], ['Railroad Street', 'Railroad St'], ['School Lane', 'School Ln'], ['Park Avenue', 'Park Ave'],
  ['Hillside Avenue', 'Hillside Ave'], ['Valley Road', 'Valley Rd'], ['Orchard Lane', 'Orchard Ln'], ['Creek Road', 'Creek Rd'], ['Ridge Avenue', 'Ridge Ave'],
];

// [name, kind, category, make and model, tag, plate, year, hours, miles, fuel, notes]
const FLEET = [
  ['Plow 1', 'truck', 'fleet', 'Tandem-axle dump truck with 11 ft plow and spreader', 'RB-101', 'MG-10101', 2017, 6120, 48210, 'diesel', 'Primary plow route north of Bridge Street.'],
  ['Plow 2', 'truck', 'fleet', 'Single-axle dump truck with 10 ft plow and spreader', 'RB-102', 'MG-10102', 2020, 3480, 27890, 'diesel', 'Primary plow route south of Bridge Street.'],
  ['Packer 7', 'truck', 'fleet', 'Rear-load packer truck, 25 cubic yards', 'RB-107', 'MG-10107', 2016, 9310, 71400, 'diesel', 'Bulk trash pickups and brush.'],
  ['Pickup 4', 'truck', 'fleet', 'Three-quarter-ton pickup with liftgate', 'RB-104', 'MG-10104', 2021, 1890, 31220, 'gasoline', 'Crew leader truck.'],
  ['Loader 1', 'loader', 'fleet', 'Wheel loader, 2.5 cubic yard bucket', 'RB-120', null, 2014, 7240, null, 'diesel', 'Salt pile and leaf season.'],
  ['Sweeper 1', 'loader', 'fleet', 'Mechanical street sweeper', 'RB-130', 'MG-10130', 2018, 4120, 19870, 'diesel', 'Spring and fall sweeping schedule.'],
  ['Jet-Vac 1', 'truck', 'fleet', 'Combination sewer jet and vacuum truck', 'RB-140', 'MG-10140', 2019, 2760, 15430, 'diesel', 'Sewer line cleaning and inlet vacuuming.'],
  ['Generator 1', 'generator', 'equipment', 'Trailer-mounted 125 kW generator', 'RB-150', null, 2015, 610, null, 'diesel', 'Backup power for the Mill Street pump station.'],
];

// [name, asset or null, every days, every hours, every miles, checklist]
const PLANS = [
  ['Plow 1 oil and filter', 'Plow 1', null, 250, 5000, 'Drain and refill engine oil\nReplace oil and fuel filters\nGrease plow and spreader'],
  ['Plow 1 plow and spreader check', 'Plow 1', 30, null, null, 'Cutting edge wear\nHydraulic hoses and fittings\nSpreader chain and spinner'],
  ['Plow 2 oil and filter', 'Plow 2', null, 250, 5000, 'Drain and refill engine oil\nReplace oil and fuel filters\nGrease plow and spreader'],
  ['Plow 2 plow and spreader check', 'Plow 2', 30, null, null, 'Cutting edge wear\nHydraulic hoses and fittings\nSpreader chain and spinner'],
  ['Packer 7 hydraulic service', 'Packer 7', 90, 500, null, 'Hydraulic fluid and filter\nPacker blade wear shoes\nTailgate seals'],
  ['Pickup 4 oil change', 'Pickup 4', 180, null, 5000, 'Oil and filter\nTire rotation\nWiper blades'],
  ['Loader 1 service', 'Loader 1', null, 250, null, 'Engine oil and filter\nGrease all fittings\nBucket teeth and cutting edge'],
  ['Sweeper 1 broom and service', 'Sweeper 1', 60, 200, null, 'Main and gutter broom wear\nWater spray nozzles\nEngine oil'],
  ['Jet-Vac 1 pump and hose check', 'Jet-Vac 1', 30, null, null, 'Water pump pressure test\nHose reel and jetter nozzles\nVacuum tube and boom'],
  ['Generator 1 monthly test run', 'Generator 1', 30, null, null, 'Run under load for 30 minutes\nCheck fuel level and coolant\nRecord hours'],
  ['Annual state inspection, Plow 1', 'Plow 1', 365, null, null, 'Book the inspection station\nBrakes, lights and tires first'],
  ['Annual state inspection, Packer 7', 'Packer 7', 365, null, null, 'Book the inspection station\nBrakes, lights and tires first'],
];

// [title, asset or null, location, priority, assigned (username), due in days (from today), source, details]
const OPEN = [
  ['Replace cutting edge on Plow 2', 'Plow 2', 'Public works garage', 'high', 'crew3', 3, 'manual', 'Edge is worn past the wear marks after the last storm.'],
  ['Fix hydraulic leak on loader', 'Loader 1', 'Salt shed', 'urgent', 'crew3', 0, 'manual', 'Steady drip from the lift cylinder hose. Keep it out of the salt pile until fixed.'],
  ['Patch potholes on Bridge Street', null, 'Bridge Street, 200 to 400 block', 'high', 'crew1', -2, 'manual', 'Cold patch for now; mill and overlay is on the summer list.'],
  ['Replace stop sign at Church Street and Second Avenue', null, 'Church Street at Second Avenue', 'urgent', 'crew4', 0, 'manual', 'Sign knocked down overnight. Temporary stand is up.'],
  ['Sweeper main broom worn', 'Sweeper 1', 'Public works garage', 'normal', 'crew2', 10, 'manual', 'Order a new main broom before spring sweeping.'],
  ['Clear storm inlet on Water Street', null, 'Water Street at Canal Street', 'normal', null, 5, 'manual', 'Leaves blocking the grate; ponding in heavy rain.'],
];
// [title, asset or null, location, assigned, done days ago, labor hours, what was done, source]
const DONE = [
  ['Plow 1 oil and filter', 'Plow 1', 'Public works garage', 'crew3', 12, 2, 'Oil and both filters changed, plow greased.', 'preventive'],
  ['Generator 1 monthly test run', 'Generator 1', 'Mill Street pump station', 'crew2', 9, 1, 'Ran 30 minutes under load. Fuel at three quarters.', 'preventive'],
  ['Replace tail light on Packer 7', 'Packer 7', 'Public works garage', 'crew3', 8, 0.5, 'Replaced left tail light bulb and lens.', 'manual'],
  ['Pick up branches after the windstorm', 'Pickup 4', 'Riverside Drive and Creek Road', 'crew1', 7, 6, 'Two loads to the brush pile.', 'manual'],
  ['Fill potholes on Main Street', null, 'Main Street, 100 to 300 block', 'crew4', 6, 3, 'Eleven potholes filled with cold patch.', 'manual'],
  ['Jet-Vac 1 pump and hose check', 'Jet-Vac 1', 'Public works garage', 'crew3', 5, 1.5, 'Pressure normal; replaced one worn nozzle.', 'preventive'],
  ['Repaint crosswalk at School Lane', null, 'School Lane at Third Avenue', 'crew2', 4, 4, 'Both crosswalks repainted.', 'manual'],
  ['Replace wiper blades on Plow 2', 'Plow 2', 'Public works garage', 'crew3', 3, 0.25, 'New blades front and rear.', 'manual'],
  ['Reset fallen speed limit sign on Valley Road', null, 'Valley Road near Orchard Lane', 'crew4', 2, 1, 'Reset on a new post.', 'manual'],
  ['Loader 1 service', 'Loader 1', 'Salt shed', 'crew3', 1, 3, 'Oil, filters and grease. Bucket edge is good for the season.', 'preventive'],
];

module.exports = async function base(conn, T, { passwordHash, slug, today, addDays, daysAgo, ids, staffIds, userIds, log }) {
  // ---- positions, people, staff records and logins
  const posIds = await ids('positions');
  for (const [name, dept] of POSITIONS) if (!posIds.has(name)) { const [r] = await conn.query('INSERT INTO positions (tenant_id, name, department) VALUES (?, ?, ?)', [T, name, dept]); posIds.set(name, Number(r.insertId)); }
  const haveUsers = await userIds();
  let made = 0;
  for (const [username, role, first, last, position] of PEOPLE) {
    if (haveUsers.has(username)) continue;
    const email = ['owner', 'manager'].includes(role) ? `${username}@${slug}.test` : null;
    const [p] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [T, first, last, email]);
    let staffId = null;
    if (position) {
      const [s] = await conn.query("INSERT INTO staff (tenant_id, person_id, status, hired_on) VALUES (?, ?, 'active', ?)", [T, p.insertId, addDays(today, -400 - made * 90)]);
      staffId = Number(s.insertId);
      await conn.query('INSERT INTO staff_positions (tenant_id, staff_id, position_id) VALUES (?, ?, ?)', [T, staffId, posIds.get(position)]);
    }
    await conn.query('INSERT INTO users (tenant_id, person_id, staff_id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)', [T, p.insertId, staffId, email, username, passwordHash, role]);
    made += 1;
  }
  log(`${made} new login${made === 1 ? '' : 's'} (owner, manager, four crew, front desk)`);

  // ---- streets
  const [st] = await conn.query(`INSERT IGNORE INTO streets (tenant_id, name, aliases) VALUES ${STREETS.map(() => '(?, ?, ?)').join(', ')}`, STREETS.flatMap(([n, a]) => [T, n, a]));
  log(`${st.affectedRows} new street${st.affectedRows === 1 ? '' : 's'} (${STREETS.length} on the list)`);

  // ---- the fleet, with meters
  const assets = await ids('ops_assets');
  let fleet = 0;
  for (const [name, kind, category, model, tag, plate, year, hours, miles, fuel, notes] of FLEET) {
    if (assets.has(name)) continue;
    const [r] = await conn.query('INSERT INTO ops_assets (tenant_id, name, kind, category, make_model, asset_tag, plate, model_year, hours, miles, fuel_type, notes, critical) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [T, name, kind, category, model, tag, plate, year, hours, miles, fuel, notes, name.startsWith('Plow') || name === 'Generator 1' ? 1 : 0]);
    assets.set(name, Number(r.insertId));
    fleet += 1;
  }
  log(`${fleet} new vehicle${fleet === 1 ? '' : 's'} and machine${fleet === 1 ? '' : 's'}`);

  // ---- service plans, last done a while ago so some are due
  const [havePlans] = await conn.query('SELECT name FROM pm_tasks WHERE tenant_id = ?', [T]);
  const planNames = new Set(havePlans.map((r) => r.name));
  let plans = 0;
  for (const [i, [name, asset, days, hours, miles, checklist]] of PLANS.entries()) {
    if (planNames.has(name)) continue;
    const a = asset ? FLEET.find((f) => f[0] === asset) : null;
    const lastHours = a && hours ? a[7] - hours + 20 + i * 5 : a ? a[7] - 40 : null; // some nearly due on hours
    const lastMiles = a && miles && a[8] ? a[8] - miles + 400 : a && a[8] ? a[8] - 900 : null;
    const lastOn = days ? addDays(today, -(days - 3 + (i % 4) * 2)) : addDays(today, -60);
    await conn.query('INSERT INTO pm_tasks (tenant_id, name, asset_id, interval_days, interval_hours, interval_miles, checklist, last_done_on, last_done_hours, last_done_miles) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [T, name, asset ? assets.get(asset) : null, days, hours, miles, checklist, lastOn, lastHours, lastMiles]);
    plans += 1;
  }
  log(`${plans} new service plan${plans === 1 ? '' : 's'}`);

  // ---- work orders: 6 open, 10 done
  const staff = await staffIds();
  const users = await userIds();
  const crewStaff = (username) => { const p = PEOPLE.find((x) => x[0] === username); return p ? staff.get(`${p[2]} ${p[3]}`) || null : null; };
  const [haveWo] = await conn.query('SELECT title FROM work_orders WHERE tenant_id = ?', [T]);
  const titles = new Set(haveWo.map((r) => r.title));
  const opener = users.get('manager') || users.get('owner');
  let wos = 0;
  for (const [i, [title, asset, location, priority, who, dueIn, source, details]] of OPEN.entries()) {
    if (titles.has(title)) continue;
    await conn.query("INSERT INTO work_orders (tenant_id, title, description, priority, status, asset_id, location, source, assigned_staff_id, due_date, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [T, title, details, priority, i === 1 ? 'in_progress' : 'open', asset ? assets.get(asset) : null, location, source, who ? crewStaff(who) : null, addDays(today, dueIn), daysAgo(3 - (i % 3), 8 + i), opener]);
    wos += 1;
  }
  for (const [i, [title, asset, location, who, ago, labor, resolution, source]] of DONE.entries()) {
    if (titles.has(title)) continue;
    const [r] = await conn.query("INSERT INTO work_orders (tenant_id, title, priority, status, asset_id, location, source, assigned_staff_id, due_date, opened_at, opened_by, completed_at, labor_hours, resolution) VALUES (?, ?, 'normal', 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [T, title, asset ? assets.get(asset) : null, location, source, crewStaff(who), addDays(today, -ago), daysAgo(ago + 2, 7 + (i % 3)), opener, daysAgo(ago, 13 + (i % 4), 15), labor, resolution]);
    await conn.query('INSERT INTO work_order_notes (tenant_id, work_order_id, user_id, body) VALUES (?, ?, ?, ?)', [T, r.insertId, users.get(who) || opener, `Completed: ${resolution}`]);
    wos += 1;
  }
  log(`${wos} new work order${wos === 1 ? '' : 's'}`);
};
// What this file makes, so a test can count its own rows apart from the other demo files' (2026.11.20).
module.exports.ROWS = { PEOPLE, STREETS, FLEET, PLANS, OPEN, DONE };
