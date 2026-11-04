'use strict';

// The go-live script fixes (Nov 2, 2026): what failed in Cloud Shell on deploy night, run here with a stand-in gcloud,
// curl and sleep on PATH (never the real gcloud). No database is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// A stand-in folder. `cases` are extra bash case arms for gcloud, tried before the defaults.
function stub({ cases = '', curl = '', svc } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-'));
  fs.writeFileSync(path.join(dir, 'gcloud'), `#!/usr/bin/env bash
echo "gcloud $*" >> "$STUB_LOG"
case "$*" in
${cases}
  "auth print-access-token") echo token-abc ;;
  "config get-value account"*) echo dan@example.com ;;
  "run services describe"*"--format=json"*) cat "$STUB_SVC" ;;
  "run services describe"*"status.url"*) echo https://summitops-api-xyz.a.run.app ;;
  "projects describe"*"projectNumber"*) echo 123456789 ;;
esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'curl'), `#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
for a in "$@"; do case "$a" in @/*) echo "header file $a: $(stat -c %a "\${a#@}" 2>/dev/null) $(cat "\${a#@}" 2>/dev/null | tr '\\n' ' ')" >> "$STUB_LOG" ;; esac; done
case "$*" in
${curl}
  *readyz*) echo '{"ok":true}' ;;
  *version*) echo '{"version":"2026.11.11"}' ;;
esac
# A body sent on stdin is kept so the test can read it.
case "$*" in *"@-"*) cat >> "$STUB_LOG.body"; echo >> "$STUB_LOG.body" ;; esac
exit 0
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const s = svc || { metadata: { annotations: {} }, spec: { template: { spec: { containers: [{ env: [] }] } } }, status: { url: 'https://summitops-api-xyz.a.run.app', latestReadyRevisionName: 'r2', traffic: [{ revisionName: 'r2', percent: 100 }] } };
  fs.writeFileSync(path.join(dir, 'svc.json'), JSON.stringify(s));
  const log = path.join(dir, 'log'); fs.writeFileSync(log, '');
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, STUB_LOG: log, STUB_SVC: path.join(dir, 'svc.json'), TMPDIR: dir };
  const run = (script, args = [], input = '') => {
    const r = spawnSync('bash', [script, ...args], { cwd: root, env, input, encoding: 'utf8', timeout: 30000 });
    return { ...r, out: r.stdout + r.stderr, calls: fs.readFileSync(log, 'utf8'), body: fs.existsSync(`${log}.body`) ? fs.readFileSync(`${log}.body`, 'utf8') : '' };
  };
  return { dir, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('1: the base image is pinned, and rotate-secrets.sh applies the values it changed', () => {
  assert.match(read('Dockerfile'), /^FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da$/m);
  const sh = read('scripts/rotate-secrets.sh');
  assert.doesNotMatch(sh, /\|\s*newval/, 'a pipe runs newval in a subshell and loses CHANGED');
  assert.match(sh, /newval "\$s" < <\(printf '%s' "\$V"\)/);
  assert.match(sh, /newval "\$s" < <\(rand 48\)/);
  const env = ['STRIPE_SECRET_KEY', 'BOOTSTRAP_KEY'].map((name) => ({ name, valueFrom: { secretKeyRef: { name: `summitops-${name.toLowerCase()}`, key: 'latest' } } }));
  const s = stub({ svc: { metadata: { annotations: {} }, spec: { template: { spec: { containers: [{ env }] } } }, status: { url: 'https://summitops-api-xyz.a.run.app', latestReadyRevisionName: 'r2', traffic: [{ revisionName: 'r2', percent: 100 }] } } });
  try {
    // A new Stripe key typed in and a new random bootstrap key (the keys not in Secret Manager are not asked).
    const r = s.run('scripts/rotate-secrets.sh', [], 'sk_live_new\nyes\n');
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /Nothing changed/);
    assert.match(r.calls, /secrets versions add summitops-stripe_secret_key --data-file=-/);
    assert.match(r.calls, /secrets versions add summitops-bootstrap_key --data-file=-/);
    assert.match(r.calls, /run services update summitops-api .*SECRETS_ROTATED_AT=/, 'the app reads the new values');
    assert.match(r.calls, /secrets versions list summitops-stripe_secret_key/);
  } finally { s.done(); }
});

test('2: staging-setup.sh loads the staging JWT_SECRET before staging-db-user.js loads the config', () => {
  const sh = read('scripts/staging-setup.sh');
  const jwtAt = sh.indexOf('export JWT_SECRET="$(secret_read summitops-staging-jwt)"');
  const userAt = sh.indexOf('node scripts/staging-db-user.js');
  assert.ok(jwtAt > 0 && userAt > jwtAt, 'JWT_SECRET is exported before the staging login is made');
  assert.ok(sh.indexOf('npm run migrate') > jwtAt);
  // Without it the config throws in production: the reason the step failed on deploy night.
  const r = spawnSync(process.execPath, ['-e', "require('./src/config')"], { cwd: root, env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'config refuses production without JWT_SECRET');
});

test('3: staging-setup.sh gives staging an https PUBLIC_URL, which production requires', () => {
  const sh = read('scripts/staging-setup.sh');
  assert.match(sh, /STG_PUBLIC="\$\(gcloud run services describe "\$STAGING_SERVICE" --region "\$REGION" --format='value\(status\.url\)'/);
  assert.match(sh, /STG_PUBLIC="https:\/\/\$\{STAGING_SERVICE\}-\$\{PROJECT_NUMBER\}\.\$\{REGION\}\.run\.app"/);
  assert.match(sh, /ENVS="\$ENVS\|PUBLIC_URL=\$STG_PUBLIC"/);
  assert.ok(sh.indexOf('PUBLIC_URL=$STG_PUBLIC') < sh.indexOf('gcloud run deploy "$STAGING_SERVICE"'), 'set before the deploy');
  // The address made for a first deploy, with the stand-in project number.
  const r = spawnSync('bash', ['-c', 'STAGING_SERVICE=summitops-staging PROJECT_NUMBER=123456789 REGION=us-east1; STG_PUBLIC=""; ' + sh.match(/^\[ -n "\$STG_PUBLIC" \] \|\| .*$/m)[0] + '; echo "$STG_PUBLIC"'], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'https://summitops-staging-123456789.us-east1.run.app');
});

test('4: jobs-oidc.sh signs every app job through the Cloud Scheduler API, with the token in a private header file', () => {
  const sh = read('scripts/jobs-oidc.sh');
  assert.doesNotMatch(sh.replace(/^\s*#.*$/gm, ''), /gcloud scheduler jobs update http/, 'gcloud\'s update crashes (TypeError NoneType)');
  const job = (j) => JSON.stringify({ name: `projects/summitops-510715/locations/us-east1/jobs/summitops-${j}`, httpTarget: { uri: `https://summitops-api-xyz.a.run.app/api/v1/internal/jobs/${j}`, httpMethod: 'POST', headers: { 'x-jobs-key': 'old-key', 'User-Agent': 'Google-Cloud-Scheduler', 'Content-Type': 'application/json' }, oauthToken: { serviceAccountEmail: 'x@y' } } });
  const s = stub({ cases: ['daily', 'guests', 'lessons', 'outreach'].map((j) => `  "scheduler jobs describe summitops-${j} "*"--format=json"*) echo '${job(j)}' ;;`).join('\n') + `
  "scheduler jobs list"*) for j in daily guests lessons outreach; do printf 'projects/p/locations/us-east1/jobs/summitops-%s\\thttps://summitops-api-xyz.a.run.app/api/v1/internal/jobs/%s\\n' $j $j; done
    printf 'projects/p/locations/us-east1/jobs/summitops-weekly-export\\thttps://sqladmin.googleapis.com/v1/projects/p/instances/db/export\\n' ;;` });
  try {
    const r = s.run('scripts/jobs-oidc.sh');
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.calls, /scheduler jobs update/);
    for (const j of ['daily', 'guests', 'lessons', 'outreach']) {
      assert.match(r.calls, new RegExp(`curl -sSf -X PATCH -H @\\S+ --data-binary @- https://cloudscheduler.googleapis.com/v1/projects/summitops-510715/locations/us-east1/jobs/summitops-${j}\\?updateMask=httpTarget`));
      assert.match(r.out, new RegExp(`summitops-${j} now signs its calls`));
    }
    assert.doesNotMatch(r.calls, /jobs\/summitops-weekly-export\?updateMask/, 'the database export job is not the app\'s');
    // The token is in a file only this account can read, never on a command line, and the file is gone after.
    assert.doesNotMatch(r.calls.split('\n').filter((l) => l.startsWith('curl')).join('\n'), /token-abc/);
    const files = [...r.calls.matchAll(/^header file @(\S+): (\d+) (.*)$/gm)];
    assert.ok(files.length >= 4);
    for (const [, f, mode, text] of files) { assert.equal(mode, '600'); assert.match(text, /Authorization: Bearer token-abc/); assert.ok(!fs.existsSync(f), 'removed after'); }
    const bodies = r.body.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(bodies.length, 4);
    for (const b of bodies) {
      assert.deepEqual(Object.keys(b), ['httpTarget']);
      assert.deepEqual(b.httpTarget.headers, { 'Content-Type': 'application/json' }, 'no x-jobs-key, no User-Agent');
      assert.equal(b.httpTarget.oauthToken, undefined);
      assert.deepEqual(b.httpTarget.oidcToken, { serviceAccountEmail: 'summitops-jobs@summitops-510715.iam.gserviceaccount.com', audience: 'https://summitops-api-xyz.a.run.app' });
    }
  } finally { s.done(); }
});

test('5: uptime-setup.sh confirms the phone through the Cloud Monitoring API, with or without "G-"', () => {
  const sh = read('scripts/uptime-setup.sh');
  assert.doesNotMatch(sh.replace(/^\s*#.*$/gm, ''), /channels (send-verification-code|verify)/, 'those gcloud commands no longer exist');
  const s = stub({ cases: `
  "alpha monitoring channels create"*"--type=sms"*) echo projects/summitops-510715/notificationChannels/111 ;;
  "alpha monitoring channels create"*) echo projects/summitops-510715/notificationChannels/222 ;;
  "alpha monitoring channels describe"*) echo UNVERIFIED ;;
  "monitoring uptime create"*) echo projects/summitops-510715/uptimeCheckConfigs/check-1 ;;` });
  try {
    for (const typed of ['G-123456', '123456']) {
      const r = s.run('scripts/uptime-setup.sh', ['+16105550123', 'dan@example.com'], `${typed}\n`);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /The phone is confirmed/);
      assert.match(r.calls, /curl -sSf -X POST -H @\S+ --data-binary @- https:\/\/monitoring.googleapis.com\/v3\/projects\/summitops-510715\/notificationChannels\/111:sendVerificationCode/);
      assert.match(r.calls, /curl -sSf -X POST -H @\S+ --data-binary @- https:\/\/monitoring.googleapis.com\/v3\/projects\/summitops-510715\/notificationChannels\/111:verify/);
      assert.doesNotMatch(r.calls.split('\n').filter((l) => l.startsWith('curl')).join('\n'), /token-abc/);
      for (const [, , mode] of r.calls.matchAll(/^header file @(\S+): (\d+)/gm)) assert.equal(mode, '600');
    }
    const bodies = s.run('/dev/null').body.trim().split('\n');
    assert.deepEqual(bodies, ['{}', '{"code":"G-123456"}', '{}', '{"code":"G-123456"}']);
    // Something that is not a code stops before asking Google.
    const bad = s.run('scripts/uptime-setup.sh', ['+16105550123', 'dan@example.com'], 'hello\n');
    assert.equal(bad.status, 1);
    assert.match(bad.out, /That is not the code Google texted/);
  } finally { s.done(); }
});

test('6: security-alerts.sh marks an alert whose metric is still new "not yet", and a second run finishes it', () => {
  const s = stub({ cases: `
  "alpha monitoring channels list"*) printf 'projects/summitops-510715/notificationChannels/111\\tVerdynt/OS: text Dan\\n' ;;
  "alpha monitoring policies list"*) [ -f "$STUB_LOG.second" ] && printf 'p1\\tVerdynt/OS security: Stripe webhook signature refused\\n' ;;
  "logging metrics describe"*) [ -f "$STUB_LOG.second" ] || exit 1 ;;
  "alpha monitoring policies create"*) if [ ! -f "$STUB_LOG.second" ] && grep -q 'summitops-signin-lockouts\\|summitops-exports' "\${5#--policy-from-file=}" 2>/dev/null; then echo "metric not found" >&2; exit 1; fi ;;
  "projects get-iam-policy"*) echo '{"bindings":[]}' ;;` });
  try {
    const first = s.run('scripts/security-alerts.sh');
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /  not yet: Verdynt\/OS security: Sign-in lockouts and too many attempts \(its metric is new; Google needs up to 10 minutes\)/);
    assert.match(first.out, /  not yet: Verdynt\/OS security: Data exports in bulk/);
    assert.match(first.out, /  made: Verdynt\/OS security: Server errors in a burst/);
    assert.match(first.out, /Run this again in 10 minutes to finish the 2 alert\(s\) marked 'not yet'\. It keeps what is done\./);
    assert.doesNotMatch(first.out, /^Done\./m);
    fs.writeFileSync(`${path.join(s.dir, 'log')}.second`, '');
    const second = s.run('scripts/security-alerts.sh');
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /  kept: Verdynt\/OS security: Stripe webhook signature refused/);
    assert.doesNotMatch(second.out, /not yet|Run this again/);
    assert.match(second.out, /^Done\./m);
  } finally { s.done(); }
});

test('7: security-alerts.sh turns on Cloud SQL audit logs under cloudsql.googleapis.com, the name Google accepts', () => {
  const s = stub({ cases: `
  "alpha monitoring channels list"*) printf 'projects/summitops-510715/notificationChannels/111\\tVerdynt/OS: text Dan\\n' ;;
  "projects get-iam-policy"*) echo '{"bindings":[],"auditConfigs":[{"service":"allServices","auditLogConfigs":[{"logType":"ADMIN_READ"}]}]}' ;;
  "projects set-iam-policy"*) cp "$4" "$STUB_LOG.policy" ;;` });
  try {
    const r = s.run('scripts/security-alerts.sh');
    assert.equal(r.status, 0, r.out);
    const policy = JSON.parse(fs.readFileSync(`${path.join(s.dir, 'log')}.policy`, 'utf8'));
    assert.deepEqual(policy.auditConfigs.map((c) => c.service), ['allServices', 'secretmanager.googleapis.com', 'cloudsql.googleapis.com']);
    assert.deepEqual(policy.auditConfigs[2].auditLogConfigs.map((c) => c.logType), ['ADMIN_READ', 'DATA_READ', 'DATA_WRITE']);
    assert.doesNotMatch(JSON.stringify(policy), /sqladmin/);
  } finally { s.done(); }
  // sqladmin stays where it is the API's address or the API to enable.
  assert.match(read('scripts/harden.sh'), /services enable .*sqladmin\.googleapis\.com/);
  assert.match(read('scripts/backups-setup.sh'), /https:\/\/sqladmin\.googleapis\.com\/v1\/projects/);
});

// backups-setup.sh with a server whose backup settings are all on, so only the weekly copy steps change anything.
function backupStub(failGrants) {
  const sql = JSON.stringify({ settings: { backupConfiguration: { enabled: true, binaryLogEnabled: true, transactionLogRetentionDays: 7, startTime: '07:00', backupRetentionSettings: { retainedBackups: 14 } }, deletionProtectionEnabled: true, availabilityType: 'ZONAL' } });
  const s = stub({ cases: `
  "sql instances describe"*"--format=json"*) echo '${sql}' ;;
  "sql instances describe"*"serviceAccountEmailAddress"*) echo p1@gcp-sa-cloud-sql.iam.gserviceaccount.com ;;
  "storage buckets describe"*) exit 0 ;;
  "iam service-accounts describe"*) exit 1 ;;
  "iam roles describe"*) exit 1 ;;
  "scheduler jobs describe"*) exit 0 ;;
  "projects add-iam-policy-binding"*) n=$(cat "$STUB_LOG.grants" 2>/dev/null || echo 0); echo $((n + 1)) > "$STUB_LOG.grants"
    if [ "$n" -lt "${failGrants}" ]; then echo "ERROR: Service account summitops-backup@x does not exist." >&2; exit 1; fi ;;` });
  fs.writeFileSync(path.join(s.dir, 'sleep'), '#!/usr/bin/env bash\necho "sleep $*" >> "$STUB_LOG"\n', { mode: 0o755 });
  return s;
}

test('8: backups-setup.sh tries the role grant again for a brand-new copy account, and replaces the weekly job', () => {
  const sh = read('scripts/backups-setup.sh');
  assert.doesNotMatch(sh.replace(/^\s*#.*$/gm, ''), /scheduler jobs update http/, 'gcloud\'s update crashes');
  // Google knows the new account on the third try: waits 5 and 10 seconds, then goes on.
  const s = backupStub(2);
  try {
    const r = s.run('scripts/backups-setup.sh');
    assert.equal(r.status, 0, r.out);
    const grants = r.calls.split('\n').filter((l) => /projects add-iam-policy-binding summitops-510715 --member=serviceAccount:summitops-backup@/.test(l));
    assert.equal(grants.length, 3, r.calls);
    assert.deepEqual(r.calls.split('\n').filter((l) => l.startsWith('sleep')), ['sleep 5', 'sleep 10']);
    // The job that is there is deleted, then made again (no update).
    const del = r.calls.indexOf('gcloud scheduler jobs delete summitops-weekly-export --location us-east1 --quiet');
    const make = r.calls.indexOf('gcloud scheduler jobs create http summitops-weekly-export');
    assert.ok(del > 0 && make > del, r.calls);
    assert.doesNotMatch(r.calls, /scheduler jobs update/);
  } finally { s.done(); }
  // Never known: 0, 5, 10, 20, 30 seconds, then it stops and says what to do.
  const never = backupStub(99);
  try {
    const r = never.run('scripts/backups-setup.sh');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Could not give the copy account its role\. Run this again in a minute\./);
    assert.deepEqual(r.calls.split('\n').filter((l) => l.startsWith('sleep')), ['sleep 5', 'sleep 10', 'sleep 20', 'sleep 30']);
    assert.doesNotMatch(r.calls, /scheduler jobs create/);
  } finally { never.done(); }
  // A dry run prints the grant once and changes nothing.
  const dry = backupStub(99);
  try {
    const r = dry.run('scripts/backups-setup.sh', ['--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.equal((r.out.match(/would run: gcloud projects add-iam-policy-binding \S+ --member=serviceAccount:summitops-backup@/g) || []).length, 1, r.out);
    assert.doesNotMatch(r.calls, /^gcloud projects add-iam-policy-binding/m);
    assert.match(r.out, /would run: gcloud scheduler jobs delete summitops-weekly-export/);
  } finally { dry.done(); }
});
