'use strict';

// Short tap-through checklists that keep a response on track. Each item is stamped with who ticked it and when.
// Scope "patient" lists belong to one patient, "case" lists to the whole case. The server only accepts known keys.
//
// They are memory aids for documentation and scene management, written for trained patrollers (OEC level): never
// clinical instructions or doses. Protocols and the medical director's orders come first.
//
// Item keys are stored with every tick, so a key never changes meaning once it ships: reword a label if you must, but
// never reuse a key for a different action, and never rename one. Keys are unique across every list.
//
// Each list may say when it suggests itself on a case (`suggest`, read by the case screen):
//   categories      the case category (injury, collision, lost_person, equipment, medical, conduct, other)
//   collision       true: a collision is recorded on the case (the collision panel or a party)
//   case_form       { field: [values] } answers on the case's report form
//   attraction      the case happened at an attraction of one of these types (src/lib/attractions.js)
//   injury_types, body_regions, treatments, dispositions, patient_form { field: [values] }, minor (under 18):
//                   about one patient; a patient list is suggested for that patient, a case list once for the case.
// `start` says whether a list is switched on before the patrol admin chooses (Settings, Patrol, Checklists):
//   'on' (the default), 'avalanche' (on when the mountain does avalanche work) or 'attraction' (on when the mountain
//   has an attraction of a type the list is for).
const LISTS = [
  // ---------------------------------------------------------------- the original seven (keys unchanged)
  {
    id: 'head_spine', scope: 'patient', group: 'care', title: 'Head or spine injury',
    when: 'Any fall with a head strike, neck or back pain, or a changed level of alertness.',
    suggest: { injury_types: ['concussion', 'spinal'], body_regions: ['head', 'neck', 'face'] },
    items: [
      ['manual_stabilization', 'Manual head and neck stabilization started'],
      ['mechanism_considered', 'Mechanism of injury considered (speed, impact, helmet)'],
      ['neuro_checked', 'Movement and feeling checked in hands and feet'],
      ['gcs_recorded', 'Level of alertness (GCS or AVPU) recorded'],
      ['vitals_repeated', 'Vitals repeated: every 5 minutes if unstable, every 15 if stable'],
      ['spine_motion_restricted', 'Spinal motion restriction applied if indicated'],
      ['ems_considered', 'Ambulance or higher care considered and decided'],
      ['concussion_sheet', 'Concussion take-home sheet given (if released)'],
    ],
  },
  {
    id: 'minor', scope: 'patient', group: 'people', title: 'Patient is a minor',
    when: 'The patient is under 18.',
    suggest: { minor: true },
    items: [
      ['guardian_contacted', 'Parent or guardian contacted'],
      ['guardian_details', 'Guardian name and phone recorded'],
      ['released_to_adult', 'Released only to a parent, guardian or named adult'],
      ['group_leader_told', 'Ski school or group leader told, if with a group'],
    ],
  },
  {
    id: 'collision', scope: 'case', group: 'scene', title: 'Collision',
    when: 'A collision with another person, an object or a vehicle.',
    suggest: { categories: ['collision'], collision: true },
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
    id: 'refusal', scope: 'patient', group: 'people', title: 'Patient refuses care or transport',
    when: 'The patient declines some or all of the care offered.',
    suggest: { dispositions: ['refused_care'] },
    items: [
      ['capacity_assessed', 'Patient alert and able to make the decision'],
      ['risks_explained', 'Risks of refusing explained in plain words'],
      ['alternatives_offered', 'Alternatives offered (ambulance, doctor, aid room)'],
      ['advice_given', 'Advice given on when to seek care'],
      ['refusal_signed', 'Refusal form signed, and a witness recorded'],
    ],
  },
  {
    id: 'transport', scope: 'patient', group: 'care', title: 'Sending a patient to higher care',
    when: 'The patient is going to an ambulance, hospital or clinic.',
    suggest: { dispositions: ['transported_ambulance', 'transported_private'] },
    items: [
      ['handoff_sheet', 'Hand-off sheet printed or read out'],
      ['allergies_confirmed', 'Allergies and medications confirmed with the receiving crew'],
      ['belongings_sent', 'Belongings and equipment accounted for'],
      ['contact_family', 'Family or companion told where the patient is going'],
      ['handoff_recorded', 'Hand-off recorded (who took over, and when)'],
    ],
  },
  {
    id: 'on_duty_injury', scope: 'case', group: 'people', title: 'Patroller or staff injured, or exposed, on duty',
    when: 'A patroller or employee was hurt at work, or had blood or body fluid on broken skin, in the eyes or mouth, or a needlestick.',
    items: [
      ['supervisor_told', 'Patrol supervisor told'],
      ['first_aid_given', 'First aid given (wash the area; flush eyes with water)'],
      ['exposure_source', 'Source of the exposure recorded (who or what), without testing anyone against their will'],
      ['ppe_noted', 'Gloves, eye protection or mask worn at the time recorded'],
      ['referred_testing', 'Sent for medical evaluation within 2 hours (exposure) or to the workers\' comp clinic (injury)'],
      ['first_report', 'Employer\'s first report of injury started (HR or the risk manager)'],
    ],
  },
  {
    id: 'lift_incident', scope: 'case', group: 'lifts', title: 'Lift-related incident',
    when: 'A fall from a chair, a loading or unloading injury, a stop with people on the lift, or anyone hurt by lift equipment.',
    suggest: { case_form: { incident_location: ['lift_incident'] } },
    items: [
      ['lift_stopped', 'Lift stopped and kept as it was (no repairs or resets before inspection)'],
      ['maintenance_told', 'Lift maintenance and the mountain manager told'],
      ['operator_statement', 'Lift operator\'s statement taken'],
      ['scene_photos', 'Scene and the chair or carrier photographed, with its number'],
      ['state_notified', 'State tramway inspector notified, with the time (most states require it within 24 hours)'],
      ['evac_considered', 'Evacuation considered if the lift cannot restart'],
    ],
  },

  // ---------------------------------------------------------------- patient care
  {
    id: 'cardiac_arrest', scope: 'patient', group: 'care', title: 'Cardiac arrest or unresponsive',
    when: 'The patient is unresponsive and not breathing normally, or has no pulse.',
    suggest: { treatments: ['cpr', 'aed'] },
    items: [
      ['ca_found_time', 'Time found unresponsive, and time last seen well, recorded'],
      ['ca_help_called', 'More help, an AED and ALS (911) called, with the time'],
      ['ca_cpr_started', 'CPR started: the time and who started it recorded'],
      ['ca_aed_applied', 'AED applied and analyzing: the time recorded'],
      ['ca_shocks_recorded', 'Each shock, or "no shock advised", recorded with its time'],
      ['ca_compressor_swap', 'Compressors changed about every 2 minutes, with short pauses'],
      ['ca_airway_recorded', 'Airway and breathing support used recorded (pocket mask, BVM, oxygen)'],
      ['ca_rosc_recorded', 'Any return of pulse or breathing recorded, with the time'],
      ['ca_als_handoff', 'Hand-off to ALS recorded: who took over, when, and the shock count passed on'],
      ['ca_bystanders', 'Companions looked after, and the patrol supervisor told'],
    ],
  },
  {
    id: 'chest_pain', scope: 'patient', group: 'care', title: 'Chest pain or suspected heart problem',
    when: 'Chest pain, pressure or discomfort, or other signs of a possible heart problem.',
    suggest: { injury_types: ['cardiac'] },
    items: [
      ['cp_onset_recorded', 'Time it started, and what the patient was doing, recorded'],
      ['cp_als_called', 'ALS (911) called early, with the time'],
      ['cp_kept_at_rest', 'Patient kept at rest: not walked or skied down'],
      ['cp_history_recorded', 'Heart history, medications and allergies recorded'],
      ['cp_aed_ready', 'AED brought to the patient and kept ready'],
      ['cp_meds_recorded', 'Any medication given or assisted under protocol recorded, with the time and who gave it'],
      ['cp_vitals_repeated', 'Vitals repeated and recorded about every 5 minutes'],
      ['cp_handoff_recorded', 'Hand-off to ALS recorded (who took over, and when)'],
    ],
  },
  {
    id: 'breathing_allergy', scope: 'patient', group: 'care', title: 'Breathing difficulty or allergic reaction',
    when: 'Trouble breathing, wheezing, swelling of the face or throat, spreading hives, or contact with something the patient is badly allergic to.',
    items: [
      ['ba_onset_recorded', 'Time it started, and any likely trigger (food, sting, medication), recorded'],
      ['ba_als_called', 'ALS (911) called if breathing is hard or the reaction is spreading'],
      ['ba_position', 'Patient allowed to sit in the position that makes breathing easiest'],
      ['ba_own_meds_asked', 'Patient asked about their own inhaler or epinephrine auto-injector'],
      ['ba_epi_recorded', 'Epinephrine auto-injector, if used under protocol: the time, where on the body, and who gave it recorded'],
      ['ba_reassessed', 'Breathing and vitals rechecked and recorded after any medication'],
      ['ba_device_kept', 'Used auto-injector kept and sent with the patient'],
      ['ba_handoff_recorded', 'Hand-off recorded (who took over, and when)'],
    ],
  },
  {
    id: 'seizure', scope: 'patient', group: 'care', title: 'Seizure',
    when: 'A seizure was seen, or the patient or a companion reports one.',
    items: [
      ['sz_times_recorded', 'Start and end times of the seizure recorded'],
      ['sz_protected', 'Patient protected from injury; nothing put in the mouth'],
      ['sz_described', 'What it looked like recorded (which parts moved, one side or both, eyes)'],
      ['sz_history_asked', 'Seizure history and medications asked about'],
      ['sz_alertness_after', 'Alertness after the seizure recorded, and rechecked'],
      ['sz_causes_considered', 'Head strike, low blood sugar and cold considered as causes'],
      ['sz_als_called', 'ALS (911) called for a first seizure, one over 5 minutes, repeated seizures, an injury or a slow recovery'],
      ['sz_release_adult', 'Not released alone: released to a responsible adult if not transported'],
    ],
  },
  {
    id: 'diabetic', scope: 'patient', group: 'care', title: 'Diabetic emergency',
    when: 'A person with diabetes is confused, sweaty, shaky or acting oddly, or says their blood sugar is low or high.',
    items: [
      ['db_history_recorded', 'Diabetes history, last meal, and last insulin or medication recorded'],
      ['db_glucose_recorded', 'Blood sugar reading recorded with the time (the patient\'s meter or yours)'],
      ['db_oral_sugar', 'Oral sugar given only if the patient can swallow safely, with the time'],
      ['db_rechecked', 'Alertness rechecked and recorded about 15 minutes later'],
      ['db_ate', 'Patient ate a meal or snack before release'],
      ['db_als_called', 'ALS (911) called if not improving or not able to swallow'],
      ['db_release_adult', 'Released only to a responsible adult, and not skiing or riding alone'],
    ],
  },
  {
    id: 'cold_injury', scope: 'patient', group: 'care', title: 'Cold injury (hypothermia or frostbite)',
    when: 'Shivering, confusion or clumsiness in the cold, or numb, pale, waxy or hard skin.',
    suggest: { injury_types: ['cold_injury'], patient_form: { cause: ['non_ski_cold'] } },
    items: [
      ['cold_exposure_recorded', 'How long the patient was out, and how wet, recorded'],
      ['cold_sheltered', 'Patient moved out of the wind and cold, and handled gently'],
      ['cold_insulated', 'Wet clothing removed or covered, and the patient insulated from the ground'],
      ['cold_alertness', 'Level of alertness and shivering recorded'],
      ['cold_frostbite_noted', 'Frostbitten areas noted (where, and how they look); not rubbed'],
      ['cold_no_refreeze', 'Frostbitten areas not rewarmed where they could freeze again'],
      ['cold_warming_recorded', 'Warming used recorded (blankets, heat packs on the trunk, a warm room)'],
      ['cold_ems_considered', 'Ambulance considered for moderate or severe hypothermia'],
    ],
  },
  {
    id: 'fracture', scope: 'patient', group: 'care', title: 'Suspected fracture or dislocation',
    when: 'Deformity, point tenderness, a joint out of place, or an injury the patient cannot move or put weight on.',
    suggest: { injury_types: ['fracture', 'dislocation'], treatments: ['splint'] },
    items: [
      ['fx_cms_before', 'Circulation, movement and feeling below the injury checked and recorded before splinting'],
      ['fx_exposed', 'Injury exposed and looked at; any open wound covered'],
      ['fx_splinted', 'Splinted as found, including the joints above and below'],
      ['fx_cms_after', 'Circulation, movement and feeling rechecked after splinting'],
      ['fx_traction_recorded', 'Traction splint, if used under protocol, recorded with the time'],
      ['fx_pain_recorded', 'Pain score recorded before and after'],
      ['fx_gear_tagged', 'Skis, board or bindings tagged and held, with binding settings noted if relevant'],
      ['fx_transport_recorded', 'How the patient left the hill recorded (toboggan, snowmobile, walked)'],
    ],
  },

  // ---------------------------------------------------------------- the scene and people
  {
    id: 'deep_snow', scope: 'case', group: 'scene', title: 'Deep snow or tree well immersion',
    when: 'Someone is or was buried head-first in deep snow or a tree well.',
    items: [
      ['ds_location_marked', 'Exact location marked and recorded (GPS or a landmark)'],
      ['ds_more_help', 'More patrollers, shovels and a probe called to the scene'],
      ['ds_airway_first', 'Dug toward the face first, and the airway cleared'],
      ['ds_times_recorded', 'Time last seen, time found, and time the airway was cleared recorded'],
      ['ds_partners_asked', 'Partners asked whether anyone else is missing'],
      ['ds_patient_checked', 'Patient checked for breathing and cold (start the cardiac or cold-injury list if needed)'],
      ['ds_hazard_marked', 'Tree well or hole marked, or the area closed, after the rescue'],
    ],
  },
  {
    id: 'avalanche', scope: 'case', group: 'scene', start: 'avalanche', title: 'Avalanche involvement',
    when: 'An avalanche caught, buried, or may have buried someone, inside or near the boundary.',
    items: [
      ['av_time_place', 'Time and place recorded, with the last-seen point marked'],
      ['av_scene_safe', 'Scene judged safe, with a lookout and an escape route'],
      ['av_plan_started', 'Avalanche rescue plan started; patrol director and 911 or search and rescue told'],
      ['av_count_confirmed', 'Number caught and number missing confirmed with witnesses'],
      ['av_transceiver_search', 'Transceiver search started; everyone on the debris switched to search'],
      ['av_probe_line', 'Probe line and shovelers organized, with the times recorded'],
      ['av_burials_recorded', 'For each person found: the time, burial depth, and time the airway was cleared'],
      ['av_dog_called', 'Avalanche dog called, if one is available'],
      ['av_area_closed', 'Area closed to the public until it is safe'],
      ['av_slide_recorded', 'Slide recorded for the avalanche log (size, path, start zone, debris)'],
    ],
  },
  {
    id: 'lost_person', scope: 'case', group: 'scene', title: 'Lost or missing person',
    when: 'A guest is reported lost, overdue or missing.',
    suggest: { categories: ['lost_person'] },
    items: [
      ['lp_reporter_recorded', 'Reporting party\'s name and phone recorded, and asked to stay reachable'],
      ['lp_description', 'Description recorded: age, clothing and colors, equipment, ability'],
      ['lp_last_seen', 'Point last seen and time last seen recorded'],
      ['lp_phone_tried', 'Missing person\'s cell phone called or texted'],
      ['lp_plans_asked', 'Plans, favorite runs and meeting places asked about'],
      ['lp_medical_asked', 'Medical conditions and medications asked about'],
      ['lp_hasty_search', 'Hasty search of likely runs, lift lines and lodges started, with the time'],
      ['lp_staff_told', 'Lift operators, ski school and guest services given the description'],
      ['lp_vehicle_checked', 'Parking lot and vehicle checked, and an end-of-day sweep considered'],
      ['lp_escalated', 'Police or search and rescue called by the time your plan sets'],
      ['lp_found', 'Found: the time, place and condition recorded, and everyone told the search is over'],
    ],
  },
  {
    id: 'terrain_park', scope: 'case', group: 'scene', title: 'Terrain park incident',
    when: 'Someone was hurt on a jump, rail, box, halfpipe or other park feature.',
    suggest: { case_form: { incident_location: ['freestyle_terrain', 'terrain_rail_park', 'half_pipe'] }, patient_form: { involvement: ['terrain_park_feature', 'rec_jumping'] } },
    items: [
      ['tp_feature_recorded', 'Feature name, number and size recorded (ask the park supervisor; do not guess)'],
      ['tp_photos', 'Feature, takeoff, landing and signs photographed'],
      ['tp_feature_closed', 'Feature closed or roped off until the park crew inspects it'],
      ['tp_supervisor_told', 'Terrain park supervisor told'],
      ['tp_last_inspection', 'Time of the park crew\'s last inspection asked for'],
      ['tp_signs_noted', 'Park entrance signs and the feature\'s size rating noted'],
      ['tp_surface_noted', 'Snow on the takeoff and landing noted (speed, ruts, ice)'],
      ['tp_video_asked', 'Witnesses asked about helmet camera or phone video'],
    ],
  },
  {
    id: 'uphill', scope: 'case', group: 'scene', title: 'Uphill or skinning traffic',
    when: 'An incident involving someone skinning, snowshoeing or hiking up the mountain.',
    items: [
      ['up_route_recorded', 'Route, time and direction of travel recorded'],
      ['up_pass_checked', 'Whether the person had an uphill pass and was on an allowed route noted'],
      ['up_hours_checked', 'Whether uphill travel was allowed at that time noted (grooming, snowmaking, closed hours)'],
      ['up_visibility', 'Lights, reflective gear, and where they were on the trail noted'],
      ['up_machine_involved', 'Any groomer, snowmobile or snowmaking involved identified, and the operator\'s statement taken'],
      ['up_policy_explained', 'Uphill policy explained to the person'],
      ['up_supervisor_told', 'Patrol supervisor told'],
    ],
  },
  {
    id: 'intoxicated', scope: 'case', group: 'people', title: 'Intoxicated or uncooperative guest',
    when: 'A guest seems impaired by alcohol or drugs, or is aggressive or will not cooperate.',
    suggest: { categories: ['conduct'] },
    items: [
      ['ix_safe', 'Scene safe: a second patroller or security present'],
      ['ix_facts_recorded', 'What you saw and heard recorded as facts (speech, balance, smell, behavior), not opinions'],
      ['ix_medical_considered', 'Medical causes considered (head injury, low blood sugar, cold)'],
      ['ix_supervisor_told', 'Patrol supervisor or security told'],
      ['ix_pass_recorded', 'Ticket or pass number recorded; pass pulled if your policy says so'],
      ['ix_police', 'Police called for a threat, a crime, or a minor with alcohol'],
      ['ix_released_to', 'Released only to a sober responsible adult or the police, and who that was recorded'],
      ['ix_driving', 'Plan to get home recorded; police told if the guest tries to drive'],
    ],
  },
  {
    id: 'fatality', scope: 'case', group: 'scene', title: 'Death or presumed death on the mountain',
    when: 'A person is dead or presumed dead. Use it with the cardiac arrest list if resuscitation was started.',
    items: [
      ['dd_times_recorded', 'Time found, and when resuscitation stopped and on whose decision, recorded'],
      ['dd_scene_preserved', 'Scene preserved: area closed, nothing moved except to give care'],
      ['dd_person_covered', 'The person covered and screened from view, with a patroller staying with them'],
      ['dd_authorities_told', 'Police and the coroner or medical examiner notified, with the times'],
      ['dd_management_told', 'Patrol director, mountain manager and risk manager told'],
      ['dd_belongings_held', 'Equipment and belongings left in place, or tagged and held for the police'],
      ['dd_witnesses', 'Witnesses identified, kept apart, and statements taken'],
      ['dd_photos', 'Scene photographed before anything is moved, if the police allow'],
      ['dd_family_liaison', 'One person named as family liaison; no news given by radio or phone'],
      ['dd_radio_plain', 'Radio traffic kept short, without names'],
      ['dd_media', 'Questions from the public and the media sent to management'],
      ['dd_staff_support', 'Patrollers and staff involved offered a debrief and support'],
    ],
  },

  // ---------------------------------------------------------------- lifts
  {
    id: 'lift_evacuation', scope: 'case', group: 'lifts', title: 'Lift evacuation',
    when: 'A lift cannot restart and riders must be brought down by rope or another way. Use it with the lift-related incident list.',
    items: [
      ['le_times_recorded', 'Time the lift stopped and time the evacuation was called recorded'],
      ['le_riders_told', 'Riders told what is happening, and told again regularly'],
      ['le_teams_assigned', 'Evacuation teams, gear and a lead assigned to each section of the line'],
      ['le_riders_counted', 'Riders on the lift counted, and tracked as each one is lowered'],
      ['le_priority', 'Children, the cold and anyone hurt brought down first'],
      ['le_base_ready', 'Ground crew, warming and a gathering place set up at the base'],
      ['le_names_recorded', 'Each rider\'s name and chair number recorded'],
      ['le_all_clear', 'Last rider down and the line walked, with the time'],
      ['le_authorities_told', 'Management and the state tramway inspector told'],
    ],
  },

  // ---------------------------------------------------------------- attractions (suggested when the case happened at one)
  {
    id: 'zipline_rescue', scope: 'case', group: 'attractions', start: 'attraction', attraction: ['zipline'], title: 'Zipline rescue or stuck rider',
    when: 'A rider stopped short on a line, cannot be brought in the usual way, or was hurt on a zipline or canopy tour.',
    items: [
      ['zl_line_closed', 'Line closed: no more riders sent, and the other lines checked'],
      ['zl_rider_reassured', 'Rider talked to, reassured, and told to stay clipped in'],
      ['zl_rescuer_named', 'Rescue method and the trained rescuer leading it recorded'],
      ['zl_times_recorded', 'Time stuck and time back on a platform or the ground recorded'],
      ['zl_hang_time', 'Time hanging in the harness recorded (watch for harness hang syndrome)'],
      ['zl_guide_statement', 'Guide\'s account taken (which line and platform, what happened)'],
      ['zl_gear_held', 'Harness, trolley and lanyards tagged and held, with their numbers'],
      ['zl_weather_recorded', 'Wind and weather at the time recorded'],
      ['zl_manager_told', 'Attraction manager told; the manufacturer and state inspector told if required'],
    ],
  },
  {
    id: 'coaster_incident', scope: 'case', group: 'attractions', start: 'attraction', attraction: ['coaster'], title: 'Mountain coaster incident',
    when: 'A rider was hurt, sleds collided or stopped on the track, or a rider had to be walked off the track.',
    items: [
      ['mc_stopped', 'Coaster stopped and kept as it was until inspected'],
      ['mc_sled_recorded', 'Sled number and where it was on the track recorded'],
      ['mc_riders_off', 'Riders on the track counted and walked off safely by staff'],
      ['mc_restraint', 'Whether the seat belt was fastened, and checked by the operator, recorded'],
      ['mc_braking_asked', 'Rider asked about braking and speed; any speed warning signs noted'],
      ['mc_riders_recorded', 'Rider\'s height and age, and whether a child rode with an adult, recorded'],
      ['mc_operator_statement', 'Operator\'s statement taken'],
      ['mc_photos', 'Track section, sled and signs photographed'],
      ['mc_manager_told', 'Attraction manager told; the state ride inspector told if required'],
    ],
  },
  {
    id: 'ice_skating', scope: 'case', group: 'attractions', start: 'attraction', attraction: ['ice_rink'], title: 'Ice skating injury',
    when: 'A skater was hurt at the ice rink.',
    items: [
      ['is_where_recorded', 'Where on the ice it happened, and the ice condition, recorded'],
      ['is_head_strike', 'Head strike asked about (start the head or spine list if yes)'],
      ['is_skates_recorded', 'Own or rental skates, and the rental number, recorded'],
      ['is_helmet_recorded', 'Helmet worn or not recorded'],
      ['is_blade_cut', 'Any skate-blade cut checked and covered'],
      ['is_ice_cleared', 'Ice cleared of blood or debris before skating resumed'],
      ['is_attendant_statement', 'Rink attendant\'s statement taken'],
      ['is_resurface_time', 'Time of the last resurfacing noted'],
    ],
  },
  {
    id: 'tubing_incident', scope: 'case', group: 'attractions', start: 'attraction', attraction: ['tubing'], title: 'Snow tubing incident',
    when: 'A tuber was hurt, or a tube left its lane or hit another tube, a barrier or a person.',
    suggest: { patient_form: { activity: ['tubing'], involvement: ['tube_slide'] } },
    items: [
      ['tb_lane_recorded', 'Lane number, and where on the lane, recorded'],
      ['tb_lane_closed', 'Lane closed until it is checked'],
      ['tb_riders_recorded', 'How many rode, linked or not, and their positions recorded'],
      ['tb_dispatch_asked', 'Attendant\'s account of the dispatch and the gap between riders taken'],
      ['tb_runout_checked', 'Run-out and barriers checked and photographed'],
      ['tb_tube_tagged', 'Tube number recorded and the tube taken out of use'],
      ['tb_conditions_noted', 'Lane speed and snow noted (icy, fast, slow)'],
    ],
  },
  {
    id: 'scenic_lift', scope: 'case', group: 'attractions', start: 'attraction', attraction: ['scenic_lift'], title: 'Scenic lift ride incident',
    when: 'A guest was hurt or became ill on a scenic lift ride or at the summit.',
    items: [
      ['sl_lift_recorded', 'Lift, and chair or cabin number, recorded'],
      ['sl_where_recorded', 'Where it happened recorded (loading, riding, unloading, at the summit)'],
      ['sl_lift_held', 'Lift stopped and kept as it was if it may be involved (start the lift-related list)'],
      ['sl_footwear_noted', 'Footwear, and anything the guest was carrying, noted'],
      ['sl_causes_considered', 'Heat, sun, altitude or a medical cause considered'],
      ['sl_down_recorded', 'How the guest came down recorded (download, vehicle, walked)'],
      ['sl_operator_statement', 'Lift operator\'s statement taken'],
    ],
  },
  {
    id: 'bike_park', scope: 'case', group: 'attractions', start: 'attraction', attraction: ['bike_park'], title: 'Bike park incident',
    when: 'A rider was hurt in the bike park or on a downhill trail.',
    items: [
      ['bp_trail_recorded', 'Trail, feature and direction recorded (ask the trail crew; do not guess)'],
      ['bp_photos', 'Feature, landing and signs photographed'],
      ['bp_helmet_recorded', 'Helmet (full-face or open) and pads recorded; a damaged helmet held'],
      ['bp_bike_recorded', 'Own or rental bike, the rental number, and any failure noted'],
      ['bp_access_route', 'Access route for the patient and vehicle chosen and recorded'],
      ['bp_trail_closed', 'Feature or trail closed until the bike crew checks it'],
      ['bp_manager_told', 'Bike park manager told'],
    ],
  },
  {
    id: 'aerial_rescue', scope: 'case', group: 'attractions', start: 'attraction', attraction: ['aerial_park', 'climbing_wall'], title: 'Aerial park or climbing wall rescue',
    when: 'A participant is stuck, fell, or was hurt on an aerial course or a climbing wall.',
    items: [
      ['ap_stopped', 'Course or wall stopped; other participants told to stay clipped in and wait'],
      ['ap_where_recorded', 'Element, route or wall section, and the height, recorded'],
      ['ap_rescuer_named', 'Rescue method and the trained rescuer leading it recorded'],
      ['ap_times_recorded', 'Time stuck and time back on the ground recorded'],
      ['ap_hang_time', 'Time hanging in the harness recorded'],
      ['ap_attachment_recorded', 'How the participant was attached recorded (both lanyards, belay, auto-belay)'],
      ['ap_gear_held', 'Harness, lanyards, belay device or auto-belay tagged and held, with numbers'],
      ['ap_guide_statement', 'Guide\'s or belayer\'s statement taken'],
      ['ap_manager_told', 'Attraction manager told; the state inspector told if required'],
    ],
  },
];

const GROUPS = [['care', 'Patient care'], ['people', 'People'], ['scene', 'The scene'], ['lifts', 'Lifts'], ['attractions', 'Attractions']];
// The seven lists from before the library grew: their keys are on recorded cases and must never change.
const ORIGINAL = ['head_spine', 'minor', 'collision', 'refusal', 'transport', 'on_duty_injury', 'lift_incident'];

const BY_ID = new Map(LISTS.map((l) => [l.id, l]));
const KEYS = new Map(LISTS.map((l) => [l.id, new Set(l.items.map((i) => i[0]))]));
/** item key -> { list, label } for the built-in lists. */
const BY_KEY = new Map(LISTS.flatMap((l) => l.items.map(([key, label]) => [key, { list: l, label }])));
const allKeys = () => new Set(BY_KEY.keys());
const valid = (key) => BY_KEY.has(key);

/** A mountain's own list's id ('c12') and item key ('c12_40'). */
const customId = (id) => `c${Number(id)}`;
const customKey = (listId, itemId) => `c${Number(listId)}_${Number(itemId)}`;
const parseCustomKey = (key) => { const m = /^c(\d+)_(\d+)$/.exec(String(key || '')); return m ? { listId: Number(m[1]), itemId: Number(m[2]) } : null; };
const parseCustomId = (id) => { const m = /^c(\d+)$/.exec(String(id || '')); return m ? Number(m[1]) : null; };

/** A built-in list as the screens read it. */
function shape(l) {
  return {
    id: l.id, source: 'builtin', scope: l.scope, group: l.group, title: l.title, when: l.when,
    items: l.items.map(([key, label]) => ({ key, label })),
    suggest: l.suggest || null, attraction_types: l.attraction || [],
  };
}

/**
 * Whether a built-in list is on before the patrol admin chooses: { on, why }. ctx: { avalanche, attractionTypes: Set }.
 */
function startsOn(l, ctx = {}) {
  if (l.start === 'avalanche') {
    const on = Boolean(ctx.avalanche);
    return { on, why: on ? 'On because Patrol settings says the mountain does avalanche work.' : 'Off until Patrol settings says the mountain does avalanche work.' };
  }
  if (l.start === 'attraction') {
    const on = (l.attraction || []).some((t) => ctx.attractionTypes && ctx.attractionTypes.has(t));
    return { on, why: on ? 'On because the mountain has this kind of attraction.' : 'Off until the mountain adds this kind of attraction.' };
  }
  return { on: true, why: null };
}

/**
 * Ticks as they were: a tick saved before labels were kept with it (or one whose label is missing) takes the built-in
 * list's title and wording. Ticks that carry their own words are left exactly as they are.
 */
function labelTicks(list) {
  return (list || []).map((r) => {
    if (r.list_title && r.item_label && r.list_id) return r;
    const b = BY_KEY.get(r.item_key);
    if (!b) return { ...r, list_id: r.list_id || null, list_title: r.list_title || null, item_label: r.item_label || r.item_key };
    return { ...r, list_id: r.list_id || b.list.id, list_title: r.list_title || b.list.title, item_label: r.item_label || b.label };
  });
}

// ---------------------------------------------------------------- the database side
/** The mountain's switches, avalanche setting and attraction types, for working out which lists are on. */
async function contextOf(db, tenantId) {
  const [switches, ops, types] = await Promise.all([
    db.query('SELECT list_id, enabled FROM patrol_checklist_switches WHERE tenant_id = ?', [tenantId]).then(([r]) => r),
    require('./patrolops').settingsOf(db, tenantId),
    db.query('SELECT DISTINCT type FROM attractions WHERE tenant_id = ? AND active = 1', [tenantId]).then(([r]) => r).catch(() => []),
  ]);
  return {
    switches: new Map(switches.map((s) => [s.list_id, Boolean(Number(s.enabled))])),
    avalanche: Boolean(ops.avalanche),
    attractionTypes: new Set(types.map((t) => t.type)),
  };
}

/** Whether a built-in list is on for this mountain. */
function builtinOn(l, ctx) {
  return ctx.switches.has(l.id) ? ctx.switches.get(l.id) : startsOn(l, ctx).on;
}

/** The mountain's own lists with their items (items taken off a list are left out unless `withRemoved`). */
async function customLists(db, tenantId, { withArchived = false, withRemoved = false, ids = null } = {}) {
  if (ids && !ids.length) return [];
  const where = [`tenant_id = ?${withArchived ? '' : ' AND archived_at IS NULL'}`];
  const params = [tenantId];
  if (ids) { where.push('id IN (?)'); params.push(ids); }
  const [lists] = await db.query(`SELECT id, title, when_text, scope, attraction_type, enabled, archived_at, created_at, updated_at FROM patrol_checklists WHERE ${where.join(' AND ')} ORDER BY title, id`, params);
  if (!lists.length) return [];
  const [items] = await db.query(`SELECT id, checklist_id, label, sort, removed_at FROM patrol_checklist_items WHERE tenant_id = ? AND checklist_id IN (?)${withRemoved ? '' : ' AND removed_at IS NULL'} ORDER BY sort, id`, [tenantId, lists.map((l) => l.id)]);
  return lists.map((l) => ({
    id: customId(l.id), db_id: Number(l.id), source: 'custom', scope: l.scope, group: 'own', title: l.title, when: l.when_text || '',
    attraction_types: l.attraction_type ? [l.attraction_type] : [], attraction_type: l.attraction_type || null,
    suggest: null, enabled: Boolean(Number(l.enabled)), archived_at: l.archived_at || null,
    items: items.filter((i) => Number(i.checklist_id) === Number(l.id)).map((i) => ({ key: customKey(l.id, i.id), id: Number(i.id), label: i.label, ...(withRemoved ? { removed_at: i.removed_at || null } : {}) })),
  }));
}

/** The list ids already ticked on a case (a list switched off later can still be finished there). */
async function tickedLists(db, tenantId, incidentId) {
  const [r] = await db.query('SELECT DISTINCT list_id, item_key FROM incident_checklist WHERE tenant_id = ? AND incident_id = ?', [tenantId, incidentId]);
  const ids = new Set();
  for (const x of r) {
    if (x.list_id) ids.add(x.list_id);
    else if (BY_KEY.has(x.item_key)) ids.add(BY_KEY.get(x.item_key).list.id);
    else { const c = parseCustomKey(x.item_key); if (c) ids.add(customId(c.listId)); }
  }
  return ids;
}

/**
 * The lists patrollers can use: every built-in list that is on, then the mountain's own lists that are on. With a
 * case, lists already ticked on it come too (marked `off: true` when they are no longer on).
 */
async function listsFor(db, tenantId, { incidentId = null } = {}) {
  const ctx = await contextOf(db, tenantId);
  const ticked = incidentId ? await tickedLists(db, tenantId, incidentId) : new Set();
  const out = [];
  for (const l of LISTS) {
    const on = builtinOn(l, ctx);
    if (on || ticked.has(l.id)) out.push({ ...shape(l), ...(on ? {} : { off: true }) });
  }
  const tickedCustom = [...ticked].map(parseCustomId).filter(Boolean);
  const own = await customLists(db, tenantId, { withArchived: tickedCustom.length > 0 });
  for (const l of own) {
    const on = l.enabled && !l.archived_at;
    if (!on && !ticked.has(l.id)) continue;
    const { enabled, archived_at: _a, db_id: _d, ...rest } = l;
    out.push({ ...rest, ...(on ? {} : { off: true }) });
  }
  return out;
}

module.exports = {
  LISTS, KEYS, BY_ID, BY_KEY, GROUPS, ORIGINAL, valid, allKeys, shape, startsOn, labelTicks,
  customId, customKey, parseCustomKey, parseCustomId, contextOf, builtinOn, customLists, tickedLists, listsFor,
};
