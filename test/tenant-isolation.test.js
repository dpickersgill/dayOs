'use strict';

// Mountain A is filled with demo data. Mountain B is a separate customer with its own owner login.
// B then calls every signed-in endpoint using A's ids. Nothing of A's may come back, change or be created.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';

const fs = require('fs');
const nodePath = require('path');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

const root = nodePath.join(__dirname, '..');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
let server; let base; let A; let B;

async function call(method, path, token, body, headers = {}) {
  const raw = body instanceof Buffer;
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(raw ? { 'content-type': 'application/octet-stream', 'x-filename': 'x.txt' } : { 'content-type': 'application/json' }), ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' || method === 'DELETE' ? undefined : (raw ? body : JSON.stringify(body ?? {})),
  });
  return { status: res.status, text: await res.text() };
}
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const login = await call('POST', '/auth/login', null, { tenant: slug, email: `owner@${slug}.test`, password: PW });
  return { slug, token: JSON.parse(login.text).token };
}

// Which tables belong to a mountain, and which columns they hold.
let tables = [];
async function loadTables() {
  const [cols] = await pool.query(`SELECT table_name AS t, column_name AS c, data_type AS d FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`);
  const by = {};
  for (const r of cols) (by[r.t] ||= []).push({ c: r.c, d: r.d });
  tables = Object.entries(by).filter(([, cs]) => cs.some((x) => x.c === 'tenant_id')).map(([t, cs]) => ({ t, cols: cs }));
}
const idOf = async (slug) => (await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id;

// A fingerprint of everything mountain A owns. If it changes, something wrote to A.
async function fingerprint(tenantId) {
  const out = {};
  for (const { t, cols } of tables) {
    const parts = cols.map((x) => `COALESCE(\`${x.c}\`, '~')`).join(", '|', ");
    const [[r]] = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT(${parts}))), 0) AS h FROM \`${t}\` WHERE tenant_id = ?`, [tenantId]);
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}

// Every signed-in route, read from the route files. Routes with no login are skipped.
const MOUNTS = {
  'people.js': { router: '/people' }, 'customerplus.js': { router: '/people' }, 'crm.js': { router: '/crm' }, 'catalog.js': { products: '/products', pricing: '/pricing' },
  'sales.js': { router: '' }, 'checkout.js': { checkout: '/checkout', giftCards: '/gift-cards' }, 'rentals.js': { router: '/rentals' }, 'rentalsplus.js': { router: '/rentals' }, 'board.js': { router: '/board' }, 'messages.js': { router: '/messages' }, 'shop.js': { router: '/online-shop' }, 'shopadmin.js': { router: '/online-shop' },
  'schedule.js': { schedule: '/schedule' }, 'workforce.js': { router: '/workforce' }, 'kiosk.js': { adminRouter: '/kiosk-admin' },
  'skischool.js': { router: '/skischool' }, 'schoolplus.js': { router: '/skischool' }, 'patrol.js': { router: '/patrol' },
  'patrolplus.js': { router: '/patrol' }, 'team.js': { router: '/patrol' }, 'dispatch.js': { router: '/patrol' }, 'form.js': { router: '/patrol' },
  'map.js': { router: '/patrol' }, 'park.js': { router: '/park' }, 'ops.js': { router: '/ops' }, 'maintenance.js': { router: '/ops' },
  'documents.js': { router: '/documents' }, 'availability.js': { router: '/availability' }, 'programs.js': { router: '/programs' },
  'reports.js': { router: '/reports' }, 'finance.js': { router: '' },
};
function discover() {
  const found = []; const unknown = new Set();
  for (const [file, vars] of Object.entries(MOUNTS)) {
    const src = fs.readFileSync(nodePath.join(root, 'src/routes', file), 'utf8');
    const re = /^(\w+)\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/gm;
    let m;
    while ((m = re.exec(src))) {
      const prefix = vars[m[1]];
      if (m[1] === 'publicRouter') continue; // no login on these; they are keyed by the mountain's web address
      if (prefix === undefined) { unknown.add(`${file}:${m[1]}`); continue; }
      const paths = [...m[3].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
      for (const p of m[3].startsWith('[') ? paths : [m[3].slice(1, -1)]) found.push({ method: m[2].toUpperCase(), path: prefix + p, file });
    }
  }
  return { found, unknown };
}

async function pool8(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

const state = {};

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`ta-${suffix}`); B = await mountain(`tb-${suffix}`);
  A.id = await idOf(A.slug); B.id = await idOf(B.slug);
  await promisify(execFile)('node', ['db/demo.js', A.slug], { cwd: root, env: { ...process.env }, timeout: 240000, maxBuffer: 1 << 26 });
  // The demo has no documents yet, so A gets a category with a document and an uploaded file.
  const cat = JSON.parse((await call('POST', '/documents/categories', A.token, { name: 'Isolation test files' })).text).id;
  const doc = JSON.parse((await call('POST', '/documents/documents', A.token, { category_id: cat, title: 'Evacuation plan for Lodge' })).text).id;
  const up = await call('PUT', `/documents/documents/${doc}/file`, A.token, Buffer.from('muster point is the flagpole'));
  assert.equal(up.status, 201, up.text);
  await call('PUT', `/documents/documents/${doc}/file`, A.token, Buffer.from('muster point moved to the lodge deck'));
  await loadTables();

  // Ids to try: a few real ones from every one of A's tables, minus any id that B legitimately owns in any table.
  const mine = new Set(); const theirs = new Set();
  for (const { t, cols } of tables) {
    if (!cols.some((x) => x.c === 'id')) continue;
    const [a] = await pool.query(`SELECT id FROM \`${t}\` WHERE tenant_id = ? ORDER BY id`, [A.id]);
    if (a.length) { mine.add(a[0].id); mine.add(a[a.length - 1].id); if (a.length > 2) mine.add(a[Math.floor(a.length / 2)].id); }
    const [b] = await pool.query(`SELECT id FROM \`${t}\` WHERE tenant_id = ?`, [B.id]);
    for (const r of b) theirs.add(r.id);
  }
  state.ids = [...mine].filter((x) => !theirs.has(x));

  // Words that only mountain A's data would contain: emails, names, titles, places. Words that are also in the app's own code are dropped.
  const code = ['src', 'public'].map((d) => { try { return execFileSync('cat', ['-s', ...fs.readdirSync(nodePath.join(root, d), { recursive: true }).filter((f) => /\.(js|html)$/.test(f)).map((f) => nodePath.join(root, d, f))], { maxBuffer: 1 << 28 }).toString(); } catch (_) { return ''; } }).join('\n').toLowerCase();
  const wanted = /^(email|name|title|summary|description|location|first_name|last_name|callsign|label|plate|code|note|notes|display_name|bio|company)$/;
  const words = new Set();
  for (const { t, cols } of tables) {
    for (const x of cols.filter((c) => wanted.test(c.c) && /char|text/.test(c.d))) {
      const [r] = await pool.query(`SELECT DISTINCT \`${x.c}\` AS v FROM \`${t}\` WHERE tenant_id = ? AND \`${x.c}\` IS NOT NULL LIMIT 400`, [A.id]);
      for (const { v } of r) if (typeof v === 'string' && v.length >= 7 && v.length <= 120 && !code.includes(v.toLowerCase())) words.add(v);
    }
  }
  state.words = [...words];
  state.routes = discover();
  state.before = await fingerprint(A.id);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const fill = (path, id) => path.replace(/:(\w+)/g, (_m, k) => (/^v$|version/i.test(k) ? '1' : String(id)));
const leaks = (text) => state.words.find((w) => text.includes(w));

test('the sweep covers the routes and has material to test with', () => {
  assert.deepEqual([...state.routes.unknown], [], 'a route file uses a router name this test does not know');
  assert.ok(state.routes.found.length > 300, `only ${state.routes.found.length} routes found`);
  assert.ok(state.ids.length > 40, `only ${state.ids.length} of A's ids to try`);
  assert.ok(state.words.length > 100, `only ${state.words.length} words to look for`);
});

test('B cannot read anything of A: not lists, not single records, not by id', async () => {
  const bad = [];
  const gets = state.routes.found.filter((r) => r.method === 'GET');
  const jobs = [];
  for (const r of gets) {
    if (!r.path.includes(':')) jobs.push({ r, url: r.path });
    else for (const id of state.ids) jobs.push({ r, url: fill(r.path, id) });
  }
  await pool8(jobs, async ({ r, url }) => {
    const res = await call('GET', url, B.token);
    if (res.status === 401) { bad.push(`${url} -> 401 (B's login stopped working)`); return; }
    const w = res.status < 300 && leaks(res.text);
    if (w) bad.push(`${url} -> ${res.status} shows "${w}" (${r.file})`);
  });
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} leaks`);
  assert.deepEqual(await fingerprint(A.id), state.before, 'a read by B changed A\'s data');
});

test('B cannot change or delete anything of A by id', async () => {
  const bad = [];
  const jobs = [];
  // B's reads in the test before this one can create B's own starter rows (default ski school skills, say), and an
  // id is only unique within its table: drop any id B owns by now, so a 200 always means one of A's rows was hit.
  const theirs = new Set();
  for (const { t, cols } of tables) {
    if (!cols.some((x) => x.c === 'id')) continue;
    const [b] = await pool.query(`SELECT id FROM \`${t}\` WHERE tenant_id = ?`, [B.id]);
    for (const r of b) theirs.add(r.id);
  }
  const ids = state.ids.filter((x) => !theirs.has(x));
  for (const r of state.routes.found.filter((x) => x.method !== 'GET' && x.path.includes(':'))) {
    for (const id of ids) jobs.push({ r, url: fill(r.path, id) });
  }
  await pool8(jobs, async ({ r, url }) => {
    const res = await call(r.method, url, B.token, {});
    if (res.status === 401) { bad.push(`${r.method} ${url} -> 401 (B's login stopped working)`); return; }
    if (res.status < 300) bad.push(`${r.method} ${url} -> ${res.status} (${r.file})`);
  });
  // These four answer 200 but match nothing of B's (each query is scoped to B), so A is untouched.
  const harmless = /^(DELETE \/people\/N\/photo|DELETE \/people\/N\/family\/N|DELETE \/kiosk-admin\/people\/N\/pin|POST \/kiosk-admin\/people\/N\/unlock) /;
  const real = bad.filter((x) => !harmless.test(x.replace(/\/\d+/g, '/N')));
  assert.deepEqual(real.slice(0, 20), [], `${real.length} writes were accepted`);
  const after = await fingerprint(A.id);
  const diff = Object.keys(after).filter((k) => after[k] !== state.before[k]);
  assert.deepEqual(diff, [], 'A\'s data changed in these tables');
});

test('B cannot tie its records to A\'s: a foreign id in the body is refused', async () => {
  const one = async (t, where = '1=1') => (await pool.query(`SELECT id FROM \`${t}\` WHERE tenant_id = ? AND ${where} ORDER BY id LIMIT 1`, [A.id]))[0][0]?.id;
  const ids = { category: await one('doc_categories'), asset: await one('ops_assets'), lift: await one('lifts'), trail: await one('trails'), staff: await one('staff'), person: await one('people'), product: await one('products') };
  for (const [k, v] of Object.entries(ids)) assert.ok(v, `no demo ${k}`);
  const before = await fingerprint(A.id);
  const tryIt = async (what, method, path, body) => {
    const r = await call(method, path, B.token, body);
    assert.ok(r.status >= 400 && r.status < 500, `${what}: ${method} ${path} -> ${r.status} ${r.text.slice(0, 120)}`);
  };
  await tryIt('document into A\'s category', 'POST', '/documents/documents', { title: 'Sneaky', category_id: ids.category });
  await tryIt('work order on A\'s asset', 'POST', '/ops/work-orders', { title: 'Sneaky', asset_id: ids.asset });
  await tryIt('work order on A\'s lift', 'POST', '/ops/work-orders', { title: 'Sneaky', lift_id: ids.lift });
  await tryIt('groom plan on A\'s trail', 'POST', '/ops/groom/plan', { plan_date: '2030-01-01', shift: 'night', trail_id: ids.trail, asset_id: ids.asset });
  await tryIt('order for A\'s guest and product', 'POST', '/orders', { person_id: ids.person, items: [{ product_id: ids.product }] });
  await tryIt('time off for A\'s staff', 'POST', '/workforce/time-off', { staff_id: ids.staff, start_date: '2030-01-01', end_date: '2030-01-02' });
  assert.deepEqual(await fingerprint(A.id), before, 'A\'s data changed');
  // Nothing of B's may point at A's rows either.
  const [[x]] = await pool.query('SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND category_id IN (SELECT id FROM doc_categories WHERE tenant_id <> ?)', [B.id, B.id]);
  assert.equal(x.n, 0);
});

test('A file or search from B never reaches A\'s documents', async () => {
  const [[d]] = await pool.query('SELECT id FROM documents WHERE tenant_id = ? AND file_name IS NOT NULL ORDER BY id LIMIT 1', [A.id]);
  if (!d) return; // the demo may hold no uploaded files
  for (const p of [`/documents/documents/${d.id}/file`, `/documents/documents/${d.id}/versions`, `/documents/documents/${d.id}/versions/1/file`]) assert.equal((await call('GET', p, B.token)).status, 404, p);
  for (const p of [`/documents/documents/${d.id}/scan`, `/documents/documents/${d.id}/versions/1/restore`]) assert.equal((await call('POST', p, B.token, {})).status, 404, p);
  assert.equal((await call('PUT', `/documents/documents/${d.id}/file`, B.token, Buffer.from('hello'))).status, 404);
});

// Last, because A's own signed-in reads may write to A (audit and last-seen rows) and would blur the before/after comparison above.
test('control: A\'s own owner sees A\'s data, so the leak check can actually catch something', async () => {
  let seen = 0;
  const gets = state.routes.found.filter((r) => r.method === 'GET' && !r.path.includes(':'));
  await pool8(gets, async (r) => { const res = await call('GET', r.path, A.token); if (res.status === 200 && leaks(res.text)) seen++; });
  assert.ok(seen >= 15, `only ${seen} pages showed A's data to A`);
});
