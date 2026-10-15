'use strict';

// Used by deploy.sh before anything is installed or migrated: compares this folder's version with the one live.
//   node scripts/check-version.js <live version or empty> [--allow-older]
// Exits 1 (and deploys nothing) when this folder is older than what is live, unless --allow-older is given.
const { VERSION, compare } = require('../src/lib/version');

const live = (process.argv[2] || '').trim();
const allowOlder = process.argv.includes('--allow-older');
if (!live) { console.log(`Deploying ${VERSION}. The live site does not report a version yet (it is from before version numbers).`); process.exit(0); }
const d = compare(VERSION, live);
if (d > 0) { console.log(`Deploying ${VERSION} over ${live}.`); process.exit(0); }
if (d === 0) { console.log(`Deploying ${VERSION} again (the same version is live). That is fine for a redeploy.`); process.exit(0); }
if (allowOlder) { console.log(`Going back: deploying ${VERSION} over the newer ${live}, as asked (--allow-older).`); process.exit(0); }
console.error(`Stopped: this folder is ${VERSION}, but ${live} is live, which is newer. Nothing was changed.`);
console.error('Check you unzipped the newest zip into this folder. To go back on purpose, run: bash deploy.sh --allow-older');
process.exit(1);
