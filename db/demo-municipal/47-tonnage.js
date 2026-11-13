'use strict';

// The demo borough's carts, tonnage and recycling report (release 2026.11.22, workstream "tonnage"), run by
// db/demo-municipal.js after the borough, its streets and its collection schedule (45-collection.js) are made.
//   Carts       sizes and fees (Trash 65 or 95 gallons, an extra $65 or $75; Recycling 65 or 95 gallons, free), a trash and
//               a recycling cart at sixty addresses, carts in the yard, and requests: five waiting, two with a delivery
//               day, three delivered last month.
//   Tonnage     three facilities and weigh tickets from January of last year to today: trash every weekday, recycling
//               every week, yard waste in season. The recycling rate comes out near 30%.
//   The report  last year's report, open, with three reporters: the hauler and one business answered, one has not.
// Every name, phone (555-01xx) and email (example.com) is made up; the demo never calls Stripe. Running it twice adds
// nothing the second time.
const crypto = require('crypto');

const PHOTO = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const today = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ref = () => `C${Array.from(crypto.randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
// A steady pseudo-random number from a seed, so a rebuilt demo has the same weights.
const wobble = (seed) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x); };
const PEOPLE = [['Alex Alder', '610-555-0141'], ['Jordan Brook', '610-555-0142'], ['Morgan Carver', '610-555-0143'], ['Casey Dale', '610-555-0144'], ['Taylor Easton', '610-555-0145'],
  ['Riley Fenwick', '610-555-0146'], ['Jamie Garner', '610-555-0147'], ['Avery Hollis', '610-555-0148'], ['Quinn Ivers', '610-555-0149'], ['Drew Jarrett', '610-555-0150']];

module.exports = async function tonnage(conn, tenantId, helpers = {}) {
  const say = (text) => { if (helpers.log) helpers.log(text); return { tonnage: text }; };
  const q = async (sql, params) => (await conn.query(sql, params))[0];
  const [t] = await q('SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const tz = (t && t.timezone) || 'America/New_York';
  const now = today(tz);
  const thisYear = Number(now.slice(0, 4));

  // The streams come from the collection schedule (45-collection.js); a borough set up before it has these three.
  let streams = await q('SELECT id, name, kind FROM collection_streams WHERE tenant_id = ? AND active = 1 ORDER BY sort, id', [tenantId]);
  if (!streams.length) {
    for (const [i, [name, kind]] of [['Trash', 'trash'], ['Recycling', 'recycling'], ['Yard waste', 'yard']].entries()) {
      await q("INSERT INTO collection_streams (tenant_id, name, kind, frequency, sort) VALUES (?, ?, ?, 'weekly', ?)", [tenantId, name, kind, i + 1]);
    }
    streams = await q('SELECT id, name, kind FROM collection_streams WHERE tenant_id = ? AND active = 1 ORDER BY sort, id', [tenantId]);
  }
  const byKind = (k) => streams.find((s) => s.kind === k);
  const trash = byKind('trash'); const rec = byKind('recycling'); const yard = byKind('yard');
  const zones = await q('SELECT id FROM collection_zones WHERE tenant_id = ? AND active = 1 ORDER BY sort, id', [tenantId]);
  const trucks = await q("SELECT id, name FROM ops_assets WHERE tenant_id = ? AND category = 'fleet' AND status <> 'retired' ORDER BY id LIMIT 4", [tenantId]);

  // ---- carts: sizes and fees, made once
  await q('INSERT IGNORE INTO cart_settings (tenant_id, online, max_extra, rules_text) VALUES (?, 1, 1, ?)', [tenantId, require('../../src/lib/carts').DEFAULT_RULES]);
  const sizes = [[trash, 65, 6500, 5000], [trash, 95, 7500, 5500], [rec, 65, 0, 0], [rec, 95, 0, 0]].filter(([s]) => s);
  for (const [s, gal, extra, repl] of sizes) await q('INSERT IGNORE INTO cart_options (tenant_id, stream_id, size_gal, extra_fee_cents, replacement_fee_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, s.id, gal, extra, repl]);

  const out = [];
  const [haveCarts] = await q('SELECT COUNT(*) AS n FROM carts WHERE tenant_id = ?', [tenantId]);
  if (!Number(haveCarts.n)) {
    const streets = await q('SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name LIMIT 6', [tenantId]);
    let n = 0;
    for (const st of streets) {
      for (let no = 100; no < 120; no += 2) {
        n += 1;
        const since = addDays(now, -(400 + (n * 37) % 900));
        if (trash) await q('INSERT INTO carts (tenant_id, street_id, house_number, house_no, stream_id, size_gal, serial, delivered_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, st.id, String(no), no, trash.id, n % 4 ? 95 : 65, `T-${String(1000 + n)}`, since]);
        if (rec) await q('INSERT INTO carts (tenant_id, street_id, house_number, house_no, stream_id, size_gal, serial, delivered_on, cond) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, st.id, String(no), no, rec.id, 65, `R-${String(2000 + n)}`, since, n % 17 ? 'good' : 'damaged']);
      }
    }
    for (const [s, gal, on] of [[trash, 95, 12], [trash, 65, 6], [rec, 65, 20], [rec, 95, 4]]) {
      if (!s) continue;
      await q('INSERT INTO cart_stock (tenant_id, stream_id, size_gal, on_hand) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE on_hand = on_hand', [tenantId, s.id, gal, on]);
      await q("INSERT INTO cart_stock_moves (tenant_id, stream_id, size_gal, delta, reason, note, on_hand) VALUES (?, ?, ?, ?, 'count', 'Counted in the yard', ?)", [tenantId, s.id, gal, on, on]);
    }
    // Requests: five waiting, two with a delivery day, three delivered last month.
    const plan = [['new', rec, 65, 'open', null], ['extra', trash, 95, 'open', null], ['replacement', rec, 65, 'open', null], ['stolen', trash, 95, 'open', null], ['extra', rec, 95, 'open', null],
      ['new', trash, 95, 'scheduled', now], ['replacement', trash, 65, 'scheduled', addDays(now, 1)],
      ['new', rec, 65, 'delivered', addDays(now, -20)], ['extra', trash, 95, 'delivered', addDays(now, -24)], ['stolen', rec, 65, 'delivered', addDays(now, -27)]];
    const streetsAll = await q('SELECT id FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name LIMIT 8', [tenantId]);
    for (const [i, [kind, s, gal, status, day]] of plan.entries()) {
      if (!s || !streetsAll.length) continue;
      const st = streetsAll[(i + 2) % streetsAll.length];
      const [name, phone] = PEOPLE[i];
      const no = 201 + i * 6;
      const fee = kind === 'extra' ? (s === trash ? 7500 : 0) : kind === 'replacement' ? (s === trash ? 5000 : 0) : 0;
      const pay = fee ? (i % 2 ? ['office', 'paid', fee] : ['office', 'due', 0]) : ['free', 'not_needed', 0];
      await q(`INSERT INTO cart_requests (tenant_id, reference, view_token, kind, stream_id, size_gal, street_id, house_number, house_no, contact_name, contact_phone, contact_email, emails_ok, source, status, deliver_on,
          delivered_at, pay_method, pay_status, fee_cents, paid_cents, police_report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, ref(), crypto.randomBytes(16).toString('hex'), kind, s.id, gal, st.id, String(no), no, name, phone, `${name.split(' ')[0].toLowerCase()}@example.com`, i % 3 ? 'online' : 'staff', status, day,
        status === 'delivered' ? `${day} 11:00:00` : null, pay[0], pay[1], fee, pay[2], kind === 'stolen' ? `PD-${26000 + i}` : null, `${addDays(day || now, -(3 + i))} 10:${String(10 + i).padStart(2, '0')}:00`]);
      if (status === 'delivered') await q('INSERT INTO carts (tenant_id, street_id, house_number, house_no, stream_id, size_gal, serial, delivered_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, st.id, String(no), no, s.id, gal, `${s === trash ? 'T' : 'R'}-${3000 + i}`, day]);
    }
    out.push('carts at 60 addresses, 10 cart requests');
  }

  // ---- tonnage: facilities, then tickets from January of last year to today
  const fac = async (name, kind, fee, residue) => {
    await q('INSERT IGNORE INTO tonnage_facilities (tenant_id, name, kind, fee_per_ton_cents, residue_pct) VALUES (?, ?, ?, ?, ?)', [tenantId, name, kind, fee, residue]);
    return (await q('SELECT id FROM tonnage_facilities WHERE tenant_id = ? AND name = ?', [tenantId, name]))[0].id;
  };
  const landfill = await fac('Pioneer Crossing Landfill', 'landfill', 7250, 0);
  const mrf = await fac('Blue Mountain Recycling', 'recycling', 0, 8);
  const compost = await fac('Borough Leaf Compost Site', 'compost', null, 0);
  // Its own marker (an import row), so the drivers' tickets of 46-routes.js do not stop the year being built.
  const MARK = 'Demo: a year of weigh tickets';
  const [haveYear] = await q('SELECT id FROM weigh_ticket_imports WHERE tenant_id = ? AND source_name = ?', [tenantId, MARK]);
  if (!haveYear) {
    // The marker is written first and its tickets point at it; INSERT IGNORE skips a ticket number already there, so a
    // run that stopped half way finishes on the next one.
    const importId = (await q('INSERT INTO weigh_ticket_imports (tenant_id, source_name, file_name) VALUES (?, ?, NULL)', [tenantId, MARK])).insertId;
    const start = `${thisYear - 1}-01-01`;
    const rows = [];
    let k = 0;
    for (let d = start; d < now; d = addDays(d, 1)) {
      const wd = weekday(d); k += 1;
      if (wd === 0 || wd === 6) continue;
      const truck = trucks.length ? trucks[k % trucks.length] : null;
      const zone = zones.length ? zones[(wd - 1) % zones.length].id : null;
      // Trash: one load a weekday, about 10.5 tons.
      if (trash) {
        const tare = 30500 + Math.round(wobble(k) * 1500);
        rows.push([d, `PC-${String(40000 + k)}`, landfill, trash.id, 'trash', 'msw', zone, truck, tare + 18000 + Math.round(wobble(k + 7) * 6000), tare, 7250]);
      }
      // Recycling: Wednesdays, two loads, about 16 tons in all.
      if (rec && wd === 3) {
        for (const leg of [1, 2]) {
          const tare = 29000 + Math.round(wobble(k * leg) * 1200);
          rows.push([d, `BMR-${String(7000 + k * 2 + leg)}`, mrf, rec.id, 'recycling', 'commingled', null, truck, tare + 14500 + Math.round(wobble(k + leg * 3) * 4000), tare, 0]);
        }
      }
      // Yard waste: Fridays from April to November, about 10 tons; more in the fall.
      const m = Number(d.slice(5, 7));
      if (yard && wd === 5 && m >= 4 && m <= 11) {
        const tare = 24000;
        rows.push([d, null, compost, yard.id, 'yard', 'leaf_yard', null, truck, tare + (m >= 10 ? 26000 : 16000) + Math.round(wobble(k + 11) * 5000), tare, null]);
      }
    }
    for (const [d, no, facId, streamId, kind, material, zone, truck, gross, tare, feePerTon] of rows) {
      const net = gross - tare;
      const [r] = await conn.query(`INSERT IGNORE INTO weigh_tickets (tenant_id, on_date, ticket_no, facility_id, stream_id, stream_kind, material, sector, zone_id, truck_asset_id, gross_lb, tare_lb, net_lb, fee_cents, source, import_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'res_curb', ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, d, no, facId, streamId, kind, material, zone, truck ? truck.id : null, gross, tare, net, feePerTon === null ? null : Math.round((net / 2000) * feePerTon), no ? 'office' : 'import', importId]);
      if (r.affectedRows && no && d > addDays(now, -10)) {
        await conn.query('INSERT INTO weigh_ticket_photos (tenant_id, ticket_id, mime, bytes, sha256, original, taken_at, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [tenantId, r.insertId, 'image/jpeg', PHOTO.length, crypto.createHash('sha256').update(PHOTO).digest('hex'), PHOTO, `${d} 15:30:00`, `${d} 15:45:00`]);
      }
    }
    await q('UPDATE weigh_ticket_imports SET rows_added = ? WHERE tenant_id = ? AND id = ?', [rows.length, tenantId, importId]);
    out.push(`${rows.length} weigh tickets`);
  }

  // ---- last year's recycling report, open, with three reporters
  for (const [name, kind, email, phone, contact] of [['Valley Waste Haulers', 'hauler', 'reports@valleywaste.example.com', '610-555-0190', 'Dana Price'], ['Riverside Grocery', 'business', 'manager@riversidegrocery.example.com', null, null], ['Corner Diner', 'business', null, '610-555-0193', 'Lee Ames']]) {
    await q('INSERT IGNORE INTO recycling_reporters (tenant_id, name, kind, email, phone, contact_name) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, name, kind, email, phone, contact]);
  }
  const year = thisYear - 1;
  const [had] = await q('SELECT id FROM recycling_reports WHERE tenant_id = ? AND year = ?', [tenantId, year]);
  if (!had) {
    await q(`INSERT INTO recycling_reports (tenant_id, year, due_on, followup_on, opened_at) VALUES (?, ?, ?, ?, ?)`, [tenantId, year, `${year + 1}-02-15`, `${year + 1}-02-01`, `${year}-12-01 08:00:00`]);
    const [r] = await q('SELECT id FROM recycling_reports WHERE tenant_id = ? AND year = ?', [tenantId, year]);
    await q('INSERT IGNORE INTO recycling_report_forms (tenant_id, report_id, reporter_id, sent_at) SELECT tenant_id, ?, id, ? FROM recycling_reporters WHERE tenant_id = ? AND active = 1', [r.id, `${year}-12-03 09:00:00`, tenantId]);
    const forms = await q('SELECT f.id, p.name FROM recycling_report_forms f JOIN recycling_reporters p ON p.tenant_id = f.tenant_id AND p.id = f.reporter_id WHERE f.tenant_id = ? AND f.report_id = ?', [tenantId, r.id]);
    const hauler = forms.find((f) => f.name === 'Valley Waste Haulers'); const grocer = forms.find((f) => f.name === 'Riverside Grocery');
    if (hauler) {
      await q("UPDATE recycling_report_forms SET answered_at = ?, answered_by = 'reporter', answer_name = 'Dana Price' WHERE id = ?", [`${year + 1}-01-22 14:05:00`, hauler.id]);
      for (const l of [['commingled', 0, 0, 212.4, 0, 18.1, 'Blue Mountain Recycling'], ['corrugated', 0, 0, 96.2, 0, 0, 'Keystone Paper Mill'], ['metal_other', 0, 0, 14.6, 0, 0, 'Schuylkill Scrap Metals']]) {
        await q('INSERT INTO recycling_report_lines (tenant_id, form_id, material, res_curb, res_dropoff, com_curb, com_dropoff, residue, processor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, hauler.id, ...l]);
      }
    }
    if (grocer) {
      await q("UPDATE recycling_report_forms SET answered_at = ?, answered_by = 'reporter', answer_name = 'Store manager' WHERE id = ?", [`${year + 1}-01-30 10:40:00`, grocer.id]);
      await q('INSERT INTO recycling_report_lines (tenant_id, form_id, material, res_curb, res_dropoff, com_curb, com_dropoff, residue, processor) VALUES (?, ?, ?, 0, 0, 0, 38.5, 0, ?)', [tenantId, grocer.id, 'corrugated', 'Keystone Paper Mill']);
    }
    out.push(`the ${year} recycling report`);
  }
  return say(out.length ? `Added ${out.join(', ')}` : 'Carts, tonnage and the recycling report were already there');
};
