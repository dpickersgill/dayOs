'use strict';

// Street notices and resident alerts (muni release 1). Residents sign up on the public page and confirm by a texted code
// or an emailed link; staff pick streets and house-number ranges and text and email everyone signed up there. A fake
// Twilio and a fake Postmark take what is sent; STOP comes in through the signed Twilio webhook as it would in real life.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.PLATFORM_RATE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT = '100000';
process.env.ALERTS_RATE_LIMIT = '100000';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'alerts@verdynt.test';
process.env.JOBS_KEY = 'test-jobs-key-notices';

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

// Signing in on a new device asks for an emailed code while email is set up, so logins are made with email off for a moment.
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
let A; let B; let streetsA; let streetB;

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${String(r.text).slice(0, 400)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
const textsTo = (phone) => texts.filter((t) => keyOf(t.To) === keyOf(phone));
const mailsTo = (email) => mails.filter((m) => m.To === email);
const lastCode = (phone) => { const t = textsTo(phone).reverse().find((x) => /your code is (\d{6})/.test(x.Body)); return t ? /your code is (\d{6})/.exec(t.Body)[1] : null; };

async function addStreets(tenantId, names) {
  const out = {};
  for (const n of names) { const [r] = await pool.query('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [tenantId, n]); out[n] = r.insertId; }
  return out;
}

/** A resident signs up on the public page and confirms (code by text, link by email). Returns { ref, manage, phone, email }. */
async function signUp(M, { street, house, unit, phone, email, topics = [], name = 'Pat Resident', confirm = true }) {
  const r = ok(await api('POST', `/public/${M.slug}/alerts`, { body: { street_id: street, house_number: house, unit, name, phone, email, topics } }), 201);
  let manage = null;
  if (confirm && phone) manage = ok(await api('POST', `/public/${M.slug}/alerts/confirm`, { body: { ref: r.ref, code: lastCode(phone) } })).manage;
  if (confirm && email) {
    const m = mailsTo(email.toLowerCase()).reverse().find((x) => /\/email\//.test(x.TextBody));
    const token = /\/email\/([^\s]+)/.exec(m.TextBody)[1];
    manage = ok(await api('POST', `/public/${M.slug}/alerts/email`, { body: { token } })).manage;
  }
  return { ref: r.ref, manage, phone, email, r };
}

/** Waits until nothing of this notice is waiting to be sent. Returns the notice. */
async function settled(M, id, token = M.token) {
  for (let i = 0; i < 200; i += 1) {
    const n = ok(await api('GET', `/street-notices/${id}`, { token }));
    if (!n.summary.queued && !n.summary.sending) { await SN.idle(); return n; }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the notice never finished sending');
}

const notice = (over = {}) => ({ type: 'water_outage', title: 'Main break', sms_text: 'Water is off on Dayton Street. Back by 5 PM.', body: 'Water is off while crews repair a main.', areas: [], ...over });

/** Signs a STOP or START text the way Twilio posts it. */
async function textBack(from, word) {
  const params = { AccountSid: 'ACtest', MessageSid: `SM${Date.now()}${Math.random()}`.slice(0, 34), From: `+1${keyOf(from)}`, To: '+16105550000', Body: word };
  const url = `${base}/api/v1/twilio/sms`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', url, params) }, body: new URLSearchParams(params).toString() });
  assert.equal(res.status, 200, await res.text());
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
  let n = 0;
  tw = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { texts.push(Object.fromEntries(new URLSearchParams(d))); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` })); }); });
  pm = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  A = await createMuniTenant(base, { slug: `sn-a-${suffix}`, name: `Riverbend Test ${suffix}` });
  B = await createMuniTenant(base, { slug: `sn-b-${suffix}`, name: `Hillside Test ${suffix}` });
  streetsA = await addStreets(A.id, ['Dayton Street', 'Main Street', 'Bridge Street', 'Old Mill Road']);
  streetB = (await addStreets(B.id, ['Dayton Street']))['Dayton Street'];
  quiet.clock.now = () => new Date(Date.UTC(2026, 10, 11, 17, 0, 0)); // noon in Pennsylvania: no quiet hours unless a test says so
});
test.after(async () => { await SN.idle(); await new Promise((r) => server.close(r)); tw.close(); pm.close(); await pool.end(); });

// ---------------------------------------------------------------- sign-up
test('sign-up: a code by text confirms the phone; wrong codes are limited and a new code starts again', async () => {
  const phone = newPhone();
  const page = ok(await api('GET', `/public/${A.slug}/alerts`));
  assert.ok(page.streets.some((s) => s.name === 'Dayton Street'));
  assert.deepEqual(page.topics.map((t) => t.key), ['water', 'streets', 'trash', 'leaves', 'news']);
  const r = ok(await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: streetsA['Dayton Street'], house_number: '12', phone, topics: ['streets'] } }), 201);
  assert.equal(r.needs_code, true);
  assert.match(r.phone_hint, /ending in \d{4}/);
  const code = lastCode(phone);
  assert.match(code, /^\d{6}$/);
  // Pending until confirmed: not on any list.
  assert.equal((await q("SELECT status FROM alert_signups WHERE tenant_id = ? AND phone = ?", [A.id, `+1${keyOf(phone)}`]))[0].status, 'pending');
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
  for (let i = 1; i <= 4; i += 1) {
    const w = await api('POST', `/public/${A.slug}/alerts/confirm`, { body: { ref: r.ref, code: wrong } });
    assert.equal(w.status, 400); assert.match(w.body.error, new RegExp(`${5 - i} tr`));
  }
  assert.equal((await api('POST', `/public/${A.slug}/alerts/confirm`, { body: { ref: r.ref, code: wrong } })).status, 429, 'the fifth wrong code uses the code up');
  assert.equal((await api('POST', `/public/${A.slug}/alerts/confirm`, { body: { ref: r.ref, code } })).status, 429, 'even the right code, once tries are used up');
  // A forged reference does not work.
  assert.equal((await api('POST', `/public/${A.slug}/alerts/confirm`, { body: { ref: r.ref.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), code } })).status, 400);
  ok(await api('POST', `/public/${A.slug}/alerts/resend`, { body: { ref: r.ref } }));
  const fresh = lastCode(phone);
  const done = ok(await api('POST', `/public/${A.slug}/alerts/confirm`, { body: { ref: r.ref, code: fresh } }));
  assert.match(done.manage, new RegExp(`/alerts/${A.slug}/manage/`));
  const s = (await q('SELECT status, by_text, topics FROM alert_signups WHERE tenant_id = ? AND phone = ?', [A.id, `+1${keyOf(phone)}`]))[0];
  assert.equal(s.status, 'active'); assert.equal(s.by_text, 1); assert.equal(s.topics, 'water,streets', 'water and sewer outages are always on');
  assert.match(textsTo(phone).at(-1).Body, /Reply STOP to stop/, 'a welcome text says how to stop');
  assert.equal((await q('SELECT texts_ok FROM residents WHERE tenant_id = ? AND phone = ?', [A.id, `+1${keyOf(phone)}`]))[0].texts_ok, 1);
});

test('sign-up: at most 5 codes an hour to one phone; a bad phone, no contact or a street from elsewhere is refused', async () => {
  const phone = newPhone();
  const r = ok(await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: streetsA['Main Street'], house_number: '4', phone } }), 201);
  for (let i = 0; i < 4; i += 1) ok(await api('POST', `/public/${A.slug}/alerts/resend`, { body: { ref: r.ref } }));
  assert.equal((await api('POST', `/public/${A.slug}/alerts/resend`, { body: { ref: r.ref } })).status, 429);
  assert.equal((await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: streetsA['Main Street'], house_number: '4', phone } })).status, 429, 'a new sign-up does not get around it');
  assert.equal((await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: streetsA['Main Street'], house_number: '4', phone: '555-12' } })).status, 400);
  assert.equal((await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: streetsA['Main Street'], house_number: '4' } })).status, 400);
  assert.equal((await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: streetB, house_number: '4', phone: newPhone() } })).status, 400, 'another town\'s street');
});

test('sign-up by email: the emailed link confirms it, a forged link does not', async () => {
  const email = `pat.${suffix}@example.com`;
  const r = ok(await api('POST', `/public/${A.slug}/alerts`, { body: { street_id: streetsA['Bridge Street'], house_number: '9', email } }), 201);
  assert.equal(r.needs_code, false); assert.equal(r.email_sent, true);
  const m = mailsTo(email).at(-1);
  assert.match(m.Subject, /Confirm your email/);
  const token = /\/email\/([^\s]+)/.exec(m.TextBody)[1];
  assert.equal((await api('POST', `/public/${A.slug}/alerts/email`, { body: { token: token.replace(/^\d+/, String(B.id)) } })).status, 400);
  assert.equal((await api('POST', `/public/${B.slug}/alerts/email`, { body: { token } })).status, 400, 'another town');
  ok(await api('POST', `/public/${A.slug}/alerts/email`, { body: { token } }));
  const s = (await q('SELECT status, by_email, by_text FROM alert_signups WHERE tenant_id = ? AND email = ?', [A.id, email]))[0];
  assert.deepEqual([s.status, s.by_email, s.by_text], ['active', 1, 0]);
});

// ---------------------------------------------------------------- who gets it
test('selection: whole streets, house-number ranges, odd and even sides, topics, and only confirmed residents', async () => {
  const M = await createMuniTenant(base, { slug: `sn-sel-${suffix}` });
  const st = await addStreets(M.id, ['Elm Street', 'Oak Street']);
  const people = {};
  for (const house of ['101', '102', '103', '150B', '201', 'Rear lot']) people[house] = await signUp(M, { street: st['Elm Street'], house, phone: newPhone() });
  people.oak = await signUp(M, { street: st['Oak Street'], house: '7', phone: newPhone(), topics: ['streets'] });
  people.waiting = await signUp(M, { street: st['Elm Street'], house: '105', phone: newPhone(), confirm: false });
  people.mail = await signUp(M, { street: st['Elm Street'], house: '107', email: `elm107.${suffix}@example.com` });
  const preview = async (areas, type = 'water_outage') => ok(await api('POST', '/street-notices/preview', { token: M.token, body: { type, areas } }));
  const elm = (o = {}) => ({ street_id: st['Elm Street'], ...o });
  let p = await preview([elm()]);
  assert.deepEqual([p.texts, p.emails, p.residents], [6, 1, 7], 'the whole street: everyone confirmed, not the one still waiting for a code');
  assert.equal(p.no_number, 1);
  p = await preview([elm({ from_no: 100, to_no: 199, side: 'odd' })]);
  assert.deepEqual([p.texts, p.emails], [3, 1], '101, 103 and the one with no house number; 107 by email');
  p = await preview([elm({ from_no: 100, to_no: 199, side: 'even' })]);
  assert.deepEqual([p.texts, p.emails], [3, 0], '102, 150B and the one with no house number');
  p = await preview([elm({ from_no: 150, to_no: null })]);
  assert.equal(p.texts, 3, '150B, 201 and no number');
  p = await preview([elm({ from_no: 102, to_no: 102 }), { street_id: st['Oak Street'] }]);
  assert.equal(p.texts, 3, '102, no number, and Oak Street');
  p = await preview([{ street_id: st['Oak Street'] }, elm()], 'paving');
  assert.equal(p.texts, 1, 'paving goes only to those who picked street closures and paving');
  assert.equal((await api('POST', '/street-notices/preview', { token: M.token, body: { type: 'water_outage', areas: [elm({ from_no: 200, to_no: 100 })] } })).status, 400, 'a range backwards');
  // The preview of the saved notice and the send agree, and every text names the notice's page.
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: notice({ areas: [elm({ from_no: 100, to_no: 199, side: 'odd' })] }) }), 201);
  assert.deepEqual([n.preview.texts, n.preview.emails], [3, 1]);
  const sent = ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true } }));
  assert.deepEqual([sent.texts, sent.emails], [3, 1]);
  const done = await settled(M, n.id);
  assert.deepEqual([done.summary.texts_sent, done.summary.emails_sent, done.summary.failed], [3, 1, 0]);
  for (const who of ['101', '103', 'Rear lot']) assert.ok(textsTo(people[who].phone).some((t) => t.Body.includes(`/alerts/${M.slug}/${n.code}`) && /Reply STOP/.test(t.Body)), who);
  for (const who of ['102', '150B', '201', 'oak', 'waiting']) assert.ok(!textsTo(people[who].phone).some((t) => t.Body.includes(n.code)), who);
  const mail = mailsTo(`elm107.${suffix}@example.com`).find((m) => m.Subject === 'Main break');
  assert.ok(mail && /manage\//.test(mail.TextBody) && mail.Headers.some((h) => h.Name === 'List-Unsubscribe'), 'the email has a manage link');
  // A second press of Send does not send it again.
  assert.equal((await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true } })).status, 409);
});

test('STOP by text and the manage link are honored before and after a send; START undoes a text STOP', async () => {
  const M = await createMuniTenant(base, { slug: `sn-stop-${suffix}` });
  const st = await addStreets(M.id, ['Walnut Street']);
  const keep = await signUp(M, { street: st['Walnut Street'], house: '1', phone: newPhone() });
  const stops = await signUp(M, { street: st['Walnut Street'], house: '2', phone: newPhone() });
  const mail = await signUp(M, { street: st['Walnut Street'], house: '3', email: `walnut3.${suffix}@example.com` });
  await textBack(stops.phone, 'STOP');
  // The manage link stops the email.
  const tok = mail.manage.split('/manage/')[1];
  const view = ok(await api('GET', `/public/${M.slug}/alerts/manage/${tok}`));
  assert.equal(view.signups[0].emails, 'on');
  assert.ok(!JSON.stringify(view).includes(`walnut3.${suffix}@example.com`), 'the manage page shows a hint, not the address');
  assert.equal(ok(await api('POST', `/public/${M.slug}/alerts/manage/${tok}`, { body: { action: 'stop', channel: 'email' } })).signups[0].emails, 'stopped');
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: notice({ areas: [{ street_id: st['Walnut Street'] }] }) }), 201);
  assert.deepEqual([n.preview.texts, n.preview.emails, n.preview.opted_out], [1, 0, 2]);
  ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true } }));
  const done = await settled(M, n.id);
  assert.deepEqual([done.summary.texts_sent, done.summary.opted_out], [1, 2]);
  assert.ok(!textsTo(stops.phone).some((t) => t.Body.includes(n.code)));
  // A STOP that arrives after the send: the follow-up skips that phone.
  await textBack(keep.phone, 'STOP');
  const up = ok(await api('POST', `/street-notices/${n.id}/updates`, { token: M.token, body: { sms_text: 'Water is back on.' } }));
  assert.deepEqual([up.texts, up.opted_out], [0, 1]);
  // START lifts a stop that came by text, and the resident is on the list again.
  await textBack(stops.phone, 'START');
  const n2 = ok(await api('POST', '/street-notices', { token: M.token, body: notice({ areas: [{ street_id: st['Walnut Street'] }] }) }), 201);
  assert.equal(n2.preview.texts, 1, 'the phone that texted START');
  // A phone that texted STOP cannot sign up again until START.
  const again = await api('POST', `/public/${M.slug}/alerts`, { body: { street_id: st['Walnut Street'], house_number: '1', phone: keep.phone } });
  assert.equal(again.status, 409); assert.match(again.body.error, /Text START/);
  const ledger = await q("SELECT a.addr, e.status, e.source FROM alert_consent_events e JOIN alert_addresses a ON a.tenant_id = e.tenant_id AND a.id = e.address_id WHERE e.tenant_id = ? ORDER BY e.id", [M.id]);
  assert.ok(ledger.some((e) => e.addr === keyOf(stops.phone) && e.status === 'opted_out' && e.source === 'text_reply'));
  assert.ok(ledger.some((e) => e.addr === keyOf(stops.phone) && e.status === 'opted_in' && e.source === 'text_reply'));
});

test('a follow-up and "Ended" go to the same people as the first send, not to anyone who signed up since', async () => {
  const M = await createMuniTenant(base, { slug: `sn-fu-${suffix}` });
  const st = await addStreets(M.id, ['Cherry Lane']);
  const first = await signUp(M, { street: st['Cherry Lane'], house: '10', phone: newPhone(), email: `cherry10.${suffix}@example.com` });
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: notice({ areas: [{ street_id: st['Cherry Lane'] }] }) }), 201);
  ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true } }));
  await settled(M, n.id);
  const late = await signUp(M, { street: st['Cherry Lane'], house: '12', phone: newPhone() });
  assert.equal((await api('POST', `/street-notices/${n.id}/updates`, { token: M.token, body: { sms_text: 'Crews found the break. Back by {time}.' } })).status, 400, 'blanks must be filled in');
  const up = ok(await api('POST', `/street-notices/${n.id}/updates`, { token: M.token, body: { sms_text: 'Water is back on.', body: 'Water is back on. Run the cold tap until clear.' } }));
  assert.deepEqual([up.texts, up.emails], [1, 1]);
  await settled(M, n.id);
  assert.ok(textsTo(first.phone).some((t) => /Update: Water is back on/.test(t.Body)));
  assert.ok(!textsTo(late.phone).some((t) => /Water is back on/.test(t.Body)));
  assert.ok(mailsTo(`cherry10.${suffix}@example.com`).some((m) => m.Subject === 'Update: Main break'));
  const end = ok(await api('POST', `/street-notices/${n.id}/end`, { token: M.token, body: { sms_text: 'All work on Cherry Lane is done.' } }));
  assert.equal(end.texts, 1);
  const done = await settled(M, n.id);
  assert.equal(done.status, 'ended');
  assert.deepEqual(done.updates.map((u) => [u.kind, u.summary.texts_sent]), [['first', 1], ['update', 1], ['ended', 1]]);
  assert.ok(textsTo(first.phone).some((t) => /Ended: All work/.test(t.Body)));
  assert.equal((await api('POST', `/street-notices/${n.id}/updates`, { token: M.token, body: { sms_text: 'More' } })).status, 409, 'an ended notice takes no more updates');
  const pub = ok(await api('GET', `/public/${M.slug}/alerts/${n.code}`));
  assert.equal(pub.status, 'ended');
  assert.deepEqual(pub.updates.map((u) => u.kind), ['update', 'ended']);
});

test('a scheduled notice waits, then the 5-minute job sends it; unscheduling puts it back to a draft', async () => {
  const M = await createMuniTenant(base, { slug: `sn-sch-${suffix}` });
  const st = await addStreets(M.id, ['Pine Street']);
  const r = await signUp(M, { street: st['Pine Street'], house: '5', phone: newPhone(), topics: ['streets'] });
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: notice({ type: 'street_closure', title: 'Pine closed', sms_text: 'Pine Street closed Friday.', areas: [{ street_id: st['Pine Street'] }] }) }), 201);
  const later = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16);
  const s = ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true, send_at: later } }));
  assert.equal(s.scheduled, true);
  assert.equal(ok(await api('GET', `/street-notices/${n.id}`, { token: M.token })).status, 'scheduled');
  assert.equal((await api('PUT', `/street-notices/${n.id}`, { token: M.token, body: notice({ areas: [{ street_id: st['Pine Street'] }] }) })).status, 409);
  ok(await api('POST', '/internal/jobs/guests', { headers: { 'x-jobs-key': process.env.JOBS_KEY } }));
  assert.ok(!textsTo(r.phone).some((t) => t.Body.includes(n.code)), 'not before its time');
  // Unschedule, then schedule again, then its time comes.
  assert.equal(ok(await api('POST', `/street-notices/${n.id}/unschedule`, { token: M.token })).status, 'draft');
  ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true, send_at: later } }));
  await pool.query("UPDATE street_notice_updates SET send_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE tenant_id = ? AND notice_id = ? AND status = 'scheduled'", [M.id, n.id]);
  const job = ok(await api('POST', '/internal/jobs/guests', { headers: { 'x-jobs-key': process.env.JOBS_KEY } }));
  assert.ok(job.street_notices && job.street_notices.queued >= 1, JSON.stringify(job.street_notices));
  const done = await settled(M, n.id);
  assert.equal(done.status, 'active');
  assert.equal(done.summary.texts_sent, 1);
  assert.ok(textsTo(r.phone).some((t) => t.Body.includes(n.code)));
});

test('quiet hours: a paving notice at night waits for 8 AM; a water outage goes at once', async () => {
  const was = quiet.clock.now;
  quiet.clock.now = () => new Date(Date.UTC(2026, 10, 12, 4, 0, 0)); // 11 PM in Pennsylvania
  try {
    const st = streetsA['Old Mill Road'];
    const paving = ok(await api('POST', '/street-notices/preview', { token: A.token, body: { type: 'paving', areas: [{ street_id: st }] } }));
    assert.match(String(paving.held_until), /^2026-11-12 13:00:00/, '8 AM Eastern');
    const water = ok(await api('POST', '/street-notices/preview', { token: A.token, body: { type: 'water_outage', areas: [{ street_id: st }] } }));
    assert.equal(water.held_until, null);
  } finally { quiet.clock.now = was; }
});

// ---------------------------------------------------------------- boil water, work orders, public page
test('a boil water advisory needs the certified operator who issued it; the public page names nobody', async () => {
  const st = streetsA['Dayton Street'];
  const r = await signUp(A, { street: st, house: '44', phone: newPhone(), email: `dayton44.${suffix}@example.com`, name: 'Jordan Privateperson' });
  const setup = ok(await api('GET', '/street-notices/setup', { token: A.token }));
  assert.equal(setup.operator_rule, 'Only send when your certified operator has issued the advisory.');
  const op = setup.operators[0];
  const body = notice({ type: 'boil_water', title: 'Boil water: Dayton Street', sms_text: 'Boil water advisory for Dayton Street.', areas: [{ street_id: st, from_no: 40, to_no: 48, side: 'even' }] });
  const no = await api('POST', '/street-notices', { token: A.token, body });
  assert.equal(no.status, 400); assert.match(no.body.error, /certified operator/);
  assert.equal((await api('POST', '/street-notices', { token: A.token, body: { ...body, issued_by_user_id: 999999999 } })).status, 400, 'an operator from nowhere');
  const n = ok(await api('POST', '/street-notices', { token: A.token, body: { ...body, issued_by_user_id: op.id } }), 201);
  assert.equal(n.issued_by_user_id, op.id); assert.equal(n.issued_by_name, op.name);
  ok(await api('POST', `/street-notices/${n.id}/send`, { token: A.token, body: { confirm: true } }));
  await settled(A, n.id);
  const pub = ok(await api('GET', `/public/${A.slug}/alerts/${n.code}`));
  assert.equal(pub.operator_note, 'Issued by our certified water operator.');
  assert.deepEqual(pub.streets, ['Dayton Street 40 to 48 (even side)']);
  const words = JSON.stringify(pub);
  for (const secret of ['Jordan', 'Privateperson', keyOf(r.phone), r.email, op.name, '"44"']) assert.ok(!words.includes(secret), `the public page shows ${secret}`);
  assert.equal((await api('GET', `/public/${B.slug}/alerts/${n.code}`)).status, 404, 'another town\'s page');
  const audit = await q("SELECT action FROM audit_log WHERE tenant_id = ? AND entity = 'street_notices' AND entity_id = ? ORDER BY id", [A.id, n.id]);
  assert.deepEqual(audit.map((a) => a.action), ['create', 'send']);
});

test('an outage notice can open a work order (source notice); a draft with blanks cannot be sent', async () => {
  const st = streetsA['Main Street'];
  const n = ok(await api('POST', '/street-notices', { token: A.token, body: notice({ sms_text: 'Water is off on Main Street until {until}.', areas: [{ street_id: st }] }) }), 201);
  assert.deepEqual(n.blanks, ['{until}']);
  const blank = await api('POST', `/street-notices/${n.id}/send`, { token: A.token, body: { confirm: true, work_order: true } });
  assert.equal(blank.status, 400); assert.match(blank.body.error, /\{until\}/);
  assert.equal((await q('SELECT COUNT(*) AS n FROM work_orders WHERE tenant_id = ?', [A.id]))[0].n, 0, 'nothing was opened');
  ok(await api('PUT', `/street-notices/${n.id}`, { token: A.token, body: notice({ areas: [{ street_id: st }] }) }));
  const s = ok(await api('POST', `/street-notices/${n.id}/send`, { token: A.token, body: { confirm: true, work_order: true } }));
  assert.ok(s.work_order_id);
  const wo = (await q('SELECT source, priority, title FROM work_orders WHERE tenant_id = ? AND id = ?', [A.id, s.work_order_id]))[0];
  assert.deepEqual([wo.source, wo.priority], ['notice', 'urgent']);
  assert.match(wo.title, /Water outage: Main break/);
  await settled(A, n.id);
});

// ---------------------------------------------------------------- lists, export, import
test('the sign-up list by street, and exports without contact details unless a manager asks', async () => {
  const st = streetsA['Bridge Street'];
  await signUp(A, { street: st, house: '77', unit: '2B', phone: newPhone(), name: 'Morgan Exportson', email: `bridge77.${suffix}@example.com` });
  const byStreet = ok(await api('GET', '/street-notices/residents/streets', { token: A.token }));
  const bridge = byStreet.data.find((s) => s.name === 'Bridge Street');
  assert.ok(bridge.residents >= 2 && bridge.phones >= 1 && bridge.emails >= 1, JSON.stringify(bridge));
  const list = ok(await api('GET', `/street-notices/residents?street_id=${st}`, { token: A.token }));
  assert.ok(list.data.some((s) => s.name === 'Morgan Exportson' && s.unit === '2B'));
  const crew = await A.addLogin('staff');
  const desk = await A.addLogin('counter');
  assert.equal((await api('GET', `/street-notices/residents?street_id=${st}`, { token: crew.token })).status, 403, 'Crew do not see residents\' contacts');
  ok(await api('GET', `/street-notices/residents?street_id=${st}`, { token: desk.token }));
  const plain = await api('GET', '/street-notices/residents/export', { token: desk.token });
  assert.equal(plain.status, 200);
  assert.ok(plain.text.startsWith('street,topics,by_text,by_email,status,source,signed_up'));
  assert.ok(!/Exportson|bridge77|"77"|2B/.test(plain.text), 'no names, phones, emails or house numbers');
  assert.equal((await api('GET', '/street-notices/residents/export?contacts=1', { token: desk.token })).status, 403);
  const full = await api('GET', '/street-notices/residents/export?contacts=1', { token: A.token });
  assert.ok(/Morgan Exportson/.test(full.text) && /bridge77/.test(full.text) && /"77"/.test(full.text));
  const audit = await q("SELECT action, detail FROM audit_log WHERE tenant_id = ? AND entity = 'alert_signups' AND action LIKE 'export%' ORDER BY id", [A.id]);
  assert.deepEqual(audit.map((a) => a.action), ['export', 'export_contacts']);
  // The notices export is a public record: no resident appears in it.
  const notices = await api('GET', '/street-notices/export', { token: crew.token });
  assert.equal(notices.status, 200);
  assert.ok(notices.text.startsWith('notice,type,title,streets'));
  assert.ok(!/Exportson|Privateperson|example\.com/.test(notices.text));
});

test('import: residents who agreed elsewhere, the agreement confirmed and audited; a phone that said STOP stays stopped', async () => {
  const M = await createMuniTenant(base, { slug: `sn-imp-${suffix}` });
  const st = await addStreets(M.id, ['Hill Road']);
  await pool.query('UPDATE streets SET aliases = ? WHERE id = ?', ['Hill Rd', st['Hill Road']]);
  const stopped = newPhone();
  await signUp(M, { street: st['Hill Road'], house: '1', phone: stopped });
  await textBack(stopped, 'STOP');
  const a = newPhone(); const b = newPhone();
  const csv = `name,phone,email,street,house_number,unit,topics\nAnn Imported,${a},,Hill Rd,20,,leaves\nBo Imported,${b},bo.${suffix}@example.com,Hill Road,21,,\nCy Stopped,${stopped},,Hill Road,1A,,\nDee Nowhere,${newPhone()},,Lost Street,3,,\nEd NoContact,,,Hill Road,4,,`;
  assert.equal((await api('POST', '/street-notices/residents/import', { token: M.token, body: { csv, consent_note: 'Paper forms' } })).status, 400, 'the agreement must be confirmed');
  const crew = await M.addLogin('staff');
  assert.equal((await api('POST', '/street-notices/residents/import', { token: crew.token, body: { csv, consent: true, consent_note: 'Paper forms at the open house' } })).status, 403);
  const r = ok(await api('POST', '/street-notices/residents/import', { token: M.token, body: { csv, consent: true, consent_note: 'Paper forms at the open house' } }));
  assert.equal(r.added, 3); assert.equal(r.stopped, 1);
  assert.deepEqual(r.skipped.map((s) => s.line), [5, 6]);
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: notice({ areas: [{ street_id: st['Hill Road'] }] }) }), 201);
  assert.deepEqual([n.preview.texts, n.preview.emails, n.preview.opted_out], [2, 1, 1], 'the imported phone that texted STOP is not texted');
  const leaves = ok(await api('POST', '/street-notices/preview', { token: M.token, body: { type: 'leaf_collection', areas: [{ street_id: st['Hill Road'] }] } }));
  assert.equal(leaves.texts, 1, 'Ann picked leaf collection');
  const audit = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND entity = 'alert_signups' AND action = 'import'", [M.id]);
  assert.equal(audit.length, 1);
  const detail = typeof audit[0].detail === 'string' ? JSON.parse(audit[0].detail) : audit[0].detail;
  assert.equal(detail.consent_confirmed, true);
  assert.ok(!/Imported|example\.com/.test(JSON.stringify(detail)), 'no names or contacts in the audit trail');
  // Imported once: importing again adds nobody twice.
  assert.equal(ok(await api('POST', '/street-notices/residents/import', { token: M.token, body: { csv, consent: true, consent_note: 'Paper forms at the open house' } })).already, 3);
});

// ---------------------------------------------------------------- who may send, Today, gating
test('Crew send only when a manager allows it; Front desk never sends', async () => {
  const crew = await A.addLogin('staff');
  const desk = await A.addLogin('counter');
  const body = notice({ areas: [{ street_id: streetsA['Main Street'] }] });
  assert.equal((await api('POST', '/street-notices', { token: crew.token, body })).status, 403);
  assert.equal((await api('POST', '/street-notices', { token: desk.token, body })).status, 403);
  ok(await api('GET', '/street-notices', { token: crew.token }));
  assert.equal((await api('PUT', '/street-notices/settings', { token: crew.token, body: { crew_senders: [crew.id] } })).status, 403);
  assert.equal((await api('PUT', '/street-notices/settings', { token: A.token, body: { crew_senders: [desk.id] } })).status, 400, 'only Crew logins');
  ok(await api('PUT', '/street-notices/settings', { token: A.token, body: { crew_senders: [crew.id] } }));
  const n = ok(await api('POST', '/street-notices', { token: crew.token, body }), 201);
  assert.equal(ok(await api('GET', '/street-notices/setup', { token: crew.token })).can_send, true);
  ok(await api('DELETE', `/street-notices/${n.id}`, { token: crew.token }));
});

test('Today: active notices and residents who signed up this week', async () => {
  const M = await createMuniTenant(base, { slug: `sn-today-${suffix}` });
  const st = await addStreets(M.id, ['Ash Street']);
  assert.deepEqual(ok(await api('GET', '/street-notices/today', { token: M.token })).cards, []);
  await signUp(M, { street: st['Ash Street'], house: '3', phone: newPhone() });
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: notice({ areas: [{ street_id: st['Ash Street'] }] }) }), 201);
  ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true } }));
  await settled(M, n.id);
  const cards = ok(await api('GET', '/street-notices/today', { token: M.token })).cards;
  assert.deepEqual(cards.map((c) => [c.title, c.count]), [['Active street notices', 1], ['Alert sign-ups this week', 1]]);
  assert.ok(cards.every((c) => /^#\/notices/.test(c.href)));
});

test('gating and isolation: off for a ski area and with Resident requests off; one town never sees another\'s', async () => {
  const off = await createMuniTenant(base, { slug: `sn-off-${suffix}`, modules: { requests: false } });
  assert.equal((await api('GET', '/street-notices', { token: off.token })).status, 403);
  assert.equal((await api('GET', `/public/${off.slug}/alerts`)).status, 404);
  const ski = await api('POST', '/platform/tenants', { headers: { 'x-platform-key': process.env.BOOTSTRAP_KEY }, body: { slug: `sn-ski-${suffix}`, name: 'Ski Test', billing: 'comped', owner: { email: `gm@sn-ski-${suffix}.test`, password: 'correct-horse-battery', first_name: 'G', last_name: 'M' } } });
  assert.equal(ski.status, 201, ski.text);
  const skiToken = (await withoutMail(() => api('POST', '/auth/login', { body: { tenant: `sn-ski-${suffix}`, login: `gm@sn-ski-${suffix}.test`, password: 'correct-horse-battery' } }))).body.token;
  assert.equal((await api('GET', '/street-notices', { token: skiToken })).status, 403);
  assert.equal((await api('GET', `/public/sn-ski-${suffix}/alerts`)).status, 404);
  // B cannot read, change or send A's notice, nor preview A's streets.
  const n = ok(await api('POST', '/street-notices', { token: A.token, body: notice({ areas: [{ street_id: streetsA['Old Mill Road'] }] }) }), 201);
  assert.equal((await api('GET', `/street-notices/${n.id}`, { token: B.token })).status, 404);
  assert.equal((await api('POST', `/street-notices/${n.id}/send`, { token: B.token, body: { confirm: true } })).status, 404);
  assert.equal((await api('DELETE', `/street-notices/${n.id}`, { token: B.token })).status, 404);
  assert.equal((await api('POST', '/street-notices', { token: B.token, body: notice({ areas: [{ street_id: streetsA['Old Mill Road'] }] }) })).status, 400);
  const listB = ok(await api('GET', '/street-notices', { token: B.token }));
  assert.ok(!listB.data.some((x) => x.id === n.id));
  assert.equal(ok(await api('GET', '/street-notices/residents/streets', { token: B.token })).total, 0);
  // A's manage link does not open on B's page.
  const r = await signUp(A, { street: streetsA['Old Mill Road'], house: '8', phone: newPhone() });
  assert.equal((await api('GET', `/public/${B.slug}/alerts/manage/${r.manage.split('/manage/')[1]}`)).status, 404);
  ok(await api('DELETE', `/street-notices/${n.id}`, { token: A.token }));
});

test('the pages: sign-up, a notice and the manage link are served', async () => {
  for (const p of [`/alerts/${A.slug}`, `/alerts/${A.slug}/ABCDEF`, `/alerts/${A.slug}/manage/1.2.x`, `/alerts/${A.slug}/email/1.2.x`]) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 200, p);
    assert.match(await res.text(), /resident-alerts\.js/);
  }
});

test('a municipality\'s own texting number sends its alerts; without one, the shared number does', async () => {
  const M = await createMuniTenant(base, { slug: `sn-from-${suffix}` });
  const st = await addStreets(M.id, ['Birch Street']);
  const r = await signUp(M, { street: st['Birch Street'], house: '2', phone: newPhone() });
  assert.equal(textsTo(r.phone).at(-1).From, '+16105550000', 'the shared number');
  assert.equal((await api('PUT', '/street-notices/settings', { token: M.token, body: { from_number: '12' } })).status, 400);
  ok(await api('PUT', '/street-notices/settings', { token: M.token, body: { from_number: '(484) 555-0999' } }));
  assert.equal(ok(await api('GET', '/street-notices/settings', { token: M.token })).from_number, '+14845550999');
  const n = ok(await api('POST', '/street-notices', { token: M.token, body: notice({ areas: [{ street_id: st['Birch Street'] }] }) }), 201);
  ok(await api('POST', `/street-notices/${n.id}/send`, { token: M.token, body: { confirm: true } }));
  await settled(M, n.id);
  assert.equal(textsTo(r.phone).find((t) => t.Body.includes(n.code)).From, '+14845550999');
});
