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

module.exports = { DEFAULTS, CODE, codeFor, list, forAge, forBirthday, ageOn, assertKnown, used };
