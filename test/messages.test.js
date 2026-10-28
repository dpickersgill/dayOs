'use strict';

// Messages to customers: who is reached (consent only), unsubscribe links, texts, no double sends, automatic reminders, isolation.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.JOBS_KEY = 'jobs-key-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const mailer = require('../src/lib/mailer');

let server; let base; let pm; let tw;
const mails = []; const texts = [];
const suffix = Date.now().toString(36) + Math.floor(Math.random() * 100);
const PW = 'correct-horse-battery';
let A; let B; const T = {};

const DEVICE = 'test-device-0123456789abcdef'; // the app always says which device signs in; leaving it out asks for an emailed code
async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE,  'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
async function mountain(slug) {
  const t = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, owner: { email: `o@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(t.status, 201);
  const l = await api('POST', '/auth/login', { body: { tenant: slug, email: `o@${slug}.test`, password: PW } });
  return { slug, token: l.body.token };
}
const person = async (token, extra) => (await api('POST', '/people', { token, body: { first_name: 'Pat', last_name: `P${Math.random().toString(36).slice(2, 7)}`, ...extra } })).body;
const listen = (server0, handler) => new Promise((r) => { server0 = http.createServer(handler); server0.listen(0, () => r(server0)); });

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  pm = await listen(null, (req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { const j = JSON.parse(d); mails.push(j); res.setHeader('content-type', 'application/json'); if (/fail@/.test(j.To)) { res.statusCode = 422; return res.end(JSON.stringify({ ErrorCode: 406, Message: 'Inactive recipient' })); } res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  tw = await listen(null, (req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { texts.push({ url: req.url, ...Object.fromEntries(new URLSearchParams(d)) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` })); }); });
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  A = await mountain(`ms-a-${suffix}`); B = await mountain(`ms-b-${suffix}`);
  for (const role of ['manager', 'counter']) {
    assert.equal((await api('POST', '/users', { token: A.token, body: { email: `${role}@${A.slug}.test`, password: PW, role } })).status, 201);
    T[role] = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `${role}@${A.slug}.test`, password: PW } })).body.token;
  }
});
test.after(async () => { server.close(); pm.close(); tw.close(); await pool.end(); });
const sentTo = (addr) => mails.filter((m) => m.To === addr);

test('only a manager sees messages; status says what is set up', async () => {
  assert.equal((await api('GET', '/messages/status', { token: T.counter })).status, 403);
  const s = await api('GET', '/messages/status', { token: T.manager });
  assert.equal(s.body.email_ready, true);
  assert.equal(s.body.sms_ready, true);
  assert.ok(s.body.audiences.some((a) => a.key === 'lapsed_passholders'));
});

test('a campaign reaches only people who agreed, once per address, and says how to stop', async () => {
  const yes1 = await person(T.counter, { first_name: 'Yes', email: `yes1${suffix}@example.com`, marketing_opt_in: true });
  const yes2 = await person(T.counter, { first_name: 'Sam', email: `yes2${suffix}@example.com`, marketing_opt_in: true });
  await person(T.counter, { first_name: 'No', email: `no${suffix}@example.com` });
  await person(T.counter, { first_name: 'Twin', email: `yes2${suffix}@example.com`.toUpperCase().replace('@EXAMPLE.COM', '@example.com'), marketing_opt_in: false });
  const fail = await person(T.counter, { first_name: 'Fay', email: `fail@f${suffix}.example.com`, marketing_opt_in: true });
  assert.ok(yes1.id && yes2.id && fail.id);
  const prev = await api('POST', '/messages/preview', { token: T.manager, body: { channel: 'email', audience: 'all' } });
  assert.equal(prev.body.count, 3);
  const c = await api('POST', '/messages/campaigns', { token: T.manager, body: { name: 'Opening day', channel: 'email', subject: 'We open Friday, {first_name}', body: 'Hi {first_name},\n\nLifts spin Friday at {mountain}.', audience: 'all' } });
  assert.equal(c.status, 201);
  assert.equal((await api('POST', `/messages/campaigns/${c.body.id}/send`, { token: T.manager, body: {} })).status, 400, 'must confirm');
  assert.equal((await api('POST', `/messages/campaigns/${c.body.id}/send`, { token: T.counter, body: { confirm: true } })).status, 403);
  const sent = await api('POST', `/messages/campaigns/${c.body.id}/send`, { token: T.manager, body: { confirm: true } });
  assert.equal(sent.status, 200);
  assert.deepEqual([sent.body.total, sent.body.sent, sent.body.failed], [3, 2, 1]);
  const m = sentTo(`yes1${suffix}@example.com`)[0];
  assert.equal(m.Subject, 'We open Friday, Yes');
  assert.match(m.TextBody, /Lifts spin Friday at Mount ms-a-/);
  assert.match(m.TextBody, /To stop: http.*\/api\/v1\/public\/unsub\/\d+\.\d+\.email\./);
  assert.match(m.Headers[0].Value, /public\/unsub\//);
  assert.equal(sentTo(`no${suffix}@example.com`).length, 0, 'never agreed');
  // The same message cannot go twice.
  assert.equal((await api('POST', `/messages/campaigns/${c.body.id}/send`, { token: T.manager, body: { confirm: true } })).status, 409);
  const d = await api('GET', `/messages/campaigns/${c.body.id}`, { token: T.manager });
  assert.equal(d.body.status, 'sent');
  assert.equal(d.body.problems.length, 1);
  assert.match(d.body.problems[0].error, /Inactive/);
  assert.equal((await api('PUT', `/messages/campaigns/${c.body.id}`, { token: T.manager, body: { name: 'x', channel: 'email', subject: 's', body: 'b', audience: 'all' } })).status, 409);
  assert.equal((await api('GET', `/messages/person/${yes1.id}`, { token: T.counter })).body.data[0].campaign, 'Opening day');
});

test('the unsubscribe link records the opt-out and stops later campaigns', async () => {
  const p = await person(T.counter, { first_name: 'Una', email: `una${suffix}@example.com`, marketing_opt_in: true });
  const c = await api('POST', '/messages/campaigns', { token: T.manager, body: { name: 'One', channel: 'email', subject: 'Hello', body: 'First', audience: 'all' } });
  await api('POST', `/messages/campaigns/${c.body.id}/send`, { token: T.manager, body: { confirm: true } });
  const url = /To stop: (\S+)/.exec(sentTo(`una${suffix}@example.com`)[0].TextBody)[1];
  const path = url.replace(base, '');
  const page = await fetch(base + path);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Stop these emails/);
  assert.equal((await api('GET', `/people/${p.id}`, { token: T.manager })).body.marketing_opt_in, 1, 'opening the page changes nothing');
  const done = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.match(await done.text(), /off the list/);
  assert.equal((await api('GET', `/people/${p.id}`, { token: T.manager })).body.marketing_opt_in, 0);
  const consent = await api('GET', `/people/${p.id}/consent`, { token: T.manager });
  assert.equal(consent.body.current.email.status, 'opted_out');
  assert.equal(consent.body.events[0].source, 'unsubscribe_link');
  const c2 = await api('POST', '/messages/campaigns', { token: T.manager, body: { name: 'Two', channel: 'email', subject: 'Again', body: 'Second', audience: 'all' } });
  await api('POST', `/messages/campaigns/${c2.body.id}/send`, { token: T.manager, body: { confirm: true } });
  assert.equal(sentTo(`una${suffix}@example.com`).length, 1, 'only the first campaign reached her');
  assert.equal((await fetch(`${base}/api/v1/public/unsub/1.1.email.${'0'.repeat(32)}`)).status, 404, 'a forged link is refused');
});

test('texts need their own consent, add the stop line, and go to one number once', async () => {
  const a = await person(T.counter, { first_name: 'Tex', phone: '610-555-0142' });
  const b = await person(T.counter, { first_name: 'Nope', phone: '610-555-0143' });
  assert.ok(b.id);
  await api('POST', `/people/${a.id}/consent`, { token: T.counter, body: { channel: 'sms', status: 'opted_in', source: 'counter' } });
  assert.equal((await api('POST', '/messages/campaigns', { token: T.manager, body: { name: 'Long', channel: 'sms', body: 'x'.repeat(400), audience: 'all' } })).status, 400);
  const c = await api('POST', '/messages/campaigns', { token: T.manager, body: { name: 'Snow', channel: 'sms', body: 'Hi {first_name}, 6 inches overnight.', audience: 'all' } });
  assert.equal((await api('POST', '/messages/preview', { token: T.manager, body: { channel: 'sms', audience: 'all' } })).body.count, 1);
  const r = await api('POST', `/messages/campaigns/${c.body.id}/send`, { token: T.manager, body: { confirm: true } });
  assert.deepEqual([r.body.total, r.body.sent], [1, 1]);
  const t = texts.find((x) => x.To === '+16105550142');
  assert.match(t.Body, /Hi Tex, 6 inches overnight\./);
  assert.match(t.Body, /Reply STOP to opt out/);
  assert.equal(t.From, '+16105550000');
  assert.equal(texts.some((x) => x.To === '+16105550143'), false);
  const test1 = await api('POST', `/messages/campaigns/${c.body.id}/test`, { token: T.manager, body: {} });
  assert.equal(test1.status, 400, 'a text test needs a number');
});

test('audiences: current pass holders and lapsed pass holders', async () => {
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [A.slug]);
  const [pr] = await pool.query("INSERT INTO products (tenant_id, name, kind, base_price_cents) VALUES (?, 'Season pass', 'season_pass', 50000)", [t.id]);
  const [or] = await pool.query("INSERT INTO orders (tenant_id, status, channel, total_cents) VALUES (?, 'paid', 'window', 50000)", [t.id]);
  const mk = async (name, from, to) => {
    const p = await person(T.counter, { first_name: name, email: `${name.toLowerCase()}${suffix}@example.com`, marketing_opt_in: true });
    const [oi] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, quantity, unit_price_cents, line_kind) VALUES (?, ?, ?, 1, 50000, 'ticket')", [t.id, or.insertId, pr.insertId]);
    await pool.query("INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)", [t.id, oi.insertId, p.id, pr.insertId, `P${Math.random().toString(36).slice(2, 12).toUpperCase()}${name}`.slice(0, 20), from, to]);
    return p;
  };
  await mk('Current', '2020-01-01', '2099-12-31');
  await mk('Lapsed', '2019-01-01', '2020-04-01');
  const cur = await api('POST', '/messages/preview', { token: T.manager, body: { channel: 'email', audience: 'passholders' } });
  assert.deepEqual(cur.body.sample, ['Current']);
  const lap = await api('POST', '/messages/preview', { token: T.manager, body: { channel: 'email', audience: 'lapsed_passholders' } });
  assert.deepEqual(lap.body.sample, ['Lapsed']);
});

test('the daily job sends rental and pass reminders once each', async () => {
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [A.slug]);
  const p = await person(T.counter, { first_name: 'Ray', email: `ray${suffix}@example.com` });
  await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, status, due_at) VALUES (?, ?, 'out', NOW() - INTERVAL 5 HOUR)", [t.id, p.id]);
  const [pr] = await pool.query("INSERT INTO products (tenant_id, name, kind, base_price_cents) VALUES (?, 'Pass B', 'season_pass', 40000)", [t.id]);
  const [or] = await pool.query("INSERT INTO orders (tenant_id, status, channel, total_cents) VALUES (?, 'paid', 'window', 40000)", [t.id]);
  const [oi] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, quantity, unit_price_cents, line_kind) VALUES (?, ?, ?, 1, 40000, 'ticket')", [t.id, or.insertId, pr.insertId]);
  await pool.query("INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, '2020-01-01', DATE_ADD(CURDATE(), INTERVAL 5 DAY))", [t.id, oi.insertId, p.id, pr.insertId, `R${suffix}RAY`.padEnd(12, '0').slice(0, 20)]);
  assert.equal((await api('POST', '/internal/jobs/daily', {})).status, 401);
  const run = () => api('POST', '/internal/jobs/daily', { headers: { 'x-jobs-key': 'jobs-key-for-tests' } });
  assert.equal((await run()).status, 200);
  const got = sentTo(`ray${suffix}@example.com`);
  assert.equal(got.length, 2);
  assert.ok(got.some((m) => /overdue/.test(m.Subject)));
  assert.ok(got.some((m) => /season pass ends/.test(m.Subject)));
  assert.doesNotMatch(got[0].TextBody, /unsub/, 'a note about their own rental needs no unsubscribe');
  await run();
  assert.equal(sentTo(`ray${suffix}@example.com`).length, 2, 'a second run sends nothing new');
});

test('another mountain cannot see or send these', async () => {
  const c = await api('POST', '/messages/campaigns', { token: T.manager, body: { name: 'Mine', channel: 'email', subject: 'Hi', body: 'Hello', audience: 'all' } });
  for (const [m, path, body] of [['GET', `/messages/campaigns/${c.body.id}`], ['POST', `/messages/campaigns/${c.body.id}/send`, { confirm: true }], ['DELETE', `/messages/campaigns/${c.body.id}`]]) {
    assert.equal((await api(m, path, { token: B.token, body })).status, 404, `${m} ${path}`);
  }
  assert.equal((await api('GET', '/messages/campaigns', { token: B.token })).body.data.length, 0);
  assert.equal((await api('DELETE', `/messages/campaigns/${c.body.id}`, { token: T.manager })).status, 200);
});

test('a mountain with Messages turned off gets nothing', async () => {
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [B.slug]);
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'messages', 0) ON DUPLICATE KEY UPDATE enabled = 0", [t.id]);
  require('../src/lib/modules').invalidate(t.id);
  assert.equal((await api('GET', '/messages/status', { token: B.token })).status, 403);
});
