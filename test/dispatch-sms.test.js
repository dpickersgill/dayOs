'use strict';

// Text HELP (help/sms): a guest texts the mountain's help number and reaches patrol. A fake Twilio takes the texts we
// send and serves the photos; the webhook is called the way Twilio calls it (form-encoded, signed with the auth token
// over PUBLIC_URL plus the path, as Twilio sees the address behind the load balancer).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.PUBLIC_URL = 'https://app.verdynt.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { signature, PATH } = require('../src/routes/helpsms');
const HL = require('../src/lib/helpline');

let server; let base; let tw;
const sent = []; // texts our server asked Twilio to send
const mediaAuth = [];
const pushes = [];
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const REC = require('./helpers/records').records(() => base, () => PW);
const num = (n) => `+1610555${String(n).padStart(4, '0')}`;
const LINE_A = `+1484${String(Date.now()).slice(-7)}`;
const LINE_B = `+1267${String(Date.now()).slice(-7)}`;
let A; let B;
let phoneN = 1000 + Math.floor(Math.random() * 8000);
const guestPhone = () => num(phoneN++);
let sidN = 0;
const sid = (p = 'SM') => `${p}${suffix}${String(++sidN).padStart(6, '0')}`.padEnd(34, '0').slice(0, 34);

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${String(r.text).slice(0, 300)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];

/** Posts a text to the webhook as Twilio would. signUrl: the address the signature is made over (default: PUBLIC_URL + path). */
async function text(fields, { signUrl = `${process.env.PUBLIC_URL}${PATH}`, token = 'tw-token', sign = true } = {}) {
  const params = { AccountSid: 'ACtest', MessageSid: sid(), NumMedia: '0', ...fields };
  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = signature(token, signUrl, params);
  const res = await fetch(`${base}${PATH}`, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  const body = await res.text();
  const m = body.match(/<Message>([\s\S]*)<\/Message>/);
  return { status: res.status, body, reply: m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : null, params };
}
const latestCall = async (tenantId, phone) => (await q("SELECT * FROM dispatch_calls WHERE tenant_id = ? AND caller_phone = ? AND source = 'sms' ORDER BY id DESC LIMIT 1", [tenantId, phone]))[0];
const callsOf = async (tenantId, phone) => q("SELECT * FROM dispatch_calls WHERE tenant_id = ? AND caller_phone = ? AND source = 'sms' ORDER BY id", [tenantId, phone]);
const textsTo = (phone) => sent.filter((s) => s.To === phone);
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); } };

/** The guest's messages on a call: help/guest's dispatch_messages once merged, the stand-in's memory before. */
async function guestMessages(callId) {
  const t = await q("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'dispatch_messages'");
  if (t.length) return q('SELECT direction, channel, body FROM dispatch_messages WHERE call_id = ? ORDER BY id', [callId]);
  return require('../src/lib/guestmsg')._log.filter((m) => m.call_id === Number(callId));
}
/** A sign with a code: in help/places' mountain_places once merged, in the stand-in's memory before. */
async function addPlace(tenantId, p) {
  const t = await q("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'mountain_places'");
  if (t.length) {
    const [r] = await pool.query("INSERT INTO mountain_places (tenant_id, kind, name, code, lat, lng, accuracy_m, marked_by, marked_at, active) VALUES (?, 'sign', ?, ?, ?, ?, 5, 1, UTC_TIMESTAMP(), 1)", [tenantId, p.name, p.code, p.lat, p.lng]);
    return { id: r.insertId, ...p };
  }
  return require('../src/lib/places')._add(tenantId, p);
}

async function mountain(tag) {
  const slug = `hsms${tag}-${suffix}`.slice(0, 40);
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${tag.toUpperCase()}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const owner = await REC((await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token);
  const id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  return { slug, owner, id, name: `Mount ${tag.toUpperCase()}` };
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  tw = await new Promise((r) => {
    const s = http.createServer((req, res) => {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => {
        if (req.method === 'GET' && /\/Media\/ME/.test(req.url)) { mediaAuth.push(req.headers.authorization || ''); res.setHeader('content-type', 'image/png'); return res.end(PNG); }
        sent.push({ url: req.url, ...Object.fromEntries(new URLSearchParams(d)) });
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` }));
      });
    });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  require('../src/lib/push').notifyStaff = async (tenantId, staffIds, message) => { pushes.push({ tenantId, staffIds, message }); return staffIds.length; };
  A = await mountain('a'); B = await mountain('b');
  ok(await api('PUT', '/patrol/text-help', { token: A.owner, body: { help_number: LINE_A, patrol_phone: '(610) 555-0100' } }));
  ok(await api('PUT', '/patrol/text-help', { token: B.owner, body: { help_number: LINE_B } }));
});
test.after(async () => { await new Promise((r) => server.close(r)); tw.close(); await pool.end(); });

// ---------------------------------------------------------------- settings
test('settings: the help number is E.164, unique across mountains, and can be cleared', async () => {
  const s = ok(await api('GET', '/patrol/text-help', { token: A.owner }));
  assert.equal(s.help_number, LINE_A);
  assert.equal(s.patrol_phone, '+16105550100');
  assert.equal(s.webhook_url, `https://app.verdynt.test${PATH}`);
  assert.equal((await api('PUT', '/patrol/text-help', { token: A.owner, body: { help_number: '12345' } })).status, 400);
  const taken = await api('PUT', '/patrol/text-help', { token: B.owner, body: { help_number: LINE_A } });
  assert.equal(taken.status, 409, 'another mountain\'s number');
  assert.equal((await q('SELECT help_number FROM patrol_help_lines WHERE tenant_id = ?', [B.id]))[0].help_number, LINE_B, 'B keeps its own');
  // A US number written any common way is stored as E.164.
  const local = `(267) ${LINE_B.slice(5, 8)}-${LINE_B.slice(8)}`;
  assert.equal(ok(await api('PUT', '/patrol/text-help', { token: B.owner, body: { help_number: local } })).help_number, LINE_B);
  const C = await mountain('c');
  const spare = `+1215${String(Date.now()).slice(-7)}`;
  ok(await api('PUT', '/patrol/text-help', { token: C.owner, body: { help_number: spare } }));
  ok(await api('PUT', '/patrol/text-help', { token: C.owner, body: { help_number: null } }));
  assert.equal((await q('SELECT COUNT(*) AS n FROM patrol_help_lines WHERE tenant_id = ?', [C.id]))[0].n, 0);
});

// ---------------------------------------------------------------- the webhook
test('signature: Twilio\'s documented example, a valid post, a bad one and an unsigned one', async () => {
  // https://www.twilio.com/docs/usage/security: token 12345, this address and these fields give this signature.
  assert.equal(signature('12345', 'https://example.com/myapp.php?foo=1&bar=2', { Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' }), 'L/OH5YylLD5NRKLltdqwSvS0BnU=');
  const phone = guestPhone();
  const good = await text({ From: phone, To: LINE_A, Body: 'HELP' });
  assert.equal(good.status, 200);
  assert.match(good.body, /^<\?xml/);
  const before = (await callsOf(A.id, phone)).length;
  assert.equal((await text({ From: phone, To: LINE_A, Body: 'HELP again' }, { token: 'wrong-token' })).status, 403, 'wrong token');
  assert.equal((await text({ From: phone, To: LINE_A, Body: 'HELP again' }, { sign: false })).status, 403, 'unsigned');
  // Behind the proxy the request arrives at our own host, but Twilio signed the public address: the Host header is not trusted.
  assert.equal((await text({ From: phone, To: LINE_A, Body: 'HELP again' }, { signUrl: `${base}${PATH}` })).status, 403, 'signed over the internal address');
  // A field changed after signing.
  const p = { AccountSid: 'ACtest', MessageSid: sid(), From: phone, To: LINE_A, Body: 'HELP' };
  const sig = signature('tw-token', `${process.env.PUBLIC_URL}${PATH}`, p);
  const res = await fetch(`${base}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams({ ...p, Body: 'HELP tampered' }).toString() });
  assert.equal(res.status, 403);
  assert.equal((await callsOf(A.id, phone)).length, before, 'nothing refused made a call');
});

test('routing: a text goes to the mountain whose help number it was sent to; an unknown number gets 200 and is dropped', async () => {
  const phone = guestPhone();
  ok(await text({ From: phone, To: LINE_A, Body: 'HELP at A' }));
  ok(await text({ From: phone, To: LINE_B, Body: 'HELP at B' }));
  const a = await latestCall(A.id, phone); const b = await latestCall(B.id, phone);
  assert.ok(a && b && a.id !== b.id, 'one call at each mountain');
  assert.match(a.description, /at A/); assert.match(b.description, /at B/);
  const before = (await q('SELECT COUNT(*) AS n FROM dispatch_calls WHERE caller_phone = ?', [phone]))[0].n;
  const unknown = await text({ From: phone, To: '+19995550123', Body: 'HELP' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.reply, null);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dispatch_calls WHERE caller_phone = ?', [phone]))[0].n, before);
});

test('the first text makes a call, source sms, with the Locate caller link in the reply', async () => {
  const phone = guestPhone();
  const r = await text({ From: phone, To: LINE_A, Body: 'HELP my friend fell and cannot get up' });
  const c = await latestCall(A.id, phone);
  assert.ok(c);
  assert.equal(c.source, 'sms'); assert.equal(c.status, 'new'); assert.equal(c.caller_phone, phone);
  assert.equal(c.description, 'my friend fell and cannot get up');
  assert.equal(c.location, 'Not given yet (Text HELP)');
  assert.match(c.locate_token, /^[0-9a-f]{32}$/);
  assert.equal(r.reply, `${A.name} ski patrol has your message. If it is life threatening, call 911. Tap this link to send your location: https://app.verdynt.test/locate/${c.locate_token}. Or reply with the code on the nearest sign or lift tower. To talk to patrol, call +16105550100.`);
  // The link is the existing Locate caller page, and it works.
  const loc = ok(await api('GET', `/public/locate/${c.locate_token}`));
  assert.equal(loc.mountain, A.name);
  ok(await api('POST', `/public/locate/${c.locate_token}`, { body: { lat: 44.27, lng: -71.3, accuracy: 9 } }));
  assert.equal((await latestCall(A.id, phone)).located_accuracy_m, 9);
  const m = await guestMessages(c.id);
  assert.equal(m.length, 1); assert.equal(m[0].direction, 'from_guest'); assert.equal(m[0].channel, 'sms'); assert.match(m[0].body, /my friend fell/);
  // The timeline says where it came from and what the guest was told.
  const ev = await q('SELECT kind, note FROM dispatch_events WHERE tenant_id = ? AND call_id = ? ORDER BY id', [A.id, c.id]);
  assert.equal(ev[0].kind, 'received'); assert.equal(ev[0].note, `Text HELP from ${phone}`);
  assert.ok(ev.some((e) => /Texted back/.test(e.note || '')));
  // A photo-only or one-word text is taken too; PATROL works like HELP.
  const p2 = guestPhone();
  const r2 = await text({ From: p2, To: LINE_A, Body: 'patrol' });
  assert.match(r2.reply, /ski patrol has your message/);
  assert.equal((await latestCall(A.id, p2)).description, null);
});

test('a sign code resolves through places.byCode, and the rest is the description', async () => {
  const place = await addPlace(A.id, { name: 'Ridge Run, below Summit Quad tower 7', code: 'R7', lat: 44.2711, lng: -71.3033 });
  const phone = guestPhone();
  await text({ From: phone, To: LINE_A, Body: 'HELP R7 my knee is hurt' });
  const c = await latestCall(A.id, phone);
  assert.equal(c.location, 'Ridge Run, below Summit Quad tower 7 (sign R7)');
  assert.equal(c.description, 'my knee is hurt');
  if ('place_id' in c) { assert.equal(Number(c.place_id), Number(place.id)); assert.equal(c.place_text, c.location); }
  // An unknown code leaves the text as it was.
  const p2 = guestPhone();
  await text({ From: p2, To: LINE_A, Body: 'HELP Z9 near the lodge' });
  const c2 = await latestCall(A.id, p2);
  assert.equal(c2.location, 'Not given yet (Text HELP)'); assert.equal(c2.description, 'Z9 near the lodge');
  // A code in a later text updates the place.
  await addPlace(A.id, { name: 'Lodge deck', code: 'L2', lat: 44.28, lng: -71.31 });
  await text({ From: p2, To: LINE_A, Body: 'L2' });
  const again = await latestCall(A.id, p2);
  assert.equal(again.id, c2.id);
  assert.equal(again.location, 'Lodge deck (sign L2)');
  // Codes are per mountain: B has no R7.
  const p3 = guestPhone();
  await text({ From: p3, To: LINE_B, Body: 'HELP R7' });
  assert.equal((await latestCall(B.id, p3)).location, 'Not given yet (Text HELP)');
});

test('lat,lng: the help page\'s text fallback body and other forms are read', async () => {
  const P = HL.parse;
  assert.deepEqual(P('HELP 44.27110,-71.30330 ±12m').gps, { lat: 44.2711, lng: -71.3033, accuracy: 12 });
  assert.deepEqual(P('HELP R7 44.27110, -71.30330 ±8 m knee').gps, { lat: 44.2711, lng: -71.3033, accuracy: 8 });
  assert.deepEqual(P('44.2711,-71.3033').gps, { lat: 44.2711, lng: -71.3033, accuracy: null });
  assert.deepEqual(P('AYUDA 44.2711,-71.3033 +/-30m').gps, { lat: 44.2711, lng: -71.3033, accuracy: 30 });
  assert.equal(P('HELP 99.1234,-71.3033 ±5m').gps, null, 'out of range');
  assert.equal(P('HELP call 610-555-0100').gps, null, 'a phone number is not a position');
  assert.equal(P('HELP R7 44.2711,-71.3033 ±8m my knee').rest, 'R7 my knee');
  const phone = guestPhone();
  await text({ From: phone, To: LINE_A, Body: 'HELP 44.27120,-71.30340 ±12m' });
  const c = await latestCall(A.id, phone);
  assert.equal(Number(c.gps_lat), 44.2712); assert.equal(Number(c.gps_lng), -71.3034); assert.equal(c.located_accuracy_m, 12);
  assert.ok(c.located_at);
  const d = await require('../src/lib/places').describe(pool, A.id, 44.2712, -71.3034, 12);
  assert.equal(c.location, d && d.text ? d.text : 'Phone position 44.27120, -71.30340', 'the place in words when one is mapped near');
  assert.equal(c.description, null);
});

test('follow-ups join the open call as guest messages and the responders get a phone alert', async () => {
  const phone = guestPhone();
  await text({ From: phone, To: LINE_A, Body: 'HELP stuck on the lift' });
  const c = await latestCall(A.id, phone);
  const staff = ok(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Pat', last_name: 'Responder' }, status: 'active' } }), 201).id;
  ok(await api('POST', `/patrol/dispatch/${c.id}/responders`, { token: A.owner, body: { staff_id: staff } }), 201);
  pushes.length = 0;
  const r = await text({ From: phone, To: LINE_A, Body: 'chair 14, it stopped' });
  assert.equal(r.reply, null, 'no automatic reply to a follow-up');
  assert.equal((await callsOf(A.id, phone)).length, 1, 'joined, not a new call');
  const m = await guestMessages(c.id);
  assert.deepEqual(m.map((x) => x.body), ['HELP stuck on the lift', 'chair 14, it stopped']);
  const alert = pushes.find((p) => p.message.tag === `call-${c.id}-sms`);
  assert.ok(alert, 'a phone alert');
  assert.deepEqual(alert.staffIds.map(Number), [Number(staff)]);
  assert.doesNotMatch(`${alert.message.title} ${alert.message.body}`, /chair 14/, 'never the guest\'s words on a locked screen');
  // A second text within the minute does not alert again.
  pushes.length = 0;
  await text({ From: phone, To: LINE_A, Body: 'cold' });
  assert.equal(pushes.filter((p) => p.message.tag === `call-${c.id}-sms`).length, 0);
  // Dispatch's reply (the Messages panel calls guestmsg.toGuest) goes out by text from the help number.
  const call = (await q('SELECT * FROM dispatch_calls WHERE id = ?', [c.id]))[0];
  await require('../src/lib/guestmsg').toGuest(pool, call, 'Patrol is on the way. Stay on the chair.', { userId: 1 });
  const out = textsTo(phone).pop();
  assert.equal(out.Body, 'Patrol is on the way. Stay on the chair.');
  assert.equal(out.From, LINE_A, 'from the help number, so it stays in the same conversation');
  assert.equal(out.MessagingServiceSid, undefined);
  // A text Twilio delivers twice (a fallback retry) is taken once.
  const p = { From: phone, To: LINE_A, Body: 'twice', MessageSid: sid() };
  await text(p); await text(p);
  assert.equal((await guestMessages(c.id)).filter((x) => x.body === 'twice').length, 1);
});

test('the 2-hour window: a text after 2 quiet hours starts a new call; within it joins', async () => {
  const phone = guestPhone();
  await text({ From: phone, To: LINE_A, Body: 'HELP first' });
  const c1 = await latestCall(A.id, phone);
  await q('UPDATE dispatch_sms_threads SET last_at = UTC_TIMESTAMP() - INTERVAL 119 MINUTE WHERE call_id = ?', [c1.id]);
  await text({ From: phone, To: LINE_A, Body: 'still here' });
  assert.equal((await latestCall(A.id, phone)).id, c1.id, 'joined within 2 hours');
  await q('UPDATE dispatch_sms_threads SET last_at = UTC_TIMESTAMP() - INTERVAL 121 MINUTE WHERE call_id = ?', [c1.id]);
  const r = await text({ From: phone, To: LINE_A, Body: 'HELP again, different place' });
  const c2 = await latestCall(A.id, phone);
  assert.notEqual(c2.id, c1.id, 'a new call');
  assert.match(r.reply, /ski patrol has your message/);
  // A closed call is not joined either.
  ok(await api('POST', `/patrol/dispatch/${c2.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  await text({ From: phone, To: LINE_A, Body: 'HELP' });
  assert.notEqual((await latestCall(A.id, phone)).id, c2.id);
});

test('repeats from one phone are grouped on the board like guest requests (never refused)', async () => {
  const phone = guestPhone();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    await text({ From: phone, To: LINE_A, Body: `HELP number ${i}` });
    const c = await latestCall(A.id, phone);
    ids.push(c.id);
    ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'cancelled' } }), 201);
  }
  assert.equal(new Set(ids).size, 3, 'each one taken');
  const rows = await q('SELECT id, flood_of FROM dispatch_calls WHERE id IN (?) ORDER BY id', [ids]);
  assert.equal(rows[0].flood_of, null);
  assert.equal(Number(rows[2].flood_of), ids[0], 'the third joins the first one\'s group');
});

test('STOP is recorded and nothing more is texted from the help line; START turns it back on; YES is a plain reply', async () => {
  const phone = guestPhone();
  await text({ From: phone, To: LINE_A, Body: 'HELP' });
  const c = await latestCall(A.id, phone);
  await text({ From: phone, To: LINE_A, Body: 'STOP', OptOutType: 'STOP' });
  assert.equal((await q('SELECT COUNT(*) AS n FROM dispatch_sms_optouts WHERE tenant_id = ? AND phone_key = ?', [A.id, phone.slice(2)]))[0].n, 1);
  const call = (await q('SELECT * FROM dispatch_calls WHERE id = ?', [c.id]))[0];
  const before = textsTo(phone).length;
  await require('../src/lib/guestmsg').toGuest(pool, call, 'Are you still there?', { userId: 1 });
  assert.equal(textsTo(phone).length, before, 'not texted after STOP');
  const ev = await q('SELECT note FROM dispatch_events WHERE call_id = ? ORDER BY id', [c.id]);
  assert.ok(ev.some((e) => /texted STOP/.test(e.note || '')), 'dispatch is told to call instead');
  // A request for help from that phone is still taken (with no reply, which Twilio would refuse).
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  const r = await text({ From: phone, To: LINE_A, Body: 'HELP please' });
  assert.equal(r.reply, null);
  const c2 = await latestCall(A.id, phone);
  assert.notEqual(c2.id, c.id);
  // START (exact word, no Advanced Opt-Out field) re-enables texts.
  await text({ From: phone, To: LINE_A, Body: 'start' });
  assert.equal((await q('SELECT COUNT(*) AS n FROM dispatch_sms_optouts WHERE tenant_id = ? AND phone_key = ?', [A.id, phone.slice(2)]))[0].n, 0);
  const call2 = (await q('SELECT * FROM dispatch_calls WHERE id = ?', [c2.id]))[0];
  await require('../src/lib/guestmsg').toGuest(pool, call2, 'Patrol is coming.', { userId: 1 });
  assert.equal(textsTo(phone).pop().Body, 'Patrol is coming.');
  // "Yes" from a phone that never opted out is an answer to patrol, not an opt-in.
  await text({ From: phone, To: LINE_A, Body: 'Yes' });
  assert.ok((await guestMessages(c2.id)).some((m) => m.body === 'Yes'));
  // STOP at A does not stop B's help line.
  await text({ From: phone, To: LINE_A, Body: 'STOP', OptOutType: 'STOP' });
  assert.equal((await q('SELECT COUNT(*) AS n FROM dispatch_sms_optouts WHERE tenant_id = ? AND phone_key = ?', [B.id, phone.slice(2)]))[0].n, 0);
});

test('HELP sent by Advanced Opt-Out (OptOutType HELP) still makes the call and our reply goes out', async () => {
  const phone = guestPhone();
  const r = await text({ From: phone, To: LINE_A, Body: 'HELP', OptOutType: 'HELP' });
  assert.match(r.reply, /ski patrol has your message/);
  assert.ok(await latestCall(A.id, phone));
});

test('AYUDA, or a text in Spanish, gets the reply and the closing text in Spanish', async () => {
  const phone = guestPhone();
  const r = await text({ From: phone, To: LINE_A, Body: 'AYUDA me caí en la pista' });
  assert.match(r.reply, new RegExp(`^La patrulla de esquí de ${A.name} recibió su mensaje\\. Si su vida corre peligro, llame al 911\\.`));
  assert.match(r.reply, /Para hablar con la patrulla, llame al \+16105550100\.$/);
  const c = await latestCall(A.id, phone);
  assert.equal(c.description, 'me caí en la pista');
  const p2 = guestPhone();
  const r2 = await text({ From: p2, To: LINE_A, Body: 'HELP estoy herido, no puedo mover la pierna' });
  assert.match(r2.reply, /^La patrulla de esquí/);
  const p3 = guestPhone();
  assert.match((await text({ From: p3, To: LINE_A, Body: 'HELP I hurt my leg on the main run' })).reply, /^Mount A ski patrol/);
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  const closing = await waitFor(() => textsTo(phone).find((t) => /cerró/.test(t.Body)));
  assert.equal(closing.Body, 'La patrulla cerró su solicitud. Responda AYUDA si necesita a la patrulla otra vez.');
});

test('the closing text goes once, from the help number', async () => {
  const phone = guestPhone();
  await text({ From: phone, To: LINE_A, Body: 'HELP' });
  const c = await latestCall(A.id, phone);
  ok(await api('POST', `/patrol/dispatch/${c.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  const closing = await waitFor(() => textsTo(phone).find((t) => /closed your request/.test(t.Body)));
  assert.equal(closing.Body, 'Patrol has closed your request. Reply HELP if you need patrol again.');
  assert.equal(closing.From, LINE_A);
  assert.equal((await HL.closed(A.id, c.id)).sent, false, 'not twice');
  assert.equal(textsTo(phone).filter((t) => /closed your request/.test(t.Body)).length, 1);
  // A call that did not come by text gets no closing text.
  const radio = ok(await api('POST', '/patrol/dispatch', { token: A.owner, body: { location: 'Base', caller_phone: guestPhone(), source: 'phone' } }), 201);
  const n = sent.length;
  ok(await api('POST', `/patrol/dispatch/${radio.id}/events`, { token: A.owner, body: { kind: 'closed' } }), 201);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, n);
});

test('outbound caps: 20 texts per call, and the hourly limit per mountain', async () => {
  const phone = guestPhone();
  await text({ From: phone, To: LINE_A, Body: 'HELP' }); // the reply is text 1
  const call = await latestCall(A.id, phone);
  const before = textsTo(phone).length;
  for (let i = 0; i < 24; i++) await require('../src/lib/guestmsg').toGuest(pool, call, `Update ${i}`, { userId: 1 });
  assert.equal(textsTo(phone).length - before, 19, '19 more after the reply: 20 in all');
  const ev = await q('SELECT note FROM dispatch_events WHERE call_id = ? AND note LIKE ?', [call.id, 'Text not sent%']);
  assert.equal(ev.length, 1, 'noted once on the timeline');
  // Hourly: the mountain's count of texts out in the last hour.
  const [{ n }] = await q("SELECT COUNT(*) AS n FROM dispatch_sms_log WHERE tenant_id = ? AND direction = 'out' AND at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR", [B.id]);
  process.env.HELP_SMS_HOURLY_CAP = String(Number(n) + 1);
  try {
    const p1 = guestPhone(); const p2 = guestPhone();
    assert.match((await text({ From: p1, To: LINE_B, Body: 'HELP' })).reply || '', /ski patrol has your message/, 'the last one inside the limit');
    const r2 = await text({ From: p2, To: LINE_B, Body: 'HELP' });
    assert.equal(r2.reply, null, 'past the limit: no reply');
    assert.ok(await latestCall(B.id, p2), 'but the request is taken');
  } finally { delete process.env.HELP_SMS_HOURLY_CAP; }
});

test('MMS: a photo is recorded with its Twilio address; patrol opens it signed in; nothing is stored', async () => {
  const phone = guestPhone();
  const media = `${process.env.TWILIO_API_BASE}/2010-04-01/Accounts/ACtest/Messages/MM${suffix}abc/Media/ME${suffix}def`;
  await text({ From: phone, To: LINE_A, Body: '', NumMedia: '1', MediaUrl0: media, MediaContentType0: 'image/jpeg' });
  const c = await latestCall(A.id, phone);
  assert.ok(c, 'a photo alone is taken');
  assert.equal(c.description, 'Sent a photo');
  const th = (await q('SELECT photos FROM dispatch_sms_threads WHERE call_id = ?', [c.id]))[0];
  assert.equal(JSON.parse(th.photos)[0].url, media);
  // A second photo whose address is not Twilio's is noted but never fetched.
  await text({ From: phone, To: LINE_A, Body: 'here', NumMedia: '1', MediaUrl0: 'https://evil.example/x.jpg', MediaContentType0: 'image/jpeg' });
  const v = ok(await api('GET', `/patrol/dispatch/${c.id}/sms`, { token: A.owner }));
  assert.equal(v.by_text, true); assert.equal(v.phone, phone); assert.equal(v.lang, 'en');
  assert.deepEqual(v.photos.map((p) => p.available), [true, false]);
  assert.equal(JSON.stringify(v).includes('evil.example') || JSON.stringify(v).includes('/Media/'), false, 'the addresses stay on the server');
  const res = await fetch(`${base}/api/v1/patrol/dispatch/${c.id}/sms-photo/0`, { headers: { authorization: `Bearer ${A.owner}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal(mediaAuth.pop(), `Basic ${Buffer.from('ACtest:tw-token').toString('base64')}`, 'fetched with the account\'s credentials');
  assert.equal((await fetch(`${base}/api/v1/patrol/dispatch/${c.id}/sms-photo/1`, { headers: { authorization: `Bearer ${A.owner}` } })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/patrol/dispatch/${c.id}/sms-photo/0`)).status, 401, 'signed in only');
  const ev = await q('SELECT note FROM dispatch_events WHERE call_id = ? ORDER BY id', [c.id]);
  assert.ok(ev.filter((e) => /sent a photo/.test(e.note || '')).length === 2);
});

test('tenant isolation: B cannot see A\'s text conversations or photos, and a phone\'s calls stay at each mountain', async () => {
  const phone = guestPhone();
  const media = `${process.env.TWILIO_API_BASE}/2010-04-01/Accounts/ACtest/Messages/MM${suffix}iso/Media/ME${suffix}iso`;
  await text({ From: phone, To: LINE_A, Body: 'HELP secret words at A', NumMedia: '1', MediaUrl0: media, MediaContentType0: 'image/png' });
  const c = await latestCall(A.id, phone);
  for (const p of [`/patrol/dispatch/${c.id}/sms`, `/patrol/dispatch/${c.id}/sms-photo/0`]) {
    const r = await api('GET', p, { token: B.owner });
    assert.equal(r.status, 404, `${p}: ${r.status}`);
    assert.doesNotMatch(r.text, /secret words|\+1610/);
  }
  assert.equal(ok(await api('GET', '/patrol/text-help', { token: B.owner })).help_number, LINE_B, 'B sees only its own number');
  // The same phone texting B starts B's own call, never joining A's.
  await text({ From: phone, To: LINE_B, Body: 'HELP at B' });
  const b = await latestCall(B.id, phone);
  assert.ok(b && b.id !== c.id);
  assert.equal((await q('SELECT COUNT(*) AS n FROM dispatch_sms_threads WHERE call_id = ? AND tenant_id = ?', [c.id, B.id]))[0].n, 0);
  // A's dispatch reply never goes from B's number, and B's never from A's.
  const callB = (await q('SELECT * FROM dispatch_calls WHERE id = ?', [b.id]))[0];
  await require('../src/lib/guestmsg').toGuest(pool, callB, 'From B', { userId: 1 });
  assert.equal(textsTo(phone).pop().From, LINE_B);
});

test('the inbound route is listed as PUBLIC in the isolation sweep, and the new tables are patrol tables kept out of AI', () => {
  const iso = fs.readFileSync(path.join(__dirname, 'tenant-isolation.test.js'), 'utf8');
  assert.match(iso, /const PUBLIC = \{[\s\S]*'helpsms\.js': \{ publicRouter: '\/public' \}[\s\S]*\};\n\/\/ Whole files/);
  assert.match(iso, /const SIGNED = \{[\s\S]*'helpsms\.js': \{ router: '\/patrol' \}/);
  const line = fs.readFileSync(path.join(__dirname, 'ai-patrol-line.test.js'), 'utf8');
  for (const t of ['patrol_help_lines', 'dispatch_sms_threads', 'dispatch_sms_optouts', 'dispatch_sms_log']) assert.match(line, new RegExp(t));
});
