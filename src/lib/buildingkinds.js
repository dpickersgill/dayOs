'use strict';

// Asset kinds for what sits inside a building and has a life-safety check of its own (muni release 1, Buildings). Added to
// the asset register's list of kinds (lib/ops.js ASSET_KINDS), in the "Buildings and facilities" category. Generators,
// boilers and HVAC units already had kinds of their own. Keys are at most 30 characters (ops_assets.kind).
const KINDS = [
  ['fire_extinguisher', 'Fire extinguisher'],
  ['sprinkler', 'Sprinkler system or riser'],
  ['fire_alarm', 'Fire alarm panel'],
  ['exit_lights', 'Exit and emergency lights (a group)'],
  ['kitchen_hood', 'Kitchen hood suppression'],
  ['elevator', 'Elevator'],
  ['backflow', 'Backflow preventer'],
  ['playground', 'Playground structure'],
  ['roof', 'Roof'],
].map(([value, label]) => ({ value, label, category: 'facility' }));

module.exports = { KINDS };
