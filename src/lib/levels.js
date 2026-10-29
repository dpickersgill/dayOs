'use strict';
// One level scale for the whole ski school: PSIA-AASI's nine levels, in plain words. Level 1 is a first time on snow,
// level 9 skis or rides anything. Lessons teach a range (level_min to level_max), guests carry their own level per
// discipline (people.ski_level, people.snowboard_level), and instructors are cleared up to a level
// (instructor_profiles.ski_level_max, snowboard_level_max). The same list is in public/js/levels.js for the screens.

const SKI = [
  null,
  { short: 'First time', can: 'I have never skied, or only tried once.' },
  { short: 'Stopping', can: 'I can slide, stop and turn a little on the beginner slope.' },
  { short: 'Wedge turns', can: 'I can link wedge (pizza) turns on the easiest green runs.' },
  { short: 'Matching skis', can: 'I can ride the lift and my skis start to match at the end of my turns on green runs.' },
  { short: 'Green parallel', can: 'I make parallel turns on green runs and wedge turns on easy blue runs.' },
  { short: 'Blue runs', can: 'I make parallel turns on blue runs and can stop quickly.' },
  { short: 'All blues', can: 'I am confident on every blue run and starting on black runs.' },
  { short: 'Black runs', can: 'I ski black runs, bumps and different snow with control.' },
  { short: 'All terrain', can: 'I ski any run in any snow, including steeps, trees and the park.' },
];
const SNOWBOARD = [
  null,
  { short: 'First time', can: 'I have never ridden, or only tried once.' },
  { short: 'Sliding', can: 'I can strap in, slide on one foot and stop on my heel edge.' },
  { short: 'Falling leaf', can: 'I can slide side to side on my heel and toe edges on the beginner slope.' },
  { short: 'First turns', can: 'I can ride the lift and link a few turns on green runs.' },
  { short: 'Linked turns', can: 'I link turns on every green run and some easy blues.' },
  { short: 'Blue runs', can: 'I ride blue runs with control and can ride a little switch.' },
  { short: 'All blues', can: 'I am confident on every blue run, carving and starting on black runs.' },
  { short: 'Black runs', can: 'I ride black runs, bumps and the park with control.' },
  { short: 'All terrain', can: 'I ride any run in any snow, including steeps, trees and the park.' },
];
const MIN = 1;
const MAX = 9;
const LEGACY = { first_timer: [1, 1], beginner: [2, 3], intermediate: [4, 6], advanced: [7, 9] };

const scale = (discipline) => (discipline === 'snowboard' ? SNOWBOARD : SKI);
const valid = (n) => Number.isInteger(n) && n >= MIN && n <= MAX;

/** 'Level 3: Wedge turns' */
function name(level, discipline = 'ski') {
  const n = Number(level);
  if (!valid(n)) return '';
  return `Level ${n}: ${scale(discipline)[n].short}`;
}

/** 'Levels 2 to 3', 'Level 1', 'All levels' */
function range(min, max) {
  const a = Number(min) || null; const b = Number(max) || null;
  if (!a && !b) return 'All levels';
  if (a && b && a === b) return `Level ${a}`;
  return `Levels ${a || MIN} to ${b || MAX}`;
}

/** The old four words as a range on the scale. */
function fromLegacy(word) { return LEGACY[word] || null; }

/** The old word for a level, for screens and exports that still show it. */
function toLegacy(level) {
  const n = Number(level);
  if (!valid(n)) return null;
  return n === 1 ? 'first_timer' : n <= 3 ? 'beginner' : n <= 6 ? 'intermediate' : 'advanced';
}

/** Does a lesson's range include this level? A lesson with no range takes anyone. */
function fits(level, min, max) {
  const n = Number(level);
  if (!valid(n)) return true;
  return (!min || n >= Number(min)) && (!max || n <= Number(max));
}

/** The guest's level for a discipline, from the people row. */
function personLevel(person, discipline) {
  if (!person) return null;
  return (discipline === 'snowboard' ? person.snowboard_level : person.ski_level) || null;
}

/** The column to write a guest's level to. */
const personColumn = (discipline) => (discipline === 'snowboard' ? 'snowboard_level' : 'ski_level');

/** Can an instructor with this profile teach this lesson range? No profile limit means no limit. */
function instructorCovers(profile, discipline, levelMax) {
  if (!profile || !levelMax) return true;
  const cap = discipline === 'snowboard' ? profile.snowboard_level_max : profile.ski_level_max;
  return !cap || Number(levelMax) <= Number(cap);
}

const list = (discipline = 'ski') => scale(discipline).slice(1).map((l, i) => ({ level: i + 1, ...l }));

module.exports = { MIN, MAX, SKI, SNOWBOARD, LEGACY, name, range, fromLegacy, toLegacy, fits, valid, personLevel, personColumn, instructorCovers, list };
