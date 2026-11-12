'use strict';

// Riverbend Borough's crew (release 2026.11.20): the public works certification types with each person's licenses (one
// running out soon), today's published shifts with two of the crew clocked in, an on-call rotation for water and sewer
// and one for streets with a swap next week and this year's holidays, and four weeks of time clock punches so Overtime
// shows people over 40 hours and a few call-outs. Safe to run again: each piece looks for what is there first.
const { seedCertifications } = require('../../src/lib/crewcerts');
const { utcFromLocal } = require('../../src/lib/util');
const { usualHolidays } = require('../../src/routes/crew');

// [person, certification code, issued days ago, expires in days (null: no expiry)]
const LICENSES = [
  ['Marcus Hale', 'pa_water_operator', 2100, 400], ['Marcus Hale', 'pa_wastewater_operator', 2100, 400], ['Marcus Hale', 'first_aid_cpr', 300, 430],
  ['Luis Ortega', 'cdl_a', 1500, 900], ['Luis Ortega', 'dot_medical', 340, 25], ['Luis Ortega', 'pa_water_operator', 900, 560], ['Luis Ortega', 'flagger', 600, 495],
  ['Kevin Brandt', 'cdl_b', 1200, 700], ['Kevin Brandt', 'dot_medical', 200, 165], ['Kevin Brandt', 'pesticide', 500, 230], ['Kevin Brandt', 'first_aid_cpr', 700, -12],
  ['Tom Kowalski', 'cdl_b', 2400, 1100], ['Tom Kowalski', 'dot_medical', 100, 265], ['Tom Kowalski', 'pa_wastewater_operator', 1300, 160],
  ['Rachel Moore', 'flagger', 200, 900], ['Rachel Moore', 'cpsi', 400, 330], ['Rachel Moore', 'first_aid_cpr', 120, 610],
];
const CREW = ['Luis Ortega', 'Kevin Brandt', 'Tom Kowalski', 'Rachel Moore'];
const POSITION_OF = { 'Luis Ortega': 'Equipment operator', 'Kevin Brandt': 'Equipment operator', 'Tom Kowalski': 'Mechanic', 'Rachel Moore': 'Laborer' };

module.exports = async function crew(conn, T, { today, addDays, staffIds, ids, timezone, log }) {
  const staff = await staffIds();
  const positions = await ids('positions');

  // ---- certification types and licenses
  await seedCertifications(conn, T);
  const [certRows] = await conn.query('SELECT id, code FROM certifications WHERE tenant_id = ? AND code IS NOT NULL', [T]);
  const cert = new Map(certRows.map((r) => [r.code, Number(r.id)]));
  let lic = 0;
  for (const [who, code, issued, expires] of LICENSES) {
    if (!staff.get(who) || !cert.get(code)) continue;
    const [r] = await conn.query('INSERT IGNORE INTO staff_certifications (tenant_id, staff_id, certification_id, issued_on, expires_on) VALUES (?, ?, ?, ?, ?)',
      [T, staff.get(who), cert.get(code), addDays(today, -issued), expires === null ? null : addDays(today, expires)]);
    lic += r.affectedRows;
  }
  log(`${lic} new license${lic === 1 ? '' : 's'} and certification${lic === 1 ? '' : 's'} on the crew's records`);

  // ---- today's shifts (published), 7:00 AM to 3:30 PM; Rachel is off today
  let sh = 0;
  for (const who of CREW.slice(0, 3)) {
    const s = staff.get(who); const pos = positions.get(POSITION_OF[who]);
    if (!s || !pos) continue;
    const [[have]] = await conn.query("SELECT COUNT(*) AS n FROM shifts WHERE tenant_id = ? AND staff_id = ? AND starts_at >= ? AND starts_at < ?", [T, s, `${today} 00:00:00`, `${addDays(today, 1)} 00:00:00`]);
    if (Number(have.n)) continue;
    await conn.query("INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, 'published')", [T, pos, s, `${today} 07:00:00`, `${today} 15:30:00`]);
    sh += 1;
  }
  log(`${sh} shift${sh === 1 ? '' : 's'} for today`);

  // ---- time clock: four weeks of punches (weekdays 7:00 to 3:30, some long days and call-outs), and two clocked in now.
  // A punch the demo left open on an earlier day is closed first, so the Hours tab shows no missed clock-out.
  const db = (local) => utcFromLocal(local, timezone);
  await conn.query("UPDATE time_entries SET clock_out = DATE_ADD(clock_in, INTERVAL 510 MINUTE) WHERE tenant_id = ? AND clock_out IS NULL AND clock_in < ?", [T, db(`${today} 00:00:00`)]);
  let punches = 0;
  const punch = async (s, inLocal, outLocal, callout = 0) => {
    const [[have]] = await conn.query('SELECT COUNT(*) AS n FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_in >= ? AND clock_in < ?', [T, s, db(`${inLocal.slice(0, 10)} 00:00:00`), db(`${addDays(inLocal.slice(0, 10), 1)} 00:00:00`)]);
    if (Number(have.n) && !callout) return;
    if (callout) { const [[dup]] = await conn.query('SELECT COUNT(*) AS n FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND callout = 1 AND clock_in = ?', [T, s, db(inLocal)]); if (Number(dup.n)) return; }
    await conn.query("INSERT INTO time_entries (tenant_id, staff_id, clock_in, clock_out, in_method, out_method, callout) VALUES (?, ?, ?, ?, 'pin', ?, ?)", [T, s, db(inLocal), outLocal ? db(outLocal) : null, outLocal ? 'pin' : null, callout]);
    punches += 1;
  };
  const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
  for (let back = 28; back >= 1; back -= 1) {
    const d = addDays(today, -back);
    if (weekday(d) === 0 || weekday(d) === 6) continue;
    for (const [i, who] of CREW.entries()) {
      const s = staff.get(who);
      if (!s) continue;
      // Eight-hour days; Luis and Tom ran long three days in the storm week (two weeks back): over 40 hours that week.
      const long = (who === 'Luis Ortega' || who === 'Tom Kowalski') && back > 7 && back <= 14 && weekday(d) <= 3;
      const out = long ? '18:00' : i === 3 && back % 5 === 0 ? '12:00' : '15:00';
      await punch(s, `${d} 07:0${i}:00`, `${d} ${out}:0${i}`);
    }
  }
  // Call-outs: a water leak at night and a tree down on a Saturday.
  if (staff.get('Luis Ortega')) await punch(staff.get('Luis Ortega'), `${addDays(today, -3)} 22:10:00`, `${addDays(today, -2)} 00:40:00`, 1);
  if (staff.get('Kevin Brandt')) await punch(staff.get('Kevin Brandt'), `${addDays(today, -9)} 19:30:00`, `${addDays(today, -9)} 22:15:00`, 1);
  if (staff.get('Tom Kowalski')) await punch(staff.get('Tom Kowalski'), `${addDays(today, -16)} 02:05:00`, `${addDays(today, -16)} 05:30:00`, 1);
  // Today: Luis and Tom are in.
  for (const [who, at] of [['Luis Ortega', '06:55'], ['Tom Kowalski', '07:02']]) {
    const s = staff.get(who);
    if (!s) continue;
    const [[open]] = await conn.query('SELECT COUNT(*) AS n FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [T, s]);
    if (!Number(open.n)) await punch(s, `${today} ${at}:00`, null);
  }
  log(`${punches} new time clock punch${punches === 1 ? '' : 'es'} (four weeks, with call-outs)`);

  // ---- on call: Water and sewer (weekly, Luis, Tom, Kevin), Streets (weekly, Kevin, Rachel, Luis), a swap and holidays
  const [cats] = await conn.query('SELECT id, name FROM request_categories WHERE tenant_id = ?', [T]);
  const cat = (re) => cats.filter((c) => re.test(c.name)).map((c) => Number(c.id));
  const monday = (() => { let d = today; while (weekday(d) !== 1) d = addDays(d, -1); return d; })();
  const rotations = [
    ['Water and sewer', 'Water', ['Luis Ortega', 'Tom Kowalski', 'Kevin Brandt'], cat(/water|sewer/i)],
    ['Streets', 'Streets', ['Kevin Brandt', 'Rachel Moore', 'Luis Ortega'], cat(/tree|sign|storm/i)],
  ];
  // Each rotation is for one of the borough's departments (made here if this runs first; 2026.11.20).
  await require('../../src/lib/workcosts').ensureBooks(conn, T);
  await require('../../src/lib/oncall').linkDepartments(conn, T); // a demo made before departments: its typed names become them
  const [depts] = await conn.query('SELECT id, name FROM departments WHERE tenant_id = ?', [T]);
  const deptId = (name) => { const d = depts.find((x) => x.name === name); return d ? Number(d.id) : null; };
  let rots = 0;
  for (const [name, dept, people, categories] of rotations) {
    const [[have]] = await conn.query('SELECT id FROM oncall_rotations WHERE tenant_id = ? AND name = ?', [T, name]);
    if (have) continue;
    const members = people.map((p) => staff.get(p)).filter(Boolean);
    const [r] = await conn.query('INSERT INTO oncall_rotations (tenant_id, name, department, department_id, members, starts_on, period_days, category_ids) VALUES (?, ?, ?, ?, ?, ?, 7, ?)',
      [T, name, deptId(dept) ? null : dept, deptId(dept), members.join(','), addDays(monday, -28), categories.join(',') || null]);
    rots += 1;
    if (name === 'Water and sewer' && staff.get('Kevin Brandt')) {
      await conn.query("INSERT INTO oncall_overrides (tenant_id, rotation_id, starts_on, ends_on, staff_id, reason, note) VALUES (?, ?, ?, ?, ?, 'swap', ?)",
        [T, r.insertId, addDays(monday, 23), addDays(monday, 25), staff.get('Kevin Brandt'), 'Covering for Tom at his daughter’s graduation']);
    }
  }
  log(`${rots} new on-call rotation${rots === 1 ? '' : 's'}`);
  let hol = 0;
  for (const year of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
    for (const [day, name] of usualHolidays(year)) { const [r] = await conn.query('INSERT IGNORE INTO oncall_holidays (tenant_id, day, name) VALUES (?, ?, ?)', [T, day, name]); hol += r.affectedRows; }
  }
  log(`${hol} new holiday${hol === 1 ? '' : 's'}`);
};
