'use strict';
// Used by scripts/staging-setup.sh. Signed in as an admin login of the server staging uses, makes (or updates) the
// staging login: it can do what the app and its migrations need inside the staging database, and nothing at all
// anywhere else, so nothing running on staging can read or change live data.
//   printf %s "$PW" | node scripts/staging-db-user.js <user> - <staging database>
// The password comes on stdin, never the command line (other programs and the shell history would see it).
// Since 2026.11.11 the login has no EVENT privilege (a scheduled event would keep running on the database server after
// staging stops) and at most STAGING_MAX_CONNECTIONS connections (default 10), so staging can never take the
// connections a shared live server needs.
const { pool } = require('../src/db');

// What the app and its migrations use. Not ALL PRIVILEGES: that includes EVENT (and on MySQL, more each version).
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER', 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER'];
const readStdin = async () => { let d = ''; for await (const c of process.stdin) d += c; return d.replace(/\r?\n$/, ''); };

async function main() {
  const [user, pwArg, db] = process.argv.slice(2);
  if (pwArg !== '-') throw new Error('Usage: printf %s "$PW" | staging-db-user.js <user> - <database>   (the password on stdin, never the command line)');
  const password = await readStdin();
  const max = Math.max(1, Math.min(Number(process.env.STAGING_MAX_CONNECTIONS) || 10, 50));
  if (!/^[a-z_][a-z0-9_]{2,31}$/.test(user || '') || !/^[a-z_][a-z0-9_]{2,63}$/.test(db || '') || !password || password.length < 24) {
    throw new Error('Usage: printf %s "$PW" | staging-db-user.js <user> - <database>   (a password of 24+ characters)');
  }
  if (db === process.env.DB_NAME) throw new Error('The staging database must not be the live one');
  await pool.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [user, password]);
  await pool.query(`ALTER USER ?@'%' IDENTIFIED BY ? WITH MAX_USER_CONNECTIONS ${max}`, [user, password]);
  // A login made before 2026.11.11 holds ALL PRIVILEGES on the staging database (EVENT included): narrow it.
  const before = (await pool.query("SHOW GRANTS FOR ?@'%'", [user]))[0].map((g) => Object.values(g)[0]);
  if (before.some((l) => /^GRANT ALL PRIVILEGES ON /.test(l) || /\bEVENT\b/.test(l))) {
    await pool.query(`REVOKE ALL PRIVILEGES ON \`${db}\`.* FROM ?@'%'`, [user]);
  }
  // No REVOKE on *.* : Cloud SQL refuses it even to its admin login (it would touch Google's own system schemas). A new
  // login has nothing there, and the check below stops if this one can reach anything but the staging database.
  await pool.query(`GRANT ${PRIVS.join(', ')} ON \`${db}\`.* TO ?@'%'`, [user]);
  const [grants] = await pool.query("SHOW GRANTS FOR ?@'%'", [user]);
  const lines = grants.map((g) => Object.values(g)[0]);
  const other = lines.filter((l) => !/^GRANT USAGE ON \*\.\*/.test(l) && !l.includes(`\`${db}\`.*`));
  if (other.length) throw new Error(`The staging login can reach more than the staging database: ${other.join('; ')}`);
  if (lines.some((l) => /\bEVENT\b|ALL PRIVILEGES/.test(l))) throw new Error(`The staging login still holds EVENT or ALL PRIVILEGES: ${lines.join('; ')}`);
  console.log(`${user} can reach ${db} and nothing else (no EVENT; at most ${max} connections).`);
}

if (require.main === module) main().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
module.exports = { PRIVS };
