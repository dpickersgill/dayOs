// The ski school's one level scale (PSIA-AASI's nine levels), for the screens. Keep in step with src/lib/levels.js.
export const SKI = [
  null,
  {
    "short": "First time",
    "can": "I have never skied, or only tried once."
  },
  {
    "short": "Stopping",
    "can": "I can slide, stop and turn a little on the beginner slope."
  },
  {
    "short": "Wedge turns",
    "can": "I can link wedge (pizza) turns on the easiest green runs."
  },
  {
    "short": "Matching skis",
    "can": "I can ride the lift and my skis start to match at the end of my turns on green runs."
  },
  {
    "short": "Green parallel",
    "can": "I make parallel turns on green runs and wedge turns on easy blue runs."
  },
  {
    "short": "Blue runs",
    "can": "I make parallel turns on blue runs and can stop quickly."
  },
  {
    "short": "All blues",
    "can": "I am confident on every blue run and starting on black runs."
  },
  {
    "short": "Black runs",
    "can": "I ski black runs, bumps and different snow with control."
  },
  {
    "short": "All terrain",
    "can": "I ski any run in any snow, including steeps, trees and the park."
  }
];
export const SNOWBOARD = [
  null,
  {
    "short": "First time",
    "can": "I have never ridden, or only tried once."
  },
  {
    "short": "Sliding",
    "can": "I can strap in, slide on one foot and stop on my heel edge."
  },
  {
    "short": "Falling leaf",
    "can": "I can slide side to side on my heel and toe edges on the beginner slope."
  },
  {
    "short": "First turns",
    "can": "I can ride the lift and link a few turns on green runs."
  },
  {
    "short": "Linked turns",
    "can": "I link turns on every green run and some easy blues."
  },
  {
    "short": "Blue runs",
    "can": "I ride blue runs with control and can ride a little switch."
  },
  {
    "short": "All blues",
    "can": "I am confident on every blue run, carving and starting on black runs."
  },
  {
    "short": "Black runs",
    "can": "I ride black runs, bumps and the park with control."
  },
  {
    "short": "All terrain",
    "can": "I ride any run in any snow, including steeps, trees and the park."
  }
];
export const MIN = 1;
export const MAX = 9;
const scale = (d) => (d === 'snowboard' ? SNOWBOARD : SKI);
const valid = (n) => Number.isInteger(n) && n >= MIN && n <= MAX;
/** 'Level 3: Wedge turns' */
export function levelName(level, discipline = 'ski') { const n = Number(level); return valid(n) ? `Level ${n}: ${scale(discipline)[n].short}` : ''; }
/** 'Levels 2 to 3', 'Level 1', 'All levels' */
export function levelRange(min, max) { const a = Number(min) || null; const b = Number(max) || null; if (!a && !b) return 'All levels'; if (a && b && a === b) return `Level ${a}`; return `Levels ${a || MIN} to ${b || MAX}`; }
/** [{ level, short, can }] for a discipline */
export const levelList = (discipline = 'ski') => scale(discipline).slice(1).map((l, i) => ({ level: i + 1, ...l }));
/** [value, label] pairs for a select */
export const levelOptions = (discipline = 'ski') => levelList(discipline).map((l) => [String(l.level), `${l.level}: ${l.short}`]);
