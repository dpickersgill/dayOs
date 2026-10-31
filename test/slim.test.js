'use strict';

// Release 2026.11.10, SLIM: a smaller repository, zip and server build, scripts and styles cached by release, and the
// buyer-review leftovers. Each test says what it proves.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

const root = nodePath.join(__dirname, '..');
const read = (f) => fs.readFileSync(nodePath.join(root, f), 'utf8');
const PACKAGE = /\.(whl|zip|tar\.gz|tgz)$/i;

let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

// ---------------------------------------------------------------- 1. no packages or archives
test('no package or archive file is in the repository, and none can reach the server build', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root }).toString().split('\n').filter(Boolean);
  assert.deepEqual(tracked.filter((f) => PACKAGE.test(f)), [], 'remove these with git rm');
  for (const f of ['.gitignore', '.dockerignore', '.gcloudignore']) {
    const lines = read(f).split('\n').map((l) => l.trim());
    for (const p of ['*.whl', '*.zip', '*.tar.gz', '*.tgz']) assert.ok(lines.includes(p), `${f} leaves out ${p}`);
  }
  for (const f of ['.dockerignore', '.gcloudignore']) assert.ok(read(f).split('\n').includes('test'), `${f} leaves out test/`);
});

// ---------------------------------------------------------------- 2. the OCR add-on, trimmed
/** The paths the Dockerfile deletes after npm ci, with any * expanded against node_modules. */
function dockerRemoved() {
  const df = read('Dockerfile').replace(/\\\n/g, ' ');
  const m = df.match(/rm -rf ([^&\n]+)/);
  assert.ok(m, 'the Dockerfile deletes the unused OCR parts');
  const out = [];
  for (const p of m[1].trim().split(/\s+/)) {
    if (!p.includes('*')) { out.push(nodePath.join(root, p)); continue; }
    const dir = nodePath.join(root, nodePath.dirname(p));
    const re = new RegExp(`^${nodePath.basename(p).replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
    for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push(nodePath.join(dir, f));
  }
  return out.map((p) => fs.realpathSync(nodePath.dirname(p)) + nodePath.sep + nodePath.basename(p));
}
/** A copy of node_modules made of links, without the removed paths (what the image holds). */
function farm(src, dst, removed) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = nodePath.join(src, name);
    if (removed.has(from)) continue;
    if ([...removed].some((r) => r.startsWith(from + nodePath.sep))) farm(from, nodePath.join(dst, name), removed);
    else fs.symlinkSync(from, nodePath.join(dst, name));
  }
}

test('the server build leaves out the unused OCR parts and still reads a scanned PDF', { timeout: 180_000 }, () => {
  const nm = fs.realpathSync(nodePath.join(root, 'node_modules'));
  const removed = dockerRemoved();
  assert.ok(removed.length >= 5);
  for (const p of removed) assert.ok(fs.existsSync(p), `${p} is installed, so deleting it means something`);
  // What src/lib/doctext.js really loads on a Debian server with Node 22 must stay.
  const needed = ['@napi-rs/canvas-linux-x64-gnu', '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.js',
    'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm', 'tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract.js-core/tesseract-core-lstm.wasm'];
  for (const n of needed) { const p = nodePath.join(nm, n); assert.ok(!removed.some((r) => p === r || p.startsWith(r + nodePath.sep)), `${n} stays`); }

  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'slim-ocr-'));
  try {
    farm(nm, nodePath.join(tmp, 'node_modules'), new Set(removed));
    fs.mkdirSync(nodePath.join(tmp, 'src', 'lib'), { recursive: true });
    fs.copyFileSync(nodePath.join(root, 'src', 'lib', 'doctext.js'), nodePath.join(tmp, 'src', 'lib', 'doctext.js'));
    const script = `require('./src/lib/doctext').extract(require('fs').readFileSync(${JSON.stringify(nodePath.join(__dirname, 'fixtures', 'scanned.pdf'))}), 'plan.pdf', { ocr: true })
      .then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.error(e.stack); process.exit(1); });`;
    fs.writeFileSync(nodePath.join(tmp, 'run.js'), script);
    // --preserve-symlinks: each package finds its own dependencies in the trimmed copy, not in the full node_modules.
    const env = { ...process.env, NODE_PATH: '' };
    const out = JSON.parse(execFileSync(process.execPath, ['--preserve-symlinks', 'run.js'], { cwd: tmp, env, timeout: 170_000 }).toString());
    assert.equal(out.method, 'ocr');
    assert.match(out.text.toLowerCase(), /muster/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
