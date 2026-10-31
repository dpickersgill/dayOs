'use strict';

// Release 2026.11.10, fixes after review. Each test names the item it guards:
//   1 text replies: only a message that is exactly one keyword changes consent; Twilio's OptOutType decides when sent
//   2 the platform key alone cannot reset or hand over access (it already could not read a mountain)
//   3 leaving the app for Stripe and coming back keeps the session; a real last-tab close still ends it (Playwright)
//   4 script and style addresses change whenever the files do, and only a stamped build is kept a year
//   5 text written in the console is put into website pages as written ("$'" and friends)
//   6 gate limits are per gate; guest pages per address and mountain; a guest cannot use up a gate's allowance
//   7 a slow database: counts give up after 250 ms and never pile up
//   8 scripts/backups-setup.sh: each setting on its own, log days only with point-in-time recovery (a stand-in gcloud)
//   9 a reload whose first request beats the closing notice; polls from a visible tab, and from a hidden one
//  10 the calendar link ends with a password change, a reset and "sign out everywhere else"; "strain" is not training
//  11 "Ends at" on Where you are signed in follows the closing rule
//  12 the Today page and the wall screen say Cannot open for a lift whose weekly inspection failed on an earlier day
//  13 the demo gives its lifts a type
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.PLATFORM_LOGIN_RATE_LIMIT = '1000';
process.env.TWILIO_AUTH_TOKEN = 'fix10-twilio-token';
process.env.STATUS_PROBES = 'off';
// Small limits so item 6 can reach them (read when the app is made).
process.env.DEVICE_RATE_LIMIT = '6';
process.env.DEVICE_MISS_LIMIT = '3';
process.env.PUBLIC_RATE_LIMIT = '5';

const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const http = require('http');
const { execFile } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const sessions = require('../src/lib/sessions');

const root = nodePath.join(__dirname, '..');
let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-device': 'fix10-device-0123456789abcdef', ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const login = async (slug, who, password = PW) => (await api('POST', '/auth/login', { body: { tenant: slug, login: who, password } })).body.token;
async function mountain(tag) {
  const slug = `${tag}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': KEY }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.clone().text());
  const id = (await res.json()).tenant_id;
  return { slug, id, owner: await login(slug, `owner@${slug}.test`) };
}
const sidOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sid;
const sessionRow = async (token) => (await pool.query('SELECT * FROM user_sessions WHERE id_hash = ?', [sessions.hash(sidOf(token))]))[0][0];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Two mountains for the whole file (adding mountains is limited to 5 a minute). M's owner keeps the password PW; a test
// that changes it puts it back. N's owner password is reset by test 2.
let M; let N;
const fresh = async () => { M.owner = await login(M.slug, `owner@${M.slug}.test`); return M; };

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M = await mountain('fm'); N = await mountain('fn');
});
test.after(async () => { server.close(); await pool.end(); });

// ---------------------------------------------------------------- 1. text replies
test('1: only a message that is exactly one keyword changes consent, and OptOutType decides when Twilio sends it', async () => {
  const { intentOf, signature } = require('../src/routes/twilioinbound');
  for (const b of ['STOP', 'stop', ' Stop. ', 'CANCEL', 'unsubscribe!', 'Quit']) assert.equal(intentOf({ Body: b }), 'stop', b);
  for (const b of ['START', 'yes', 'Unstop.']) assert.equal(intentOf({ Body: b }), 'start', b);
  for (const b of ['Cancel my lesson tomorrow please', 'Yes what time is the lesson?', 'stop it', 'STOP STOP', 'Stopping by later', 'yes!! see you', 'YESTERDAY', '']) assert.equal(intentOf({ Body: b }), null, b);
  assert.equal(intentOf({ Body: 'please stop texting me', OptOutType: 'STOP' }), 'stop', 'Twilio says it was an opt-out');
  assert.equal(intentOf({ Body: 'START', OptOutType: 'HELP' }), null, 'Twilio says it was HELP');
  assert.equal(intentOf({ Body: 'go', OptOutType: 'start' }), 'start');

  const { recordConsent, currentConsent } = require('../src/lib/consent');
  const A = M; const B = N;
  const phone = `610557${String(Date.now()).slice(-4)}`;
  const person = async (t) => (await pool.query('INSERT INTO people (tenant_id, first_name, last_name, phone) VALUES (?, ?, ?, ?)', [t, 'Text', 'Guest', `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`]))[0].insertId;
  const pA = await person(A.id); const pB = await person(B.id);
  await recordConsent(pool, A.id, pA, 'sms', 'opted_in', 'lesson_window', null);
  await recordConsent(pool, B.id, pB, 'sms', 'opted_in', 'lesson_window', null);
  const url = `${base}/api/v1/twilio/sms`;
  const send = async (m) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature(process.env.TWILIO_AUTH_TOKEN, url, m) }, body: new URLSearchParams(m) });
  const status = async () => [(await currentConsent(pool, A.id, pA)).sms.status, (await currentConsent(pool, B.id, pB)).sms.status];
  assert.equal((await send({ From: `+1${phone}`, Body: 'Cancel my lesson tomorrow please', MessageSid: 'SMf1' })).status, 200);
  assert.deepEqual(await status(), ['opted_in', 'opted_in'], 'an ordinary reply changes nothing');
  await send({ From: `+1${phone}`, Body: 'Stop.', MessageSid: 'SMf2' });
  assert.deepEqual(await status(), ['opted_out', 'opted_out'], 'the keyword alone opts out everywhere');
  await send({ From: `+1${phone}`, Body: 'Yes what time is the lesson?', MessageSid: 'SMf3' });
  assert.deepEqual(await status(), ['opted_out', 'opted_out'], 'a sentence starting with yes is not an opt-in');
  await send({ From: `+1${phone}`, Body: 'YES', MessageSid: 'SMf4' });
  assert.deepEqual(await status(), ['opted_in', 'opted_in'], 'the keyword alone undoes a text-reply opt-out');
});

// ---------------------------------------------------------------- 2. the platform key and access
test('2: the platform key alone cannot reset a login, clear two-step or hand an operator access', async () => {
  const { operatorConsole } = require('./helpers/platform-operator');
  const op = await operatorConsole(base, KEY); // there is now an operator with two-step
  const m = N;
  const plat = (method, path, body) => api(method, `/platform${path}`, { body, headers: { 'x-platform-key': KEY, 'x-operator': 'tester' } });
  const [[owner]] = await pool.query("SELECT id FROM users WHERE tenant_id = ? AND role = 'owner'", [m.id]);
  const refused = (r, why) => { assert.equal(r.status, 403, `${why}: ${JSON.stringify(r.body)}`); assert.equal(r.body.details.code, 'two_step_required', why); };
  refused(await plat('POST', `/tenants/${m.id}/reset-password`, { user_id: owner.id, password: 'a-new-password-nobody-knows-77', clear_two_step: true }), 'reset with clear_two_step');
  refused(await plat('POST', `/tenants/${m.id}/reset-password`, { user_id: owner.id, password: 'a-new-password-nobody-knows-77' }), 'reset');
  assert.ok(await login(m.slug, `owner@${m.slug}.test`), 'the owner\'s password is unchanged');
  refused(await plat('POST', '/operators', { email: `new-${suffix}@operators.test`, name: 'New', password: 'a-long-operator-password' }), 'adding an operator');
  const [[o]] = await pool.query("SELECT id FROM platform_operators WHERE active = 1 AND totp_enabled = 1 ORDER BY id DESC LIMIT 1");
  refused(await plat('POST', `/operators/${o.id}/password`, { password: 'brand-new-password-1' }), 'an operator\'s password');
  refused(await plat('POST', `/operators/${o.id}/reset-two-step`), 'an operator\'s two-step');
  // Switching an operator off stays open to the key (break-glass); switching one back on is handing access back.
  assert.equal((await plat('POST', `/operators/${o.id}/active`, { active: false })).status, 200);
  refused(await plat('POST', `/operators/${o.id}/active`, { active: true }), 'turning an operator back on');
  await pool.query('UPDATE platform_operators SET active = 1 WHERE id = ?', [o.id]);
  // A named operator (two-step) still can, once the mountain is opened with a reason.
  const op2 = await operatorConsole(base, KEY);
  assert.equal((await op2('POST', `/tenants/${m.id}/access`, { reason: 'Owner locked out, ticket 7', hours: 1 })).status, 201);
  assert.equal((await op2('POST', `/tenants/${m.id}/reset-password`, { user_id: owner.id, password: 'a-new-password-nobody-knows-77', clear_two_step: true })).status, 200);
  assert.ok(await login(m.slug, `owner@${m.slug}.test`, 'a-new-password-nobody-knows-77'));
  assert.ok(op);
});

// ---------------------------------------------------------------- 4. release addresses
test('4: a dirty build, a clean build and a copy with no stamp get different addresses; only a stamped build is kept a year', async () => {
  const express = require('express');
  const tmpRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'fix10-assets-'));
  const tree = (name, build, extra) => {
    const t = nodePath.join(tmpRoot, name);
    fs.mkdirSync(nodePath.join(t, 'src/lib'), { recursive: true }); fs.mkdirSync(nodePath.join(t, 'src/release'));
    fs.copyFileSync(nodePath.join(root, 'src/lib/appassets.js'), nodePath.join(t, 'src/lib/appassets.js'));
    fs.copyFileSync(nodePath.join(root, 'package.json'), nodePath.join(t, 'package.json'));
    if (build !== null) fs.writeFileSync(nodePath.join(t, 'src/release/build.json'), JSON.stringify({ version: '2026.11.10', build }));
    fs.mkdirSync(nodePath.join(t, 'public/js'), { recursive: true }); fs.mkdirSync(nodePath.join(t, 'public/css'));
    fs.writeFileSync(nodePath.join(t, 'public/index.html'), '<script type="module" src="/js/main.js"></script>');
    fs.writeFileSync(nodePath.join(t, 'public/js/main.js'), `console.log('hello'${extra ? `, ${JSON.stringify(extra)}` : ''});`);
    fs.writeFileSync(nodePath.join(t, 'public/css/app.css'), 'body { color: black; }');
    fs.symlinkSync(nodePath.join(root, 'node_modules'), nodePath.join(t, 'node_modules'));
    return require(nodePath.join(t, 'src/lib/appassets.js'));
  };
  try {
    const clean = tree('clean', '4857b6e');
    const dirty = tree('dirty', '4857b6e+', 'an uncommitted change');
    const dirtySame = tree('dirtysame', '4857b6e+');
    const none = tree('none', null);
    const noneEdited = tree('noneedited', null, 'edited');
    const dev = tree('dev', 'dev');
    assert.notEqual(clean.PREFIX, dirty.PREFIX, 'dirty and clean builds of one commit');
    assert.notEqual(clean.PREFIX, dirtySame.PREFIX, 'the "+" is kept even when the files happen to match');
    assert.notEqual(none.PREFIX, noneEdited.PREFIX, 'two copies with no stamp and different files');
    assert.equal(clean.STAMPED, true); assert.equal(dirty.STAMPED, true);
    assert.equal(none.STAMPED, false); assert.equal(dev.STAMPED, false);
    const headerOf = async (A, rel) => {
      const app = express(); app.use(A.releaseFiles);
      const s = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
      try { return (await fetch(`http://127.0.0.1:${s.address().port}${rel}/js/main.js`)).headers.get('cache-control'); } finally { s.close(); }
    };
    assert.equal(await headerOf(clean, clean.PREFIX), 'public, max-age=31536000, immutable', 'a stamped build is kept a year');
    assert.equal(await headerOf(none, none.PREFIX), 'no-cache', 'no stamp: never immutable');
    assert.equal(await headerOf(dev, dev.PREFIX), 'no-cache', 'a "dev" stamp is no stamp');
    assert.equal(await headerOf(clean, dirty.PREFIX), 'no-cache', 'another release\'s address is not promised');
    assert.match(clean.rewrite('<script type="module" src="/js/main.js"></script>'), new RegExp(`src="${clean.PREFIX.replace(/[.+]/g, '\\$&')}/js/main.js"`));
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 5. website fills
test('5: console text is put into the status page as written, and site.js fills pages only with function replacements', async () => {
  const note = "Refunds over $'100 are delayed; $& and $` and $$ stay too";
  const r = await api('POST', '/platform/status', { headers: { 'x-platform-key': KEY }, body: { kind: 'incident', title: 'F5 refunds $&', body: note, parts: ['payments'], impact: 'slow', starts_at: new Date(Date.now() - 60000).toISOString() } });
  assert.equal(r.status, 201, r.text);
  try {
    const html = await (await fetch(`${base}/site/status`)).text();
    assert.equal((html.match(/<footer class="sf">/g) || []).length, 1, 'one footer');
    assert.ok(html.includes("Refunds over $'100 are delayed; $&amp; and $` and $$ stay too"), 'the note as written');
    assert.ok(html.includes('F5 refunds $&amp;'), 'the title as written');
  } finally { await api('DELETE', `/platform/status/${r.body.id}`, { headers: { 'x-platform-key': KEY } }); }
  // Every fill of a page in site.js passes a function, never a string (a string reads "$'" as a pattern).
  const src = fs.readFileSync(nodePath.join(root, 'src/routes/site.js'), 'utf8');
  const fills = [...src.matchAll(/\.replace(?:All)?\(\s*('[^']*'|\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)\s*,\s*([^\n]{0,40})/g)];
  const bad = fills.filter((m) => /<!--|\{\{|<div/.test(m[1]) && !/^(\(|lit\(|\w+\s*=>|async|''\))/.test(m[2].trim()));
  assert.deepEqual(bad.map((m) => m[0]), [], 'page fills with a string replacement');
});

// ---------------------------------------------------------------- 6. rate limits per gate and per mountain
test('6: each gate has its own allowance, bad keys from the same address never stop a gate, guest pages count per mountain', async () => {
  const m = await fresh();
  const pair = async (name) => {
    const d = await api('POST', '/access/devices', { token: m.owner, body: { name } });
    assert.equal(d.status, 201, d.text);
    const p = await api('POST', '/device/pair', { body: { code: d.body.code } });
    assert.equal(p.status, 200, p.text);
    return p.body.token;
  };
  const gateA = await pair('Gate A'); const gateB = await pair('Gate B');
  const ping = (tok) => api('GET', '/device/ping', { headers: tok ? { authorization: `Device ${tok}` } : {} });
  for (let i = 0; i < 6; i += 1) assert.equal((await ping(gateA)).status, 200, `gate A ${i + 1}`);
  const over = await ping(gateA);
  assert.equal(over.status, 429, 'gate A used its own allowance'); assert.ok(Number(over.headers.get('retry-after')) > 0);
  assert.equal((await ping(gateB)).status, 200, 'gate B, at the same address, is not affected');
  // A guest on the same address sending no key or a made-up one: stopped after 3, and gate B carries on.
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await ping(i % 2 ? 'made-up-key-0123456789' : null)).status);
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  for (let i = 0; i < 4; i += 1) assert.equal((await ping(gateB)).status, 200, 'the guest did not use up the gate');
  // Guest pages: per address and mountain (PUBLIC_RATE_LIMIT is 5 here).
  const other = N;
  const pub = (slug) => api('GET', `/public/${slug}/help`);
  for (let i = 0; i < 5; i += 1) assert.notEqual((await pub(m.slug)).status, 429);
  assert.equal((await pub(m.slug)).status, 429, 'one mountain\'s pages, over the limit');
  assert.notEqual((await pub(other.slug)).status, 429, 'another mountain from the same address is not affected');
  const app = fs.readFileSync(nodePath.join(root, 'src/app.js'), 'utf8');
  assert.match(app, /PUBLIC_RATE_LIMIT\) \|\| 600/); assert.match(app, /PUBLIC_RATE_LIMIT_ALL\) \|\| 2400/);
});

// ---------------------------------------------------------------- 7. a slow database
test('7: a slow database: a count gives up after about 250 ms, and slow queries never pile up', async () => {
  const RS = require('../src/lib/ratestore');
  delete process.env.RATE_STORE_TIMEOUT_MS;
  let sent = 0; const release = [];
  const slowPool = { query: () => { sent += 1; return new Promise((r) => { release.push(() => r([{ insertId: 0 }])); }); } };
  const store = new RS.MysqlStore({ prefix: 'fix10-slow', pool: slowPool });
  store.init({ windowMs: 60_000 });
  const t0 = Date.now();
  const first = await store.increment('lodge');
  const took = Date.now() - t0;
  assert.ok(took >= 200 && took < 900, `gave up after ${took} ms`);
  assert.equal(first.totalHits, 1);
  // The first query is still running: 30 more hits on the key send nothing and are counted here, at once.
  const t1 = Date.now();
  const more = await Promise.all(Array.from({ length: 30 }, () => store.increment('lodge')));
  assert.ok(Date.now() - t1 < 150, 'answered from memory without waiting');
  assert.equal(sent, 1, 'one query for the key, not 31');
  assert.equal(Math.max(...more.map((x) => x.totalHits)), 31, 'every hit still counts');
  // Other keys: at most 10 queries in flight on this server at once.
  await Promise.all(Array.from({ length: 25 }, (_v, i) => store.increment(`addr-${i}`)));
  assert.ok(sent <= 10, `${sent} queries in flight`);
  assert.ok(RS.inFlight() <= 10);
  release.forEach((f) => f()); await wait(20);
  assert.equal(RS.inFlight(), 0, 'all finished');
  // Two hits at once on one server never both count as the first (the console's one-time codes rely on it).
  const fastPool = { query: async () => [{ insertId: 0 }] };
  const claims = new RS.MysqlStore({ prefix: 'fix10-claims', pool: fastPool });
  claims.init({ windowMs: 60_000 });
  const both = await Promise.all([claims.increment('step-1'), claims.increment('step-1')]);
  assert.deepEqual(both.map((x) => x.totalHits).sort(), [1, 2]);
});

// ---------------------------------------------------------------- 8. backups-setup.sh with a stand-in gcloud
test('8: backups-setup.sh changes each setting on its own, and sends log days only with point-in-time recovery', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'fix10-gcloud-'));
  try {
    // Like Cloud SQL, the stand-in refuses --retained-transaction-log-days unless binary logging is on or turned on with it.
    fs.writeFileSync(nodePath.join(dir, 'gcloud'), `#!/usr/bin/env bash
echo "gcloud $*" >> "$STUB_LOG"
case "$*" in
  "auth print-access-token") echo token ;;
  "run services describe"*"--format=json"*) echo '{"status":{"url":"https://x"},"spec":{"template":{"spec":{"containers":[{"env":[]}]}}}}' ;;
  "sql instances describe"*"--format=json"*) cat "$STUB_SQL" ;;
  "sql instances describe"*"serviceAccountEmailAddress"*) echo p1@gcp-sa-cloud-sql.iam.gserviceaccount.com ;;
  "sql instances patch"*) if [[ "$*" == *--retained-transaction-log-days* ]] && [[ "$*" != *--enable-bin-log* ]] && ! grep -q '"binaryLogEnabled":true' "$STUB_SQL"; then exit 1; fi ;;
  "storage buckets describe"*|"iam service-accounts describe"*|"scheduler jobs describe"*) exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
    const run = (settings, answer, args = []) => new Promise((resolve) => {
      const log = nodePath.join(dir, `log-${Math.random()}`); fs.writeFileSync(log, '');
      const sql = nodePath.join(dir, `sql-${Math.random()}.json`); fs.writeFileSync(sql, JSON.stringify({ settings }));
      const p = execFile('bash', ['scripts/backups-setup.sh', ...args], { cwd: root, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, STUB_SQL: sql } }, (err, stdout) => {
        resolve({ code: err ? err.code : 0, stdout, patches: fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('gcloud sql instances patch')) });
      });
      p.stdin.end(`${answer}\n`);
    });
    const off = { backupConfiguration: { enabled: true, binaryLogEnabled: false, startTime: '07:00', backupRetentionSettings: { retainedBackups: 7 } }, deletionProtectionEnabled: false, availabilityType: 'ZONAL' };
    // Declining the restart: backups and deletion protection still go on, and log days are not sent.
    const no = await run(off, 'no');
    assert.equal(no.code, 0, no.stdout);
    assert.ok(no.patches.some((p) => p.includes('--deletion-protection')), 'deletion protection');
    assert.ok(no.patches.some((p) => p.includes('--retained-backups-count=14')), 'backups kept');
    assert.ok(!no.patches.some((p) => p.includes('--retained-transaction-log-days') || p.includes('--enable-bin-log')), no.patches.join('\n'));
    assert.match(no.stdout, /Skipped point-in-time recovery/);
    // Saying yes: point-in-time recovery and its days in one step.
    const yes = await run(off, 'restart');
    assert.equal(yes.code, 0, yes.stdout);
    assert.ok(yes.patches.some((p) => p.includes('--enable-bin-log') && p.includes('--retained-transaction-log-days=7')));
    // Already on with too few days: only the days, and no question.
    const short = await run({ ...off, backupConfiguration: { ...off.backupConfiguration, binaryLogEnabled: true, transactionLogRetentionDays: 3 }, deletionProtectionEnabled: true }, '');
    assert.equal(short.code, 0, short.stdout);
    assert.deepEqual(short.patches.map((p) => p.replace(/^gcloud sql instances patch \S+ /, '')), ['--retained-backups-count=14 --quiet', '--retained-transaction-log-days=7 --quiet']);
    assert.doesNotMatch(short.stdout, /Type restart/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- 9 and 11. closing, the reload race, polls
test('9 and 11: a reload that speaks before the closing notice keeps the session; polls from a visible tab keep it, a hidden tab\'s do not; Ends at follows', async () => {
  const m = await fresh();
  const who = `owner@${m.slug}.test`;
  assert.equal(sessions.CLOSING_GRACE_SECONDS, 1800, 'long enough for a trip to Stripe');
  // The race: the new page's "back" arrives first, the old page's closing notice after it. The notice is ignored.
  const t = await login(m.slug, who);
  const oldPage = Date.now() - 5000; const newPage = Date.now();
  assert.equal((await api('POST', '/auth/back', { token: t, body: { page: newPage } })).status, 204);
  assert.equal((await api('POST', '/auth/closing', { token: t, headers: { 'x-poll': '1' }, body: { page: oldPage } })).status, 204);
  assert.equal((await sessionRow(t)).closing_at, null, 'an older page\'s closing notice just after a back notice is the reload race');
  // The page that said it was back closes at once: that is a real close.
  await api('POST', '/auth/closing', { token: t, headers: { 'x-poll': '1' }, body: { page: newPage } });
  assert.ok((await sessionRow(t)).closing_at, 'closed');
  // A notice that does not say which page: ignored only within seconds of a back notice.
  await api('POST', '/auth/back', { token: t, body: { page: newPage } });
  await api('POST', '/auth/closing', { token: t, headers: { 'x-poll': '1' } });
  assert.equal((await sessionRow(t)).closing_at, null);
  await pool.query('UPDATE user_sessions SET back_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id_hash = ?', [sessions.hash(sidOf(t))]);
  await api('POST', '/auth/closing', { token: t, headers: { 'x-poll': '1' } });
  assert.ok((await sessionRow(t)).closing_at, 'closed later');
  // Ends at: the closing rule, sooner than the idle limit (shown on Where you are signed in).
  const sec = (await api('GET', '/auth/security', { token: m.owner })).body;
  const mine = sec.sessions.find((s) => s.id === sessions.hash(sidOf(t)).slice(0, 16));
  assert.ok(mine && mine.closing, 'listed as closing');
  const [[sql]] = await pool.query('SELECT ends_at FROM (SELECT LEAST(s.expires_at, DATE_ADD(s.last_seen, INTERVAL 60 MINUTE), COALESCE(DATE_ADD(s.closing_at, INTERVAL 1800 SECOND), s.expires_at)) AS ends_at FROM user_sessions s WHERE id_hash = ?) x', [sessions.hash(sidOf(t))]);
  assert.equal(String(mine.ends_at).slice(0, 16).replace('T', ' '), String(sql.ends_at instanceof Date ? sql.ends_at.toISOString() : sql.ends_at).slice(0, 16).replace('T', ' '));
  const [[gap]] = await pool.query('SELECT TIMESTAMPDIFF(SECOND, closing_at, ?) AS s FROM user_sessions WHERE id_hash = ?', [sql.ends_at, sessions.hash(sidOf(t))]);
  assert.equal(Number(gap.s), 1800, 'ends 30 minutes after the close, sooner than the idle limit');
  // A hidden tab's poll does not clear it; a visible tab's poll does, without counting as use.
  const before = (await sessionRow(t)).last_seen;
  await pool.query('UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE id_hash = ?', [sessions.hash(sidOf(t))]);
  const seen5 = (await sessionRow(t)).last_seen;
  assert.equal((await api('GET', '/auth/me', { token: t, headers: { 'x-poll': '1' } })).status, 200);
  await wait(150);
  assert.ok((await sessionRow(t)).closing_at, 'a hidden tab\'s poll keeps nothing alive');
  assert.equal((await api('GET', '/auth/me', { token: t, headers: { 'x-poll': '1', 'x-visible': '1' } })).status, 200);
  await wait(150);
  const after = await sessionRow(t);
  assert.equal(after.closing_at, null, 'a tab on screen is still using it');
  assert.equal(String(after.last_seen), String(seen5), 'and it is still not use: the idle limit applies');
  assert.ok(before);
  // Any normal request after the notice also clears it (the reload's later requests).
  await pool.query('UPDATE user_sessions SET back_at = NULL WHERE id_hash = ?', [sessions.hash(sidOf(t))]);
  await api('POST', '/auth/closing', { token: t, headers: { 'x-poll': '1' } });
  await api('GET', '/auth/me', { token: t });
  await wait(150);
  assert.equal((await sessionRow(t)).closing_at, null);
  // Closed for good, past the grace: ended.
  await api('POST', '/auth/closing', { token: t, headers: { 'x-poll': '1' } });
  await pool.query('UPDATE user_sessions SET closing_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 MINUTE) WHERE id_hash = ?', [sessions.hash(sidOf(t))]);
  assert.equal((await api('GET', '/auth/me', { token: t, headers: { 'x-poll': '1', 'x-visible': '1' } })).status, 401);
});

// ---------------------------------------------------------------- 10. the calendar link and patrol training
test('10: the calendar link stops with a password change, a console reset and sign out everywhere else; "strain" is not training', async () => {
  const m = await fresh();
  const who = `owner@${m.slug}.test`;
  const feedOk = async (url) => (await fetch(url)).status === 200;
  const newLink = async (token) => { const r = await api('POST', '/calendar/feed', { token }); assert.equal(r.status, 201, r.text); return r.body.url.replace(/^https?:\/\/[^/]+/, base); };
  // Sign out everywhere else
  let t = await login(m.slug, who);
  let url = await newLink(t);
  assert.ok(await feedOk(url));
  assert.equal((await api('POST', '/auth/sessions/end-others', { token: t })).status, 200);
  assert.equal(await feedOk(url), false, 'sign out everywhere else');
  // Change password
  url = await newLink(t);
  const ch = await api('POST', '/auth/change-password', { token: t, body: { current_password: PW, new_password: 'another-strong-password-9' } });
  assert.equal(ch.status, 200, ch.text);
  assert.equal(await feedOk(url), false, 'a password change');
  t = ch.body.token;
  // A reset from the console
  url = await newLink(t);
  assert.ok(await feedOk(url));
  const op = await require('./helpers/platform-operator').operatorConsole(base, KEY);
  await op('POST', `/tenants/${m.id}/access`, { reason: 'Owner forgot password', hours: 1 });
  const [[owner]] = await pool.query("SELECT id FROM users WHERE tenant_id = ? AND role = 'owner'", [m.id]);
  assert.equal((await op('POST', `/tenants/${m.id}/reset-password`, { user_id: owner.id, password: PW })).status, 200);
  assert.equal(await feedOk(url), false, 'a password reset');

  // Patrol training: whole words only.
  t = await login(m.slug, who);
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const shift = (role, notes, h) => pool.query("INSERT INTO patrol_shifts (tenant_id, starts_at, ends_at, role_label, notes, status) VALUES (?, ?, ?, ?, ?, 'published')", [m.id, `${day} ${h}:00:00`, `${day} ${Number(h) + 2}:00:00`, role, notes]);
  await shift('Hill', 'Watch for a back strain on the lift line', '09');
  await shift('Constrained', null, '10');
  await shift('Hill', 'Train the new hires on toboggans', '11');
  await shift('OEC Training', null, '13');
  const cal = await api('GET', `/calendar?from=${day}&to=${day}&team=patrol`, { token: t });
  assert.equal(cal.status, 200, cal.text);
  const titles = cal.body.items.filter((i) => i.source === 'patrol').map((i) => i.title).sort();
  assert.deepEqual(titles, ['Patrol training: Hill', 'Patrol: OEC Training']);
  assert.equal(cal.body.items.find((i) => i.title === 'Patrol training: Hill').note, '1 patroller');
});

// ---------------------------------------------------------------- 12. Cannot open, on every screen
test('12: the Today page and wall screen say Cannot open for a lift whose weekly inspection failed on an earlier day', async () => {
  const m = await fresh();
  const lift = await api('POST', '/schedule/lifts', { token: m.owner, body: { name: 'Summit Quad', status: 'closed' } });
  assert.equal(lift.status, 201, lift.text);
  const ok = await api('POST', '/schedule/lifts', { token: m.owner, body: { name: 'Ridge Triple', status: 'closed' } });
  const lastWeek = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  await pool.query("INSERT INTO lift_checks (tenant_id, lift_id, check_date, kind, result, items) VALUES (?, ?, ?, 'periodic', 'fail', '[]'), (?, ?, ?, 'periodic', 'pass', '[]')", [m.id, lift.body.id, lastWeek, m.id, ok.body.id, lastWeek]);
  const layout = await api('PUT', '/board/layout', { token: m.owner, body: { tiles: ['morning', 'lifts'] } });
  assert.equal(layout.status, 200, layout.text);
  const board = (await api('GET', '/board', { token: m.owner })).body;
  const tile = board.data.lifts.lifts.find((l) => l.name === 'Summit Quad');
  assert.equal(tile.check, 'fail', 'the lifts tile (Today and the wall screen)');
  assert.equal(board.data.lifts.lifts.find((l) => l.name === 'Ridge Triple').check, null);
  const morning = board.data.morning.lifts.find((l) => l.name === 'Summit Quad');
  assert.equal(morning.check, 'fail'); assert.equal(morning.blocked, true);
  assert.match(morning.detail, new RegExp(`Failed its weekly inspection on ${lastWeek}`));
  // The open check (ops.openBlock) agrees, and so do the words every screen uses.
  const ops = require('../src/lib/ops');
  const today = board.today;
  assert.match(await ops.openBlock(pool, m.id, lift.body.id, today), /failed its weekly inspection/);
  assert.equal(await ops.openBlock(pool, m.id, ok.body.id, today), null);
  assert.equal(require('../src/lib/liftstatus').liftWord('closed', tile.check), 'Cannot open');
  const open = await api('PATCH', `/schedule/lifts/${lift.body.id}`, { token: m.owner, body: { status: 'open' } });
  assert.ok(open.status >= 400 && open.status < 500, 'and it cannot be opened');
  assert.match(open.body.error, /weekly inspection/);
});

// ---------------------------------------------------------------- 13. the demo's lifts have types
test('13: the demo gives each lift a lift type', () => {
  const demo = fs.readFileSync(nodePath.join(root, 'db/demo.js'), 'utf8');
  assert.match(demo, /\/ops\/lifts\/\$\{l\.id\}\/type/);
  // The name rules, run on the sample mountain's lifts (the function is copied out of demo.js, which runs when loaded).
  const fn = demo.match(/const OSM_TYPE = [^\n]+\nfunction liftTypeOf\(name\) \{[\s\S]*?\n\}/)[0];
  const liftTypeOf = new Function('AREA', `${fn}; return liftTypeOf;`)(null);
  const L = require('../src/lib/liftchecks');
  const want = { 'Summit Quad': 'fixed_grip', 'Ridge Triple': 'fixed_grip', 'Valley Double': 'fixed_grip', 'Magic Carpet': 'carpet', 'T-Bar': 'surface', 'Peak Express': 'detachable', 'Village Gondola': 'gondola_tram' };
  for (const [n, type] of Object.entries(want)) { assert.equal(liftTypeOf(n), type, n); assert.ok(L.TYPE_KEYS.includes(type)); }
  const real = new Function('AREA', `${fn}; return liftTypeOf;`)({ lifts: [{ name: 'Big Chair', kind: 'chair_lift' }, { name: 'Bunny Belt', kind: 'magic_carpet' }] });
  assert.equal(real('Bunny Belt'), 'carpet');
});

// ---------------------------------------------------------------- 3. leaving for Stripe and coming back (Playwright)
let chromium = null;
try { ({ chromium } = require('/usr/local/lib/node_modules_global/playwright')); } catch (_) { try { ({ chromium } = require('playwright')); } catch (__) { chromium = null; } }

test('3: a trip to Stripe and back keeps the session; a real close of the last tab still ends it', { skip: chromium ? false : 'Playwright is not installed here', timeout: 120_000 }, async () => {
  const m = await fresh();
  const stripe = http.createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end('<h1>Stand-in for Stripe</h1><a id="back" href="javascript:history.back()">Return</a>'); });
  await new Promise((r) => stripe.listen(0, '127.0.0.1', r));
  const stripeUrl = `http://127.0.0.1:${stripe.address().port}/onboarding`;
  const browser = await chromium.launch();
  const signIn = async (page, remember) => {
    await page.goto(`${base}/`);
    await page.fill('input[name=tenant]', m.slug); await page.fill('input[name=login]', `owner@${m.slug}.test`); await page.fill('input[name=password]', PW);
    if (remember) await page.check('input[name=remember]');
    await page.click('form[data-step=signin] button[type=submit]');
    await page.waitForSelector('#main .page-head', { timeout: 15000 });
    return page.evaluate(() => sessionStorage.getItem('so.token') || localStorage.getItem('so.token'));
  };
  try {
    for (const remember of [false, true]) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const token = await signIn(page, remember);
      // What billing.js does: leaveApp(url) sends the tab to Stripe. No closing notice.
      await page.evaluate(async (u) => { const T = await import('/js/tablock.js'); T.leaveApp(u); }, stripeUrl);
      await page.waitForURL(stripeUrl);
      await wait(800);
      assert.equal((await sessionRow(token)).closing_at, null, `remember=${remember}: leaving for Stripe is not closing`);
      // Even if a closing notice had been sent (a browser without the Navigation API), 31 minutes away is what it takes.
      await pool.query('UPDATE user_sessions SET closing_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 MINUTE) WHERE id_hash = ?', [sessions.hash(sidOf(token))]);
      // Stripe's return link (or Back): the app opens signed in and clears the mark.
      await page.click('#back');
      await page.waitForSelector('#main .page-head', { timeout: 15000 });
      await wait(500);
      assert.equal(await page.locator('form[data-step=signin]').count(), 0, 'still signed in');
      assert.equal((await sessionRow(token)).closing_at, null, 'back in the app: the closing mark is gone');
      assert.equal((await api('GET', '/auth/me', { token })).status, 200);
      // Typing another address in the same tab: the browser does not say why the page goes (it may keep it for Back, or a
      // closing notice goes), but coming back within the half hour keeps the session either way.
      await page.goto(stripeUrl);
      await wait(800);
      await pool.query('UPDATE user_sessions SET closing_at = COALESCE(closing_at, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 MINUTE)) WHERE id_hash = ?', [sessions.hash(sidOf(token))]);
      await page.goBack();
      await page.waitForSelector('#main .page-head', { timeout: 15000 });
      await wait(500);
      assert.equal((await sessionRow(token)).closing_at, null, 'and cleared on the way back');
      // A real close of the last tab: marked closing, and ended once the grace has passed.
      const keep = await ctx.newPage(); await keep.goto('about:blank');
      await page.close({ runBeforeUnload: true });
      await wait(800);
      assert.ok((await sessionRow(token)).closing_at, `remember=${remember}: a real close is still a close`);
      await pool.query('UPDATE user_sessions SET closing_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 MINUTE) WHERE id_hash = ?', [sessions.hash(sidOf(token))]);
      assert.equal((await api('GET', '/auth/me', { token })).status, 401);
      await ctx.close();
    }
  } finally { await browser.close(); stripe.close(); }
});
