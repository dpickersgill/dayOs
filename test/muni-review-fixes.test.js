'use strict';

// Fixes from the independent review of 2026.11.19 (the municipal edition). Every test goes through the real HTTP routes,
// with a fake Twilio and a fake Postmark that keep what is sent.
//   1  a phone or email typed on a public form never reaches a resident's manage link, addresses or record
//   2  texting numbers are set by the platform operator, are unique, and STOP to the shared number covers everyone on it
//   3  the open-requests map loads Leaflet from a build-stamped page
//   4  the public map's rounding cannot be reversed from the longitude step
//   5  public forms cannot be used to text or email a stranger again and again; requests and bookings keep what was typed
//   6  the minor findings
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.PLATFORM_RATE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT = '100000';
process.env.ALERTS_RATE_LIMIT = '100000';
process.env.BULK_RATE_LIMIT = '100000';
process.env.USERS_RATE_LIMIT = '100000';
process.env.REPORT_RATE_LIMIT = '100000';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.TWILIO_SENDERS = '+16105550001, +1 (610) 555-0002';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'alerts@verdynt.test';
process.env.JOBS_KEY = 'test-jobs-key-review';

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
const newPhone = () => `267-555-${String((phoneN++) % 10000).padStart(4, '0')}`;
const keyOf = (p) => String(p).replace(/\D/g, '').slice(-10);
let A;

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${String(r.text).slice(0, 400)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
const textsTo = (phone) => texts.filter((t) => keyOf(t.To) === keyOf(phone));
const mailsTo = (email) => mails.filter((m) => m.To === email);
const lastCode = (phone) => { const t = textsTo(phone).reverse().find((x) => /your code is (\d{6})/.test(x.Body)); return t ? /your code is (\d{6})/.exec(t.Body)[1] : null; };
const emailToken = (email) => { const m = mailsTo(email.toLowerCase()).reverse().find((x) => /\/email\//.test(x.TextBody)); return /\/email\/([^\s]+)/.exec(m.TextBody)[1]; };
const tokenOf = (manage) => manage.split('/manage/')[1];

async function addStreets(tenantId, names) {
  const out = {};
  for (const n of names) { const [r] = await pool.query('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [tenantId, n]); out[n] = r.insertId; }
  return out;
}
/** Waits until nothing of this notice is waiting to be sent. */
async function settled(M, id) {
  for (let i = 0; i < 200; i += 1) {
    const n = ok(await api('GET', `/street-notices/${id}`, { token: M.token }));
    if (!n.summary.queued && !n.summary.sending) { await SN.idle(); return n; }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the notice never finished sending');
}
async function sendNotice(M, streetId, title) {
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: { type: 'water_outage', title, sms_text: `${title}: water is off. Back by 5 PM.`, body: 'Crews are repairing a main.', areas: [{ street_id: streetId }] } }), 201);
  ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true } }));
  return settled(M, n.id);
}
/** Signs a text reply the way Twilio posts it. */
async function textBack(from, word, to = '+16105550000') {
  const params = { AccountSid: 'ACtest', MessageSid: `SM${Date.now()}${Math.random()}`.slice(0, 34), From: `+1${keyOf(from)}`, To: to, Body: word };
  const url = `${base}/api/v1/twilio/sms`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', url, params) }, body: new URLSearchParams(params).toString() });
  assert.equal(res.status, 200, await res.text());
}
const platform = (method, p, body) => api(method, `/platform${p}`, { body, headers: { 'x-platform-key': process.env.BOOTSTRAP_KEY } });

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
  let n = 0;
  tw = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { texts.push(Object.fromEntries(new URLSearchParams(d))); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` })); }); });
  pm = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  A = await createMuniTenant(base, { slug: `rf-a-${suffix}`, name: `Riverbend Review ${suffix}`, modules: { solidwaste: true } });
  A.streets = await addStreets(A.id, ['Dayton Street', 'Main Street', 'Bridge Street', 'Old Mill Road']);
  quiet.clock.now = () => new Date(Date.UTC(2026, 10, 11, 17, 0, 0)); // noon in Pennsylvania
});
test.after(async () => { await SN.idle(); await new Promise((r) => server.close(r)); tw.close(); pm.close(); await pool.end(); });

// ================================================================ 1. alert sign-ups and manage links
/** Everything a manage link shows, as one string, to search for things it must not hold. */
const shown = (view) => JSON.stringify(view);

test('1: the victim\'s phone and the attacker\'s email: the attacker\'s manage link shows and changes only the attacker\'s own sign-up', async () => {
  const S = A.streets;
  const victimPhone = newPhone();
  const attackerEmail = `mallory.${suffix}@example.com`;
  // The victim signs up by phone and confirms with the texted code.
  const v = ok(await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: S['Dayton Street'], house_number: '418', unit: 'Apt 3', name: 'Victor Victim', phone: victimPhone, topics: ['streets'] } }), 201);
  const victimManage = ok(await api('POST', `/public/${A.slug}/alerts/confirm`, { body: { ref: v.ref, code: lastCode(victimPhone) } })).manage;
  const [victimSignup] = await q("SELECT id, resident_id FROM alert_signups WHERE tenant_id = ? AND street_id = ? AND house_number = '418'", [A.id, S['Dayton Street']]);
  const [victimBefore] = await q('SELECT * FROM residents WHERE tenant_id = ? AND id = ?', [A.id, victimSignup.resident_id]);
  assert.equal(victimBefore.email, null);

  // The attacker types the victim's phone and their own email, and confirms the email (the link comes to them).
  const a = ok(await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: S['Main Street'], house_number: '9', name: 'Mallory', phone: victimPhone, email: attackerEmail } }), 201);
  assert.equal(a.needs_code, true, 'the code for the phone goes to the phone, not to the attacker');
  const attackerManage = ok(await api('POST', `/public/${A.slug}/alerts/email`, { body: { token: emailToken(attackerEmail) } })).manage;
  assert.notEqual(tokenOf(attackerManage), tokenOf(victimManage));

  const view = ok(await api('GET', `/public/${A.slug}/alerts/manage/${tokenOf(attackerManage)}`));
  assert.equal(view.channel, 'email');
  assert.deepEqual(view.signups.map((s) => [s.street, s.house_number]), [['Main Street', '9']], 'only the attacker\'s own sign-up');
  for (const secret of ['418', 'Apt 3', 'Dayton', 'Victor', keyOf(victimPhone).slice(-4)]) assert.ok(!shown(view).includes(secret), `the attacker sees nothing of the victim (${secret})`);
  assert.equal(view.signups[0].texts, null, 'the unconfirmed phone on the attacker\'s form is not shown as on');

  // The attacker cannot stop or remove the victim's sign-up, or stop the victim's texts.
  assert.equal((await api('POST', `/public/${A.slug}/alerts/manage/${tokenOf(attackerManage)}`, { body: { action: 'remove', signup_id: victimSignup.id } })).status, 404);
  assert.equal((await api('POST', `/public/${A.slug}/alerts/manage/${tokenOf(attackerManage)}`, { body: { action: 'topics', signup_id: victimSignup.id, topics: [] } })).status, 404);
  assert.equal((await api('POST', `/public/${A.slug}/alerts/manage/${tokenOf(attackerManage)}`, { body: { action: 'stop', channel: 'sms' } })).status, 400);
  ok(await api('POST', `/public/${A.slug}/alerts/manage/${tokenOf(attackerManage)}`, { body: { action: 'stop' } })); // stops the attacker's own email only
  const [victimRow] = await q('SELECT status, topics FROM alert_signups WHERE id = ?', [victimSignup.id]);
  assert.deepEqual([victimRow.status, victimRow.topics], ['active', 'water,streets']);
  assert.equal((await q("SELECT stopped_at FROM alert_addresses WHERE tenant_id = ? AND channel = 'sms' AND addr = ?", [A.id, keyOf(victimPhone)]))[0].stopped_at, null);

  // The victim's record never got the attacker's email or name, and the attacker's sign-up is not the victim's.
  const [victimAfter] = await q('SELECT name, phone, email, street_id, house_number, unit FROM residents WHERE tenant_id = ? AND id = ?', [A.id, victimSignup.resident_id]);
  assert.deepEqual(victimAfter, { name: victimBefore.name, phone: victimBefore.phone, email: null, street_id: victimBefore.street_id, house_number: victimBefore.house_number, unit: victimBefore.unit });
  assert.equal((await q('SELECT COUNT(*) AS n FROM residents WHERE tenant_id = ? AND email = ? AND id = ?', [A.id, attackerEmail, victimSignup.resident_id]))[0].n, 0);
  const [attackerRow] = await q("SELECT resident_id FROM alert_signups WHERE tenant_id = ? AND email = ? AND by_email = 1", [A.id, attackerEmail]);
  assert.notEqual(attackerRow.resident_id, victimSignup.resident_id);
  // The attacker's pending phone sign-up joins nobody until the phone's own code is entered.
  assert.equal((await q("SELECT resident_id FROM alert_signups WHERE tenant_id = ? AND street_id = ? AND house_number = '9' AND phone IS NOT NULL", [A.id, S['Main Street']]))[0].resident_id, null);

  // The victim's own link still works and shows only the victim's address; the victim still gets alerts.
  const vv = ok(await api('GET', `/public/${A.slug}/alerts/manage/${tokenOf(victimManage)}`));
  assert.deepEqual(vv.signups.map((s) => [s.street, s.house_number, s.texts]), [['Dayton Street', '418', 'on']]);
  const before = textsTo(victimPhone).length;
  const sent = await sendNotice(A, S['Dayton Street'], 'Dayton main break');
  assert.ok(sent.summary.texts_sent >= 1);
  assert.equal(textsTo(victimPhone).length, before + 1, 'the victim still gets alerts');
});

test('1: the attacker\'s phone and the victim\'s email: the attacker\'s manage link shows and changes only the attacker\'s own sign-up', async () => {
  const S = A.streets;
  const victimEmail = `victoria.${suffix}@example.com`;
  const attackerPhone = newPhone();
  const v = ok(await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: S['Bridge Street'], house_number: '77', name: 'Victoria Victim', email: victimEmail, topics: ['trash'] } }), 201);
  assert.equal(v.needs_code, false);
  const victimManage = ok(await api('POST', `/public/${A.slug}/alerts/email`, { body: { token: emailToken(victimEmail) } })).manage;
  const [victimSignup] = await q("SELECT id, resident_id FROM alert_signups WHERE tenant_id = ? AND street_id = ? AND house_number = '77'", [A.id, S['Bridge Street']]);
  const [victimBefore] = await q('SELECT * FROM residents WHERE tenant_id = ? AND id = ?', [A.id, victimSignup.resident_id]);

  const a = ok(await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: S['Old Mill Road'], house_number: '3', name: 'Mallory', phone: attackerPhone, email: victimEmail } }), 201);
  const attackerManage = ok(await api('POST', `/public/${A.slug}/alerts/confirm`, { body: { ref: a.ref, code: lastCode(attackerPhone) } })).manage;
  const view = ok(await api('GET', `/public/${A.slug}/alerts/manage/${tokenOf(attackerManage)}`));
  assert.equal(view.channel, 'sms');
  assert.deepEqual(view.signups.map((s) => [s.street, s.house_number]), [['Old Mill Road', '3']]);
  for (const secret of ['Bridge', '77', 'Victoria', 'victoria']) assert.ok(!shown(view).includes(secret), `the attacker sees nothing of the victim (${secret})`);
  assert.equal(view.signups[0].emails, null);

  assert.equal((await api('POST', `/public/${A.slug}/alerts/manage/${tokenOf(attackerManage)}`, { body: { action: 'remove', signup_id: victimSignup.id } })).status, 404);
  assert.equal((await api('POST', `/public/${A.slug}/alerts/manage/${tokenOf(attackerManage)}`, { body: { action: 'stop', channel: 'email' } })).status, 400);
  assert.equal((await q('SELECT status FROM alert_signups WHERE id = ?', [victimSignup.id]))[0].status, 'active');
  const [victimAfter] = await q('SELECT name, phone, email, street_id, house_number FROM residents WHERE tenant_id = ? AND id = ?', [A.id, victimSignup.resident_id]);
  assert.deepEqual(victimAfter, { name: victimBefore.name, phone: null, email: victimBefore.email, street_id: victimBefore.street_id, house_number: victimBefore.house_number }, 'no attacker phone on the victim');

  const before = mailsTo(victimEmail).length;
  await sendNotice(A, S['Bridge Street'], 'Bridge main break');
  const got = mailsTo(victimEmail).slice(before);
  assert.equal(got.length, 1, 'the victim still gets alerts');
  // The email's own manage link is the victim's, for the email only.
  const link = /manage\/([^\s]+)/.exec(got[0].TextBody)[1];
  assert.equal(link, tokenOf(victimManage));
  // A manage link of the old kind (made for a resident) opens nothing.
  const old = SN.tokenFor('manage', A.id, victimSignup.resident_id);
  assert.equal((await api('GET', `/public/${A.slug}/alerts/manage/${old}`)).status, 404);
});

test('1: one person with a phone and an email has two links, each reaching only what came through it', async () => {
  const S = A.streets;
  const phone = newPhone(); const email = `pat.both.${suffix}@example.com`;
  const r = ok(await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: S['Main Street'], house_number: '120', name: 'Pat Both', phone, email } }), 201);
  const byText = ok(await api('POST', `/public/${A.slug}/alerts/confirm`, { body: { ref: r.ref, code: lastCode(phone) } })).manage;
  const byMail = ok(await api('POST', `/public/${A.slug}/alerts/email`, { body: { token: emailToken(email) } })).manage;
  const t = ok(await api('GET', `/public/${A.slug}/alerts/manage/${tokenOf(byText)}`));
  const m = ok(await api('GET', `/public/${A.slug}/alerts/manage/${tokenOf(byMail)}`));
  assert.deepEqual(t.signups.map((s) => [s.house_number, s.texts, s.emails]), [['120', 'on', null]]);
  assert.deepEqual(m.signups.map((s) => [s.house_number, s.texts, s.emails]), [['120', null, 'on']]);
  // Removing through the email link leaves the texts on.
  ok(await api('POST', `/public/${A.slug}/alerts/manage/${tokenOf(byMail)}`, { body: { action: 'remove', signup_id: m.signups[0].id } }));
  assert.deepEqual(ok(await api('GET', `/public/${A.slug}/alerts/manage/${tokenOf(byText)}`)).signups.map((s) => s.texts), ['on']);
  // The staff list shows the name typed on the sign-up.
  const list = ok(await api('GET', `/street-notices/residents?street_id=${S['Main Street']}`, { token: A.token }));
  assert.ok(list.data.some((s) => s.name === 'Pat Both' && s.house_number === '120'));
});

// ================================================================ 5b. requests and bookings keep what was typed
test('5b: a report or bulk booking with someone else\'s phone never changes that resident; staff see what was typed', async () => {
  const S = A.streets;
  const phone = newPhone();
  const [res0] = await pool.query("INSERT INTO residents (tenant_id, name, phone, street_id, house_number) VALUES (?, 'Rhoda Real', ?, ?, '15')", [A.id, `+1${keyOf(phone)}`, S['Bridge Street']]);
  const residentId = res0.insertId;
  const page = ok(await api('GET', `/public/${A.slug}/report`));
  const cat = page.categories[0].id;
  const rep = ok(await api('POST', `/public/${A.slug}/report`, { body: { category_id: cat, street_id: S['Main Street'], house_number: '500', name: 'Mallory', phone, email: `mallory.req.${suffix}@example.com`, texts_ok: true, emails_ok: true } }), 201);
  const [row] = await q('SELECT id, resident_id, contact_name, contact_phone, contact_email FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, rep.reference]);
  assert.equal(row.contact_name, 'Mallory');
  const [after] = await q('SELECT name, phone, email, street_id, house_number, texts_ok, emails_ok FROM residents WHERE id = ?', [residentId]);
  assert.deepEqual(after, { name: 'Rhoda Real', phone: `+1${keyOf(phone)}`, email: null, street_id: S['Bridge Street'], house_number: '15', texts_ok: 0, emails_ok: 0 });
  const detail = ok(await api('GET', `/requests/${row.id}`, { token: A.token }));
  assert.equal(detail.contact.name, 'Mallory', 'the request\'s own name, not the resident\'s');
  assert.equal(detail.contact.email, `mallory.req.${suffix}@example.com`);

  // Bulk pickup: the same.
  const opts = ok(await api('GET', '/solid-waste/options', { token: A.token }));
  const day = opts.days.find((d) => d.available).date;
  const small = opts.sizes.find((x) => x.name === 'Small').id;
  const b = ok(await api('POST', `/public/${A.slug}/bulk-pickup/bookings`, { body: { collection_date: day, street_id: S['Main Street'], house_number: '501', items: [{ size_id: small, quantity: 1 }], pay: 'stickers',
    name: 'Mallory Again', phone, email: `mallory.bulk.${suffix}@example.com`, texts_ok: true, emails_ok: true } }), 201);
  const [after2] = await q('SELECT name, email, house_number FROM residents WHERE id = ?', [residentId]);
  assert.deepEqual(after2, { name: 'Rhoda Real', email: null, house_number: '15' });
  const [bk] = await q('SELECT id FROM bulk_bookings WHERE tenant_id = ? AND reference = ?', [A.id, b.reference]);
  const staff = ok(await api('GET', `/solid-waste/bookings/${bk.id}`, { token: A.token }));
  assert.equal(staff.name, 'Mallory Again');
  const mine = ok(await api('GET', `/public/${A.slug}/bulk-pickup/bookings/${b.token}`));
  assert.equal(mine.name, 'Mallory Again', 'the booking page shows the name typed on it, never the resident on file');
});

// ================================================================ 2. texting numbers
test('2: only the platform operator sets a municipality\'s own number; shared, Text HELP and taken numbers are refused', async () => {
  const M = await createMuniTenant(base, { slug: `rf-num-${suffix}` });
  const N = await createMuniTenant(base, { slug: `rf-num2-${suffix}` });
  // The manager sees the number, read-only, with the words to ask for one.
  const s = ok(await api('GET', '/street-notices/settings', { token: M.token }));
  assert.equal(s.from_number, null);
  assert.equal(s.own_number_words, 'Ask Verdynt to set up your own texting number.');
  assert.equal(s.default_from, '610-555-0000');
  const tried = await api('PUT', '/street-notices/settings', { token: M.token, body: { crew_senders: [], from_number: '+14845551234' } });
  assert.equal(tried.status, 403); assert.match(tried.body.error, /Ask Verdynt to set up your own texting number/);
  ok(await api('PUT', '/street-notices/settings', { token: M.token, body: { crew_senders: [] } }), 200);

  const own = `+1484${String(Date.now()).slice(-7)}`;
  const set = (T, n) => platform('PUT', `/tenants/${T.id}/texting-number`, { from_number: n });
  for (const shared of ['+16105550000', '(610) 555-0001', '610-555-0002']) {
    const r = await set(M, shared);
    assert.equal(r.status, 400, shared); assert.match(r.body.error, /shared Verdynt\/OS number/);
  }
  // A ski patrol's Text HELP number is refused too.
  const ski = ok(await platform('POST', '/tenants', { slug: `rf-ski-${suffix}`, name: `Pine Test ${suffix}`, billing: 'comped', owner: { email: `gm@rf-ski-${suffix}.test`, password: 'correct-horse-battery', first_name: 'G', last_name: 'M' } }), 201);
  const help = `+1267${String(Date.now()).slice(-7)}`;
  await pool.query('INSERT INTO patrol_help_lines (tenant_id, help_number) VALUES (?, ?)', [ski.id, help]);
  const h1 = await set(M, help);
  assert.equal(h1.status, 400); assert.match(h1.body.error, /Text HELP/);
  assert.equal((await platform('PUT', `/tenants/${ski.id}/texting-number`, { from_number: own })).status, 400, 'a ski area has no municipal texting number');
  // One municipality's number cannot be another's.
  assert.equal(ok(await set(M, own)).from_number, own);
  const taken = await set(N, own);
  assert.equal(taken.status, 400); assert.match(taken.body.error, /Another municipality already texts from that number/);
  assert.equal(ok(await api('GET', '/street-notices/settings', { token: M.token })).from_number, own);
  ok(await set(M, null));
  ok(await set(N, own)); // free again
});

test('2: STOP to a municipality\'s own number stops only its residents; STOP to the shared number stops everyone who texts from it, customers too', async () => {
  const own = `+1484${String(Date.now() + 7).slice(-7)}`;
  const M = await createMuniTenant(base, { slug: `rf-stop-m-${suffix}` }); // its own number
  const N = await createMuniTenant(base, { slug: `rf-stop-n-${suffix}` }); // the shared number
  ok(await platform('PUT', `/tenants/${M.id}/texting-number`, { from_number: own }));
  const ski = ok(await platform('POST', '/tenants', { slug: `rf-stop-ski-${suffix}`, name: `Stop Ski ${suffix}`, billing: 'comped', owner: { email: `gm@rf-stop-ski-${suffix}.test`, password: 'correct-horse-battery', first_name: 'G', last_name: 'M' } }), 201);
  const phone = newPhone(); const key = keyOf(phone);
  for (const T of [M, N]) await pool.query("INSERT INTO residents (tenant_id, name, phone, texts_ok) VALUES (?, 'Sam Stopper', ?, 1)", [T.id, `+1${key}`]);
  const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, phone) VALUES (?, 'Sam', 'Skier', ?)", [ski.id, `+1${key}`]);
  const residentOff = async (T) => Number((await q('SELECT texts_ok FROM residents WHERE tenant_id = ? AND phone = ?', [T.id, `+1${key}`]))[0].texts_ok) === 0;
  const customerOff = async () => ((await q("SELECT status FROM consent_events WHERE tenant_id = ? AND person_id = ? AND channel = 'sms' ORDER BY id DESC LIMIT 1", [ski.id, p.insertId]))[0] || {}).status === 'opted_out';

  await textBack(phone, 'STOP', own);
  assert.equal(await residentOff(M), true, 'its own residents');
  assert.equal(await residentOff(N), false, 'not a municipality on the shared number');
  assert.equal(await customerOff(), false, 'not a ski customer');
  await textBack(phone, 'START', own);
  assert.equal(await residentOff(M), false);

  // To the shared number, and to a messaging-service sender: every municipality on it, and customers, as before.
  await textBack(phone, 'STOP', '+16105550001');
  assert.equal(await residentOff(N), true);
  assert.equal(await customerOff(), true, 'the ski customer, as the base did');
  assert.equal(await residentOff(M), false, 'a municipality with its own number is not on the shared one');
  await textBack(phone, 'START');
  assert.equal(await residentOff(N), false);
  assert.equal(await customerOff(), false);
});

// ================================================================ 3. the public pages' scripts load from a build address
test('3: every script and file the new public pages load is served (JavaScript, 200) from the build-stamped address', async () => {
  for (const page of [`/open-requests/${A.slug}`, `/report/${A.slug}`, `/alerts/${A.slug}`, `/bulk-pickup/${A.slug}`]) {
    const html = await (await fetch(`${base}${page}`)).text();
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith('/r/'));
    assert.ok(scripts.length, `${page} loads a script from /r/<release>/`);
    const seen = new Set(); const queue = scripts.map((u) => new URL(u, base).href);
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      const res = await fetch(url);
      assert.equal(res.status, 200, `${page}: ${url}`);
      if (!url.endsWith('.js')) continue;
      assert.match(res.headers.get('content-type'), /javascript/, `${page}: ${url}`);
      const js = await res.text();
      // Static imports, dynamic imports and files loaded with new URL(..., import.meta.url), relative to the script.
      const refs = [...js.matchAll(/(?:from\s+|import\s*\(\s*)'(\.{1,2}\/[^']+)'/g), ...js.matchAll(/new URL\('(\.{1,2}\/[^']+)',\s*import\.meta\.url\)/g)].map((m) => new URL(m[1], url).href);
      queue.push(...refs);
    }
    if (page.startsWith('/open-requests')) assert.ok([...seen].some((u) => /\/r\/[^/]+\/vendor\/leaflet\/leaflet\.js$/.test(u)), 'the map asks for Leaflet under the build address');
  }
});

// ================================================================ 4. the public map's rounding
test('4: points with the same rounded latitude and the same true longitude publish the same position', async () => {
  const S = A.streets;
  ok(await api('PUT', '/requests/settings', { token: A.token, body: { public_map: true } }));
  const page = ok(await api('GET', `/public/${A.slug}/report`));
  const lng = -75.514321;
  // Three latitudes inside one 50 m band (0.00045 degrees): before the fix each gave its own longitude step.
  const band = Math.round(40.130 / 0.00045) * 0.00045;
  const lats = [band - 0.0002, band, band + 0.0002];
  for (const lat of lats) ok(await api('POST', `/public/${A.slug}/report`, { body: { category_id: page.categories[0].id, street_id: S['Old Mill Road'], lat, lng, accuracy: 5, description: `rounding ${lat}` } }), 201);
  const map = ok(await api('GET', `/public/${A.slug}/open-requests`));
  const mine = map.open.filter((r) => r.at && Math.abs(r.at.lat - Math.round(band * 1e6) / 1e6) < 1e-9);
  assert.ok(mine.length >= 3, JSON.stringify(map.open.slice(0, 3)));
  assert.equal(new Set(mine.map((r) => `${r.at.lat},${r.at.lng}`)).size, 1, `one published position: ${JSON.stringify(mine.map((r) => r.at))}`);
  const { roundPosition } = require('../src/lib/requests');
  const steps = lats.map((la) => roundPosition(la, lng)).map((p) => p.lng);
  assert.equal(new Set(steps).size, 1);
});

// ================================================================ 5a. limits per phone and email on the public pages
test('5a: at most 3 reports an hour with one phone or email, and at most 6 texts and 6 emails a day to one of them', async () => {
  const M = await createMuniTenant(base, { slug: `rf-lim-${suffix}` });
  const st = await addStreets(M.id, ['Elm Street']);
  const page = ok(await api('GET', `/public/${M.slug}/report`));
  const phone = newPhone(); const email = `limit.${suffix}@example.com`;
  const report = (extra) => api('POST', `/public/${M.slug}/report`, { body: { category_id: page.categories[0].id, street_id: st['Elm Street'], description: 'Pothole', ...extra } });
  for (let i = 0; i < 3; i += 1) ok(await report({ phone, texts_ok: true }), 201);
  const fourth = await report({ phone, texts_ok: true });
  assert.equal(fourth.status, 429); assert.match(fourth.body.error, /Too many reports with this phone number in the last hour/);
  for (let i = 0; i < 3; i += 1) ok(await report({ email, emails_ok: true }), 201);
  assert.equal((await report({ email: email.toUpperCase(), emails_ok: true })).status, 429, 'the same email in capitals');
  ok(await report({ description: 'No contact given' }), 201);
  // Bulk pickup: the same 3 an hour.
  const N = await createMuniTenant(base, { slug: `rf-limb-${suffix}`, modules: { solidwaste: true } });
  const nst = await addStreets(N.id, ['Elm Street']);
  const opts = ok(await api('GET', '/solid-waste/options', { token: N.token }));
  const day = opts.days.find((d) => d.available).date; const small = opts.sizes.find((x) => x.name === 'Small').id;
  const book = (house) => api('POST', `/public/${N.slug}/bulk-pickup/bookings`, { body: { collection_date: day, street_id: nst['Elm Street'], house_number: house, items: [{ size_id: small, quantity: 1 }], pay: 'stickers', name: 'Lee', phone, texts_ok: true } });
  for (const h of ['1', '2', '3']) ok(await book(h), 201);
  const b4 = await book('4');
  assert.equal(b4.status, 429); assert.match(b4.body.error, /Too many bookings with this phone number/);
  const bulkText = textsTo(phone).find((t) => t.Body.startsWith(`${N.name}: your bulk pickup is booked`));
  assert.ok(bulkText && /Reply STOP to stop texts\.$/.test(bulkText.Body), 'the bulk pickup text says who sent it and how to stop');

  // Six texts and six emails a day to one phone or email from the public pages; the seventh is skipped and logged, not queued.
  const phone2 = newPhone(); const email2 = `limit2.${suffix}@example.com`;
  const t0 = textsTo(phone2).length; const m0 = mailsTo(email2).length;
  for (let i = 0; i < 7; i += 1) {
    await pool.query("DELETE FROM public_sends WHERE tenant_id = ? AND kind = 'submit'", [M.id]); // past the hourly report limit
    ok(await report({ phone: phone2, texts_ok: true, email: email2, emails_ok: true }), 201);
  }
  for (let i = 0; i < 100 && (textsTo(phone2).length - t0 < 6 || mailsTo(email2).length - m0 < 6); i += 1) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(textsTo(phone2).length - t0, 6, 'six texts');
  assert.equal(mailsTo(email2).length - m0, 6, 'six emails');
  const [[skipped]] = await pool.query("SELECT SUM(channel = 'sms') AS sms, SUM(channel = 'email') AS email FROM public_sends WHERE tenant_id = ? AND kind = 'skipped'", [M.id]);
  assert.deepEqual([Number(skipped.sms), Number(skipped.email)], [1, 1], 'the seventh of each was skipped and logged');
  assert.equal((await q("SELECT COUNT(*) AS n FROM public_sends WHERE tenant_id = ? AND dest LIKE '%@%'", [M.id]))[0].n, 0, 'no address is kept, only its hash');
  // A text says who sent it and how to stop.
  assert.match(textsTo(phone2).at(-1).Body, /Reply STOP to stop texts\.$/);
  assert.ok(textsTo(phone2).at(-1).Body.startsWith(`${M.name}: `), 'it says who sent it');
});

// ================================================================ 6. minor findings
test('6: ski-area APIs are refused for a municipality (module_disabled) and still open for a ski area', async () => {
  for (const p of ['/lost-found', '/waivers/summary', '/attractions', '/reports/daily', '/board']) {
    const r = await api('GET', p, { token: A.token });
    assert.equal(r.status, 403, `${p}: ${r.text.slice(0, 120)}`);
    assert.equal(r.body.details && r.body.details.code, 'module_disabled', p);
  }
  const ski = ok(await platform('POST', '/tenants', { slug: `rf-gate-ski-${suffix}`, name: `Gate Ski ${suffix}`, billing: 'comped', owner: { email: `gm@rf-gate-ski-${suffix}.test`, password: 'correct-horse-battery', first_name: 'G', last_name: 'M' } }), 201);
  const tok = await withoutMail(async () => (await api('POST', '/auth/login', { body: { tenant: `rf-gate-ski-${suffix}`, login: `gm@rf-gate-ski-${suffix}.test`, password: 'correct-horse-battery' } })).body.token);
  for (const p of ['/lost-found', '/waivers/summary', '/board']) assert.equal((await api('GET', p, { token: tok })).status, 200, `${p} for a ski area`);
});

test('6: a boil water advisory can name only a certified operator a manager listed', async () => {
  const S = A.streets;
  const crew = await A.addLogin('staff');
  const certified = await A.addLogin('staff');
  const body = { type: 'boil_water', title: 'Boil water: Main Street', sms_text: 'Boil water advisory for Main Street.', areas: [{ street_id: S['Main Street'] }] };
  ok(await api('PUT', '/street-notices/settings', { token: A.token, body: { crew_senders: [], certified_operators: [certified.id] } }));
  assert.deepEqual(ok(await api('GET', '/street-notices/setup', { token: A.token })).operators.map((o) => o.id), [certified.id]);
  const any = await api('POST', '/street-notices', { token: A.token, body: { ...body, issued_by_user_id: crew.id } });
  assert.equal(any.status, 400, 'any Crew login is not enough'); assert.match(any.body.error, /certified operators/);
  const n = ok(await api('POST', '/street-notices', { token: A.token, body: { ...body, issued_by_user_id: certified.id } }), 201);
  assert.equal(n.issued_by_user_id, certified.id);
  assert.equal((await api('PUT', '/street-notices/settings', { token: crew.token, body: { crew_senders: [], certified_operators: [crew.id] } })).status, 403, 'a Crew login cannot certify itself');
  ok(await api('DELETE', `/street-notices/${n.id}`, { token: A.token }));
});

test('6: "open a work order" on a notice is refused on the server when Assets is off', async () => {
  const M = await createMuniTenant(base, { slug: `rf-wo-${suffix}`, modules: { assets: false } });
  const st = await addStreets(M.id, ['Ash Street']);
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: { type: 'water_outage', title: 'Ash main', sms_text: 'Water is off on Ash Street.', areas: [{ street_id: st['Ash Street'] }] } }), 201);
  const r = await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true, work_order: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Assets and fleet/);
  assert.equal((await q('SELECT status FROM street_notices WHERE id = ?', [n.id]))[0].status, 'draft', 'nothing went out');
  assert.equal((await q('SELECT COUNT(*) AS n FROM work_orders WHERE tenant_id = ?', [M.id]))[0].n, 0);
});

test('6: CSV exports keep coordinates and other plain numbers as numbers; formulas are still defused', async () => {
  const { cell } = require('../src/lib/csv');
  assert.equal(cell(-75.514321), '"-75.514321"');
  assert.equal(cell('-75.514321'), '"-75.514321"');
  assert.equal(cell('+3'), '"+3"');
  assert.equal(cell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(cell('-cmd'), '"\'-cmd"');
  assert.equal(cell('@SUM(A1)'), '"\'@SUM(A1)"');
  // A program over map items exports its coordinates as numbers, through the real route.
  const M = await createMuniTenant(base, { slug: `rf-csv-${suffix}`, modules: { water: true } });
  const f = ok(await api('POST', '/assets/map/features', { token: M.token, body: { kind: 'fire_hydrant', points: [[40.130123, -75.514321]], tag: `H-${suffix}`.slice(0, 20) } }), 201);
  const tpl = ok(await api('GET', '/assets/templates', { token: M.token })).data.find((t) => t.name === 'Hydrant flush and inspection');
  const p = ok(await api('POST', '/assets/programs', { token: M.token, body: { name: 'Flush hydrants', template_id: tpl.id, targets: { features: [f.id] } } }), 201);
  const res = await fetch(`${base}/api/v1/assets/programs/${p.id}/export.csv`, { headers: { authorization: `Bearer ${M.token}` } });
  const csv = await res.text();
  assert.equal(res.status, 200, csv.slice(0, 200));
  assert.match(csv, /,40\.130123,-75\.514321,/, csv);
  assert.ok(!csv.includes("'-75"), 'no quote mark before a negative longitude');
});

// ================================================================ re-review (2026.11.19)
test('A: a ski area cannot take the shared number or a municipality\'s own number as its Text HELP number', async () => {
  const M = await createMuniTenant(base, { slug: `rf-a1-${suffix}` });
  const own = `+1484${String(Date.now() + 11).slice(-7)}`;
  ok(await platform('PUT', `/tenants/${M.id}/texting-number`, { from_number: own }));
  ok(await platform('POST', '/tenants', { slug: `rf-a1-ski-${suffix}`, name: `Help Ski ${suffix}`, billing: 'comped', owner: { email: `gm@rf-a1-ski-${suffix}.test`, password: 'correct-horse-battery', first_name: 'G', last_name: 'M' } }), 201);
  const tok = await withoutMail(async () => (await api('POST', '/auth/login', { body: { tenant: `rf-a1-ski-${suffix}`, login: `gm@rf-a1-ski-${suffix}.test`, password: 'correct-horse-battery' } })).body.token);
  for (const shared of ['+16105550000', '(610) 555-0002']) {
    const r = await api('PUT', '/patrol/text-help', { token: tok, body: { help_number: shared } });
    assert.equal(r.status, 400, shared); assert.match(r.body.error, /shared Verdynt\/OS number/);
  }
  const taken = await api('PUT', '/patrol/text-help', { token: tok, body: { help_number: own } });
  assert.equal(taken.status, 409); assert.match(taken.body.error, /already belongs to another organization/);
  ok(await api('PUT', '/patrol/text-help', { token: tok, body: { help_number: `+1267${String(Date.now() + 13).slice(-7)}` } }));
});

test('B: only a public form\'s own confirmation counts toward the daily limit; reports and bookings have separate hourly limits; a skip shows to staff', async () => {
  const S = A.streets;
  const page = ok(await api('GET', `/public/${A.slug}/report`));
  const phone = newPhone();
  const report = () => api('POST', `/public/${A.slug}/report`, { body: { category_id: page.categories[0].id, street_id: S['Main Street'], description: 'Sign down', phone, texts_ok: true } });
  for (let i = 0; i < 3; i += 1) ok(await report(), 201);
  assert.equal((await report()).status, 429, 'a fourth report this hour');
  // A booking with the same phone is its own limit.
  const opts = ok(await api('GET', '/solid-waste/options', { token: A.token }));
  const day = opts.days.find((d) => d.available).date; const small = opts.sizes.find((x) => x.name === 'Small').id;
  const book = (house) => api('POST', `/public/${A.slug}/bulk-pickup/bookings`, { body: { collection_date: day, street_id: S['Main Street'], house_number: house, items: [{ size_id: small, quantity: 1 }], pay: 'stickers', name: 'Robin Real', phone, texts_ok: true } });
  const b1 = ok(await book('801'), 201);
  // 3 report confirmations and 1 booking confirmation so far today. Staff actions on a report are not counted.
  const [first] = await q('SELECT id FROM requests WHERE tenant_id = ? AND contact_phone = ? ORDER BY id LIMIT 1', [A.id, phone]);
  for (let i = 0; i < 3; i += 1) {
    const [r] = await q('SELECT id FROM requests WHERE tenant_id = ? AND contact_phone = ? ORDER BY id LIMIT 1 OFFSET ?', [A.id, phone, i]);
    ok(await api('POST', `/requests/${r.id}/refer`, { token: A.token, body: { referred_to: 'PennDOT' } }));
  }
  const closedTexts = textsTo(phone).filter((t) => /is closed/.test(t.Body)).length;
  assert.equal(closedTexts, 3, 'staff-caused messages still go');
  // Two more confirmations reach six; the seventh confirmation is skipped and staff see why.
  await pool.query("DELETE FROM public_sends WHERE tenant_id = ? AND kind = 'submit'", [A.id]);
  ok(await report(), 201); ok(await book('802'), 201);
  const before = textsTo(phone).length;
  const last = ok(await report(), 201);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(textsTo(phone).length, before, 'the seventh confirmation was not sent');
  const [lr] = await q('SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, last.reference]);
  const d = ok(await api('GET', `/requests/${lr.id}`, { token: A.token }));
  assert.ok(d.messages.some((m) => m.channel === 'sms' && !m.ok && m.error === 'Text not sent: daily limit for this phone'), JSON.stringify(d.messages));
  const b3 = ok(await book('803'), 201);
  const [bk] = await q('SELECT id FROM bulk_bookings WHERE tenant_id = ? AND reference = ?', [A.id, b3.reference]);
  assert.equal(ok(await api('GET', `/solid-waste/bookings/${bk.id}`, { token: A.token })).message_note, 'Text not sent: daily limit for this phone');
  assert.ok(b1 && first);
});

test('C: a boil water advisory is refused at send, and held at its scheduled time, once its operator is no longer certified', async () => {
  const S = A.streets;
  const op = await A.addLogin('staff');
  const body = { type: 'boil_water', title: 'Boil water: Bridge Street', sms_text: 'Boil water advisory for Bridge Street.', areas: [{ street_id: S['Bridge Street'] }], issued_by_user_id: op.id };
  ok(await api('PUT', '/street-notices/settings', { token: A.token, body: { crew_senders: [], certified_operators: [op.id] } }));
  const now = ok(await api('POST', '/street-notices', { token: A.token, body }), 201);
  const later = ok(await api('POST', '/street-notices', { token: A.token, body: { ...body, title: 'Boil water: Bridge Street, later' } }), 201);
  ok(await api('POST', `/street-notices/${later.id}/send`, { token: A.token, body: { confirm: true, send_at: '2099-01-01T08:00' } }));
  ok(await api('PUT', '/street-notices/settings', { token: A.token, body: { crew_senders: [], certified_operators: [] } }));
  const r = await api('POST', `/street-notices/${now.id}/send`, { token: A.token, body: { confirm: true } });
  assert.equal(r.status, 400); assert.match(r.body.error, /no longer one of your certified operators/);
  assert.equal((await q('SELECT status FROM street_notices WHERE id = ?', [now.id]))[0].status, 'draft');
  // The scheduled one comes due: the job holds it as a draft and says why.
  await pool.query("UPDATE street_notice_updates SET send_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE tenant_id = ? AND notice_id = ? AND status = 'scheduled'", [A.id, later.id]);
  ok(await api('POST', '/internal/jobs/guests', { headers: { 'x-jobs-key': process.env.JOBS_KEY } }));
  const held = ok(await api('GET', `/street-notices/${later.id}`, { token: A.token }));
  assert.equal(held.status, 'draft');
  assert.match(held.held_note, /no longer one of your certified operators/);
  assert.equal((await q('SELECT COUNT(*) AS n FROM street_notice_deliveries WHERE notice_id = ?', [later.id]))[0].n, 0, 'nothing was sent');
  for (const id of [now.id, later.id]) ok(await api('DELETE', `/street-notices/${id}`, { token: A.token }));
});
