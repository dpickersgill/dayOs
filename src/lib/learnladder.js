'use strict';
// Learn to ski ladders (feat/school-pay): a first-timer package of 3 or 4 lessons. The school sets the number of
// lessons, the price, the lift ticket and rental it includes, and the season pass offer for graduates.
//   - It is a lesson package (products.kind 'lesson', uses = the lessons), so Sell and the online shop sell it as any
//     package, and the roster spends it one lesson at a time (lesson_credits). learn_ladders holds the rest.
//   - The included lift ticket and rental are named on the roster and at check-in for each ladder lesson. Checking the
//     student in issues them (issueIncluded, 2026.11.13), once per lesson: the ticket for the lesson day and a rental
//     contract to fit, the way a desk sale of a lesson, a ticket and a rental does. They are part of the package price.
//   - A student who has attended every lesson on it graduates: they get a season pass offer (a guest reward, percent
//     off the named pass, valid for pass_days), which Sell and the online shop take like any other reward.
//   - The family's progress card shows "Lesson 2 of 3" and, once they graduate, the offer and its code.
const { rows, one } = require('../db');
const { z, todayIn, addDays } = require('./util');
const { notFound, bad } = require('./errors');
const { audit } = require('./audit');
const rewards = require('./rewards');

const schema = z.object({
  name: z.string().trim().min(3).max(120),
  lessons: z.number().int().min(3).max(4),
  price_cents: z.number().int().min(0).max(1000000),
  valid_days: z.number().int().min(7).max(365).default(120),
  ticket_product_id: z.number().int().positive().nullable().optional(),
  rental_product_id: z.number().int().positive().nullable().optional(),
  pass_product_id: z.number().int().positive().nullable().optional(),
  pass_percent: z.number().int().min(0).max(100).default(0),
  pass_days: z.number().int().min(7).max(365).default(30),
  active: z.boolean().optional(),
});

async function checkProducts(conn, tenantId, b) {
  const want = [['ticket_product_id', ['day_ticket', 'multi_day']], ['rental_product_id', ['rental']], ['pass_product_id', ['season_pass']]];
  for (const [k, kinds] of want) {
    if (!b[k]) continue;
    const p = await one(conn, 'SELECT kind FROM products WHERE tenant_id = ? AND id = ?', [tenantId, b[k]]);
    if (!p || !kinds.includes(p.kind)) throw bad(k === 'pass_product_id' ? 'Pick a season pass for the graduate offer' : k === 'rental_product_id' ? 'Pick a rental package' : 'Pick a lift ticket');
  }
  if (b.pass_percent && !b.pass_product_id) throw bad('Pick the season pass the graduate discount is for');
}

/** Makes the package product and the ladder. Returns the ladder id. */
async function create(conn, req, b) {
  const t = req.auth.tenantId;
  await checkProducts(conn, t, b);
  const [p] = await conn.query("INSERT INTO products (tenant_id, kind, name, base_price_cents, valid_days, uses, active, online) VALUES (?, 'lesson', ?, ?, ?, ?, ?, 0)",
    [t, b.name, b.price_cents, b.valid_days, b.lessons, b.active === false ? 0 : 1]);
  const [r] = await conn.query('INSERT INTO learn_ladders (tenant_id, product_id, ticket_product_id, rental_product_id, pass_product_id, pass_percent, pass_days, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [t, p.insertId, b.ticket_product_id ?? null, b.rental_product_id ?? null, b.pass_product_id ?? null, b.pass_percent, b.pass_days, b.active === false ? 0 : 1]);
  await audit(conn, req, 'create', 'learn_ladders', r.insertId, { ...b, product_id: p.insertId });
  return r.insertId;
}

async function update(conn, req, id, b) {
  const t = req.auth.tenantId;
  const l = await one(conn, 'SELECT * FROM learn_ladders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
  if (!l) throw notFound('Learn to ski ladder');
  const merged = { ...l, ...b };
  await checkProducts(conn, t, merged);
  const prod = {};
  if (b.name !== undefined) prod.name = b.name;
  if (b.price_cents !== undefined) prod.base_price_cents = b.price_cents;
  if (b.lessons !== undefined) prod.uses = b.lessons; // packages already sold keep their number of lessons
  if (b.valid_days !== undefined) prod.valid_days = b.valid_days;
  if (b.active !== undefined) prod.active = b.active ? 1 : 0;
  if (Object.keys(prod).length) await conn.query(`UPDATE products SET ${Object.keys(prod).map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...Object.values(prod), t, l.product_id]);
  const own = ['ticket_product_id', 'rental_product_id', 'pass_product_id', 'pass_percent', 'pass_days'].filter((k) => b[k] !== undefined);
  if (b.active !== undefined) own.push('active');
  if (own.length) await conn.query(`UPDATE learn_ladders SET ${own.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...own.map((k) => (k === 'active' ? (b.active ? 1 : 0) : b[k] ?? null)), t, id]);
  await audit(conn, req, 'update', 'learn_ladders', id, b);
}

const LIST = `SELECT l.*, p.name, p.base_price_cents AS price_cents, p.uses AS lessons, p.valid_days, tk.name AS ticket, rn.name AS rental, ps.name AS pass
  FROM learn_ladders l JOIN products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
  LEFT JOIN products tk ON tk.tenant_id = l.tenant_id AND tk.id = l.ticket_product_id LEFT JOIN products rn ON rn.tenant_id = l.tenant_id AND rn.id = l.rental_product_id
  LEFT JOIN products ps ON ps.tenant_id = l.tenant_id AND ps.id = l.pass_product_id`;
const includesWords = (l) => [l.ticket, l.rental].filter(Boolean).join(' and ');

async function list(db, tenantId) {
  return (await rows(db, `${LIST} WHERE l.tenant_id = ? ORDER BY l.active DESC, p.name`, [tenantId])).map((l) => ({ ...l, active: Boolean(l.active), includes: includesWords(l) || null }));
}

/** The ladder a lesson package credit belongs to, or null (for the roster and check-in). */
async function forCredit(db, tenantId, creditId) {
  if (!creditId) return null;
  return one(db, `${LIST} JOIN lesson_credits c ON c.tenant_id = l.tenant_id AND c.product_id = l.product_id WHERE l.tenant_id = ? AND c.id = ?`, [tenantId, creditId]);
}

/**
 * A student's ladders: lessons attended of the total, the next one booked, and, once every lesson is attended, the
 * graduate's season pass offer (made once, then shown). issue: false only reads.
 */
async function progress(db, tenantId, personId, { issue = true } = {}) {
  let ladders;
  try {
    ladders = await rows(db, `${LIST.replace('SELECT l.*', 'SELECT l.*, c.id AS credit_id, c.total, c.used, c.created_at AS bought_at')}
      JOIN lesson_credits c ON c.tenant_id = l.tenant_id AND c.product_id = l.product_id WHERE l.tenant_id = ? AND c.person_id = ? AND c.status = 'active' ORDER BY c.id DESC LIMIT 5`, [tenantId, personId]);
  } catch (err) { if (err.code === 'ER_NO_SUCH_TABLE') return []; throw err; }
  const out = [];
  for (const l of ladders) {
    const b = await one(db, `SELECT SUM(b.status = 'attended') AS attended, SUM(b.status = 'booked') AS booked, MIN(IF(b.status = 'booked', s.starts_at, NULL)) AS next_at
      FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id WHERE b.tenant_id = ? AND b.credit_id = ? AND s.status <> 'cancelled'`, [tenantId, l.credit_id]);
    const attended = Number(b.attended || 0);
    const graduated = attended >= Number(l.total);
    let offer = null;
    if (graduated && l.pass_percent > 0 && l.pass_product_id) {
      let r = await one(db, 'SELECT * FROM guest_rewards WHERE tenant_id = ? AND person_id = ? AND source_key = ?', [tenantId, personId, `ladder:${l.credit_id}`]);
      if (!r && issue) {
        const today = todayIn((await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
        r = await rewards.issue(db, tenantId, { personId, kind: 'firsttimer', reason: `Learn to ski graduate: ${l.pass_percent}% off ${l.pass}`,
          options: { percent: { percent: l.pass_percent, product_id: l.pass_product_id } }, validFrom: today, validTo: addDays(today, l.pass_days), sourceKey: `ladder:${l.credit_id}` });
      }
      if (r) offer = { code: r.code, percent: l.pass_percent, pass: l.pass, valid_to: String(r.valid_to instanceof Date ? r.valid_to.toISOString() : r.valid_to).slice(0, 10), status: r.status };
    }
    out.push({ ladder_id: l.id, name: l.name, credit_id: l.credit_id, lessons: Number(l.total), attended, booked: Number(b.booked || 0), next_at: b.next_at || null,
      graduated, includes: includesWords(l) || null, offer });
  }
  return out;
}

/**
 * At check-in for a ladder lesson (2026.11.13): issues the lift ticket and opens the rental the ladder includes, the way
 * Sell does for a lesson sold with a ticket and a rental (lib/ticketissue.js; a rental with no gear yet is a contract to
 * fit, lib/rentalfit.js). Once per lesson: the booking keeps the ticket and contract ids, so undoing and redoing the
 * check-in issues nothing more. Each is a no-charge line on the package's own order, labelled as included. Returns
 * { ticket, rental } (null for what the ladder does not include or was already issued), or null for any other lesson.
 */
async function issueIncluded(conn, tenantId, bookingId, { userId = null } = {}) {
  const b = await one(conn, `SELECT b.id, b.person_id, b.credit_id, b.ladder_ticket_id, b.ladder_contract_id, DATE_FORMAT(s.starts_at, '%Y-%m-%d') AS day
    FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id WHERE b.tenant_id = ? AND b.id = ? FOR UPDATE`, [tenantId, bookingId]);
  if (!b || !b.credit_id) return null;
  const l = await forCredit(conn, tenantId, b.credit_id);
  if (!l || (!l.ticket_product_id && !l.rental_product_id)) return null;
  const sale = await one(conn, 'SELECT i.order_id FROM lesson_credits c JOIN order_items i ON i.tenant_id = c.tenant_id AND i.id = c.order_item_id WHERE c.tenant_id = ? AND c.id = ?', [tenantId, b.credit_id]);
  if (!sale) return null; // a package not sold through an order (none today): nothing to hang the lines on
  const line = async (product, kind) => (await conn.query(
    `INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents, list_cents, reward_cents, label)
     VALUES (?, ?, ?, ?, ?, 'adult', 1, 0, ?, 0, 0, 0, 0, ?)`, [tenantId, sale.order_id, product.id, kind, b.person_id, b.day, `Included: ${l.name}`.slice(0, 80)]))[0].insertId;
  const out = { ticket: null, rental: null };
  if (l.ticket_product_id && !b.ladder_ticket_id) {
    const product = await one(conn, 'SELECT id, name, valid_days, uses FROM products WHERE tenant_id = ? AND id = ?', [tenantId, l.ticket_product_id]);
    if (product) {
      const t = await require('./ticketissue').issueTicket(conn, tenantId, { orderItemId: await line(product, 'ticket'), personId: b.person_id, product, validOn: b.day });
      await conn.query('UPDATE lesson_bookings SET ladder_ticket_id = ? WHERE tenant_id = ? AND id = ?', [t.id, tenantId, b.id]);
      out.ticket = { id: t.id, code: t.code, product: product.name, valid_from: t.valid_from, valid_to: t.valid_to };
    }
  }
  if (l.rental_product_id && !b.ladder_contract_id) {
    const product = await one(conn, 'SELECT id, name, valid_days, rental_kind FROM products WHERE tenant_id = ? AND id = ?', [tenantId, l.rental_product_id]);
    if (product) {
      const itemId = await line(product, 'rental');
      const c = await require('./rentalfit').createToFit(conn, tenantId, { personId: b.person_id, orderId: sale.order_id, orderItemId: itemId, validOn: b.day, product, notes: `Included in ${l.name}`.slice(0, 300) });
      await conn.query('UPDATE order_items SET contract_id = ? WHERE tenant_id = ? AND id = ?', [c.id, tenantId, itemId]);
      await conn.query('UPDATE lesson_bookings SET ladder_contract_id = ? WHERE tenant_id = ? AND id = ?', [c.id, tenantId, b.id]);
      out.rental = { contract_id: c.id, product: product.name, status: 'to_fit', due_at: c.due_at };
    }
  }
  if (out.ticket || out.rental) {
    await audit(conn, { auth: { tenantId, userId }, ip: null }, 'ladder_issue', 'lesson_bookings', b.id, { ticket_id: out.ticket && out.ticket.id, contract_id: out.rental && out.rental.contract_id, ladder: l.id });
  }
  return out;
}

module.exports = { schema, create, update, list, forCredit, progress, includesWords, issueIncluded };
