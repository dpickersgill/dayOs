'use strict';

// Copies every row from one SummitOps database into another that `npm run migrate` has just set up (used to move from
// Aiven to Cloud SQL). The target's tables are emptied first, then filled table by table, keeping every id, so nothing
// that points at something else changes. Afterwards each table's row count is compared, and the script exits 1 if any
// differ.
//
//   SRC_HOST SRC_PORT SRC_USER SRC_PASSWORD SRC_NAME [SRC_SSL=true SRC_CA=<certificate text>]   the database to copy from
//   DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME [DB_SOCKET]                                   the database to copy into
//   node db/copy-db.js
const mysql = require('mysql2/promise');
const config = require('../src/config');

const MAX_BATCH_BYTES = 4 * 1024 * 1024; // well under the target's largest allowed statement
const MAX_BATCH_ROWS = 500;

function source() {
  const e = process.env;
  for (const k of ['SRC_HOST', 'SRC_USER', 'SRC_NAME']) if (!e[k]) throw new Error(`${k} is not set`);
  const ssl = e.SRC_SSL === 'true' ? (e.SRC_CA ? { ca: e.SRC_CA, rejectUnauthorized: true } : { rejectUnauthorized: true }) : undefined;
  return { host: e.SRC_HOST, port: Number(e.SRC_PORT || 3306), user: e.SRC_USER, password: e.SRC_PASSWORD || '', database: e.SRC_NAME, ssl };
}

// JSON columns come back as text (not parsed), so they go back in exactly as they were.
const common = { dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4',
  typeCast: (field, next) => (field.type === 'JSON' ? field.string('utf8') : next()) };

const size = (v) => (v === null || v === undefined ? 4 : Buffer.isBuffer(v) ? v.length : String(v).length * 2);

async function main() {
  const src = await mysql.createConnection({ ...source(), ...common });
  const dst = await mysql.createConnection({
    socketPath: config.db.socketPath, host: config.db.host, port: config.db.port, user: config.db.user,
    password: config.db.password, database: config.db.database, ssl: config.db.sslOptions, ...common,
  });
  // Both sides on UTC, so TIMESTAMP values come out and go back in unchanged.
  for (const c of [src, dst]) await c.query("SET time_zone = '+00:00'");
  await dst.query('SET FOREIGN_KEY_CHECKS = 0');
  await dst.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'"); // keep any id 0 as it is, and accept rows exactly as they were

  const [srcTables] = await src.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
  const [dstTables] = await dst.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
  const have = new Set(srcTables.map((r) => r.t));
  const missing = srcTables.map((r) => r.t).filter((t) => !dstTables.some((d) => d.t === t));
  if (missing.length) console.log(`Not in the new database (skipped): ${missing.join(', ')}`);

  const results = [];
  for (const { t } of dstTables) {
    await dst.query(`DELETE FROM \`${t}\``);
    if (!have.has(t)) { results.push({ t, from: 0, to: 0 }); continue; }
    // Generated columns are worked out by the database itself, and a column only on one side is left alone.
    const [dCols] = await dst.query("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND EXTRA NOT LIKE '%GENERATED%' ORDER BY ORDINAL_POSITION", [t]);
    const [sCols] = await src.query("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]);
    const sSet = new Set(sCols.map((r) => r.c));
    const cols = dCols.map((r) => r.c).filter((c) => sSet.has(c));
    const list = cols.map((c) => `\`${c}\``).join(', ');
    const [[{ n }]] = await src.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    const total = Number(n);
    let done = 0;
    let batch = []; let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await dst.query(`INSERT INTO \`${t}\` (${list}) VALUES ?`, [batch]);
      done += batch.length; batch = []; bytes = 0;
    };
    // Read in pages of the primary key order where there is one, so a big table never sits in memory at once.
    const [pk] = await src.query("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION", [t]);
    const order = pk.length ? ` ORDER BY ${pk.map((r) => `\`${r.c}\``).join(', ')}` : '';
    for (let offset = 0; offset < total; offset += 200) {
      const [rows] = await src.query({ sql: `SELECT ${list} FROM \`${t}\`${order} LIMIT 200 OFFSET ${offset}`, rowsAsArray: true });
      for (const raw of rows) {
        // A JSON column can still arrive parsed (some servers flag it); turn it back into the same text.
        const r = raw.map((v) => (v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? JSON.stringify(v) : v));
        const b = r.reduce((s, v) => s + size(v), 0);
        if (batch.length && (bytes + b > MAX_BATCH_BYTES || batch.length >= MAX_BATCH_ROWS)) await flush();
        batch.push(r); bytes += b;
      }
    }
    await flush();
    const [[{ m }]] = await dst.query(`SELECT COUNT(*) AS m FROM \`${t}\``);
    results.push({ t, from: total, to: Number(m) });
    process.stdout.write(`${t}: ${done} row${done === 1 ? '' : 's'}\n`);
  }
  await dst.query('SET FOREIGN_KEY_CHECKS = 1');
  const bad = results.filter((r) => r.from !== r.to);
  const rowsCopied = results.reduce((s, r) => s + r.to, 0);
  if (bad.length) {
    console.error(`\nROW COUNTS DIFFER in ${bad.length} table(s):`);
    for (const r of bad) console.error(`  ${r.t}: ${r.from} in the old database, ${r.to} in the new one`);
    process.exitCode = 1;
  } else {
    console.log(`\nCopied ${rowsCopied} rows in ${results.length} tables. Every table's row count matches.`);
  }
  await src.end(); await dst.end();
}

main().catch((err) => { console.error('Copy failed:', err.message); process.exit(1); });
