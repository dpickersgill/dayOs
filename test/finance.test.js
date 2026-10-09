'use strict';

// Money, family and sign-in: tax, comps, card details, partial refunds with reasons, the cash drawer, card statement
// reconciliation, accountant exports, receipts, guardians, merging duplicates, season passes, gate warnings and two-step sign-in.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const totp = require('../src/lib/totp');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
async function addUser(m, email, role) {
  assert.equal((await api('POST', '/users', { token: m.owner, body: { email, password: PW, role } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const q = async (sql, params) => (await pool.query(sql, params))[0];
const ADULT = { date_of_birth: '1985-03-02', sex: 'female' };
const person = (first, last, extra = {}) => ({ details: { first_name: first, last_name: last, ...ADULT, email: `${first}.${last}@x.test`.toLowerCase(), ...extra } });
const freeGear = async () => {
  await q("UPDATE rental_contracts SET status = 'returned' WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [A.slug]);
  await q("UPDATE rental_items SET status = 'available' WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [A.slug]);
};
const JPEG = `data:image/jpeg;base64,${Buffer.from('not-really-a-photo').toString('base64')}`;

let A; let B; const T = {}; const D = {};

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`fa-${suffix}`);
  B = await mountain(`fb-${suffix}`);
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.counter2 = await addUser(A, `counter2@${A.slug}.test`, 'counter');
  T.manager = await addUser(A, `manager@${A.slug}.test`, 'manager');
  const prod = async (body) => (await api('POST', '/products', { token: A.owner, body })).body.id;
  D.day = await prod({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 10000 });
  D.rental = await prod({ kind: 'rental', name: 'Ski Package', base_price_cents: 4000 });
  D.pass = await prod({ kind: 'season_pass', name: 'Season Pass', base_price_cents: 50000 });
  D.ski = (await api('POST', '/rentals/items', { token: A.owner, body: { sku: 'F-SKI', category: 'ski', size: '150' } })).body.id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const sell = (token, body) => api('POST', '/checkout', { token, body });

test('sales tax is added per kind of item, shown on the receipt and kept out of revenue', async () => {
  const rule = await api('POST', '/tax-rules', { token: A.owner, body: { name: 'State tax', applies_to: 'ticket', rate_percent: 6 } });
  assert.equal(rule.status, 201);
  assert.equal((await api('POST', '/tax-rules', { token: T.counter, body: { name: 'x', rate_percent: 1 } })).status, 403, 'counter staff cannot change rates');
  const quote = await api('POST', '/checkout/quote', { token: T.counter, body: { lines: [{ type: 'ticket', product_id: D.day }, { type: 'rental', product_id: D.rental }] } });
  assert.equal(quote.body.tax_cents, 600, 'only the ticket is taxed');
  assert.equal(quote.body.total_cents, 14600);
  const r = await sell(T.counter, { channel: 'window', customer: person('Tara', 'Taxed'), lines: [{ type: 'ticket', product_id: D.day }], payments: [{ tender: 'cash', amount_cents: 10600, tendered_cents: 11000 }] });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.tax_cents, 600);
  const rec = await api('GET', `/orders/${r.body.id}/receipt`, { token: T.counter });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.order.tax_cents, 600);
  assert.equal(rec.body.order.change_due_cents, 400);
  assert.equal(rec.body.taxes[0].name, 'State tax');
  assert.equal(rec.body.tickets.length, 1);
  assert.match(rec.body.tickets[0].code, /^[A-Z0-9]+$/);
  const rep = await api('GET', `/reports/daily?date=${today}`, { token: T.manager });
  assert.equal(rep.status, 200);
  assert.equal(rep.body.sales.tax_cents, 600);
  assert.equal(rep.body.sales.revenue_cents, 10000, 'tax is not revenue');
  D.taxedOrder = r.body.id;
});

test('a comp needs a reason, counter staff are limited by the manager setting, and a comp is not revenue', async () => {
  const body = (payments) => ({ channel: 'window', customer: person('Cory', 'Comp'), lines: [{ type: 'ticket', product_id: D.day }], payments });
  const free = (amount) => [{ tender: 'comp', amount_cents: amount, comp_reason: 'staff' }];
  assert.equal((await sell(T.counter, body([{ tender: 'comp', amount_cents: 10600 }]))).status, 400, 'reason required');
  const denied = await sell(T.counter, body(free(10600)));
  assert.equal(denied.status, 403, 'counter limit defaults to nothing');
  assert.equal((await api('PUT', '/tenant/profile', { token: T.manager, body: { comp_counter_limit_cents: 5000 } })).status, 200);
  assert.equal((await sell(T.counter, body(free(10600)))).status, 403, 'over the limit');
  assert.equal((await api('PUT', '/tenant/profile', { token: T.manager, body: { comp_counter_limit_cents: 20000 } })).status, 200);
  const ok = await sell(T.counter, body(free(10600)));
  assert.equal(ok.status, 201, ok.text);
  const rep = await api('GET', `/reports/daily?date=${today}`, { token: T.manager });
  assert.equal(rep.body.sales.comp_cents, 10600);
  assert.equal(rep.body.sales.revenue_cents, 10000, 'comps do not add revenue');
  const m = await api('GET', '/checkout/menu', { token: T.counter });
  assert.equal(m.body.comp.can_comp, true);
  assert.ok(m.body.comp.reasons.includes('staff'));
});

test('card details are kept on the payment and cards can be matched against the processor statement', async () => {
  const mk = (ref, last4, dob) => sell(T.counter, { channel: 'window', customer: person('Cara', `Card${ref}`, { date_of_birth: dob }), lines: [{ type: 'ticket', product_id: D.day }],
    payments: [{ tender: 'card', amount_cents: 10600, reference: ref, card_brand: 'visa', card_last4: last4, auth_code: `AU${ref}`, processor: 'manual' }] });
  const a = await mk('REF1', '4242', '1980-01-01'); const b = await mk('REF2', '1111', '1981-01-01'); const c = await mk('REF3', '0005', '1982-01-01');
  for (const r of [a, b, c]) assert.equal(r.status, 201, r.text);
  const bad = await sell(T.counter, { channel: 'window', customer: person('Bad', 'Digits'), lines: [{ type: 'ticket', product_id: D.day }], payments: [{ tender: 'card', amount_cents: 10600, card_last4: '12' }] });
  assert.equal(bad.status, 400, 'last 4 digits only, and exactly four');
  const rec = await api('GET', `/orders/${a.body.id}/receipt`, { token: T.counter });
  assert.equal(rec.body.payments[0].card_last4, '4242');
  const stored = await q('SELECT card_last4, card_brand FROM order_payments WHERE order_id = ?', [a.body.id]);
  assert.equal(stored[0].card_brand, 'visa');
  const out = await api('POST', '/reconcile/cards', { token: T.manager, body: { rows: [{ reference: 'ref1', amount_cents: 10600 }, { reference: 'REF2', amount_cents: 9999 }, { reference: 'STRANGER', amount_cents: 500 }] } });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.body.matched, 1);
  assert.equal(out.body.mismatched.length, 1);
  assert.equal(out.body.mismatched[0].processor_cents, 9999);
  assert.equal(out.body.only_in_system.length, 1, 'REF3 is not on the statement');
  assert.equal(out.body.only_in_file[0].reference, 'stranger');
  assert.equal((await api('POST', '/reconcile/cards', { token: T.counter, body: { rows: [] } })).status, 403);
});

test('refunds: manager only, a reason is always recorded, partial refunds return the exact line and tax', async () => {
  const s = await sell(T.counter, { channel: 'window', customer: { ...person('Rita', 'Refund'), sign_waiver: true }, lines: [{ type: 'ticket', product_id: D.day, quantity: 2, holders: ['customer', 'second'] }, { type: 'rental', product_id: D.rental, items: [{ rental_item_id: D.ski }] }],
    participants: { second: person('Sam', 'Refund', { email: undefined, phone: '610-555-0111' }) }, payments: [{ tender: 'cash', amount_cents: 25200, tendered_cents: 25200 }] });
  assert.equal(s.status, 201, s.text);
  const id = s.body.id;
  assert.equal((await api('POST', `/orders/${id}/refund`, { token: T.counter, body: { reason: 'weather' } })).status, 403);
  assert.equal((await api('POST', `/orders/${id}/refund`, { token: T.manager, body: {} })).status, 400, 'a reason is required');
  assert.equal((await api('POST', `/orders/${id}/refund`, { token: T.manager, body: { reason: 'other' } })).status, 400, '"other" needs a note');
  const detail = await api('GET', `/orders/${id}`, { token: T.manager });
  const ticketItems = detail.body.items.filter((i) => i.line_kind === 'ticket');
  assert.equal(ticketItems.length, 2);
  const part = await api('POST', `/orders/${id}/refund`, { token: T.manager, body: { reason: 'injury', item_ids: [ticketItems[0].id] } });
  assert.equal(part.status, 200, part.text);
  assert.equal(part.body.amount_cents, 10600, 'the ticket plus its own tax');
  const after = await api('GET', `/orders/${id}`, { token: T.manager });
  assert.equal(after.body.status, 'paid', 'only part is refunded so the order stays paid');
  assert.equal(after.body.refunds.length, 1);
  assert.equal(after.body.refunds[0].reason, 'injury');
  const again = await api('POST', `/orders/${id}/refund`, { token: T.manager, body: { reason: 'injury', item_ids: [ticketItems[0].id] } });
  assert.equal(again.status, 400, 'cannot refund the same line twice');
  const early = await api('POST', `/orders/${id}/refund`, { token: T.manager, body: { reason: 'customer_request' } });
  assert.equal(early.status, 409, 'the rental gear has to be back first');
  await freeGear();
  const rest = await api('POST', `/orders/${id}/refund`, { token: T.manager, body: { reason: 'customer_request' } });
  assert.equal(rest.status, 200, rest.text);
  assert.equal(rest.body.amount_cents, 25200 - 10600);
  assert.equal(rest.body.whole_order, true);
  assert.equal((await api('GET', `/orders/${id}`, { token: T.manager })).body.status, 'refunded');
  const csv = await api('GET', `/exports/refunds.csv?from=${today}&to=${today}`, { token: T.manager });
  assert.match(csv.text, /injury/);
  assert.match(csv.text, /customer_request/);
});

test('the cash drawer: open with a float, move money, close counted, and a variance needs a note', async () => {
  assert.equal((await api('GET', '/till/current', { token: T.counter2 })).body.till, null);
  assert.equal((await api('POST', '/till/open', { token: T.counter2, body: { opening_float_cents: 20000 } })).status, 201);
  assert.equal((await api('POST', '/till/open', { token: T.counter2, body: { opening_float_cents: 1 } })).status, 409, 'one drawer at a time');
  const s = await sell(T.counter2, { channel: 'window', customer: person('Dana', 'Drawer'), lines: [{ type: 'ticket', product_id: D.day }], payments: [{ tender: 'cash', amount_cents: 10600, tendered_cents: 10600 }] });
  assert.equal(s.status, 201, s.text);
  assert.equal((await api('POST', '/till/moves', { token: T.counter2, body: { kind: 'payout', amount_cents: 500 } })).status, 400, 'say what a payout was for');
  const mv = await api('POST', '/till/moves', { token: T.counter2, body: { kind: 'payout', amount_cents: 500, reason: 'Buy tape' } });
  assert.equal(mv.status, 201, mv.text);
  assert.equal(mv.body.till.expected_cents, 20000 + 10600 - 500);
  const short = await api('POST', '/till/close', { token: T.counter2, body: { counted_cents: 29100 } });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /short by \$10\.00/);
  const closed = await api('POST', '/till/close', { token: T.counter2, body: { counted_cents: 29100, notes: 'Gave change out of pocket' } });
  assert.equal(closed.status, 200, closed.text);
  assert.equal(closed.body.till.variance_cents, -1000);
  assert.equal((await api('GET', '/till/current', { token: T.counter2 })).body.till, null);
  const list = await api('GET', `/till?date=${today}`, { token: T.manager });
  assert.ok(list.body.data.some((t) => t.variance_cents === -1000));
  assert.equal((await api('GET', '/till', { token: T.counter2 })).status, 403);
});

test('accountant exports are CSV, managers only, and safe to open in a spreadsheet', async () => {
  const names = ['sales', 'payments', 'refunds', 'daily-summary'];
  for (const n of names) {
    const r = await api('GET', `/exports/${n}.csv?from=${today}&to=${today}`, { token: T.manager });
    assert.equal(r.status, 200, n);
    assert.match(r.text.split('\n')[0], /date/, n);
    assert.equal((await api('GET', `/exports/${n}.csv`, { token: T.counter })).status, 403, n);
  }
  assert.equal((await api('GET', '/exports/sales.csv?from=2020-01-01&to=2023-01-01', { token: T.manager })).status, 400, 'a year at most');
  const sales = await api('GET', `/exports/sales.csv?from=${today}&to=${today}`, { token: T.manager });
  assert.match(sales.text, /Adult Day/);
  assert.match(sales.text, /State tax|6\.00/);
});

test('under 18s need a guardian: named or the adult buyer, who signs the waiver and is linked on file', async () => {
  await freeGear();
  const kid = { first_name: 'Kay', last_name: 'Kid', date_of_birth: '2015-02-03', sex: 'female' };
  const line = [{ type: 'rental', product_id: D.rental, participant: 'kid', items: [{ rental_item_id: D.ski }] }];
  const pay = [{ tender: 'cash', amount_cents: 4000, tendered_cents: 4000 }];
  const kidOnly = await sell(T.counter, { channel: 'window', customer: { details: { ...kid, last_name: 'Solo' } }, lines: [{ type: 'ticket', product_id: D.day }], payments: [{ tender: 'cash', amount_cents: 10600 }] });
  assert.equal(kidOnly.status, 400, 'a child cannot be the only person on a sale');
  assert.match(kidOnly.body.error, /guardian/i);
  const noWaiver = await sell(T.counter, { channel: 'window', customer: person('Gail', 'Guardian'), participants: { kid: { details: kid } }, lines: line, payments: pay });
  assert.equal(noWaiver.status, 409, 'the guardian must sign for the child');
  assert.match(noWaiver.body.error, /guardian must sign/);
  const ok = await sell(T.counter, { channel: 'window', customer: person('Gail', 'Guardian'), participants: { kid: { details: kid, sign_waiver: true } }, lines: line, payments: pay });
  assert.equal(ok.status, 201, ok.text);
  const w = await q("SELECT w.signed_by_name, w.signer_relation FROM waivers w JOIN people p ON p.id = w.person_id WHERE p.last_name = 'Kid' AND p.tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [A.slug]);
  assert.equal(w[0].signed_by_name, 'Gail Guardian');
  assert.equal(w[0].signer_relation, 'guardian');
  const links = await q("SELECT relation FROM person_links WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [A.slug]);
  assert.ok(links.some((l) => l.relation === 'guardian'));
  const kidId = (await q("SELECT id FROM people WHERE last_name = 'Kid' AND tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [A.slug]))[0].id;
  const fam = await api('GET', `/people/${kidId}/family`, { token: T.counter });
  assert.equal(fam.body.guardians[0].first_name, 'Gail');
  D.gail = fam.body.guardians[0].id; D.kid = kidId;
  const gfam = await api('GET', `/people/${D.gail}/family`, { token: T.counter });
  assert.equal(gfam.body.dependents[0].first_name, 'Kay');
  assert.equal(gfam.body.dependents[0].age, 11);
  // Next visit: the link is remembered, so the child on a basket needs no guardian named again.
  const again = await sell(T.counter, { channel: 'window', customer: { person_id: D.kid }, lines: [{ type: 'ticket', product_id: D.day }], payments: [{ tender: 'cash', amount_cents: 10600 }] });
  assert.equal(again.status, 201, again.text);
});

test('family links can be added by hand, and a person cannot be their own guardian', async () => {
  const mk = async (first) => (await api('POST', '/people', { token: T.counter, body: { first_name: first, last_name: 'Link', ...ADULT } })).body.id;
  const x = await mk('Xena'); const y = await mk('Yuri');
  assert.equal((await api('POST', `/people/${x}/family`, { token: T.counter, body: { other_id: x } })).status, 400);
  const link = await api('POST', `/people/${x}/family`, { token: T.counter, body: { other_id: y, relation: 'family' } });
  assert.equal(link.status, 201);
  assert.equal(link.body.household[0].first_name, 'Yuri');
  assert.equal((await api('GET', `/people/${y}/family`, { token: T.counter })).body.household[0].first_name, 'Xena', 'family goes both ways');
  assert.equal((await api('DELETE', `/people/${x}/family/${y}`, { token: T.counter })).status, 200);
  assert.equal((await api('GET', `/people/${x}/family`, { token: T.counter })).body.household.length, 0);
});

test('rental sizing is kept on the customer, with the last DIN used', async () => {
  await freeGear();
  const p = await api('POST', '/people', { token: T.counter, body: { first_name: 'Sizer', last_name: 'Skier', ...ADULT, email: 'sizer@x.test', height_in: 68, weight_lb: 160, boot_size: '9.5', stance: 'goofy', skier_type: '2' } });
  assert.equal(p.status, 201, p.text);
  const bad = await api('PATCH', `/people/${p.body.id}`, { token: T.counter, body: { stance: 'sideways' } });
  assert.equal(bad.status, 400);
  const s = await sell(T.counter, { channel: 'window', customer: { person_id: p.body.id, sign_waiver: true }, lines: [{ type: 'rental', product_id: D.rental, items: [{ rental_item_id: D.ski, din_setting: 7.5 }] }], payments: [{ tender: 'cash', amount_cents: 4000 }] });
  assert.equal(s.status, 201, s.text);
  const prof = await api('GET', `/people/${p.body.id}/rental-profile`, { token: T.counter });
  assert.equal(prof.body.boot_size, '9.5');
  assert.equal(prof.body.height_in, 68);
  assert.equal(Number(prof.body.last_din), 7.5);
  await freeGear();
});

test('photos are stored apart from the customer record and only fetched when asked for', async () => {
  const p = (await api('POST', '/people', { token: T.counter, body: { first_name: 'Pia', last_name: 'Photo', ...ADULT } })).body.id;
  assert.equal((await api('GET', `/people/${p}`, { token: T.counter })).body.has_photo, false);
  assert.equal((await api('PUT', `/people/${p}/photo`, { token: T.counter, body: { photo: 'data:text/html;base64,AAAA' } })).status, 400, 'JPEG only');
  assert.equal((await api('PUT', `/people/${p}/photo`, { token: T.counter, body: { photo: JPEG } })).status, 200);
  const rec = await api('GET', `/people/${p}`, { token: T.counter });
  assert.equal(rec.body.has_photo, true);
  assert.equal(rec.body.photo, undefined, 'the list and detail views never carry the photo');
  assert.equal((await api('GET', `/people/${p}/photo`, { token: T.counter })).body.photo, JPEG);
  assert.equal((await api('DELETE', `/people/${p}/photo`, { token: T.counter })).body.has_photo, false);
});

test('a season pass needs a photo of the holder, shows up at the gate lookup, and the renewals list finds lapsed passes', async () => {
  const noPhoto = await sell(T.counter, { channel: 'window', customer: person('Sean', 'Season'), lines: [{ type: 'ticket', product_id: D.pass }], payments: [{ tender: 'cash', amount_cents: 53000 }] });
  assert.equal(noPhoto.status, 400);
  assert.match(noPhoto.body.error, /photo/);
  const withPhoto = await sell(T.counter, { channel: 'window', customer: person('Sean', 'Season', { photo: JPEG }), lines: [{ type: 'ticket', product_id: D.pass }], payments: [{ tender: 'cash', amount_cents: 53000 }] });
  assert.equal(withPhoto.status, 201, withPhoto.text);
  const code = withPhoto.body.tickets[0].code;
  const look = await api('GET', '/passes/lookup?q=season', { token: T.counter });
  assert.equal(look.body.data[0].first_name, 'Sean');
  assert.equal(look.body.data[0].has_photo, true);
  assert.equal(look.body.data[0].valid_today, true);
  assert.equal((await api('GET', `/passes/lookup?q=${code}`, { token: T.counter })).body.data.length, 1, 'find by ticket code too');
  // Make this pass last season's: it should appear on the renewal list until they buy another.
  await q("UPDATE tickets SET valid_from = DATE_SUB(?, INTERVAL 200 DAY), valid_to = DATE_SUB(?, INTERVAL 10 DAY) WHERE code = ?", [today, today, code]);
  const ren = await api('GET', '/passes/renewals', { token: T.manager });
  assert.equal(ren.status, 200);
  const row = ren.body.data.find((r) => r.code === code);
  assert.ok(row && row.expired);
  assert.equal(row.first_name, 'Sean');
  await q("UPDATE tickets SET valid_from = ?, valid_to = DATE_ADD(?, INTERVAL 100 DAY) WHERE code = ?", [today, today, code]);
  D.passCode = code;
});

test('the gate warns when the same ticket is scanned again straight away and shows who it belongs to', async () => {
  const code = D.passCode;
  const scan = (extra = {}) => api('POST', '/tickets/scan', { token: T.counter, body: { code, ...extra } });
  const first = await scan();
  assert.equal(first.body.result, 'ok');
  assert.equal(first.body.holder.name, 'Sean Season');
  assert.equal(first.body.holder.photo, JPEG);
  assert.equal(first.body.holder.kind, 'season_pass');
  const second = await scan();
  assert.equal(second.body.result, 'duplicate');
  assert.equal(second.body.valid, false);
  assert.ok(second.body.scanned_before);
  assert.equal((await scan({ override: true })).body.result, 'ok');
  assert.equal((await api('PUT', '/tenant/profile', { token: T.manager, body: { scan_passback_seconds: 0 } })).status, 200);
  assert.equal((await scan()).body.result, 'ok', 'a zero window turns the warning off');
  await api('PUT', '/tenant/profile', { token: T.manager, body: { scan_passback_seconds: 120 } });
});

test('duplicate customers are found, and merging moves everything over and removes the extra record', async () => {
  const mk = (body) => api('POST', '/people', { token: T.counter, body: { last_name: 'Twin', ...ADULT, ...body } });
  const keep = (await mk({ first_name: 'Tess', phone: '610-555-0199' })).body.id;
  const extra = (await mk({ first_name: 'Tess', email: 'tess.twin@x.test', boot_size: '8' })).body.id;
  assert.notEqual(keep, extra);
  assert.equal((await api('GET', '/people/duplicates', { token: T.counter })).status, 403);
  const dups = await api('GET', '/people/duplicates', { token: T.manager });
  const grp = dups.body.data.find((g) => g.some((p) => p.id === keep));
  assert.ok(grp && grp.some((p) => p.id === extra), 'same name and date of birth');
  const s = await sell(T.counter, { channel: 'window', customer: { person_id: extra }, lines: [{ type: 'ticket', product_id: D.day }], payments: [{ tender: 'cash', amount_cents: 10600 }] });
  assert.equal(s.status, 201, s.text);
  assert.equal((await api('POST', `/people/${extra}/merge`, { token: T.counter, body: { into_id: keep } })).status, 403);
  assert.equal((await api('POST', `/people/${extra}/merge`, { token: T.manager, body: { into_id: extra } })).status, 400);
  const m = await api('POST', `/people/${extra}/merge`, { token: T.manager, body: { into_id: keep } });
  assert.equal(m.status, 200, m.text);
  assert.equal((await api('GET', `/people/${extra}`, { token: T.manager })).status, 404);
  const kept = await api('GET', `/people/${keep}`, { token: T.manager });
  assert.equal(kept.body.email, 'tess.twin@x.test', 'blanks are filled from the merged record');
  assert.equal(kept.body.phone, '610-555-0199');
  assert.equal(kept.body.boot_size, '8');
  const act = await api('GET', `/people/${keep}/activity`, { token: T.manager });
  assert.equal(act.body.orders.length, 1, 'the sale now belongs to the kept record');
  assert.equal(act.body.tickets.length, 1);
});

test('a customer who is staff or has a login cannot be merged away', async () => {
  const u = await q("SELECT person_id FROM users WHERE email = ?", [`counter@${A.slug}.test`]);
  const pid = u[0].person_id;
  if (!pid) return; // logins made without a person record have nothing to merge
  const other = (await api('POST', '/people', { token: T.manager, body: { first_name: 'Other', last_name: 'One', ...ADULT } })).body.id;
  assert.equal((await api('POST', `/people/${pid}/merge`, { token: T.manager, body: { into_id: other } })).status, 409);
});

test('tenants cannot see or merge each other\'s customers', async () => {
  const b = (await api('POST', '/people', { token: B.owner, body: { first_name: 'Bee', last_name: 'Other', ...ADULT } })).body.id;
  assert.equal((await api('GET', `/people/${b}/family`, { token: T.manager })).status, 404);
  assert.equal((await api('POST', `/people/${b}/merge`, { token: T.manager, body: { into_id: D.gail } })).status, 404);
  assert.equal((await api('GET', `/people/${b}/photo`, { token: T.manager })).status, 404);
});

// ---------------------------------------------------------------- two-step sign-in
test('the one-time-code maths matches the published test vectors', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.hotp(secret, 1), '287082'); // RFC 4226 appendix D
  assert.equal(totp.hotp(secret, 0), '755224');
  assert.equal(totp.verify(secret, '287082', 59 * 1000), 1, 'RFC 6238: time 59 s is step 1');
  assert.equal(totp.verify(secret, '000000', 59 * 1000), null);
  assert.equal(totp.open(totp.seal('ABCDEF')), 'ABCDEF');
});

test('two-step sign-in: set up, sign in with a code, use a recovery code once, and turn it off', async () => {
  const email = `mfa@${A.slug}.test`;
  const token = await addUser(A, email, 'manager');
  const setup = await api('POST', '/auth/mfa/setup', { token });
  assert.equal(setup.status, 200, setup.text);
  assert.match(setup.body.otpauth_uri, /^otpauth:\/\/totp\//);
  const stored = (await q('SELECT totp_secret FROM users WHERE email = ?', [email]))[0].totp_secret;
  assert.ok(!stored.includes(setup.body.secret), 'the secret is encrypted in the database');
  assert.equal((await api('POST', '/auth/mfa/enable', { token, body: { code: '000000' } })).status, 400);
  const code = () => totp.hotp(setup.body.secret, totp.stepAt(Date.now()));
  const en = await api('POST', '/auth/mfa/enable', { token, body: { code: code() } });
  assert.equal(en.status, 200, en.text);
  assert.equal(en.body.recovery_codes.length, 8);
  assert.equal((await q('SELECT code_hash FROM user_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = ?)', [email])).length, 8);

  const login = await api('POST', '/auth/login', { body: { tenant: A.slug, email, password: PW } });
  assert.equal(login.body.mfa_required, true);
  assert.equal(login.body.token, undefined, 'no session until the second step');
  assert.equal((await api('GET', '/auth/me', { token: login.body.mfa_token })).status, 401, 'the half-signed-in token opens nothing');
  assert.equal((await api('POST', '/auth/mfa', { body: { mfa_token: login.body.mfa_token, code: '123456' } })).status, 401);
  // A code that was already used to turn it on cannot be used again; use the next step's code.
  const next = totp.hotp(setup.body.secret, totp.stepAt(Date.now()) + 1);
  const done = await api('POST', '/auth/mfa', { body: { mfa_token: login.body.mfa_token, code: next } });
  assert.equal(done.status, 200, done.text);
  assert.equal((await api('GET', '/auth/me', { token: done.body.token })).body.mfa_enabled, true);
  const replay = await api('POST', '/auth/mfa', { body: { mfa_token: login.body.mfa_token, code: next } });
  assert.equal(replay.status, 401, 'the same code is refused the second time');

  const rc = en.body.recovery_codes[0];
  const login2 = await api('POST', '/auth/login', { body: { tenant: A.slug, email, password: PW } });
  const viaRecovery = await api('POST', '/auth/mfa', { body: { mfa_token: login2.body.mfa_token, code: rc.toLowerCase() } });
  assert.equal(viaRecovery.status, 200, viaRecovery.text);
  assert.equal(viaRecovery.body.recovery_codes_left, 7);
  const login3 = await api('POST', '/auth/login', { body: { tenant: A.slug, email, password: PW } });
  assert.equal((await api('POST', '/auth/mfa', { body: { mfa_token: login3.body.mfa_token, code: rc } })).status, 401, 'a recovery code works once');

  // A manager can clear it for someone who lost their phone.
  const uid = (await q('SELECT id FROM users WHERE email = ?', [email]))[0].id;
  assert.equal((await api('POST', `/users/${uid}/reset-mfa`, { token: T.counter })).status, 403);
  assert.equal((await api('POST', `/users/${uid}/reset-mfa`, { token: A.owner })).status, 200);
  const after = await api('POST', '/auth/login', { body: { tenant: A.slug, email, password: PW } });
  assert.ok(after.body.token, 'back to password only');
});

test('wrong second-step codes lock the login for a few minutes', async () => {
  const email = `lock@${A.slug}.test`;
  const token = await addUser(A, email, 'counter');
  const setup = await api('POST', '/auth/mfa/setup', { token });
  assert.equal((await api('POST', '/auth/mfa/enable', { token, body: { code: totp.hotp(setup.body.secret, totp.stepAt(Date.now())) } })).status, 200);
  const login = await api('POST', '/auth/login', { body: { tenant: A.slug, email, password: PW } });
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/auth/mfa', { body: { mfa_token: login.body.mfa_token, code: '111111' } })).status, 401);
  const good = totp.hotp(setup.body.secret, totp.stepAt(Date.now()) + 1);
  assert.equal((await api('POST', '/auth/mfa', { body: { mfa_token: login.body.mfa_token, code: good } })).status, 429, 'even the right code is refused while locked');
});

test('when the mountain requires two-step sign-in, people without it can only reach the setup screens', async () => {
  const M = await mountain(`fm-${suffix}`);
  const staff = await addUser(M, `staff@${M.slug}.test`, 'counter');
  assert.equal((await api('GET', '/checkout/menu', { token: staff })).status, 200);
  assert.equal((await api('PUT', '/tenant/profile', { token: M.owner, body: { require_mfa: true } })).status, 200);
  const blocked = await api('GET', '/checkout/menu', { token: staff });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.details.code, 'mfa_enrollment_required');
  const me = await api('GET', '/auth/me', { token: staff });
  assert.equal(me.status, 200);
  assert.equal(me.body.mfa_enrollment_required, true);
  const setup = await api('POST', '/auth/mfa/setup', { token: staff });
  assert.equal(setup.status, 200);
  assert.equal((await api('POST', '/auth/mfa/enable', { token: staff, body: { code: totp.hotp(setup.body.secret, totp.stepAt(Date.now())) } })).status, 200);
  assert.equal((await api('GET', '/checkout/menu', { token: staff })).status, 200, 'enrolled, so the gate opens');
  const off = await api('POST', '/auth/mfa/disable', { token: staff, body: { password: PW, code: totp.hotp(setup.body.secret, totp.stepAt(Date.now()) + 1) } });
  assert.equal(off.status, 403, 'cannot be turned off while required');
});
