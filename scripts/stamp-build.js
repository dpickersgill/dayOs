'use strict';

// Run when making a release zip: writes the git commit and the time to src/release/build.json, so the app, /version and
// the console can say exactly which code is running. Checks that the version in package.json has a change log entry.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
const log = JSON.parse(fs.readFileSync(path.join(root, 'src', 'release', 'changelog.json'), 'utf8'));
if (!/^\d{4}\.\d{1,2}\.\d+$/.test(version)) { console.error(`package.json version ${version} is not YEAR.MONTH.N`); process.exit(1); }
if (!log.releases.length || log.releases[0].version !== version) { console.error(`The newest change log entry is ${log.releases[0] && log.releases[0].version}, not ${version}. Add the release notes first.`); process.exit(1); }
let build = 'dev';
try { build = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch (_) { /* not a git copy */ }
let dirty = false;
try { dirty = execSync('git status --porcelain -- src db public package.json ":!src/release/build.json"', { cwd: root }).toString().trim() !== ''; } catch (_) { /* not a git copy */ }
const out = { version, build: dirty ? `${build}+` : build, built_at: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'src', 'release', 'build.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`Stamped ${version} build ${out.build}${dirty ? ' (uncommitted changes: commit first for a clean build id)' : ''}`);
