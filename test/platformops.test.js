'use strict';

// Operator logins for the platform console: email, password and an authenticator code; first-time setup; lockout;
// switching an operator off or resetting them ends their sessions; the platform key stays as the way in for emergencies.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.PLATFORM_LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const totp = require('../src/lib/totp');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const KEY = 'test-bootstrap-key';
const PW = 'a-long-operator-password';

async function api(method, path, { session, key, body } = {}) {
  const res = await fetch(`${base}/api/v1/platform${path}`, { method, headers: { 'content-type': 'application/json', ...(session ? { 'x-platform-session': session } : {}), ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const codeAt = (secret, offset = 0) => totp.hotp(secret, totp.stepAt(Date.now()) + offset);

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const ada = `ada-${suffix}@example.test`; const bo = `bo-${suffix}@example.test`;
let adaSecret; let adaSession; let boId; let adaId;

test('the platform key adds the first operator; passwords are checked', async () => {
  is(await api('POST', '/operators', { body: { email: ada, name: 'Ada', password: PW } }), 403, 'needs the key or a session');
  is(await api('POST', '/operators', { key: KEY, body: { email: ada, name: 'Ada', password: 'short' } }), 400, 'at least 10 characters');
  const r = await api('POST', '/operators', { key: KEY, body: { email: ada.toUpperCase(), name: 'Ada', password: PW } });
  is(r, 201); adaId = r.body.id;
  is(await api('POST', '/operators', { key: KEY, body: { email: ada, name: 'Ada again', password: PW } }), 400, 'one operator per email');
});

test('the first sign-in sets up the authenticator app, and only then opens the console', async () => {
  is(await api('POST', '/login', { body: { email: ada, password: 'wrong-password-here' } }), 403);
  const first = await api('POST', '/login', { body: { email: ada, password: PW } });
  is(first, 200);
  assert.equal(first.body.setup_required, true);
  assert.match(first.body.otpauth_uri, /^otpauth:\/\/totp\//);
  adaSecret = first.body.secret;
  is(await api('GET', '/tenants', { session: first.body.setup_token }), 403, 'the setup ticket opens nothing');
  is(await api('POST', '/login/setup', { body: { setup_token: first.body.setup_token, code: '000000' } }), 400);
  const done = await api('POST', '/login/setup', { body: { setup_token: first.body.setup_token, code: codeAt(adaSecret) } });
  is(done, 200);
  assert.equal(done.body.operator, true); assert.equal(done.body.name, 'Ada');
  adaSession = done.body.session;
  is(await api('GET', '/tenants', { session: adaSession }), 200);
  const me = await api('GET', '/me', { session: adaSession });
  assert.equal(me.body.operator_id, adaId); assert.equal(me.body.by_key, false);
});

test('later sign-ins need a fresh code, and a code works once', async () => {
  const noCode = await api('POST', '/login', { body: { email: ada, password: PW } });
  assert.equal(noCode.body.code_required, true, 'asks for the code');
  assert.equal(noCode.body.session, undefined);
  is(await api('POST', '/login', { body: { email: ada, password: PW, code: codeAt(adaSecret) } }), 403, 'the code used at setup cannot be used again');
  const ok = await api('POST', '/login', { body: { email: ada, password: PW, code: codeAt(adaSecret, 1) } });
  is(ok, 200);
  adaSession = ok.body.session;
  const [[a]] = await pool.query("SELECT actor FROM platform_audit WHERE action = 'sign_in' ORDER BY id DESC LIMIT 1");
  assert.equal(a.actor, 'Ada', 'the sign-in is recorded against the person');
});

test('an operator adds another; switching them off or resetting them ends their sessions', async () => {
  const r = await api('POST', '/operators', { session: adaSession, body: { email: bo, name: 'Bo', password: PW } });
  is(r, 201); boId = r.body.id;
  const s1 = await api('POST', '/login', { body: { email: bo, password: PW } });
  const boSecret = s1.body.secret;
  let boSession = (await api('POST', '/login/setup', { body: { setup_token: s1.body.setup_token, code: codeAt(boSecret) } })).body.session;
  is(await api('GET', '/operators', { session: boSession }), 200);
  const list = (await api('GET', '/operators', { session: adaSession })).body.data;
  assert.equal(list.find((o) => o.id === adaId).you, true);
  assert.equal(list.find((o) => o.id === boId).two_step, true);

  is(await api('POST', `/operators/${adaId}/active`, { session: adaSession, body: { active: false } }), 400, 'cannot switch yourself off');
  is(await api('POST', `/operators/${boId}/active`, { session: adaSession, body: { active: false } }), 200);
  is(await api('GET', '/tenants', { session: boSession }), 403, 'switched off: the session ends');
  is(await api('POST', '/login', { body: { email: bo, password: PW, code: codeAt(boSecret, 1) } }), 403, 'and cannot sign in');
  is(await api('POST', `/operators/${boId}/active`, { session: adaSession, body: { active: true } }), 200);

  boSession = (await api('POST', '/login', { body: { email: bo, password: PW, code: codeAt(boSecret, 1) } })).body.session;
  is(await api('POST', `/operators/${boId}/reset-two-step`, { session: adaSession }), 200);
  is(await api('GET', '/tenants', { session: boSession }), 403, 'reset: the session ends');
  const again = await api('POST', '/login', { body: { email: bo, password: PW } });
  assert.equal(again.body.setup_required, true, 'they set up the app again');
});

test('changing your own password needs the current one and keeps you signed in', async () => {
  const before = adaSession;
  is(await api('POST', '/me/password', { session: adaSession, body: { current: 'not-the-password', password: 'another-long-password' } }), 400);
  const r = await api('POST', '/me/password', { session: adaSession, body: { current: PW, password: 'another-long-password' } });
  is(r, 200);
  is(await api('GET', '/tenants', { session: before }), 403, 'the old session ended');
  is(await api('GET', '/tenants', { session: r.body.session }), 200, 'the new one works');
  is(await api('POST', '/me/password', { key: KEY, body: { current: 'x', password: 'another-long-password' } }), 400, 'the key has no password of its own');
});

test('five wrong passwords lock an operator for a while', async () => {
  for (let i = 0; i < 5; i += 1) is(await api('POST', '/login', { body: { email: bo, password: 'wrong-password-here' } }), 403);
  const locked = await api('POST', '/login', { body: { email: bo, password: PW } });
  is(locked, 403, 'the right password does not work while locked');
  const [[o]] = await pool.query('SELECT locked_until > UTC_TIMESTAMP() AS locked FROM platform_operators WHERE id = ?', [boId]);
  assert.equal(Number(o.locked), 1);
  await pool.query('UPDATE platform_operators SET locked_until = NULL, failures = 0 WHERE id = ?', [boId]);
});

test('key sign-in can be turned off once operators work', async () => {
  const keySession = (await api('POST', '/session', { body: { key: KEY, name: 'Key holder' } })).body.session;
  is(await api('GET', '/tenants', { session: keySession }), 200);
  const before = process.env.PLATFORM_KEY_SIGNIN;
  process.env.PLATFORM_KEY_SIGNIN = 'off';
  try {
    is(await api('POST', '/session', { body: { key: KEY, name: 'Key holder' } }), 403);
    is(await api('GET', '/tenants', { session: keySession }), 403, 'existing key sessions end');
    is(await api('GET', '/tenants', { key: KEY }), 403, 'and the raw key is refused');
    const code = codeAt(adaSecret, 1);
    const [[row]] = await pool.query('SELECT totp_last_step FROM platform_operators WHERE id = ?', [adaId]);
    const fresh = Number(row.totp_last_step) >= totp.stepAt(Date.now()) + 1 ? null : code;
    if (fresh) is(await api('POST', '/login', { body: { email: ada, password: 'another-long-password', code: fresh } }), 200, 'operators still sign in');
  } finally { if (before === undefined) delete process.env.PLATFORM_KEY_SIGNIN; else process.env.PLATFORM_KEY_SIGNIN = before; }
});

test('the platform key turns itself off once an operator signs in by name with two-step', async () => {
  const before = process.env.PLATFORM_KEY_SIGNIN;
  delete process.env.PLATFORM_KEY_SIGNIN; // the default: automatic
  require('../src/routes/platform').forgetKeyGate();
  try {
    // Ada has two-step set up, so the key alone opens nothing, and new mountains cannot be made with it either
    const raw = await api('GET', '/tenants', { key: KEY });
    is(raw, 403); assert.match(raw.body.error, /turned off/);
    is(await api('POST', '/session', { body: { key: KEY, name: 'Key holder' } }), 403);
    const made = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': KEY }, body: JSON.stringify({ slug: `nokey-${Date.now().toString(36)}`, name: 'No key', owner: { email: 'o@nokey.test', password: 'correct-horse-battery', first_name: 'N', last_name: 'K' } }) });
    assert.equal(made.status, 403);
    // break-glass: set deliberately, it works again
    process.env.PLATFORM_KEY_SIGNIN = 'on';
    is(await api('GET', '/tenants', { key: KEY }), 200);
  } finally { if (before === undefined) delete process.env.PLATFORM_KEY_SIGNIN; else process.env.PLATFORM_KEY_SIGNIN = before; require('../src/routes/platform').forgetKeyGate(); }
});

test('a lock that has run out starts counting again, so five more wrong tries lock it again', async () => {
  for (let i = 0; i < 5; i += 1) await api('POST', '/login', { body: { email: bo, password: 'wrong-password-here' } });
  await pool.query('UPDATE platform_operators SET locked_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [boId]); // the lock runs out
  for (let i = 0; i < 5; i += 1) await api('POST', '/login', { body: { email: bo, password: 'wrong-password-here' } });
  const [[o]] = await pool.query('SELECT failures, locked_until > UTC_TIMESTAMP() AS locked FROM platform_operators WHERE id = ?', [boId]);
  assert.equal(Number(o.locked), 1, `locked again (failures ${o.failures})`);
  is(await api('POST', '/login', { body: { email: bo, password: PW } }), 403);
  // With a code (the form sends one once it asks for it), a locked login and an unknown email get the same answer.
  // (Without one, an unknown email is asked for a code like any operator with the app set up, so that step reveals nothing.)
  const r = await api('POST', '/login', { body: { email: bo, password: PW, code: '123456' } });
  is(r, 403);
  const unknown = await api('POST', '/login', { body: { email: `nobody-${suffix}@example.test`, password: PW, code: '123456' } });
  assert.equal(unknown.body.error, r.body.error, 'a locked login and an unknown email get the same answer');
  await pool.query('UPDATE platform_operators SET locked_until = NULL, failures = 0 WHERE id = ?', [boId]);
});

test('the platform key cannot make an operator session, and key actions are marked as such in the log', async () => {
  const crypto = require('crypto');
  const forged = (() => {
    const body = Buffer.from(JSON.stringify({ n: 'Ada', o: adaId, e: 0, typ: null, exp: Date.now() + 3600_000 })).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', `platform-session:${KEY}`).update(body).digest('base64url')}`;
  })();
  is(await api('GET', '/tenants', { session: forged }), 403, 'a session signed with the key is not accepted');
  // Once an operator has two-step, the key alone cannot add another one (that would hand over access, 2026.11.10 fix).
  const refused = await api('POST', '/operators', { key: KEY, body: { email: `cy-${suffix}@example.test`, name: 'Cy', password: PW } });
  is(refused, 403); assert.equal(refused.body.details.code, 'two_step_required');
  const op = await require('./helpers/platform-operator').operatorConsole(base, KEY);
  is(await op('POST', '/operators', { email: `cy-${suffix}@example.test`, name: 'Cy', password: PW }), 201);
  is(await api('POST', '/sandboxes/purge', { key: KEY }), 200);
  const [[a]] = await pool.query("SELECT actor FROM platform_audit WHERE action = 'purge_demos' ORDER BY id DESC LIMIT 1");
  assert.match(a.actor, /^key: /);
});

test('a setup ticket stops working once a newer sign-in or a password reset happens', async () => {
  const cy = `cy-${suffix}@example.test`;
  const first = await api('POST', '/login', { body: { email: cy, password: PW } });
  const second = await api('POST', '/login', { body: { email: cy, password: PW } });
  is(await api('POST', '/login/setup', { body: { setup_token: first.body.setup_token, code: codeAt(first.body.secret) } }), 403, 'the older ticket is void');
  const [[c]] = await pool.query('SELECT id FROM platform_operators WHERE email = ?', [cy]);
  is(await api('POST', `/operators/${c.id}/password`, { key: KEY, body: { password: 'brand-new-password-1' } }), 403, 'the key alone cannot set an operator password');
  is(await api('POST', `/operators/${c.id}/reset-two-step`, { key: KEY }), 403, 'nor reset their two-step');
  const op = await require('./helpers/platform-operator').operatorConsole(base, KEY);
  is(await op('POST', `/operators/${c.id}/password`, { password: 'brand-new-password-1' }), 200);
  is(await api('POST', '/login/setup', { body: { setup_token: second.body.setup_token, code: codeAt(second.body.secret) } }), 403, 'a reset voids it too');
});
