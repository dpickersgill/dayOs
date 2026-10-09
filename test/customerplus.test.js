'use strict';

// Customer record release 1: consent history, flags, dated notes, data export, anonymise, merge trail, data quality.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = Date.now().toString(36) + Math.floor(Math.random() * 100);
const PW = 'correct-horse-battery';
let A; let B; const T = {};

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
async function mountain(slug) {
  const t = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `o@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(t.status, 201);
  const l = await api('POST', '/auth/login', { body: { tenant: slug, email: `o@${slug}.test`, password: PW } });
  return { slug, token: l.body.token };
}
const person = async (token, extra = {}) => (await api('POST', '/people', { token, body: { first_name: 'Sam', last_name: `Skier${Math.random().toString(36).slice(2, 7)}`, ...extra } })).body;

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`cp-a-${suffix}`); B = await mountain(`cp-b-${suffix}`);
  for (const role of ['manager', 'counter', 'patrol']) {
    assert.equal((await api('POST', '/users', { token: A.token, body: { email: `${role}@${A.slug}.test`, password: PW, role } })).status, 201);
    T[role] = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `${role}@${A.slug}.test`, password: PW } })).body.token;
  }
});
test.after(async () => { server.close(); await pool.end(); });

test('consent: every change is kept, in order, by channel', async () => {
  const p = await person(T.counter, { email: 'cons@example.com', phone: '610-555-0101', marketing_opt_in: true });
  let c = await api('GET', `/people/${p.id}/consent`, { token: T.counter });
  assert.equal(c.body.current.email.status, 'opted_in');
  assert.equal(c.body.current.sms, null);
  assert.equal(c.body.events[0].source, 'staff_form');
  // Text messages are separate from email.
  assert.equal((await api('POST', `/people/${p.id}/consent`, { token: T.counter, body: { channel: 'sms', status: 'opted_in', source: 'counter' } })).status, 201);
  assert.equal((await api('POST', `/people/${p.id}/consent`, { token: T.counter, body: { channel: 'sms', status: 'opted_in', source: 'counter' } })).status, 409, 'no repeat of the same answer');
  // Withdrawing email updates the quick flag too.
  assert.equal((await api('POST', `/people/${p.id}/consent`, { token: T.counter, body: { channel: 'email', status: 'opted_out', source: 'guest_request' } })).status, 201);
  assert.equal((await api('GET', `/people/${p.id}`, { token: T.counter })).body.marketing_opt_in, 0);
  c = await api('GET', `/people/${p.id}/consent`, { token: T.counter });
  assert.equal(c.body.events.length, 3);
  assert.equal(c.body.current.email.status, 'opted_out');
  assert.equal(c.body.current.sms.status, 'opted_in');
  // Editing the form's tick box also lands in the ledger.
  await api('PATCH', `/people/${p.id}`, { token: T.counter, body: { marketing_opt_in: true } });
  assert.equal((await api('GET', `/people/${p.id}/consent`, { token: T.counter })).body.current.email.status, 'opted_in');
  // Needs something to send to.
  const bare = await person(T.counter);
  assert.equal((await api('POST', `/people/${bare.id}/consent`, { token: T.counter, body: { channel: 'sms', status: 'opted_in', source: 'phone' } })).status, 400);
  assert.equal((await api('POST', `/people/${bare.id}/consent`, { token: T.counter, body: { channel: 'email', status: 'opted_in', source: 'phone' } })).status, 400);
  assert.equal((await api('GET', `/people/${p.id}/consent`, { token: T.patrol })).status, 403);
});

test('flags: managers set and clear, staff see them in lookup, patrol sees medical alerts only', async () => {
  const p = await person(T.counter, { first_name: 'Flagg', last_name: `Test${suffix}` });
  assert.equal((await api('POST', `/people/${p.id}/flags`, { token: T.counter, body: { kind: 'do_not_rent', message: 'Lost skis' } })).status, 403);
  assert.equal((await api('POST', `/people/${p.id}/flags`, { token: T.manager, body: { kind: 'do_not_rent', message: 'Lost skis last winter' } })).status, 201);
  const med = await api('POST', `/people/${p.id}/flags`, { token: T.manager, body: { kind: 'medical_alert', message: 'Carries an epinephrine pen' } });
  assert.equal(med.body.data.length, 2);
  const look = await api('GET', `/people/lookup?q=Flagg`, { token: T.counter });
  assert.deepEqual(look.body.data[0].flags.map((f) => f.kind).sort(), ['do_not_rent', 'medical_alert']);
  const pat = await api('GET', `/people/${p.id}/flags`, { token: T.patrol });
  assert.deepEqual(pat.body.data.map((f) => f.kind), ['medical_alert']);
  // An expired flag no longer shows.
  await api('POST', `/people/${p.id}/flags`, { token: T.manager, body: { kind: 'vip', message: 'Old', expires_on: '2020-01-01' } });
  assert.equal((await api('GET', `/people/${p.id}/flags`, { token: T.counter })).body.data.length, 2);
  const id = med.body.data.find((f) => f.kind === 'do_not_rent').id;
  assert.equal((await api('DELETE', `/people/${p.id}/flags/${id}`, { token: T.counter })).status, 403);
  assert.equal((await api('DELETE', `/people/${p.id}/flags/${id}`, { token: T.manager })).body.data.length, 1);
  assert.equal((await api('DELETE', `/people/${p.id}/flags/${id}`, { token: T.manager })).status, 404);
  assert.equal((await api('POST', `/people/${p.id}/flags`, { token: T.manager, body: { kind: 'nonsense', message: 'x1' } })).status, 400);
});

test('notes: dated, with the author, newest first; only a manager deletes', async () => {
  const p = await person(T.counter);
  await api('POST', `/people/${p.id}/notes`, { token: T.counter, body: { body: 'Prefers morning lessons', category: 'preference' } });
  const r = await api('POST', `/people/${p.id}/notes`, { token: T.manager, body: { body: 'Refunded a day ticket after the lift closed', category: 'complaint' } });
  assert.equal(r.body.data.length, 2);
  assert.equal(r.body.data[0].category, 'complaint');
  assert.match(r.body.data[1].author_name, /counter@/);
  assert.equal((await api('POST', `/people/${p.id}/notes`, { token: T.counter, body: { body: '' } })).status, 400);
  assert.equal((await api('DELETE', `/people/${p.id}/notes/${r.body.data[0].id}`, { token: T.counter })).status, 403);
  assert.equal((await api('DELETE', `/people/${p.id}/notes/${r.body.data[0].id}`, { token: T.manager })).status, 200);
  assert.equal((await api('GET', `/people/${p.id}/notes`, { token: T.counter })).body.data.length, 1);
});

test('data export: one person, managers only, and it is logged', async () => {
  const p = await person(T.counter, { first_name: 'Dana', last_name: `Export${suffix}`, email: `dana${suffix}@example.com`, marketing_opt_in: true });
  await api('POST', `/people/${p.id}/notes`, { token: T.counter, body: { body: 'Likes the east lift' } });
  assert.equal((await api('GET', `/people/${p.id}/data-export`, { token: T.counter })).status, 403);
  const x = await api('GET', `/people/${p.id}/data-export`, { token: T.manager });
  assert.equal(x.status, 200);
  assert.equal(x.body.person.email, `dana${suffix}@example.com`);
  assert.equal(x.body.person.photo, undefined);
  assert.equal(x.body.notes.length, 1);
  assert.equal(x.body.consent.length, 1);
  const [[log]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'data_export' AND entity_id = ?", [p.id]);
  assert.equal(Number(log.n), 1);
  const other = await api('GET', `/people/${p.id}/data-export`, { token: B.token });
  assert.equal(other.status, 404, 'another mountain cannot see this person');
});

test('anonymise: identity goes, history and the proof of withdrawal stay', async () => {
  const p = await person(T.counter, { first_name: 'Erin', last_name: `Erase${suffix}`, email: `erin${suffix}@example.com`, phone: '610-555-0199', date_of_birth: '1985-02-03', marketing_opt_in: true });
  await api('POST', `/people/${p.id}/notes`, { token: T.counter, body: { body: 'Secret' } });
  await api('POST', `/people/${p.id}/flags`, { token: T.manager, body: { kind: 'vip', message: 'Friend of the owner' } });
  assert.equal((await api('POST', `/people/${p.id}/anonymise`, { token: T.counter, body: { confirm: true } })).status, 403);
  assert.equal((await api('POST', `/people/${p.id}/anonymise`, { token: T.manager, body: {} })).status, 400, 'must confirm');
  assert.equal((await api('POST', `/people/${p.id}/anonymise`, { token: T.manager, body: { confirm: true } })).status, 200);
  const g = (await api('GET', `/people/${p.id}`, { token: T.manager })).body;
  assert.equal(g.first_name, 'Former');
  assert.equal(g.email, null);
  assert.equal(g.phone, null);
  assert.equal(g.date_of_birth, null);
  assert.equal(g.marketing_opt_in, 0);
  assert.ok(g.anonymised_at);
  assert.equal((await api('GET', `/people/${p.id}/notes`, { token: T.manager })).body.data.length, 0);
  const c = await api('GET', `/people/${p.id}/consent`, { token: T.manager });
  assert.equal(c.body.current.email.status, 'opted_out');
  assert.equal(c.body.events[0].source, 'erasure');
  assert.equal((await api('PATCH', `/people/${p.id}`, { token: T.manager, body: { first_name: 'Back' } })).status, 409);
  assert.equal((await api('POST', `/people/${p.id}/notes`, { token: T.manager, body: { body: 'x' } })).status, 409);
  assert.equal((await api('POST', `/people/${p.id}/anonymise`, { token: T.manager, body: { confirm: true } })).status, 409, 'only once');
  const [[t]] = await pool.query("SELECT COUNT(*) AS n FROM person_tombstones WHERE old_id = ? AND action = 'anonymise'", [p.id]);
  assert.equal(Number(t.n), 1);
  // The email is free again.
  assert.equal((await api('POST', '/people', { token: T.counter, body: { first_name: 'New', last_name: 'Erin', email: `erin${suffix}@example.com` } })).status, 201);
  // A signed-in user is never anonymised.
  const mgrPerson = (await pool.query('SELECT person_id FROM users WHERE email = ?', [`manager@${A.slug}.test`]))[0][0].person_id;
  if (mgrPerson) assert.equal((await api('POST', `/people/${mgrPerson}/anonymise`, { token: T.manager, body: { confirm: true } })).status, 409);
});

test('merge keeps consent, notes and flags, and leaves a trail', async () => {
  const keep = await person(T.counter, { first_name: 'Mel', last_name: `Merge${suffix}`, email: `mel1${suffix}@example.com` });
  const dupe = await person(T.counter, { first_name: 'Mel', last_name: `Merge${suffix}`, phone: '610-555-0123', marketing_opt_in: true });
  await api('POST', `/people/${dupe.id}/notes`, { token: T.counter, body: { body: 'From the duplicate' } });
  await api('POST', `/people/${dupe.id}/flags`, { token: T.manager, body: { kind: 'other', message: 'Call before booking' } });
  const m = await api('POST', `/people/${dupe.id}/merge`, { token: T.manager, body: { into_id: keep.id } });
  assert.equal(m.status, 200);
  assert.equal((await api('GET', `/people/${keep.id}/notes`, { token: T.manager })).body.data.length, 1);
  assert.equal((await api('GET', `/people/${keep.id}/flags`, { token: T.manager })).body.data.length, 1);
  assert.equal((await api('GET', `/people/${keep.id}/consent`, { token: T.manager })).body.current.email.status, 'opted_in');
  const [[t]] = await pool.query("SELECT kept_id FROM person_tombstones WHERE old_id = ? AND action = 'merge'", [dupe.id]);
  assert.equal(Number(t.kept_id), keep.id);
  assert.equal((await api('GET', `/people/${dupe.id}`, { token: T.manager })).status, 404);
});

test('data quality: counts what is missing; scores and flags for the list', async () => {
  const q = await api('GET', '/people/quality', { token: T.manager });
  assert.equal(q.status, 200);
  assert.ok(q.body.total >= 5);
  assert.ok(q.body.no_email >= 1);
  assert.equal((await api('GET', '/people/quality', { token: T.counter })).status, 403);
  const full = await person(T.counter, { email: `full${suffix}@example.com`, phone: '610-555-0111', date_of_birth: '1990-01-01', address_line1: '1 Main St', postal_code: '19460', emergency_phone: '610-555-0000', marketing_opt_in: true });
  const bare = await person(T.counter);
  const s = await api('GET', `/people/scores?ids=${full.id},${bare.id}`, { token: T.counter });
  assert.equal(s.body.data[full.id].score, 100);
  assert.equal(s.body.data[bare.id].score, 0);
  assert.deepEqual(s.body.data[bare.id].flags, []);
});

test('another mountain cannot touch these', async () => {
  const p = await person(T.counter);
  for (const [m, path, body] of [['GET', 'consent'], ['POST', 'consent', { channel: 'email', status: 'opted_in', source: 'counter' }], ['GET', 'notes'], ['POST', 'notes', { body: 'hi' }], ['GET', 'flags'], ['POST', 'flags', { kind: 'vip', message: 'hi there' }], ['POST', 'anonymise', { confirm: true }]]) {
    const r = await api(m, `/people/${p.id}/${path}`, { token: B.token, body });
    assert.equal(r.status, 404, `${m} ${path}`);
  }
});
