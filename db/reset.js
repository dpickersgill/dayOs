'use strict';

// Wipes one mountain's records and keeps its owner login(s) and the mountain itself.
//   node db/reset.js <slug>          shows what would be deleted (changes nothing)
//   node db/reset.js <slug> --yes    deletes it
// Kept: the tenants row (name, address, timezone, receipt text, waiver text and other mountain settings),
// every user with role "owner" (password and two-step settings), and the person record behind each owner.
// Everything else for this mountain is deleted: staff, other users, customers, tickets, orders, lessons,
// patrol cases, kiosk tablets/PINs/photos, products, prices, tax rates, audit log and so on.
// Other mountains are never touched. There is no undo.
const { pool } = require('../src/db');

async function main() {
  const slug = process.argv[2];
  const go = process.argv.includes('--yes');
  if (!slug || slug.startsWith('--')) throw new Error('Usage: node db/reset.js <mountain-slug> [--yes]');
  const [[t]] = await pool.query('SELECT id, slug, name FROM tenants WHERE slug = ?', [slug]);
  if (!t) throw new Error(`No mountain with the slug "${slug}"`);
  const [owners] = await pool.query("SELECT id, email, person_id FROM users WHERE tenant_id = ? AND role = 'owner' AND active = 1", [t.id]);
  if (!owners.length) throw new Error('This mountain has no active owner login. Refusing to continue, you would be locked out.');

  const [tables] = await pool.query(
    `SELECT t.table_name AS name FROM information_schema.tables t
      WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'
        AND EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name AND c.column_name = 'tenant_id')
        AND t.table_name NOT IN ('tenants', 'users') ORDER BY t.table_name`);
  const keepPeople = owners.map((o) => o.person_id).filter(Boolean);

  const conn = await pool.getConnection();
  const report = [];
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    await conn.beginTransaction();
    for (const { name } of tables) {
      let where = 'tenant_id = ?'; const params = [t.id];
      if (name === 'people' && keepPeople.length) { where += ' AND id NOT IN (?)'; params.push(keepPeople); }
      const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\` WHERE ${where}`, params);
      if (c.n) report.push([name, Number(c.n)]);
      if (go && c.n) await conn.query(`DELETE FROM \`${name}\` WHERE ${where}`, params);
    }
    const [[u]] = await conn.query("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role <> 'owner'", [t.id]);
    if (u.n) report.push(['users (not owners)', Number(u.n)]);
    if (go) {
      await conn.query("DELETE FROM users WHERE tenant_id = ? AND role <> 'owner'", [t.id]);
      await conn.query("UPDATE users SET staff_id = NULL WHERE tenant_id = ? AND role = 'owner'", [t.id]);
      await conn.commit();
    } else {
      await conn.rollback();
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* nothing open */ }
    throw err;
  } finally {
    conn.release();
  }

  console.log(`${go ? 'Deleted' : 'Would delete'} for ${t.name} (${t.slug}):`);
  for (const [name, n] of report) console.log(`  ${name}: ${n}`);
  if (!report.length) console.log('  nothing, the mountain is already empty');
  console.log(`Kept: the mountain itself and ${owners.length} owner login(s): ${owners.map((o) => o.email).join(', ')}`);
  if (!go) console.log('\nNothing was changed. Run again with --yes to delete.');
}

main().then(() => pool.end()).catch((err) => { console.error(`Reset stopped: ${err.message}`); pool.end().then(() => process.exit(1)); });
