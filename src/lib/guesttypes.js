'use strict';

// Guest types: the kinds of guest a mountain prices by (Adult, Youth, Child, Senior, Military, or its own: College,
// Local, Twilight...). Each mountain starts with the five it always had, under the same codes, so every price and
// past sale carries straight over. A manager can add, rename, hide and reorder them, and give each an age range: online,
// a guest with a date of birth is priced as the type their age falls in (the narrowest range wins), and a guest
// without one picks from the types marked for online sale. A type that has ever been used can be hidden, never deleted.
const { rows, one } = require('../db');
const { bad } = require('./errors');

const DEFAULTS = [
  { code: 'adult', name: 'Adult', min_age: 18, max_age: 64, online: 1, sort: 1 },
  { code: 'youth', name: 'Youth', min_age: 13, max_age: 17, online: 1, sort: 2 },
  { code: 'child', name: 'Child', min_age: 0, max_age: 12, online: 1, sort: 3 },
  { code: 'senior', name: 'Senior', min_age: 65, max_age: null, online: 1, sort: 4 },
  { code: 'military', name: 'Military', min_age: null, max_age: null, online: 0, sort: 5 },
];
const CODE = /^[a-z0-9_]{1,30}$/;

/** A code from a name: "College student" -> college_student. */
const codeFor = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'type';

const shape = (t) => ({ code: t.code, name: t.name, min_age: t.min_age === null ? null : Number(t.min_age), max_age: t.max_age === null ? null : Number(t.max_age),
  online: Boolean(Number(t.online)), hidden: Boolean(Number(t.hidden)), sort: Number(t.sort) });

/** The mountain's guest types in order (hidden ones too, unless visibleOnly). Makes the five defaults the first time. */
async function list(db, tenantId, { visibleOnly = false } = {}) {
  let all = await rows(db, 'SELECT * FROM guest_types WHERE tenant_id = ? ORDER BY sort, id', [tenantId]);
  if (!all.length) {
    for (const d of DEFAULTS) {
      await db.query('INSERT IGNORE INTO guest_types (tenant_id, code, name, min_age, max_age, online, sort) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, d.code, d.name, d.min_age, d.max_age, d.online, d.sort]);
    }
    all = await rows(db, 'SELECT * FROM guest_types WHERE tenant_id = ? ORDER BY sort, id', [tenantId]);
  }
  const out = all.map(shape);
  return visibleOnly ? out.filter((t) => !t.hidden) : out;
}

/** The type a guest of this age is priced as: the narrowest visible range that holds the age; Adult, or the first type, if none does. */
function forAge(types, age) {
  const visible = types.filter((t) => !t.hidden);
  const fits = visible.filter((t) => (t.min_age !== null || t.max_age !== null) && (t.min_age === null || age >= t.min_age) && (t.max_age === null || age <= t.max_age));
  fits.sort((a, b) => ((a.max_age ?? 200) - (a.min_age ?? 0)) - ((b.max_age ?? 200) - (b.min_age ?? 0)));
  if (fits.length) return fits[0].code;
  return (visible.find((t) => t.code === 'adult') || visible[0] || { code: 'adult' }).code;
}

const ageOn = (dob, day) => {
  let a = Number(day.slice(0, 4)) - Number(dob.slice(0, 4));
  if (day.slice(5) < dob.slice(5, 10)) a -= 1;
  return a;
};
/** The type for someone born on dob, on the day of their ticket or lesson. */
async function forBirthday(db, tenantId, dob, day) {
  return forAge(await list(db, tenantId), ageOn(dob, day));
}

/** Throws unless every code is one of this mountain's types (and, for a new sale, not hidden). */
async function assertKnown(db, tenantId, codes, { forSale = false } = {}) {
  const want = [...new Set(codes.filter((c) => c !== undefined && c !== null))];
  if (!want.length) return;
  const types = await list(db, tenantId);
  for (const c of want) {
    const t = types.find((x) => x.code === c);
    if (!t) throw bad(`There is no guest type "${c}" at this mountain`);
    if (forSale && t.hidden) throw bad(`${t.name} is hidden, so it cannot be sold. Show it again under Products and prices, Guest types.`);
  }
}

/** Whether a type has ever been priced or sold (then it can only be hidden). */
async function used(db, tenantId, code) {
  const a = await one(db, 'SELECT 1 AS x FROM price_tiers WHERE tenant_id = ? AND tier = ? LIMIT 1', [tenantId, code]);
  const b = a || await one(db, 'SELECT 1 AS x FROM price_calendar WHERE tenant_id = ? AND tier = ? LIMIT 1', [tenantId, code]);
  const c = b || await one(db, 'SELECT 1 AS x FROM order_items WHERE tenant_id = ? AND tier = ? LIMIT 1', [tenantId, code]);
  return Boolean(c);
}

/**
 * A guest's type follows them through the basket (the counter's Sell). Once a person is a Child on one line (picked, or
 * from their date of birth), their other lines at the usual type (Adult) are priced as a Child too: a child's rental
 * never goes at the adult price because the cashier picked "Child" only on the lesson. A type picked on purpose (other
 * than the usual one) is kept. A ticket line held by people of different types is split into one line per type.
 * body: the checkout body ({ customer, participants, lines }); changed in place. Returns what changed, for the screen:
 * [{ key, name, line, from, to }].
 */
async function followPerson(db, tenantId, body, today) {
  if (!body || body.quick || !Array.isArray(body.lines)) return [];
  const types = await list(db, tenantId);
  const usual = (types.find((t) => t.code === 'adult' && !t.hidden) || types.find((t) => !t.hidden) || { code: 'adult' }).code;
  const specs = { customer: body.customer || {}, ...(body.participants || {}) };
  const who = new Map(); // key -> { dob, name }
  for (const [key, spec] of Object.entries(specs)) {
    const d = (spec && spec.details) || {};
    let dob = d.date_of_birth || null;
    let name = [d.first_name, d.last_name].filter(Boolean).join(' ');
    if (spec && spec.person_id && (!dob || !name)) {
      const p = await one(db, 'SELECT first_name, last_name, date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [tenantId, spec.person_id]);
      if (p) { dob = dob || (p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : null); name = name || `${p.first_name} ${p.last_name}`; }
    }
    who.set(key, { dob, name: name || (key === 'customer' ? 'The customer' : 'A guest') });
  }
  const TIERED = ['ticket', 'lesson', 'lesson_package', 'rental', 'activity'];
  // a ticket line for several people: one line per holder first, so each can follow its holder (merged again below)
  const lines = [];
  for (const l of body.lines) {
    if (l.type === 'ticket' && Array.isArray(l.holders) && l.holders.length > 1 && new Set(l.holders).size > 1) {
      for (const k of l.holders) lines.push({ ...l, quantity: 1, holders: [k], _from: l });
    } else lines.push(l);
  }
  const keyOf = (l) => (l.type === 'ticket' ? ((l.holders && l.holders[0]) || 'customer') : (l.participant || 'customer'));
  const changes = [];
  for (const [key, w] of who) {
    const mine = lines.filter((l) => TIERED.includes(l.type) && keyOf(l) === key && !(l.type === 'ticket' && l.quantity > 1 && !(l.holders && l.holders.length)));
    if (!mine.length) continue;
    const picked = mine.map((l) => l.tier).filter((t) => t && t !== usual);
    const byAge = w.dob && /^\d{4}-\d{2}-\d{2}/.test(w.dob) ? forAge(types, ageOn(w.dob, today)) : null;
    const target = picked[0] || byAge;
    if (!target || target === usual) continue;
    for (const l of mine) {
      if ((l.tier || usual) !== usual) continue;
      changes.push({ key, name: w.name, line: l.type, from: usual, to: target });
      l.tier = target;
    }
  }
  // put split ticket lines back together where their holders ended up the same type
  const out = [];
  for (const l of lines) {
    if (!l._from) { out.push(l); continue; }
    const same = out.find((x) => x._from === l._from && x.tier === l.tier);
    if (same) { same.quantity += 1; same.holders.push(l.holders[0]); } else out.push({ ...l, holders: [...l.holders] });
  }
  for (const l of out) delete l._from;
  body.lines = out;
  return changes;
}

module.exports = { DEFAULTS, CODE, codeFor, list, forAge, forBirthday, ageOn, assertKnown, used, followPerson };
