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

// ---------------------------------------------------------------- 3. the release zip
test('the release zip leaves out the tests and packages, and deploy.sh and promote.sh need nothing from test/', () => {
  for (const f of ['deploy.sh', 'promote.sh', ...fs.readdirSync(nodePath.join(root, 'scripts')).map((s) => `scripts/${s}`)]) {
    assert.doesNotMatch(read(f).replace(/^\s*#.*$/gm, ''), /(^|[\s"'./])test\//m, `${f} uses something from test/`);
  }
  const stamp = nodePath.join(root, 'src', 'release', 'build.json');
  const made = !fs.existsSync(stamp);
  if (made) fs.writeFileSync(stamp, JSON.stringify({ version: require('../package.json').version, build: 'slimtest', built_at: new Date().toISOString() }));
  const out = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'slim-zip-'));
  try {
    const said = execFileSync('bash', ['scripts/zip-release.sh', '--no-stamp'], { cwd: root, env: { ...process.env, ZIP_OUT_DIR: out } }).toString();
    const zip = nodePath.join(out, `summitops-${require('../package.json').version}.zip`);
    assert.match(said, /Wrote .*summitops-.*\.zip: \d+ files, [\d.]+[KM]/);
    const names = execFileSync('unzip', ['-Z1', zip]).toString().split('\n').filter(Boolean);
    assert.deepEqual(names.filter((n) => n.startsWith('test/')), []);
    assert.deepEqual(names.filter((n) => PACKAGE.test(n)), []);
    for (const n of ['deploy.sh', 'promote.sh', 'Dockerfile', '.dockerignore', '.gcloudignore', 'package-lock.json', 'src/server.js', 'src/release/build.json', 'public/index.html']) assert.ok(names.includes(n), `${n} is in the zip`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    if (made) fs.rmSync(stamp);
  }
});

// ---------------------------------------------------------------- 4. scripts and styles cached by release
test('every script and stylesheet the app loads has a release address kept a year; the pages and the service worker are not kept', async () => {
  const { RELEASE } = require('../src/lib/appassets');
  const rel = `/r/${RELEASE}/`;
  const get = (p) => fetch(`${base}${p}`, { redirect: 'manual' });
  const local = (html) => [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)=["'](\/[^"']+)["']/g)].map((m) => m[1]).filter((u) => /\.(js|css)(\?|$)/.test(u));
  const pagesIn = fs.readdirSync(nodePath.join(root, 'public')).filter((f) => f.endsWith('.html'));
  // Each page by its own name and at the addresses the app and guests use.
  const addresses = [...pagesIn.map((f) => `/${f}`), '/', '/kiosk', '/book/some-mountain', '/shop/some-mountain', '/waiver/some-mountain', '/platform', '/try', '/lesson/x/y', '/help/x'];
  const seen = new Set();
  for (const a of addresses) {
    const r = await get(a);
    assert.equal(r.status, 200, a);
    assert.equal(r.headers.get('cache-control'), 'no-cache', `${a} is checked on every load`);
    const html = await r.text();
    for (const u of local(html)) { assert.ok(u.startsWith(rel), `${a} loads ${u} without the release address`); seen.add(u); }
  }
  assert.ok(seen.size >= 30, `only ${seen.size} scripts and styles found`);
  for (const u of seen) {
    const r = await get(u);
    assert.equal(r.status, 200, u);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable', u);
  }
  // A script loaded by another one stays under the same address: scripts use relative imports and paths only.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(nodePath.join(d, e.name)) : [nodePath.join(d, e.name)]));
  for (const f of walk(nodePath.join(root, 'public', 'js')).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /(from\s+|import\s*\(\s*)['"`]\//, `${f} imports by an absolute path`);
    assert.doesNotMatch(src, /['"`]\/(js|css|vendor)\//, `${f} loads a script or style by an absolute path`);
  }
  const lazy = await get(`${rel}js/views/dashboard.js`);
  assert.equal(lazy.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await get(`${rel}vendor/jsqr/jsQR.js`)).status, 200);
  // An address from another release gets today's file without the year-long promise; pages are never under /r/.
  const old = await get('/r/2020.1.1-old/js/main.js');
  assert.equal(old.status, 200); assert.equal(old.headers.get('cache-control'), 'no-cache');
  assert.equal((await get(`${rel}index.html`)).status, 404);
  for (const p of ['/sw.js', '/manifest.webmanifest', '/js/main.js']) assert.equal((await get(p)).headers.get('cache-control'), 'no-cache', p);
  assert.match((await get('/fonts/atkinson-hyperlegible-latin-700-normal.woff2')).headers.get('cache-control'), /immutable/);
});

// ---------------------------------------------------------------- 5. smaller files
test('the logos and the share picture are compressed, share.png is stored once, and the QR reader is the compact build', async () => {
  const size = (f) => fs.statSync(nodePath.join(root, f)).size;
  const brand = fs.readdirSync(nodePath.join(root, 'public', 'brand')).reduce((n, f) => n + size(`public/brand/${f}`), 0);
  assert.ok(brand < 120_000, `public/brand is ${brand} bytes (was 234,434)`);
  assert.ok(size('public/site/img/share.png') < 40_000);
  assert.ok(!fs.existsSync(nodePath.join(root, 'public', 'icons', 'share.png')), 'one share.png, in public/site/img');
  assert.ok(size('public/vendor/jsqr/jsQR.js') < 140_000);
});

test('the compact QR reader still reads a QR code', async () => {
  // A QR code made by the app's own generator, drawn into pixels, read back by the jsQR the kiosk loads.
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'slim-qr-'));
  try {
    fs.copyFileSync(nodePath.join(root, 'public', 'vendor', 'qrcode', 'qrcode.js'), nodePath.join(tmp, 'qrcode.mjs'));
    const qrcode = (await import(nodePath.join(tmp, 'qrcode.mjs'))).default;
    const text = 'KIOSK-PAIR-7Q2M-SLIM';
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    const n = qr.getModuleCount(); const scale = 6; const quiet = 4; const w = (n + quiet * 2) * scale;
    const px = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.floor(y / scale) - quiet; const c = Math.floor(x / scale) - quiet;
        if (r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c)) { const i = (y * w + x) * 4; px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; }
      }
    }
    const self = {};
    new Function('self', fs.readFileSync(nodePath.join(root, 'public', 'vendor', 'jsqr', 'jsQR.js'), 'utf8'))(self);
    assert.equal(typeof self.jsQR, 'function', 'the browser build sets window.jsQR, as kiosk.js expects');
    const out = self.jsQR(px, w, w, { inversionAttempts: 'dontInvert' });
    assert.ok(out, 'a code was found');
    assert.equal(out.data, text);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
