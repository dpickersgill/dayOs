'use strict';
// Lift inspection checklists by lift type (2026.11.10). Each lift has a type; each type has a daily list (before the
// lift carries anyone) and a periodic list (the deeper weekly walk). A mountain edits its own copy of any list
// (Lift inspections, Checklists); with no copy, the built-in list here is used.
//
// The built-in lists follow the subjects that daily and weekly lift inspections usually cover, in plain words for a
// lift operator or mechanic. They are a starting point: the manufacturer's manual, the mountain's own lift procedures
// and the state lift inspector's rules come first. Keys stay fixed once shipped; an inspection keeps the words it was
// done with, so a later edit never changes what was ticked.
//
// required: a failed required item fails the inspection, and the lift cannot be set to open until a new inspection of
// the same kind passes. A failed item that is not required still opens a work order, but the inspection passes.

const TYPES = [
  { key: 'fixed_grip', label: 'Fixed-grip chairlift' },
  { key: 'detachable', label: 'Detachable chairlift' },
  { key: 'gondola_tram', label: 'Gondola or tram' },
  { key: 'surface', label: 'Surface lift (T-bar, J-bar, platter or rope tow)' },
  { key: 'carpet', label: 'Conveyor (magic carpet)' },
];
const TYPE_KEYS = TYPES.map((t) => t.key);
const KINDS = [
  { key: 'daily', label: 'Daily', long: 'Daily inspection', every_days: 1 },
  { key: 'periodic', label: 'Weekly', long: 'Weekly inspection', every_days: 7 },
];
const KIND_KEYS = KINDS.map((k) => k.key);
const typeLabel = (k) => (TYPES.find((t) => t.key === k) || { label: 'Type not set' }).label;
const kindOf = (k) => KINDS.find((x) => x.key === k) || KINDS[0];

// [key, label, required]. R marks a required item, O one that is not.
const R = true; const O = false;

const COMMS = ['comms', 'Radios or phones work between every station and the operator', R];
const ESTOPS = ['estops', 'Every stop button tested at each station: the lift stops', R];
const WIND = ['wind', 'Wind gauge reading and the weather are inside the lift\'s limits', R];
const EVAC_KIT = ['evac_kit', 'Evacuation gear at its station, counted and ready', R];
const SIGNS = ['signs', 'Rider signs, rules and the load and unload signs in place', R];
const LOG = ['log', 'Daily log started: operators, attendants and the time the lift opened to riders', O];

const DAILY = {
  fixed_grip: [
    ['terminals', 'Drive and return terminals clear of snow, ice and loose objects', R],
    ['ramps', 'Load and unload ramps groomed, level and free of ice', R],
    ['maze', 'Maze, corral and loading point markers set', O],
    ['gates', 'Missed-unload gate or stop line tested: the lift stops', R],
    ESTOPS,
    ['service_brake', 'Service brake tested: the lift stops smoothly', R],
    ['emergency_brake', 'Emergency (bullwheel) brake tested', R],
    ['aux_drive', 'Auxiliary or evacuation drive started and run', R],
    ['rope_visual', 'Haul rope watched through a full loop: no broken wires, kinks or bumps', R],
    ['line_walk', 'Line checked by ride or walk: towers, sheaves and rope in its track', R],
    ['carriers', 'Chairs checked: seats, restraint bars, footrests and hangers', R],
    ['grips_visual', 'Grips watched at the terminals: none slipped or out of line', R],
    ['tension', 'Tension carriage or counterweight free to move, within its marks', R],
    ['empty_run', 'Empty run at full speed: no odd noise, vibration or smell', R],
    WIND, COMMS, EVAC_KIT, SIGNS, LOG,
  ],
  detachable: [
    ['terminals', 'Drive and return terminals clear of snow, ice and loose objects', R],
    ['ramps', 'Load and unload areas groomed, level and free of ice', R],
    ['loading_carpet', 'Loading carpet, if fitted, runs and its stop works', R],
    ['gates', 'Missed-unload gate or stop line tested: the lift stops', R],
    ESTOPS,
    ['service_brake', 'Service brake tested: the lift stops smoothly', R],
    ['emergency_brake', 'Emergency (bullwheel) brake tested', R],
    ['aux_drive', 'Auxiliary or evacuation drive started and run', R],
    ['grip_test', 'Grip force tests passed at both terminals on every chair (the lift\'s own test or the tester)', R],
    ['detach_sensors', 'Grip open and close sensors and the chair spacing alarms tested', R],
    ['tires', 'Terminal tires and conveyor drives: none flat, loose or slipping', R],
    ['rope_visual', 'Haul rope watched through a full loop: no broken wires, kinks or bumps', R],
    ['line_walk', 'Line checked by ride or walk: towers, sheaves and rope in its track', R],
    ['carriers', 'Chairs checked: seats, restraint bars, bubbles and footrests', R],
    ['tension', 'Tension system pressure and travel within marks', R],
    ['empty_run', 'Empty run at full speed with chairs cycling: no faults on the panel', R],
    WIND, COMMS, EVAC_KIT, SIGNS, LOG,
  ],
  gondola_tram: [
    ['terminals', 'Terminals and platforms clear of snow, ice and loose objects', R],
    ['platforms', 'Boarding platforms, rails and edge markings in place', R],
    ['doors', 'Cabin doors open, close and lock; the door alarms work', R],
    ['cabins', 'Cabins checked: windows, floors, seats, hangers and inside signs', R],
    ESTOPS,
    ['service_brake', 'Service brake tested: the lift stops smoothly', R],
    ['emergency_brake', 'Emergency (bullwheel or track) brake tested', R],
    ['aux_drive', 'Auxiliary or evacuation drive started and run', R],
    ['grip_test', 'Grip force or carriage checks passed (the lift\'s own test or the tester)', R],
    ['track_rope', 'Track and haul ropes watched: no broken wires, kinks or bumps', R],
    ['line_walk', 'Line checked by an empty trip: towers, saddles and sheaves', R],
    ['tension', 'Tension system pressure and travel within marks', R],
    ['empty_run', 'Empty trip at full speed: no faults on the panel', R],
    ['cabin_comms', 'Cabin intercom or speakers work, if fitted', O],
    WIND, COMMS, EVAC_KIT, SIGNS, LOG,
  ],
  surface: [
    ['track', 'Track groomed: no ruts, holes, ice or bare spots, and the edges are marked', R],
    ['load_area', 'Loading area level, with the loading point marked', R],
    ['unload_area', 'Unload area clear, with room to get off and move away', R],
    ['safety_gate', 'Safety gate (stop gate) past the unload tested: the lift stops', R],
    ESTOPS,
    ['brake', 'Brake tested: the lift stops', R],
    ['rope_visual', 'Rope watched through a full loop: no broken wires, frays or bad splices', R],
    ['carriers', 'T-bars, J-bars, platters or handles checked: springs retract, none cracked or missing', R],
    ['line_walk', 'Line checked: towers, sheaves and rope in its track, nothing in the way', R],
    ['tension', 'Tension weight or spring free to move, within its marks', R],
    ['guards', 'Guards over the bullwheels, pulleys and moving parts in place', R],
    ['empty_run', 'Empty run: no odd noise or vibration', R],
    WIND, COMMS, SIGNS, LOG,
  ],
  carpet: [
    ['belt', 'Belt surface clean and free of ice and snow, no tears or lifting seams', R],
    ['comb_plates', 'Comb plates and transitions at both ends in place, no gaps', R],
    ['side_boards', 'Sideboards, covers and skirt boards secure', R],
    ['stops', 'Stop buttons at both ends tested: the belt stops', R],
    ['unload_stop', 'Overrun or unload safety stop at the top tested', R],
    ['entry', 'Entry and exit areas level and free of ice', R],
    ['canopy', 'Gallery or canopy, if fitted, clear and lit', O],
    ['run_test', 'Run end to end: smooth start and stop, no slipping or odd noise', R],
    ['signs', 'Rider signs and how to ride posted at the bottom', R],
    ['radio', 'A way to reach the operator from the top', R],
    LOG,
  ],
};

const PERIODIC = {
  fixed_grip: [
    ['grips', 'Grips checked for slip and wear, and the grip slip test done where due (manufacturer\'s method)', R],
    ['sheaves', 'Sheave trains checked: liners, bearings, flanges and deropement switches', R],
    ['derope', 'Rope position (deropement) switches tested on every tower that has them', R],
    ['towers', 'Towers checked: ladders, crossarms, bolts and footings', R],
    ['brake_test', 'Brakes tested as the manual says (stopping distance or torque) and logged', R],
    ['brake_wear', 'Brake pads or shoes, springs and linkages checked for wear', R],
    ['gearbox', 'Gearbox oil level, leaks and temperature checked', R],
    ['motor', 'Main motor and drive: mounts, couplings and guards checked', R],
    ['aux_load', 'Auxiliary drive run under load, fuel and fluids topped up', R],
    ['bullwheels', 'Bullwheels checked: liners, spokes and bearings', R],
    ['tension_system', 'Tension system checked: carriage rails, cylinders or weights, cables', R],
    ['splice', 'Haul rope splice and the rope near it looked at closely', R],
    ['lubrication', 'Lubrication done as the schedule says', O],
    ['restraints', 'Every restraint bar opens and closes freely', R],
    ['evac_equipment', 'Evacuation ropes, harnesses and devices inspected', R],
    ['electrical', 'Control panel, fault lights and the lightning protection checked', O],
  ],
  detachable: [
    ['grips', 'Grips checked for wear: jaws, springs and rollers (manufacturer\'s method)', R],
    ['grip_springs', 'Grip spring checks or tests done where due and logged', R],
    ['terminal_tires', 'Terminal tires and tire banks: pressure, wear and belts', R],
    ['rails', 'Terminal rails, guides and the opening and closing rails checked', R],
    ['sheaves', 'Sheave trains checked: liners, bearings, flanges and deropement switches', R],
    ['derope', 'Rope position (deropement) switches tested on every tower that has them', R],
    ['towers', 'Towers checked: ladders, crossarms, bolts and footings', R],
    ['brake_test', 'Brakes tested as the manual says (stopping distance or torque) and logged', R],
    ['brake_wear', 'Brake pads, springs and hydraulics checked for wear and leaks', R],
    ['gearbox', 'Gearbox oil level, leaks and temperature checked', R],
    ['aux_load', 'Auxiliary drive run under load, fuel and fluids topped up', R],
    ['tension_system', 'Tension system checked: cylinder, pressure, rails and accumulators', R],
    ['splice', 'Haul rope splice and the rope near it looked at closely', R],
    ['sensors', 'Terminal sensors, proximity switches and the chair counter tested', R],
    ['restraints', 'Every restraint bar and bubble opens and closes freely', R],
    ['evac_equipment', 'Evacuation ropes, harnesses and devices inspected', R],
    ['lubrication', 'Lubrication done as the schedule says', O],
  ],
  gondola_tram: [
    ['grips', 'Grips or carriages checked for wear (manufacturer\'s method)', R],
    ['doors_mech', 'Cabin door mechanisms, locks and rails checked on every cabin', R],
    ['cabin_hangers', 'Cabin hangers, bolts and suspension checked', R],
    ['sheaves', 'Sheaves, saddles and track rope shoes checked', R],
    ['derope', 'Rope position (deropement) switches tested on every tower that has them', R],
    ['towers', 'Towers checked: ladders, crossarms, bolts and footings', R],
    ['brake_test', 'Brakes tested as the manual says and logged', R],
    ['brake_wear', 'Brake pads, springs and hydraulics checked for wear and leaks', R],
    ['gearbox', 'Gearbox oil level, leaks and temperature checked', R],
    ['aux_load', 'Auxiliary drive run under load, fuel and fluids topped up', R],
    ['tension_system', 'Tension and counterweight systems checked', R],
    ['ropes', 'Haul and track ropes looked at closely at splices, sockets and ends', R],
    ['rescue', 'Rescue vehicle or rescue gear checked and ready', R],
    ['electrical', 'Control panel, fault lights and the lightning protection checked', O],
    ['lubrication', 'Lubrication done as the schedule says', O],
  ],
  surface: [
    ['sheaves', 'Sheaves checked: liners, bearings and flanges', R],
    ['towers', 'Towers checked: bolts, crossarms and footings', R],
    ['carrier_springs', 'Every carrier spring box or recoil checked: cables, springs and housings', R],
    ['clamps', 'Carrier clamps or grips on the rope checked for slip and wear', R],
    ['brake_test', 'Brake checked for wear and tested as the manual says', R],
    ['gearbox', 'Gearbox or drive oil level and leaks checked', R],
    ['bullwheel', 'Bullwheel liner, spokes and bearings checked', R],
    ['tension_system', 'Tension weight, cable and track checked', R],
    ['splice', 'Rope splice and the rope near it looked at closely', R],
    ['electrical', 'Control box, wiring and the stop circuit checked', O],
    ['lubrication', 'Lubrication done as the schedule says', O],
  ],
  carpet: [
    ['belt_tracking', 'Belt tracking and tension adjusted as needed', R],
    ['belt_wear', 'Belt underside, seams and lacing checked for wear', R],
    ['rollers', 'Rollers and bearings checked: none seized or noisy', R],
    ['drive', 'Drive motor, gearbox oil and chain or belt drive checked', R],
    ['sensors', 'Overrun and safety sensors cleaned and tested', R],
    ['electrical', 'Control box, wiring and the heat tape, if fitted, checked', O],
    ['structure', 'Frame, covers and anchors checked for damage', O],
  ],
};

// A lift with no type set keeps the standard list it always had (lib/ops.js LIFT_CHECKLIST, all required), and a
// general weekly list.
const GENERAL_PERIODIC = [
  ['sheaves', 'Sheaves and towers checked: liners, bearings and bolts', R],
  ['brake_test', 'Brakes tested as the manual says and logged', R],
  ['gearbox', 'Gearbox oil level and leaks checked', R],
  ['aux_load', 'Auxiliary drive run under load', R],
  ['tension_system', 'Tension system checked', R],
  ['splice', 'Rope splice looked at closely', R],
  ['carriers', 'Carriers and restraints checked', R],
  ['lubrication', 'Lubrication done as the schedule says', O],
];

const asItems = (list) => list.map(([key, label, required]) => ({ key, label, required: Boolean(required) }));

/** The built-in list for a type (or null for a lift with no type) and kind, as [{ key, label, required }]. */
function builtIn(type, kind) {
  if (kind === 'periodic') return asItems(PERIODIC[type] || GENERAL_PERIODIC);
  if (DAILY[type]) return asItems(DAILY[type]);
  return require('./ops').LIFT_CHECKLIST.map((i) => ({ key: i.key, label: i.label, required: true }));
}

/** A mountain's own list (JSON text), or null when it is empty or unreadable. */
function parseItems(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) && v.length ? v.filter((i) => i && i.key && i.label).map((i) => ({ key: String(i.key), label: String(i.label), required: i.required !== false })) : null;
  } catch (_) { return null; }
}

/** A stable key for a new item: its words, shortened, unique within the list. */
function keyFor(label, taken) {
  const stem = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'item';
  let key = stem; let n = 2;
  while (taken.has(key)) key = `${stem}_${n++}`;
  taken.add(key);
  return key;
}
/** A list as a manager saves it. Items that keep their key keep it; new ones get one from their words. */
function normalize(items) {
  const taken = new Set();
  const kept = items.map((i) => ({ key: i.key && /^[a-z0-9_]{1,40}$/.test(i.key) && !taken.has(i.key) ? (taken.add(i.key), i.key) : null, label: String(i.label).trim(), required: i.required !== false }));
  return kept.map((i) => ({ key: i.key || keyFor(i.label, taken), label: i.label, required: i.required }));
}

module.exports = { TYPES, TYPE_KEYS, KINDS, KIND_KEYS, typeLabel, kindOf, builtIn, parseItems, normalize };
