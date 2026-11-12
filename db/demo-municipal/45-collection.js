'use strict';

// The demo borough's collection schedule (release 2026.11.22, Trash and recycling), run by db/demo-municipal.js after the
// foundation and the requests. Riverbend collects with its own crew: four zones that cover every demo street (Main
// Street split by side between two zones, and a business block of Railroad Street marked not collected), Trash every
// week, Recycling every other week, Yard waste from April through November, the US federal holidays for 2026 and 2027
// with the usual shift rule, leaf collection in November and Christmas trees in January, an education log, the demo's
// missed pickups given their stream, and 24 made-up residents signed up for night-before reminders (phones 555-02xx,
// emails at example.com; nothing is sent). Running it twice adds nothing the second time; a manager's changes stay.
const C = require('../../src/lib/collection');
const SN = require('../../src/lib/streetnotices');

const NOTE = 'Demo reminder sign-up (made up)';
const STREAMS = [
  ['Trash', 'trash', 'weekly', null, null, null, '#5b6770', 10,
    'Bagged household trash in your cart, lid closed\nUp to two extra bags beside the cart\nPet waste, bagged',
    'Recycling, yard waste or bulk items\nPaint, chemicals, batteries or electronics\nHot ashes'],
  ['Recycling', 'recycling', 'biweekly', '2026-01-05', null, null, '#1565c0', 20,
    'Plastic bottles, jugs and tubs\nAluminum and steel cans\nGlass bottles and jars, clear and colored\nNewspaper, mail, office paper\nFlattened cardboard',
    'Plastic bags or film\nFoam cups and trays\nPizza boxes with grease\nGarden hoses and cords'],
  ['Yard waste', 'yard', 'weekly', null, '04-01', '11-30', '#2e7d32', 30,
    'Grass clippings and leaves in paper bags\nBrush and branches, tied, under 4 feet\nGarden plants',
    'Plastic bags\nDirt, stones or sod\nTree stumps'],
];
// [name, weekday, streets]: every demo street is in a zone. Main Street is split by side.
const ZONES = [
  ['Monday north', 1, ['Bridge Street', 'Church Street', 'High Street', 'Mill Street', 'Water Street', 'Market Street', 'Chestnut Street', 'Walnut Street', 'Maple Avenue']],
  ['Tuesday south', 2, ['Oak Street', 'Pine Street', 'Cherry Street', 'Spruce Street', 'Elm Street', 'Hall Street', 'Gay Street', 'Dewees Street', 'Morgan Street', 'Nutt Road']],
  ['Thursday east', 4, ['First Avenue', 'Second Avenue', 'Third Avenue', 'Fourth Avenue', 'Fifth Avenue', 'Prospect Street', 'Franklin Avenue', 'Washington Avenue', 'Lincoln Avenue', 'Jefferson Avenue']],
  ['Friday west', 5, ['Riverside Drive', 'Canal Street', 'Railroad Street', 'School Lane', 'Park Avenue', 'Hillside Avenue', 'Valley Road', 'Orchard Lane', 'Creek Road', 'Ridge Avenue']],
];
const EDUCATION = [
  ['2026-03-16', 'mailer', 1, '2026 collection calendar mailed to every household', 'Every household', 4100],
  ['2026-05-04', 'newsletter', 1, 'Spring newsletter: what goes in the recycling cart', 'Every household', 4100],
  ['2026-09-21', 'website', 0, 'Recycling rules page updated on the borough website', 'Website visitors', null],
  ['2026-10-10', 'event', 0, 'Recycling table at the fall festival', 'About 300 visitors', null],
];
const FIRST = ['Robin', 'Jesse', 'Kerry', 'Lee', 'Marley', 'Noel', 'Oakley', 'Perry', 'Rory', 'Shay', 'Toby', 'Val'];
const LAST = ['Abbott', 'Bishop', 'Cole', 'Dunn', 'Ellis', 'Ford', 'Greer', 'Hale'];

module.exports = async function collection(conn, tenantId, helpers) {
  const q = async (sql, params) => (await conn.query(sql, params))[0];
  const say = (text) => (helpers.log ? helpers.log(text) : null);
  const streets = await helpers.ids('streets');

  // ---- settings (made once; a manager may change them)
  await q(`INSERT IGNORE INTO collection_settings (tenant_id, model, holiday_rule, reminder_hour, curb_by, ordinance_materials) VALUES (?, 'inhouse', 'shift', 18, ?, ?)`,
    [tenantId, 'Carts at the curb by 6 AM, and not before 6 PM the night before', 'Clear glass\nColored glass\nAluminum cans\nSteel and bimetallic cans\nNewspaper\nCorrugated cardboard\nLeaf waste']);

  // ---- streams, found by name
  const streamId = new Map((await q('SELECT id, name FROM collection_streams WHERE tenant_id = ?', [tenantId])).map((r) => [r.name, Number(r.id)]));
  for (const [name, kind, freq, anchor, from, to, color, sort, yes, no] of STREAMS) {
    if (streamId.has(name)) continue;
    const r = await q('INSERT INTO collection_streams (tenant_id, name, kind, frequency, anchor_date, season_start, season_end, color, materials, not_accepted, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, name, kind, freq, anchor, from, to, color, yes, no, sort]);
    streamId.set(name, Number(r.insertId));
  }

  // ---- zones, their days and streets, found by name (a zone already there keeps its streets)
  const zoneId = new Map((await q('SELECT id, name FROM collection_zones WHERE tenant_id = ?', [tenantId])).map((r) => [r.name, Number(r.id)]));
  let made = 0;
  for (const [i, [name, weekday, list]] of ZONES.entries()) {
    if (zoneId.has(name)) continue;
    const r = await q('INSERT INTO collection_zones (tenant_id, name, sort) VALUES (?, ?, ?)', [tenantId, name, (i + 1) * 10]);
    const id = Number(r.insertId);
    zoneId.set(name, id); made += 1;
    for (const s of STREAMS) await q('INSERT IGNORE INTO collection_zone_days (tenant_id, zone_id, stream_id, weekday) VALUES (?, ?, ?, ?)', [tenantId, id, streamId.get(s[0]), weekday]);
    for (const st of list) if (streets.get(st)) await q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id) VALUES (?, ?, ?)', [tenantId, id, streets.get(st)]);
    // Main Street: the odd side with Monday north, the even side with Tuesday south.
    if (name === 'Monday north' && streets.get('Main Street')) await q("INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, side) VALUES (?, ?, ?, 'odd')", [tenantId, id, streets.get('Main Street')]);
    if (name === 'Tuesday south' && streets.get('Main Street')) await q("INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, side) VALUES (?, ?, ?, 'even')", [tenantId, id, streets.get('Main Street')]);
  }
  if (made && streets.get('Railroad Street')) {
    await q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, from_no, to_no, side, not_collected) VALUES (?, NULL, ?, 500, 699, ?, 1)', [tenantId, streets.get('Railroad Street'), 'both']);
  }
  // Any street on the list that no zone has (a borough that added streets of its own) goes to the last zone.
  const covered = new Set((await q('SELECT DISTINCT street_id FROM collection_zone_streets WHERE tenant_id = ?', [tenantId])).map((r) => Number(r.street_id)));
  for (const [, id] of streets) if (!covered.has(id)) await q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id) VALUES (?, ?, ?)', [tenantId, zoneId.get('Friday west'), id]);
  say(`${made} collection zone${made === 1 ? '' : 's'} (${ZONES.length} in the demo)`);

  // ---- holidays (2026 and 2027, the shift rule), leaf collection in November, Christmas trees in January
  for (const y of [2026, 2027]) for (const hday of C.federalHolidays(y)) await q('INSERT IGNORE INTO collection_holidays (tenant_id, on_date, name) VALUES (?, ?, ?)', [tenantId, hday.on_date, hday.name]);
  const events = [
    ['leaf', 'Leaf collection, north and east', '2026-11-02', '2026-11-13', 'Rake leaves to the curb by 7 AM Monday, not into the street. No bags, sticks or stones in the pile.', ['Monday north', 'Thursday east']],
    ['leaf', 'Leaf collection, south and west', '2026-11-16', '2026-11-27', 'Rake leaves to the curb by 7 AM Monday, not into the street. No bags, sticks or stones in the pile.', ['Tuesday south', 'Friday west']],
    ['tree', 'Christmas tree pickup', '2027-01-04', '2027-01-15', 'Take off every light, ornament and stand. Trees are chipped into mulch.', []],
    ['hazardous', 'Household hazardous waste day', '2027-04-17', '2027-04-17', 'At the public works yard, 9 AM to 1 PM. Paint, chemicals, batteries and electronics. Residents only.', []],
  ];
  for (const [kind, name, from, to, notes, zones] of events) {
    if ((await q('SELECT id FROM collection_events WHERE tenant_id = ? AND name = ?', [tenantId, name])).length) continue;
    await q('INSERT INTO collection_events (tenant_id, kind, name, starts_on, ends_on, notes, zone_ids) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, kind, name, from, to, notes, JSON.stringify(zones.map((z) => zoneId.get(z)).filter(Boolean))]);
  }

  // ---- the education log
  for (const [onDate, kind, printed, title, audience, copies] of EDUCATION) {
    if ((await q('SELECT id FROM collection_education WHERE tenant_id = ? AND title = ?', [tenantId, title])).length) continue;
    await q('INSERT INTO collection_education (tenant_id, on_date, kind, printed, title, audience, copies) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, onDate, kind, printed, title, audience, copies]);
  }

  // ---- the demo's missed pickups get a stream (trash or recycling), and what the check would have said
  const missed = await q("SELECT r.id FROM requests r JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id WHERE r.tenant_id = ? AND c.code = 'missed' AND r.stream_id IS NULL ORDER BY r.id", [tenantId]);
  for (const [i, r] of missed.entries()) await q("UPDATE requests SET stream_id = ?, pickup_check = 'ok_to_report' WHERE tenant_id = ? AND id = ?", [i % 3 === 2 ? streamId.get('Recycling') : streamId.get('Trash'), tenantId, r.id]);

  // ---- 24 residents signed up for night-before reminders (confirmed, as if by code or link)
  const [have] = await q('SELECT COUNT(*) AS n FROM alert_signups WHERE tenant_id = ? AND consent_note = ?', [tenantId, NOTE]);
  if (Number(have.n) < 24) {
    const { upsertResident } = require('../../src/lib/residents');
    const names = [...streets.keys()].sort();
    for (let i = Number(have.n); i < 24; i += 1) {
      const street = names[(i * 7) % names.length];
      const house = String(101 + ((i * 37) % 380));
      const name = `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`;
      const phone = i % 4 === 3 ? null : `+1610555${String(200 + i).padStart(4, '0')}`;
      const email = i % 2 === 0 || !phone ? `${name.toLowerCase().replace(/\s+/g, '.')}.r${i}@example.com` : null;
      const residentId = await upsertResident(conn, tenantId, { name, phone, email, streetId: streets.get(street), houseNumber: house, textsOk: phone ? true : undefined, emailsOk: email ? true : undefined }, { source: 'street_notices' });
      for (const [channel, v] of [['sms', phone], ['email', email]]) {
        if (!v) continue;
        const a = await SN.addressRow(conn, tenantId, channel, v);
        if (!a.confirmed_at) {
          await q("UPDATE alert_addresses SET confirmed_at = UTC_TIMESTAMP() - INTERVAL ? DAY, confirmed_by = 'code' WHERE tenant_id = ? AND id = ?", [5 + i, tenantId, a.id]);
          await SN.recordAnswer(conn, tenantId, a.id, 'opted_in', 'signup_code');
        }
      }
      const picked = i % 3 === 0 ? ['Trash', 'Recycling', 'Yard waste'] : i % 3 === 1 ? ['Recycling'] : ['Trash', 'Recycling'];
      await q(`INSERT INTO alert_signups (tenant_id, resident_id, name, street_id, house_number, house_no, phone, email, topics, collection_streams, by_text, by_email, status, source, consent_note, created_at, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'water,trash', ?, ?, ?, 'active', 'web', ?, UTC_TIMESTAMP() - INTERVAL ? DAY, UTC_TIMESTAMP() - INTERVAL ? DAY)`,
      [tenantId, residentId, name, streets.get(street), house, Number(house), phone, email, picked.map((p) => streamId.get(p)).join(','), phone ? 1 : 0, email ? 1 : 0, NOTE, 5 + i, 5 + i]);
    }
    say(`${24 - Number(have.n)} reminder sign-ups`);
  }

  // ---- published: every street is in a zone (or marked not collected)
  await q('UPDATE collection_settings SET setup_done_at = COALESCE(setup_done_at, UTC_TIMESTAMP()) WHERE tenant_id = ?', [tenantId]);
};
