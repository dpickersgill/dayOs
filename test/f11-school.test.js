'use strict';

// 2026.11.11, track SCHOOL AND GUEST: regression tests for the fixes from the Oct 31 reviews (children, lessons, family
// pages). Each test is the review's proof turned around: it fails if the defect comes back.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';
process.env.SHOP_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const mailer = require('../src/lib/mailer');
const stripe = require('../src/lib/stripe');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const { signaturePng } = require('./helpers/signature');

let server; let base; let fakeStripe; let fakeMail;
const mails = [];
const PW = 'correct-horse-battery';
const DEVICE = 'test-device-0123456789abcdef';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const year = Number(today.slice(0, 4));
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const q = async (sql, params) => (await pool.query(sql, params))[0];
let n = 0;

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${url}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call(m, `/api/v1${p}`, o);
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${r.text.slice(0, 300)}`); return r.body; };
const login = async (slug, email) => ok(await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).token;

/**
 * A mountain with an owner, a counter login, two instructors (ivy, max) cleared for everything, and a group lesson product.
 * Mountains are made at most 5 a minute (the sign-up limit), so tests share a few: 'guest', 'school', 'narrow' (tests that
 * change what Ivy teaches) and 'other'. Each test uses its own days and people.
 */
const made = new Map();
function mountain(tag) {
  const key = { g1: 'guest', g1b: 'guest', g2: 'guest', g3: 'guest', g6: 'guest', g9: 'guest', dp2: 'guest', gt: 'guest', g1c: 'other', s6: 'narrow', s7: 'narrow', s8: 'narrow', s10: 'narrow', pv: 'narrow' }[tag] || 'school';
  if (!made.has(key)) made.set(key, makeMountain(key));
  return made.get(key);
}
async function makeMountain(tag) {
  const slug = `f11s${tag}-${suffix}`.toLowerCase();
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Peak ${tag}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const M = { slug, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
  for (const m of ['programs', 'shop', 'school', 'rentals', 'waivers', 'guests']) await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [M.id, m]).catch(() => {});
  modules.invalidate(M.id);
  M.owner = await login(slug, `owner@${slug}.test`);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }));
  M.counter = await login(slug, `counter@${slug}.test`);
  for (const [k, first] of [['ivy', 'Ivy'], ['max', 'Max']]) {
    const st = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: first, last_name: 'Teach', email: `${k}@${slug}.test` }, status: 'active' } }));
    M[`${k}Id`] = st.id;
    ok(await api('POST', '/users', { token: M.owner, body: { email: `${k}@${slug}.test`, password: PW, role: 'instructor', staff_id: st.id } }));
    M[k] = await login(slug, `${k}@${slug}.test`);
    ok(await api('PUT', `/skischool/instructors/${st.id}/profile`, { token: M.owner, body: { disciplines: ['ski', 'snowboard'], ski_level_max: 9, snowboard_level_max: 9, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  }
  M.group = ok(await api('POST', '/products', { token: M.owner, body: { kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 } })).id;
  M.pub = (m, p, o) => call(m, `/api/v1/public/${slug}${p}`, o);
  return M;
}
const lesson = (M, date, time, extra = {}, hours = 2) => api('POST', '/skischool/sessions', { token: M.owner, body: { product_id: M.group, starts_at: `${date}T${time}`, ends_at: `${date}T${String(Number(time.slice(0, 2)) + hours).padStart(2, '0')}:${time.slice(3)}`, ...extra } });
const book = (M, sid, student, extra = {}, token) => api('POST', `/skischool/sessions/${sid}/bookings`, { token: token || M.counter, body: { student, sign_waiver: true, send_confirmation: false, ...extra } });
/** A family sign-in, through the emailed link. */
async function familySession(M, email) {
  const before = mails.length;
  ok(await M.pub('POST', '/family/link', { body: { email } }));
  const m = mails.slice(before).find((x) => x.To === email);
  if (!m) return null;
  return ok(await M.pub('POST', '/family/session', { body: { token: /\?t=([A-Za-z0-9_-]+)/.exec(m.TextBody)[1] } })).session;
}
/** Registers and pays for a program place online (the Stripe webhook comes back paid). */
async function payProgram(M, P, contact, child, extra = {}) {
  const r = ok(await M.pub('POST', '/programs/register', { body: { ...contact, waiver_accepted: true, registrations: [{ program_id: P.id, term_id: P.term, group_id: P.group, child, ...extra }] } }));
  const row = (await q('SELECT * FROM program_registrations WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0];
  const raw = JSON.stringify({ id: `evt_${row.id}_${suffix}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.id}_${suffix}`, metadata: { tenant_id: String(M.id), registration_id: String(row.id), kind: 'program' } } } });
  await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
}
async function program(M, name, capacity) {
  let monday = addDays(today, 14); while (new Date(`${monday}T12:00:00Z`).getUTCDay() !== 1) monday = addDays(monday, 1);
  const id = ok(await api('POST', '/programs', { token: M.owner, body: { name, season: `${year}-${String(year + 1).slice(2)}`, age_min: 5, age_max: 14, online: true, cancel_days: 3, allow_switch: true } })).id;
  const term = ok(await api('POST', `/programs/${id}/terms`, { token: M.owner, body: { name: 'Session 1', starts_on: monday, weeks: 4, start_time: '15:45', end_time: '17:45', price_cents: 10000, status: 'open', days: [{ weekday: 1, capacity }] } }));
  return { id, term: term.id, group: term.groups[0].id, monday };
}

test.before(async () => {
  fakeStripe = http.createServer((req, res) => {
    let d = ''; req.on('data', (c) => { d += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v1/checkout/sessions') && !req.url.includes('expire')) return res.end(JSON.stringify({ id: `cs_${++n}`, url: `https://checkout.test/${n}`, payment_intent: null }));
      if (req.url.startsWith('/v1/refunds')) return res.end(JSON.stringify({ id: `re_${++n}`, status: 'succeeded' }));
      if (req.url.startsWith('/v1/accounts')) return res.end(JSON.stringify({ id: 'acct_x', charges_enabled: true, details_submitted: true }));
      res.end(JSON.stringify({ id: `x_${++n}`, status: 'expired' }));
    });
  });
  fakeMail = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { mails.push(JSON.parse(d)); } catch (_) { /* not JSON */ } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => fakeStripe.listen(0, '127.0.0.1', r));
  await new Promise((r) => fakeMail.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${fakeStripe.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${fakeMail.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); fakeStripe.close(); fakeMail.close(); await pool.end(); });

// ---------------------------------------------------------------- the family page and who counts as family
test('G1: joining a waitlist naming someone else\'s child gives no access to the child; the real parent keeps it', async () => {
  const M = await mountain('g1');
  await api('PUT', '/tenant/profile', { token: M.owner, body: { online_shop: true } });
  const A = await program(M, 'After-School Ski', 1); const B = await program(M, 'Race Team', 1);
  const kid = { first_name: 'Mia', last_name: 'Real', date_of_birth: `${year - 8}-03-03` };
  await payProgram(M, A, { contact_first_name: 'Rita', contact_last_name: 'Real', contact_email: 'rita@parent.test', contact_phone: '215-555-0101' }, kid, { medical: 'Type 1 diabetic', pickup: [{ name: 'Rita Real', phone: '215-555-0101', relation: 'Mother' }] });
  const real = (await q('SELECT id FROM program_enrollments WHERE tenant_id = ? AND program_id = ?', [M.id, A.id]))[0];
  assert.ok(real, 'the real place was made');
  await q("INSERT INTO people (tenant_id, first_name, last_name, date_of_birth) VALUES (?, 'Other', 'Kid', ?)", [M.id, `${year - 9}-01-01`]);
  const other = (await q("SELECT id FROM people WHERE tenant_id = ? AND first_name = 'Other'", [M.id]))[0].id;
  await q("INSERT INTO program_enrollments (tenant_id, program_id, person_id, status, term_id, group_id) VALUES (?, ?, ?, 'enrolled', ?, ?)", [M.id, B.id, other, B.term, B.group]);
  ok(await M.pub('POST', '/programs/waitlist', { body: { contact_first_name: 'Sam', contact_last_name: 'Stranger', contact_email: 'sam@stranger.test', contact_phone: '610-555-0199', program_id: B.id, term_id: B.term, group_id: B.group, child: kid } }));
  const s = await familySession(M, 'sam@stranger.test');
  const fam = (m, p, body) => call(m, `/api/v1/public/${M.slug}/family${p}`, { headers: { 'x-family-session': s }, body });
  const page = ok(await fam('GET', ''));
  assert.equal(page.people.some((p) => p.first_name === 'Mia'), false, 'the stranger does not see the child');
  assert.equal((await fam('PATCH', `/places/${real.id}`, { pickup: [{ name: 'Sam Stranger' }] })).status, 404, 'and cannot change who picks her up');
  const acct = ok(await call('GET', `/api/v1/public/${M.slug}/account`, { headers: { 'x-family-session': s } }));
  assert.equal(acct.members.some((m) => m.first_name === 'Mia'), false);
  // The real parent still sees her child, with the medical notes.
  const rs = await familySession(M, 'rita@parent.test');
  const rp = ok(await call('GET', `/api/v1/public/${M.slug}/family`, { headers: { 'x-family-session': rs } }));
  const mia = rp.people.find((p) => p.first_name === 'Mia');
  assert.ok(mia && mia.places.some((p) => p.medical === 'Type 1 diabetic'));
});

test('G1: a guardian staff name when enrolling becomes a guardian link, so that parent sees the child', async () => {
  const M = await mountain('g1b');
  const P = await program(M, 'Mini Rippers', 5);
  const kid = ok(await api('POST', '/people', { token: M.owner, body: { first_name: 'Kit', last_name: 'Desk', date_of_birth: `${year - 7}-02-02` } })).id;
  const mom = ok(await api('POST', '/people', { token: M.owner, body: { first_name: 'Mona', last_name: 'Desk', email: 'mona@desk.test', date_of_birth: `${year - 38}-02-02` } })).id;
  ok(await api('POST', `/programs/terms/${P.term}/enroll`, { token: M.counter, body: { person_id: kid, group_id: P.group, guardian_id: mom } }));
  assert.equal((await q("SELECT COUNT(*) AS n FROM person_links WHERE tenant_id = ? AND adult_id = ? AND member_id = ? AND relation = 'guardian'", [M.id, mom, kid]))[0].n, 1);
  const other = await mountain('g1c');
  const foreign = ok(await api('POST', '/people', { token: other.owner, body: { first_name: 'Far', last_name: 'Away', date_of_birth: '1980-01-01' } })).id;
  assert.equal((await api('POST', `/programs/terms/${P.term}/enroll`, { token: M.counter, body: { person_id: kid, group_id: P.group, guardian_id: foreign } })).status, 404, 'a guardian from another mountain is refused');
});

test('G2: signing the online waiver never makes the signer guardian of a child already on file', async () => {
  const M = await mountain('g2');
  const TEXT = 'I accept the risks of skiing.';
  ok(await api('PUT', '/tenant/profile', { token: M.owner, body: { waiver_text: TEXT } }));
  const kid = ok(await api('POST', '/people', { token: M.owner, body: { first_name: 'Ava', last_name: 'Walkup', date_of_birth: `${year - 9}-05-05` } }));
  const w = await M.pub('POST', '/waiver/sign', { body: { sha: crypto.createHash('sha256').update(TEXT).digest('hex'), signer: { first_name: 'Sam', last_name: 'Stranger', date_of_birth: '1980-01-01', email: 'sam2@stranger.test' },
    self: false, children: [{ first_name: 'Ava', last_name: 'Walkup', date_of_birth: `${year - 9}-05-05` }], typed_name: 'Sam Stranger', signature: signaturePng(), agree: true } });
  assert.ok(w.status < 300, w.text);
  assert.equal((await q("SELECT COUNT(*) AS n FROM person_links WHERE tenant_id = ? AND member_id = ? AND relation = 'guardian'", [M.id, kid.id]))[0].n, 0, 'the real record gets no guardian');
  const dup = await q("SELECT id, notes FROM people WHERE tenant_id = ? AND first_name = 'Ava' AND id <> ?", [M.id, kid.id]);
  assert.equal(dup.length, 1, 'the signing went on a new record');
  assert.match(dup[0].notes, /not a guardian on file/);
  const s = await familySession(M, 'sam2@stranger.test');
  assert.equal((await call('PATCH', `/api/v1/public/${M.slug}/account/people/${kid.id}`, { headers: { 'x-family-session': s }, body: { date_of_birth: `${year - 3}-01-01` } })).status, 404);
});

test('G3: a second adult added on an account gets no email until they confirm it, and cannot capture another family\'s child', async () => {
  const M = await mountain('g3');
  await api('PUT', '/tenant/profile', { token: M.owner, body: { online_shop: true } });
  const P = await program(M, 'After-School Ski', 10);
  await payProgram(M, P, { contact_first_name: 'Max', contact_last_name: 'Attacker', contact_email: 'max@attacker.test', contact_phone: '610-555-0001' }, { first_name: 'Own', last_name: 'Kid', date_of_birth: `${year - 7}-01-01` });
  const s = await familySession(M, 'max@attacker.test');
  const hdr = { 'x-family-session': s };
  const before = mails.length;
  const plant = ok(await call('POST', `/api/v1/public/${M.slug}/account/people`, { headers: hdr, body: { adult: true, first_name: 'Vera', last_name: 'Victim', email: 'vera@victim.test' } }));
  const rec = (await q('SELECT email, source FROM people WHERE id = ?', [plant.id]))[0];
  assert.equal(rec.email, null, 'the typed email is not on the record');
  assert.equal(rec.source, 'household');
  await new Promise((r) => setTimeout(r, 200));
  const invite = mails.slice(before).find((m) => m.To === 'vera@victim.test');
  assert.ok(invite, 'Vera is asked to confirm');
  assert.doesNotMatch(invite.TextBody, /Attacker|Max/, 'nothing the other guest typed is in the email');
  await payProgram(M, P, { contact_first_name: 'Vera', contact_last_name: 'Victim', contact_email: 'vera@victim.test', contact_phone: '484-555-0102' }, { first_name: 'Lily', last_name: 'Victim', date_of_birth: `${year - 9}-06-06` });
  const acct = ok(await call('GET', `/api/v1/public/${M.slug}/account`, { headers: hdr }));
  assert.equal(acct.members.some((m) => m.first_name === 'Lily'), false, 'Lily is not in the attacker\'s household');
  // A child typed into a household is never matched by an online sale either.
  const fake = ok(await call('POST', `/api/v1/public/${M.slug}/account/people`, { headers: hdr, body: { first_name: 'Zoe', last_name: 'Victim', date_of_birth: `${year - 8}-04-04` } })).id;
  await payProgram(M, P, { contact_first_name: 'Vera', contact_last_name: 'Victim', contact_email: 'vera@victim.test', contact_phone: '484-555-0102' }, { first_name: 'Zoe', last_name: 'Victim', date_of_birth: `${year - 8}-04-04` });
  assert.equal((await q('SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND person_id = ?', [M.id, fake]))[0].n, 0);
  // The person who really owns the address confirms, and is signed in.
  const token = /join=([A-Za-z0-9_-]+)/.exec(invite.TextBody)[1];
  const j = ok(await M.pub('POST', '/account/join', { body: { token } }));
  assert.equal(j.email, 'vera@victim.test');
  assert.equal((await q('SELECT email FROM people WHERE id = ?', [plant.id]))[0].email, 'vera@victim.test');
  assert.equal((await M.pub('POST', '/account/join', { body: { token } })).status, 400, 'a link works once');
});

// ---------------------------------------------------------------- booking lessons
test('S1: bringing a canceled booking back goes through the booking checks (no double booking)', async () => {
  const M = await mountain('s1');
  const day = addDays(today, 10);
  const a = ok(await lesson(M, day, '10:00')).id; const b = ok(await lesson(M, day, '10:00')).id;
  const kid = { first_name: 'Kara', last_name: 'Twice', date_of_birth: '2017-02-02', sex: 'female' };
  const bk = ok(await book(M, a, kid));
  ok(await api('PATCH', `/skischool/bookings/${bk.id}`, { token: M.counter, body: { status: 'cancelled' } }));
  ok(await book(M, b, kid, { person_id: bk.person_id }));
  const revive = await api('PATCH', `/skischool/bookings/${bk.id}`, { token: M.counter, body: { status: 'booked' } });
  assert.equal(revive.status, 409);
  assert.match(revive.body.error, /Already booked/);
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND person_id = ? AND status = 'booked'", [M.id, bk.person_id]))[0].n, 1);
});

test('S2/G5: every online path checks age, discipline and level, and confirming checks again', async () => {
  const M = await mountain('s2');
  ok(await api('PUT', '/tenant/profile', { token: M.owner, body: { online_booking: true, booking_notice_hours: 1, waiver_text: 'I accept the risks.' } }));
  const day = addDays(today, 6);
  const kids = ok(await lesson(M, day, '10:00', { age_min: 4, age_max: 7 })).id;
  const experts = ok(await lesson(M, day, '13:00', { level_min: 7, level_max: 9 })).id;
  const contact = { contact_first_name: 'Pat', contact_last_name: 'Parent', contact_email: 'pat@x.test', contact_phone: '215-555-0101', waiver_accepted: true };
  const a = await M.pub('POST', '/requests', { body: { ...contact, session_id: kids, students: [{ first_name: 'Big', last_name: 'Adult', date_of_birth: '1986-01-01', sex: 'male' }] } });
  assert.equal(a.status, 409); assert.match(a.body.error, /ages 4 to 7/);
  const b = await M.pub('POST', '/lesson-basket', { body: { ...contact, items: [{ session_id: experts, student: { first_name: 'Tia', last_name: 'Tiny', date_of_birth: `${year - 8}-02-02`, sex: 'female', level: 1, discipline: 'ski' } }] } });
  assert.equal(b.status, 409); assert.match(b.body.error, /levels 7 to 9/);
  const c = await M.pub('POST', '/lesson-basket', { body: { ...contact, items: [{ session_id: kids, student: { first_name: 'Tot', last_name: 'Small', date_of_birth: `${year - 2}-02-02`, sex: 'female' } }] } });
  assert.equal(c.status, 409);
  const d = await M.pub('POST', '/requests', { body: { ...contact, session_id: experts, students: [{ first_name: 'New', last_name: 'Bie', date_of_birth: '1990-01-01', sex: 'male', ability_level: 'first_timer' }] } });
  assert.equal(d.status, 409, 'the old four words count as a level too');
  // A request that fit when made is checked again when staff confirm it.
  const fine = ok(await M.pub('POST', '/requests', { body: { ...contact, session_id: kids, students: [{ first_name: 'Kim', last_name: 'Kid', date_of_birth: `${year - 6}-01-01`, sex: 'female' }] } }));
  ok(await api('PATCH', `/skischool/sessions/${kids}`, { token: M.owner, body: { age_min: 10, age_max: 14 } }));
  const rid = (await q('SELECT id FROM lesson_requests WHERE tenant_id = ? AND reference = ?', [M.id, fine.reference]))[0].id;
  const conf = await api('POST', `/skischool/requests/${rid}/confirm`, { token: M.counter });
  assert.equal(conf.status, 409);
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status = 'booked'", [M.id, kids]))[0].n, 0);
});

test('G6: a lesson the booking page does not list cannot be booked by its id', async () => {
  const M = await mountain('g6');
  ok(await api('PUT', '/tenant/profile', { token: M.owner, body: { online_booking: true, waiver_text: 'I accept the risks.', booking_notice_hours: 1 } }));
  const far = ok(await lesson(M, addDays(today, 120), '10:00')).id;
  const retired = ok(await api('POST', '/products', { token: M.owner, body: { kind: 'lesson', name: 'Retired', base_price_cents: 5000 } })).id;
  const off = ok(await api('POST', '/skischool/sessions', { token: M.owner, body: { product_id: retired, starts_at: `${addDays(today, 5)}T10:00`, ends_at: `${addDays(today, 5)}T12:00` } })).id;
  await q('UPDATE products SET active = 0 WHERE id = ?', [retired]);
  const student = { first_name: 'Kim', last_name: 'Kid', date_of_birth: `${year - 9}-02-02`, sex: 'female' };
  const contact = { contact_first_name: 'Pat', contact_last_name: 'Parent', contact_email: 'pat6@x.test', contact_phone: '215-555-0101', waiver_accepted: true };
  for (const sid of [far, off]) {
    assert.equal((await M.pub('POST', '/requests', { body: { ...contact, session_id: sid, students: [student] } })).status, 404);
    assert.equal((await M.pub('POST', '/lesson-basket', { body: { ...contact, items: [{ session_id: sid, student }] } })).status, 404);
  }
});

test('S3: a weather delay that would overlap lessons is listed in the preview and refused', async () => {
  const M = await mountain('s3');
  const day = addDays(today, 2);
  const a = ok(await lesson(M, day, '09:00', { instructor_id: M.ivyId })).id;
  const b = ok(await lesson(M, day, '11:00', { instructor_id: M.ivyId })).id;
  const kid = ok(await book(M, a, { first_name: 'Wendy', last_name: 'Weather', date_of_birth: '2016-06-06', sex: 'female' }));
  ok(await book(M, b, {}, { person_id: kid.person_id }));
  const scope = { action: 'delay', date: day, from_time: '08:00', to_time: '10:00', delay_minutes: 60 };
  const pv = ok(await api('POST', '/skischool/director/weather/preview', { token: M.owner, body: scope }));
  assert.ok(pv.clashes.some((c) => /Wendy/.test(c.who)));
  assert.ok(pv.clashes.some((c) => /Ivy/.test(c.who)));
  assert.equal((await q('SELECT starts_at FROM lesson_sessions WHERE id = ?', [a]))[0].starts_at.slice(11, 16), '09:00', 'the preview changed nothing');
  const r = await api('POST', '/skischool/director/weather', { token: M.owner, body: { ...scope, reason: 'Wind hold' } });
  assert.equal(r.status, 409);
  assert.equal((await q('SELECT starts_at FROM lesson_sessions WHERE id = ?', [a]))[0].starts_at.slice(11, 16), '09:00');
  // The whole day moves together: no overlap, so it goes ahead.
  ok(await api('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'delay', date: day, delay_minutes: 30, reason: 'Wind hold' } }));
  assert.equal((await q('SELECT starts_at FROM lesson_sessions WHERE id = ?', [b]))[0].starts_at.slice(11, 16), '11:30');
});

// ---------------------------------------------------------------- instructors on lessons
test('S4: copying a day keeps a lesson that runs past midnight whole', async () => {
  const M = await mountain('s4');
  const src = addDays(today, 20); const dst = addDays(today, 27);
  ok(await api('POST', '/skischool/sessions', { token: M.owner, body: { product_id: M.group, starts_at: `${src}T20:00`, ends_at: `${addDays(src, 1)}T00:30` } }));
  ok(await api('POST', '/skischool/director/copy', { token: M.owner, body: { source: { from: src }, targets: [dst] } }));
  const [c] = await q("SELECT starts_at, ends_at FROM lesson_sessions WHERE tenant_id = ? AND origin = 'copy'", [M.id]);
  assert.equal(c.starts_at, `${dst} 20:00:00`);
  assert.equal(c.ends_at, `${addDays(dst, 1)} 00:30:00`);
});

test('S7: copying with instructors drops one who is not cleared for the lesson', async () => {
  const M = await mountain('s7');
  const src = addDays(today, 5); const dst = addDays(today, 12);
  ok(await lesson(M, src, '10:00', { age_min: 4, age_max: 7, level_min: 1, level_max: 2, instructor_id: M.ivyId }));
  ok(await api('PUT', `/skischool/instructors/${M.ivyId}/profile`, { token: M.owner, body: { disciplines: ['snowboard'], ski_level_max: null, snowboard_level_max: 9, teaches_kids: false, teaches_adaptive: false, psia_level: 'level1' } }));
  const pv = ok(await api('POST', '/skischool/director/copy/preview', { token: M.owner, body: { source: { from: src }, targets: [dst], with_instructors: true } }));
  assert.ok(pv.lessons[0].instructor_problem);
  ok(await api('POST', '/skischool/director/copy', { token: M.owner, body: { source: { from: src }, targets: [dst], with_instructors: true } }));
  assert.equal((await q("SELECT instructor_id FROM lesson_sessions WHERE tenant_id = ? AND origin = 'copy'", [M.id]))[0].instructor_id, null);
});

test('S5: undoing a plan publish does not put an instructor back on a time they now teach', async () => {
  const M = await mountain('s5');
  const day = addDays(today, 9);
  const plan = ok(await api('POST', '/skischool/plans', { token: M.owner, body: { name: 'Winter', from_on: day, to_on: day } }));
  const docAt = (start, end) => ({ ...plan.doc, weekdays: Array(7).fill('weekday'),
    day_types: plan.doc.day_types.map((t) => (t.key === 'weekday' ? { ...t, slots: [{ key: 'am', start, end, product_id: M.group, kind: 'class', format: 'group', discipline: 'ski', spots: 6, spots_mode: 'fixed', instructor_id: M.ivyId }] } : t)) });
  ok(await api('PUT', `/skischool/plans/${plan.id}`, { token: M.owner, body: { doc: docAt('10:00', '12:00') } }));
  ok(await api('POST', `/skischool/plans/${plan.id}/publish`, { token: M.owner, body: {} }));
  ok(await api('PUT', `/skischool/plans/${plan.id}`, { token: M.owner, body: { doc: docAt('13:00', '15:00') } }));
  const p2 = ok(await api('POST', `/skischool/plans/${plan.id}/publish`, { token: M.owner, body: {} }));
  ok(await lesson(M, day, '10:00', { instructor_id: M.ivyId }));
  const u = ok(await api('POST', `/skischool/plans/publishes/${p2.publish_id}/undo`, { token: M.owner }));
  assert.equal(u.assign_later.length, 1);
  const at10 = await q("SELECT id FROM lesson_sessions WHERE tenant_id = ? AND instructor_id = ? AND status = 'scheduled' AND TIME(starts_at) = '10:00:00'", [M.id, M.ivyId]);
  assert.equal(at10.length, 1);
});

test('S6: applying a lineup split checks the class as it ends up, with its certification', async () => {
  const M = await mountain('s6');
  const cert = ok(await api('POST', '/workforce/certifications', { token: M.owner, body: { name: 'Freestyle Specialist' } })).id;
  ok(await api('PUT', `/skischool/instructors/${M.ivyId}/profile`, { token: M.owner, body: { disciplines: ['ski'], ski_level_max: 3, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  const day = addDays(today, 3);
  const sid = ok(await lesson(M, day, '10:00', { level_min: 7, level_max: 9, required_certification_id: cert })).id;
  const b = ok(await book(M, sid, { first_name: 'Ada', last_name: 'Expert', date_of_birth: '2000-01-01', sex: 'female', ski_level: 8 }));
  const lu = ok(await api('GET', `/skischool/lineups?date=${day}`, { token: M.owner })).data[0].id;
  const r = await api('POST', `/skischool/lineups/${lu}/apply`, { token: M.owner, body: { classes: [{ session_id: sid, booking_ids: [b.id], instructor_id: M.ivyId }] } });
  assert.equal(r.status, 409);
  assert.equal((await q('SELECT instructor_id FROM lesson_sessions WHERE id = ?', [sid]))[0].instructor_id, null);
});

test('S8: editing a lesson takes off an instructor who is no longer cleared for it, and says so', async () => {
  const M = await mountain('s8');
  ok(await api('PUT', `/skischool/instructors/${M.ivyId}/profile`, { token: M.owner, body: { disciplines: ['ski'], ski_level_max: 3, snowboard_level_max: null, teaches_kids: false, teaches_adaptive: false, psia_level: 'level1' } }));
  const sid = ok(await lesson(M, addDays(today, 8), '10:00', { level_min: 1, level_max: 2, age_min: 18, instructor_id: M.ivyId })).id;
  const e = ok(await api('PATCH', `/skischool/sessions/${sid}`, { token: M.owner, body: { level_min: 7, level_max: 9, age_min: 6, age_max: 10 } }));
  assert.ok(e.instructor_removed && /Ivy/.test(e.instructor_removed.message));
  assert.equal((await q('SELECT instructor_id FROM lesson_sessions WHERE id = ?', [sid]))[0].instructor_id, null);
  const keep = ok(await lesson(M, addDays(today, 8), '13:00', { level_min: 1, level_max: 2, age_min: 18, instructor_id: M.ivyId })).id;
  assert.equal(ok(await api('PATCH', `/skischool/sessions/${keep}`, { token: M.owner, body: { meeting_place: 'The bell' } })).instructor_removed, null, 'an edit that still fits keeps them');
});

test('S9: a plain instructor cannot book students or read another instructor\'s roster', async () => {
  const M = await mountain('s9');
  const day = addDays(today, 4);
  const maxLesson = ok(await lesson(M, day, '10:00', { instructor_id: M.maxId })).id;
  ok(await book(M, maxLesson, { first_name: 'Olivia', last_name: 'Other', date_of_birth: '2016-05-05', sex: 'female' }));
  const r = await api('POST', `/skischool/sessions/${maxLesson}/bookings`, { token: M.ivy, body: { student: { first_name: 'Nate', last_name: 'New', date_of_birth: '2017-01-01', sex: 'male' }, sign_waiver: true, send_confirmation: false } });
  assert.equal(r.status, 403);
  assert.equal((await q("SELECT COUNT(*) AS n FROM people WHERE tenant_id = ? AND first_name = 'Nate'", [M.id]))[0].n, 0);
  assert.equal((await api('GET', `/skischool/sessions/${maxLesson}/roster`, { token: M.ivy })).status, 403);
  assert.equal((await api('GET', `/skischool/sessions/${maxLesson}/roster`, { token: M.max })).status, 200, 'their own roster is fine');
});

test('S10: a ski school director cannot change how instructors are paid', async () => {
  const M = await mountain('s10');
  ok(await api('PUT', `/skischool/access/${M.maxId}`, { token: M.owner, body: { level: 'director' } }));
  M.max = await login(M.slug, `max@${M.slug}.test`);
  const r = await api('PATCH', '/skischool/settings', { token: M.max, body: { request_bonus_cents: 100000 } });
  assert.equal(r.status, 403, r.text);
  assert.equal((await api('PATCH', '/skischool/settings', { token: M.max, body: { private_accept_minutes: 60, request_bonus_cents: 0, pay_mode: 'per_lesson' } })).status, 200, 'the rest of the form, with pay unchanged, saves');
  assert.equal(ok(await api('PATCH', '/skischool/settings', { token: M.owner, body: { request_bonus_cents: 500 } })).request_bonus_cents, 500);
});

// ---------------------------------------------------------------- signatures, Spanish, children's accounts
test('G9: a waiver with a blank box is not signed; a drawn signature is', async () => {
  const M = await mountain('g9');
  const TEXT = 'I accept the risks of skiing.';
  ok(await api('PUT', '/tenant/profile', { token: M.owner, body: { waiver_text: TEXT } }));
  const body = (signature) => ({ sha: crypto.createHash('sha256').update(TEXT).digest('hex'), signer: { first_name: 'Ann', last_name: 'Adult', date_of_birth: '1980-01-01', email: 'ann@x.test' }, self: true, children: [], typed_name: 'Ann Adult', signature, agree: true });
  const header = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString('base64')}`;
  for (const sig of [header, signaturePng({ blank: true })]) assert.equal((await M.pub('POST', '/waiver/sign', { body: body(sig) })).status, 400);
  assert.ok((await M.pub('POST', '/waiver/sign', { body: body(signaturePng()) })).status < 300);
  const S = require('../src/lib/signature');
  assert.equal(S.check(signaturePng()).ok, true);
  assert.equal(S.check(signaturePng({ blank: true })).ok, false);
  assert.equal(S.check('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==').ok, false, 'a 1 by 1 image is not a signature');
});

test('G10: the booking page has Spanish for its sentences and the built-in placement questions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'book.js'), 'utf8');
  for (const s of ['Tell us who is coming and pick a lesson for each person. The ski school confirms it, and you pay at the desk.', 'Add everyone who wants a lesson. Each person can pick a different lesson, so brothers and sisters at different levels are fine.', 'Find my level', 'Have you skied before?', 'Can you ride a blue trail with linked turns?']) {
    assert.ok(src.includes(`${JSON.stringify(s)}: "`), `Spanish for "${s}"`);
  }
  for (const qq of require('../src/lib/placement').BUILT_IN.ski.concat(require('../src/lib/placement').BUILT_IN.snowboard)) assert.ok(src.includes(`${JSON.stringify(qq.text)}: "`), qq.text);
  assert.ok(src.includes('T(q.text)'), 'the questions go through T()');
});

test('DP-2: a gift opened for someone under 13 goes to a parent\'s account with consent; the child is never emailed', async () => {
  const M = await mountain('dp2');
  const token = crypto.randomBytes(24).toString('base64url');
  const kidMail = `kid-${suffix}@kidmail.example`;
  await q(`INSERT INTO gift_experiences (tenant_id, theme, includes, from_name, recipient_name, recipient_email, deliver_on, token_hash, delivered_at)
    VALUES (?, 'First day on snow', '{"items":[{"kind":"lesson","name":"Group lesson","cents":6000}],"amount_cents":0}', 'Grandma', 'Timmy', ?, CURDATE(), ?, UTC_TIMESTAMP())`, [M.id, kidMail, crypto.createHash('sha256').update(token).digest('hex')]);
  const kid = { first_name: 'Timmy', last_name: 'Kid', date_of_birth: `${year - 9}-05-01` };
  assert.equal((await M.pub('POST', `/gift/${token}/redeem`, { body: kid })).status, 400, 'a parent is needed');
  assert.equal((await M.pub('POST', `/gift/${token}/redeem`, { body: { ...kid, parent_first_name: 'Pam', parent_last_name: 'Kid', parent_email: kidMail, parent_consent: true } })).status, 400, 'not the child\'s own address');
  assert.equal((await M.pub('POST', `/gift/${token}/redeem`, { body: { ...kid, parent_first_name: 'Pam', parent_last_name: 'Kid', parent_email: 'pam@parent.test' } })).status, 400, 'consent is needed');
  const before = mails.length;
  const r = ok(await M.pub('POST', `/gift/${token}/redeem`, { body: { ...kid, parent_first_name: 'Pam', parent_last_name: 'Kid', parent_email: 'pam@parent.test', parent_consent: true } }));
  assert.equal(r.parent, true);
  await new Promise((x) => setTimeout(x, 200));
  assert.equal((await q('SELECT COUNT(*) AS n FROM people WHERE tenant_id = ? AND email = ?', [M.id, kidMail]))[0].n, 0, 'no record holds the child\'s email');
  assert.equal(mails.slice(before).some((m) => m.To === kidMail), false, 'nothing is sent to the child');
  assert.ok(mails.slice(before).some((m) => m.To === 'pam@parent.test'));
  const child = (await q("SELECT id, email FROM people WHERE tenant_id = ? AND first_name = 'Timmy'", [M.id]))[0];
  assert.equal(child.email, null);
  assert.equal((await q("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'parent_consent' AND entity_id = ?", [M.id, child.id]))[0].n, 1, 'consent is recorded');
});

// ---------------------------------------------------------------- suspicions confirmed and fixed
test('a private lesson assigned by hand needs an instructor cleared for it', async () => {
  const M = await mountain('pv');
  ok(await api('PUT', `/skischool/instructors/${M.ivyId}/profile`, { token: M.owner, body: { disciplines: ['snowboard'], ski_level_max: null, snowboard_level_max: 9, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  const [o] = await pool.query('INSERT INTO private_offers (tenant_id, product_id, minutes) VALUES (?, ?, 60)', [M.id, M.group]);
  const day = addDays(today, 5);
  const [r] = await pool.query(`INSERT INTO private_requests (tenant_id, reference, token_sha, product_id, offer_id, discipline, starts_at, minutes, students, status, contact_name, contact_email, contact_phone, amount_cents, pay_at_desk)
    VALUES (?, ?, ?, ?, ?, 'ski', ?, 60, ?, 'waiting', 'Pat Parent', 'pat@x.test', '215-555-0101', 0, 1)`, [M.id, `PV${Date.now() % 1000000}`.slice(0, 8), crypto.randomBytes(32).toString('hex'), M.group, o.insertId, `${day} 10:00:00`,
    JSON.stringify({ contact: { first_name: 'Pat', last_name: 'Parent' }, students: [{ first_name: 'Kim', last_name: 'Kid', date_of_birth: `${year - 9}-01-01`, sex: 'female', level: 2 }] })]);
  const a = await api('POST', `/skischool/pay/requests/${r.insertId}/assign`, { token: M.owner, body: { staff_id: M.ivyId } });
  assert.equal(a.status, 409);
  assert.match(a.body.error, /not cleared/);
});

test('moving a student at the lineup checks the class takes their age', async () => {
  const M = await mountain('mv');
  const day = addDays(today, 3);
  const adults = ok(await lesson(M, day, '10:00', { age_min: 18 })).id;
  const kidsClass = ok(await lesson(M, day, '10:00', { age_min: 4, age_max: 7 })).id;
  const b = ok(await book(M, adults, { first_name: 'Al', last_name: 'Adult', date_of_birth: '1980-01-01', sex: 'male' }));
  const r = await api('POST', `/skischool/bookings/${b.id}/move`, { token: M.owner, body: { session_id: kidsClass } });
  assert.equal(r.status, 409);
});

test('instructor pay counts the real minutes of a lesson across a daylight saving change', () => {
  const P = require('../src/lib/lessonpay');
  assert.equal(P.zoneMinutes('2026-11-01 00:30:00', '2026-11-01 03:30:00', 'America/New_York'), 240);
  assert.equal(P.zoneMinutes('2027-03-14 01:00:00', '2027-03-14 04:00:00', 'America/Denver'), 120);
  assert.equal(P.zoneMinutes('2026-12-01 10:00:00', '2026-12-01 12:00:00', 'America/Denver'), 120);
});

test('a gift theme is one from the list, and the names in the subject are one line', async () => {
  const { oneLine, THEMES } = require('../src/lib/giftthemes');
  assert.equal(oneLine('Bob\r\nBcc: x'), 'Bob Bcc: x');
  assert.ok(oneLine('x'.repeat(200)).length <= 60);
  const M = await mountain('gt');
  const card = await q("INSERT INTO gift_cards (tenant_id, code, initial_cents, balance_cents, status) VALUES (?, ?, 1000, 1000, 'active')", [M.id, `GT${suffix}`.slice(0, 16).toUpperCase()]).catch(() => null);
  if (!card) return;
  const body = { gift_card_id: card.insertId, theme: 'Free money inside', from_name: 'Grandma', recipient_name: 'Timmy', recipient_email: 't@x.test', deliver_on: addDays(today, 1) };
  assert.equal((await api('POST', '/guests/gift-experiences', { token: M.owner, body })).status, 400);
  assert.ok(THEMES.includes('First day on snow'));
});

test('stale online requests stop holding places without waiting for Stripe', async () => {
  const M = await mountain('sw');
  const sid = ok(await lesson(M, addDays(today, 3), '10:00')).id;
  await q("INSERT INTO lesson_requests (tenant_id, session_id, reference, contact_name, contact_email, contact_phone, students, waiver_accepted, status, amount_cents, created_at) VALUES (?, ?, ?, 'Pat', 'p@x.test', '215-555-0101', '{\"students\":[{}]}', 1, 'awaiting_payment', 5000, NOW() - INTERVAL 2 HOUR)", [M.id, sid, `SW${n++}${Date.now() % 100000}`.slice(0, 8)]);
  await require('../src/routes/schoolparents').tick();
  assert.equal((await q('SELECT status FROM lesson_requests WHERE tenant_id = ? AND session_id = ?', [M.id, sid]))[0].status, 'expired');
});
