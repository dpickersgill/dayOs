'use strict';
// The ski school's settings, one row per mountain in school_settings. A mountain with no row gets the defaults.
// Each part of the school reads what it needs: get(db, tenantId).field. Managers change them in Settings, Ski school.
const { one } = require('../db');
const { z } = require('./util');

const DEFAULTS = {
  confirm_email: 1, // email a confirmation when a lesson is booked or a request is confirmed
  checkin_link: 1, // the confirmation carries a "We're here" check-in link
  ratio_kids: 5, // students per instructor when the lineup splits a kids lesson
  ratio_adults: 6,
  recap_on: 1, // send families a recap after each lesson
  recap_photos: 1, // instructors may add photos to a recap, only for students whose family said yes
  waitlist_claim_minutes: 15, // how long the next family on a waitlist has to claim an open spot
  tips_on: 1, // families can add a tip from the recap, paid in full to the instructor
  tip_policy: null,
  pay_mode: 'per_lesson', // per_lesson, hourly or both
  lineup_paid: 0, // pay for time at the lineup before a lesson
  lineup_minutes: 15,
  request_bonus_cents: 0, // added when a guest asked for the instructor by name
  private_accept_minutes: 120, // how long an instructor has to accept a private asked for by name
  private_decline: 'offer_other', // offer_other or refund, when the instructor declines or does not answer
  what_to_bring: null, // Track CORE (db/steps/lessons2-core.js): in the confirmation; blank uses the lesson product's description
  private_confirm: 'accept', // 2026.11.9: accept (the instructor says yes, as before) or auto (confirmed when a cleared instructor is free)
  placement_questions: null, // 2026.11.9: JSON of the director's own placement questions; null uses the built-in ones (lib/placement.js)
  pool_spots_mode: 'staff', // 2026.11.9: new pool slots follow staff (staff) or keep the number typed (fixed)
  // School safety (feat/school-safety). Lists are JSON in the row; get() hands them back as arrays.
  ratio_bands: null, // [{ label, age_min, age_max, size }]: class size by age band; null uses DEFAULT_BANDS
  ratio_adaptive: 1, // students per instructor in an adaptive lesson (extra staff from the intake add to it)
  pickup_windows: null, // [{ label, age_min, age_max, minutes }]: minutes after the lesson ends to pick a child up
  group_places: null, // ['Magic carpet', ...]: the named spots an instructor taps for "We're at"
};
const DEFAULT_BANDS = [
  { label: 'Ages 3 to 4', age_min: 3, age_max: 4, size: 4 },
  { label: 'Ages 5 to 6', age_min: 5, age_max: 6, size: 6 },
  { label: 'Ages 7 to 12', age_min: 7, age_max: 12, size: 8 },
  { label: 'Teens', age_min: 13, age_max: 17, size: 8 },
  { label: 'Adults', age_min: 18, age_max: null, size: 10 },
];
const DEFAULT_WINDOWS = [
  { label: 'Ages 3 to 6', age_min: 0, age_max: 6, minutes: 10 },
  { label: 'Ages 7 to 12', age_min: 7, age_max: 12, minutes: 15 },
];
const DEFAULT_PLACES = ['Magic carpet', 'Lift 2 base', 'Lodge'];
const JSON_FIELDS = { ratio_bands: DEFAULT_BANDS, pickup_windows: DEFAULT_WINDOWS, group_places: DEFAULT_PLACES };

const bool = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0));
const schema = z.object({
  confirm_email: bool, checkin_link: bool,
  ratio_kids: z.number().int().min(1).max(20), ratio_adults: z.number().int().min(1).max(20),
  recap_on: bool, recap_photos: bool,
  waitlist_claim_minutes: z.number().int().min(5).max(240),
  tips_on: bool, tip_policy: z.string().trim().max(500).nullable(),
  pay_mode: z.enum(['per_lesson', 'hourly', 'both']), lineup_paid: bool, lineup_minutes: z.number().int().min(0).max(120),
  request_bonus_cents: z.number().int().min(0).max(100000),
  private_accept_minutes: z.number().int().min(15).max(2880), private_decline: z.enum(['offer_other', 'refund']),
  what_to_bring: z.string().trim().max(500).nullable(), // Track CORE
  private_confirm: z.enum(['accept', 'auto']), pool_spots_mode: z.enum(['staff', 'fixed']), // 2026.11.9
  ratio_bands: z.array(z.object({ label: z.string().trim().min(1).max(40), age_min: z.number().int().min(0).max(99).nullable(), age_max: z.number().int().min(0).max(99).nullable(), size: z.number().int().min(1).max(30) })).min(1).max(12)
    .refine((list) => list.every((b) => b.age_min == null || b.age_max == null || b.age_min <= b.age_max), 'A band has its youngest age above its oldest'),
  ratio_adaptive: z.number().int().min(1).max(6),
  pickup_windows: z.array(z.object({ label: z.string().trim().min(1).max(40), age_min: z.number().int().min(0).max(99).nullable(), age_max: z.number().int().min(0).max(99).nullable(), minutes: z.number().int().min(0).max(120) })).max(12),
  group_places: z.array(z.string().trim().min(1).max(80)).max(30),
}).partial();

async function get(db, tenantId) {
  const row = await one(db, 'SELECT * FROM school_settings WHERE tenant_id = ?', [tenantId]);
  const out = { ...DEFAULTS };
  if (row) for (const k of Object.keys(DEFAULTS)) if (row[k] !== undefined) out[k] = row[k];
  for (const [k, def] of Object.entries(JSON_FIELDS)) {
    let v = out[k];
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    out[k] = Array.isArray(v) ? v : def.map((x) => (typeof x === 'object' ? { ...x } : x));
  }
  return out;
}

/** Saves the fields given (already validated with schema). */
async function save(conn, tenantId, fields) {
  const keys = Object.keys(fields).filter((k) => k in DEFAULTS);
  if (!keys.length) return;
  const cols = keys.join(', ');
  const marks = keys.map(() => '?').join(', ');
  const upd = keys.map((k) => `${k} = VALUES(${k})`).join(', ');
  await conn.query(`INSERT INTO school_settings (tenant_id, ${cols}) VALUES (?, ${marks}) ON DUPLICATE KEY UPDATE ${upd}`, [tenantId, ...keys.map((k) => (k in JSON_FIELDS && fields[k] != null ? JSON.stringify(fields[k]) : fields[k]))]);
}

/** The settings that set instructors' pay: owners and managers change them, a school director does not. */
const PAY_FIELDS = ['pay_mode', 'lineup_paid', 'lineup_minutes', 'request_bonus_cents'];

module.exports = { DEFAULTS, DEFAULT_BANDS, DEFAULT_WINDOWS, DEFAULT_PLACES, PAY_FIELDS, schema, get, save };
