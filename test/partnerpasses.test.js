'use strict';

// Partner passes (Indy Pass Level 1): two free days a season, then one day at 25% off, then no more; blackout dates for
// the level that has them; one day per pass per day; a daily limit; photo ID before selling; a refund or a void gives
// the day back; guests reserve a free day online; and the report adds it all up for checking the partner's statement.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.HELP_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let slug;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const M = {};
let today;

const guest = (first) => ({ details: { first_name: first, last_name: 'Indy', email: `${first.toLowerCase()}@x.test`, date_of_birth: '1980-01-01', sex: 'male' }, sign_waiver: true });
const indyLine = (number, date, extra = {}) => ({ type: 'ticket', product_id: M.day, valid_on: date, partner: { program_id: M.indy, number, level: 'base', id_checked: true, ...extra } });
const redeem = (number, date, extra = {}, payments = []) => api('POST', '/checkout', { token: M.desk, body: { customer: guest('Ida'), lines: [indyLine(number, date, extra)], payments } });

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  slug = `pp-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Partner Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `desk@${slug}.test`, password: PW, role: 'counter' } }));
  M.desk = await login(`desk@${slug}.test`);
  M.day = ok(await api('POST', '/products', { token: M.owner, body: { kind: 'day_ticket', name: 'Adult Day', base_price_cents: 8000 } })).id;
  M.lesson = ok(await api('POST', '/products', { token: M.owner, body: { kind: 'lesson', name: 'Lesson', base_price_cents: 5000 } })).id;
  today = (await api('GET', '/partner-passes', { token: M.desk })).body.today;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('a manager sets up the Indy Pass from its usual rules', async () => {
  is(await api('POST', '/partner-passes/indy', { token: M.desk, body: { product_id: M.day } }), 403, 'the desk does not set rules');
  is(await api('POST', '/partner-passes/indy', { token: M.owner, body: { product_id: M.lesson } }), 400, 'issued as a day ticket');
  M.indy = ok(await api('POST', '/partner-passes/indy', { token: M.owner, body: { product_id: M.day } })).id;
  is(await api('POST', '/partner-passes/indy', { token: M.owner, body: { product_id: M.day } }), 409);
  const list = ok(await api('GET', '/partner-passes', { token: M.desk }));
  const p = list.data.find((x) => x.id === M.indy);
  assert.equal(p.free_days, 2); assert.equal(p.discount_days, 1); assert.equal(p.discount_percent, 25);
  assert.deepEqual(p.levels.map((l) => [l.key, l.blackouts]), [['base', true], ['plus', false]]);
  const menu = ok(await api('GET', '/checkout/menu', { token: M.desk }));
  assert.ok(menu.partner_programs.some((x) => x.id === M.indy && x.number_label === 'Indy customer number'));
});

test('two free days, then 25% off, then no more; one a day; ID first', async () => {
  const n = `IND-${suffix}`;
  is(await redeem(n, today, { id_checked: false }), 400, 'photo ID is checked first');
  let c = ok(await api('GET', `/partner-passes/${M.indy}/check?number=${n}&level=base&date=${today}`, { token: M.desk }));
  assert.equal(c.kind, 'free'); assert.equal(c.price_cents, 0);

  const first = ok(await redeem(n, today));
  assert.equal(first.total_cents, 0);
  assert.equal(first.partner[0].kind, 'free');
  assert.equal(first.tickets.length, 1, 'an ordinary ticket for the gate');
  is(await redeem(n.toLowerCase().replace(/-/g, ''), today), 409, 'the same pass, typed differently, cannot have the same day twice');

  ok(await redeem(n, addDays(today, 1)));
  c = ok(await api('GET', `/partner-passes/${M.indy}/check?number=${n}&level=base&date=${addDays(today, 2)}`, { token: M.desk }));
  assert.equal(c.kind, 'discount'); assert.equal(c.percent, 25); assert.equal(c.price_cents, 6000);
  is(await redeem(n, addDays(today, 2)), 400, 'the discount day must be paid for');
  const third = ok(await redeem(n, addDays(today, 2), {}, [{ tender: 'cash', amount_cents: 6000 }]));
  assert.equal(third.partner[0].kind, 'discount');
  c = ok(await api('GET', `/partner-passes/${M.indy}/check?number=${n}&level=base&date=${addDays(today, 3)}`, { token: M.desk }));
  assert.equal(c.ok, false); assert.match(c.reason, /used its 3 Indy Pass days/);
  is(await redeem(n, addDays(today, 3), {}, [{ tender: 'cash', amount_cents: 8000 }]), 409);

  // Two lines for the same pass in one basket are refused.
  const m = `TWO-${suffix}`;
  is(await api('POST', '/checkout', { token: M.desk, body: { customer: guest('Two'), lines: [indyLine(m, today), indyLine(m, addDays(today, 1))] } }), 400);
});

test('blackout dates stop Base but not Plus; the daily limit holds', async () => {
  const black = addDays(today, 5);
  ok(await api('PUT', `/partner-passes/${M.indy}/blackouts`, { token: M.owner, body: { dates: [black, '2001-01-01'] } }));
  is(await redeem(`BLK-${suffix}`, black), 409, 'Base is blacked out');
  ok(await redeem(`PLS-${suffix}`, black, { level: 'plus' }));

  ok(await api('PATCH', `/partner-passes/${M.indy}`, { token: M.owner, body: { daily_limit: 1 } }));
  const d = addDays(today, 6);
  ok(await redeem(`LIM1-${suffix}`, d));
  const full = await redeem(`LIM2-${suffix}`, d);
  is(full, 409); assert.match(full.body.error, /full/);
  ok(await api('PATCH', `/partner-passes/${M.indy}`, { token: M.owner, body: { daily_limit: null } }));
});

test('a refund or a void gives the day back, and the report counts what stands', async () => {
  const n = `REF-${suffix}`;
  const d = addDays(today, 10);
  const sale = ok(await redeem(n, d));
  ok(await api('POST', `/orders/${sale.id}/refund`, { token: M.owner, body: { reason: 'customer_request' } }));
  const again = ok(await redeem(n, d));
  const c = ok(await api('GET', `/partner-passes/${M.indy}/check?number=${n}&level=base&date=${addDays(d, 1)}`, { token: M.desk }));
  assert.equal(c.used.free, 1, 'the refunded day does not count');

  is(await api('POST', `/partner-passes/redemptions/${again.partner[0].id}/void`, { token: M.desk, body: { reason: 'wrong pass' } }), 403);
  ok(await api('POST', `/partner-passes/redemptions/${again.partner[0].id}/void`, { token: M.owner, body: { reason: 'wrong pass' } }));
  const [[tk]] = await pool.query('SELECT status FROM tickets WHERE code = ?', [again.tickets[0].code]);
  assert.equal(tk.status, 'void', 'the ticket stops working at the gate');

  const rep = ok(await api('GET', `/partner-passes/${M.indy}/redemptions?from=${today}&to=${addDays(today, 20)}`, { token: M.desk }));
  assert.equal(rep.totals.visits, 5, 'three days for one pass, a Plus day, a limit day; not the refunded or voided ones');
  assert.equal(rep.totals.discount, 1);
  assert.equal(rep.totals.charged_cents, 6000);
  assert.ok(rep.data.some((r) => r.status === 'void'));
  assert.ok(rep.data.some((r) => r.counts === false && r.status === 'active'), 'the refunded one is listed but not counted');
  const csv = await fetch(`${base}/api/v1/partner-passes/${M.indy}/redemptions.csv?from=${today}&to=${addDays(today, 20)}`, { headers: { authorization: `Bearer ${M.desk}` } });
  const text = await csv.text();
  assert.match(text, /"Date","Pass number","Level"/);
  assert.ok(text.includes('Indy Base') && text.includes('Refunded') && text.includes('Voided: wrong pass'));
});

test('guests reserve a free day online when the mountain allows it', async () => {
  is(await api('GET', `/public/${slug}/partner`), 200);
  assert.equal((await api('GET', `/public/${slug}/partner`)).body.programs.length, 0, 'off until the mountain turns it on');
  ok(await api('PATCH', `/partner-passes/${M.indy}`, { token: M.owner, body: { online: true } }));
  const page = ok(await api('GET', `/public/${slug}/partner`));
  const prog = page.programs.find((p) => p.id === M.indy);
  assert.ok(prog.blackouts.includes(addDays(today, 5)));
  const n = `WEB-${suffix}`;
  const body = { number: n, level: 'base', date: addDays(today, 3), first_name: 'Wes', last_name: 'Web', date_of_birth: '1990-05-05', email: 'wes@x.test', waiver_accepted: true };
  const r = ok(await api('POST', `/public/${slug}/partner/${M.indy}/reserve`, { body }));
  assert.equal(r.free_day, 1);
  assert.match(r.code, /^[0-9A-F]{20}$/);
  is(await api('POST', `/public/${slug}/partner/${M.indy}/reserve`, { body }), 409, 'not the same day twice');
  is(await api('POST', `/public/${slug}/partner/${M.indy}/reserve`, { body: { ...body, date: addDays(today, 5) } }), 409, 'blackout');
  const list = ok(await api('GET', `/partner-passes/${M.indy}/redemptions?from=${addDays(today, 3)}&to=${addDays(today, 3)}`, { token: M.desk }));
  const mine = list.data.find((x) => x.number === n.replace(/-/g, '').toUpperCase());
  assert.equal(mine.channel, 'online'); assert.equal(mine.id_checked, false);
  ok(await api('POST', `/partner-passes/redemptions/${mine.id}/id-checked`, { token: M.desk }));
  // Once the free days are used, the discount day is bought at the window, not online.
  ok(await api('POST', `/public/${slug}/partner/${M.indy}/reserve`, { body: { ...body, date: addDays(today, 4) } }));
  const third = await api('POST', `/public/${slug}/partner/${M.indy}/reserve`, { body: { ...body, date: addDays(today, 7) } });
  is(third, 409); assert.match(third.body.error, /ticket window/);
  // A bot that fills the hidden box gets a thank-you and nothing is saved.
  is(await api('POST', `/public/${slug}/partner/${M.indy}/reserve`, { body: { ...body, number: `BOT-${suffix}`, website: 'http://spam' } }), 201);
  const [[bot]] = await pool.query('SELECT COUNT(*) AS n FROM partner_redemptions WHERE number = ?', [`BOT${suffix}`.toUpperCase()]);
  assert.equal(Number(bot.n), 0);
});

test('Sell shows the Partner passes tab unless a manager turns it off, and the change is audited', async () => {
  assert.deepEqual(ok(await api('GET', '/partner-passes/tab', { token: M.desk })), { show: true }, 'on unless turned off');
  assert.equal(ok(await api('GET', '/partner-passes', { token: M.desk })).show_tab, true);
  is(await api('PUT', '/partner-passes/tab', { token: M.desk, body: { show: false } }), 403, 'the desk cannot change it');
  is(await api('PUT', '/partner-passes/tab', { token: M.owner, body: { show: 'no' } }), 400, 'a yes or no only');
  assert.deepEqual(ok(await api('PUT', '/partner-passes/tab', { token: M.owner, body: { show: false } })), { show: false });
  assert.deepEqual(ok(await api('GET', '/partner-passes/tab', { token: M.desk })), { show: false });
  const [[row]] = await pool.query("SELECT a.action, a.entity, a.detail FROM audit_log a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = ? AND a.entity = 'tenants' AND a.detail LIKE '%partner_tab%' ORDER BY a.id DESC LIMIT 1", [slug]);
  assert.deepEqual(typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail, { partner_tab: { before: true, after: false } });
  ok(await api('PUT', '/partner-passes/tab', { token: M.owner, body: { show: true } }));
  assert.equal(ok(await api('GET', '/partner-passes/tab', { token: M.desk })).show, true);
});
