'use strict';

// One basket for everything the mountain sells: tickets, lessons, rentals, program places and gift cards.
// The counter builds the basket first and adds the customer's details at the end, then pays.
//   GET  /checkout/menu    what can be sold today (with spots left and stock)
//   POST /checkout/quote   prices a basket and checks it can be sold, without selling it
//   POST /checkout         sells it: one order, one payment (or a split), every booking made in one transaction
//   GET  /gift-cards/:code balance check, and POST /gift-cards/:code/void for a manager
// Prices always come from the server. Nothing is saved unless the whole basket can be sold.
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, dateTimeStr, tierEnum, validate, newCode, addDays, todayIn, seasonFor, normDateTime } = require('../lib/util');
const { unitPrice, applyPromo } = require('../lib/pricing');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { personFields, resolvePerson, ensureRequired } = require('../lib/customers');
const { loadRules, applyTax, split } = require('../lib/tax');
const { addLink, isMinor } = require('../lib/family');
const R = require('../lib/rentals');

const checkout = express.Router();
const giftCards = express.Router();
const sellers = ['counter', 'manager'];

const TICKET_KINDS = ['day_ticket', 'multi_day', 'season_pass', 'punch_card', 'voucher'];
const GIFT_MIN = 500; // $5.00
const GIFT_MAX = 100000; // $1,000.00
const { money } = require('../lib/format');
const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------- request shapes
const detailsSchema = z.object({ ...personFields, first_name: personFields.first_name.optional(), last_name: personFields.last_name.optional() });
// Someone already on file (person_id) or new details to save. sign_waiver records this season's waiver at the counter.
// guardian: for someone under 18, the key of the adult ("customer" or another participant) who is their parent or guardian and signs for them.
const personSpec = z.object({ person_id: z.number().int().positive().optional(), details: detailsSchema.optional(), sign_waiver: z.boolean().optional(), guardian: z.string().min(1).max(20).optional() });
const who = z.string().min(1).max(20).optional(); // key into `participants`; blank means the customer

const lineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ticket'), product_id: z.number().int().positive(), tier: tierEnum.default('adult'), quantity: z.number().int().min(1).max(200).default(1), valid_on: dateStr.optional(), holders: z.array(z.string().min(1).max(20)).max(200).optional() }),
  z.object({ type: z.literal('lesson_package'), product_id: z.number().int().positive(), tier: tierEnum.default('adult'), participant: who }),
  z.object({ type: z.literal('lesson'), session_id: z.number().int().positive(), tier: tierEnum.default('adult'), participant: who }),
  z.object({
    type: z.literal('rental'), product_id: z.number().int().positive(), tier: tierEnum.default('adult'), valid_on: dateStr.optional(), due_at: dateTimeStr.optional(), participant: who,
    items: z.array(R.gearLine).max(60).optional(),
  }),
  z.object({ type: z.literal('program'), program_id: z.number().int().positive(), participant: who }),
  z.object({ type: z.literal('gift_card'), amount_cents: z.number().int().min(GIFT_MIN).max(GIFT_MAX), recipient_name: z.string().max(150).optional(), message: z.string().max(300).optional() }),
]);

const COMP_REASONS = ['staff', 'patrol', 'promotion', 'sponsor', 'management_guest', 'service_recovery', 'other'];
const paymentSchema = z.object({
  tender: z.enum(['cash', 'card', 'gift_card', 'other', 'comp']),
  comp_reason: z.enum(COMP_REASONS).optional(), // a comp (free of charge) always says why
  card_brand: z.enum(['visa', 'mastercard', 'amex', 'discover', 'other']).optional(),
  card_last4: z.string().regex(/^\d{4}$/, 'The last 4 digits of the card').optional(),
  auth_code: z.string().max(30).optional(),
  processor: z.string().max(30).optional(),
  amount_cents: z.number().int().min(1).max(10_000_000),
  tendered_cents: z.number().int().min(1).max(10_000_000).optional(), // cash handed over, when it is more than the amount (change is due)
  reference: z.string().max(100).optional(),
  code: z.string().max(40).optional(), // gift card code
});

const quoteSchema = z.object({ date: dateStr.optional(), promo_code: z.string().max(40).optional(), lines: z.array(lineSchema).min(1).max(50) });
const checkoutSchema = z.object({
  channel: z.enum(['window', 'online', 'phone', 'group']).default('window'),
  customer: personSpec.optional(),
  participants: z.record(z.string().min(1).max(20), personSpec).optional(),
  promo_code: z.string().max(40).optional(),
  lines: z.array(lineSchema).min(1).max(50),
  payments: z.array(paymentSchema).max(6).default([]),
  // Quick sale: day tickets, multi-day tickets, punch cards and vouchers only, with no customer record (a mountain can
  // switch this off in Account to require a name on every sale).
  quick: z.boolean().optional(),
});
const QUICK_KINDS = ['day_ticket', 'multi_day', 'punch_card', 'voucher'];

// ---------------------------------------------------------------- pricing and availability
async function spotsLeft(conn, tenantId, sessionId, capacity) {
  const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, sessionId]);
  return Math.max(capacity - n, 0);
}

/**
 * Prices every line from the catalog and checks it can be sold. Returns one entry per line:
 * { i, line, type, name, detail, quantity, unit, cents, ... } plus whatever the booking step needs later.
 */
async function priceLines(conn, tenantId, lines, today) {
  const out = [];
  for (const [i, ln] of lines.entries()) {
    if (ln.type === 'ticket') {
      const validOn = ln.valid_on || today;
      if (validOn < today) throw bad('Tickets cannot be sold for a past date');
      const { product, cents } = await unitPrice(conn, tenantId, ln.product_id, ln.tier, validOn);
      if (!TICKET_KINDS.includes(product.kind)) throw bad(`${product.name} is a ${product.kind} product and cannot be sold as a ticket`);
      out.push({ i, line: ln, type: 'ticket', name: product.name, detail: `${ln.tier}, ${validOn}`, quantity: ln.quantity, unit: cents, product, validOn });
    } else if (ln.type === 'lesson') {
      const session = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, ln.session_id]);
      if (!session) throw notFound('Lesson session');
      if (session.status !== 'scheduled') throw conflict(`That lesson is ${session.status}`);
      const day = session.starts_at.slice(0, 10);
      if (day < today) throw conflict('That lesson date has passed');
      const { product, cents } = await unitPrice(conn, tenantId, session.product_id, ln.tier, day);
      // Spots held for an online request (unpaid) count as open here: the student paying for one takes it over. The exact check happens when booking.
      const held = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status = 'booked' AND unpaid = 1", [tenantId, session.id]);
      if ((await spotsLeft(conn, tenantId, session.id, session.capacity)) + Number(held.n) < 1) throw conflict(`${product.name} on ${day} is full`);
      out.push({ i, line: ln, type: 'lesson', name: product.name, detail: `${session.starts_at.slice(0, 16).replace('T', ' ')}, ${session.discipline}`, quantity: 1, unit: cents, product, session, day });
    } else if (ln.type === 'lesson_package') {
      const { product, cents } = await unitPrice(conn, tenantId, ln.product_id, ln.tier, today);
      if (product.kind !== 'lesson' || !(product.uses > 1)) throw bad(`${product.name} is not a lesson package`);
      out.push({ i, line: ln, type: 'lesson', pkg: true, name: product.name, detail: `${product.uses} lessons${product.valid_days > 1 ? `, valid ${product.valid_days} days` : ''}`, quantity: 1, unit: cents, product });
    } else if (ln.type === 'rental') {
      const validOn = ln.valid_on || today;
      if (validOn < today) throw bad('Rentals cannot be sold for a past date');
      const { product, cents } = await unitPrice(conn, tenantId, ln.product_id, ln.tier, validOn);
      if (product.kind !== 'rental') throw bad(`${product.name} is not a rental package`);
      out.push({ i, line: ln, type: 'rental', name: product.name, detail: `${ln.tier}, ${validOn}${product.valid_days > 1 ? ` for ${product.valid_days} days` : ''}`, quantity: 1, unit: cents, product, validOn });
    } else if (ln.type === 'program') {
      const program = await one(conn, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ?', [tenantId, ln.program_id]);
      if (!program) throw notFound('Program');
      if (program.ends_on && program.ends_on < today) throw conflict(`${program.name} has ended`);
      if (program.capacity !== null) {
        const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND status = 'enrolled'", [tenantId, program.id]);
        if (n >= program.capacity) throw conflict(`${program.name} is full. Use the Programs screen to add them to the waitlist.`);
      }
      out.push({ i, line: ln, type: 'program', name: program.name, detail: program.season, quantity: 1, unit: program.price_cents, program });
    } else {
      out.push({ i, line: ln, type: 'gift_card', name: 'Gift card', detail: ln.recipient_name ? `for ${ln.recipient_name}` : '', quantity: 1, unit: ln.amount_cents });
    }
  }
  return out;
}

async function totals(conn, tenantId, priced, promoCode, today, lock) {
  let subtotal = 0;
  let promoEligible = 0; // gift cards are not discounted
  for (const p of priced) {
    p.cents = p.unit * p.quantity;
    subtotal += p.cents;
    if (p.type !== 'gift_card') promoEligible += p.cents;
  }
  let discount = 0;
  let promo = null;
  if (promoCode) {
    promo = promoCode.toUpperCase();
    const applied = await applyPromo(conn, tenantId, promo, promoEligible, today, { lock });
    discount = applied.discountCents;
    if (lock) await conn.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE tenant_id = ? AND id = ?', [tenantId, applied.promo.id]);
  }
  const { tax, taxes } = applyTax(priced, discount, await loadRules(conn, tenantId));
  const giftCents = subtotal - promoEligible;
  return { subtotal, discount, tax, taxes, total: subtotal - discount + tax, giftCents, promo };
}

const describe = (p) => ({ index: p.i, type: p.type, name: p.name, detail: p.detail, quantity: p.quantity, unit_price_cents: p.unit, line_cents: p.cents, discount_cents: p.discount || 0, tax_cents: p.tax || 0 });

// ---------------------------------------------------------------- menu
checkout.get('/menu', requireRole(...sellers), async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone, comp_counter_limit_cents, waiver_text, quick_sale FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const [products, tiers, sessions, programs, stock] = await Promise.all([
    // Best sellers of the last 30 days first, so the busiest tiles sit where the cashier's hand already is.
    rows(pool, `SELECT p.id, p.kind, p.name, p.base_price_cents, p.valid_days, p.uses,
                  (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id AND i.order_id IN
                    (SELECT o.id FROM orders o WHERE o.tenant_id = p.tenant_id AND o.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY))) AS sold
                FROM products p WHERE p.tenant_id = ? AND p.active = 1 ORDER BY sold DESC, p.name`, [tenantId]),
    rows(pool, 'SELECT product_id, tier, price_cents FROM price_tiers WHERE tenant_id = ?', [tenantId]),
    rows(pool, `SELECT s.id, s.product_id, pr.name, pr.base_price_cents, s.discipline, s.ability_level, s.format, s.age_group, s.meeting_place, s.starts_at, s.ends_at, s.capacity,
                  (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
                FROM lesson_sessions s JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
                WHERE s.tenant_id = ? AND s.status = 'scheduled' AND DATE(s.starts_at) BETWEEN ? AND ? ORDER BY s.starts_at LIMIT 200`, [tenantId, today, addDays(today, 14)]),
    rows(pool, `SELECT p.id, p.name, p.kind, p.season, p.capacity, p.price_cents, p.starts_on, p.ends_on,
                  (SELECT COUNT(*) FROM program_enrollments e WHERE e.tenant_id = p.tenant_id AND e.program_id = p.id AND e.status = 'enrolled') AS enrolled
                FROM programs p WHERE p.tenant_id = ? AND (p.ends_on IS NULL OR p.ends_on >= ?) ORDER BY p.name`, [tenantId, today]),
    rows(pool, "SELECT category, COUNT(*) AS available FROM rental_items WHERE tenant_id = ? AND status = 'available' GROUP BY category", [tenantId]),
  ]);
  const withTiers = (p) => ({ ...p, tiers: Object.fromEntries(tiers.filter((t) => t.product_id === p.id).map((t) => [t.tier, t.price_cents])) });
  res.json({
    today,
    tickets: products.filter((p) => TICKET_KINDS.includes(p.kind) && p.kind !== 'voucher').map(withTiers),
    rentals: products.filter((p) => p.kind === 'rental').map(withTiers),
    packages: products.filter((p) => p.kind === 'lesson' && p.uses > 1).map(withTiers),
    lessons: sessions.map((s) => ({ ...s, spots_left: Math.max(s.capacity - Number(s.booked), 0) })),
    programs: programs.map((p) => ({ ...p, spots_left: p.capacity === null ? null : Math.max(p.capacity - Number(p.enrolled), 0) })),
    stock: Object.fromEntries(stock.map((s) => [s.category, Number(s.available)])),
    gift_card: { min_cents: GIFT_MIN, max_cents: GIFT_MAX },
    waiver_text: tenant.waiver_text || null,
    quick_sale: { allowed: Boolean(tenant.quick_sale), kinds: QUICK_KINDS },
    tax_rules: await rows(pool, 'SELECT name, applies_to, rate_bps FROM tax_rules WHERE tenant_id = ? AND active = 1 ORDER BY id', [tenantId]),
    comp: { reasons: COMP_REASONS, counter_limit_cents: tenant.comp_counter_limit_cents, can_comp: ['owner', 'manager'].includes(req.auth.role) || tenant.comp_counter_limit_cents > 0 },
  });
});

// ---------------------------------------------------------------- quote
checkout.post('/quote', requireRole(...sellers), validate(quoteSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const priced = await priceLines(pool, tenantId, req.body.lines, today);
  const t = await totals(pool, tenantId, priced, req.body.promo_code, today, false);
  res.json({ lines: priced.map(describe), subtotal_cents: t.subtotal, discount_cents: t.discount, tax_cents: t.tax, taxes: t.taxes, total_cents: t.total, gift_card_cents: t.giftCents });
});

// ---------------------------------------------------------------- checkout
checkout.post('/', requireRole(...sellers), validate(checkoutSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const body = req.body;

  const result = await tx(async (conn) => {
    const tenant = await one(conn, 'SELECT timezone, comp_counter_limit_cents, waiver_text, quick_sale FROM tenants WHERE id = ?', [tenantId]);
    const today = todayIn(tenant.timezone);
    const lines = body.lines;

    // ---- price first, so a bad line or a wrong payment fails before anything is saved
    const priced = await priceLines(conn, tenantId, lines, today);
    const t = await totals(conn, tenantId, priced, body.promo_code, today, true);
    const paySum = body.payments.reduce((n, p) => n + p.amount_cents, 0);
    if (t.total === 0 && body.payments.length) throw bad('Nothing is due on this basket, so no payment should be recorded');
    if (t.total > 0 && !body.payments.length) throw bad('Record how it was paid');
    if (paySum !== t.total) throw bad(`Payments add up to ${money(paySum)} but the basket is ${money(t.total)}`);
    for (const p of body.payments) {
      if (p.tender === 'cash' && p.tendered_cents !== undefined && p.tendered_cents < p.amount_cents) throw bad('The cash handed over is less than the amount paid in cash');
      if (p.tender === 'gift_card' && !cleanCode(p.code)) throw bad('Enter the gift card code');
      if (p.tender === 'comp' && !p.comp_reason) throw bad('Say why this is free of charge (comp reason)');
    }
    const giftPaid = body.payments.filter((p) => p.tender === 'gift_card').reduce((n, p) => n + p.amount_cents, 0);
    const compPaid = body.payments.filter((p) => p.tender === 'comp').reduce((n, p) => n + p.amount_cents, 0);
    if (giftPaid + compPaid > t.total - t.giftCents) throw bad('A gift card or a comp cannot be used to buy a gift card');
    // Free of charge: managers always; counter staff only up to the limit the manager has set (default none).
    if (compPaid && !['owner', 'manager'].includes(req.auth.role) && compPaid > tenant.comp_counter_limit_cents) throw forbidden(compPaid && tenant.comp_counter_limit_cents ? `Counter staff can comp up to ${money(tenant.comp_counter_limit_cents)}. Ask a manager.` : 'Only a manager can give things away free of charge');

    // ---- quick sale: tickets only, nobody named, nothing saved about the guest
    if (body.quick) {
      if (!tenant.quick_sale) throw bad('Quick sale is switched off for this mountain: add the customer\'s details');
      if (body.participants && Object.keys(body.participants).length) throw bad('A quick sale has no named guests');
      for (const p of priced) {
        if (p.type !== 'ticket' || !QUICK_KINDS.includes(p.product.kind)) throw bad(`${p.product ? p.product.name : 'That item'} needs the guest's details. Use the full checkout.`);
        if ((p.line.holders || []).some((x) => x !== 'customer')) throw bad('A quick sale has no named guests');
      }
    }

    // ---- every item sold is for a named person. The customer pays and is the default for everything; a ticket
    // holder, lesson student, renter or program participant can be someone else (a key into `participants`).
    // Everyone is held to the same rule: name, date of birth and sex; adults also a phone or an email; under 18s no phone or email.
    const cust = body.quick ? null : body.customer;
    if (!body.quick && (!cust || !(cust.person_id || cust.details))) throw bad("Add the customer's details: every item sold needs a name");
    const sale = { today };
    const holdersOf = (l) => {
      const h = l.holders || [];
      if (h.length && h.length !== l.quantity) throw bad(`Name who each of the ${l.quantity} ${l.type === 'ticket' ? 'tickets' : 'items'} is for`);
      return Array.from({ length: l.quantity }, (_, n) => h[n] || 'customer');
    };
    const keyOf = (l) => l.participant || 'customer';
    const usedBy = new Map(); // person key -> Set of line types
    const use = (key, type) => { if (!usedBy.has(key)) usedBy.set(key, new Set()); usedBy.get(key).add(type); };
    use('customer', 'buyer');
    for (const l of lines) {
      if (l.type === 'ticket') for (const k of holdersOf(l)) use(k, 'ticket');
      else if (l.type !== 'gift_card') use(keyOf(l), l.type);
    }
    const isLesson = (types) => types.has('lesson') || types.has('lesson_package');
    const scopeFor = (types) => (isLesson(types) ? 'lesson' : types.has('ticket') || types.has('buyer') ? 'ticket' : 'none');
    const resolve = async (key, spec) => {
      const types = usedBy.get(key);
      const r = await resolvePerson(conn, tenantId, { personId: spec.person_id, details: spec.details, scope: scopeFor(types), source: body.channel, sale });
      if (r.notFound) throw notFound('Person');
      if (isLesson(types) && types.has('ticket')) await ensureRequired(conn, tenantId, r.person, 'ticket', sale);
      return r;
    };
    const buyer = body.quick ? { id: null, person: null, created: false, matched: false } : await resolve('customer', cust);
    const people = new Map([['customer', buyer.id]]);
    const names = new Map(buyer.id ? [[buyer.id, `${buyer.person.first_name} ${buyer.person.last_name}`]] : []);
    const waiverFor = new Map([['customer', Boolean(cust && cust.sign_waiver)]]);
    for (const key of usedBy.keys()) {
      if (key === 'customer') continue;
      const spec = body.participants && body.participants[key];
      if (!spec || (!spec.person_id && !spec.details)) throw bad(`Choose or enter who "${key}" is for`);
      const r = await resolve(key, spec);
      people.set(key, r.id);
      names.set(r.id, `${r.person.first_name} ${r.person.last_name}`);
      waiverFor.set(key, Boolean(spec.sign_waiver));
    }
    const personOf = (ln) => people.get(ln.participant || 'customer');

    // ---- under 18s need a parent or guardian (18 or over). They sign the waiver for the minor and are linked on file.
    const personRows = new Map();
    for (const id of new Set(people.values())) if (id) personRows.set(id, await one(conn, 'SELECT id, first_name, last_name, date_of_birth, (photo IS NOT NULL) AS has_photo FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id]));
    const guardianOf = new Map(); // key -> guardian person id
    for (const [key, id] of people) {
      const me = personRows.get(id);
      if (!me || !isMinor(me.date_of_birth, today)) continue;
      const spec = key === 'customer' ? cust : body.participants[key];
      let gid = null;
      if (spec.guardian) {
        if (!people.has(spec.guardian)) throw bad(`Choose or enter who "${spec.guardian}" is: they are named as guardian of ${me.first_name}`);
        gid = people.get(spec.guardian);
      } else if (key !== 'customer' && !isMinor(personRows.get(buyer.id).date_of_birth, today)) gid = buyer.id;
      else {
        const link = await one(conn, "SELECT l.adult_id FROM person_links l JOIN people a ON a.tenant_id = l.tenant_id AND a.id = l.adult_id WHERE l.tenant_id = ? AND l.member_id = ? AND l.relation = 'guardian' ORDER BY l.created_at LIMIT 1", [tenantId, id]);
        if (link) gid = link.adult_id;
      }
      if (!gid) throw bad(`${me.first_name} ${me.last_name} is under 18: name a parent or guardian (18 or over) who is signing for them`);
      if (gid === id) throw bad(`${me.first_name} cannot be their own guardian`);
      if (!personRows.has(gid)) personRows.set(gid, await one(conn, 'SELECT id, first_name, last_name, date_of_birth, (photo IS NOT NULL) AS has_photo FROM people WHERE tenant_id = ? AND id = ?', [tenantId, gid]));
      const g = personRows.get(gid);
      if (isMinor(g.date_of_birth, today)) throw bad(`${g.first_name} ${g.last_name} is under 18 and cannot be a guardian`);
      guardianOf.set(key, g);
      await addLink(conn, tenantId, gid, id, 'guardian');
    }

    // ---- a season pass carries the holder's photo (the gate shows it next to the name)
    for (const l of lines) {
      if (l.type !== 'ticket') continue;
      const pr = priced.find((x) => x.line === l);
      if (!pr || pr.product.kind !== 'season_pass') continue;
      for (const key of holdersOf(l)) {
        const me = personRows.get(people.get(key));
        if (!me.has_photo) throw bad(`${me.first_name} ${me.last_name} needs a photo for a season pass`);
      }
    }

    const ensureWaiver = async (key, personId, season, label) => {
      if (await one(conn, 'SELECT id FROM waivers WHERE tenant_id = ? AND person_id = ? AND season = ? LIMIT 1', [tenantId, personId, season])) return;
      const g = guardianOf.get(key);
      if (!waiverFor.get(key)) throw conflict(g ? `${label} is under 18: their guardian must sign the waiver for the ${season} season` : `${label} needs a signed waiver for the ${season} season`, { person_id: personId });
      const me = personRows.get(personId);
      const signer = g || me;
      const sha = tenant.waiver_text ? crypto.createHash('sha256').update(tenant.waiver_text).digest('hex') : null;
      const [w] = await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_person_id, signed_by_name, signer_relation, text_sha) VALUES (?, ?, ?, 'general', ?, ?, ?, ?)",
        [tenantId, personId, season, signer.id, `${signer.first_name} ${signer.last_name}`, g ? 'guardian' : 'self', sha]);
      await audit(conn, req, 'sign_waiver', 'waivers', w.insertId, { person_id: personId, season, signed_by: signer.id });
    };

    // ---- the order
    const firstRef = body.payments.find((p) => p.reference);
    const [o] = await conn.query(
      `INSERT INTO orders (tenant_id, person_id, user_id, status, promo_code, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, buyer.id, req.auth.userId, t.promo, t.subtotal, t.discount, t.tax, t.total, body.channel, firstRef ? firstRef.reference : null],
    );
    const orderId = o.insertId;
    for (const tx_ of t.taxes) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, orderId, tx_.name, tx_.rate_bps, tx_.amount_cents]);
    const done = { tickets: [], lessons: [], packages: [], rentals: [], programs: [], gift_cards: [] };

    for (const p of priced) {
      const ln = p.line;
      const unitsOf = p.type === 'ticket' ? p.quantity : 1; // a ticket line becomes one item per person
      let unitNo = 0;
      const item = async (extra) => (await conn.query(
        `INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, session_id, program_id, contract_id, gift_card_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, orderId, extra.product_id ?? null, p.type, extra.person_id ?? null, extra.session_id ?? null, extra.program_id ?? null, extra.contract_id ?? null, extra.gift_card_id ?? null, ln.tier || 'adult', extra.quantity ?? p.quantity, p.unit,
          extra.valid_on ?? null, split(p.discount, unitsOf)[Math.min(unitNo, unitsOf - 1)], split(p.tax, unitsOf)[Math.min(unitNo++, unitsOf - 1)]],
      ))[0].insertId;

      if (p.type === 'ticket') {
        const validTo = addDays(p.validOn, Math.max(p.product.valid_days, 1) - 1);
        for (const key of holdersOf(ln)) { // one line item and one ticket per person, so every ticket carries a name
          const holder = people.get(key);
          const itemId = await item({ product_id: p.product.id, person_id: holder, valid_on: p.validOn, quantity: 1 });
          const code = newCode();
          await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, itemId, holder, p.product.id, code, p.validOn, validTo, p.product.uses ?? null]);
          done.tickets.push({ code, product: p.product.name, tier: ln.tier, valid_from: p.validOn, valid_to: validTo, person_id: holder, holder: names.get(holder) });
        }
      } else if (p.type === 'lesson' && p.pkg) {
        const owner = personOf(ln);
        const itemId = await item({ product_id: p.product.id, person_id: owner });
        const expires = p.product.valid_days > 1 ? addDays(today, p.product.valid_days) : null;
        const [cr] = await conn.query('INSERT INTO lesson_credits (tenant_id, person_id, product_id, order_item_id, total, expires_on) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, owner, p.product.id, itemId, p.product.uses, expires]);
        await audit(conn, req, 'sell_package', 'lesson_credits', cr.insertId, { person_id: owner, order_id: orderId });
        done.packages.push({ credit_id: cr.insertId, person_id: owner, name: p.name, lessons: p.product.uses, expires_on: expires });
      } else if (p.type === 'lesson') {
        const student = personOf(ln);
        const s = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, p.session.id]);
        if (s.status !== 'scheduled') throw conflict(`That lesson is ${s.status}`);
        await ensureWaiver(ln.participant || 'customer', student, seasonFor(p.day), 'The student');
        const existing = await one(conn, 'SELECT id, status, unpaid FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ?', [tenantId, s.id, student]);
        const adopting = existing && existing.status === 'booked' && existing.unpaid; // their spot is already held
        if (!adopting && (await spotsLeft(conn, tenantId, s.id, s.capacity)) < 1) throw conflict(`${p.name} on ${p.day} is full`);
        let bookingId;
        if (existing && existing.status === 'booked' && existing.unpaid) { await conn.query('UPDATE lesson_bookings SET unpaid = 0 WHERE id = ? AND tenant_id = ?', [existing.id, tenantId]); bookingId = existing.id; } // an online request they are now paying for
        else if (existing && ['booked', 'attended'].includes(existing.status)) throw conflict('That student is already booked into this lesson');
        else if (existing) { await conn.query("UPDATE lesson_bookings SET status = 'booked' WHERE id = ? AND tenant_id = ?", [existing.id, tenantId]); bookingId = existing.id; } else {
          bookingId = (await conn.query('INSERT INTO lesson_bookings (tenant_id, session_id, person_id) VALUES (?, ?, ?)', [tenantId, s.id, student]))[0].insertId;
        }
        await item({ product_id: s.product_id, person_id: student, session_id: s.id });
        await audit(conn, req, 'book', 'lesson_sessions', s.id, { person_id: student, order_id: orderId });
        done.lessons.push({ booking_id: bookingId, session_id: s.id, person_id: student, name: p.name, starts_at: s.starts_at });
      } else if (p.type === 'rental') {
        const renter = personOf(ln);
        const gear = ln.items || [];
        if (!gear.length) throw bad(`Choose the gear for the ${p.name} rental`);
        await ensureWaiver(ln.participant || 'customer', renter, seasonFor(today), 'The renter');
        const dueAt = ln.due_at ? normDateTime(ln.due_at) : `${addDays(p.validOn, Math.max(p.product.valid_days, 1) - 1)} 17:00:00`;
        const [c] = await conn.query('INSERT INTO rental_contracts (tenant_id, person_id, order_id, due_at) VALUES (?, ?, ?, ?)', [tenantId, renter, orderId, dueAt]);
        const locked = await R.insertGear(conn, tenantId, c.insertId, gear, await R.getSettings(conn, tenantId));
        const ids = gear.map((g) => g.rental_item_id);
        await item({ product_id: p.product.id, person_id: renter, contract_id: c.insertId, valid_on: p.validOn });
        await audit(conn, req, 'checkout', 'rental_contracts', c.insertId, { items: ids, order_id: orderId });
        done.rentals.push({ contract_id: c.insertId, person_id: renter, due_at: dueAt, items: locked.map((l) => l.sku) });
      } else if (p.type === 'program') {
        const participant = personOf(ln);
        const pg = await one(conn, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, p.program.id]);
        if (pg.capacity !== null) {
          const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND status = 'enrolled'", [tenantId, pg.id]);
          if (n >= pg.capacity) throw conflict(`${pg.name} is full. Use the Programs screen to add them to the waitlist.`);
        }
        const existing = await one(conn, 'SELECT id, status FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND person_id = ?', [tenantId, pg.id, participant]);
        if (existing && existing.status !== 'withdrawn') throw conflict(`Already ${existing.status} in ${pg.name}`);
        const guardian = buyer.id && buyer.id !== participant ? buyer.id : null;
        let enrollmentId;
        if (existing) {
          await conn.query("UPDATE program_enrollments SET status = 'enrolled', guardian_id = ?, paid_cents = ? WHERE id = ? AND tenant_id = ?", [guardian, p.unit, existing.id, tenantId]);
          enrollmentId = existing.id;
        } else {
          enrollmentId = (await conn.query("INSERT INTO program_enrollments (tenant_id, program_id, person_id, guardian_id, status, paid_cents) VALUES (?, ?, ?, ?, 'enrolled', ?)", [tenantId, pg.id, participant, guardian, p.unit]))[0].insertId;
        }
        await item({ person_id: participant, program_id: pg.id });
        await audit(conn, req, 'enroll', 'programs', pg.id, { person_id: participant, status: 'enrolled', order_id: orderId });
        done.programs.push({ enrollment_id: enrollmentId, program_id: pg.id, person_id: participant, name: pg.name });
      } else {
        const code = newCode();
        const [g] = await conn.query('INSERT INTO gift_cards (tenant_id, code, initial_cents, balance_cents, purchaser_id, recipient_name, message, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [tenantId, code, ln.amount_cents, ln.amount_cents, buyer.id, ln.recipient_name ?? null, ln.message ?? null, orderId]);
        await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, order_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, ?, 'issue', ?, ?)", [tenantId, g.insertId, orderId, ln.amount_cents, ln.amount_cents]);
        await item({ person_id: buyer.id, gift_card_id: g.insertId });
        done.gift_cards.push({ code, amount_cents: ln.amount_cents, recipient_name: ln.recipient_name ?? null });
      }
    }

    // ---- payment
    let change = 0;
    for (const p of body.payments) {
      let cardId = null;
      if (p.tender === 'gift_card') {
        const card = await one(conn, 'SELECT * FROM gift_cards WHERE tenant_id = ? AND code = ? FOR UPDATE', [tenantId, cleanCode(p.code)]);
        if (!card) throw bad('That gift card code was not found');
        if (card.status !== 'active') throw conflict('That gift card has been cancelled');
        if (card.expires_on && card.expires_on < today) throw conflict('That gift card has expired');
        if (card.balance_cents < p.amount_cents) throw conflict(`That gift card only has ${money(card.balance_cents)} left`, { balance_cents: card.balance_cents });
        const left = card.balance_cents - p.amount_cents;
        await conn.query('UPDATE gift_cards SET balance_cents = ? WHERE id = ? AND tenant_id = ?', [left, card.id, tenantId]);
        await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, order_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, ?, 'redeem', ?, ?)", [tenantId, card.id, orderId, -p.amount_cents, left]);
        cardId = card.id;
      }
      if (p.tender === 'cash' && p.tendered_cents && p.tendered_cents > p.amount_cents) change += p.tendered_cents - p.amount_cents;
      await conn.query('INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, tendered_cents, reference, gift_card_id, card_brand, card_last4, auth_code, processor, comp_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [tenantId, orderId, p.tender, p.amount_cents, p.tendered_cents ?? null, p.reference ?? null, cardId, p.card_brand ?? null, p.card_last4 ?? null, p.auth_code ?? null, p.processor ?? null, p.comp_reason ?? null]);
    }

    await audit(conn, req, 'create', 'orders', orderId, { total_cents: t.total, tickets: done.tickets.length, lessons: done.lessons.length, rentals: done.rentals.length, programs: done.programs.length, gift_cards: done.gift_cards.length, tenders: body.payments.map((p) => p.tender), tax_cents: t.tax });
    return {
      id: orderId, person_id: buyer.id, customer: buyer.id ? { id: buyer.id, created: buyer.created, matched: buyer.matched } : null,
      subtotal_cents: t.subtotal, discount_cents: t.discount, tax_cents: t.tax, taxes: t.taxes, total_cents: t.total, change_due_cents: change,
      lines: priced.map(describe), payments: body.payments.map((p) => ({ tender: p.tender, amount_cents: p.amount_cents })),
      ...done,
    };
  });

  res.status(201).json(result);
});

// ---------------------------------------------------------------- gift cards
const publicCard = (c) => ({ code: c.code, status: c.status, initial_cents: c.initial_cents, balance_cents: c.balance_cents, expires_on: c.expires_on, recipient_name: c.recipient_name, created_at: c.created_at });

giftCards.get('/', requireRole('manager'), async (req, res) => {
  const data = await rows(pool, 'SELECT * FROM gift_cards WHERE tenant_id = ? ORDER BY id DESC LIMIT 200', [req.auth.tenantId]);
  res.json({ data: data.map(publicCard) });
});

giftCards.get('/:code', requireRole(...sellers), async (req, res) => {
  const card = await one(pool, 'SELECT * FROM gift_cards WHERE tenant_id = ? AND code = ?', [req.auth.tenantId, cleanCode(req.params.code)]);
  if (!card) throw notFound('Gift card');
  res.json(publicCard(card));
});

giftCards.post('/:code/void', requireRole('manager'), async (req, res) => {
  await tx(async (conn) => {
    const card = await one(conn, 'SELECT * FROM gift_cards WHERE tenant_id = ? AND code = ? FOR UPDATE', [req.auth.tenantId, cleanCode(req.params.code)]);
    if (!card) throw notFound('Gift card');
    if (card.status === 'void') throw conflict('Already cancelled');
    await conn.query("UPDATE gift_cards SET status = 'void', balance_cents = 0 WHERE id = ? AND tenant_id = ?", [card.id, req.auth.tenantId]);
    await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, 'void', ?, 0)", [req.auth.tenantId, card.id, -card.balance_cents]);
    await audit(conn, req, 'void', 'gift_cards', card.id, { balance_cents: card.balance_cents });
  });
  res.json({ ok: true });
});

module.exports = { checkout, giftCards };
