'use strict';
// Used by scripts/harden.sh and promote.sh. Signed in as the migration login, makes (or updates) the login the running
// app uses: it can read and change rows but cannot change tables, add logins or grant anything, and it cannot rewrite
// or remove the audit trail (audit_log and platform_audit: read and add only). Grants are per table, so promote.sh runs
// this after every migration to cover new tables.
//
// It only adds what is missing and takes away only what is wrong, table by table, and never starts from nothing: the
// live app keeps serving while this runs, and a login stripped of everything (even for a second, or for good if the
// connection drops part way) would fail every request. Run again, it reads the login's grants once and changes nothing.
//   node scripts/db-runtime-user.js <user> <password>   make the login, or set its password, and grant
//   node scripts/db-runtime-user.js <user>              only refresh the grants (after a migration)
//   add --dry-run to print the statements without running them

const APPEND_ONLY = ['audit_log', 'platform_audit']; // read and add only: nothing in the app edits or removes audit rows
const RUNTIME = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const APPEND = ['SELECT', 'INSERT'];
// What ALL PRIVILEGES means on one table, so a table granted ALL can be trimmed to what the app needs.
// (The ones MySQL and MariaDB share; MariaDB's DELETE HISTORY only applies to versioned tables, which there are none of.)
const TABLE_ALL = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'REFERENCES', 'INDEX', 'ALTER', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER'];

const unquote = (s) => s.replace(/^`|`$/g, '').replace(/``/g, '`').replace(/\\([_%])/g, '$1');

/**
 * Reads SHOW GRANTS output into { tables: Map(table -> Set of privileges), schema: Set, global: Set } for one database.
 * Grants on other databases are left out; column grants, roles and proxy grants are ignored.
 */
function parseGrants(lines, db) {
  const out = { tables: new Map(), schema: new Set(), global: new Set() };
  for (const line of lines) {
    const m = /^GRANT (.+?) ON (\*\.\*|`(?:[^`]|``)+`\.\*|`(?:[^`]|``)+`\.`(?:[^`]|``)+`) TO .*?( WITH GRANT OPTION)?\s*$/.exec(String(line));
    if (!m) continue;
    const privs = m[1].split(/,\s*/).map((p) => p.trim().toUpperCase()).filter((p) => /^[A-Z ]+$/.test(p));
    if (m[3]) privs.push('GRANT OPTION');
    let into;
    if (m[2] === '*.*') into = out.global;
    else {
      const [, schema, table] = /^(`(?:[^`]|``)+`)\.(\*|`(?:[^`]|``)+`)$/.exec(m[2]);
      if (unquote(schema) !== db) continue;
      if (table === '*') into = out.schema;
      else {
        const name = unquote(table);
        if (!out.tables.has(name)) out.tables.set(name, new Set());
        into = out.tables.get(name);
      }
    }
    for (const p of privs) {
      if (p === 'USAGE') continue;
      if (p === 'ALL PRIVILEGES' && into !== out.global && into !== out.schema) TABLE_ALL.forEach((x) => into.add(x));
      else into.add(p);
    }
  }
  return out;
}

/**
 * What to change, given the database's tables and the login's current grants: the privileges each table is missing,
 * the ones it has beyond what the app needs (UPDATE or DELETE on an audit table, or anything that changes tables or
 * grants), any grant on the whole database (each table has its own), and global privileges to report.
 */
function plan(tables, grants) {
  const grant = []; const revoke = [];
  for (const t of tables) {
    const has = grants.tables.get(t) || new Set();
    const want = APPEND_ONLY.includes(t) ? APPEND : RUNTIME;
    const missing = want.filter((p) => !has.has(p));
    const extra = [...has].filter((p) => !want.includes(p));
    if (missing.length) grant.push({ table: t, privileges: missing });
    if (extra.length) revoke.push({ table: t, privileges: extra });
  }
  return { grant, revoke, schema: [...grants.schema], global: [...grants.global] };
}

/** The statements for a plan, in a safe order: every grant first, then the removals, so no table is ever left without. */
function statements(db, user, p) {
  const on = (t) => `\`${db}\`.\`${String(t).replace(/`/g, '')}\``;
  // GRANT OPTION is taken away in a statement of its own: it does not combine with ALL PRIVILEGES on every server.
  const takeAway = (privileges, target) => [privileges.filter((x) => x !== 'GRANT OPTION'), privileges.filter((x) => x === 'GRANT OPTION')]
    .filter((list) => list.length).map((list) => ({ sql: `REVOKE ${list.join(', ')} ON ${target} FROM ?@'%'`, params: [user] }));
  return [
    ...p.grant.map((g) => ({ sql: `GRANT ${g.privileges.join(', ')} ON ${on(g.table)} TO ?@'%'`, params: [user] })),
    ...p.revoke.flatMap((r) => takeAway(r.privileges, on(r.table))),
    ...takeAway(p.schema, `\`${db}\`.*`),
  ];
}

async function main() {
  const { pool } = require('../src/db');
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const [user, password] = args.filter((a) => a !== '--dry-run');
  try {
    if (!/^[a-z_][a-z0-9_]{2,31}$/.test(user || '') || (password !== undefined && password.length < 24)) {
      throw new Error('Usage: db-runtime-user.js <user> [password of 24+ characters] [--dry-run]');
    }
    const db = String(process.env.DB_NAME).replace(/`/g, '');
    if (password !== undefined && !dry) {
      await pool.query("CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?", [user, password]);
      await pool.query("ALTER USER ?@'%' IDENTIFIED BY ?", [user, password]);
    }
    let lines;
    try {
      lines = (await pool.query("SHOW GRANTS FOR ?@'%'", [user]))[0].map((g) => Object.values(g)[0]);
    } catch (e) {
      if (e.errno !== 1141 || password !== undefined) throw e; // 1141: no such login
      console.log(`No login ${user}; nothing to do.`);
      return;
    }
    const [tables] = await pool.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [db]);
    const p = plan(tables.map((r) => String(r.t)), parseGrants(lines, db));
    for (const s of statements(db, user, p)) {
      console.log(`${dry ? 'Would run' : 'Running'}: ${s.sql.replace('?', `'${user}'`)}`);
      if (!dry) await pool.query(s.sql, s.params);
    }
    if (p.global.length) console.log(`Warning: ${user} also holds ${p.global.join(', ')} on every database. Take that away by hand if it is not needed.`);
    console.log(`${user} may read and change rows in ${tables.length} tables (audit tables: read and add only). ${p.grant.length} tables gained grants, ${p.revoke.length} lost extra ones.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { APPEND_ONLY, parseGrants, plan, statements };
