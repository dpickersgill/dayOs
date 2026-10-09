'use strict';

// Creates a demo mountain with realistic starter data so you can click around immediately.
//   SEED_PASSWORD=<at least 10 chars> npm run seed
// Prints the login at the end. Safe to run once per slug; re-running with the same slug fails on purpose.
const bcrypt = require('bcryptjs');
const { pool, tx } = require('../src/db');

const slug = process.env.SEED_SLUG || 'demo-mountain';
const password = process.env.SEED_PASSWORD;
if (!password || password.length < 10) {
  console.error('Set SEED_PASSWORD to at least 10 characters.');
  process.exit(1);
}

async function main() {
  await tx(async (c) => {
    const [t] = await c.query('INSERT INTO tenants (slug, name, timezone) VALUES (?, ?, ?)', [slug, 'Demo Mountain', 'America/New_York']);
    const tid = t.insertId;
    const [p] = await c.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [tid, 'Demo', 'Owner', `owner@${slug}.test`]);
    await c.query('INSERT INTO users (tenant_id, person_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)', [tid, p.insertId, `owner@${slug}.test`, await bcrypt.hash(password, 12), 'owner']);

    const product = async (kind, name, cents, extra = {}) => {
      const [r] = await c.query('INSERT INTO products (tenant_id, kind, name, base_price_cents, valid_days, uses) VALUES (?, ?, ?, ?, ?, ?)', [tid, kind, name, cents, extra.valid_days ?? 1, extra.uses ?? null]);
      return r.insertId;
    };
    const day = await product('day_ticket', 'All-Day Lift Ticket', 6500);
    await product('multi_day', '2-Day Lift Ticket', 11500, { valid_days: 2 });
    await product('season_pass', 'Season Pass', 49900, { valid_days: 200 });
    await product('punch_card', '5-Visit Card', 27500, { valid_days: 120, uses: 5 });
    await product('lesson', 'Beginner Group Lesson', 7500);
    for (const [tier, cents] of [['youth', 4500], ['child', 2500], ['senior', 4500], ['military', 4500]]) {
      await c.query('INSERT INTO price_tiers (tenant_id, product_id, tier, price_cents) VALUES (?, ?, ?, ?)', [tid, day, tier, cents]);
    }

    const cert = {};
    for (const name of ['Lift Operator Training', 'PSIA Level 1', 'Outdoor Emergency Care (OEC)', 'CPR/First Aid']) {
      const [r] = await c.query('INSERT INTO certifications (tenant_id, name) VALUES (?, ?)', [tid, name]);
      cert[name] = r.insertId;
    }
    const position = async (name, department, ratio, certs = []) => {
      const [r] = await c.query('INSERT INTO positions (tenant_id, name, department, visits_per_staff) VALUES (?, ?, ?, ?)', [tid, name, department, ratio]);
      for (const cn of certs) await c.query('INSERT INTO position_certifications (tenant_id, position_id, certification_id) VALUES (?, ?, ?)', [tid, r.insertId, cert[cn]]);
    };
    await position('Lift Operator', 'lifts', 150, ['Lift Operator Training']);
    await position('Rental Technician', 'rentals', 120);
    await position('Ski Instructor', 'ski_school', 40, ['PSIA Level 1']);
    await position('Patroller', 'patrol', 250, ['Outdoor Emergency Care (OEC)', 'CPR/First Aid']);
    await position('Ticket Window', 'guest_services', 300);

    for (const name of ['Main Quad', 'Magic Carpet', 'T-Bar']) await c.query("INSERT INTO lifts (tenant_id, name, status) VALUES (?, ?, 'closed')", [tid, name]);
    for (const [name, diff] of [['Bunny Hill', 'green'], ['Ridge Run', 'blue'], ['The Chute', 'black'], ['Terrain Park', 'park']]) {
      await c.query("INSERT INTO trails (tenant_id, name, difficulty, status) VALUES (?, ?, ?, 'closed')", [tid, name, diff]);
    }
  });
  console.log(`Seeded mountain "${slug}". Login: tenant=${slug} email=owner@${slug}.test (password from SEED_PASSWORD)`);
}

main()
  .catch((e) => { console.error('Seed failed:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
