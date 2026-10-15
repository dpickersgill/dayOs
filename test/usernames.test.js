'use strict';

// Sign in with a username or an email: every login has a username (made from the person's name when not given), email
// is optional except for owners and managers, usernames are unique per mountain and case does not matter, and a
// temporary password set by a manager has to be replaced before anything else works.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { suggestUsername, PATTERN } = require('../src/lib/usernames');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const PW2 = 'a-brand-new-password';
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const M = {};
const signIn = (login, password = PW, slug = M.slug) => api('POST', '/auth/login', { body: { tenant: slug, login, password } });

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M.slug = `un-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug: M.slug, name: 'Username Hill', owner: { email: `owner@${M.slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.owner = ok(await signIn(`owner@${M.slug}.test`)).token;
  M.staff = Number(ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Mia', last_name: 'Ellis' }, status: 'active' } })).id);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('usernames are suggested from the name, plain, and never clash', () => {
  assert.equal(suggestUsername({ first_name: 'Mia', last_name: 'Ellis' }), 'mellis');
  assert.equal(suggestUsername({ first_name: 'Mia', last_name: 'Ellis' }, new Set(['mellis', 'mellis2'])), 'mellis3');
  assert.equal(suggestUsername({ first_name: 'José', last_name: "Núñez-O'Brien" }), 'jnunezobrien');
  assert.equal(suggestUsername({ email: 'sam.window@x.test' }), 'sam.window');
  assert.match(suggestUsername({ email: 'o@x.test', id: 7 }), PATTERN);
});

test('the owner has a username and signs in with it or the email, any case', async () => {
  const me = ok(await api('GET', '/auth/me', { token: M.owner }));
  assert.equal(me.username, 'oowner');
  assert.equal(me.login_name, `owner@${M.slug}.test`);
  ok(await signIn('oowner'));
  ok(await signIn('OOwner'));
  ok(await api('POST', '/auth/login', { body: { tenant: M.slug, email: `owner@${M.slug}.test`, password: PW } }), 'the old email field still works');
  is(await signIn('oowner', 'wrong-password-123'), 401);
  is(await signIn('nobody'), 401);
});

test('a staff login needs no email; a manager does', async () => {
  const r = ok(await api('POST', '/users', { token: M.owner, body: { password: PW, role: 'patrol', staff_id: M.staff } }));
  assert.equal(r.username, 'mellis', 'made from the linked staff member');
  assert.equal(r.email, null);
  M.mia = r.id;
  const t = ok(await signIn('mellis')).token;
  const me = ok(await api('GET', '/auth/me', { token: t }));
  assert.equal(me.email, null);
  assert.equal(me.login_name, 'mellis');
  is(await api('POST', '/users', { token: M.owner, body: { username: 'mellis', password: PW, role: 'staff' } }), 409, 'taken');
  is(await api('POST', '/users', { token: M.owner, body: { username: 'MEllis', password: PW, role: 'staff' } }), 409, 'case does not make it different');
  is(await api('POST', '/users', { token: M.owner, body: { username: 'no@at.signs', password: PW, role: 'staff' } }), 400);
  is(await api('POST', '/users', { token: M.owner, body: { password: PW, role: 'staff' } }), 400, 'a username or an email is needed');
  is(await api('POST', '/users', { token: M.owner, body: { username: 'boss', password: PW, role: 'manager' } }), 400, 'managers need an email');
  const mgr = ok(await api('POST', '/users', { token: M.owner, body: { username: 'boss', email: `boss@${M.slug}.test`, password: PW, role: 'manager' } }));
  is(await api('PATCH', `/users/${mgr.id}`, { token: M.owner, body: { email: null } }), 400, 'a manager cannot lose their email');
  is(await api('PATCH', `/users/${M.mia}`, { token: M.owner, body: { role: 'manager' } }), 400, 'nor become a manager without one');
  // usernames and emails can be changed, and the new username signs in
  ok(await api('PATCH', `/users/${M.mia}`, { token: M.owner, body: { username: 'mia.e', email: 'mia@example.test' } }));
  ok(await signIn('mia.e'));
  ok(await signIn('mia@example.test'));
  is(await signIn('mellis'), 401);
  ok(await api('PATCH', `/users/${M.mia}`, { token: M.owner, body: { email: '' } }));
  is(await signIn('mia@example.test'), 401, 'email cleared');
  const list = ok(await api('GET', '/users', { token: M.owner })).data;
  assert.ok(list.some((u) => u.username === 'mia.e' && u.email === null));
  assert.equal(ok(await api('GET', `/users/suggest-username?staff_id=${M.staff}`, { token: M.owner })).username, 'mellis');
});

test('a temporary password has to be changed before anything else works', async () => {
  ok(await api('POST', `/users/${M.mia}/reset-password`, { token: M.owner, body: { new_password: 'temporary-pass-1', temporary: true } }));
  const out = ok(await signIn('mia.e', 'temporary-pass-1'));
  assert.equal(out.must_change_password, true);
  const me = ok(await api('GET', '/auth/me', { token: out.token }));
  assert.equal(me.must_change_password, true);
  const blocked = await api('GET', '/inbox/unread', { token: out.token });
  is(blocked, 403);
  assert.equal(blocked.body.details.code, 'password_change_required');
  is(await api('POST', '/auth/change-password', { token: out.token, body: { current_password: 'temporary-pass-1', new_password: 'temporary-pass-1' } }), 400, 'must be different');
  const changed = ok(await api('POST', '/auth/change-password', { token: out.token, body: { current_password: 'temporary-pass-1', new_password: PW2 } }));
  ok(await api('GET', '/inbox/unread', { token: changed.token }));
  assert.equal(ok(await api('GET', '/auth/me', { token: changed.token })).must_change_password, false);
  // a login made with a temporary password starts the same way
  const n = ok(await api('POST', '/users', { token: M.owner, body: { username: 'newbie', password: PW, role: 'staff', temporary: true } }));
  const t = ok(await signIn('newbie')).token;
  is(await api('GET', '/workforce/me', { token: t }), 403);
  assert.ok(ok(await api('GET', '/users', { token: M.owner })).data.find((u) => u.id === n.id).must_change_password);
});

test('a login with no email is shown by its username', async () => {
  const t = ok(await signIn('mia.e', PW2)).token;
  ok(await api('POST', '/inbox/threads', { token: t, body: { user_ids: [Number((await pool.query('SELECT id FROM users WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?) AND role = ?', [M.slug, 'owner']))[0][0].id)], body: 'Hello' } }));
  const threads = ok(await api('GET', '/inbox/threads', { token: M.owner })).data;
  assert.ok(threads.every((th) => th.members.every((m) => m.name)), 'every member has a name');
  // someone with no person record and no email shows as their username
  const nt = ok(await signIn('newbie')).token;
  const fresh = ok(await api('POST', '/auth/change-password', { token: nt, body: { current_password: PW, new_password: PW2 } })).token;
  ok(await api('POST', '/inbox/threads', { token: fresh, body: { user_ids: [M.mia], body: 'Hi Mia' } }));
  const mine = ok(await api('GET', '/inbox/threads', { token: t })).data;
  assert.ok(mine.some((th) => th.members.some((m) => m.name === 'newbie')));
});

test('anyone can change their own username', async () => {
  ok(await api('POST', '/auth/username', { token: M.owner, body: { username: 'Olive.Owner' } }));
  ok(await signIn('olive.owner'));
  is(await api('POST', '/auth/username', { token: M.owner, body: { username: 'mia.e' } }), 409);
  ok(await api('POST', '/auth/username', { token: M.owner, body: { username: 'oowner' } }));
});

test('usernames belong to one mountain', async () => {
  const slug = `un2-${suffix}`;
  await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Other', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  ok(await signIn('oowner', PW, slug), 'the same username at another mountain is a different login');
  is(await signIn('mia.e', PW2, slug), 401);
});
