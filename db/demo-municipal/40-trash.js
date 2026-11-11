'use strict';

// The demo borough's bulk trash pickup (muni release 1, workstream "trash"), run by db/demo-municipal.js after the
// foundation has made the borough, its staff and its streets. Riverbend's settings are the usual ones: Monday
// collection, booking closes at noon Thursday, 40 stops a day, Small $15, Medium $25, Large $35, Metal free. It adds ten
// weeks of past Mondays (most stops picked up, a few not out, one not accepted) and next Monday's list of 22 stops.
// Every payment is "paid at Borough Hall" or stickers: the demo never calls Stripe. Every name, phone (555-01xx) and email
// (example.com) is made up. Running it twice adds nothing the second time.
const crypto = require('crypto');

const RULES = [
  'Put items at the curb by 6:00 AM on collection day, and not before 6:00 PM the night before.',
  'We take furniture, mattresses (wrapped in plastic), carpet (rolled, under 4 feet, tied), and large household items.',
  'We do not take tires, paint, chemicals, propane tanks, TVs, computers or other electronics, or building debris.',
  'Refrigerators, freezers and air conditioners need a sticker showing the refrigerant was removed.',
].join('\n');
const SIZES = [
  ['Small', 'One person can carry it: a chair, a small table, a rolled rug.', 1500, 5],
  ['Medium', 'Two people carry it: a loveseat, a dresser, a mattress or box spring.', 2500, 5],
  ['Large', 'A sofa, a sectional piece, a recliner, a large cabinet.', 3500, 3],
  ['Metal', 'Metal only: a bike, a grill without its propane tank, metal shelves or furniture, a water heater.', 0, 5],
];
const FIRST = ['Alex', 'Jordan', 'Morgan', 'Casey', 'Taylor', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Drew', 'Robin', 'Sam', 'Leslie', 'Dana', 'Pat', 'Chris', 'Terry', 'Kelly', 'Jesse', 'Shawn'];
const LAST = ['Alder', 'Brook', 'Carver', 'Dale', 'Easton', 'Fenwick', 'Garner', 'Hollis', 'Ivers', 'Jarrett', 'Keane', 'Lowell', 'Marsh', 'Norwood', 'Oakes', 'Pryor', 'Quarles', 'Rowe', 'Sutter', 'Thorne'];
const NOTES = [null, null, null, 'Old couch and two chairs', 'Mattress and box spring, wrapped', 'Dresser, drawers taped shut', 'Broken grill, tank removed', 'Rolled carpet, tied', 'Recliner by the garage', 'Kid’s bike and metal shelves', null, 'Behind the hedge, left side'];
// A 1 by 1 pixel JPEG for the demo's not-out photos (a real crew photo is kept as taken).
const PHOTO = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

const today = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

module.exports = async function trash(conn, tenantId, helpers = {}) {
  const say = (text) => { if (helpers.log) helpers.log(text); return { bulk_pickup: text }; };
  const q = async (sql, params) => (await conn.query(sql, params))[0];
  const [t] = await q('SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const tz = (t && t.timezone) || 'America/New_York';

  // Settings and sizes: made once, never changed on a second run (a manager may have changed them since).
  const made = await q("INSERT IGNORE INTO bulk_settings (tenant_id, online, collection_days, cutoff_days_before, cutoff_time, capacity, curb_by, pay_card, pay_stickers, office_name, rules_text, not_out_policy) VALUES (?, 1, '1', 4, '12:00:00', 40, '06:00:00', 1, 1, 'Borough Hall', ?, 'no_refund')", [tenantId, RULES]);
  if (made.affectedRows === 1 && !(await q('SELECT id FROM bulk_sizes WHERE tenant_id = ? LIMIT 1', [tenantId])).length) {
    for (const [i, [name, description, price, max]] of SIZES.entries()) await q('INSERT INTO bulk_sizes (tenant_id, name, description, price_cents, max_qty, sort) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, name, description, price, max, i + 1]);
  }
  const sizes = await q('SELECT id, name, price_cents FROM bulk_sizes WHERE tenant_id = ? AND active = 1 ORDER BY sort, id', [tenantId]);
  const streets = await q('SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [tenantId]);
  if (!sizes.length || !streets.length) return say('bulk pickup skipped: no streets or item sizes yet');
  if ((await q('SELECT id FROM bulk_bookings WHERE tenant_id = ? LIMIT 1', [tenantId])).length) return say('bulk pickup bookings already there, nothing added');

  // The same numbers every time for the same borough, so a rebuilt demo looks the same.
  let seed = Number(tenantId) * 7919 + 17;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const ref = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join('');
  const [crew] = await q("SELECT id FROM users WHERE tenant_id = ? AND role IN ('staff','manager','owner') AND active = 1 ORDER BY FIELD(role, 'staff', 'manager', 'owner'), id LIMIT 1", [tenantId]);
  const crewId = crew ? crew.id : null;

  const now = today(tz);
  let nextMonday = addDays(now, 1);
  while (weekday(nextMonday) !== 1) nextMonday = addDays(nextMonday, 1);
  const past = Array.from({ length: 10 }, (_, i) => addDays(nextMonday, -7 * (i + 1))).filter((d) => d < now).reverse();

  let people = 0;
  async function resident(streetId, house) {
    people += 1;
    const first = FIRST[(people * 7) % FIRST.length]; const last = LAST[(people * 11 + 3) % LAST.length];
    const phone = `610-555-01${String(people % 100).padStart(2, '0')}`;
    const texts = rand() < 0.6; const emails = rand() < 0.5;
    const r = await q('INSERT INTO residents (tenant_id, name, phone, email, street_id, house_number, texts_ok, emails_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, `${first} ${last}`, phone, `${first}.${last}${people}@example.com`.toLowerCase(), streetId, house, texts ? 1 : 0, emails ? 1 : 0]);
    return { id: r.insertId, texts, emails };
  }
  async function book(date, { past: done }) {
    const street = pick(streets);
    const house = String(10 + Math.floor(rand() * 890));
    const who = await resident(street.id, house);
    const lines = [];
    const kinds = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < kinds; k += 1) {
      const z = pick(sizes);
      if (!lines.some((l) => l.id === z.id)) lines.push({ ...z, qty: 1 + Math.floor(rand() * 2) });
    }
    const total = lines.reduce((n, l) => n + l.price_cents * l.qty, 0);
    const how = total === 0 ? 'free' : rand() < 0.45 ? 'stickers' : 'office';
    const payStatus = how === 'office' ? (done || rand() < 0.7 ? 'paid' : 'due') : 'not_needed';
    let outcome = null; let reason = null;
    if (done) { const r = rand(); outcome = r < 0.88 ? 'picked_up' : r < 0.97 ? 'not_out' : 'not_accepted'; if (outcome === 'not_accepted') reason = 'Paint cans and a tire in the pile'; }
    const tok = crypto.randomBytes(16).toString('hex');
    let b;
    for (let attempt = 0; ; attempt += 1) {
      try {
        b = await q(`INSERT INTO bulk_bookings (tenant_id, reference, view_token, collection_date, street_id, house_number, resident_id, items_note, source, status, pay_method, pay_status, total_cents, paid_cents, paid_at,
            texts_ok, emails_ok, reminded_at, outcome, outcome_reason, outcome_at, outcome_by, notified_at, notified_via, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, ref(), tok, date, street.id, house, who.id, pick(NOTES), rand() < 0.6 ? 'online' : 'staff', how, payStatus, total, payStatus === 'paid' ? total : 0, payStatus === 'paid' ? `${addDays(date, -5)} 15:00:00` : null,
          who.texts ? 1 : 0, who.emails ? 1 : 0, done && (who.texts || who.emails) ? `${addDays(date, -1)} 20:00:00` : null,
          outcome, reason, outcome ? `${date} ${String(7 + Math.floor(rand() * 6)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00` : null, outcome ? crewId : null,
          outcome && outcome !== 'picked_up' ? `${date} 14:00:00` : null, outcome && outcome !== 'picked_up' ? (who.texts ? 'text' : who.emails ? 'email' : 'none') : null, `${addDays(date, -6)} 14:00:00`]);
        break;
      } catch (err) { if (err.code !== 'ER_DUP_ENTRY' || attempt > 4) throw err; }
    }
    for (const l of lines) await q('INSERT INTO bulk_booking_items (tenant_id, booking_id, size_id, name, unit_cents, quantity) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, b.insertId, l.id, l.name, l.price_cents, l.qty]);
    if (outcome && outcome !== 'picked_up') {
      const p = await q("INSERT INTO bulk_photos (tenant_id, booking_id, mime, bytes, sha256, original, taken_at, taken_from, uploaded_by, uploaded_at) VALUES (?, ?, 'image/jpeg', ?, ?, ?, ?, 'phone', ?, ?)",
        [tenantId, b.insertId, PHOTO.length, crypto.createHash('sha256').update(PHOTO).digest('hex'), PHOTO, `${date} 09:00:00`, crewId, `${date} 09:00:00`]);
      await q('UPDATE bulk_bookings SET outcome_photo_id = ? WHERE tenant_id = ? AND id = ?', [p.insertId, tenantId, b.insertId]);
    }
  }

  let made2 = 0;
  for (const d of past) {
    const stops = 16 + Math.floor(rand() * 15);
    for (let i = 0; i < stops; i += 1) { await book(d, { past: true }); made2 += 1; }
  }
  for (let i = 0; i < 22; i += 1) await book(nextMonday, { past: false });
  return say(`${made2} past bulk pickup stops over ${past.length} Mondays, and 22 stops on ${nextMonday}`);
};
