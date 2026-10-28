'use strict';

// The document repository: categories, which roles see or add to each one, uploads, downloads and replacing a file.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const fs = require('fs');
const nodePath = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, path, { token, body, headers = {} } = {}) {
  const raw = body instanceof Buffer;
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(raw ? { 'content-type': 'application/octet-stream', 'x-filename': headers.name, ...(headers.note ? { 'x-note': encodeURIComponent(headers.note) } : {}) } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), text };
}
const ok = (r, status) => { assert.equal(r.status, status ?? (r.status < 300 ? r.status : -1), JSON.stringify(r.body)); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
const login = async (m, email) => (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;

let A; let B; const T = {}; const D = {};

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`dc-${suffix}`); B = await mountain(`dd-${suffix}`);
  for (const role of ['staff', 'counter', 'patrol', 'manager']) {
    ok(await api('POST', '/users', { token: A.owner, body: { email: `${role}@${A.slug}.test`, password: PW, role } }), 201);
    T[role] = await login(A, `${role}@${A.slug}.test`);
  }
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

test('only managers make categories, and a category with no roles is managers only', async () => {
  is(await api('POST', '/documents/categories', { token: T.staff, body: { name: 'Nope' } }), 403);
  D.safety = ok(await api('POST', '/documents/categories', { token: T.manager, body: { name: 'Safety', description: 'Rules and plans' } }), 201).id;
  D.hr = ok(await api('POST', '/documents/categories', { token: T.manager, body: { name: 'HR forms' } }), 201).id;
  is(await api('POST', '/documents/categories', { token: T.manager, body: { name: 'Safety' } }), 409, 'duplicate name');
  assert.equal(ok(await api('GET', '/documents/categories', { token: T.staff })).data.length, 0, 'nothing is shared yet');
  assert.equal(ok(await api('GET', '/documents/categories', { token: T.manager })).data.length, 2);
});

test('roles per category: patrol may read and add to Safety, staff may only read, counter sees nothing', async () => {
  is(await api('PUT', `/documents/categories/${D.safety}/roles`, { token: T.staff, body: { roles: [] } }), 403);
  is(await api('PUT', `/documents/categories/${D.safety}/roles`, { token: T.manager, body: { roles: [{ role: 'owner', can_add: true }] } }), 400, 'only the four crew roles');
  ok(await api('PUT', `/documents/categories/${D.safety}/roles`, { token: T.manager, body: { roles: [{ role: 'patrol', can_add: true }, { role: 'staff', can_add: false }] } }));
  const mine = ok(await api('GET', '/documents/categories', { token: T.patrol })).data;
  assert.equal(mine.length, 1); assert.equal(mine[0].can_add, true);
  assert.equal(ok(await api('GET', '/documents/categories', { token: T.staff })).data[0].can_add, false);
  assert.equal(ok(await api('GET', '/documents/categories', { token: T.counter })).data.length, 0);
  const m = ok(await api('GET', '/documents/categories', { token: T.manager })).data.find((c) => c.id === D.safety);
  assert.equal(m.roles.length, 2);
});

test('upload, download, replace, and who may do it', async () => {
  D.doc = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.safety, title: 'Evacuation plan', description: 'Lodge and lifts' } }), 201).id;
  is(await api('POST', '/documents/documents', { token: T.staff, body: { category_id: D.safety, title: 'Staff add' } }), 403, 'read only role cannot add');
  is(await api('POST', '/documents/documents', { token: T.counter, body: { category_id: D.safety, title: 'x' } }), 404, 'a category the role cannot see looks missing');
  is(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.hr, title: 'x' } }), 404);
  is(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.safety, title: 'x', link_url: 'javascript:alert(1)' } }), 400, 'links must be web addresses');
  ok(await api('PUT', `/documents/documents/${D.doc}/file`, { token: T.patrol, body: pdf, headers: { name: 'evac plan.pdf' } }), 201);
  is(await api('PUT', `/documents/documents/${D.doc}/file`, { token: T.patrol, body: Buffer.from('<script>alert(1)</script>'), headers: { name: 'x.html' } }), 400, 'html is not allowed');
  is(await api('PUT', `/documents/documents/${D.doc}/file`, { token: T.patrol, body: Buffer.from('not a pdf'), headers: { name: 'fake.pdf' } }), 400, 'pdf must look like a pdf');
  is(await api('PUT', `/documents/documents/${D.doc}/file`, { token: T.staff, body: pdf, headers: { name: 'a.pdf' } }), 403);
  const list = ok(await api('GET', '/documents/documents', { token: T.staff })).data;
  assert.equal(list.length, 1); assert.equal(list[0].file_name, 'evac plan.pdf'); assert.equal(list[0].version, 1); assert.equal(list[0].uploader !== null, true);
  const dl = await api('GET', `/documents/documents/${D.doc}/file`, { token: T.staff });
  is(dl, 200); assert.equal(dl.type, 'application/pdf'); assert.match(dl.disposition, /^inline/); assert.ok(dl.text.startsWith('%PDF-'));
  assert.match((await api('GET', `/documents/documents/${D.doc}/file?download=1`, { token: T.staff })).disposition, /^attachment/);
  is(await api('GET', `/documents/documents/${D.doc}/file`, { token: T.counter }), 404, 'a counter login cannot read it');
  is(await api('GET', `/documents/documents/${D.doc}/file`, { token: B.owner }), 404, 'another mountain cannot either');
  ok(await api('PUT', `/documents/documents/${D.doc}/file`, { token: T.patrol, body: Buffer.concat([pdf, Buffer.from('2')]), headers: { name: 'evac plan v2.pdf' } }), 201);
  assert.equal(ok(await api('GET', '/documents/documents', { token: T.patrol })).data[0].version, 2, 'a new file is a new version');
  assert.equal(ok(await api('GET', '/documents/documents?q=evac', { token: T.staff })).data.length, 1);
  assert.equal(ok(await api('GET', '/documents/documents?q=zzz', { token: T.staff })).data.length, 0);
});

test('a link document, moving categories, and removing things', async () => {
  const link = ok(await api('POST', '/documents/documents', { token: T.manager, body: { category_id: D.hr, title: 'Payroll portal', link_url: 'https://example.com/payroll' } }), 201).id;
  assert.equal(ok(await api('GET', '/documents/documents', { token: T.staff })).data.length, 1, 'staff do not see HR documents');
  is(await api('DELETE', `/documents/categories/${D.hr}`, { token: T.manager }), 409, 'category still has a document');
  ok(await api('PATCH', `/documents/documents/${link}`, { token: T.manager, body: { category_id: D.safety } }));
  assert.equal(ok(await api('GET', '/documents/documents', { token: T.staff })).data.length, 2, 'moved into a category staff can read');
  is(await api('DELETE', `/documents/documents/${link}`, { token: T.staff }), 403);
  ok(await api('DELETE', `/documents/documents/${link}`, { token: T.patrol }));
  ok(await api('DELETE', `/documents/categories/${D.hr}`, { token: T.manager }));
  ok(await api('PATCH', `/documents/categories/${D.safety}`, { token: T.manager, body: { name: 'Safety and rescue' } }));
  is(await api('PUT', `/documents/categories/${D.safety}/roles`, { token: T.manager, body: { roles: [] } }), 200);
  assert.equal(ok(await api('GET', '/documents/documents', { token: T.patrol })).data.length, 0, 'removing every role hides the category');
  assert.equal(ok(await api('GET', '/documents/documents', { token: T.manager })).data.length, 1, 'managers still see it');
});

// ---------------------------------------------------------------- versions and searching inside files
const upload = (token, id, name, content, note) => api('PUT', `/documents/documents/${id}/file`, { token, body: Buffer.isBuffer(content) ? content : Buffer.from(content), headers: { name, note } });

test('every replaced file is kept as an earlier version, with who and why, and can be opened or restored', async () => {
  const cat = ok(await api('POST', '/documents/categories', { token: T.manager, body: { name: 'Manuals' } }), 201).id;
  ok(await api('PUT', `/documents/categories/${cat}/roles`, { token: T.manager, body: { roles: [{ role: 'patrol', can_add: true }, { role: 'staff', can_add: false }] } }));
  D.cat = cat;
  D.man = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: cat, title: 'Lift manual' } }), 201).id;
  ok(await upload(T.patrol, D.man, 'manual.txt', 'Version one: check the bullwheel', 'First draft'), 201);
  ok(await upload(T.patrol, D.man, 'manual.txt', 'Version two: check the bullwheel and rope', 'Added rope'), 201);
  const v = ok(await api('GET', `/documents/documents/${D.man}/versions`, { token: T.staff }));
  assert.equal(v.max, 10); assert.equal(v.current.version, 2); assert.equal(v.current.note, 'Added rope'); assert.equal(v.earlier.length, 1);
  assert.equal(v.earlier[0].version, 1); assert.equal(v.earlier[0].note, 'First draft'); assert.ok(v.earlier[0].uploader);
  assert.equal(v.can_add, false, 'staff can look at versions but not change them');
  const old = await api('GET', `/documents/documents/${D.man}/versions/1/file`, { token: T.staff });
  is(old, 200); assert.equal(old.text, 'Version one: check the bullwheel');
  is(await api('GET', `/documents/documents/${D.man}/versions/1/file`, { token: T.counter }), 404, 'a counter login cannot see versions of a hidden category');
  is(await api('GET', `/documents/documents/${D.man}/versions/9/file`, { token: T.staff }), 404);
  is(await api('POST', `/documents/documents/${D.man}/versions/1/restore`, { token: T.staff }), 403);
  const back = ok(await api('POST', `/documents/documents/${D.man}/versions/1/restore`, { token: T.patrol }));
  assert.equal(back.version, 3, 'restoring makes a new version, nothing is lost');
  const after = ok(await api('GET', `/documents/documents/${D.man}/versions`, { token: T.patrol }));
  assert.equal(after.earlier.length, 2); assert.match(after.current.note, /Restored version 1/);
  assert.equal((await api('GET', `/documents/documents/${D.man}/file`, { token: T.patrol })).text, 'Version one: check the bullwheel');
});

test('a document keeps 10 versions at most; the 11th file has to be a new document', async () => {
  for (let i = 4; i <= 10; i++) ok(await upload(T.patrol, D.man, 'manual.txt', `Version ${i}`), 201);
  const v = ok(await api('GET', `/documents/documents/${D.man}/versions`, { token: T.patrol }));
  assert.equal(v.current.version, 10); assert.equal(v.earlier.length, 9);
  const r = await upload(T.patrol, D.man, 'manual.txt', 'Version 11');
  is(r, 409); assert.match(r.body.error, /10 versions/);
  is(await api('POST', `/documents/documents/${D.man}/versions/2/restore`, { token: T.patrol }), 409, 'restoring is also a new version');
  assert.equal(ok(await api('GET', `/documents/documents/${D.man}/versions`, { token: T.patrol })).current.version, 10, 'nothing changed');
  // the replacement goes in as a brand new document in the same category
  const fresh = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.cat, title: 'Lift manual (new)' } }), 201).id;
  ok(await upload(T.patrol, fresh, 'manual.txt', 'Fresh start'), 201);
  assert.equal(ok(await api('GET', `/documents/documents/${fresh}/versions`, { token: T.patrol })).current.version, 1);
  ok(await api('DELETE', `/documents/documents/${fresh}`, { token: T.patrol }));
});

test('documents can be found by the words inside them, in text, Word and PDF-free formats', async () => {
  const { zipSync, strToU8 } = require('fflate');
  const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Avalanche transceiver beacon checks every morning</w:t></w:r></w:p></w:body></w:document>') }));
  const a = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.cat, title: 'Morning routine' } }), 201).id;
  const up = ok(await upload(T.patrol, a, 'routine.docx', docx), 201);
  assert.equal(up.text_status, 'indexed');
  const b = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.cat, title: 'Rope notes' } }), 201).id;
  ok(await upload(T.patrol, b, 'rope.txt', 'The haul rope must be inspected for broken wires. Keep a log.'), 201);
  const find = async (q, token = T.staff) => ok(await api('GET', `/documents/documents?q=${encodeURIComponent(q)}`, { token })).data;
  let hits = await find('transceiver');
  assert.equal(hits.length, 1); assert.equal(hits[0].title, 'Morning routine'); assert.match(hits[0].snippet, /transceiver/i);
  assert.equal((await find('beacon morning')).length, 1, 'every word has to match');
  assert.equal((await find('beacon rope')).length, 0);
  assert.equal((await find('broken wires'))[0].title, 'Rope notes');
  assert.equal((await find('transceiver', T.counter)).length, 0, 'a role that cannot see the category never gets a match');
  assert.equal((await find('transceiver', B.owner)).length, 0, 'another mountain never matches');
  assert.equal((await find('100%')).length, 0, 'percent signs are plain characters');
  // replacing the file replaces what is searchable
  ok(await upload(T.patrol, b, 'rope.txt', 'Completely different words about sheaves'));
  assert.equal((await find('broken')).length, 0); assert.equal((await find('sheaves')).length, 1);
  const st = ok(await api('GET', '/documents/scan-status', { token: T.staff }));
  assert.ok(st.counts.indexed >= 2);
});

test('a small Word file that would unzip to 300 MB is kept, marked as not readable, and the server carries on', async () => {
  const { zipSync, strToU8 } = require('fflate');
  const bomb = Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<x/>'), 'word/document.xml': [new Uint8Array(300 * 1048576).fill(0x20), { level: 9 }] }));
  const id = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.cat, title: 'Huge inside' } }), 201).id;
  const before = process.memoryUsage().rss;
  assert.equal(ok(await upload(T.patrol, id, 'huge.docx', bomb), 201).text_status, 'failed');
  assert.ok(process.memoryUsage().rss - before < 100 * 1048576, 'the file was never unzipped in full');
  const back = await api('GET', `/documents/documents/${id}/file`, { token: T.patrol });
  assert.equal(back.status, 200, 'the upload itself is kept and can be downloaded');
  ok(await api('DELETE', `/documents/documents/${id}`, { token: T.patrol }));
});

test('text recognition is an add-on: off until the operator turns it on for the mountain', async () => {
  const png = fs.readFileSync(nodePath.join(__dirname, 'fixtures', 'scan.png'));
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [A.slug]);
  const plat = (body) => fetch(`${base}/api/v1/platform/tenants/${t.id}/modules`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-platform-key': 'test-bootstrap-key' }, body: JSON.stringify(body) });
  assert.equal(ok(await api('GET', '/documents/scan-status', { token: T.patrol })).ocr, false);
  const i = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.cat, title: 'Addon check' } }), 201).id;
  assert.equal(ok(await upload(T.patrol, i, 'addon.png', png), 201).text_status, 'needs_ocr');
  assert.equal(ok(await api('POST', `/documents/documents/${i}/scan`, { token: T.patrol })).text_status, 'needs_ocr', 'a picture stays unread without the add-on');
  const run = ok(await api('POST', '/documents/scan', { token: T.manager, body: { limit: 5 } }));
  assert.equal(run.remaining, 0, 'pictures are not counted as waiting, so the scan loop ends');
  assert.ok(ok(await api('GET', '/auth/me', { token: T.patrol })).modules.every((m) => m !== 'doc_ocr'));
  assert.equal((await plat({ modules: { doc_ocr: true } })).status, 200);
  assert.equal(ok(await api('GET', '/documents/scan-status', { token: T.patrol })).ocr, true);
});

test('pictures of text are read with OCR: a scanned image and a scanned PDF', async () => {
  const png = fs.readFileSync(nodePath.join(__dirname, 'fixtures', 'scan.png'));
  const pdfScan = fs.readFileSync(nodePath.join(__dirname, 'fixtures', 'scanned.pdf'));
  const i = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.cat, title: 'Posted notice' } }), 201).id;
  assert.equal(ok(await upload(T.patrol, i, 'notice.png', png), 201).text_status, 'needs_ocr', 'upload stays quick; reading the picture is a separate step');
  const p = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.cat, title: 'Scanned plan' } }), 201).id;
  assert.equal(ok(await upload(T.patrol, p, 'plan.pdf', pdfScan), 201).text_status, 'needs_ocr');
  const find = async (q) => ok(await api('GET', `/documents/documents?q=${encodeURIComponent(q)}`, { token: T.staff })).data;
  assert.equal((await find('muster')).length, 0, 'not searchable until scanned');
  is(await api('POST', `/documents/documents/${i}/scan`, { token: T.staff }), 403, 'read only roles cannot trigger scans');
  assert.equal(ok(await api('POST', `/documents/documents/${i}/scan`, { token: T.patrol })).text_status, 'indexed');
  assert.equal((await find('muster')).length, 1);
  // a manager scans everything still waiting
  is(await api('POST', '/documents/scan', { token: T.patrol, body: {} }), 403);
  const run = ok(await api('POST', '/documents/scan', { token: T.manager, body: { limit: 5 } }));
  assert.ok(run.scanned >= 1); assert.equal(run.remaining, 0);
  assert.equal((await find('muster')).length, 3, 'the scanned PDF is searchable now, and so is the picture left waiting by the add-on test');
  const again = ok(await api('POST', '/documents/scan', { token: T.manager, body: {} }));
  assert.equal(again.scanned, 0, 'nothing waiting');
  const redo = ok(await api('POST', '/documents/scan', { token: T.manager, body: { rescan: true, limit: 10 } }));
  assert.ok(redo.scanned >= 1);
});

const freshCategory = async (name) => {
  const id = ok(await api('POST', '/documents/categories', { token: T.manager, body: { name } }), 201).id;
  ok(await api('PUT', `/documents/categories/${id}/roles`, { token: T.manager, body: { roles: [{ role: 'patrol', can_add: true }, { role: 'staff', can_add: false }] } }));
  return id;
};

test('read and accepted: each person accepts the current version, and a new version asks again', async () => {
  D.safety = await freshCategory('Safety rules');
  const doc = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.safety, title: 'Lift evacuation rules', require_ack: true } }), 201).id;
  ok(await api('PUT', `/documents/documents/${doc}/file`, { token: T.patrol, body: Buffer.from('rules, first version'), headers: { name: 'rules.txt' } }), 201);
  const mine = async (token) => ok(await api('GET', '/documents/documents', { token })).data.find((d) => d.id === doc);
  assert.equal((await mine(T.staff)).require_ack, true);
  assert.equal((await mine(T.staff)).accepted_by_me, false);
  is(await api('POST', `/documents/documents/${doc}/accept`, { token: T.counter }), 404, 'a role with no access cannot accept');
  ok(await api('POST', `/documents/documents/${doc}/accept`, { token: T.staff }));
  ok(await api('POST', `/documents/documents/${doc}/accept`, { token: T.staff }), 200); // a second tap changes nothing
  assert.equal((await mine(T.staff)).accepted_by_me, true);
  assert.equal((await mine(T.manager)).accepted_count, 1);
  assert.equal((await mine(T.staff)).accepted_count, undefined, 'only managers see the count');
  is(await api('GET', `/documents/documents/${doc}/acceptances`, { token: T.staff }), 403);
  const who = ok(await api('GET', `/documents/documents/${doc}/acceptances`, { token: T.manager }));
  assert.ok(who.data.find((p) => p.email === `staff@${A.slug}.test` && p.accepted_at));
  assert.ok(who.data.find((p) => p.email === `patrol@${A.slug}.test` && !p.accepted_at), 'patrol can see the category and has not accepted');
  assert.ok(!who.data.find((p) => p.email === `counter@${A.slug}.test`), 'counter cannot see the category, so is not asked');
  ok(await api('PUT', `/documents/documents/${doc}/file`, { token: T.patrol, body: Buffer.from('rules, second version'), headers: { name: 'rules.txt' } }), 201);
  assert.equal((await mine(T.staff)).accepted_by_me, false, 'a new version asks again');
  const plain = ok(await api('POST', '/documents/documents', { token: T.patrol, body: { category_id: D.safety, title: 'No acceptance needed' } }), 201).id;
  is(await api('POST', `/documents/documents/${plain}/accept`, { token: T.staff }), 400);
});

test('a mountain cannot upload past its storage limit', async () => {
  const tid = (await pool.query('SELECT id FROM tenants WHERE slug = ?', [A.slug]))[0][0].id;
  const used = ok(await api('GET', '/documents/storage', { token: T.manager }));
  assert.ok(used.used_mb >= 0 && used.cap_mb === 500);
  await pool.query('UPDATE tenants SET storage_cap_mb = 1 WHERE id = ?', [tid]);
  try {
    const doc = ok(await api('POST', '/documents/documents', { token: T.manager, body: { category_id: D.safety, title: 'Big one' } }), 201).id;
    const big = await api('PUT', `/documents/documents/${doc}/file`, { token: T.manager, body: Buffer.alloc(1.5 * 1048576, 97), headers: { name: 'big.txt' } });
    assert.equal(big.status, 413, JSON.stringify(big.body));
    assert.match(big.body.error, /storage is full/);
    const small = await api('PUT', `/documents/documents/${doc}/file`, { token: T.manager, body: Buffer.from('tiny'), headers: { name: 'tiny.txt' } });
    assert.equal(small.status, 201, 'a small file still fits');
  } finally {
    await pool.query('UPDATE tenants SET storage_cap_mb = 500 WHERE id = ?', [tid]);
  }
});
