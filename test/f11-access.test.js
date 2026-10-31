'use strict';

// Release 2026.11.11, Track ACCESS: sign-in, sessions, roles, links, the console and the edge. One test per finding,
// each the review's proof turned around (it passed while the defect was there, and must fail now).
//   ACC-1  adding a passkey needs the second check, and adding one is not the check
//   ACC-2  the console: a fresh code (or passkey) to add a passkey; signing out ends the session on the server
//   ACC-3  a password alone never beats two-step: recovery codes, change-password, and wrong passwords count toward the lock
//   ACC-4  a PIN session cannot set up two-step or change the username
//   ACC-5  off the patrol roster means no patrol access
//   ACC-6  a login's email or last day needs the second check; the old address is told
//   ACC-7  shared rate limits hold against bursts on several servers
//   ACC-8  a login's last day is the mountain's day
//   ACC-9  downloads with names need the second check
//   ACC-10 a locked login and an unknown one answer the same; the owner's own device still gets in
//   ACC-11 bad query strings answer 400
//   CR-1   lift staff cannot read customer histories
//   CR-2   claim share passcode guesses sent at once get 10 checks in all
//   CR-4   the offline entry key is per device and changes with a password change
//   G7     the family sign-in link replies before any email work
//   G8     the website's contact copy carries nothing typed
//   C-1, C-2, INF-5, INF-6, INF-10 and the suspicions (another mountain's person, lesson links that run out)
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'f11-access-postmark';
process.env.MAIL_FROM = process.env.MAIL_FROM || 'noreply@test.example';
process.env.SITE_CONTACT_EMAIL = 'hello@test.example';
process.env.PUBLIC_URL = 'https://app.example.test';

const http = require('node:http');
const nodePath = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const sessions = require('../src/lib/sessions');
const totp = require('../src/lib/totp');
const mailer = require('../src/lib/mailer');
const { SoftAuthenticator } = require('./fixtures/authenticator');

const root = nodePath.join(__dirname, '..');
let server; let base; let stub;
const mails = [];
let mailDelay = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const DEVICE = 'f11-access-device-0123456789';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-device': DEVICE, ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const login = async (slug, who, password = PW, device = DEVICE) => (await api('POST', '/auth/login', { headers: { 'x-device': device }, body: { tenant: slug, login: who, password } })).body.token;
const sidOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sid;
const stale = (token) => pool.query('UPDATE user_sessions SET stepped_up_at = NULL WHERE id_hash = ?', [sessions.hash(sidOf(token))]);
const stepUpCode = (r) => r.status === 403 && r.body && r.body.details && r.body.details.code === 'step_up_required';
const OWNER_HASH = bcrypt.hashSync(PW, 4);
/** A mountain and its owner, made in the database as POST /tenants does (that route allows 5 a minute). */
async function mountain(tag, timezone = 'America/New_York') {
  const slug = `${tag}-${suffix}`;
  const [t] = await pool.query('INSERT INTO tenants (slug, name, timezone) VALUES (?, ?, ?)', [slug, slug, timezone]);
  const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, 'Olive', 'Owner', ?)", [t.insertId, `owner@${slug}.test`]);
  const [u] = await pool.query("INSERT INTO users (tenant_id, person_id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, 'owner')", [t.insertId, p.insertId, `owner@${slug}.test`, `owner${tag}${suffix}`.slice(0, 30), OWNER_HASH]);
  return { slug, id: t.insertId, ownerId: u.insertId, owner: await login(slug, `owner@${slug}.test`) };
}
/** A login inserted directly (role, optional staff record). */
async function user(m, role, { staff = false, email } = {}) {
  email = email || `${role}-${Math.random().toString(36).slice(2, 8)}@${m.slug}.test`;
  const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [m.id, 'Test', role, email]);
  let staffId = null;
  if (staff) staffId = (await pool.query("INSERT INTO staff (tenant_id, person_id, status) VALUES (?, ?, 'active')", [m.id, p.insertId]))[0].insertId;
  const uname = `${role}${Math.random().toString(36).slice(2, 10)}`.slice(0, 30);
  const [u] = await pool.query('INSERT INTO users (tenant_id, person_id, staff_id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)', [m.id, p.insertId, staffId, email, uname, await bcrypt.hash(PW, 4), role]);
  return { id: u.insertId, personId: p.insertId, staffId, email, username: uname, token: await login(m.slug, email) };
}
const code = (secret, offset = 0) => totp.hotp(secret, totp.stepAt(Date.now()) + offset);
async function withApp(m) { // turns two-step (app) on for a mountain's owner; returns the secret
  const s = await api('POST', '/auth/mfa/setup', { token: m.owner });
  assert.equal(s.status, 200, s.text);
  assert.equal((await api('POST', '/auth/mfa/enable', { token: m.owner, body: { code: code(s.body.secret) } })).status, 200);
  return s.body.secret;
}

test.before(async () => {
  stub = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { setTimeout(() => { try { mails.push(JSON.parse(b || '{}')); } catch (_) { /* not mail */ } res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"m"}'); }, mailDelay); }); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${stub.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stub.close(r)); await pool.end(); });

// ---------------------------------------------------------------- ACC-1
test('ACC-1: adding a passkey needs the second check, and adding one does not give it', async () => {
  const m = await mountain('a1');
  const phone = new SoftAuthenticator(base);
  // Straight after a password sign-in (no passkey or app yet) the password was the check: the first passkey goes on.
  let o = await api('POST', '/auth/passkeys/options', { token: m.owner });
  assert.equal(o.status, 200, o.text);
  assert.equal((await api('POST', '/auth/passkeys', { token: m.owner, body: { handle: o.body.handle, response: phone.create(o.body.options) } })).status, 201);
  // A session whose check has run out (a copied token): no new passkey, and the password is not enough to confirm.
  const pw = await api('POST', '/auth/login', { body: { tenant: m.slug, login: `owner@${m.slug}.test`, password: PW } });
  const p2 = await api('POST', '/auth/mfa/passkey-options', { body: { mfa_token: pw.body.mfa_token } });
  const tok = (await api('POST', '/auth/mfa', { body: { mfa_token: pw.body.mfa_token, handle: p2.body.handle, response: phone.get(p2.body.options) } })).body.token;
  await stale(tok);
  o = await api('POST', '/auth/passkeys/options', { token: tok });
  assert.ok(stepUpCode(o), o.text);
  assert.ok(stepUpCode(await api('POST', '/auth/passkeys', { token: tok, body: { handle: 'x', response: {} } })));
  assert.equal((await api('POST', '/auth/step-up', { token: tok, body: { password: PW } })).status, 403);
  // Registering (after a real check) leaves the check's time alone: it is not a check of its own.
  const s = await api('POST', '/auth/step-up/options', { token: tok });
  assert.equal((await api('POST', '/auth/step-up', { token: tok, body: { handle: s.body.passkey.handle, response: phone.get(s.body.passkey.options) } })).status, 200);
  await pool.query('UPDATE user_sessions SET stepped_up_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 9 MINUTE) WHERE id_hash = ?', [sessions.hash(sidOf(tok))]);
  o = await api('POST', '/auth/passkeys/options', { token: tok });
  assert.equal((await api('POST', '/auth/passkeys', { token: tok, body: { handle: o.body.handle, response: new SoftAuthenticator(base).create(o.body.options) } })).status, 201);
  const [[row]] = await pool.query('SELECT TIMESTAMPDIFF(MINUTE, stepped_up_at, UTC_TIMESTAMP()) AS ago FROM user_sessions WHERE id_hash = ?', [sessions.hash(sidOf(tok))]);
  assert.ok(Number(row.ago) >= 8, 'the check was not renewed by adding a passkey');
});

// ---------------------------------------------------------------- ACC-2
test('ACC-2: the console asks for a fresh code to add a passkey, and signing out ends the session', async () => {
  const plat = (method, path, { session, body } = {}) => api(method, `/platform${path}`, { body, headers: session ? { 'x-platform-session': session } : {} });
  const email = `op-${suffix}@example.test`; const opw = 'a-long-operator-password-9';
  await pool.query('INSERT INTO platform_operators (email, name, password_hash, password_changed_at, created_by) VALUES (?, ?, ?, UTC_TIMESTAMP(), ?)', [email, 'Opal', await bcrypt.hash(opw, 4), 'f11']);
  const first = await plat('POST', '/login', { body: { email, password: opw } });
  const secret = first.body.secret;
  const setup = await plat('POST', '/login/setup', { body: { setup_token: first.body.setup_token, code: code(secret) } });
  const session = setup.body.session;
  assert.ok(session, setup.text);
  const bare = await plat('POST', '/me/passkeys/options', { session, body: {} });
  assert.equal(bare.status, 403);
  assert.equal(bare.body.details.code, 'fresh_check_required');
  assert.equal((await plat('POST', '/me/passkeys/options', { session, body: { code: '000000' } })).status, 403);
  const ok = await plat('POST', '/me/passkeys/options', { session, body: { code: code(secret, 1) } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await plat('GET', '/me', { session })).status, 200);
  assert.equal((await plat('POST', '/logout', { session })).status, 204);
  assert.equal((await plat('GET', '/me', { session })).status, 403, 'a copy of the session no longer works');
});

// ---------------------------------------------------------------- ACC-3
test('ACC-3: a password alone does not beat two-step, and wrong passwords after sign-in count toward the lock', async () => {
  const m = await mountain('a3');
  const secret = await withApp(m);
  const pw = await api('POST', '/auth/login', { body: { tenant: m.slug, login: `owner@${m.slug}.test`, password: PW } });
  const tok = (await api('POST', '/auth/mfa', { body: { mfa_token: pw.body.mfa_token, code: code(secret, 1) } })).body.token;
  await stale(tok);
  assert.ok(stepUpCode(await api('POST', '/auth/mfa/recovery-codes', { token: tok, body: { password: PW } })), 'recovery codes need the app or a passkey');
  const cp = await api('POST', '/auth/change-password', { token: tok, body: { current_password: PW, new_password: 'another-long-pass-917' } });
  assert.equal(cp.status, 200, cp.text);
  assert.ok(stepUpCode(await api('GET', '/people/export.csv', { token: cp.body.token })), 'the new session is not stepped up');
  assert.ok(stepUpCode(await api('POST', '/users', { token: cp.body.token, body: { email: `m-${suffix}@x.test`, password: 'attacker-chosen-pass-99', role: 'manager' } })));
  // With a code from the app, both work.
  await pool.query('UPDATE users SET totp_last_step = NULL WHERE id = ?', [m.ownerId]); // the next code in the window, as if 30 seconds later
  assert.equal((await api('POST', '/auth/step-up', { token: cp.body.token, body: { code: code(secret) } })).status, 200);
  assert.ok((await api('POST', '/auth/mfa/recovery-codes', { token: cp.body.token, body: {} })).body.recovery_codes.length > 0);
  // A login with neither: its password is the check, and wrong ones there count toward the 10 that lock the login.
  const b = await mountain('a3b');
  await stale(b.owner);
  for (let i = 0; i < 10; i += 1) assert.equal((await api('POST', '/auth/step-up', { token: b.owner, body: { password: `wrong-${i}-password` } })).status, 403);
  assert.equal((await api('POST', '/auth/step-up', { token: b.owner, body: { password: PW } })).status, 429, 'locked after 10 wrong passwords');
  assert.equal((await api('POST', '/auth/login', { headers: { 'x-device': 'f11-other-device-000000000' }, body: { tenant: b.slug, login: `owner@${b.slug}.test`, password: PW } })).status, 429, 'the sign-in page is locked too');
});

// ---------------------------------------------------------------- ACC-4
test('ACC-4: a PIN session cannot turn on two-step or change the username', async () => {
  const m = await mountain('a4');
  const term = await api('POST', '/terminals', { token: m.owner, body: { name: 'Window 1' } });
  assert.equal(term.status, 201, term.text);
  const v = await user(m, 'counter');
  assert.equal((await api('PUT', '/auth/pin', { token: v.token, body: { password: PW, pin: '583920' } })).status, 200);
  const ps = (await api('POST', '/auth/pin-login', { body: { tenant: m.slug, terminal: term.body.secret, login: v.username, pin: '583920' } })).body.token;
  assert.equal((await api('POST', '/auth/mfa/setup', { token: ps })).status, 403);
  assert.equal((await api('POST', '/auth/mfa/enable', { token: ps, body: { code: '123456' } })).status, 403);
  assert.equal((await api('POST', '/auth/username', { token: ps, body: { username: `x${suffix}`.slice(0, 20) } })).status, 403);
  assert.equal((await api('POST', '/auth/mfa/recovery-codes', { token: ps, body: {} })).status, 403);
});

// ---------------------------------------------------------------- ACC-5
test('ACC-5: someone taken off the patrol roster has no patrol access', async () => {
  const m = await mountain('a5');
  const dir = await user(m, 'patrol', { staff: true });
  await pool.query("INSERT INTO patrol_members (tenant_id, staff_id, level, access_level) VALUES (?, ?, 'director', 'admin')", [m.id, dir.staffId]);
  const lee = await user(m, 'patrol', { staff: true });
  await pool.query("INSERT INTO patrol_members (tenant_id, staff_id, level, access_level) VALUES (?, ?, 'patroller', 'patrol')", [m.id, lee.staffId]);
  const leeTok = await login(m.slug, lee.email);
  const inc = await api('POST', '/patrol/incidents', { token: m.owner, body: { occurred_at: '2026-10-31 10:00:00', location: 'Upper Ridge', category: 'injury', summary: 'Fall' } });
  assert.equal(inc.status, 201, inc.text);
  assert.equal((await api('GET', `/patrol/incidents/${inc.body.id}`, { token: leeTok })).status, 200, 'on the roster: opens the case');
  assert.ok((await api('DELETE', `/patrol/team/${lee.staffId}`, { token: dir.token })).status < 300);
  assert.equal((await api('GET', `/patrol/incidents/${inc.body.id}`, { token: leeTok })).status, 403);
  assert.equal((await api('GET', '/patrol/incidents', { token: leeTok })).status, 403);
  assert.equal((await api('POST', '/patrol/incidents', { token: leeTok, body: { occurred_at: '2026-10-31 11:00:00', location: 'Base', category: 'other', summary: 'x' } })).status, 403);
});

// ---------------------------------------------------------------- ACC-6
test('ACC-6: changing a login\'s email or last day needs the second check, and the old address is told', async () => {
  const m = await mountain('a6');
  const p = await user(m, 'patrol', { staff: true });
  await stale(m.owner);
  assert.ok(stepUpCode(await api('PATCH', `/users/${p.id}`, { token: m.owner, body: { email: `new-${suffix}@attacker.example` } })));
  assert.ok(stepUpCode(await api('PATCH', `/users/${p.id}`, { token: m.owner, body: { access_ends_on: '2020-01-01' } })));
  assert.equal((await api('PATCH', `/users/${p.id}`, { token: m.owner, body: { username: `pat${suffix}`.slice(0, 20) } })).status, 200, 'other fields as before');
  await pool.query('UPDATE user_sessions SET stepped_up_at = UTC_TIMESTAMP() WHERE id_hash = ?', [sessions.hash(sidOf(m.owner))]);
  const before = mails.length;
  assert.equal((await api('PATCH', `/users/${p.id}`, { token: m.owner, body: { email: `new-${suffix}@x.example` } })).status, 200);
  for (let i = 0; i < 50 && !mails.slice(before).some((x) => x.To === p.email); i += 1) await wait(20);
  const told = mails.slice(before).find((x) => x.To === p.email);
  assert.ok(told && /changed/.test(told.Subject), 'the old address is told');
});

// ---------------------------------------------------------------- ACC-7
test('ACC-7: a burst on three servers at once still gets only the limit through', async () => {
  const RS = require('../src/lib/ratestore');
  const name = `f11-burst-${suffix}`;
  const stores = [1, 2, 3].map(() => { const s = new RS.MysqlStore({ prefix: name, pool }); s.init({ windowMs: 60_000 }); return s; });
  let allowed = 0;
  for (const s of stores) allowed += (await Promise.all(Array.from({ length: 10 }, () => s.increment('203.0.113.7')))).filter((r) => r.totalHits <= 10).length;
  assert.equal(allowed, 10);
  const k = require('node:crypto').createHash('sha256').update(`${name}\u0000203.0.113.7`).digest();
  const [[row]] = await pool.query('SELECT hits FROM rate_limits WHERE k = ?', [k]);
  assert.equal(Number(row.hits), 30, 'every hit reached the shared row');
});

// ---------------------------------------------------------------- ACC-8
test('ACC-8: a login works through its last day at the mountain, and stops the day after', async () => {
  const { todayIn } = require('../src/lib/util');
  const AE = require('../src/lib/accessend');
  for (const tz of ['Pacific/Pago_Pago', 'Pacific/Kiritimati', 'America/Denver']) {
    const local = todayIn(tz);
    const yesterday = new Date(Date.parse(`${local}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    assert.equal(AE.over(local, tz), false, `${tz}: the last day is today there`);
    assert.equal(AE.over(yesterday, tz), true, `${tz}: the last day was yesterday there`);
  }
  // End to end, for a mountain whose date is not the UTC one right now.
  const utc = new Date().toISOString().slice(0, 10);
  const tz = todayIn('Pacific/Pago_Pago') !== utc ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
  const m = await mountain('a8', tz);
  const u = await user(m, 'counter');
  const local = todayIn(tz);
  await pool.query('UPDATE users SET access_ends_on = ? WHERE id = ?', [local, u.id]);
  assert.equal((await api('POST', '/auth/login', { body: { tenant: m.slug, login: u.email, password: PW } })).status, 200);
  assert.equal((await api('GET', '/auth/me', { token: u.token })).status, 200);
  const yesterday = new Date(Date.parse(`${local}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  await pool.query('UPDATE users SET access_ends_on = ? WHERE id = ?', [yesterday, u.id]);
  assert.equal((await api('POST', '/auth/login', { body: { tenant: m.slug, login: u.email, password: PW } })).status, 403);
  assert.equal((await api('GET', '/auth/me', { token: u.token })).status, 401);
  assert.equal((await api('POST', '/users/season-end', { token: m.owner, body: { date: local } })).status, 200, 'today at the mountain is allowed');
});

// ---------------------------------------------------------------- ACC-9
test('ACC-9: downloads with names in them need the second check', async () => {
  const m = await mountain('a9');
  await stale(m.owner);
  for (const p of ['/staff-injuries/log.csv', '/exports/sales.csv?from=2026-10-01&to=2026-10-31', '/exports/refunds.csv?from=2026-10-01&to=2026-10-31', '/workforce/time/export?start=2026-10-26']) {
    const r = await api('GET', p, { token: m.owner });
    assert.ok(stepUpCode(r), `${p}: ${r.status} ${r.text.slice(0, 80)}`);
  }
});

// ---------------------------------------------------------------- ACC-10
test('ACC-10: a locked login and an unknown one answer the same; the owner\'s own device still gets in', async () => {
  const m = await mountain('a10');
  const probe = async (who) => { let last; for (let i = 0; i < 11; i += 1) last = await api('POST', '/auth/login', { headers: { 'x-device': 'f11-attacker-device-0000000' }, body: { tenant: m.slug, login: who, password: `guess-${i}-xxxxxxxx` } }); return last; };
  const real = await probe(`owner@${m.slug}.test`);
  const fake = await probe(`nobody@${m.slug}.test`);
  assert.equal(real.status, 429);
  assert.equal(fake.status, 429);
  assert.deepEqual(real.body, fake.body, 'the same words');
  assert.equal((await api('POST', '/auth/login', { body: { tenant: m.slug, login: `owner@${m.slug}.test`, password: PW } })).status, 200, 'the owner, on a device used before');
  assert.equal((await api('POST', '/auth/login', { headers: { 'x-device': 'f11-attacker-device-0000000' }, body: { tenant: m.slug, login: `owner@${m.slug}.test`, password: PW } })).status, 429, 'not on a new one');
});

// ---------------------------------------------------------------- ACC-11
test('ACC-11: a missing or malformed query string answers 400', async () => {
  const m = await mountain('a11');
  for (const p of ['/workforce/time/export', '/workforce/time/export?start=next-week', '/skischool/director/offers/free']) assert.equal((await api('GET', p, { token: m.owner })).status, 400, p);
});

// ---------------------------------------------------------------- CR-1
test('CR-1: lift staff cannot read a customer\'s history or welcome card; the desk can', async () => {
  const m = await mountain('c1');
  const staff = await user(m, 'staff');
  const counter = await user(m, 'counter');
  const [g] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, date_of_birth) VALUES (?, 'Grace', 'Guest', '2015-01-01')", [m.id]);
  assert.equal((await api('GET', `/guests/people/${g.insertId}/history`, { token: staff.token })).status, 403);
  assert.equal((await api('GET', `/guests/people/${g.insertId}/welcome`, { token: staff.token })).status, 403);
  assert.equal((await api('GET', `/guests/people/${g.insertId}/history`, { token: counter.token })).status, 200);
});

// ---------------------------------------------------------------- CR-2
test('CR-2: passcode guesses sent all at once get 10 checks in all', async () => {
  const m = await mountain('c2');
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'patrol', 1) ON DUPLICATE KEY UPDATE enabled = 1", [m.id]).catch(() => {});
  const mk = await api('POST', '/patrol/risk-report/share', { token: m.owner, body: { shared_with: 'Broker', passcode: true } });
  assert.equal(mk.status, 201, mk.text);
  const token = mk.body.url.split('/c/')[1]; const right = mk.body.passcode;
  const guesses = Array.from({ length: 60 }, (_v, i) => String((Number(right) + 1 + i) % 1e6).padStart(6, '0'));
  const res = await Promise.all(guesses.map((g) => api('GET', `/public/claim-share/${token}`, { headers: { 'x-share-code': g } })));
  assert.ok(res.filter((r) => r.status === 401).length <= 10, `${res.filter((r) => r.status === 401).length} compared`);
  assert.equal((await api('GET', `/public/claim-share/${token}`, { headers: { 'x-share-code': right } })).status, 423, 'locked, even for the right code');
});

// ---------------------------------------------------------------- CR-4
test('CR-4: the key for offline entries is per device and changes with a password change', async () => {
  const m = await mountain('c4');
  const p = await user(m, 'patrol');
  await pool.query('UPDATE users SET email = NULL WHERE id = ?', [p.id]); // no emailed code for a new phone, so each sign-in is direct
  const keyOn = async (device) => (await api('GET', '/auth/me', { token: await login(m.slug, p.username, PW, device) })).body.device_key;
  const a1 = await keyOn('f11-phone-a-000000000000000');
  assert.equal(await keyOn('f11-phone-a-000000000000000'), a1, 'the same phone, the same key');
  assert.notEqual(await keyOn('f11-phone-b-000000000000000'), a1, 'another phone, another key');
  const tok = await login(m.slug, p.username, PW, 'f11-phone-a-000000000000000');
  assert.ok(a1 && tok);
  const cp = await api('POST', '/auth/change-password', { token: tok, headers: { 'x-device': 'f11-phone-a-000000000000000' }, body: { current_password: PW, new_password: 'another-long-pass-917' } });
  assert.equal(cp.status, 200, cp.text);
  assert.notEqual((await api('GET', '/auth/me', { token: cp.body.token })).body.device_key, a1, 'a password change gives a new key');
});

// ---------------------------------------------------------------- G7 and G8
test('G7: the family sign-in link answers at once, known email or not; the email follows', async () => {
  const m = await mountain('g7');
  const email = `fam-${suffix}@x.test`;
  await pool.query("INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, 'Pat', 'Parent', ?)", [m.id, email]);
  mailDelay = 400;
  try {
    const t0 = Date.now();
    const r = await api('POST', `/public/${m.slug}/family/link`, { body: { email } });
    const took = Date.now() - t0;
    if (r.status === 404) return; // the mountain has no family page (programs off): nothing to time
    assert.equal(r.status, 200, r.text);
    assert.ok(took < 300, `answered in ${took} ms, not after the email`);
    for (let i = 0; i < 100 && !mails.some((x) => x.To === email); i += 1) await wait(20);
    assert.ok(mails.some((x) => x.To === email), 'the link was still sent');
  } finally { mailDelay = 0; }
});

test('G8: the contact form\'s copy to the typed address carries nothing that was typed', async () => {
  const before = mails.length;
  const r = await api('POST', '/site/contact', { body: { kind: 'question', name: 'Verify now at https://evil.example/verify', mountain: 'https://evil.example/verify', email: `victim-${suffix}@example.org` } });
  assert.equal(r.status, 201, r.text);
  for (let i = 0; i < 50 && !mails.slice(before).some((x) => x.To === `victim-${suffix}@example.org`); i += 1) await wait(20);
  const copy = mails.slice(before).find((x) => x.To === `victim-${suffix}@example.org`);
  if (copy) assert.ok(!/evil\.example/.test(`${copy.Subject} ${copy.TextBody}`), copy.TextBody);
});

// ---------------------------------------------------------------- C-1 and C-2
test('C-1, C-2: stylesheets only from this address; the canonical address never comes from the Host header', async () => {
  const r = await fetch(`${base}/site/pricing`);
  const csp = r.headers.get('content-security-policy') || '';
  const style = (/style-src[^;]*/.exec(csp) || [''])[0];
  assert.ok(style && !/\bhttps:(\s|$)/.test(style), style);
  const html = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/site/pricing', headers: { host: 'attacker.example' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); }).on('error', reject);
  });
  const canon = (/<link rel="canonical" href="([^"]*)"/.exec(html) || [])[1] || '';
  assert.ok(canon && !canon.includes('attacker.example'), canon);
});

// ---------------------------------------------------------------- INF-5
test('INF-5: the visitor\'s address is right behind the load balancer and with run.app open', async () => {
  const express = require('express');
  const { trustProxy } = require('../src/lib/clientip');
  const app = express();
  app.set('trust proxy', trustProxy({ TRUST_PROXY_LB_IPS: '34.120.10.10' }));
  app.get('/ip', (req, res) => res.send(req.ip));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const ip = (xff) => fetch(`http://127.0.0.1:${srv.address().port}/ip`, { headers: { 'x-forwarded-for': xff } }).then((r) => r.text());
  try {
    assert.equal(await ip('203.0.113.77, 34.120.10.10'), '203.0.113.77', 'through the load balancer');
    assert.equal(await ip('10.20.30.40, 203.0.113.66'), '203.0.113.66', 'straight to run.app: what the visitor sent is not believed');
    assert.equal(await ip('10.20.30.40, 203.0.113.66, 34.120.10.10'), '203.0.113.66');
  } finally { srv.close(); }
  assert.equal(trustProxy({}), 1, 'without the setting, the hop count as before');
});

// ---------------------------------------------------------------- INF-6 and INF-10 (their own servers)
function run(env, script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (codeNo) => resolve({ code: codeNo, out }));
  });
}
test('INF-6: the staging password allows a few tries, and a pass is per browser', async () => {
  const script = `
    const { createApp } = require('./src/app'); const { pool } = require('./src/db');
    const s = createApp().listen(0, '127.0.0.1', async () => {
      const url = 'http://127.0.0.1:' + s.address().port + '/__staging';
      const post = (pw) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + pw + '&next=/' });
      const ok = await post('Mountain2026'); const c1 = ok.headers.get('set-cookie'); const c2 = (await post('Mountain2026')).headers.get('set-cookie');
      const codes = []; for (let i = 0; i < 15; i++) codes.push((await post('guess' + i)).status);
      const open = await fetch('http://127.0.0.1:' + s.address().port + '/api/v1/auth/me', { headers: { cookie: c1.split(';')[0] } });
      console.log(JSON.stringify({ first: ok.status, different: c1 !== c2, days: /Max-Age=(\\d+)/.exec(c1)[1] / 86400, codes, open: open.status }));
      s.close(); await pool.end();
    });`;
  const r = await run({ STAGE: 'staging', STAGING_GATE: 'Mountain2026', STAGING_INBOX: 'me@example.test', RATE_STORE: 'memory', NODE_ENV: 'development' }, script);
  const o = JSON.parse(r.out.trim().split('\n').pop());
  assert.equal(o.first, 303);
  assert.ok(o.different, 'each sign-in gets its own pass');
  assert.equal(o.days, 7);
  assert.ok(o.codes.includes(429), JSON.stringify(o.codes));
  assert.equal(o.open, 401, 'the pass opens the site; the API still wants its own sign-in');
});
test('INF-10: production will not start with unsafe settings', async () => {
  const r = await run({ NODE_ENV: 'production', BOOTSTRAP_KEY: 'x', JWT_SECRET: 'a'.repeat(32), DB_USER: 'root', PUBLIC_URL: '', PORT: '0' }, "require('./src/server')");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Unsafe settings for production/);
  assert.match(r.out, /JWT_SECRET/); assert.match(r.out, /BOOTSTRAP_KEY/); assert.match(r.out, /DB_USER/); assert.match(r.out, /PUBLIC_URL/);
  // The platform key's own sign-in has the operator sign-in limit (20 in 15 minutes per address).
  const app = require('fs').readFileSync(nodePath.join(root, 'src/app.js'), 'utf8');
  assert.match(app, /api\.post\(\['\/platform\/session', '\/platform\/login'/);
});

// ---------------------------------------------------------------- suspicions
test('Suspicions: a login takes only this mountain\'s person; lesson links run out 60 days after the lesson', async () => {
  const a = await mountain('s1a');
  const b = await mountain('s1b');
  const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Other', 'Mountain')", [b.id]);
  assert.equal((await api('POST', '/users', { token: a.owner, body: { username: `x${suffix}`.slice(0, 20), password: 'a-long-enough-pass-1', role: 'counter', person_id: p.insertId } })).status, 404);
  const LL = require('../src/lib/lessonlinks');
  const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(LL.expired({ ends_at: ago(10) }), false);
  assert.equal(LL.expired({ ends_at: ago(61) }), true);
});
