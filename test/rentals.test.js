'use strict';

// The full rental counter: reservations, binding records, group contracts, fees, swaps, service, reports, and mountain-to-mountain isolation.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const R = require('../src/lib/rentals');

let server; let base;
const suffix = Date.now().toString(36) + Math.floor(Math.random() * 100);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
let A; let B; let mum; let kid;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
async function mountain(slug) {
  const t = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `o@${slug}.test`, password: 'correct-horse-battery', first_name: 'O', last_name: 'O' } }) });
  assert.equal(t.status, 201);
  const l = await api('POST', '/auth/login', { body: { tenant: slug, email: `o@${slug}.test`, password: 'correct-horse-battery' } });
  return { slug, token: l.body.token };
}
const item = async (t, sku, category, extra = {}) => (await api('POST', '/rentals/items', { token: t.token, body: { sku, category, ...extra } })).body.id;

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`rent-a-${suffix}`);
  B = await mountain(`rent-b-${suffix}`);
  mum = (await api('POST', '/people', { token: A.token, body: { first_name: 'Mia', last_name: 'Renter' } })).body.id;
  kid = (await api('POST', '/people', { token: A.token, body: { first_name: 'Kit', last_name: 'Renter' } })).body.id;
  // both have signed that their details are true, so skis can go out (Mia for herself, a parent for Kit)
  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  for (const [pid, rel, details] of [[mum, 'self', { date_of_birth: '1984-02-02' }], [kid, 'parent', {}]]) {
    const r = await api('POST', '/rentals/fit/signoffs', { token: A.token, body: { person_id: pid, signer_name: 'Mia Renter', signer_relation: rel, signature: SIG, details } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('late fee maths uses grace and whole days', () => {
  const s = { late_fee_cents_per_day: 1000, late_grace_minutes: 60 };
  assert.equal(R.lateFee('2000-01-01 10:00:00', { ...s, late_fee_cents_per_day: 0 }, 'America/New_York').cents, 0);
  assert.equal(R.lateFee('2999-01-01 10:00:00', s, 'America/New_York').cents, 0);
  const r = R.lateFee('2000-01-01 10:00:00', s, 'America/New_York');
  assert.ok(r.days > 1000 && r.cents === r.days * 1000);
});

test('settings: only managers write, values stick', async () => {
  const put = await api('PUT', '/rentals/settings', { token: A.token, body: { late_fee_cents_per_day: 1500, late_grace_minutes: 0, require_binding_record: true, default_deposit_cents: 2000 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.late_fee_cents_per_day, 1500);
  assert.equal(put.body.require_binding_record, true);
  assert.equal((await api('GET', '/rentals/settings', { token: B.token })).body.late_fee_cents_per_day, 0);
});

test('binding record is required for skis and a failed test blocks checkout', async () => {
  const ski = await item(A, `SK-${suffix}`, 'ski', { tier: 'standard' });
  for (const p of [mum, kid]) await api('POST', `/people/${p}/waivers`, { token: A.token, body: {} });
  const due = `${today}T23:59`;
  const no = await api('POST', '/rentals/contracts', { token: A.token, body: { unpaid_reason: 'Test hand-out', person_id: mum, due_at: due, items: [{ rental_item_id: ski }] } });
  assert.equal(no.status, 400);
  const fail = await api('POST', '/rentals/contracts', { token: A.token, body: { unpaid_reason: 'Test hand-out', person_id: mum, due_at: due, items: [{ rental_item_id: ski, din_setting: 5, tech_name: 'Tess', test_result: 'fail' }] } });
  assert.equal(fail.status, 400);
  assert.equal((await api('GET', '/rentals/items', { token: A.token })).body.data.find((i) => i.id === ski).status, 'available');
});

test('group contract needs a waiver for everyone wearing gear; deposit, late fee, damage fee and collection', async () => {
  const ski = await item(A, `SG-${suffix}`, 'ski');
  const boot = await item(A, `BG-${suffix}`, 'boot');
  const stranger = (await api('POST', '/people', { token: A.token, body: { first_name: 'No', last_name: 'Waiver' } })).body.id;
  const due = `${addDays(today, -3)}T10:00`;
  const blocked = await api('POST', '/rentals/contracts', { token: A.token, body: { unpaid_reason: 'Test hand-out', person_id: mum, due_at: due, items: [{ rental_item_id: boot, person_id: stranger }] } });
  assert.equal(blocked.status, 409);
  const ok = await api('POST', '/rentals/contracts', { token: A.token, body: { unpaid_reason: 'Test hand-out', person_id: mum, group_name: 'Renter family', due_at: due, items: [{ rental_item_id: ski, person_id: kid, din_setting: 4.5, tech_name: 'Tess', test_result: 'pass', boot_sole_mm: 290, skier_type: 'I' }, { rental_item_id: boot, person_id: kid }] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const id = ok.body.id;
  const detail = (await api('GET', `/rentals/contracts/${id}`, { token: A.token })).body;
  assert.equal(detail.group_name, 'Renter family');
  assert.equal(detail.deposit_cents, 2000);
  assert.ok(detail.items.every((l) => l.person_id === kid));
  const dep = (await api('GET', `/rentals/contracts/${id}/charges`, { token: A.token })).body.data;
  assert.equal(dep.length, 1); assert.equal(dep[0].kind, 'deposit');

  const back = await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.token, body: { items: [{ rental_item_id: ski, damage_notes: 'Core shot', fee_cents: 4000 }, { rental_item_id: boot }] } });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const kinds = back.body.fees.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['damage', 'late']);
  const charges = (await api('GET', `/rentals/contracts/${id}/charges`, { token: A.token })).body.data;
  const late = charges.find((c) => c.kind === 'late');
  assert.ok(late.cents >= 3 * 1500 && late.cents % 1500 === 0);

  const paid = await api('POST', `/rentals/charges/${late.id}/collect`, { token: A.token, body: { method: 'cash' } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.ok(paid.body.order_id);
  assert.equal((await api('POST', `/rentals/charges/${late.id}/collect`, { token: A.token, body: { method: 'cash' } })).status, 409);
  const dmg = charges.find((c) => c.kind === 'damage');
  assert.equal((await api('POST', `/rentals/charges/${dmg.id}/waive`, { token: A.token, body: { note: 'Goodwill' } })).status, 200);
  assert.equal((await api('GET', '/rentals/charges', { token: A.token })).body.data.some((c) => c.id === dmg.id), false);
});

test('reservations check capacity, convert at pickup and cannot be reused', async () => {
  for (let i = 0; i < 2; i++) await item(A, `HE-${suffix}-${i}`, 'helmet');
  const when = addDays(today, 5);
  const day = { pickup_on: when, days: 2 };
  const av = (await api('GET', `/rentals/availability?from=${when}&days=2`, { token: A.token })).body.data.find((d) => d.category === 'helmet');
  assert.equal(av.free, 2);
  const r1 = await api('POST', '/rentals/reservations', { token: A.token, body: { person_id: mum, ...day, lines: [{ category: 'helmet', quantity: 2 }] } });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const r2 = await api('POST', '/rentals/reservations', { token: A.token, body: { person_id: kid, ...day, lines: [{ category: 'helmet', quantity: 1 }] } });
  assert.equal(r2.status, 409);
  assert.equal((await api('GET', `/rentals/availability?from=${addDays(when, 3)}&days=1`, { token: A.token })).body.data.find((d) => d.category === 'helmet').free, 2);
  assert.equal((await api('PATCH', `/rentals/reservations/${r1.body.id}`, { token: A.token, body: { status: 'no_show' } })).status, 200);
  assert.equal((await api('PATCH', `/rentals/reservations/${r1.body.id}`, { token: A.token, body: { status: 'cancelled' } })).status, 409);
  const r3 = await api('POST', '/rentals/reservations', { token: A.token, body: { person_id: kid, ...day, lines: [{ category: 'helmet', quantity: 1 }] } });
  assert.equal(r3.status, 201);
  const helmets = (await api('GET', '/rentals/items?category=helmet', { token: A.token })).body.data;
  const out = await api('POST', '/rentals/contracts', { token: A.token, body: { unpaid_reason: 'Test hand-out', person_id: kid, reservation_id: r3.body.id, due_at: `${when}T17:00`, items: [{ rental_item_id: helmets[0].id }] } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const again = await api('POST', '/rentals/contracts', { token: A.token, body: { unpaid_reason: 'Test hand-out', person_id: kid, reservation_id: r3.body.id, due_at: `${when}T17:00`, items: [{ rental_item_id: helmets[1].id }] } });
  assert.equal(again.status, 409);
  assert.equal((await api('GET', `/rentals/reservations/${r3.body.id}`, { token: A.token })).body.status, 'picked_up');
});

test('extend and swap', async () => {
  const p1 = await item(A, `PO1-${suffix}`, 'pole'); const p2 = await item(A, `PO2-${suffix}`, 'pole');
  const c = await api('POST', '/rentals/contracts', { token: A.token, body: { unpaid_reason: 'Test hand-out', person_id: mum, deposit_cents: 0, due_at: `${addDays(today, 1)}T10:00`, items: [{ rental_item_id: p1 }] } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await api('POST', `/rentals/contracts/${c.body.id}/extend`, { token: A.token, body: { due_at: `${today}T08:00` } })).status, 400);
  assert.equal((await api('POST', `/rentals/contracts/${c.body.id}/extend`, { token: A.token, body: { due_at: `${addDays(today, 2)}T10:00` } })).status, 200);
  const sw = await api('POST', `/rentals/contracts/${c.body.id}/swap`, { token: A.token, body: { out_item_id: p1, damaged: true, reason: 'Bent', replacement: { rental_item_id: p2 } } });
  assert.equal(sw.status, 200, JSON.stringify(sw.body));
  const items = (await api('GET', '/rentals/items', { token: A.token })).body.data;
  assert.equal(items.find((i) => i.id === p1).status, 'maintenance');
  assert.equal(items.find((i) => i.id === p2).status, 'rented');
  const svc = await api('POST', `/rentals/items/${p1}/service`, { token: A.token, body: { kind: 'repair', notes: 'Straightened', return_to_rack: true } });
  assert.equal(svc.status, 201);
  assert.equal((await api('GET', `/rentals/items/${p1}/history`, { token: A.token })).body.service.length, 1);
  assert.equal((await api('GET', '/rentals/items', { token: A.token })).body.data.find((i) => i.id === p1).status, 'available');
});

test('binding chart is advisory and holds only what the shop entered', async () => {
  assert.equal((await api('GET', '/rentals/chart', { token: A.token })).body.data.length, 0);
  const put = await api('PUT', '/rentals/chart', { token: A.token, body: { rows: [{ skier_type: 'II', weight_lb_min: 100, weight_lb_max: 150, din: 7 }] } });
  assert.equal(put.status, 200);
  const hit = await api('GET', '/rentals/chart/suggest?skier_type=II&weight_lb=120', { token: A.token });
  assert.equal(hit.body.data[0].din, 7);
  assert.equal((await api('GET', '/rentals/chart/suggest?skier_type=II&weight_lb=200', { token: A.token })).body.data.length, 0);
  assert.equal((await api('GET', '/rentals/chart', { token: B.token })).body.data.length, 0);
});

test('scan lookup, import, reports and isolation', async () => {
  const sku = `SC-${suffix}`;
  await item(A, sku, 'other');
  assert.equal((await api('GET', `/rentals/lookup?code=${sku}`, { token: A.token })).body.item.sku, sku);
  assert.equal((await api('GET', `/rentals/lookup?code=${sku}`, { token: B.token })).status, 404);
  const imp = await api('POST', '/rentals/items/import', { token: A.token, body: { rows: [{ sku, category: 'other' }, { sku: `IM-${suffix}`, category: 'ski', tier: 'performance', boot_sole_mm: 305 }] } });
  assert.deepEqual([imp.body.added, imp.body.skipped], [1, [sku]]);
  const rep = await api('GET', '/rentals/reports', { token: A.token });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.ok(rep.body.contracts >= 3);
  assert.ok(rep.body.fees.some((f) => f.kind === 'late'));
  assert.equal((await api('GET', '/rentals/reports', { token: B.token })).body.contracts, 0);
  assert.equal((await api('GET', `/rentals/profiles/${mum}`, { token: B.token })).status, 404);
  const prof = await api('PUT', `/rentals/profiles/${mum}`, { token: A.token, body: { skier_type: 'II', boot_sole_mm: 305, helmet_size: 'M' } });
  assert.equal(prof.status, 200);
  assert.equal((await api('GET', `/rentals/profiles/${mum}`, { token: A.token })).body.profile.boot_sole_mm, 305);
  assert.equal((await api('PUT', `/rentals/profiles/${mum}`, { token: B.token, body: { skier_type: 'I' } })).status, 404);
});
