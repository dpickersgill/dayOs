'use strict';

// Fix release 2026.11.11, Track OPS, UI AND INFRA SCRIPTS: one regression test per finding (the proof turned around).
//   OPS-1 punches and shifts across daylight saving      OPS-3 a cut-off migration finishes; /readyz needs it finished
//   OPS-5 rentals overdue on the mountain's clock        OPS-6 promote.sh after a rollback; --lock moves every job
//   OPS-8 scans by time alone                           OPS-10 the level backfill keeps updated_at
//   CR-5 .ics bare CR                                   UI-4 extend within a year   UI-5 plain messages
//   UI-6 help closing time                              UI-7 long names   UI-8 dates that do not exist
//   INF-4 Google-signed job calls                       INF-12 the audit copy stays on in production
//   INF-1/2/7/8/9/13/14 the scripts, read and run with a stand-in gcloud (never the real one)
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.JOBS_KEY = 'f11-jobs-key-for-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, p, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
async function mountain(slug, timezone = 'America/New_York') {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, timezone, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return { slug, owner, id: Number(t.id) };
}

let A;
test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`f11o-${suffix}`);
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ---------------------------------------------------------------- OPS-1
test('OPS-1: a punch fix across the night clocks fall back is stored right and counts 9 hours; shifts too', async () => {
  const { utcFromLocal } = require('../src/lib/util');
  assert.equal(utcFromLocal('2025-11-02 06:00:00', 'America/New_York'), '2025-11-02 11:00:00', 'after the change: UTC-5');
  assert.equal(utcFromLocal('2025-11-01 22:00', 'America/New_York'), '2025-11-02 02:00:00', 'before the change: UTC-4');
  assert.equal(utcFromLocal('2026-03-08 03:30:00', 'America/Denver'), '2026-03-08 09:30:00', 'spring forward: MDT');
  const staff = Number((await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Nate', last_name: 'Night' }, status: 'active' } })).body.id);
  const add = await api('POST', '/workforce/time/entries', { token: A.owner, body: { staff_id: staff, clock_in: '2025-11-01T22:00', clock_out: '2025-11-02T06:00', note: 'Kiosk was down overnight' } });
  assert.equal(add.status, 201, add.text);
  const wk = (await api('GET', '/workforce/time/week?start=2025-10-27', { token: A.owner })).body.data.find((r) => r.staff_id === staff);
  assert.equal(wk.entries[0].minutes, 540);
  assert.ok(wk.entries[0].clock_out.endsWith('06:00:00'), wk.entries[0].clock_out);
  const SH = require('../src/lib/shifts');
  assert.equal(SH.minutesBetween('2025-11-01 22:00:00', '2025-11-02 06:00:00', 'America/New_York'), 540, 'a shift on the wall clock');
  assert.equal(SH.minutesBetween('2025-11-02 02:00:00', '2025-11-02 11:00:00'), 540, 'punches are UTC already');
});

// ---------------------------------------------------------------- OPS-3
test('OPS-3: a step cut off between statements is finished on the next run, and only recorded steps count as done', async () => {
  const { stepRunner } = require('../db/stepruns');
  const db = `${process.env.DB_NAME}_f11mig`.slice(0, 64);
  const admin = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', multipleStatements: true });
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\`; CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(`USE \`${db}\`; CREATE TABLE t (id INT PRIMARY KEY, a INT); INSERT INTO t VALUES (1, 10), (2, 20)`);
    const col = async (c) => (await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 't' AND column_name = 'b'"))[0].length > 0;
    const step = ['t.b', col, ['ALTER TABLE t ADD COLUMN b INT NULL', 'UPDATE t SET b = a * 2 WHERE b IS NULL']];
    // A run under this release, cut off right after the ALTER (its progress row says 0 of 2 done: the kill came first).
    let run = await stepRunner(admin);
    await admin.query("INSERT INTO schema_steps (name, statements_done) VALUES ('t.b', 0)");
    await admin.query(step[2][0]);
    run = await stepRunner(admin);
    assert.equal(await run(...step), true, 'the started step is picked up again');
    assert.deepEqual((await admin.query('SELECT b FROM t ORDER BY id'))[0].map((r) => r.b), [20, 40], 'the fill ran');
    const [[rec]] = await admin.query("SELECT statements_done, finished_at FROM schema_steps WHERE name = 't.b'");
    assert.equal(rec.statements_done, 2); assert.ok(rec.finished_at);
    assert.equal(await (await stepRunner(admin))(...step), false, 'a finished step is never run again');
    // An older database (no schema_steps rows) is backfilled from each step's own check: nothing runs again.
    await admin.query('DELETE FROM schema_steps');
    await admin.query('UPDATE t SET b = 99');
    run = await stepRunner(admin);
    assert.equal(run.firstRun, true);
    assert.equal(await run(...step), false);
    assert.deepEqual((await admin.query('SELECT DISTINCT b FROM t'))[0].map((r) => r.b), [99], 'the fill did not run again');
    // A uniqueness step put off because of duplicates is not recorded as done.
    let skipped = 0;
    run = await stepRunner(admin, () => skipped);
    assert.equal(await run('t.unique', async () => { skipped += 1; return true; }, 'ALTER TABLE t ADD UNIQUE KEY uq_a (a)'), false);
    assert.equal((await admin.query("SELECT 1 FROM schema_steps WHERE name = 't.unique'"))[0].length, 0);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
    await admin.end();
  }
});

test('OPS-3: the level backfill only fills rows not filled yet, and keeps each guest\'s updated_at (OPS-10)', () => {
  const steps = require('../db/steps/lessons2')({ tableExists: () => true, columnExists: () => true });
  const level = steps.find((s) => s[0] === 'lesson_sessions.level_min')[2];
  assert.match(level[1], /WHERE level_min IS NULL AND level_max IS NULL/);
  assert.match(level[2], /WHERE age_min IS NULL AND age_max IS NULL/);
  const people = steps.find((s) => s[0] === 'people.ski_level')[2][1];
  assert.match(people, /updated_at = updated_at/);
  assert.match(people, /ski_level IS NULL AND snowboard_level IS NULL AND level_source IS NULL/);
});

test('OPS-3: /readyz and the status page need this release\'s migration to have finished, not one column', async () => {
  const { migrated, atLeast } = require('../src/lib/schemaready');
  assert.equal(await migrated(pool), true, 'the test database was migrated to the end');
  assert.equal(await migrated(pool, '2999.1.1'), false, 'a later version is not migrated yet');
  assert.ok(atLeast('2026.11.11', '2026.11.10') && atLeast('2026.12.1', '2026.11.11') && !atLeast('2026.11.9', '2026.11.10'));
  const r = await fetch(`${base}/readyz`);
  assert.equal(r.status, 200);
  const [rows] = await pool.query("SELECT COUNT(*) AS n FROM schema_steps WHERE finished_at IS NULL AND name NOT LIKE 'release %'");
  assert.equal(Number(rows[0].n), 0, 'every step finished');
});

// ---------------------------------------------------------------- OPS-5
test('OPS-5: a rental due back in an hour is not overdue (report, weekly, list), one due an hour ago is', async () => {
  const { nowIn, todayIn } = require('../src/lib/util');
  for (const tz of ['America/Denver', 'America/Los_Angeles']) {
    const m = await mountain(`f11r-${tz.split('/')[1].toLowerCase().replace(/[^a-z]/g, '').slice(0, 6)}-${suffix}`, tz);
    const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Rhea', 'Renter')", [m.id]);
    const at = (h) => new Date(Date.parse(`${nowIn(tz).replace(' ', 'T')}Z`) + h * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
    await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, status, due_at, valid_on) VALUES (?, ?, 'out', ?, ?)", [m.id, p.insertId, at(1), todayIn(tz)]);
    let rep = (await api('GET', `/reports/daily?date=${todayIn(tz)}`, { token: m.owner })).body;
    assert.equal(Number(rep.rentals.overdue), 0, tz);
    assert.equal((await api('GET', '/rentals/contracts?overdue=true', { token: m.owner })).body.data.length, 0, tz);
    await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, status, due_at, valid_on) VALUES (?, ?, 'out', ?, ?)", [m.id, p.insertId, at(-1), todayIn(tz)]);
    rep = (await api('GET', `/reports/daily?date=${todayIn(tz)}`, { token: m.owner })).body;
    assert.equal(Number(rep.rentals.overdue), 1, tz);
    assert.equal((await api('GET', '/rentals/contracts?overdue=true', { token: m.owner })).body.data.length, 1, tz);
  }
  assert.doesNotMatch(read('src/lib/weekly.js'), /due_at < NOW\(\)/);
  assert.doesNotMatch(read('src/lib/messaging.js'), /due_at < NOW\(\)/);
});

// ---------------------------------------------------------------- OPS-8
test('OPS-8: scans have an index on time alone, so the 5-minute jobs do not read every scan', async () => {
  const [r] = await pool.query("SELECT column_name AS c FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'scans' AND index_name = 'ix_scans_at' ORDER BY seq_in_index");
  assert.deepEqual(r.map((x) => x.c || x.COLUMN_NAME), ['scanned_at']);
});

// ---------------------------------------------------------------- UI-4, UI-5, UI-7, UI-8
test('UI-7: Add staff member with a long name gets a plain 400, not a 500', async () => {
  const r = await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Alexandra-Catherine '.repeat(6).trim(), last_name: 'Smith' } } });
  assert.equal(r.status, 400, r.text);
  assert.match(r.body.error, /First name is too long \(at most 100 characters\)/);
  assert.match(read('public/js/views/workforce-staff.js'), /name: 'first', required: true, maxlength: 100/);
});

test('UI-8: dates that do not exist get a plain 400 everywhere, and calendar and shift years stay in 2000 to 2099', async () => {
  const a = await api('POST', '/calendar/events', { token: A.owner, body: { title: 'Board meeting', kind: 'meeting', starts_on: '2026-02-31' } });
  assert.equal(a.status, 400, a.text);
  const b = await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Ann', last_name: 'Lee' }, hired_on: '2026-13-01' } });
  assert.equal(b.status, 400, b.text);
  assert.match(b.body.error, /real date/);
  const c = await api('POST', '/calendar/events', { token: A.owner, body: { title: 'Typo', kind: 'meeting', starts_on: '1926-02-03' } });
  assert.equal(c.status, 400, c.text);
  const { dateStr, dateTimeStr, timeStr } = require('../src/lib/util');
  assert.equal(dateStr.safeParse('2024-02-29').success, true);
  assert.equal(dateStr.safeParse('2025-02-29').success, false);
  assert.equal(dateTimeStr.safeParse('2026-11-01T24:30').success, false);
  assert.equal(timeStr.safeParse('25:00').success, false);
});

test('UI-5: a validation error says which field in plain words, with the label the server knows', async () => {
  const r = await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: '', last_name: 'Lee' }, hired_on: '2026-02-30' } });
  assert.equal(r.status, 400);
  assert.doesNotMatch(r.text, /Invalid input|Too (big|small)|expected string|Validation failed/);
  const paths = r.body.details.map((d) => d.path);
  assert.ok(paths.includes('person.first_name') && paths.includes('hired_on'), r.text);
  assert.ok(r.body.details.every((d) => d.label && d.message.length > 5), r.text);
  const ui = read('public/js/ui.js');
  assert.match(ui, /if \(!form.checkValidity\(\)\) \{ form.reportValidity\(\); return; \}/, 'the browser checks run again');
  assert.match(ui, /errorBox\(err, labelFor\)/, 'the form maps server paths to its own labels');
});

test('UI-4: a rental cannot be extended past a year from now', async () => {
  const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Ext', 'End')", [A.id]);
  const { todayIn } = require('../src/lib/util');
  const [c] = await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, status, due_at, valid_on) VALUES (?, ?, 'out', ?, ?)", [A.id, p.insertId, `${todayIn('America/New_York')} 16:30:00`, todayIn('America/New_York')]);
  const far = await api('POST', `/rentals/contracts/${c.insertId}/extend`, { token: A.owner, body: { due_at: '2100-12-31T23:59' } });
  assert.equal(far.status, 400, far.text);
  const empty = await api('POST', `/rentals/contracts/${c.insertId}/extend`, { token: A.owner, body: { due_at: null } });
  assert.equal(empty.status, 400);
  assert.doesNotMatch(empty.text, /expected string, received null/);
  assert.match(read('public/js/views/rentals-returns.js'), /'Later than now, and within a year'/);
});

// ---------------------------------------------------------------- UI-1, UI-2, UI-3, UI-6 (read: the browser checks are the proof scripts)
test('UI-1/2/3/6: dialogs ask before discarding, keep focus, page behind inert; tables scroll in their box; help says 30 minutes', async () => {
  const ui = read('public/js/ui.js');
  assert.match(ui, /cancel.addEventListener\('click', dlg.requestClose\)/);
  assert.match(ui, /closeBtn.addEventListener\('click', requestClose\)/);
  assert.match(ui, /for \(const el of inerted\) el.inert = true;/);
  assert.match(read('public/js/main.js'), /dirtyDialogOpen\(\) && !window.confirm/);
  assert.match(read('public/css/app.css'), /\.table-wrap \{ position: relative; \}/);
  const { ARTICLES } = await import('../public/js/help-content.js');
  const pw = ARTICLES.find((a) => a.id === 'password');
  const text = [pw.intro, ...(pw.steps || []), ...(pw.tips || [])].join(' ');
  assert.doesNotMatch(text, /about 2 minutes after you close/);
  assert.match(text, /30 minutes after you close the last tab/);
  const r = await fetch(`${base}/status`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/site/status');
});

// ---------------------------------------------------------------- CR-5
test('CR-5: a bare CR (or any control character) in calendar text never reaches the .ics feed', async () => {
  const marker = `cr${suffix}`;
  const ev = await api('POST', '/calendar/events', { token: A.owner, body: { title: `Scouts ${marker}\rURL:https://x.example/${marker}\u000bEND`, kind: 'event', starts_on: new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10) } });
  assert.equal(ev.status, 201, ev.text);
  const feed = await api('POST', '/calendar/feed', { token: A.owner });
  const ics = await (await fetch(`${base}${new URL(feed.body.url).pathname}`)).text();
  const line = ics.split('\r\n').find((l) => l.includes(marker));
  assert.ok(line, ics.slice(0, 400));
  assert.doesNotMatch(line, /[\r\n\u000b]/);
  assert.ok(!ics.split(/\r\n|\r|\n/).some((l) => l.startsWith('URL:https://x.example')), 'no property of its own');
});

// ---------------------------------------------------------------- INF-4
test('INF-4: job calls signed by Google for the jobs account get in; the old key only until OIDC is set up', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const certs = http.createServer((_q, s) => { s.setHeader('content-type', 'application/json'); s.setHeader('cache-control', 'max-age=60'); s.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => certs.listen(0, r));
  const env = { JOBS_OIDC_EMAIL: process.env.JOBS_OIDC_EMAIL, JOBS_OIDC_AUDIENCES: process.env.JOBS_OIDC_AUDIENCES, JOBS_OIDC_CERTS_URL: process.env.JOBS_OIDC_CERTS_URL, JOBS_KEY_FALLBACK: process.env.JOBS_KEY_FALLBACK };
  const sa = 'summitops-jobs@summitops-510715.iam.gserviceaccount.com';
  const tok = (over = {}, key = privateKey, kid = 'k1') => jwt.sign({ iss: 'https://accounts.google.com', aud: 'https://svc.example', email: sa, email_verified: true, ...over }, key, { algorithm: 'RS256', keyid: kid, expiresIn: 300 });
  const call = (headers) => fetch(`${base}/api/v1/internal/jobs/lessons`, { method: 'POST', headers }).then((r) => r.status);
  try {
    require('../src/lib/jobauth')._reset();
    assert.notEqual(await call({ 'x-jobs-key': process.env.JOBS_KEY }), 401, 'before OIDC is set up the key still works');
    Object.assign(process.env, { JOBS_OIDC_EMAIL: sa, JOBS_OIDC_AUDIENCES: 'https://svc.example,https://app.example', JOBS_OIDC_CERTS_URL: `http://127.0.0.1:${certs.address().port}/certs` });
    delete process.env.JOBS_KEY_FALLBACK;
    assert.notEqual(await call({ authorization: `Bearer ${tok()}` }), 401, 'a good signed call gets in');
    assert.equal(await call({ authorization: `Bearer ${tok({ aud: 'https://other.example' })}` }), 401, 'another address');
    assert.equal(await call({ authorization: `Bearer ${tok({ email: 'someone@x.iam.gserviceaccount.com' })}` }), 401, 'another account');
    assert.equal(await call({ authorization: `Bearer ${tok({ iss: 'https://evil.example' })}` }), 401, 'not issued by Google');
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    assert.equal(await call({ authorization: `Bearer ${tok({}, other)}` }), 401, 'signed by another key');
    assert.equal(await call({ 'x-jobs-key': process.env.JOBS_KEY }), 401, 'the old key is refused once OIDC is set up');
    process.env.JOBS_KEY_FALLBACK = 'on';
    assert.notEqual(await call({ 'x-jobs-key': process.env.JOBS_KEY }), 401, 'unless the fallback is turned on');
  } finally {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    certs.close();
  }
});

// ---------------------------------------------------------------- INF-12
test('INF-12: the audit copy in the logs cannot be turned off in production', () => {
  const { trail } = require('../src/lib/audit');
  const write = process.stdout.write; const was = { off: process.env.AUDIT_LOG_STDOUT, env: process.env.NODE_ENV };
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  try {
    process.env.AUDIT_LOG_STDOUT = 'off'; process.env.NODE_ENV = 'production';
    trail({ action: 'f11_check' });
  } finally {
    process.stdout.write = write;
    if (was.off === undefined) delete process.env.AUDIT_LOG_STDOUT; else process.env.AUDIT_LOG_STDOUT = was.off;
    if (was.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = was.env;
  }
  assert.match(out, /f11_check/);
});

// ---------------------------------------------------------------- scripts, with a stand-in gcloud
function stubDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11ops-'));
  fs.writeFileSync(path.join(dir, 'gcloud'), `#!/usr/bin/env bash
echo "gcloud $*" >> "$STUB_LOG"
case "$*" in
  "auth print-access-token") echo token ;;
  "config get-value account"*) echo dan@example.com ;;
  "run services describe"*"--format=json"*) cat "$STUB_SVC" ;;
  "run services describe"*"latestReadyRevisionName"*) echo summitops-staging-00042-abc ;;
  "run revisions describe"*"imageDigest"*) echo us-east1-docker.pkg.dev/p/r/i@sha256:abc ;;
  "iam service-accounts describe"*) exit 0 ;;
  "secrets describe"*) exit 1 ;;
  "scheduler jobs list"*) cat "$STUB_JOBS" ;;
  "compute ssl-certificates describe"*) echo ACTIVE ;;
  "compute ssl-policies describe"*) exit 1 ;;
  "compute target-https-proxies describe"*) exit 1 ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'curl'), `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
case "$*" in *readyz*) echo "{\\"ok\\":true,\\"version\\":\\"$STUB_VERSION\\",\\"build\\":\\"$STUB_BUILD\\"}" ;; *version*) echo '{"version":"2026.11.9"}' ;; *healthz*) echo ok ;; esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'npm'), '#!/usr/bin/env bash\necho "npm $*" >> "$STUB_LOG"\n', { mode: 0o755 });
  const svc = { metadata: { annotations: {} }, spec: { traffic: [{ revisionName: 'summitops-api-00040-old', percent: 100 }], template: { spec: { containers: [{ env: [{ name: 'DB_NAME', value: 'x' }, { name: 'DB_USER', value: 'u' }, { name: 'PUBLIC_URL', value: 'https://app.example' }] }] } } },
    status: { url: 'https://summitops-api-xyz.a.run.app', latestReadyRevisionName: 'summitops-api-00041-dark', traffic: [{ revisionName: 'summitops-api-00040-old', percent: 100 }] } };
  fs.writeFileSync(path.join(dir, 'svc.json'), JSON.stringify(svc));
  fs.writeFileSync(path.join(dir, 'jobs.txt'), ['daily', 'guests', 'lessons', 'outreach'].map((j) => `projects/p/locations/us-east1/jobs/summitops-${j}\thttps://summitops-api-xyz.a.run.app/api/v1/internal/jobs/${j}`).join('\n')
    + '\nprojects/p/locations/us-east1/jobs/summitops-weekly-export\thttps://sqladmin.googleapis.com/v1/projects/p/instances/summitops-db/export\n');
  return dir;
}

test('OPS-6b and INF-13: cloud-armor.sh --lock moves every job that calls the app, and the HTTPS proxy gets a TLS 1.2 policy', () => {
  const dir = stubDir(); const log = path.join(dir, 'log');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, STUB_LOG: log, STUB_SVC: path.join(dir, 'svc.json'), STUB_JOBS: path.join(dir, 'jobs.txt') };
  execFileSync('bash', ['scripts/cloud-armor.sh', '--lock', 'www.example.com', 'app.example.com'], { cwd: root, env, stdio: 'pipe' });
  const calls = fs.readFileSync(log, 'utf8');
  for (const j of ['daily', 'guests', 'lessons', 'outreach']) assert.match(calls, new RegExp(`scheduler jobs update http summitops-${j} .*--uri https://app.example/api/v1/internal/jobs/${j}`));
  assert.doesNotMatch(calls, /jobs update http summitops-weekly-export/);
  fs.writeFileSync(log, '');
  execFileSync('bash', ['scripts/cloud-armor.sh', 'www.example.com', 'app.example.com'], { cwd: root, env, stdio: 'pipe' });
  const built = fs.readFileSync(log, 'utf8');
  assert.match(built, /ssl-policies create summitops-tls --profile MODERN --min-tls-version 1.2/);
  assert.match(built, /target-https-proxies create summitops-https .*--ssl-policy summitops-tls/);
  assert.match(built, /rules create 90 .*\/api\/v1\/auth\//);
});

test('OPS-6a: promote.sh sends traffic to the new revision after a rollback pinned it, and names the serving revision to go back to', () => {
  const dir = stubDir(); const log = path.join(dir, 'log');
  const version = require('../package.json').version;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, STUB_LOG: log, STUB_SVC: path.join(dir, 'svc.json'), STUB_JOBS: path.join(dir, 'jobs.txt'), STUB_VERSION: version, STUB_BUILD: (() => { try { return require('../src/release/build.json').build; } catch { return 'dev'; } })() };
  // The database steps need the real proxy and a database: stop the run at npm ci, after the checks, by reading what it would do.
  const promote = read('promote.sh');
  const deployAt = promote.indexOf('gcloud run deploy "$SERVICE" --image');
  const latestAt = promote.indexOf('gcloud run services update-traffic "$SERVICE" --to-latest');
  assert.ok(deployAt > 0 && latestAt > deployAt, 'update-traffic --to-latest right after the deploy');
  assert.match(promote, /--startup-probe=httpGet.path=\/readyz/);
  assert.match(promote, /select\(\(\.percent \/\/ 0\) > 0\)\] \| sort_by/, 'the revision serving now, not the newest');
  assert.match(promote, /will not be deployed as the default compute account/);
  assert.match(read('RECOVERY.md'), /update-traffic summitops-api --region us-east1 --to-latest/);
  assert.match(read('DEPLOY.md'), /update-traffic summitops-api --region us-east1 --to-latest/);
  const r = spawnSync('bash', ['promote.sh', '--yes'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.match(calls, /npm ci --omit=dev --ignore-scripts/, r.stdout + r.stderr);
});

test('INF-1/2/3/7/8/9/14: the scripts build as their own account, keep staging off live keys and data, and keep secrets off command lines', () => {
  for (const f of ['deploy.sh', 'promote.sh', 'move-to-cloudsql.sh', ...fs.readdirSync(path.join(root, 'scripts')).filter((s) => s.endsWith('.sh')).map((s) => `scripts/${s}`)]) execFileSync('bash', ['-n', path.join(root, f)]);
  const common = read('scripts/cloud-common.sh');
  assert.match(common, /BUILD_FLAG=\(--build-service-account "projects\/\$\{PROJECT\}\/serviceAccounts\/\$\{BUILD_SA\}"\)/);
  assert.match(read('deploy.sh'), /--service-account "\$STAGING_SA" "\$\{BUILD_FLAG\[@\]\}"/);
  assert.match(read('scripts/staging-setup.sh'), /"\$\{BUILD_FLAG\[@\]\}"/);
  const harden = read('scripts/harden.sh');
  assert.match(harden, /REMOVE_EDITOR=1/);
  assert.match(harden, /--keep-editor\) REMOVE_EDITOR=0/);
  assert.match(harden, /ANTHROPIC_API_KEY/);
  assert.match(harden, /clean_plain_revisions/);
  assert.doesNotMatch(harden, /add-iam-policy-binding "\$PROJECT" --member "serviceAccount:\$COMPUTE_SA" --role "\$role"/, 'no project-wide storage read for the default account');
  const staging = read('scripts/staging-setup.sh');
  assert.doesNotMatch(staging, /put_secret summitops-staging-postmark "\$PM_VALUE"/, 'the live Postmark token is never copied');
  assert.doesNotMatch(staging, /put_secret summitops-staging-assistant-api-key "\$\(secret_read summitops-assistant-api-key\)"/);
  assert.match(staging, /That is the live server's token/);
  assert.match(staging, /gcloud sql instances create "\$STG_INSTANCE"/);
  assert.match(staging, /title=staging-db-only/);
  assert.match(read('scripts/staging-db-user.js'), /WITH MAX_USER_CONNECTIONS/);
  assert.match(read('scripts/staging-db-user.js'), /GRANT \$\{PRIVS.join\(', '\)\} ON/);
  assert.doesNotMatch(read('scripts/staging-db-user.js'), /'EVENT'/);
  // Secrets: prompts and stdin, never argv
  assert.match(read('scripts/assistant-key.sh'), /read -r -s -p/);
  assert.match(read('scripts/stripe-connect.sh'), /read -r -s -p/);
  assert.doesNotMatch(read('scripts/stripe-connect.sh'), /--update-env-vars "STRIPE_CONNECT_WEBHOOK_SECRET=/);
  assert.match(read('scripts/db-runtime-user.js'), /never on the command line/);
  assert.doesNotMatch(read('RUNBOOK.md'), /PASTE_POSTMARK_TOKEN/);
  assert.doesNotMatch(staging, /curl -sS -u "\$STRIPE_KEY:"/);
  // Supply chain
  for (const f of ['deploy.sh', 'promote.sh', 'scripts/staging-setup.sh']) assert.match(read(f), /npm ci --omit=dev --ignore-scripts/, f);
  assert.match(read('Dockerfile'), /npm ci --omit=dev --ignore-scripts/);
  assert.match(common, /PROXY_SHA256=a38fe97690a27490e60a7945a8a178186ff9464abb81fe2bc652a3f773443387/);
  assert.match(read('deploy.sh'), /a reason of at least 20 characters/);
  assert.match(read('.dockerignore'), /^db\/reset\.js$/m);
  assert.match(read('.dockerignore'), /^db\/copy-db\.js$/m);
  // Keyless Gmail, signed jobs
  assert.doesNotMatch(read('scripts/outreach-setup.sh'), /keys create/);
  assert.match(read('scripts/outreach-setup.sh'), /keys delete/);
  for (const f of ['scripts/guests-job.sh', 'scripts/lessons-job.sh', 'scripts/outreach-setup.sh']) assert.doesNotMatch(read(f), /x-jobs-key=/, f);
});

test('INF-7: staging-db-user and db-runtime-user refuse a password on the command line', () => {
  for (const [script, args] of [['scripts/db-runtime-user.js', ['summitops_app', 'a-password-on-the-command-line-1234']], ['scripts/staging-db-user.js', ['summitops_stg', 'a-password-on-the-command-line-1234', 'summitops_staging']]]) {
    const r = spawnSync(process.execPath, [script, ...args], { cwd: root, env: process.env, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, /stdin|never the command line/, script);
  }
});

// ---------------------------------------------------------------- suspicions found real (2026.11.11)
test('Patrol case list pages past 500 with a total, so older cases can be reached', async () => {
  const vals = Array.from({ length: 503 }, (_, i) => [A.id, `2026-01-01 08:00:00`, 'Lift 1', 'injury', `Case ${i}`]);
  await pool.query('INSERT INTO incidents (tenant_id, occurred_at, location, category, summary) VALUES ?', [vals]);
  const first = await api('GET', '/patrol/incidents', { token: A.owner });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.data.length, 500); assert.equal(first.body.total, 503);
  const next = await api('GET', '/patrol/incidents?offset=500', { token: A.owner });
  assert.equal(next.body.data.length, 3); assert.equal(next.body.total, 503);
  assert.ok(!next.body.data.some((x) => first.body.data.some((y) => y.id === x.id)), 'no case on two pages');
  assert.match(read('public/js/views/patrol.js'), /Show more/);
  await pool.query('DELETE FROM incidents WHERE tenant_id = ?', [A.id]);
});

test('addDays keeps years under 100; a shift from 9:00 to 9:00 is refused, not 24 hours; local-time job windows', () => {
  const { addDays } = require('../src/lib/util');
  assert.equal(addDays('0050-01-01', 1), '0050-01-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.match(read('public/js/ui.js'), /setUTCFullYear\(y, m - 1, d \+ n\)/);
  for (const f of ['public/js/views/workforce-shift.js', 'public/js/views/patrol-schedule.js']) {
    const s = read(f);
    assert.ok(!/to\.value <= from\.value/.test(s), `${f}: the same time is not overnight`);
    assert.match(s, /to\.value === from\.value\) throw new Error\('The shift must end after it starts/);
  }
  assert.ok(!/starts_at >= NOW\(\)/.test(read('src/lib/workforce.js')), 'coachBusy uses the mountain\'s now');
  assert.match(read('src/lib/programplus.js'), /BETWEEN DATE_SUB\(NOW\(\), INTERVAL 1 DAY\)/);
  assert.match(read('public/js/views/calendar.js'), /Make a new link\?/);
  assert.match(read('public/js/views/calendar.js'), /realDay\(hashParam\('day'\)\)/);
  assert.match(read('public/js/views/lift-checks.js'), /Switch without saving\?/);
  assert.match(read('public/css/app.css'), /@media \(hover: none\) \{\n  \.cell-add/);
});

test('UI-1 follow-up: a form being saved is not "typed in", and a dialog taken off the page some other way lets go of the page', () => {
  const ui = read('public/js/ui.js');
  assert.match(ui, /dlg\.setDirty\(false\);\n\s*try \{\n\s*await submit/);
  assert.match(ui, /if \(!overlay\.isConnected\) \{ close\(\); return false; \}/);
  assert.ok(!/querySelectorAll\('\.overlay'\)\.forEach\(\(o\) => o\.remove\(\)\)/.test(read('public/js/views/school.js')));
});
