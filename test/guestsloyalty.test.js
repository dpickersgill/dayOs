'use strict';

// Guests round 2, Track LOYALTY: birthday gifts (who, when, once a season, the off switch, a child's email to the parent,
// the choices), the loyalty rules (every Nth paid day, milestones, the first-timer ladder), day recaps (once per person
// per day, a family together, texts only with consent, not staff), the season recap page by its private link only,
// badges for the welcome-back card, and the settings and report routes. Postmark is a mock; texts are recorded.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';
process.env.TWILIO_ACCOUNT_SID = 'AC_test';
process.env.TWILIO_AUTH_TOKEN = 'tw_test';
process.env.TWILIO_FROM = '+12155550000';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const mailer = require('../src/lib/mailer');
const sms = require('../src/lib/sms');
const Y = require('../src/lib/loyalty');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let pm; let n = 0;
const mails = []; const texts = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function call(prefix, method, path, { token, body } = {}) {
  const headers = { 'x-device': 'test-device-0123456789abcdef', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(`${base}${prefix}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'x-device': 'test-device-0123456789abcdef', 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}

let A; let B; const D = {}; const P = {}; let counter;
async function person(first, extra = {}) {
  const [r] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name, email, phone, date_of_birth) VALUES (?, ?, ?, ?, ?, ?)',
    [extra.tenant || A.id, first, extra.last || 'Guest', extra.email === undefined ? `${first.toLowerCase()}.${suffix}@x.test` : extra.email, extra.phone || null, extra.dob || null]);
  return r.insertId;
}
/** A ticket for a person: an order, a line at a price, and the ticket. */
async function ticket(personId, { product = D.day, price = 6000, from = '2026-11-20', to = '2027-04-10', tenant = A.id, comp = null } = {}) {
  const [o] = await pool.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, total_cents, channel) VALUES (?, ?, 'paid', ?, ?, 'window')", [tenant, personId, price, price]);
  const [i] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, quantity, unit_price_cents) VALUES (?, ?, ?, 'ticket', ?, 1, ?)", [tenant, o.insertId, product, personId, price]);
  if (comp) await pool.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, comp_reason) VALUES (?, ?, 'comp', ?, ?)", [tenant, o.insertId, price, comp]);
  const [t] = await pool.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [tenant, i.insertId, personId, product, crypto.randomBytes(10).toString('hex').toUpperCase(), from, to]);
  return t.insertId;
}
/** A good scan at a local New York time ('2026-12-12 09:05') at a lift. */
async function scan(ticketId, local, location = 'Summit Express', tenant = A.id) {
  const utc = new Date(Date.parse(`${local.replace(' ', 'T')}:00-05:00`)).toISOString().slice(0, 19).replace('T', ' ');
  await pool.query("INSERT INTO scans (tenant_id, ticket_id, code, location, result, scanned_at) VALUES (?, ?, 'X', ?, 'ok', ?)", [tenant, ticketId, location, utc]);
}
async function lesson(personId, day) {
  const [s] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, starts_at, ends_at, capacity, status, format) VALUES (?, ?, 'ski', ?, ?, 6, 'scheduled', 'group')", [A.id, D.lesson, `${day} 10:00:00`, `${day} 12:00:00`]);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'attended')", [A.id, s.insertId, personId]);
}
const rewardsOf = (personId, kind) => q('SELECT * FROM guest_rewards WHERE tenant_id = ? AND person_id = ?' + (kind ? ' AND kind = ?' : '') + ' ORDER BY id', [A.id, personId, ...(kind ? [kind] : [])]);
const mailTo = (email) => mails.filter((m) => m.To === email);
const settings = async (body, t = A) => { const r = await api('PATCH', '/guests/settings', { token: t.owner, body }); assert.equal(r.status, 200, r.text); };

test.before(async () => {
  pm = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => pm.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  sms.send = async (m) => { texts.push(m); return { ok: true }; };
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`la-${suffix}`); B = await mountain(`lb-${suffix}`);
  const mk = async (body, t = A) => { const r = await api('POST', '/products', { token: t.owner, body }); assert.equal(r.status, 201, r.text); return r.body.id; };
  D.day = await mk({ kind: 'day_ticket', name: 'All-day ticket', base_price_cents: 6000 });
  D.pass = await mk({ kind: 'season_pass', name: 'Season pass', base_price_cents: 40000 });
  D.lesson = await mk({ kind: 'lesson', name: 'First-timer lesson', base_price_cents: 9000 });
  D.bday = await mk({ kind: 'day_ticket', name: 'Birthday ticket', base_price_cents: 6000 });
  D.bDay = await mk({ kind: 'day_ticket', name: 'B day', base_price_cents: 5000 }, B);
  await q('UPDATE tenants SET season_ends_on = ? WHERE id IN (?)', ['2027-04-10', [A.id, B.id]]);
  await settings({ season_opens_on: '2026-11-20' });
  await settings({ season_opens_on: '2026-11-20', birthday_on: false }, B);
  assert.equal((await api('POST', '/users', { token: A.owner, body: { email: `desk@${A.slug}.test`, password: PW, role: 'counter' } })).status, 201);
  counter = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `desk@${A.slug}.test`, password: PW } })).body.token;

  // Last season's guests (a day in Jan 2026), a pass holder, a newcomer, a family.
  P.pat = await person('Pat', { dob: '1990-12-17', phone: '215-555-0101' }); await scan(await ticket(P.pat, { from: '2026-01-10', to: '2026-01-10' }), '2026-01-10 09:00');
  P.quinn = await person('Quinn', { dob: '1985-12-18' }); await scan(await ticket(P.quinn, { from: '2026-01-10', to: '2026-01-10' }), '2026-01-10 09:30');
  P.nora = await person('Nora', { dob: '1992-12-17' }); // never here
  P.paul = await person('Paul', { dob: '1970-12-16' }); await ticket(P.paul, { product: D.pass, price: 40000 });
  P.gina = await person('Gina', { dob: '1984-05-05', phone: '215-555-0102' });
  P.ava = await person('Ava', { dob: '2018-12-15', email: null });
  await q("INSERT INTO person_links (tenant_id, adult_id, member_id, relation) VALUES (?, ?, ?, 'guardian')", [A.id, P.gina, P.ava]);
  await scan(await ticket(P.ava, { from: '2026-02-01', to: '2026-02-01', price: 3000 }), '2026-02-01 10:00');
  P.olga = await person('Olga', { dob: '1980-07-04' }); await scan(await ticket(P.olga, { from: '2026-02-02', to: '2026-02-02' }), '2026-02-02 10:00');
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => pm.close(r)); await pool.end(); });

test('the season window: settings, an older year carried over, and the Nov 15 to Apr 15 default', () => {
  assert.deepEqual(Y.seasonWindow('2026-11-20', '2027-04-10', '2026-12-01'), { label: '2026-27', opens: '2026-11-20', ends: '2027-04-10', assumed: { opens: false, ends: false } });
  assert.equal(Y.seasonWindow('2025-11-21', '2026-04-05', '2026-12-01').opens, '2026-11-21', 'last year\'s date keeps its month and day');
  assert.equal(Y.seasonWindow('2025-11-21', '2026-04-05', '2026-12-01').ends, '2027-04-05');
  assert.deepEqual(Y.seasonWindow(null, null, '2027-01-05'), { label: '2026-27', opens: '2026-11-15', ends: '2027-04-15', assumed: { opens: true, ends: true } });
  assert.equal(Y.nextBirthday('2000-02-29', '2027-02-01'), '2027-02-28', 'a leap-day birthday in another year');
  assert.deepEqual(Y.giftWindow('2026-12-17', 'week'), ['2026-12-13', '2026-12-19'], 'Sunday to Saturday');
  assert.deepEqual(Y.giftWindow('2026-12-17', 'month'), ['2026-12-01', '2026-12-31']);
});

test('birthday gifts: past guests and pass holders a week ahead, not newcomers, once a season, the choices from settings', async () => {
  await settings({ birthday_ticket_product_id: D.bday, birthday_percent: 20, birthday_credit_cents: 2500 });
  mails.length = 0;
  const out = await Y.birthdays(A.id, '2026-12-10', 'https://app.test');
  // Dec 11 to Dec 17: Pat (17th, last season), Paul (16th, pass), Ava (15th, a child). Quinn is the 18th: not yet. Nora is new.
  assert.equal(out.issued, 3, JSON.stringify(out));
  const [pat] = await rewardsOf(P.pat, 'birthday');
  assert.equal(pat.source_key, 'birthday:2026-27');
  assert.equal(String(pat.valid_from).slice(0, 10), '2026-12-13'); assert.equal(String(pat.valid_to).slice(0, 10), '2026-12-19');
  const opts = typeof pat.options === 'string' ? JSON.parse(pat.options) : pat.options;
  assert.deepEqual(opts, { free_ticket: { product_id: D.bday }, percent: { percent: 20 }, credit: { cents: 2500 } });
  assert.equal((await rewardsOf(P.paul, 'birthday')).length, 1, 'a pass holder');
  assert.equal((await rewardsOf(P.nora, 'birthday')).length, 0, 'a newcomer gets nothing');
  assert.equal((await rewardsOf(P.quinn, 'birthday')).length, 0, '8 days out: not yet');
  const pm1 = mailTo(`pat.${suffix}@x.test`);
  assert.equal(pm1.length, 1);
  assert.match(pm1[0].Subject, /Happy birthday/);
  assert.match(pm1[0].TextBody, /a free Birthday ticket, 20% off or a \$25\.00 credit/);
  assert.match(pm1[0].TextBody, new RegExp(pat.code));
  assert.match(pm1[0].TextBody, /Sun, Dec 13, 2026 to Sat, Dec 19, 2026/);
  assert.ok(!/—|–/.test(pm1[0].TextBody + pm1[0].HtmlBody), 'no long dashes');
  // The child's goes to the parent.
  const g = mailTo(`gina.${suffix}@x.test`);
  assert.equal(g.length, 1);
  assert.match(g[0].Subject, /Ava's birthday is Tuesday/);
  assert.equal((await rewardsOf(P.ava, 'birthday')).length, 1, 'the gift is the child\'s');
  // Quinn's turn the next day; nobody gets a second.
  const next = await Y.birthdays(A.id, '2026-12-11', 'https://app.test');
  assert.equal(next.issued, 1);
  assert.equal((await rewardsOf(P.quinn, 'birthday')).length, 1);
  assert.equal((await Y.birthdays(A.id, '2026-12-11', 'https://app.test')).issued, 0, 'once a season');
  assert.equal(mailTo(`pat.${suffix}@x.test`).length, 1, 'one email');
});

test('birthday gifts: a birthday outside the season comes at opening, good for 30 days; the off switch', async () => {
  assert.equal((await rewardsOf(P.olga, 'birthday')).length, 0);
  await Y.birthdays(A.id, '2026-11-19', 'https://app.test');
  assert.equal((await rewardsOf(P.olga, 'birthday')).length, 0, 'not before opening');
  mails.length = 0;
  await Y.birthdays(A.id, '2026-11-20', 'https://app.test');
  const [o] = await rewardsOf(P.olga, 'birthday');
  assert.ok(o, 'issued at opening');
  assert.equal(String(o.valid_from).slice(0, 10), '2026-11-20'); assert.equal(String(o.valid_to).slice(0, 10), '2026-12-19');
  assert.match(mailTo(`olga.${suffix}@x.test`)[0].TextBody, /saved your gift for the start of the season/);
  assert.equal((await rewardsOf(P.pat, 'birthday')).length, 1, 'an in-season birthday is not given at opening too');
  // Mountain B turned birthdays off.
  const bob = await person('Bob', { tenant: B.id, dob: '1990-12-17' });
  await scan(await ticket(bob, { tenant: B.id, product: D.bDay, from: '2026-01-10', to: '2026-01-10' }), '2026-01-10 09:00', 'Lift', B.id);
  assert.deepEqual(await Y.birthdays(B.id, '2026-12-10', 'https://app.test'), { off: true, issued: 0 });
  assert.equal((await q('SELECT COUNT(*) AS n FROM guest_rewards WHERE tenant_id = ?', [B.id]))[0].n, 0);
});

test('every Nth paid day is free, milestones, and the welcome-back badges', async () => {
  await settings({ loyalty_every_n: 3, milestones_on: true });
  const lee = await person('Lee', { dob: '1975-06-01' });
  const days = ['2026-12-01', '2026-12-02', '2026-12-03'];
  for (const d of days) await scan(await ticket(lee, { from: d, to: d }), `${d} 09:10`);
  // A free-of-charge (comp) day does not count.
  await scan(await ticket(lee, { from: '2026-11-30', to: '2026-11-30', comp: 'promotion' }), '2026-11-30 09:00');
  await Y.rulesFor(A.id, '2026-12-02', 'https://app.test');
  assert.equal((await rewardsOf(lee, 'loyalty')).length, 0, 'two paid days');
  const b2 = await Y.badgesFor(pool, A.id, lee, '2026-12-02');
  assert.ok(b2.some((b) => b.kind === 'loyalty' && b.text === '2 of 3 toward a free day'), JSON.stringify(b2));
  await Y.rulesFor(A.id, '2026-12-03', 'https://app.test');
  const [r] = await rewardsOf(lee, 'loyalty');
  assert.ok(r, 'the third paid day earns a free day');
  assert.equal(r.source_key, 'loyalty:2026-27:1');
  await Y.rulesFor(A.id, '2026-12-03', 'https://app.test');
  assert.equal((await rewardsOf(lee, 'loyalty')).length, 1, 'once');
  // Milestones: the 10th day ever.
  const mo = await person('Mo', { dob: '1980-03-03' });
  const tk = await ticket(mo, { product: D.pass, price: 40000 });
  for (let i = 1; i <= 10; i += 1) await scan(tk, `2026-12-${String(i).padStart(2, '0')} 09:00`, i % 2 ? 'Summit Express' : 'Bunny Lift');
  await Y.rulesFor(A.id, '2026-12-09', 'https://app.test');
  assert.equal((await rewardsOf(mo, 'milestone')).length, 0, 'nine days');
  const b10 = await Y.badgesFor(pool, A.id, mo, '2026-12-10');
  assert.ok(b10.some((b) => b.kind === 'milestone' && /10th day/.test(b.text)), JSON.stringify(b10));
  await Y.rulesFor(A.id, '2026-12-10', 'https://app.test');
  const [m] = await rewardsOf(mo, 'milestone');
  assert.equal(m.source_key, 'milestone:10');
  assert.ok(mailTo(`mo.${suffix}@x.test`).some((x) => /10th day/.test(x.TextBody)));
  assert.equal((await rewardsOf(mo, 'loyalty')).length, 0, 'pass days are not paid days');
  // Birthday badge this week.
  const bb = await Y.badgesFor(pool, A.id, P.pat, '2026-12-15');
  assert.ok(bb.some((b) => b.kind === 'birthday' && b.text === 'Birthday Thursday'), JSON.stringify(bb));
  assert.ok((await Y.badgesFor(pool, A.id, P.pat, '2026-12-17')).some((b) => b.text === 'Birthday today'));
  assert.deepEqual(await Y.badgesFor(pool, A.id, 999999999, '2026-12-17'), [], 'nobody: no badges, no error');
  const viaApi = await api('GET', `/guests/people/${P.pat}/badges?day=2026-12-17`, { token: counter });
  assert.equal(viaApi.status, 200); assert.ok(viaApi.body.data.some((b) => b.kind === 'birthday'));
  assert.deepEqual((await api('GET', `/guests/people/${P.pat}/badges?day=2026-12-17`, { token: B.owner })).body.data, [], 'another mountain sees nothing');
});

test('the first-timer ladder: lesson 2 of 3, then a season pass offer after the third lesson', async () => {
  await settings({ firsttimer_on: true });
  const fi = await person('Finn', { dob: '2000-01-01' });
  await lesson(fi, '2026-12-05'); await lesson(fi, '2026-12-12');
  const b = await Y.badgesFor(pool, A.id, fi, '2026-12-12');
  assert.ok(b.some((x) => x.kind === 'firsttimer' && x.text === 'First-timer: lesson 2 of 3'), JSON.stringify(b));
  await Y.rulesFor(A.id, '2026-12-12', 'https://app.test');
  assert.equal((await rewardsOf(fi, 'firsttimer')).length, 0);
  await lesson(fi, '2026-12-19');
  await Y.rulesFor(A.id, '2026-12-19', 'https://app.test');
  const [r] = await rewardsOf(fi, 'firsttimer');
  assert.ok(r);
  const o = typeof r.options === 'string' ? JSON.parse(r.options) : r.options;
  assert.deepEqual(o, { percent: { percent: 50, product_id: D.pass } });
  // Someone whose first day was not a lesson is not on the ladder.
  const sk = await person('Sky', { dob: '2000-01-01' });
  await scan(await ticket(sk, { from: '2026-12-01', to: '2026-12-01' }), '2026-12-01 09:00');
  await lesson(sk, '2026-12-05');
  assert.ok(!(await Y.badgesFor(pool, A.id, sk, '2026-12-05')).some((x) => x.kind === 'firsttimer'));
});

let seasonToken;
test('day recap: once per person per day, the family together to the parent, a text only with consent, never staff', async () => {
  const day = '2027-01-09';
  await scan(await ticket(P.gina, { from: day, to: day }), `${day} 08:58`, 'Summit Express');
  const avaT = await ticket(P.ava, { from: day, to: day, price: 3000 });
  await scan(avaT, `${day} 09:10`, 'Bunny Lift'); await scan(avaT, `${day} 09:40`, 'Bunny Lift'); await scan(avaT, `${day} 10:30`, 'Summit Express');
  const patT = await ticket(P.pat, { from: day, to: day });
  for (const [t, l] of [['08:58', 'Summit Express'], ['09:20', 'Summit Express'], ['10:00', 'Ridge'], ['11:00', 'Ridge'], ['13:00', 'Bunny Lift'], ['14:00', 'Summit Express']]) await scan(patT, `${day} ${t}`, l);
  // A staff member's day and a staff comp: no recap.
  const st = await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Stan', last_name: 'Staff', email: `stan.${suffix}@x.test` }, status: 'active' } });
  assert.equal(st.status, 201, st.text);
  const stanId = (await q('SELECT person_id FROM staff WHERE tenant_id = ? AND id = ?', [A.id, st.body.id]))[0].person_id;
  await scan(await ticket(stanId, { from: day, to: day }), `${day} 09:00`);
  const cara = await person('Cara', { dob: '1990-01-01' });
  await scan(await ticket(cara, { from: day, to: day, comp: 'patrol' }), `${day} 09:00`);
  // Pat said yes to texts; Gina did not.
  await q("INSERT INTO consent_events (tenant_id, person_id, channel, status, source) VALUES (?, ?, 'sms', 'opted_in', 'test')", [A.id, P.pat]);
  mails.length = 0; texts.length = 0;
  const out = await Y.dayRecaps(A.id, day, 'https://app.test');
  assert.equal(out.sent, 2, JSON.stringify(out));
  const pat = mailTo(`pat.${suffix}@x.test`);
  assert.equal(pat.length, 1);
  assert.match(pat[0].TextBody, /Thanks for skiing with us today, Pat\./);
  assert.match(pat[0].TextBody, /First chair at 8:58 AM, 6 laps on 3 lifts\./);
  const gina = mailTo(`gina.${suffix}@x.test`);
  assert.equal(gina.length, 1, 'one message for the family');
  assert.match(gina[0].TextBody, /Gina: first chair at 8:58 AM, 1 lap\./);
  assert.match(gina[0].TextBody, /Ava: first chair at 9:10 AM, 3 laps on 2 lifts\./);
  assert.equal(mailTo(`stan.${suffix}@x.test`).length, 0, 'not for staff');
  assert.equal(mailTo(`cara.${suffix}@x.test`).length, 0, 'not for a patrol comp');
  assert.equal(texts.length, 1, 'only Pat said yes to texts');
  assert.equal(texts[0].to, '215-555-0101');
  assert.match(texts[0].body, /6 laps on 3 lifts/);
  // Once per person per day.
  assert.equal((await Y.dayRecaps(A.id, day, 'https://app.test')).sent || 0, 0);
  assert.equal(mailTo(`pat.${suffix}@x.test`).length, 1);
  // The link opens the day's page.
  const token = /\/season\/[^/]+\/([A-Za-z0-9_-]+)/.exec(gina[0].TextBody)[1];
  const v = await call('/api/v1/public', 'GET', `/${A.slug}/recap/${token}`);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.body.kind, 'day');
  assert.deepEqual(v.body.people.map((p) => p.first_name).sort(), ['Ava', 'Gina']);
  assert.ok(!/allerg|medical|last_name|Guest/i.test(JSON.stringify(v.body)), 'no last names or medical details');
});

test('season recap: a private link per family, a share page without private details, and stop', async () => {
  const pre = await api('GET', '/guests/loyalty/season-recaps?season=2026-27', { token: A.owner });
  assert.equal(pre.status, 200, pre.text);
  assert.ok(pre.body.people >= 5 && pre.body.emails >= 4, JSON.stringify(pre.body));
  assert.equal((await api('POST', '/guests/loyalty/season-recaps/send', { token: counter, body: { season: '2026-27' } })).status, 403, 'managers only');
  mails.length = 0;
  const sent = await api('POST', '/guests/loyalty/season-recaps/send', { token: A.owner, body: { season: '2026-27' } });
  assert.equal(sent.status, 200, sent.text);
  assert.ok(sent.body.sent >= 4);
  const pat = mailTo(`pat.${suffix}@x.test`);
  assert.equal(pat.length, 1);
  assert.match(pat[0].Subject, /Your season at/);
  seasonToken = /\/season\/[^/]+\/([A-Za-z0-9_-]+)/.exec(pat[0].TextBody)[1];
  const again = await api('POST', '/guests/loyalty/season-recaps/send', { token: A.owner, body: { season: '2026-27' } });
  assert.equal(again.body.sent, 0, 'once per season');
  const v = await call('/api/v1/public', 'GET', `/${A.slug}/recap/${seasonToken}`);
  assert.equal(v.status, 200);
  assert.equal(v.body.kind, 'season');
  const s = v.body.people[0].stats;
  assert.equal(s.days, 1); assert.equal(s.laps, 6); assert.equal(s.favorite_lift, 'Summit Express');
  // By token only: a wrong token, another mountain, nothing.
  assert.equal((await call('/api/v1/public', 'GET', `/${A.slug}/recap/${'x'.repeat(32)}`)).status, 404);
  assert.equal((await call('/api/v1/public', 'GET', `/${B.slug}/recap/${seasonToken}`)).status, 404);
  assert.equal((await call('/api/v1/public', 'GET', `/${A.slug}/recap/short`)).status, 404);
  // The page itself.
  const page = await fetch(`${base}/season/${A.slug}/${seasonToken}`);
  assert.equal(page.status, 200); assert.match(await page.text(), /season\.js/);
  // Share: first name and numbers only.
  const sh = await call('/api/v1/public', 'POST', `/${A.slug}/recap/${seasonToken}/share`, { body: { index: 0 } });
  assert.equal(sh.status, 200, sh.text);
  const shareToken = sh.body.url.split('/').pop();
  const shared = await call('/api/v1/public', 'GET', `/${A.slug}/recap-share/${shareToken}`);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.first_name, 'Pat');
  assert.equal(shared.body.stats.lessons, undefined); assert.equal(shared.body.stats.levels, undefined);
  assert.equal((await call('/api/v1/public', 'GET', `/${A.slug}/recap-share/${seasonToken}`)).status, 404, 'the private link is not a share link');
  // Stop: no more recaps for Pat.
  assert.equal((await call('/api/v1/public', 'POST', `/${A.slug}/recap/${seasonToken}/stop`)).status, 200);
  const day = '2027-01-16';
  await scan(await ticket(P.pat, { from: day, to: day }), `${day} 09:00`);
  mails.length = 0;
  await Y.dayRecaps(A.id, day, 'https://app.test');
  assert.equal(mailTo(`pat.${suffix}@x.test`).length, 0, 'stopped');
});

test('settings, report and top loyalists: managers only, plain numbers', async () => {
  assert.equal((await api('GET', '/guests/loyalty/settings', { token: counter })).status, 403);
  const g = await api('GET', '/guests/loyalty/settings', { token: A.owner });
  assert.equal(g.status, 200, g.text);
  assert.equal(g.body.recap_time, '18:00');
  assert.equal(g.body.season.opens, '2026-11-20');
  assert.ok(g.body.estimate.birthdays >= 4);
  const p = await api('PATCH', '/guests/loyalty/settings', { token: A.owner, body: { recap_time: '17:30', milestone_credit_cents: 2000 } });
  assert.equal(p.status, 200, p.text); assert.equal(p.body.recap_time, '17:30');
  assert.equal((await api('PATCH', '/guests/loyalty/settings', { token: A.owner, body: { recap_time: '25:00' } })).status, 400);
  const r = await api('GET', '/guests/loyalty/report?season=2026-27', { token: A.owner });
  assert.equal(r.status, 200, r.text);
  const bday = r.body.rewards.find((x) => x.kind === 'birthday');
  assert.ok(bday && bday.issued >= 5, JSON.stringify(r.body));
  assert.ok(r.body.recaps.find((x) => x.kind === 'day').emails >= 2);
  assert.ok(r.body.recaps.find((x) => x.kind === 'season').viewed >= 1);
  const top = await api('GET', '/guests/loyalty/top?season=2026-27&limit=3', { token: A.owner });
  assert.equal(top.status, 200);
  assert.equal(top.body.data[0].days, 10, 'Mo skied the most days');
  mails.length = 0;
  const th = await api('POST', '/guests/loyalty/top/thanks', { token: A.owner, body: { person_ids: [top.body.data[0].id], credit_cents: 1500, note: 'Lunch is on us.' } });
  assert.equal(th.status, 200, th.text); assert.equal(th.body.emailed, 1);
  assert.match(mails[0].TextBody, /Lunch is on us\./);
  assert.match(mails[0].TextBody, /\$15\.00 credit/);
  const th2 = await api('POST', '/guests/loyalty/top/thanks', { token: A.owner, body: { person_ids: [top.body.data[0].id], credit_cents: 1500 } });
  assert.equal(th2.body.thanked, 0, 'once a season');
  assert.equal((await api('POST', '/guests/loyalty/top/thanks', { token: counter, body: { person_ids: [1] } })).status, 403);
});

// ---------------------------------------------------------------- guests round 2 fixes
test('fix: top loyalists count mountain days, not UTC days, without time zone tables', async () => {
  const Y = require('../src/lib/loyalty');
  const id = await person('Tess', { last: `Late${suffix}` });
  const t = await ticket(id, { from: '2030-12-01', to: '2031-04-01' });
  await scan(t, '2031-01-10 15:00'); await scan(t, '2031-01-10 20:30'); // 20:30 New York is the next day in UTC
  await scan(t, '2031-01-11 09:00');
  const me = (await Y.topLoyalists(pool, A.id, '2030-31', 1000, 'America/New_York')).find((x) => x.id === id);
  assert.equal(me.days, 2);
});
