'use strict';

// Staging: the private copy where each release is checked before it goes live. Nothing on it may reach a real guest
// or real money: a live Stripe key stops it starting, every email goes to the team's inbox, texts go nowhere, a shared
// password keeps the public out (except the health checks, the version and Stripe's webhook), and search engines are
// told to keep away. deploy.sh only ever targets staging; promote.sh puts staging's exact image live.
process.env.STAGE = 'staging';
process.env.STAGING_GATE = 'staging-gate-password-1';
process.env.STAGING_INBOX = 'team@dayos.test';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test';
process.env.MAIL_FROM = 'hello@dayos.test';
process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_FROM = '+15005550006';
delete process.env.STAGING_SMS_TO;

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const sent = { mail: [], sms: [] };
let fake; let server; let base;
test.before(async () => {
  fake = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/email') { sent.mail.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ErrorCode: 0, MessageID: 'm1' })); }
      sent.sms.push(body); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ sid: 'SM1' }));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  process.env.POSTMARK_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  const { createApp } = require('../src/app');
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r)); await new Promise((r) => fake.close(r));
  await require('../src/db').pool.end();
});

const html = { accept: 'text/html' };

test('a shared password stands in front of staging, and search engines are kept out', async () => {
  const home = await fetch(`${base}/`, { headers: html });
  assert.equal(home.status, 401);
  assert.match(await home.text(), /Verdynt\/OS staging/);
  assert.match(home.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await fetch(`${base}/api/v1/site/plans`)).status, 401, 'the API too');
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Disallow: \/\n/);

  const wrong = await fetch(`${base}/__staging`, { method: 'POST', body: new URLSearchParams({ password: 'nope', next: '/app' }), redirect: 'manual' });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${base}/__staging`, { method: 'POST', body: new URLSearchParams({ password: 'staging-gate-password-1', next: '/app' }), redirect: 'manual' });
  assert.equal(right.status, 303); assert.equal(right.headers.get('location'), '/app');
  const cookie = right.headers.get('set-cookie').split(';')[0];
  assert.match(right.headers.get('set-cookie'), /HttpOnly/i);
  const inside = await fetch(`${base}/api/v1/site/plans`, { headers: { cookie } });
  assert.equal(inside.status, 200, 'with the cookie, staging works as normal');
  assert.match(inside.headers.get('x-robots-tag'), /noindex/);
  assert.equal((await fetch(`${base}/api/v1/site/plans`, { headers: { cookie: 'dayos_staging=forged' } })).status, 401);

  const away = await fetch(`${base}/__staging`, { method: 'POST', body: new URLSearchParams({ password: 'staging-gate-password-1', next: '//evil.test/x' }), redirect: 'manual' });
  assert.equal(away.headers.get('location'), '/', 'never sends people off-site');
});

test('the health check, the version and Stripe stay open, and say which build is on staging', async () => {
  const ready = await (await fetch(`${base}/readyz`)).json();
  assert.equal(ready.ok, true); assert.equal(ready.stage, 'staging'); assert.ok(ready.build);
  assert.equal((await (await fetch(`${base}/version`)).json()).stage, 'staging', 'the app shows the staging band from this');
  assert.notEqual((await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', body: '{}' })).status, 401, 'Stripe test events reach staging');
});

test('every email goes to the team inbox, saying who it was for; no texts are sent', async () => {
  const mailer = require('../src/lib/mailer');
  const r = await mailer.sendPlatform({ to: 'guest@example.com', subject: 'Your lesson', text: 'Hi' });
  assert.equal(r.ok, true);
  const m = sent.mail.at(-1);
  assert.equal(m.To, 'team@dayos.test');
  assert.equal(m.Subject, '[Staging, for guest@example.com] Your lesson');

  const sms = require('../src/lib/sms');
  const t = await sms.send({ tenantId: 987654321, to: '+12155550123', body: 'Your lesson is cancelled' });
  assert.equal(t.ok, false);
  assert.equal(sent.sms.length, 0, 'nothing reached the text service');
});

test('staging refuses a live Stripe key', () => {
  const r = spawnSync(process.execPath, ['-e', "require('./src/config')"], { cwd: path.join(__dirname, '..'), env: { ...process.env, STAGE: 'staging', STRIPE_SECRET_KEY: 'sk_live_abc' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Stripe test key/);
  const ok = spawnSync(process.execPath, ['-e', "require('./src/config')"], { cwd: path.join(__dirname, '..'), env: { ...process.env, STAGE: 'staging', STRIPE_SECRET_KEY: 'sk_test_abc' }, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('deploy.sh only ever targets staging; promote.sh puts staging\'s exact image live after checks', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['deploy.sh', 'promote.sh', 'scripts/staging-setup.sh', 'scripts/cloud-common.sh']) execFileSync('bash', ['-n', path.join(root, f)]);
  const deploy = fs.readFileSync(path.join(root, 'deploy.sh'), 'utf8');
  assert.ok(deploy.indexOf('DAYOS_TARGET=summitops-staging') < deploy.indexOf('cloud-common.sh'), 'set before the shared settings are read');
  assert.ok(!/summitops-api|PROD_SERVICE/.test(deploy), 'never names the live service');
  const promote = fs.readFileSync(path.join(root, 'promote.sh'), 'utf8');
  assert.match(promote, /--image "\$IMAGE"/);
  assert.match(promote, /STG_BUILD" != "\$NEW_BUILD"/, 'stops unless staging runs this exact build');
  assert.match(promote, /read -r -p "Type \$NEW_VERSION/, 'asks for the version before going live');
  const common = fs.readFileSync(path.join(root, 'scripts/cloud-common.sh'), 'utf8');
  assert.match(common, /\[ "\$SERVICE" = "\$PROD_SERVICE" \] && secret_exists summitops-db-migrator/, 'staging never gets the live migration login');
});
