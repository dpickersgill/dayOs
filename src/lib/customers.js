'use strict';

// The shared customer record. Every module (tickets, lessons, rentals, programs, patrol) points at the
// `people` table; this file is the one place that knows which details we hold about a customer, how a
// purchaser is matched to an existing record, and which details a mountain has made mandatory.
const { partialOf, z, dateStr } = require('./util');
const { rows, one } = require('../db');
const { bad } = require('./errors');
const { recordConsent } = require('./consent');

const DISCIPLINES = ['ski', 'snowboard', 'telemark', 'adaptive'];
const SEXES = ['female', 'male', 'other'];
const STANCES = ['regular', 'goofy'];
const SKIER_TYPES = ['1', '1.5', '2', '2.5', '3'];
const ABILITIES = ['first_timer', 'beginner', 'intermediate', 'advanced'];
const SOURCES = ['window', 'online', 'phone', 'group', 'lesson', 'import', 'staff'];

// key, label, group, type. `fixed` fields cannot be switched on or off by an administrator.
const FIELDS = [
  { key: 'first_name', label: 'First name', group: 'contact', type: 'text', fixed: 'required' },
  { key: 'last_name', label: 'Last name', group: 'contact', type: 'text', fixed: 'required' },
  { key: 'email', label: 'Email', group: 'contact', type: 'email' },
  { key: 'phone', label: 'Phone', group: 'contact', type: 'tel' },
  { key: 'date_of_birth', label: 'Date of birth', group: 'contact', type: 'date' },
  { key: 'sex', label: 'Sex', group: 'contact', type: 'select', options: SEXES },
  { key: 'address_line1', label: 'Street address', group: 'address', type: 'text' },
  { key: 'address_line2', label: 'Apartment, suite, etc.', group: 'address', type: 'text', fixed: 'optional' },
  { key: 'city', label: 'City', group: 'address', type: 'text' },
  { key: 'region', label: 'State or province', group: 'address', type: 'text' },
  { key: 'postal_code', label: 'ZIP or postal code', group: 'address', type: 'text' },
  { key: 'country', label: 'Country', group: 'address', type: 'text' },
  { key: 'height_in', label: 'Height (inches)', group: 'sizing', type: 'number', fixed: 'optional' },
  { key: 'weight_lb', label: 'Weight (pounds)', group: 'sizing', type: 'number', fixed: 'optional' },
  { key: 'boot_size', label: 'Boot size', group: 'sizing', type: 'text', fixed: 'optional' },
  { key: 'stance', label: 'Snowboard stance', group: 'sizing', type: 'select', options: STANCES, fixed: 'optional' },
  { key: 'skier_type', label: 'Skier type (I, II, III)', group: 'sizing', type: 'select', options: SKIER_TYPES, fixed: 'optional' },
  { key: 'emergency_name', label: 'Emergency contact name', group: 'emergency', type: 'text' },
  { key: 'emergency_phone', label: 'Emergency contact phone', group: 'emergency', type: 'tel' },
  { key: 'discipline', label: 'Ski or snowboard', group: 'skiing', type: 'select', options: DISCIPLINES },
  { key: 'ability_level', label: 'Ability level', group: 'skiing', type: 'select', options: ABILITIES },
  { key: 'marketing_opt_in', label: 'Send me news and offers by email', group: 'consent', type: 'check', fixed: 'optional' },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const GROUPS = [
  ['contact', 'Contact'], ['address', 'Address'], ['emergency', 'Emergency contact'], ['skiing', 'Skiing'], ['sizing', 'Rental sizing'], ['consent', 'Email consent'],
];
const SCOPES = ['ticket', 'lesson'];
// Not a field: when set on the ticket form, a ticket sale cannot be completed without a purchaser.
const PURCHASER_KEY = '_purchaser';

const PERSON_COLUMNS = FIELDS.map((f) => f.key).concat(['marketing_opt_in_at', 'source', 'notes']);
// Everything about a person except the photo, which is large and fetched on its own.
const COLS = ['id', 'tenant_id', 'created_at', 'anonymised_at', 'phone_key', ...PERSON_COLUMNS].map((c) => `\`${c}\``).join(', ') + ', (photo IS NOT NULL) AS has_photo';

const text = (n) => z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v), z.string().max(n).nullable().optional());
const personFields = {
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v), z.string().email().max(255).nullable().optional()),
  phone: text(40),
  date_of_birth: z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional()),
  sex: z.preprocess((v) => (v === '' ? null : v), z.enum(SEXES).nullable().optional()),
  height_in: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().min(10).max(110).nullable().optional()),
  weight_lb: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().min(10).max(600).nullable().optional()),
  boot_size: text(10),
  stance: z.preprocess((v) => (v === '' ? null : v), z.enum(STANCES).nullable().optional()),
  skier_type: z.preprocess((v) => (v === '' ? null : v), z.enum(SKIER_TYPES).nullable().optional()),
  // A small JPEG as a data URL (the screen shrinks it to about 40 KB before sending).
  photo: z.preprocess((v) => (v === '' ? null : v), z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'A JPEG photo').max(120000).nullable().optional()),
  address_line1: text(255), address_line2: text(255), city: text(100), region: text(60), postal_code: text(20), country: text(60),
  emergency_name: text(150), emergency_phone: text(40),
  discipline: z.preprocess((v) => (v === '' ? null : v), z.enum(DISCIPLINES).nullable().optional()),
  ability_level: z.preprocess((v) => (v === '' ? null : v), z.enum(ABILITIES).nullable().optional()),
  marketing_opt_in: z.boolean().optional(),
  notes: text(1000),
};
const personCreate = z.object(personFields);
const personUpdate = partialOf(personFields);

const isBlank = (v) => v === null || v === undefined || v === '';

/** Which fields a mountain requires for a kind of sale: Set of keys, possibly including PURCHASER_KEY. */
async function requiredFor(conn, tenantId, scope) {
  const saved = await rows(conn, 'SELECT field_key, required FROM customer_form_config WHERE tenant_id = ? AND scope = ?', [tenantId, scope]);
  return new Set(saved.filter((r) => r.required).map((r) => r.field_key));
}

/** Whole years old on a day ('YYYY-MM-DD'), or null when the date of birth is not known. */
function ageOn(dob, day) {
  if (!dob) return null;
  const [by, bm, bd] = String(dob).slice(0, 10).split('-').map(Number);
  const [y, m, d] = String(day).slice(0, 10).split('-').map(Number);
  if (!by || !y) return null;
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/**
 * The names of required details a customer record is missing.
 * `sale` applies the rule for anyone who is sold something: everyone needs a name, date of birth and sex. A guest under 18
 * needs nothing more (no phone or email); an adult also needs a phone number or an email. The mountain's own mandatory
 * fields are added on top, except that a guest under 18 is never asked for a phone number or email.
 */
function missingFields(person, required, sale) {
  const minor = Boolean(sale && sale.today) && ageOn(person.date_of_birth, sale.today) !== null && ageOn(person.date_of_birth, sale.today) < 18;
  const out = [];
  const want = new Set(required);
  if (sale) { want.add('first_name'); want.add('last_name'); want.add('date_of_birth'); want.add('sex'); }
  for (const key of want) {
    if (key === PURCHASER_KEY) continue;
    if (minor && (key === 'phone' || key === 'email')) continue;
    const f = BY_KEY.get(key);
    if (f && isBlank(person[key])) out.push(f.label);
  }
  if (sale && !minor && isBlank(person.phone) && isBlank(person.email) && !want.has('phone') && !want.has('email')) out.push('Phone or email');
  return out;
}

const complain = (who, missing) =>
  bad(`${who ? `${who}: ` : ''}Missing required details: ${missing.join(', ')}`, missing.map((m) => ({ path: m, message: 'Required' })));

/** Checks an existing customer record against a kind of sale's mandatory fields, naming what is missing. */
async function ensureRequired(conn, tenantId, person, scope, sale) {
  const missing = missingFields(person, await requiredFor(conn, tenantId, scope), sale);
  if (missing.length) throw complain(`${person.first_name} ${person.last_name}`, missing);
}

/**
 * Find or create the customer for a sale or booking, inside the caller's transaction.
 *   - person_id given: that customer is used. Any details sent with it overwrite what we hold (the clerk just
 *     confirmed them with the guest).
 *   - no person_id: look for an existing customer by email, by name plus date of birth, or by name plus phone number. A match is reused and
 *     only has its blanks filled in; nothing already on file is overwritten and consent is never withdrawn by a
 *     match. No match creates a new customer.
 * Then the mountain's mandatory fields for this kind of sale are checked against the final record.
 * Returns { id, person, created, matched }.
 */
async function resolvePerson(conn, tenantId, { personId, details, scope, source, sale }) {
  const required = await requiredFor(conn, tenantId, scope);
  const d = details || {};
  const supplied = Object.keys(d).filter((k) => BY_KEY.has(k) || k === 'notes' || k === 'photo');
  let person = null;
  let created = false;
  let matched = false;

  if (personId) {
    person = await one(conn, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND id = ? FOR UPDATE`, [tenantId, personId]);
    if (!person) return { notFound: true };
    if (supplied.length) await applyDetails(conn, tenantId, person, d, 'overwrite');
  } else if (supplied.length) {
    if (isBlank(d.first_name) || isBlank(d.last_name)) throw bad('First and last name are required');
    if (!isBlank(d.email)) person = await one(conn, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND email = ? ORDER BY id LIMIT 1 FOR UPDATE`, [tenantId, d.email]);
    if (!person && !isBlank(d.date_of_birth)) {
      person = await one(conn, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND first_name = ? AND last_name = ? AND date_of_birth = ? ORDER BY id LIMIT 1 FOR UPDATE`, [tenantId, d.first_name, d.last_name, d.date_of_birth]);
    }
    const key = isBlank(d.phone) ? '' : String(d.phone).replace(/\D/g, '').slice(-10);
    if (!person && key.length >= 7) {
      // Same first and last name on the same phone number (a family may share a phone, so the name must match too).
      person = await one(conn, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND first_name = ? AND last_name = ? AND phone_key = ? ORDER BY id LIMIT 1 FOR UPDATE`, [tenantId, d.first_name, d.last_name, key]);
    }
    if (person) {
      matched = true;
      await applyDetails(conn, tenantId, person, d, 'fill');
    } else {
      const keys = supplied.filter((k) => !isBlank(d[k]) && k !== 'marketing_opt_in');
      const vals = keys.map((k) => d[k]);
      const optIn = d.marketing_opt_in === true;
      const [r] = await conn.query(
        `INSERT INTO people (tenant_id, ${keys.map((k) => `\`${k}\``).join(', ')}, marketing_opt_in, marketing_opt_in_at, source) VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ${optIn ? 'NOW()' : 'NULL'}, ?)`,
        [tenantId, ...vals, optIn ? 1 : 0, source || null],
      );
      if (optIn) await recordConsent(conn, tenantId, r.insertId, 'email', 'opted_in', source || 'sale', null);
      person = await one(conn, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND id = ?`, [tenantId, r.insertId]);
      created = true;
    }
  }
  if (!person) return { id: null, person: null, created: false, matched: false };
  const fresh = await one(conn, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND id = ?`, [tenantId, person.id]);
  const missing = missingFields(fresh, required, sale);
  if (missing.length) throw complain(`${fresh.first_name} ${fresh.last_name}`, missing);
  return { id: fresh.id, person: fresh, created, matched };
}

const hasPhoto = async (conn, tenantId, id) => Boolean((await one(conn, 'SELECT (photo IS NOT NULL) AS has FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id])).has);

/** Writes supplied details onto an existing customer. mode 'fill' only touches blank columns; 'overwrite' replaces. */
async function applyDetails(conn, tenantId, person, d, mode) {
  const set = [];
  const vals = [];
  for (const f of FIELDS) {
    if (f.key === 'marketing_opt_in' || d[f.key] === undefined) continue;
    const v = isBlank(d[f.key]) ? null : d[f.key];
    if (mode === 'fill' && (v === null || !isBlank(person[f.key]))) continue; // a match only fills blanks
    if (mode === 'overwrite' && v === person[f.key]) continue;
    set.push(`\`${f.key}\` = ?`);
    vals.push(v);
  }
  if (d.notes !== undefined && mode === 'overwrite') { set.push('notes = ?'); vals.push(isBlank(d.notes) ? null : d.notes); }
  if (d.photo !== undefined && !isBlank(d.photo) && (mode === 'overwrite' || !(await hasPhoto(conn, tenantId, person.id)))) { set.push('photo = ?'); vals.push(d.photo); }
  if (d.marketing_opt_in === true && !person.marketing_opt_in) { set.push('marketing_opt_in = 1, marketing_opt_in_at = NOW()'); await recordConsent(conn, tenantId, person.id, 'email', 'opted_in', 'sale', null); }
  if (d.marketing_opt_in === false && mode === 'overwrite' && person.marketing_opt_in) { set.push('marketing_opt_in = 0'); await recordConsent(conn, tenantId, person.id, 'email', 'opted_out', 'sale', null); }
  if (!set.length) return;
  await conn.query(`UPDATE people SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, tenantId, person.id]);
}

module.exports = { COLS, STANCES, SKIER_TYPES, SEXES, ageOn, FIELDS, BY_KEY, GROUPS, SCOPES, SOURCES, PURCHASER_KEY, PERSON_COLUMNS, DISCIPLINES, ABILITIES, personFields, personCreate, personUpdate, requiredFor, missingFields, ensureRequired, resolvePerson, isBlank };
