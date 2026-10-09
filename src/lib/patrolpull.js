'use strict';

// A one-way pull: patrol reads what the mountain already knows about a guest (their customer record, the
// ticket they hold, the gear they have rented) and copies the useful parts into a patient record.
// Nothing in here writes. The customer, ticket and rental records are never changed from patrol, and nothing
// patrol records flows back to them. Callers add the audit entry.
// Patrol may copy the contact and body details the incident form asks for (address, height, weight). It still never gets
// the emergency contact, email, marketing consent, notes or what the guest paid.
const { rows, one } = require('../db');
const { dayRange } = require('./util');

const ABILITY = { first_timer: 'beginner', beginner: 'beginner', intermediate: 'intermediate', advanced: 'advanced' };
const ACTIVITY = { ski: 'ski', telemark: 'ski', snowboard: 'snowboard', adaptive: 'other_snow' };
// Which ticket to report when a guest holds more than one: the most specific pass first.
const TICKET_RANK = ['season_pass', 'multi_day', 'day_ticket', 'punch_card', 'voucher'];
const TICKET_TYPE = { season_pass: 'season_pass', multi_day: 'multi_day', day_ticket: 'day', punch_card: 'other_pass', voucher: 'other_pass' };

const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

function ageOn(dob, onDate) {
  if (!dob) return null;
  const b = ymd(dob); const d = ymd(onDate);
  let age = Number(d.slice(0, 4)) - Number(b.slice(0, 4));
  if (d.slice(5) < b.slice(5)) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

/**
 * What patrol may see about a guest, and the patient-record values it suggests.
 * `at` is the incident time as a 'YYYY-MM-DD HH:MM[:SS]' string, so gear counts only if it was out then.
 * Returns null when there is no such customer. Patrol never gets the emergency contact, marketing consent, notes,
 * email or what the guest paid.
 */
async function buildPull(conn, tenantId, personId, at) {
  const p = await one(conn, 'SELECT id, first_name, last_name, date_of_birth, sex, phone, address_line1, address_line2, city, region, postal_code, height_in, weight_lb, discipline, ability_level FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  if (!p) return null;
  const stamp = String(at).replace('T', ' ').padEnd(19, ':00').slice(0, 19); // 'YYYY-MM-DD HH:MM:SS'
  const day = stamp.slice(0, 10);
  const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const [dayStart, dayEnd] = dayRange(tz, day); // check-out times are stamped in database time (UTC); the incident day is local

  const tickets = await rows(conn, `SELECT pr.name, pr.kind, t.valid_from, t.valid_to FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id
                                    WHERE t.tenant_id = ? AND t.person_id = ? AND t.status IN ('active','used_up') AND t.valid_from <= ? AND t.valid_to >= ?`, [tenantId, personId, day, day]);
  // Gear counts if the contract was open at any time on the day of the incident (check-out times are
  // stored in database time, incident times in the mountain's local time).
  const gear = await rows(conn, `SELECT i.category, i.sku, i.brand, i.model, i.size, ci.din_setting FROM rental_contracts c
                                 JOIN rental_contract_items ci ON ci.contract_id = c.id AND ci.tenant_id = c.tenant_id
                                 JOIN rental_items i ON i.id = ci.rental_item_id AND i.tenant_id = ci.tenant_id
                                 WHERE c.tenant_id = ? AND c.person_id = ? AND c.status <> 'lost' AND c.checked_out_at < ? AND (c.checked_in_at IS NULL OR c.checked_in_at >= ?)`, [tenantId, personId, dayEnd, dayStart]);

  const best = TICKET_RANK.map((k) => tickets.find((t) => t.kind === k)).find(Boolean);
  const helmetOut = gear.some((g) => g.category === 'helmet');
  const boot = gear.find((g) => g.category === 'boot');
  const ski = gear.find((g) => g.category === 'ski' || g.category === 'snowboard');

  const patient = {
    first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth ? ymd(p.date_of_birth) : null,
    age_years: ageOn(p.date_of_birth, day), sex: p.sex, phone: p.phone,
    home_town: p.city || null,
    activity: ACTIVITY[p.discipline] || null, ability: ABILITY[p.ability_level] || null,
    helmet: helmetOut ? 'yes' : null, rental_equipment: gear.length ? 'yes' : null,
  };
  const form = {};
  if (best) form.ticket_type = TICKET_TYPE[best.kind];
  if (gear.length) form.equipment = 'area_rental';
  if (helmetOut) form.helmet = 'rental';
  if (boot) form.rental_boot = boot.sku;
  if (ski) form.rental_ski = ski.sku;
  if (patient.ability) form.ability = patient.ability;
  const street = [p.address_line1, p.address_line2].filter(Boolean).join(', ');
  if (street) form.address = street;
  if (p.region) form.region = p.region;
  if (p.postal_code) form.postal = p.postal_code;
  if (p.height_in) form.height = `${Math.floor(p.height_in / 12)} ft ${p.height_in % 12} in`;
  if (p.weight_lb) form.weight = `${p.weight_lb} lbs`;

  return {
    person: { id: p.id, first_name: p.first_name, last_name: p.last_name, date_of_birth: patient.date_of_birth, age_years: patient.age_years, phone: p.phone, home_town: patient.home_town, address: form.address || null, region: p.region || null, postal: p.postal_code || null, height: form.height || null, weight: form.weight || null, discipline: p.discipline, ability_level: p.ability_level },
    tickets: tickets.map((t) => ({ name: t.name, kind: t.kind, valid_from: ymd(t.valid_from), valid_to: ymd(t.valid_to) })),
    rentals: gear.map((g) => ({ category: g.category, sku: g.sku, brand: g.brand, model: g.model, size: g.size, din_setting: g.din_setting === null ? null : Number(g.din_setting) })),
    suggested: { patient, form },
  };
}

module.exports = { buildPull, ageOn };
