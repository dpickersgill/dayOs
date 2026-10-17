'use strict';
// Used by scripts/harden.sh and deploy.sh. Signed in as the migration login, makes (or updates) the login the running
// app uses: it can read and change rows but cannot change tables, add logins or grant anything, and it cannot rewrite
// the audit trail (audit_log and platform_audit: add and remove only, never edit). Grants are per table, so deploy.sh
// runs this after every migration to cover new tables.
//   node scripts/db-runtime-user.js <user> <password>   make the login, or set its password, and grant
//   node scripts/db-runtime-user.js <user>              only refresh the grants (after a migration)
const { pool } = require('../src/db');

const APPEND_ONLY = ['audit_log', 'platform_audit']; // DELETE stays so a departed mountain can be removed in full

async function main() {
  const [user, password] = process.argv.slice(2);
  if (!/^[a-z_][a-z0-9_]{2,31}$/.test(user || '') || (password !== undefined && password.length < 24)) {
    throw new Error('Usage: db-runtime-user.js <user> [password of 24+ characters]');
  }
  const db = String(process.env.DB_NAME).replace(/`/g, '');
  if (password !== undefined) {
    await pool.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [user, password]);
    await pool.query("ALTER USER ?@'%' IDENTIFIED BY ?", [user, password]);
  } else {
    const [[found]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.user_privileges WHERE grantee = CONCAT(QUOTE(?), '@', QUOTE('%'))", [user]);
    if (!found.n) { console.log(`No login ${user}; nothing to do.`); return; }
  }
  // Start from nothing, then give exactly what the app needs, table by table.
  await pool.query("REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@'%'", [user]);
  const [tables] = await pool.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [db]);
  for (const { t } of tables) {
    const name = String(t).replace(/`/g, '');
    const what = APPEND_ONLY.includes(name) ? 'SELECT, INSERT, DELETE' : 'SELECT, INSERT, UPDATE, DELETE';
    await pool.query(`GRANT ${what} ON \`${db}\`.\`${name}\` TO ?@'%'`, [user]);
  }
  console.log(`${user} may read and change rows in ${tables.length} tables (audit tables cannot be edited).`);
}

main().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
