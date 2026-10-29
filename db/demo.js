'use strict';

// Fills one mountain with realistic demo data by using the app's own API, so everything it creates is valid.
//   node db/demo.js <slug>
// Run db/reset.js first for a clean start; running this twice adds a second set of staff and customers.
// It uses a short-lived owner login that it removes when it finishes, so no password is needed.
// Everything is made up. Orders and punches are stamped with the current time.
// It talks to its own private copy of the app on 127.0.0.1, so staging's shared password (STAGING_GATE) must not stand
// in front of that copy: without this, every demo built on staging failed. Set before anything reads the settings.
delete process.env.STAGING_GATE;
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { createApp } = require('../src/app');

const slug = process.argv[2];
// A demo on a real mountain (the visitor picked it on the map): its lifts and runs from OpenStreetMap, its place and map.
// Everything else stays made up. Set by routes/sandbox.js; see src/lib/skiarea.js.
let AREA = null;
try { AREA = process.env.DEMO_AREA ? JSON.parse(process.env.DEMO_AREA) : null; } catch (_) { AREA = null; }
if (!slug || slug.startsWith('--')) { console.error('Usage: node db/demo.js <mountain-slug>'); process.exit(1); }

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const nowParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
const P = Object.fromEntries(nowParts.map((p) => [p.type, p.value]));
const today = `${P.year}-${P.month}-${P.day}`;
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return ymd(t); };
const hhmm = (h, m = 0) => `${pad(h)}:${pad(m)}`;
const nowMin = Number(P.hour) * 60 + Number(P.minute);
const ago = (min) => { const t = Math.max(nowMin - min, 0); return `${today}T${hhmm(Math.floor(t / 60), t % 60)}`; };

// A neutral silhouette, used where a season pass needs a photo of the holder.
const AVATAR = 'data:image/jpeg;base64,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';

let api; const failures = [];
let mountainName = 'the mountain';
const log = (s) => console.log(s);
async function call(method, path, body, token) {
  const r = await fetch(`${api}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  if (r.status >= 300) { const e = new Error(`${method} ${path} -> ${r.status} ${typeof json === 'string' ? json : JSON.stringify(json)}`.slice(0, 400)); e.status = r.status; throw e; }
  return json;
}
// A step that may fail without stopping the rest: it is listed at the end.
async function soft(what, fn) { try { return await fn(); } catch (e) { failures.push(`${what}: ${e.message}`); return null; } }

const FIRST = ['Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Elijah', 'Sophia', 'Lucas', 'Mia', 'Mason', 'Harper', 'Ethan', 'Amelia', 'Logan', 'Ella', 'Jack', 'Grace', 'Owen', 'Chloe', 'Caleb', 'Nora', 'Wyatt', 'Zoe', 'Henry', 'Layla', 'Isaac', 'Maya', 'Leo', 'Ruby', 'Dylan'];
const LAST = ['Anderson', 'Brooks', 'Carter', 'Diaz', 'Evans', 'Foster', 'Garcia', 'Hughes', 'Ingram', 'Jensen', 'Kim', 'Lopez', 'Mitchell', 'Nguyen', 'Ortiz', 'Patel', 'Quinn', 'Reyes', 'Singh', 'Turner', 'Underwood', 'Vasquez', 'Walker', 'Xu', 'Young', 'Zimmerman', 'Baker', 'Coleman', 'Dawson', 'Ellis'];
let nameAt = 0;
const nextName = () => { const i = nameAt++; return [FIRST[i % FIRST.length], LAST[(i * 7 + 3) % LAST.length]]; };
let emailN = 0;
const emailOf = (f, l) => `${f}.${l}${++emailN}@example.com`.toLowerCase();

/**
 * The lifts and runs the demo uses, and which of them play each part in the made-up day (the lift on hold, the run where a
 * child hurt a wrist). The sample mountain's own names, or a real mountain's from the map.
 */
function names() {
  const SAMPLE = {
    lifts: [['Summit Quad', 'open'], ['Ridge Triple', 'open'], ['Valley Double', 'hold'], ['Magic Carpet', 'open'], ['T-Bar', 'closed']],
    trails: [['Bunny Hill', 'green'], ['Easy Does It', 'green'], ['Apple Orchard', 'green'], ['Ridge Run', 'blue'], ['Switchback', 'blue'], ['Lower Meadow', 'blue'], ['Cliffhanger', 'black'], ['Gnar', 'black'], ['Widowmaker', 'double_black'], ['The Chute', 'double_black'], ['Terrain Park', 'park'], ['Jib Garden', 'park']],
    summit: 'Summit Quad', second: 'Ridge Triple', hold: 'Valley Double', small: 'Magic Carpet',
    bunny: 'Bunny Hill', green2: 'Easy Does It', blue1: 'Ridge Run', blue2: 'Lower Meadow', black1: 'Cliffhanger', black2: 'Gnar', park: 'Terrain Park',
    closed: ['Widowmaker', 'The Chute'], where: {},
  };
  if (!AREA || !(AREA.lifts || []).length || !(AREA.trails || []).length) return SAMPLE;
  const L = AREA.lifts.map((l) => l.name);
  const big = AREA.lifts.filter((l) => !l.small).map((l) => l.name);
  const small = AREA.lifts.filter((l) => l.small).map((l) => l.name);
  const summit = big[0] || L[0];
  const second = big[1] || L.find((n) => n !== summit) || summit;
  const hold = big[2] || L.find((n) => ![summit, second].includes(n)) || second;
  const smallOne = small[0] || L[L.length - 1];
  const status = (n, i) => (n === hold && L.length > 1 ? 'hold' : i === L.length - 1 && L.length > 4 && n !== smallOne ? 'closed' : 'open');
  const T = AREA.trails;
  const of = (d) => T.filter((x) => x.difficulty === d).map((x) => x.name);
  const any = T.map((x) => x.name);
  const pick = (list, i, fallback) => list[i] || fallback;
  const greens = of('green'); const blues = of('blue'); const blacks = [...of('black'), ...of('double_black')];
  const bunny = pick(greens, 0, any[0]);
  const hardest = [...of('double_black'), ...of('black')].slice(0, 2).filter(() => T.length > 6);
  const where = {};
  for (const x of T) if (x.lat !== null && x.lng !== null) where[x.name] = [x.lat, x.lng];
  return {
    lifts: L.map((n, i) => [n, status(n, i)]), trails: T.map((x) => [x.name, x.difficulty]),
    summit, second, hold, small: smallOne,
    bunny, green2: pick(greens, 1, bunny), blue1: pick(blues, 0, any[1] || bunny), blue2: pick(blues, 1, pick(blues, 0, any[2] || bunny)),
    black1: pick(blacks, 0, any[any.length - 1]), black2: pick(blacks, 1, pick(blacks, 0, any[any.length - 1])),
    park: pick(of('park'), 0, pick(blacks, 0, any[any.length - 1])), closed: hardest, where,
  };
}

async function main() {
  const [[t]] = await pool.query('SELECT id, name, require_mfa FROM tenants WHERE slug = ?', [slug]);
  if (!t) throw new Error(`No mountain with the slug "${slug}"`);
  mountainName = t.name;
  if (t.require_mfa) throw new Error('This mountain requires two-step sign-in, so the demo loader cannot sign in. Turn that off in Account while loading the demo, then back on.');

  const server = await new Promise((resolve) => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  api = `http://127.0.0.1:${server.address().port}`;
  const email = `demo-loader-${crypto.randomBytes(4).toString('hex')}@demo-loader.invalid`;
  const password = crypto.randomBytes(18).toString('base64url');
  const [u] = await pool.query("INSERT INTO users (tenant_id, email, password_hash, role) VALUES (?, ?, ?, 'owner')", [t.id, email, await bcrypt.hash(password, 10)]);
  let token;
  try {
    token = (await call('POST', '/auth/login', { tenant: slug, email, password })).token;
    await load(token);
  } finally {
    await pool.query('DELETE FROM users WHERE id = ?', [u.insertId]);
    await new Promise((resolve) => server.close(resolve));
  }
}

async function load(o) {
  const C = (m, p, b) => call(m, p, b, o);

  // ---------------------------------------------------------------- the mountain
  log('Mountain');
  const place = AREA ? [AREA.city, AREA.state].filter(Boolean).join(', ') : '1200 Summit Road, Spring Mountain, PA';
  await soft('settings', () => C('PUT', '/tenant/profile', { address: place, phone: '(610) 555-0142', receipt_footer: `Thank you for skiing ${mountainName}. Ski safe.` }));
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    const weekend = [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
    await soft(`day ${d}`, () => C('PUT', `/schedule/days/${d}`, { status: i === 5 ? 'closed' : 'open', open_time: weekend ? '08:30' : '09:00', close_time: weekend ? '16:30' : '21:00', notes: i === 0 ? 'Fresh groomers, 4 inches overnight' : i === 5 ? 'Closed for high wind' : weekend ? 'Weekend hours' : 'Night skiing until 9' }));
  }
  const N = names();
  for (const [name, status] of N.lifts) await soft(`lift ${name}`, () => C('POST', '/schedule/lifts', { name, status }));
  for (const [name, difficulty] of N.trails) await soft(`trail ${name}`, () => C('POST', '/schedule/trails', { name, difficulty, status: N.closed.includes(name) ? 'closed' : 'open' }));

  // ---------------------------------------------------------------- products
  log('Products and prices');
  const prod = {};
  const addProduct = async (key, body, tiers) => {
    const r = await soft(`product ${body.name}`, () => C('POST', '/products', body));
    if (!r) return;
    prod[key] = r.id;
    if (tiers) await soft(`tiers ${body.name}`, () => C('PUT', `/products/${r.id}/tiers`, { tiers }));
  };
  await addProduct('day', { kind: 'day_ticket', name: 'All-day lift ticket', base_price_cents: 7500 }, [{ tier: 'youth', price_cents: 5500 }, { tier: 'child', price_cents: 3500 }, { tier: 'senior', price_cents: 5500 }, { tier: 'military', price_cents: 5500 }]);
  await addProduct('half', { kind: 'day_ticket', name: 'Half-day ticket (afternoon)', base_price_cents: 5500 }, [{ tier: 'youth', price_cents: 4000 }, { tier: 'child', price_cents: 2500 }]);
  await addProduct('night', { kind: 'day_ticket', name: 'Night ticket (after 4 pm)', base_price_cents: 3500 });
  await addProduct('two', { kind: 'multi_day', name: '2-day lift ticket', base_price_cents: 13500, valid_days: 2 });
  await addProduct('season', { kind: 'season_pass', name: 'Season pass', base_price_cents: 54900, valid_days: 200 }, [{ tier: 'youth', price_cents: 36900 }, { tier: 'child', price_cents: 19900 }, { tier: 'senior', price_cents: 39900 }]);
  await addProduct('punch', { kind: 'punch_card', name: '5-visit card', base_price_cents: 29500, uses: 5, valid_days: 120 });
  await addProduct('lesson', { kind: 'lesson', name: 'Group lesson (2 hours)', base_price_cents: 8500 });
  await addProduct('private', { kind: 'lesson', name: 'Private lesson (1 hour)', base_price_cents: 14000 });
  await addProduct('rental', { kind: 'rental', name: 'Ski package rental (skis, boots, poles)', base_price_cents: 4500 }, [{ tier: 'child', price_cents: 3000 }]);
  await addProduct('boardrental', { kind: 'rental', name: 'Snowboard package rental', base_price_cents: 5000 });
  await addProduct('helmet', { kind: 'rental', name: 'Helmet rental', base_price_cents: 1200 });
  await addProduct('program', { kind: 'program', name: 'Junior race team season', base_price_cents: 62000 });
  for (const [code, pct] of [['WELCOME10', 10], ['SENIORS15', 15], ['FRIENDS20', 20]]) await soft(`promo ${code}`, () => C('POST', '/pricing/promos', { code, percent_off: pct }));
  await soft('tax', () => C('POST', '/tax-rules', { name: AREA ? `Sales tax (sample: set your own rate)` : 'PA sales tax', applies_to: 'all', rate_percent: 6 }));

  // ---------------------------------------------------------------- staff
  log('Staff');
  const certs = {};
  for (const name of ['Outdoor Emergency Care (OEC)', 'CPR and first aid', 'PSIA Level 1', 'PSIA Level 2', 'Lift operator training', 'Snowmaker', 'Food handler']) {
    const r = await soft(`cert ${name}`, () => C('POST', '/workforce/certifications', { name })); if (r) certs[name] = r.id;
  }
  const pos = {};
  for (const [key, name, department, ratio] of [['lift', 'Lift operator', 'lifts', 200], ['rent', 'Rental technician', 'rentals', 120], ['inst', 'Ski instructor', 'ski_school', 40], ['patrol', 'Patroller', 'patrol', 250], ['window', 'Ticket window', 'guest_services', 300], ['groom', 'Groomer', 'grooming', 500], ['food', 'Cafe cook', 'food', 150]]) {
    const r = await soft(`position ${name}`, () => C('POST', '/workforce/positions', { name, department, visits_per_staff: ratio })); if (r) pos[key] = r.id;
  }
  const people = [];
  const hire = async (posKey, dept, certNames = []) => {
    const [f, l] = nextName();
    const s = await soft(`staff ${f} ${l}`, () => C('POST', '/workforce/staff', { person: { first_name: f, last_name: l, email: emailOf(f, l), phone: `610555${String(1000 + people.length * 37).slice(0, 4)}` }, status: 'active', department: dept }));
    if (!s) return null;
    const rec = { id: s.id, name: `${f} ${l}`, first: f, last: l, pos: posKey };
    for (const cn of certNames) if (certs[cn]) await soft(`cert ${rec.name}`, () => C('PUT', `/workforce/staff/${s.id}/certifications`, { certification_id: certs[cn], expires_on: `${Number(today.slice(0, 4)) + 1}-06-30` }));
    people.push(rec); return rec;
  };
  for (let i = 0; i < 3; i++) await hire('lift', 'lifts', ['Lift operator training']);
  for (let i = 0; i < 2; i++) await hire('rent', 'rentals');
  for (let i = 0; i < 3; i++) await hire('inst', 'ski_school', ['PSIA Level 1', i === 0 ? 'PSIA Level 2' : 'CPR and first aid']);
  for (let i = 0; i < 4; i++) await hire('patrol', 'patrol', ['Outdoor Emergency Care (OEC)', 'CPR and first aid']);
  for (let i = 0; i < 2; i++) await hire('window', 'guest_services');
  await hire('groom', 'grooming', ['Snowmaker']);
  await hire('food', 'food', ['Food handler']);
  const by = (k) => people.filter((p) => p.pos === k);

  // shifts for the next 7 days, then publish
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    for (const [k, start, end, n] of [['lift', '08:00', '16:30', 3], ['rent', '08:00', '16:00', 2], ['patrol', '08:00', '16:30', 3], ['window', '08:00', '16:00', 2], ['groom', '17:00', '23:00', 1]]) {
      const crew = by(k);
      for (let j = 0; j < n; j++) {
        const s = crew.length ? crew[(i + j) % crew.length] : null;
        await soft(`shift ${k}`, () => C('POST', '/workforce/shifts', { position_id: pos[k], staff_id: s ? s.id : undefined, starts_at: `${d}T${start}`, ends_at: `${d}T${end}` }));
      }
    }
    if (i === 2) await soft('open shift', () => C('POST', '/workforce/shifts', { position_id: pos.lift, starts_at: `${d}T12:00`, ends_at: `${d}T20:00` }));
  }
  await soft('publish', () => C('POST', '/workforce/shifts/publish', { from: today, to: addDays(today, 6) }));

  // ---------------------------------------------------------------- customers
  log('Customers');
  const guests = [];
  const mkGuest = async (age, extra = {}) => {
    const [f, l] = nextName();
    const dob = `${Number(today.slice(0, 4)) - age}-0${1 + (guests.length % 9)}-${pad(3 + (guests.length * 5) % 25)}`;
    const body = { first_name: f, last_name: l, email: age >= 18 ? emailOf(f, l) : undefined, phone: age >= 18 ? `484555${String(2000 + guests.length * 13).slice(0, 4)}` : undefined, date_of_birth: dob, sex: guests.length % 2 ? 'male' : 'female', city: AREA && AREA.city ? AREA.city : 'Phoenixville', region: AREA ? AREA.state : 'PA', postal_code: AREA ? undefined : '19460', discipline: guests.length % 3 ? 'ski' : 'snowboard', ability_level: ['beginner', 'intermediate', 'advanced'][guests.length % 3], ...extra };
    const r = await soft(`guest ${f}`, () => C('POST', '/people', body));
    if (!r) return null;
    const g = { id: r.id, name: `${f} ${l}`, first: f, last: l, age, dob, sex: body.sex, email: body.email };
    await soft(`waiver ${f}`, () => C('POST', `/people/${r.id}/waivers`, {}));
    guests.push(g); return g;
  };
  for (const age of [34, 41, 29, 52, 38, 45, 31, 27, 63, 58, 36, 44, 33, 49, 70, 24, 39, 47, 35, 28]) await mkGuest(age);
  for (const age of [8, 10, 12, 14, 9, 11, 15, 7]) await mkGuest(age);

  // ---------------------------------------------------------------- rentals
  log('Rental fleet');
  const items = [];
  const fleet = [['SK', 'ski', ['Atomic', 'Rossignol', 'Salomon'], ['120', '135', '150', '160', '170']], ['SB', 'snowboard', ['Burton', 'Ride'], ['135', '145', '152', '158']], ['BT', 'boot', ['Nordica', 'Lange'], ['22', '24', '26', '27', '28']], ['HL', 'helmet', ['Smith'], ['S', 'M', 'L']], ['PL', 'pole', ['Leki'], ['100', '110', '120']]];
  let n = 0;
  for (const [pre, category, brands, sizes] of fleet) {
    for (let i = 0; i < 6; i++) {
      const r = await soft(`item ${pre}`, () => C('POST', '/rentals/items', { sku: `${pre}-${pad(++n)}`, category, brand: brands[i % brands.length], size: sizes[i % sizes.length], serial_no: `${pre}${String(1000 + n * 7)}`, tier: i % 3 === 2 && ['ski', 'snowboard'].includes(category) ? 'performance' : 'standard', location: `Rack ${'ABC'[i % 3]}`, grade: ['A', 'B', 'B', 'C'][i % 4] }));
      if (r) items.push({ id: r.id, category });
    }
  }
  const free = (cat) => items.filter((i) => i.category === cat && !i.used);
  const take = (cat) => { const x = free(cat)[0]; if (x) x.used = true; return x; };

  // ---------------------------------------------------------------- lessons and programs
  log('Lessons and programs');
  const sessions = [];
  for (let i = 0; i < 6; i++) {
    const d = addDays(today, i);
    for (const [hh, prodKey, cap] of [[10, 'lesson', 6], [13, 'lesson', 6], [11, 'private', 1]]) {
      const inst = by('inst')[(i + hh) % Math.max(by('inst').length, 1)];
      // the nine levels and ages (ski school round 2); a private is a private
      const fit = prodKey === 'private' ? { format: 'private' } : hh === 10 ? { level_min: 1, level_max: 3, age_min: 5, age_max: 12, meeting_place: 'Magic carpet' } : { level_min: 4, level_max: 6, meeting_place: 'Ski school flag' };
      const r = await soft('lesson session', () => C('POST', '/skischool/sessions', { product_id: prod[prodKey], starts_at: `${d}T${hhmm(hh)}`, ends_at: `${d}T${hhmm(hh + (prodKey === 'private' ? 1 : 2))}`, capacity: cap, instructor_id: inst ? inst.id : undefined, ...fit }));
      if (r) sessions.push({ id: r.id, cap, day: i });
    }
  }
  const kids = guests.filter((g) => g.age < 16);
  const adults = guests.filter((g) => g.age >= 18);
  for (let i = 0; i < Math.min(sessions.length, 8); i++) {
    for (const g of (i % 2 ? kids : adults.slice(0, 5)).slice(i % 3, (i % 3) + Math.min(3, sessions[i].cap))) await soft('booking', () => C('POST', `/skischool/sessions/${sessions[i].id}/bookings`, { person_id: g.id }));
  }
  const team = await soft('race team', () => C('POST', '/programs', { name: 'Junior race team', kind: 'race_team', season: '2026-27', capacity: 12, price_cents: 62000 }));
  const club = await soft('club', () => C('POST', '/programs', { name: 'Saturday ski club (ages 7 to 12)', kind: 'club', season: '2026-27', capacity: 20, price_cents: 28000 }));
  for (const [pr, group] of [[team, kids.slice(2, 7)], [club, kids.slice(0, 6)]]) {
    if (!pr) continue;
    for (const g of group) await soft('enrollment', () => C('POST', `/programs/${pr.id}/enrollments`, { person_id: g.id }));
    for (let w = 0; w < 4; w++) await soft('program session', () => C('POST', `/programs/${pr.id}/sessions`, { starts_at: `${addDays(today, 3 + w * 7)}T16:00`, ends_at: `${addDays(today, 3 + w * 7)}T18:00` }));
  }

  // ---------------------------------------------------------------- sales
  log('Sales');
  const sold = [];
  const person = (g) => ({ person_id: g.id });
  const sale = async (g, lines, tender = 'card', extra = {}) => {
    const q = await soft('quote', () => C('POST', '/checkout/quote', { lines, promo_code: extra.promo_code }));
    const total = q && (q.total_cents ?? (q.totals && q.totals.total_cents));
    if (!total) return null;
    const pay = tender === 'cash' ? { tender: 'cash', amount_cents: total, tendered_cents: Math.ceil(total / 2000) * 2000 } : { tender: 'card', amount_cents: total, card_brand: ['visa', 'mastercard', 'amex'][sold.length % 3], card_last4: String(1000 + sold.length * 77).slice(0, 4), auth_code: `A${100000 + sold.length}` };
    const r = await soft(`sale ${g ? g.name : 'walk-in'}`, () => C('POST', '/checkout', { customer: g ? person(g) : { details: { first_name: 'Walk', last_name: 'In', email: 'walkin@example.com', date_of_birth: '1988-04-12', sex: 'female' } }, lines, payments: [pay], ...extra }));
    if (r) sold.push(r);
    return r;
  };
  for (let i = 0; i < 12; i++) await sale(adults[i % adults.length], [{ type: 'ticket', product_id: prod.day, quantity: 1 + (i % 3 === 0 ? 1 : 0) }], i % 4 === 0 ? 'cash' : 'card');
  for (let i = 0; i < 4; i++) await sale(adults[(i + 3) % adults.length], [{ type: 'ticket', product_id: prod.half }, { type: 'rental', product_id: prod.rental, items: [take('ski') && { rental_item_id: items.find((x) => x.used && x.category === 'ski').id }].filter(Boolean) }].slice(0, 1), 'card');
  for (const g of adults.slice(8, 11)) { await soft('photo', () => C('PUT', `/people/${g.id}/photo`, { photo: AVATAR })); await sale(g, [{ type: 'ticket', product_id: prod.season, tier: g.age >= 62 ? 'senior' : 'adult' }], 'card'); }
  for (const g of adults.slice(0, 2)) await sale(g, [{ type: 'ticket', product_id: prod.punch }], 'card');
  for (let i = 0; i < 3; i++) await sale(adults[i + 4], [{ type: 'gift_card', amount_cents: [5000, 7500, 10000][i], recipient_name: 'Alex', message: 'Happy holidays' }], 'card');
  // A board fitted at the window: the renter signs that their details are true before it goes out (a demo signature).
  const SIGN = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const fit5 = { weight_lb: 165, height_in: 69, stance: 'regular', skier_type: '2' };
  const rentalSale = await sale(adults[5], [{ type: 'rental', product_id: prod.boardrental, items: free('snowboard').slice(0, 1).map((x) => ({ rental_item_id: x.id })), fit: fit5, signoff: { signer_name: adults[5].name, signer_relation: 'self', signature: SIGN, details: fit5 } }, { type: 'rental', product_id: prod.helmet, items: free('helmet').slice(0, 1).map((x) => ({ rental_item_id: x.id })) }], 'card');
  if (!rentalSale) failures.push('rental sale did not complete');
  // Paid rentals waiting to be fitted: sold at the window with no gear chosen, they show in Rentals, Counter.
  for (const g of adults.slice(11, 15)) await sale(g, [{ type: 'ticket', product_id: prod.day }, { type: 'rental', product_id: prod.rental }], 'card');

  // rental shop settings, sizing profile, reservations and a service entry (the binding chart is left empty on purpose: a shop enters its own)
  await soft('rental settings', () => C('PUT', '/rentals/settings', { late_fee_cents_per_day: 1500, late_grace_minutes: 60, default_deposit_cents: 0, service_every_uses: 20 }));
  await soft('rental profile', () => C('PUT', `/rentals/profiles/${adults[5].id}`, { skier_type: 'II', boot_sole_mm: 305, helmet_size: 'M', notes: 'Prefers a shorter ski' }));
  for (const [idx, d, cat, qty] of [[6, 1, 'ski', 2], [7, 2, 'snowboard', 1]]) {
    await soft('rental reservation', () => C('POST', '/rentals/reservations', { person_id: adults[idx].id, pickup_on: addDays(today, d), days: 2, notes: 'Booked by phone', lines: [{ category: cat, quantity: qty }] }));
  }
  const tuneItem = items.find((x) => x.category === 'ski' && !x.used);
  if (tuneItem) await soft('service log', () => C('POST', `/rentals/items/${tuneItem.id}/service`, { kind: 'tune', notes: 'Base grind and wax', done_by: 'Shop tech' }));

  // refunds on two earlier orders
  for (const r of sold.slice(1, 3)) await soft('refund', () => C('POST', `/orders/${r.id || r.order_id}/refund`, { reason: 'weather' }));

  // scans at the gate for a few of the tickets sold
  const codes = [];
  for (const r of sold.slice(3, 9)) {
    const detail = await soft('order detail', () => C('GET', `/orders/${r.id || r.order_id}`));
    if (detail && detail.tickets) for (const tk of detail.tickets) codes.push(tk.code);
  }
  for (const code of codes.slice(0, 8)) await soft('scan', () => C('POST', '/tickets/scan', { code }));

  // RFID cards (the guided gate tour taps these by typing their serials) and two gate devices
  // the card's ticket is a fresh sale that has never been scanned, so the first tap in the tour is a clean "go"
  const cardSale = await sale(adults[1], [{ type: 'ticket', product_id: prod.day }], 'card');
  const cardOrder = cardSale && await soft('order detail', () => C('GET', `/orders/${cardSale.id || cardSale.order_id}`));
  const cardCode = cardOrder && cardOrder.tickets && cardOrder.tickets[0] ? cardOrder.tickets[0].code : null;
  if (cardCode) await soft('rfid card', () => C('POST', '/access/cards/assign', { ticket_code: cardCode, uid: '04A1B2C3D4E5F6', label: '1001' }));
  if (codes[1]) {
    const lost = await soft('rfid card', () => C('POST', '/access/cards/assign', { ticket_code: codes[1], uid: '04C0FFEE123456', label: '1002' }));
    if (lost) await soft('rfid lost', () => C('POST', `/access/cards/${lost.id}/lost`));
  }
  for (const [name, location, kind] of [[`${N.summit} gate 1`.slice(0, 100), N.summit, 'turnstile'], ['Base lodge handheld', 'Base lodge', 'handheld']]) await soft(`gate device ${name}`, () => C('POST', '/access/devices', { name, location, kind }));

  // ---------------------------------------------------------------- patrol
  log('Patrol');
  const levels = ['director', 'leader', 'senior', 'patroller'];
  const patrollers = by('patrol');
  for (let i = 0; i < patrollers.length; i++) await soft('roster', () => C('POST', '/patrol/team', { staff_id: patrollers[i].id, level: levels[i % levels.length], callsign: `Patrol ${i + 1}` }));
  for (const [name, kind] of [['Summit hut', 'hut'], ['Base aid room', 'aid_room'], [`${N.blue2} zone`.slice(0, 100), 'zone']]) await soft(`station ${name}`, () => C('POST', '/patrol/stations', { name, kind }));
  for (const [name, kind, serial] of [['AED summit hut', 'aed', 'A-1001'], ['AED base aid room', 'aed', 'A-1002'], ['Oxygen kit 1', 'oxygen', 'O-2001'], ['Toboggan 1', 'toboggan', 'T-3001'], ['Toboggan 2', 'toboggan', 'T-3002'], ['Trauma bag A', 'trauma_bag', 'B-4001']]) await soft(`equipment ${name}`, () => C('POST', '/patrol/equipment', { name, kind, serial }));
  const cases = [
    { cat: 'injury', sev: 'minor', where: N.green2, sum: 'Child fell, sore wrist', patient: [kids[0], 'Wrist pain after a fall', 'wrist_hand', 'right', 'sprain_strain', { kind: 'ice', description: 'Ice pack applied' }, 'treated_released'], minutesAgo: 240 },
    { cat: 'injury', sev: 'moderate', where: N.blue1, sum: 'Skier caught an edge, knee injury', patient: [adults[3], 'Knee pain and swelling', 'knee', 'left', 'sprain_strain', { kind: 'splint', description: 'Knee immobilized' }, 'transported_ambulance'], minutesAgo: 180 },
    { cat: 'collision', sev: 'moderate', where: N.blue2, sum: 'Two skiers collided at the merge', patient: [adults[6], 'Shoulder pain', 'shoulder', 'right', 'dislocation', { kind: 'spinal_motion_restriction', description: 'Collar and board, precaution' }, 'transported_ambulance'], minutesAgo: 120 },
    { cat: 'medical', sev: 'minor', where: 'Summit hut', sum: 'Lightheaded after a hard run', patient: [adults[9], 'Dizziness', 'other', 'na', 'illness', { kind: 'warming', description: 'Warm drink, rested in hut' }, 'treated_released'], minutesAgo: 90 },
    { cat: 'injury', sev: 'serious', where: N.park, sum: 'Rider landed hard, possible fracture', patient: [adults[11], 'Ankle pain, unable to bear weight', 'ankle_foot', 'left', 'fracture', { kind: 'splint', description: 'Vacuum splint' }, 'transported_ambulance'], minutesAgo: 45 },
    { cat: 'injury', sev: 'minor', where: N.bunny, sum: 'Beginner fall, bruised hip', patient: [kids[3], 'Sore hip', 'hip', 'right', 'contusion', { kind: 'ice', description: 'Ice pack' }, 'treated_released'], minutesAgo: 20 },
  ];
  for (const c of cases) {
    const at = N.where[c.where]; // on a real mountain, a pin on the run itself
    const inc = await soft(`case ${c.sum}`, () => C('POST', '/patrol/incidents', { occurred_at: ago(c.minutesAgo), location: c.where, category: c.cat, severity: c.sev, summary: c.sum, ...(at ? { gps_lat: at[0], gps_lng: at[1] } : {}) }));
    if (!inc) continue;
    const [g, complaint, region, side, type, treat, dispo] = c.patient;
    const pat = await soft('patient', () => C('POST', `/patrol/incidents/${inc.id}/patients`, { first_name: g.first, last_name: g.last, date_of_birth: g.dob, sex: g.sex }));
    if (!pat) continue;
    const base = `/patrol/incidents/${inc.id}/patients/${pat.id}`;
    await soft('vitals', () => C('POST', `${base}/vitals`, { pulse: 82 + (inc.id % 20), resp: 16, bp_sys: 124, bp_dia: 80, spo2: 98, gcs: 15, pain: 4 + (inc.id % 4), avpu: 'alert' }));
    await soft('injury', () => C('POST', `${base}/injuries`, { body_region: region, side, injury_type: type }));
    await soft('treatment', () => C('POST', `${base}/treatments`, treat));
    await soft('patient notes', () => C('PATCH', base, { chief_complaint: complaint, disposition: dispo, assessment: 'Alert and oriented, stable. Treated per protocol.', allergies: 'None known' }));
    await soft('event', () => C('POST', `/patrol/incidents/${inc.id}/events`, { kind: 'on_scene' }));
    if (patrollers[0]) await soft('responder', () => C('POST', `/patrol/incidents/${inc.id}/responders`, { staff_id: patrollers[c.minutesAgo % patrollers.length].id }));
    await soft('narrative', () => C('PATCH', `/patrol/incidents/${inc.id}`, { narrative: `Called to ${c.where}. ${c.sum}. Patient assessed, treated and handed off per protocol.` }));
  }

  // ---------------------------------------------------------------- time clock and kiosk
  log('Time clock and kiosk');
  const dev = await soft('kiosk tablet', () => C('POST', '/kiosk-admin/devices', { name: 'Employee entrance' }));
  const pins = [];
  for (const [i, p] of people.entries()) {
    const r = await soft(`pin ${p.name}`, () => C('PUT', `/kiosk-admin/people/${p.id}/pin`, { pin: String((i * 7919 + 4829) % 9000 + 1000) }));
    if (r) pins.push([p.name, r.pin]);
  }
  // a morning's clock-ins, a few already out
  for (const [i, p] of people.slice(0, 10).entries()) {
    await soft('clock in', () => C('POST', '/workforce/time/clock-in', { staff_id: p.id }));
    if (i % 3 === 2) await soft('clock out', () => C('POST', '/workforce/time/clock-out', { staff_id: p.id }));
  }
  await soft('kiosk settings', () => C('PUT', '/kiosk-admin/settings', { photos: false, photo_days: 30 }));

  // ---------------------------------------------------------------- terrain park
  log('Terrain park');
  const main = await soft('park area', () => C('POST', '/park/areas', { name: 'Main park', level: 'medium' }));
  const mini = await soft('park area', () => C('POST', '/park/areas', { name: 'Mini park', level: 'learn' }));
  const parkFeatures = [
    ['Butter box 1', 'butter_box', 's', '8 ft', main], ['Butter box 2', 'butter_box', 'm', '12 ft', main], ['Down rail 1', 'rail_down', 'm', '14 ft', main],
    ['Rainbow rail', 'rail_rainbow', 'm', '12 ft', main], ['Flat rail 1', 'rail_flat', 's', '10 ft', mini], ['Kinked rail', 'rail_kinked', 'l', '16 ft', main],
    ['A-frame box', 'a_frame', 'm', '10 ft', main], ['Tabletop', 'tabletop', 'l', '30 ft', main], ['Step-up', 'step_up', 'l', '22 ft', main],
    ['Rollers', 'roller', 's', null, mini], ['Mini hip', 'hip', 's', '12 ft', mini], ['Barrel', 'barrel', 's', '8 ft', mini],
  ];
  // Near the middle of the real mountain when there is one, else a made-up spot; set the map's opening view from the Terrain park screen
  const baseLat = AREA ? AREA.lat : 40.2689; const baseLng = AREA ? AREA.lng : -75.4417;
  for (const [i, [name, kind, size, dimensions, area]] of parkFeatures.entries()) {
    const f = await soft(`park feature ${name}`, () => C('POST', '/park/features', { name, kind, size, dimensions }));
    if (!f) continue;
    const lat = baseLat + (i % 4) * 0.0004 - (i >= 8 ? 0.0012 : 0);
    const lng = baseLng + Math.floor(i / 4) * 0.0005;
    await soft(`place ${name}`, () => C('PUT', `/park/placements/${today}/${f.id}`, { lat, lng, area_id: area ? area.id : null }));
    if (i % 3 !== 2) await soft(`inspect ${name}`, () => C('POST', `/park/features/${f.id}/inspections`, { result: 'ok' }));
  }

  // ---------------------------------------------------------------- mountain operations
  log('Grooming, maintenance and mountain operations');
  const opsFleet = [['Groomer 1', 'groomer', 'PistenBully 600', 2140.5], ['Groomer 2', 'groomer', 'PistenBully 400', 3810], ['Snowmobile 1', 'snowmobile', 'Ski-Doo Skandic', 410], ['Patrol UTV', 'utv', 'Polaris Ranger', 695], ['Shop truck', 'truck', 'Ford F-250', 5200]];
  const assetIds = {};
  for (const [name, kind, make_model, hours] of opsFleet) {
    const a = await soft(`asset ${name}`, () => C('POST', '/ops/assets', { name, kind, make_model, hours }));
    if (a) assetIds[name] = a.id;
  }
  const liftList = (await soft('lift list', () => C('GET', '/schedule/lifts?limit=100')) || { data: [] }).data;
  const trailList = (await soft('trail list', () => C('GET', '/schedule/trails?limit=100')) || { data: [] }).data;
  await soft('groom plan', () => C('POST', '/ops/groom/plan/fill', { plan_date: today, shift: 'night', all: true, asset_id: assetIds['Groomer 1'] || null }));
  const plan = (await soft('plan list', () => C('GET', `/ops/groom/plan?date=${today}&shift=night`)) || { data: [] }).data;
  for (const [i, row] of plan.entries()) {
    if (i < 4) { await soft('plan start', () => C('POST', `/ops/groom/plan/${row.id}/start`)); await soft('plan finish', () => C('POST', `/ops/groom/plan/${row.id}/finish`, { machine_hours: 1.5 + i * 0.5, fuel_gal: 9 + i * 2 })); }
    else if (i === 4) await soft('plan start', () => C('POST', `/ops/groom/plan/${row.id}/start`));
  }
  await soft('snow reading', () => C('POST', '/ops/snow', { base_in: 38, new_snow_in: 4, surface: 'packed_powder', quality: 'good', note: 'Light snow overnight' }));
  await soft('weather', () => C('POST', '/ops/weather', { place: 'Base', temp_f: 24, wind_mph: 8, gust_mph: 15, wind_dir: 'NW', sky: 'partly', precip_in: 0 }));
  await soft('weather', () => C('POST', '/ops/weather', { place: 'Summit', temp_f: 17, wind_mph: 22, gust_mph: 34, wind_dir: 'NW', sky: 'snow', precip_in: 0.1 }));
  const lowTrail = trailList.find((x) => x.name === N.bunny);
  if (lowTrail) {
    const run = await soft('snowmaking', () => C('POST', '/ops/snowmaking', { trail_id: lowTrail.id, guns: 8, temp_f: 21 }));
    if (run) await soft('snowmaking stop', () => C('POST', `/ops/snowmaking/${run.id}/stop`, { water_gal: 120000 }));
  }
  const wo = await soft('work order', () => C('POST', '/ops/work-orders', { title: 'Replace left track on Groomer 2', priority: 'high', asset_id: assetIds['Groomer 2'] || null, description: 'Track is cracking at the third cleat.' }));
  await soft('work order', () => C('POST', '/ops/work-orders', { title: `Re-grease ${N.small} bearings`.slice(0, 200), priority: 'normal', lift_id: (liftList.find((l) => l.name === N.small) || {}).id || null }));
  if (wo) await soft('work order note', () => C('POST', `/ops/work-orders/${wo.id}/notes`, { body: 'Track ordered, arrives Thursday' }));
  await soft('pm', () => C('POST', '/ops/pm', { name: 'Groomer oil change', asset_id: assetIds['Groomer 1'], interval_hours: 250, interval_days: 180 }));
  await soft('pm', () => C('POST', '/ops/pm', { name: 'Annual rope inspection', lift_id: (liftList.find((l) => l.name === N.summit) || {}).id, interval_days: 365 }));
  await soft('pm', () => C('POST', '/ops/pm', { name: 'Snowmobile belt check', asset_id: assetIds['Snowmobile 1'], interval_hours: 100 }));
  const meta = await soft('ops meta', () => C('GET', '/ops/meta'));
  if (meta) {
    for (const lift of liftList) {
      const failIt = lift.name === N.hold;
      const items = meta.lift_checklist.map((i) => ({ key: i.key, result: failIt && i.key === 'estop' ? 'fail' : 'pass', note: failIt && i.key === 'estop' ? 'North terminal stop is slow to trip' : null }));
      await soft(`inspect ${lift.name}`, () => C('POST', '/ops/lift-checks', { lift_id: lift.id, items }));
    }
  }
  const tl = liftList.find((l) => l.name === N.second);
  if (tl) await soft('downtime', () => C('POST', '/ops/downtime', { lift_id: tl.id, started_at: `${today} 08:10`, ended_at: `${today} 08:55`, reason: 'wind', note: 'Gusts over 35 at the top' }));
  await soft('handoff', () => C('POST', '/ops/handoffs', { dept: 'grooming', shift: 'night', body: `${N.black1} and ${N.black2} still need a second pass. Groomer 2 is down for the track.` }));
  await soft('handoff', () => C('POST', '/ops/handoffs', { dept: 'lifts', shift: 'day', body: `${N.hold} stays on hold until the north stop is fixed and re-inspected.` }));

  log('Documents and instructor availability');
  // ---- documents: a few categories with who may see them, and short files that can be searched
  const docRoles = {
    'Safety plans': [{ role: 'patrol', can_add: true }, { role: 'staff', can_add: false }, { role: 'instructor', can_add: false }, { role: 'counter', can_add: false }],
    'HR forms': [{ role: 'staff', can_add: false }, { role: 'patrol', can_add: false }, { role: 'instructor', can_add: false }, { role: 'counter', can_add: false }],
    'Lift operations manuals': [{ role: 'staff', can_add: false }],
  };
  const docIds = {};
  for (const [name, roles] of Object.entries(docRoles)) {
    const cat = await soft(`category ${name}`, () => C('POST', '/documents/categories', { name, description: name === 'Safety plans' ? 'Emergency plans and rules everyone on snow should know' : name === 'HR forms' ? 'Time off, expenses and onboarding forms' : 'Procedures for opening, running and closing lifts' }));
    if (cat) { docIds[name] = cat.id; await soft(`roles ${name}`, () => C('PUT', `/documents/categories/${cat.id}/roles`, { roles })); }
  }
  const upload = async (id, name, text, note) => {
    const r = await fetch(`${api}/api/v1/documents/documents/${id}/file`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-filename': name, ...(note ? { 'x-note': encodeURIComponent(note) } : {}), authorization: `Bearer ${o}` }, body: Buffer.from(text) });
    if (!r.ok) throw new Error(`upload ${name} -> ${r.status}`);
  };
  const demoDocs = [
    ['Safety plans', 'Lift evacuation plan', 'If a lift stops for more than ten minutes, the lift operator radios patrol dispatch. Patrol sets up the evacuation team at the nearest tower. Guests are lowered with the rescue rope one chair at a time. Muster point for all staff is the base lodge flagpole.', 'Updated rescue rope procedure for the new season', true],
    ['Safety plans', 'Emergency action plan', 'Call 911 for any life threatening injury. Patrol dispatch sends the nearest toboggan team. The helicopter landing zone is the lower parking lot. The incident commander is the patrol director.', null, true],
    ['HR forms', 'Time off request', 'Submit time off requests at least two weeks ahead. Holiday weekends need manager approval. Season pass benefits continue during approved leave.', null, false],
    ['Lift operations manuals', 'Daily lift opening checklist', 'Inspect the haul rope, check the emergency stop at both terminals, test the backup engine, walk the loading area and confirm the radios work before opening the lift to guests.', 'Added the radio check', true],
  ];
  for (const [cat, title, text, note, ack] of demoDocs) {
    if (!docIds[cat]) continue;
    const d = await soft(`document ${title}`, () => C('POST', '/documents/documents', { category_id: docIds[cat], title, description: `${cat}`, require_ack: ack }));
    if (!d) continue;
    await soft(`file ${title}`, () => upload(d.id, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`, text));
    if (note) await soft(`file v2 ${title}`, () => upload(d.id, `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`, `${text} Reviewed by the safety committee.`, note));
  }

  // ---- instructor availability: the page is switched on, and the instructors list themselves with open days
  await soft('availability on', () => C('PUT', '/availability/settings', { public: true }));
  const bios = ['Teaches first timers and families. Patient, loud and a big fan of hot chocolate breaks.', 'Former race coach. Loves helping intermediate skiers carve their first clean turns.', 'Snowboard and ski, all ages. Specialises in confidence on steeper terrain.'];
  const picks = people.filter((p) => p.pos === 'inst');
  for (const [i, ins] of picks.entries()) {
    await soft(`profile ${ins.name}`, () => C('PUT', '/availability/profile', { staff_id: ins.id, is_public: true, display_name: `${ins.first} ${ins.last[0]}.`, bio: bios[i % bios.length], disciplines: i === 1 ? ['ski'] : ['ski', 'snowboard'], levels: i === 2 ? ['intermediate', 'advanced'] : ['beginner', 'intermediate'] }));
    const days = []; for (let k = 1; k <= 14; k++) if ((k + i) % 3 !== 0) days.push(addDays(today, k));
    await soft(`open times ${ins.name}`, () => C('POST', '/availability/windows', { staff_id: ins.id, dates: days, start_time: i === 1 ? '13:00' : '09:00', end_time: i === 1 ? '16:30' : '12:00', note: i === 0 ? 'Mornings only' : null }));
  }

  log('');
  log(`Done. Added ${people.length} staff, ${guests.length} customers, ${items.length} rental items, ${sessions.length} lesson sessions, ${sold.length} orders, ${cases.length} patrol cases.`);
  if (pins.length) log(`Kiosk PINs (demo only): ${pins.slice(0, 5).map(([n, p]) => `${n} ${p}`).join(', ')} … (set a new one in the Kiosk tab at any time)`);
  if (dev) log(`Kiosk tablet "Employee entrance" is added; make a new pairing code in the Kiosk tab when you are ready to pair a tablet.`);
  if (failures.length) { log(`\n${failures.length} step(s) did not go through (the rest loaded fine):`); for (const f of failures.slice(0, 25)) log(`  - ${f}`); if (failures.length > 25) log(`  … and ${failures.length - 25} more`); }
}

main().then(() => pool.end()).catch((err) => { console.error(`Demo loader stopped: ${err.message}`); pool.end().then(() => process.exit(1)); });
