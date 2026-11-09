'use strict';

// Verdynt/OS School: a ski school on its own. The School only plan (Ski school, Documents and Instructor availability),
// and the ski area's free read-only login showing the day's ski school in numbers (lessons and students booked by time
// slot and level, instructors rostered by name, and how many students have a waiver on file), alongside or instead of
// the patrol summary depending on what the mountain has turned on.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SITE_CONTACT_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const config = require('../src/config');
const { seasonFor } = require('../src/lib/util');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';
const slug = `so-${suffix}`;
let T; let owner;

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const login = async (who) => (await api('POST', '/auth/login', { body: { tenant: slug, login: who, password: PW } })).body.token;
// The mountain's own day, not UTC's (new tenants default to America/New_York).
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  is(await api('POST', '/tenants', { headers: { 'x-bootstrap-key': KEY }, body: { slug, name: `Birch Ski School ${suffix}`, owner: { email: `dir@${slug}.test`, password: PW, first_name: 'Sam', last_name: 'Director' } } }), 201);
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  T = t.id;
  // Ski school, Documents and Instructor availability only: everything else off, as the School only plan sets it.
  const off = Object.fromEntries(['sell', 'catalog', 'gate', 'conditions', 'park', 'rentals', 'patrol', 'programs', 'messages', 'shop', 'money', 'workforce'].map((k) => [k, false]));
  is(await api('PUT', `/platform/tenants/${T}/modules`, { headers: { 'x-platform-key': KEY }, body: { modules: { ...off, school: true, documents: true, availability: true } } }), 200);
  owner = await login(`dir@${slug}.test`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the School only plan is seeded once, with Ski school, Documents and Instructor availability, priced above Patrol only', async () => {
  const r = await api('GET', '/site/plans');
  const p = r.body.plans.find((x) => x.code === 'school-only');
  assert.ok(p, 'listed with the plans');
  assert.equal(p.monthly_cents, 24900);
  assert.equal(p.yearly_cents, 254000);
  assert.deepEqual(p.apps.map((a) => a.key).sort(), ['availability', 'documents', 'school']);
  // Texts to families and AI lesson recaps stay separate paid add-ons: never bundled into School only.
  assert.ok(!p.apps.some((a) => ['lesson_texts', 'lesson_ai'].includes(a.key)));
  const patrol = r.body.plans.find((x) => x.code === 'patrol-only');
  assert.ok(patrol && p.monthly_cents > patrol.monthly_cents, 'priced on the higher side of Patrol only');

  // Running the migration again (a second install, or a redeploy) must not add a second row.
  execFileSync(process.execPath, [path.join(__dirname, '..', 'db', 'migrate.js')], { cwd: path.join(__dirname, '..'), env: process.env, timeout: 120000 });
  const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM billing_plans WHERE code = 'school-only'");
  assert.equal(Number(count.n), 1, 'seeding school-only twice does not duplicate it');
});

test('a school-only tenant can use the school module, and nothing it does not have', async () => {
  const me = (await api('GET', '/auth/me', { token: owner })).body;
  assert.ok(me.modules.includes('school') && me.modules.includes('availability') && me.modules.includes('documents'));
  assert.ok(!me.modules.includes('patrol') && !me.modules.includes('conditions'));
  is(await api('GET', '/skischool/sessions', { token: owner }), 200);
  is(await api('GET', '/patrol/incidents', { token: owner }), 403, 'no Patrol on this mountain');
  is(await api('GET', '/rentals', { token: owner }), 403, 'no rentals');
  is(await api('GET', '/workforce', { token: owner }), 403, 'no staff and schedule');
});

test('the free area login sees only the ski school summary: counts, instructor names and waiver completion, never prices or a family\'s details', async () => {
  is(await api('POST', '/users', { token: owner, body: { username: `area${suffix}`, password: PW, role: 'area' } }), 400, 'needs an email');
  const made = await api('POST', '/users', { token: owner, body: { username: `area${suffix}`, email: `gm@${slug}.test`, password: PW, role: 'area' } });
  is(made, 201);
  const area = await login(`gm@${slug}.test`);
  assert.equal((await api('GET', '/auth/me', { token: area })).body.role, 'area');

  const today = todayLocal();
  const [prod] = await pool.query("INSERT INTO products (tenant_id, kind, name, base_price_cents) VALUES (?, 'lesson', 'Group lesson', 8900)", [T]);
  const [s1] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, starts_at, ends_at, capacity) VALUES (?, ?, 'ski', 'beginner', ?, ?, 6)", [T, prod.insertId, `${today} 09:00:00`, `${today} 10:00:00`]);
  const [s2] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, starts_at, ends_at, capacity) VALUES (?, ?, 'ski', 'beginner', ?, ?, 6)", [T, prod.insertId, `${today} 09:00:00`, `${today} 10:00:00`]);
  const [kid1] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, 'Riley', 'Brightwater', 'parent1@example.test')", [T]);
  const [kid2] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, 'Jordan', 'Hollis', 'parent2@example.test')", [T]);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [T, s1.insertId, kid1.insertId]);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [T, s2.insertId, kid2.insertId]);
  // Riley has a waiver on file for this season; Jordan does not.
  await pool.query('INSERT INTO waivers (tenant_id, person_id, season) VALUES (?, ?, ?)', [T, kid1.insertId, seasonFor(today)]);
  // An instructor, rostered today in the ski_school department.
  const [instr] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Casey', 'Coach')", [T]);
  const [staffRow] = await pool.query('INSERT INTO staff (tenant_id, person_id) VALUES (?, ?)', [T, instr.insertId]);
  const [pos] = await pool.query("INSERT INTO positions (tenant_id, name, department) VALUES (?, 'Instructor', 'ski_school')", [T]);
  await pool.query("INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, 'published')", [T, pos.insertId, staffRow.insertId, `${today} 08:00:00`, `${today} 16:00:00`]);

  const sum = await api('GET', '/area/summary', { token: area });
  is(sum, 200);
  assert.ok(!sum.body.calls, 'no patrol fields: this mountain has no Patrol');
  const sc = sum.body.school;
  assert.ok(sc, 'a school summary is there');
  assert.equal(sc.lessons, 2);
  assert.equal(sc.students, 2);
  assert.deepEqual(sc.waivers, { on_file: 1, of: 2 });
  assert.deepEqual(sc.slots, [{ time: '09:00', level: 'beginner', discipline: 'ski', sessions: 2, students: 2 }]);
  assert.deepEqual(sc.instructors, ['Casey Coach']);

  const text = JSON.stringify(sum.body);
  assert.ok(!text.includes('Riley') && !text.includes('Brightwater') && !text.includes('Jordan') && !text.includes('Hollis'), 'no family or student names');
  assert.ok(!text.includes('parent1@example.test') && !text.includes('parent2@example.test'), 'no contact details');
  assert.ok(!text.includes('8900') && !/\$|cents|price/i.test(text), 'no dollar figures or prices');

  // Nothing else, and nothing changed
  for (const p of ['/skischool/sessions', '/documents/categories', '/inbox/unread', '/board', '/users', '/area/reports']) {
    is(await api('GET', p, { token: area }), 403, p);
  }
  is(await api('POST', '/skischool/sessions', { token: area, body: {} }), 403);
  is(await api('GET', '/auth/security', { token: area }), 200, 'their own sign-in settings');

  // In production it must use two-step sign-in, like anyone who reads patient reports or a school's students.
  const was = config.requireAdminMfa; config.requireAdminMfa = true;
  try {
    assert.equal((await api('GET', '/auth/me', { token: area })).body.mfa_rule, 'area');
    is(await api('GET', '/area/summary', { token: area }), 403);
  } finally { config.requireAdminMfa = was; }
  // Owners and managers can open it too
  is(await api('GET', '/area/summary', { token: owner }), 200);
});

test('a mountain with Patrol and Ski school both on sees both sections; a Patrol-only mountain is unaffected', async () => {
  const bothSlug = `sob-${suffix}`;
  is(await api('POST', '/tenants', { headers: { 'x-bootstrap-key': KEY }, body: { slug: bothSlug, name: `Both Hill ${suffix}`, owner: { email: `dir@${bothSlug}.test`, password: PW, first_name: 'Robin', last_name: 'Director' } } }), 201);
  const [[tb]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [bothSlug]);
  const off = Object.fromEntries(['sell', 'catalog', 'gate', 'conditions', 'park', 'rentals', 'programs', 'messages', 'shop', 'money', 'workforce'].map((k) => [k, false]));
  is(await api('PUT', `/platform/tenants/${tb.id}/modules`, { headers: { 'x-platform-key': KEY }, body: { modules: { ...off, patrol: true, school: true, documents: true, availability: true } } }), 200);
  // login() reads the module-level `slug` (the first tenant's), so sign in directly for this second tenant.
  const signedIn = await api('POST', '/auth/login', { body: { tenant: bothSlug, login: `dir@${bothSlug}.test`, password: PW } });
  is(signedIn, 200);
  const sum = await api('GET', '/area/summary', { token: signedIn.body.token });
  is(sum, 200);
  assert.ok(sum.body.calls, 'patrol fields are there, top level, same as a patrol-only mountain');
  assert.ok(sum.body.school, 'and the school summary is there too');
});

test('the website takes a School only sign-up as a lead', async () => {
  const r = await api('POST', '/site/contact', { body: { kind: 'school', name: 'Sam Director', mountain: `Birch ${suffix}`, email: `sam@${slug}.test`, message: '3 instructors' } });
  is(r, 201);
  const [[lead]] = await pool.query('SELECT kind FROM site_leads WHERE mountain = ?', [`Birch ${suffix}`]);
  assert.equal(lead.kind, 'school');
  await pool.query('DELETE FROM site_leads WHERE mountain = ?', [`Birch ${suffix}`]);
});
