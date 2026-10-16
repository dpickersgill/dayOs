'use strict';

// The product website: its pages at /site everywhere and at / on its own address, robots and sitemap, live plans from the
// console, and the Contact form (kept for the console's Leads and emailed through a mock Postmark).
const http = require('node:http');
const mails = [];
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => { mails.push(JSON.parse(body || '{}')); res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"m"}'); });
});
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SITE_CONTACT_LIMIT = '1000';
process.env.SITE_HOSTS = 'www.site.test';
process.env.SITE_CONTACT_EMAIL = 'sales@site.test';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test';
process.env.MAIL_FROM = 'hello@site.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const KEY = 'test-bootstrap-key';
async function get(path, host) {
  const res = await fetch(`${base}${path}`, { headers: { accept: 'text/html', ...(host ? { 'x-forwarded-host': host, host } : {}) }, redirect: 'manual' });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') || '', location: res.headers.get('location') };
}
// fetch will not set Host, so ask Node's http client directly for the website's own address
function onHost(path, host = 'www.site.test') {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ hostname: u.hostname, port: u.port, path, headers: { host, accept: 'text/html' } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t, type: res.headers['content-type'] || '' }));
    }).on('error', reject);
  });
}
const api = async (method, path, body, key) => {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
};

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stub.address().port}`;
  require('../src/lib/mailer').settings.apiBase = process.env.POSTMARK_API_BASE;
  const { createApp } = require('../src/app');
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stub.close(r)); await pool.end(); });

test('every page is at /site, with its links kept under /site', async () => {
  assert.equal((await get('/site')).status, 301);
  for (const p of ['/site/', '/site/product', '/site/pricing', '/site/security', '/site/contact', '/site/privacy', '/site/terms']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.type, /text\/html/);
    assert.ok(!r.text.includes('{{') && !r.text.includes('<!--HEADER') && !r.text.includes('<!--FOOTER'), `${p} has every token filled`);
    assert.ok(r.text.includes('href="/site/pricing"'), `${p} links within /site`);
  }
  assert.equal((await get('/site/nope')).status, 404);
  const app = await get('/');
  assert.ok(app.text.includes('/js/main.js'), 'the app keeps / on its own address');
});

test('on the website address, the pages are at the top, with robots, a sitemap and a not-found page', async () => {
  const home = await onHost('/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('Open the mountain from one screen.'));
  assert.ok(home.text.includes('href="/pricing"') && home.text.includes('href="/app"') && home.text.includes('href="/try"'));
  assert.ok(home.text.includes('rel="canonical" href="http://www.site.test/"'));
  assert.equal((await onHost('/pricing')).status, 200);
  assert.equal((await onHost('/pricing/')).status, 200);
  const robots = await onHost('/robots.txt');
  assert.match(robots.text, /Sitemap: http:\/\/www\.site\.test\/sitemap\.xml/);
  const map = await onHost('/sitemap.xml');
  assert.ok(map.text.includes('<loc>http://www.site.test/security</loc>'));
  const lost = await onHost('/no-such-page');
  assert.equal(lost.status, 404);
  assert.ok(lost.text.includes('isn\'t on the map'));
  assert.ok((await onHost('/app')).text.includes('/js/main.js'), 'the app is at /app on the website address');
  assert.equal((await onHost('/try')).status, 200, 'the demo page still works there');
});

test('the Pricing page reads the active plans and add-ons set in the console', async () => {
  const code = `site-${suffix}`;
  const made = await api('POST', '/platform/billing/plans', { code, name: `Site Plan ${suffix}`, kind: 'plan', modules: ['sell', 'gate', 'assets'], monthly_cents: 12300, yearly_cents: 120000, blurb: 'For testing' }, KEY);
  assert.equal(made.status, 201);
  const r = await api('GET', '/site/plans');
  assert.equal(r.status, 200);
  const p = r.body.plans.find((x) => x.code === code);
  assert.ok(p, 'a new plan shows straight away');
  assert.equal(p.monthly_cents, 12300);
  assert.deepEqual(p.apps.map((a) => a.label), ['Sell', 'Gate', 'Assets and fleet']);
  assert.equal(r.body.trial_days, 14);
  assert.ok(!('id' in p) && !('stripe_product' in p), 'nothing internal');
  await api('PATCH', `/platform/billing/plans/${made.body.id}`, { active: false }, KEY);
  assert.ok(!(await api('GET', '/site/plans')).body.plans.some((x) => x.code === code), 'a hidden plan leaves the website');
});

test('the Contact form keeps the request for Leads and emails it, and bots and bad input are turned away', async () => {
  assert.equal((await api('POST', '/site/contact', { name: 'A', mountain: 'B', email: 'not-an-email' })).status, 400);
  mails.length = 0;
  const bot = await api('POST', '/site/contact', { name: 'Bot', mountain: `Bot ${suffix}`, email: 'bot@x.test', website: 'http://spam' });
  assert.equal(bot.status, 201);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM site_leads WHERE mountain = ?', [`Bot ${suffix}`]))[0][0].n, 0, 'the hidden field catches it');
  assert.equal(mails.length, 0);
  const ok = await api('POST', '/site/contact', { kind: 'trial', name: 'Pat Patroller', mountain: `Ridge ${suffix}`, email: 'pat@ridge.test', lifts: '3 to 5', plan_interest: 'Mountain', message: 'Volunteer patrol of 30', founding: true });
  assert.equal(ok.status, 201); assert.equal(ok.body.copy, true);
  const row = (await pool.query('SELECT * FROM site_leads WHERE mountain = ?', [`Ridge ${suffix}`]))[0][0];
  assert.equal(row.kind, 'trial'); assert.equal(row.founding, 1); assert.equal(row.emailed, 1); assert.ok(row.ip_hash && !row.ip_hash.includes('127.0.0.1'));
  assert.equal(mails.length, 2);
  assert.equal(mails[0].To, 'sales@site.test'); assert.equal(mails[0].ReplyTo, 'pat@ridge.test');
  assert.match(mails[0].Subject, /14-day trial request/); assert.match(mails[0].TextBody, /Volunteer patrol of 30/);
  assert.equal(mails[1].To, 'pat@ridge.test');

  // The console's Leads
  const list = await api('GET', '/platform/leads?status=new', null, KEY);
  assert.equal(list.status, 200);
  const lead = list.body.data.find((l) => l.mountain === `Ridge ${suffix}`);
  assert.ok(lead && list.body.new_count >= 1);
  assert.equal((await api('GET', '/platform/leads')).status, 403, 'the console key is needed');
  assert.equal((await api('PATCH', `/platform/leads/${lead.id}`, { status: 'contacted', operator_note: 'Called Tuesday' }, KEY)).status, 200);
  const after = (await api('GET', '/platform/leads?status=contacted', null, KEY)).body.data.find((l) => l.id === lead.id);
  assert.equal(after.operator_note, 'Called Tuesday');
});
