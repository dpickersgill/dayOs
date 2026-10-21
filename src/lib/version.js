'use strict';

// Which version of Verdynt/OS this is, and what changed in each release.
//
// Version numbers are calendar versions: YEAR.MONTH.N, where N counts the releases in that month (2026.10.4 is the
// fourth release of October 2026). The number lives in package.json and goes up by one with every zip that is deployed.
// The build is the short git commit the zip was made from, written to src/release/build.json when the zip is made
// (scripts/stamp-build.js); a copy without it says "dev".
//
// What changed lives in src/release/changelog.json, newest release first. Each note says:
//   kind: new | improved | fixed
//   app:  the app it belongs to (a key from lib/modules.js), or null for everyone
//   who:  null for every role, a list of roles (owners and managers always see every note for their apps),
//         or "platform" for notes only the operator sees in the console
//   text: one plain sentence, written for the people who use the app
//   help: optional help article id
const fs = require('fs');
const path = require('path');

const VERSION = require('../../package.json').version;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release', file), 'utf8')); } catch (_) { return fallback; }
}
const stamp = readJson('build.json', {});
const BUILD = typeof stamp.build === 'string' && stamp.build ? stamp.build : 'dev';
const BUILT_AT = stamp.built_at || null;
const RELEASES = readJson('changelog.json', { releases: [] }).releases;
/** What is planned (src/release/roadmap.json): stages (now, next, later), each with plain-language items. */
const roadmap = () => readJson('roadmap.json', { updated: null, stages: [] });

/** Compares two calendar versions: negative when a is older, 0 when the same, positive when newer. Missing counts as oldest. */
function compare(a, b) {
  const parts = (v) => (/^\d+(\.\d+)*$/.test(String(v || '')) ? String(v).split('.').map(Number) : null);
  const x = parts(a); const y = parts(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

const MANAGERS = ['owner', 'manager'];
/** Can this person see this note? modules is the mountain's list of apps that are on (null means every app). */
function noteFor(note, { role, modules }) {
  if (note.who === 'platform') return false;
  if (note.app && modules && !modules.includes(note.app)) return false;
  if (MANAGERS.includes(role)) return true;
  return !Array.isArray(note.who) || note.who.includes(role);
}

/** The releases this person would care about, newest first, each with only their notes; releases left empty are dropped. */
function releasesFor(viewer) {
  return RELEASES.map((r) => ({ version: r.version, date: r.date, title: r.title || null, notes: r.notes.filter((n) => noteFor(n, viewer)).map(({ kind, app, text, help }) => ({ kind, app: app || null, text, help: help || null })) }))
    .filter((r) => r.notes.length);
}

/**
 * How many notes are new to someone who last opened What's new at version `seen`. Someone who has never opened it
 * (seen is empty) counts only the newest release, so nobody starts with a badge for the whole history.
 */
function unseenCount(releases, seen) {
  if (!releases.length) return 0;
  if (!seen) return compare(releases[0].version, VERSION) <= 0 ? releases[0].notes.length : 0;
  return releases.filter((r) => compare(r.version, seen) > 0 && compare(r.version, VERSION) <= 0).reduce((n, r) => n + r.notes.length, 0);
}

module.exports = { VERSION, BUILD, BUILT_AT, RELEASES, roadmap, compare, noteFor, releasesFor, unseenCount };
