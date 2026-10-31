'use strict';

// Signing in, 2026.11.10 (what an outside tester reported): what the sign-in page may offer for a mountain (a demo sends
// no email; a server with no email set up offers no email sign-in), a session whose last tab closed ends two minutes later
// unless it is used again, "Where you are signed in" lists only open sessions with when each ends, usernames are not case
// sensitive and come back as saved, and the browser side: Remember me, show password, the 10-minute tab lock with two
// tabs (Playwright, skipped when it is not installed).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
let mailServer;
const mails = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const DEV = 'signin10-device-0123456789abcdef';

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-device': DEV, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const login = async (tenant, who, password = PW) => (await api('POST', '/auth/login', { body: { tenant, login: who, password } })).body.token;
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const id = (await res.json()).tenant_id;
  return { slug, id, owner: await login(slug, `owner@${slug}.test`) };
}
const sidOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sid;
const sessionRow = async (token) => (await pool.query('SELECT * FROM user_sessions WHERE id_hash = ?', [require('../src/lib/sessions').hash(sidOf(token))]))[0][0];

let A; let D;
const saved = {};
test.before(async () => {
  for (const k of ['POSTMARK_SERVER_TOKEN', 'MAIL_FROM', 'POSTMARK_API_BASE']) saved[k] = process.env[k];
  delete process.env.POSTMARK_SERVER_TOKEN;
  // A stand-in for Postmark: takes the email and says it was sent.
  mailServer = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { mails.push(JSON.parse(d)); } catch (_) { /* fine */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m${mails.length}` })); }); });
  await new Promise((r) => mailServer.listen(0, '127.0.0.1', r));
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`sa-${suffix}`);
  D = await mountain(`sd-${suffix}`);
  await pool.query('UPDATE tenants SET sandbox_expires_at = DATE_ADD(NOW(), INTERVAL 5 DAY) WHERE id = ?', [D.id]);
});
test.after(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  server.close(); mailServer.close();
  await pool.end();
});
const mailOn = () => { process.env.POSTMARK_SERVER_TOKEN = 'pm_test'; process.env.MAIL_FROM = 'mountain@example.test'; require('../src/lib/mailer').settings.apiBase = `http://127.0.0.1:${mailServer.address().port}`; };
const mailOff = () => { delete process.env.POSTMARK_SERVER_TOKEN; };

test('the sign-in page learns what it may offer: demo mountains and a server with no email offer no email sign-in', async (t) => {
  mailOff();
  t.after(mailOff);
  let o = (await api('GET', `/auth/signin-options?tenant=${A.slug}`)).body;
  assert.deepEqual(o, { tenant: A.slug, known: true, demo: false, demo_over: false, email_set_up: false, email_codes: false }, 'no email set up: nothing to offer by email');
  mailOn();
  o = (await api('GET', `/auth/signin-options?tenant=${A.slug}`)).body;
  assert.equal(o.email_codes, true, 'a normal mountain with email set up');
  o = (await api('GET', `/auth/signin-options?tenant=${D.slug}`)).body;
  assert.equal(o.demo, true); assert.equal(o.email_codes, false, 'a demo never sends email, so the page says so');
  o = (await api('GET', '/auth/signin-options?tenant=no-such-mountain-here'));
  assert.equal(o.status, 200); assert.equal(o.body.known, false, 'a mistyped mountain is said plainly');
  o = (await api('GET', '/auth/signin-options?tenant=Bad%20Name!'));
  assert.equal(o.body.tenant, null); assert.equal(o.body.known, false);
  assert.ok(!('login' in o.body) && !('user' in o.body), 'it says nothing about any login');
  mailOff();
});

test('"Email me a code" answers the same for a real login, an unknown one and a demo', async (t) => {
  mailOn();
  t.after(mailOff);
  const before = mails.length;
  const real = await api('POST', '/auth/email-code', { body: { tenant: A.slug, login: `owner@${A.slug}.test`, purpose: 'reset' } });
  const unknown = await api('POST', '/auth/email-code', { body: { tenant: A.slug, login: 'nobody-here', purpose: 'reset' } });
  const demo = await api('POST', '/auth/email-code', { body: { tenant: D.slug, login: `owner@${D.slug}.test`, purpose: 'reset' } });
  for (const r of [real, unknown, demo]) { assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.body).sort(), ['minutes', 'request']); }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mails.length - before, 1, 'only the real login on the normal mountain was emailed');
  mailOff();
});

test('a session whose last tab closed ends two minutes later, unless it is used again first (a reload)', async () => {
  const t = await login(A.slug, `owner@${A.slug}.test`);
  assert.equal((await api('POST', '/auth/closing', { token: t, headers: { 'x-poll': '1' } })).status, 204);
  assert.ok((await sessionRow(t)).closing_at, 'marked closing');
  // A reload uses it again within seconds: still open, and the mark is cleared.
  assert.equal((await api('GET', '/auth/me', { token: t })).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await sessionRow(t)).closing_at, null, 'used again: no longer closing');
  // Closed for good: two minutes later it no longer works, and the list does not show it.
  await api('POST', '/auth/closing', { token: t, headers: { 'x-poll': '1' } });
  await pool.query('UPDATE user_sessions SET closing_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 MINUTE) WHERE id_hash = ?', [require('../src/lib/sessions').hash(sidOf(t))]);
  assert.equal((await api('GET', '/auth/me', { token: t })).status, 401, 'a closed browser does not come back');
  const sec = (await api('GET', '/auth/security', { token: A.owner })).body;
  assert.ok(!sec.sessions.some((s) => s.id === require('../src/lib/sessions').hash(sidOf(t)).slice(0, 16)), 'not listed');
  // Without a token there is nothing to mark.
  assert.equal((await api('POST', '/auth/closing', { headers: { 'x-poll': '1' } })).status, 401);
});

test('"Where you are signed in": open sessions only, with last use, when each ends, and this tab', async () => {
  const owner = `owner@${A.slug}.test`;
  const here = await login(A.slug, owner);
  const other = await login(A.slug, owner);
  const idle = await login(A.slug, owner);
  const old = await login(A.slug, owner);
  const hash = (t) => require('../src/lib/sessions').hash(sidOf(t));
  await pool.query('UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 12 MINUTE) WHERE id_hash = ?', [hash(other)]);
  await pool.query('UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 61 MINUTE) WHERE id_hash = ?', [hash(idle)]);
  await pool.query('UPDATE user_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id_hash = ?', [hash(old)]);
  // A shared terminal session idle 20 minutes is past its 15-minute limit.
  const [term] = await pool.query("INSERT INTO terminals (tenant_id, name, secret_hash, created_at) VALUES (?, 'Window 9', ?, UTC_TIMESTAMP())", [A.id, `t${suffix}`.padEnd(64, '0')]);
  const pinT = await login(A.slug, owner);
  await pool.query('UPDATE user_sessions SET terminal_id = ?, last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 MINUTE) WHERE id_hash = ?', [term.insertId, hash(pinT)]);
  const sec = (await api('GET', '/auth/security', { token: here })).body;
  const ids = sec.sessions.map((s) => s.id);
  assert.ok(ids.includes(hash(here).slice(0, 16)) && ids.includes(hash(other).slice(0, 16)));
  for (const gone of [idle, old, pinT]) assert.ok(!ids.includes(hash(gone).slice(0, 16)), 'past a limit: never listed');
  const mine = sec.sessions.find((s) => s.current);
  assert.equal(mine.id, hash(here).slice(0, 16), 'this tab is marked');
  const o = sec.sessions.find((s) => s.id === hash(other).slice(0, 16));
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sec.now));
  const mins = (a, b) => (Date.parse(`${a.replace(' ', 'T')}Z`) - Date.parse(`${b.replace(' ', 'T')}Z`)) / 60000;
  assert.ok(Math.abs(mins(sec.now, o.last_seen) - 12) < 1.5, 'last used 12 minutes ago');
  assert.ok(Math.abs(mins(o.ends_at, o.last_seen) - 60) < 0.1, 'ends an hour after its last use');
  // Near the 8-hour end, the end comes first.
  await pool.query('UPDATE user_sessions SET expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE id_hash = ?', [hash(other)]);
  const o2 = (await api('GET', '/auth/security', { token: here })).body.sessions.find((s) => s.id === hash(other).slice(0, 16));
  assert.ok(mins(o2.ends_at, sec.now) < 6, 'the 8-hour end when it is sooner');
  // Signing one out from the list, then everywhere else.
  assert.equal((await api('DELETE', `/auth/sessions/${o.id}`, { token: here })).status, 200);
  assert.equal((await api('GET', '/auth/me', { token: other })).status, 401);
  assert.equal((await api('POST', '/auth/sessions/end-others', { token: here })).status, 200);
  assert.equal((await api('GET', '/auth/security', { token: here })).body.sessions.length, 1);
  // Another mountain's owner never sees these.
  const otherSec = (await api('GET', '/auth/security', { token: D.owner })).body;
  assert.ok(!otherSec.sessions.some((s) => s.id === hash(here).slice(0, 16)));
});

test('usernames are not case sensitive, and come back as saved', async () => {
  A.owner = await login(A.slug, `owner@${A.slug}.test`); // the last test signed out everywhere else
  const made = await api('POST', '/users', { token: A.owner, body: { username: 'JSmith', password: PW, role: 'staff' } });
  assert.equal(made.status, 201); assert.equal(made.body.username, 'jsmith');
  assert.ok(await login(A.slug, 'JSMITH'), 'any case signs in');
  const edited = await api('PATCH', `/users/${made.body.id}`, { token: A.owner, body: { username: 'J.Smith' } });
  assert.equal(edited.status, 200); assert.equal(edited.body.username, 'j.smith', 'the edit answers with the username as saved');
  assert.ok(await login(A.slug, 'j.SMITH'));
});

test('a failed sign-in still gives nothing away', async () => {
  const wrongPw = await api('POST', '/auth/login', { body: { tenant: A.slug, login: `owner@${A.slug}.test`, password: 'not-the-password-1' } });
  const unknown = await api('POST', '/auth/login', { body: { tenant: A.slug, login: 'nobody-at-all', password: 'not-the-password-1' } });
  const noMountain = await api('POST', '/auth/login', { body: { tenant: 'no-such-mountain-here', login: 'x', password: 'not-the-password-1' } });
  for (const r of [wrongPw, unknown, noMountain]) { assert.equal(r.status, 401); assert.equal(r.body.error, 'Invalid credentials'); }
});

// ---------------------------------------------------------------- the browser side (Playwright)
let chromium = null;
try { ({ chromium } = require('/usr/local/lib/node_modules_global/playwright')); } catch (_) { try { ({ chromium } = require('playwright')); } catch (__) { chromium = null; } }

test('in the browser: Remember me, show password, two tabs, and the 10-minute tab lock', { skip: chromium ? false : 'Playwright is not installed here', timeout: 120_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    // The idle clock runs 600 times faster: 10 minutes is one second.
    await ctx.addInitScript(() => { window.__SO_IDLE_SPEED__ = 600; });
    const tab1 = await ctx.newPage();
    await tab1.goto(`${base}/`);
    await tab1.fill('input[name=tenant]', A.slug);
    await tab1.fill('input[name=login]', `owner@${A.slug}.test`);
    await tab1.fill('input[name=password]', PW);
    // Show password: the box shows what was typed, and says so to a screen reader.
    const eye = tab1.locator('.pw-reveal').first();
    assert.equal(await eye.getAttribute('aria-pressed'), 'false');
    await eye.click();
    assert.equal(await tab1.getAttribute('input[name=password]', 'type'), 'text');
    assert.equal(await eye.getAttribute('aria-pressed'), 'true');
    await eye.click();
    assert.equal(await tab1.getAttribute('input[name=password]', 'type'), 'password');
    await tab1.check('input[name=remember]');
    // Keep tab 1 in use while it signs in (the fast clock would lock it).
    const busy = setInterval(() => { tab1.mouse.move(Math.random() * 300, Math.random() * 300).catch(() => {}); }, 150);
    await tab1.click('form[data-step=signin] button[type=submit]');
    await tab1.waitForSelector('#main', { timeout: 15000 });
    const stored = await tab1.evaluate(() => ({ shared: localStorage.getItem('so.token'), tab: sessionStorage.getItem('so.token'), remember: localStorage.getItem('so.remember') }));
    assert.ok(stored.shared && !stored.tab, 'the token is shared by the tabs of this browser');
    assert.equal(JSON.parse(stored.remember).login, `owner@${A.slug}.test`);
    assert.ok(!/correct-horse/.test(JSON.stringify(stored)), 'never the password');
    // A reload of the only tab stays signed in (the token steps aside while it reloads, and comes back).
    await tab1.reload();
    await tab1.waitForSelector('#main .page-head', { timeout: 15000 });
    assert.equal(await tab1.evaluate(() => localStorage.getItem('so.token')), stored.shared, 'the same sign-in after a reload');
    // A second tab (a link opened in a new tab) opens signed in.
    const tab2 = await ctx.newPage();
    const busy2 = setInterval(() => { tab2.mouse.move(Math.random() * 300, Math.random() * 300).catch(() => {}); }, 150);
    await tab2.goto(`${base}/#/settings`);
    await tab2.waitForSelector('#main', { timeout: 15000 });
    assert.ok(!(await tab2.$('form[data-step=signin]')), 'no sign-in asked in the new tab');
    // Tab 2 goes idle: it locks itself; tab 1 carries on.
    clearInterval(busy2);
    await tab2.waitForSelector('form[data-step=locked]', { timeout: 15000 });
    assert.match(await tab2.textContent('h1'), /Locked after 10 minutes/);
    assert.ok(await tab2.evaluate(() => sessionStorage.getItem('so.locked')), 'locked, also after a reload');
    await tab2.reload();
    await tab2.waitForSelector('form[data-step=locked]', { timeout: 15000 });
    assert.ok(await tab1.evaluate(() => Boolean(localStorage.getItem('so.token'))), 'the other tab is still signed in');
    assert.equal((await api('GET', '/auth/me', { token: stored.shared })).status, 200, 'the session is still open');
    assert.ok(!(await tab1.$('form[data-step=locked]')), 'tab 1 did not lock');
    // Unlock tab 2 with the password: it opens where it was, and the shared sign-in is the new one.
    const b2 = setInterval(() => { tab2.mouse.move(Math.random() * 300, Math.random() * 300).catch(() => {}); }, 150);
    await tab2.fill('form[data-step=locked] input[name=password]', PW);
    await tab2.click('form[data-step=locked] button[type=submit]');
    await tab2.waitForSelector('#main .page-head', { timeout: 15000 });
    assert.match(tab2.url(), /#\/settings/);
    const after = await tab2.evaluate(() => localStorage.getItem('so.token'));
    assert.ok(after && after !== stored.shared, 'a fresh sign-in replaced the shared one');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await api('GET', '/auth/me', { token: stored.shared })).status, 401, 'the old session ended');
    // Every tab goes idle: both lock, the shared token leaves the browser, and the server session ends.
    clearInterval(busy); clearInterval(b2);
    await tab1.waitForSelector('form[data-step=locked]', { timeout: 15000 });
    await tab2.waitForSelector('form[data-step=locked]', { timeout: 15000 });
    await tab1.waitForFunction(() => !localStorage.getItem('so.token'), null, { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await api('GET', '/auth/me', { token: after })).status, 401, 'the server session ended');
    // A new tab now asks to sign in, with the mountain and username filled in (never the password).
    const tab3 = await ctx.newPage();
    await tab3.goto(`${base}/`);
    await tab3.waitForSelector('form[data-step=signin]');
    assert.match(await tab3.textContent('.signin-mountain'), new RegExp(`Mountain: ${A.slug}`));
    assert.equal(await tab3.inputValue('input[name=login]'), `owner@${A.slug}.test`);
    assert.equal(await tab3.inputValue('input[name=password]'), '');
    assert.equal(await tab3.isChecked('input[name=remember]'), true);
    await ctx.close();

    // Remember me, then the last tab closes: the token leaves the browser and the server ends the session soon after.
    const ctxC = await browser.newContext();
    const c1 = await ctxC.newPage();
    await c1.goto(`${base}/`);
    await c1.fill('input[name=tenant]', A.slug);
    await c1.fill('input[name=login]', `owner@${A.slug}.test`);
    await c1.fill('input[name=password]', PW);
    await c1.check('input[name=remember]');
    await c1.click('form[data-step=signin] button[type=submit]');
    await c1.waitForSelector('#main .page-head', { timeout: 15000 });
    const closedTok = await c1.evaluate(() => localStorage.getItem('so.token'));
    const keep = await ctxC.newPage(); // a page of the browser on another site, so the browser itself stays open
    await keep.goto('about:blank');
    await c1.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 800));
    const c2 = await ctxC.newPage();
    await c2.goto(`${base}/`);
    await c2.waitForSelector('form[data-step=signin]');
    assert.ok((await sessionRow(closedTok)).closing_at, 'the server was told the last tab closed');
    await ctxC.close();

    // Without Remember me: one tab only, the mountain alone is remembered, and a new tab asks to sign in.
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript(() => { window.__SO_IDLE_SPEED__ = 600; });
    const p = await ctx2.newPage();
    const busy3 = setInterval(() => { p.mouse.move(Math.random() * 300, Math.random() * 300).catch(() => {}); }, 150);
    await p.goto(`${base}/`);
    await p.fill('input[name=tenant]', A.slug);
    await p.fill('input[name=login]', `owner@${A.slug}.test`);
    await p.fill('input[name=password]', PW);
    await p.click('form[data-step=signin] button[type=submit]');
    await p.waitForSelector('#main', { timeout: 15000 });
    const s2 = await p.evaluate(() => ({ shared: localStorage.getItem('so.token'), tab: sessionStorage.getItem('so.token'), remember: localStorage.getItem('so.remember') }));
    assert.ok(s2.tab && !s2.shared && !s2.remember);
    const q = await ctx2.newPage();
    await q.goto(`${base}/`);
    await q.waitForSelector('form[data-step=signin]');
    assert.equal(await q.inputValue('input[name=login]'), '', 'the username is not remembered');
    await q.close();
    // Its tab lock ends its session (nothing else uses it).
    clearInterval(busy3);
    await p.waitForSelector('form[data-step=locked]', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await api('GET', '/auth/me', { token: s2.tab })).status, 401);
    // A wrong password says to check the mountain too.
    const r = await ctx2.newPage();
    await r.goto(`${base}/`);
    await r.click('.signin-mountain .btn.link');
    await r.fill('input[name=tenant]', A.slug);
    await r.fill('input[name=login]', `owner@${A.slug}.test`);
    await r.fill('input[name=password]', 'not-the-password-1');
    await r.click('form[data-step=signin] button[type=submit]');
    await r.waitForSelector('.error-box');
    assert.match(await r.textContent('.error-box'), /Check the mountain name too/);
    // A demo mountain says it sends no email, and hides both email buttons.
    await r.fill('input[name=tenant]', D.slug);
    await r.dispatchEvent('input[name=tenant]', 'change');
    await r.waitForFunction(() => /Demo mountains don't send email/.test(document.body.textContent));
    assert.equal(await r.isVisible('.signin-email'), false);
    await ctx2.close();
  } finally { await browser.close(); }
});
