'use strict';

// Guests, round 2 (2026.11.8), Track WINDOW: the welcome-back card, scan to find, day tickets with only a name, typed
// quantities, group prices and rosters, the counter's refund limit, change day at the window, rewards at the window and
// goodwill credits. Postmark is a mock server.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const WIN = require('../src/lib/windowsale');

let server; let base; let pmMock; const mails = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const year = Number(today.slice(0, 4));
const DEVICE = 'test-device-0123456789abcdef';
async function call(prefix, method, p, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${p}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
async function user(m, role) {
  const email = `${role}-${Math.floor(Math.random() * 1e6)}@${m.slug}.test`;
  assert.equal((await api('POST', '/users', { token: m.owner, body: { email, password: PW, role } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const person = async (body) => { const r = await api('POST', '/people', { token: A.owner, body }); assert.equal(r.status, 201, r.text); return r.body; };

let A; let counter; let manager; let dayP; let passP; let lessonP;
const ticketLine = (extra = {}) => ({ type: 'ticket', product_id: dayP, quantity: 1, ...extra });

test.before(async () => {
  pmMock = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`g2win-${suffix}`);
  counter = await user(A, 'counter');
  manager = await user(A, 'manager');
  const mk = async (b) => { const r = await api('POST', '/products', { token: A.owner, body: b }); assert.equal(r.status, 201, r.text); return r.body.id; };
  dayP = await mk({ kind: 'day_ticket', name: 'All-day lift ticket', base_price_cents: 8000 });
  assert.equal((await api('PUT', `/products/${dayP}/tiers`, { token: A.owner, body: { tiers: [{ tier: 'child', price_cents: 5000 }] } })).status, 200);
  passP = await mk({ kind: 'season_pass', name: 'Season pass', base_price_cents: 50000, valid_days: 150 });
  lessonP = await mk({ kind: 'lesson', name: 'Group lesson', base_price_cents: 6000 });
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

// ---------------------------------------------------------------- the welcome-back card
test('welcome back: visits, pass, birthday this week, the family\'s lessons and rental sizes, rewards, one line; never medical notes', async () => {
  const bday = plus(today, 3);
  const pat = await person({ first_name: 'Pat', last_name: 'Rivera', email: `pat${suffix}@x.test`, date_of_birth: `1985-${bday.slice(5)}` });
  const ava = await person({ first_name: 'Ava', last_name: 'Rivera', date_of_birth: `${year - 8}-03-04` });
  assert.equal((await api('POST', `/people/${pat.id}/family`, { token: A.owner, body: { other_id: ava.id, relation: 'guardian', as: 'guardian_of' } })).status, 201);
  // two days skied this season (good scans), one on a pass
  const [o] = await pool.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, total_cents, channel) VALUES (?, ?, 'paid', 50000, 50000, 'window')", [A.id, pat.id]);
  const [oi] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, person_id, unit_price_cents) VALUES (?, ?, ?, ?, 50000)", [A.id, o.insertId, passP, pat.id]);
  const [tk] = await pool.query("INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')", [A.id, oi.insertId, pat.id, passP, `PASS${suffix}`.toUpperCase().slice(0, 20), plus(today, -20), plus(today, 120)]);
  for (const d of [plus(today, -10), plus(today, -5)]) await pool.query("INSERT INTO scans (tenant_id, ticket_id, code, result, scanned_at) VALUES (?, ?, 'X', 'ok', ?)", [A.id, tk.insertId, `${d} 15:00:00`]);
  // Ava's second lesson (level 3), with allergies and medical notes the card must never show
  for (const [k, d] of [[1, plus(today, -9)], [2, plus(today, -3)]]) {
    const [s] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, starts_at, ends_at, capacity, status) VALUES (?, ?, 'ski', ?, ?, 6, 'scheduled')", [A.id, lessonP, `${d} 10:00:00`, `${d} 12:00:00`]);
    await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, level, allergies, medical) VALUES (?, ?, ?, 'attended', ?, 'PEANUT-SECRET', 'EPIPEN-SECRET')", [A.id, s.insertId, ava.id, k + 1]);
  }
  // her usual rental: 120 cm skis and 21.5 boots
  const [c] = await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, status, checked_out_at, due_at, kind) VALUES (?, ?, 'returned', ?, ?, 'day')", [A.id, ava.id, `${plus(today, -3)} 09:00:00`, `${plus(today, -3)} 16:00:00`]);
  for (const [cat, size] of [['ski', '120'], ['boot', '21.5']]) {
    const [it] = await pool.query("INSERT INTO rental_items (tenant_id, sku, category, size, status) VALUES (?, ?, ?, ?, 'available')", [A.id, `${cat}-${suffix}`, cat, size]);
    await pool.query('INSERT INTO rental_contract_items (tenant_id, contract_id, rental_item_id, person_id) VALUES (?, ?, ?, ?)', [A.id, c.insertId, it.insertId, ava.id]);
  }
  // a goodwill credit: managers only
  assert.equal((await api('POST', `/guests/people/${pat.id}/goodwill`, { token: counter, body: { reason: 'Lift stopped', credit_cents: 2000 } })).status, 403, 'counter staff cannot give goodwill');
  const gw = await api('POST', `/guests/people/${pat.id}/goodwill`, { token: manager, body: { reason: 'Lift stopped for an hour', credit_cents: 2000 } });
  assert.equal(gw.status, 201, gw.text); assert.equal(gw.body.kind, 'goodwill'); assert.equal(gw.body.options.credit.cents, 2000);
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'goodwill' AND entity_id = ?", [A.id, gw.body.id])).length, 'audited');

  const t0 = Date.now();
  const r = await api('GET', `/guests/people/${pat.id}/welcome`, { token: counter });
  const ms = Date.now() - t0;
  assert.equal(r.status, 200, r.text);
  const w = r.body;
  assert.equal(w.visits.this_season, 2); assert.equal(w.visits.last_day, plus(today, -5)); assert.equal(w.visits.visit_today, 3);
  assert.equal(w.pass.product, 'Season pass'); assert.equal(w.pass.active, true);
  assert.equal(w.birthday_this_week.on, bday); assert.equal(w.birthday_this_week.turning, year - 1985 + (bday.slice(0, 4) > today.slice(0, 4) ? 1 : 0));
  const a = w.family.find((f) => f.first_name === 'Ava');
  assert.equal(a.relation, 'child'); assert.equal(a.last_lesson.level, 3); assert.equal(a.last_lesson.nth, 2);
  assert.match(a.line, /Ava's second lesson: .* \(Level 3\)\. Usual rental: 120 cm skis, boots 21\.5\./);
  assert.equal(w.rewards.length, 1); assert.match(w.rewards[0].words, /20\.00 credit/);
  assert.ok(Array.isArray(w.badges));
  assert.match(w.line, /^Welcome back, Pat\. .*Happy early birthday!$/);
  assert.doesNotMatch(r.text, /SECRET|allerg|medical/i, 'no allergy or medical notes on the card');
  assert.ok(ms < 1500, `the card took ${ms} ms`);
  // the gate: a compact welcome on a good scan
  const g = await api('POST', '/tickets/scan', { token: counter, body: { code: `PASS${suffix}`.toUpperCase().slice(0, 20) } });
  assert.equal(g.status, 200); assert.equal(g.body.result, 'ok');
  assert.equal(g.body.holder.welcome.visit, 3); assert.equal(g.body.holder.welcome.birthday, new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${bday}T12:00:00Z`)));
  assert.doesNotMatch(g.text, /SECRET/);
});

// ---------------------------------------------------------------- scan to find
test('scan to find: an order, a ticket, a lesson, a card, a reward, a driver\'s license (name and birthday only), and a name', async () => {
  const sam = await person({ first_name: 'Sam', last_name: `Find${suffix}`, email: `sam${suffix}@x.test` });
  const sale = await api('POST', '/checkout', { token: counter, body: { channel: 'window', customer: { person_id: sam.id }, lines: [ticketLine()], payments: [{ tender: 'cash', amount_cents: 8000 }] } });
  assert.equal(sale.status, 201, sale.text);
  const find = async (code) => { const r = await api('GET', `/guests/find?q=${encodeURIComponent(code)}`, { token: counter }); assert.equal(r.status, 200, r.text); return r; };
  let r = await find(`ORD-${sale.body.id}`);
  assert.equal(r.body.kind, 'order'); assert.equal(r.body.order_id, sale.body.id); assert.equal(r.body.people[0].id, sam.id);
  r = await find(sale.body.tickets[0].code);
  assert.equal(r.body.kind, 'ticket'); assert.equal(r.body.people[0].id, sam.id); assert.equal(r.body.order_id, sale.body.id);
  const [s] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, starts_at, ends_at, capacity, status) VALUES (?, ?, 'ski', ?, ?, 6, 'scheduled')", [A.id, lessonP, `${plus(today, 2)} 10:00:00`, `${plus(today, 2)} 12:00:00`]);
  const [b] = await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [A.id, s.insertId, sam.id]);
  r = await find(`L${b.insertId}`);
  assert.equal(r.body.kind, 'lesson'); assert.equal(r.body.people[0].id, sam.id);
  const tid = (await q('SELECT id FROM tickets WHERE tenant_id = ? AND code = ?', [A.id, sale.body.tickets[0].code]))[0].id;
  await pool.query("INSERT INTO rfid_cards (tenant_id, uid, label, ticket_id, status) VALUES (?, 'A1B2C3D4E5', '1001', ?, 'assigned')", [A.id, tid]);
  r = await find('a1:b2:c3:d4:e5');
  assert.equal(r.body.kind, 'card'); assert.equal(r.body.people[0].id, sam.id);
  const gw = await api('POST', `/guests/people/${sam.id}/goodwill`, { token: manager, body: { reason: 'Long wait', percent: 50 } });
  r = await find(gw.body.code.toLowerCase());
  assert.equal(r.body.kind, 'reward'); assert.equal(r.body.reward.id, gw.body.id); assert.equal(r.body.people[0].id, sam.id);
  // a driver's license typed by a USB scanner: with line breaks, with "|" from the scan box, and with none at all
  const lic = (sep) => ['@', '\x1e\rANSI 636014040002DL00410278ZC03190008DLDAQD1234562', 'DCSPICKERING', 'DACJORDAN', 'DADQUINN', 'DBD08292017', 'DBB01151985', 'DBA01152030', 'DBC1', 'DAU069 IN', 'DAG123 MAIN ST', 'DAIROYERSFORD', 'DAJPA', 'DAK194680000'].join(sep);
  for (const sep of ['\n', '|', '']) {
    const L = WIN.parseLicense(lic(sep));
    assert.deepEqual(L, { first_name: 'Jordan', last_name: 'Pickering', date_of_birth: '1985-01-15' }, `separator ${JSON.stringify(sep)}`);
  }
  r = await find(lic('|'));
  assert.equal(r.body.kind, 'license'); assert.deepEqual(r.body.license, { first_name: 'Jordan', last_name: 'Pickering', date_of_birth: '1985-01-15' });
  assert.equal(r.body.people.length, 0); assert.match(r.body.title, /not on file yet/);
  assert.doesNotMatch(r.text, /D1234562|MAIN ST|194680000/, 'the license number and address are never returned');
  const jordan = await person({ first_name: 'Jordan', last_name: 'Pickering', date_of_birth: '1985-01-15' });
  r = await find(lic('\n'));
  assert.equal(r.body.people[0].id, jordan.id);
  // a name still searches; two people with the same name show what tells them apart
  const twinA = await person({ first_name: 'Sam', last_name: `Twin${suffix}`, date_of_birth: '1980-02-02' });
  const twinB = await person({ first_name: 'Sam', last_name: `Twin${suffix}`, date_of_birth: `${year - 10}-02-02` });
  assert.equal((await api('POST', `/people/${twinA.id}/family`, { token: A.owner, body: { other_id: twinB.id, relation: 'guardian', as: 'guardian_of' } })).status, 201);
  r = await find(`Sam Twin${suffix}`);
  assert.equal(r.body.kind, 'text'); assert.equal(r.body.people.length, 2);
  const lk = await api('GET', `/people/lookup?q=${encodeURIComponent(`Sam Twin${suffix}`)}`, { token: counter });
  const kid = lk.body.data.find((p) => p.id === twinB.id);
  assert.ok(kid.age >= 9 && kid.age <= 10); assert.equal(kid.guardian, `Sam Twin${suffix}`);
  assert.ok('last_visit' in kid);
  // a phone number is a search, not a card
  r = await find('2155550199');
  assert.equal(r.body.kind, 'text');
});

// ---------------------------------------------------------------- day tickets need only a name
test('a day ticket needs only a name (no date of birth or sex), shown as missing; a pass or a lesson still needs them; typed quantities', async () => {
  const body = { channel: 'window', customer: { details: { first_name: 'Quinn', last_name: `Light${suffix}`, email: `quinn${suffix}@x.test` } }, participants: { p1: { details: { first_name: 'Robin', last_name: `Light${suffix}` } } },
    lines: [ticketLine({ quantity: 2, holders: ['customer', 'p1'] })], payments: [{ tender: 'cash', amount_cents: 16000 }] };
  const chk = await api('POST', '/checkout/check', { token: counter, body: { ...body, payments: [] } });
  assert.equal(chk.status, 200, chk.text);
  assert.equal(chk.body.missing.length, 2); assert.deepEqual(chk.body.missing[0].missing, ['Date of birth', 'Sex']);
  const ok = await api('POST', '/checkout', { token: counter, body });
  assert.equal(ok.status, 201, ok.text); assert.equal(ok.body.tickets.length, 2);
  assert.deepEqual(ok.body.tickets.map((t) => t.holder).sort(), [`Quinn Light${suffix}`, `Robin Light${suffix}`]);
  // a season pass still needs a date of birth and sex
  const pass = await api('POST', '/checkout', { token: counter, body: { channel: 'window', customer: { details: { first_name: 'Pass', last_name: `Light${suffix}`, email: `pl${suffix}@x.test` } }, lines: [{ type: 'ticket', product_id: passP, quantity: 1 }], payments: [{ tender: 'cash', amount_cents: 50000 }] } });
  assert.equal(pass.status, 400); assert.match(pass.body.error, /Date of birth, Sex/);
  // typed quantities: 37 in one line
  const many = await api('POST', '/checkout', { token: counter, body: { channel: 'window', quick: true, lines: [ticketLine({ quantity: 37, valid_on: plus(today, 1) })], payments: [{ tender: 'cash', amount_cents: 37 * 8000 }] } });
  assert.equal(many.status, 201, many.text); assert.equal(many.body.tickets.length, 37);
});

// ---------------------------------------------------------------- group prices and rosters
test('group price from N people (managers set it), and a roster read into named tickets with guest types', async () => {
  assert.equal((await api('PUT', `/guests/group-prices/${dayP}`, { token: counter, body: { min_people: 10, price_cents: 6000 } })).status, 403);
  assert.equal((await api('PUT', `/guests/group-prices/${dayP}`, { token: manager, body: { min_people: 10, price_cents: 6000 } })).status, 200);
  const d = plus(today, 3);
  const nine = await api('POST', '/checkout/quote', { token: counter, body: { lines: [ticketLine({ quantity: 9, valid_on: d })] } });
  assert.equal(nine.body.lines[0].unit_price_cents, 8000); assert.ok(!nine.body.lines[0].group);
  const ten = await api('POST', '/checkout/quote', { token: counter, body: { lines: [ticketLine({ quantity: 6, valid_on: d }), ticketLine({ quantity: 4, valid_on: d, tier: 'child' })] } });
  assert.equal(ten.body.lines[0].unit_price_cents, 6000); assert.equal(ten.body.lines[0].group.min_people, 10);
  assert.equal(ten.body.lines[1].unit_price_cents, 5000, 'a lower guest type price stays');
  const ro = await api('POST', '/guests/roster', { token: counter, body: { text: 'Name, Age\nAlex Kim, 9\nJo Park, 34\n\n' } });
  assert.equal(ro.status, 200); assert.deepEqual(ro.body.people, [{ first_name: 'Alex', last_name: 'Kim', age: 9, tier: 'child' }, { first_name: 'Jo', last_name: 'Park', age: 34, tier: 'adult' }]);
  const plain = await api('POST', '/guests/roster', { token: counter, body: { text: 'Lee, Morgan, 12\nTaylor Brooks' } });
  assert.deepEqual(plain.body.people.map((p) => [p.first_name, p.last_name, p.age]), [['Morgan', 'Lee', 12], ['Taylor', 'Brooks', null]]);
  // one payer, a ticket per person on the roster
  const participants = Object.fromEntries(ro.body.people.map((p, i) => [`r${i}`, { details: { first_name: p.first_name, last_name: p.last_name } }]));
  const g = await api('POST', '/checkout', { token: counter, body: { channel: 'group', customer: { details: { first_name: 'Group', last_name: `Leader${suffix}`, phone: '215-555-0142' } }, participants,
    lines: [ticketLine({ quantity: 1, tier: 'child', valid_on: d, holders: ['r0'] }), ticketLine({ quantity: 1, valid_on: d, holders: ['r1'] })], payments: [{ tender: 'cash', amount_cents: 13000 }] } });
  assert.equal(g.status, 201, g.text); assert.deepEqual(g.body.tickets.map((t) => t.holder), ['Alex Kim', 'Jo Park']);
  assert.equal((await api('DELETE', `/guests/group-prices/${dayP}`, { token: manager })).status, 200);
});

// ---------------------------------------------------------------- refunds at the counter
test('refunds: counter staff up to the mountain\'s limit per order, a manager above it; 0 means never', async () => {
  const sell = async () => { const r = await api('POST', '/checkout', { token: counter, body: { channel: 'window', quick: true, lines: [ticketLine({ quantity: 2, valid_on: plus(today, 1) })], payments: [{ tender: 'cash', amount_cents: 16000 }] } }); assert.equal(r.status, 201, r.text); return r.body; };
  const o = await sell();
  const items = (await q('SELECT id FROM order_items WHERE tenant_id = ? AND order_id = ? ORDER BY id', [A.id, o.id])).map((x) => x.id);
  const refund = (tok, ids) => api('POST', `/orders/${o.id}/refund`, { token: tok, body: { reason: 'customer_request', item_ids: ids } });
  let r = await refund(counter, [items[0]]);
  assert.equal(r.status, 403); assert.match(r.body.error, /Only a manager/);
  assert.equal((await api('PATCH', '/guests/settings', { token: manager, body: { counter_refund_limit_cents: 10000 } })).status, 200);
  r = await refund(counter, [items[0]]);
  assert.equal(r.status, 200, r.text); assert.equal(r.body.amount_cents, 8000);
  r = await refund(counter, [items[1]]);
  assert.equal(r.status, 403, 'over the limit for this order'); assert.match(r.body.error, /up to \$100\.00 on an order\. Ask a manager/);
  r = await refund(manager, [items[1]]);
  assert.equal(r.status, 200, r.text);
});

// ---------------------------------------------------------------- change day
test('change day at the window: same code, the difference charged or given back, the day limit, and the email', async () => {
  const guest = await person({ first_name: 'Casey', last_name: `Move${suffix}`, email: `casey${suffix}@x.test` });
  const d1 = plus(today, 2); const dUp = plus(today, 4); const dDown = plus(today, 5); const dFull = plus(today, 6);
  await pool.query('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents, blackout) VALUES (?, ?, ?, NULL, 9000, 0), (?, ?, ?, NULL, 7000, 0)', [A.id, dayP, dUp, A.id, dayP, dDown]);
  const sale = await api('POST', '/checkout', { token: counter, body: { channel: 'window', customer: { person_id: guest.id }, lines: [ticketLine({ valid_on: d1 })], payments: [{ tender: 'cash', amount_cents: 8000 }] } });
  assert.equal(sale.status, 201, sale.text);
  const code = sale.body.tickets[0].code;
  const move = (tok, body) => api('POST', `/guests/tickets/${code}/change-day`, { token: tok, body });
  let r = await move(counter, { date: dUp, check: true });
  assert.equal(r.status, 200); assert.equal(r.body.owed_cents, 1000); assert.equal(r.body.back_cents, 0);
  assert.equal((await move(counter, { date: dUp })).status, 400, 'the difference is paid first');
  mails.length = 0;
  r = await move(counter, { date: dUp, payment: { tender: 'cash' } });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.done, true);
  const t = (await q('SELECT code, valid_from FROM tickets WHERE tenant_id = ? AND code = ?', [A.id, code]))[0];
  assert.equal(t.code, code); assert.equal(String(t.valid_from).slice(0, 10), dUp);
  const paid = (await q('SELECT total_cents FROM orders WHERE tenant_id = ? AND id = ?', [A.id, r.body.paid_order_id]))[0];
  assert.equal(paid.total_cents, 1000);
  const m = mails.find((x) => /Your ticket is now for/.test(x.Subject));
  assert.ok(m, 'the change email'); assert.equal(m.To, `casey${suffix}@x.test`); assert.match(m.TextBody, /Was: .*\n- Now: /); assert.match(m.TextBody, /You paid \$10\.00/);
  // a cheaper day: the difference goes back (from what was paid so far, 90.00), within the counter's limit
  r = await move(counter, { date: dDown });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.back_cents, 2000); assert.equal(r.body.back_method, 'cash');
  assert.equal((await q('SELECT refunded_cents FROM orders WHERE tenant_id = ? AND id = ?', [A.id, sale.body.id]))[0].refunded_cents, 2000);
  // a day at its limit: only a manager, with a reason
  await api('POST', '/online-shop/calendar', { token: A.owner, body: { from: dFull, to: dFull, action: 'limit', limit: 1 } });
  assert.equal((await api('POST', '/checkout', { token: counter, body: { channel: 'window', quick: true, lines: [ticketLine({ valid_on: dFull })], payments: [{ tender: 'cash', amount_cents: 8000 }] } })).status, 201);
  r = await move(counter, { date: dFull });
  assert.equal(r.status, 409); assert.match(r.body.error, /at its limit/);
  assert.equal((await move(counter, { date: dFull, over_limit_reason: 'Family visit' })).status, 403);
  r = await move(manager, { date: dFull, over_limit_reason: 'Family visit', payment: { tender: 'cash' } });
  assert.equal(r.status, 200, r.text);
  // a used ticket cannot move
  await api('POST', '/tickets/scan', { token: counter, body: { code } }).catch(() => {});
  await pool.query("INSERT INTO scans (tenant_id, ticket_id, code, result) SELECT tenant_id, id, code, 'ok' FROM tickets WHERE tenant_id = ? AND code = ?", [A.id, code]);
  assert.equal((await move(manager, { date: plus(today, 9) })).status, 409);
});

// ---------------------------------------------------------------- rewards at the window
test('a reward is used once (two sales at once: one wins), comes off the right line, and a refund gives it back', async () => {
  const kim = await person({ first_name: 'Kim', last_name: `Reward${suffix}`, email: `kim${suffix}@x.test` });
  const gw = await api('POST', `/guests/people/${kim.id}/goodwill`, { token: manager, body: { reason: 'Birthday at the window', free_ticket_product_id: dayP, percent: 50 } });
  assert.equal(gw.status, 201, gw.text);
  // the quote shows what it is worth; a percent off takes half of one ticket
  const qp = await api('POST', '/checkout/quote', { token: counter, body: { lines: [ticketLine({ quantity: 2 })], rewards: [{ code: gw.body.code, choice: 'percent' }] } });
  assert.equal(qp.status, 200, qp.text); assert.equal(qp.body.rewards[0].value_cents, 4000); assert.equal(qp.body.total_cents, 12000);
  const sale = () => api('POST', '/checkout', { token: counter, body: { channel: 'window', customer: { person_id: kim.id }, lines: [ticketLine()], rewards: [{ reward_id: gw.body.id, choice: 'free_ticket' }] } });
  const [a, b] = await Promise.all([sale(), sale()]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [201, 409], `one sale wins: ${a.text} ${b.text}`);
  const won = a.status === 201 ? a : b; const lost = a.status === 201 ? b : a;
  assert.match(lost.body.error, /already been used/);
  assert.equal(won.body.total_cents, 0);
  const r = (await q('SELECT status, chosen, order_id FROM guest_rewards WHERE id = ?', [gw.body.id]))[0];
  assert.equal(r.status, 'redeemed'); assert.equal(r.chosen, 'free_ticket'); assert.equal(r.order_id, won.body.id);
  const item = (await q('SELECT reward_id, unit_price_cents FROM order_items WHERE tenant_id = ? AND order_id = ?', [A.id, won.body.id]))[0];
  assert.equal(item.reward_id, gw.body.id); assert.equal(item.unit_price_cents, 0);
  // a free ticket is not for a lesson package or a gift card
  const nope = await api('POST', '/checkout/quote', { token: counter, body: { lines: [{ type: 'gift_card', amount_cents: 5000 }], rewards: [{ reward_id: gw.body.id, choice: 'free_ticket' }] } });
  assert.equal(nope.status, 409);
  // refunded: the reward is the guest's again
  const ref = await api('POST', `/orders/${won.body.id}/refund`, { token: manager, body: { reason: 'customer_request' } });
  assert.equal(ref.status, 200, ref.text);
  assert.equal((await q('SELECT status, order_id FROM guest_rewards WHERE id = ?', [gw.body.id]))[0].status, 'offered');
  // a credit comes off the basket
  const cr = await api('POST', `/guests/people/${kim.id}/goodwill`, { token: manager, body: { reason: 'Rental mix-up', credit_cents: 10000 } });
  const two = await api('POST', '/checkout', { token: counter, body: { channel: 'window', customer: { person_id: kim.id }, lines: [ticketLine({ quantity: 2, holders: ['customer', 'customer'] })], rewards: [{ reward_id: cr.body.id, choice: 'credit' }], payments: [{ tender: 'cash', amount_cents: 6000 }] } });
  assert.equal(two.status, 201, two.text); assert.equal(two.body.total_cents, 6000);
  const its = await q('SELECT unit_price_cents, reward_id FROM order_items WHERE tenant_id = ? AND order_id = ? ORDER BY id', [A.id, two.body.id]);
  assert.deepEqual(its.map((x) => x.unit_price_cents), [0, 6000]); assert.ok(its.every((x) => x.reward_id === cr.body.id));
});
