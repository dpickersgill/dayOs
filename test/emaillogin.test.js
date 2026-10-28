'use strict';

// Signing in with a code (or link) from your email, and resetting a forgotten password the same way.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
const http = require('http');

const mails = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { try { mails.push(JSON.parse(body)); } catch (_) { /* not JSON */ } res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"x"}'); });
}).listen(0);
process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.POSTMARK_SERVER_TOKEN = 'test-token';
process.env.MAIL_FROM = 'hello@test.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const slug = `em-${suffix}`;
const owner = `owner@${slug}.test`;
const ann = `ann@${slug}.test`;
const T = {};

const DEVICE = 'test-device-0123456789abcdef'; // the app always says which device signs in; leaving it out asks for an emailed code
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE,  ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const settle = () => new Promise((r) => { setTimeout(r, 300); }); // the email is sent without waiting
const lastTo = (email) => mails.filter((m) => m.To === email).at(-1);
const codeIn = (m) => /(\d{6})/.exec(m.Subject)[1];
const linkIn = (m, kind) => new RegExp(`#${kind}=([A-Za-z0-9_-]+\\.\\d{6})`).exec(m.TextBody)[1];

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Email Peak', owner: { email: owner, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: owner, password: PW } })).body.token;
  const s = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: 'Ann', last_name: 'Counter' }, status: 'active' } })).id;
  ok(await api('POST', '/users', { token: T.owner, body: { email: ann, password: PW, role: 'counter', staff_id: s } }));
  const n = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: 'Nell', last_name: 'Noemail' }, status: 'active' } })).id;
  T.nell = ok(await api('POST', '/users', { token: T.owner, body: { username: 'nell.noemail', password: PW, role: 'counter', staff_id: n } }));
});
test.after(async () => { await new Promise((r) => server.close(r)); stub.close(); await pool.end(); });

test('sign in with the emailed code; it works once, and a wrong code is refused', async () => {
  const r = ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: ann } }));
  assert.ok(r.request && r.minutes === 10);
  await settle();
  const m = lastTo(ann);
  assert.match(m.Subject, /^\d{6} is your Verdynt\/OS sign-in code$/);
  assert.match(m.TextBody, /#email-link=/);
  const code = codeIn(m);
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await api('POST', '/auth/email-code/verify', { body: { request: r.request, code: wrong } })).status, 401);
  const out = ok(await api('POST', '/auth/email-code/verify', { body: { request: r.request, code } }));
  assert.ok(out.token);
  const me = ok(await api('GET', '/auth/me', { token: out.token }));
  assert.equal(me.email, ann); assert.equal(me.signed_in_with, 'email');
  assert.equal((await api('POST', '/auth/email-code/verify', { body: { request: r.request, code } })).status, 401, 'used once');
});

test('the link in the email signs in on its own, once; a username finds the email too', async () => {
  const [[u]] = await pool.query('SELECT username FROM users WHERE email = ?', [ann]);
  ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: u.username } }));
  await settle();
  const link = linkIn(lastTo(ann), 'email-link');
  assert.ok(ok(await api('POST', '/auth/email-code/verify', { body: { link } })).token);
  assert.equal((await api('POST', '/auth/email-code/verify', { body: { link } })).status, 401);
});

test('unknown logins and logins with no email look the same, and get no email', async () => {
  const before = mails.length;
  const a = ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: `nobody@${slug}.test` } }));
  const b = ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: 'nell.noemail' } }));
  assert.equal(Object.keys(a).sort().join(), Object.keys(b).sort().join());
  assert.equal(a.request.length, b.request.length);
  await settle();
  assert.equal(mails.length, before);
  assert.equal((await api('POST', '/auth/email-code/verify', { body: { request: a.request, code: '123456' } })).status, 401);
});

test('at most 3 codes in 15 minutes go to one login', async () => {
  const [[u]] = await pool.query('SELECT id FROM users WHERE email = ?', [ann]);
  await pool.query("DELETE FROM auth_challenges WHERE user_id = ? AND purpose = 'email_signin'", [u.id]);
  const before = mails.filter((m) => m.To === ann).length;
  for (let i = 0; i < 5; i += 1) ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: ann } }));
  await settle();
  assert.equal(mails.filter((m) => m.To === ann).length - before, 3);
});

test('an owner with an authenticator app still does that step after the email code', async () => {
  await pool.query("UPDATE users SET totp_enabled = 1, totp_secret = 'x' WHERE email = ?", [owner]);
  ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: owner } }));
  await settle();
  const out = ok(await api('POST', '/auth/email-code/verify', { body: { link: linkIn(lastTo(owner), 'email-link') } }));
  assert.equal(out.mfa_required, true); assert.ok(out.mfa_token); assert.equal(out.token, undefined);
  await pool.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE email = ?', [owner]);
});

test('forgot password: the code sets a new one, signs in here, signs out everywhere else, and says so by email', async () => {
  const old = ok(await api('POST', '/auth/login', { body: { tenant: slug, login: ann, password: PW } })).token;
  const r = ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: ann, purpose: 'reset' } }));
  await settle();
  const m = lastTo(ann);
  assert.match(m.Subject, /reset your Verdynt\/OS password/);
  assert.match(m.TextBody, /#reset-link=/);
  // a reset code does not sign in, and a sign-in code does not reset
  assert.equal((await api('POST', '/auth/email-code/verify', { body: { request: r.request, code: codeIn(m) } })).status, 401);
  const NEW = 'a brand new long password 42';
  const out = ok(await api('POST', '/auth/password-reset', { body: { request: r.request, code: codeIn(m), new_password: NEW } }));
  assert.ok(out.token); assert.equal(out.password_saved, true);
  assert.ok(ok(await api('GET', '/auth/me', { token: out.token })).email);
  assert.equal((await api('GET', '/auth/me', { token: old })).status, 401, 'the old session ended');
  await settle();
  assert.match(lastTo(ann).Subject, /password was changed/);
  ok(await api('POST', '/auth/login', { body: { tenant: slug, login: ann, password: NEW } }));
  assert.equal((await api('POST', '/auth/login', { body: { tenant: slug, login: ann, password: PW } })).status, 401);
});

test('a reset link works once, and weak passwords are refused without spending it', async () => {
  ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: ann, purpose: 'reset' } }));
  await settle();
  const link = linkIn(lastTo(ann), 'reset-link');
  assert.equal((await api('POST', '/auth/password-reset', { body: { link, new_password: 'short' } })).status, 400);
  assert.equal((await api('POST', '/auth/password-reset', { body: { link, new_password: 'email peak email peak' } })).status, 400, 'the mountain name is refused');
  ok(await api('POST', '/auth/password-reset', { body: { link, new_password: 'another long password for ann' } }));
  assert.equal((await api('POST', '/auth/password-reset', { body: { link, new_password: 'yet another long password ok' } })).status, 401);
});
