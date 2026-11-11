'use strict';

// Builds a demo municipality: Riverbend Borough, a made-up small borough (never a real town, its staff or its data).
//   SEED_PASSWORD=<at least 12 characters> node db/demo-municipal.js demo-borough
// It makes the tenant (a municipality, on America/New_York, every municipal app on, free of charge) when it is not there,
// then runs every file in db/demo-municipal/ in name order. Each file exports
//   async function (conn, tenantId, helpers)
// and adds its own app's sample data: 00-base.js (the foundation) adds the logins and staff, the street list, the fleet
// with meters and service plans, and work orders; then 20-assets.js, 30-requests.js, 40-trash.js, 50-notices.js and
// 60-buildings.js each add their app's.
// Safe to run again: every file finds what is there already (by name, title or username) and adds only what is missing.
// Prints the owner's login at the end, like db/seed.js. Every login uses SEED_PASSWORD.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const M = require('../src/lib/modules');
const { todayIn, addDays } = require('../src/lib/util');

const slug = process.argv[2];
const password = process.env.SEED_PASSWORD;
if (!slug || slug.startsWith('--') || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) { console.error('Usage: SEED_PASSWORD=... node db/demo-municipal.js <slug>, for example demo-borough'); process.exit(1); }
if (!password || password.length < 12) { console.error('Set SEED_PASSWORD to at least 12 characters.'); process.exit(1); }

const NAME = 'Riverbend Borough';
const TZ = 'America/New_York';
const DIR = path.join(__dirname, 'demo-municipal');
/** The municipal add-ons, all on for a demo: Water, Sewer, Stormwater, Trash and recycling, Buildings. */
const ADD_ONS = ['water', 'sewer', 'stormwater', 'solidwaste', 'buildings'];

/** The tenant, made when it is not there. A ski area with this address is left alone. */
async function tenantFor(conn) {
  const [[t]] = await conn.query('SELECT id, org_type FROM tenants WHERE slug = ?', [slug]);
  if (t) {
    if (t.org_type !== 'municipality') throw new Error(`${slug} is a ski area, not a municipality. Pick another address.`);
    // A demo borough made before an add-on existed, or with one turned off since, gets every municipal add-on on again.
    for (const k of ADD_ONS) await conn.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [t.id, k]);
    return { id: Number(t.id), made: false };
  }
  const [r] = await conn.query("INSERT INTO tenants (slug, name, timezone, org_type, address, phone, weekly_report) VALUES (?, ?, ?, 'municipality', ?, ?, 0)",
    [slug, NAME, TZ, '100 Main Street, Riverbend, PA 19000', '(555) 010-2400']);
  const id = Number(r.insertId);
  // A demo shows every municipal app: the core and every add-on.
  const on = M.apply({}, Object.fromEntries(ADD_ONS.map((k) => [k, true])), 'municipality');
  for (const k of M.KEYS) await conn.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?)', [id, k, on.includes(k) ? 1 : 0]);
  await conn.query('INSERT IGNORE INTO tenant_billing (tenant_id, comped) VALUES (?, 1)', [id]);
  return { id, made: true };
}

async function main() {
  const conn = await pool.getConnection();
  try {
    const t = await tenantFor(conn);
    const today = todayIn(TZ);
    const hash = await bcrypt.hash(password, 10);
    const helpers = {
      slug, name: NAME, timezone: TZ, today, addDays, passwordHash: hash,
      log: (s) => console.log(`  ${s}`),
      /** A local date and time n days before today at hh:mm, as the app stores times ('YYYY-MM-DD HH:MM:SS'). */
      daysAgo: (n, hh = 9, mm = 0) => `${addDays(today, -n)} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`,
      /** name -> id for a table's rows in this tenant (staff by full name: use helpers.staffIds). */
      ids: async (table, column = 'name') => new Map((await conn.query(`SELECT id, \`${column}\` AS k FROM \`${table}\` WHERE tenant_id = ?`, [t.id]))[0].map((r) => [r.k, Number(r.id)])),
      /** "First Last" -> staff id. */
      staffIds: async () => new Map((await conn.query("SELECT s.id, CONCAT(p.first_name, ' ', p.last_name) AS k FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ?", [t.id]))[0].map((r) => [r.k, Number(r.id)])),
      /** username -> user id. */
      userIds: async () => new Map((await conn.query('SELECT id, username AS k FROM users WHERE tenant_id = ?', [t.id]))[0].map((r) => [r.k, Number(r.id)])),
    };
    console.log(`${t.made ? 'Made' : 'Found'} ${NAME} (${slug}).`);
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
    for (const f of files) {
      console.log(`${f}:`);
      await require(path.join(DIR, f))(conn, t.id, helpers);
    }
    M.invalidate(t.id);
    console.log(`Done. Login: tenant=${slug} username=owner (or email owner@${slug}.test), password from SEED_PASSWORD. Other logins: manager, crew1 to crew4, frontdesk.`);
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('Demo failed:', e.message); process.exit(1); });
