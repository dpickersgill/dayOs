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
