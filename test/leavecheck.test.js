'use strict';

// Before the patient leaves: the server's list and the phone's list (used with no signal) must agree, and what is
// waiting on the phone to be sent counts as done there.
const test = require('node:test');
const assert = require('node:assert/strict');
const LEAVE = require('../src/lib/leavecheck');

const patient = (over = {}) => ({ id: 21, first_name: 'Kim', last_name: 'Lee', age_years: 30, disposition: 'treated_released', form: {}, ...over });
const caseOf = (over = {}) => ({ id: 5, category: 'injury', occurred_at: '2026-01-10 10:00:00', form: {}, patients: [patient()], events: [], signatures: [], witnesses: [], skips: [], ...over });

const cases = [
  ['a released adult', caseOf()],
  ['a minor on rental gear who refused care', caseOf({ patients: [patient({ age_years: 12, disposition: 'refused_care', form: { equipment: 'area_rental' } })] })],
  ['no outcome yet, but handed off', caseOf({ patients: [patient({ disposition: null })], events: [{ kind: 'handoff', patient_id: null }] })],
  ['no outcome and no hand-off', caseOf({ patients: [patient({ disposition: null })] })],
  ['done or skipped', caseOf({ patients: [patient({ phone: '555', age_years: 16, guardian_name: 'Ann Lee' })], form: { witnesses_none: true } })],
  ['a skip on file', caseOf({ skips: [{ item_key: 'contact', patient_id: 21, reason: 'declined' }] })],
  ['not a patient care case', caseOf({ category: 'lost_person' })],
];

test('the phone and the server agree on the checklist', async () => {
  const client = await import('../public/js/leavecheck.js');
  for (const [name, c] of cases) {
    const server = LEAVE.items(c).map((i) => [i.item, i.patient_id, i.met, Boolean(i.skip)]);
    const phone = client.leaveItems(c).map((i) => [i.item, i.patient_id, i.met, Boolean(i.skip)]);
    assert.deepEqual(phone, server, name);
  }
  assert.deepEqual(LEAVE.items(cases[1][1]).map((i) => i.item), ['contact', 'guardian', 'refusal_signature', 'rental', 'witnesses']);
  assert.equal(LEAVE.items(cases[3][1]).length, 0, 'nobody has left yet');
  assert.ok(LEAVE.items(cases[4][1]).every((i) => i.met));
  assert.equal(LEAVE.problems(cases[5][1]).length, 1, 'the skipped contact is fine; the witnesses are not');
});

test('what waits on the phone counts as done there', async () => {
  const client = await import('../public/js/leavecheck.js');
  const c = { ...caseOf(), waiting: [
    { method: 'PATCH', path: '/patrol/incidents/5/patients/21', body: { phone: '555-0100' } },
    { method: 'POST', path: '/patrol/incidents/5/skips', body: { item: 'witnesses', patient_id: null, reason: 'not_applicable' } },
  ] };
  const list = client.leaveItems(c);
  assert.ok(list.every((i) => i.met || i.skip), JSON.stringify(list));
  // an entry that failed to send does not count
  const failed = { ...c, waiting: c.waiting.map((x) => ({ ...x, error: 'refused' })) };
  assert.ok(client.leaveItems(failed).some((i) => !i.met && !i.skip));
});
