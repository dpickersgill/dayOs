'use strict';

// The independent review of the guest help release (2026.11.16), each fix through the real HTTP routes: a guest who needs
// help always gets through, and patrol gets the right place words. A fake Twilio takes the texts we send; Text HELP is
// posted the way Twilio posts it (form-encoded and signed).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.PUBLIC_URL = 'https://app.verdynt.test';
process.env.HELP_FLOOD_ALERT_GAP_S = '2'; // 30 s in production; 2 here so the held flood alert can be seen going out

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { signature, PATH } = require('../src/routes/helpsms');
const HL = require('../src/lib/helpline');
const PUSH = require('../src/lib/push');

let server; let base; let tw;
const sent = []; // texts our server asked Twilio to send
const pushes = []; // phone alerts to staff on duty
const userPushes = []; // phone alerts to owners and managers
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const REC = require('./helpers/records').records(() => base, () => PW);
let phoneN = 1000 + Math.floor(Math.random() * 8000);
const guestPhone = () => `+1610555${String(phoneN++).padStart(4, '0')}`;
let sidN = 0;
const sid = () => `SM${suffix}${String(++sidN).padStart(6, '0')}`.padEnd(34, '0').slice(0, 34);
let ipN = 0;
const freshIp = () => `10.77.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const rid = () => require('crypto').randomBytes(16).toString('hex');

async function api(method, p, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${String(r.text).slice(0, 300)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); } };
const notes = async (callId) => (await q('SELECT note FROM dispatch_events WHERE call_id = ? ORDER BY id', [callId])).map((e) => e.note || '');

async function text(fields) {
  const params = { AccountSid: 'ACtest', MessageSid: sid(), NumMedia: '0', ...fields };
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', `${process.env.PUBLIC_URL}${PATH}`, params) };
  const res = await fetch(`${base}${PATH}`, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  const body = await res.text();
  const m = body.match(/<Message>([\s\S]*)<\/Message>/);
  return { status: res.status, reply: m ? m[1] : null, params };
}
const latestSms = async (M, phone) => (await q("SELECT * FROM dispatch_calls WHERE tenant_id = ? AND caller_phone = ? AND source = 'sms' ORDER BY id DESC LIMIT 1", [M.id, phone]))[0];
const help = (M, body, { dev, ip } = {}) => api('POST', `/public/${M.slug}/help`, { body, headers: { 'x-forwarded-for': ip || freshIp(), ...(dev ? { 'x-device': dev } : {}) } });
const callOf = async (token) => (await q('SELECT * FROM dispatch_calls WHERE guest_token = ?', [token]))[0];

let lineN = 0;
async function mountain(tag) {
  const slug = `hr${tag}-${suffix}`.slice(0, 40);
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ slug, name: `Mount ${tag.toUpperCase()}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const owner = await REC((await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token);
  const id = Number((await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id);
  const line = `+1484${String(Date.now() + (++lineN) * 7919).slice(-7)}`;
  const patrolPhone = `+1215${String(Date.now() * 7 + lineN * 104729).slice(-7)}`; // unique per run: the guests job serves every mountain
  ok(await api('PUT', '/patrol/guest-help', { token: owner, body: { enabled: true } }));
  ok(await api('PUT', '/patrol/text-help', { token: owner, body: { help_number: line, patrol_phone: patrolPhone } }));
  const ownerUser = Number((await q('SELECT id FROM users WHERE tenant_id = ? AND role = ? LIMIT 1', [id, 'owner']))[0].id);
  return { slug, owner, id, line, patrolPhone, ownerUser, name: `Mount ${tag.toUpperCase()}` };
}
/** Someone signed in on patrol duty for the length of fn. */
async function onDuty(M, fn) {
  const staff = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Duty', last_name: 'Patroller' }, status: 'active' } }), 201).id;
  const now = require('../src/lib/util').nowIn((await q('SELECT timezone FROM tenants WHERE id = ?', [M.id]))[0].timezone);
  await pool.query("INSERT INTO patrol_duty (tenant_id, staff_id, on_date, signed_in_at, source) VALUES (?, ?, ?, ?, 'phone')", [M.id, staff, now.slice(0, 10), now]);
  try { return await fn(Number(staff)); } finally { await pool.query('UPDATE patrol_duty SET signed_out_at = signed_in_at WHERE tenant_id = ? AND staff_id = ?', [M.id, staff]); }
}

let A; let MAP;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  tw = await new Promise((r) => {
    const s = http.createServer((req, res) => {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => { sent.push(Object.fromEntries(new URLSearchParams(d))); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` })); });
    });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  PUSH.notifyStaff = async (tenantId, staffIds, message) => { pushes.push({ tenantId, staffIds: staffIds.map(Number), message }); return staffIds.length; };
  PUSH.notifyUsers = async (tenantId, userIds, message) => { userPushes.push({ tenantId, userIds: userIds.map(Number), message }); return userIds.length; };
  A = await mountain('a');
  MAP = await mountain('map');
  await q('UPDATE tenants SET map_lat = 44.27, map_lng = -71.30 WHERE id = ?', [MAP.id]);
});
test.after(async () => { await new Promise((r) => server.close(r)); tw.close(); await pool.end(); });

// ---------------------------------------------------------------- 1. Text HELP calls in the call's Guest section
test('Text HELP: patrol reads the guest\'s texts in the call and replies; the reply goes out by text', async () => {
  const phone = guestPhone();
  await text({ From: phone, To: A.line, Body: 'HELP my friend is stuck in the trees' });
  const c = await latestSms(A, phone);
  const view = ok(await api('GET', `/patrol/dispatch/${c.id}`, { token: A.owner }));
  assert.ok(view.guest, 'the Guest section is there for a text');
  assert.equal(view.guest.by_text, true);
  assert.equal(view.guest.can_text, true);
  assert.deepEqual(view.guest.messages.map((m) => [m.direction, m.channel, m.body]), [['from_guest', 'sms', 'HELP my friend is stuck in the trees']]);
  const before = sent.length;
  const r = ok(await api('POST', `/patrol/dispatch/${c.id}/messages`, { token: A.owner, body: { body: 'Stay put. Patrol is coming.' } }), 201);
  assert.equal(r.texted, true);
  const out = sent.slice(before).find((x) => x.To === phone);
  assert.ok(out, 'texted to the guest');
  assert.equal(out.Body, `${A.name} ski patrol: Stay put. Patrol is coming.`);
  assert.equal(out.From, A.line, 'from the help number, in the same conversation');
  const again = ok(await api('GET', `/patrol/dispatch/${c.id}`, { token: A.owner }));
  assert.deepEqual(again.guest.messages.map((m) => [m.direction, m.channel]), [['from_guest', 'sms'], ['to_guest', 'sms']]);
});

// ---------------------------------------------------------------- 2. a flood never silences an alert
test('flood: 5 junk requests from one address, then a lost child from another phone, alerts; every grouped request still alerts, rate limited', async () => {
  await onDuty(A, async (staff) => {
    const ip = freshIp();
    pushes.length = 0;
    for (let i = 0; i < 5; i++) ok(await help(A, { kind: 'help', rid: rid() }, { dev: `junk-phone-${i}-abcdefghij`, ip }), 201);
    const lost = ok(await help(A, { kind: 'lost_child', rid: rid() }, { dev: 'real-parent-phone-0001', ip }), 201);
    const lc = await callOf(lost.token);
    assert.ok(lc.flood_of, 'grouped into the flood (the 6th from the address)');
    const alert = await waitFor(() => pushes.find((p) => p.message.tag === `call-${lc.id}`));
    assert.ok(alert, 'the lost child alerts on its own');
    assert.match(alert.message.title, /^Lost child: patrol call /);
    assert.ok(alert.staffIds.includes(staff));
    // More junk: the first grouped one alerts at once, the next inside 2 s is held, then alerted with the count.
    ok(await help(A, { kind: 'help', rid: rid() }, { dev: 'junk-phone-7-abcdefghij', ip }), 201);
    const first = await waitFor(() => pushes.find((p) => p.message.tag === `flood-${lc.flood_of}`));
    assert.ok(first, 'a request grouped into a flood still alerts');
    assert.match(first.message.title, /^Guest help: 2 more requests from the same place$/);
    ok(await help(A, { kind: 'help', rid: rid() }, { dev: 'junk-phone-8-abcdefghij', ip }), 201);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(pushes.filter((p) => p.message.tag === `flood-${lc.flood_of}`).length, 1, 'not two pushes inside the gap');
    const later = await waitFor(() => pushes.filter((p) => p.message.tag === `flood-${lc.flood_of}`)[1], 6000);
    assert.ok(later, 'the held one goes out when the gap is up: never silenced');
    assert.match(later.message.title, /3 more requests from the same place/);
    assert.doesNotMatch(JSON.stringify(pushes.map((p) => p.message)), /Lost child reported by a guest/, 'never the guest\'s words');
  });
});

// ---------------------------------------------------------------- 3. joining only on the same press
test('the same phone within 2 minutes: a retry of the same press joins; a different press is a new call, linked, and never moves the first', async () => {
  const [pl] = await pool.query("INSERT INTO mountain_places (tenant_id, kind, name, code, lat, lng, accuracy_m, marked_by, marked_at, active) VALUES (?, 'sign', 'Lower Birch', 'LB1', 44.3, -71.3, 5, 1, UTC_TIMESTAMP(), 1)", [A.id]);
  const dev = 'same-phone-review-0001';
  const key = rid();
  const first = ok(await help(A, { kind: 'help', rid: key }, { dev }), 201);
  const c0 = await callOf(first.token);
  assert.equal(c0.place_text, null);
  // The retry of the same press brings a position 10 m east of the sign: it joins, and the place words follow.
  const at = { lat: 44.3, lng: -71.3 + 10 / (111320 * Math.cos(44.3 * Math.PI / 180)) };
  const retry = ok(await help(A, { kind: 'help', rid: key, gps_lat: at.lat, gps_lng: at.lng, accuracy: 8 }, { dev }), 200);
  assert.equal(retry.token, first.token);
  const c1 = await callOf(first.token);
  assert.equal(c1.place_text, 'Near Lower Birch, about 10 m');
  assert.equal(Number(c1.place_id), pl.insertId);
  assert.match(c1.location, /^Near Lower Birch, about 10 m/, 'the location line follows the words');
  // A different press from the same phone, somewhere else: its own call, linked; the first call does not move.
  const other = ok(await help(A, { kind: 'help', rid: rid(), gps_lat: 44.31, gps_lng: -71.31, accuracy: 5, location: 'Top of the Glades' }, { dev }), 201);
  assert.notEqual(other.token, first.token);
  const c2 = await callOf(other.token);
  assert.equal(Number(c2.same_phone_of), Number(c0.id));
  const still = await callOf(first.token);
  assert.deepEqual([Number(still.gps_lat), Number(still.gps_lng), still.location, still.place_text], [Number(c1.gps_lat), Number(c1.gps_lng), c1.location, c1.place_text]);
  assert.ok((await notes(c2.id)).some((n) => n.startsWith(`From the same phone as call ${first.reference}`)));
  assert.ok((await notes(c0.id)).some((n) => n.startsWith('The same phone asked again')));
  // Patrol sees the link on the board and in the call.
  const board = ok(await api('GET', '/patrol/dispatch', { token: A.owner })).data;
  assert.equal(board.find((x) => x.id === c2.id).same_phone_no, first.reference);
  const view = ok(await api('GET', `/patrol/dispatch/${c0.id}`, { token: A.owner }));
  assert.deepEqual(view.same_phone_later.map((x) => x.call_no), [other.reference]);
});

test('the Locate caller link: a shared position works out the place words again', async () => {
  const phone = guestPhone();
  await text({ From: phone, To: A.line, Body: 'HELP' });
  const c = await latestSms(A, phone);
  assert.equal(c.location, 'Not given yet (Text HELP)');
  ok(await api('POST', `/public/locate/${c.locate_token}`, { body: { lat: 44.3, lng: -71.3, accuracy: 6 } }));
  const after = (await q('SELECT * FROM dispatch_calls WHERE id = ?', [c.id]))[0];
  assert.equal(after.place_text, 'Near Lower Birch, about 5 m');
  assert.equal(after.location, 'Near Lower Birch, about 5 m');
});

// ---------------------------------------------------------------- 4. a text that fails once is not lost
test('Text HELP: a text whose first try fails is taken on Twilio\'s retry', async () => {
  const D = require('../src/routes/dispatch');
  const real = D.createCall;
  let failed = 0;
  D.createCall = async () => { failed += 1; throw new Error('database blip'); };
  const phone = guestPhone();
  const params = { From: phone, To: A.line, Body: 'HELP fell off the lift', MessageSid: sid() };
  let first;
  try { first = await text(params); } finally { D.createCall = real; }
  assert.equal(failed, 1);
  assert.equal(first.status, 500);
  assert.equal(await latestSms(A, phone), undefined);
  const retry = await text(params); // the same MessageSid
  assert.equal(retry.status, 200);
  assert.match(retry.reply, /ski patrol has your message/);
  const c = await latestSms(A, phone);
  assert.ok(c, 'the retry made the call');
  assert.equal(c.description, 'fell off the lift');
  assert.equal((await text(params)).reply, null, 'a third delivery of the same text is still taken once');
});

// ---------------------------------------------------------------- 6. odd input never ends a request
test('a real request is never refused because of an optional field: odd ones are cut, capped or left out', async () => {
  const odd = ok(await help(A, { kind: 'nonsense', location: 'x', gps_lat: 44.3, gps_lng: -71.3, accuracy: 250000, who: 'alien', code: '!!', lang: 'fr', rid: 'not-hex',
    description: 'd'.repeat(1000), name: { first: 'A' }, phone: 6105550123, website: '' }), 201);
  const c = await callOf(odd.token);
  assert.equal(c.located_accuracy_m, 5000, 'accuracy capped');
  assert.match(c.place_text, /\(location rough\)$/, 'and marked rough');
  assert.equal(c.description.length, 300);
  assert.equal(c.caller_phone, '6105550123');
  assert.equal(c.who, null);
  assert.doesNotMatch(c.location, /^x$/, 'a 1-character place is left out');
  const n = await notes(c.id);
  assert.ok(n.some((x) => x === 'The phone\'s location is rough: it said within 250000 m.'));
  assert.ok(n.some((x) => /left out: location, name, who, sign code\./.test(x)), n.join(' | '));
  // A position out of range is left out; the request goes in.
  const bad = ok(await help(A, { gps_lat: 200, gps_lng: -71.3, accuracy: -5, location: 'By the lodge' }), 201);
  const b = await callOf(bad.token);
  assert.equal(b.gps_lat, null); assert.equal(b.location, 'By the lodge');
  // Not even an object: still a request.
  ok(await help(A, ['help']), 201);
  // The bot trap still works.
  assert.equal((await help(A, { website: 'http://spam.example' })).status, 202);
});

// ---------------------------------------------------------------- 8. reading a position in a text
test('Text HELP positions: signed, not part of a longer number, the page\'s format or the mountain\'s own area', async () => {
  const P = (s, area) => HL.parse(s, area).gps;
  const area = { lat: 44.27, lng: -71.30 };
  assert.deepEqual(P('HELP -33.86,151.21'), { lat: -33.86, lng: 151.21, accuracy: null }, 'the minus sign is kept');
  assert.deepEqual(P('HELP:-33.86,151.21'), { lat: -33.86, lng: 151.21, accuracy: null });
  assert.deepEqual(P('HELP +44.2711,-71.3033 ±9m'), { lat: 44.2711, lng: -71.3033, accuracy: 9 });
  assert.equal(P('HELP 1044.27110,-71.30330'), null, 'part of a longer number');
  assert.equal(P('HELP 44.27110,-71.303301234'), null, 'too many decimals is not a position');
  assert.equal(P('HELP 12.50, 7.25'), null, 'a space after the comma and no accuracy: not a position');
  assert.equal(P('HELP 12.50, 7.25', area), null, 'nor far from the mountain');
  assert.equal(P('HELP 12.50,7.25', area), null, 'nor without a space, when the mountain is far away');
  assert.deepEqual(P('HELP 44.2712, -71.3034', area), { lat: 44.2712, lng: -71.3034, accuracy: null }, 'in the mountain\'s own area');
  assert.deepEqual(P('HELP 12.50, 7.25 ±20m'), { lat: 12.5, lng: 7.25, accuracy: 20 }, 'the page\'s own format');
  assert.equal(P('HELP 95.10,-71.30 ±5m'), null, 'out of range');
  // Through the webhook: a mountain with a map point.
  const p1 = guestPhone();
  await text({ From: p1, To: MAP.line, Body: 'HELP lost my ski 12.50, 7.25' });
  assert.equal((await latestSms(MAP, p1)).gps_lat, null);
  const p2 = guestPhone();
  await text({ From: p2, To: MAP.line, Body: 'HELP 44.2712, -71.3034 knee' });
  const c2 = await latestSms(MAP, p2);
  assert.equal(Number(c2.gps_lat), 44.2712); assert.equal(Number(c2.gps_lng), -71.3034);
  assert.equal(c2.description, 'knee');
  const p3 = guestPhone();
  await text({ From: p3, To: A.line, Body: 'HELP -33.86,151.21' });
  assert.equal(Number((await latestSms(A, p3)).gps_lat), -33.86);
});

// ---------------------------------------------------------------- 9. lost child by text
test('Text HELP: a text that says a child is lost is a Lost child call at High, alerted as one', async () => {
  for (const body of ['HELP lost child', 'lost kid by the lodge', 'AYUDA niño perdido', 'nino perdido', 'perdí a mi hijo cerca del telesilla', 'HELP 44.27120,-71.30340 ±12m lost child']) {
    const phone = guestPhone();
    pushes.length = 0;
    await onDuty(A, async () => {
      await text({ From: phone, To: A.line, Body: body });
      const c = await latestSms(A, phone);
      assert.equal(c.call_type, 'lost_child', body);
      assert.equal(c.priority, 'high', body);
      const p = pushes.find((x) => x.message.tag === `call-${c.id}`);
      assert.ok(p && /^Lost child: patrol call/.test(p.message.title), body);
    });
  }
  assert.equal(HL.parse('my child lost a glove').lostChild, false);
  // A later text in the conversation makes the call a Lost child call.
  const phone = guestPhone();
  await text({ From: phone, To: A.line, Body: 'HELP' });
  const c = await latestSms(A, phone);
  assert.equal(c.call_type, null);
  await text({ From: phone, To: A.line, Body: 'lost kid, 7, red jacket' });
  const after = await latestSms(A, phone);
  assert.equal(after.id, c.id);
  assert.equal(after.call_type, 'lost_child'); assert.equal(after.priority, 'high');
});

// ---------------------------------------------------------------- 10. no one on duty
test('no one on duty: owners and managers are alerted, the patrol phone is texted, and the board shows a red banner', async () => {
  const A = await mountain('nod'); // a mountain of its own: the summary goes once a minute per mountain
  userPushes.length = 0;
  const before = sent.length;
  const r = ok(await help(A, { kind: 'help', rid: rid(), location: 'Bottom of the T-bar' }), 201);
  const c = await callOf(r.token);
  const up = await waitFor(() => userPushes.find((p) => p.message.tag === `call-${c.id}`));
  assert.ok(up, 'owners and managers get the push');
  assert.ok(up.userIds.includes(A.ownerUser));
  assert.match(up.message.title, /^No one on duty\. Guest help: patrol call /);
  const txt = await waitFor(() => sent.slice(before).find((x) => x.To === A.patrolPhone));
  assert.ok(txt, 'the patrol phone is texted');
  assert.match(txt.Body, /Bottom of the T-bar/);
  assert.ok((await waitFor(async () => (await notes(c.id)).find((n) => n.startsWith('No one on duty was alerted.')))));
  const board = ok(await api('GET', '/patrol/dispatch', { token: A.owner })).data;
  assert.equal(board.find((x) => x.id === c.id).nobody_alerted, true);
  assert.equal(ok(await api('GET', `/patrol/dispatch/${c.id}`, { token: A.owner })).nobody_alerted, true);
  // With someone on duty: no fallback.
  await onDuty(A, async () => {
    userPushes.length = 0;
    const r2 = ok(await help(A, { kind: 'help', rid: rid(), location: 'Lodge deck' }), 201);
    const c2 = await callOf(r2.token);
    await waitFor(() => pushes.find((p) => p.message.tag === `call-${c2.id}`));
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(userPushes.length, 0);
    assert.ok(!(await notes(c2.id)).some((n) => n.startsWith('No one on duty')));
    assert.equal(ok(await api('GET', '/patrol/dispatch', { token: A.owner })).data.find((x) => x.id === c2.id).nobody_alerted, false);
  });
  // The board draws the banner.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'patrol-dispatch.js'), 'utf8');
  assert.match(js, /c\.nobody_alerted && c\.status === 'new' \? nobodyBanner\(\)/);
});

// ---------------------------------------------------------------- minor fixes
test('STOP never blocks a request for help; replies wait for START (HELP does not undo STOP), and the call says so', async () => {
  const phone = guestPhone();
  await text({ From: phone, To: A.line, Body: 'HELP' });
  const c = await latestSms(A, phone);
  await text({ From: phone, To: A.line, Body: 'STOP', OptOutType: 'STOP' });
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  const r = await text({ From: phone, To: A.line, Body: 'my wife fell, chair 4' });
  const c2 = await latestSms(A, phone);
  assert.notEqual(c2.id, c.id, 'still a new request');
  assert.equal(r.reply, null, 'no reply while opted out');
  const STOPPED = 'This phone texted STOP; replies can\'t be sent until it texts START. Call them instead.';
  assert.ok((await notes(c2.id)).includes(`Text not sent: ${STOPPED}`), 'the call says so');
  const again = await text({ From: phone, To: A.line, Body: 'HELP please answer' });
  assert.equal(again.reply, null);
  assert.equal((await latestSms(A, phone)).id, c2.id, 'the request reaches dispatch, on its call');
  assert.ok((await q('SELECT body FROM dispatch_messages WHERE call_id = ?', [c2.id])).some((m) => m.body === 'HELP please answer'));
  assert.equal((await q('SELECT COUNT(*) AS n FROM dispatch_sms_optouts WHERE tenant_id = ? AND phone_key = ?', [A.id, phone.slice(2)]))[0].n, 1, 'HELP does not undo STOP: Twilio still blocks the phone');
  const blocked = ok(await api('POST', `/patrol/dispatch/${c2.id}/messages`, { token: A.owner, body: { body: 'We see you.' } }), 201);
  assert.equal(blocked.texted, false);
  assert.equal(blocked.error, STOPPED);
  const view = ok(await api('GET', `/patrol/dispatch/${c2.id}`, { token: A.owner }));
  assert.equal(view.guest.opted_out, true); assert.equal(view.guest.can_text, false);
  // A help word sent as an opt-in keyword (Twilio's OptOutType START, RUNBOOK step 3) clears it and is still a request.
  ok(await api('POST', `/patrol/dispatch/${c2.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  const r3 = await text({ From: phone, To: A.line, Body: 'AYUDA', OptOutType: 'START' });
  const c3 = await latestSms(A, phone);
  assert.notEqual(c3.id, c2.id, 'a new request');
  assert.match(r3.reply, /patrulla/);
  const out = ok(await api('POST', `/patrol/dispatch/${c3.id}/messages`, { token: A.owner, body: { body: 'We see you.' } }), 201);
  assert.equal(out.texted, true);
});

test('patrol\'s texts to a phone typed on the help page stop at 20 a call; the guest may change the phone 3 times', async () => {
  const r = ok(await help(A, { kind: 'help', rid: rid(), location: 'Lift line', phone: '610-555-0177' }), 201);
  const c = await callOf(r.token);
  const before = sent.length;
  let last;
  for (let i = 0; i < 21; i++) last = ok(await api('POST', `/patrol/dispatch/${c.id}/messages`, { token: A.owner, body: { body: `Message ${i}` } }), 201);
  assert.equal(sent.slice(before).filter((x) => x.To === '+16105550177').length, 20);
  assert.equal(last.texted, false);
  assert.match(last.error, /20 texts/);
  assert.equal((await q("SELECT COUNT(*) AS n FROM dispatch_messages WHERE call_id = ? AND direction = 'to_guest'", [c.id]))[0].n, 21, 'still on the guest\'s page');
  // Phone changes: three, then the number stays.
  for (const p of ['610-555-0101', '610-555-0102', '610-555-0103']) ok(await api('PATCH', `/public/${A.slug}/help/${r.token}`, { body: { phone: p } }));
  const kept = ok(await api('PATCH', `/public/${A.slug}/help/${r.token}`, { body: { phone: '610-555-0104', what: 'knee' } }));
  assert.equal(kept.phone, 'kept');
  const after = await callOf(r.token);
  assert.equal(after.caller_phone, '610-555-0103');
  assert.equal(after.description, 'knee', 'the other answers are still saved');
});

test('the guest page: focus rings have 3:1 on white, and Call 911 and the language switch are 56 px', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'help.html'), 'utf8');
  assert.doesNotMatch(html, /outline:[^;]*var\(--gold\)/, 'no gold ring on the light page');
  assert.match(html, /:root \{ --focus: #1e2d3a;/);
  assert.match(html, /\.b911 \{[^}]*min-height: 56px/);
  assert.match(html, /\.blang \{[^}]*min-height: 56px/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const focus = css.match(/^\s*--focus: (#[0-9a-f]{6});/m)[1];
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  assert.ok(ratio(focus, '#ffffff') >= 3.5, `app.css focus ring ${focus} on white: ${ratio(focus, '#ffffff').toFixed(2)}`);
  assert.ok(ratio('#1e2d3a', '#ffffff') >= 3 && ratio('#1e2d3a', '#f4f6f7') >= 3);
});

test('the guest page: a failed first load offers Try again, Send by text (from the cached number) and Call 911; a refused send retries with nothing optional', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'help.js'), 'utf8');
  assert.match(js, /if \(!saved\) \{ offline\(\); return; \}/);
  assert.match(js, /cachePage\(S\.page\)/);
  assert.match(js, /if \(!minimal\) \{ minimal = true; body = \{ kind, rid \}; continue; \}/);
  assert.doesNotMatch(js, /show\(h\('h1', null, t\('noOnline'\)\)\); return; \}\s*\n\s*await/, 'never a dead end on a refused send');
});
