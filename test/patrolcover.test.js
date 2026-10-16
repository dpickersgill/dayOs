'use strict';

// Patrol shift cover: a patroller asks for cover on their own published shift, the roster is told in the cover
// conversation, someone free takes it and the shift moves to them; with approval on, a schedule builder approves or
// declines the offer first. Withdrawing, schedule changes and shifts that have started close requests.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, addDays } = require('../src/lib/util');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

const M = {};
const today = todayIn('America/New_York');
const day0 = addDays(today, 20);
const at = (d, hm) => `${addDays(day0, d)}T${hm}`;

async function inboxText(token) {
  const threads = ok(await api('GET', '/inbox/threads', { token })).data;
  const out = [];
  for (const t of threads) out.push(...ok(await api('GET', `/inbox/threads/${t.id}/messages`, { token })).data.map((m) => m.body));
  return out.join('\n');
}
async function shift(staffId, d, publish = true) {
  const id = Number(ok(await api('POST', '/patrol/schedule', { token: M.owner, body: { staff_id: staffId, starts_at: at(d, '08:00'), ends_at: at(d, '16:30'), station_id: M.hut } })).id);
  if (publish) ok(await api('POST', '/patrol/schedule/publish', { token: M.owner, body: { from: addDays(day0, d), to: addDays(day0, d) } }));
  return id;
}
const staffOn = async (id) => Number((await pool.query('SELECT staff_id FROM patrol_shifts WHERE id = ?', [id]))[0][0].staff_id);
const board = async (token) => ok(await api('GET', '/patrol/cover', { token }));

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `pc-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Cover Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  // Paula leads (so she builds the schedule); Vic, Wes and Val patrol
  for (const [key, first, level] of [['paula', 'Paula', 'leader'], ['vic', 'Vic', 'patroller'], ['wes', 'Wes', 'patroller'], ['val', 'Val', 'candidate']]) {
    M[key] = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: first, last_name: 'Patrol' }, level } })).staff_id);
    ok(await api('POST', '/users', { token: M.owner, body: { email: `${key}@${slug}.test`, password: PW, role: 'patrol', staff_id: M[key] } }));
    M[`${key}T`] = await login(`${key}@${slug}.test`);
  }
  M.hut = Number(ok(await api('POST', '/patrol/stations', { token: M.owner, body: { name: 'Summit hut', kind: 'hut' } })).id);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('a patroller asks for cover on their own published shift, once', async () => {
  M.vicShift = await shift(M.vic, 0);
  M.wesShift = await shift(M.wes, 0);
  const draft = await shift(M.vic, 9, false);
  const open = await shift(null, 0);
  is(await api('POST', '/patrol/cover', { token: M.wesT, body: { patrol_shift_id: M.vicShift } }), 403, 'not your shift');
  is(await api('POST', '/patrol/cover', { token: M.vicT, body: { patrol_shift_id: draft } }), 400, 'drafts are changed on the schedule');
  is(await api('POST', '/patrol/cover', { token: M.owner, body: { patrol_shift_id: open } }), 400, 'nobody to cover for');
  const r = ok(await api('POST', '/patrol/cover', { token: M.vicT, body: { patrol_shift_id: M.vicShift, reason: 'Family wedding' } }));
  M.req1 = r.id;
  is(await api('POST', '/patrol/cover', { token: M.vicT, body: { patrol_shift_id: M.vicShift } }), 409, 'already asked');
  const past = Number(ok(await api('POST', '/patrol/schedule', { token: M.owner, body: { staff_id: M.vic, starts_at: `${addDays(today, -3)}T08:00`, ends_at: `${addDays(today, -3)}T16:00` } })).id);
  ok(await api('POST', '/patrol/schedule/publish', { token: M.owner, body: { from: addDays(today, -3), to: addDays(today, -3) } }));
  is(await api('POST', '/patrol/cover', { token: M.vicT, body: { patrol_shift_id: past } }), 400, 'already started');

  const mine = await board(M.vicT);
  assert.equal(mine.my_shifts.find((s) => s.id === M.vicShift).request_id, M.req1);
  assert.ok(mine.open.find((x) => x.id === M.req1).mine);
  const sched = ok(await api('GET', `/patrol/schedule?from=${day0}&to=${day0}`, { token: M.valT }));
  assert.equal(sched.shifts.find((s) => Number(s.id) === M.vicShift).cover_status, 'open', 'the schedule shows it needs cover');
});

test('the roster is told, and only someone free can take it', async () => {
  assert.match(await inboxText(M.valT), /Cover needed: .*Summit hut, for Vic Patrol\. "Family wedding"/);
  const wes = (await board(M.wesT)).open.find((x) => x.id === M.req1);
  assert.equal(wes.can_take, false);
  assert.match(wes.problems.join(), /Already on patrol/);
  is(await api('POST', `/patrol/cover/${M.req1}/take`, { token: M.wesT }), 409, 'Wes is on patrol then');
  is(await api('POST', `/patrol/cover/${M.req1}/take`, { token: M.vicT }), 400, 'not your own');
  assert.equal((await board(M.valT)).open.find((x) => x.id === M.req1).can_take, true);
  const out = ok(await api('POST', `/patrol/cover/${M.req1}/take`, { token: M.valT }));
  assert.equal(out.status, 'covered');
  assert.equal(await staffOn(M.vicShift), M.val, 'the shift moved to Val');
  is(await api('POST', `/patrol/cover/${M.req1}/take`, { token: M.paulaT }), 409, 'already covered');
  assert.match(await inboxText(M.vicT), /Val Patrol is covering your patrol shift/);
  assert.match(await inboxText(M.wesT), /Covered: .*Val Patrol is covering for Vic Patrol/);
  const h = (await board(M.wesT)).history.find((x) => x.id === M.req1);
  assert.equal(h.status, 'covered');
  assert.equal(h.taken_by_name, 'Val Patrol');
});

test('with approval on, an offer waits for a schedule builder', async () => {
  is(await api('PUT', '/patrol/cover/settings', { token: M.vicT, body: { needs_approval: true } }), 403);
  ok(await api('PUT', '/patrol/cover/settings', { token: M.paulaT, body: { needs_approval: true } }));
  const r = ok(await api('POST', '/patrol/cover', { token: M.wesT, body: { patrol_shift_id: M.wesShift } }));
  assert.equal(ok(await api('POST', `/patrol/cover/${r.id}/take`, { token: M.vicT })).status, 'pending');
  assert.equal(await staffOn(M.wesShift), M.wes, 'still Wes until approved');
  is(await api('POST', `/patrol/cover/${r.id}/take`, { token: M.paulaT }), 409, 'already offered');
  assert.match(await inboxText(M.paulaT), /Shift cover to approve: Vic Patrol offered to cover Wes Patrol/);
  assert.equal((await board(M.paulaT)).pending.length, 1);
  assert.equal((await board(M.valT)).pending.length, 0, 'others do not see offers');
  is(await api('POST', `/patrol/cover/${r.id}/approve`, { token: M.vicT }), 403);
  ok(await api('POST', `/patrol/cover/${r.id}/decline`, { token: M.paulaT, body: { note: 'Need a senior there' } }));
  assert.match(await inboxText(M.vicT), /was not approved\. "Need a senior there"/);
  assert.ok((await board(M.valT)).open.some((x) => x.id === r.id), 'open again');
  ok(await api('POST', `/patrol/cover/${r.id}/take`, { token: M.vicT }));
  ok(await api('POST', `/patrol/cover/${r.id}/approve`, { token: M.paulaT }));
  assert.equal(await staffOn(M.wesShift), M.vic);
  assert.match(await inboxText(M.vicT), /Approved: you are covering Wes Patrol's patrol shift/);
  ok(await api('PUT', '/patrol/cover/settings', { token: M.owner, body: { needs_approval: false } }));
});

test('withdrawing keeps the shift, and tells anyone who offered', async () => {
  ok(await api('PUT', '/patrol/cover/settings', { token: M.owner, body: { needs_approval: true } }));
  const s = await shift(M.wes, 2);
  const r = ok(await api('POST', '/patrol/cover', { token: M.wesT, body: { patrol_shift_id: s } }));
  ok(await api('POST', `/patrol/cover/${r.id}/take`, { token: M.valT }));
  is(await api('POST', `/patrol/cover/${r.id}/withdraw`, { token: M.vicT }), 403, 'only the one who asked');
  ok(await api('POST', `/patrol/cover/${r.id}/withdraw`, { token: M.wesT }));
  assert.equal(await staffOn(s), M.wes);
  assert.match(await inboxText(M.valT), /Wes Patrol no longer needs cover/);
  is(await api('POST', `/patrol/cover/${r.id}/withdraw`, { token: M.wesT }), 409, 'already closed');
  ok(await api('PUT', '/patrol/cover/settings', { token: M.owner, body: { needs_approval: false } }));
});

test('changing the shift on the schedule settles the request', async () => {
  const a = await shift(M.wes, 3);
  const ra = ok(await api('POST', '/patrol/cover', { token: M.wesT, body: { patrol_shift_id: a } }));
  ok(await api('PATCH', `/patrol/schedule/${a}`, { token: M.owner, body: { staff_id: M.paula } }));
  let row = (await pool.query('SELECT status, taken_by FROM patrol_cover_requests WHERE id = ?', [ra.id]))[0][0];
  assert.deepEqual([row.status, Number(row.taken_by)], ['covered', M.paula], 'putting someone else on it counts as covered');
  const b = await shift(M.wes, 4);
  const rb = ok(await api('POST', '/patrol/cover', { token: M.wesT, body: { patrol_shift_id: b } }));
  ok(await api('PATCH', `/patrol/schedule/${b}`, { token: M.owner, body: { notes: 'Bring radios' } }));
  assert.equal((await pool.query('SELECT status FROM patrol_cover_requests WHERE id = ?', [rb.id]))[0][0].status, 'open', 'a note does not change it');
  ok(await api('DELETE', `/patrol/schedule/${b}`, { token: M.owner }));
  row = (await pool.query('SELECT status FROM patrol_cover_requests WHERE id = ?', [rb.id]))[0][0];
  assert.equal(row.status, 'closed');
  // taking someone off the roster closes their requests
  const c = await shift(M.wes, 5);
  const rc = ok(await api('POST', '/patrol/cover', { token: M.wesT, body: { patrol_shift_id: c } }));
  ok(await api('DELETE', `/patrol/team/${M.wes}`, { token: M.owner }));
  assert.equal((await pool.query('SELECT status FROM patrol_cover_requests WHERE id = ?', [rc.id]))[0][0].status, 'closed');
  assert.ok(!(await board(M.valT)).open.some((x) => x.id === rc.id));
});
