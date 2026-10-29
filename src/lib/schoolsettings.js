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
};

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
}).partial();

async function get(db, tenantId) {
  const row = await one(db, 'SELECT * FROM school_settings WHERE tenant_id = ?', [tenantId]);
  const out = { ...DEFAULTS };
  if (row) for (const k of Object.keys(DEFAULTS)) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

/** Saves the fields given (already validated with schema). */
async function save(conn, tenantId, fields) {
  const keys = Object.keys(fields).filter((k) => k in DEFAULTS);
  if (!keys.length) return;
  const cols = keys.join(', ');
  const marks = keys.map(() => '?').join(', ');
  const upd = keys.map((k) => `${k} = VALUES(${k})`).join(', ');
  await conn.query(`INSERT INTO school_settings (tenant_id, ${cols}) VALUES (?, ${marks}) ON DUPLICATE KEY UPDATE ${upd}`, [tenantId, ...keys.map((k) => fields[k])]);
}

module.exports = { DEFAULTS, schema, get, save };
