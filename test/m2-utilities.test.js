'use strict';

// Release 2026.11.20, workstream "utilities": main breaks (the valves to shut, the work order, the break history that
// raises a main's condition), work orders on any map item, the water customer list (consent, STOP, door hangers),
// failed outfall screenings (condition and illicit discharge cases), Chapter 94 flows, MS4, the bulk pickup driving order,
// and repeat callers and duplicates. Everything through real HTTP; a fake Twilio and Postmark take what is sent.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.PLATFORM_RATE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT = '100000';
process.env.USERS_RATE_LIMIT = '100000';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'alerts@verdynt.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const mailer = require('../src/lib/mailer');
const quiet = require('../src/lib/quiet');
const SN = require('../src/lib/streetnotices');
const { signature } = require('../src/routes/twilioinbound');
const helper = require('./helpers/muni');

async function withoutMail(fn) {
  const was = process.env.POSTMARK_SERVER_TOKEN; delete process.env.POSTMARK_SERVER_TOKEN;
  try { return await fn(); } finally { process.env.POSTMARK_SERVER_TOKEN = was; }
}
async function createMuniTenant(b, opts) {
  const M = await withoutMail(() => helper.createMuniTenant(b, opts));
  const add = M.addLogin;
  M.addLogin = (role, extra) => withoutMail(() => add(role, extra));
  return M;
}

let server; let base; let tw; let pm;
const texts = []; const mails = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let phoneN = Number(String(Date.now()).slice(-4));
const newPhone = () => `484-555-${String((phoneN++) % 10000).padStart(4, '0')}`;
const keyOf = (p) => String(p).replace(/\D/g, '').slice(-10);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
let A; let B; let crewA; let deskA; let ski;

async function api(method, p, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': raw ? 'image/jpeg' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${String(r.text).slice(0, 400)}`); return r.body; };
const is = (r, status, why = '') => assert.equal(r.status, status, `${why} ${String(r.text).slice(0, 300)}`);
const q = async (sql, params) => (await pool.query(sql, params))[0];
const textsTo = (phone) => texts.filter((t) => keyOf(t.To) === keyOf(phone));
const mailsTo = (email) => mails.filter((m) => m.To === email);
const todayNY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };

async function addStreets(tenantId, names) {
  const out = {};
  for (const n of names) { const [r] = await pool.query('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [tenantId, n]); out[n] = r.insertId; }
  return out;
}
const feature = async (M, body) => ok(await api('POST', '/assets/map/features', { token: M.token, body }), 201);
async function textBack(from, word, to = '+16105550000') {
  const params = { AccountSid: 'ACtest', MessageSid: `SM${Date.now()}${Math.random()}`.slice(0, 34), From: `+1${keyOf(from)}`, To: to, Body: word };
  const url = `${base}/api/v1/twilio/sms`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', url, params) }, body: new URLSearchParams(params).toString() });
  assert.equal(res.status, 200, await res.text());
}
async function settled(M, id) {
  for (let i = 0; i < 200; i += 1) {
    const n = ok(await api('GET', `/street-notices/${id}`, { token: M.token }));
    if (!n.summary.queued && !n.summary.sending) { await SN.idle(); return n; }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the notice never finished sending');
}

let streets; const LAT = 40.1; const LNG = -75.4;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
  let n = 0;
  tw = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { texts.push(Object.fromEntries(new URLSearchParams(d))); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` })); }); });
  pm = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  const all = { water: true, sewer: true, stormwater: true, solidwaste: true };
  A = await createMuniTenant(base, { slug: `ut-a-${suffix}`, name: `Riverbend Utilities ${suffix}`, modules: all });
  B = await createMuniTenant(base, { slug: `ut-b-${suffix}`, name: `Other Borough ${suffix}`, modules: all });
  crewA = await A.addLogin('staff');
  deskA = await A.addLogin('counter');
  streets = await addStreets(A.id, ['Market Street', 'Bridge Street', 'Church Street', 'High Street']);
  quiet.clock.now = () => new Date(Date.UTC(2026, 10, 11, 17, 0, 0));
  // A ski area, to show none of this reaches it.
  const made = await api('POST', '/platform/tenants', { headers: { 'x-platform-key': 'test-bootstrap-key' }, body: { slug: `ut-ski-${suffix}`, name: `Ski ${suffix}`, timezone: 'America/New_York', billing: 'comped', owner: { email: `o@ut-ski-${suffix}.test`, password: helper.PASSWORD, first_name: 'S', last_name: 'K' } } });
  is(made, 201);
  ski = ok(await withoutMail(() => api('POST', '/auth/login', { body: { tenant: `ut-ski-${suffix}`, login: `o@ut-ski-${suffix}.test`, password: helper.PASSWORD } }))).token;
  assert.ok(ski);
});
test.after(async () => { await SN.idle(); await new Promise((r) => server.close(r)); tw.close(); pm.close(); await pool.end(); });

// ---------------------------------------------------------------- main breaks
test('main breaks: valves to shut along the main first, an urgent work order, the history, and 3 breaks in 5 years raise its condition', async () => {
  const main = await feature(A, { kind: 'potable_line', points: [[LAT, LNG], [LAT, LNG - 0.004]], name: 'Market Street water main', tag: `WM-${suffix}`.slice(0, 30), size: '6 in', material: 'Cast iron', street_id: streets['Market Street'], condition_score: 2, criticality: 4 });
  assert.equal(main.street, 'Market Street');
  const onMain = await feature(A, { kind: 'valve', points: [[LAT + 0.00003, LNG - 0.0008]], tag: `V-1${suffix}`.slice(0, 30), street_id: streets['Market Street'] });
  const offMain = await feature(A, { kind: 'valve', points: [[LAT + 0.0009, LNG - 0.001]], tag: `V-2${suffix}`.slice(0, 30), street_id: streets['Bridge Street'] });
  const far = await feature(A, { kind: 'valve', points: [[LAT + 0.01, LNG]], tag: `V-3${suffix}`.slice(0, 30) });
  const hydrant = await feature(A, { kind: 'fire_hydrant', points: [[LAT, LNG - 0.001]], tag: `H-1${suffix}`.slice(0, 30), street_id: streets['Market Street'] });

  const cand = ok(await api('GET', `/water/main-breaks/valves?main_id=${main.id}&lat=${LAT}&lng=${LNG - 0.001}`, { token: crewA.token }));
  const ids = cand.valves.map((v) => v.id);
  assert.ok(ids.includes(onMain.id) && ids.includes(offMain.id), 'both near valves are candidates');
  assert.ok(!ids.includes(far.id), 'a valve over 150 m away is not');
  assert.equal(ids[0], onMain.id, 'the valve on the main comes first');
  assert.equal(cand.valves[0].on_main, true);
  assert.ok(!ids.includes(hydrant.id), 'a hydrant is not a valve');

  const today = plus(todayNY(), -1); // yesterday: every time below has passed, whatever the hour the test runs
  const made = ok(await api('POST', '/water/main-breaks', { token: crewA.token, body: { main_id: main.id, broke_at: `${today} 06:10`, lat: LAT, lng: LNG - 0.001, location: 'In front of 214 Market Street', cause: 'corrosion',
    customers_out: 14, boil_water: false, water_off_at: `${today} 06:40`, valves: [{ valve_id: onMain.id, closed_at: `${today} 06:40`, turns: 21 }] } }), 201);
  assert.equal(made.pipe_material, 'Cast iron', 'the pipe defaults from the main');
  assert.equal(made.street, 'Market Street');
  assert.ok(made.work_order_id, 'a work order is opened');
  const wo = ok(await api('GET', `/ops/work-orders/${made.work_order_id}`, { token: A.token }));
  assert.equal(wo.priority, 'urgent'); assert.equal(wo.map_feature_id, main.id);
  is(await api('POST', '/water/main-breaks', { token: crewA.token, body: { main_id: hydrant.id, broke_at: `${today} 06:10` } }), 400, 'a hydrant is not a main');
  is(await api('POST', '/water/main-breaks', { token: crewA.token, body: { main_id: main.id, broke_at: `${today} 06:10`, valves: [{ valve_id: hydrant.id }] } }), 400, 'only valves are operated');
  is(await api('GET', '/water/main-breaks', { token: deskA.token }), 403, 'the front desk does not work breaks');

  // Repaired: water back on, the valves opened again.
  const fixed = ok(await api('PATCH', `/water/main-breaks/${made.id}`, { token: crewA.token, body: { repair: 'Full-circle repair clamp, 6 in', repaired_at: `${today} 11:00`, water_on_at: `${today} 11:30`, valves: [{ valve_id: onMain.id, closed_at: `${today} 06:40`, opened_at: `${today} 11:20`, turns: 21 }] } }));
  assert.equal(fixed.status, 'repaired'); assert.equal(fixed.hours_out, 4.8);
  const one = ok(await api('GET', `/water/main-breaks/${made.id}`, { token: A.token }));
  assert.equal(one.valve_list.length, 1); assert.equal(one.valve_list[0].opened_at.slice(11, 16), '11:20');

  // Two more in the past five years: the third raises the condition to Poor (4).
  ok(await api('POST', '/water/main-breaks', { token: A.token, body: { main_id: main.id, broke_at: `${plus(today, -400)} 02:00`, cause: 'frost', work_order: false } }), 201);
  let f = ok(await api('GET', `/assets/map/features/${main.id}`, { token: A.token }));
  assert.equal(f.condition_score, 2, 'two breaks do not change it');
  assert.equal(f.main_breaks.total, 2);
  const third = ok(await api('POST', '/water/main-breaks', { token: A.token, body: { main_id: main.id, broke_at: `${plus(today, -900)} 14:00`, cause: 'age', work_order: false } }), 201);
  assert.equal(third.condition_raised, 4);
  f = ok(await api('GET', `/assets/map/features/${main.id}`, { token: A.token }));
  assert.equal(f.condition_score, 4); assert.equal(f.main_breaks.in_5_years, 3); assert.equal(f.risk.score, 16);
  const mains = ok(await api('GET', '/water/mains', { token: A.token })).data;
  assert.equal(mains.find((m) => m.id === main.id).breaks_5y, 3);
  const csv = await api('GET', '/water/main-breaks/export.csv', { token: A.token });
  assert.match(csv.text, /Market Street water main/); assert.match(csv.text, /Corrosion/);

  // Another municipality never sees it; a ski area has no Water.
  is(await api('GET', `/water/main-breaks/${made.id}`, { token: B.token }), 404);
  is(await api('PATCH', `/water/main-breaks/${made.id}`, { token: B.token, body: { notes: 'x' } }), 404);
  is(await api('GET', `/water/main-breaks/valves?main_id=${main.id}`, { token: B.token }), 404);
  is(await api('GET', '/water/main-breaks', { token: ski }), 403);
  is(await api('DELETE', `/water/main-breaks/${third.id}`, { token: crewA.token }), 403, 'only a manager deletes');
  ok(await api('DELETE', `/water/main-breaks/${third.id}`, { token: A.token }));
});

test('work orders: any map item can be picked, found by tag, kind or street', async () => {
  const v = await feature(A, { kind: 'valve', points: [[LAT + 0.002, LNG - 0.002]], tag: `V-114-${suffix}`.slice(0, 30), street_id: streets['Church Street'] });
  const mh = await feature(A, { kind: 'sewer_manhole', points: [[LAT + 0.002, LNG - 0.0025]], tag: `MH-9-${suffix}`.slice(0, 30), street_id: streets['Church Street'] });
  const byTag = ok(await api('GET', `/assets/map/search?q=${encodeURIComponent(`V-114-${suffix}`.slice(0, 30))}`, { token: crewA.token })).data;
  assert.equal(byTag[0].id, v.id);
  assert.match(byTag[0].label, /Valve/); assert.match(byTag[0].label, /Church Street/);
  const byStreet = ok(await api('GET', '/assets/map/search?q=Church', { token: crewA.token })).data.map((x) => x.id);
  assert.ok(byStreet.includes(v.id) && byStreet.includes(mh.id), 'found by street');
  const byKind = ok(await api('GET', '/assets/map/search?q=manhole', { token: crewA.token })).data;
  assert.ok(byKind.some((x) => x.id === mh.id) && byKind.every((x) => x.kind === 'sewer_manhole'), 'a kind word finds that kind');
  const mainsOnly = ok(await api('GET', '/assets/map/search?q=Church&kinds=valve', { token: crewA.token })).data;
  assert.ok(mainsOnly.every((x) => x.kind === 'valve'));
  const w = ok(await api('POST', '/ops/work-orders', { token: crewA.token, body: { title: 'Raise manhole frame', map_feature_id: mh.id } }), 201);
  assert.equal(ok(await api('GET', `/ops/work-orders/${w.id}`, { token: crewA.token })).feature_kind_label, 'Sewer manhole');
  assert.equal(ok(await api('GET', '/assets/map/search?q=Church', { token: B.token })).data.length, 0, 'another municipality finds nothing of A’s');
});

// ---------------------------------------------------------------- the water customer list
test('water customers: contacts kept only with consent, STOP stays stopped, the preview counts three ways, door hangers are addresses only', async () => {
  const M = await createMuniTenant(base, { slug: `ut-wc-${suffix}`, modules: { water: true } });
  const st = await addStreets(M.id, ['Walnut Street', 'Elm Street']);
  const p1 = newPhone(); const p2 = newPhone(); const pStop = newPhone(); const pSigned = newPhone();
  const e1 = `cust1.${suffix}@example.com`;
  // One phone already texted STOP to this municipality before the import.
  await pool.query("INSERT INTO alert_addresses (tenant_id, channel, addr, stopped_at, stop_source) VALUES (?, 'sms', ?, UTC_TIMESTAMP(), 'text_reply')", [M.id, keyOf(pStop)]);
  // A resident signed up for alerts at 10 Walnut Street (they are reached as a sign-up, not twice).
  await pool.query("INSERT INTO alert_addresses (tenant_id, channel, addr, confirmed_at, confirmed_by) VALUES (?, 'sms', ?, UTC_TIMESTAMP(), 'code')", [M.id, keyOf(pSigned)]);
  const [res] = await pool.query("INSERT INTO residents (tenant_id, name, phone, street_id, house_number) VALUES (?, 'Sam Signed', ?, ?, '10')", [M.id, pSigned, st['Walnut Street']]);
  await pool.query("INSERT INTO alert_signups (tenant_id, resident_id, street_id, house_number, house_no, phone, topics, by_text, status, source, confirmed_at) VALUES (?, ?, ?, '10', 10, ?, 'water', 1, 'active', 'staff', UTC_TIMESTAMP())", [M.id, res.insertId, st['Walnut Street'], pSigned]);

  const csv = [
    'Account Number,Service Address,Unit,Phone,Email',
    `A-100,10 Walnut St,,${pSigned},`,
    `A-101,12 Walnut Street,,${p1},${e1}`,
    `A-102,14 Walnut Street,,${pStop},`,
    'A-103,16 Walnut Street,,,',
    `A-104,18 Walnut Street,2B,${p2},`,
    'A-105,5 Elm Street,,,',
    'A-106,99 Nowhere Lane,,,',
  ].join('\n');
  // Without the consent attestation no phone or email is kept.
  const first = ok(await api('POST', '/street-notices/service-addresses/import', { token: M.token, body: { csv, file_name: 'billing.csv' } }));
  assert.deepEqual([first.added, first.contacts_kept, first.contacts_dropped, first.skipped.length], [6, 0, 4, 1]);
  assert.equal((await q('SELECT COUNT(*) AS n FROM service_addresses WHERE tenant_id = ? AND (phone IS NOT NULL OR email IS NOT NULL)', [M.id]))[0].n, 0);
  is(await api('POST', '/street-notices/service-addresses/import', { token: M.token, body: { csv, consent: true } }), 400, 'the attestation needs how they agreed');
  const crew = await M.addLogin('staff');
  is(await api('POST', '/street-notices/service-addresses/import', { token: crew.token, body: { csv } }), 403, 'only a manager imports');
  // With it: the same addresses (matched by account), now with their contacts.
  const second = ok(await api('POST', '/street-notices/service-addresses/import', { token: M.token, body: { csv, consent: true, consent_note: 'Water bill sign-up form, text and email box ticked' } }));
  assert.deepEqual([second.added, second.updated, second.contacts_kept, second.stopped], [0, 6, 5, 1]);
  const audits = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND entity = 'service_addresses' AND action = 'import' ORDER BY id", [M.id]);
  assert.equal(audits.length, 2);
  const detail = (a) => (typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail);
  assert.ok(!audits.some((a) => JSON.stringify(detail(a)).includes(keyOf(p1)) || JSON.stringify(detail(a)).includes(e1)), 'the audit log names no phone or email');
  assert.equal(detail(audits[1]).consent_attested, true);
  const imports = ok(await api('GET', '/street-notices/service-addresses/imports', { token: M.token })).data;
  assert.equal(imports[0].consent, 1); assert.match(imports[0].consent_note, /bill sign-up/); assert.ok(imports[0].by_name);
  const stopped = (await q("SELECT stopped_at FROM alert_addresses WHERE tenant_id = ? AND channel = 'sms' AND addr = ?", [M.id, keyOf(pStop)]))[0];
  assert.ok(stopped.stopped_at, 'a phone that texted STOP stays stopped');
  const crewList = await api('GET', `/street-notices/service-addresses?street_id=${st['Walnut Street']}`, { token: crew.token });
  is(crewList, 403, 'the crew sees counts, not the contacts');
  assert.equal(ok(await api('GET', '/street-notices/service-addresses/streets', { token: crew.token })).total, 6);

  // The preview: 1 signed-up resident; on the customer list 3 addresses with a phone or email that can be used (10 is the
  // sign-up's own phone, 12, 18); 14 (STOP) and 16 (no contact) by door hanger. 5 Elm Street is not on the street picked.
  const areas = [{ street_id: st['Walnut Street'] }];
  const pre = ok(await api('POST', '/street-notices/preview', { token: M.token, body: { type: 'water_outage', areas } }));
  assert.deepEqual([pre.residents, pre.service_addresses, pre.door_hangers, pre.customers], [1, 3, 2, 5]);
  assert.deepEqual([pre.texts, pre.emails, pre.opted_out], [3, 1, 1], 'one text each to the sign-up, 12 and 18; one email; the stopped phone skipped');
  const paving = ok(await api('POST', '/street-notices/preview', { token: M.token, body: { type: 'paving', areas } }));
  assert.deepEqual([paving.texts, paving.service_addresses, paving.door_hangers, paving.customers], [0, 0, 0, 0], 'a paving notice is not for the customer list (and the sign-up chose water only)');

  const n = ok(await api('POST', '/street-notices', { token: M.token, body: { type: 'water_outage', title: 'Main break', sms_text: 'Water is off on Walnut Street. Back by 5 PM.', body: 'Crews are repairing a main.', areas } }), 201);
  const hang = ok(await api('GET', `/street-notices/${n.id}/door-hangers`, { token: crew.token }));
  assert.deepEqual(hang.addresses.map((a) => a.house_number), ['14', '16']);
  assert.ok(!JSON.stringify(hang).includes(keyOf(pStop)) && !JSON.stringify(hang).includes('A-10'), 'addresses only: no phone or account');
  const hangCsv = await api('GET', `/street-notices/${n.id}/door-hangers?format=csv`, { token: crew.token });
  assert.match(hangCsv.text, /^"?street"?,"?house_number"?,"?unit"?/); assert.match(hangCsv.text, /Walnut Street/);
  is(await api('GET', `/street-notices/${n.id}/door-hangers`, { token: A.token }), 404, 'another municipality');

  const sentBefore = texts.length;
  ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true } }));
  const done = await settled(M, n.id);
  assert.equal(done.summary.texts_sent, 3); assert.equal(done.summary.emails_sent, 1);
  assert.equal(textsTo(p1).length, 1); assert.equal(textsTo(pSigned).length, 1, 'the sign-up gets one text, not two');
  assert.equal(textsTo(pStop).length, 0);
  assert.ok(texts.slice(sentBefore).every((t) => /Reply STOP/.test(t.Body)));
  const mail = mailsTo(e1).pop();
  assert.match(mail.TextBody, /on file with .* for water service/); assert.match(mail.TextBody, /To stop these emails: http/);
  const rows = await q('SELECT resident_id, service_address_id FROM street_notice_deliveries WHERE tenant_id = ? AND notice_id = ?', [M.id, n.id]);
  assert.equal(rows.filter((r) => r.service_address_id).length, 4, 'customer deliveries carry the service address');
  // STOP after the send: the follow-up skips that customer.
  await textBack(p1, 'STOP');
  const up = ok(await api('POST', `/street-notices/${n.id}/updates`, { token: M.token, body: { sms_text: 'Water is back on.' } }));
  assert.equal(up.texts, 2); assert.equal(up.opted_out, 1);
  await settled(M, n.id);
  assert.equal(textsTo(p1).length, 1, 'no follow-up after STOP');

  // A new file that replaces the list ends 16 and 18 Walnut and removes their contacts at once.
  const third = ok(await api('POST', '/street-notices/service-addresses/import', { token: M.token, body: { csv: csv.split('\n').filter((l) => !/A-103|A-104/.test(l)).join('\n'), replace: true, consent: true, consent_note: 'Water bill sign-up form' } }));
  assert.equal(third.ended, 2);
  const ended = await q('SELECT phone, email, active FROM service_addresses WHERE tenant_id = ? AND house_number IN (\'16\', \'18\')', [M.id]);
  assert.ok(ended.every((r) => !r.active && !r.phone && !r.email));
  // The register: erasing a person blanks the contact on the customer list.
  const { REGISTRY } = require('../src/lib/personal');
  assert.ok(REGISTRY.some((e) => e.table === 'service_addresses' && e.erase.set && 'phone' in e.erase.set && 'account_number' in e.erase.set));
  ok(await api('POST', '/street-notices/service-addresses/clear', { token: M.token, body: { confirm: true } }));
  assert.equal(ok(await api('GET', '/street-notices/service-addresses/streets', { token: M.token })).total, 0);
});

// ---------------------------------------------------------------- stormwater
test('outfall screening: a failure lowers condition to at least 4; suspected illicit discharge opens a case; MS4 counts it', async () => {
  const templates = ok(await api('GET', '/assets/templates', { token: A.token })).data;
  const tpl = templates.find((t) => t.name === 'Outfall dry-weather screening');
  const of1 = await feature(A, { kind: 'storm_outfall', points: [[LAT - 0.003, LNG]], tag: `OF-07-${suffix}`.slice(0, 30), condition_score: 2, criticality: 2 });
  const of2 = await feature(A, { kind: 'storm_outfall', points: [[LAT - 0.003, LNG - 0.001]], tag: `OF-08-${suffix}`.slice(0, 30), condition_score: 1, criticality: 3 });
  const photo = async (f) => ok(await api('POST', `/assets/map/features/${f.id}/photos`, { token: crewA.token, raw: JPEG }), 201).id;
  const screen = async (f, illicit, flow = 'yes') => ok(await api('POST', `/assets/map/features/${f.id}/inspections`, { token: crewA.token, body: { template_id: tpl.id, items: [
    { key: 'flow', value: flow, photo_id: await photo(f) }, { key: 'color', value: flow === 'yes' ? 'Gray' : 'No flow' }, { key: 'odor', value: flow === 'yes' ? 'Chemical or soapy' : 'None' },
    { key: 'floatables', value: flow }, { key: 'illicit', value: illicit ? 'yes' : 'no', ...(illicit ? { note: 'Gray, soapy flow after 4 dry days' } : {}) }] } }), 201);
  const r = await screen(of1, true);
  assert.equal(r.result, 'fail'); assert.equal(r.condition_score, 4); assert.ok(r.case_id);
  let f = ok(await api('GET', `/assets/map/features/${of1.id}`, { token: A.token }));
  assert.equal(f.condition_score, 4); assert.equal(f.risk.label, 'Medium'); assert.equal(f.cases.length, 1);
  const c = ok(await api('GET', `/stormwater/cases/${r.case_id}`, { token: crewA.token }));
  assert.match(c.reference, /^IDD-\d{4}-\d{2}$/); assert.equal(c.outfall_id, of1.id); assert.match(c.description, /Gray/);
  // A second failed screening adds to the open case instead of opening another.
  const again = await screen(of1, true);
  assert.equal(again.case_id, r.case_id);
  assert.equal(ok(await api('GET', `/stormwater/cases/${r.case_id}`, { token: A.token })).entries.length, 2);
  // A clean screening changes nothing.
  const clean = await screen(of2, false, 'no');
  assert.equal(clean.result, 'pass'); assert.ok(!clean.case_id);
  assert.equal(ok(await api('GET', `/assets/map/features/${of2.id}`, { token: A.token })).condition_score, 1);

  // Tracing, then closed with a resolution.
  ok(await api('POST', `/stormwater/cases/${r.case_id}/entries`, { token: crewA.token, body: { kind: 'upstream', body: 'Dye test at inlet IN-404: dye reached the outfall', map_feature_id: of2.id } }), 201);
  ok(await api('PATCH', `/stormwater/cases/${r.case_id}`, { token: crewA.token, body: { status: 'source_found', suspected_source: 'Car wash floor drain tied to the storm sewer', responsible_party: 'Riverside Car Wash' } }));
  is(await api('PATCH', `/stormwater/cases/${r.case_id}`, { token: crewA.token, body: { status: 'closed' } }), 400, 'a resolution first');
  ok(await api('PATCH', `/stormwater/cases/${r.case_id}`, { token: crewA.token, body: { status: 'closed', resolution: 'Drain rerouted to the sanitary sewer; screened clean.' } }));
  is(await api('GET', `/stormwater/cases/${r.case_id}`, { token: B.token }), 404);
  is(await api('POST', `/stormwater/cases/${r.case_id}/entries`, { token: B.token, body: { kind: 'note', body: 'nope' } }), 404);

  // MS4: activities by measure, screenings done against the outfalls, the case, the pack.
  ok(await api('POST', '/stormwater/ms4/activities', { token: crewA.token, body: { kind: 'education', on_date: todayNY(), title: 'Storm drain markers with the Scouts', audience: 'Scout troop 12', people: 18 } }), 201);
  ok(await api('POST', '/stormwater/ms4/activities', { token: A.token, body: { kind: 'training', on_date: todayNY(), title: 'Spill response refresher', attendees: ['Luis Ortega', 'Dana Kim'] } }), 201);
  ok(await api('PUT', '/stormwater/ms4/settings', { token: A.token, body: { permit_number: 'PAG133701', screenings_required: 2 } }));
  is(await api('PUT', '/stormwater/ms4/settings', { token: crewA.token, body: { permit_number: 'x' } }), 403);
  const ms4 = ok(await api('GET', '/stormwater/ms4', { token: A.token }));
  assert.equal(ms4.sections.length, 6);
  assert.equal(ms4.sections[0].activities[0].people, 18);
  assert.deepEqual(ms4.sections[5].activities[0].attendees, ['Luis Ortega', 'Dana Kim']);
  assert.equal(ms4.screenings.required, 2); assert.equal(ms4.screenings.done, 2); assert.equal(ms4.screenings.illicit, 1);
  assert.ok(ms4.cases.some((x) => x.id === r.case_id));
  assert.match(ms4.permit_year.label, /^July 1, \d{4} to June 30, \d{4}$/);
  const pack = await api('GET', '/stormwater/ms4.csv', { token: A.token });
  assert.match(pack.text, /MCM 1/); assert.match(pack.text, /Illicit discharge case/); assert.match(pack.text, /Permit PAG133701/);
  assert.ok(!pack.text.includes('Dana Kim'), 'the pack counts who came to training, it does not list them');
  is(await api('GET', '/stormwater/ms4', { token: ski }), 403);
});

// ---------------------------------------------------------------- sewer, Chapter 94
test('Chapter 94: run hours by month x each pump’s rated flow, the peak month, connections and overflows, and the CSV', async () => {
  const M = await createMuniTenant(base, { slug: `ut-94-${suffix}`, modules: { sewer: true } });
  const tpl = ok(await api('GET', '/assets/templates', { token: M.token })).data.find((t) => t.name === 'Pump station round');
  const ps = await feature(M, { kind: 'lift_station', points: [[LAT, LNG]], name: 'Mill Street pump station', tag: 'PS-1' });
  const year = Number(todayNY().slice(0, 4)) - 1;
  // Readings at the start of three months: 100 h, then +200 h in February, +300 h in March (pump 1); pump 2 half of that.
  const read = async (date, h1, h2) => {
    const [ins] = await pool.query("INSERT INTO asset_inspections (tenant_id, map_feature_id, template_id, template_name, result, items, done_at) VALUES (?, ?, ?, 'Pump station round', 'pass', '[]', ?)", [M.id, ps.id, tpl.id, `${date} 08:00:00`]);
    await pool.query("INSERT INTO station_run_hours (tenant_id, map_feature_id, inspection_id, item_key, label, hours, read_at) VALUES (?, ?, ?, 'pump1_hours', 'Pump 1 run hour meter', ?, ?), (?, ?, ?, 'pump2_hours', 'Pump 2 run hour meter', ?, ?)",
      [M.id, ps.id, ins.insertId, h1, `${date} 08:00:00`, M.id, ps.id, ins.insertId, h2, `${date} 08:00:00`]);
  };
  await read(`${year}-01-31`, 1000, 500); await read(`${year}-02-28`, 1200, 600); await read(`${year}-03-31`, 1500, 750);
  let r = ok(await api('GET', `/sewer/ch94?year=${year}`, { token: M.token }));
  assert.deepEqual(r.missing_rates, ['Mill Street pump station'], 'it says which station needs its rated flows');
  is(await api('PUT', `/sewer/ch94/stations/${ps.id}/pumps`, { token: (await M.addLogin('staff')).token, body: { pumps: { pump1_hours: 300 } } }), 403);
  ok(await api('PUT', `/sewer/ch94/stations/${ps.id}/pumps`, { token: M.token, body: { pumps: { pump1_hours: 300, pump2_hours: 250 } } }));
  r = ok(await api('GET', `/sewer/ch94?year=${year}`, { token: M.token }));
  const s = r.stations[0];
  const feb = s.months.find((m) => m.month === `${year}-02`);
  assert.equal(feb.hours, 300); assert.equal(feb.gallons, 200 * 60 * 300 + 100 * 60 * 250);
  const mar = s.months.find((m) => m.month === `${year}-03`);
  assert.equal(mar.gallons, 300 * 60 * 300 + 150 * 60 * 250);
  assert.equal(s.annual.peak_month, `${year}-03`);
  assert.equal(r.system.annual.peak_month, `${year}-03`);
  assert.equal(mar.mgd, Math.round(((300 * 60 * 300 + 150 * 60 * 250) / 31 / 1e6) * 10000) / 10000);
  ok(await api('PUT', `/sewer/ch94/years/${year}`, { token: M.token, body: { new_edus: 42, projected_edus: 180, notes: 'Riverside Commons phase 2' } }));
  ok(await api('POST', '/sewer/overflows', { token: M.token, body: { map_feature_id: ps.id, started_at: `${year}-03-14 02:00`, ended_at: `${year}-03-14 05:30`, gallons: 3500, cause: 'power', reached_water: true, reported_to_dep_at: `${year}-03-14 07:00` } }), 201);
  is(await api('POST', '/sewer/overflows', { token: M.token, body: { started_at: `${year}-03-14 02:00` } }), 400, 'it needs a place');
  r = ok(await api('GET', `/sewer/ch94?year=${year}`, { token: M.token }));
  assert.equal(r.connections[0].new_edus, 42); assert.equal(r.overflows[0].gallons, 3500); assert.equal(r.overflows[0].where, 'PS-1');
  const csv = await api('GET', `/sewer/ch94.csv?year=${year}`, { token: M.token });
  const lines = csv.text.split('\r\n');
  assert.equal(lines[0], 'year,month,station,station_tag,pump,run_hours,rated_flow_gpm,estimated_gallons,days,average_daily_flow_mgd');
  assert.ok(lines.some((l) => l.includes(`"${year}-02","Mill Street pump station","PS-1","Pump 1 run hour meter","200","300","3600000"`)));
  assert.ok(lines.some((l) => l.includes('"Year","All stations"')));
  is(await api('GET', `/sewer/ch94?year=${year}`, { token: A.token }).then((x) => ({ status: x.body.stations.some((st) => st.id === ps.id) ? 500 : 200, text: '' })), 200, 'A never sees M’s station');
  is(await api('PUT', `/sewer/ch94/stations/${ps.id}/pumps`, { token: A.token, body: { pumps: { pump1_hours: 1 } } }), 404);
});

// ---------------------------------------------------------------- bulk pickup route order
test('bulk pickup: the stop list follows the manager’s street order and house number direction; new streets go last with a note', async () => {
  const day = (() => { let d = plus(todayNY(), 1); while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 3) d = plus(d, 1); return d; })(); // a Wednesday
  let k = 0;
  const book = async (street, house) => pool.query("INSERT INTO bulk_bookings (tenant_id, reference, view_token, street_id, house_number, collection_date, status, total_cents, pay_method, pay_status, source) VALUES (?, ?, ?, ?, ?, ?, 'booked', 0, 'free', 'not_needed', 'staff')",
    [A.id, `T${String(++k).padStart(4, '0')}`, require('crypto').randomBytes(16).toString('hex'), streets[street], house, day]);
  await book('Market Street', '12'); await book('Market Street', '210'); await book('Bridge Street', '5'); await book('Bridge Street', '41'); await book('High Street', '7'); await book('Church Street', '3');
  // Without a route: by street name.
  let d = ok(await api('GET', `/solid-waste/day?date=${day}`, { token: crewA.token }));
  assert.deepEqual(d.stops.map((s) => s.street), ['Bridge Street', 'Bridge Street', 'Church Street', 'High Street', 'Market Street', 'Market Street']);
  is(await api('PUT', '/solid-waste/route', { token: crewA.token, body: { weekday: 3, streets: [] } }), 403);
  ok(await api('PUT', '/solid-waste/route', { token: A.token, body: { weekday: 3, streets: [{ street_id: streets['Market Street'], direction: 'down' }, { street_id: streets['Bridge Street'] }, { street_id: streets['Church Street'] }] } }));
  d = ok(await api('GET', `/solid-waste/day?date=${day}`, { token: crewA.token }));
  assert.deepEqual(d.stops.map((s) => `${s.house_number} ${s.street}`), ['210 Market Street', '12 Market Street', '5 Bridge Street', '41 Bridge Street', '3 Church Street', '7 High Street']);
  assert.deepEqual(d.route.new_streets, ['High Street']);
  const route = ok(await api('GET', '/solid-waste/route?weekday=3', { token: crewA.token }));
  assert.deepEqual(route.route.map((x) => x.name), ['Market Street', 'Bridge Street', 'Church Street']);
  assert.ok(route.not_in_route.some((x) => x.name === 'High Street'));
  is(await api('PUT', '/solid-waste/route', { token: B.token, body: { weekday: 3, streets: [{ street_id: streets['Market Street'] }] } }), 404, 'another municipality’s street');
});

// ---------------------------------------------------------------- repeat callers and duplicates
test('requests: an open pothole on the same block is shown before saving; a caller’s phone finds their earlier requests (staff only)', async () => {
  const meta = ok(await api('GET', '/requests/meta', { token: A.token }));
  const pothole = meta.categories.find((c) => c.name === 'Pothole');
  const light = meta.categories.find((c) => /light/i.test(c.name));
  const phone = newPhone();
  const first = ok(await api('POST', '/requests', { token: deskA.token, body: { category_id: pothole.id, source: 'phone', street_id: streets['Market Street'], house_number: '111', description: 'Deep pothole by the curb', priority: 'normal', contact: { name: 'Rae Caller', phone } } }), 201);
  const sim = ok(await api('GET', `/requests/checks/similar?category_id=${pothole.id}&street_id=${streets['Market Street']}&house_number=115`, { token: crewA.token })).matches;
  assert.equal(sim.length, 1); assert.equal(sim[0].request_id, first.id);
  assert.match(sim[0].words, new RegExp(`^Open: ${first.reference} pothole at 111 Market Street, reported today$`));
  assert.equal(ok(await api('GET', `/requests/checks/similar?category_id=${pothole.id}&street_id=${streets['Market Street']}&house_number=420`, { token: crewA.token })).matches.length, 0, 'another block');
  assert.equal(ok(await api('GET', `/requests/checks/similar?category_id=${light.id}&street_id=${streets['Market Street']}&house_number=111`, { token: crewA.token })).matches.length, 0, 'another category');
  // A work order the crew opened themselves on the block counts too, and a new request can be linked to it.
  const wo = ok(await api('POST', '/ops/work-orders', { token: A.token, body: { title: 'Patch pothole', location: '130 Market Street' } }), 201);
  const both = ok(await api('GET', `/requests/checks/similar?category_id=${pothole.id}&street_id=${streets['Market Street']}&house_number=125`, { token: deskA.token })).matches;
  assert.ok(both.some((m) => m.type === 'work_order' && m.work_order_id === wo.id && /^Open: work order/.test(m.words)));
  const second = ok(await api('POST', '/requests', { token: deskA.token, body: { category_id: pothole.id, source: 'phone', street_id: streets['Market Street'], house_number: '128', priority: 'normal', contact: { phone } } }), 201);
  ok(await api('POST', '/requests/checks/link', { token: deskA.token, body: { request_id: second.id, work_order_id: wo.id } }));
  ok(await api('POST', `/ops/work-orders/${wo.id}/status`, { token: A.token, body: { status: 'done', resolution: 'Hot patched' } }));
  assert.equal(ok(await api('GET', `/requests/${second.id}`, { token: deskA.token })).status, 'fixed', 'finishing the work order fixed the linked request');
  is(await api('POST', '/requests/checks/link', { token: deskA.token, body: { request_id: first.id, work_order_id: wo.id } }), 409, 'a closed work order');
  // The caller's earlier requests, by phone: Front desk and managers only.
  const calls = ok(await api('GET', `/requests/checks/callers?phone=${encodeURIComponent(phone)}`, { token: deskA.token })).requests;
  assert.deepEqual(calls.map((c) => c.id).sort(), [first.id, second.id].sort());
  assert.ok(!JSON.stringify(calls).includes(keyOf(phone)), 'the answer does not repeat the phone');
  is(await api('GET', `/requests/checks/callers?phone=${encodeURIComponent(phone)}`, { token: crewA.token }), 403);
  is(await api('GET', '/requests/checks/callers?phone=12', { token: deskA.token }), 400);
  assert.equal(ok(await api('GET', `/requests/checks/callers?phone=${encodeURIComponent(phone)}`, { token: B.token })).requests.length, 0);
  const logged = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'caller_lookup' ORDER BY id DESC LIMIT 1", [A.id]);
  assert.ok(logged.length && !JSON.stringify(logged[0].detail).includes(keyOf(phone)));
  // The public pages never answer it.
  is(await api('GET', `/public/${A.slug}/requests/checks/callers?phone=${encodeURIComponent(phone)}`), 404);
});
