'use strict';

// help/guest (Nov 9): the guest side of asking ski patrol for help. One button sends; optional tap answers are saved by
// the guest token; a status page shows patrol's messages and takes replies; live location while the page is open; the
// pass hint; the text-message fallback; Spanish; the personal-data register; and each mountain's requests stay its own.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.HELP_POSITION_LIMIT = '12'; // 12 a minute here, so the trail of 10 and the limit can both be seen

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const GH = require('../src/lib/guesthelp');
const GM = require('../src/lib/guestmsg');
const PUSH = require('../src/lib/push');

let server; let base;
const REC = require('./helpers/records').records(() => base, () => PW);
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, p, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${r.text.slice(0, 300)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
let n = 0;
async function mountain(tag) {
  const slug = `hg${tag}-${suffix}-${++n}`.slice(0, 40);
  const make = () => fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${tag}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  let res = await make();
  for (let i = 0; res.status === 429 && i < 14; i++) { await new Promise((r) => setTimeout(r, 5000)); res = await make(); }
  assert.equal(res.status, 201);
  const owner = await REC((await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token);
  const tenantId = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  ok(await api('PUT', '/patrol/guest-help', { token: owner, body: { enabled: true, message: 'Patrol base is at the summit' } }));
  // The two numbers are set in one place, Patrol settings, Text HELP. The help number is unique across mountains.
  const line = `+1484${String(tenantId).padStart(3, '0').slice(-3)}${String(Date.now()).slice(-4)}`;
  ok(await api('PUT', '/patrol/text-help', { token: owner, body: { help_number: line, patrol_phone: '610-555-0100' } }));
  const [l] = await pool.query("INSERT INTO lifts (tenant_id, name) VALUES (?, 'Summit Quad')", [tenantId]);
  return { slug, owner, tenantId, lift: l.insertId };
}
const help = (m, body, headers = {}) => api('POST', `/public/${m.slug}/help`, { body, headers });
const tok = (m, token, p = '', method = 'GET', body) => api(method, `/public/${m.slug}/help/${token}${p}`, { body });
const rid = () => require('crypto').randomBytes(16).toString('hex');
const callOf = async (token) => (await q('SELECT * FROM dispatch_calls WHERE guest_token = ?', [token]))[0];
let A; let B;

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain('a'); B = await mountain('b');
});
test.after(async () => { GH.usePlaces(null); await new Promise((r) => server.close(r)); await pool.end(); });

test('one button: a request with no words lands on the board as a new guest call, with a token for the status page', async () => {
  const r = ok(await help(A, { kind: 'help', rid: rid(), gps_lat: 44.26, gps_lng: -71.25, accuracy: 22 }, { 'x-device': 'onebutton-device-0001' }), 201);
  assert.match(r.token, /^[0-9a-f]{32}$/);
  assert.match(r.reference, /^\d{4}-\d{2}$/);
  assert.equal(r.status, 'received');
  const c = await callOf(r.token);
  assert.equal(c.source, 'guest'); assert.equal(c.status, 'new'); assert.equal(c.priority, 'normal');
  assert.equal(c.description, 'Guest pressed I need help now.');
  assert.match(c.location, /Phone location, within about 22 m/);
  assert.equal(Number(c.located_accuracy_m), 22);
  // The board shows it, and never the token or the request key.
  const board = ok(await api('GET', '/patrol/dispatch', { token: A.owner })).data;
  const row = board.find((x) => x.id === c.id);
  assert.ok(row);
  assert.equal(row.guest_token, undefined); assert.equal(row.request_key, undefined);
  // Even with no location at all, the request is taken.
  const bare = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  assert.equal((await callOf(bare.token)).location, 'Not given yet (guest help page)');
  // "For someone else" says so; the old typed form still works.
  const other = ok(await help(A, { kind: 'help', who: 'someone_i_saw', rid: rid(), location: 'Ridge Run' }), 201);
  const oc = await callOf(other.token);
  assert.equal(oc.who, 'someone_i_saw'); assert.equal(oc.location, 'Ridge Run');
  assert.match(oc.description, /someone they saw/);
});

test('a sign code from the QR resolves through help/places (and is skipped when places is not there)', async () => {
  // Without lib/places.js the page and the request still work.
  GH.usePlaces(null);
  const page0 = ok(await api('GET', `/public/${A.slug}/help?c=R7`));
  if (!GH.placesLib()) assert.equal(page0.place, undefined);
  const seen = [];
  GH.usePlaces({
    byCode: async (_db, tenantId, code) => { seen.push([tenantId, code]); return tenantId === A.tenantId && code === 'R7' ? { id: 77, name: 'Ridge Run top' } : null; },
    describe: async (_db, tenantId) => (tenantId === A.tenantId ? { text: 'Near Ridge Run, below Summit Quad tower 7, about 30 m', text_es: 'x', place_id: 78, distance_m: 30, confidence: 'high' } : null),
  });
  try {
    const page = ok(await api('GET', `/public/${A.slug}/help?c=r7`));
    assert.deepEqual(page.place, { code: 'R7', name: 'Ridge Run top' });
    assert.equal(ok(await api('GET', `/public/${B.slug}/help?c=R7`)).place, undefined, 'another mountain\'s code finds nothing');
    const r = ok(await help(A, { kind: 'help', rid: rid(), code: 'R7', gps_lat: 44.2, gps_lng: -71.2, accuracy: 30 }), 201);
    const c = await callOf(r.token);
    assert.equal(c.location, 'Sign R7: Ridge Run top');
    assert.equal(Number(c.place_id), 77);
    assert.equal(c.place_text, 'Near Ridge Run, below Summit Quad tower 7, about 30 m');
    assert.ok(seen.every(([t]) => [A.tenantId, B.tenantId].includes(t)));
    // A code that is not on the map: the phone's place words instead.
    const r2 = ok(await help(A, { kind: 'help', rid: rid(), code: 'ZZ9', gps_lat: 44.2, gps_lng: -71.2, accuracy: 30 }), 201);
    assert.match((await callOf(r2.token)).location, /^Near Ridge Run, below Summit Quad tower 7/);
  } finally { GH.usePlaces(null); }
});

test('answers are saved by the guest token only: a wrong token, a bad one or another mountain\'s address gets 404', async () => {
  const r = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  ok(await tok(A, r.token, '', 'PATCH', { who: 'someone_with_me', where: 'trees', lift: A.lift, steep: 'double_black', tower: '7', what: 'Twisted knee in the glades', phone: '(555) 201-3344' }));
  const c = await callOf(r.token);
  const a = JSON.parse(c.answers);
  assert.equal(a.lift_name, 'Summit Quad'); assert.equal(a.tower, '7'); assert.equal(a.steep, 'double_black');
  assert.equal(c.who, 'someone_with_me'); assert.equal(c.caller_phone, '(555) 201-3344');
  assert.equal(c.description, 'Twisted knee in the glades');
  assert.equal(c.location, 'Summit Quad tower 7. In the trees or off a trail', 'with no sign, the location line is made from the taps');
  ok(await tok(A, r.token, '', 'PATCH', { lift: 'not_sure' }));
  assert.equal(JSON.parse((await callOf(r.token)).answers).lift_not_sure, true);
  assert.equal((await tok(A, r.token, '', 'PATCH', { lift: B.lift })).status, 404, 'another mountain\'s lift');
  assert.equal((await tok(A, 'f'.repeat(32), '', 'PATCH', { what: 'x' })).status, 404, 'a wrong token');
  assert.equal((await tok(A, 'not-a-token', '', 'PATCH', { what: 'x' })).status, 404, 'a bad token');
  assert.equal((await tok(B, r.token, '', 'PATCH', { what: 'from B' })).status, 404, 'A\'s token at B\'s address');
  assert.equal((await tok(B, r.token)).status, 404);
  assert.equal(JSON.parse((await callOf(r.token)).answers).what, 'Twisted knee in the glades', 'unchanged');
  // The dispatch view reads them in plain words.
  const view = ok(await api('GET', `/patrol/dispatch/${c.id}`, { token: A.owner }));
  assert.equal(view.guest.who_text, 'Someone with the person asking');
  assert.deepEqual(view.guest.answers.map((x) => x.label), ['Where they are', 'Last lift ridden', 'How steep', 'Lift tower number', 'What happened']);
  assert.equal(view.guest.answers[2].value, 'Double black diamond (experts only)');
  assert.equal(view.guest_token, undefined);
  // A closed call takes no more answers.
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  assert.equal((await tok(A, r.token, '', 'PATCH', { what: 'late' })).status, 409);
});

test('a yes on bleeding raises the call to High, with a note on the timeline; a no does not', async () => {
  const r = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  ok(await tok(A, r.token, '', 'PATCH', { bleeding: false, cant_move: false, very_cold: false }));
  assert.equal((await callOf(r.token)).priority, 'normal');
  ok(await tok(A, r.token, '', 'PATCH', { bleeding: true }));
  const c = await callOf(r.token);
  assert.equal(c.priority, 'high');
  const notes = (await q('SELECT note FROM dispatch_events WHERE call_id = ? ORDER BY id', [c.id])).map((e) => e.note);
  assert.ok(notes.includes('Guest says someone is bleeding. Priority raised to High.'), notes.join(' | '));
  const view = ok(await api('GET', `/patrol/dispatch/${c.id}`, { token: A.owner }));
  assert.deepEqual(view.guest.answers.find((x) => x.label === 'Anyone bleeding'), { label: 'Anyone bleeding', value: 'Yes', alert: true });
  // A dispatcher's Critical is never lowered by the guest.
  ok(await api('PATCH', `/patrol/dispatch/${c.id}`, { token: A.owner, body: { priority: 'critical' } }));
  ok(await tok(A, r.token, '', 'PATCH', { very_cold: true }));
  assert.equal((await callOf(r.token)).priority, 'critical');
});

test('lost child: the guest\'s report opens a Lost child call (the school\'s call type), High, with the child\'s details', async () => {
  const r = ok(await help(A, { kind: 'lost_child', rid: rid() }), 201);
  const c0 = await callOf(r.token);
  assert.equal(c0.call_type, 'lost_child'); assert.equal(c0.priority, 'high'); assert.equal(c0.source, 'guest');
  ok(await tok(A, r.token, '', 'PATCH', { child_name: 'Mia', child_age: 6, child_jacket: 'Red', child_last_seen: 'Bottom of the Magic Carpet' }));
  const c = await callOf(r.token);
  assert.equal(c.description, 'Lost child (guest report): Mia, age 6. Jacket Red. Last seen: Bottom of the Magic Carpet.');
  assert.equal(c.location, 'Child last seen: Bottom of the Magic Carpet');
  const view = ok(await api('GET', `/patrol/dispatch/${c.id}`, { token: A.owner }));
  assert.deepEqual(view.guest.answers.map((x) => x.label), ['Child\'s first name', 'Child\'s age', 'Jacket color', 'Last seen']);
  assert.equal((await tok(A, r.token, '', 'PATCH', { child_age: 30 })).status, 400, 'a child is under 18');
  assert.equal(ok(await tok(A, r.token)).lost_child, true);
  // A guest's lost child report is not a school report: no school record, so the school's photo route has nothing.
  assert.equal((await api('GET', `/skischool/lost-by-call/${c.id}`, { token: A.owner })).status, 404);
  // A lost child from the same phone does not join a help request, and the other way round.
  const dev = { 'x-device': 'lostchild-device-0001' };
  const h1 = ok(await help(A, { kind: 'help', rid: rid() }, dev), 201);
  const l1 = ok(await help(A, { kind: 'lost_child', rid: rid() }, dev), 201);
  assert.notEqual(h1.token, l1.token);
});

test('dedupe: a retry, or the same phone again within 2 minutes, joins the same call; another phone does not', async () => {
  const dev = { 'x-device': 'dedupe-device-abcdef01' };
  const key = rid();
  const first = ok(await help(A, { kind: 'help', rid: key }, dev), 201);
  const retry = ok(await help(A, { kind: 'help', rid: key, gps_lat: 44.3, gps_lng: -71.3, accuracy: 15 }, { 'x-device': 'other-phone-entirely-01' }), 200);
  assert.equal(retry.joined, true); assert.equal(retry.token, first.token); assert.equal(retry.reference, first.reference);
  assert.equal(Number((await callOf(first.token)).gps_lat), 44.3, 'a retry with the location fills it in');
  const again = ok(await help(A, { kind: 'help', rid: rid() }, dev), 200);
  assert.equal(again.token, first.token, 'the same phone pressing again joins');
  const c = await callOf(first.token);
  assert.ok((await q('SELECT note FROM dispatch_events WHERE call_id = ?', [c.id])).some((e) => /asked again/.test(e.note)));
  const otherPhone = ok(await help(A, { kind: 'help', rid: rid() }, { 'x-device': 'dedupe-device-abcdef02' }), 201);
  assert.notEqual(otherPhone.token, first.token);
  const noDevice = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  assert.notEqual(noDevice.token, first.token, 'without a phone id nothing joins by address (a lodge\'s Wi-Fi)');
  // Two minutes later the same phone makes a new call.
  await pool.query('UPDATE dispatch_calls SET received_at = received_at - INTERVAL 3 MINUTE WHERE id = ?', [c.id]);
  assert.notEqual(ok(await help(A, { kind: 'help', rid: rid() }, dev), 201).token, first.token);
  // B never joins A's call, even with A's key.
  const atB = ok(await help(B, { kind: 'help', rid: key }, dev), 201);
  assert.notEqual(atB.token, first.token);
});

test('live location: positions are kept (last 10), rate limited per request, and stop when the guest turns it off or the call closes', async () => {
  const r = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  const c = await callOf(r.token);
  for (let i = 0; i < 12; i++) ok(await tok(A, r.token, '/position', 'POST', { lat: 44 + i / 1000, lng: -71, accuracy: 10 + i, age_s: 3 }));
  const over = await tok(A, r.token, '/position', 'POST', { lat: 44, lng: -71, accuracy: 5 });
  assert.equal(over.status, 429, 'the 13th in a minute is refused');
  const kept = await q('SELECT lat, accuracy_m FROM dispatch_positions WHERE call_id = ? ORDER BY id', [c.id]);
  assert.equal(kept.length, 10, 'the trail keeps the last 10');
  assert.equal(Number(kept[9].accuracy_m), 21);
  const latest = await callOf(r.token);
  assert.equal(Number(latest.gps_lat), 44.011); assert.equal(Number(latest.located_accuracy_m), 21); assert.ok(latest.located_at);
  const view = ok(await api('GET', `/patrol/dispatch/${c.id}`, { token: A.owner }));
  assert.equal(view.guest.positions.length, 10);
  assert.equal(Number(view.guest.positions[0].accuracy_m), 21, 'newest first, with accuracy and the time it was taken');
  assert.ok(view.guest.positions[0].taken_at);
  // Turned off by the guest.
  const r2 = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  ok(await tok(A, r2.token, '/live-off', 'POST', {}));
  const off = await tok(A, r2.token, '/position', 'POST', { lat: 44, lng: -71 });
  assert.equal(off.status, 409); assert.equal(off.body.stop, true);
  assert.equal(ok(await tok(A, r2.token)).live, false);
  // After 2 hours.
  const r3 = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  await pool.query('UPDATE dispatch_calls SET received_at = received_at - INTERVAL 121 MINUTE WHERE guest_token = ?', [r3.token]);
  assert.equal((await tok(A, r3.token, '/position', 'POST', { lat: 44, lng: -71 })).status, 409);
});

test('messages both ways: dispatch to the guest\'s page, the guest\'s reply to dispatch, and a phone alert to responders without the words', async () => {
  const r = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  const c = await callOf(r.token);
  const sid = ok(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Rae', last_name: 'Responder' }, status: 'active' } }), 201).id;
  ok(await api('POST', `/patrol/dispatch/${c.id}/responders`, { token: A.owner, body: { staff_id: sid } }), 201);
  const sent = ok(await api('POST', `/patrol/dispatch/${c.id}/messages`, { token: A.owner, body: { body: 'Stay where you are.' } }), 201);
  assert.equal(sent.texted, false, 'no phone given, texts not set up: page only');
  let st = ok(await tok(A, r.token));
  assert.deepEqual(st.messages.map((m) => [m.from, m.body]), [['patrol', 'Stay where you are.']]);
  assert.ok((await q('SELECT delivered FROM dispatch_messages WHERE id = ?', [sent.id]))[0].delivered, 'seen once the page shows it');
  const pushed = [];
  const was = PUSH.notifyStaff;
  PUSH.notifyStaff = async (tenantId, ids, msg) => { pushed.push({ tenantId, ids, msg }); return ids.length; };
  try {
    ok(await tok(A, r.token, '/messages', 'POST', { body: 'I am by the big pine, my leg hurts' }), 201);
    ok(await tok(A, r.token, '/messages', 'POST', { body: 'Still here' }), 201);
  } finally { PUSH.notifyStaff = was; }
  assert.equal(pushed.length, 2, 'every reply alerts the responders');
  assert.deepEqual(pushed[0].ids.map(Number), [sid]);
  assert.match(pushed[0].msg.title, /message from the guest/);
  assert.ok(!JSON.stringify(pushed).includes('pine'), 'the alert never holds the guest\'s words');
  const view = ok(await api('GET', `/patrol/dispatch/${c.id}`, { token: A.owner }));
  assert.deepEqual(view.guest.messages.map((m) => m.direction), ['to_guest', 'from_guest', 'from_guest']);
  st = ok(await tok(A, r.token));
  assert.deepEqual(st.messages.map((m) => m.from), ['patrol', 'you', 'you']);
  assert.equal(JSON.stringify(st).includes('Rae'), false, 'no staff names on the guest\'s page');
  // help/sms writes through the same module; nothing else writes the table.
  await GM.fromGuest(pool, { ...c, tenant_id: A.tenantId }, 'by text', 'sms');
  assert.equal((await q("SELECT channel FROM dispatch_messages WHERE call_id = ? ORDER BY id DESC LIMIT 1", [c.id]))[0].channel, 'sms');
  assert.equal((await api('POST', `/patrol/dispatch/${c.id}/messages`, { token: B.owner, body: { body: 'x' } })).status, 404, 'another mountain');
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  assert.equal((await tok(A, r.token, '/messages', 'POST', { body: 'hello?' })).status, 409);
  assert.equal((await api('POST', `/patrol/dispatch/${c.id}/messages`, { token: A.owner, body: { body: 'x' } })).status, 409);
});

test('the status words the guest sees follow the call: received, dispatched, on scene, closed', async () => {
  assert.deepEqual(['new', 'dispatched', 'on_scene', 'transporting', 'closed', 'cancelled'].map(GM.guestStatus), ['received', 'dispatched', 'on_scene', 'on_scene', 'closed', 'closed']);
  const r = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  const c = await callOf(r.token);
  const word = async () => ok(await tok(A, r.token)).status;
  assert.equal(await word(), 'received');
  const sid = ok(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Sam', last_name: 'Sent' }, status: 'active' } }), 201).id;
  ok(await api('POST', `/patrol/dispatch/${c.id}/responders`, { token: A.owner, body: { staff_id: sid } }), 201);
  assert.equal(await word(), 'dispatched');
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'on_scene' } }), 201);
  assert.equal(await word(), 'on_scene');
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'transporting' } }), 201);
  assert.equal(await word(), 'on_scene');
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'closed', note: 'Handed to aid room' } }), 201);
  const st = ok(await tok(A, r.token));
  assert.equal(st.status, 'closed'); assert.equal(st.live, false);
  assert.equal(JSON.stringify(st).includes('aid room'), false, 'never the timeline');
  // A day later the page is gone.
  await pool.query('UPDATE dispatch_calls SET received_at = received_at - INTERVAL 25 HOUR WHERE id = ?', [c.id]);
  assert.equal((await tok(A, r.token)).status, 404);
});

test('the pass hint: this mountain\'s last scan today goes on the call; the guest is told nothing; lookups are limited and logged', async () => {
  await pool.query("INSERT INTO scans (tenant_id, code, location, result, scanned_at) VALUES (?, 'APASS1234', 'Summit Quad', 'ok', UTC_TIMESTAMP() - INTERVAL 25 MINUTE)", [A.tenantId]);
  await pool.query("INSERT INTO scans (tenant_id, code, location, result, scanned_at) VALUES (?, 'BPASS9999', 'B Lift', 'ok', UTC_TIMESTAMP() - INTERVAL 5 MINUTE)", [B.tenantId]);
  const r = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  const found = await tok(A, r.token, '/pass', 'POST', { number: 'apass 1234' });
  assert.deepEqual(found.body, { ok: true });
  const hint = JSON.parse((await callOf(r.token)).last_scan_hint);
  assert.equal(hint.lift, 'Summit Quad'); assert.ok(hint.minutes_ago >= 24 && hint.minutes_ago <= 26, String(hint.minutes_ago));
  assert.deepEqual(Object.keys(hint).sort(), ['lift', 'minutes_ago']);
  const st = ok(await tok(A, r.token));
  assert.equal(JSON.stringify(st).includes('Summit Quad'), false, 'nothing about the pass on the guest\'s page');
  // Another mountain's pass finds nothing here, and the answer to the guest is the same.
  const other = await tok(A, r.token, '/pass', 'POST', { number: 'BPASS9999' });
  assert.deepEqual(other.body, found.body);
  assert.deepEqual(JSON.parse((await callOf(r.token)).last_scan_hint), { none: true });
  const view = ok(await api('GET', `/patrol/dispatch/${(await callOf(r.token)).id}`, { token: A.owner }));
  assert.match(view.guest.scan_hint, /no lift scan today/);
  ok(await tok(A, r.token, '/pass', 'POST', { number: 'APASS1234' }));
  assert.equal((await tok(A, r.token, '/pass', 'POST', { number: 'APASS1234' })).status, 429, 'three lookups per request in 10 minutes');
  const logged = (await q('SELECT note FROM dispatch_events WHERE call_id = ? AND note LIKE ?', [(await callOf(r.token)).id, '%pass%'])).length;
  assert.equal(logged, 3, 'each lookup is on the call\'s timeline');
  assert.match((await q('SELECT note FROM dispatch_events WHERE call_id = ? ORDER BY id DESC LIMIT 1', [(await callOf(r.token)).id]))[0].note, /last lift scan today is on the call/);
  // Yesterday's scan is not today's.
  await pool.query("UPDATE scans SET scanned_at = UTC_TIMESTAMP() - INTERVAL 30 HOUR WHERE tenant_id = ? AND code = 'APASS1234'", [A.tenantId]);
  assert.equal(await GH.passHint(pool, A.tenantId, 'APASS1234', 'America/New_York'), null);
});

test('Spanish is chosen by the phone\'s language, and kept on the call', async () => {
  assert.equal(GH.langOf('es-MX,es;q=0.9,en;q=0.5'), 'es');
  assert.equal(GH.langOf('en-US,es;q=0.8'), 'en');
  assert.equal(GH.langOf('fr-CA,es;q=0.7,en;q=0.6'), 'es');
  assert.equal(GH.langOf('de'), 'en');
  assert.equal(GH.langOf(''), 'en');
  assert.equal(ok(await api('GET', `/public/${A.slug}/help`, { headers: { 'accept-language': 'es-419,es;q=0.9' } })).lang, 'es');
  assert.equal(ok(await api('GET', `/public/${A.slug}/help`, { headers: { 'accept-language': 'en-US' } })).lang, 'en');
  const r = ok(await help(A, { kind: 'help', rid: rid() }, { 'accept-language': 'es-MX' }), 201);
  assert.equal((await callOf(r.token)).lang, 'es');
  const chosen = ok(await help(A, { kind: 'help', rid: rid(), lang: 'en' }, { 'accept-language': 'es-MX' }), 201);
  assert.equal((await callOf(chosen.token)).lang, 'en', 'the guest\'s own switch wins');
  const view = ok(await api('GET', `/patrol/dispatch/${(await callOf(r.token)).id}`, { token: A.owner }));
  assert.equal(view.guest.lang, 'es');
});

test('the personal-data register lists the guest\'s messages and positions, found by their phone, and erasing keeps them with the call', async () => {
  const P = require('../src/lib/personal');
  for (const t of ['dispatch_messages', 'dispatch_positions']) {
    const e = P.REGISTRY.find((x) => x.table === t);
    assert.ok(e, `${t} is in the register`); assert.equal(e.group, 'patrol'); assert.equal(e.erase.keep, P.KEEP_DISPATCH);
  }
  const phone = `610555${String(Date.now()).slice(-4)}`;
  const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name, phone) VALUES (?, ?, ?, ?)', [A.tenantId, 'Gwen', 'Guest', phone]);
  const r = ok(await help(A, { kind: 'help', rid: rid() }), 201);
  ok(await tok(A, r.token, '', 'PATCH', { phone }));
  ok(await tok(A, r.token, '/messages', 'POST', { body: 'by the lodge' }), 201);
  ok(await tok(A, r.token, '/position', 'POST', { lat: 44, lng: -71, accuracy: 9 }));
  const out = await P.exportOf(pool, A.tenantId, p.insertId);
  assert.equal(out.patrol_records.exists, true);
  assert.equal(out.patrol_records.rows.dispatch_messages, 1);
  assert.equal(out.patrol_records.rows.dispatch_positions, 1);
  assert.equal(out.tables.dispatch_messages, undefined, 'patrol rows are counted, not copied');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const done = await P.erase(conn, A.tenantId, p.insertId);
    await conn.rollback();
    assert.equal(done.changed.dispatch_messages, undefined);
    assert.ok(done.kept.some((k) => k.tables.includes('dispatch_messages')));
  } finally { conn.release(); }
});

test('the text-message fallback: HELP, the sign or place, the position with accuracy, and what; iPhone and Android forms', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-strings-'));
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', 'help-strings.js'), path.join(dir, 'help-strings.mjs'));
  const H = await import(pathToFileURL(path.join(dir, 'help-strings.mjs')).href);
  assert.equal(H.smsBody({ code: 'R7', place: 'Ridge Run', lat: 44.260123, lng: -71.254456, acc: 18.4, what: 'lost child' }), 'HELP R7 44.26012,-71.25446 ±18m lost child');
  assert.equal(H.smsBody({ place: 'Ridge  Run' }), 'HELP Ridge Run');
  assert.equal(H.smsBody({}), 'HELP');
  const body = 'HELP R7 44.26012,-71.25446 ±18m';
  assert.equal(H.smsHref('555-010-0199', body, true), `sms:5550100199&body=${encodeURIComponent(body)}`);
  assert.equal(H.smsHref('+1 (555) 010-0199', body, false), `sms:+15550100199?body=${encodeURIComponent(body)}`);
  assert.equal(H.isApple('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 5), true);
  assert.equal(H.isApple('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5), true, 'an iPad that says it is a Mac');
  assert.equal(H.isApple('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0), false);
  assert.equal(H.isApple('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 5), false);
  // Every string in both languages, plain (no long dashes), and the language choice.
  assert.deepEqual(Object.keys(H.STRINGS.es).sort(), Object.keys(H.STRINGS.en).sort());
  for (const lang of ['en', 'es']) for (const [k, v] of Object.entries(H.STRINGS[lang])) assert.ok(v && !/[—–]/.test(v) && !/\$/.test(v), `${lang}.${k}`);
  assert.equal(H.pickLang(null, 'es', 'en-US'), 'es');
  assert.equal(H.pickLang('en', 'es', 'es-MX'), 'en');
  assert.equal(H.pickLang(null, null, 'es-AR'), 'es');
  assert.equal(H.t('es', 'qOf', { n: 2, t: 9 }), 'Pregunta 2 de 9');
  // The page settings show the numbers from Patrol settings, Text HELP (the one place they are set).
  const line = (await q('SELECT help_number FROM patrol_help_lines WHERE tenant_id = ?', [A.tenantId]))[0].help_number;
  const s = ok(await api('GET', '/patrol/guest-help', { token: A.owner }));
  assert.equal(s.patrol_phone, '+16105550100'); assert.equal(s.patrol_phone_shown, '610-555-0100'); assert.equal(s.sms_number, line);
  assert.equal((await api('PUT', '/patrol/text-help', { token: A.owner, body: { help_number: line, patrol_phone: 'call me' } })).status, 400);
  const page = ok(await api('GET', `/public/${A.slug}/help`));
  assert.equal(page.patrol_phone, '+16105550100'); assert.equal(page.patrol_phone_shown, '610-555-0100'); assert.equal(page.sms_number, line);
  assert.deepEqual(page.lifts.map((l) => l.name), ['Summit Quad']);
});

test('the page is small and stands alone: no app stylesheet, no app scripts, Call 911 on every screen', async () => {
  const pub = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'help.html'), 'utf8');
  const js = fs.readFileSync(path.join(pub, 'js', 'help.js'), 'utf8');
  const strings = fs.readFileSync(path.join(pub, 'js', 'help-strings.js'), 'utf8');
  assert.doesNotMatch(html, /app\.css/);
  assert.match(html, /href="tel:911"/);
  assert.deepEqual([...js.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]), ['./help-strings.js'], 'help.js loads only its strings');
  const total = Buffer.byteLength(html) + Buffer.byteLength(js) + Buffer.byteLength(strings);
  assert.ok(total < 48 * 1024, `page, script and strings are ${total} bytes`);
  assert.match(js, /tel:911/); // the bar on every screen
  assert.match(js, /8000/); assert.match(js, /15000/); // location capped at 8 s; text offered after 15 s
  const served = await fetch(`${base}/help/${A.slug}`);
  assert.equal(served.status, 200);
  assert.match(await served.text(), /Call 911/);
});
