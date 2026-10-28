'use strict';

// Programs, the best-of-breed set: types the mountain names; a price built from parts (lessons, a lift ticket a season
// pass holder does not pay, rental, helmet); the pass check (found, or flagged for the first lesson); a pass bought later
// refunded or credited as the mountain chose; ski or snowboard; late joiners; school levels as classes; the day-before
// reminder; and the parent's own page (sign-in link, every date, report card, switch day, withdraw).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SHOP_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');

let server; let base; let stripeMock; let pmMock; const mails = []; const refunds = []; let n = 0;
const PP = require('../src/lib/programplus');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
let monday = plus(today, 14); while (dow(monday) !== 1) monday = plus(monday, 1);
const year = Number(today.slice(0, 4));

const DEVICE = 'test-device-0123456789abcdef'; // the app always says which device signs in; leaving it out asks for an emailed code
async function call(prefix, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'x-device': DEVICE,  'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const ok = (r, s) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); if (s) assert.equal(r.status, s); return r.body; };
const is = (r, s, why) => assert.equal(r.status, s, `${why || ''} ${r.text}`);
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const paid = (row, tenant) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(tenant), registration_id: String(row.id), kind: 'program' } } } });

const M = {};
let pub;
test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') res.end(JSON.stringify({ id: `cs_prog_${++n}`, url: `https://checkout.stripe.test/c/${n}` }));
      else if (req.url === '/v1/refunds') { const p = Object.fromEntries(new URLSearchParams(data)); refunds.push(p); res.end(JSON.stringify({ id: `re_${++n}`, payment_intent: p.payment_intent, status: 'succeeded' })); }
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  pmMock = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => stripeMock.listen(0, '127.0.0.1', r));
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${stripeMock.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `pp-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Pine Peak', phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.slug = slug; M.id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  for (const m of ['programs', 'shop', 'school']) await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [M.id, m]);
  modules.invalidate(M.id);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `inst@${slug}.test`, password: PW, role: 'instructor' } }));
  ok(await api('POST', '/users', { token: M.owner, body: { email: `desk@${slug}.test`, password: PW, role: 'counter' } }));
  M.inst = await login(`inst@${slug}.test`); M.desk = await login(`desk@${slug}.test`);
  M.ticket = ok(await api('POST', '/products', { token: M.owner, body: { kind: 'day_ticket', name: 'Program lift ticket', base_price_cents: 0 } })).id;
  ok(await api('POST', '/tax-rules', { token: M.owner, body: { name: 'Sales tax', applies_to: 'program', rate_percent: 6 } }));
  ok(await api('PUT', '/tenant/profile', { token: M.owner, body: { online_shop: true, waiver_text: 'I accept the risks of skiing.' } }));
  pub = (m, p, o) => call('/api/v1/public', m, `/${slug}${p}`, o);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stripeMock.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

const person = async (first, last, dob) => ok(await api('POST', '/people', { token: M.owner, body: { first_name: first, last_name: last, date_of_birth: dob, sex: 'female', email: `${first.toLowerCase()}.${suffix}@x.test`, phone: '215-555-0199' } })).id;

const contact = (tag) => ({ contact_first_name: 'Pat', contact_last_name: `Parent${tag}`, contact_email: `pat.${tag}.${suffix}@x.test`, contact_phone: '215-555-0150' });
const kidOf = (first, last, age) => ({ first_name: first, last_name: last, date_of_birth: `${year - age}-01-15` });
async function payFor(reference) {
  const row = (await q('SELECT * FROM program_registrations WHERE tenant_id = ? AND reference = ?', [M.id, reference]))[0];
  ok(await webhook(paid(row, M.id)));
  return row;
}

test('program types are the mountain\'s own: made the first time, renamed, added, hidden, and on each program', async () => {
  const types = ok(await api('GET', '/programs/types', { token: M.desk })).data;
  assert.ok(types.some((x) => x.name === 'Multi-week lessons') && types.some((x) => x.name === 'Race team'));
  M.homeschool = ok(await api('POST', '/programs/types', { token: M.owner, body: { name: 'Homeschool' } }), 201).id;
  is(await api('POST', '/programs/types', { token: M.owner, body: { name: 'Homeschool' } }), 409);
  is(await api('POST', '/programs/types', { token: M.desk, body: { name: 'Nope' } }), 403);
  const league = types.find((x) => x.name === 'League').id;
  ok(await api('PATCH', `/programs/types/${league}`, { token: M.owner, body: { hidden: true } }));
  M.multi = types.find((x) => x.name === 'Multi-week lessons').id;
  const pid = ok(await api('POST', '/programs', { token: M.owner, body: { name: 'Homeschool Fridays', season: '2026-27', type_id: M.homeschool } })).id;
  const list = ok(await api('GET', `/programs?type_id=${M.homeschool}`, { token: M.owner })).data;
  assert.deepEqual(list.map((x) => x.id), [pid]);
});

test('the price is built from parts: lessons, a lift ticket only without a pass, rental and helmet when asked; siblings save on lessons', async () => {
  M.program = ok(await api('POST', '/programs', { token: M.owner, body: { name: 'After-School Ski & Ride', season: '2026-27', type_id: M.multi, age_min: 5, age_max: 14, online: true,
    includes_ticket: true, ticket_product_id: M.ticket, includes_rental: true, offers_helmet: true, sibling_mode: 'percent', sibling_value: 10, snowboard_age_min: 7,
    meeting_place: 'The bell by the lodge', what_to_bring: 'Snack, goggles', cancel_days: 7, cancel_fee_cents: 2500, allow_switch: true } })).id;
  const s1 = ok(await api('POST', `/programs/${M.program}/terms`, { token: M.owner, body: {
    name: 'Session 1', starts_on: monday, weeks: 4, makeup_weeks: 1, start_time: '15:45', end_time: '17:45', price_cents: 16000, ticket_cents: 8000, rental_cents: 6000, helmet_cents: 1500, status: 'open',
    days: [{ weekday: 1, capacity: 10 }, { weekday: 2, capacity: 10, discipline: 'snowboard' }, { weekday: 3, capacity: 10 }],
  } }), 201);
  M.s1 = s1.id; [M.mon, M.tue, M.wed] = s1.groups;
  // Ana already has a season pass on file; Bo says he has one but it is not found; Cy has none and needs rental and a helmet.
  const ana = await person('Ana', 'Pass', `${year - 9}-01-15`);
  const pass = ok(await api('POST', '/products', { token: M.owner, body: { kind: 'season_pass', name: 'Kids season pass', base_price_cents: 30000, valid_days: 200 } })).id;
  M.pass = pass;
  const [oi] = await pool.query("INSERT INTO orders (tenant_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, channel) VALUES (?, 'paid', 0, 0, 0, 0, 'window')", [M.id]);
  const [it] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, discount_cents, tax_cents) VALUES (?, ?, ?, 'ticket', ?, 'child', 1, 0, 0, 0)", [M.id, oi.insertId, pass, ana]);
  await q('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)', [M.id, it.insertId, ana, pass, `PASS${n++}${suffix}`.slice(0, 20), today, plus(today, 200)]);
  const regs = [
    { program_id: M.program, term_id: M.s1, group_id: M.mon.id, child: kidOf('Ana', 'Pass', 9), discipline: 'ski', has_pass: false },
    { program_id: M.program, term_id: M.s1, group_id: M.mon.id, child: kidOf('Bo', 'Pass', 8), discipline: 'ski', has_pass: true },
    { program_id: M.program, term_id: M.s1, group_id: M.mon.id, child: kidOf('Cy', 'Pass', 10), discipline: 'ski', needs_rental: true, needs_helmet: true, sizes: { height_in: 52, weight_lb: 70, boot_size: '3' } },
  ];
  const qt = ok(await pub('POST', '/programs/quote', { body: { registrations: regs } }));
  assert.deepEqual(qt.lines.map((l) => [l.pass, l.lesson_cents, l.ticket_cents, l.rental_cents, l.helmet_cents, l.sibling_cents]), [
    ['found', 16000, 0, 0, 0, 0], ['check', 16000, 0, 0, 0, 1600], ['none', 16000, 8000, 6000, 1500, 1600]]);
  is(await pub('POST', '/programs/quote', { body: { registrations: [{ ...regs[0], group_id: M.tue.id }] } }), 400, 'Tuesdays are snowboard only');
  is(await pub('POST', '/programs/quote', { body: { registrations: [{ ...regs[0], child: kidOf('Di', 'Pass', 6), group_id: M.tue.id, discipline: 'snowboard' }] } }), 400, 'snowboard from 7');
  const r = ok(await pub('POST', '/programs/register', { body: { ...contact('a'), registrations: regs.map((x, i) => (i === 2 ? { ...x, allergies: 'Peanuts', pickup: [{ name: 'Gran Pass', phone: '215-555-0199', relation: 'Grandmother' }] } : x)), waiver_accepted: true } }), 201);
  await payFor(r.reference);
  const roster = ok(await api('GET', `/programs/groups/${M.mon.id}/roster`, { token: M.inst })).data;
  const by = (f) => roster.find((x) => x.first_name === f);
  assert.deepEqual([by('Ana').pass_status, by('Bo').pass_status, by('Cy').pass_status], ['verified', 'claimed', 'none']);
  assert.equal(by('Ana').ticket_code, null, 'a pass holder gets no program ticket');
  assert.ok(by('Cy').ticket_code);
  assert.equal(by('Cy').allergies, 'Peanuts');
  assert.equal(by('Cy').pickup[0].name, 'Gran Pass');
  assert.deepEqual([by('Cy').needs_rental, by('Cy').needs_helmet, by('Cy').height_in, by('Cy').boot_size], [true, true, 52, '3'], 'sizes go on the child\'s record for the rental shop');
  // Bo's pass is checked at the first lesson: not there, so the ticket part is owed and his ticket issued.
  const bo = await api('POST', `/programs/enrollments/${by('Bo').enrollment_id}/pass`, { token: M.desk, body: { result: 'no_pass' } });
  assert.equal(ok(bo).owes_added_cents, 8000);
  assert.ok(bo.body.ticket);
  const after = ok(await api('GET', `/programs/groups/${M.mon.id}/roster`, { token: M.inst })).data.find((x) => x.first_name === 'Bo');
  assert.equal(after.owes_cents, 8000);
  M.cy = by('Cy');
});

test('a season pass bought later: the mountain chooses nothing, a refund of the unused ticket share to the card, or a credit', async () => {
  const cyId = M.cy.person_id;
  await q("UPDATE people SET photo = 'data:image/jpeg;base64,AAAA', sex = 'female' WHERE tenant_id = ? AND id = ?", [M.id, cyId]);
  const guardian = (await q('SELECT guardian_id FROM program_enrollments WHERE id = ?', [M.cy.enrollment_id]))[0].guardian_id;
  await q("UPDATE people SET sex = 'female', date_of_birth = ? WHERE tenant_id = ? AND id = ?", [`${year - 40}-05-05`, M.id, guardian]);
  ok(await api('PUT', '/programs/settings', { token: M.owner, body: { pass_later: 'refund', pass_later_share: 'unused' } }));
  const before = refunds.length;
  const sale = ok(await api('POST', '/checkout', { token: M.desk, body: { customer: { person_id: guardian }, participants: { c: { person_id: cyId } },
    lines: [{ type: 'ticket', product_id: M.pass, tier: 'child', valid_on: today, holders: ['c'] }], payments: [{ tender: 'cash', amount_cents: 30000 }] } }), 201);
  assert.equal(sale.program_adjustments.length, 1);
  const adj = sale.program_adjustments[0];
  assert.equal(adj.how, 'card', 'paid online by card, so back to the card');
  assert.equal(adj.cents, 8000 + Math.round(8000 * 0.06), 'no lesson has happened yet: the whole ticket part, with its tax');
  assert.equal(refunds.length, before + 1, 'sent to Stripe');
  const e = (await q('SELECT pass_status, adjust_how, ticket_id FROM program_enrollments WHERE id = ?', [M.cy.enrollment_id]))[0];
  assert.equal(e.pass_status, 'verified');
  assert.equal((await q('SELECT status FROM tickets WHERE id = ?', [e.ticket_id]))[0].status, 'void', 'the program ticket is voided');
  // Credit: a gift card for the family.
  ok(await api('PUT', '/programs/settings', { token: M.owner, body: { pass_later: 'credit' } }));
  const kid = await person('Dee', 'Credit', `${year - 9}-02-02`);
  const mom = await person('Mae', 'Credit', `${year - 40}-02-02`);
  await q("UPDATE people SET photo = 'data:image/jpeg;base64,AAAA' WHERE tenant_id = ? AND id = ?", [M.id, kid]);
  ok(await api('POST', '/checkout', { token: M.desk, body: { customer: { person_id: mom }, participants: { k: { person_id: kid } },
    lines: [{ type: 'program', program_id: M.program, term_id: M.s1, group_id: M.wed.id, participant: 'k', discipline: 'ski' }], payments: [{ tender: 'cash', amount_cents: Math.round(24000 * 1.06) }] } }), 201);
  const s2 = ok(await api('POST', '/checkout', { token: M.desk, body: { customer: { person_id: mom }, participants: { k: { person_id: kid } },
    lines: [{ type: 'ticket', product_id: M.pass, tier: 'child', valid_on: today, holders: ['k'] }], payments: [{ tender: 'cash', amount_cents: 30000 }] } }), 201);
  assert.equal(s2.program_adjustments[0].how, 'credit');
  assert.equal(s2.program_adjustments[0].cents, 8000);
  const gc = (await q('SELECT balance_cents, purchaser_id FROM gift_cards WHERE tenant_id = ? AND code = ?', [M.id, s2.program_adjustments[0].code]))[0];
  assert.deepEqual([gc.balance_cents, gc.purchaser_id], [8000, mom]);
  ok(await api('PUT', '/programs/settings', { token: M.owner, body: { pass_later: 'none' } }));
});

test('joining late: after the first lesson the rest is prorated; a program can close late joining online instead', async () => {
  let past = plus(today, -7); while (dow(past) !== 4) past = plus(past, 1); // the last Thursday before today
  const term = ok(await api('POST', `/programs/${M.program}/terms`, { token: M.owner, body: { name: 'Thursday run', starts_on: past, weeks: 4, makeup_weeks: 0, start_time: '15:45', end_time: '17:45', price_cents: 16000, ticket_cents: 8000, status: 'open', days: [{ weekday: 4, capacity: 10 }] } }), 201);
  const regs = [{ program_id: M.program, term_id: term.id, group_id: term.groups[0].id, child: kidOf('Lu', 'Late', 9), discipline: 'ski' }];
  const qt = ok(await pub('POST', '/programs/quote', { body: { registrations: regs } }));
  assert.deepEqual([qt.lines[0].lesson_cents, qt.lines[0].ticket_cents, qt.lines[0].late], [12000, 6000, true], 'three of four lessons left');
  ok(await api('PATCH', `/programs/${M.program}`, { token: M.owner, body: { late_join: 'closed' } }));
  is(await pub('POST', '/programs/quote', { body: { registrations: regs } }), 409);
  ok(await api('PATCH', `/programs/${M.program}`, { token: M.owner, body: { late_join: 'prorate' } }));
});

test('classes can be the ski school\'s levels: preset from the report card, and the program shows on the report card', async () => {
  const levels = ok(await api('GET', '/skischool/levels', { token: M.owner })).data.filter((l) => l.discipline === 'ski');
  const l2 = levels.find((l) => l.rank_no === 2);
  const cls = ok(await api('POST', `/programs/groups/${M.mon.id}/levels`, { token: M.inst, body: { school_level_id: l2.id } }), 201).id;
  const roster = ok(await api('GET', `/programs/groups/${M.mon.id}/roster`, { token: M.inst }));
  assert.equal(roster.levels.find((l) => l.id === cls).name, `Ski: ${l2.name}`, 'a day for both disciplines says which');
  const ana = roster.data.find((x) => x.first_name === 'Ana');
  ok(await api('POST', '/skischool/progress', { token: M.inst, body: { person_id: ana.person_id, discipline: 'ski', level: 2 } }), 201);
  const pre = ok(await api('POST', `/programs/groups/${M.mon.id}/levels/preset`, { token: M.inst }));
  assert.ok(pre.placed >= 1);
  assert.equal(ok(await api('GET', `/programs/groups/${M.mon.id}/roster`, { token: M.inst })).data.find((x) => x.first_name === 'Ana').level_id, cls);
  const card = ok(await api('GET', `/skischool/students/${ana.person_id}/card`, { token: M.inst }));
  assert.equal(card.programs[0].program, 'After-School Ski & Ride');
  assert.equal(card.programs[0].class_name, `Ski: ${l2.name}`);
});

test('the day before: families get the time, the meeting place and what to bring, once', async () => {
  const tomorrow = plus(today, 1);
  const term = ok(await api('POST', `/programs/${M.program}/terms`, { token: M.owner, body: { name: 'Tomorrow run', starts_on: tomorrow, weeks: 2, makeup_weeks: 0, start_time: '15:45', end_time: '17:45', price_cents: 1000, status: 'open', days: [{ weekday: dow(tomorrow), capacity: 5 }] } }), 201);
  const kid = await person('Rae', 'Remind', `${year - 9}-03-03`);
  const mom = await person('Rita', 'Remind', `${year - 40}-03-03`);
  ok(await api('POST', `/programs/terms/${term.id}/enroll`, { token: M.desk, body: { person_id: kid, group_id: term.groups[0].id, guardian_id: mom, discipline: 'ski' } }), 201);
  const before = mails.length;
  await PP.remindAll();
  const sent = mails.slice(before).filter((m) => m.To && m.To.startsWith('rita.'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].TextBody, /The first lesson/);
  assert.match(sent[0].TextBody, /The bell by the lodge/);
  assert.match(sent[0].TextBody, /Snack, goggles/);
  await PP.remindAll();
  assert.equal(mails.slice(before).filter((m) => m.To && m.To.startsWith('rita.')).length, 1, 'once');
});

test('the family page: a sign-in link by email, every child and date, update details, switch day, withdraw inside the window', async () => {
  const email = `pat.a.${suffix}@x.test`;
  const before = mails.length;
  ok(await pub('POST', '/family/link', { body: { email: 'nobody@x.test' } }));
  assert.equal(mails.length, before, 'an unknown email gets nothing, and the reply does not say so');
  ok(await pub('POST', '/family/link', { body: { email } }));
  const mail = mails.slice(before).find((m) => m.To === email);
  const token = mail.TextBody.match(/\?t=([A-Za-z0-9_-]+)/)[1];
  const s = ok(await pub('POST', '/family/session', { body: { token } }));
  is(await pub('POST', '/family/session', { body: { token } }), 400, 'a link works once');
  const fam = async (m, p, body) => {
    const res = await fetch(`${base}/api/v1/public/${M.slug}/family${p}`, { method: m, headers: { 'content-type': 'application/json', 'x-family-session': s.session }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})), text: '' };
  };
  is(await call('/api/v1/public', 'GET', `/${M.slug}/family`), 401);
  const page = ok(await fam('GET', ''));
  assert.deepEqual(page.people.map((p) => p.first_name).sort(), ['Ana', 'Bo', 'Cy']);
  const bo = page.people.find((p) => p.first_name === 'Bo').places[0];
  assert.equal(bo.dates.length, 4); assert.equal(bo.makeup_reserve.length, 1);
  assert.equal(bo.owes_cents, 8000);
  assert.equal(bo.meeting_place, 'The bell by the lodge');
  assert.ok(bo.policy.can_switch && bo.policy.switch_to.some((g) => g.day === 'Wednesday') && !bo.policy.switch_to.some((g) => g.day === 'Tuesday'), 'not to the snowboard day');
  ok(await fam('PATCH', `/places/${bo.id}`, { allergies: 'Bees', pickup: [{ name: 'Uncle Ray', phone: '215-555-0111' }] }));
  ok(await fam('POST', `/places/${bo.id}/switch`, { group_id: M.wed.id }));
  const ana = page.people.find((p) => p.first_name === 'Ana').places[0];
  assert.equal(ana.policy.can_withdraw, true);
  assert.equal(ana.policy.refund_cents, ana.paid_cents - 2500, 'less the $25 fee');
  const before2 = refunds.length;
  const w = ok(await fam('POST', `/places/${ana.id}/withdraw`));
  assert.equal(w.how, 'card');
  assert.equal(refunds.length, before2 + 1);
  const again = ok(await fam('GET', ''));
  assert.ok(!again.people.some((p) => p.first_name === 'Ana'), 'withdrawn places leave the page');
  const boNow = again.people.find((p) => p.first_name === 'Bo').places[0];
  assert.deepEqual([boNow.day, boNow.allergies, boNow.pickup[0].name], ['Wednesday', 'Bees', 'Uncle Ray']);
  is(await fam('POST', `/places/${M.cy.enrollment_id + 999999}/withdraw`), 404, 'only the family\'s own places');
});

test('the registration and family pages are served', async () => {
  for (const [path, script] of [[`/programs/${M.slug}`, 'register.js'], [`/family/${M.slug}`, 'family.js']]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(script));
  }
});
