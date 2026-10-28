'use strict';

// The live app's database login (scripts/db-runtime-user.js): promote.sh refreshes its grants after every migration while
// the live app is serving, so the refresh only adds what is missing and takes away only what is wrong, never everything.
// The audit tables are read and add only. (The test database runs without grant tables, so this checks the plan the
// script makes, built from this database's real tables.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseGrants, plan, statements, APPEND_ONLY } = require('../scripts/db-runtime-user');
const { pool } = require('../src/db');

const DB = String(process.env.DB_NAME);
const USER = 'summitops_app';
let tables;
const usage = [`GRANT USAGE ON *.* TO \`${USER}\`@\`%\` IDENTIFIED BY PASSWORD '*ABC'`];
/** What SHOW GRANTS would list after the statements ran, starting from these lines. */
function after(lines, stmts) {
  const g = parseGrants(lines, DB);
  for (const s of stmts) {
    const m = /^(GRANT|REVOKE) (.+) ON `[^`]+`\.(`([^`]+)`|\*) (TO|FROM)/.exec(s.sql);
    const set = m[4] ? (g.tables.get(m[4]) || g.tables.set(m[4], new Set()).get(m[4])) : g.schema;
    for (const p of m[2].split(', ')) { if (m[1] === 'GRANT') set.add(p); else set.delete(p); }
  }
  const out = [...usage];
  for (const [t, set] of g.tables) if (set.size) out.push(`GRANT ${[...set].filter((p) => p !== 'GRANT OPTION').join(', ')} ON \`${DB}\`.\`${t}\` TO \`${USER}\`@\`%\`${set.has('GRANT OPTION') ? ' WITH GRANT OPTION' : ''}`);
  if (g.schema.size) out.push(`GRANT ${[...g.schema].join(', ')} ON \`${DB}\`.* TO \`${USER}\`@\`%\``);
  return out.filter((l) => !/^GRANT\s+ON/.test(l));
}

test.before(async () => {
  const [r] = await pool.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [DB]);
  tables = r.map((x) => String(x.t));
  assert.ok(tables.length > 200 && APPEND_ONLY.every((t) => tables.includes(t)));
});
test.after(() => pool.end());

test('a new login gets each table it needs, the audit tables read and add only, and nothing is taken away', () => {
  const stmts = statements(DB, USER, plan(tables, parseGrants(usage, DB)));
  assert.equal(stmts.length, tables.length);
  assert.ok(stmts.every((s) => s.sql.startsWith('GRANT ')), 'only grants');
  assert.equal(stmts.find((s) => s.sql.includes('`audit_log`')).sql, `GRANT SELECT, INSERT ON \`${DB}\`.\`audit_log\` TO ?@'%'`);
  assert.equal(stmts.find((s) => s.sql.includes('`platform_audit`')).sql, `GRANT SELECT, INSERT ON \`${DB}\`.\`platform_audit\` TO ?@'%'`);
  assert.equal(stmts.find((s) => s.sql.includes('`orders`')).sql, `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB}\`.\`orders\` TO ?@'%'`);
  // Run again: nothing to do.
  assert.deepEqual(statements(DB, USER, plan(tables, parseGrants(after(usage, stmts), DB))), []);
});

test('after a migration only the new table is granted; the login the old script made loses DELETE on the audit tables only', () => {
  const old = [...usage, ...tables.map((t) => `GRANT ${APPEND_ONLY.includes(t) ? 'SELECT, INSERT, DELETE' : 'SELECT, INSERT, UPDATE, DELETE'} ON \`${DB}\`.\`${t}\` TO \`${USER}\`@\`%\``)];
  const stmts = statements(DB, USER, plan([...tables, 'brand_new_table'], parseGrants(old, DB)));
  assert.deepEqual(stmts.map((s) => s.sql), [
    `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB}\`.\`brand_new_table\` TO ?@'%'`,
    ...APPEND_ONLY.filter((t) => tables.includes(t)).sort((a, b) => tables.indexOf(a) - tables.indexOf(b)).map((t) => `REVOKE DELETE ON \`${DB}\`.\`${t}\` FROM ?@'%'`),
  ]);
});

test('only wrong privileges are taken away, after every grant, and never all of them at once', () => {
  const lines = [...usage,
    `GRANT ALL PRIVILEGES ON \`${DB}\`.\`users\` TO \`${USER}\`@\`%\` WITH GRANT OPTION`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB}\`.\`audit_log\` TO \`${USER}\`@\`%\``,
    `GRANT SELECT, UPDATE ON \`${DB}\`.* TO \`${USER}\`@\`%\``,
    `GRANT SELECT ON \`some_other_db\`.\`t\` TO \`${USER}\`@\`%\``];
  const p = plan(tables, parseGrants(lines, DB));
  const sql = statements(DB, USER, p).map((s) => s.sql);
  const firstRevoke = sql.findIndex((s) => s.startsWith('REVOKE'));
  assert.ok(sql.slice(0, firstRevoke).every((s) => s.startsWith('GRANT')) && sql.slice(firstRevoke).every((s) => s.startsWith('REVOKE')), 'every grant runs before any removal');
  assert.ok(!sql.some((s) => /REVOKE ALL|ON \*\.\*|some_other_db/.test(s)), 'never everything, never another database');
  assert.ok(sql.includes(`REVOKE UPDATE, DELETE ON \`${DB}\`.\`audit_log\` FROM ?@'%'`));
  assert.ok(sql.includes(`REVOKE CREATE, DROP, REFERENCES, INDEX, ALTER, CREATE VIEW, SHOW VIEW, TRIGGER ON \`${DB}\`.\`users\` FROM ?@'%'`));
  assert.ok(sql.includes(`REVOKE GRANT OPTION ON \`${DB}\`.\`users\` FROM ?@'%'`));
  assert.equal(sql.at(-1), `REVOKE SELECT, UPDATE ON \`${DB}\`.* FROM ?@'%'`, 'a grant on the whole database goes last, once each table has its own');
  assert.ok(!sql.some((s) => s.includes('`users`') && s.startsWith('GRANT')), 'users already had what the app needs');
  assert.deepEqual(statements(DB, USER, plan(tables, parseGrants(after(lines, statements(DB, USER, p)), DB))), [], 'run again: nothing to do');
});

test('the scripts never strip the login, and the app never edits or removes audit rows', () => {
  const root = path.join(__dirname, '..');
  const script = fs.readFileSync(path.join(root, 'scripts/db-runtime-user.js'), 'utf8');
  assert.ok(!/REVOKE ALL PRIVILEGES, GRANT OPTION FROM/.test(script));
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.js') && /(UPDATE|DELETE FROM|TRUNCATE(?: TABLE)?|REPLACE INTO)\s+`?(audit_log|platform_audit)\b/i.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
    }
  };
  walk(path.join(root, 'src'));
  assert.deepEqual(offenders, [], 'audit rows are read and added only');
  const sandbox = fs.readFileSync(path.join(root, 'src/lib/sandbox.js'), 'utf8');
  assert.match(sandbox, /NOT IN \('tenants', 'sandbox_signups', 'audit_log', 'platform_audit'\)/, 'removing a mountain leaves its audit trail');
});
