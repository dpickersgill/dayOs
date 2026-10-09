'use strict';

// Instructor availability: instructors set their own open dates and times, managers can edit for anyone, and a public read-only page shows only the instructors who opt in.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const day = (offset) => fmt.format(new Date(Date.now() + offset * 86400000));
const yesterday = day(-1);

async function api(method, path, { token, body, headers = {} } = {}) {
  const raw = body instanceof Buffer;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? { 'content-type': 'application/octet-stream', 'x-filename': headers.name } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), text };
}
const ok = (r, status) => { assert.equal(r.status, status ?? (r.status < 300 ? r.status : -1), JSON.stringify(r.body)); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
const login = async (m, email) => (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;

let A; let B; const T = {}; const D = {};
const future = (n) => day(n);

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`av-${suffix}`); B = await mountain(`aw-${suffix}`);
  D.ivy = ok(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Ivy', last_name: 'Instructor' }, status: 'active' } }), 201).id;
  D.max = ok(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Max', last_name: 'Other' }, status: 'active' } }), 201).id;
  ok(await api('POST', '/users', { token: A.owner, body: { email: `ivy@${A.slug}.test`, password: PW, role: 'instructor', staff_id: D.ivy } }), 201);
  ok(await api('POST', '/users', { token: A.owner, body: { email: `max@${A.slug}.test`, password: PW, role: 'instructor', staff_id: D.max } }), 201);
  ok(await api('POST', '/users', { token: A.owner, body: { email: `mgr@${A.slug}.test`, password: PW, role: 'manager' } }), 201);
  ok(await api('POST', '/users', { token: A.owner, body: { email: `counter@${A.slug}.test`, password: PW, role: 'counter' } }), 201);
  ok(await api('POST', '/users', { token: A.owner, body: { email: `patrol@${A.slug}.test`, password: PW, role: 'patrol' } }), 201);
  T.ivy = await login(A, `ivy@${A.slug}.test`); T.max = await login(A, `max@${A.slug}.test`);
  T.manager = await login(A, `mgr@${A.slug}.test`); T.counter = await login(A, `counter@${A.slug}.test`); T.patrol = await login(A, `patrol@${A.slug}.test`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('an instructor marks dates and times open, and overlapping times join together', async () => {
  const d1 = future(3); const d2 = future(4);
  is(await api('POST', '/availability/windows', { token: T.patrol, body: { dates: [d1], start_time: '09:00', end_time: '12:00' } }), 403, 'patrol is not an instructor');
  is(await api('POST', '/availability/windows', { token: T.ivy, body: { dates: [yesterday], start_time: '09:00', end_time: '12:00' } }), 400, 'not in the past');
  is(await api('POST', '/availability/windows', { token: T.ivy, body: { dates: [d1], start_time: '12:00', end_time: '09:00' } }), 400, 'end after start');
  is(await api('POST', '/availability/windows', { token: T.ivy, body: { dates: [future(500)], start_time: '09:00', end_time: '12:00' } }), 400, 'not beyond a year');
  ok(await api('POST', '/availability/windows', { token: T.ivy, body: { dates: [d1, d2], start_time: '09:00', end_time: '12:00', note: 'Mornings' } }), 201);
  ok(await api('POST', '/availability/windows', { token: T.ivy, body: { dates: [d1], start_time: '11:00', end_time: '14:00' } }), 201);
  const me = ok(await api('GET', '/availability/me', { token: T.ivy }));
  assert.equal(me.staff.id, D.ivy);
  assert.equal(me.windows.length, 2, 'the overlap on day one became a single window');
  const joined = me.windows.find((w) => w.open_date === d1);
  assert.equal(joined.start_time, '09:00'); assert.equal(joined.end_time, '14:00');
  ok(await api('POST', '/availability/windows', { token: T.ivy, body: { dates: [d1], start_time: '15:00', end_time: '16:00' } }), 201);
  assert.equal(ok(await api('GET', '/availability/me', { token: T.ivy })).windows.length, 3, 'a separate time stays separate');
  is(await api('DELETE', `/availability/windows/${me.windows[0].id}`, { token: T.max }), 403, 'another instructor cannot remove it');
  ok(await api('DELETE', `/availability/windows/${me.windows[0].id}`, { token: T.ivy }));
  const cleared = ok(await api('POST', '/availability/windows/clear', { token: T.ivy, body: { dates: [d1, d2] } }));
  assert.ok(cleared.cleared >= 1);
  assert.equal(ok(await api('GET', '/availability/me', { token: T.ivy })).windows.length, 0);
});

test('instructors cannot edit each other, but a manager can edit anyone', async () => {
  is(await api('POST', '/availability/windows', { token: T.max, body: { staff_id: D.ivy, dates: [future(5)], start_time: '09:00', end_time: '10:00' } }), 403);
  is(await api('GET', `/availability/me?staff_id=${D.ivy}`, { token: T.max }), 403);
  is(await api('POST', '/availability/windows', { token: T.manager, body: { dates: [future(5)], start_time: '09:00', end_time: '10:00' } }), 400, 'a manager must say whose');
  ok(await api('POST', '/availability/windows', { token: T.manager, body: { staff_id: D.ivy, dates: [future(5)], start_time: '09:00', end_time: '10:00' } }), 201);
  assert.equal(ok(await api('GET', `/availability/me?staff_id=${D.ivy}`, { token: T.manager })).windows.length, 1);
  is(await api('GET', `/availability/me?staff_id=${D.ivy}`, { token: B.owner }), 404, 'another mountain');
  const list = ok(await api('GET', '/availability/instructors', { token: T.counter })).data;
  assert.deepEqual(list.map((i) => i.name).sort(), ['Ivy Instructor', 'Max Other']);
  const over = ok(await api('GET', '/availability/overview', { token: T.counter })).data;
  assert.equal(over.length, 1); assert.equal(over[0].name, 'Ivy Instructor');
  is(await api('GET', '/availability/overview', { token: T.patrol }), 403);
});

test('the public page is off until a manager turns it on, and lists only instructors who opt in', async () => {
  const url = `/public/${A.slug}/instructor-availability`;
  is(await api('GET', url), 404, 'off by default');
  is(await api('PUT', '/availability/settings', { token: T.ivy, body: { public: true } }), 403, 'only managers switch it on');
  ok(await api('PUT', '/availability/settings', { token: T.manager, body: { public: true } }));
  assert.deepEqual(ok(await api('GET', url)).instructors, [], 'nobody has opted in yet');
  is(await api('PUT', '/availability/profile', { token: T.ivy, body: { is_public: true, disciplines: [], levels: [] } }), 400, 'say what you teach first');
  is(await api('PUT', '/availability/profile', { token: T.ivy, body: { is_public: true, disciplines: ['curling'], levels: [] } }), 400);
  ok(await api('PUT', '/availability/profile', { token: T.ivy, body: { is_public: true, bio: 'Teaching for ten years.', disciplines: ['ski', 'snowboard'], levels: ['beginner', 'intermediate'] } }));
  const page = ok(await api('GET', url));
  assert.equal(page.instructors.length, 1);
  assert.equal(page.instructors[0].name, 'Ivy I.', 'last initial only by default');
  assert.deepEqual(page.instructors[0].disciplines, ['ski', 'snowboard']);
  assert.equal(page.days.length, 1);
  assert.equal(page.days[0].slots[0].instructor, page.instructors[0].id);
  const text = JSON.stringify(page);
  assert.equal(text.includes('Max'), false, 'an instructor who did not opt in is not listed');
  assert.equal(text.includes('@'), false, 'no email addresses');
  assert.equal(Object.keys(page.instructors[0]).includes('staff_id'), false);
  ok(await api('POST', '/availability/windows', { token: T.max, body: { dates: [future(6)], start_time: '13:00', end_time: '16:00' } }), 201);
  assert.equal(ok(await api('GET', url)).days.length, 1, 'an unlisted instructor adds nothing to the public page');
  ok(await api('PUT', '/availability/profile', { token: T.ivy, body: { is_public: true, display_name: 'Ivy', disciplines: ['ski'], levels: [] } }));
  assert.equal(ok(await api('GET', url)).instructors[0].name, 'Ivy');
  ok(await api('PUT', '/availability/profile', { token: T.ivy, body: { is_public: false, disciplines: ['ski'], levels: [] } }));
  assert.equal(ok(await api('GET', url)).days.length, 0, 'opting out removes their times');
  ok(await api('PUT', '/availability/settings', { token: T.manager, body: { public: false } }));
  is(await api('GET', url), 404, 'switched off again');
  is(await api('GET', `/public/${B.slug}/instructor-availability`), 404);
});
