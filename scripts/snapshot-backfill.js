'use strict';

// One-off: rebuilds forecast data (daily_snapshots) for the past season from the tables already there, so next season's
// forecast has a year to compare with. Run once after the release that adds snapshots, from the app folder with the
// database settings in the environment:
//
//   node scripts/snapshot-backfill.js                     every real mountain, start of last season to yesterday
//   node scripts/snapshot-backfill.js --tenant 12         one mountain
//   node scripts/snapshot-backfill.js --from 2025-11-15 --to 2026-04-15
//
// What can be rebuilt, and how, is in lib/snapshots.js (backfill). Rows are marked backfilled. A day the daily job
// already took is never changed, and running the script again gives the same rows, so it is safe to run twice.
const { pool, rows } = require('../src/db');
const { backfill } = require('../src/lib/snapshots');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const day = (v, name) => {
  if (v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) { console.error(`--${name} must be YYYY-MM-DD`); process.exit(2); }
  return v;
};

async function main() {
  const tenant = arg('tenant'); const from = day(arg('from'), 'from'); const to = day(arg('to'), 'to');
  const list = await rows(pool, `SELECT id, slug FROM tenants WHERE status = 'active' AND sandbox_expires_at IS NULL${tenant ? ' AND id = ?' : ''} ORDER BY id`, tenant ? [Number(tenant)] : []);
  if (!list.length) { console.log('No mountain to fill in.'); return; }
  const started = Date.now();
  let failed = 0;
  for (const t of list) {
    try {
      const r = await backfill(pool, t.id, { from, to });
      console.log(`${t.slug}: ${r.days} day(s) from ${r.from} to ${r.to}: ${r.presales} presales, ${r.forecast} weather, ${r.staffing} staffing`);
    } catch (err) {
      failed += 1;
      console.error(`${t.slug}: not filled in: ${err.message}`);
    }
  }
  console.log(`Done in ${Math.round((Date.now() - started) / 1000)} seconds. ${list.length - failed} mountain(s) filled in${failed ? `, ${failed} failed` : ''}.`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { main };
