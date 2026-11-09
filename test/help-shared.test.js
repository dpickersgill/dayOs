'use strict';

// The shared Text HELP number (help/shared): every mountain uses one shared Verdynt/OS number by default, and any
// mountain can switch to its own. A guest who texts the shared number must always reach a patrol, and never the wrong
// mountain's. Every text goes through the real webhook, signed the way Twilio signs it, with a fake Twilio taking the
// texts we send. The 3-minute and 2-hour texts are sent by the job (POST /internal/jobs/help-texts), never by timers.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.PLATFORM_RATE_LIMIT = '100000';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.PUBLIC_URL = 'https://app.verdynt.test';
process.env.JOBS_KEY = 'jobs-key-for-tests-0123456789';
process.env.HELP_PENDING_HOURLY_CAP = '100000'; // earlier runs' replies are in the same hour; the budget test sets its own
const SHARED = `+1888${String(Date.now()).slice(-7)}`;
process.env.SHARED_HELP_NUMBER = SHARED; // this process only, so test files running beside this one never see it

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { signature, PATH } = require('../src/routes/helpsms');
const HL = require('../src/lib/helpline');
const SH = require('../src/lib/sharedhelp');

let server; let base; let tw;
const sent = [];
const failTo = new Set(); // phones the fake Twilio refuses (a send that fails)
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const REC = require('./helpers/records').records(() => base, () => PW);
// Words only this run uses, so names typed by a "guest" match this run's mountains and no other.
const WORD = `Q${Date.now().toString(36).replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)])}`.slice(0, 8);
const LAT0 = 52 + Math.random() * 10; const LNG0 = -135 + Math.random() * 20; // somewhere no other test puts a mountain
let phoneN = (Date.now() % 1000000) * 10;
const guestPhone = () => `+1555${String(phoneN++).padStart(7, '0').slice(-7)}`;
let sidN = 0;
const sid = () => `SM${suffix}${String(++sidN).padStart(6, '0')}`.padEnd(34, '0').slice(0, 34);
let A; let B; let C; let D; let E; let op;
const mails = []; const alerts = [];

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${String(r.text).slice(0, 300)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
const console_ = (method, p, body) => api(method, `/platform${p}`, { body, headers: { 'x-platform-key': 'test-bootstrap-key', 'x-operator': 'Shared test' } });

/** A text to a number, as Twilio posts it. */
async function text(from, body, { to = SHARED, extra = {} } = {}) {
  const params = { AccountSid: 'ACtest', MessageSid: sid(), NumMedia: '0', From: from, To: to, Body: body, ...extra };
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', `${process.env.PUBLIC_URL}${PATH}`, params) };
  const res = await fetch(`${base}${PATH}`, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  const out = await res.text();
  const m = out.match(/<Message>([\s\S]*)<\/Message>/);
  return { status: res.status, reply: m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : null };
}
const callsOf = (phone) => q("SELECT * FROM dispatch_calls WHERE caller_phone = ? AND source = 'sms' ORDER BY id", [phone]);
const notesOf = async (call) => (await q("SELECT note FROM dispatch_events WHERE tenant_id = ? AND call_id = ? AND kind = 'note' ORDER BY id", [call.tenant_id, call.id])).map((r) => r.note);
const messagesOf = async (call) => (await q("SELECT body FROM dispatch_messages WHERE tenant_id = ? AND call_id = ? AND direction = 'from_guest' ORDER BY id", [call.tenant_id, call.id])).map((r) => r.body);
const pendingOf = async (phone) => (await q('SELECT * FROM help_pending WHERE phone = ? ORDER BY id DESC LIMIT 1', [phone]))[0];
const textsTo = (phone) => sent.filter((s) => s.To === phone);
const job = () => api('POST', '/internal/jobs/help-texts', { headers: { 'x-jobs-key': process.env.JOBS_KEY } });

/** A free tag this run can use (tags are unique across every mountain in the database). */
async function freeTag() {
  for (;;) {
    const L = 'BCDFGHJKLMNPQRSTVWXZ';
    const t = Array.from({ length: 3 }, () => L[Math.floor(Math.random() * L.length)]).join('');
    if (HL.tagProblem(t)) continue;
    if (!(await q('SELECT id FROM tenants WHERE help_tag = ?', [t])).length && !(await q('SELECT tag FROM help_tag_history WHERE tag = ?', [t])).length) return t;
  }
}
async function mountain(key, name, { lat, lng } = {}) {
  const slug = `hshr${key}-${suffix}`.slice(0, 40);
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const owner = await REC((await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token);
  const id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  if (lat !== undefined) await pool.query('UPDATE tenants SET map_lat = ?, map_lng = ? WHERE id = ?', [lat, lng, id]);
  const tag = await freeTag();
  await pool.query('UPDATE tenants SET help_tag = ? WHERE id = ?', [tag, id]);
  return { slug, owner, id, name, tag };
}
async function addPlace(tenantId, name, code, lat, lng) {
  await pool.query("INSERT INTO mountain_places (tenant_id, kind, name, code, lat, lng, accuracy_m, marked_by, marked_at, active) VALUES (?, 'sign', ?, ?, ?, ?, 5, 1, UTC_TIMESTAMP(), 1)", [tenantId, name, code, lat, lng]);
}
const near = (m, dLat = 0.001) => `${(m.lat + dLat).toFixed(5)},${m.lng.toFixed(5)} ±15m`;

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tw = await new Promise((r) => {
    const s = http.createServer((req, res) => {
      let d = ''; req.on('data', (c) => { d += c; });
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(d));
        res.setHeader('content-type', 'application/json');
        if (failTo.has(f.To)) { failTo.delete(f.To); res.statusCode = 500; return res.end(JSON.stringify({ message: 'Twilio is down' })); }
        sent.push({ url: req.url, ...f }); res.end(JSON.stringify({ sid: `SM${sent.length}` }));
      });
    });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  const PUSH = require('../src/lib/push');
  PUSH.notifyStaff = async (t, staffIds, m) => { alerts.push({ t: Number(t), who: 'staff', ids: staffIds, m }); return staffIds.length; };
  PUSH.notifyUsers = async (t, userIds, m) => { alerts.push({ t: Number(t), who: 'users', ids: userIds, m }); return userIds.length; };
  require('../src/lib/mailer').sendPlatform = async (m) => { mails.push(m); return { ok: true }; };
  op = await require('./helpers/platform-operator').operatorConsole(base, 'test-bootstrap-key');
  // Mountains this file made on earlier runs are paused, so their names and map points never match this run's texts.
  await pool.query("UPDATE tenants SET status = 'suspended' WHERE slug LIKE 'hshr%' AND slug NOT LIKE ?", [`%-${suffix}`]);
  A = await mountain('a', `Blue Ridge ${WORD}`, { lat: LAT0, lng: LNG0 }); A.lat = LAT0; A.lng = LNG0;
  B = await mountain('b', `Elk Hollow ${WORD}`, { lat: LAT0 + 0.18, lng: LNG0 }); B.lat = LAT0 + 0.18; B.lng = LNG0; // 20 km north, on its own number
  C = await mountain('c', `Pine Knob East ${WORD}`, { lat: LAT0 - 3, lng: LNG0 });
  D = await mountain('d', `Pine Knob West ${WORD}`, { lat: LAT0 - 3.1, lng: LNG0 });
  E = await mountain('e', `Cedar Falls ${WORD}`, { lat: LAT0 + 5, lng: LNG0 }); E.lat = LAT0 + 5; E.lng = LNG0;
  B.own = `+1267${String(Date.now()).slice(-7)}`;
  ok(await api('PUT', '/patrol/text-help', { token: A.owner, body: { mode: 'shared', patrol_phone: '(610) 555-0100', tag: A.tag } }));
  ok(await api('PUT', '/patrol/text-help', { token: B.owner, body: { mode: 'own', help_number: B.own } }));
  await addPlace(A.id, 'Ridge Run sign', 'R7', LAT0 + 0.002, LNG0);
  await addPlace(B.id, 'Elk Run sign', 'R7', LAT0 + 0.181, LNG0);
});
test.after(async () => {
  await pool.query("UPDATE tenants SET status = 'suspended' WHERE slug LIKE ?", [`hshr%-${suffix}`]);
  await new Promise((r) => server.close(r)); tw.close(); await pool.end();
});

// ---------------------------------------------------------------- settings
test('settings: Patrol settings default to the shared number; the tag is suggested from the name, unique, owner only, never a common word', async () => {
  const s = ok(await api('GET', '/patrol/text-help', { token: A.owner }));
  assert.equal(s.mode, 'shared'); assert.equal(s.number, SHARED); assert.equal(s.shared_number, SHARED); assert.equal(s.tag, A.tag); assert.equal(s.can_edit_tag, true);
  const b = ok(await api('GET', '/patrol/text-help', { token: B.owner }));
  assert.equal(b.mode, 'own'); assert.equal(b.number, B.own);
  // Suggested from the name, 3 letters; then other letters when that is taken; never a word a guest might type.
  const first = HL.suggestTag('Blue Ridge', new Set());
  assert.match(first, /^BR[A-Z]$/);
  assert.equal(HL.suggestTag('Blue Ridge Ski Area', new Set()), first);
  const second = HL.suggestTag('Blue Ridge', new Set([first]));
  assert.match(second, /^[A-Z]{3}$/); assert.notEqual(second, first);
  assert.match(HL.suggestTag('Mount Snow', new Set()), /^S[A-Z]{2}$/);
  assert.ok(!HL.tagProblem(HL.suggestTag('Mount Snow', new Set())));
  assert.ok(HL.tagProblem('MY') && HL.tagProblem('I') && HL.tagProblem('LEG') && HL.tagProblem('B1') && HL.tagProblem('ABCD'));
  // A mountain with no tag gets one from its name the first time it is needed.
  const F = C; // Pine Knob East (a sixth mountain in a minute would meet the sign-up limit)
  await pool.query('UPDATE tenants SET help_tag = NULL WHERE id = ?', [F.id]);
  const f = ok(await api('GET', '/patrol/text-help', { token: F.owner }));
  assert.match(f.tag, /^P[A-Z]{2}$/);
  // Unique, and never a common word.
  assert.equal((await api('PUT', '/patrol/text-help', { token: F.owner, body: { mode: 'shared', tag: A.tag } })).status, 409);
  assert.equal((await api('PUT', '/patrol/text-help', { token: F.owner, body: { mode: 'shared', tag: 'my' } })).status, 400);
  // Only the owner changes it: a manager keeps it as it is.
  ok(await api('POST', '/users', { token: F.owner, body: { email: `mgr@${F.slug}.test`, password: PW, role: 'manager', first_name: 'Max', last_name: 'Manager' } }), 201);
  const mgr = await REC((await api('POST', '/auth/login', { body: { tenant: F.slug, email: `mgr@${F.slug}.test`, password: PW } })).body.token);
  const m = ok(await api('GET', '/patrol/text-help', { token: mgr }));
  assert.equal(m.can_edit_tag, false);
  const tag2 = await freeTag();
  assert.equal((await api('PUT', '/patrol/text-help', { token: mgr, body: { mode: 'shared', tag: tag2 } })).status, 403);
  ok(await api('PUT', '/patrol/text-help', { token: mgr, body: { mode: 'shared', tag: f.tag, patrol_phone: '6105550199' } }), 200);
  // The owner may, and the platform operator may.
  assert.equal(ok(await api('PUT', '/patrol/text-help', { token: F.owner, body: { mode: 'shared', tag: tag2.toLowerCase() } })).tag, tag2);
  const tag3 = await freeTag();
  assert.equal(ok(await console_('PUT', `/tenants/${F.id}/help-tag`, { tag: tag3 })).tag, tag3);
  assert.equal((await console_('PUT', `/tenants/${F.id}/help-tag`, { tag: A.tag })).status, 409);
  // A mountain's own number can never be the shared number.
  assert.equal((await api('PUT', '/patrol/text-help', { token: F.owner, body: { mode: 'own', help_number: SHARED } })).status, 409);
  // Switching to its own number and back.
  const own = `+1215${String(Date.now()).slice(-7)}`;
  assert.equal(ok(await api('PUT', '/patrol/text-help', { token: F.owner, body: { mode: 'own', help_number: own } })).number, own);
  const back = ok(await api('PUT', '/patrol/text-help', { token: F.owner, body: { mode: 'shared', help_number: own } }));
  assert.equal(back.number, SHARED, 'back on the shared number, its own number kept for later');
  assert.equal((await q('SELECT help_number FROM patrol_help_lines WHERE tenant_id = ?', [F.id]))[0].help_number, own);
  C.tag = (await q('SELECT help_tag FROM tenants WHERE id = ?', [C.id]))[0].help_tag;
});

test('settings: the platform operator sets the shared number in the console; SHARED_HELP_NUMBER is the fallback', async () => {
  const before = ok(await console_('GET', '/help-settings'));
  assert.equal(before.env_number, SHARED);
  const other = `+1877${String(Date.now()).slice(-7)}`;
  try {
    assert.equal((await console_('PUT', '/help-settings', { shared_number: '12' })).status, 400);
    assert.equal((await console_('PUT', '/help-settings', { shared_number: B.own })).status, 400, 'a mountain\'s own number');
    assert.equal(ok(await console_('PUT', '/help-settings', { shared_number: `(877) ${other.slice(5, 8)}-${other.slice(8)}` })).shared_number, other);
    assert.equal(await HL.sharedNumber(), other);
  } finally {
    ok(await console_('PUT', '/help-settings', { shared_number: before.saved || null }));
  }
  assert.equal(await HL.sharedNumber(), before.saved ? HL.normalNumber(before.saved) : SHARED);
  // A mountain login never reaches the console.
  assert.equal((await api('GET', '/platform/help-settings', { token: A.owner })).status, 403);
});

// ---------------------------------------------------------------- a. the tag
test('a tag routes, in every form: "HELP BR R7", "help br-r7", "HELP BRR7", "BR", lower case, AYUDA', async () => {
  const forms = [`HELP ${A.tag} R7 hurt my knee`, `help ${A.tag.toLowerCase()}-r7 hurt`, `HELP ${A.tag}R7`, `HELP ${A.tag}`, `${A.tag.toLowerCase()} r7`, `AYUDA ${A.tag} R7 me caí`, `HELP ${A.tag}. R7`, `HELP: ${A.tag} - R7`];
  for (const body of forms) {
    const phone = guestPhone();
    const r = await text(phone, body);
    assert.equal(r.status, 200);
    const calls = await callsOf(phone);
    assert.equal(calls.length, 1, body);
    assert.equal(Number(calls[0].tenant_id), Number(A.id), `${body} reaches ${A.name}`);
    assert.match(r.reply, new RegExp(`^(If it is life threatening, call 911\\. )?${A.name} ski patrol has your message|^La patrulla de esquí de ${A.name}`), body);
    if (/R7/i.test(body)) assert.equal(calls[0].location, 'Ridge Run sign (sign R7)', `${body}: the sign is found`);
    assert.ok((await notesOf(calls[0])).some((n) => new RegExp(`^Arrived on the shared number, matched by tag \\(${A.tag}( R7)?\\) after 0 min`).test(n)), body);
    const th = (await q('SELECT help_number FROM dispatch_sms_threads WHERE tenant_id = ? AND call_id = ?', [A.id, calls[0].id]))[0];
    assert.equal(th.help_number, SHARED, 'replies go from the shared number');
    if (/^AYUDA/.test(body)) assert.match(r.reply, /^La patrulla de esquí/);
  }
  // A sign code alone is not enough on the shared number (codes repeat across mountains): it asks.
  const lone = guestPhone();
  const r = await text(lone, 'HELP R7');
  assert.equal((await callsOf(lone)).length, 0);
  assert.match(r.reply, /^Ski patrol: which ski area are you at\?/);
  // A word that looks like a tag is never one: "HELP I fell", "HELP my leg".
  for (const body of ['HELP I fell', 'HELP my leg is broken', 'HELP me']) {
    const p = guestPhone();
    assert.match((await text(p, body)).reply, /which ski area/);
    assert.equal((await callsOf(p)).length, 0, body);
  }
  // Dispatch's reply goes back from the shared number.
  const phone = guestPhone();
  await text(phone, `HELP ${A.tag} R7`);
  const [c] = await callsOf(phone);
  const out = await require('../src/lib/guestmsg').toGuest(pool, c, 'On our way', null);
  assert.equal(out.texted, true);
  assert.equal(textsTo(phone).at(-1).From, SHARED);
});

test('own number: the plain code works, and the tagged code works too', async () => {
  for (const body of ['HELP R7', `HELP ${B.tag} R7`, `HELP ${B.tag}R7`, `help ${B.tag.toLowerCase()}-r7`]) {
    const phone = guestPhone();
    const r = await text(phone, body, { to: B.own });
    const [c] = await callsOf(phone);
    assert.equal(Number(c.tenant_id), Number(B.id), body);
    assert.equal(c.location, 'Elk Run sign (sign R7)', body);
    assert.match(r.reply, new RegExp(`^${B.name} ski patrol`));
    assert.equal((await q('SELECT help_number FROM dispatch_sms_threads WHERE tenant_id = ? AND call_id = ?', [B.id, c.id]))[0].help_number, B.own);
  }
  // On the shared number, B's tag reaches B too (decided: still the right patrol).
  const phone = guestPhone();
  await text(phone, `HELP ${B.tag} R7`);
  assert.equal(Number((await callsOf(phone))[0].tenant_id), Number(B.id));
});

// ---------------------------------------------------------------- b. an open call
test('an open call from the phone joins: a text with no tag goes on the call', async () => {
  const phone = guestPhone();
  await text(phone, `HELP ${A.tag}`);
  const r = await text(phone, 'my leg hurts, near the big rock');
  assert.equal(r.reply, null);
  const calls = await callsOf(phone);
  assert.equal(calls.length, 1);
  assert.deepEqual(await messagesOf(calls[0]), [`HELP ${A.tag}`, 'my leg hurts, near the big rock']);
  assert.equal(await pendingOf(phone), undefined, 'never pending');
});

// ---------------------------------------------------------------- c. a position
test('a position picks the nearest mountain within 50 km, and records the choice; outside 50 km nothing is routed', async () => {
  const phone = guestPhone();
  await text(phone, `HELP ${near(A, 0.01)} hurt`);
  const [c] = await callsOf(phone);
  assert.equal(Number(c.tenant_id), Number(A.id));
  assert.ok(Number(c.gps_lat));
  const notes = await notesOf(c);
  assert.ok(notes.some((n) => n.startsWith('Arrived on the shared number, matched by position after 0 min') && n.includes(`Nearest ski area to the position: ${A.name}`) && n.includes(`also within 50 km: ${B.name}`)), notes.join(' | '));
  // Closer to B: B.
  const p2 = guestPhone();
  await text(p2, `HELP ${near(B, -0.01)}`);
  assert.equal(Number((await callsOf(p2))[0].tenant_id), Number(B.id));
  // 200 km from every mountain: no call, the guest is asked.
  const far = guestPhone();
  const r = await text(far, `HELP ${(LAT0 + 1.8).toFixed(5)},${LNG0.toFixed(5)} ±10m`);
  assert.equal((await callsOf(far)).length, 0);
  assert.match(r.reply, /which ski area/);
  assert.ok(await pendingOf(far));
});

// ---------------------------------------------------------------- d. pending, then a name
test('pending, then a name reply routes, with every pending text on the call in order', async () => {
  const phone = guestPhone();
  const r1 = await text(phone, 'HELP fell and hurt my knee');
  assert.equal(r1.reply, `Ski patrol: which ski area are you at? Reply with its name, or the code on the nearest sign. Or tap this link to send your location: https://app.verdynt.test/help-locate/${(await pendingOf(phone)).locate_token}. If it is life threatening, call 911.`);
  const r2 = await text(phone, 'cant move it');
  assert.match(r2.reply, /we did not find that ski area.*call 911\.$/);
  const r3 = await text(phone, `I'm at ${A.name.toLowerCase()} ski area!`);
  assert.match(r3.reply, new RegExp(`^${A.name} ski patrol has your message`));
  const [c] = await callsOf(phone);
  assert.equal(Number(c.tenant_id), Number(A.id));
  assert.equal(c.description, 'fell and hurt my knee');
  assert.deepEqual(await messagesOf(c), ['HELP fell and hurt my knee', 'cant move it', `I'm at ${A.name.toLowerCase()} ski area!`]);
  assert.ok((await notesOf(c)).includes('Arrived on the shared number, matched by name after 0 min'));
  const p = await pendingOf(phone);
  assert.equal(Number(p.resolved_tenant), Number(A.id)); assert.equal(p.resolved_by, 'name'); assert.equal(Number(p.resolved_call_id), Number(c.id));
  // The next text joins the call.
  await text(phone, 'thanks');
  assert.equal((await callsOf(phone)).length, 1);
  // Spanish, with the Spanish words for a ski area.
  const es = guestPhone();
  assert.match((await text(es, 'AYUDA me caí')).reply, /^Patrulla de esquí: ¿en qué estación de esquí está\?.*llame al 911\.$/);
  await text(es, `Estoy en la estación de esquí ${A.name}`);
  assert.equal(Number((await callsOf(es))[0].tenant_id), Number(A.id));
  // A tag in a later text routes the pending request too.
  const t = guestPhone();
  await text(t, 'HELP');
  await text(t, `${B.tag} R7`);
  const [cb] = await callsOf(t);
  assert.equal(Number(cb.tenant_id), Number(B.id));
  assert.equal(cb.location, 'Elk Run sign (sign R7)');
  assert.ok((await notesOf(cb)).includes(`Arrived on the shared number, matched by tag (${B.tag}) after 0 min`));
});

test('an ambiguous name gets a numbered list, and "2" routes; a typo is matched; no match keeps asking', async () => {
  const phone = guestPhone();
  await text(phone, 'HELP');
  const r = await text(phone, `pine knob ${WORD}`);
  assert.equal(r.reply, `Ski patrol: Reply 1 for ${C.name}, 2 for ${D.name}, or 0 for none of these: tell us the town or tap the location link: https://app.verdynt.test/help-locate/${(await pendingOf(phone)).locate_token}. If it is life threatening, call 911.`);
  assert.equal((await callsOf(phone)).length, 0);
  await text(phone, '2');
  assert.equal(Number((await callsOf(phone))[0].tenant_id), Number(D.id));
  // A typo is offered, never routed on its own; "1" routes.
  const typo = guestPhone();
  await text(typo, 'HELP');
  assert.match((await text(typo, `blue rdge ${WORD.toLowerCase()}`)).reply, new RegExp(`^Ski patrol: Reply 1 for ${A.name}, or 0 for none of these`));
  assert.equal((await callsOf(typo)).length, 0);
  await text(typo, '1');
  assert.equal(Number((await callsOf(typo))[0].tenant_id), Number(A.id));
  // No match: asked again, with the 911 line, as many times as it takes.
  const none = guestPhone();
  await text(none, 'HELP');
  for (const w of ['Narnia', 'the big one']) assert.match((await text(none, w)).reply, /^Ski patrol: we did not find that ski area\..* If it is life threatening, call 911\.$/);
  assert.equal((await callsOf(none)).length, 0);
  // Lost child: the 911 line first.
  const lost = guestPhone();
  assert.match((await text(lost, 'HELP lost child')).reply, /^If it is life threatening, call 911\. Ski patrol: which ski area/);
  const lr = await text(lost, A.name);
  assert.match(lr.reply, new RegExp(`^If it is life threatening, call 911\\. ${A.name} ski patrol has your message`));
  const [lc] = await callsOf(lost);
  assert.equal(lc.call_type, 'lost_child');
});

test('a mountain on its own number is matched by name on the shared number (decided: still the right patrol)', async () => {
  const phone = guestPhone();
  await text(phone, 'HELP');
  await text(phone, B.name);
  const [c] = await callsOf(phone);
  assert.equal(Number(c.tenant_id), Number(B.id));
  assert.equal((await q('SELECT help_number FROM dispatch_sms_threads WHERE tenant_id = ? AND call_id = ?', [B.id, c.id]))[0].help_number, SHARED, 'the conversation stays on the number the guest texted');
});

test('the locate link routes to the nearest mountain within 50 km; a position outside 50 km keeps it pending', async () => {
  const phone = guestPhone();
  await text(phone, 'HELP stuck in the trees');
  const p = await pendingOf(phone);
  const page = await fetch(`${base}/help-locate/${p.locate_token}`);
  assert.equal(page.status, 200);
  assert.equal(ok(await api('GET', `/public/help-locate/${p.locate_token}`)).state, 'waiting');
  const far = ok(await api('POST', `/public/help-locate/${p.locate_token}`, { body: { lat: LAT0 + 2, lng: LNG0, accuracy: 20 } }));
  assert.equal(far.matched, false);
  assert.equal((await callsOf(phone)).length, 0);
  const n = sent.length;
  const r = ok(await api('POST', `/public/help-locate/${p.locate_token}`, { body: { lat: A.lat + 0.002, lng: A.lng, accuracy: 12 } }));
  assert.deepEqual(r, { matched: true, mountain: A.name });
  const [c] = await callsOf(phone);
  assert.equal(Number(c.tenant_id), Number(A.id));
  assert.equal(Number(c.located_accuracy_m), 12);
  assert.ok((await notesOf(c)).some((x) => x.startsWith('Arrived on the shared number, matched by position after 0 min')));
  const out = sent.slice(n).filter((s) => s.To === phone);
  assert.equal(out.length, 1); assert.equal(out[0].From, SHARED);
  assert.match(out[0].Body, new RegExp(`^${A.name} ski patrol has your message`));
  assert.equal(ok(await api('GET', `/public/help-locate/${p.locate_token}`)).mountain, A.name);
  // A made-up token is not found.
  assert.equal((await api('POST', `/public/help-locate/${'0'.repeat(32)}`, { body: { lat: A.lat, lng: A.lng } })).status, 404);
});

// ---------------------------------------------------------------- the job
test('the job texts again after 3 minutes and closes the request after 2 hours with a last text', async () => {
  const phone = guestPhone();
  await text(phone, 'AYUDA');
  const p = await pendingOf(phone);
  const n0 = sent.length;
  ok(await job());
  assert.equal(sent.slice(n0).filter((s) => s.To === phone).length, 0, 'not yet');
  await pool.query('UPDATE help_pending SET created_at = created_at - INTERVAL 4 MINUTE WHERE id = ?', [p.id]);
  const n = sent.length;
  ok(await job());
  ok(await job());
  const nudges = sent.slice(n).filter((s) => s.To === phone);
  assert.equal(nudges.length, 1, 'once');
  assert.match(nudges[0].Body, /^Patrulla de esquí: Todavía necesitamos el nombre de la estación de esquí\..*llame al 911\.$/);
  assert.equal(nudges[0].From, SHARED);
  await pool.query('UPDATE help_pending SET created_at = created_at - INTERVAL 2 HOUR WHERE id = ?', [p.id]);
  ok(await job());
  const last = sent.slice(n).filter((s) => s.To === phone);
  assert.equal(last.length, 2);
  assert.equal(last[1].Body, 'Patrulla de esquí: Si todavía necesita ayuda, llame al 911 o a la estación de esquí.');
  assert.ok((await q('SELECT expired_at FROM help_pending WHERE id = ?', [p.id]))[0].expired_at);
  ok(await job());
  assert.equal(sent.slice(n).filter((s) => s.To === phone).length, 2, 'the last text goes once');
  // A new text starts a new request.
  await text(phone, 'HELP');
  assert.notEqual(Number((await pendingOf(phone)).id), Number(p.id));
});

test('the console shows the waiting texts, and the operator can send one to a mountain by hand', async () => {
  const phone = guestPhone();
  await text(phone, 'HELP hurt');
  await text(phone, 'by the chairlift');
  assert.equal((await console_('GET', '/help-pending')).status, 403, 'the platform key alone, without two-step, cannot read guests\' texts');
  const w = ok(await op('GET', '/help-pending'));
  const mine = w.data.find((x) => x.phone === phone);
  assert.deepEqual(mine.texts.map((x) => x.body), ['HELP hurt', 'by the chairlift']);
  assert.ok(w.mountains.some((m) => m.id === Number(A.id) && m.tag === A.tag));
  // A mountain login cannot see or assign them.
  assert.equal((await api('GET', '/platform/help-pending', { token: A.owner })).status, 403);
  assert.equal((await api('POST', `/platform/help-pending/${mine.id}/assign`, { token: A.owner, body: { tenant_id: Number(A.id) } })).status, 403);
  const n = sent.length;
  const out = ok(await op('POST', `/help-pending/${mine.id}/assign`, { tenant_id: Number(A.id) }));
  assert.equal(out.mountain, A.name);
  const [c] = await callsOf(phone);
  assert.equal(Number(c.tenant_id), Number(A.id));
  assert.deepEqual(await messagesOf(c), ['HELP hurt', 'by the chairlift']);
  assert.ok((await notesOf(c)).some((x) => x.startsWith('Arrived on the shared number, assigned by hand on the platform console (Test Operator) after 0 min')));
  assert.match(sent.slice(n).find((s) => s.To === phone).Body, new RegExp(`^${A.name} ski patrol has your message`));
  assert.ok(!ok(await op('GET', '/help-pending')).data.some((x) => x.phone === phone), 'no longer waiting');
  assert.equal((await op('POST', `/help-pending/${mine.id}/assign`, { tenant_id: Number(B.id) })).status, 404, 'once');
  // A paused mountain cannot be chosen.
  const p2 = guestPhone();
  await text(p2, 'HELP');
  const id2 = (await pendingOf(p2)).id;
  await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = ?", [E.id]);
  try { assert.equal((await op('POST', `/help-pending/${id2}/assign`, { tenant_id: Number(E.id) })).status, 400); } finally { await pool.query("UPDATE tenants SET status = 'active' WHERE id = ?", [E.id]); }
});

// ---------------------------------------------------------------- STOP, caps, a paused mountain
test('STOP on the shared number counts for the whole shared number; the phone still reaches dispatch, with no reply', async () => {
  const phone = guestPhone();
  await text(phone, `HELP ${A.tag}`);
  const [ca] = await callsOf(phone);
  assert.equal((await text(phone, 'STOP', { extra: { OptOutType: 'STOP' } })).reply, null);
  assert.equal((await q('SELECT COUNT(*) AS n FROM help_shared_optouts WHERE phone_key = ?', [HL.keyOf(phone)]))[0].n, 1);
  assert.ok((await notesOf(ca)).includes(HL.STOPPED));
  const n = sent.length;
  const r = await require('../src/lib/guestmsg').toGuest(pool, ca, 'Are you there?', null);
  assert.equal(r.texted, false);
  // At another mountain too (B, by its tag): the call is made, nothing is texted.
  await pool.query("UPDATE dispatch_calls SET status = 'closed' WHERE id = ?", [ca.id]);
  const rb = await text(phone, `HELP ${B.tag}`);
  assert.equal(rb.reply, null);
  assert.equal(Number((await callsOf(phone)).at(-1).tenant_id), Number(B.id));
  // And a pending request: kept, not answered.
  await pool.query("UPDATE dispatch_calls SET status = 'closed' WHERE caller_phone = ?", [phone]);
  assert.equal((await text(phone, 'HELP where am i')).reply, null);
  assert.ok(await pendingOf(phone));
  assert.equal(sent.slice(n).filter((s) => s.To === phone).length, 0);
  // START: texts go again.
  await text(phone, 'START', { extra: { OptOutType: 'START' } });
  assert.equal((await q('SELECT COUNT(*) AS n FROM help_shared_optouts WHERE phone_key = ?', [HL.keyOf(phone)]))[0].n, 0);
  assert.match((await text(phone, 'still here')).reply, /we did not find that ski area/);
  // STOP to the shared number does not touch an own number's list.
  assert.equal((await q('SELECT COUNT(*) AS n FROM dispatch_sms_optouts WHERE phone_key = ?', [HL.keyOf(phone)]))[0].n, 0);
});

test('caps: 6 replies an hour to a pending phone, and the shared number\'s hourly cap across every mountain', async () => {
  const phone = guestPhone();
  const replies = [];
  for (let i = 0; i < 8; i++) replies.push((await text(phone, i ? `where ${i}` : 'HELP')).reply);
  assert.equal(replies.filter(Boolean).length, 6);
  assert.equal(replies[6], null); assert.equal(replies[7], null);
  assert.equal(JSON.parse((await pendingOf(phone)).texts).length, 8, 'every text is still kept');
  // The shared cap: the call is made, the reply is held, and the call says why.
  const was = process.env.HELP_SMS_SHARED_HOURLY_CAP;
  process.env.HELP_SMS_SHARED_HOURLY_CAP = String(await HL.sharedHourCount());
  try {
    const p2 = guestPhone();
    const r = await text(p2, `HELP ${A.tag}`);
    assert.equal(r.reply, null);
    const [c] = await callsOf(p2);
    assert.ok((await notesOf(c)).some((x) => /^Text not sent: The shared help number has sent \d+ texts in the last hour/.test(x)));
    const p3 = guestPhone();
    assert.match((await text(p3, 'HELP')).reply, /which ski area/, 'the call budget does not hold back the which-ski-area reply: it has its own');
  } finally { if (was === undefined) delete process.env.HELP_SMS_SHARED_HOURLY_CAP; else process.env.HELP_SMS_SHARED_HOURLY_CAP = was; }
  // The per-call cap still holds on the shared number.
  assert.equal(HL.CALL_CAP(), 20);
});

test('a paused mountain is never routed to: not by tag, position, name or an open call', async () => {
  const phone = guestPhone();
  await text(phone, `HELP ${E.tag}`);
  const [open] = await callsOf(phone);
  assert.equal(Number(open.tenant_id), Number(E.id));
  await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = ?", [E.id]);
  try {
    assert.match((await text(phone, 'still waiting')).reply, /which ski area/, 'the open call at a paused mountain is not joined');
    assert.equal((await callsOf(phone)).length, 1);
    for (const body of [`HELP ${E.tag} R7`, `HELP ${near(E)}`]) {
      const p = guestPhone();
      assert.match((await text(p, body)).reply, /which ski area/, body);
      assert.equal((await callsOf(p)).length, 0, body);
    }
    const p = guestPhone();
    await text(p, 'HELP');
    assert.match((await text(p, E.name)).reply, /we did not find that ski area/);
    assert.equal((await callsOf(p)).length, 0);
    const tok = (await pendingOf(p)).locate_token;
    assert.equal(ok(await api('POST', `/public/help-locate/${tok}`, { body: { lat: E.lat, lng: E.lng } })).matched, false);
  } finally { await pool.query("UPDATE tenants SET status = 'active' WHERE id = ?", [E.id]); }
  // A demo mountain never takes texts either, and has no number to show.
  assert.equal((await SH.reachable()).some((t) => /^hshr/.test(t.slug) && t.status !== 'active'), false);
});

// ---------------------------------------------------------------- the guest page and the signs
test('the guest page shows the shared number, and its Send by text instead body always routes (tag first, even with no code)', async () => {
  await pool.query('UPDATE tenants SET guest_help_enabled = 1 WHERE id = ?', [A.id]);
  const g = ok(await api('GET', `/public/${A.slug}/help`));
  assert.equal(g.sms_number, SHARED); assert.equal(g.sms_tag, A.tag); assert.equal(g.patrol_phone, '+16105550100');
  const H = await import('../public/js/help-strings.js');
  const bodies = [
    H.smsBody({ tag: g.sms_tag, code: null, place: null }),
    H.smsBody({ tag: g.sms_tag, code: null, place: null, lat: B.lat, lng: B.lng, acc: 20 }), // B's position: the tag wins
    H.smsBody({ tag: g.sms_tag, code: 'R7', place: null, lat: A.lat, lng: A.lng, acc: 8, what: 'lost child' }),
    H.smsBody({ tag: g.sms_tag, code: null, place: 'Ridge Run', lat: LAT0 + 0.01, lng: LNG0, acc: 30 }), // a place, and a position near A
    H.smsBody({ tag: g.sms_tag, code: null, place: null, what: 'lost child' }),
  ];
  assert.equal(bodies[0], `HELP ${A.tag}`);
  assert.equal(bodies[1], `HELP ${A.tag} ${B.lat.toFixed(5)},${B.lng.toFixed(5)} ±20m`);
  for (const body of bodies) {
    const phone = guestPhone();
    await text(phone, body);
    const [c] = await callsOf(phone);
    assert.ok(c, body);
    assert.equal(Number(c.tenant_id), Number(A.id), body);
  }
  // The page's place words with no position are not enough on their own: the guest is asked, with A first.
  const p = guestPhone();
  const r = await text(p, H.smsBody({ tag: g.sms_tag, code: null, place: 'Ridge Run' }));
  assert.match(r.reply, new RegExp(`^Ski patrol: Reply 1 for ${A.name}`));
  assert.equal((await callsOf(p)).length, 0);
});

test('sign sheets show the number guests text and the tagged code; the QR address is unchanged', async () => {
  const sheet = ok(await api('GET', '/patrol/places/signs', { token: A.owner }));
  assert.equal(sheet.help_number, SHARED); assert.equal(sheet.help_tag, A.tag); assert.equal(sheet.shared, true);
  const p = sheet.places.find((x) => x.code === 'R7');
  assert.equal(p.url, `https://app.verdynt.test/help/${A.slug}?c=R7`);
  const S = await import('../public/js/signsheet.js');
  const w = S.signWords({ code: p.code, mountain: sheet.mountain, number: sheet.help_number, tag: sheet.help_tag });
  assert.equal(w.code, `${A.tag} R7`);
  assert.equal(w.how, `Scan, or text HELP ${A.tag} R7 to ${SHARED.slice(2, 5)}-${SHARED.slice(5, 8)}-${SHARED.slice(8)}`);
  const sb = ok(await api('GET', '/patrol/places/signs', { token: B.owner }));
  assert.equal(sb.help_number, B.own); assert.equal(sb.help_tag, B.tag); assert.equal(sb.shared, false);
  // Changing the tag changes the signs.
  const t = await freeTag();
  ok(await api('PUT', '/patrol/text-help', { token: A.owner, body: { mode: 'shared', tag: t, patrol_phone: '6105550100' } }));
  try {
    assert.equal(ok(await api('GET', '/patrol/places/signs', { token: A.owner })).help_tag, t);
    const phone = guestPhone();
    await text(phone, `HELP ${t} R7`);
    assert.equal(Number((await callsOf(phone))[0].tenant_id), Number(A.id));
  } finally { ok(await api('PUT', '/patrol/text-help', { token: A.owner, body: { mode: 'shared', tag: A.tag, patrol_phone: '6105550100' } })); }
});

// ---------------------------------------------------------------- reading a text
test('reading the lead: tag forms, and the text that reaches the mountain keeps its code', () => {
  const L = HL.leadOf('HELP BR-R7 my knee');
  assert.deepEqual(L.cands.map((c) => [c.tag, c.code, c.joined]), [['BR', 'R7', false]]);
  assert.equal(HL.withoutLead(L, L.cands[0], true), 'HELP R7 my knee');
  const J = HL.leadOf('help brr7');
  assert.deepEqual(J.cands.map((c) => [c.tag, c.code]), [['BR', 'R7']], 'B alone is a letter, never a tag');
  assert.equal(HL.leadOf('HELP I fell').cands.length, 0);
  assert.equal(HL.leadOf('HELP my leg').cands.length, 0);
  assert.deepEqual(HL.leadOf('BR').cands.map((c) => c.tag), ['BR']);
  const M = SH.matchName('Estoy en la estación de esquí Blue Ridge', [{ id: 1, name: 'Blue Ridge Ski Area' }, { id: 2, name: 'Blue Mountain' }]);
  assert.equal(M.exact.length, 1); assert.equal(M.exact[0].tenant.id, 1);
  assert.equal(SH.matchName('my leg hurts', [{ id: 1, name: 'Blue Ridge' }]).close.length, 0);
});

// ---------------------------------------------------------------- tenant isolation
test('tenant isolation: one mountain cannot see, route or change another\'s Text HELP', async () => {
  // B's owner reads only B's settings, and cannot set A's tag or A's number.
  const b = ok(await api('GET', '/patrol/text-help', { token: B.owner }));
  assert.equal(b.tag, B.tag); assert.equal(b.help_number, B.own);
  assert.equal((await api('PUT', '/patrol/text-help', { token: B.owner, body: { mode: 'own', help_number: B.own, tag: A.tag } })).status, 409);
  assert.equal((await q('SELECT help_tag FROM tenants WHERE id = ?', [A.id]))[0].help_tag, A.tag);
  // B's sign sheet holds nothing of A's.
  const sb = ok(await api('GET', '/patrol/places/signs', { token: B.owner }));
  assert.ok(!JSON.stringify(sb).includes(A.slug) && !JSON.stringify(sb).includes(A.tag + ' '));
  // The console routes need an operator; a mountain's token is refused.
  for (const [m, p] of [['GET', '/platform/help-pending'], ['GET', '/platform/help-settings'], ['PUT', `/platform/tenants/${A.id}/help-tag`]]) {
    assert.equal((await api(m, p, { token: B.owner, body: m === 'PUT' ? { tag: 'ZZZ' } : undefined })).status, 403, p);
  }
  // A call's locate token is not a shared locate token, and the reverse.
  const phone = guestPhone();
  await text(phone, `HELP ${A.tag}`);
  const [c] = await callsOf(phone);
  assert.equal((await api('GET', `/public/help-locate/${c.locate_token}`)).status, 404);
  const p2 = guestPhone();
  await text(p2, 'HELP');
  assert.equal((await api('GET', `/public/locate/${(await pendingOf(p2)).locate_token}`)).status, 404);
  // B's dispatch board never sees a call routed to A.
  const board = ok(await api('GET', '/patrol/dispatch', { token: B.owner }));
  assert.ok(!JSON.stringify(board).includes(phone));
});

// ---------------------------------------------------------------- map orientation: "Which way is uphill from the base?"
test('the uphill compass picker: each of the 8 points turns the maps so that way is up, and saves as a manual setting', async () => {
  const T = await import('../public/js/mapturn.js');
  assert.deepEqual(T.UPHILL.map((u) => [u.key, u.deg]), [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]]);
  assert.equal(T.uphillDeg('nw'), 315); assert.equal(T.uphillDeg('X'), null);
  assert.equal(T.uphillWord(315), 'north-west'); assert.equal(T.uphillWord(-45), 'north-west'); assert.equal(T.uphillWord(100), null);
  // Uphill is up: with uphill east (90), a point east of the base is straight up the screen.
  for (const u of T.UPHILL) {
    const r = Math.PI * u.deg / 180;
    const p = T.turn(Math.sin(r) * 100, Math.cos(r) * 100, u.deg);
    assert.ok(Math.abs(p.x) < 1e-6 && p.y < -99, `${u.key}: uphill is at the top`);
  }
  // What a tap sends is saved at once as a manual setting, and every map follows it.
  for (const u of [T.UPHILL[7], T.UPHILL[2]]) {
    const o = ok(await api('PUT', '/patrol/places/orientation', { token: A.owner, body: { rotation_deg: u.deg } }));
    assert.equal(o.mode, 'manual'); assert.equal(o.rotation_deg, u.deg); assert.equal(o.manual_deg, u.deg);
    assert.equal(ok(await api('GET', '/patrol/places/orientation', { token: A.owner })).rotation_deg, u.deg);
  }
  // Back to uphill up with nothing mapped: north up until a lift is marked.
  const back = ok(await api('PUT', '/patrol/places/orientation', { token: A.owner, body: { auto: true } }));
  assert.equal(back.mode, 'north'); assert.equal(back.rotation_deg, 0);
});

// ---------------------------------------------------------------- the review (Nov 9): when unsure, ask; never a guess
const rename = async (M, name) => { await pool.query('UPDATE tenants SET name = ? WHERE id = ?', [name, M.id]); };

test('review 1: an open call keeps its texts; a joined code with a digit is not a sign; only a separated tag and a real sign at another mountain moves the guest', async () => {
  const phone = guestPhone();
  await text(phone, `HELP ${A.tag}`);
  const r = await text(phone, `${B.tag}12`); // B has no sign 12: before the fix this left A's call for B
  assert.equal(r.reply, null);
  let calls = await callsOf(phone);
  assert.equal(calls.length, 1); assert.equal(Number(calls[0].tenant_id), Number(A.id));
  assert.deepEqual(await messagesOf(calls[0]), [`HELP ${A.tag}`, `${B.tag}12`]);
  // A joined real code at B does not move it either: only a clearly separated tag does.
  await text(phone, `${B.tag}R7`);
  assert.equal((await callsOf(phone)).length, 1);
  // "BRX R7", a real sign at B: a new call at B, and both calls say so.
  await text(phone, `${B.tag} R7 now at the other hill`);
  calls = await callsOf(phone);
  assert.equal(calls.length, 2); assert.equal(Number(calls[1].tenant_id), Number(B.id));
  assert.ok((await notesOf(calls[0])).some((n) => n.startsWith(`Guest texted another ski area's sign (${B.name}, ${B.tag} R7): a new call was made there.`)));
  assert.ok((await notesOf(calls[1])).some((n) => n.includes(`This phone also has an open call at ${A.name}.`)));
  // A joined code with a digit but no such sign never routes a first text either.
  const p2 = guestPhone();
  assert.match((await text(p2, `HELP ${A.tag}99`)).reply, /which ski area|Reply 1/);
  assert.equal((await callsOf(p2)).length, 0);
});

test('review 2: a retired tag is never given to another mountain, and a text with it reaches the mountain that used it, or asks', async () => {
  const old = A.tag; const now = await freeTag();
  ok(await api('PUT', '/patrol/text-help', { token: A.owner, body: { mode: 'shared', tag: now, patrol_phone: '6105550100' } }));
  try {
    assert.equal((await q('SELECT tenant_id FROM help_tag_history WHERE tag = ?', [old]))[0].tenant_id, A.id);
    assert.equal((await api('PUT', '/patrol/text-help', { token: C.owner, body: { mode: 'shared', tag: old } })).status, 409, 'never given to another mountain');
    assert.equal((await console_('PUT', `/tenants/${C.id}/help-tag`, { tag: old })).status, 409);
    assert.notEqual(HL.suggestTag(A.name, await HL.takenTags(pool)), old);
    // An old sign: "HELP <old> R7" reaches A, with a note.
    const p1 = guestPhone();
    await text(p1, `HELP ${old} R7`);
    const [c] = await callsOf(p1);
    assert.equal(Number(c.tenant_id), Number(A.id));
    assert.ok((await notesOf(c)).some((n) => n.startsWith(`Arrived on the shared number, matched by old sign tag (${old} R7)`)));
    // A code that is not there: asked, with A first.
    const p2 = guestPhone();
    assert.match((await text(p2, `HELP ${old} R99`)).reply, new RegExp(`^Ski patrol: Reply 1 for ${A.name}`));
    assert.equal((await callsOf(p2)).length, 0);
  } finally {
    ok(await api('PUT', '/patrol/text-help', { token: A.owner, body: { mode: 'shared', tag: old, patrol_phone: '6105550100' } })); // its own old tag, back
  }
  assert.equal((await q('SELECT COUNT(*) AS n FROM help_tag_history WHERE tag = ?', [old]))[0].n, 0);
});

test('review 3: common words are never tags, tags are 3 letters, and a lone tag before other words asks with that mountain first', async () => {
  for (const w of ['BC', 'IM', 'ME', 'RED', 'RUN', 'HIP', 'ICY', 'IDK', 'IVE', 'OMG', 'RN', 'BF', 'GF', 'SI', 'YA', 'ES', 'EN', 'LOS', 'ARM', 'SKI', 'LOL']) assert.ok(HL.tagProblem(w), w);
  assert.equal((await api('PUT', '/patrol/text-help', { token: C.owner, body: { mode: 'shared', tag: 'BC' } })).status, 400);
  for (const body of ['help bc i fell', 'help im on blue run', 'HELP ME', 'help red run', 'help!', 'Help ski patrol at Big Sky']) {
    const phone = guestPhone();
    const r = await text(phone, body);
    assert.equal((await callsOf(phone)).length, 0, body);
    assert.match(r.reply, /^Ski patrol: (which ski area|Reply)/, body);
  }
  // A's tag, then words: asked, A first.
  const phone = guestPhone();
  assert.match((await text(phone, `help ${A.tag} at the lodge`)).reply, new RegExp(`^Ski patrol: Reply 1 for ${A.name}, or 0 for none of these`));
  assert.equal((await callsOf(phone)).length, 0);
  await text(phone, '1');
  assert.equal(Number((await callsOf(phone))[0].tenant_id), Number(A.id));
  // "0": none of these, asked again.
  const p0 = guestPhone();
  await text(p0, `help ${A.tag} at the lodge`);
  assert.match((await text(p0, '0')).reply, /^Ski patrol: we did not find that ski area/);
  assert.equal((await callsOf(p0)).length, 0);
});

test('review 4: a name routes only when it is the whole name; one word or a typo gets a numbered list ending with 0', async () => {
  const names = { C: C.name, D: D.name, E: E.name };
  await rename(C, `Killington ${WORD}`); await rename(D, `Deer Creek ${WORD}`); await rename(E, `Blue Knob ${WORD}`);
  try {
    for (const [reply, M] of [['killington', C], [`Bear Creek ${WORD}`, D], ['Blue Knob', E]]) {
      const phone = guestPhone();
      await text(phone, 'HELP');
      const r = await text(phone, reply);
      assert.equal((await callsOf(phone)).length, 0, `${reply} is not routed on a guess`);
      assert.match(r.reply, new RegExp(`Reply 1 for ${M.name === C.name ? `Killington ${WORD}` : M === D ? `Deer Creek ${WORD}` : `Blue Knob ${WORD}`}.*0 for none of these: tell us the town or tap the location link`), reply);
    }
    // The whole name routes.
    const phone = guestPhone();
    await text(phone, 'HELP');
    await text(phone, `Deer Creek ${WORD}`);
    assert.equal(Number((await callsOf(phone))[0].tenant_id), Number(D.id));
  } finally { await rename(C, names.C); await rename(D, names.D); await rename(E, names.E); }
});

test('review 5: a position between two ski areas 3.3 km apart asks with a list by distance; near a mapped place it routes', async () => {
  await pool.query('UPDATE tenants SET map_lat = ? WHERE id = ?', [A.lat + 0.0297, B.id]); // 3.3 km north of A
  const [m1] = await pool.query("INSERT INTO mountain_places (tenant_id, kind, name, code, lat, lng, accuracy_m, marked_by, marked_at, active) VALUES (?, 'sign', 'Midway sign', 'M1', ?, ?, 5, 1, UTC_TIMESTAMP(), 1)", [A.id, A.lat + 0.0144, A.lng]);
  try {
    const phone = guestPhone();
    const r = await text(phone, `HELP ${(A.lat + 0.0135).toFixed(5)},${(A.lng + 0.01).toFixed(5)} ±25m`); // 1.6 km from A, 1.8 km from B
    assert.equal((await callsOf(phone)).length, 0);
    assert.match(r.reply, new RegExp(`^Ski patrol: Reply 1 for ${A.name}, 2 for ${B.name}, or 0 for none of these`));
    // Within 300 m of A's Midway sign: A.
    const p2 = guestPhone();
    await text(p2, `HELP ${(A.lat + 0.0145).toFixed(5)},${A.lng.toFixed(5)} ±10m`);
    assert.equal(Number((await callsOf(p2))[0].tenant_id), Number(A.id));
    // The locate link asks the same way.
    const p3 = guestPhone();
    await text(p3, 'HELP');
    const tok = (await pendingOf(p3)).locate_token;
    const n = sent.length;
    assert.deepEqual(ok(await api('POST', `/public/help-locate/${tok}`, { body: { lat: A.lat + 0.0135, lng: A.lng + 0.01, accuracy: 20 } })), { matched: false, asked: true });
    assert.match(sent.slice(n).find((x) => x.To === p3).Body, new RegExp(`^Ski patrol: Reply 1 for ${A.name}, 2 for ${B.name}`));
    assert.equal((await callsOf(p3)).length, 0);
  } finally {
    await pool.query('UPDATE tenants SET map_lat = ? WHERE id = ?', [B.lat, B.id]);
    await pool.query('UPDATE mountain_places SET active = 0 WHERE id = ?', [m1.insertId]);
  }
});

test('review 6: a waiting text alerts every operator and the patrol it may belong to at 3 and 10 minutes, with no guest words; a failed text is sent again', async () => {
  const phone = guestPhone();
  failTo.add(phone);
  // A position between A and a mountain moved 3.3 km away makes both candidates.
  await pool.query('UPDATE tenants SET map_lat = ? WHERE id = ?', [A.lat + 0.0297, B.id]);
  try { await text(phone, `HELP my secret words ${(A.lat + 0.0135).toFixed(5)},${(A.lng + 0.01).toFixed(5)} ±25m`); } finally { await pool.query('UPDATE tenants SET map_lat = ? WHERE id = ?', [B.lat, B.id]); }
  const p = await pendingOf(phone);
  assert.deepEqual(JSON.parse(p.candidates).sort(), [Number(A.id), Number(B.id)].sort());
  failTo.add(phone); // the list went out in the reply (TwiML); the 3-minute text through Twilio fails once
  await pool.query('UPDATE help_pending SET created_at = created_at - INTERVAL 4 MINUTE WHERE id = ?', [p.id]);
  mails.length = 0; alerts.length = 0;
  ok(await job());
  const opEmails = (await q('SELECT email FROM platform_operators WHERE active = 1')).map((r) => r.email);
  assert.ok(opEmails.length >= 1);
  const m3 = mails.filter((m) => m.subject === SH.ALERT);
  assert.deepEqual(m3.map((m) => m.to).sort(), [...opEmails].sort(), 'every operator');
  assert.ok(m3.every((m) => !m.text.includes('secret') && !m.text.includes(phone.slice(2))), 'no guest words or number');
  const forA = alerts.filter((x) => x.t === Number(A.id) && x.m.tag === `help-waiting-${p.id}`);
  const forB = alerts.filter((x) => x.t === Number(B.id) && x.m.tag === `help-waiting-${p.id}`);
  assert.ok(forA.some((x) => x.who === 'users' && x.ids.length) && forB.length, 'owners and managers (and patrol on duty) at each candidate');
  assert.ok(alerts.every((x) => x.m.title === SH.ALERT && !JSON.stringify(x.m).includes('secret')));
  // The 3-minute text failed at Twilio: tried again on the next run.
  assert.equal((await q('SELECT nudged_at FROM help_pending WHERE id = ?', [p.id]))[0].nudged_at, null);
  mails.length = 0;
  ok(await job());
  assert.equal(sent.filter((x) => x.To === phone && /We still need the ski area name/.test(x.Body)).length, 1, 'sent on the retry, once');
  assert.equal(mails.filter((m) => m.subject === SH.ALERT).length, 0, 'the 3-minute alert goes once');
  await pool.query('UPDATE help_pending SET created_at = created_at - INTERVAL 7 MINUTE WHERE id = ?', [p.id]);
  ok(await job());
  assert.equal(mails.filter((m) => m.subject === SH.ALERT).length, opEmails.length, 'and again at 10 minutes');
  assert.ok(mails.find((m) => m.subject === SH.ALERT).text.includes('waited 10 minutes'));
});

test('review 7: 25 spam texts use their own budget and never stop a real call\'s reply', async () => {
  const wasP = process.env.HELP_PENDING_HOURLY_CAP; const wasS = process.env.HELP_SMS_SHARED_HOURLY_CAP;
  const pend = (await q("SELECT COUNT(*) AS n FROM help_shared_log WHERE direction = 'out' AND at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR"))[0].n;
  process.env.HELP_PENDING_HOURLY_CAP = String(Number(pend) + 10);
  process.env.HELP_SMS_SHARED_HOURLY_CAP = String(await HL.sharedHourCount() + 1);
  try {
    let replies = 0;
    for (let i = 0; i < 25; i++) if ((await text(guestPhone(), `hello ${i}`)).reply) replies += 1;
    assert.equal(replies, 10, 'the which-ski-area budget');
    const real = guestPhone();
    const r = await text(real, `HELP ${A.tag} R7`);
    assert.match(r.reply, new RegExp(`^${A.name} ski patrol has your message`), 'the call\'s reply still goes');
  } finally { process.env.HELP_PENDING_HOURLY_CAP = wasP; if (wasS === undefined) delete process.env.HELP_SMS_SHARED_HOURLY_CAP; else process.env.HELP_SMS_SHARED_HOURLY_CAP = wasS; }
});

test('review 8: a first text that names the ski area in full goes straight there; part of a name asks with a list', async () => {
  const phone = guestPhone();
  const r = await text(phone, `HELP I'm at ${A.name}, hurt my wrist`);
  assert.equal((await callsOf(phone)).length, 0, 'other words with the name: asked, not guessed');
  assert.match(r.reply, new RegExp(`^Ski patrol: Reply 1 for ${A.name}`));
  const p2 = guestPhone();
  const r2 = await text(p2, `Help, I'm at ${A.name} ski area`);
  assert.equal(Number((await callsOf(p2))[0].tenant_id), Number(A.id));
  assert.match(r2.reply, new RegExp(`^${A.name} ski patrol has your message`));
});

test('review 10: a text Twilio sends again after a failure is stored once (MessageSid)', async () => {
  const phone = guestPhone();
  await text(phone, 'HELP');
  const was = HL.sharedOptedOut;
  let once = true;
  HL.sharedOptedOut = async (...a) => { if (once) { once = false; throw new Error('database blip'); } return was(...a); };
  const params = { AccountSid: 'ACtest', MessageSid: sid(), NumMedia: '0', From: phone, To: SHARED, Body: 'near the lodge' };
  const post = () => fetch(`${base}${PATH}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', `${process.env.PUBLIC_URL}${PATH}`, params) }, body: new URLSearchParams(params).toString() });
  try {
    assert.equal((await post()).status, 500);
    assert.equal((await post()).status, 200, 'the retry is taken');
  } finally { HL.sharedOptedOut = was; }
  assert.deepEqual(JSON.parse((await pendingOf(phone)).texts).map((x) => x.b), ['HELP', 'near the lodge']);
});
