'use strict';
// Used by scripts/staging-setup.sh. Signed in as the live database's migration login, makes (or updates) the staging
// login: it can do anything inside the staging database, and nothing at all anywhere else, so nothing running on
// staging can read or change live data.
//   node scripts/staging-db-user.js <user> <password> <staging database>
const { pool } = require('../src/db');

async function main() {
  const [user, password, db] = process.argv.slice(2);
  if (!/^[a-z_][a-z0-9_]{2,31}$/.test(user || '') || !/^[a-z_][a-z0-9_]{2,63}$/.test(db || '') || !password || password.length < 24) {
    throw new Error('Usage: staging-db-user.js <user> <password of 24+ characters> <database>');
  }
  if (db === process.env.DB_NAME) throw new Error('The staging database must not be the live one');
  await pool.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [user, password]);
  await pool.query("ALTER USER ?@'%' IDENTIFIED BY ?", [user, password]);
  await pool.query("REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@'%'", [user]);
  await pool.query(`GRANT ALL PRIVILEGES ON \`${db}\`.* TO ?@'%'`, [user]);
  const [grants] = await pool.query("SHOW GRANTS FOR ?@'%'", [user]);
  const lines = grants.map((g) => Object.values(g)[0]);
  const other = lines.filter((l) => !/^GRANT USAGE ON \*\.\*/.test(l) && !l.includes(`\`${db}\`.*`));
  if (other.length) throw new Error(`The staging login can reach more than the staging database: ${other.join('; ')}`);
  console.log(`${user} can reach ${db} and nothing else.`);
}

main().then(() => pool.end()).catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
