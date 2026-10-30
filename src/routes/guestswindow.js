'use strict';
// Guests, round 2, Track WINDOW: the welcome back and the 20-second window. router is mounted at /guests (staff);
// publicRouter under /public (nothing public here). tick() and daily() have nothing to do yet.
//   GET    /guests/people/:id/welcome?day=     the welcome-back card (visits, pass, birthday, family, rewards, badges, a line)
//   GET    /guests/people/:id/history          the whole family's history for the customer record
//   POST   /guests/people/:id/goodwill         a manager gives a goodwill credit (a reward, kind goodwill)
//   GET    /guests/find?q=                     scan to find: an order, ticket, lesson, card, reward, license or a name
//   GET    /guests/group-prices                each product's group price; PUT and DELETE /guests/group-prices/:productId (managers)
//   POST   /guests/roster                      a pasted roster or CSV (names, ages) read into people with a guest type
//   POST   /guests/tickets/:code/change-day    move a dated ticket to another day at the window (check: true to price it)
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, addDays, seasonFor } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { money, dayText } = require('../lib/format');
const { COLS } = require('../lib/customers');
const { familyOf } = require('../lib/family');
const GV = require('../lib/guestvisits');
const RW = require('../lib/rewards');
const loyalty = require('../lib/loyalty');
const GS = require('../lib/guestsettings');
const GT = require('../lib/guesttypes');
const WIN = require('../lib/windowsale');
const levels = require('../lib/levels');
const { unitPrice } = require('../lib/pricing');
const { loadRules, applyTax } = require('../lib/tax');
const SH = require('../lib/shopsale');
const cardrefund = require('../lib/cardrefund');
const mailer = require('../lib/mailer');

const router = express.Router();
const publicRouter = express.Router();
const sellers = ['counter', 'manager'];
const front = ['counter', 'manager', 'staff', 'instructor'];
const isMgr = (req) => ['owner', 'manager'].includes(req.auth.role);
const d10 = (d) => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);
const WEEKDAY = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${d}T12:00:00Z`));
const SHORT = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));
const ageOn = (dob, day) => (dob ? GT.ageOn(d10(dob), day) : null);
const tzOf = async (db, tenantId) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

const { birthdayThisWeek } = WIN;
/** A reward's choices in words, with money the app's way: "a free All-day lift ticket or a $25.00 credit". */
const rewardWords = (r, names = {}) => RW.words(r, names).replace(/a (\d+\.\d\d) credit/, (_, d) => `a ${money(Math.round(Number(d) * 100))} credit`);

/** The people in this person's family: themselves first, then their guardians, dependents and household. */
async function familyIds(db, tenantId, personId, day) {
  const f = await familyOf(db, tenantId, personId, day);
  const seen = new Set([personId]);
  const out = [];
  for (const [rel, list] of [['guardian', f.guardians], ['child', f.dependents], ['family', f.household]]) {
    for (const p of list) { if (!seen.has(p.id)) { seen.add(p.id); out.push({ id: p.id, relation: rel }); } }
  }
  return out;
}

/** Recent lessons, level and usual rental sizes for a list of people (never their allergies or medical notes). */
async function familyBits(db, tenantId, ids, day) {
  if (!ids.length) return new Map();
  const [ppl, lessons, gear] = await Promise.all([
    rows(db, 'SELECT id, first_name, last_name, date_of_birth, ski_level, snowboard_level, boot_size FROM people WHERE tenant_id = ? AND id IN (?)', [tenantId, ids]),
    rows(db, `SELECT b.person_id, b.status, b.level, s.starts_at, s.discipline, pr.name FROM lesson_bookings b
      JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
      WHERE b.tenant_id = ? AND b.person_id IN (?) AND b.status IN ('booked','attended') AND DATE(s.starts_at) >= ? ORDER BY s.starts_at DESC LIMIT 60`, [tenantId, ids, `${seasonFor(day).slice(0, 4)}-08-01`]),
    rows(db, `SELECT c.person_id AS renter, ci.person_id AS wearer, c.id AS contract_id, ri.category, ri.size FROM rental_contracts c
      JOIN rental_contract_items ci ON ci.tenant_id = c.tenant_id AND ci.contract_id = c.id JOIN rental_items ri ON ri.tenant_id = ci.tenant_id AND ri.id = ci.rental_item_id
      WHERE c.tenant_id = ? AND (c.person_id IN (?) OR ci.person_id IN (?)) ORDER BY c.id DESC LIMIT 80`, [tenantId, ids, ids]),
  ]);
  const out = new Map();
  for (const p of ppl) {
    const mine = lessons.filter((l) => l.person_id === p.id);
    const done = mine.filter((l) => l.status === 'attended' || d10(l.starts_at) < day);
    const last = mine.find((l) => d10(l.starts_at) <= day) || null;
    const next = [...mine].reverse().find((l) => d10(l.starts_at) > day) || null;
    const lvl = last && last.level ? Number(last.level) : (Number(p.ski_level) || Number(p.snowboard_level) || null);
    const myGear = gear.filter((g) => (g.wearer || g.renter) === p.id);
    const lastContract = myGear.length ? myGear[0].contract_id : null;
    const sizes = myGear.filter((g) => g.contract_id === lastContract && ['ski', 'snowboard', 'boot'].includes(g.category) && g.size)
      .map((g) => (g.category === 'boot' ? `boots ${g.size}` : `${g.size}${/^\d+$/.test(g.size) ? ' cm' : ''} ${g.category === 'ski' ? 'skis' : 'snowboard'}`));
    out.set(p.id, {
      id: p.id, first_name: p.first_name, last_name: p.last_name, age: ageOn(p.date_of_birth, day),
      lessons_this_season: done.length,
      last_lesson: last ? { name: last.name, day: d10(last.starts_at), discipline: last.discipline, level: last.level ? Number(last.level) : null, nth: done.length } : null,
      next_lesson: next ? { name: next.name, day: d10(next.starts_at) } : null,
      level: lvl, level_name: lvl ? levels.name(lvl, last && last.discipline === 'snowboard' ? 'snowboard' : 'ski') : null,
      rental: sizes.length ? sizes.join(', ') : (p.boot_size ? `boots ${p.boot_size}` : null),
    });
  }
  return out;
}

/** One plain sentence about a family member for the card, or null when there is nothing to say. */
function memberLine(m) {
  const bits = [];
  if (m.last_lesson) {
    const n = m.last_lesson.nth;
    bits.push(`${m.first_name}'s ${n >= 1 && n <= 10 ? `${ORDINAL[n - 1]} lesson` : 'last lesson'}: ${SHORT(m.last_lesson.day)}${m.last_lesson.level ? ` (Level ${m.last_lesson.level})` : ''}.`);
  } else if (m.next_lesson) bits.push(`${m.first_name} has a lesson ${SHORT(m.next_lesson.day)}.`);
  if (m.rental) bits.push(`Usual rental: ${m.rental}.`);
  return bits.length ? bits.join(' ') : null;
}

/** The welcome-back card. Fast (a handful of queries) and never anything medical. */
async function welcome(db, tenantId, personId, day) {
  const tz = await tzOf(db, tenantId);
  const p = await one(db, 'SELECT id, first_name, last_name, date_of_birth, (photo IS NOT NULL) AS has_photo FROM people WHERE tenant_id = ? AND id = ? AND anonymised_at IS NULL', [tenantId, personId]);
  if (!p) return null;
  const fam = await familyIds(db, tenantId, personId, day);
  const ids = [personId, ...fam.map((f) => f.id)];
  const [visits, pass, bits, rewards, badges, names] = await Promise.all([
    GV.summary(db, tenantId, personId, day, tz),
    one(db, `SELECT t.code, t.valid_from, t.valid_to, t.status, pr.name AS product FROM tickets t JOIN products pr ON pr.tenant_id = t.tenant_id AND pr.id = t.product_id
      WHERE t.tenant_id = ? AND t.person_id = ? AND pr.kind = 'season_pass' AND t.status <> 'void' AND t.valid_to >= ? ORDER BY t.valid_from LIMIT 1`, [tenantId, personId, day]),
    familyBits(db, tenantId, ids, day),
    RW.usable(db, tenantId, ids, day),
    Promise.resolve(loyalty.badgesFor(db, tenantId, personId, day)).catch(() => []),
    rows(db, 'SELECT id, name FROM products WHERE tenant_id = ? AND kind IN (\'day_ticket\',\'multi_day\')', [tenantId]),
  ]);
  const productNames = Object.fromEntries(names.map((x) => [x.id, x.name]));
  const bday = birthdayThisWeek(p.date_of_birth, day);
  const family = [personId, ...fam.map((f) => f.id)].map((id) => {
    const m = bits.get(id);
    if (!m) return null;
    const rel = id === personId ? 'self' : fam.find((f) => f.id === id).relation;
    return { ...m, relation: rel, line: memberLine(m) };
  }).filter(Boolean);
  // family birthdays this week too (a child's birthday is worth a word to the parent)
  const dobs = await rows(db, 'SELECT id, date_of_birth FROM people WHERE tenant_id = ? AND id IN (?)', [tenantId, ids]);
  for (const f of family) { const d = dobs.find((x) => x.id === f.id); f.birthday_this_week = birthdayThisWeek(d && d.date_of_birth, day); }
  const first = p.first_name;
  const passOut = pass ? { product: pass.product, valid_from: d10(pass.valid_from), valid_to: d10(pass.valid_to), active: pass.status === 'active' && d10(pass.valid_from) <= day } : null;
  let line;
  if (bday && bday.today) line = `Happy birthday, ${first}!`;
  else if (!visits.total && !passOut) line = `Welcome, ${first}. Is this your first time with us?`;
  else if (visits.this_season === 0) line = `Welcome back, ${first}. Good to see you again this season.`;
  else line = `Welcome back, ${first}. Good to see you again.`;
  if (bday && !bday.today) line += ` Happy early birthday!`;
  return {
    person: { id: p.id, first_name: p.first_name, last_name: p.last_name, age: ageOn(p.date_of_birth, day), has_photo: Boolean(p.has_photo) },
    day,
    visits: { ...visits, visit_today: visits.last_day === day ? visits.this_season : visits.this_season + 1, here_today: visits.last_day === day },
    pass: passOut,
    birthday_this_week: bday,
    family,
    rewards: rewards.map((r) => ({ id: r.id, code: r.code, kind: r.kind, reason: r.reason, options: r.options, valid_to: d10(r.valid_to), person_id: r.person_id,
      person: (bits.get(r.person_id) || {}).first_name || null, words: rewardWords(r, productNames) })),
    badges: Array.isArray(badges) ? badges : [],
    line,
  };
}

router.get('/people/:id/welcome', requireRole(...front), async (req, res) => {
  const { tenantId } = req.auth;
  const day = req.query.day ? String(req.query.day) : todayIn(await tzOf(pool, tenantId));
  if (!dateStr.safeParse(day).success) throw bad('day must be YYYY-MM-DD');
  const out = await welcome(pool, tenantId, paramId(req), day);
  if (!out) throw notFound('Person');
  res.json(out);
});

// ---------------------------------------------------------------- the customer record: the whole family's history
router.get('/people/:id/history', requireRole(...front), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const tz = await tzOf(pool, tenantId);
  const day = todayIn(tz);
  const me = await one(pool, 'SELECT id, first_name, last_name FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!me) throw notFound('Person');
  const fam = await familyIds(pool, tenantId, id, day);
  const ids = [id, ...fam.map((f) => f.id)];
  const people = await rows(pool, 'SELECT id, first_name, last_name, date_of_birth FROM people WHERE tenant_id = ? AND id IN (?)', [tenantId, ids]);
  const [tickets, lessons, rentals, programs, rewards] = await Promise.all([
    rows(pool, `SELECT t.id, t.code, t.person_id, t.valid_from, t.valid_to, t.status, pr.name AS product, pr.kind, i.order_id, i.tier,
        (SELECT COUNT(*) FROM scans s WHERE s.tenant_id = t.tenant_id AND s.ticket_id = t.id AND s.result = 'ok') AS scans
      FROM tickets t JOIN products pr ON pr.tenant_id = t.tenant_id AND pr.id = t.product_id LEFT JOIN order_items i ON i.tenant_id = t.tenant_id AND i.id = t.order_item_id
      WHERE t.tenant_id = ? AND t.person_id IN (?) ORDER BY t.valid_from DESC, t.id DESC LIMIT 200`, [tenantId, ids]),
    rows(pool, `SELECT b.id, b.person_id, b.status, b.level, s.starts_at, s.discipline, pr.name FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE b.tenant_id = ? AND b.person_id IN (?) ORDER BY s.starts_at DESC LIMIT 100`, [tenantId, ids]),
    rows(pool, `SELECT c.id, c.person_id, c.status, c.kind, c.valid_on, c.due_at, c.checked_out_at FROM rental_contracts c WHERE c.tenant_id = ? AND c.person_id IN (?) ORDER BY c.id DESC LIMIT 100`, [tenantId, ids]),
    rows(pool, `SELECT e.id, e.person_id, e.status, p.name, p.season FROM program_enrollments e JOIN programs p ON p.tenant_id = e.tenant_id AND p.id = e.program_id
      WHERE e.tenant_id = ? AND e.person_id IN (?) ORDER BY e.id DESC LIMIT 100`, [tenantId, ids]),
    rows(pool, 'SELECT * FROM guest_rewards WHERE tenant_id = ? AND person_id IN (?) ORDER BY id DESC LIMIT 50', [tenantId, ids]),
  ]);
  const visits = {};
  for (const pid of ids) visits[pid] = await GV.summary(pool, tenantId, pid, day, tz);
  const name = Object.fromEntries(people.map((p) => [p.id, p.first_name]));
  const tag = (x) => ({ ...x, who: name[x.person_id] || null });
  res.json({
    members: ids.map((pid) => { const p = people.find((x) => x.id === pid); return p ? { id: pid, first_name: p.first_name, last_name: p.last_name, age: ageOn(p.date_of_birth, day), relation: pid === id ? 'self' : fam.find((f) => f.id === pid).relation, visits: visits[pid] } : null; }).filter(Boolean),
    tickets: tickets.filter((t) => t.kind !== 'season_pass').map((t) => tag({ ...t, scans: Number(t.scans), valid_from: d10(t.valid_from), valid_to: d10(t.valid_to) })),
    passes: tickets.filter((t) => t.kind === 'season_pass').map((t) => tag({ ...t, scans: Number(t.scans), valid_from: d10(t.valid_from), valid_to: d10(t.valid_to) })),
    lessons: lessons.map((l) => tag({ ...l, day: d10(l.starts_at), level_name: l.level ? levels.name(l.level, l.discipline === 'snowboard' ? 'snowboard' : 'ski') : null })),
    rentals: rentals.map(tag), programs: programs.map(tag),
    rewards: rewards.map((r) => tag({ ...RW.shape(r), valid_from: d10(r.valid_from), valid_to: d10(r.valid_to), words: rewardWords(r) })),
    can_give_goodwill: isMgr(req),
  });
});

// ---------------------------------------------------------------- a goodwill credit (managers)
const goodwillBody = z.object({
  reason: z.string().trim().min(3).max(200),
  credit_cents: z.number().int().min(100).max(100000).optional(),
  free_ticket_product_id: z.number().int().positive().optional(),
  percent: z.number().int().min(5).max(100).optional(),
  valid_days: z.number().int().min(1).max(730).default(365),
}).refine((b) => b.credit_cents || b.free_ticket_product_id || b.percent, 'Choose what the goodwill is: a credit, a free ticket or a percent off');
router.post('/people/:id/goodwill', requireRole('manager'), validate(goodwillBody), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const b = req.body;
  const day = todayIn(await tzOf(pool, tenantId));
  const out = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id]))) throw notFound('Person');
    if (b.free_ticket_product_id && !(await one(conn, "SELECT id FROM products WHERE tenant_id = ? AND id = ? AND kind IN ('day_ticket','multi_day')", [tenantId, b.free_ticket_product_id]))) throw bad('Choose a day ticket for the free ticket');
    const r = await RW.issue(conn, tenantId, { personId: id, kind: 'goodwill', reason: b.reason, validFrom: day, validTo: addDays(day, b.valid_days),
      options: { ...(b.credit_cents ? { credit: { cents: b.credit_cents } } : {}), ...(b.free_ticket_product_id ? { free_ticket: { product_id: b.free_ticket_product_id } } : {}), ...(b.percent ? { percent: { percent: b.percent } } : {}) } });
    await audit(conn, req, 'goodwill', 'guest_rewards', r.id, { person_id: id, reason: b.reason, credit_cents: b.credit_cents || null, free_ticket: b.free_ticket_product_id || null, percent: b.percent || null });
    return r;
  });
  res.status(201).json({ ...RW.shape(out), valid_from: d10(out.valid_from), valid_to: d10(out.valid_to), words: rewardWords(out) });
});

// ---------------------------------------------------------------- scan to find
/** What tells two people with the same name apart: age, a parent or guardian, the last visit. */
async function tellApart(db, tenantId, list, day, tz) {
  if (!list.length) return list;
  const ids = list.map((p) => p.id);
  const g = await rows(db, `SELECT l.member_id, a.first_name, a.last_name FROM person_links l JOIN people a ON a.tenant_id = l.tenant_id AND a.id = l.adult_id
    WHERE l.tenant_id = ? AND l.member_id IN (?) AND l.relation = 'guardian' ORDER BY l.created_at`, [tenantId, ids]);
  const last = await rows(db, `SELECT t.person_id, MAX(s.scanned_at) AS at FROM scans s JOIN tickets t ON t.tenant_id = s.tenant_id AND t.id = s.ticket_id
    WHERE s.tenant_id = ? AND t.person_id IN (?) AND s.result = 'ok' GROUP BY t.person_id`, [tenantId, ids]);
  return list.map((p) => {
    const gd = g.find((x) => x.member_id === p.id);
    const lv = last.find((x) => x.person_id === p.id);
    let lastDay = null;
    if (lv && lv.at) lastDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(`${String(lv.at).replace(' ', 'T')}Z`));
    return { ...p, age: ageOn(p.date_of_birth, day), guardian: gd ? `${gd.first_name} ${gd.last_name}` : null, last_visit: lastDay };
  });
}

const peopleBy = async (ids, tenantId) => (ids.length ? rows(pool, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND id IN (?) AND anonymised_at IS NULL ORDER BY last_name, first_name LIMIT 20`, [tenantId, [...new Set(ids)]]) : []);

router.get('/find', requireRole(...sellers), async (req, res) => {
  const { tenantId } = req.auth;
  const q = String(Array.isArray(req.query.q) ? req.query.q[0] : req.query.q || '').slice(0, 3000);
  const tz = await tzOf(pool, tenantId);
  const day = todayIn(tz);
  const c = WIN.classify(q);
  const out = { kind: c.kind, title: null, people: [], order_id: null, reward: null, license: null, ticket: null };
  let ids = [];
  if (c.kind === 'license') {
    // the name and date of birth only: the license number is never read out, kept or logged
    out.license = c.license;
    const L = c.license;
    const byDob = L.date_of_birth ? await rows(pool, 'SELECT id FROM people WHERE tenant_id = ? AND last_name = ? AND date_of_birth = ? LIMIT 10', [tenantId, L.last_name, L.date_of_birth]) : [];
    ids = byDob.length ? byDob.map((x) => x.id) : (await rows(pool, 'SELECT id FROM people WHERE tenant_id = ? AND first_name = ? AND last_name = ? LIMIT 10', [tenantId, L.first_name, L.last_name])).map((x) => x.id);
    out.title = ids.length ? `${L.first_name} ${L.last_name}` : `${L.first_name} ${L.last_name}, not on file yet`;
  } else if (c.kind === 'order' || c.kind === 'shop') {
    const o = c.kind === 'order' ? await one(pool, 'SELECT id, person_id FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, c.order_id])
      : await one(pool, 'SELECT o.id, o.person_id FROM shop_orders so JOIN orders o ON o.tenant_id = so.tenant_id AND o.id = so.order_id WHERE so.tenant_id = ? AND so.reference = ?', [tenantId, c.reference]);
    if (o) {
      out.order_id = o.id; out.title = `Order #${o.id}`;
      ids = [o.person_id, ...(await rows(pool, 'SELECT DISTINCT person_id FROM order_items WHERE tenant_id = ? AND order_id = ? AND person_id IS NOT NULL', [tenantId, o.id])).map((x) => x.person_id)].filter(Boolean);
    }
  } else if (c.kind === 'lesson') {
    const b = await one(pool, 'SELECT b.person_id, s.starts_at FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id WHERE b.tenant_id = ? AND b.id = ?', [tenantId, c.booking_id]);
    if (b) { ids = [b.person_id]; out.title = `Lesson L${c.booking_id}, ${dayText(d10(b.starts_at))}`; }
  } else if (c.kind === 'ticket') {
    const t = await one(pool, 'SELECT t.code, t.person_id, t.status, t.valid_from, t.valid_to, pr.name, i.order_id FROM tickets t JOIN products pr ON pr.tenant_id = t.tenant_id AND pr.id = t.product_id LEFT JOIN order_items i ON i.tenant_id = t.tenant_id AND i.id = t.order_item_id WHERE t.tenant_id = ? AND t.code = ?', [tenantId, c.code]);
    if (t) {
      out.ticket = { code: t.code, product: t.name, status: t.status, valid_from: d10(t.valid_from), valid_to: d10(t.valid_to) };
      out.order_id = t.order_id || null; out.title = `${t.name}, ${dayText(d10(t.valid_from))}`;
      if (t.person_id) ids = [t.person_id];
    }
  } else if (c.kind === 'reward') {
    const r = await RW.byCode(pool, tenantId, c.code);
    if (r) { out.reward = { id: r.id, code: r.code, kind: r.kind, status: r.status, options: r.options, valid_from: d10(r.valid_from), valid_to: d10(r.valid_to), words: rewardWords(r) }; ids = [r.person_id]; out.title = `Reward ${r.code}`; }
  } else if (c.kind === 'card') {
    const { card } = await require('../lib/access').findCard(pool, tenantId, c.raw);
    if (card && card.ticket_id) {
      const t = await one(pool, 'SELECT t.person_id, pr.name FROM tickets t JOIN products pr ON pr.tenant_id = t.tenant_id AND pr.id = t.product_id WHERE t.tenant_id = ? AND t.id = ?', [tenantId, card.ticket_id]);
      if (t && t.person_id) ids = [t.person_id];
      out.title = `Card ${card.label || card.uid}${t ? `: ${t.name}` : ''}`;
    } else if (card) out.title = `Card ${card.label || card.uid}: no ticket on it`;
  }
  if (!ids.length && !out.title && c.kind !== 'license') {
    // not a code we know: a name, phone or email (what the Customers search does)
    out.kind = 'text';
    const s = q.trim().slice(0, 100);
    const digits = s.replace(/\D/g, '');
    if (s.length >= 2) {
      let where; let params;
      if (s.includes('@')) { where = 'email LIKE ?'; params = [`${s.replace(/[%_]/g, '')}%`]; } else if (digits.length >= 4 && digits.length >= s.replace(/[\s()+.-]/g, '').length) { where = 'phone_key LIKE ?'; params = [`%${digits.slice(-10)}`]; } else {
        const tokens = s.split(/\s+/).filter(Boolean).slice(0, 3).map((x) => x.replace(/[%_]/g, ''));
        where = tokens.map(() => '(first_name LIKE ? OR last_name LIKE ?)').join(' AND '); params = tokens.flatMap((x) => [`${x}%`, `${x}%`]);
      }
      ids = (await rows(pool, `SELECT id FROM people WHERE tenant_id = ? AND anonymised_at IS NULL AND ${where} ORDER BY last_name, first_name LIMIT 10`, [tenantId, ...params])).map((x) => x.id);
    }
  }
  const ppl = await peopleBy(ids, tenantId);
  // the buyer of an order first, then the rest
  const order = new Map(ids.map((x, i) => [x, i]));
  ppl.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  out.people = await tellApart(pool, tenantId, ppl.map((p) => ({ ...p, has_photo: Boolean(p.has_photo) })), day, tz);
  res.json(out);
});

// ---------------------------------------------------------------- group prices and rosters
router.get('/group-prices', requireRole(...sellers), async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT g.product_id, g.min_people, g.price_cents, p.name FROM group_prices g JOIN products p ON p.tenant_id = g.tenant_id AND p.id = g.product_id WHERE g.tenant_id = ? ORDER BY p.name', [req.auth.tenantId]) });
});
router.put('/group-prices/:productId', requireRole('manager'), validate(z.object({ min_people: z.number().int().min(2).max(500), price_cents: z.number().int().min(0).max(1_000_000) })), async (req, res) => {
  const { tenantId } = req.auth;
  const pid = Number(req.params.productId);
  const p = await one(pool, "SELECT id, kind FROM products WHERE tenant_id = ? AND id = ?", [tenantId, pid]);
  if (!p) throw notFound('Product');
  if (!['day_ticket', 'multi_day', 'punch_card', 'voucher'].includes(p.kind)) throw bad('Group prices are for day tickets, multi-day tickets, punch cards and vouchers');
  await tx(async (conn) => {
    await conn.query('INSERT INTO group_prices (tenant_id, product_id, min_people, price_cents, updated_by) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE min_people = VALUES(min_people), price_cents = VALUES(price_cents), updated_by = VALUES(updated_by)', [tenantId, pid, req.body.min_people, req.body.price_cents, req.auth.userId]);
    await audit(conn, req, 'group_price', 'products', pid, req.body);
  });
  res.json({ product_id: pid, ...req.body });
});
router.delete('/group-prices/:productId', requireRole('manager'), async (req, res) => {
  const pid = Number(req.params.productId);
  await tx(async (conn) => {
    await conn.query('DELETE FROM group_prices WHERE tenant_id = ? AND product_id = ?', [req.auth.tenantId, pid]);
    await audit(conn, req, 'group_price_off', 'products', pid, {});
  });
  res.json({ ok: true });
});

/**
 * A roster pasted or uploaded as CSV: one person a line, "First Last, age" (or "Last, First, age", or a header row with
 * name and age columns). Each gets a guest type from their age (the mountain's guest types). Nothing is saved here.
 */
function readRoster(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 500);
  if (!lines.length) return [];
  const cells = (l) => l.split(/[,\t;]/).map((c) => c.trim().replace(/^"|"$/g, ''));
  let head = cells(lines[0]).map((c) => c.toLowerCase());
  const hasHead = head.some((c) => /name|age/.test(c)) && !head.some((c) => /^\d+$/.test(c));
  if (!hasHead) head = null;
  const out = [];
  for (const l of hasHead ? lines.slice(1) : lines) {
    const c = cells(l);
    let first = ''; let last = ''; let age = null;
    if (head) {
      const at = (re) => head.findIndex((x) => re.test(x));
      const fi = at(/first/); const li = at(/last|surname/); const ni = at(/^name|full/); const ai = at(/age/);
      if (fi >= 0) first = c[fi] || ''; if (li >= 0) last = c[li] || '';
      if (!first && ni >= 0) [first, ...last] = String(c[ni] || '').split(/\s+/), last = Array.isArray(last) ? last.join(' ') : last;
      if (ai >= 0 && /^\d{1,3}$/.test(c[ai] || '')) age = Number(c[ai]);
    } else {
      const nums = c.filter((x) => /^\d{1,3}$/.test(x));
      const words = c.filter((x) => x && !/^\d{1,3}$/.test(x));
      if (nums.length) age = Number(nums[0]);
      if (words.length >= 2) { last = words[0]; first = words[1]; if (words[0].includes(' ')) { [first, ...last] = words[0].split(/\s+/); last = last.join(' '); } } else if (words.length === 1) { const ws = words[0].split(/\s+/); first = ws[0]; last = ws.slice(1).join(' '); }
    }
    first = String(first).trim().slice(0, 100); last = String(last).trim().slice(0, 100);
    if (!first) continue;
    out.push({ first_name: first, last_name: last || '(group)', age: age !== null && age <= 120 ? age : null });
  }
  return out;
}
router.post('/roster', requireRole(...sellers), validate(z.object({ text: z.string().max(60000) })), async (req, res) => {
  const types = await GT.list(pool, req.auth.tenantId);
  const people = readRoster(req.body.text).map((p) => ({ ...p, tier: p.age === null ? null : GT.forAge(types, p.age) }));
  res.json({ people, count: people.length });
});

// ---------------------------------------------------------------- change day at the window
const changeBody = z.object({
  date: dateStr,
  check: z.boolean().optional(),
  over_limit_reason: z.string().trim().max(300).optional(),
  // when the new day costs more: how the difference is paid (as at checkout)
  payment: z.object({ tender: z.enum(['cash', 'card', 'other']), card_last4: z.string().regex(/^\d{4}$/).optional(), reference: z.string().max(100).optional(), terminal_payment_id: z.number().int().positive().optional() }).optional(),
});
/** The counter's refund limit: what has gone back on this order already plus this, against the mountain's limit. */
async function refundAllowed(conn, req, orderId, cents) {
  if (isMgr(req)) return;
  const s = await GS.get(conn, req.auth.tenantId);
  if (!s.counter_refund_limit_cents) throw forbidden('Only a manager can give money back. Ask a manager.');
  if (cents <= 0) return;
  const before = await one(conn, 'SELECT COALESCE(SUM(amount_cents), 0) AS c FROM order_refunds WHERE tenant_id = ? AND order_id = ?', [req.auth.tenantId, orderId]);
  if (!s.counter_refund_limit_cents) throw forbidden('Only a manager can give money back. Ask a manager.');
  if (Number(before.c) + cents > s.counter_refund_limit_cents) throw forbidden(`Counter staff can give back up to ${money(s.counter_refund_limit_cents)} on an order. Ask a manager.`);
}

router.post('/tickets/:code/change-day', requireRole(...sellers), validate(changeBody), async (req, res) => {
  const { tenantId } = req.auth;
  const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const b = req.body;
  let refundRow = null;
  const out = await tx(async (conn) => {
    const tenant = await one(conn, 'SELECT id, name, timezone, online_daily_limit FROM tenants WHERE id = ?', [tenantId]);
    const today = todayIn(tenant.timezone);
    const t = await one(conn, `SELECT t.id, t.code, t.product_id, t.valid_from, t.valid_to, t.status, t.person_id, i.id AS item_id, i.order_id, i.unit_price_cents, i.discount_cents, i.tier,
        p.name, p.kind, p.valid_days FROM tickets t JOIN order_items i ON i.tenant_id = t.tenant_id AND i.id = t.order_item_id JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
      WHERE t.tenant_id = ? AND t.code = ? FOR UPDATE`, [tenantId, code]);
    if (!t) throw notFound('Ticket');
    if (t.status !== 'active') throw conflict('That ticket cannot be moved');
    if (!['day_ticket', 'multi_day'].includes(t.kind)) throw conflict('Only dated day tickets can move to another day');
    if (await one(conn, "SELECT id FROM scans WHERE tenant_id = ? AND ticket_id = ? AND result = 'ok' LIMIT 1", [tenantId, t.id])) throw conflict('That ticket has already been used');
    const from = d10(t.valid_from);
    if (b.date === from) throw bad('Pick a different day');
    if (b.date < today) throw bad('Pick today or a later day');
    if (b.date > addDays(today, 365)) throw bad('That day is too far ahead');
    // the day limit (online and window together), the same lock the sale takes; a manager may go over with a reason
    if (!b.check) await conn.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
    const { product, cents } = await unitPrice(conn, tenantId, t.product_id, t.tier, b.date);
    const over = await SH.overLimits(conn, tenant, [{ product, valid_on: b.date, quantity: 1 }]);
    if (over.length && !b.check) {
      const words = over.map((o) => o.words).join(' ');
      if (!b.over_limit_reason) throw conflict(`${words} Only a manager can sell over the limit, and says why.`, { over_limit: over });
      if (!isMgr(req)) throw forbidden(`${words} Only a manager can sell over the limit. Ask a manager.`);
    }
    // what has been paid for it so far, before tax: the sale, or the day it was last moved to at the window
    const prior = await one(conn, 'SELECT new_cents FROM window_changes WHERE tenant_id = ? AND ticket_id = ? ORDER BY id DESC LIMIT 1', [tenantId, t.id]);
    const old = prior ? Number(prior.new_cents) : t.unit_price_cents - t.discount_cents;
    const diff = cents - old;
    const { tax } = applyTax([{ type: 'ticket', cents: Math.abs(diff) }], 0, await loadRules(conn, tenantId));
    const owed = diff > 0 ? diff + tax : 0;
    const back = diff < 0 ? Math.abs(diff) + tax : 0;
    const quote = { ticket: { code: t.code, product: t.name, from, to: b.date }, old_cents: old, new_cents: cents, diff_cents: diff, tax_cents: diff ? tax : 0, owed_cents: owed, back_cents: back, over_limit: over };
    if (b.check) return { ...quote, check: true };
    if (back) await refundAllowed(conn, req, t.order_id, back);
    if (owed && !b.payment) throw bad(`The new day costs ${money(owed)} more. Take the payment first.`);
    // move it: the same code, the new day
    const to = addDays(b.date, Math.max(Number(t.valid_days), 1) - 1);
    await conn.query('UPDATE tickets SET valid_from = ?, valid_to = ? WHERE tenant_id = ? AND id = ?', [b.date, to, tenantId, t.id]);
    await conn.query('UPDATE order_items SET valid_on = ? WHERE tenant_id = ? AND id = ?', [b.date, tenantId, t.item_id]);
    let paidOrder = null;
    if (owed) {
      // the difference is its own small order (a "Price difference" line), so the till and the books balance
      const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, user_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, ?, 'paid', ?, 0, ?, ?, 'window', ?)", [tenantId, t.person_id, req.auth.userId, diff, tax, owed, b.payment.reference || null]);
      paidOrder = o.insertId;
      await conn.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, label, person_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents) VALUES (?, ?, NULL, 'fee', 'Price difference', ?, ?, 1, ?, ?, 0, ?)", [tenantId, paidOrder, t.person_id, t.tier, diff, b.date, tax]);
      if (b.payment.terminal_payment_id) {
        if (b.payment.tender !== 'card') throw bad('A card reader payment must be recorded as a card');
        const tp = await require('./terminal').attach(conn, tenantId, b.payment.terminal_payment_id, owed, paidOrder);
        await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, card_brand, card_last4, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, ?, ?, 'stripe', ?, ?)", [tenantId, paidOrder, owed, tp.intent, tp.brand, tp.last4, tp.account, tp.fee]);
      } else {
        await conn.query('INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, card_last4, processor) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, paidOrder, b.payment.tender, owed, b.payment.reference || null, b.payment.card_last4 || null, b.payment.tender === 'card' ? 'manual' : null]);
      }
    }
    let refundId = null;
    if (back) {
      // the difference goes back the way the order was paid: a Stripe card through Stripe (retried, never twice), else
      // the desk's card machine, or cash from the cashier's drawer
      const pays = await rows(conn, 'SELECT * FROM order_payments WHERE tenant_id = ? AND order_id = ? ORDER BY id', [tenantId, t.order_id]);
      const real = pays.filter((p) => p.tender !== 'comp');
      const lastTender = real.length ? real[real.length - 1].tender : 'cash';
      const method = lastTender === 'card' ? 'card' : 'cash';
      const parts = method === 'card' ? await cardrefund.splitCard(conn, tenantId, t.order_id, pays, back) : [{ method: 'cash', cents: back }];
      const till = method === 'cash' ? await one(conn, "SELECT id FROM till_sessions WHERE tenant_id = ? AND opened_by = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [tenantId, req.auth.userId]) : null;
      for (const [k, x] of parts.entries()) {
        const [r] = await conn.query("INSERT INTO order_refunds (tenant_id, order_id, user_id, reason, note, amount_cents, tax_cents, method, till_id) VALUES (?, ?, ?, 'customer_request', ?, ?, ?, ?, ?)",
          [tenantId, t.order_id, req.auth.userId, `Changed day: ${from} to ${b.date}`, x.cents, k === parts.length - 1 ? tax : 0, x.method, till ? till.id : null]);
        if (!refundId) refundId = r.insertId;
        if (x.method === 'card' && x.ref) { await cardrefund.markPending(conn, tenantId, r.insertId, x.ref); refundRow = r.insertId; }
      }
      await conn.query('UPDATE orders SET refunded_cents = refunded_cents + ? WHERE tenant_id = ? AND id = ?', [back, tenantId, t.order_id]);
      quote.back_method = method;
    }
    const [w] = await conn.query('INSERT INTO window_changes (tenant_id, ticket_id, order_id, from_date, to_date, old_cents, new_cents, diff_cents, paid_order_id, refund_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, t.id, t.order_id, from, b.date, old, cents, diff, paidOrder, refundId, req.auth.userId]);
    await audit(conn, req, 'change_day', 'tickets', t.id, { from, to: b.date, diff_cents: diff, owed_cents: owed, back_cents: back, paid_order_id: paidOrder, refund_id: refundId, ...(over.length ? { over_limit_reason: b.over_limit_reason } : {}) });
    return { ...quote, done: true, change_id: w.insertId, paid_order_id: paidOrder, order_id: t.order_id, ticket_id: t.id };
  });
  if (out.check) return res.json(out);
  if (refundRow) { const s = await cardrefund.send(tenantId, refundRow); if (s === 'failed') out.card_refund_failed = true; }
  out.emailed = await changeEmail(tenantId, out).catch(() => false);
  res.json(out);
});

/** The guest hears about the move: the old day, the new day, what was paid or given back. Same style as salemail.js. */
async function changeEmail(tenantId, c) {
  if (!mailer.enabled()) return false;
  const to = await require('../lib/salemail').recipientOf(tenantId, c.order_id);
  if (!to) return false;
  const t = await one(pool, 'SELECT name, phone FROM tenants WHERE id = ?', [tenantId]);
  const k = await one(pool, 'SELECT p.first_name, p.last_name FROM tickets tk LEFT JOIN people p ON p.tenant_id = tk.tenant_id AND p.id = tk.person_id WHERE tk.tenant_id = ? AND tk.id = ?', [tenantId, c.ticket_id]);
  const firstName = String(to.name || '').trim().split(/\s+/)[0] || 'there';
  const text = [`Hi ${firstName},`, '', `Your ticket at ${t.name} has moved to a new day.`, '',
    `- ${c.ticket.product}${k && k.first_name ? `, ${k.first_name} ${k.last_name}` : ''}`,
    `- Was: ${dayText(c.ticket.from)}`, `- Now: ${dayText(c.ticket.to)}`,
    c.owed_cents ? `- You paid ${money(c.owed_cents)} for the change.` : c.back_cents ? `- ${money(c.back_cents)} goes back to you${c.back_method === 'card' ? ' on your card. It usually shows in 5 to 10 business days' : ' in cash at the window'}.` : '- The change was free.', '',
    'The barcode is the same. Show it at the gate on the new day.', '',
    t.phone ? `Questions? Call ${t.phone}.` : ''].join('\n');
  const r = await mailer.send({ tenantId, to: to.email, fromName: t.name, subject: `Your ticket is now for ${dayText(c.ticket.to)}`, text, tag: 'window-change' });
  return r.ok;
}

// ---------------------------------------------------------------- the receipt from Line mode
/**
 * Sends the receipt with the ticket codes: by email to the address given, or by text to the guest on the order, only
 * when texts are set up and that guest has said yes to texts (the consent ledger). Never a text without consent.
 * ACCOUNT's designed confirmation (lib/salemail.js) can replace the email body when it lands.
 */
router.post('/orders/:id/send-receipt', requireRole(...sellers), validate(z.object({ email: z.string().trim().email().max(255).optional(), by: z.enum(['email', 'text']).default('email') })), async (req, res) => {
  const { tenantId } = req.auth;
  const o = await one(pool, 'SELECT id, person_id, total_cents FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!o) throw notFound('Order');
  const t = await one(pool, 'SELECT name, phone FROM tenants WHERE id = ?', [tenantId]);
  const tickets = await rows(pool, `SELECT tk.code, tk.valid_from, pr.name, p.first_name FROM tickets tk JOIN order_items i ON i.tenant_id = tk.tenant_id AND i.id = tk.order_item_id
    JOIN products pr ON pr.tenant_id = tk.tenant_id AND pr.id = tk.product_id LEFT JOIN people p ON p.tenant_id = tk.tenant_id AND p.id = tk.person_id
    WHERE tk.tenant_id = ? AND i.order_id = ? AND tk.status <> 'void' ORDER BY tk.id`, [tenantId, o.id]);
  const lines = tickets.map((k) => `- ${k.name}${k.first_name ? ` for ${k.first_name}` : ''}, ${dayText(d10(k.valid_from))}: ${k.code}`);
  if (req.body.by === 'text') {
    const sms = require('../lib/sms');
    if (!sms.enabled()) throw conflict('Text messages are not set up for this mountain. Send the receipt by email.');
    const p = o.person_id ? await one(pool, 'SELECT phone FROM people WHERE tenant_id = ? AND id = ?', [tenantId, o.person_id]) : null;
    const c = o.person_id ? await require('../lib/consent').currentConsent(pool, tenantId, o.person_id) : null;
    if (!p || !p.phone || !c || !c.sms || c.sms.status !== 'opted_in') throw conflict('This guest has not said yes to texts. Send the receipt by email.');
    const r = await sms.send({ tenantId, to: sms.e164(p.phone) || p.phone, body: `${t.name}: thanks! Order ${o.id}, ${money(o.total_cents)}.${tickets.length ? ` Tickets: ${tickets.map((k) => k.code).join(', ')}` : ''}` });
    if (!r.ok) throw conflict('The text could not be sent. Try email.');
    return res.json({ ok: true, by: 'text' });
  }
  if (!req.body.email) throw bad('Enter the email address');
  if (!mailer.enabled()) throw conflict('Email is not set up for this mountain.');
  const text = [`Thanks for coming to ${t.name}!`, '', `Order ${o.id}: ${money(o.total_cents)}`, '', ...(lines.length ? ['Your tickets (show the code at the gate):', ...lines, ''] : []), t.phone ? `Questions? Call ${t.phone}.` : ''].join('\n');
  const r = await mailer.send({ tenantId, to: req.body.email, fromName: t.name, subject: `Your receipt from ${t.name}`, text, tag: 'window-receipt' });
  if (!r.ok) throw conflict('The email could not be sent.');
  await audit(pool, req, 'send_receipt', 'orders', o.id, { by: 'email' });
  res.json({ ok: true, by: 'email' });
});

async function tick() { return {}; }
async function daily() { return {}; }

module.exports = { router, publicRouter, tick, daily, welcome, tellApart, readRoster, refundAllowed, birthdayThisWeek };
