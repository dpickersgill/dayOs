'use strict';

// Rentals round 2, the fitting track: sell a rental with no gear, Ready to fit, the fitting card (details, binding
// suggestion from this person's details, the signed confirmation), handing out, stations, the gear picker past 500 pieces,
// what's left, the agreement, online rentals, refunds and the manager-only unpaid hand-out.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const F = require('../src/lib/rentalfit');

let server; let base;
const suffix = Date.now().toString(36) + Math.floor(Math.random() * 100);
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const q = async (sql, params) => (await pool.query(sql, params))[0];
// a tiny valid PNG data URL, the shape the signature pad sends
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
async function mountain(slug) {
  const t = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `o@${slug}.test`, password: PW, first_name: 'O', last_name: 'O' } }) });
  assert.equal(t.status, 201);
  const l = await api('POST', '/auth/login', { body: { tenant: slug, email: `o@${slug}.test`, password: PW } });
  const tid = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  return { slug, token: l.body.token, tid };
}
async function addUser(m, email, role) {
  assert.equal((await api('POST', '/users', { token: m.token, body: { email, password: PW, role } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const item = async (t, sku, category, extra = {}) => (await api('POST', '/rentals/items', { token: t.token, body: { sku, category, ...extra } })).body.id;
const ADULT = { date_of_birth: '1985-03-02', sex: 'female' };
const sell = (token, body) => api('POST', '/checkout', { token, body: { channel: 'window', ...body } });

let A; let B; let counterTok; let pkg; let seasonPkg;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`fit-a-${suffix}`);
  B = await mountain(`fit-b-${suffix}`);
  counterTok = await addUser(A, `counter@fit-a-${suffix}.test`, 'counter');
  pkg = (await api('POST', '/products', { token: A.token, body: { kind: 'rental', name: 'Adult Ski Package', base_price_cents: 4500 } })).body.id;
  seasonPkg = (await api('POST', '/products', { token: A.token, body: { kind: 'rental', name: 'Junior Season Ski', base_price_cents: 19900 } })).body.id;
  await q("UPDATE products SET rental_kind = 'season' WHERE id = ?", [seasonPkg]);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('due back comes from closing time, and season rentals from the return date', () => {
  const s = { closing_time: '16:00', season_return_md: '04-15' };
  assert.equal(F.dueFor(s, 'day', '2026-12-20', 1), '2026-12-20 16:00:00');
  assert.equal(F.dueFor(s, 'day', '2026-12-20', 3), '2026-12-22 16:00:00');
  assert.equal(F.dueFor(s, 'season', '2026-12-20'), '2027-04-15 16:00:00');
  assert.equal(F.dueFor(s, 'season', '2027-02-01'), '2027-04-15 16:00:00');
  assert.equal(F.typeOf('II'), '2');
  assert.deepEqual(F.mismatch({ weight_lb: 150, skier_type: '2' }, { weight_lb: 150, skier_type: 'II', height_in: 66 }), []);
  assert.deepEqual(F.mismatch({ weight_lb: 150 }, { weight_lb: 170 }), ['weight_lb']);
});

test('fitting settings: defaults, managers only, kept per mountain', async () => {
  const s = (await api('GET', '/rentals/fit/settings', { token: counterTok })).body;
  assert.equal(s.layout, 'counter'); assert.equal(s.closing_time, '16:30'); assert.equal(s.require_signoff, true); assert.equal(s.signoff_valid_days, 1);
  assert.equal((await api('PUT', '/rentals/fit/settings', { token: counterTok, body: { layout: 'stations' } })).status, 403);
  assert.equal((await api('PUT', '/rentals/fit/settings', { token: A.token, body: { closing_time: '25:00' } })).status, 400);
  const put = await api('PUT', '/rentals/fit/settings', { token: A.token, body: { closing_time: '16:00', layout: 'stations', signoff_valid_days: 2 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.closing_time, '16:00'); assert.equal(put.body.layout, 'stations');
  // the old settings form still saves without touching these
  assert.equal((await api('PUT', '/rentals/settings', { token: A.token, body: { late_fee_cents_per_day: 1000 } })).status, 200);
  assert.equal((await api('GET', '/rentals/fit/settings', { token: A.token })).body.layout, 'stations');
  assert.equal((await api('GET', '/rentals/fit/settings', { token: B.token })).body.layout, 'counter');
});

let order1; let contractId; let renterId;
test('Sell: a rental with no gear is paid and ready to fit, never out', async () => {
  const r = await sell(counterTok, {
    customer: { details: { first_name: 'Rhea', last_name: 'Fitter', email: 'rhea@fit.test', phone: '6105550101', ...ADULT }, sign_waiver: true },
    lines: [{ type: 'rental', product_id: pkg, tier: 'adult' }, { type: 'rental', product_id: seasonPkg, tier: 'adult' }],
    payments: [{ tender: 'cash', amount_cents: 24400 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  order1 = r.body.id;
  assert.equal(r.body.rentals.length, 2);
  assert.ok(r.body.rentals.every((x) => x.status === 'to_fit' && x.items.length === 0));
  const cs = await q('SELECT * FROM rental_contracts WHERE order_id = ? ORDER BY id', [order1]);
  assert.equal(cs[0].status, 'to_fit'); assert.equal(cs[0].kind, 'day'); assert.equal(cs[0].stage, 'form'); assert.equal(String(cs[0].valid_on), today);
  assert.equal(String(cs[0].due_at), `${today} 16:00:00`);
  assert.equal(cs[1].kind, 'season'); assert.match(String(cs[1].due_at), /-04-15 16:00:00$/);
  assert.ok(cs[0].order_item_id);
  contractId = cs[0].id; renterId = cs[0].person_id;
  // not out, not overdue
  const out = (await api('GET', '/rentals/contracts?status=out', { token: counterTok })).body.data;
  assert.ok(!out.some((c) => c.order_id === order1));
  assert.ok(!(await api('GET', '/rentals/contracts?overdue=true', { token: counterTok })).body.data.some((c) => c.order_id === order1));
  // Ready to fit: search by name, phone and order number
  for (const needle of ['rhea', 'Fitter', '0101', `ORD-${order1}`, String(order1)]) {
    const ready = (await api('GET', `/rentals/fit/ready?q=${encodeURIComponent(needle)}`, { token: counterTok })).body.data;
    assert.ok(ready.some((c) => c.id === contractId), needle);
  }
  const ready = (await api('GET', '/rentals/fit/ready', { token: counterTok })).body.data.find((c) => c.id === contractId);
  assert.equal(ready.product_name, 'Adult Ski Package'); assert.equal(ready.tier, 'adult');
  assert.equal((await api('GET', '/rentals/fit/ready?q=rhea', { token: B.token })).body.data.length, 0, 'another mountain sees nothing');
  // scanning the receipt finds both
  const found = (await api('GET', `/rentals/fit/find?code=ORD-${order1}`, { token: counterTok })).body;
  assert.equal(found.ready.length, 2);
});

test('stations: done here moves along the queue; the board shows first names only', async () => {
  const s1 = await api('POST', `/rentals/fit/contracts/${contractId}/stage`, { token: counterTok, body: {} });
  assert.equal(s1.body.stage, 'boots');
  assert.ok((await api('GET', '/rentals/fit/ready?stage=boots', { token: counterTok })).body.data.some((c) => c.id === contractId));
  assert.ok(!(await api('GET', '/rentals/fit/ready?stage=form', { token: counterTok })).body.data.some((c) => c.id === contractId));
  await api('POST', `/rentals/fit/contracts/${contractId}/stage`, { token: counterTok, body: {} });
  assert.equal((await api('POST', `/rentals/fit/contracts/${contractId}/stage`, { token: counterTok, body: {} })).body.stage, 'door');
  assert.equal((await api('POST', `/rentals/fit/contracts/${contractId}/stage`, { token: counterTok, body: {} })).status, 409, 'door is the last station');
  const board = (await api('GET', '/rentals/fit/board', { token: counterTok })).body;
  assert.equal(board.stages.length, 4);
  const door = board.stages.find((s) => s.stage === 'door');
  assert.equal(door.next[0].name, 'Rhea F.');
});

let ski; let boot;
test('fitting card: details save to the person; the binding suggestion uses only today\'s details', async () => {
  await api('PUT', '/rentals/chart', { token: A.token, body: { rows: [
    { skier_type: 'I', weight_lb_min: 100, weight_lb_max: 160, din: 4 },
    { skier_type: '2', weight_lb_min: 100, weight_lb_max: 160, height_in_min: 60, height_in_max: 66, din: 4.5 },
    { skier_type: '2', weight_lb_min: 161, weight_lb_max: 220, height_in_min: 67, height_in_max: 74, din: 6.5 },
  ] } });
  await q('INSERT INTO binding_chart (tenant_id, skier_type, weight_lb_min, weight_lb_max, din, age_min, age_max) VALUES (?, ?, ?, ?, ?, ?, ?)', [A.tid, '2', 100, 220, 3.5, 50, null]);
  const card = (await api('GET', `/rentals/fit/contracts/${contractId}`, { token: counterTok })).body;
  assert.equal(card.person.first_name, 'Rhea'); assert.equal(card.contract.product_name, 'Adult Ski Package'); assert.equal(card.signoff, null);
  const saved = await api('PUT', `/rentals/fit/people/${renterId}`, { token: counterTok, body: { weight_lb: 170, height_in: 70, boot_sole_mm: 305, skier_type: '2', stance: 'regular', boot_size: '26.5' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.details.weight_lb, 170); assert.equal(saved.body.details.boot_sole_mm, 305);
  assert.equal((await q('SELECT boot_sole_mm FROM rental_profiles WHERE person_id = ?', [renterId]))[0].boot_sole_mm, 305);
  // weight and height both on the 6.5 row
  let s = (await api('GET', '/rentals/fit/suggest?weight_lb=170&height_in=70&skier_type=2&sole_mm=305&date_of_birth=1985-03-02', { token: counterTok })).body;
  assert.equal(s.din, 6.5);
  // the lower of weight and height when both match
  s = (await api('GET', '/rentals/fit/suggest?weight_lb=170&height_in=64&skier_type=2&date_of_birth=1985-03-02', { token: counterTok })).body;
  assert.equal(s.din, 4.5);
  // an age row wins for a skier it covers
  s = (await api('GET', '/rentals/fit/suggest?weight_lb=170&skier_type=2&date_of_birth=1960-01-01', { token: counterTok })).body;
  assert.equal(s.din, 3.5);
  // Roman numerals in the chart match the same type
  assert.equal((await api('GET', '/rentals/fit/suggest?weight_lb=150&skier_type=1', { token: counterTok })).body.din, 4);
  // nothing without ability or a weight or height
  assert.equal((await api('GET', '/rentals/fit/suggest?weight_lb=150', { token: counterTok })).body.din, null);
  ski = await item(A, `FS-${suffix}`, 'ski', { size: '160' });
  boot = await item(A, `FB-${suffix}`, 'boot', { size: '26.5' });
  // the old Sell pre-fill source is gone from the card: no last setting is offered anywhere on it
  assert.equal(card.last_din, undefined);
});

test('hand out: skis need the signed confirmation, and it must match the card', async () => {
  const gear = [{ rental_item_id: ski, din_setting: 6.5, tech_name: 'Tess', test_result: 'pass' }, { rental_item_id: boot }];
  const no = await api('POST', `/rentals/contracts/${contractId}/handout`, { token: counterTok, body: { items: gear } });
  assert.equal(no.status, 409); assert.match(no.body.error.message || no.body.error, /signed/);
  // a minor cannot sign for themself (checked on a child below); an adult signs for self
  const details = { weight_lb: 170, height_in: 70, boot_sole_mm: 305, skier_type: '2', date_of_birth: '1985-03-02' };
  const sig = await api('POST', '/rentals/fit/signoffs', { token: counterTok, body: { person_id: renterId, signer_name: 'Rhea Fitter', signer_relation: 'self', signature: SIG, details } });
  assert.equal(sig.status, 201, JSON.stringify(sig.body));
  assert.equal((await api('POST', '/rentals/fit/signoffs', { token: counterTok, body: { person_id: renterId, signer_name: 'R', signature: SIG, details } })).status, 400, 'a name');
  assert.equal((await api('POST', '/rentals/fit/signoffs', { token: counterTok, body: { person_id: renterId, signer_name: 'Rhea', signature: 'data:text/html,x', details } })).status, 400, 'a PNG');
  // the weight changed after signing: sign again
  await api('PUT', `/rentals/fit/people/${renterId}`, { token: counterTok, body: { weight_lb: 150 } });
  const changed = await api('POST', `/rentals/contracts/${contractId}/handout`, { token: counterTok, body: { items: gear } });
  assert.equal(changed.status, 409); assert.match(JSON.stringify(changed.body), /changed since they signed/);
  await api('PUT', `/rentals/fit/people/${renterId}`, { token: counterTok, body: { weight_lb: 170 } });
  const card = (await api('GET', `/rentals/fit/contracts/${contractId}`, { token: counterTok })).body;
  assert.ok(card.signoff && card.signoff.mismatch.length === 0);
  const ok = await api('POST', `/rentals/contracts/${contractId}/handout`, { token: counterTok, body: { items: gear, deposit_cents: 5000 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'out');
  const c = (await q('SELECT * FROM rental_contracts WHERE id = ?', [contractId]))[0];
  assert.equal(c.status, 'out'); assert.equal(c.stage, null); assert.equal(c.deposit_cents, 5000); assert.equal(c.deposit_mode, 'note');
  assert.equal((await q("SELECT COUNT(*) AS n FROM rental_charges WHERE contract_id = ? AND kind = 'deposit'", [contractId]))[0].n, 1);
  assert.equal((await q('SELECT contract_id FROM rental_signoffs WHERE id = ?', [sig.body.id]))[0].contract_id, contractId);
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [ski]))[0].status, 'rented');
  assert.equal((await api('POST', `/rentals/contracts/${contractId}/handout`, { token: counterTok, body: { items: [{ rental_item_id: boot }] } })).status, 409, 'only once');
  assert.ok((await api('GET', '/rentals/contracts?status=out', { token: counterTok })).body.data.some((x) => x.id === contractId));
  // the printed agreement has the person, their signature and the gear with its setting
  const ag = (await api('GET', `/rentals/fit/contracts/${contractId}/agreement`, { token: counterTok })).body;
  assert.equal(ag.people.length, 1); assert.equal(ag.people[0].signoff.signature, SIG);
  assert.equal(Number(ag.people[0].items.find((i) => i.category === 'ski').din_setting), 6.5);
  assert.equal(ag.contract.deposit_cents, 5000);
});

test('a signoff from the guest rental form (no contract) counts the same', async () => {
  const kid = (await api('POST', '/people', { token: A.token, body: { first_name: 'Kip', last_name: 'Fitter', date_of_birth: '2016-05-05', weight_lb: 70 } })).body.id;
  // a child does not sign for themself at the counter
  assert.equal((await api('POST', '/rentals/fit/signoffs', { token: counterTok, body: { person_id: kid, signer_name: 'Kip Fitter', signer_relation: 'self', signature: SIG, details: { weight_lb: 70 } } })).status, 400);
  await q("INSERT INTO rental_signoffs (tenant_id, person_id, signer_name, signer_relation, details, signature, via) VALUES (?, ?, 'Rhea Fitter', 'parent', ?, ?, 'form')", [A.tid, kid, JSON.stringify({ weight_lb: 70, skier_type: '1' }), SIG]);
  const v = await F.validSignoff(pool, A.tid, kid, { weight_lb: 70, skier_type: 'I' });
  assert.ok(v && v.mismatch.length === 0 && v.signoff.via === 'form');
});

test('a form filled in the night before counts on the rental day; set-aside group gear goes out with the contract', async () => {
  const kid = (await api('POST', '/people', { token: A.token, body: { first_name: 'Gus', last_name: 'Group', date_of_birth: '2015-01-01' } })).body.id;
  await q("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_name, method) VALUES (?, ?, ?, 'general', 'Pat Group', 'recorded_by_staff')", [A.tid, kid, require('../src/lib/util').seasonFor(today)]);
  const [f] = await pool.query("INSERT INTO rental_forms (tenant_id, contact_name, rental_on, people, status) VALUES (?, 'Pat Group', ?, '[]', 'used')", [A.tid, today]);
  await q("INSERT INTO rental_signoffs (tenant_id, person_id, form_id, signer_name, signer_relation, details, signature, via, signed_at) VALUES (?, ?, ?, 'Pat Group', 'parent', ?, ?, 'form', DATE_SUB(NOW(), INTERVAL 3 DAY))", [A.tid, kid, f.insertId, JSON.stringify({ weight_lb: 80, skier_type: '1' }), SIG]);
  await api('PUT', `/rentals/fit/people/${kid}`, { token: counterTok, body: { weight_lb: 80, skier_type: '1' } });
  const v = await F.validSignoff(pool, A.tid, kid, { weight_lb: 80, skier_type: '1' });
  assert.ok(v && !v.mismatch.length, 'a form for today counts though it was signed days ago');
  // a group contract with gear set aside the night before
  const gski = await item(A, `GS-${suffix}`, 'ski', { size: '110' });
  // the group's billing is recorded (a manager's note), so its gear can go out
  const [grp] = await pool.query("INSERT INTO rental_groups (tenant_id, name, rental_on, billing_note, billing_at) VALUES (?, 'Gus club', ?, 'Invoice to the club', NOW())", [A.tid, today]);
  const [gc] = await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, status, stage, valid_on, due_at, group_id) VALUES (?, ?, 'to_fit', 'set', ?, ?, ?)", [A.tid, kid, today, `${today} 16:00:00`, grp.insertId]);
  await q('INSERT INTO rental_contract_items (tenant_id, contract_id, rental_item_id, person_id, din_setting, tech_name, test_result) VALUES (?, ?, ?, ?, 3, \'Tess\', \'pass\')', [A.tid, gc.insertId, gski, kid]);
  await q("UPDATE rental_items SET status = 'set_aside' WHERE id = ?", [gski]);
  assert.ok((await api('GET', '/rentals/fit/ready?q=Gus', { token: counterTok })).body.data.some((x) => x.id === gc.insertId));
  const out = await api('POST', `/rentals/contracts/${gc.insertId}/handout`, { token: counterTok, body: { items: [] } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [gski]))[0].status, 'rented');
  assert.equal((await q('SELECT COUNT(*) AS n FROM rental_contract_items WHERE contract_id = ?', [gc.insertId]))[0].n, 1, 'no second line for the same ski');
});

test('handing out with nothing paid: counter is sent to Sell, a manager gives a reason', async () => {
  const p = (await api('POST', '/people', { token: A.token, body: { first_name: 'Una', last_name: 'Paid' } })).body.id;
  await q("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_name, method) VALUES (?, ?, ?, 'general', 'Una Paid', 'recorded_by_staff')", [A.tid, p, require('../src/lib/util').seasonFor(today)]);
  const helmet = await item(A, `FH-${suffix}`, 'helmet');
  const body = { person_id: p, due_at: `${today}T16:00`, items: [{ rental_item_id: helmet }] };
  const c = await api('POST', '/rentals/contracts', { token: counterTok, body });
  assert.equal(c.status, 403); assert.match(JSON.stringify(c.body), /Sell the rental first/);
  assert.equal((await api('POST', '/rentals/contracts', { token: A.token, body })).status, 400, 'a reason is required');
  const ok = await api('POST', '/rentals/contracts', { token: A.token, body: { ...body, unpaid_reason: 'Card machine down, paying later' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const row = (await q('SELECT unpaid_reason, unpaid_by FROM rental_contracts WHERE id = ?', [ok.body.id]))[0];
  assert.equal(row.unpaid_reason, 'Card machine down, paying later'); assert.ok(row.unpaid_by);
  const a = (await q("SELECT detail FROM audit_log WHERE entity = 'rental_contracts' AND entity_id = ? AND action = 'checkout'", [ok.body.id]))[0];
  assert.match(JSON.stringify(a.detail), /Card machine down/);
});

test('Sell with gear: the fitting card signoff rides along and the contract goes straight out', async () => {
  const ski2 = await item(A, `FS2-${suffix}`, 'ski', { size: '150' });
  const base_ = {
    customer: { details: { first_name: 'Gil', last_name: 'Geared', email: 'gil@fit.test', ...ADULT }, sign_waiver: true },
    payments: [{ tender: 'cash', amount_cents: 4500 }],
  };
  const noSig = await sell(counterTok, { ...base_, lines: [{ type: 'rental', product_id: pkg, items: [{ rental_item_id: ski2, din_setting: 5 }] }] });
  assert.equal(noSig.status, 409, JSON.stringify(noSig.body));
  const fit = { weight_lb: 150, height_in: 66, skier_type: '2', boot_sole_mm: 300 };
  const r = await sell(counterTok, { ...base_, lines: [{ type: 'rental', product_id: pkg, items: [{ rental_item_id: ski2, din_setting: 5 }], fit, signoff: { signer_name: 'Gil Geared', signer_relation: 'self', signature: SIG, details: fit } }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.rentals[0].status, 'out');
  const c = (await q('SELECT * FROM rental_contracts WHERE id = ?', [r.body.rentals[0].contract_id]))[0];
  assert.equal(c.status, 'out'); assert.equal(String(c.due_at), `${today} 16:00:00`); assert.ok(c.order_item_id);
  assert.equal((await q('SELECT COUNT(*) AS n FROM rental_signoffs WHERE contract_id = ?', [c.id]))[0].n, 1);
  assert.equal((await q('SELECT weight_lb FROM people WHERE id = ?', [c.person_id]))[0].weight_lb, 150);
});

test('the gear picker pages past 500 pieces, with counts by size, and what is left', async () => {
  const vals = [];
  for (let i = 0; i < 520; i++) vals.push([A.tid, `BULK-${suffix}-${i}`, 'pole', String(100 + (i % 4) * 5), i < 10 ? 'maintenance' : 'available']);
  await pool.query('INSERT INTO rental_items (tenant_id, sku, category, size, status) VALUES ?', [vals]);
  const p1 = (await api('GET', '/rentals/fit/gear?category=pole&limit=200', { token: counterTok })).body;
  assert.equal(p1.total, 510); assert.equal(p1.data.length, 200);
  const p3 = (await api('GET', '/rentals/fit/gear?category=pole&limit=200&offset=400', { token: counterTok })).body;
  assert.equal(p3.data.length, 110);
  assert.deepEqual(p1.sizes.map((s) => s.size), ['100', '105', '110', '115']);
  assert.equal(p1.sizes.reduce((a, s) => a + s.free, 0), 510); assert.equal(p1.sizes.reduce((a, s) => a + s.service, 0), 10);
  assert.equal((await api('GET', '/rentals/fit/gear?category=pole&size=105', { token: counterTok })).body.total, 130 - p1.sizes.find((s) => s.size === '105').service);
  assert.equal((await api('GET', `/rentals/fit/gear?q=BULK-${suffix}-51`, { token: counterTok })).body.total, 11);
  const left = (await api('GET', '/rentals/fit/left', { token: counterTok })).body.data;
  const poles = left.find((x) => x.category === 'pole');
  assert.equal(poles.free, 510); assert.equal(poles.service, 10);
  assert.ok(left.find((x) => x.category === 'ski').out_now >= 2);
  assert.equal((await api('GET', '/rentals/fit/gear?category=pole', { token: B.token })).body.total, 0);
});

test('online rentals wait in Ready to fit; a refund takes a not-yet-fitted rental off the list', async () => {
  await q('UPDATE products SET online = 1 WHERE id = ?', [pkg]);
  const S = require('../src/lib/shopsale');
  const conn = await pool.getConnection();
  let out;
  try {
    await conn.beginTransaction();
    const tenant = (await conn.query('SELECT * FROM tenants WHERE id = ?', [A.tid]))[0][0];
    const quote = await S.quote(conn, tenant, [], { addons: [{ product_id: pkg, quantity: 2 }] });
    const row = { id: 0, basket: JSON.stringify({ quote, contact: { first_name: 'Olly', last_name: 'Online' } }), contact_email: 'olly@fit.test', contact_phone: null, contact_name: 'Olly Online', waiver_accepted: 0, news_opt_in: 0 };
    out = await S.fulfil(conn, A.tid, row, { paymentIntent: 'pi_test_fit' });
    await conn.commit();
  } finally { conn.release(); }
  const cs = await q('SELECT * FROM rental_contracts WHERE order_id = ?', [out.orderId]);
  assert.equal(cs.length, 2);
  assert.ok(cs.every((c) => c.status === 'to_fit' && String(c.valid_on) === today && c.order_item_id));
  assert.ok((await api('GET', '/rentals/fit/ready?q=Olly', { token: counterTok })).body.data.length === 2);
  // a rental sold at the window and refunded before anyone fitted it leaves the list
  const sold = await sell(counterTok, { customer: { details: { first_name: 'Rory', last_name: 'Refund', email: 'rory@fit.test', ...ADULT } }, lines: [{ type: 'rental', product_id: pkg }], payments: [{ tender: 'cash', amount_cents: 4500 }] });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  assert.equal((await api('GET', '/rentals/fit/ready?q=Rory', { token: counterTok })).body.data.length, 1);
  const ref = await api('POST', `/orders/${sold.body.id}/refund`, { token: A.token, body: { reason: 'customer_request', method: 'cash' } });
  assert.equal(ref.status, 200, JSON.stringify(ref.body));
  assert.equal((await api('GET', '/rentals/fit/ready?q=Rory', { token: counterTok })).body.data.length, 0);
});

test('a manager clears a rental nobody picked up', async () => {
  const c = (await q("SELECT id FROM rental_contracts WHERE order_id = ? AND kind = 'season'", [order1]))[0].id;
  assert.equal((await api('POST', `/rentals/fit/contracts/${c}/cancel`, { token: counterTok, body: { reason: 'No show' } })).status, 403);
  assert.equal((await api('POST', `/rentals/fit/contracts/${c}/cancel`, { token: A.token, body: { reason: 'No show today' } })).status, 200);
  assert.equal((await q('SELECT status FROM rental_contracts WHERE id = ?', [c]))[0].status, 'cancelled');
});
