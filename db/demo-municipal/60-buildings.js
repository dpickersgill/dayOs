'use strict';
// Demo data for Buildings (muni release 1), run by db/demo-municipal.js for the fictional Riverbend Borough:
// Riverbend Borough Hall (elevator, boiler, sprinkler riser, fire alarm, 14 extinguishers, exit lights), the Public Works
// Garage (generator, 6 extinguishers, backflow preventer), the library, two parks with playgrounds and restrooms and a
// pump house; twelve months of checks with a few late ones, two vendor visits with their certificates as small PDFs made
// here, and one deficiency still open. Every name is made up. Running it again adds nothing: it stops when the borough
// already has buildings.
//
// Exports async function (conn, tenantId, helpers). It writes through the same tables the app does (and the library
// seeding in lib/buildings.js), with dates relative to the borough's today so the calendar always looks lived in.

const crypto = require('crypto');

/** A one-page PDF of plain text lines (Helvetica), enough for a sample certificate. */
function textPdf(lines) {
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?');
  const body = ['BT', '/F1 13 Tf', '72 720 Td', '16 TL', ...lines.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// [name, type, house number, street words, year built, square feet, rooms, equipment: [kind, name, room, count]]
const BUILDINGS = [
  ['Riverbend Borough Hall', 'office', '100', 'Main', 1962, 18400, ['Lobby', 'Council chambers', 'Boiler room', 'Second floor offices', 'Kitchen'], [
    ['elevator', 'Borough Hall elevator', 'Lobby', 1], ['boiler', 'Borough Hall boiler', 'Boiler room', 1], ['sprinkler', 'Borough Hall sprinkler riser', 'Boiler room', 1],
    ['fire_alarm', 'Borough Hall fire alarm panel', 'Lobby', 1], ['fire_extinguisher', 'Borough Hall extinguisher', null, 14], ['exit_lights', 'Borough Hall exit lights, first floor', 'Lobby', 1],
    ['exit_lights', 'Borough Hall exit lights, second floor', 'Second floor offices', 1], ['kitchen_hood', 'Borough Hall kitchen hood', 'Kitchen', 1], ['hvac', 'Borough Hall rooftop unit', null, 1], ['roof', 'Borough Hall roof', null, 1]]],
  ['Public Works Garage', 'garage', '41', 'Mill', 1978, 12000, ['Shop floor', 'Office', 'Salt shed'], [
    ['generator', 'Garage emergency generator', 'Shop floor', 1], ['fire_extinguisher', 'Garage extinguisher', null, 6], ['backflow', 'Garage backflow preventer', 'Shop floor', 1], ['exit_lights', 'Garage exit lights', 'Shop floor', 1]]],
  ['Riverbend Public Library', 'library', '212', 'Church', 1931, 9600, ['Reading room', 'Children’s room', 'Basement'], [
    ['fire_extinguisher', 'Library extinguisher', null, 4], ['exit_lights', 'Library exit lights', 'Reading room', 1], ['fire_alarm', 'Library fire alarm panel', 'Basement', 1], ['boiler', 'Library boiler', 'Basement', 1]]],
  ['Veterans Park', 'park', null, 'Park', null, null, ['Restrooms', 'Pavilion'], [
    ['playground', 'Veterans Park playground', null, 1], ['fire_extinguisher', 'Veterans Park pavilion extinguisher', 'Pavilion', 1]]],
  ['Creekside Park', 'park', null, 'Water', null, null, ['Restrooms'], [['playground', 'Creekside Park playground', null, 1]]],
  ['Water Street Pump House', 'pump_house', '8', 'Water', 1988, 600, [], [['fire_extinguisher', 'Pump house extinguisher', null, 1], ['backflow', 'Pump house backflow preventer', null, 1]]],
];

module.exports = async function buildingsDemo(conn, tenantId) {
  const t = Number(tenantId);
  const q = async (sql, params) => (await conn.query(sql, params))[0];
  const one = async (sql, params) => (await q(sql, params))[0];
  if (await one('SELECT id FROM buildings WHERE tenant_id = ? LIMIT 1', [t])) return { skipped: 'buildings already there' };
  const tz = (await one('SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const B = require('../../src/lib/buildings');
  const A = require('../../src/lib/assets');
  const { CATEGORY_OF } = require('../../src/lib/ops');
  await B.ensureLibrary(t); // the library, as when Buildings is turned on
  await A.ensureSettings(conn, t);
  const owner = await one("SELECT id FROM users WHERE tenant_id = ? AND role IN ('owner','manager') AND active = 1 ORDER BY role = 'owner' DESC, id LIMIT 1", [t]);
  const userId = owner ? owner.id : null;
  const custodian = 'Sam Ortiz';

  // Vendors (made-up companies).
  const vendor = async (name, contact) => {
    const v = await one('SELECT id FROM vendors WHERE tenant_id = ? AND name = ?', [t, name]);
    if (v) return v.id;
    return (await q('INSERT INTO vendors (tenant_id, name, contact, notes) VALUES (?, ?, ?, ?)', [t, name, contact, 'Demo vendor'])).insertId;
  };
  const fireCo = await vendor('Keystone Fire Protection', 'Service desk');
  const liftCo = await vendor('Valley Elevator Inspections', 'Scheduling');
  const backflowCo = await vendor('Schuylkill Backflow Testing', 'Office');
  const tasks = await q('SELECT id, code, name, who, interval_days, template_id, certificate FROM life_safety_tasks WHERE tenant_id = ?', [t]);
  const byCode = Object.fromEntries(tasks.map((x) => [x.code, x]));
  for (const [code, v] of [['ext_annual', fireCo], ['sprinkler_quarterly', fireCo], ['sprinkler_annual', fireCo], ['alarm_annual', fireCo], ['hood_semiannual', fireCo], ['elevator_semiannual', liftCo], ['boiler_inspection', liftCo], ['backflow_annual', backflowCo]]) {
    if (byCode[code]) await q('UPDATE life_safety_tasks SET vendor_id = ? WHERE tenant_id = ? AND id = ? AND vendor_id IS NULL', [v, t, byCode[code].id]);
  }

  // Buildings, rooms and equipment.
  const streetId = async (word) => { const s = await one('SELECT id FROM streets WHERE tenant_id = ? AND name LIKE ? ORDER BY id LIMIT 1', [t, `${word}%`]).catch(() => null); return s ? s.id : null; };
  const settings = await one('SELECT next_tag FROM asset_settings WHERE tenant_id = ?', [t]);
  let tag = Number(settings.next_tag);
  const nextTag = async () => { while (await one('SELECT id FROM ops_assets WHERE tenant_id = ? AND asset_tag = ?', [t, A.tagOf(tag)])) tag += 1; const v = A.tagOf(tag); tag += 1; return v; };
  const ids = {};
  for (const [name, type, num, streetWord, year, sqft, rooms, equipment] of BUILDINGS) {
    let loc = await one('SELECT id FROM asset_locations WHERE tenant_id = ? AND name = ?', [t, name]);
    if (!loc) loc = { id: (await q("INSERT INTO asset_locations (tenant_id, name, kind) VALUES (?, ?, 'building')", [t, name])).insertId };
    const sid = await streetId(streetWord);
    const b = (await q('INSERT INTO buildings (tenant_id, location_id, name, type, street_id, house_number, address, year_built, square_feet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, loc.id, name, type, sid, sid ? num : null, sid ? null : [num, `${streetWord} Street`].filter(Boolean).join(' '), year, sqft])).insertId;
    ids[name] = b;
    const roomIds = {};
    for (const r of rooms) {
      const full = B.roomLocationName(name, r);
      const have = await one('SELECT id FROM asset_locations WHERE tenant_id = ? AND name = ?', [t, full]);
      roomIds[r] = have ? have.id : (await q("INSERT INTO asset_locations (tenant_id, name, kind, parent_id) VALUES (?, ?, 'area', ?)", [t, full, loc.id])).insertId;
    }
    for (const [kind, ename, room, count] of equipment) {
      for (let i = 1; i <= count; i += 1) {
        const n = count > 1 ? `${ename} ${i}` : ename;
        if (await one('SELECT id FROM ops_assets WHERE tenant_id = ? AND name = ?', [t, n])) continue;
        // Extinguishers are spread around the building's rooms.
        const where = room ? roomIds[room] : (count > 1 && rooms.length ? roomIds[rooms[(i - 1) % rooms.length]] : loc.id);
        await q('INSERT INTO ops_assets (tenant_id, name, kind, category, asset_tag, location_id, critical) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [t, n, kind, CATEGORY_OF[kind] || 'facility', await nextTag(), where, ['elevator', 'fire_alarm', 'sprinkler', 'generator'].includes(kind) ? 1 : 0]);
      }
    }
  }
  await q('UPDATE asset_settings SET next_tag = GREATEST(next_tag, ?) WHERE tenant_id = ?', [tag, t]);
  await B.syncPlans(conn, t);

  // Twelve months of history. Staff monthly checks done mid-month, a few late; vendor work on its schedule.
  const plans = await q(`SELECT p.pm_task_id, p.asset_id, t.code, t.who, t.interval_days, t.template_id FROM building_plans p JOIN life_safety_tasks t ON t.tenant_id = p.tenant_id AND t.id = p.task_id WHERE p.tenant_id = ?`, [t]);
  const tpl = new Map((await q('SELECT id, name, items FROM inspection_templates WHERE tenant_id = ?', [t])).map((x) => [x.id, { name: x.name, items: JSON.parse(x.items) }]));
  const passItems = (tid, values = {}) => (tpl.get(tid) ? tpl.get(tid).items : []).map((s) => (s.type === 'number' ? { key: s.key, label: s.label, type: 'number', result: 'pass', value: values[s.key] ?? null, unit: s.unit || null, note: null }
    : s.type === 'date' ? { key: s.key, label: s.label, type: 'date', result: 'pass', value: addDays(today, 900), note: null } : { key: s.key, label: s.label, type: 'pass', result: 'pass', note: null }));
  const record = async (p, on, inspector, values) => {
    const ins = (await q('INSERT INTO asset_inspections (tenant_id, asset_id, template_id, template_name, result, items, inspector, user_id, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, p.asset_id, p.template_id, (tpl.get(p.template_id) || {}).name || 'Check', 'pass', JSON.stringify(passItems(p.template_id, values)), inspector, userId, `${on} 10:30:00`])).insertId;
    await q('INSERT INTO pm_log (tenant_id, pm_task_id, done_on, user_id, note) VALUES (?, ?, ?, ?, ?)', [t, p.pm_task_id, on, userId, 'Demo history']);
    await q('UPDATE pm_tasks SET last_done_on = IF(last_done_on IS NULL OR last_done_on < ?, ?, last_done_on) WHERE tenant_id = ? AND id = ?', [on, on, t, p.pm_task_id]);
    return ins;
  };
  // A stable "random" so a demo looks the same each time it is built.
  const jitter = (seed, n) => crypto.createHash('sha1').update(String(seed)).digest()[0] % n;
  for (const p of plans.filter((x) => x.who === 'staff')) {
    if (p.interval_days <= 31) {
      for (let m = 12; m >= 1; m -= 1) {
        // About the same day each month; the garage's checks ran late twice (14 and 9 days past due).
        let on = addDays(today, -30 * m + jitter(`${p.pm_task_id}-${m}`, 5));
        if ((m === 7 || m === 3) && p.code === 'ext_monthly' && jitter(p.asset_id, 3) === 0) on = addDays(on, m === 7 ? 14 : 9);
        if (on >= today) continue;
        await record(p, on, custodian, p.code === 'generator_monthly' ? { run_minutes: 35, load_pct: 40 + jitter(m, 15), fuel_pct: 70 + jitter(m + 1, 25) } : p.code === 'playground_monthly' ? { surfacing_in: 10 + jitter(m, 3) } : {});
      }
    } else await record(p, addDays(today, -200 - jitter(p.pm_task_id, 60)), custodian);
  }

  // Vendor work. Visit 1, about 50 days ago: Keystone Fire Protection's annual extinguisher service and the alarm and
  // sprinkler tests across Borough Hall and the garage. Visit 2, about 20 days ago: the elevator and boiler at Borough
  // Hall, with new certificates of operation. Other vendor checks get history without a visit record.
  const D = require('../../src/routes/documents').files;
  const category = await B.docCategory(conn, t);
  const fileVisit = async (visitId, title, lines, buildingIds) => {
    const buf = textPdf(lines);
    const docId = (await q('INSERT INTO documents (tenant_id, category_id, title, description, file_name, mime_type, size_bytes, uploaded_by, uploader, file_at, text_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)',
      [t, category, title, 'Sample certificate made for the demo', `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`, 'application/pdf', buf.length, userId, 'Demo', 'pending'])).insertId;
    await q('INSERT INTO document_files (tenant_id, document_id, content) VALUES (?, ?, ?)', [t, docId, buf]);
    await q('UPDATE building_visits SET document_id = ? WHERE tenant_id = ? AND id = ?', [docId, t, visitId]);
    await q('UPDATE building_certificates SET document_id = ? WHERE tenant_id = ? AND visit_id = ?', [docId, t, visitId]);
    for (const b of buildingIds) await q('INSERT IGNORE INTO building_documents (tenant_id, building_id, document_id, visit_id) VALUES (?, ?, ?, ?)', [t, b, docId, visitId]);
    await D.scanDocument(t, docId, { ocr: false }).catch(() => null);
    return docId;
  };
  const planIn = async (codes, buildingNames) => q(`SELECT p.pm_task_id, p.asset_id, p.task_id, t.code, t.name AS task, t.template_id, t.certificate, a.name AS asset, b.id AS building_id FROM building_plans p
      JOIN life_safety_tasks t ON t.tenant_id = p.tenant_id AND t.id = p.task_id JOIN ops_assets a ON a.tenant_id = p.tenant_id AND a.id = p.asset_id
      JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id JOIN buildings b ON b.tenant_id = a.tenant_id AND (b.location_id = l.id OR b.location_id = l.parent_id)
    WHERE p.tenant_id = ? AND t.code IN (?) AND b.name IN (?) ORDER BY b.name, a.name`, [t, codes, buildingNames]);
  const visit = async (vendorId, on, technician, list, notes) => {
    const vid = (await q('INSERT INTO building_visits (tenant_id, vendor_id, visit_on, technician, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)', [t, vendorId, on, technician, notes, userId])).insertId;
    const vname = (await one('SELECT name FROM vendors WHERE id = ?', [vendorId])).name;
    for (const p of list) {
      const ins = await record(p, on, `${vname}, ${technician}`, p.code === 'sprinkler_quarterly' ? { static_psi: 62 } : p.code === 'sprinkler_annual' ? { residual_psi: 48 } : {});
      await q('INSERT INTO building_visit_items (tenant_id, visit_id, pm_task_id, task_id, asset_id, task_name, result, inspection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, vid, p.pm_task_id, p.task_id, p.asset_id, p.task, 'pass', ins]);
    }
    return vid;
  };
  const v1on = addDays(today, -50);
  const v1list = await planIn(['ext_annual', 'alarm_annual', 'sprinkler_annual', 'sprinkler_quarterly'], ['Riverbend Borough Hall', 'Public Works Garage']);
  const v1 = await visit(fireCo, v1on, 'J. Reyes', v1list, 'Annual extinguisher service, fire alarm test and sprinkler test. One extinguisher in the garage was low and was replaced on site.');
  await fileVisit(v1, `Keystone Fire Protection report, ${v1on}`, ['Keystone Fire Protection (sample for the Verdynt/OS demo)', '', `Service report, ${v1on}`, 'Riverbend Borough Hall and Public Works Garage',
    'Portable extinguishers: annual maintenance done, tags updated.', 'Fire alarm: annual test done. All devices reported.', 'Sprinkler riser: annual and quarterly inspection done.', '', 'This is made-up sample data.'], [ids['Riverbend Borough Hall'], ids['Public Works Garage']]);

  const v2on = addDays(today, -20);
  const v2list = await planIn(['elevator_semiannual', 'boiler_inspection'], ['Riverbend Borough Hall']);
  const v2 = await visit(liftCo, v2on, 'M. Chen', v2list, 'Elevator periodic inspection and boiler inspection. Certificates renewed.');
  for (const p of v2list) {
    // The elevator's certificate runs out in 25 days, so its reminder shows on the demo's Today screen.
    const expires = p.code === 'elevator_semiannual' ? addDays(today, 25) : addDays(v2on, 365);
    await q('INSERT INTO building_certificates (tenant_id, asset_id, name, number, issued_on, expires_on, visit_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, p.asset_id, p.certificate || 'Certificate of operation', `DEMO-${p.asset_id}-${v2on.slice(0, 4)}`, v2on, expires, v2, userId]);
    await q('UPDATE ops_assets SET inspection_expires = ? WHERE tenant_id = ? AND id = ?', [expires, t, p.asset_id]);
  }
  await fileVisit(v2, `Valley Elevator Inspections certificates, ${v2on}`, ['Valley Elevator Inspections (sample for the Verdynt/OS demo)', '', `Inspection, ${v2on}`, 'Riverbend Borough Hall',
    'Elevator: periodic inspection done. Certificate of operation renewed.', 'Boiler: inspection done. Certificate of operation renewed.', '', 'This is made-up sample data, not a real certificate.'], [ids['Riverbend Borough Hall']]);

  // Every other vendor check: done some time in the last year (the library's rare one-offs stay without a record).
  const covered = new Set([...v1list, ...v2list].map((p) => p.pm_task_id));
  for (const p of plans.filter((x) => x.who === 'vendor' && !covered.has(x.pm_task_id))) {
    if (p.code === 'playground_annual' && jitter(p.asset_id, 2) === 0) continue; // one park still has no record: shows on the calendar
    await record(p, addDays(today, -Math.min(Number(p.interval_days) - 5, 120 + jitter(p.pm_task_id, 150))), 'Vendor (demo history)');
  }

  // One deficiency still open: a failed exit light found on last month's round at the garage.
  const exitPlan = (await planIn(['exit_monthly'], ['Public Works Garage']))[0];
  if (exitPlan) {
    const on = addDays(today, -12);
    const items = passItems(exitPlan.template_id).map((i) => (i.key === 'test30' ? { ...i, result: 'fail', note: 'Two heads by the bay door went dark during the test' } : i));
    const ins = (await q('INSERT INTO asset_inspections (tenant_id, asset_id, template_id, template_name, result, items, inspector, user_id, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, exitPlan.asset_id, exitPlan.template_id, exitPlan.task, 'fail', JSON.stringify(items), custodian, userId, `${on} 09:15:00`])).insertId;
    const wo = (await q("INSERT INTO work_orders (tenant_id, title, description, priority, asset_id, location, source, opened_by) VALUES (?, ?, ?, 'high', ?, ?, 'inspection', ?)",
      [t, `${exitPlan.task} failed: ${exitPlan.asset}`, 'Emergency lights stay on for the 30-second test: Two heads by the bay door went dark during the test', exitPlan.asset_id, 'Public Works Garage, Shop floor', userId])).insertId;
    await q('UPDATE asset_inspections SET work_order_id = ? WHERE tenant_id = ? AND id = ?', [wo, t, ins]);
    await q("UPDATE ops_assets SET status = 'needs_service' WHERE tenant_id = ? AND id = ?", [t, exitPlan.asset_id]);
    await q("INSERT INTO building_deficiencies (tenant_id, building_id, asset_id, description, found_on, source, inspection_id, work_order_id) VALUES (?, ?, ?, ?, ?, 'round', ?, ?)",
      [t, exitPlan.building_id, exitPlan.asset_id, 'Two emergency light heads by the bay door went dark during the 30-second test', on, ins, wo]);
  }
  return { buildings: Object.keys(ids).length, plans: plans.length };
};

module.exports.textPdf = textPdf;
