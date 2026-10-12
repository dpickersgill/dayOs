'use strict';

// Inbox: one-to-one and group conversations between the logins of one mountain; links to records that each reader sees
// only as far as their own access lets them; unread counts; removing your own message; leaving a group; and nothing
// crossing to another mountain.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.INBOX_RATE_LIMIT = '5000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

const M = {};
async function mountain(name) {
  const slug = `${name}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const m = { slug, owner: await login(`owner@${slug}.test`) };
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  m.id = Number(t.id);
  for (const role of ['counter', 'patrol', 'staff']) {
    ok(await api('POST', '/users', { token: m.owner, body: { email: `${role}@${slug}.test`, password: PW, role } }));
    m[role] = await login(`${role}@${slug}.test`);
  }
  const users = (await pool.query('SELECT id, role FROM users WHERE tenant_id = ?', [m.id]))[0];
  m.uid = Object.fromEntries(users.map((u) => [u.role, Number(u.id)]));
  return m;
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M.a = await mountain('ia');
  M.b = await mountain('ib');
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('one-to-one: the same conversation every time, unread counts, read marks', async () => {
  const a = M.a;
  const first = ok(await api('POST', '/inbox/threads', { token: a.owner, body: { user_ids: [a.uid.counter], body: 'Can you cover the window at 2?' } }));
  const again = ok(await api('POST', '/inbox/threads', { token: a.counter, body: { user_ids: [a.uid.owner] } }));
  assert.equal(again.id, first.id, 'two people share one direct conversation');
  assert.equal(ok(await api('GET', '/inbox/unread', { token: a.counter })).unread, 1);
  assert.equal(ok(await api('GET', '/inbox/unread', { token: a.owner })).unread, 0, 'your own message is not unread');
  const list = ok(await api('GET', '/inbox/threads', { token: a.counter })).data;
  const row = list.find((t) => t.id === first.id);
  assert.equal(row.title, 'Olive Owner'); assert.equal(row.unread, 1); assert.equal(row.last.text, 'Can you cover the window at 2?');
  const msgs = ok(await api('GET', `/inbox/threads/${first.id}/messages`, { token: a.counter }));
  ok(await api('POST', `/inbox/threads/${first.id}/read`, { token: a.counter, body: { up_to: 999999999 } }));
  assert.equal(ok(await api('GET', '/inbox/unread', { token: a.counter })).unread, 0);
  // a read mark past the end does not hide what comes next
  ok(await api('POST', `/inbox/threads/${first.id}/messages`, { token: a.owner, body: { body: 'Thanks!' } }));
  assert.equal(ok(await api('GET', '/inbox/unread', { token: a.counter })).unread, 1);
  // new since the last look
  const after = ok(await api('GET', `/inbox/threads/${first.id}/messages?after=${msgs.data[msgs.data.length - 1].id}`, { token: a.counter })).data;
  assert.deepEqual(after.map((m) => m.body), ['Thanks!']);
  is(await api('POST', `/inbox/threads/${first.id}/messages`, { token: a.owner, body: { body: '   ' } }), 400, 'an empty message');
});

test('links show each reader only what they may open', async () => {
  const a = M.a;
  const [inc] = await pool.query("INSERT INTO incidents (tenant_id, occurred_at, location, category, severity, summary) VALUES (?, '2026-01-10 10:00:00', 'Ridge', 'injury', 'minor', 'Knee, Ridge Run')", [a.id]);
  const [person] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Gwen', 'Guest')", [a.id]);
  const refs = [{ type: 'patrol_case', id: inc.insertId }, { type: 'customer', id: person.insertId }, { type: 'order', id: 987654321 }];
  const g = ok(await api('POST', '/inbox/threads', { token: a.owner, body: { user_ids: [a.uid.counter, a.uid.patrol], name: 'Morning ops', body: 'Look at these', refs } }));
  const linksFor = async (token) => {
    const m = ok(await api('GET', `/inbox/threads/${g.id}/messages`, { token })).data.find((x) => x.body === 'Look at these');
    return Object.fromEntries(m.links.map((l) => [l.type, l]));
  };
  const owner = await linksFor(a.owner);
  assert.equal(owner.patrol_case.state, 'ok'); assert.match(owner.patrol_case.title, /^Case /); assert.match(owner.patrol_case.subtitle, /Knee/);
  assert.equal(owner.customer.title, 'Gwen Guest');
  assert.equal(owner.order.state, 'gone');
  const counter = await linksFor(a.counter);
  assert.equal(counter.patrol_case.state, 'no_access'); assert.equal(counter.patrol_case.title, undefined, 'no title, no summary');
  assert.equal(counter.customer.state, 'ok');
  assert.equal(counter.patrol_case.path, `#/patrol/case/${inc.insertId}`);
  const patrol = await linksFor(a.patrol);
  assert.equal(patrol.patrol_case.state, 'ok');
  assert.equal(patrol.customer.state, 'no_access', 'patrol does not get customer records from a link');
  // the app switched off: links into it cannot be opened, even by the owner
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'patrol', 0) ON DUPLICATE KEY UPDATE enabled = 0", [a.id]);
  modules.invalidate(a.id);
  assert.equal((await linksFor(a.owner)).patrol_case.state, 'no_access');
  await pool.query("UPDATE tenant_modules SET enabled = 1 WHERE tenant_id = ? AND module = 'patrol'", [a.id]);
  modules.invalidate(a.id);
  // a document: its category decides
  const [cat] = await pool.query("INSERT INTO doc_categories (tenant_id, name) VALUES (?, 'Safety plans')", [a.id]);
  await pool.query("INSERT INTO doc_category_roles (tenant_id, category_id, role, can_add) VALUES (?, ?, 'staff', 0)", [a.id, cat.insertId]);
  const [doc] = await pool.query("INSERT INTO documents (tenant_id, category_id, title, link_url) VALUES (?, ?, 'Avalanche plan', 'https://example.com/plan')", [a.id, cat.insertId]);
  const r = { refs: [{ type: 'document', id: doc.insertId }] };
  assert.equal(ok(await api('POST', '/inbox/links', { token: a.staff, body: r })).data[0].title, 'Avalanche plan');
  assert.equal(ok(await api('POST', '/inbox/links', { token: a.counter, body: r })).data[0].state, 'no_access');
  // bad links are refused
  is(await api('POST', `/inbox/threads/${g.id}/messages`, { token: a.owner, body: { refs: [{ type: 'salary', id: 1 }] } }), 400);
  is(await api('POST', `/inbox/threads/${g.id}/messages`, { token: a.owner, body: { refs: Array.from({ length: 6 }, (_, i) => ({ type: 'customer', id: i + 1 })) } }), 400, 'at most 5 links');
});

test('groups: rename, add, leave; private to their members; remove your own message only', async () => {
  const a = M.a;
  const g = ok(await api('POST', '/inbox/threads', { token: a.owner, body: { user_ids: [a.uid.counter], name: 'Lift ops' } }));
  is(await api('GET', `/inbox/threads/${g.id}/messages`, { token: a.staff }), 404, 'not a member: it does not exist for you');
  is(await api('POST', `/inbox/threads/${g.id}/messages`, { token: a.staff, body: { body: 'hi' } }), 404);
  ok(await api('POST', `/inbox/threads/${g.id}/members`, { token: a.counter, body: { user_ids: [a.uid.staff] } }));
  const sent = ok(await api('POST', `/inbox/threads/${g.id}/messages`, { token: a.staff, body: { body: 'Chair 3 is iced up' } }));
  is(await api('DELETE', `/inbox/messages/${sent.id}`, { token: a.owner }), 404, 'not your message');
  ok(await api('DELETE', `/inbox/messages/${sent.id}`, { token: a.staff }));
  const msgs = ok(await api('GET', `/inbox/threads/${g.id}/messages`, { token: a.owner })).data;
  const removed = msgs.find((m) => m.id === sent.id);
  assert.equal(removed.removed, true); assert.equal(removed.body, '');
  assert.ok(msgs.some((m) => m.by === null && /added/.test(m.body)), 'a note says who was added');
  ok(await api('PATCH', `/inbox/threads/${g.id}`, { token: a.staff, body: { name: 'Lifts' } }));
  assert.equal(ok(await api('GET', `/inbox/threads/${g.id}`, { token: a.owner })).title, 'Lifts');
  ok(await api('POST', `/inbox/threads/${g.id}/leave`, { token: a.staff }));
  is(await api('GET', `/inbox/threads/${g.id}/messages`, { token: a.staff }), 404, 'gone after leaving');
  // a one-to-one conversation cannot be renamed or left
  const d = ok(await api('POST', '/inbox/threads', { token: a.owner, body: { user_ids: [a.uid.staff] } }));
  is(await api('PATCH', `/inbox/threads/${d.id}`, { token: a.owner, body: { name: 'x' } }), 400);
  is(await api('POST', `/inbox/threads/${d.id}/leave`, { token: a.owner }), 403);
});

test('nothing crosses to another mountain', async () => {
  const { a, b } = M;
  const t = ok(await api('POST', '/inbox/threads', { token: a.owner, body: { user_ids: [a.uid.counter], body: 'private' } }));
  is(await api('GET', `/inbox/threads/${t.id}/messages`, { token: b.owner }), 404);
  is(await api('POST', `/inbox/threads/${t.id}/messages`, { token: b.owner, body: { body: 'hello' } }), 404);
  is(await api('POST', '/inbox/threads', { token: b.owner, body: { user_ids: [a.uid.counter] } }), 400, 'cannot message a login at another mountain');
  const people = ok(await api('GET', '/inbox/people', { token: b.owner })).data;
  assert.ok(people.every((p) => ![a.uid.counter, a.uid.owner, a.uid.patrol, a.uid.staff].includes(p.id)));
  // another mountain's record in a link: it is "gone" here, never its title
  const [person] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Secret', 'Person')", [a.id]);
  const out = ok(await api('POST', '/inbox/links', { token: b.owner, body: { refs: [{ type: 'customer', id: person.insertId }] } })).data[0];
  assert.equal(out.state, 'gone'); assert.equal(out.title, undefined);
  assert.equal(ok(await api('GET', '/inbox/unread', { token: b.owner })).unread, 0);
});

test('someone added to a group, or added back, sees it from then on; your own notes are not unread', async () => {
  const a = M.a;
  const g = ok(await api('POST', '/inbox/threads', { token: a.owner, body: { user_ids: [a.uid.counter, a.uid.staff], name: 'Rejoin test', body: 'before' } }));
  ok(await api('POST', `/inbox/threads/${g.id}/leave`, { token: a.staff }));
  ok(await api('POST', `/inbox/threads/${g.id}/messages`, { token: a.counter, body: { body: 'said while staff was away' } }));
  const before = ok(await api('GET', '/inbox/unread', { token: a.staff })).unread;
  ok(await api('POST', `/inbox/threads/${g.id}/members`, { token: a.counter, body: { user_ids: [a.uid.staff] } }));
  const seen = ok(await api('GET', `/inbox/threads/${g.id}/messages`, { token: a.staff })).data.map((m) => m.body);
  assert.ok(!seen.includes('said while staff was away') && !seen.includes('before'), JSON.stringify(seen));
  assert.ok(seen.some((b) => /added/.test(b)), 'they see the note that they were added');
  assert.equal(ok(await api('GET', '/inbox/unread', { token: a.staff })).unread, before + 1, 'only the note is new for them');
  ok(await api('POST', `/inbox/threads/${g.id}/messages`, { token: a.counter, body: { body: 'after' } }));
  assert.ok(ok(await api('GET', `/inbox/threads/${g.id}/messages`, { token: a.staff })).data.some((m) => m.body === 'after'));
  is(await api('POST', `/inbox/threads/${g.id}/members`, { token: a.counter, body: { user_ids: [a.uid.staff] } }), 400, 'already in it');
  is(await api('POST', `/inbox/threads/${g.id}/members`, { token: a.counter, body: { user_ids: [M.b.uid.counter] } }), 400, 'someone from another mountain');
  // the person who renamed it does not get their own note as unread
  const mine = ok(await api('GET', '/inbox/unread', { token: a.counter })).unread;
  ok(await api('PATCH', `/inbox/threads/${g.id}`, { token: a.counter, body: { name: 'Renamed' } }));
  assert.equal(ok(await api('GET', '/inbox/unread', { token: a.counter })).unread, mine);
  // odd paging numbers are ignored, not errors
  is(await api('GET', `/inbox/threads/${g.id}/messages?limit=-5`, { token: a.counter }), 200);
  is(await api('GET', `/inbox/threads/${g.id}/messages?limit=1.5&before=2.7`, { token: a.counter }), 200);
});

test('a document that does not exist looks the same as one you may not see; a login that was switched off gets no new messages', async () => {
  const a = M.a;
  const out = ok(await api('POST', '/inbox/links', { token: a.counter, body: { refs: [{ type: 'document', id: 987654321 }] } })).data[0];
  assert.equal(out.state, 'no_access');
  const d = ok(await api('POST', '/inbox/threads', { token: a.owner, body: { user_ids: [a.uid.patrol] } }));
  await pool.query('UPDATE users SET active = 0 WHERE id = ?', [a.uid.patrol]);
  is(await api('POST', `/inbox/threads/${d.id}/messages`, { token: a.owner, body: { body: 'are you there?' } }), 400);
  await pool.query('UPDATE users SET active = 1 WHERE id = ?', [a.uid.patrol]);
});
