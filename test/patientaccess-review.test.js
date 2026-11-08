'use strict';
// Review of release 2026.11.12 (fix/review-security): the case rule on a patient's own record, a dispatch path in
// capitals, taking a responder off a case call, and the records check never being case permission on its own.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.AUDIT_LOG_STDOUT = 'off';
const http = require('node:http');

const mails = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { try { mails.push(JSON.parse(body)); } catch (_) { /* not JSON */ } res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"x"}'); });
}).listen(0);
process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.POSTMARK_SERVER_TOKEN = 'test-token';
process.env.MAIL_FROM = 'hello@test.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const DEVICE = 'patient-access-device-0123456789';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function raw(method, p, { token, body, headers = {}, device = DEVICE } = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(device ? { 'x-device': device } : {}), ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const api = (method, p, opts) => raw(method, `/api/v1${p}`, opts);
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body).slice(0, 300)}`);
const asks = (r, why) => { is(r, 403, why); assert.equal(r.body.details && r.body.details.code, 'step_up_required', why); assert.equal(r.body.details.scope, 'records', why); };
const login = (who, password = PW, extra = {}, device = DEVICE) => api('POST', '/auth/login', { body: { tenant: M.slug, login: who, password, ...extra }, device });
const tokenOf = async (who) => ok(await login(who)).token;
const records = (token, password = PW) => api('POST', '/auth/step-up', { token, body: { scope: 'records', password } });
const stepUp = (token, password = PW) => api('POST', '/auth/step-up', { token, body: { password } });

let M; const U = {};
/** A login (patrol by default) with a staff record, on the roster at `level` when given. */
async function person(key, { role = 'patrol', level = null, email = true } = {}) {
  const staff = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: key, last_name: 'Tester' }, status: 'active' } })).id;
  const login_ = `${key.toLowerCase()}@${M.slug}.test`;
  const u = ok(await api('POST', '/users', { token: M.owner, body: { ...(email ? { email: login_ } : { username: `${key.toLowerCase()}-${suffix}` }), password: PW, role, staff_id: staff } }));
  if (level) ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: staff, access_level: level, level: level === 'admin' ? 'director' : level === 'manager' ? 'leader' : 'patroller' } }));
  const who = email ? login_ : `${key.toLowerCase()}-${suffix}`;
  U[key] = { id: u.id, staff, login: who, token: await tokenOf(who) };
  return U[key];
}
const newCase = async (token, extra = {}) => ok(await api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'minor', summary: 'Knee', ...extra } })).id;
/** Moves a case (and the links made with it) back in time. */
async function age(id, hours) {
  await pool.query('UPDATE incidents SET created_at = DATE_SUB(created_at, INTERVAL ? HOUR) WHERE id = ?', [hours, id]);
  await pool.query('UPDATE incident_responders SET added_at = DATE_SUB(added_at, INTERVAL ? HOUR) WHERE incident_id = ? AND added_at IS NOT NULL', [hours, id]);
}
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `rv-${suffix}`;
  const r = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Access Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(r.status, 201);
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  M = { slug, id: t.id };
  M.owner = (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device': DEVICE }, body: JSON.stringify({ tenant: slug, login: `owner@${slug}.test`, password: PW }) })).json()).token;
  ok(await stepUp(M.owner));
  for (const k of ['Pat', 'Pia', 'Pete', 'Paz']) await person(k, { level: 'patrol' });
});
test.after(async () => { await new Promise((r) => server.close(r)); stub.close(); await pool.end(); });


const guestOn = async (token, key) => {
  const g = ok(await api('POST', '/people', { token: M.owner, body: { first_name: key, last_name: 'Guest', email: `${key.toLowerCase()}${suffix}@x.test`, phone: '5550001111', date_of_birth: '1990-02-03' } }));
  if (!token) return { guest: g, id: null };
  const id = await newCase(token);
  ok(await api('POST', `/patrol/incidents/${id}/patients`, { token, body: { person_id: g.id } }));
  return { guest: g, id };
};

// ---------------------------------------------------------------- 1. a patient's own record follows the case rule
test('a patroller opens a patient by id only on a case they may open; before the check every other id gets the same answer', async () => {
  const { guest, id } = await guestOn(U.Pat.token, 'Gina');
  const { guest: free } = await guestOn(null, 'Nora'); // a customer who was never a patient
  asks(await api('GET', `/patrol/incidents/${id}`, { token: U.Pia.token }), 'the case needs the check');
  // Pia had no part in the case: the patient's name, email, phone and birth date need the check too.
  const other = await api('GET', `/people/${guest.id}`, { token: U.Pia.token });
  asks(other, 'a patient on someone else\'s case');
  assert.equal(JSON.stringify(other.body).includes('Gina'), false);
  // Not a patient at all, and no such person: the very same answer, so ids tried one by one show nothing.
  const never = await api('GET', `/people/${free.id}`, { token: U.Pia.token });
  const none = await api('GET', '/people/987654321', { token: U.Pia.token });
  asks(never, 'not a patient'); asks(none, 'no such person');
  assert.deepEqual(never.body, other.body); assert.deepEqual(none.body, other.body);
  // The patroller who wrote the case opens the patient straight away, and it is logged with the case.
  const mine = ok(await api('GET', `/people/${guest.id}`, { token: U.Pat.token }));
  assert.equal(mine.first_name, 'Gina'); assert.equal(mine.address_line1, undefined, 'patrol still does not see the address');
  const [[row]] = await pool.query("SELECT detail FROM audit_log WHERE entity = 'people' AND entity_id = ? AND user_id = ? AND action = 'lookup' ORDER BY id DESC LIMIT 1", [guest.id, U.Pat.id]);
  const d = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  assert.equal(d.incident_id, id); assert.equal(d.fresh, false);
  // After the records check Pia opens the patient; someone who was never a patient is then simply not found.
  ok(await records(U.Pia.token));
  assert.equal(ok(await api('GET', `/people/${guest.id}`, { token: U.Pia.token })).first_name, 'Gina');
  is(await api('GET', `/people/${free.id}`, { token: U.Pia.token }), 404, 'not a patient, after the check');
  is(await api('GET', '/people/987654321', { token: U.Pia.token }), 404, 'no such person, after the check');
  // The front desk is not patrol: it still opens any customer.
  is(await api('GET', `/people/${free.id}`, { token: M.owner }), 200);
});

// ---------------------------------------------------------------- 2. capitals in a dispatch address
test('a case call\'s timeline cannot be written with the address in capitals or with a trailing slash', async () => {
  const call = ok(await api('POST', '/patrol/dispatch', { token: U.Pat.token, body: { location: 'Ridge', description: 'Head injury', source: 'radio' } }));
  const made = ok(await api('POST', `/patrol/dispatch/${call.id}/case`, { token: U.Pat.token, body: {} }));
  await age(made.id, 1);
  const pete = await tokenOf(U.Paz.login); // no tie to the case, no check
  for (const p of ['events', 'Events', 'EVENTS', 'events/', 'Events/']) asks(await api('POST', `/patrol/dispatch/${call.id}/${p}`, { token: pete, body: { kind: 'closed' } }), p);
  const [[c]] = await pool.query('SELECT status FROM dispatch_calls WHERE id = ?', [call.id]);
  assert.notEqual(c.status, 'closed');
  // Someone tied to the case goes on as before.
  is(await api('POST', `/patrol/dispatch/${call.id}/Events`, { token: U.Pat.token, body: { kind: 'note', note: 'Splinted' } }), 201);
});

// ---------------------------------------------------------------- 3. taking a responder off a case call
test('taking someone off a case call is logged, needs the case rule, and keeps the tie they had to the case', async () => {
  const call = ok(await api('POST', '/patrol/dispatch', { token: U.Pat.token, body: { location: 'Bowl', description: 'Shoulder', source: 'radio' } }));
  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: U.Pat.token, body: { staff_id: U.Pete.staff } }));
  const made = ok(await api('POST', `/patrol/dispatch/${call.id}/case`, { token: U.Pat.token, body: {} }));
  is(await api('GET', `/patrol/incidents/${made.id}`, { token: U.Pete.token }), 200, 'Pete was sent: opens it');
  const paz = await tokenOf(U.Paz.login); // dispatch, no tie, no check
  for (const p of ['responders', 'Responders', 'RESPONDERS']) asks(await api('DELETE', `/patrol/dispatch/${call.id}/${p}/${U.Pete.staff}`, { token: paz }), p);
  const [[still]] = await pool.query('SELECT COUNT(*) AS n FROM dispatch_responders WHERE call_id = ? AND staff_id = ?', [call.id, U.Pete.staff]);
  assert.equal(Number(still.n), 1, 'not removed');
  // The patroller who made the case takes Pete off.
  is(await api('DELETE', `/patrol/dispatch/${call.id}/responders/${U.Pete.staff}`, { token: U.Pat.token }), 204);
  const [[a]] = await pool.query("SELECT detail FROM audit_log WHERE entity = 'dispatch_calls' AND entity_id = ? AND user_id = ? AND action = 'remove_responder'", [call.id, U.Pat.id]);
  const d = typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail;
  assert.equal(d.staff_id, U.Pete.staff); assert.equal(d.incident_id, made.id);
  const board = ok(await api('GET', `/patrol/dispatch/${call.id}`, { token: U.Pat.token }));
  assert.equal((board.responders || []).some((r) => Number(r.staff_id) === U.Pete.staff), false, 'off the board');
  // Pete was sent within 30 minutes of the case starting: he still opens his own scene case.
  const back = await api('GET', `/patrol/incidents/${made.id}`, { token: U.Pete.token });
  is(back, 200, 'Pete keeps the case');
  // He can be sent again, and taken off again.
  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: U.Pat.token, body: { staff_id: U.Pete.staff } }));
  is(await api('DELETE', `/patrol/dispatch/${call.id}/responders/${U.Pete.staff}`, { token: U.Pat.token }), 204);
  is(await api('GET', `/patrol/incidents/${made.id}`, { token: U.Pete.token }), 200);
  // After the records check, anyone with dispatch can take a responder off.
  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: U.Pat.token, body: { staff_id: U.Pia.staff } }));
  ok(await records(paz));
  is(await api('DELETE', `/patrol/dispatch/${call.id}/responders/${U.Pia.staff}`, { token: paz }), 204);
});

test('taking someone off a call with no case gives no tie to a case made later; a late send does not gain one', async () => {
  const call = ok(await api('POST', '/patrol/dispatch', { token: U.Pat.token, body: { location: 'Glades', description: 'Lost', source: 'radio' } }));
  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: U.Pat.token, body: { staff_id: U.Paz.staff } }));
  const paz = await tokenOf(U.Paz.login);
  is(await api('DELETE', `/patrol/dispatch/${call.id}/responders/${U.Paz.staff}`, { token: paz }), 204, 'no case: no rule');
  const [[a]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'dispatch_calls' AND entity_id = ? AND action = 'remove_responder'", [call.id]);
  assert.equal(Number(a.n), 1, 'logged');
  const made = ok(await api('POST', `/patrol/dispatch/${call.id}/case`, { token: U.Pat.token, body: {} }));
  asks(await api('GET', `/patrol/incidents/${made.id}`, { token: paz }), 'removed before the case existed');
  // Someone sent long after the case started, then taken off: the kept tie follows the link rule, so it does not count.
  const call2 = ok(await api('POST', '/patrol/dispatch', { token: U.Pat.token, body: { location: 'Bowl', description: 'Wrist', source: 'radio' } }));
  const made2 = ok(await api('POST', `/patrol/dispatch/${call2.id}/case`, { token: U.Pat.token, body: {} }));
  await age(made2.id, 2);
  const pia = await tokenOf(U.Pia.login);
  ok(await api('POST', `/patrol/dispatch/${call2.id}/responders`, { token: pia, body: { staff_id: U.Pia.staff } })); // a late self-send
  asks(await api('GET', `/patrol/incidents/${made2.id}`, { token: pia }), 'late self-send');
  ok(await records(pia));
  is(await api('DELETE', `/patrol/dispatch/${call2.id}/responders/${U.Pia.staff}`, { token: pia }), 204);
  const pia2 = await tokenOf(U.Pia.login);
  asks(await api('GET', `/patrol/incidents/${made2.id}`, { token: pia2 }), 'still needs the check');
});

// ---------------------------------------------------------------- 4. the records check is not case permission
test('a Host who makes the records check still sees no case-tied kit or medication notes', async () => {
  const host = await person('Hal', { level: null });
  ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: host.staff, access_level: 'host' } }));
  host.token = await tokenOf(host.login);
  ok(await api('POST', '/patrol/kits/types/starter', { token: M.owner, body: { names: ['Trauma bag'] } }));
  const board = ok(await api('GET', '/patrol/kits', { token: M.owner }));
  const kit = ok(await api('POST', '/patrol/kits', { token: M.owner, body: { type_id: board.types[0].id, count: 1, location: 'Summit' } })).data[0];
  const id = await newCase(U.Pat.token);
  ok(await api('POST', `/patrol/kits/${kit.id}/checks`, { token: U.Pat.token, body: { kind: 'use', used: { [board.types[0].contents[0].key]: 1 }, incident_id: id, note: 'Used on Jane Roe, open femur' } }));
  // A medication move tied to the case, with a note.
  const drug = ok(await api('POST', '/patrol/meds/formulary', { token: M.owner, body: { name: 'Review test drug', authority: 'standing_order' } }));
  const stock = ok(await api('POST', '/patrol/meds/stock', { token: M.owner, body: { formulary_id: drug.id, quantity: 10 } }));
  await pool.query("INSERT INTO patrol_med_moves (tenant_id, stock_id, delta, reason, incident_id, note, by_user, at) VALUES (?, ?, -1, 'used', ?, 'Given to Jane Roe', ?, UTC_TIMESTAMP())", [M.id, stock.id, id, U.Pat.id]);
  const notes = async (token) => {
    const k = ok(await api('GET', `/patrol/kits/${kit.id}`, { token }));
    const m = ok(await api('GET', '/patrol/meds', { token }));
    return [...k.checks.map((c) => c.note), ...m.moves.map((x) => x.note)].filter(Boolean).join(' | ');
  };
  assert.doesNotMatch(await notes(host.token), /Jane/, 'before the check');
  ok(await records(host.token));
  is(await api('GET', `/patrol/incidents/${id}`, { token: host.token }), 403, 'a Host still cannot open cases');
  assert.doesNotMatch(await notes(host.token), /Jane/, 'after the check');
  // Someone who may see cases sees both notes after the check, and the patroller who wrote the case without one.
  assert.match(await notes(U.Pat.token), /open femur.*Given to Jane Roe|Given to Jane Roe.*open femur/);
  const paz = await tokenOf(U.Paz.login);
  assert.doesNotMatch(await notes(paz), /Jane/);
  ok(await records(paz));
  assert.match(await notes(paz), /open femur/);
});

// ---------------------------------------------------------------- the screens these rules show
test('the records check says which action asked for it', async () => {
  const pia = await tokenOf(U.Pia.login);
  const r = await api('GET', '/patrol/incidents?q=Gina', { token: pia });
  asks(r, 'a search');
  assert.equal(r.body.details.reason, 'search');
  assert.match(r.body.error, /Searching cases by name can find a patient/);
  const opened = await api('GET', `/patrol/incidents/${await newCase(U.Pat.token)}`, { token: pia });
  asks(opened); assert.equal(opened.body.details.reason, 'open');
  const past = await api('GET', '/patrol/dispatch?status=all', { token: pia });
  asks(past); assert.equal(past.body.details.reason, 'past_calls');
});

test('the passkey offer knows whether the login has an app or recovery codes', async () => {
  const fresh = await person('Quin', { level: 'patrol' });
  const me = ok(await api('GET', '/auth/me', { token: fresh.token }));
  assert.equal(me.passkey_prompt.kind, 'once');
  assert.equal(me.passkey_prompt.app, false); assert.equal(me.passkey_prompt.codes, false);
  // The app's words: only what is true.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  assert.doesNotMatch(src, /h\('p', \{ class: 'muted small' \}, 'Your authenticator app and recovery codes keep working as a backup\.'\)/, 'never said to everyone');
  assert.match(src, /if \(p\.app && p\.codes\) return 'Your authenticator app and recovery codes keep working as a backup\.'/);
});

test('the access log names fields as the case report does', async () => {
  const { guest, id } = await guestOn(U.Pat.token, 'Lena');
  const [[p]] = await pool.query('SELECT id FROM incident_patients WHERE incident_id = ? AND person_id = ?', [id, guest.id]);
  ok(await api('PATCH', `/patrol/incidents/${id}/patients/${p.id}`, { token: U.Pat.token, body: { chief_complaint: 'Knee', allergies: 'None known' } }));
  const log = ok(await api('GET', `/patrol/access-log?incident_id=${id}`, { token: M.owner }));
  const row = log.data.find((r) => r.action === 'update_patient');
  assert.deepEqual(row.detail.fields.sort(), ['allergies', 'chief_complaint']);
  assert.deepEqual(row.detail.field_labels.sort(), ['Allergies', 'Chief complaint']);
});
