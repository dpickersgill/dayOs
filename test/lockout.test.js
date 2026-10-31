'use strict';

// Lockouts hold when guesses are sent all at once: every try at a password, PIN or code is counted before it is checked,
// so a burst of parallel guesses gets no more checks than one guess after another would. Also: a sign-in that leaves out
// the device id is treated as a new device, a day of wrong codes stops codes for that login, the operator console never
// confirms a password before its code, and an unknown login takes as long to refuse as a wrong password.
// (Built from the security review's race and timing proofs.)
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000'; // stands in for many source addresses, or many servers
process.env.PLATFORM_LOGIN_RATE_LIMIT = '100000';
process.env.PLATFORM_RATE_LIMIT = '100000';
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
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const totp = require('../src/lib/totp');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const slug = `lk-${suffix}`;
const DEVICE = `test-device-${suffix}`.padEnd(30, 'x');
const T = {};
const emailOf = (n) => `${n}@${slug}.test`;

async function api(method, p, { token, body, headers = {}, device = DEVICE } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { ...(device ? { 'x-device': device } : {}), ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const tally = (out) => out.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {});
const settle = () => new Promise((r) => { setTimeout(r, 400); });
const userRow = async (email) => (await pool.query('SELECT * FROM users WHERE email = ?', [email]))[0][0];
async function addUser(name, role = 'counter') {
  ok(await api('POST', '/users', { token: T.owner, body: { email: emailOf(name), password: PW, role } }));
  return emailOf(name);
}

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Lock Peak', owner: { email: emailOf('owner'), password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = ok(await api('POST', '/auth/login', { body: { tenant: slug, email: emailOf('owner'), password: PW } })).token;
});
test.after(async () => { await new Promise((r) => server.close(r)); stub.close(); await pool.end(); });

test('61 wrong passwords sent at once get 10 checks; the login locks, and the right password is refused after', async () => {
  const bob = await addUser('bob');
  const out = await Promise.all(Array.from({ length: 61 }, (_, i) => api('POST', '/auth/login', { body: { tenant: slug, email: bob, password: `wrong-password-${i}xx` } })));
  assert.deepEqual(tally(out), { 401: 10, 429: 51 });
  const u = await userRow(bob);
  assert.equal(Number(u.login_failures), 10); assert.ok(u.login_locked_until, 'locked');
  const right = await api('POST', '/auth/login', { body: { tenant: slug, email: bob, password: PW } });
  assert.equal(right.status, 429, 'no success after the limit');
  const [[locked]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'users' AND entity_id = ? AND action = 'login_locked'", [u.id]);
  assert.equal(Number(locked.n), 1, 'the lock is written down once');
  // The review's proof: the right password hidden at guess 46 of 61. At most 10 guesses are ever checked.
  const cat = await addUser('cat');
  const pws = Array.from({ length: 60 }, (_, i) => `wrong-password-${i}xx`); pws.splice(45, 0, PW);
  const mixed = tally(await Promise.all(pws.map((p) => api('POST', '/auth/login', { body: { tenant: slug, email: cat, password: p } }))));
  assert.ok((mixed[401] || 0) + (mixed[200] || 0) <= 11 && mixed[429] >= 50, JSON.stringify(mixed));
});

test('an expired lock starts the count again, and a right password clears it', async () => {
  const dee = await addUser('dee');
  for (let i = 0; i < 3; i += 1) assert.equal((await api('POST', '/auth/login', { body: { tenant: slug, email: dee, password: 'wrong-password-xx' } })).status, 401);
  ok(await api('POST', '/auth/login', { body: { tenant: slug, email: dee, password: PW } }));
  assert.equal(Number((await userRow(dee)).login_failures), 0);
  await pool.query('UPDATE users SET login_failures = 10, login_locked_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE email = ?', [dee]);
  assert.equal((await api('POST', '/auth/login', { body: { tenant: slug, email: dee, password: 'wrong-password-xx' } })).status, 401);
  assert.equal(Number((await userRow(dee)).login_failures), 1, 'counting starts again at 1');
  assert.equal((await userRow(dee)).login_locked_until, null);
});

test('150 guesses at an emailed code sent at once get 5 checks, and the right code is refused after', async () => {
  const ann = await addUser('ann');
  const r = ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: ann } }));
  await settle();
  const code = /(\d{6})/.exec(mails.filter((m) => m.To === ann).at(-1).Subject)[1];
  const guesses = [];
  for (let i = 0; guesses.length < 150; i += 1) { const g = String(i).padStart(6, '0'); if (g !== code) guesses.push(g); }
  const out = await Promise.all(guesses.map((g) => api('POST', '/auth/email-code/verify', { body: { request: r.request, code: g } })));
  assert.deepEqual(tally(out), { 401: 5, 429: 145 });
  const [[ch]] = await pool.query('SELECT tries FROM auth_challenges WHERE user_id = (SELECT id FROM users WHERE email = ?) ORDER BY expires_at DESC LIMIT 1', [ann]);
  assert.equal(Number(ch.tries), 5, 'the code itself took 5 tries');
  const right = await api('POST', '/auth/email-code/verify', { body: { request: r.request, code } });
  assert.equal(right.status, 429, 'no success after the limit');
});

test('parallel app codes get 5 checks; 50 wrong codes in a day stop emailed-code sign-in until a full sign-in or a reset', async () => {
  const mo = await addUser('mo', 'manager');
  const token = ok(await api('POST', '/auth/login', { body: { tenant: slug, email: mo, password: PW } })).token;
  const setup = ok(await api('POST', '/auth/mfa/setup', { token }));
  ok(await api('POST', '/auth/mfa/enable', { token, body: { code: totp.hotp(setup.secret, totp.stepAt(Date.now())) } }));
  const half = async () => ok(await api('POST', '/auth/login', { body: { tenant: slug, email: mo, password: PW } })).mfa_token;
  // A code works once; the test forgets the last one used so it need not wait 30 seconds for the next.
  const right = async () => { await pool.query('UPDATE users SET totp_last_step = NULL WHERE email = ?', [mo]); return totp.hotp(setup.secret, totp.stepAt(Date.now())); };
  const now = totp.hotp(setup.secret, totp.stepAt(Date.now()));
  const wrong = (i) => String((Number(now) + 1000 + i * 7) % 1_000_000).padStart(6, '0');
  const mt = await half();
  const out = await Promise.all(Array.from({ length: 30 }, (_, i) => api('POST', '/auth/mfa', { body: { mfa_token: mt, code: wrong(i) } })));
  assert.deepEqual(tally(out), { 401: 5, 429: 25 });
  // The lock runs out: counting starts again, and a right code signs in and clears every count.
  await pool.query('UPDATE users SET mfa_locked_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE email = ?', [mo]);
  ok(await api('POST', '/auth/mfa', { body: { mfa_token: await half(), code: await right() } }));
  let u = await userRow(mo);
  assert.equal(Number(u.mfa_failures), 0); assert.equal(Number(u.code_day_failures), 0);

  // A day's worth: the 50th wrong code stops signing in with an emailed code (it needs no password), even with the right
  // code. The password and app code still work, so guessing at the emailed code cannot lock the person out, and that
  // full sign-in turns emailed codes back on.
  await pool.query('UPDATE users SET code_day_failures = 49, code_day_from = UTC_TIMESTAMP() - INTERVAL 2 HOUR WHERE email = ?', [mo]);
  assert.equal((await api('POST', '/auth/mfa', { body: { mfa_token: await half(), code: wrong(99) } })).status, 401);
  u = await userRow(mo);
  assert.ok(u.codes_blocked_at, 'emailed-code sign-in is stopped');
  const [[logged]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'codes_stopped'", [u.id]);
  assert.equal(Number(logged.n), 1);
  const asked = ok(await api('POST', '/auth/email-code', { body: { tenant: slug, login: mo } }));
  await settle();
  const emailed = /(\d{6})/.exec(mails.filter((m) => m.To === mo).at(-1).Subject)[1];
  const stopped = await api('POST', '/auth/email-code/verify', { body: { request: asked.request, code: emailed } });
  assert.equal(stopped.status, 429); assert.match(stopped.body.error, /emailed code is stopped/);
  ok(await api('POST', '/auth/mfa', { body: { mfa_token: await half(), code: await right() } }));
  assert.equal((await userRow(mo)).codes_blocked_at, null, 'the password and app code turned it back on');
  const now2 = await api('POST', '/auth/email-code/verify', { body: { request: asked.request, code: emailed } });
  assert.equal(now2.body.mfa_required, true, 'the emailed code works again (then the app code, as always)');
  // The window is a day: an old count starts again instead of adding up forever.
  await pool.query('UPDATE users SET code_day_failures = 49, code_day_from = UTC_TIMESTAMP() - INTERVAL 25 HOUR, mfa_failures = 0, mfa_locked_until = NULL WHERE email = ?', [mo]);
  assert.equal((await api('POST', '/auth/mfa', { body: { mfa_token: await half(), code: wrong(98) } })).status, 401);
  u = await userRow(mo);
  assert.equal(Number(u.code_day_failures), 1); assert.equal(u.codes_blocked_at, null);
  // Stopped again, then the owner sets a new password: emailed codes work again.
  await pool.query('UPDATE users SET codes_blocked_at = UTC_TIMESTAMP() WHERE email = ?', [mo]);
  ok(await api('POST', `/users/${u.id}/reset-password`, { token: T.owner, body: { new_password: 'another-strong-password-9' } }));
  assert.equal((await userRow(mo)).codes_blocked_at, null);
});

test('PINs sent at once at a shared terminal get 5 checks', async () => {
  const kim = await addUser('kim', 'counter');
  const kt = ok(await api('POST', '/auth/login', { body: { tenant: slug, email: kim, password: PW } })).token;
  ok(await api('PUT', '/auth/pin', { token: kt, body: { password: PW, pin: '482915' } }));
  const term = ok(await api('POST', '/terminals', { token: T.owner, body: { name: 'Window 1' } }));
  const pin = (p) => api('POST', '/auth/pin-login', { body: { tenant: slug, terminal: term.secret, login: kim, pin: p }, device: null });
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => pin(String(700000 + i))));
  assert.deepEqual(tally(out), { 401: 5, 429: 15 });
  assert.equal((await pin('482915')).status, 429, 'the right PIN is refused while locked');
  await pool.query('UPDATE users SET pin_locked_until = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE email = ?', [kim]);
  const on = await pin('482915');
  assert.equal(on.status, 200, 'a terminal sign-in needs no device id');
  assert.equal(Number((await userRow(kim)).pin_failures), 0);
});

test('a sign-in without a device id (or with one that is not a device id) is a new device: emailed code and alert', async () => {
  const eve = await addUser('eve');
  const first = await api('POST', '/auth/login', { body: { tenant: slug, email: eve, password: PW } });
  assert.ok(first.body.token, 'the device the person always uses');
  const known = await api('POST', '/auth/login', { body: { tenant: slug, email: eve, password: PW } });
  assert.ok(known.body.token, 'the same device again: no code');
  for (const device of [null, 'short', 'has spaces in it and is long enough']) {
    const r = await api('POST', '/auth/login', { body: { tenant: slug, email: eve, password: PW }, device });
    assert.equal(r.body.mfa_required, true, `device ${device}: a code is asked for`);
    assert.equal(r.body.methods.email, true); assert.equal(r.body.token, undefined);
  }
  await settle();
  const code = /(\d{6})/.exec(mails.filter((m) => m.To === eve).at(-1).Subject)[1];
  const last = await api('POST', '/auth/login', { body: { tenant: slug, email: eve, password: PW }, device: null });
  await settle();
  const fresh = /(\d{6})/.exec(mails.filter((m) => m.To === eve).at(-1).Subject)[1];
  assert.notEqual(code, undefined);
  ok(await api('POST', '/auth/mfa', { body: { mfa_token: last.body.mfa_token, code: fresh }, device: null }));
  await settle();
  assert.ok(mails.some((m) => m.To === eve && /New sign-in/.test(m.Subject)), 'the person is told');
  const [[a]] = await pool.query("SELECT detail FROM audit_log WHERE action = 'new_device' AND entity_id = (SELECT id FROM users WHERE email = ?) ORDER BY id DESC LIMIT 1", [eve]);
  assert.match(JSON.stringify(a.detail), /no_device_id/);
  // The app's own pages always send one, even where the browser will not keep it.
  const apiJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');
  assert.match(apiJs, /catch \(_\) \{\s*if \(!pageDevice\) pageDevice = newDeviceId\(\);\s*return pageDevice;/);
  assert.match(apiJs, /headers\['x-device'\] = dev/);
});

test('operator sign-in: parallel codes get 5 checks, and the password is never confirmed before the code', async () => {
  const plat = async (p, body) => { const res = await fetch(`${base}/api/v1/platform${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-key': 'test-bootstrap-key' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const email = `op-${suffix}@example.test`; const opPw = 'operator-password-long';
  // The key alone adds only the first operator (2026.11.10): on a shared test database another operator may already have
  // two-step, so add this one directly then.
  const added = await plat('/operators', { email, name: 'Lock Op', password: opPw });
  if (added.status === 403) {
    const { pool } = require('../src/db');
    await pool.query('INSERT INTO platform_operators (email, name, password_hash, password_changed_at, created_by) VALUES (?, ?, ?, UTC_TIMESTAMP(), ?)', [email, 'Lock Op', await require('bcryptjs').hash(opPw, 12), 'test']);
  } else assert.equal(added.status, 201);
  const first = await plat('/login', { email, password: opPw });
  const secret = first.body.secret;
  assert.equal((await plat('/login/setup', { setup_token: first.body.setup_token, code: totp.hotp(secret, totp.stepAt(Date.now())) })).status, 200);
  // No code yet: right password, wrong password and unknown email get the same answer.
  const right = await plat('/login', { email, password: opPw });
  const wrongPw = await plat('/login', { email, password: 'not-the-password-at-all' });
  const nobody = await plat('/login', { email: `nobody-${suffix}@example.test`, password: opPw });
  for (const r of [right, wrongPw, nobody]) assert.deepEqual([r.status, r.body], [200, { code_required: true }]);
  // With a code: a wrong password and a wrong code get the same answer.
  const step = totp.stepAt(Date.now());
  const badCode = String((Number(totp.hotp(secret, step + 1)) + 1) % 1_000_000).padStart(6, '0');
  const a = await plat('/login', { email, password: 'not-the-password-at-all', code: totp.hotp(secret, step + 1) });
  const b = await plat('/login', { email, password: opPw, code: badCode });
  assert.equal(a.status, 403); assert.deepEqual(a.body, b.body);
  await pool.query('UPDATE platform_operators SET failures = 0, locked_until = NULL WHERE email = ?', [email]);
  // Parallel guesses at the code with the right password: 5 are checked, then the operator is locked.
  const out = await Promise.all(Array.from({ length: 20 }, (_, i) => plat('/login', { email, password: opPw, code: String(100000 + i * 37) })));
  assert.equal(out.filter((r) => r.status === 200).length, 0);
  const [[o]] = await pool.query('SELECT failures, locked_until > UTC_TIMESTAMP() AS locked FROM platform_operators WHERE email = ?', [email]);
  assert.equal(Number(o.failures), 5); assert.equal(Number(o.locked), 1);
  const late = await plat('/login', { email, password: opPw, code: totp.hotp(secret, step + 2) });
  assert.equal(late.status, 403, 'the right code is refused while locked');
});

test('an unknown login takes about as long to refuse as a wrong password', async () => {
  const time = async (email) => { const t = process.hrtime.bigint(); await api('POST', '/auth/login', { body: { tenant: slug, email, password: 'wrong-password-xyz' } }); return Number(process.hrtime.bigint() - t) / 1e6; };
  const fay = await addUser('fay');
  const known = []; const unknown = [];
  for (let i = 0; i < 6; i += 1) { known.push(await time(fay)); unknown.push(await time(`nobody${i}@${slug}.test`)); }
  const med = (x) => x.sort((p, q) => p - q)[Math.floor(x.length / 2)];
  assert.ok(med(unknown) > med(known) * 0.6, `unknown ${med(unknown).toFixed(0)} ms, known ${med(known).toFixed(0)} ms`);
});
