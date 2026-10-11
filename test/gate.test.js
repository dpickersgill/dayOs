'use strict';

// Gate: RFID cards and gate hardware. A card carries a ticket and opens the gate whichever way its serial is read
// (phone, hex reader, decimal reader); a lost card is blocked and its ticket moves to a new card; a paired gate asks
// online, works from a list offline, and sends its offline scans once; one mountain's cards and devices never touch
// another's.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const A = require('../src/lib/access');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const dev = (token) => ({ authorization: `Device ${token}` });

const M = {};
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const token = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return { slug, token, id: t.id };
}
async function sell(m, kind = 'day_ticket', extra = {}) {
  const p = ok(await api('POST', '/products', { token: m.token, body: { kind, name: `${kind} ${Math.random()}`, base_price_cents: 5000, ...extra } }));
  return ok(await api('POST', '/orders', { token: m.token, body: { items: [{ product_id: p.id }] } })).tickets[0].code;
}

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M.a = await mountain(`ga-${suffix}`);
  M.b = await mountain(`gb-${suffix}`);
  ok(await api('POST', '/users', { token: M.a.token, body: { email: `desk@${M.a.slug}.test`, password: PW, role: 'counter' } }));
  M.a.desk = (await api('POST', '/auth/login', { body: { tenant: M.a.slug, email: `desk@${M.a.slug}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('one chip, read many ways', () => {
  assert.deepEqual(A.uidCandidates('04:a2:3b:4c'), ['04A23B4C']);
  // a decimal reader gives the same chip as a number; some reverse the bytes
  const c = A.uidCandidates(String(0x04A23B4C));
  assert.ok(c.includes('04A23B4C') && c.includes('4C3BA204'));
  assert.deepEqual(A.uidCandidates('not a card'), []);
});

test('cards: load a ticket, tap to ride, block a lost card and move the ticket', async () => {
  const a = M.a;
  const code = await sell(a);
  // the counter loads the ticket onto a card read by a desk reader
  const card = ok(await api('POST', '/access/cards/assign', { token: a.desk, body: { ticket_code: code, uid: '04:A2:3B:4C:5D:6E:70', label: '1001' } }));
  assert.equal(card.uid, '04A23B4C5D6E70');
  // a phone reads it with colons; the gate box gets it typed as plain hex: both ride
  const tap = ok(await api('POST', '/tickets/scan', { token: a.desk, body: { uid: '04:a2:3b:4c:5d:6e:70', location: 'Summit' } }));
  assert.equal(tap.result, 'ok');
  assert.equal(tap.card.label, '1001');
  assert.equal(ok(await api('POST', '/tickets/scan', { token: a.desk, body: { code: '04A23B4C5D6E70' } })).result, 'duplicate', 'pass-back still applies to cards');
  // a card nobody registered
  assert.equal(ok(await api('POST', '/tickets/scan', { token: a.desk, body: { uid: 'DEADBEEF' } })).result, 'unknown');
  // a second ticket cannot silently overwrite a card that still carries a good one
  const code2 = await sell(a);
  const clash = await api('POST', '/access/cards/assign', { token: a.desk, body: { ticket_code: code2, uid: '04A23B4C5D6E70' } });
  is(clash, 409); assert.equal(clash.body.details.code, 'card_in_use');
  // lost: blocked at once, and the ticket goes onto a new card
  ok(await api('POST', `/access/cards/${card.id}/lost`, { token: a.desk }));
  assert.equal(ok(await api('POST', '/tickets/scan', { token: a.desk, body: { uid: '04A23B4C5D6E70' } })).result, 'card_blocked');
  is(await api('POST', '/access/cards/assign', { token: a.desk, body: { ticket_code: code2, uid: '04A23B4C5D6E70' } }), 409, 'a lost card cannot be loaded');
  is(await api('POST', `/access/cards/${card.id}/free`, { token: a.desk }), 409, 'only a manager unblocks');
  const fresh = ok(await api('POST', '/access/cards/assign', { token: a.desk, body: { ticket_code: code, uid: '11223344' } }));
  assert.equal(fresh.moved_from_other_card, false, 'the lost card stays blocked rather than freed');
  const found = ok(await api('GET', '/access/cards/lookup?uid=11:22:33:44', { token: a.desk })).card;
  assert.equal(found.ticket_code, code); assert.equal(found.status, 'assigned');
  // moving a ticket from one good card to another frees the first
  const moved = ok(await api('POST', '/access/cards/assign', { token: a.desk, body: { ticket_code: code, uid: 'AABBCCDD' } }));
  assert.equal(moved.moved_from_other_card, true);
  assert.equal(ok(await api('GET', '/access/cards/lookup?uid=11223344', { token: a.desk })).card.status, 'free');
  const list = ok(await api('GET', '/access/cards?q=1001', { token: a.desk }));
  assert.equal(list.data[0].status, 'lost');
  // another mountain sees none of it
  assert.equal(ok(await api('GET', '/access/cards/lookup?uid=AABBCCDD', { token: M.b.token })).card, null);
  assert.equal(ok(await api('POST', '/tickets/scan', { token: M.b.token, body: { uid: 'AABBCCDD' } })).result, 'unknown');
});

test('devices: pair, check online, a retry is one ride, offline list and upload', async () => {
  const a = M.a;
  is(await api('POST', '/access/devices', { token: a.desk, body: { name: 'Summit gate' } }), 403, 'devices are a manager\'s');
  const d = ok(await api('POST', '/access/devices', { token: a.token, body: { name: 'Summit gate', location: 'Summit Quad', kind: 'turnstile' } }));
  is(await api('POST', '/device/check', { body: { uid: 'AABBCCDD' }, headers: dev('nope') }), 401);
  const paired = ok(await api('POST', '/device/pair', { body: { code: d.code } }));
  is(await api('POST', '/device/pair', { body: { code: d.code } }), 401, 'a pairing code works once');
  const H = dev(paired.token);
  ok(await api('GET', '/device/ping', { headers: H }));

  // a punch card with two rides, on a card
  const code = await sell(a, 'punch_card', { valid_days: 30, uses: 2 });
  ok(await api('POST', '/access/cards/assign', { token: a.token, body: { ticket_code: code, uid: '0A0B0C0D' } }));
  const first = ok(await api('POST', '/device/check', { body: { uid: '0A0B0C0D', client_ref: 'g1-1' }, headers: H }));
  assert.equal(first.allow, true); assert.ok(first.open_ms > 0); assert.equal(first.uses_remaining, 1);
  const retry = ok(await api('POST', '/device/check', { body: { uid: '0A0B0C0D', client_ref: 'g1-1' }, headers: H }));
  assert.equal(retry.repeat, true); assert.equal(retry.allow, true);
  const [[t]] = await pool.query('SELECT uses_remaining FROM tickets WHERE tenant_id = ? AND code = ?', [a.id, code]);
  assert.equal(t.uses_remaining, 1, 'a retried request used one ride, not two');
  const [[s]] = await pool.query('SELECT location, via, device_id FROM scans WHERE tenant_id = ? AND client_ref = ?', [a.id, 'g1-1']);
  assert.equal(s.location, 'Summit Quad'); assert.equal(s.via, 'device');

  // the offline list: good chips and codes, blocked chips, no names
  const list = ok(await api('GET', '/device/list', { headers: H }));
  assert.ok(list.items.some((i) => i.uid === '0A0B0C0D' && i.uses_remaining === 1));
  assert.ok(list.blocked.includes('04A23B4C5D6E70'));
  assert.ok(!JSON.stringify(list).includes('Olive'));

  // scans decided offline arrive later, are saved once, and use the ride
  const at = new Date(Date.now() - 60_000).toISOString();
  const up = ok(await api('POST', '/device/scans', { body: { scans: [{ client_ref: 'off-1', at, uid: '0A0B0C0D', allowed: true }, { client_ref: 'off-2', at, uid: 'FFFFFFFF', allowed: false }] }, headers: H }));
  assert.deepEqual(up, { saved: 2, repeats: 0 });
  assert.deepEqual(ok(await api('POST', '/device/scans', { body: { scans: [{ client_ref: 'off-1', at, uid: '0A0B0C0D', allowed: true }] }, headers: H })), { saved: 0, repeats: 1 });
  const [[t2]] = await pool.query('SELECT uses_remaining, status FROM tickets WHERE tenant_id = ? AND code = ?', [a.id, code]);
  assert.equal(t2.uses_remaining, 0); assert.equal(t2.status, 'used_up');
  assert.equal(ok(await api('POST', '/device/check', { body: { uid: '0A0B0C0D' }, headers: H })).result, 'no_uses');

  // the manager sees the device working, and can switch it off
  const devices = ok(await api('GET', '/access/devices', { token: a.token })).data;
  const mine = devices.find((x) => x.id === d.id);
  assert.equal(mine.paired, true); assert.ok(mine.scans_24h >= 3); assert.ok(mine.last_list_at);
  ok(await api('PATCH', `/access/devices/${d.id}`, { token: a.token, body: { active: false } }));
  is(await api('GET', '/device/ping', { headers: H }), 401, 'a switched-off device is shut out');
  // the other mountain cannot see or change it
  is(await api('PATCH', `/access/devices/${d.id}`, { token: M.b.token, body: { active: true } }), 404);
});

test('the Gate app switched off closes cards and devices too', async () => {
  const a = M.a;
  const d = ok(await api('POST', '/access/devices', { token: a.token, body: { name: 'Base gate' } }));
  const paired = ok(await api('POST', '/device/pair', { body: { code: d.code } }));
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'gate', 0) ON DUPLICATE KEY UPDATE enabled = 0", [a.id]);
  modules.invalidate(a.id);
  try {
    is(await api('GET', '/access/cards', { token: a.token }), 403);
    is(await api('GET', '/device/ping', { headers: dev(paired.token) }), 403);
  } finally {
    await pool.query("UPDATE tenant_modules SET enabled = 1 WHERE tenant_id = ? AND module = 'gate'", [a.id]);
    modules.invalidate(a.id);
  }
  // settings
  ok(await api('PUT', '/access/settings', { token: a.token, body: { gate_open_ms: 4000 } }));
  assert.equal(ok(await api('GET', '/access/settings', { token: a.token })).gate_open_ms, 4000);
  is(await api('PUT', '/access/settings', { token: a.desk, body: { gate_open_ms: 1000 } }), 403);
});
