'use strict';
// Used by scripts/harden.sh: prints the phone-alert (VAPID) key pair kept in the database, so it can move to Secret
// Manager unchanged (phones already signed up keep working). With --forget, removes the database copy afterwards.
const { pool } = require('../src/db');

async function main() {
  if (process.argv.includes('--forget')) { await pool.query("DELETE FROM app_secrets WHERE name = 'vapid'"); return; }
  const [[row]] = await pool.query("SELECT value FROM app_secrets WHERE name = 'vapid'");
  if (row) process.stdout.write(row.value);
}
main().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
