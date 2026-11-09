'use strict';

// The morning brief's evaluation fixtures: realistic days at small mountains, each a mountain of its own. Shared by
// the brief evaluations in the tests (fake model) and scripts/ai-evals-brief.js (the real model, opt-in). Kept here, not
// with the tests, so the script needs nothing that the release leaves out (as scripts/ai-evals-conditions.js).
const crypto = require('crypto');
const D = require('../src/lib/briefdata');
const B = require('../src/lib/brief');
const W = require('../src/lib/briefwrite');

let E = null; // { pool, api, ok, wx, modules }
const setup = (env) => { E = env; };
const PW = 'correct-horse-battery';
let seq = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

// Things written into patrol cases that must never reach a brief.
const PATROL_SECRETS = ['Zebulon', 'Quixote', 'femur', 'fractured', 'PB-2026-0042', 'unconscious', '555-0199'];

async function q(sql, params) { return (await E.pool.query(sql, params))[0]; }

const HASH = require('bcryptjs').hashSync(PW, 4);
const login = async (slug, email) => (await E.api('POST', '/auth/login', { body: { tenant: slug, login: email, password: PW } })).body.token;

/** A new mountain with its owner, written straight to the database. day: the local date the brief is for. */
async function mountain(name, { tz = 'America/New_York', day, weather } = {}) {
  seq += 1;
  const slug = `brf-${suffix}-${seq}`;
  const ownerEmail = `owner@${slug}.test`;
  const id = (await q('INSERT INTO tenants (slug, name, timezone) VALUES (?, ?, ?)', [slug, name, tz])).insertId;
  const owner = (await q("INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES (?, ?, ?, 'owner', 1)", [id, ownerEmail, HASH])).insertId;
  const lat = (40 + seq / 100).toFixed(3);
  await q('UPDATE tenants SET map_lat = ?, map_lng = -105.5 WHERE id = ?', [lat, id]);
  if (weather) E.wx.set(lat, weather);
  E.modules.invalidate(id);
  return { id, slug, name, day, tz, ownerId: owner, ownerEmail, lat };
}

const open = (m, ...days) => Promise.all(days.map((d) => q("INSERT INTO calendar_days (tenant_id, on_date, status, open_time, close_time) VALUES (?, ?, 'open', '09:00:00', '16:00:00') ON DUPLICATE KEY UPDATE status = 'open'", [m.id, d])));
async function lift(m, name, limit = null) { const [r] = [await q("INSERT INTO lifts (tenant_id, name, status, wind_hold_mph) VALUES (?, ?, 'open', ?)", [m.id, name, limit])]; return r.insertId; }
async function trail(m, name) { return (await q("INSERT INTO trails (tenant_id, name, difficulty, status) VALUES (?, ?, 'blue', 'open')", [m.id, name])).insertId; }
async function ticketsFor(m, day, n) {
  const o = await q("INSERT INTO orders (tenant_id, status, channel, total_cents) VALUES (?, 'paid', 'online', ?)", [m.id, n * 8900]);
  await q("INSERT INTO order_items (tenant_id, order_id, line_kind, quantity, unit_price_cents, valid_on) VALUES (?, ?, 'ticket', ?, 8900, ?)", [m.id, o.insertId, n, day]);
}
async function person(m, first, last, dob = null) { return (await q('INSERT INTO people (tenant_id, first_name, last_name, date_of_birth) VALUES (?, ?, ?, ?)', [m.id, first, last, dob])).insertId; }
async function staff(m, first, last) { const p = await person(m, first, last); return (await q("INSERT INTO staff (tenant_id, person_id, status) VALUES (?, ?, 'active')", [m.id, p])).insertId; }
async function position(m, name, department) { return (await q('INSERT INTO positions (tenant_id, name, department) VALUES (?, ?, ?)', [m.id, name, department])).insertId; }

async function tenantRow(m) { return (await q('SELECT * FROM tenants WHERE id = ?', [m.id]))[0]; }
async function mods(m) { return new Set(await E.modules.enabledKeys(m.id)); }
const dayOf = (m) => ({ date: m.day, today: m.day, opening_day: false, opening_tomorrow: false, hours: { open: '09:00', close: '16:00' } });

/** The facts for a fixture's day and a kind of brief. */
async function facts(m, kind) { return D.assemble(E.pool, await tenantRow(m), kind, dayOf(m), await mods(m)); }
/** The day's brief of a kind, made (and kept) as the job makes it. */
async function brief(m, kind) {
  const d = dayOf(m);
  return B.ensure(E.pool, await tenantRow(m), kind, { sentOn: m.day, forDate: m.day, today: m.day, opening_day: false, opening_tomorrow: false, hours: d.hours }, await mods(m));
}
const writeOnly = (m, data) => W.write(data, { tenantId: m.id, kind: 'ops' });

// ---------------------------------------------------------------- the days
async function powderSaturday() {
  const m = await mountain('Powder Ridge', { day: '2026-12-12', weather: { high: 22, low: 9, snow: 14, precip: 1.2, wind: 12, gust: 20, code: 73 } });
  await open(m, '2026-12-12');
  await lift(m, 'Summit Quad', 50); await lift(m, 'Valley Double', 60);
  await q("INSERT INTO snow_readings (tenant_id, read_at, new_snow_in, base_in) VALUES (?, '2026-12-12 05:30:00', 12, 40)", [m.id]);
  await ticketsFor(m, '2026-12-12', 320);
  for (const [d, v] of [['2026-12-05', 800], ['2026-11-28', 850], ['2026-11-21', 950], ['2026-11-14', 1000], ['2026-11-07', 5000], ['2026-12-08', 300]]) {
    await q("INSERT INTO day_records (tenant_id, on_date, weekday, status, visits) VALUES (?, ?, WEEKDAY(?) + 1 - 7 * (WEEKDAY(?) = 6), 'open', ?)", [m.id, d, d, d, v]);
  }
  return m;
}

async function windDay() {
  const m = await mountain('Gusty Peak', { day: '2026-12-13', weather: { high: 30, low: 18, snow: 0, precip: 0, wind: 31, gust: 58, code: 3 } });
  await open(m, '2026-12-13');
  await lift(m, 'Summit Quad', 45); await lift(m, 'Valley Double', 70); await lift(m, 'Bunny Carpet', null);
  return m;
}

async function rainDay() {
  const m = await mountain('Wet Hollow', { day: '2026-12-14', weather: { high: 41, low: 34, snow: 0, precip: 0.6, wind: 9, gust: 16, code: 63 } });
  await open(m, '2026-12-14');
  await lift(m, 'Main Chair', 50);
  await ticketsFor(m, '2026-12-14', 45);
  return m;
}

async function slowTuesday() {
  const m = await mountain('Quiet Knob', { day: '2026-12-15', weather: { high: 25, low: 12, snow: 0, precip: 0, wind: 6, gust: 11, code: 1 } });
  await open(m, '2026-12-15');
  await lift(m, 'Main Chair', 50);
  await ticketsFor(m, '2026-12-15', 12);
  return m;
}

async function openingDay() {
  const m = await mountain('Front Range Hill', { tz: 'America/Denver', day: '2026-12-05' });
  await open(m, '2026-12-05');
  await q("INSERT INTO calendar_days (tenant_id, on_date, status) VALUES (?, '2026-12-04', 'closed')", [m.id]);
  await lift(m, 'Main Chair', null);
  return m;
}

async function understaffedSchool() {
  const m = await mountain('Learners Lodge', { day: '2026-12-16', weather: { high: 24, low: 10, snow: 1, precip: 0.1, wind: 8, gust: 14, code: 71 } });
  await open(m, '2026-12-16');
  const prod = (await q("INSERT INTO products (tenant_id, kind, name, base_price_cents, active) VALUES (?, 'lesson', 'Kids group', 9900, 1)", [m.id])).insertId;
  const adult = (await q("INSERT INTO products (tenant_id, kind, name, base_price_cents, active) VALUES (?, 'lesson', 'Adult group', 9900, 1)", [m.id])).insertId;
  const priv = (await q("INSERT INTO products (tenant_id, kind, name, base_price_cents, active) VALUES (?, 'lesson', 'Private hour', 19900, 1)", [m.id])).insertId;
  const ina = await staff(m, 'Ina', 'Instructor');
  const kids = (await q("INSERT INTO lesson_sessions (tenant_id, product_id, starts_at, ends_at, capacity, format, age_group, age_min, age_max, status) VALUES (?, ?, '2026-12-16 10:00:00', '2026-12-16 12:00:00', 8, 'group', 'kids', 3, 4, 'scheduled')", [m.id, prod])).insertId;
  const adults = (await q("INSERT INTO lesson_sessions (tenant_id, product_id, starts_at, ends_at, capacity, format, age_group, instructor_id, status) VALUES (?, ?, '2026-12-16 13:00:00', '2026-12-16 15:00:00', 8, 'group', 'adults', ?, 'scheduled')", [m.id, adult, ina])).insertId;
  const one = (await q("INSERT INTO lesson_sessions (tenant_id, product_id, starts_at, ends_at, capacity, format, status) VALUES (?, ?, '2026-12-16 11:00:00', '2026-12-16 12:00:00', 1, 'private', 'scheduled')", [m.id, priv])).insertId;
  for (let i = 0; i < 6; i += 1) await q("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [m.id, kids, await person(m, `Kid${i}`, 'Small', '2022-06-01')]);
  for (let i = 0; i < 2; i += 1) await q("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [m.id, adults, await person(m, `Grown${i}`, 'Up', '1980-01-01')]);
  await q("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [m.id, one, await person(m, 'Solo', 'Skier', '1990-01-01')]);
  const school = await position(m, 'Instructor', 'ski_school');
  const lifts = await position(m, 'Lift operator', 'lifts');
  await q("INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at, status) VALUES (?, ?, ?, '2026-12-16 08:30:00', '2026-12-16 16:30:00', 'published')", [m.id, school, ina]);
  await q("INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at, status) VALUES (?, ?, NULL, '2026-12-16 08:30:00', '2026-12-16 16:30:00', 'published')", [m.id, lifts]);
  return m;
}

async function failedCheck() {
  const m = await mountain('Checklist Mountain', { day: '2026-12-15' });
  await open(m, '2026-12-15');
  const vd = await lift(m, 'Valley Double', null);
  await lift(m, 'Summit Quad', null);
  await q("INSERT INTO lift_checks (tenant_id, lift_id, check_date, kind, result, items, inspector, checked_at) VALUES (?, ?, '2026-12-14', 'pre_open', 'pass', '[]', 'Lead', '2026-12-14 12:00:00')", [m.id, vd]);
  await q("INSERT INTO lift_checks (tenant_id, lift_id, check_date, kind, result, items, inspector, checked_at) VALUES (?, ?, '2026-12-15', 'pre_open', 'fail', '[]', 'Lead', '2026-12-15 12:00:00')", [m.id, vd]);
  await q("INSERT INTO work_orders (tenant_id, title, priority, status, lift_id) VALUES (?, 'Bullwheel liner worn', 'high', 'open', ?)", [m.id, vd]);
  await q("INSERT INTO orders (tenant_id, status, channel, total_cents, tax_cents, created_at) VALUES (?, 'paid', 'window', 125000, 0, '2026-12-14 18:00:00')", [m.id]);
  return m;
}

async function patrolBusyDay() {
  const m = await mountain('Steep Bowl', { day: '2026-12-20', weather: { high: 19, low: 2, snow: 3, precip: 0.2, wind: 15, gust: 28, code: 85 } });
  await open(m, '2026-12-19', '2026-12-20');
  const upper = await trail(m, 'Upper Ridge'); const lower = await trail(m, 'Lower Meadow');
  const quad = await lift(m, 'Summit Quad', 50);
  const zeb = await person(m, 'Zebulon', 'Quixote', '1992-03-04');
  let first = true;
  const kase = (when, where, extra = {}) => { const tag = first; first = false; return q(`INSERT INTO incidents (tenant_id, occurred_at, location, category, severity, person_id, summary, narrative, trail_id, lift_id, seq, client_ref, status)
    VALUES (?, ?, ?, 'injury', 'serious', ?, ?, ?, ?, ?, ?, ?, 'open')`, [m.id, when, where, zeb, 'Zebulon Quixote, fractured femur', 'Patient Zebulon Quixote was found unconscious. Wife reached at 555-0199.', extra.trail || null, extra.lift || null, tag ? 4242 : null, tag ? 'PB-2026-0042' : null]); };
  for (const t of ['10:22:00', '11:05:00', '14:27:00']) await kase(`2026-12-19 ${t}`, 'Upper Ridge, skier left', { trail: upper });
  for (const t of ['10:22:00', '13:40:00']) await kase(`2026-12-19 ${t}`, 'Unload ramp', { lift: quad });
  await kase('2026-12-19 15:10:00', 'Lower Meadow', { trail: lower });
  await kase('2026-12-19 14:27:00', 'behind the Zeb cabin');
  await kase('2026-12-18 12:00:00', 'Upper Ridge', { trail: upper });
  await kase('2026-12-20 09:15:00', 'Upper Ridge', { trail: upper });
  return m;
}

/** A mountain with every kind of person: owner, manager, patrol director, school Director, a supervisor, a counter clerk. */
async function sendingMountain() {
  const m = await mountain('Sending Summit', { day: '2026-12-15' });
  await open(m, '2026-12-15', '2026-12-16', '2026-12-17');
  await lift(m, 'Main Chair', null);
  m.emails = { owner: m.ownerEmail }; m.ids = { owner: m.ownerId }; m.tokens = { owner: await login(m.slug, m.ownerEmail) };
  const make = async (key, role, extra) => {
    const email = `${key}@${m.slug}.test`;
    const id = (await q('INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)', [m.id, email, HASH, role])).insertId;
    m.ids[key] = id; m.emails[key] = email;
    if (extra) { const s = await staff(m, key, 'Person'); await q('UPDATE users SET staff_id = ? WHERE id = ?', [s, id]); await extra(s); }
    m.tokens[key] = await login(m.slug, email);
  };
  await make('manager', 'manager');
  await make('patrol', 'patrol', (s) => q("INSERT INTO patrol_members (tenant_id, staff_id, level, access_level) VALUES (?, ?, 'director', 'admin')", [m.id, s]));
  await make('school', 'instructor', (s) => q("INSERT INTO instructor_profiles (tenant_id, staff_id, school_access) VALUES (?, ?, 'director')", [m.id, s]));
  await make('instructor2', 'instructor', (s) => q("INSERT INTO instructor_profiles (tenant_id, staff_id, school_access) VALUES (?, ?, 'supervisor')", [m.id, s]));
  await make('plain', 'instructor', (s) => q("INSERT INTO instructor_profiles (tenant_id, staff_id, school_access) VALUES (?, ?, 'instructor')", [m.id, s]));
  await make('counter', 'counter');
  // The patrol director chose phone alerts only, and has a phone.
  await q("INSERT INTO brief_prefs (tenant_id, user_id, on_off, channel) VALUES (?, ?, 1, 'push')", [m.id, m.ids.patrol]);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(8).toString('hex')}`;
  await q('INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?)',
    [m.id, m.ids.patrol, endpoint, crypto.createHash('sha256').update(endpoint).digest('hex'), ecdh.getPublicKey().toString('base64url'), crypto.randomBytes(16).toString('base64url')]);
  return m;
}

const ALL = { powderSaturday, windDay, rainDay, slowTuesday, openingDay, understaffedSchool, failedCheck, patrolBusyDay };
module.exports = { setup, facts, brief, writeOnly, mountain, PATROL_SECRETS, ALL, sendingMountain, ...ALL };
