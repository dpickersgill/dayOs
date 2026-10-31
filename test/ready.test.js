'use strict';

// Ready for the busiest morning (2026.11.10, READY): rate limits shared by every server (MySQL), the console's one-time
// code claimed across servers, the public status page and its console notes, the load test's guard against the live
// site, the deploy scripts' server settings, the restore check, and the mountain's data exports.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.STATUS_CACHE_MS = '0';
// The status page's outside checks talk to stand-ins (started below) instead of Stripe, Postmark and Twilio.
const FAKE_PORT = 47000 + Math.floor(Math.random() * 2000);
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
// Stripe's settings and the addresses are read when the app loads; email and texts are switched on only for the status
// tests (with email on, an owner's sign-in from a new device asks for an emailed code).
Object.assign(process.env, {
  POSTMARK_API_BASE: `${FAKE}/postmark`, TWILIO_API_BASE: `${FAKE}/twilio`,
  STRIPE_SECRET_KEY: 'sk_test_ready', STRIPE_WEBHOOK_SECRET: 'whsec_ready', STRIPE_API_BASE: `${FAKE}/stripe`,
});
const MAIL_AND_TEXTS = { POSTMARK_SERVER_TOKEN: 'pm-test', MAIL_FROM: 'patrol@ready.test', TWILIO_ACCOUNT_SID: 'ACready', TWILIO_AUTH_TOKEN: 'tw-test', TWILIO_FROM: '+16105550100' };
const mailAndTexts = (on) => { for (const [k, v] of Object.entries(MAIL_AND_TEXTS)) { if (on) process.env[k] = v; else delete process.env[k]; } };

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const RS = require('../src/lib/ratestore');
const totp = require('../src/lib/totp');

const ROOT = path.join(__dirname, '..');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';
let server; let base; let fake; const kids = [];
const fakeAnswers = { postmark: 200, stripe: 401, twilio: 200 };
const seen = [];

async function api(method, p, { token, body, key, headers = {} } = {}, at = base) {
  const res = await fetch(`${at}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-platform-key': key, 'x-operator': 'tester' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const page = async (p, at = base) => { const r = await fetch(`${at}${p}`); return { status: r.status, text: await r.text(), headers: r.headers }; };

/** Another server on the same database: a child process, like a second Cloud Run instance. */
function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 46000 + Math.floor(Math.random() * 900);
    const kid = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(kid);
    let out = '';
    const t = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20_000);
    const on = (d) => { out += d; if (out.includes('listening on')) { clearTimeout(t); resolve(`http://127.0.0.1:${port}`); } };
    kid.stdout.on('data', on); kid.stderr.on('data', on);
    kid.on('exit', (code) => { if (!out.includes('listening on')) { clearTimeout(t); reject(new Error(`server stopped (${code}): ${out}`)); } });
  });
}

let owner;
test.before(async () => {
  fake = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const kind = req.url.split('/')[1];
    res.writeHead(fakeAnswers[kind] || 404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise((r) => { fake.listen(FAKE_PORT, '127.0.0.1', r); });
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `ready-${suffix}`;
  const res = await api('POST', '/tenants', { body: { slug, name: `Ready Mountain ${suffix}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }, headers: { 'x-bootstrap-key': KEY } });
  assert.equal(res.status, 201, res.text);
  owner = { slug, token: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
});
test.after(async () => {
  for (const k of kids) k.kill('SIGTERM');
  await pool.query("DELETE FROM status_notes WHERE title LIKE 'Ready test%'").catch(() => {});
  server.close(); fake.close();
  await pool.end();
});

// ---------------------------------------------------------------- the shared store
test('the MySQL store counts per limit and key, starts again when the window ends, and can give back or forget', async () => {
  const s = new RS.MysqlStore({ prefix: `t-${suffix}` });
  s.init({ windowMs: 400 });
  const hits = [];
  for (let i = 0; i < 3; i += 1) hits.push((await s.increment('203.0.113.9')).totalHits);
  assert.deepEqual(hits, [1, 2, 3]);
  assert.equal((await s.increment('203.0.113.10')).totalHits, 1, 'another address has its own count');
  const other = new RS.MysqlStore({ prefix: `u-${suffix}` }); other.init({ windowMs: 400 });
  assert.equal((await other.increment('203.0.113.9')).totalHits, 1, 'another limit has its own count');
  const reset = await s.resetTimeOf('203.0.113.9');
  assert.ok(reset instanceof Date && reset.getTime() > Date.now() && reset.getTime() <= Date.now() + 400);
  await s.decrement('203.0.113.9');
  assert.equal((await s.increment('203.0.113.9')).totalHits, 3, 'a count given back');
  await s.resetKey('203.0.113.9');
  assert.equal((await s.increment('203.0.113.9')).totalHits, 1, 'a forgotten key starts again');
  await new Promise((r) => { setTimeout(r, 450); });
  assert.equal((await s.increment('203.0.113.10')).totalHits, 1, 'the window ended, so it starts again');
  // No address is stored: the key is a hash of the limit and the address.
  const [rowsWithIp] = await pool.query("SELECT COUNT(*) AS n FROM rate_limits WHERE k LIKE '%203.0.113%'");
  assert.equal(Number(rowsWithIp[0].n), 0);
});

test('when the database cannot answer, the limit still holds in this server\'s memory', async () => {
  const broken = { query: () => Promise.reject(new Error('connection refused')) };
  const s = new RS.MysqlStore({ prefix: 'broken', pool: broken });
  s.init({ windowMs: 60_000 });
  assert.equal((await s.increment('a')).totalHits, 1);
  assert.equal((await s.increment('a')).totalHits, 2);
  const slow = { query: () => new Promise(() => {}) }; // never answers
  process.env.RATE_STORE_TIMEOUT_MS = '50';
  const t = new RS.MysqlStore({ prefix: 'slow', pool: slow }); t.init({ windowMs: 60_000 });
  const t0 = Date.now();
  assert.equal((await t.increment('a')).totalHits, 1);
  assert.ok(Date.now() - t0 < 1000, 'a slow database does not hold the request up');
  delete process.env.RATE_STORE_TIMEOUT_MS;
});

test('the daily clean-up removes counts a day past their window and keeps the rest', async () => {
  const crypto = require('node:crypto');
  const oldKey = crypto.randomBytes(32); const newKey = crypto.randomBytes(32);
  await pool.query('INSERT INTO rate_limits (k, hits, reset_ms) VALUES (?, 3, ?), (?, 3, ?)', [oldKey, Date.now() - 2 * 86_400_000, newKey, Date.now() - 3_600_000]);
  assert.ok((await RS.cleanup()) >= 1);
  const [left] = await pool.query('SELECT k FROM rate_limits WHERE k IN (?, ?)', [oldKey, newKey]);
  assert.deepEqual(left.map((r) => r.k.toString('hex')), [newKey.toString('hex')]);
  await pool.query('DELETE FROM rate_limits WHERE k = ?', [newKey]);
  assert.match(require('node:fs').readFileSync(path.join(ROOT, 'src/routes/followpublic.js'), 'utf8'), /stage\('rate_limits_cleanup'/, 'the daily job runs it');
});

test('two servers share one sign-in limit: the attempt over the limit is refused whichever server gets it', async () => {
  // A limit no earlier run used, so the window starts empty (the limit's name includes its maximum).
  const max = 5 + (Date.now() % 40);
  const env = { RATE_STORE: 'mysql', LOGIN_RATE_LIMIT: String(max), NODE_ENV: 'test' };
  const [a, b] = await Promise.all([startServer(env), startServer(env)]);
  // Logins nobody has, so no login's own lock (ten wrong passwords) gets in the way: only the limit per address counts.
  const body = (i) => ({ tenant: owner.slug, email: `nobody-${i}@${owner.slug}.test`, password: 'not-the-password' });
  const codes = [];
  for (let i = 0; i < max; i += 1) codes.push((await api('POST', '/auth/login', { body: body(i) }, i % 2 ? b : a)).status);
  assert.ok(codes.every((c) => c === 401), `every try inside the limit is answered: ${codes}`);
  const over = await api('POST', '/auth/login', { body: body(max) }, max % 2 ? b : a);
  assert.equal(over.status, 429, 'the next try, on either server, is over the shared limit');
  assert.ok(Number(over.headers.get('retry-after')) >= 1 && Number(over.headers.get('retry-after')) <= 60);
  assert.equal((await api('POST', '/auth/login', { body: body(max + 1) }, max % 2 ? a : b)).status, 429, 'and on the other one too');
});

test('a console sign-in code works once across servers, not once per server', async () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  const env = { RATE_STORE: 'mysql', PLATFORM_TOTP_SECRET: secret, PLATFORM_KEY_SIGNIN: 'on', NODE_ENV: 'test' };
  const [a, b] = await Promise.all([startServer(env), startServer(env)]);
  // A code for a moment no other run used: the next 30-second step, which verify() accepts for clock drift.
  const step = Math.floor(Date.now() / 30_000) + 1;
  const code = totpAt(secret, step);
  const first = await api('POST', '/platform/session', { body: { key: KEY, name: 'Dan', code } }, a);
  assert.equal(first.status, 200, first.text);
  const again = await api('POST', '/platform/session', { body: { key: KEY, name: 'Dan', code } }, b);
  assert.equal(again.status, 403, 'the second server refuses the same code');
  assert.match(again.body.error, /just used/);
});
/** The six digits for one 30-second step (RFC 6238), from lib/totp's own hotp when it is exported. */
function totpAt(secret, step) {
  if (typeof totp.hotp === 'function') return totp.hotp(secret, step);
  const crypto = require('node:crypto');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// ---------------------------------------------------------------- the status page
test('the status page checks each part itself: working, not working, or not checked', async () => {
  const before = await api('GET', '/status');
  assert.equal(before.body.parts.find((p) => p.key === 'email').word, 'Not checked', 'email not set up');
  assert.equal(before.body.parts.find((p) => p.key === 'texts').word, 'Not checked', 'texts not set up');
  mailAndTexts(true);
  const r = await api('GET', '/status');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /max-age=60/);
  const by = Object.fromEntries(r.body.parts.map((p) => [p.key, p]));
  assert.deepEqual(Object.keys(by), ['app', 'guest', 'payments', 'email', 'texts']);
  assert.equal(by.app.state, 'ok'); assert.equal(by.guest.state, 'ok');
  assert.equal(by.email.state, 'ok', 'Postmark answered');
  assert.equal(by.texts.state, 'ok', 'Twilio answered');
  assert.equal(by.payments.state, 'down', 'Stripe refused the key');
  assert.equal(by.payments.word, 'Not working');
  assert.equal(r.body.state, 'down');
  assert.equal(by.app.days.length, 90);
  assert.ok(seen.includes('GET /postmark/server') && seen.includes('GET /stripe/v1/balance') && seen.includes('GET /twilio/2010-04-01/Accounts/ACready.json'));
  fakeAnswers.stripe = 200;
  process.env.STATUS_PROBES = 'off';
  const off = await api('GET', '/status');
  assert.equal(off.body.parts.find((p) => p.key === 'payments').word, 'Not checked', 'outside checks can be turned off');
  delete process.env.STATUS_PROBES;
  assert.equal((await api('GET', '/status')).body.summary, 'Everything is working.');
  mailAndTexts(false);
});

test('the console writes incidents and planned maintenance; the page shows them, safely, for 90 days', async () => {
  assert.equal((await api('GET', '/platform/status')).status, 403, 'operators only');
  const live = await api('GET', '/platform/status', { key: KEY });
  assert.equal(live.status, 200);
  assert.equal(live.body.live.app, 'ok');
  const now = Date.now();
  const bad = await api('POST', '/platform/status', { key: KEY, body: { kind: 'incident', title: 'Ready test x', parts: ['nope'], impact: 'down', starts_at: new Date(now).toISOString() } });
  assert.equal(bad.status, 400);
  const backwards = await api('POST', '/platform/status', { key: KEY, body: { kind: 'incident', title: 'Ready test x', parts: ['payments'], impact: 'down', starts_at: new Date(now).toISOString(), ends_at: new Date(now - 60_000).toISOString() } });
  assert.equal(backwards.status, 400);
  const inc = await api('POST', '/platform/status', { key: KEY, body: { kind: 'incident', title: 'Ready test <script>alert(1)</script> card payments failing', body: 'Stripe is slow.\nWe are on it.', parts: ['payments'], impact: 'slow', starts_at: new Date(now - 5 * 60_000).toISOString() } });
  assert.equal(inc.status, 201, inc.text);
  const plan = await api('POST', '/platform/status', { key: KEY, body: { kind: 'maintenance', title: 'Ready test database upgrade', parts: ['app', 'guest'], impact: 'down', starts_at: new Date(now + 2 * 86_400_000).toISOString(), ends_at: new Date(now + 2 * 86_400_000 + 3_600_000).toISOString() } });
  assert.equal(plan.status, 201);

  const s = (await api('GET', '/status')).body;
  assert.equal(s.parts.find((p) => p.key === 'payments').state, 'slow', 'an open incident shows on its part');
  assert.equal(s.parts.find((p) => p.key === 'app').state, 'ok', 'maintenance that has not started changes nothing yet');
  assert.ok(s.open.some((n) => n.id === inc.body.id));
  assert.ok(s.planned.some((n) => n.id === plan.body.id));
  assert.equal(s.parts.find((p) => p.key === 'payments').days[89].state, 'slow', 'today is marked on the 90-day strip');

  const html = await page('/site/status');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('cache-control'), /max-age=60/);
  assert.ok(html.text.includes('Happening now') && html.text.includes('Planned maintenance'));
  assert.ok(html.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.text.includes('<script>alert(1)'), 'what the console writes is escaped');
  assert.ok(html.text.includes('Stripe is slow.<br>We are on it.'));
  assert.ok(!html.text.includes(owner.slug) && !html.text.includes(`Ready Mountain ${suffix}`), 'no mountain is named');
  assert.equal((html.text.match(/<h1[ >]/g) || []).length, 1);

  assert.equal((await api('PATCH', `/platform/status/${inc.body.id}`, { key: KEY, body: { body: 'Fixed by Stripe. Watching it.' } })).status, 200);
  assert.equal((await api('POST', `/platform/status/${inc.body.id}/end`, { key: KEY })).status, 200);
  const after = (await api('GET', '/status')).body;
  assert.equal(after.parts.find((p) => p.key === 'payments').state, 'ok');
  assert.ok(after.past.some((n) => n.id === inc.body.id && n.body === 'Fixed by Stripe. Watching it.'), 'an incident that is over stays in the last 90 days');
  assert.equal((await api('DELETE', `/platform/status/${plan.body.id}`, { key: KEY })).status, 200);
  assert.equal((await api('DELETE', `/platform/status/${plan.body.id}`, { key: KEY })).status, 404);
  const [audit] = await pool.query("SELECT action FROM platform_audit WHERE action LIKE 'status_note_%' AND detail LIKE ?", [`%${inc.body.id}%`]);
  assert.ok(['status_note_add', 'status_note_edit', 'status_note_end'].every((a) => audit.some((x) => x.action === a)), 'every change is in the console\'s activity');
});

test('the website links the status page from its footer and the Security page', async () => {
  const sec = await page('/site/security');
  assert.ok(sec.text.includes('href="/site/status">Status</a>'), 'footer');
  assert.ok(sec.text.includes('<a href="/site/status">status page</a>'), 'Security page');
  const map = await page('/site/sitemap.xml');
  assert.ok(map.text.includes('/status</loc>'));
});

// ---------------------------------------------------------------- the scripts Dan runs
// Run without blocking: the scripts talk to the server in this same process.
const run = (cmd, args, env = {}) => new Promise((resolve) => {
  const kid = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  let stdout = ''; let stderr = '';
  kid.stdout.on('data', (d) => { stdout += d; }); kid.stderr.on('data', (d) => { stderr += d; });
  const t = setTimeout(() => kid.kill('SIGKILL'), 60_000);
  kid.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
});

test('the load test refuses anything that is not staging or this computer, and runs a short holiday morning here', async () => {
  const port = server.address().port;
  const notStaging = await run(process.execPath, ['scripts/loadtest.js', '--url', `http://127.0.0.2:${port}`, '--mountain', owner.slug, '--login', 'x', '--password', 'y']);
  assert.equal(notStaging.status, 1);
  assert.match(notStaging.stderr, /is not staging/);
  const dryElsewhere = await run(process.execPath, ['scripts/loadtest.js', '--dry-run', '--url', 'https://app.runmyresort.com']);
  assert.equal(dryElsewhere.status, 1);
  assert.match(dryElsewhere.stderr, /only runs against this computer/);
  // A staging server (STAGE=staging) is allowed; --plan sends nothing but /version.
  const stg = await startServer({ STAGE: 'staging', NODE_ENV: 'test' });
  const planned = await run(process.execPath, ['scripts/loadtest.js', '--url', stg.replace('127.0.0.1', '127.0.0.2'), '--mountain', owner.slug, '--login', 'x', '--password', 'y', '--plan']);
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /\(staging\)/);
  // A few seconds of counters selling on this computer, with the numbers at the end.
  const ticket = await api('POST', '/products', { token: owner.token, body: { kind: 'day_ticket', name: 'Adult Day', base_price_cents: 6000 } });
  assert.equal(ticket.status, 201, ticket.text);
  const out = await run(process.execPath, ['scripts/loadtest.js', '--url', base, '--mountain', owner.slug, '--login', `owner@${owner.slug}.test`, '--password', PW, '--seconds', '3', '--gates', '0', '--counters', '2', '--sale-every', '1', '--shoppers', '0']);
  assert.equal(out.status, 0, out.stderr + out.stdout);
  assert.match(out.stdout, /counter sale\s+\d+/);
  assert.match(out.stdout, /p50 ms\s+p95 ms\s+p99 ms/);
});

test('promote.sh keeps one live server warm and grows to four, within the database\'s connections; staging stays at none', async () => {
  const promote = require('node:fs').readFileSync(path.join(ROOT, 'promote.sh'), 'utf8');
  const deploy = require('node:fs').readFileSync(path.join(ROOT, 'deploy.sh'), 'utf8');
  assert.match(promote, /LIVE_MIN_SERVERS="\$\{LIVE_MIN_SERVERS:-1\}"/);
  assert.match(promote, /LIVE_MAX_SERVERS="\$\{LIVE_MAX_SERVERS:-4\}"/);
  assert.match(promote, /--min-instances="\$LIVE_MIN_SERVERS" --max-instances="\$LIVE_MAX_SERVERS"/);
  assert.match(promote, /RATE_STORE=mysql/);
  assert.match(deploy, /--min-instances=0 --max-instances="\$\{STAGING_MAX_SERVERS:-1\}"/);
  for (const s of [promote, deploy]) assert.ok(!/\btest\//.test(s), 'neither needs anything from test/');
  // Too many servers for the database: it stops before touching anything (no gcloud is called).
  const tooMany = await run('bash', ['promote.sh'], { LIVE_MAX_SERVERS: '10', PATH: '/nonexistent:/usr/bin:/bin' });
  assert.equal(tooMany.status, 1);
  assert.match(tooMany.stdout, /10 servers x 8 connections, plus staging and tools, is 92 database connections, more than the budget of 60/);
  const wrong = await run('bash', ['scripts/uptime-setup.sh', '6105550123', 'dan']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /starts with \+ and the country code/);
});

test('the restore check reads a copy and says whether it is complete and migrated', async () => {
  const env = { DB_HOST: process.env.DB_HOST || '127.0.0.1', DB_PORT: process.env.DB_PORT || '3307', DRILL_PORT: process.env.DB_PORT || '3307', DRILL_DB_NAME: process.env.DB_NAME, DRILL_AT: new Date().toISOString() };
  const r = await run(process.execPath, ['scripts/restore-check.js'], env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /The copy is migrated for this release/);
  assert.match(r.stdout, /tenants\s+\d+\s+\d+/);
  const missing = await run(process.execPath, ['scripts/restore-check.js'], { ...env, DRILL_DB_NAME: 'information_schema' });
  assert.equal(missing.status, 1, 'a copy without the tables is reported');
});

test('a mountain can still export its data', async () => {
  for (const p of ['/people/export.csv', '/exports/sales.csv', '/exports/payments.csv', '/waivers/export.csv']) {
    const r = await api('GET', p, { token: owner.token });
    assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 200)}`);
    assert.match(r.headers.get('content-type'), /text\/csv/, p);
  }
});
