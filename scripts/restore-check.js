'use strict';

// Compares a restored copy of the database with the live one (2026.11.10, READY). Run by scripts/restore-drill.sh, or
// by hand after a real restore (RECOVERY.md):
//   DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=... DB_PASSWORD=... DB_NAME=summitops DRILL_PORT=3308 node scripts/restore-check.js
// The live database is DB_*; the copy is the same login and database on DRILL_HOST (default DB_HOST) and DRILL_PORT
// (and DRILL_DB_NAME, when the copy is a second database on the same server, as in the automated test).
// For each table that matters it prints the rows in each, and for the copy the newest record (how far it reaches).
// It only reads. Exit code 1 when the copy is missing a table, is not migrated, or holds no mountains.
const mysql = require('mysql2/promise');

const TABLES = [
  ['tenants', null], ['users', 'created_at'], ['people', 'created_at'], ['orders', 'created_at'], ['order_payments', 'created_at'],
  ['tickets', 'valid_from'], ['scans', 'scanned_at'], ['waivers', 'signed_at'], ['incidents', 'created_at'], ['shop_orders', 'created_at'],
  ['lesson_bookings', 'created_at'], ['audit_log', 'at'],
];

async function open(port, host, database = process.env.DB_NAME) {
  return mysql.createConnection({ host, port: Number(port), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database, dateStrings: true });
}

async function describe(conn) {
  const out = {};
  for (const [t, col] of TABLES) {
    try {
      const [[r]] = await conn.query(`SELECT COUNT(*) AS n${col ? `, MAX(\`${col}\`) AS newest` : ''} FROM \`${t}\``);
      out[t] = { n: Number(r.n), newest: r.newest || null };
    } catch (err) { out[t] = { error: err.code || err.message }; }
  }
  const { LATEST } = require('../src/schema');
  const [m] = LATEST.column
    ? await conn.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [LATEST.table, LATEST.column])
    : await conn.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [LATEST.table, LATEST.index]);
  out.migrated = m.length > 0;
  return out;
}

async function main() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const live = await open(process.env.DB_PORT || 3307, host);
  const copy = await open(process.env.DRILL_PORT || 3308, process.env.DRILL_HOST || host, process.env.DRILL_DB_NAME || process.env.DB_NAME);
  const [a, b] = [await describe(live), await describe(copy)];
  await live.end(); await copy.end();
  console.log(`${'table'.padEnd(16)} ${'live now'.padStart(10)} ${'restored'.padStart(10)}  newest in the copy (UTC)`);
  let bad = 0;
  for (const [t] of TABLES) {
    const x = a[t]; const y = b[t];
    if (y.error) bad += 1;
    console.log(`${t.padEnd(16)} ${String(x.error ? x.error : x.n).padStart(10)} ${String(y.error ? y.error : y.n).padStart(10)}  ${y.newest || ''}`);
  }
  console.log(`\nThe copy is ${b.migrated ? '' : 'NOT '}migrated for this release.`);
  if (process.env.DRILL_AT) {
    const newest = TABLES.map(([t]) => b[t] && b[t].newest).filter(Boolean).sort().pop();
    if (newest) {
      const lost = Math.round((Date.parse(process.env.DRILL_AT) - Date.parse(`${newest.replace(' ', 'T')}Z`)) / 1000);
      console.log(`Asked for ${process.env.DRILL_AT}; the newest record in the copy is ${newest} UTC (${lost >= 0 ? `${lost} seconds before` : `${-lost} seconds after`}). Fewer rows in the copy than live is expected: live has kept working since.`);
    }
  }
  if (bad || !b.migrated || !(b.tenants && b.tenants.n > 0)) { console.log('Something is wrong with the copy: see above.'); process.exitCode = 1; }
}

main().catch((err) => { console.error(`Could not compare: ${err.message}`); process.exit(1); });
