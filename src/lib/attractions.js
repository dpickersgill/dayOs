'use strict';
// The kinds of attraction a mountain can run beside skiing and riding. A mountain adds its own attractions (Settings,
// Attractions) and picks a type for each; 'other' is any attraction not listed, with its own name.
// The type decides the default opening checks, the patrol activity on reports, and whether it sells by time slot.
// Shared by Mountain status, Patrol, selling and staff: add a type here, never in one of those places alone.
//
// activity: the value the patrol report's Activity list (lib/nsaar.js) uses for a guest hurt on this kind of attraction.
const TYPES = [
  { key: 'zipline', label: 'Zipline or canopy tour', season: 'all', group: 'Rides', activity: 'zipline' },
  { key: 'coaster', label: 'Mountain coaster', season: 'all', group: 'Rides', activity: 'mountain_coaster' },
  { key: 'tubing', label: 'Snow tubing', season: 'winter', group: 'Snow', activity: 'tubing' },
  { key: 'ice_rink', label: 'Ice skating', season: 'winter', group: 'Snow', activity: 'ice_skating' },
  { key: 'scenic_lift', label: 'Scenic lift ride', season: 'summer', group: 'Summer', activity: 'scenic_lift' },
  { key: 'bike_park', label: 'Bike park', season: 'summer', group: 'Summer', activity: 'mountain_biking' },
  { key: 'disc_golf', label: 'Disc golf', season: 'summer', group: 'Summer', activity: 'disc_golf' },
  { key: 'aerial_park', label: 'Aerial adventure park', season: 'summer', group: 'Summer', activity: 'aerial_park' },
  { key: 'climbing_wall', label: 'Climbing wall', season: 'all', group: 'Summer', activity: 'climbing' },
  { key: 'other', label: 'Something else', season: 'all', group: 'Other', activity: 'other' },
];
const TYPE_KEYS = TYPES.map((t) => t.key);
const byKey = Object.fromEntries(TYPES.map((t) => [t.key, t]));
const typeLabel = (k) => (byKey[k] ? byKey[k].label : 'Attraction');

/**
 * The patrol report's Activity choices for attractions, in the order the list shows them. 'tubing' was on the list
 * before attractions and keeps its value, so older reports keep their meaning.
 */
const ACTIVITIES = [
  ['tubing', 'Tubing'], ['zipline', 'Zipline or canopy tour'], ['mountain_coaster', 'Mountain coaster'], ['ice_skating', 'Ice skating'],
  ['scenic_lift', 'Scenic lift ride'], ['mountain_biking', 'Mountain biking'], ['disc_golf', 'Disc golf'], ['aerial_park', 'Aerial adventure park'], ['climbing', 'Climbing'],
];
/** The Activity value for an attraction type ('other' for one the list has no word for). */
const activityFor = (type) => (byKey[type] ? byKey[type].activity : 'other');

/**
 * Default daily opening checks, per type: short items in the spirit of the manufacturer's daily inspection and ASTM
 * practice (F2959 for aerial adventure courses and ziplines, F2291 and F770 for rides). Each mountain edits them per
 * attraction (Settings, Attractions). They are a starting list: the manufacturer's manual and the state ride
 * inspector's rules come first. Keys stay fixed once shipped; an inspection keeps the words it was done with.
 */
const TEMPLATES = {
  zipline: [
    ['weather', 'Weather, wind and lightning within the operating limits'],
    ['cables', 'Cables, terminations and clamps visually inspected on every line'],
    ['braking', 'Primary and emergency braking systems checked and reset'],
    ['platforms', 'Platforms, towers, stairs and guardrails checked'],
    ['landing', 'Landing and arrival areas clear'],
    ['harnesses', 'Harnesses, lanyards and connectors inspected and counted'],
    ['trolleys', 'Trolleys inspected and counted, wheels turning freely'],
    ['helmets', 'Helmets inspected and counted'],
    ['rescue', 'Rescue kit at its station and checked'],
    ['test_run', 'Test run on each line with a test weight or a guide'],
    ['radios', 'Radio check with every platform and the base'],
  ],
  coaster: [
    ['weather', 'Weather and wind within the manufacturer\'s limits'],
    ['track', 'Track, rails and supports walked or visually checked'],
    ['clear', 'Track clear of branches, debris, snow and ice'],
    ['lift_section', 'Lift section, chain or cable and anti-rollback checked'],
    ['sleds', 'Sleds inspected: body, wheels and handles'],
    ['brakes', 'Sled hand brakes and the track brake zones tested'],
    ['restraints', 'Seat belts and restraints checked on every sled'],
    ['stations', 'Loading and unloading stations, gates and signs checked'],
    ['estops', 'Emergency stops tested at each station'],
    ['controls', 'Control panel, sensors and block zones working'],
    ['test_runs', 'Empty test runs completed without a fault'],
    ['radios', 'Radio or phone check between the stations'],
  ],
  tubing: [
    ['lanes', 'Lanes groomed, free of ruts, ice and bare spots'],
    ['runouts', 'Run-outs clear and the stopping areas ready'],
    ['barriers', 'Lane dividers, end barriers and padding in place'],
    ['fencing', 'Fencing, nets and signs in place'],
    ['conveyor', 'Conveyor or tow checked, emergency stops tested'],
    ['tubes', 'Tubes inspected for leaks, tears and handles, damaged tubes pulled'],
    ['dispatch', 'Top dispatch area, gates and signals checked'],
    ['test_runs', 'Test run in each lane open today, speed checked'],
    ['radios', 'Radio check between the top and the bottom'],
  ],
  ice_rink: [
    ['surface', 'Ice surface checked for ruts, holes, cracks and soft spots'],
    ['resurfaced', 'Ice resurfaced, or swept and scraped, before opening'],
    ['ice_plant', 'Refrigeration running, or natural ice thickness measured and logged'],
    ['boards', 'Boards, glass, netting and doors checked and latched'],
    ['entries', 'Entry gates and rubber mats in place'],
    ['rentals', 'Skate rental area checked, skates sharpened and sorted by size'],
    ['helmets', 'Helmets and skating aids available and checked'],
    ['lights', 'Lights and the sound system working'],
    ['signs', 'Rink rules and the skating direction posted'],
    ['first_aid', 'First aid kit and a phone or radio at the rink'],
  ],
  scenic_lift: [
    ['lift_inspection', 'The lift\'s daily inspection done and passed'],
    ['weather', 'Weather, wind and lightning within the operating limits'],
    ['loading', 'Loading and unloading areas set up for foot passengers'],
    ['carriers', 'Chairs or cabins, restraint bars and doors checked'],
    ['summit', 'Summit area, paths and railings checked'],
    ['signs', 'Ride rules and signs for foot passengers posted'],
    ['evacuation', 'Evacuation plan and staff ready'],
    ['radios', 'Radio check between the base and the summit'],
  ],
  bike_park: [
    ['trails', 'Trails ridden or walked: features, berms and landings checked'],
    ['closures', 'Closed trails and features roped off and signed'],
    ['signs', 'Trail signs, difficulty markers and the trail map posted'],
    ['carriers', 'Bike carriers on the lift checked'],
    ['rentals', 'Rental bikes and protective gear inspected'],
    ['patrol', 'Bike patrol on duty with first aid and a radio'],
    ['weather', 'Weather and trail moisture checked'],
    ['radios', 'Radio check'],
  ],
  disc_golf: [
    ['course', 'Fairways and tee pads walked, hazards marked'],
    ['baskets', 'Baskets and chains secure'],
    ['signs', 'Tee signs, the course map and out-of-bounds lines in place'],
    ['crossings', 'Crossings with bike trails, roads and lifts signed'],
    ['weather', 'Weather and lightning checked'],
    ['first_aid', 'First aid kit and a way to call for help at the course'],
  ],
  aerial_park: [
    ['weather', 'Weather, wind and lightning within the operating limits'],
    ['elements', 'Elements, cables, platforms and connections visually inspected'],
    ['belay', 'Belay system checked on every course (continuous belay or smart lanyards)'],
    ['zip_brakes', 'Zip line brakes and landing areas checked'],
    ['harnesses', 'Harnesses, lanyards and connectors inspected and counted'],
    ['helmets', 'Helmets inspected and counted'],
    ['ground', 'Ground area clear, fall zones and signs in place'],
    ['rescue', 'Rescue kit at its station and checked'],
    ['radios', 'Radio check between the guides and the base'],
  ],
  climbing_wall: [
    ['holds', 'Holds and wall surface checked, loose or cracked holds removed'],
    ['belay', 'Auto-belays or belay devices tested'],
    ['ropes', 'Ropes, anchors and carabiners inspected'],
    ['harnesses', 'Harnesses and helmets inspected and counted'],
    ['fall_zone', 'Fall zone matting or flooring in place'],
    ['weather', 'Weather and wind checked (outdoor wall)'],
    ['signs', 'Rules posted and a staff member supervising'],
  ],
  other: [
    ['area', 'Area walked and clear of hazards'],
    ['equipment', 'Equipment inspected and counted'],
    ['safety', 'Safety systems and emergency stops tested'],
    ['weather', 'Weather within the operating limits'],
    ['signs', 'Rules and signs posted'],
    ['first_aid', 'First aid kit and a way to call for help'],
    ['radios', 'Radio check'],
  ],
};
const asItems = (list) => list.map(([key, label]) => ({ key, label }));
/** The default opening checks for a type, as [{ key, label }]. */
const templateFor = (type) => asItems(TEMPLATES[type] || TEMPLATES.other);

/** A mountain's own list (JSON text from attractions.checklist), or null when it uses the type's defaults. */
function parseChecklist(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) && v.length ? v.filter((i) => i && i.key && i.label).map((i) => ({ key: String(i.key), label: String(i.label) })) : null;
  } catch (_) { return null; }
}
/** The opening checks an attraction uses today: its own list, or its type's defaults. */
const checklistOf = (a) => parseChecklist(a.checklist) || templateFor(a.type);

/** A stable key for a new item: its words, shortened, and unique within the list. */
function keyFor(label, taken) {
  const stem = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'item';
  let key = stem; let n = 2;
  while (taken.has(key)) key = `${stem}_${n++}`;
  taken.add(key);
  return key;
}
/**
 * A list as a manager saves it: [{ key?, label }]. Items that keep their key keep it (an item reworded keeps its key);
 * new ones get a key from their words.
 */
function normalizeChecklist(items) {
  const taken = new Set();
  const kept = items.map((i) => ({ key: i.key && /^[a-z0-9_]{1,40}$/.test(i.key) && !taken.has(i.key) ? (taken.add(i.key), i.key) : null, label: String(i.label).trim() }));
  return kept.map((i) => ({ key: i.key || keyFor(i.label, taken), label: i.label }));
}

/** Why an attraction stopped, for the downtime log (the lift reasons, and closed for the day). */
const DOWNTIME_REASONS = [
  ['weather', 'Weather'], ['wind', 'Wind'], ['lightning', 'Lightning'], ['mechanical', 'Mechanical'], ['electrical', 'Electrical or power'],
  ['rescue', 'Rescue or evacuation'], ['incident', 'Guest incident'], ['staffing', 'Staffing'], ['inspection', 'Inspection'],
  ['scheduled', 'Scheduled maintenance'], ['day_end', 'Closed for the day'], ['other', 'Other'],
].map(([value, label]) => ({ value, label }));
const DOWNTIME_KEYS = DOWNTIME_REASONS.map((r) => r.value);

/**
 * Staff each type usually needs: positions (in the Attractions department) and the certifications each requires.
 * A manager adds them in one step from Settings, Staff and schedule; nothing is made without asking. Names are
 * suggestions: a mountain renames them to its own words.
 */
const FIRST_AID = 'First aid and CPR';
const STAFF = {
  zipline: [['Zip guide', ['Zipline guide', FIRST_AID]], ['Lead zip guide', ['Zipline guide', 'Zipline rescue', FIRST_AID]]],
  coaster: [['Coaster operator', ['Mountain coaster operator']], ['Coaster attendant', []]],
  tubing: [['Tubing attendant', []], ['Tubing lead', ['Conveyor operator', FIRST_AID]]],
  ice_rink: [['Rink attendant', [FIRST_AID]], ['Ice resurfacer driver', ['Ice resurfacer operator']]],
  scenic_lift: [['Scenic ride attendant', ['Lift operations']]],
  bike_park: [['Bike patroller', [FIRST_AID, 'Bike patrol']], ['Bike park attendant', []]],
  disc_golf: [['Course attendant', []]],
  aerial_park: [['Aerial park guide', ['Aerial park guide', FIRST_AID]], ['Aerial park rescue lead', ['Aerial park rescue', FIRST_AID]]],
  climbing_wall: [['Climbing wall attendant', ['Climbing wall belay', FIRST_AID]]],
  other: [['Attraction attendant', []]],
};
/** { positions: [{ name, requires: [cert names] }], certifications: [names] } for a type. */
function staffFor(type) {
  const positions = (STAFF[type] || STAFF.other).map(([name, requires]) => ({ name, requires }));
  return { positions, certifications: [...new Set(positions.flatMap((p) => p.requires))] };
}

module.exports = { TYPES, TYPE_KEYS, typeLabel, ACTIVITIES, activityFor, TEMPLATES, templateFor, parseChecklist, checklistOf, normalizeChecklist, DOWNTIME_REASONS, DOWNTIME_KEYS, staffFor };
