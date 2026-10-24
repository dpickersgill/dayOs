'use strict';

// The incident form, following the National Ski Area Accident Report (NSAAR) form and its review guide.
//
// One registry describes every field: where it lives, how it is validated, how the screen draws it, and
// whether a mountain's patrol administrator has made it mandatory. The server and the screens both read it,
// so a field added here shows up everywhere, including the "required" switches.
//
// scope 'case'    = one value per incident (location, conditions, witnesses, sign-off)
// scope 'patient' = one value per patient on the incident (the NSAAR is filled in per patient)
// col             = the field already has its own database column (older reports keep working);
//                   every other field is stored in the case's or patient's `form` JSON.
const { z } = require('zod');

const opts = (...pairs) => pairs.map((p) => (Array.isArray(p) ? { value: p[0], label: p[1] } : { value: p, label: p.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) }));
const UNK = [['unknown', 'Unknown'], ['na', 'N/A']];

const SECTIONS = [
  { id: 'patient', scope: 'patient', title: 'Patient', note: 'A name is of utmost importance. If the patient is unconscious or unresponsive, make every effort to find it out. A date of birth is often the only way to find a patient later. Where something is unknown or does not apply, enter N/A rather than leaving it blank.' },
  { id: 'complaint', scope: 'patient', title: 'Complaint and treatment protocol', note: 'Mark L, R or B (both) for each body part. Name the protocol that first aid was applied to, for example a lower leg splint for a suspected fracture is Fracture. If a spine fracture is suspected, the protocol must match.' },
  { id: 'assessment', scope: 'patient', title: 'Assessment', show: 'always', note: 'The primary survey, and the questions for a medical call. These are usually filled in from the Care tab while you work.' },
  { id: 'head', scope: 'patient', title: 'Head injury', show: 'head', note: 'Ask every patient with a blow to the head. Repeat the questions at each set of vitals: a change matters more than one answer.' },
  { id: 'spine', scope: 'patient', title: 'Spine', show: 'spine', note: 'Record the answers your protocol uses to decide on spinal motion restriction.' },
  { id: 'first_aid', scope: 'patient', title: 'First aid', note: 'Record first aid at the scene and at the aid room, with times. Vital signs, injuries and treatments are logged in the bedside card at the top of the patient (tick the box below when you use it). Any medication given by staff or EMS goes here.' },
  { id: 'arrest', scope: 'patient', title: 'Cardiac arrest', show: 'arrest', note: 'CPR, pads, shocks and a returning pulse are logged with times from the arrest log on the Care tab.' },
  { id: 'witness', scope: 'case', title: 'Witnesses', note: 'Eye witness reports are essential. Take names and contact details so they can be reached later. Write statements in the witness\'s own words and do not lead them.' },
  { id: 'location', scope: 'case', title: 'Location of accident', note: 'Use a GPS fix if you have one. Without one, measure from fixed objects nearby.' },
  { id: 'activity', scope: 'patient', title: 'Activity and experience' },
  { id: 'conditions', scope: 'case', title: 'Conditions', note: 'Use general conditions at the site, especially if the run was groomed. If the incident was reported later, choose Unknown. Choose N/A for incidents indoors.' },
  { id: 'equipment', scope: 'patient', title: 'Equipment and ability' },
  { id: 'cause', scope: 'patient', title: 'Collision or cause' },
  { id: 'transport', scope: 'patient', title: 'Transport' },
  { id: 'refusal', scope: 'patient', title: 'Refusal of care', note: 'Complete this when the patient declines some or all care. The signed refusal is collected from the bedside card.' },
  { id: 'signoff', scope: 'case', title: 'Sign off', note: 'The patroller completing the form must print legibly and sign. This form may be used as a legal document, and the completing patroller may be asked to give evidence about it.' },
];

const CAUSES = [
  { group: 'Non-collision', items: [['fall_lost_control', 'Fall, skier lost control'], ['fall_caught_edge', 'Fall, caught an edge'], ['fall_own_equipment', 'Fall and struck by own equipment'], ['fall_jumping', 'Fall, jumping'], ['fall_conditions', 'Fall, change of conditions'], ['fall_terrain', 'Fall, change of terrain'], ['near_collision', 'Near collision with (say who or what)'], ['prior_medical', 'Prior medical condition'], ['skied_off_trail', 'Skied off trail'], ['equipment_failure', 'Equipment failure (not binding)'], ['binding_pre_released', 'Binding pre-released'], ['hit_by_equipment', 'Hit by other\'s equipment']] },
  { group: 'Lift related', items: [['lift_clothing', 'Clothing caught on lift'], ['lift_fall_loading', 'Fall while loading'], ['lift_fall_unloading', 'Fall while unloading'], ['lift_fall_from', 'Fall from lift'], ['lift_jump_chair', 'Jump chair lift'], ['lift_restraint_bar', 'Injured by restraining bar'], ['lift_struck_chair', 'Struck by chair']] },
  { group: 'Non-skiing related', items: [['non_ski_slip_fall', 'Slip and fall (non-skiing)'], ['non_ski_cold', 'Cold or weather related'], ['non_ski_unclassified', 'Not otherwise classified'], ['non_ski_other', 'Other (say what)']] },
];
const CAUSE_VALUES = CAUSES.flatMap((g) => g.items.map((i) => i[0]));

const BODY_SIDED = [['foot', 'Foot'], ['ankle', 'Ankle'], ['lower_leg', 'Lower leg'], ['knee', 'Knee'], ['thigh', 'Thigh'], ['hip', 'Hip'], ['lower_ab', 'Lower abdomen'], ['upper_ab', 'Upper abdomen'], ['chest', 'Chest'], ['neck', 'Neck'], ['clavicle', 'Clavicle'], ['shoulder', 'Shoulder'], ['upper_arm', 'Upper arm'], ['elbow', 'Elbow'], ['lower_arm', 'Lower arm'], ['wrist', 'Wrist'], ['hand', 'Hand'], ['thumb', 'Thumb'], ['finger', 'Finger']];
const BODY_PLAIN = [['upper_back', 'Upper back'], ['lower_back', 'Lower back'], ['tailbone', 'Tailbone'], ['head', 'Head'], ['face', 'Face'], ['medical', 'Medical'], ['no_injury', 'No injury']];

// type: text | longtext | date | time | number | tel | email | select | multi | check | yesno | measure | bodymap | trail | gps | signature | witnesses
// locked 'always' = the report cannot exist without it; locked 'never' = a helper tick box that cannot be made mandatory.
const F = [];
const add = (scope, section, key, label, type, more = {}) => F.push({ key, scope, section, label, type, ...more });
const YN = [['yes', 'Yes'], ['no', 'No']];

// ---- patient
add('patient', 'patient', 'name', 'Name', 'name', { locked: 'always', hint: 'First and last name' });
add('patient', 'patient', 'accommodation', 'Visitor local accommodation', 'text');
add('patient', 'patient', 'address', 'Home address', 'text');
add('patient', 'patient', 'city', 'City', 'text', { col: 'home_town' });
add('patient', 'patient', 'region', 'Province or state', 'text');
add('patient', 'patient', 'postal', 'Postal or zip code', 'text');
add('patient', 'patient', 'phone', 'Phone', 'tel', { col: 'phone', hint: 'Needed to follow up with the patient later' });
add('patient', 'patient', 'student_program', 'If a student, in a school ski program?', 'select', { options: opts(...YN, ['na', 'N/A']) });
add('patient', 'patient', 'occupation', 'Occupation or school group', 'text');
add('patient', 'patient', 'date_of_birth', 'Date of birth', 'date', { col: 'date_of_birth' });
add('patient', 'patient', 'age', 'Age', 'number', { col: 'age_years', min: 0, max: 120, hint: 'Worked out from the date of birth if you leave it blank' });
add('patient', 'patient', 'gender', 'Gender', 'select', { col: 'sex', options: opts(['female', 'Female'], ['male', 'Male'], ['other', 'Other'], ['unknown', 'Unknown']), noBlank: false });
add('patient', 'patient', 'height', 'Height', 'measure', { units: ['cm', 'in'] });
add('patient', 'patient', 'weight', 'Weight', 'measure', { units: ['kg', 'lb'], hint: 'Needed for a child\'s medication dose' });
add('patient', 'patient', 'patient_type', 'Patient type', 'select', { options: opts('guest', ['staff_work', 'Staff member, on duty'], ['staff_off', 'Staff member, off duty'], ['volunteer_work', 'Volunteer, on duty'], 'unknown'), hint: 'On duty: the owner and GM are told, and it is not counted as a guest injury. Off duty: stays a guest case; the owner is told.' });
add('patient', 'patient', 'ticket_type', 'Ticket type', 'select', { options: opts(['day', 'Day ticket'], ['multi_day', 'Multi-day ticket'], ['season_pass', 'Season pass'], ['other_pass', 'Other pass'], ['na', 'Not applicable'], 'unknown'), hint: 'Resorts define members in their own ways: night pass, terrain park pass, and so on' });
add('patient', 'patient', 'description', 'Patient\'s description of the incident', 'longtext', { hint: 'In the patient\'s own words. Ask: where were you skiing or riding, how fast, and were you in control? "Fell while skiing. Broken leg." is too little; "I was riding down the spillway real fast, lost control, caught an edge and slid with my hands in front of me" is good.' });
add('patient', 'patient', 'description_signed_by', 'Description signed by', 'select', { options: opts('patient', 'parent', 'guardian') });
add('patient', 'patient', 'patient_signature', 'Patient signature', 'signature', { kind: 'patient_acknowledgment', hint: 'Collect it under Signatures' });
add('patient', 'patient', 'signs_symptoms', 'Signs and symptoms recorded by the patroller or doctor', 'longtext', { col: 'assessment', hint: 'Record what is observed and what is not. Good: "C/O pain midshaft R tibia. Redness and minor swelling anterior R tibia. Point tenderness on palpation. Unwilling to bear weight." Also note what is absent, for example "no swelling, able to bear weight". Say whether a primary (P) or secondary (P/S) survey was done.' });
add('patient', 'patient', 'refusal_initials', 'Patient or guardian initials, if treatment is refused', 'text', { when: { field: 'disposition', equals: 'refused_care' }, hint: 'Required by the form when treatment is refused' });
add('patient', 'patient', 'recurrence', 'Recurrence of a previous injury?', 'select', { options: opts(...YN, ['unknown', 'Unknown']) });
add('patient', 'patient', 'last_meal', 'Time of last meal', 'text', { col: 'last_oral_intake' });
add('patient', 'patient', 'allergies', 'Allergies', 'text', { col: 'allergies', none: true });
add('patient', 'patient', 'medications', 'Medications', 'text', { col: 'medications', none: true });
add('patient', 'patient', 'medic_alert', 'Medic Alert', 'select', { options: opts(...YN) });
add('patient', 'patient', 'medical_history', 'Related medical history', 'text', { col: 'medical_history', none: true });
add('patient', 'patient', 'drugs_alcohol', 'Drugs or alcohol', 'text', { hint: 'Note if either is admitted to by the patient', none: true });

// ---- complaint
add('patient', 'complaint', 'chief_complaint', 'Chief complaint', 'text', { col: 'chief_complaint', defaultRequired: true, hint: 'The main problem, in the patient\'s words. If there is more than one injury, put the main one first. It also becomes the case summary.' });
add('patient', 'complaint', 'body_parts', 'Body parts injured', 'bodymap');
add('patient', 'complaint', 'treatment_protocol', 'Treatment protocol', 'multi', { options: opts('fracture', 'sprain', 'strain', 'bruise', 'laceration', 'dislocation', 'cardiac', 'stroke', 'concussion', 'hypothermia', 'frostbite', 'internal', 'illness', 'deceased', 'unknown', ['na', 'N/A']) });
add('patient', 'complaint', 'other_treatment', 'Other treatment', 'text');

// ---- assessment
const AV = [['alert', 'Alert'], ['verbal', 'Responds to voice'], ['pain', 'Responds to pain'], ['unresponsive', 'Unresponsive']];
add('patient', 'assessment', 'ps_time', 'Primary survey time (24 hour)', 'time');
add('patient', 'assessment', 'ps_bleeding', 'Bleeding', 'select', { options: opts(['none', 'No major bleeding'], ['controlled', 'Major bleeding, controlled'], ['uncontrolled', 'Major bleeding, not controlled']) });
add('patient', 'assessment', 'ps_airway', 'Airway', 'select', { options: opts(['clear', 'Clear'], ['managed', 'Opened or managed'], ['obstructed', 'Obstructed']) });
add('patient', 'assessment', 'ps_breathing', 'Breathing', 'select', { options: opts(['adequate', 'Adequate'], ['laboured', 'Laboured'], ['inadequate', 'Inadequate or absent']) });
add('patient', 'assessment', 'ps_circulation', 'Circulation', 'select', { options: opts(['normal', 'Pulse present, skin normal'], ['poor', 'Weak pulse or poor perfusion'], ['absent', 'No pulse']) });
add('patient', 'assessment', 'ps_disability', 'Disability (responsiveness)', 'select', { options: opts(...AV) });
add('patient', 'assessment', 'opqrst_onset', 'Onset: what were you doing when it started?', 'text');
add('patient', 'assessment', 'opqrst_provokes', 'Provokes: what makes it better or worse?', 'text');
add('patient', 'assessment', 'opqrst_quality', 'Quality: what does it feel like?', 'text');
add('patient', 'assessment', 'opqrst_region', 'Region and radiation: where, and does it spread?', 'text');
add('patient', 'assessment', 'opqrst_severity', 'Severity (0 to 10)', 'number', { min: 0, max: 10 });
add('patient', 'assessment', 'opqrst_time', 'Time: when did it start, has it changed?', 'text');
add('patient', 'assessment', 'stroke_face', 'Stroke check: face', 'select', { options: opts(['normal', 'Both sides move the same'], ['droop', 'One side droops']) });
add('patient', 'assessment', 'stroke_arm', 'Stroke check: arms', 'select', { options: opts(['normal', 'Both arms stay up'], ['drift', 'One arm drifts down']) });
add('patient', 'assessment', 'stroke_speech', 'Stroke check: speech', 'select', { options: opts(['normal', 'Clear'], ['abnormal', 'Slurred, wrong words or none']) });
add('patient', 'assessment', 'stroke_last_well', 'Last known well (24 hour)', 'time');

// ---- head injury
const YNU = [['yes', 'Yes'], ['no', 'No'], ['unknown', 'Unknown']];
add('patient', 'head', 'head_loc', 'Lost consciousness', 'select', { options: opts(...YNU) });
add('patient', 'head', 'head_loc_minutes', 'For about how many minutes', 'number', { min: 0, max: 600, when: { field: 'head_loc', equals: 'yes' } });
add('patient', 'head', 'head_amnesia_before', 'Cannot remember what happened before', 'select', { options: opts(...YNU) });
add('patient', 'head', 'head_amnesia_after', 'Cannot remember what happened after', 'select', { options: opts(...YNU) });
add('patient', 'head', 'head_repeating', 'Asking the same questions again', 'select', { options: opts(...YN) });
add('patient', 'head', 'head_vomiting', 'Vomiting', 'select', { options: opts(...YN) });
add('patient', 'head', 'head_vomit_count', 'How many times', 'number', { min: 0, max: 50, when: { field: 'head_vomiting', equals: 'yes' } });
add('patient', 'head', 'head_headache', 'Headache', 'select', { options: opts(...YN) });
add('patient', 'head', 'head_seizure', 'Seizure', 'select', { options: opts(...YN) });
add('patient', 'head', 'head_helmet_damage', 'Helmet damaged', 'select', { options: opts(...YN, ['na', 'No helmet']) });
add('patient', 'head', 'return_cleared_note', 'Cleared to return to skiing by (name and reason)', 'text', { hint: 'Only when someone with the authority cleared a patient with head injury signs to ski again' });

// ---- spine
add('patient', 'spine', 'spine_mechanism', 'Dangerous mechanism (high speed, fall from height, axial load)', 'select', { options: opts(...YN) });
add('patient', 'spine', 'spine_midline', 'Tender in the middle of the neck or back', 'select', { options: opts(...YN) });
add('patient', 'spine', 'spine_neuro', 'Numbness, tingling or weakness', 'select', { options: opts(...YN) });
add('patient', 'spine', 'spine_alert', 'Alert, oriented and reliable', 'select', { options: opts(...YN) });
add('patient', 'spine', 'spine_intox', 'Alcohol or drugs', 'select', { options: opts(...YN) });
add('patient', 'spine', 'spine_distracting', 'A painful injury that could distract from neck pain', 'select', { options: opts(...YN) });
add('patient', 'spine', 'spine_decision', 'Decision', 'select', { options: opts(['smr', 'Spinal motion restriction applied'], ['not_indicated', 'Not indicated by the criteria'], ['declined', 'Patient declined']) });

// ---- cardiac arrest
add('patient', 'arrest', 'arrest_time_down', 'Time down (24 hour)', 'time', { hint: 'When the patient collapsed, or your best estimate' });
add('patient', 'arrest', 'arrest_witnessed', 'Collapse', 'select', { options: opts(['witnessed', 'Witnessed'], ['unwitnessed', 'Not witnessed']) });
add('patient', 'arrest', 'arrest_bystander_cpr', 'CPR by a bystander before patrol arrived', 'select', { options: opts(...YN) });
add('patient', 'arrest', 'arrest_outcome', 'Outcome of the resuscitation', 'select', { options: opts(['rosc', 'Pulse returned'], ['ongoing', 'CPR continuing at hand-off'], ['stopped', 'Resuscitation stopped']) });

// ---- first aid
add('patient', 'first_aid', 'scene_on', 'At scene: on scene (24 hour)', 'time');
add('patient', 'first_aid', 'scene_transported', 'At scene: transported (24 hour)', 'time');
add('patient', 'first_aid', 'fa_scene', 'First aid at the scene', 'longtext', { hint: 'Treatments with times' });
add('patient', 'first_aid', 'base_in', 'Base or clinic: in (24 hour)', 'time');
add('patient', 'first_aid', 'base_out', 'Base or clinic: out (24 hour)', 'time');
add('patient', 'first_aid', 'fa_base', 'First aid at the base or clinic', 'longtext');
add('patient', 'first_aid', 'fa_attached', 'Additional first aid details attached', 'check', { hint: 'Tick if vitals or other details are recorded in the bedside card for this patient' });
add('patient', 'first_aid', 'medication_text', 'Medication administered', 'text', { none: true });
add('patient', 'first_aid', 'medication_time', 'Medication time (24 hour)', 'time');
add('patient', 'first_aid', 'medication_by', 'Medication given by', 'text', { hint: 'Signed by the person giving it. If you cannot get a signature, say who gave it.' });

// ---- witnesses (case)
add('case', 'witness', 'witnesses', 'At least one witness', 'witnesses', { hint: 'Add witnesses below, or tick "No witnesses"' });
add('case', 'witness', 'witnesses_none', 'No witnesses', 'check', { locked: 'never' });

// ---- location (case)
add('case', 'location', 'trail_id', 'Run', 'trail', { col: 'trail_id' });
add('case', 'location', 'map_grid', 'Map or grid coordinates', 'text');
add('case', 'location', 'gps', 'GPS', 'gps', { col: 'gps_lat', hint: 'Complete this if the patroller has a GPS' });
add('case', 'location', 'location', 'Exact location', 'text', { col: 'location', locked: 'always' });
add('case', 'location', 'incident_location', 'Incident location', 'select', { options: opts(['marked_run', 'Marked run (run is posted)'], ['freestyle_terrain', 'Freestyle terrain (posted as freestyle)'], ['terrain_rail_park', 'Terrain or rail park'], ['competition_terrain', 'Competition terrain (active competition)'], ['half_pipe', 'Half pipe'], ['out_of_bounds', 'Out of bounds'], ['closed_inbounds', 'Closed inbounds'], ['off_trail', 'Off trail (inside the boundary)'], ['lift_incident', 'Lift incident'], ['premises', 'Premises (indoors, deck, walkway, parking lot)'], 'unknown', ['na', 'N/A']) });
add('case', 'location', 'park_feature', 'Park feature name, number and size', 'text', { when: { field: 'incident_location', in: ['freestyle_terrain', 'terrain_rail_park', 'half_pipe'] }, hint: 'Ask the terrain park supervisor. Do not guess.' });
add('case', 'location', 'run_classification', 'Run classification', 'select', { options: opts(['easiest', 'Easiest (green circle)'], ['more_difficult', 'More difficult (blue square)'], ['most_difficult', 'Most difficult (black diamond)'], ['extreme', 'Extreme (double black diamond)'], ['na', 'N/A']) });

// ---- activity (patient)
add('patient', 'activity', 'activity', 'Activity', 'select', { options: opts('alpine', 'snowboard', 'telemark', 'nordic', 'touring', 'tubing', ['non_skiing', 'Non-skiing'], 'other') });
add('patient', 'activity', 'activity_other', 'Other activity', 'text', { when: { field: 'activity', equals: 'other' } });
add('patient', 'activity', 'involvement', 'Involvement', 'select', { options: opts(['rec_ski_ride', 'Recreation skiing or riding'], ['rec_jumping', 'Recreation jumping'], 'competition', 'training', ['in_lesson', 'In lesson (circle SB or ski)'], ['tube_slide', 'Tube slide'], ['terrain_park_feature', 'Terrain park feature'], 'unknown', 'other') });
add('patient', 'activity', 'involvement_other', 'Other involvement', 'text', { when: { field: 'involvement', equals: 'other' } });
add('patient', 'activity', 'days_area', 'Days skied or ridden this year at this area', 'number', { min: 0, max: 400 });
add('patient', 'activity', 'days_all', 'Days skied or ridden this year at all areas', 'number', { min: 0, max: 400 });
add('patient', 'activity', 'times_run', 'Times skied or ridden this run or lift before', 'number', { min: 0, max: 100000 });
add('patient', 'activity', 'times_when', 'When', 'text');

// ---- conditions (case)
add('case', 'conditions', 'weather', 'Weather', 'select', { options: opts(['clear', 'Clear (clear sky or some clouds)'], ['overcast', 'Overcast'], ['snowing', 'Snowing'], ['raining', 'Raining'], ['fog', 'Fog'], ...UNK) });
add('case', 'conditions', 'light', 'Light', 'select', { options: opts(['sharp', 'Sharp (distinct shadows)'], ['flat', 'Flat (shadows not distinct)'], ['whiteout', 'Whiteout (hard to judge depth)'], ['lights', 'Lights (night lights)'], ['dark', 'Dark (no lighting)'], ...UNK) });
add('case', 'conditions', 'temperature', 'Temperature', 'select', { options: opts(['above_10', 'Above 10 °C (above 50 °F)'], ['0_to_10', '0 to 10 °C (32 to 50 °F)'], ['minus10_to_0', '-10 to 0 °C (14 to 32 °F)'], ['minus20_to_minus11', '-20 to -11 °C (-4 to 12 °F)'], ['below_minus20', 'Below -20 °C (below -4 °F)'], ...UNK) });
add('case', 'conditions', 'snow', 'New snow, last 24 hours', 'select', { options: opts(['none', 'No new snow'], ['0_to_5', '0 to 5 cm (0 to 2 in)'], ['5_to_10', '5 to 10 cm (2 to 4 in)'], ['10_to_15', '10 to 15 cm (4 to 6 in)'], ['over_15', 'Over 15 cm (over 6 in)'], ...UNK) });
add('case', 'conditions', 'surface', 'Surface', 'select', { options: opts(['groomed', 'Groomed'], ['moguls', 'Moguls'], ['powder', 'Powder (new snow on the old surface)'], ['variable', 'Variable (slush or cut-up powder)'], ['granular', 'Granular (corn snow)'], ['hard', 'Hard (resists poles and edges)'], ...UNK) });

// ---- equipment and ability (patient)
add('patient', 'equipment', 'equipment', 'Equipment', 'select', { options: opts('owned', ['area_rental', 'Area rental'], ['other_rental', 'Other rental'], ['area_demos', 'Area demos'], ['other_demos', 'Other demos'], ...UNK) });
add('patient', 'equipment', 'binding_release', 'Binding release', 'select', { options: opts('none', ['left_only', 'Left only'], ['right_only', 'Right only'], 'both', ['pre_released', 'Pre-released'], ...UNK) });
add('patient', 'equipment', 'rental_boot', 'Rental boot number', 'text');
add('patient', 'equipment', 'rental_ski', 'Rental ski number', 'text');
add('patient', 'equipment', 'helmet', 'Helmet', 'select', { options: opts('owned', 'rental', 'none', 'unknown') });
add('patient', 'equipment', 'lesson', 'Lesson', 'select', { options: opts('never', ['this_year', 'This year'], ['years_ago', 'Years ago']) });
add('patient', 'equipment', 'lesson_years', 'How many years ago', 'number', { min: 0, max: 80, when: { field: 'lesson', equals: 'years_ago' } });
add('patient', 'equipment', 'ability', 'Ability', 'select', { options: opts('beginner', 'novice', 'intermediate', 'advanced', 'expert', 'unknown', ['na', 'N/A']) });

// ---- collision or cause (patient)
add('patient', 'cause', 'collided', 'Did the patient collide with a person or object?', 'select', { options: opts(...YN) });
add('patient', 'cause', 'collision_description', 'If yes, describe', 'text', { when: { field: 'collided', equals: 'yes' } });
add('patient', 'cause', 'cause', 'If not a collision, the primary cause of the incident', 'select', { groups: CAUSES, options: CAUSE_VALUES.map((v) => ({ value: v, label: CAUSES.flatMap((g) => g.items).find((i) => i[0] === v)[1] })), when: { field: 'collided', equals: 'no' } });
add('patient', 'cause', 'cause_detail', 'Say who or what, or what else', 'text', { when: { field: 'cause', in: ['near_collision', 'non_ski_other'] } });

// ---- transport (patient)
add('patient', 'transport', 'to_first_aid', 'To first aid', 'select', { options: opts(['walk_ski', 'Walk or ski'], 'toboggan', 'snowmobile', 'helicopter', ['download', 'Download (chair or gondola)'], ['on_hill', 'On-hill (treated at the site)'], 'other', 'unknown', ['na', 'N/A (refused treatment)']) });
add('patient', 'transport', 'from_base', 'From base', 'select', { options: opts(['private_car_taxi', 'Private car or taxi'], ['company', 'Company vehicle'], 'ambulance', 'bus', 'helicopter', ['walk_ski', 'Walk or ski'], 'other', 'unknown', ['na', 'N/A']) });
add('patient', 'transport', 'ambulance_code', 'Attending ambulance number and code', 'text', { when: { field: 'from_base', equals: 'ambulance' } });
add('patient', 'transport', 'destination_type', 'Destination', 'select', { options: opts('home', 'doctor', 'hospital', 'clinic', 'hotel', ['return_to_ski', 'Return to ski'], 'rest', 'other', 'unknown', ['na', 'N/A']) });
add('patient', 'transport', 'hospital_name', 'Name of the facility en route to', 'text', { when: { field: 'destination_type', in: ['hospital', 'clinic', 'doctor'] } });
add('patient', 'transport', 'handoff_to', 'Care handed to (name and unit)', 'text', { hint: 'The paramedic, nurse or doctor who took over, and their unit or facility' });
add('patient', 'transport', 'handoff_time', 'Hand-off time (24 hour)', 'time');
add('patient', 'transport', 'disposition', 'Outcome', 'select', { col: 'disposition', defaultRequired: true, options: opts('treated_released', 'transported_ambulance', 'transported_private', 'refused_care', 'no_injury', 'referred', 'other') });

// ---- refusal of care (patient)
add('patient', 'refusal', 'refusal_scope', 'What was refused', 'select', { when: { field: 'disposition', equals: 'refused_care' }, options: opts(['all_care', 'All care'], ['transport', 'Transport to higher care'], ['some_treatment', 'Some treatment'], ['further_evaluation', 'Further evaluation']) });
add('patient', 'refusal', 'refusal_capacity', 'Patient alert and able to decide', 'select', { when: { field: 'disposition', equals: 'refused_care' }, options: opts(...YN) });
add('patient', 'refusal', 'refusal_capacity_note', 'How you judged they could decide', 'text', { when: { field: 'disposition', equals: 'refused_care' }, hint: 'Needed when drugs or alcohol, loss of consciousness, amnesia or a GCS under 15 is recorded. For example: "Oriented to person, place, time; repeated back the risks."' });
add('patient', 'refusal', 'refusal_risks_explained', 'Risks explained, including that the condition could worsen', 'select', { when: { field: 'disposition', equals: 'refused_care' }, options: opts(...YN) });
add('patient', 'refusal', 'refusal_reason', 'Reason given for refusing', 'text', { when: { field: 'disposition', equals: 'refused_care' } });
add('patient', 'refusal', 'refusal_advice', 'Advice given about when to seek care', 'text', { when: { field: 'disposition', equals: 'refused_care' } });
add('patient', 'refusal', 'refusal_care_offered', 'Care and transport offered', 'longtext', { when: { field: 'disposition', equals: 'refused_care' }, hint: 'What you offered, in plain words: for example "Splint, ambulance transport to hospital for an X-ray"' });
add('patient', 'refusal', 'refusal_signer', 'Who signs the refusal', 'select', { when: { field: 'disposition', equals: 'refused_care' }, options: opts(['patient', 'The patient'], ['guardian', 'A parent or guardian']), hint: 'A parent or guardian signs for anyone under 18' });
add('patient', 'refusal', 'refusal_guardian_name', 'Parent or guardian name', 'text', { when: { field: 'refusal_signer', equals: 'guardian' } });
add('patient', 'refusal', 'refusal_guardian_relation', 'Relationship to the patient', 'text', { when: { field: 'refusal_signer', equals: 'guardian' } });
add('patient', 'refusal', 'refusal_witness', 'Witness to the refusal (name)', 'text', { when: { field: 'disposition', equals: 'refused_care' } });

// ---- sign off (case)
add('case', 'signoff', 'completed_by_name', 'Form completed by (print)', 'text');
add('case', 'signoff', 'completed_by_number', 'Patroller number', 'text', { hint: 'Your patrol number. The mountain keeps a record of which number belongs to whom.' });
add('case', 'signoff', 'patroller_signature', 'Patroller signature', 'signature', { kind: 'patroller', hint: 'Collect it under Signatures' });

const FIELDS = F;
const BY_KEY = (scope) => new Map(FIELDS.filter((f) => f.scope === scope).map((f) => [f.key, f]));

function valueSchema(f) {
  switch (f.type) {
    case 'text': return z.string().max(300);
    case 'longtext': return z.string().max(20000);
    case 'tel': return z.string().max(40);
    case 'email': return z.string().email().max(255);
    case 'date': return z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    case 'time': return z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24 hour time, HH:MM');
    case 'number': return z.number().min(f.min ?? 0).max(f.max ?? 1e6);
    case 'check': return z.boolean();
    case 'select': return z.enum(f.options.map((o) => o.value));
    case 'multi': return z.array(z.enum(f.options.map((o) => o.value))).max(30);
    case 'measure': return z.union([z.string().max(300), z.object({ v: z.number().min(0).max(1000), u: z.enum(f.units) }).strict()]);
    case 'bodymap': return z.record(z.string(), z.enum(['L', 'R', 'B', 'X'])).refine((m) => Object.keys(m).every((k) => [...BODY_SIDED, ...BODY_PLAIN].some((p) => p[0] === k)), 'Unknown body part');
    default: return null;
  }
}

/** zod schema for the `form` object of a scope: only fields stored in the JSON, every value optional, null removes it. */
function formSchema(scope) {
  const shape = {};
  for (const f of FIELDS) {
    if (f.scope !== scope || f.col) continue;
    const s = valueSchema(f);
    if (s) shape[f.key] = s.nullable().optional();
  }
  return z.object(shape).strict();
}

const parseForm = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
};

/** Applies a form patch to the stored JSON: null removes a key. Returns the JSON text to store, or null when empty. */
function mergeForm(stored, patch) {
  const out = { ...parseForm(stored) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) || v === false;

/** Does a field's `when` condition hold for these values? */
function applies(f, values) {
  if (!f.when) return true;
  const v = values[f.when.field];
  if (f.when.equals !== undefined) return v === f.when.equals;
  if (f.when.in) return f.when.in.includes(v);
  return true;
}

/** What the screens need to draw the form. */
function describe() {
  return {
    sections: SECTIONS,
    fields: FIELDS.map(({ key, scope, section, label, type, options, groups, hint, when, col, locked, none, min, max, kind, defaultRequired, units }) => ({ key, scope, section, label, type, options, groups, hint, when, units, locked: locked || null, none: Boolean(none), min, max, kind, col: col || null, stored: col ? 'column' : 'form', defaultRequired: Boolean(defaultRequired) })),
    body: { sided: BODY_SIDED.map(([value, label]) => ({ value, label })), plain: BODY_PLAIN.map(([value, label]) => ({ value, label })) },
  };
}

module.exports = { FIELDS, SECTIONS, BY_KEY, formSchema, parseForm, mergeForm, isEmpty, applies, describe, BODY_SIDED, BODY_PLAIN };
