'use strict';

// Sign-in hardening (feat/auth-hardening), findings 1 to 10 of the security review, each probe turned into a test:
// emailed codes on their own counter; app codes counted per login at the second check and when turning two-step on or
// off; sign-in security events in the outside audit copy (no secrets); security emails; family tokens after #; one PIN
// answer; the 72-byte password cap; the passkey origin; HIPAA.md; 6-digit kiosk PINs. Also the console reset reason.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000'; // the per-address limits are not what is tested here: the per-login counts are
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.LOGIN_LOCK_AFTER = '4';
process.env.AUDIT_LOG_STDOUT = 'on';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Emails go to a stand-in for Postmark.
const mails = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { try { mails.push(JSON.parse(body)); } catch (_) { /* not JSON */ } res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"x"}'); });
}).listen(0);
process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.POSTMARK_SERVER_TOKEN = 'test-token';
process.env.MAIL_FROM = 'hello@test.example';

// The outside audit copy (summitops-audit) is read from what the server writes to stdout.
const trail = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = String(chunk);
  if (s.includes('"summitops-audit"')) { for (const line of s.split('\n').filter(Boolean)) { try { trail.push(JSON.parse(line)); } catch (_) { /* partial */ } } return true; }
  return write(chunk, ...rest);
};

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const totp = require('../src/lib/totp');
const { SoftAuthenticator } = require('./fixtures/authenticator');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const DEVICE = 'auth-hardening-device-0123456789';

async function api(method, p, { token, body, headers = {}, device = DEVICE } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(device ? { 'x-device': device } : {}), ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body).slice(0, 300)}`);
const settle = (ms = 250) => new Promise((r) => { setTimeout(r, ms); });
const login = (slug, who, password = PW, extra = {}) => api('POST', '/auth/login', { body: { tenant: slug, login: who, password, ...extra } });
const codeNow = (secret) => totp.hotp(secret, totp.stepAt(Date.now()));
const wrongFor = (secret) => { const c = codeNow(secret); return c === '000000' ? '111111' : '000000'; };
const freshCode = async (userId, secret) => { await pool.query('UPDATE users SET totp_last_step = NULL WHERE id = ?', [userId]); return codeNow(secret); };
const mailsTo = (to) => mails.filter((m) => m.To === to);
const idOf = async (slug, who) => Number((await pool.query('SELECT u.id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = ? AND (u.username = ? OR u.email = ?)', [slug, who, who]))[0][0].id);

let M;
async function mountain(slug) {
  const r = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Peak ${slug}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(r.status, 201);
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return { slug, id: t.id, owner: ok(await login(slug, `owner@${slug}.test`)).token };
}
/** A login (with a staff record) at mountain m. Returns { id, token, email }. */
async function person(m, name, role = 'counter') {
  const staff = ok(await api('POST', '/workforce/staff', { token: m.owner, body: { person: { first_name: name, last_name: 'Tester' }, status: 'active' } })).id;
  const email = `${name.toLowerCase()}@${m.slug}.test`;
  const u = ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, staff_id: staff } }));
  return { id: u.id, staff, email, token: ok(await login(m.slug, email)).token };
}
/** Turns on the authenticator app for a signed-in login (password as the second check first). Returns the secret. */
async function withApp(p) {
  ok(await api('POST', '/auth/step-up', { token: p.token, body: { password: PW } }));
  const { secret } = ok(await api('POST', '/auth/mfa/setup', { token: p.token }));
  ok(await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: codeNow(secret) } }));
  return secret;
}

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M = await mountain(`ah-${suffix}`);
});
test.after(async () => { await new Promise((r) => server.close(r)); stub.close(); await pool.end(); process.stdout.write = write; });

// ---------------------------------------------------------------- 1. emailed codes on their own counter
test('1: five wrong emailed codes from another device never lock the right password plus the right app code', async () => {
  const ann = await person(M, 'Ann');
  const secret = await withApp(ann);
  const req = ok(await api('POST', '/auth/email-code', { body: { tenant: M.slug, login: ann.email }, device: 'someone-elses-device-0123456789' }));
  for (let i = 0; i < 5; i += 1) is(await api('POST', '/auth/email-code/verify', { body: { request: req.request, code: '000000' }, device: 'someone-elses-device-0123456789' }), 401, `wrong emailed code ${i + 1}`);
  // The emailed path locks itself.
  is(await api('POST', '/auth/email-code/verify', { body: { request: req.request, code: '000000' } }), 429, 'emailed codes are locked for this login');
  const [[u]] = await pool.query('SELECT mfa_failures, mfa_locked_until, email_code_failures, email_code_locked_until FROM users WHERE id = ?', [ann.id]);
  assert.equal(Number(u.mfa_failures), 0, 'the app-code count is untouched');
  assert.equal(u.mfa_locked_until, null);
  assert.ok(u.email_code_locked_until, 'emailed codes have their own lock');
  // The real person: right password, right app code, signed in.
  const first = ok(await login(M.slug, ann.email));
  assert.equal(first.mfa_required, true);
  const done = ok(await api('POST', '/auth/mfa', { body: { mfa_token: first.mfa_token, code: await freshCode(ann.id, secret) } }));
  assert.ok(done.token, 'signed in despite the wrong emailed codes');
});

// ---------------------------------------------------------------- 2. app codes counted per login
test('2: 40 wrong app codes at the second check lock after 5; the right one is refused while locked, at sign-in too, and works after', async () => {
  const bob = await person(M, 'Bob');
  const secret = await withApp(bob);
  const signedIn = ok(await api('POST', '/auth/mfa', { body: { mfa_token: ok(await login(M.slug, bob.email)).mfa_token, code: await freshCode(bob.id, secret) } })).token;
  const answers = [];
  for (let i = 0; i < 40; i += 1) answers.push((await api('POST', '/auth/step-up', { token: signedIn, body: { code: wrongFor(secret) } })).status);
  assert.deepEqual(answers.slice(0, 5), [403, 403, 403, 403, 403]);
  assert.ok(answers.slice(5).every((s) => s === 429), `then too many: ${answers.slice(5).join(',')}`);
  is(await api('POST', '/auth/step-up', { token: signedIn, body: { code: await freshCode(bob.id, secret) } }), 429, 'the right code is refused while locked');
  const half = ok(await login(M.slug, bob.email));
  is(await api('POST', '/auth/mfa', { body: { mfa_token: half.mfa_token, code: await freshCode(bob.id, secret) } }), 429, 'and so is the sign-in second step');
  // The lock runs out as sign-in's does: then the right code works and the count starts again.
  await pool.query('UPDATE users SET mfa_locked_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE id = ?', [bob.id]);
  ok(await api('POST', '/auth/step-up', { token: signedIn, body: { code: await freshCode(bob.id, secret) } }));
  assert.equal(Number((await pool.query('SELECT mfa_failures FROM users WHERE id = ?', [bob.id]))[0][0].mfa_failures), 0);
});

test('2: turning two-step on and off counts app codes per login too', async () => {
  const cat = await person(M, 'Cat');
  ok(await api('POST', '/auth/step-up', { token: cat.token, body: { password: PW } }));
  const { secret } = ok(await api('POST', '/auth/mfa/setup', { token: cat.token }));
  for (let i = 0; i < 5; i += 1) is(await api('POST', '/auth/mfa/enable', { token: cat.token, body: { code: wrongFor(secret) } }), 400);
  is(await api('POST', '/auth/mfa/enable', { token: cat.token, body: { code: codeNow(secret) } }), 429, 'locked like sign-in');
  await pool.query('UPDATE users SET mfa_locked_until = NULL, mfa_failures = 0 WHERE id = ?', [cat.id]);
  ok(await api('POST', '/auth/mfa/enable', { token: cat.token, body: { code: codeNow(secret) } }));
  const t = ok(await api('POST', '/auth/mfa', { body: { mfa_token: ok(await login(M.slug, cat.email)).mfa_token, code: await freshCode(cat.id, secret) } })).token;
  for (let i = 0; i < 5; i += 1) is(await api('POST', '/auth/mfa/disable', { token: t, body: { password: PW, code: wrongFor(secret) } }), 403);
  is(await api('POST', '/auth/mfa/disable', { token: t, body: { password: PW, code: await freshCode(cat.id, secret) } }), 429);
});

// ---------------------------------------------------------------- 3. security events in the outside copy
test('3: sign-in events reach the summitops-audit copy, the database rows stay, and nothing secret is in them', async () => {
  const dan = await person(M, 'Dan');
  trail.length = 0;
  const typedName = `nobody-${suffix}`;
  is(await login(M.slug, typedName, 'typed-secret-password-1'), 401, 'unknown login');
  is(await login(M.slug, dan.email, 'typed-secret-password-2'), 401, 'wrong password');
  ok(await login(M.slug, dan.email));
  // Locked after LOGIN_LOCK_AFTER (4) wrong passwords in a row.
  for (let i = 0; i < 4; i += 1) await login(M.slug, dan.email, 'typed-secret-password-3');
  await settle(100);
  const ev = (action) => trail.filter((e) => e.action === action);
  const failed = ev('sign_in_failed');
  assert.ok(failed.some((e) => e.user === null && JSON.parse(e.detail).reason === 'unknown_login' && e.tenant === M.id), 'unknown login: the mountain, no user');
  assert.ok(failed.some((e) => e.user === dan.id && JSON.parse(e.detail).reason === 'wrong_password'));
  assert.ok(ev('sign_in').some((e) => e.user === dan.id && JSON.parse(e.detail).method === 'password' && JSON.parse(e.detail).outcome === 'ok'), 'a sign-in that worked');
  assert.ok(ev('login_locked').some((e) => e.user === dan.id), 'the lock');
  const [[row]] = await pool.query("SELECT user_id, entity_id FROM audit_log WHERE tenant_id = ? AND action = 'login_locked' AND entity_id = ? ORDER BY id DESC LIMIT 1", [M.id, dan.id]);
  assert.ok(row, 'and its database row'); assert.equal(row.user_id, null, 'nobody did it');
  for (const e of trail) {
    const s = JSON.stringify(e);
    for (const secret of ['typed-secret-password', PW, typedName]) assert.ok(!s.includes(secret), `no "${secret}" in ${s}`);
    assert.ok(e.ip !== undefined && 'tenant' in e, 'who, where and which mountain');
  }
});

test('3: a new device, a reset by email, a recovery code, staff resets and the day stop are events too', async () => {
  const eve = await person(M, 'Eve');
  trail.length = 0;
  // New device (the person has a device on record already).
  // New device: without two-step, a code is emailed first; once it is typed, the device is noted (and emailed).
  const NEW = 'a-brand-new-device-000000000001';
  const half = ok(await api('POST', '/auth/login', { body: { tenant: M.slug, login: eve.email, password: PW }, device: NEW }));
  assert.equal(half.methods.email, true);
  await settle();
  const devCode = /(\d{6})/.exec(mailsTo(eve.email).filter((m) => /sign-in code/.test(m.Subject)).at(-1).Subject)[1];
  ok(await api('POST', '/auth/mfa', { body: { mfa_token: half.mfa_token, code: devCode }, device: NEW }));
  // Reset by email.
  const r = ok(await api('POST', '/auth/email-code', { body: { tenant: M.slug, login: eve.email, purpose: 'reset' } }));
  await settle();
  const code = /(\d{6})/.exec(mailsTo(eve.email).at(-1).Subject)[1];
  ok(await api('POST', '/auth/password-reset', { body: { request: r.request, code, new_password: 'a-whole-new-password-77' } }));
  // A recovery code.
  const fay = await person(M, 'Fay');
  ok(await api('POST', '/auth/step-up', { token: fay.token, body: { password: PW } }));
  const { secret } = ok(await api('POST', '/auth/mfa/setup', { token: fay.token }));
  const { recovery_codes: rc } = ok(await api('POST', '/auth/mfa/enable', { token: fay.token, body: { code: codeNow(secret) } }));
  ok(await api('POST', '/auth/mfa', { body: { mfa_token: ok(await login(M.slug, fay.email)).mfa_token, code: rc[0] } }));
  // Staff resets by the owner.
  ok(await api('POST', '/auth/step-up', { token: M.owner, body: { password: PW } }));
  ok(await api('POST', `/users/${fay.id}/reset-mfa`, { token: M.owner }));
  ok(await api('POST', `/users/${fay.id}/reset-password`, { token: M.owner, body: { new_password: 'another-new-password-88', temporary: true } }));
  // The day's 50th wrong code stops emailed codes.
  await pool.query('UPDATE users SET code_day_failures = 49, code_day_from = UTC_TIMESTAMP() WHERE id = ?', [eve.id]);
  const r2 = ok(await api('POST', '/auth/email-code', { body: { tenant: M.slug, login: eve.email } }));
  is(await api('POST', '/auth/email-code/verify', { body: { request: r2.request, code: '000000' } }), 401);
  await settle(100);
  const has = (action, userId) => trail.some((e) => e.action === action && (userId === undefined || e.user === userId));
  for (const [a, u] of [['new_device', eve.id], ['password_reset_by_email', eve.id], ['mfa_recovery_used', fay.id], ['staff_mfa_reset', fay.id], ['staff_password_reset', fay.id], ['codes_stopped', eve.id]]) assert.ok(has(a, u), `${a} in the outside copy`);
  for (const a of ['new_device', 'password_reset_by_email', 'mfa_recovery_used', 'codes_stopped']) {
    assert.ok((await pool.query('SELECT id FROM audit_log WHERE tenant_id = ? AND action = ?', [M.id, a]))[0].length, `${a} database row kept`);
  }
  for (const e of trail) { const s = JSON.stringify(e); for (const x of [code, rc[0], 'a-whole-new-password-77', 'another-new-password-88']) assert.ok(!s.includes(x), `no secret in ${s}`); }
});

test('3: a failed console sign-in goes to the outside copy, and the alert script and runbook cover failed sign-ins', async () => {
  trail.length = 0;
  await api('POST', '/platform/login', { body: { email: `nobody-${suffix}@operators.test`, password: 'typed-console-password', code: '123456' } });
  await settle(100);
  const e = trail.find((x) => x.action === 'sign_in_failed' && x.console === true);
  assert.ok(e, 'console failure logged');
  assert.ok(!JSON.stringify(e).includes('typed-console-password') && !JSON.stringify(e).includes('nobody-'));
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'security-alerts.sh'), 'utf8');
  assert.match(script, /summitops-signin-failures\|Failed staff sign-ins\|[^|]*sign_in_failed[^|]*\|30\|300/);
  assert.match(script, /summitops-console-signin-failures\|Failed console sign-ins/);
  assert.match(script, /not yet/, 'tolerant of a metric made a moment ago');
  const runbook = fs.readFileSync(path.join(__dirname, '..', 'RUNBOOK.md'), 'utf8');
  assert.match(runbook, /^## Security alerts$/m);
  assert.match(runbook, /Failed staff sign-ins/);
});

// ---------------------------------------------------------------- 4. security emails
test('4: security emails for every change to how someone signs in, plain, with when and where, and no secrets', async () => {
  const gus = await person(M, 'Gus');
  mails.length = 0;
  const changed = ok(await api('POST', '/auth/change-password', { token: gus.token, body: { current_password: PW, new_password: 'gus-new-long-password-1' } })).token;
  ok(await api('POST', '/auth/step-up', { token: changed, body: { password: 'gus-new-long-password-1' } }));
  const { secret } = ok(await api('POST', '/auth/mfa/setup', { token: changed }));
  ok(await api('POST', '/auth/mfa/enable', { token: changed, body: { code: codeNow(secret) } }));
  ok(await api('POST', '/auth/step-up', { token: changed, body: { code: await freshCode(gus.id, secret) } }));
  ok(await api('POST', '/auth/mfa/recovery-codes', { token: changed }));
  // A passkey added and removed (a software passkey, end to end).
  const phone = new SoftAuthenticator(base);
  const o = ok(await api('POST', '/auth/passkeys/options', { token: changed }));
  const pk = ok(await api('POST', '/auth/passkeys', { token: changed, body: { handle: o.handle, response: phone.create(o.options), name: 'Test phone' } }));
  ok(await api('DELETE', `/auth/passkeys/${pk.id}`, { token: changed }));
  ok(await api('POST', '/auth/mfa/disable', { token: changed, body: { password: 'gus-new-long-password-1', code: await freshCode(gus.id, secret) } }));
  // A manager resets the password, then two-step.
  ok(await api('POST', '/auth/step-up', { token: M.owner, body: { password: PW } }));
  ok(await api('POST', `/users/${gus.id}/reset-password`, { token: M.owner, body: { new_password: 'gus-reset-password-22', temporary: true } }));
  ok(await api('POST', `/users/${gus.id}/reset-mfa`, { token: M.owner }));
  await settle(400);
  const subjects = mailsTo(gus.email).map((m) => m.Subject);
  for (const s of ['Your Verdynt/OS password was changed', 'Two-step sign-in is on for your Verdynt/OS login', 'New recovery codes for your Verdynt/OS login',
    'A passkey was added to your Verdynt/OS login', 'A passkey was removed from your Verdynt/OS login', 'Two-step sign-in was turned off on your Verdynt/OS login',
    'A manager set a new password for your Verdynt/OS login', 'Two-step sign-in was reset on your Verdynt/OS login']) assert.ok(subjects.includes(s), `sent: ${s} (got ${subjects.join(' | ')})`);
  for (const m of mailsTo(gus.email)) {
    assert.match(m.TextBody, /When: .+UTC/); assert.match(m.TextBody, /From: /);
    assert.match(m.TextBody, /If (this was not you|you did not expect this)/);
    assert.ok(!/—/.test(m.TextBody + m.Subject), 'no em dash');
    for (const x of ['gus-new-long-password-1', 'gus-reset-password-22', PW]) assert.ok(!m.TextBody.includes(x), 'no password');
    assert.ok(!/\b\d{6}\b/.test(m.TextBody), 'no code');
  }
});

// ---------------------------------------------------------------- 5. family tokens after #
test('5: family sign-in links carry the token after #, old ?t= links still work once, and the page clears the address first', async () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const f of ['src/routes/family.js', 'src/routes/guestsaccount.js']) {
    assert.ok(!/\/family\/\$\{t\.slug\}\?(t|join)=/.test(src(f)), `${f}: no token in a query string`);
    assert.match(src(f), /\/family\/\$\{t\.slug\}#(t|join)=/);
  }
  const page = src('public/js/family.js');
  const start = page.slice(page.indexOf('async function start()'), page.indexOf('/** No session'));
  assert.match(start, /location\.hash/, 'reads the fragment');
  assert.match(start, /query\.get\('t'\)/, 'still takes an old ?t= link');
  assert.ok(start.indexOf('history.replaceState') < start.indexOf("call('POST', '/session'"), 'the address is cleared before the token is used');
  assert.ok(!/console\.(log|info|warn|error)\([^)]*location/.test(page), 'nothing logs the address');
});

// ---------------------------------------------------------------- 6. one PIN answer
test('6: PIN sign-in gives one answer, with the same work, for an unknown login, no PIN, a role that may not use one and a wrong PIN', async () => {
  ok(await api('POST', '/auth/step-up', { token: M.owner, body: { password: PW } }));
  const term = ok(await api('POST', '/terminals', { token: M.owner, body: { name: 'Window 1' } }));
  const hal = await person(M, 'Hal');
  ok(await api('PUT', '/auth/pin', { token: hal.token, body: { password: PW, pin: '284719' } }));
  await person(M, 'Ida'); // no PIN
  const pat = await person(M, 'Pat', 'patrol');
  const pin = (who, p = '593017') => api('POST', '/auth/pin-login', { body: { tenant: M.slug, terminal: term.secret, login: who, pin: p } });
  const timed = async (who, p) => { const t0 = process.hrtime.bigint(); const r = await pin(who, p); return { r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };
  const cases = [await timed(`ghost-${suffix}`), await timed(`ida@${M.slug}.test`), await timed(pat.email), await timed(hal.email, '111222')];
  for (const c of cases) { is(c.r, 401); assert.equal(c.r.body.error, cases[0].r.body.error, 'the same words'); }
  const times = cases.map((c) => c.ms);
  assert.ok(Math.max(...times) < Math.min(...times) * 3 + 40, `similar timing: ${times.map((x) => Math.round(x)).join(', ')} ms`);
  ok(await pin(hal.email, '284719'));
  // Five tries at an unknown login also end in "too many", as a real one does.
  for (let i = 0; i < 5; i += 1) await pin(`ghost2-${suffix}`);
  is(await pin(`ghost2-${suffix}`), 429);
});

// ---------------------------------------------------------------- 7. 72 bytes
test('7: new passwords over 72 bytes are refused with a clear message; an existing longer password still signs in', async () => {
  const accented = 'é'.repeat(37); // 37 characters, 74 bytes
  const r = await api('POST', '/users', { token: M.owner, body: { username: `long-${suffix}`, password: accented, role: 'counter' } });
  is(r, 400); assert.match(JSON.stringify(r.body), /72 bytes/);
  const ascii = 'river-stone-maple-cloud-bright-harbor-quiet-lantern-winter-meadow-sun72x'; // 72 bytes
  assert.equal(Buffer.byteLength(ascii), 72);
  ok(await api('POST', '/users', { token: M.owner, body: { username: `fits-${suffix}`, password: ascii, role: 'counter' } }));
  is(await api('POST', '/auth/change-password', { token: M.owner, body: { current_password: PW, new_password: `${ascii}xyz` } }), 400, 'changing to a longer one is refused too');
  // Someone whose saved password is already longer than 72 bytes is not locked out.
  const old = 'an-older-password-that-goes-on-and-on-well-past-the-old-limit-of-seventy-two-bytes-ok';
  const jo = await person(M, 'Jo');
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(old, 4), jo.id]);
  ok(await login(M.slug, jo.email, old));
});

// ---------------------------------------------------------------- 8. HIPAA.md
test('8: HIPAA.md states the real session and storage facts', async () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'HIPAA.md'), 'utf8');
  for (const fact of [/localStorage/, /sessionStorage/, /30 minutes after (its|the) last tab closes/, /10 minutes/, /8 hours/, /60 minutes/, /15 minutes/, /quick resume/i, /fresh check/i, /records_checked_at|separate check/i]) assert.match(doc, fact);
  assert.ok(!/lives in the browser tab only/.test(doc), 'the old claim is gone');
});

// ---------------------------------------------------------------- 9. passkey origin
test('9: passkey answers are accepted only from PUBLIC_URL and the listed origins, never the Host header', async () => {
  const pk = require('../src/lib/passkeys');
  const req = { protocol: 'https', hostname: 'evil.runmyresort.com', get: (h) => (h === 'host' ? 'evil.runmyresort.com' : '') };
  const keep = { p: process.env.PUBLIC_URL, o: process.env.WEBAUTHN_ORIGINS };
  try {
    process.env.PUBLIC_URL = 'https://app.runmyresort.com/'; delete process.env.WEBAUTHN_ORIGINS;
    assert.deepEqual(pk.rp(req).origin, ['https://app.runmyresort.com']);
    process.env.WEBAUTHN_ORIGINS = 'https://www.runmyresort.com, https://app.runmyresort.com/';
    assert.deepEqual(pk.rp(req).origin.sort(), ['https://app.runmyresort.com', 'https://www.runmyresort.com']);
    assert.ok(!pk.rp(req).origin.includes('https://evil.runmyresort.com'));
    delete process.env.PUBLIC_URL; delete process.env.WEBAUTHN_ORIGINS;
    assert.deepEqual(pk.rp({ ...req, protocol: 'http', get: () => '127.0.0.1:1' }).origin, ['http://127.0.0.1:1'], 'local runs: the address itself');
  } finally {
    if (keep.p === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = keep.p;
    if (keep.o === undefined) delete process.env.WEBAUTHN_ORIGINS; else process.env.WEBAUTHN_ORIGINS = keep.o;
  }
});

// ---------------------------------------------------------------- 10. kiosk PINs
test('10: new kiosk PINs are 6 digits unless the mountain allows 4; existing 4-digit PINs still work; tablet changes are filed as tablets', async () => {
  const kim = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Kim', last_name: 'Clock' }, status: 'active' } })).id;
  const set = (pin) => api('PUT', `/kiosk-admin/people/${kim}/pin`, { token: M.owner, body: pin === undefined ? {} : { pin } });
  const r = await set('2468'); is(r, 400); assert.match(r.body.error, /6 digits/);
  assert.match(ok(await set()).pin, /^\d{6}$/, 'a random PIN is 6 digits');
  ok(await set('739164'));
  assert.equal(ok(await api('GET', '/kiosk-admin/overview', { token: M.owner })).settings.pin_four, false, 'off by default');
  ok(await api('PUT', '/kiosk-admin/settings', { token: M.owner, body: { photos: false, photo_days: 30, pin_four: true } }));
  ok(await set('2468'));
  ok(await api('PUT', '/kiosk-admin/settings', { token: M.owner, body: { photos: false, photo_days: 30, pin_four: false } }));
  // A tablet: the 4-digit PIN set while allowed still clocks in after the setting is off again.
  const dev = ok(await api('POST', '/kiosk-admin/devices', { token: M.owner, body: { name: 'Lodge tablet' } }));
  const { token } = ok(await api('POST', '/kiosk/pair', { body: { code: dev.code } }));
  ok(await api('POST', '/kiosk/identify', { body: { staff_id: kim, pin: '2468' }, headers: { 'x-kiosk-token': token } }));
  const [[a]] = await pool.query("SELECT entity FROM audit_log WHERE tenant_id = ? AND action = 'kiosk_device_added' ORDER BY id DESC LIMIT 1", [M.id]);
  assert.equal(a.entity, 'kiosk_devices');
});

// ---------------------------------------------------------------- the console's reset
test('the console resets a patrol director with a reason it keeps, and the person is emailed', async () => {
  const { operatorConsole } = require('./helpers/platform-operator');
  const op = await operatorConsole(base, process.env.PLATFORM_KEY || 'x');
  ok(await api('POST', '/auth/step-up', { token: M.owner, body: { password: PW } }));
  const dir = await person(M, 'Dora', 'patrol');
  ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: dir.staff, access_level: 'admin', level: 'director' } }));
  const open = await op('POST', `/tenants/${M.id}/access`, { reason: 'Director lost her phone, ticket 42', hours: 1 });
  assert.ok(open.status < 300, JSON.stringify(open.body));
  const listed = (await op('GET', `/tenants/${M.id}`)).body.users.map((u) => u.id);
  assert.ok(listed.includes(dir.id), 'patrol directors are listed for a console reset');
  const noReason = await op('POST', `/tenants/${M.id}/reset-password`, { user_id: dir.id, password: 'quartz-lantern-ridge-41', temporary: true });
  assert.equal(noReason.status, 400, 'a reason is required');
  mails.length = 0;
  const done = await op('POST', `/tenants/${M.id}/reset-password`, { user_id: dir.id, password: 'quartz-lantern-ridge-41', temporary: true, reason: 'Confirmed by phone call with Dora and the owner' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const [[h]] = await pool.query("SELECT detail FROM platform_audit WHERE tenant_id = ? AND action = 'password_reset' ORDER BY id DESC LIMIT 1", [M.id]);
  assert.match(String(h.detail), /Confirmed by phone call/);
  await settle();
  assert.ok(mailsTo(dir.email).some((m) => /support set a new password/.test(m.Subject)));
});
