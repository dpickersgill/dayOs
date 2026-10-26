'use strict';

// Report requirements, the rules on their own: levels, "only when" conditions, starting setups, N/A answers, exceptions,
// and the counts the Report tab shows. The routes that use them are tested in requirementsroutes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const RQ = require('../src/lib/requirements');

const patient = (over = {}) => ({ id: 11, first_name: 'Ana', last_name: 'Ruiz', age_years: 34, disposition: null, form: {}, derived: {}, ...over });
const caseOf = (over = {}) => ({ id: 1, category: 'injury', severity: 'minor', occurred_at: '2026-01-10 10:00:00', form: {}, narrative: '', patients: [patient()], witnesses: [], signatures: [], photos: [], ...over });
const rules = (type, items) => ({ ...RQ.emptyRules(), [type]: items });

test('every starting setup is valid for every kind of case', () => {
  for (const p of RQ.PRESETS) {
    const r = RQ.presetRules(p.key);
    for (const t of RQ.TYPE_KEYS) assert.ok(Object.keys(r[t]).length > 0, `${p.key} has rules for ${t}`);
    // patient fields only on patient care cases
    for (const t of ['lost_person', 'equipment', 'conduct', 'other']) assert.ok(Object.keys(r[t]).every((id) => id.startsWith('case.')), `${p.key} ${t} has no patient fields`);
  }
  assert.equal(RQ.PRESETS.find((p) => p.key === 'insurer').draft, true);
});

test('clean refuses unknown items, levels and conditions, and drops off and locked items', () => {
  assert.throws(() => RQ.clean({ injury: { 'patient.nope': { level: 'submit' } } }), /Unknown item/);
  assert.throws(() => RQ.clean({ injury: { 'patient.phone': { level: 'maybe' } } }), /Unknown level/);
  assert.throws(() => RQ.clean({ injury: { 'patient.phone': { level: 'submit', when: ['moon'] } } }), /Unknown condition/);
  assert.throws(() => RQ.clean({ lost_person: { 'patient.phone': { level: 'submit' } } }), /Unknown item/);
  const r = RQ.clean({ injury: { 'patient.phone': { level: 'off' }, 'patient.name': { level: 'submit' }, 'patient.age': { level: 'approve', when: ['minor', 'minor'] } } });
  assert.deepEqual(r.injury, { 'patient.age': { level: 'approve', when: ['minor'] } });
  // a patient condition is dropped for a kind of case without patients
  assert.deepEqual(RQ.clean({ other: { 'case.narrative': { level: 'submit', when: ['minor', 'serious'] } } }).other, { 'case.narrative': { level: 'submit', when: ['serious'] } });
});

test('a required field shows as met once answered, or once answered N/A with a reason', () => {
  const r = rules('injury', { 'patient.phone': { level: 'submit' }, 'case.narrative': { level: 'approve' } });
  let items = RQ.evaluate(r, caseOf());
  assert.deepEqual(items.map((i) => [i.id, i.met, i.level]), [['patient.phone', false, 'submit'], ['case.narrative', false, 'approve']]);
  assert.equal(RQ.summary(items).submit_left, 1);
  assert.equal(RQ.summary(items).approve_left, 1);
  items = RQ.evaluate(r, caseOf({ narrative: 'Fell on the lower bowl', patients: [patient({ phone: '555-0100' })] }));
  assert.ok(items.every((i) => i.met));
  items = RQ.evaluate(r, caseOf({ patients: [patient({ na: JSON.stringify({ phone: { reason: 'declined' } }) })] }));
  assert.equal(items[0].met, true);
  assert.equal(items[0].na.reason, 'declined');
});

test('only when: the rule applies only to cases or patients that match', () => {
  const r = rules('injury', { 'patient.handoff_to': { level: 'submit', when: ['transported'] }, 'case.photos': { level: 'submit', when: ['serious'] } });
  assert.equal(RQ.evaluate(r, caseOf()).length, 0);
  const items = RQ.evaluate(r, caseOf({ severity: 'serious', patients: [patient({ disposition: 'transported_ambulance' }), patient({ id: 12, first_name: 'Ben' })] }));
  assert.deepEqual(items.map((i) => [i.id, i.patient_id]), [['patient.handoff_to', 11], ['case.photos', null]]);
});

test('conditions are worked out from answers already on the report', () => {
  const c = caseOf({ category: 'injury', form: { incident_location: 'lift_incident' } });
  const kid = patient({ age_years: null, date_of_birth: '2010-06-01', form: { equipment: 'area_rental', patient_type: 'staff_work', collided: 'yes' }, disposition: 'refused_care' });
  for (const k of ['minor', 'rental', 'staff', 'collision', 'refused']) assert.equal(RQ.conditionHolds(k, c, kid), true, k);
  assert.equal(RQ.conditionHolds('lift', c, patient()), true, 'lift from the incident location');
  assert.equal(RQ.conditionHolds('transported', c, kid), false);
  assert.equal(RQ.conditionHolds('minor', c, patient({ age_years: 18 })), false);
  assert.equal(RQ.ageOf({ date_of_birth: '2008-01-11' }, '2026-01-10'), 17);
  assert.equal(RQ.ageOf({ date_of_birth: '2008-01-10' }, '2026-01-10'), 18);
});

test('a field that depends on another answer is only checked when it applies', () => {
  const r = rules('injury', { 'patient.ambulance_code': { level: 'submit' } });
  assert.equal(RQ.evaluate(r, caseOf()).length, 0);
  assert.equal(RQ.evaluate(r, caseOf({ patients: [patient({ form: { from_base: 'ambulance' } })] })).length, 1);
});

test('witnesses, signatures and the extras count the right things', () => {
  const r = rules('collision', { 'case.witnesses': { level: 'submit' }, 'case.patroller_signature': { level: 'submit' }, 'case.collision_report': { level: 'submit' }, 'case.photos': { level: 'approve' } });
  let items = RQ.evaluate(r, caseOf({ category: 'collision' }));
  assert.equal(items.filter((i) => !i.met).length, 4);
  items = RQ.evaluate(r, caseOf({ category: 'collision', form: { witnesses_none: true }, signatures: [{ kind: 'patroller', patient_id: null }], collision: { id: 1 }, photos: [{ id: 1, voided_at: null }] }));
  assert.ok(items.every((i) => i.met));
  // a photo entered in error does not count
  items = RQ.evaluate(r, caseOf({ category: 'collision', photos: [{ id: 1, voided_at: '2026-01-10 11:00:00' }] }));
  assert.equal(items.find((i) => i.key === 'photos').met, false);
});

test('an approved exception no longer counts against approval', () => {
  const r = rules('injury', { 'patient.phone': { level: 'approve' } });
  const items = RQ.evaluate(r, caseOf(), { exceptions: [{ scope: 'patient', key: 'phone', patient_id: 11 }] });
  assert.equal(items[0].exception, true);
  assert.equal(RQ.summary(items).approve_left, 0);
});

test('other kinds of case use their own list', () => {
  const r = { ...RQ.emptyRules(), injury: { 'case.narrative': { level: 'submit' } }, lost_person: { 'case.witnesses': { level: 'submit' } } };
  assert.deepEqual(RQ.evaluate(r, caseOf({ category: 'lost_person', patients: [] })).map((i) => i.id), ['case.witnesses']);
  assert.ok(RQ.itemsFor('lost_person').every((i) => i.scope === 'case'));
  assert.ok(!RQ.itemsFor('injury').some((i) => i.key === 'collision_report'));
});

test('the preview lists what a starting setup would change', () => {
  const before = rules('injury', { 'patient.phone': { level: 'submit' } });
  const after = rules('injury', { 'patient.phone': { level: 'approve' }, 'case.narrative': { level: 'submit' } });
  const d = RQ.diff(before, after);
  assert.deepEqual(d.map((x) => [x.id, x.from.level, x.to.level]), [['patient.phone', 'submit', 'approve'], ['case.narrative', 'off', 'submit']]);
});

test('N/A is never allowed for what the form always needs', () => {
  assert.equal(RQ.naAllowed('injury', 'patient.name'), false);
  assert.equal(RQ.naAllowed('injury', 'case.location'), false);
  assert.equal(RQ.naAllowed('injury', 'patient.phone'), true);
});
