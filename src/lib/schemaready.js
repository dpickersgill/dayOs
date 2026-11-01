'use strict';
// Is the database migrated for this version? Used by /readyz, the status page and scripts/restore-check.js.
//
// Two checks: the last thing the migration adds is there (src/schema.js), and the migration for this release (or a later
// one) ran to the end (db/stepruns.js writes "release <version>" to schema_steps once every step has finished). A run that
// was cut off part way leaves no such row, so the site does not report ready on a half-migrated database.
const { VERSION } = require('./version');

const parts = (v) => String(v).split('.').map((n) => Number(n) || 0);
const atLeast = (have, want) => {
  const a = parts(have); const b = parts(want);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
};

/** q: a pool or a connection on the database to check. Resolves true when migrated for this version. */
async function migrated(q, version = VERSION) {
  const { LATEST } = require('../schema');
  const [r] = LATEST.column
    ? await q.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1', [LATEST.table, LATEST.column])
    : await q.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1', [LATEST.table, LATEST.index]);
  if (!r.length) return false;
  let rows;
  try {
    [rows] = await q.query("SELECT name FROM schema_steps WHERE name LIKE 'release %' AND finished_at IS NOT NULL");
  } catch (_) { return false; } // no schema_steps: migrated by a release before 2026.11.11
  return rows.some((x) => atLeast(x.name.slice('release '.length), version));
}

module.exports = { migrated, atLeast };
