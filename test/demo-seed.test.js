'use strict';

// db/demo.js after db/seed.js, on a fresh database, run twice (2026.11.12 review): it used to stop partway ("Cannot read
// properties of undefined (reading 'name')"), make every staff member and some students twice, fail every patrol shift
// and every 4-digit PIN, and miss the seed's certifications and positions (so no shift had a position).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const mysql = require('mysql2/promise');

const root = path.join(__dirname, '..');
const db = `${process.env.DB_NAME}_demoseed`.slice(0, 64);
const env = { ...process.env, DB_NAME: db, SEED_PASSWORD: 'demo-seed-test-pass-2026', SEED_SLUG: 'demo-mountain' };
const run = async (file, args = []) => {
  const r = await promisify(execFile)(process.execPath, [file, ...args], { cwd: root, env, timeout: 300000, maxBuffer: 1 << 26 });
  // The app's audit lines are JSON; the loader's own lines are plain text.
  return r.stdout.split('\n').filter((l) => !l.startsWith('{')).join('\n') + r.stderr;
};

let admin;
test.before(async () => {
  admin = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', multipleStatements: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await run('db/migrate.js');
});
test.after(async () => {
  await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await admin.end();
});

const counts = async () => {
  const [tables] = await admin.query("SELECT table_name AS t FROM information_schema.columns WHERE table_schema = ? AND column_name = 'tenant_id'", [db]);
  const out = {};
  for (const { t } of tables) out[t] = Number((await admin.query(`SELECT COUNT(*) AS n FROM \`${db}\`.\`${t}\``))[0][0].n);
  return out;
};
const all = async (sql, params = []) => (await admin.query(sql.replaceAll('{db}', db), params))[0];

test('seed then demo runs cleanly, uses the seed\'s records, and has what a ski school demo needs; a second run adds nothing', async () => {
  await run('db/seed.js');
  const first = await run('db/demo.js', ['demo-mountain']);
  assert.doesNotMatch(first, /did not go through|Demo loader stopped/, first);
  assert.match(first, /Done\. Demo Mountain has 17 staff \(17 new\)/, first);

  // No duplicates: one of each name, and every staff member and guest once.
  for (const [table, col] of [['certifications', 'name'], ['positions', 'name'], ['lifts', 'name'], ['trails', 'name'], ['products', 'name'], ['programs', 'name'], ['patrol_stations', 'name'], ['ops_assets', 'name'], ['doc_categories', 'name']]) {
    const dup = await all(`SELECT LOWER(${col}) AS k, COUNT(*) AS n FROM \`{db}\`.\`${table}\` GROUP BY LOWER(${col}) HAVING n > 1`);
    assert.deepEqual(dup, [], `${table} has no duplicates`);
  }
  const twice = await all("SELECT p.first_name, p.last_name, p.date_of_birth, COUNT(*) AS n FROM `{db}`.people p GROUP BY p.first_name, p.last_name, p.date_of_birth HAVING n > 1");
  assert.deepEqual(twice, [], 'nobody is on file twice');
  assert.equal((await all('SELECT COUNT(*) AS n FROM `{db}`.staff'))[0].n, 17);
  // The seed's certifications and positions are the ones used: every work shift has a position.
  assert.equal((await all("SELECT COUNT(*) AS n FROM `{db}`.certifications"))[0].n, 7);
  assert.equal((await all("SELECT COUNT(*) AS n FROM `{db}`.positions"))[0].n, 7);
  assert.ok((await all('SELECT COUNT(*) AS n FROM `{db}`.shifts WHERE position_id IS NOT NULL'))[0].n >= 50);
  // Patrol shifts are on the patrol schedule, published.
  assert.equal((await all("SELECT COUNT(*) AS n FROM `{db}`.patrol_shifts WHERE status = 'published' AND staff_id IS NOT NULL"))[0].n, 21);
  // 6-digit PINs for everyone (the mountain does not allow 4).
  assert.equal((await all('SELECT COUNT(*) AS n FROM `{db}`.kiosk_credentials WHERE pin_hash IS NOT NULL'))[0].n, 17);
  for (const [, pin] of first.matchAll(/ (\d+)(?=,| …)/g)) assert.equal(pin.length, 6, pin);

  // The ski school: instructors with certifications, teaching profiles and pay rates.
  const inst = await all("SELECT s.id, (SELECT COUNT(*) FROM `{db}`.staff_certifications sc WHERE sc.staff_id = s.id) AS certs FROM `{db}`.staff s JOIN `{db}`.instructor_profiles ip ON ip.staff_id = s.id");
  assert.equal(inst.length, 4);
  for (const i of inst) assert.ok(i.certs >= 2, 'each instructor holds PSIA Level 1 and CPR');
  const rates = await all('SELECT staff_id, kind FROM `{db}`.instructor_pay_rates');
  assert.ok(rates.filter((r) => r.staff_id === null).length >= 4, 'school-wide rates');
  assert.ok(rates.some((r) => r.staff_id !== null), 'and one instructor\'s own');
  // Lessons on each of the next 7 days, with children and adults booked, nobody in two lessons at once.
  const days = await all("SELECT COUNT(DISTINCT DATE(starts_at)) AS d, COUNT(*) AS n FROM `{db}`.lesson_sessions WHERE status <> 'cancelled' AND instructor_id IS NOT NULL");
  assert.equal(days[0].d, 7); assert.equal(days[0].n, 21);
  const ages = await all("SELECT TIMESTAMPDIFF(YEAR, p.date_of_birth, CURDATE()) AS age FROM `{db}`.lesson_bookings b JOIN `{db}`.people p ON p.id = b.person_id WHERE b.status = 'booked'");
  assert.ok(ages.filter((a) => a.age < 13).length >= 14, 'children in the kids\' groups');
  assert.ok(ages.filter((a) => a.age >= 18).length >= 21, 'adults in the adult groups and privates');
  const clash = await all("SELECT b1.id FROM `{db}`.lesson_bookings b1 JOIN `{db}`.lesson_sessions s1 ON s1.id = b1.session_id JOIN `{db}`.lesson_bookings b2 ON b2.person_id = b1.person_id AND b2.id > b1.id JOIN `{db}`.lesson_sessions s2 ON s2.id = b2.session_id WHERE s1.starts_at < s2.ends_at AND s2.starts_at < s1.ends_at");
  assert.deepEqual(clash, []);
  // A multi-week program: six weeks and a makeup week of Saturday meetings, with children enrolled.
  const term = await all("SELECT t.id, t.weeks, (SELECT COUNT(*) FROM `{db}`.program_sessions s WHERE s.term_id = t.id) AS meetings, (SELECT COUNT(*) FROM `{db}`.program_enrollments e WHERE e.term_id = t.id AND e.status <> 'withdrawn') AS kids FROM `{db}`.program_terms t");
  assert.equal(term.length, 1);
  assert.equal(term[0].weeks, 6); assert.ok(term[0].meetings >= 6); assert.ok(term[0].kids >= 4);

  // Run again: every table holds what it held (the audit log records the run itself).
  const before = await counts();
  const second = await run('db/demo.js', ['demo-mountain']);
  assert.doesNotMatch(second, /did not go through|Demo loader stopped/, second);
  assert.match(second, /\(0 new\)/);
  assert.match(second, /Already there, so not added again: .*work shifts.*lessons.*sales/);
  const after = await counts();
  delete before.audit_log; delete after.audit_log;
  assert.deepEqual(after, before);
});

test('2026.11.13: sentence-case seed names reach new mountains only; nothing matches the old names by case', async () => {
  // a second seed of the same mountain is refused and changes nothing
  const before = await counts();
  await assert.rejects(run('db/seed.js'), 'seeding a mountain that exists fails on purpose');
  assert.deepEqual(await counts(), before, 'an existing mountain is not touched');
  // no migration step renames a mountain's records
  const fs = require('node:fs');
  const steps = [path.join(root, 'db/migrate.js'), ...fs.readdirSync(path.join(root, 'db/steps')).map((f) => path.join(root, 'db/steps', f))];
  for (const f of steps) assert.ok(!/UPDATE\s+`?(positions|products|certifications|lifts|trails)`?\s+SET\s+[^;'"]*\bname\s*=/i.test(fs.readFileSync(f, 'utf8')), `${path.basename(f)} renames no records`);
  // production code never looks for the old Title Case seed names
  const OLD = /'(Lift Operator|Rental Technician|Ski Instructor|Ticket Window|Main Quad|Season Pass|Beginner Group Lesson|All-Day Lift Ticket|2-Day Lift Ticket|5-Visit Card|Lift Operator Training|CPR\/First Aid)'/;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  for (const f of [...walk(path.join(root, 'src')), ...walk(path.join(root, 'public/js'))]) assert.ok(!OLD.test(fs.readFileSync(f, 'utf8')), `${path.relative(root, f)} names an old seed record`);
  // position menus (menu v3) match a position's name in any case
  const menus = require('../src/lib/menus');
  for (const name of ['Lift operator', 'Lift Operator', 'LIFT OPERATOR']) assert.equal(menus.positionKind({ name, department: 'guest_services' }), 'lifts', name);
  for (const name of ['Park crew', 'Park Crew', 'TERRAIN PARK']) assert.equal(menus.positionKind({ name }), 'park', name);
  assert.equal(menus.positionKind({ name: 'Crew', department: 'Grooming' }), 'grooming');
});
