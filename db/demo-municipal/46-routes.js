'use strict';

// The demo borough's collection routes and hauler oversight (release 2026.11.22, workstream "routes"), run after the
// collection schedule (45-collection.js). It turns on the Collection routes and Hauler oversight add-ons, adds two packer
// trucks that also plow (Packer 8, Packer 9) beside Packer 7, lists the collection trucks, and then:
//   - the last ten collection days' routes, finished: every street done except a few skipped (with a photo), crew hours,
//     truck hours and a landfill and a recycling ticket, so Costs and the monthly report's Sanitation line have numbers;
//   - today's routes, when today is a collection day: the first on the road with Packer 8 (crew1 and crew2), two thirds
//     of its streets marked, one skipped for parked cars; the second assigned to crew3 and not started; the rest open;
//   - a go-back from a demo missed pickup on tomorrow's route, and one plowing day on Packer 9 last winter;
//   - the hauler contract the borough would use if it contracted (the Hauler tab shows when Who collects is a hauler).
// Made-up data only; nothing is sent. Running it twice adds nothing the second time.
const { createCanvas } = require('@napi-rs/canvas');
const R = require('../../src/lib/collectionroutes');
const { addDays, weekdayOf } = require('../../src/lib/util');

/** A plain photo for a skipped street (a gray square with words on it), as a JPEG. */
function photo(words) {
  const c = createCanvas(480, 360); const g = c.getContext('2d');
  g.fillStyle = '#8a9399'; g.fillRect(0, 0, 480, 360); g.fillStyle = '#ffffff'; g.font = '28px sans-serif'; g.fillText(words, 24, 190);
  return c.toBuffer('image/jpeg');
}

module.exports = async function routes(conn, tenantId, helpers) {
  const q = async (sql, params) => (await conn.query(sql, params))[0];
  const say = (text) => (helpers.log ? helpers.log(text) : null);
  const t = tenantId;
  for (const k of ['collectionroutes', 'hauler']) await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [t, k]);
  require('../../src/lib/modules').invalidate(t);

  // ---- trucks
  const assets = await helpers.ids('ops_assets');
  for (const [name, tag, miles] of [['Packer 8', 'RB-108', 58210], ['Packer 9', 'RB-109', 40330]]) {
    if (assets.has(name)) continue;
    const r = await q("INSERT INTO ops_assets (tenant_id, name, kind, category, make_model, asset_tag, model_year, hours, miles, fuel_type, notes, hourly_rate_cents) VALUES (?, ?, 'truck', 'fleet', 'Rear-load packer, 25 cubic yards, plow hitch', ?, 2019, 5200, ?, 'diesel', 'Collection Monday to Friday; plows in a storm.', 9000)", [t, name, tag, miles]);
    assets.set(name, Number(r.insertId));
  }
  for (const [name, plows] of [['Packer 7', 0], ['Packer 8', 1], ['Packer 9', 1]]) {
    if (assets.has(name)) await q('INSERT IGNORE INTO collection_trucks (tenant_id, asset_id, plows) VALUES (?, ?, ?)', [t, assets.get(name), plows]);
  }
  const users = await helpers.userIds();
  const mgrId = users.get('manager') || users.get('owner');
  const req = { auth: { tenantId: t, userId: mgrId, role: 'manager', staffId: null }, ip: null, headers: {} };
  const userStaff = new Map((await q('SELECT id, staff_id FROM users WHERE tenant_id = ?', [t])).map((u) => [Number(u.id), u.staff_id ? Number(u.staff_id) : null]));
  const crewOn = async (routeId, names) => { for (const u of names) if (users.get(u)) await q('INSERT IGNORE INTO collection_route_crew (tenant_id, route_id, user_id, staff_id, added_by) VALUES (?, ?, ?, ?, ?)', [t, routeId, users.get(u), userStaff.get(users.get(u)), mgrId]); };
  const addPhoto = async (routeId, stopId, at, words) => {
    const buf = photo(words);
    const sha = require('crypto').createHash('sha256').update(buf).digest('hex');
    const r = await q("INSERT INTO collection_photos (tenant_id, route_id, stop_id, mime, bytes, sha256, original, taken_at, taken_from, uploaded_by, uploaded_at) VALUES (?, ?, ?, 'image/jpeg', ?, ?, ?, ?, 'phone', ?, ?)", [t, routeId, stopId, buf.length, sha, buf, at, mgrId, at]);
    return Number(r.insertId);
  };
  const markAll = async (routeId, date, { upTo = 1, skipEvery = 9, startHour = 6 } = {}) => {
    const stops = await q("SELECT id FROM collection_route_stops WHERE tenant_id = ? AND route_id = ? AND status = 'todo' ORDER BY position, id", [t, routeId]);
    const n = Math.floor(stops.length * upTo);
    for (const [i, s] of stops.slice(0, n).entries()) {
      const at = `${date} ${String(startHour + Math.floor((i * 8) / 60)).padStart(2, '0')}:${String((i * 8) % 60).padStart(2, '0')}:00`;
      if (skipEvery && i % skipEvery === skipEvery - 1) {
        const pid = await addPhoto(routeId, s.id, at, 'Cars parked at the curb');
        await q("UPDATE collection_route_stops SET status = 'skipped', reason = 'parked_cars', photo_id = ?, marked_at = ?, marked_by = ? WHERE tenant_id = ? AND id = ?", [pid, at, mgrId, t, s.id]);
      } else await q("UPDATE collection_route_stops SET status = 'done', marked_at = ?, marked_by = ?, marked_lat = ?, marked_lng = ? WHERE tenant_id = ? AND id = ?", [at, mgrId, (40.13 + i * 0.0007).toFixed(6), (-75.515 + (i % 5) * 0.0011).toFixed(6), t, s.id]);
    }
    return n;
  };

  // ---- the last ten collection days, finished and costed
  const today = helpers.today;
  let past = 0; let costed = 0;
  for (let d = addDays(today, -1); past < 10 && d > addDays(today, -40); d = addDays(d, -1)) {
    if (weekdayOf(d) === 0 || weekdayOf(d) === 6) continue;
    await R.ensureRoutes(t, d);
    const list = await q("SELECT r.id, r.status, st.kind FROM collection_routes r JOIN collection_streams st ON st.tenant_id = r.tenant_id AND st.id = r.stream_id WHERE r.tenant_id = ? AND r.on_date = ? ORDER BY r.sort, r.id", [t, d]);
    if (!list.length) continue;
    past += 1;
    for (const [i, r] of list.entries()) {
      if (r.status === 'done' || r.status === 'delayed') continue;
      const truck = assets.get(['Packer 8', 'Packer 9', 'Packer 7'][i % 3]);
      await crewOn(r.id, i % 2 ? ['crew3', 'crew4'] : ['crew1', 'crew2']);
      await q("UPDATE collection_routes SET asset_id = ?, status = 'started', started_at = ?, pretrip_skipped = 0 WHERE tenant_id = ? AND id = ?", [truck, `${d} 06:00:00`, t, r.id]);
      await markAll(r.id, d, { skipEvery: 11 });
      const tons = r.kind === 'recycling' ? 3.4 + (i % 3) * 0.3 : 8.1 + (i % 4) * 0.4;
      await R.finish(req, r.id, { truck_id: truck, truck_hours: 6.5, crew: (await q('SELECT user_id FROM collection_route_crew WHERE tenant_id = ? AND route_id = ?', [t, r.id])).map((c) => ({ user_id: Number(c.user_id), hours: 7 })),
        tickets: [{ facility: r.kind === 'recycling' ? 'Valley Recycling Center' : 'Pottstown Landfill', ticket_no: `${r.kind === 'recycling' ? 'R' : 'L'}-${d.replace(/-/g, '').slice(2)}${i}`, net_tons: Math.round(tons * 100) / 100, fee_cents: Math.round(tons * (r.kind === 'recycling' ? 1500 : 7000)) }] });
      await q('UPDATE collection_routes SET finished_at = ? WHERE tenant_id = ? AND id = ?', [`${d} 13:30:00`, t, r.id]);
      costed += 1;
    }
  }
  say(`${costed} past routes finished and costed`);

  // ---- today
  await R.ensureRoutes(t, today);
  const todays = await q('SELECT id, status FROM collection_routes WHERE tenant_id = ? AND on_date = ? ORDER BY sort, id', [t, today]);
  if (todays.length && todays[0].status === 'planned') {
    const [first, second] = todays;
    await crewOn(first.id, ['crew1', 'crew2']);
    await q("UPDATE collection_routes SET asset_id = ?, status = 'started', started_at = ?, started_by = ?, odometer_start = ?, pretrip_skipped = 0, last_lat = 40.1352, last_lng = -75.5121, last_seen_at = ? WHERE tenant_id = ? AND id = ?",
      [assets.get('Packer 8'), `${today} 06:05:00`, users.get('crew1'), 58240, `${today} 09:40:00`, t, first.id]);
    await markAll(first.id, today, { upTo: 0.66, skipEvery: 7 });
    if (second) await crewOn(second.id, ['crew3']);
    say(`today: ${todays.length} routes, the first on the road`);
  }

  // ---- a go-back for tomorrow from a demo missed pickup
  const missed = await q("SELECT q.id FROM requests q JOIN request_categories c ON c.tenant_id = q.tenant_id AND c.id = q.category_id WHERE q.tenant_id = ? AND c.name LIKE 'Missed%' AND q.street_id IS NOT NULL ORDER BY q.status IN ('new','assigned') DESC, q.id DESC LIMIT 1", [t]);
  if (missed.length && !(await q('SELECT id FROM collection_gobacks WHERE tenant_id = ? AND request_id = ?', [t, missed[0].id])).length) {
    const rq = (await q('SELECT street_id, house_number FROM requests WHERE tenant_id = ? AND id = ?', [t, missed[0].id]))[0];
    await q('INSERT INTO collection_gobacks (tenant_id, request_id, street_id, house_number, note, due_on, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, missed[0].id, rq.street_id, rq.house_number, 'Resident called: cart was out by 6', addDays(today, 1), mgrId]);
    say('a go-back for tomorrow');
  }

  // ---- a plowing day last winter on Packer 9
  const plowDay = `${Number(today.slice(0, 4)) - (today.slice(5) < '03-01' ? 1 : 0)}-01-27`;
  if (assets.get('Packer 9') && plowDay < today && !(await q("SELECT id FROM collection_truck_jobs WHERE tenant_id = ? AND asset_id = ? AND job = 'plowing'", [t, assets.get('Packer 9')])).length) {
    const staff = await helpers.staffIds();
    const luis = [...staff.values()][0];
    await R.logTruckHours(req, { truck_id: assets.get('Packer 9'), job: 'plowing', hours: 9, on_date: plowDay, crew: luis ? [{ staff_id: luis, hours: 9 }] : [] });
    say('a plowing day');
  }

  // ---- the hauler contract (for when Who collects is a contracted hauler)
  if (!(await q('SELECT id FROM hauler_contracts WHERE tenant_id = ?', [t])).length) {
    await q("INSERT INTO hauler_contracts (tenant_id, hauler_name, starts_on, ends_on, service_hours, households, price_per_household_cents, penalty_cents, penalty_after, terms, updated_by) VALUES (?, 'Valley Waste Services (made up)', ?, ?, 24, 4100, 22800, 5000, 2, ?, ?)",
      [t, `${today.slice(0, 4)}-01-01`, `${Number(today.slice(0, 4)) + 2}-12-31`, 'Weekly trash, every-other-week recycling, yard waste April to November. Carts supplied by the hauler. Two late missed pickups a month before penalties.', mgrId]);
  }
};
