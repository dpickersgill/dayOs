'use strict';

// The guest rental form (from an order link, a walk-in QR poster, a group link), using a form at the counter (matching
// people, signoffs, attaching to the order's to_fit contracts), and rental groups (members, set aside, bag scan, hand out).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.RENTAL_FORM_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const F = require('../src/lib/rentalforms');

let server; let base;
const suffix = Date.now().toString(36) + Math.floor(Math.random() * 100);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let A; let B;

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
  const [[row]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  await pool.query("UPDATE tenants SET timezone = 'America/New_York' WHERE id = ?", [row.id]);
  return { slug, token: l.body.token, id: row.id };
}
const person = (first, last, dob, extra = {}) => ({
  first_name: first, last_name: last, date_of_birth: dob, discipline: 'ski', height_in: 60, weight_lb: 110, boot_size: '6', ability: 'moderate', helmet: true,
  signer_name: `${first} ${last}`, signer_relation: 'self', signature: PNG, agree: true, ...extra,
});
const adultDob = '1985-02-03';
const kidDob = addDays(today, -10 * 365);
const item = async (t, sku, category, extra = {}) => (await api('POST', '/rentals/items', { token: t.token, body: { sku, category, ...extra } })).body.id;

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`rform-a-${suffix}`);
  B = await mountain(`rform-b-${suffix}`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('cleanPerson checks who signs and keeps the ability as a type', () => {
  const p = F.cleanPerson(person('Ann', 'Lee', adultDob), today);
  assert.equal(p.skier_type, '2');
  assert.throws(() => F.cleanPerson(person('Kid', 'Lee', kidDob), today), /parent or guardian/);
  assert.equal(F.cleanPerson(person('Kid', 'Lee', kidDob, { signer_name: 'Ann Lee', signer_relation: 'parent' }), today).signer_relation, 'parent');
  assert.throws(() => F.cleanPerson(person('Ann', 'Lee', adultDob, { signer_name: 'Bob Lee' }), today), /signs for themselves/);
  assert.throws(() => F.cleanPerson(person('Ann', 'Lee', adultDob, { signature: 'data:image/png;base64,AAAA' }), today), /sign/);
  assert.throws(() => F.cleanPerson(person('Ann', 'Lee', adultDob, { ability: '' }), today), /skis or rides/);
  assert.equal(F.parseContractCode('rc-42'), 42);
  assert.equal(F.parseContractCode('ORD-42'), null);
});

let orderId; let buyer; let token;
test('an order with rentals gets a form link on its receipt; the link shows only the day and how many renters', async () => {
  buyer = (await api('POST', '/people', { token: A.token, body: { first_name: 'Ann', last_name: 'Lee', date_of_birth: adultDob } })).body.id;
  const [o] = await pool.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, total_cents, channel) VALUES (?, ?, 'paid', 8000, 8000, 'window')", [A.id, buyer]);
  orderId = o.insertId;
  for (let i = 0; i < 2; i++) await pool.query("INSERT INTO order_items (tenant_id, order_id, line_kind, person_id, quantity, unit_price_cents, valid_on) VALUES (?, ?, 'rental', ?, 1, 4000, ?)", [A.id, orderId, buyer, today]);
  const rec = await api('GET', `/orders/${orderId}/receipt`, { token: A.token });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.match(rec.body.rental_form_url, new RegExp(`/rental-form/${A.slug}\\?t=[A-Za-z0-9_-]{32}$`));
  token = new URL(rec.body.rental_form_url).searchParams.get('t');
  assert.equal((await api('GET', `/rentals/orders/${orderId}/form-link`, { token: A.token })).body.url, rec.body.rental_form_url, 'the same link every time');
  const [[row]] = await pool.query('SELECT rental_form_token_sha FROM orders WHERE id = ?', [orderId]);
  assert.equal(row.rental_form_token_sha, F.sha(token), 'only the hash is kept');
  const page = await api('GET', `/public/${A.slug}/rental-form?t=${token}`);
  assert.equal(page.status, 200);
  assert.deepEqual(page.body.order, { day: today, renters: 2, sent: false });
  assert.ok(!JSON.stringify(page.body).includes('Lee'), 'no names without staff');
  assert.equal((await api('GET', `/public/${A.slug}/rental-form?t=${'x'.repeat(32)}`)).status, 404);
  assert.equal((await api('GET', `/public/${B.slug}/rental-form?t=${token}`)).status, 404, 'a link works only at its own mountain');
  const page2 = await api('GET', `/public/${A.slug}/rental-form`);
  assert.equal(page2.status, 200); assert.equal(page2.body.order, null);
});

test('the public form checks what it gets, and a bot filling the hidden box saves nothing', async () => {
  const bad1 = await api('POST', `/public/${A.slug}/rental-form`, { body: { t: token, contact_name: 'Ann Lee', people: [person('Kid', 'Lee', kidDob)] } });
  assert.equal(bad1.status, 400); assert.match(bad1.body.error, /parent or guardian/);
  const bad2 = await api('POST', `/public/${A.slug}/rental-form`, { body: { contact_name: 'Walk In', people: [person('Wal', 'In', adultDob)] } });
  assert.equal(bad2.status, 400); assert.match(bad2.body.error, /phone/);
  const bot = await api('POST', `/public/${A.slug}/rental-form`, { body: { contact_name: 'Bot', phone: '555', website: 'http://spam', people: [person('B', 'Ot', adultDob)] } });
  assert.equal(bot.status, 201);
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM rental_forms WHERE tenant_id = ? AND contact_name = 'Bot'", [A.id]);
  assert.equal(n.n, 0);
  const tooMany = await api('POST', `/public/${A.slug}/rental-form`, { body: { contact_name: 'X', phone: '5551234', people: Array.from({ length: 11 }, () => person('A', 'B', adultDob)) } });
  assert.equal(tooMany.status, 400);
});

let formId;
test('the order form: submitted, found at the counter, used: people matched, signoffs written, put on the to_fit contracts', async () => {
  const sent = await api('POST', `/public/${A.slug}/rental-form`, { body: { t: token, contact_name: 'Ann Lee', phone: '(555) 201-3344', email: 'ann@example.com',
    people: [person('Ann', 'Lee', adultDob, { weight_lb: 140, height_in: 66, ability: 'aggressive' }), person('Kit', 'Lee', kidDob, { signer_name: 'Ann Lee', signer_relation: 'parent', discipline: 'snowboard', stance: 'goofy', boot_size: '', shoe_size: '4' })] } });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  formId = sent.body.id;
  assert.equal((await api('GET', `/public/${A.slug}/rental-form?t=${token}`)).body.order.sent, true);
  // Track FIT makes one to_fit contract per renter; both made out to the buyer here
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const [c] = await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, order_id, status, due_at, valid_on, stage) VALUES (?, ?, ?, 'to_fit', ?, ?, 'form')", [A.id, buyer, orderId, `${today} 16:30:00`, today]);
    ids.push(c.insertId);
  }
  for (const q of ['Kit', '2013344', String(orderId)]) {
    const list = await api('GET', `/rentals/forms?q=${encodeURIComponent(q)}`, { token: A.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((f) => f.id === formId), `found by ${q}`);
    assert.ok(list.body.data.every((f) => f.people.every((p) => !p.signature)), 'lists carry no signatures');
  }
  assert.equal((await api('GET', '/rentals/forms', { token: B.token })).body.data.length, 0, 'another mountain sees nothing');
  assert.equal((await api('GET', `/rentals/forms/${formId}`, { token: B.token })).status, 404);
  const detail = await api('GET', `/rentals/forms/${formId}`, { token: A.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.people[0].candidates[0].id, buyer);
  assert.equal(detail.body.people[0].candidates[0].dob_match, true);
  assert.equal(detail.body.to_fit.length, 2);
  const used = await api('POST', `/rentals/forms/${formId}/use`, { token: A.token, body: { people: [{ index: 0, person_id: buyer }, { index: 1, person_id: null }] } });
  assert.equal(used.status, 200, JSON.stringify(used.body));
  const kit = used.body.people[1];
  assert.equal(kit.created, true);
  assert.equal(used.body.attached.length, 2);
  const [cs] = await pool.query('SELECT id, person_id, stage FROM rental_contracts WHERE id IN (?) ORDER BY id', [ids]);
  assert.deepEqual(cs.map((c) => c.person_id).sort(), [buyer, kit.person_id].sort());
  assert.ok(cs.every((c) => c.stage === 'boots'), 'the form is in, so stations move them on to boots');
  const [[ann]] = await pool.query('SELECT weight_lb, height_in, skier_type, phone FROM people WHERE id = ?', [buyer]);
  assert.equal(ann.weight_lb, 140); assert.equal(ann.skier_type, '3'); assert.equal(ann.phone, '(555) 201-3344');
  const [[prof]] = await pool.query('SELECT skier_type, stance, shoe_size FROM rental_profiles WHERE tenant_id = ? AND person_id = ?', [A.id, kit.person_id]);
  assert.deepEqual({ ...prof }, { skier_type: '2', stance: 'goofy', shoe_size: '4' });
  const [so] = await pool.query('SELECT person_id, contract_id, form_id, via, signer_name, signer_relation, details FROM rental_signoffs WHERE tenant_id = ? AND form_id = ? ORDER BY id', [A.id, formId]);
  assert.equal(so.length, 2);
  assert.ok(so.every((s) => s.via === 'form' && s.contract_id === null));
  assert.equal(so[1].signer_relation, 'parent'); assert.equal(so[1].signer_name, 'Ann Lee');
  const det = typeof so[1].details === 'string' ? JSON.parse(so[1].details) : so[1].details;
  assert.equal(det.ability, 'moderate'); assert.equal(det.signature, undefined);
  assert.equal((await api('POST', `/rentals/forms/${formId}/use`, { token: A.token, body: {} })).status, 409);
  // to_fit is never "out"
  assert.ok(!(await api('GET', '/rentals/contracts?status=out', { token: A.token })).body.data.some((c) => ids.includes(c.id)));
});

test('a walk-in form: today only by default, discard for junk', async () => {
  const sent = await api('POST', `/public/${A.slug}/rental-form`, { body: { contact_name: 'Wal In', phone: '555-777-8888', people: [person('Wal', 'In', adultDob)] } });
  assert.equal(sent.status, 201);
  const ahead = await api('POST', `/public/${A.slug}/rental-form`, { body: { contact_name: 'Fut Ure', phone: '555-777-9999', rental_on: addDays(today, 3), people: [person('Fut', 'Ure', adultDob)] } });
  assert.equal(ahead.status, 201);
  const past = await api('POST', `/public/${A.slug}/rental-form`, { body: { contact_name: 'Pa St', phone: '555', rental_on: addDays(today, -1), people: [person('Pa', 'St', adultDob)] } });
  assert.equal(past.status, 400);
  const list = (await api('GET', '/rentals/forms', { token: A.token })).body.data;
  assert.ok(list.some((f) => f.id === sent.body.id)); assert.ok(!list.some((f) => f.id === ahead.body.id));
  assert.ok((await api('GET', '/rentals/forms?coming=1', { token: A.token })).body.data.some((f) => f.id === ahead.body.id));
  assert.equal((await api('POST', `/rentals/forms/${ahead.body.id}/discard`, { token: B.token })).status, 404);
  assert.equal((await api('POST', `/rentals/forms/${ahead.body.id}/discard`, { token: A.token })).status, 200);
  assert.ok(!(await api('GET', '/rentals/forms?coming=1', { token: A.token })).body.data.some((f) => f.id === ahead.body.id));
  const link = await api('GET', '/rentals/forms/link', { token: A.token });
  assert.match(link.body.url, new RegExp(`/rental-form/${A.slug}$`));
});

test('groups: members from a list and a parent form, gear set aside, bag labels scanned, the rest handed out at once', async () => {
  const g = await api('POST', '/rentals/groups', { token: A.token, body: { name: 'Pine School', leader_name: 'Ms Pine', leader_email: 'pine@example.com', rental_on: today, days: 1 } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gid = g.body.id;
  const pasted = await api('POST', `/rentals/groups/${gid}/members`, { token: A.token, body: { rows: [
    { first_name: 'Sam', last_name: 'Oak', date_of_birth: kidDob, height_in: 54, weight_lb: 80, boot_size: '4', skier_type: '1' },
    { first_name: 'Tia', last_name: 'Elm', date_of_birth: kidDob, height_in: 52, weight_lb: 75, boot_size: '3', skier_type: '2' },
  ] } });
  assert.equal(pasted.status, 201, JSON.stringify(pasted.body));
  assert.equal(pasted.body.added, 2);
  let page = (await api('GET', `/rentals/groups/${gid}`, { token: A.token })).body;
  assert.equal(page.members.length, 2);
  assert.ok(page.members.every((m) => m.details_in && !m.signed && !m.waiver_signed));
  const gtoken = new URL(page.link).searchParams.get('g');
  const pub = await api('GET', `/public/${A.slug}/rental-form?g=${gtoken}`);
  assert.equal(pub.status, 200); assert.deepEqual(pub.body.group, { name: 'Pine School', day: today });
  // a parent fills in Sam's form from the group link: it matches Sam on the list
  const f = await api('POST', `/public/${A.slug}/rental-form`, { body: { g: gtoken, contact_name: 'Pat Oak', phone: '5550001111', people: [person('Sam', 'Oak', kidDob, { signer_name: 'Pat Oak', signer_relation: 'parent' })] } });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  page = (await api('GET', `/rentals/groups/${gid}`, { token: A.token })).body;
  assert.equal(page.forms.length, 1);
  assert.equal((await api('POST', `/rentals/forms/${f.body.id}/use`, { token: A.token, body: {} })).status, 200);
  page = (await api('GET', `/rentals/groups/${gid}`, { token: A.token })).body;
  assert.equal(page.members.length, 2, 'matched, not added twice');
  const sam = page.members.find((m) => m.first_name === 'Sam'); const tia = page.members.find((m) => m.first_name === 'Tia');
  assert.equal(sam.signed, true); assert.equal(tia.signed, false);

  const s1 = await item(A, `GS1-${suffix}`, 'ski', { size: '120' }); const b1 = await item(A, `GB1-${suffix}`, 'boot', { size: '4' });
  const s2 = await item(A, `GS2-${suffix}`, 'ski', { size: '110' });
  const set1 = await api('PUT', `/rentals/groups/${gid}/members/${sam.contract_id}/gear`, { token: A.token, body: { items: [{ rental_item_id: s1, din_setting: 3.5, tech_name: 'Tess', test_result: 'pass' }, { rental_item_id: b1 }] } });
  assert.equal(set1.status, 200, JSON.stringify(set1.body));
  assert.equal((await api('PUT', `/rentals/groups/${gid}/members/${tia.contract_id}/gear`, { token: A.token, body: { items: [{ rental_item_id: s1 }] } })).status, 409, 'gear set aside for one is not free for another');
  assert.equal((await api('PUT', `/rentals/groups/${gid}/members/${tia.contract_id}/gear`, { token: A.token, body: { items: [{ rental_item_id: s2, din_setting: 3, tech_name: 'Tess' }] } })).status, 200);
  const [st] = await pool.query('SELECT id, status FROM rental_items WHERE id IN (?)', [[s1, b1, s2]]);
  assert.ok(st.every((r) => r.status === 'set_aside'));
  const [[gs]] = await pool.query('SELECT status FROM rental_groups WHERE id = ?', [gid]);
  assert.equal(gs.status, 'set');
  // the shop's Out now never shows set-aside bags
  assert.ok(!(await api('GET', '/rentals/contracts?status=out', { token: A.token })).body.data.some((c) => c.group_id === gid));

  // the morning: no waiver yet, so the bag stays
  const noWaiver = await api('POST', '/rentals/groups/scan', { token: A.token, body: { code: F.contractCode(sam.contract_id) } });
  assert.equal(noWaiver.status, 200); assert.match(noWaiver.body.skipped, /waiver/);
  for (const m of [sam, tia]) assert.equal((await api('POST', `/people/${m.person_id}/waivers`, { token: A.token, body: {} })).status < 300, true);
  const out1 = await api('POST', '/rentals/groups/scan', { token: A.token, body: { code: `rc-${sam.contract_id}` } });
  assert.equal(out1.body.out, true, JSON.stringify(out1.body));
  assert.equal((await api('POST', '/rentals/groups/scan', { token: B.token, body: { code: `RC-${tia.contract_id}` } })).status, 404, 'another mountain cannot scan it');
  // Tia has no signed details yet: the leader's hand-out lists her as not ready
  const all = await api('POST', `/rentals/groups/${gid}/handout`, { token: A.token, body: {} });
  assert.equal(all.status, 200);
  assert.equal(all.body.out.length, 0); assert.match(all.body.skipped[0].skipped, /not signed/);
  await pool.query("INSERT INTO rental_signoffs (tenant_id, person_id, contract_id, signer_name, signer_relation, details, signature, via) VALUES (?, ?, ?, 'Pat Elm', 'parent', '{}', ?, 'counter')", [A.id, tia.person_id, tia.contract_id, PNG]);
  const all2 = await api('POST', `/rentals/groups/${gid}/handout`, { token: A.token, body: {} });
  assert.equal(all2.body.out.length, 1);
  const [items] = await pool.query('SELECT status FROM rental_items WHERE id IN (?)', [[s1, b1, s2]]);
  assert.ok(items.every((r) => r.status === 'rented'));
  const outNow = (await api('GET', '/rentals/contracts?status=out', { token: A.token })).body.data.filter((c) => c.group_id === gid);
  assert.equal(outNow.length, 2);
  const [[g2]] = await pool.query('SELECT status FROM rental_groups WHERE id = ?', [gid]);
  assert.equal(g2.status, 'out');
  // the normal check-in still works on a group contract
  const back = await api('POST', `/rentals/contracts/${sam.contract_id}/checkin`, { token: A.token, body: {} });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.status, 'returned');
});

test('groups: a member taken off puts their gear back; closing the group puts it away', async () => {
  const g = (await api('POST', '/rentals/groups', { token: A.token, body: { name: 'Ski Club', rental_on: addDays(today, 1), days: 2 } })).body.id;
  await api('POST', `/rentals/groups/${g}/members`, { token: A.token, body: { rows: [{ first_name: 'Ola', last_name: 'Fir', date_of_birth: kidDob }] } });
  const m = (await api('GET', `/rentals/groups/${g}`, { token: A.token })).body.members[0];
  assert.equal(String(m.due_at).slice(0, 16).replace('T', ' '), `${addDays(today, 2)} 16:30`);
  const sk = await item(A, `GX-${suffix}`, 'ski');
  await api('PUT', `/rentals/groups/${g}/members/${m.contract_id}/gear`, { token: A.token, body: { items: [{ rental_item_id: sk }] } });
  assert.equal((await api('DELETE', `/rentals/groups/${g}/members/${m.contract_id}`, { token: A.token })).status, 200);
  const [[it]] = await pool.query('SELECT status FROM rental_items WHERE id = ?', [sk]);
  assert.equal(it.status, 'available');
  assert.equal((await api('PATCH', `/rentals/groups/${g}`, { token: A.token, body: { status: 'closed' } })).status, 200);
  assert.ok(!(await api('GET', '/rentals/groups', { token: A.token })).body.data.some((x) => x.id === g));
  assert.equal((await api('GET', `/rentals/groups/${g}`, { token: B.token })).status, 404);
});
