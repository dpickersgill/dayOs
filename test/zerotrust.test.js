'use strict';

// Tiered sign-in: password rules, passkeys (sign-in, second step, second check), who must use two-step, new-device codes
// and alerts, sessions you can end, shared terminals with PINs, access that runs out, and the console's passkeys and
// per-mountain access. Passkeys are made by a software authenticator, so the server's real WebAuthn checks run.
const http = require('node:http');
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.PLATFORM_LOGIN_RATE_LIMIT = '1000';

const mails = [];
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => { mails.push(JSON.parse(body || '{}')); res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"m"}'); });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const config = require('../src/config');
const totp = require('../src/lib/totp');
const { SoftAuthenticator } = require('./fixtures/authenticator');

let server; let base; let phone;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';
const DEV = { a: 'device-aaaaaaaaaaaaaaaaaaaaaa', b: 'device-bbbbbbbbbbbbbbbbbbbbbb', c: 'device-cccccccccccccccccccccc' };

async function api(method, path, { token, body, device, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(device ? { 'x-device': device } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const login = (slug, who, password = PW, device = DEV.a) => api('POST', '/auth/login', { body: { tenant: slug, login: who, password }, device });
async function mountain(slug) {
  is(await api('POST', '/tenants', { headers: { 'x-bootstrap-key': KEY }, body: { slug, name: `Peak ${slug}`, owner: { email: `o@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } } }), 201);
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return { slug, id: t.id, token: (await login(slug, `o@${slug}.test`)).body.token };
}
async function addLogin(M, role, extra = {}) {
  const username = `${role}${Math.floor(Math.random() * 1e6)}`;
  const r = await api('POST', '/users', { token: M.token, body: { username, password: PW, role, ...extra } });
  is(r, 201);
  return { id: r.body.id, username, token: (await login(M.slug, username)).body.token };
}
const passkeyAdd = async (token, auth = phone) => {
  const o = await api('POST', '/auth/passkeys/options', { token });
  is(o, 200);
  return api('POST', '/auth/passkeys', { token, body: { handle: o.body.handle, response: auth.create(o.body.options), name: 'Test phone' } });
};
const expireStepUp = (token) => pool.query('UPDATE user_sessions SET stepped_up_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE) WHERE id_hash = ?', [require('../src/lib/sessions').hash(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sid)]);
let A;

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  require('../src/lib/mailer').settings.apiBase = `http://127.0.0.1:${stub.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://localhost:${server.address().port}`; // passkeys need a host name, not an IP address
  phone = new SoftAuthenticator(base);
  A = await mountain(`zt-${suffix}`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stub.close(r)); await pool.end(); });

test('passwords: 12 or more characters, not built from the login or the mountain, not a repeat', async () => {
  const add = (password, username = `pw${Math.floor(Math.random() * 1e6)}`) => api('POST', '/users', { token: A.token, body: { username, password, role: 'staff' } });
  is(await add('elevenchars'), 400, 'too short');
  is(await add(`my-${A.slug}-password`), 400, 'the mountain\'s address');
  is(await add('summitops-forever-1'), 400, '"DAY/OS"');
  is(await add('liftie-jordan-2026', 'jordan.liftie'), 201, 'a word that is not the whole username is fine');
  is(await add('jordanl-is-my-name', 'jordanl'), 400, 'their own username');
  is(await add('aaaaaaaaaaaaaaaa'), 400, 'one character over and over');
  is(await add('a long passphrase with spaces'), 201, 'spaces and passphrases are welcome');
});

test('a passkey signs in on its own, and after a password it is the second step', async () => {
  const B = await mountain(`ztb-${suffix}`);
  is(await passkeyAdd(B.token), 201);
  const sec = await api('GET', '/auth/security', { token: B.token });
  assert.equal(sec.body.passkeys.length, 1);
  // Alone: the phone offers it, nothing typed
  const o = await api('POST', '/auth/passkey/options', { body: { tenant: B.slug } });
  is(o, 200);
  const r = await api('POST', '/auth/passkey', { body: { tenant: B.slug, handle: o.body.handle, response: phone.get(o.body.options) }, device: DEV.a });
  is(r, 200);
  const me = await api('GET', '/auth/me', { token: r.body.token });
  assert.equal(me.body.signed_in_with, 'passkey'); assert.equal(me.body.mfa_enabled, true); assert.equal(me.body.stepped_up, true);
  // The same challenge cannot be used twice, and the passkey only works at its own mountain
  is(await api('POST', '/auth/passkey', { body: { tenant: B.slug, handle: o.body.handle, response: phone.get(o.body.options) } }), 403, 'a challenge works once');
  const other = await api('POST', '/auth/passkey/options', { body: { tenant: A.slug } });
  is(await api('POST', '/auth/passkey', { body: { tenant: A.slug, handle: other.body.handle, response: phone.get(other.body.options) } }), 403, 'another mountain');
  // After a password, the passkey is the second step
  const pw = await login(B.slug, `o@${B.slug}.test`);
  is(pw, 200);
  assert.equal(pw.body.mfa_required, true); assert.deepEqual(pw.body.methods, { app: false, passkey: true });
  is(await api('POST', '/auth/mfa', { body: { mfa_token: pw.body.mfa_token, code: '123456' } }), 401, 'no app, so no codes');
  const p2 = await api('POST', '/auth/mfa/passkey-options', { body: { mfa_token: pw.body.mfa_token } });
  const done = await api('POST', '/auth/mfa', { body: { mfa_token: pw.body.mfa_token, handle: p2.body.handle, response: phone.get(p2.body.options) } });
  is(done, 200);
  assert.ok(done.body.token);
  // It cannot remove the only second step while one is required
  const was = config.requireAdminMfa; config.requireAdminMfa = true;
  try {
    const id = sec.body.passkeys[0].id;
    is(await api('DELETE', `/auth/passkeys/${id}`, { token: done.body.token }), 403, 'the owner must keep one');
  } finally { config.requireAdminMfa = was; }
});

test('the second check: sensitive actions need a recent passkey, code or (with neither) password', async () => {
  const C = await mountain(`ztc-${suffix}`);
  const crew = await addLogin(C, 'staff');
  // Straight after signing in counts, so nobody is asked twice
  is(await api('GET', '/people/export.csv', { token: C.token }), 200);
  await expireStepUp(C.token);
  const asked = await api('GET', '/people/export.csv', { token: C.token });
  is(asked, 403);
  assert.equal(asked.body.details.code, 'step_up_required');
  assert.match(asked.body.error, /Confirm it is you to download the customer list/);
  is(await api('POST', `/users/${crew.id}/reset-password`, { token: C.token, body: { new_password: 'another-long-password' } }), 403);
  // No passkey or app: their password confirms
  const opts = await api('POST', '/auth/step-up/options', { token: C.token });
  assert.deepEqual(opts.body.methods, ['password']);
  is(await api('POST', '/auth/step-up', { token: C.token, body: { password: 'wrong-password-here' } }), 403);
  is(await api('POST', '/auth/step-up', { token: C.token, body: { password: PW } }), 200);
  is(await api('GET', '/people/export.csv', { token: C.token }), 200, 'for the next few minutes');
  is(await api('POST', `/users/${crew.id}/reset-password`, { token: C.token, body: { new_password: 'another-long-password' } }), 200);
  // With a passkey, a password is not enough
  is(await passkeyAdd(C.token), 201);
  await expireStepUp(C.token);
  is(await api('POST', '/auth/step-up', { token: C.token, body: { password: PW } }), 403, 'what an attacker would have');
  const o = await api('POST', '/auth/step-up/options', { token: C.token });
  assert.deepEqual(o.body.methods, ['passkey']);
  is(await api('POST', '/auth/step-up', { token: C.token, body: { handle: o.body.passkey.handle, response: phone.get(o.body.passkey.options) } }), 200);
  is(await api('GET', '/people/export.csv', { token: C.token }), 200);
  // Switching a login off or changing its role needs it too, and ends that person's sessions
  await expireStepUp(C.token);
  is(await api('PATCH', `/users/${crew.id}`, { token: C.token, body: { role: 'counter' } }), 403);
});

test('who must use two-step, tier by tier, with patrol given two weeks', async () => {
  const D = await mountain(`ztd-${suffix}`);
  const counter = await addLogin(D, 'counter');
  const patroller = await addLogin(D, 'patrol');
  const was = config.requireAdminMfa;
  config.requireAdminMfa = true;
  try {
    const rule = async (t) => (await api('GET', '/auth/me', { token: t })).body;
    assert.equal((await rule(D.token)).mfa_rule, 'manager');
    is(await api('GET', '/board', { token: D.token }), 403, 'the owner sets it up first');
    assert.equal((await rule(counter.token)).mfa_required, false, 'counter staff are not forced');
    // Patrol: the mountain already existed, so two weeks' notice
    await pool.query('UPDATE tenants SET patrol_mfa_from = DATE_ADD(CURDATE(), INTERVAL 14 DAY) WHERE id = ?', [D.id]);
    const soon = await rule(patroller.token);
    assert.equal(soon.mfa_required, false); assert.ok(soon.mfa_starts_on);
    await pool.query('UPDATE tenants SET patrol_mfa_from = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?', [D.id]);
    assert.equal((await rule(patroller.token)).mfa_rule, 'patrol');
    const blocked = await api('GET', '/patrol/incidents', { token: patroller.token });
    is(blocked, 403); assert.equal(blocked.body.details.why, 'patrol');
    // A passkey satisfies it
    is(await passkeyAdd(patroller.token, new SoftAuthenticator(base)), 201, 'setting up is allowed while blocked');
    assert.equal((await rule(patroller.token)).mfa_enrollment_required, false);
    // The owner can turn patrol off; that needs the owner's own second step to be set up first (they are blocked until then)
    is(await api('PUT', '/tenant/sign-in-rules', { token: D.token, body: { mfa_for_patrol: false } }), 403);
  } finally { config.requireAdminMfa = was; }
  // (with the rule off, as in tests) the owner can change it after a fresh check
  is(await api('PUT', '/tenant/sign-in-rules', { token: D.token, body: { mfa_for_patrol: false } }), 200);
  assert.equal((await api('GET', '/tenant/sign-in-rules', { token: D.token })).body.mfa_for_patrol, false);
});

test('a new device: noted, emailed, and without two-step a code goes to email first', async () => {
  process.env.POSTMARK_SERVER_TOKEN = 'pm-test'; process.env.MAIL_FROM = 'hello@summitops.test';
  try {
    const E = await mountain(`zte-${suffix}`);
    const email = `crew@zte-${suffix}.test`;
    is(await api('POST', '/users', { token: E.token, body: { username: `crew${suffix}`, email, password: PW, role: 'counter' } }), 201);
    is(await login(E.slug, email, PW, DEV.a), 200, 'their first device is not "new"');
    is(await login(E.slug, email, PW, DEV.a), 200, 'nor is the same one again');
    mails.length = 0;
    const fresh = await login(E.slug, email, PW, DEV.b);
    is(fresh, 200);
    assert.equal(fresh.body.mfa_required, true); assert.deepEqual(fresh.body.methods, { email: true });
    assert.match(fresh.body.sent_to, /^c\*+@/);
    const code = mails[0].Subject.match(/^(\d{6})/)[1];
    assert.equal(mails[0].To, email);
    is(await api('POST', '/auth/mfa', { body: { mfa_token: fresh.body.mfa_token, code: '000000' === code ? '111111' : '000000' }, device: DEV.b }), 401);
    const ok = await api('POST', '/auth/mfa', { body: { mfa_token: fresh.body.mfa_token, code }, device: DEV.b });
    is(ok, 200);
    is(await api('POST', '/auth/mfa', { body: { mfa_token: fresh.body.mfa_token, code }, device: DEV.b }), 401, 'a code works once');
    assert.ok(mails.some((m) => m.Subject === 'New sign-in to DAY/OS' && m.To === email), 'and they are told');
    assert.equal((await api('GET', '/auth/me', { token: ok.body.token })).body.signed_in_with, 'email');
    const sec = await api('GET', '/auth/security', { token: ok.body.token });
    assert.equal(sec.body.devices.length, 2);
    assert.ok(sec.body.devices.find((d) => d.current));
    const [[a]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'new_device'", [E.id]);
    assert.equal(a.n, 1);
    // Forgetting the device makes it new again, and signs it out
    const dev = sec.body.devices.find((d) => !d.current);
    is(await api('DELETE', `/auth/devices/${dev.id}`, { token: ok.body.token }), 200);
  } finally { delete process.env.POSTMARK_SERVER_TOKEN; delete process.env.MAIL_FROM; }
});

test('where you are signed in: see each session and end any of them', async () => {
  const F = A; // (at most five new mountains a minute)
  const second = (await login(F.slug, `o@${F.slug}.test`, PW, DEV.c)).body.token;
  const list = await api('GET', '/auth/security', { token: F.token });
  assert.equal(list.body.sessions.length, 2);
  const other = list.body.sessions.find((s) => !s.current);
  is(await api('DELETE', `/auth/sessions/${other.id}`, { token: F.token }), 200);
  is(await api('GET', '/auth/me', { token: second }), 401);
  const third = (await login(F.slug, `o@${F.slug}.test`)).body.token;
  is(await api('POST', '/auth/sessions/end-others', { token: F.token }), 200);
  is(await api('GET', '/auth/me', { token: third }), 401);
  is(await api('GET', '/auth/me', { token: F.token }), 200, 'this one stays');
});

test('shared terminals: crew switch in with a PIN; managers and patrol cannot; removing it ends them', async () => {
  const G = A;
  const counter = await addLogin(G, 'counter');
  const patroller = await addLogin(G, 'patrol');
  const t = await api('POST', '/terminals', { token: G.token, body: { name: 'Ticket window 1' } });
  is(t, 201);
  assert.ok(t.body.secret.length >= 40);
  is(await api('POST', '/auth/terminal', { body: { tenant: G.slug, terminal: t.body.secret } }), 200);
  is(await api('POST', '/auth/terminal', { body: { tenant: G.slug, terminal: 'x'.repeat(43) } }), 403);
  // Setting a PIN: their password, and not an easy one
  for (const weak of ['123456', '111111', '654321', '121212', '2026', '199912']) {
    const r = await api('PUT', '/auth/pin', { token: counter.token, body: { password: PW, pin: weak } });
    assert.ok([400].includes(r.status), `${weak} ${JSON.stringify(r.body)}`);
  }
  is(await api('PUT', '/auth/pin', { token: counter.token, body: { password: 'wrong-password-here', pin: '482915' } }), 403);
  is(await api('PUT', '/auth/pin', { token: counter.token, body: { password: PW, pin: '482915' } }), 200);
  is(await api('PUT', '/auth/pin', { token: patroller.token, body: { password: PW, pin: '482915' } }), 403, 'patrol sign in properly');
  const pinLogin = (pin, who = counter.username, terminal = t.body.secret) => api('POST', '/auth/pin-login', { body: { tenant: G.slug, terminal, login: who, pin } });
  const on = await pinLogin('482915');
  is(on, 200);
  assert.equal(on.body.terminal, 'Ticket window 1');
  const me = (await api('GET', '/auth/me', { token: on.body.token })).body;
  assert.equal(me.signed_in_with, 'pin'); assert.equal(me.terminal.name, 'Ticket window 1'); assert.equal(me.stepped_up, false);
  is(await pinLogin('482915', counter.username, 'y'.repeat(43)), 403, 'only on an enrolled terminal');
  is(await api('POST', '/auth/passkeys/options', { token: on.body.token }), 403, 'a PIN session cannot change sign-in settings');
  is(await api('PUT', '/auth/pin', { token: on.body.token, body: { password: PW, pin: '739204' } }), 403);
  // Five wrong PINs lock it for 15 minutes
  for (let i = 0; i < 5; i += 1) is(await pinLogin('000001'), 401);
  is(await pinLogin('482915'), 429);
  await pool.query('UPDATE users SET pin_locked_until = NULL, pin_failures = 0 WHERE id = ?', [counter.id]);
  // A terminal session ends after 15 minutes unused
  const again = (await pinLogin('482915')).body.token;
  await pool.query("UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 16 MINUTE) WHERE user_id = ? AND method = 'pin'", [counter.id]);
  is(await api('GET', '/auth/me', { token: again }), 401);
  // Removing the terminal ends everyone switched in there
  const last = (await pinLogin('482915')).body.token;
  is(await api('DELETE', `/terminals/${t.body.id}`, { token: G.token }), 200);
  is(await api('GET', '/auth/me', { token: last }), 401);
  is(await pinLogin('482915'), 403);
  // A manager can clear someone's PIN
  is(await api('DELETE', `/users/${counter.id}/pin`, { token: G.token }), 200);
  assert.equal((await api('GET', '/users', { token: G.token })).body.data.find((u) => u.id === counter.id).pin_set, 0);
});

test('access runs out at the season\'s end, and comes back when a manager moves the date', async () => {
  const H = A;
  const lift = await addLogin(H, 'staff');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  is(await api('POST', '/users/season-end', { token: H.token, body: { date: yesterday } }), 400, 'not in the past');
  const set = await api('POST', '/users/season-end', { token: H.token, body: { date: later } });
  is(set, 200);
  assert.ok(set.body.changed >= 1);
  const fresh = await addLogin(H, 'instructor');
  assert.equal(String((await api('GET', '/users', { token: H.token })).body.data.find((u) => u.id === fresh.id).access_ends_on).slice(0, 10), later, 'new logins get the season end');
  // The day passes
  await pool.query('UPDATE users SET access_ends_on = ? WHERE id = ?', [yesterday, lift.id]);
  is(await api('GET', '/auth/me', { token: lift.token }), 401, 'signed out');
  const refused = await login(H.slug, lift.username);
  is(refused, 403); assert.match(refused.body.error, /ended for the season/);
  // Managers are never affected; clearing the date brings them back
  is(await api('GET', '/auth/me', { token: H.token }), 200);
  is(await api('PATCH', `/users/${lift.id}`, { token: H.token, body: { access_ends_on: null } }), 200);
  is(await login(H.slug, lift.username), 200);
});

test('the console: operators open a mountain with a reason, and sign in with a passkey only once they have one', async () => {
  const P = A;
  const plat = (method, path, { session, key, body } = {}) => api(method, `/platform${path}`, { body, headers: { ...(session ? { 'x-platform-session': session } : {}), ...(key ? { 'x-platform-key': key } : {}) } });
  const email = `op-${suffix}@example.test`; const opPw = 'a-long-operator-password';
  is(await plat('POST', '/operators', { key: KEY, body: { email, name: 'Opal', password: opPw } }), 201);
  const first = await plat('POST', '/login', { body: { email, password: opPw } });
  const secret = first.body.secret;
  const s = (await plat('POST', '/login/setup', { body: { setup_token: first.body.setup_token, code: totp.hotp(secret, totp.stepAt(Date.now())) } })).body.session;
  // Changing a mountain needs it opened: a reason and a time
  const shut = await plat('PATCH', `/tenants/${P.id}`, { session: s, body: { platform_notes: 'hello' } });
  is(shut, 403); assert.equal(shut.body.details.code, 'access_required');
  is(await plat('GET', `/tenants/${P.id}`, { session: s }), 200, 'looking is fine');
  is(await plat('POST', `/tenants/${P.id}/access`, { session: s, body: { reason: 'no' } }), 400, 'say why');
  is(await plat('POST', `/tenants/${P.id}/access`, { session: s, body: { reason: 'Owner asked for notes', hours: 9 } }), 400, 'at most 8 hours');
  is(await plat('POST', `/tenants/${P.id}/access`, { session: s, body: { reason: 'Owner asked for notes', hours: 1 } }), 201);
  is(await plat('PATCH', `/tenants/${P.id}`, { session: s, body: { platform_notes: 'hello' } }), 200);
  const history = (await plat('GET', `/tenants/${P.id}`, { session: s })).body.history.map((x) => x.action);
  assert.ok(history.includes('open_access') && history.includes('edit'));
  is(await plat('POST', `/tenants/${P.id}/access/close`, { session: s }), 200);
  is(await plat('PATCH', `/tenants/${P.id}`, { session: s, body: { platform_notes: 'again' } }), 403, 'closed again');
  is(await plat('PATCH', `/tenants/${P.id}`, { key: KEY, body: { platform_notes: 'break glass' } }), 200, 'the key is not asked (and is recorded)');
  // A passkey: then the password and code no longer work for this operator
  const console_ = new SoftAuthenticator(base);
  const o = await plat('POST', '/me/passkeys/options', { session: s });
  is(await plat('POST', '/me/passkeys', { session: s, body: { handle: o.body.handle, response: console_.create(o.body.options), name: 'Laptop' } }), 201);
  const pw = await plat('POST', '/login', { body: { email, password: opPw, code: totp.hotp(secret, totp.stepAt(Date.now()) + 1) } });
  is(pw, 403); assert.match(pw.body.error, /passkey/);
  const lo = await plat('POST', '/login/passkey/options');
  const inn = await plat('POST', '/login/passkey', { body: { handle: lo.body.handle, response: console_.get(lo.body.options) } });
  is(inn, 200);
  assert.equal(inn.body.name, 'Opal'); assert.equal(inn.body.passkey, true);
  is(await plat('GET', '/tenants', { session: inn.body.session }), 200);
  assert.equal((await plat('GET', '/operators', { session: inn.body.session })).body.data.find((x) => x.email === email).passkeys, 1);
});
