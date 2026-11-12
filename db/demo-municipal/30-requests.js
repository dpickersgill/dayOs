'use strict';

// The demo borough's resident requests (run by db/demo-municipal.js after 00-base.js): 120 requests over the last six
// months across the categories and streets, with realistic times (most made safe and fixed within the response standard,
// some late, a few passed to PennDOT, a few duplicates and closed with no action), before and after photos (simple
// pictures drawn here, never downloaded), and 5 new ones today. Every resident is made up. Safe to run again: each demo
// request has its own key and is added only when it is not there.
const crypto = require('crypto');
const zlib = require('zlib');
const Q = require('../../src/lib/requests');

// ---------------------------------------------------------------- a small PNG, drawn in code
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** A 160 x 120 picture: road-gray ground, a stripe in the category's color, and a dark patch (before) or a neat one (after). */
function picture(color, stage, seed) {
  const W = 160; const H = 120;
  const rows = [];
  const [cr, cg, cb] = hexRgb(color);
  for (let y = 0; y < H; y += 1) {
    const row = Buffer.alloc(1 + W * 3);
    for (let x = 0; x < W; x += 1) {
      const noise = ((x * 31 + y * 17 + seed * 7) % 13) - 6;
      let px = [118 + noise, 120 + noise, 122 + noise];
      if (y < 10) px = [cr, cg, cb];
      const dx = (x - 80) / 36; const dy = (y - 68) / 22;
      if (stage === 'before' && dx * dx + dy * dy < 1) px = [44 + noise, 42 + noise, 40 + noise];
      if (stage === 'after' && Math.abs(x - 80) < 38 && Math.abs(y - 68) < 24) px = [70, 72, 74];
      if (stage === 'made_safe' && ((x - 30) ** 2 + (y - 80) ** 2 < 90 || (x - 130) ** 2 + (y - 80) ** 2 < 90)) px = [236, 108, 0];
      row.set(px.map((v) => Math.max(0, Math.min(255, v))), 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- the borough's choices
// [category, make safe hours, fix hours, how often it is reported (weight)]
// The borough's sample response targets, so the repair record shows which requests met them and which did not: a pothole
// made safe in 24 hours and fixed in 5 days, a sign down made safe in 4 hours and fixed in 3 days, a street light fixed
// in 10 days, a water leak or a sewer backup made safe in 2 hours.
const STANDARDS = [
  ['Pothole', 24, 120, 30], ['Street light out', null, 240, 18], ['Sign down or damaged', 4, 72, 8], ['Sidewalk or curb', 48, 720, 7],
  ['Storm drain or flooding', 8, 72, 8], ['Water leak or low pressure', 2, 24, 6], ['Sewer backup', 2, 24, 4], ['Missed pickup', null, 48, 10],
  ['Tree or branch down', 4, 72, 7], ['Other', null, null, 2],
];
const ARTERIAL = ['Main Street', 'Bridge Street', 'Nutt Road', 'Ridge Avenue'];
const COLLECTOR = ['Church Street', 'High Street', 'Gay Street', 'Washington Avenue', 'Valley Road', 'Market Street'];
const FIRST = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Taylor', 'Quinn', 'Reese', 'Skyler', 'Parker', 'Rowan', 'Emerson', 'Hayden', 'Logan', 'Sawyer', 'Finley'];
const LAST = ['Calloway', 'Brennan', 'Okafor', 'Lindqvist', 'Marchetti', 'Delacroix', 'Abernathy', 'Kowalczyk', 'Nakamura', 'Fairbanks', 'Holloway', 'Szabo', 'Whitcombe', 'Prentiss'];
const WORDS = {
  Pothole: ['Deep pothole in the travel lane', 'Pothole by the storm drain, cars swerving', 'Several potholes in a row', 'Pothole getting bigger after the rain'],
  'Street light out': ['Light out in front of the house', 'Street light flickers all night', 'Two lights out on this block'],
  'Sign down or damaged': ['Stop sign knocked over', 'Speed limit sign bent', 'Street name sign missing'],
  'Sidewalk or curb': ['Sidewalk slab lifted by a tree root', 'Curb broken at the corner', 'Trip hazard on the sidewalk'],
  'Storm drain or flooding': ['Inlet clogged with leaves', 'Water ponding across the road', 'Storm grate loose'],
  'Water leak or low pressure': ['Water bubbling up through the pavement', 'Low water pressure since this morning', 'Leak at the curb box'],
  'Sewer backup': ['Sewer smell and water in the basement drain', 'Manhole overflowing'],
  'Missed pickup': ['Recycling not picked up', 'Trash missed on our side of the street', 'Bulk item left behind'],
  'Tree or branch down': ['Large branch blocking half the road', 'Tree leaning on the wires', 'Limb down on the sidewalk'],
  Other: ['Graffiti on the bus shelter', 'Abandoned shopping cart'],
};
const RIVER = { lat: 40.1302, lng: -75.5149 }; // the demo borough's middle (a made-up place on the map)

module.exports = async function requests(conn, T, { daysAgo, timezone, userIds, log }) {
  await Q.ensureSetup(conn, T);
  const cats = new Map((await conn.query('SELECT id, name, color FROM request_categories WHERE tenant_id = ?', [T]))[0].map((c) => [c.name, c]));
  const streets = (await conn.query('SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [T]))[0];
  if (!streets.length) { log('No streets yet: skipped the requests.'); return; }
  for (const s of streets) {
    const cls = ARTERIAL.includes(s.name) ? 'arterial' : COLLECTOR.includes(s.name) ? 'collector' : 'local';
    await conn.query('UPDATE streets SET street_class = ? WHERE tenant_id = ? AND id = ?', [cls, T, s.id]);
  }
  // The manager's standards, the numbers and who hears about new requests (only when not set already).
  const [[std]] = await conn.query('SELECT COUNT(*) AS n FROM request_standards WHERE tenant_id = ?', [T]);
  if (!Number(std.n)) {
    for (const [name, safe, fix] of STANDARDS) if (cats.has(name) && (safe || fix)) await conn.query('INSERT INTO request_standards (tenant_id, category_id, street_class, make_safe_hours, fix_hours) VALUES (?, ?, ?, ?, ?)', [T, cats.get(name).id, 'any', safe, fix]);
    await conn.query("INSERT INTO request_standards (tenant_id, category_id, street_class, make_safe_hours, fix_hours) VALUES (?, ?, 'arterial', 8, 48)", [T, cats.get('Pothole').id]);
  }
  const users = await userIds();
  const alert = ['manager', 'frontdesk'].map((u) => users.get(u)).filter(Boolean);
  await conn.query("UPDATE request_settings SET office_phone = COALESCE(office_phone, '(555) 010-2400'), after_hours_phone = COALESCE(after_hours_phone, '(555) 010-2499'), public_map = 1, alert_user_ids = COALESCE(alert_user_ids, ?) WHERE tenant_id = ?", [JSON.stringify(alert), T]);
  await Q.syncAlertThread(conn, T, users.get('manager') || null);
  const crew = ['crew1', 'crew2', 'crew4'].map((u) => users.get(u)).filter(Boolean);
  const desk = users.get('frontdesk') || users.get('manager') || null;
  const staffIds = (await conn.query("SELECT s.id FROM staff s JOIN users u ON u.tenant_id = s.tenant_id AND u.staff_id = s.id WHERE s.tenant_id = ? AND u.role = 'staff'", [T]))[0].map((r) => Number(r.id));

  // A seeded random, so every run of the demo builds the same borough.
  let seed = 20261111;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const weighted = STANDARDS.flatMap(([name, , , w]) => Array(w).fill(name));
  const stamp = (base, hours) => { const ms = Date.parse(`${base.replace(' ', 'T')}Z`) + hours * 3600000; return new Date(ms).toISOString().slice(0, 19).replace('T', ' '); };
  const nowLocal = require('../../src/lib/util').nowIn(timezone || 'America/New_York');
  let added = 0; let photos = 0;
  const firstByStreet = new Map();

  for (let i = 0; i < 125; i += 1) {
    const key = crypto.createHash('md5').update(`demo-request-${i}`).digest('hex');
    const isToday = i >= 120;
    // Draw every value, even for a request already there, so the next ones come out the same.
    const catName = pick(weighted); const cat = cats.get(catName);
    const street = pick(streets);
    const ago = isToday ? 0 : Math.floor(rand() * 182) + 1;
    const reported = isToday ? stamp(nowLocal, -(0.3 + (124 - i) * 0.6 + rand() * 0.3)).slice(0, 17) + '00' : daysAgo(ago, 6 + Math.floor(rand() * 14), Math.floor(rand() * 59));
    const house = String(10 + Math.floor(rand() * 89) * 2 + (rand() < 0.5 ? 1 : 0));
    const source = isToday ? (i % 2 ? 'web' : 'phone') : pick(['web', 'web', 'web', 'web', 'phone', 'phone', 'walk_in', 'crew', 'email']);
    const withPos = source === 'web' || source === 'crew' ? rand() < 0.7 : false;
    const pos = withPos ? { lat: Math.round((RIVER.lat + (rand() - 0.5) * 0.02) * 1e6) / 1e6, lng: Math.round((RIVER.lng + (rand() - 0.5) * 0.028) * 1e6) / 1e6, acc: 5 + Math.floor(rand() * 25) } : null;
    const who = rand() < 0.6 ? { name: `${pick(FIRST)} ${pick(LAST)}`, phone: `555010${String(3000 + i).slice(-4)}`.replace(/^(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3'), texts: rand() < 0.6 } : null;
    const roll = rand(); const late = rand(); const safeRoll = rand(); const fixFrac = rand(); const lateBy = rand(); const words = pick(WORDS[catName] || WORDS.Other);
    const [[seen]] = await conn.query('SELECT id FROM requests WHERE tenant_id = ? AND request_key = ?', [T, key]);
    if (seen) continue;

    const [stds] = await conn.query("SELECT make_safe_hours, fix_hours FROM request_standards WHERE tenant_id = ? AND category_id = ? AND street_class = 'any'", [T, cat.id]);
    const safeT = stds.length ? stds[0].make_safe_hours : null; const fixT = (stds.length && stds[0].fix_hours) || 120;
    // What happened: 5 today are new; of the rest, about 3 in 4 fixed (1 in 6 of those late), a few referred, duplicates
    // and closed, and the last few weeks' still open.
    let outcome = 'fixed';
    if (isToday) outcome = 'new';
    else if (ago < 30 && roll < 0.5) outcome = roll < 0.1 && ago < 4 ? 'new' : roll < 0.3 ? 'made_safe' : 'assigned';
    else if (roll > 0.94) outcome = 'referred';
    else if (roll > 0.90) outcome = 'duplicate';
    else if (roll > 0.87) outcome = 'closed_no_action';
    const fixHours = late < 0.17 ? fixT * (1.2 + lateBy) : fixT * (0.15 + fixFrac * 0.8);
    const safeHours = safeT ? (safeRoll < 0.1 ? safeT * 1.5 : safeT * (0.1 + safeRoll * 0.8)) : null;
    let fixedAt = outcome === 'fixed' ? stamp(reported, fixHours) : null;
    if (fixedAt && fixedAt > nowLocal) { outcome = 'assigned'; fixedAt = null; }
    const madeSafe = outcome === 'made_safe' ? stamp(reported, Math.min(safeHours || 3, ago * 24 - 1))
      : safeHours && outcome === 'fixed' && safeHours < fixHours ? stamp(reported, safeHours) : null;
    const assigned = ['fixed', 'assigned', 'made_safe'].includes(outcome) ? stamp(reported, Math.min(2 + rand() * 6, fixHours / 2)) : null;
    const closedAt = fixedAt || (['referred', 'duplicate', 'closed_no_action'].includes(outcome) ? stamp(reported, 3 + rand() * 20) : null);

    let residentId = null;
    if (who) {
      const [r] = await conn.query('INSERT INTO residents (tenant_id, name, phone, street_id, house_number, texts_ok) VALUES (?, ?, ?, ?, ?, ?)', [T, who.name, who.phone, street.id, house, who.texts ? 1 : 0]);
      residentId = r.insertId;
      if (who.texts) await conn.query("INSERT INTO resident_consent (tenant_id, resident_id, channel, status, source, wording, created_at) VALUES (?, ?, 'sms', 'opted_in', ?, 'v1', ?)", [T, residentId, source === 'web' ? 'report_page' : 'staff', reported]);
    }
    const original = outcome === 'duplicate' ? firstByStreet.get(`${street.id}|${cat.id}`) : null;
    if (outcome === 'duplicate' && !original) outcome = 'closed_no_action';
    let woId = null;
    if (assigned) {
      const done = outcome === 'fixed';
      const [w] = await conn.query("INSERT INTO work_orders (tenant_id, title, description, priority, status, location, source, request_id, assigned_staff_id, opened_at, opened_by, completed_at, resolution, labor_hours) VALUES (?, ?, ?, ?, ?, ?, 'request', NULL, ?, ?, ?, ?, ?, ?)",
        [T, `${catName}: ${house} ${street.name}`.slice(0, 150), words, catName === 'Sewer backup' || catName === 'Water leak or low pressure' ? 'urgent' : 'normal', done ? 'done' : 'open', `${house} ${street.name}`.slice(0, 120),
          staffIds.length ? pick(staffIds) : null, assigned, desk, done ? fixedAt : null, done ? (catName === 'Pothole' ? 'Cold patch, rolled' : 'Repaired') : null, done ? Math.round((0.5 + rand() * 3) * 2) / 2 : null]);
      woId = w.insertId;
    }
    const status = outcome === 'closed_no_action' ? 'closed_no_action' : outcome;
    const [r] = await conn.query(`INSERT INTO requests (tenant_id, reference, status_token, category_id, street_id, house_number, lat, lng, accuracy_m, description, source, resident_id, contact_name, contact_phone, updates_by_text,
        reported_at, status, priority, referred_to, referred_at, duplicate_of, closed_reason, work_order_id, assigned_at, made_safe_at, made_safe_note, fixed_at, closed_at, public_note, request_key, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [T, await Q.newReference(conn, T), Q.newToken(), cat.id, street.id, house, pos ? pos.lat : null, pos ? pos.lng : null, pos ? pos.acc : null, words, source, residentId, who ? who.name : null, who ? who.phone : null, who && who.texts ? 1 : 0,
      reported, status, outcome === 'referred' ? 'PennDOT' : null, outcome === 'referred' ? closedAt : null, original || null,
      outcome === 'closed_no_action' ? 'On private property: the owner was told' : null, woId, assigned, madeSafe, madeSafe ? pick(['Cones and a sign', 'Barricade placed', 'Coned off']) : null, fixedAt, closedAt,
      outcome === 'fixed' && rand() < 0.4 ? 'Thanks for letting us know.' : null, key, source === 'web' ? null : desk]);
    const id = r.insertId;
    if (woId) await conn.query('UPDATE work_orders SET request_id = ? WHERE tenant_id = ? AND id = ?', [id, T, woId]);
    if (!firstByStreet.has(`${street.id}|${cat.id}`) && ['fixed', 'assigned', 'made_safe', 'new'].includes(outcome)) firstByStreet.set(`${street.id}|${cat.id}`, id);
    // The timeline, as the app writes it.
    const ev = (at, body, user = null) => conn.query('INSERT INTO request_events (tenant_id, request_id, at, kind, body, user_id) VALUES (?, ?, ?, \'event\', ?, ?)', [T, id, at, body, user]);
    await ev(reported, source === 'web' ? 'Reported on the report page.' : `Taken by staff (${Q.SOURCE_WORDS[source].toLowerCase()}).`, source === 'web' ? null : desk);
    if (woId) await ev(assigned, `Work order ${woId} made for the crew.`, desk);
    if (madeSafe) await ev(madeSafe, `Made safe at ${madeSafe.slice(0, 16)}.`, crew.length ? pick(crew) : null);
    if (fixedAt) await ev(fixedAt, `Work order ${woId} completed. Marked fixed.`, crew.length ? pick(crew) : null);
    if (outcome === 'referred') await ev(closedAt, 'Referred to PennDOT. State road.', desk);
    if (outcome === 'duplicate') await ev(closedAt, 'Marked a duplicate of an earlier report.', desk);
    if (outcome === 'closed_no_action') await ev(closedAt, 'Closed with no action: on private property.', desk);
    // Photos: a before photo on most, made safe and after photos on the work done (one picture each, fingerprinted).
    const addPhoto = async (stage, at, byResident) => {
      const png = picture(cat.color, stage === 'report' ? 'before' : stage, i);
      await conn.query('INSERT INTO request_photos (tenant_id, request_id, stage, mime, bytes, sha256, original, taken_at, taken_from, by_resident, uploaded_by, uploaded_at) VALUES (?, ?, ?, \'image/png\', ?, ?, ?, ?, \'phone\', ?, ?, ?)',
        [T, id, stage, png.length, crypto.createHash('sha256').update(png).digest('hex'), png, at, byResident ? 1 : 0, byResident ? null : (crew.length ? pick(crew) : null), at]);
      photos += 1;
    };
    if (rand() < 0.75) await addPhoto(source === 'web' ? 'report' : 'before', reported, source === 'web');
    if (madeSafe && rand() < 0.6) await addPhoto('made_safe', madeSafe, false);
    if (fixedAt && rand() < 0.7) await addPhoto('after', fixedAt, false);
    added += 1;
  }
  log(`${added} requests added (${photos} photos).`);
};
