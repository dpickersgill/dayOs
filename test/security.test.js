'use strict';

// The security review's fixes: sessions the server can end (sign out, idle, password change), the login lockout, the
// breached-password check, two-step for owners and managers, the offline device key, upload content checks, what
// /version shows, push addresses, and closing a mountain (paused now, deleted by the daily job after its window).
const http = require('node:http');
const crypto = require('node:crypto');
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.LOGIN_LOCK_AFTER = '3';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { zipSync, strToU8 } = require('fflate');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const config = require('../src/config');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';
const BREACHED = 'breached-password-123';

// A stand-in for the Pwned Passwords range API that "knows" one password.
const seen = crypto.createHash('sha1').update(BREACHED).digest('hex').toUpperCase();
const ranges = [];
const pwned = http.createServer((req, res) => {
  ranges.push(req.url);
  res.end(req.url === `/range/${seen.slice(0, 5)}` ? `0000000000000000000000000000000000A:1\r\n${seen.slice(5)}:4242\r\n` : '0000000000000000000000000000000000A:3\r\n');
});

async function api(method, path, { token, body, headers = {} } = {}) {
  const raw = body instanceof Buffer;
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const login = (slug, email, password = PW) => api('POST', '/auth/login', { body: { tenant: slug, email, password } });
async function mountain(slug) {
  const t = await api('POST', '/tenants', { headers: { 'x-bootstrap-key': KEY }, body: { slug, name: slug, owner: { email: `o@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const [[row]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return { slug, id: row.id, token: (await login(slug, `o@${slug}.test`)).body.token };
}
let A;

test.before(async () => {
  await new Promise((r) => pwned.listen(0, '127.0.0.1', r));
  require('../src/lib/pwned').settings.apiBase = `http://127.0.0.1:${pwned.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`sec-${suffix}`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => pwned.close(r)); await pool.end(); });

test('signing out ends the session on the server, so a kept copy of the token stops working', async () => {
  const t = (await login(A.slug, `o@${A.slug}.test`)).body.token;
  assert.equal((await api('GET', '/auth/me', { token: t })).status, 200);
  assert.equal((await api('POST', '/auth/logout', { token: t })).status, 204);
  assert.equal((await api('GET', '/auth/me', { token: t })).status, 401);
  // A token signed with the right key but no session behind it is refused too.
  const forged = jwt.sign({ tid: A.id, role: 'owner' }, config.jwtSecret, { algorithm: 'HS256', subject: '1', expiresIn: '1h' });
  assert.equal((await api('GET', '/auth/me', { token: forged })).status, 401);
  const madeUp = jwt.sign({ tid: A.id, role: 'owner', sid: 'nope' }, config.jwtSecret, { algorithm: 'HS256', subject: '1', expiresIn: '1h' });
  assert.equal((await api('GET', '/auth/me', { token: madeUp })).status, 401);
});

test('a session left idle for an hour ends, and the server keeps only a hash of its id', async () => {
  const t = (await login(A.slug, `o@${A.slug}.test`)).body.token;
  const { sid } = jwt.decode(t);
  const hash = crypto.createHash('sha256').update(sid).digest('hex');
  const [[row]] = await pool.query('SELECT id_hash, ip_hash FROM user_sessions WHERE id_hash = ?', [hash]);
  assert.ok(row, 'kept by hash');
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM user_sessions WHERE id_hash = ?', [sid]))[0][0].n, 0, 'never the id itself');
  await pool.query('UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 61 MINUTE) WHERE id_hash = ?', [hash]);
  assert.equal((await api('GET', '/auth/me', { token: t })).status, 401);
});

test('changing a password signs out every other session and hands back a fresh token', async () => {
  const B = await mountain(`sec-b-${suffix}`);
  const other = (await login(B.slug, `o@${B.slug}.test`)).body.token;
  const r = await api('POST', '/auth/change-password', { token: B.token, body: { current_password: PW, new_password: 'a-new-long-password-77' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await api('GET', '/auth/me', { token: other })).status, 401, 'the other device is signed out');
  assert.equal((await api('GET', '/auth/me', { token: B.token })).status, 401, 'so is the old token');
  assert.equal((await api('GET', '/auth/me', { token: r.body.token })).status, 200, 'the fresh one works');
});

test('a login is locked for 15 minutes after repeated wrong passwords, even with the right one', async () => {
  const email = `lock@${A.slug}.test`;
  assert.equal((await api('POST', '/users', { token: A.token, body: { email, password: PW, role: 'staff' } })).status, 201);
  for (let i = 0; i < 3; i += 1) assert.equal((await login(A.slug, email, 'wrong-password-here')).status, 401, 'still the same answer');
  const locked = await login(A.slug, email);
  assert.equal(locked.status, 429, JSON.stringify(locked.body));
  assert.match(locked.body.error.message || JSON.stringify(locked.body), /minutes|locked/i);
  const [[u]] = await pool.query('SELECT id, login_failures, login_locked_until FROM users WHERE tenant_id = ? AND email = ?', [A.id, email]);
  assert.ok(u.login_locked_until);
  const [[a]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'login_locked' AND entity_id = ?", [A.id, u.id]);
  assert.equal(a.n, 1, 'the lock is in the audit log');
  // Once the lock has passed, the right password works and the count starts again.
  await pool.query('UPDATE users SET login_locked_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id = ?', [u.id]);
  assert.equal((await login(A.slug, email)).status, 200);
  assert.equal((await pool.query('SELECT login_failures FROM users WHERE id = ?', [u.id]))[0][0].login_failures, 0);
});

test('a password known from data breaches is refused, and only five characters of its hash leave the server', async () => {
  const before = process.env.PWNED_CHECK;
  delete process.env.PWNED_CHECK;
  try {
    const r = await api('POST', '/users', { token: A.token, body: { email: `pw@${A.slug}.test`, password: BREACHED, role: 'staff' } });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /data breaches/);
    assert.ok(ranges.every((u) => /^\/range\/[0-9A-F]{5}$/.test(u)), 'only the hash prefix is sent');
    assert.equal((await api('POST', '/users', { token: A.token, body: { email: `pw@${A.slug}.test`, password: 'not-in-any-breach-9', role: 'staff' } })).status, 201);
    // When the service cannot be reached, nobody is stopped from choosing a password.
    const P = require('../src/lib/pwned');
    const was = P.settings.apiBase; P.settings.apiBase = 'http://127.0.0.1:9';
    try { assert.equal(await P.timesSeen(BREACHED), null); } finally { P.settings.apiBase = was; }
  } finally { if (before === undefined) delete process.env.PWNED_CHECK; else process.env.PWNED_CHECK = before; }
});

test('owners and managers must set up two-step when the rule is on; crew roles are not forced', async () => {
  const C = await mountain(`sec-c-${suffix}`);
  assert.equal((await api('POST', '/users', { token: C.token, body: { email: `m@${C.slug}.test`, password: PW, role: 'manager' } })).status, 201);
  assert.equal((await api('POST', '/users', { token: C.token, body: { email: `s@${C.slug}.test`, password: PW, role: 'staff' } })).status, 201);
  const was = config.requireAdminMfa;
  config.requireAdminMfa = true;
  try {
    for (const who of ['o', 'm']) {
      const t = (await login(C.slug, `${who}@${C.slug}.test`)).body.token;
      const me = await api('GET', '/auth/me', { token: t });
      assert.equal(me.body.mfa_required, true); assert.equal(me.body.mfa_enrollment_required, true);
      const blocked = await api('GET', '/board', { token: t });
      assert.equal(blocked.status, 403, who);
      assert.match(JSON.stringify(blocked.body), /mfa_enrollment_required/);
      assert.equal((await api('POST', '/auth/logout', { token: t })).status, 204, 'signing out still works');
    }
    const staff = (await login(C.slug, `s@${C.slug}.test`)).body.token;
    assert.equal((await api('GET', '/auth/me', { token: staff })).body.mfa_required, false);
    assert.equal((await api('GET', '/board', { token: staff })).status, 200);
  } finally { config.requireAdminMfa = was; }
});

test('each person gets their own key for the offline patrol store, the same on every sign-in', async () => {
  const me1 = (await api('GET', '/auth/me', { token: A.token })).body;
  const again = (await login(A.slug, `o@${A.slug}.test`)).body.token;
  const me2 = (await api('GET', '/auth/me', { token: again })).body;
  assert.ok(me1.device_key && Buffer.from(me1.device_key, 'base64').length === 32);
  assert.equal(me1.device_key, me2.device_key);
  const staff = (await login(A.slug, `lock@${A.slug}.test`)).body.token;
  assert.notEqual((await api('GET', '/auth/me', { token: staff })).body.device_key, me1.device_key);
});

test('uploads must be what their name says: no programs, archives or Office files with macros', async () => {
  const cat = (await api('POST', '/documents/categories', { token: A.token, body: { name: `Sec ${suffix}` } })).body.id;
  const doc = (await api('POST', '/documents/documents', { token: A.token, body: { category_id: cat, title: 'Upload test' } })).body.id;
  const put = (name, buf) => api('PUT', `/documents/documents/${doc}/file`, { token: A.token, body: buf, headers: { 'x-filename': name } });
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
  assert.equal((await put('report.pdf', exe)).status, 400, 'a program named .pdf');
  assert.equal((await put('report.docx', exe)).status, 400, 'a program named .docx');
  assert.equal((await put('files.zip', Buffer.from(zipSync({ 'a.txt': strToU8('hi') })))).status, 400, 'archives are not accepted');
  const docx = (extra = {}) => Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document/>'), ...extra }));
  assert.equal((await put('macro.docx', docx({ 'word/vbaProject.bin': strToU8('macro') }))).status, 400, 'a macro inside is refused');
  assert.equal((await put('notdocx.docx', Buffer.from(zipSync({ 'xl/workbook.xml': strToU8('<x/>') })))).status, 400, 'a spreadsheet named .docx');
  assert.equal((await put('notes.txt', Buffer.from([0x68, 0x00, 0x69]))).status, 400, 'text with binary inside');
  assert.equal((await put('plan.docx', docx())).status, 201);
  assert.equal((await put('notes.txt', Buffer.from('Lift line notes\n'))).status, 201);
});

test('the build is shown only to someone signed in; health checks show no build details', async () => {
  const anon = await fetch(`${base}/version`).then((r) => r.json());
  assert.ok(anon.version && !('build' in anon) && !('built_at' in anon));
  const signed = await fetch(`${base}/version`, { headers: { authorization: `Bearer ${A.token}` } }).then((r) => r.json());
  assert.ok('build' in signed && 'built_at' in signed);
  const ready = await fetch(`${base}/readyz`).then((r) => r.json());
  assert.ok(!('build' in ready));
});

test('alerts are only sent to the known push services', () => {
  const { pushHostOk } = require('../src/lib/push');
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-bl2p.notify.windows.com/w/?token=x']) assert.equal(pushHostOk(ok), true, ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/computeMetadata', 'https://localhost/x', 'https://fcm.googleapis.com.evil.test/x', 'https://evil.test/notify.windows.com', 'not a url']) assert.equal(pushHostOk(bad), false, bad);
});

test('closing a mountain signs everyone out now and the daily job deletes it after the window', async () => {
  const D = await mountain(`sec-d-${suffix}`);
  const plat = (method, path, body) => api(method, `/platform${path}`, { headers: { 'x-platform-key': KEY }, body });
  assert.equal((await plat('POST', `/tenants/${D.id}/close`, { days: 30, confirm_slug: 'wrong' })).status, 400, 'the address must be typed');
  const closed = await plat('POST', `/tenants/${D.id}/close`, { days: 30, confirm_slug: D.slug });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.ok(closed.body.delete_after);
  assert.equal((await api('GET', '/auth/me', { token: D.token })).status, 401, 'signed out at once');
  assert.notEqual((await login(D.slug, `o@${D.slug}.test`)).status, 200, 'and cannot sign in');
  const listed = (await plat('GET', '/tenants')).body.data.find((t) => t.id === D.id);
  assert.ok(listed.delete_after && listed.status === 'suspended');

  // Reopening cancels it; closing again and letting the window pass deletes everything but the console's history.
  assert.equal((await plat('POST', `/tenants/${D.id}/reopen`)).status, 200);
  assert.equal((await pool.query('SELECT delete_after FROM tenants WHERE id = ?', [D.id]))[0][0].delete_after, null);
  assert.equal((await plat('POST', `/tenants/${D.id}/close`, { days: 7, confirm_slug: D.slug })).status, 200);
  const R = require('../src/lib/retention');
  await R.runAll();
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE id = ?', [D.id]))[0][0].n, 1, 'not before the window ends');
  await pool.query('UPDATE tenants SET delete_after = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?', [D.id]);
  const out = await R.runAll();
  assert.ok(out.mountains >= 1);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE id = ?', [D.id]))[0][0].n, 0);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?', [D.id]))[0][0].n, 0);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM user_sessions WHERE tenant_id = ?', [D.id]))[0][0].n, 0);
  assert.ok((await pool.query("SELECT COUNT(*) AS n FROM platform_audit WHERE tenant_id = ? AND action IN ('close', 'deleted_after_close')", [D.id]))[0][0].n >= 2);
  // An active mountain is never touched, even with a date set by mistake.
  await pool.query('UPDATE tenants SET delete_after = DATE_SUB(CURDATE(), INTERVAL 1 DAY) WHERE id = ?', [A.id]);
  await R.runAll();
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE id = ?', [A.id]))[0][0].n, 1);
  await pool.query('UPDATE tenants SET delete_after = NULL WHERE id = ?', [A.id]);
});

test('old website requests and long-finished sessions are cleared by the daily job', async () => {
  await pool.query("INSERT INTO site_leads (kind, name, mountain, email, created_at) VALUES ('question', 'Old', ?, 'old@x.test', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 YEAR))", [`Old ${suffix}`]);
  await pool.query("INSERT INTO site_leads (kind, name, mountain, email) VALUES ('question', 'New', ?, 'new@x.test')", [`New ${suffix}`]);
  await pool.query('INSERT INTO user_sessions (id_hash, tenant_id, user_id, created_at, last_seen, expires_at) VALUES (?, ?, 1, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 DAY), DATE_SUB(UTC_TIMESTAMP(), INTERVAL 59 DAY))', [crypto.randomBytes(32).toString('hex'), A.id]);
  const out = await require('../src/lib/retention').runAll();
  assert.ok(out.leads >= 1 && out.sessions >= 1);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM site_leads WHERE mountain = ?', [`Old ${suffix}`]))[0][0].n, 0);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM site_leads WHERE mountain = ?', [`New ${suffix}`]))[0][0].n, 1);
  await pool.query('DELETE FROM site_leads WHERE mountain = ?', [`New ${suffix}`]);
});
