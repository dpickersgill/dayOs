'use strict';

// Terrain park feature types. Stored as a short key; the label and group are for screens.
// portable: boxes and rails are moved around daily, jumps and pipes are built and usually stay.
const GROUPS = {
  rails: 'Rails',
  boxes: 'Boxes and ground features',
  jumps: 'Jumps',
  pipes: 'Pipes and banks',
  other: 'Other',
};

// [key, label, group, portable]
const KIND_LIST = [
  ['rail_flat', 'Flat rail', 'rails', true],
  ['rail_flat_down', 'Flat-down rail', 'rails', true],
  ['rail_down', 'Down rail', 'rails', true],
  ['rail_kinked', 'Kinked rail', 'rails', true],
  ['rail_rainbow', 'Rainbow rail', 'rails', true],
  ['rail_c', 'C-rail', 'rails', true],
  ['rail_s', 'S-rail', 'rails', true],
  ['rail_double_kink', 'Double kink rail', 'rails', true],
  ['tube', 'Tube', 'rails', true],
  ['pole_jam', 'Pole jam', 'rails', true],
  ['butter_box', 'Butter box', 'boxes', true],
  ['a_frame', 'A-frame box', 'boxes', true],
  ['down_box', 'Down box', 'boxes', true],
  ['mailbox', 'Mailbox', 'boxes', true],
  ['barrel', 'Barrel or log', 'boxes', true],
  ['picnic_table', 'Picnic table', 'boxes', true],
  ['stump', 'Stump', 'boxes', true],
  ['wall_ride', 'Wall ride', 'boxes', false],
  ['roller', 'Rollers', 'jumps', false],
  ['tabletop', 'Tabletop', 'jumps', false],
  ['step_up', 'Step-up', 'jumps', false],
  ['step_down', 'Step-down', 'jumps', false],
  ['gap', 'Gap jump', 'jumps', false],
  ['hip', 'Hip', 'jumps', false],
  ['spine', 'Spine', 'jumps', false],
  ['kicker', 'Wedge or kicker', 'jumps', false],
  ['halfpipe', 'Halfpipe', 'pipes', false],
  ['quarterpipe', 'Quarterpipe', 'pipes', false],
  ['bank', 'Bank or berm', 'pipes', false],
  ['boardercross', 'Boardercross run', 'pipes', false],
  ['tunnel', 'Tunnel', 'other', false],
  ['kids', 'Kids feature', 'other', true],
  ['other', 'Other', 'other', true],
];

const KINDS = KIND_LIST.map(([key, label, group, portable]) => ({ key, label, group, group_label: GROUPS[group], portable }));
const KIND_KEYS = KINDS.map((k) => k.key);

// Feature sizes, smallest first, and the area ratings. An area is rated S, M, L or XL like the size signs at its entrance,
// or is a beginner or progression zone (features up to S). A feature larger than its area's rating needs a reason.
const SIZES = [['xs', 'XS'], ['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']];
const SIZE_KEYS = SIZES.map((s) => s[0]);
const LEVELS = [['beginner', 'Beginner or progression zone'], ['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']];
const LEVEL_KEYS = LEVELS.map((l) => l[0]);
const LEVEL_MAX = { beginner: 's', s: 's', m: 'm', l: 'l', xl: 'xl' };
const sizeRank = (s) => SIZE_KEYS.indexOf(s);
/** Is a feature of this size larger than an area of this level allows? */
const overRating = (size, level) => Boolean(level && LEVEL_MAX[level]) && sizeRank(size) > sizeRank(LEVEL_MAX[level]);

// What a crew member looks at on each kind of feature. Every item is answered pass, fail or not applicable, and a fail
// needs a note. The signage and surface items are on every feature.
const CHECKS = {
  jumps: [['approach', 'Approach'], ['takeoff_lip', 'Takeoff lip'], ['knuckle', 'Knuckle'], ['landing', 'Landing'], ['run_out', 'Run-out'], ['deck_gap', 'Deck or gap']],
  rails: [['burrs', 'No burrs or sharp edges'], ['hardware', 'Bolts and hardware tight'], ['end_caps', 'End caps on'], ['buried_ends', 'Buried ends and supports'], ['snow_on_off', 'Takeoff and landing snow']],
  pipes: [['walls', 'Walls'], ['deck', 'Deck'], ['transitions', 'Transitions']],
  other: [],
};
CHECKS.boxes = CHECKS.rails;
const COMMON_CHECKS = [['signage', 'Signage on the feature'], ['surface', 'Surface around the feature']];
// A wall ride is checked like a pipe or wall, though it is listed with the boxes.
const CHECK_GROUP = { wall_ride: 'pipes' };
/** The checklist for one feature type: [{ key, label }]. */
function checklistFor(kind) {
  const k = KINDS.find((x) => x.key === kind);
  const group = CHECK_GROUP[kind] || (k ? k.group : 'other');
  return [...(CHECKS[group] || []), ...COMMON_CHECKS].map(([key, label]) => ({ key, label }));
}

const INSPECTION_KINDS = [['morning', 'Morning'], ['midday', 'Mid-day'], ['after_grooming', 'After grooming'], ['after_snow', 'After new snow'], ['after_change', 'After a change'], ['post_incident', 'Post-incident']];
const INSPECTION_KIND_KEYS = INSPECTION_KINDS.map((k) => k[0]);
// The words for each result. A pass never says "safe": it says what was found.
const RESULTS = [['ok', 'Inspected, no defects found, open'], ['needs_attention', 'Needs attention'], ['closed', 'Close it']];

// Opening an area: what the supervisor checks before the rope comes down.
const SIGNOFF = [
  ['entrance_sign', 'Entrance sign with the orange oval'],
  ['code_sign', 'Park SMART or code sign'],
  ['size_signs', 'Size signs match today\'s layout'],
  ['ropes', 'Rope lines and closures in place'],
  ['visibility', 'Visibility and surface checked'],
  ['test_ride', 'Test ride done on every jump and rail'],
];
const SIGNOFF_KEYS = SIGNOFF.map((s) => s[0]);
const CLOSE_REASONS = [['weather', 'Weather'], ['visibility', 'Visibility or flat light'], ['wind', 'Wind'], ['hard_snow', 'Hard or icy snow'], ['other', 'Other']];
const CLOSE_REASON_KEYS = CLOSE_REASONS.map((r) => r[0]);

module.exports = {
  KINDS, KIND_KEYS, GROUPS, SIZES, SIZE_KEYS, LEVELS, LEVEL_KEYS, LEVEL_MAX, sizeRank, overRating, checklistFor,
  INSPECTION_KINDS, INSPECTION_KIND_KEYS, RESULTS, SIGNOFF, SIGNOFF_KEYS, CLOSE_REASONS, CLOSE_REASON_KEYS,
};
