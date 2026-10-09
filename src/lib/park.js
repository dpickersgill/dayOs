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

module.exports = { KINDS, KIND_KEYS, GROUPS };
