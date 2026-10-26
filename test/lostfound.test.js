'use strict';

// Lost and found: items logged (valuables flagged, card numbers refused), guest reports at the counter and on the
// website (with a bot trap), matches suggested both ways, a confirmed match tells the guest, handing back needs an ID
// check, and items past their keeping time can be cleared out.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.HELP_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { score } = require('../src/routes/lostfound');

let server; let base; let slug;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const M = {};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

test('the rules: the same kind, color and day make a match', () => {
  const item = { kind: 'gloves', color: 'red', brand: 'Hestra', found_where: 'Summit Quad', description: 'leather', found_at: '2026-12-05 11:00:00' };
  assert.ok(score(item, { kind: 'gloves', color: 'Red', brand: 'hestra', lost_where: 'summit quad', lost_on: '2026-12-05' }) >= 10);
  assert.ok(score(item, { kind: 'phone', color: 'red', lost_on: '2026-12-05' }) < 5);
  assert.ok(score(item, { kind: 'gloves', color: 'red', lost_on: '2026-12-20' }) < 5, 'found before it was lost');
});

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  slug = `lf-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Found Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `desk@${slug}.test`, password: PW, role: 'counter' } }));
  M.desk = await login(`desk@${slug}.test`);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol' } }));
  M.pat = await login(`pat@${slug}.test`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the front desk logs what is handed in; valuables are flagged and card numbers refused', async () => {
  is(await api('GET', '/lost-found', { token: M.pat }), 403, 'patrol does not run the front desk');
  const a = ok(await api('POST', '/lost-found/items', { token: M.desk, body: { kind: 'gloves', color: 'red', brand: 'Hestra', found_where: 'Summit Quad', bin: 'B3' } }));
  const b = ok(await api('POST', '/lost-found/items', { token: M.desk, body: { kind: 'wallet', color: 'brown', found_where: 'Base lodge', photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' } }));
  assert.equal(a.number, 1); assert.equal(b.number, 2);
  is(await api('POST', '/lost-found/items', { token: M.desk, body: { kind: 'card', description: 'Visa 4111 1111 1111 1111' } }), 400, 'no card numbers');
  is(await api('POST', '/lost-found/items', { token: M.desk, body: { kind: 'card', photo: 'javascript:alert(1)' } }), 400);
  const list = ok(await api('GET', '/lost-found', { token: M.desk }));
  const w = list.items.find((i) => i.id === b.id);
  assert.equal(w.valuable, true); assert.equal(w.has_photo, true); assert.equal(w.photo, undefined, 'photos come separately');
  const photo = await fetch(`${base}/api/v1/lost-found/items/${b.id}/photo`, { headers: { authorization: `Bearer ${M.desk}` } });
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  M.gloves = a.id; M.wallet = b.id;
});

test('a guest reports a loss on the website; the bot trap keeps nothing', async () => {
  const page = ok(await api('GET', `/public/${slug}/lost`));
  assert.equal(page.mountain, 'Found Peak');
  is(await api('POST', `/public/${slug}/lost`, { body: { kind: 'gloves', lost_on: today, name: 'Ann Guest' } }), 400, 'needs a way to reach them');
  is(await api('POST', `/public/${slug}/lost`, { body: { kind: 'gloves', lost_on: '2099-01-01', name: 'Ann Guest', email: 'ann@example.com' } }), 400, 'not in the future');
  is(await api('POST', `/public/${slug}/lost`, { body: { kind: 'gloves', lost_on: today, name: 'Bot', email: 'b@example.com', website: 'http://spam' } }), 202);
  ok(await api('POST', `/public/${slug}/lost`, { body: { kind: 'gloves', color: 'Red', brand: 'Hestra', lost_where: 'Summit Quad chair', lost_on: today, name: 'Ann Guest', email: 'ann@example.com' } }));
  const list = ok(await api('GET', '/lost-found', { token: M.desk }));
  assert.equal(list.reports.length, 1, 'the bot left nothing');
  const rep = list.reports[0];
  assert.equal(rep.source, 'web'); assert.equal(rep.matches[0].id, M.gloves);
  M.rep = rep.id;
  // the mountain can turn the form off
  ok(await api('PUT', '/lost-found/settings', { token: M.owner, body: { keep_days: 30, web_form: false, pickup: 'Collect it at Guest Services, base lodge, with photo ID.' } }));
  is(await api('GET', `/public/${slug}/lost`), 404);
  ok(await api('PUT', '/lost-found/settings', { token: M.owner, body: { keep_days: 30, web_form: true, pickup: 'Collect it at Guest Services, base lodge, with photo ID.' } }));
  is(await api('PUT', '/lost-found/settings', { token: M.desk, body: { keep_days: 30, web_form: true } }), 403, 'managers set it');
});

test('a confirmed match sets it aside; handing back needs an ID check', async () => {
  const m = ok(await api('POST', '/lost-found/match', { token: M.desk, body: { item_id: M.gloves, report_id: M.rep } }));
  assert.ok(m.ok);
  is(await api('POST', '/lost-found/match', { token: M.desk, body: { item_id: M.gloves, report_id: M.rep } }), 409);
  let list = ok(await api('GET', '/lost-found', { token: M.desk }));
  assert.equal(list.items.find((i) => i.id === M.gloves).status, 'matched'); assert.equal(list.reports.length, 0);
  is(await api('POST', `/lost-found/items/${M.gloves}/return`, { token: M.desk, body: { returned_to: 'Ann Guest' } }), 400, 'ID check first');
  ok(await api('POST', `/lost-found/items/${M.gloves}/return`, { token: M.desk, body: { returned_to: 'Ann Guest', id_checked: true } }));
  list = ok(await api('GET', '/lost-found?status=returned', { token: M.desk }));
  assert.equal(list.items[0].returned_to, 'Ann Guest');
  const [[rep]] = await pool.query('SELECT status FROM lost_reports WHERE id = ?', [M.rep]);
  assert.equal(rep.status, 'closed');
});

test('a counter report finds what is already here; old items are cleared out', async () => {
  const r = ok(await api('POST', '/lost-found/reports', { token: M.desk, body: { kind: 'wallet', color: 'brown leather', lost_where: 'base lodge', lost_on: today, name: 'Bo Guest', phone: '555-0100' } }));
  assert.equal(r.matches[0].id, M.wallet);
  await pool.query('UPDATE lost_items SET found_at = found_at - INTERVAL 40 DAY WHERE id = ?', [M.wallet]);
  const list = ok(await api('GET', '/lost-found', { token: M.desk }));
  assert.equal(list.items.find((i) => i.id === M.wallet).due, true);
  ok(await api('POST', `/lost-found/items/${M.wallet}/clear`, { token: M.desk, body: { how: 'donated' } }));
  is(await api('POST', `/lost-found/items/${M.wallet}/clear`, { token: M.desk, body: { how: 'discarded' } }), 409);
  ok(await api('POST', `/lost-found/reports/${r.id}/close`, { token: M.desk }));
});
