'use strict';

// Short tap-through checklists that keep a response on track. Each item is stamped with who ticked it and when.
// Scope "patient" lists belong to one patient, "case" lists to the whole case. The server only accepts known keys.
const LISTS = [
  {
    id: 'head_spine', scope: 'patient', title: 'Head or spine injury',
    when: 'Any fall with a head strike, neck or back pain, or a changed level of alertness.',
    items: [
      ['manual_stabilization', 'Manual head and neck stabilization started'],
      ['mechanism_considered', 'Mechanism of injury considered (speed, impact, helmet)'],
      ['neuro_checked', 'Movement and feeling checked in hands and feet'],
      ['gcs_recorded', 'Level of alertness (GCS or AVPU) recorded'],
      ['vitals_repeated', 'Vitals repeated at least every 5 minutes'],
      ['spine_motion_restricted', 'Spinal motion restriction applied if indicated'],
      ['ems_considered', 'Ambulance or higher care considered and decided'],
      ['concussion_sheet', 'Concussion take-home sheet given (if released)'],
    ],
  },
  {
    id: 'minor', scope: 'patient', title: 'Patient is a minor',
    when: 'The patient is under 18.',
    items: [
      ['guardian_contacted', 'Parent or guardian contacted'],
      ['guardian_details', 'Guardian name and phone recorded'],
      ['released_to_adult', 'Released only to a parent, guardian or named adult'],
      ['group_leader_told', 'Ski school or group leader told, if with a group'],
    ],
  },
  {
    id: 'collision', scope: 'case', title: 'Collision',
    when: 'A collision with another person, an object or a vehicle.',
    items: [
      ['parties_identified', 'Every person involved identified, or described if they left'],
      ['contact_exchanged', 'Contact details recorded for each party'],
      ['witnesses_taken', 'Witnesses found and statements taken'],
      ['scene_noted', 'Scene noted: impact point, signage, closures, conditions'],
      ['equipment_held', 'Damaged or relevant equipment tagged and held'],
      ['statements_separate', 'Statements taken from each party separately'],
      ['supervisor_notified', 'Patrol supervisor or risk manager notified'],
      ['police_considered', 'Police considered (serious injury, flight from scene, dispute)'],
    ],
  },
  {
    id: 'refusal', scope: 'patient', title: 'Patient refuses care or transport',
    when: 'The patient declines some or all of the care offered.',
    items: [
      ['capacity_assessed', 'Patient alert and able to make the decision'],
      ['risks_explained', 'Risks of refusing explained in plain words'],
      ['alternatives_offered', 'Alternatives offered (ambulance, doctor, aid room)'],
      ['advice_given', 'Advice given on when to seek care'],
      ['refusal_signed', 'Refusal form signed, and a witness recorded'],
    ],
  },
  {
    id: 'transport', scope: 'patient', title: 'Sending a patient to higher care',
    when: 'The patient is going to an ambulance, hospital or clinic.',
    items: [
      ['handoff_sheet', 'Hand-off sheet printed or read out'],
      ['allergies_confirmed', 'Allergies and medications confirmed with the receiving crew'],
      ['belongings_sent', 'Belongings and equipment accounted for'],
      ['contact_family', 'Family or companion told where the patient is going'],
      ['handoff_recorded', 'Hand-off recorded (who took over, and when)'],
    ],
  },
];

const KEYS = new Map(LISTS.map((l) => [l.id, new Set(l.items.map((i) => i[0]))]));
const allKeys = () => new Set(LISTS.flatMap((l) => l.items.map((i) => i[0])));
const valid = (key) => allKeys().has(key);

module.exports = { LISTS, KEYS, valid };
