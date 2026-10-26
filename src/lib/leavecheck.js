'use strict';

// Before the patient leaves: the few things that can only be collected while the patient is still with patrol.
//   contact            a phone or an email for the patient (or a parent's email for a minor), to follow up
//   guardian           a parent or guardian's name, for anyone under 18
//   refusal_signature  the signed refusal, when care was refused
//   rental             the rental boot or ski number, when the gear was rented or a demo
//   witnesses          names of witnesses, or "no witnesses" (once per case)
// The phone shows the list when the patroller records an outcome or stamps hand-off or transport; each item is done
// there and then, or skipped with a reason. It never stops care or the outcome being saved. Skips go to the reviewer, and
// an item neither done nor skipped holds up the submit. public/js/leavecheck.js is the same list for the phone (offline).
const { parseForm } = require('./nsaar');
const { ageOf } = require('./requirements');

const ITEMS = [
  ['contact', 'Contact details (phone or email)'],
  ['guardian', 'Parent or guardian name'],
  ['refusal_signature', 'Signed refusal of care'],
  ['rental', 'Rental boot or ski number'],
  ['witnesses', 'Witness names, or no witnesses'],
];
const ITEM_KEYS = ITEMS.map((x) => x[0]);
const LABEL = Object.fromEntries(ITEMS);
const RENTAL = ['area_rental', 'other_rental', 'area_demos', 'other_demos'];
const CARE = ['injury', 'medical', 'collision'];
const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/** Has this patient left patrol's care, as far as the report knows? An outcome is recorded, or hand-off or transport was stamped. */
function leaving(c, p) {
  if (p.disposition) return true;
  return (c.events || []).some((e) => !e.voided_at && ['handoff', 'transport_started'].includes(e.kind) && (!e.patient_id || e.patient_id === p.id));
}

/**
 * The checklist for a loaded case: [{ item, label, patient_id, who, met, skip }]. Only patients who have left are listed;
 * the witness line appears once any patient has left. skip is the skip on file ({ reason, note, skipped_by }) or null.
 */
function items(c) {
  if (!CARE.includes(c.category)) return [];
  const out = [];
  const skips = c.skips || [];
  const skipFor = (item, pid) => skips.find((s) => s.item_key === item && (s.patient_id === null || s.patient_id === undefined ? null : Number(s.patient_id)) === (pid || null)) || null;
  const patients = (c.patients || []).filter((p) => !p.voided_at && leaving(c, p));
  for (const p of patients) {
    const f = { ...(p.derived || {}), ...parseForm(p.form) };
    const who = `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Patient';
    const age = ageOf(p, c.occurred_at);
    const minor = age !== null && age < 18;
    const add = (item, met) => out.push({ item, label: LABEL[item], patient_id: p.id, who, met: Boolean(met), skip: skipFor(item, p.id) });
    add('contact', !blank(p.phone) || !blank(p.email) || (minor && !blank(p.guardian_email)));
    if (minor) add('guardian', !blank(p.guardian_name) || !blank(f.refusal_guardian_name));
    if (p.disposition === 'refused_care') add('refusal_signature', (c.signatures || []).some((s) => s.kind === 'refusal_of_care' && s.patient_id === p.id));
    if (RENTAL.includes(f.equipment) || p.rental_equipment === 'yes') add('rental', !blank(f.rental_boot) || !blank(f.rental_ski));
  }
  if (patients.length) out.push({ item: 'witnesses', label: LABEL.witnesses, patient_id: null, who: null, met: (c.witnesses || []).length > 0 || Boolean(parseForm(c.form).witnesses_none), skip: skipFor('witnesses', null) });
  return out;
}

/** Items neither done nor skipped, as report problems (they hold up the submit). */
function problems(c) {
  return items(c).filter((i) => !i.met && !i.skip).map((i) => ({
    message: `Before the patient left: ${i.who ? `${i.who}, ` : ''}${i.label.charAt(0).toLowerCase()}${i.label.slice(1)}. Add it, or skip it with a reason`,
    area: 'leave', ...(i.patient_id ? { patient_id: i.patient_id } : {}), level: 'submit',
  }));
}

module.exports = { ITEMS, ITEM_KEYS, LABEL, items, problems, leaving };
