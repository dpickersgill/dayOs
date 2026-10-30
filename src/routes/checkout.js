'use strict';

// One basket for everything the mountain sells: tickets, lessons, rentals, program places, activities and gift cards.
// The counter builds the basket first and adds the customer's details at the end, then pays.
//   GET  /checkout/menu    what can be sold today (with spots left and stock)
//   POST /checkout/quote   prices a basket and checks it can be sold, without selling it
//   POST /checkout         sells it: one order, one payment (or a split), every booking made in one transaction
//   GET  /gift-cards/:code balance check, and POST /gift-cards/:code/void for a manager
// Prices always come from the server. Nothing is saved unless the whole basket can be sold.
const { ON_FILE } = require('../lib/waivers');
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, dateTimeStr, tierEnum, validate, newCode, addDays, todayIn, nowIn, seasonFor, normDateTime } = require('../lib/util');
const { unitPrice, applyPromo } = require('../lib/pricing');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PS = require('../lib/programsessions');
const PP = require('../lib/programplus');
const { personFields, resolvePerson, ensureRequired } = require('../lib/customers');
const { loadRules, applyTax, split } = require('../lib/tax');
const { addLink, isMinor } = require('../lib/family');
const R = require('../lib/rentals');
const F = require('../lib/rentalfit');
const terminal = require('./terminal');
const PPS = require('../lib/partnerpasses');
const ACT = require('../lib/activities');
const GT = require('../lib/guesttypes');
const LS = require('../lib/lessonsale');
const { studentClash, clashWords, spotsLeft } = require('../lib/lessonrules');
const { heldWords } = require('../lib/lessonbooking');
const SH = require('../lib/shopsale');
const WIN = require('../lib/windowsale');

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
  z.object({ type: z.literal('ticket'), product_id: z.number().int().positive(), tier: tierEnum.default('adult'), quantity: z.number().int().min(1).max(200).default(1), valid_on: dateStr.optional(), holders: z.array(z.string().min(1).max(20)).max(200).optional(),
    // A partner pass day (Indy Pass and the like): free or discounted by the program's rules (lib/partnerpasses.js).
    partner: z.object({ program_id: z.number().int().positive(), number: z.string().trim().min(1).max(60), level: z.string().max(30).optional(), id_checked: z.boolean().optional() }).optional() }),
  z.object({ type: z.literal('lesson_package'), product_id: z.number().int().positive(), tier: tierEnum.default('adult'), participant: who }),
  // safety: the student's allergies, medical notes, pickup and contact, and the family's text and photo answers (lib/lessonsale.js)
  z.object({ type: z.literal('lesson'), session_id: z.number().int().positive(), tier: tierEnum.default('adult'), participant: who, safety: LS.safetySchema.optional() }),
  z.object({
    type: z.literal('rental'), product_id: z.number().int().positive(), tier: tierEnum.default('adult'), valid_on: dateStr.optional(), due_at: dateTimeStr.optional(), participant: who,
    items: z.array(R.gearLine).max(60).optional(),
    // The fitting card in Sell: the renter's details, and their signed confirmation of them (needed for skis or a board).
    fit: F.detailsSchema.optional(), signoff: F.signoffSchema.optional(),
  }),
  z.object({
    type: z.literal('program'), program_id: z.number().int().positive(), participant: who,
    // A program run in sessions: one day of one session, or a bundle with a day for each of its sessions.
    term_id: z.number().int().positive().optional(), group_id: z.number().int().positive().optional(),
    bundle_id: z.number().int().positive().optional(), groups: z.array(z.object({ term_id: z.number().int().positive(), group_id: z.number().int().positive() })).max(8).optional(),
    // The child's answers: ski or snowboard, a season pass (no lift ticket part; checked when the sale is made), rental, helmet.
    discipline: z.enum(['ski', 'snowboard']).optional(), has_pass: z.boolean().optional(), needs_rental: z.boolean().optional(), needs_helmet: z.boolean().optional(),
  }),
  // A place on an attraction for one guest: the day, the time slot (none for a day pass), and the clerk's word that this
  // rider meets the attraction's height, weight and age limits (needed when the attraction has limits).
  z.object({ type: z.literal('activity'), product_id: z.number().int().positive(), tier: tierEnum.default('adult'), valid_on: dateStr.optional(), start_time: z.string().trim().max(8).optional(), participant: who, limits_ok: z.boolean().optional() }),
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
  terminal_payment_id: z.number().int().positive().optional(), // a card taken on the counter's card reader (routes/terminal.js)
});

// A reward the guest holds (lib/rewards.js), used at the window: by id (the welcome-back card) or by its code, with the
// choice the guest made, on one line of the basket (its index; the first line it fits when left out).
const rewardUse = z.object({ reward_id: z.number().int().positive().optional(), code: z.string().trim().max(20).optional(), choice: z.enum(['free_ticket', 'percent', 'credit']), line: z.number().int().min(0).max(49).optional() })
  .refine((r) => r.reward_id || r.code, 'Give the reward or its code');
const quoteSchema = z.object({ date: dateStr.optional(), promo_code: z.string().max(40).optional(), lines: z.array(lineSchema).min(1).max(50), rewards: z.array(rewardUse).max(5).optional() });
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
  // Sell sends this: each guest's type follows them across their lines (lib/guesttypes.js followPerson). The check before
  // payment returns the new total, so the counter always takes the right amount.
  follow_types: z.boolean().optional(),
  // A day at its ticket limit (online and window sales together): a manager can still sell, and says why.
  over_limit_reason: z.string().trim().max(300).optional(),
  rewards: z.array(rewardUse).max(5).optional(),
});
const QUICK_KINDS = ['day_ticket', 'multi_day', 'punch_card', 'voucher'];

/** For the Sell menu: each program's sessions still running (not closed or archived), with each day's places and price now. */
async function withSessions(tenantId, programs, today) {
  if (!programs.length) return programs;
  const terms = await rows(pool, "SELECT id, program_id FROM program_terms WHERE tenant_id = ? AND program_id IN (?) AND status IN ('draft','open') ORDER BY starts_on", [tenantId, programs.map((p) => p.id)]);
  const bundles = await rows(pool, 'SELECT id, program_id, name, price_cents, term_ids FROM program_bundles WHERE tenant_id = ? AND program_id IN (?) AND active = 1', [tenantId, programs.map((p) => p.id)]);
  for (const p of programs) {
    p.terms = [];
    for (const t of terms.filter((x) => x.program_id === p.id)) {
      const d = await PS.termDetail(pool, tenantId, t.id, today);
      p.terms.push({ id: d.id, name: d.name, starts_on: d.starts_on, status: d.status, groups: d.groups.map((g) => ({ id: g.id, day: g.day, discipline: g.discipline, left: g.left, price_cents: g.price_now.cents, waiting: g.waiting })) });
    }
    const ids = new Set(p.terms.map((t) => t.id));
    p.bundles = bundles.filter((b) => b.program_id === p.id).map((b) => ({ id: b.id, name: b.name, price_cents: b.price_cents, term_ids: PS.parseJson(b.term_ids, []).map(Number) })).filter((b) => b.term_ids.every((x) => ids.has(x)));
  }
  return programs;
}

// ---------------------------------------------------------------- pricing and availability
// Places left in a lesson: lib/lessonrules.spotsLeft (bookings, waitlist offers still standing and online requests
// still waiting all count), the same count every way of booking uses.

/**
 * Prices every line from the catalog and checks it can be sold. Returns one entry per line:
 * { i, line, type, name, detail, quantity, unit, cents, ... } plus whatever the booking step needs later.
 */
async function priceLines(conn, tenantId, lines, today) {
  const out = [];
  const partnerSeen = new Set();
  const activityCount = new Map(); const clockOf = {};
  for (const [i, ln] of lines.entries()) {
    if (ln.type === 'ticket') {
      const validOn = ln.valid_on || today;
      if (validOn < today) throw bad('Tickets cannot be sold for a past date');
      const { product, cents, walkup } = await unitPrice(conn, tenantId, ln.product_id, ln.tier, validOn, { at: 'window' }); // FAIR: the walk-up cap
      if (!TICKET_KINDS.includes(product.kind)) throw bad(`${product.name} is a ${product.kind} product and cannot be sold as a ticket`);
      if (ln.partner) {
        // One pass, one day, one person; the program's rules decide free or discounted (locked while selling).
        if (ln.quantity !== 1) throw bad('A partner pass day is one ticket for one person');
        const key = PPS.cleanNumber(ln.partner.number);
        if (partnerSeen.has(key)) throw bad('One partner pass day per pass in a basket');
        partnerSeen.add(key);
        const c = await PPS.check(conn, tenantId, ln.partner.program_id, { number: ln.partner.number, level: ln.partner.level, date: validOn, lock: conn !== pool });
        if (c.program.product_id !== product.id) throw bad(`${c.program.name} days are sold as ${(await one(conn, 'SELECT name FROM products WHERE tenant_id = ? AND id = ?', [tenantId, c.program.product_id]) || {}).name || 'their own ticket'}`);
        const unit = PPS.chargeFor(cents, c);
        out.push({ i, line: ln, type: 'ticket', name: `${product.name} (${c.program.name}${c.kind === 'free' ? ', free day' : `, ${c.percent}% off`})`, detail: `${ln.tier}, ${validOn}`, quantity: 1, unit, product, validOn, partner: c, windowCents: cents });
        continue;
      }
      out.push({ i, line: ln, type: 'ticket', name: product.name, detail: `${ln.tier}, ${validOn}${walkup ? ', walk-up cap applied' : ''}`, quantity: ln.quantity, unit: cents, product, validOn, walkup }); // FAIR: the cashier sees the cap
    } else if (ln.type === 'lesson') {
      const session = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, ln.session_id]);
      if (!session) throw notFound('Lesson session');
      if (session.status !== 'scheduled') throw conflict(`That lesson is ${session.status}`);
      const day = session.starts_at.slice(0, 10);
      if (day < today) throw conflict('That lesson date has passed');
      const { product, cents } = await unitPrice(conn, tenantId, session.product_id, ln.tier, day);
      // Spots held for an online request (unpaid) count as open here: the student paying for one takes it over. The exact check happens when booking.
      const held = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status = 'booked' AND unpaid = 1", [tenantId, session.id]);
      const sp = await spotsLeft(conn, tenantId, session);
      if (sp.left + Number(held.n) < 1) throw conflict(sp.booked < session.capacity ? `${product.name} on ${day}: ${heldWords(sp)}` : `${product.name} on ${day} is full`);
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
    } else if (ln.type === 'activity') {
      const day = ln.valid_on || today;
      if (day < today) throw bad('Activities cannot be sold for a past date');
      const { product, cents } = await unitPrice(conn, tenantId, ln.product_id, ln.tier, day);
      const tz = clockOf.tz || (clockOf.tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
      const { attraction, slot } = await ACT.slotFor(conn, tenantId, product, day, ln.start_time, { today, now: nowIn(tz).slice(11, 16) });
      // Places are checked here for the quote (this basket's own earlier lines count too); the sale checks again under a lock.
      const key = `${product.id}|${day}|${slot.start || ''}`;
      const mine = (activityCount.get(key) || 0);
      if (conn === pool) await ACT.ensurePlaces(conn, tenantId, product, day, slot, 1, { lock: false, extra: mine });
      activityCount.set(key, mine + 1);
      out.push({ i, line: ln, type: 'activity', name: product.name, detail: `${ln.tier}, ${day}${slot.start ? `, ${ACT.clock(slot.start)}` : ', all day'}`, quantity: 1, unit: cents, product, attraction, slot, day });
    } else if (ln.type === 'program' && (ln.term_id || ln.bundle_id)) {
      const reg = await PS.priceRegistration(conn, tenantId, ln, today, { pass: async () => (ln.has_pass ? 'claimed' : 'none') });
      out.push({ i, line: ln, type: 'program', name: reg.name, detail: reg.detail, quantity: 1, unit: reg.list_cents, program: reg.program, reg: { ...reg, child: ln.participant || 'customer' } });
    } else if (ln.type === 'program') {
      const program = await one(conn, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ?', [tenantId, ln.program_id]);
      if (!program) throw notFound('Program');
      if (await one(conn, 'SELECT id FROM program_terms WHERE tenant_id = ? AND program_id = ? LIMIT 1', [tenantId, program.id])) throw bad(`Choose the session and day for ${program.name}`);
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
  // Group prices (Track WINDOW): a product's price per person from N people on the same day, when it is lower.
  await WIN.applyGroupPrices(conn, tenantId, out);
  // Sibling discounts on programs run in sessions: the second and later child in the same program pay less.
  const regs = out.filter((p) => p.reg).map((p) => p.reg);
  if (regs.length) {
    PS.applySiblings(regs);
    for (const p of out.filter((x) => x.reg)) {
      p.unit = p.reg.unit_cents;
      if (p.reg.sibling_cents) p.detail = `${p.detail}, sibling discount ${(p.reg.sibling_cents / 100).toFixed(2)}`;
    }
  }
  return out;
}

/** Days this basket would take over a day's ticket limit (lib/shopsale.js overLimits): the window sees it, a manager decides. */
async function overLimits(conn, tenantId, priced) {
  const lines = priced.filter((p) => p.type === 'ticket' && p.product).map((p) => ({ product: p.product, valid_on: p.validOn, quantity: p.quantity }));
  if (!lines.length) return [];
  const tenant = await one(conn, 'SELECT id, online_daily_limit FROM tenants WHERE id = ?', [tenantId]);
  return SH.overLimits(conn, tenant, lines);
}

async function totals(conn, tenantId, priced, promoCode, today, lock) {
  let subtotal = 0;
  let promoEligible = 0; // gift cards are not discounted
  for (const p of priced) {
    p.cents = p.unit * p.quantity - (p.unitOff || []).reduce((n, c) => n + c, 0); // a reward used on this line (lib/windowsale.js)
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

const describe = (p) => ({ index: p.i, type: p.type, name: p.name, detail: p.detail, quantity: p.quantity, unit_price_cents: p.unit, line_cents: p.cents, discount_cents: p.discount || 0, tax_cents: p.tax || 0, ...(p.walkup ? { walkup: p.walkup } : {}),
  ...(p.group ? { group: p.group } : {}), ...(p.rewardsUsed ? { reward_cents: (p.unitOff || []).reduce((n, c) => n + c, 0), rewards: p.rewardsUsed } : {}),
  ...(p.partner ? { partner: { program: p.partner.program.name, kind: p.partner.kind, percent: p.partner.percent, window_cents: p.windowCents, used: p.partner.used, free_days: p.partner.program.free_days, discount_days: p.partner.program.discount_days, history: p.partner.history.map((h) => String(h.on_date).slice(0, 10)) } } : {}) });

// ---------------------------------------------------------------- menu
checkout.get('/menu', requireRole(...sellers), async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone, comp_counter_limit_cents, waiver_text, quick_sale FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const [products, tiers, sessions, programs, stock] = await Promise.all([
    // Best sellers of the last 30 days first, so the busiest tiles sit where the cashier's hand already is.
    rows(pool, `SELECT p.id, p.kind, p.name, p.base_price_cents, p.valid_days, p.uses, p.attraction_id, p.timed, p.day_capacity,
                  (SELECT COALESCE(SUM(i.quantity), 0) FROM order_items i WHERE i.tenant_id = p.tenant_id AND i.product_id = p.id AND i.order_id IN
                    (SELECT o.id FROM orders o WHERE o.tenant_id = p.tenant_id AND o.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY))) AS sold
                FROM products p WHERE p.tenant_id = ? AND p.active = 1 ORDER BY sold DESC, p.name`, [tenantId]),
    rows(pool, 'SELECT product_id, tier, price_cents FROM price_tiers WHERE tenant_id = ?', [tenantId]),
    rows(pool, `SELECT s.id, s.product_id, pr.name, pr.base_price_cents, s.discipline, s.ability_level, s.format, s.age_group, s.meeting_place, s.starts_at, s.ends_at, s.capacity,
                  s.level_min, s.level_max, s.age_min, s.age_max, s.kind, ip.first_name AS instructor_first,
                  (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
                FROM lesson_sessions s JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
                LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people ip ON ip.tenant_id = st.tenant_id AND ip.id = st.person_id
                WHERE s.tenant_id = ? AND s.status = 'scheduled' AND DATE(s.starts_at) BETWEEN ? AND ? ORDER BY s.starts_at LIMIT 400`, [tenantId, today, addDays(today, 14)]),
    rows(pool, `SELECT p.id, p.name, p.kind, p.season, p.capacity, p.price_cents, p.starts_on, p.ends_on, p.includes_ticket, p.includes_rental, p.offers_helmet, p.disciplines,
                  (SELECT COUNT(*) FROM program_enrollments e WHERE e.tenant_id = p.tenant_id AND e.program_id = p.id AND e.status = 'enrolled') AS enrolled
                FROM programs p WHERE p.tenant_id = ? AND (p.ends_on IS NULL OR p.ends_on >= ?) ORDER BY p.name`, [tenantId, today]),
    rows(pool, "SELECT category, COUNT(*) AS available FROM rental_items WHERE tenant_id = ? AND status = 'available' GROUP BY category", [tenantId]),
  ]);
  const withTiers = (p) => ({ ...p, tiers: Object.fromEntries(tiers.filter((t) => t.product_id === p.id).map((t) => [t.tier, t.price_cents])) });
  // Activities by attraction: only active activity products of active attractions (Sell shows the tab only when there are some).
  const acts = products.filter((p) => p.kind === 'activity' && p.attraction_id);
  const attractions = acts.length ? (await ACT.activeAttractions(pool, tenantId)).filter((a) => acts.some((p) => p.attraction_id === a.id)) : [];
  res.json({
    activities: attractions.map((a) => ({ attraction: ACT.attractionOut(a), products: acts.filter((p) => p.attraction_id === a.id).map((p) => ({ ...withTiers(p), timed: Boolean(p.timed) })) })),
    today,
    tickets: products.filter((p) => TICKET_KINDS.includes(p.kind) && p.kind !== 'voucher').map(withTiers),
    rentals: products.filter((p) => p.kind === 'rental').map(withTiers),
    packages: products.filter((p) => p.kind === 'lesson' && p.uses > 1).map(withTiers),
    // the window's day strip (Sell, Lessons): level range and ages in words, and whether the lesson has started
    lessons: LS.menuLessons(sessions.map((x) => ({ ...x, tiers: Object.fromEntries(tiers.filter((t) => t.product_id === x.product_id).map((t) => [t.tier, t.price_cents])) })), nowIn(tenant.timezone)),
    programs: await withSessions(tenantId, programs.map((p) => ({ ...p, spots_left: p.capacity === null ? null : Math.max(p.capacity - Number(p.enrolled), 0) })), today),
    stock: Object.fromEntries(stock.map((s) => [s.category, Number(s.available)])),
    gift_card: { min_cents: GIFT_MIN, max_cents: GIFT_MAX },
    waiver_text: tenant.waiver_text || null,
    quick_sale: { allowed: Boolean(tenant.quick_sale), kinds: QUICK_KINDS },
    tax_rules: await rows(pool, 'SELECT name, applies_to, rate_bps FROM tax_rules WHERE tenant_id = ? AND active = 1 ORDER BY id', [tenantId]),
    comp: { reasons: COMP_REASONS, counter_limit_cents: tenant.comp_counter_limit_cents, can_comp: ['owner', 'manager'].includes(req.auth.role) || tenant.comp_counter_limit_cents > 0 },
    // refunds at the counter (Track WINDOW): managers always; counter staff up to this much per order (0: never)
    refund: { counter_limit_cents: (await require('../lib/guestsettings').get(pool, tenantId)).counter_refund_limit_cents, can_refund: ['owner', 'manager'].includes(req.auth.role) || (await require('../lib/guestsettings').get(pool, tenantId)).counter_refund_limit_cents > 0 },
    partner_programs: (await rows(pool, 'SELECT id, name, product_id, levels, number_label, id_check, staff_note FROM partner_programs WHERE tenant_id = ? AND active = 1 ORDER BY name', [tenantId])).map((x) => ({ ...x, levels: PPS.levelsOf(x), id_check: Boolean(x.id_check) })),
  });
});

/** One day of activities at the counter: each product's time slots (or the whole day) with places left, refreshed as it sells. */
checkout.get('/activity-day', requireRole(...sellers), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const today = todayIn(tz);
  const day = String(req.query.date || today);
  if (!dateStr.safeParse(day).success) throw bad('date must be YYYY-MM-DD');
  if (day < today) throw bad('Pick today or a later day');
  const aid = Number(req.query.attraction_id) || null;
  const prods = await rows(pool, `SELECT id, kind, name, attraction_id, timed, day_capacity, sale_days FROM products WHERE tenant_id = ? AND active = 1 AND kind = 'activity'${aid ? ' AND attraction_id = ?' : ''} ORDER BY name`, aid ? [tenantId, aid] : [tenantId]);
  const used = await ACT.taken(pool, tenantId, prods.map((p) => p.id), day);
  const now = day === today ? nowIn(tz).slice(11, 16) : null;
  const out = [];
  for (const p of prods) {
    const d = await ACT.dayOf(pool, tenantId, p, day, { now, used });
    const blackout = await one(pool, 'SELECT 1 AS x FROM price_calendar WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND blackout = 1 AND tier IS NULL', [tenantId, p.id, day]);
    out.push({ id: p.id, name: p.name, attraction_id: p.attraction_id, timed: d.timed, slots: d.slots, closed: Boolean(blackout) || !require('../lib/saledays').allowedOn(p.sale_days, day) });
  }
  res.json({ date: day, today, products: out });
});

// ---------------------------------------------------------------- quote
checkout.post('/quote', requireRole(...sellers), validate(quoteSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const priced = await priceLines(pool, tenantId, req.body.lines, today);
  const used = await WIN.applyRewards(pool, tenantId, priced, req.body.rewards, today, { lock: false });
  const t = await totals(pool, tenantId, priced, req.body.promo_code, today, false);
  res.json({ rewards: used, lines: priced.map(describe), subtotal_cents: t.subtotal, discount_cents: t.discount, tax_cents: t.tax, taxes: t.taxes, total_cents: t.total, gift_card_cents: t.giftCents, warnings: LS.dayWarnings(priced), over_limit: await overLimits(pool, tenantId, priced) });
});

// ---------------------------------------------------------------- checkout
/** A sale checked but not made: thrown inside the transaction so everything it wrote (a new customer) is rolled back. */
class Checked extends Error { constructor(result) { super('checked'); this.result = result; } }

/**
 * The sale, inside one transaction. Everything that can refuse it (prices, who it is for, guardians, waivers, a rider's
 * limits and age, places left, gear) is checked first; only then are the order, its bookings and its payments written.
 * With `check` set, it stops after those checks and throws Checked with the quote, so the counter can be sure the sale
 * will go through before any money is taken, on the reader or from the till.
 */
async function runSale(conn, req, body, { check = false } = {}) {
  const { tenantId } = req.auth;
  {
    // Activity places are claimed under their products' row locks, taken first (before anything is read), so a sale that
    // finished while this one waited is counted.
    await ACT.lockProducts(conn, tenantId, body.lines.filter((l) => l.type === 'activity').map((l) => l.product_id));
    const tenant = await one(conn, 'SELECT timezone, comp_counter_limit_cents, waiver_text, quick_sale FROM tenants WHERE id = ?', [tenantId]);
    const today = todayIn(tenant.timezone);
    // a guest's type follows them: a child on the lesson is a child on the rental and the ticket too (lib/guesttypes.js)
    body = { ...body, lines: body.lines.map((l) => ({ ...l, ...(l.holders ? { holders: [...l.holders] } : {}) })) };
    const typeChanges = body.follow_types ? await GT.followPerson(conn, tenantId, body, today) : [];
    const lines = body.lines;

    // ---- price first, so a bad line or a wrong payment fails before anything is saved
    const priced = await priceLines(conn, tenantId, lines, today);
    // ---- rewards the guest is using (Track WINDOW): locked now, so two sales cannot both use one; marked used below
    const rewardsUsed = await WIN.applyRewards(conn, tenantId, priced, body.rewards, today, { lock: !check });
    // ---- a day at its ticket limit: the same lock the online shop takes, so the window and the shop count one at a time.
    // The cashier sees the limit; only a manager goes over it, with a reason, and that is audited below.
    if (!check && priced.some((p) => p.type === 'ticket')) await conn.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
    const over = await overLimits(conn, tenantId, priced);
    if (over.length) {
      const words = over.map((o) => o.words).join(' ');
      if (!body.over_limit_reason) throw conflict(`${words} Only a manager can sell over the limit, and says why.`, { over_limit: over });
      if (!['owner', 'manager'].includes(req.auth.role)) throw forbidden(`${words} Only a manager can sell over the limit. Ask a manager to make this sale.`);
    }
    const t = await totals(conn, tenantId, priced, body.promo_code, today, !check);
    if (check) body = { ...body, payments: [] }; // not paid yet: the payment is checked when the sale is made
    const paySum = body.payments.reduce((n, p) => n + p.amount_cents, 0);
    if (t.total === 0 && body.payments.length) throw bad('Nothing is due on this basket, so no payment should be recorded');
    if (t.total > 0 && !body.payments.length && !check) throw bad('Record how it was paid');
    if (!check && paySum !== t.total) throw bad(`Payments add up to ${money(paySum)} but the basket is ${money(t.total)}`);
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

    // ---- a partner pass day: the photo ID was checked, when the program asks for it, and never on a quick sale
    for (const p of priced) {
      if (!p.partner) continue;
      if (body.quick) throw bad(`A ${p.partner.program.name} day needs the guest's name. Use the full checkout.`);
      if (p.partner.program.id_check && !p.line.partner.id_checked) throw bad(`Check the guest's photo ID against their ${p.partner.program.name} account first`);
    }

    // ---- quick sale: tickets only, nobody named, nothing saved about the guest
    if (body.quick) {
      if (!tenant.quick_sale) throw bad('Quick sale is switched off for this mountain: add the customer\'s details');
      if (body.participants && Object.keys(body.participants).length) throw bad('A quick sale has no named guests');
      for (const p of priced) {
        if (p.type === 'gift_card') continue; // a gift card names nobody: the code is the card
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
    const scopeFor = (types) => (isLesson(types) ? 'lesson' : types.has('ticket') || types.has('activity') || types.has('buyer') ? 'ticket' : 'none');
    // A day ticket needs only a name (Track WINDOW): no date of birth or sex unless something else this person gets needs
    // them (a season pass, a lesson, a rental, a program place, an activity). What is missing is shown, never blocking.
    const fullFor = new Set();
    for (const p of priced) {
      if (p.type === 'gift_card') continue;
      if (p.type === 'ticket') { if (p.product.kind === 'season_pass') for (const k of holdersOf(p.line)) fullFor.add(k); continue; }
      fullFor.add(keyOf(p.line));
    }
    const softMissing = [];
    const resolve = async (key, spec) => {
      const types = usedBy.get(key);
      const light = !fullFor.has(key);
      const r = await resolvePerson(conn, tenantId, { personId: spec.person_id, details: spec.details, scope: scopeFor(types), source: body.channel, sale: light ? { today, light: true, noContact: key !== 'customer' } : sale });
      if (light && r.person) { const gap = WIN.softGaps(r.person); if (gap.length) softMissing.push({ key, person_id: r.id, name: `${r.person.first_name} ${r.person.last_name}`, missing: gap }); }
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

    // A waiver on file for the season, or one being signed at the counter now: checked before anything is written,
    // then recorded when the booking is made.
    const waiverOk = async (key, personId, season, label) => {
      if (await one(conn, ON_FILE, [tenantId, personId, season])) return;
      const g = guardianOf.get(key);
      if (!waiverFor.get(key)) throw conflict(g ? `${label} is under 18: their guardian must sign the waiver for the ${season} season` : `${label} needs a signed waiver for the ${season} season`, { person_id: personId });
    };
    const ensureWaiver = async (key, personId, season, label) => {
      await waiverOk(key, personId, season, label);
      if (await one(conn, ON_FILE, [tenantId, personId, season])) return;
      const g = guardianOf.get(key);
      const me = personRows.get(personId);
      const signer = g || me;
      const sha = tenant.waiver_text ? crypto.createHash('sha256').update(tenant.waiver_text).digest('hex') : null;
      const [w] = await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_person_id, signed_by_name, signer_relation, text_sha, method, recorded_by) VALUES (?, ?, ?, 'general', ?, ?, ?, ?, 'recorded_by_staff', ?)",
        [tenantId, personId, season, signer.id, `${signer.first_name} ${signer.last_name}`, g ? 'guardian' : 'self', sha, req.auth.userId]);
      await audit(conn, req, 'sign_waiver', 'waivers', w.insertId, { person_id: personId, season, signed_by: signer.id });
    };
    // A lesson's session, locked, with the student's place: refused when it is not running, full, or already theirs.
    const lessonCheck = async (p, student) => {
      const s = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, p.session.id]);
      if (s.status !== 'scheduled') throw conflict(`That lesson is ${s.status}`);
      const existing = await one(conn, 'SELECT id, status, unpaid FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ?', [tenantId, s.id, student]);
      const adopting = Boolean(existing && existing.status === 'booked' && existing.unpaid); // their spot is already held
      if (!adopting && existing && ['booked', 'attended'].includes(existing.status)) throw conflict('That student is already booked into this lesson');
      if (!adopting) {
        const sp = await spotsLeft(conn, tenantId, s);
        if (sp.left < 1) throw conflict(sp.booked < s.capacity ? `${p.name} on ${p.day}: ${heldWords(sp)}` : `${p.name} on ${p.day} is full`);
      }
      // not already in another lesson or a program meeting at that time (lib/lessonrules.js; the student's people row
      // was locked when the sale found them, before the lesson row, and lock: true reads the latest bookings)
      const clash = await studentClash(conn, tenantId, student, s.starts_at, s.ends_at, { ignoreSessionId: s.id, lock: true });
      if (clash) throw conflict(`${(personRows.get(student) || {}).first_name || 'The student'}: ${clashWords(clash)}`);
      return { s, existing, adopting };
    };
    // An activity rider: the clerk's word on the limits, old enough, and (when the attraction asks) a waiver.
    const riderCheck = async (p) => {
      const key = p.line.participant || 'customer';
      const rider = personOf(p.line);
      const me = personRows.get(rider);
      const a = p.attraction;
      const who = `${me.first_name} ${me.last_name}`;
      if (ACT.hasLimits(a) && !p.line.limits_ok) throw bad(`Confirm that ${who} meets the limits for ${a.name}. ${ACT.limitsText(a)}`, { person_id: rider, attraction_id: a.id });
      const age = a.min_age ? ACT.ageOn(me.date_of_birth, p.day) : null;
      if (age !== null && age < a.min_age) throw conflict(`${who} is ${age}. ${a.name} riders must be ${a.min_age} or older.`);
      if (a.waiver_required) await waiverOk(key, rider, seasonFor(p.day), 'The rider');
    };
    // A program with no sessions: a place left, and not already in it.
    const programCheck = async (p, participant) => {
      const pg = await one(conn, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, p.program.id]);
      if (pg.capacity !== null) {
        const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND status = 'enrolled'", [tenantId, pg.id]);
        if (n >= pg.capacity) throw conflict(`${pg.name} is full. Use the Programs screen to add them to the waitlist.`);
      }
      const existing = await one(conn, 'SELECT id, status FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND person_id = ?', [tenantId, pg.id, participant]);
      if (existing && existing.status !== 'withdrawn') throw conflict(`Already ${existing.status} in ${pg.name}`);
      return { pg, existing };
    };

    // ---- everything that can still refuse the sale, before the order, its bookings or any payment is written. The
    // cashier sees a refusal before money changes hands, not after. The booking step checks again under its locks.
    const placesWanted = new Map(); // activity product|day|slot -> places this basket takes
    for (const p of priced) {
      const ln = p.line;
      if (p.type === 'lesson' && !p.pkg) {
        const student = personOf(ln);
        await waiverOk(ln.participant || 'customer', student, seasonFor(p.day), 'The student');
        await lessonCheck(p, student);
      } else if (p.type === 'rental') {
        // No gear: the rental is paid now and fitted at the rental shop (Ready to fit), where the waiver is checked.
        const gear = ln.items || [];
        if (!gear.length) continue;
        await waiverOk(ln.participant || 'customer', personOf(ln), seasonFor(today), 'The renter');
        // Every person wearing skis or a snowboard needs their own signoff. The one signed on this card is the renter's
        // only, and it counts once it is written (checked again below after it is); it never covers anyone else.
        const renter = personOf(ln);
        const fs = await F.fitSettings(conn, tenantId);
        const others = gear.filter((g) => g.person_id && g.person_id !== renter);
        const mine = gear.filter((g) => !g.person_id || g.person_id === renter);
        await F.requireSignoffs(conn, tenantId, others, renter, fs);
        if (!ln.signoff && renter) {
          const onFile = await F.detailsOf(conn, tenantId, renter);
          await F.requireSignoffs(conn, tenantId, mine, renter, fs).catch(async (err) => {
            // a signoff in the window whose details match what was typed on the card now still counts
            if (!ln.fit) throw err;
            const v = await F.validSignoff(conn, tenantId, renter, { ...onFile.details, ...ln.fit }, { settings: fs });
            if (!v || v.mismatch.length) throw err;
          });
        }
        const ids = gear.map((g) => g.rental_item_id);
        if (new Set(ids).size !== ids.length) throw bad('The same rental item was chosen twice');
        const items = await rows(conn, 'SELECT id, sku, status FROM rental_items WHERE tenant_id = ? AND id IN (?)', [tenantId, ids]);
        if (items.length !== ids.length) throw notFound('One or more rental items');
        const out = items.filter((r) => r.status !== 'available');
        if (out.length) throw conflict('Some gear is not available', out.map((u) => ({ sku: u.sku, status: u.status })));
      } else if (p.type === 'activity') {
        await riderCheck(p);
        const key = `${p.product.id}|${p.day}|${p.slot.start || ''}`;
        const mine = placesWanted.get(key) || 0;
        await ACT.ensurePlaces(conn, tenantId, p.product, p.day, p.slot, 1, { extra: mine });
        placesWanted.set(key, mine + 1);
      } else if (p.type === 'program' && p.reg) {
        const participant = personOf(ln);
        for (const x of p.reg.parts) {
          const existing = await one(conn, 'SELECT id, status FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND term_key = ? AND person_id = ?', [tenantId, p.program.id, x.term.id, participant]);
          if (existing && existing.status !== 'withdrawn') throw conflict(`Already ${existing.status === 'waitlist' ? 'on the waitlist' : 'enrolled'} in ${x.term.name}`);
          const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND group_id = ? AND status = 'enrolled'", [tenantId, x.group.id]);
          if (x.group.capacity != null && Number(n) >= x.group.capacity) throw conflict(`${PS.WEEKDAYS[x.group.weekday]}s in ${x.term.name} are full`);
        }
      } else if (p.type === 'program') {
        await programCheck(p, personOf(ln));
      }
    }
    if (check) {
      throw new Checked({ ok: true, missing: softMissing, rewards: rewardsUsed, lines: priced.map(describe), subtotal_cents: t.subtotal, discount_cents: t.discount, tax_cents: t.tax, taxes: t.taxes, total_cents: t.total, gift_card_cents: t.giftCents, type_changes: typeChanges, warnings: LS.dayWarnings(priced), over_limit: over });
    }

    // ---- the order
    const firstRef = body.payments.find((p) => p.reference);
    const [o] = await conn.query(
      `INSERT INTO orders (tenant_id, person_id, user_id, status, promo_code, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, buyer.id, req.auth.userId, t.promo, t.subtotal, t.discount, t.tax, t.total, body.channel, firstRef ? firstRef.reference : null],
    );
    if (over.length) await audit(conn, req, 'sell_over_limit', 'orders', o.insertId, { reason: body.over_limit_reason, days: over.map((x) => ({ date: x.date, product_id: x.product_id, limit: x.limit, sold: x.sold, wanted: x.wanted })) });
    const orderId = o.insertId;
    for (const tx_ of t.taxes) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, orderId, tx_.name, tx_.rate_bps, tx_.amount_cents]);
    const done = { tickets: [], lessons: [], packages: [], rentals: [], programs: [], activities: [], gift_cards: [], program_adjustments: [] };
    // the rewards used: marked used on this order (row locked above), and audited
    for (const r of rewardsUsed) {
      await require('../lib/rewards').redeem(conn, tenantId, r.id, { choice: r.choice, day: today, orderId, userId: req.auth.userId });
      await audit(conn, req, 'redeem', 'guest_rewards', r.id, { order_id: orderId, choice: r.choice, value_cents: r.value_cents });
    }

    for (const p of priced) {
      const ln = p.line;
      const unitsOf = p.type === 'ticket' ? p.quantity : 1; // a ticket line becomes one item per person
      let unitNo = 0;
      const item = async (extra) => {
        const k = Math.min(unitNo++, unitsOf - 1);
        const off = (p.unitOff || [])[k] || 0; // a reward used on this unit lowers what it cost (lib/windowsale.js)
        const qty = extra.quantity ?? p.quantity;
        return (await conn.query(
          `INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, session_id, program_id, contract_id, gift_card_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents, reward_id, list_cents, reward_cents)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [tenantId, orderId, extra.product_id ?? null, p.type, extra.person_id ?? null, extra.session_id ?? null, extra.program_id ?? null, extra.contract_id ?? null, extra.gift_card_id ?? null, ln.tier || 'adult', qty,
            qty === 1 ? p.unit - off : p.unit, extra.valid_on ?? null, split(p.discount, unitsOf)[k], split(p.tax, unitsOf)[k], (p.unitReward || [])[k] || null,
            p.unit, qty === 1 ? off : 0], // list_cents and reward_cents (db/steps/guests-fix.js, lib/linevalue.js)
        ))[0].insertId;
      };

      if (p.type === 'ticket') {
        const validTo = addDays(p.validOn, Math.max(p.product.valid_days, 1) - 1);
        for (const key of holdersOf(ln)) { // one line item and one ticket per person, so every ticket carries a name
          const holder = people.get(key);
          const itemId = await item({ product_id: p.product.id, person_id: holder, valid_on: p.validOn, quantity: 1 });
          const code = newCode();
          const [tk] = await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, itemId, holder, p.product.id, code, p.validOn, validTo, p.product.uses ?? null]);
          done.tickets.push({ code, product: p.product.name, tier: ln.tier, valid_from: p.validOn, valid_to: validTo, person_id: holder, holder: names.get(holder) });
          if (p.partner) {
            const rid = await PPS.record(conn, tenantId, p.partner, { date: p.validOn, windowCents: p.windowCents, chargedCents: p.unit, personId: holder, orderId, itemId, ticketId: tk.insertId, channel: body.channel, idChecked: Boolean(ln.partner.id_checked), userId: req.auth.userId });
            done.partner = (done.partner || []).concat({ id: rid, program: p.partner.program.name, kind: p.partner.kind, percent: p.partner.percent, number: p.partner.number, used: { free: p.partner.used.free + (p.partner.kind === 'free' ? 1 : 0), discount: p.partner.used.discount + (p.partner.kind === 'discount' ? 1 : 0) } });
          }
          // A season pass for a child already in a program with a lift ticket part: refund or credit it, per the mountain.
          if (p.product.kind === 'season_pass') done.program_adjustments.push(...await PP.passBought(conn, tenantId, holder, { passFrom: p.validOn, passTo: validTo, userId: req.auth.userId }));
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
        await ensureWaiver(ln.participant || 'customer', student, seasonFor(p.day), 'The student');
        const { s, existing, adopting } = await lessonCheck(p, student);
        let bookingId;
        if (adopting) { await conn.query('UPDATE lesson_bookings SET unpaid = 0 WHERE id = ? AND tenant_id = ?', [existing.id, tenantId]); bookingId = existing.id; } // an online request they are now paying for
        else if (existing) { await conn.query("UPDATE lesson_bookings SET status = 'booked' WHERE id = ? AND tenant_id = ?", [existing.id, tenantId]); bookingId = existing.id; } else {
          bookingId = (await conn.query('INSERT INTO lesson_bookings (tenant_id, session_id, person_id) VALUES (?, ?, ?)', [tenantId, s.id, student]))[0].insertId;
        }
        await item({ product_id: s.product_id, person_id: student, session_id: s.id });
        await LS.saveSafety(conn, req, tenantId, bookingId, student, s, ln.safety);
        await audit(conn, req, 'book', 'lesson_sessions', s.id, { person_id: student, order_id: orderId });
        done.lessons.push({ booking_id: bookingId, session_id: s.id, person_id: student, name: p.name, starts_at: s.starts_at, ...(await LS.receiptBits(conn, tenantId, s, student)) });
      } else if (p.type === 'rental') {
        const renter = personOf(ln);
        const gear = ln.items || [];
        const key = ln.participant || 'customer';
        const fs = await F.fitSettings(conn, tenantId);
        if (ln.fit) await F.saveDetails(conn, tenantId, renter, ln.fit);
        if (!gear.length) {
          // Paid and ready to fit: one contract for the renter, no gear yet. A waiver ticked at the window is still recorded.
          if (waiverFor.get(key)) await ensureWaiver(key, renter, seasonFor(today), 'The renter');
          const tf = await F.createToFit(conn, tenantId, { personId: renter, orderId, validOn: p.validOn, product: p.product, settings: fs });
          const itemId = await item({ product_id: p.product.id, person_id: renter, contract_id: tf.id, valid_on: p.validOn });
          await conn.query('UPDATE rental_contracts SET order_item_id = ? WHERE tenant_id = ? AND id = ?', [itemId, tenantId, tf.id]);
          await audit(conn, req, 'sell_to_fit', 'rental_contracts', tf.id, { order_id: orderId, kind: tf.kind });
          done.rentals.push({ contract_id: tf.id, person_id: renter, status: 'to_fit', kind: tf.kind, due_at: tf.due_at, items: [] });
          continue;
        }
        await ensureWaiver(key, renter, seasonFor(today), 'The renter');
        const kind = p.product.rental_kind === 'season' ? 'season' : 'day';
        const dueAt = ln.due_at ? normDateTime(ln.due_at) : F.dueFor(fs, kind, p.validOn, p.product.valid_days);
        const [c] = await conn.query('INSERT INTO rental_contracts (tenant_id, person_id, order_id, due_at, kind, valid_on) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, renter, orderId, dueAt, kind, p.validOn]);
        if (ln.signoff) await F.saveDetails(conn, tenantId, renter, ln.signoff.details);
        if (ln.signoff) await F.writeSignoff(conn, tenantId, renter, ln.signoff, { contractId: c.insertId, ip: req.ip || null, today });
        // the details and the signoff are written now: check every wearer for real before the gear goes out
        await F.requireSignoffs(conn, tenantId, gear, renter, fs);
        const locked = await R.insertGear(conn, tenantId, c.insertId, gear, fs);
        const ids = gear.map((g) => g.rental_item_id);
        const itemId = await item({ product_id: p.product.id, person_id: renter, contract_id: c.insertId, valid_on: p.validOn });
        await conn.query('UPDATE rental_contracts SET order_item_id = ? WHERE tenant_id = ? AND id = ?', [itemId, tenantId, c.insertId]);
        await audit(conn, req, 'checkout', 'rental_contracts', c.insertId, { items: ids, order_id: orderId });
        done.rentals.push({ contract_id: c.insertId, person_id: renter, status: 'out', kind, due_at: dueAt, items: locked.map((l) => l.sku) });
      } else if (p.type === 'activity') {
        // One guest, one place, one ticket good once at this attraction in this slot.
        const key = ln.participant || 'customer';
        const rider = personOf(ln);
        const a = p.attraction;
        await riderCheck(p);
        if (a.waiver_required) await ensureWaiver(key, rider, seasonFor(p.day), 'The rider');
        await ACT.ensurePlaces(conn, tenantId, p.product, p.day, p.slot, 1);
        const itemId = await item({ product_id: p.product.id, person_id: rider, valid_on: p.day });
        const code = newCode();
        const [tk] = await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', [tenantId, itemId, rider, p.product.id, code, p.day, p.day]);
        await ACT.book(conn, tenantId, { product: p.product, attractionId: a.id, day: p.day, slot: p.slot, personId: rider, orderItemId: itemId, ticketId: tk.insertId, channel: body.channel, limitsBy: ACT.hasLimits(a) ? req.auth.userId : null });
        const when = p.slot.start ? `${ACT.clock(p.slot.start)} to ${ACT.clock(p.slot.end)}` : 'All day';
        done.tickets.push({ code, product: `${p.product.name}, ${when}`, tier: ln.tier, valid_from: p.day, valid_to: p.day, person_id: rider, holder: names.get(rider) });
        done.activities.push({ code, attraction: a.name, product: p.product.name, date: p.day, start_time: p.slot.start, end_time: p.slot.end, person_id: rider, holder: names.get(rider) });
      } else if (p.type === 'program' && p.reg) {
        const participant = personOf(ln);
        const guardian = buyer.id && buyer.id !== participant ? buyer.id : null;
        // One order line for the registration; one place per session. Each place carries its share of the price paid.
        const itemId = await item({ person_id: participant, program_id: p.program.id });
        const paidShare = split(p.unit - (p.discount || 0) + (p.tax || 0), p.reg.parts.length);
        for (const [k, x] of p.reg.parts.entries()) {
          // A pass the cashier was told about is looked up now the child is known: found, or flagged for the first lesson.
          if (x.pass_status === 'claimed') x.pass_status = await PP.passStatus(conn, tenantId, { personId: participant }, (await PP.termStart(conn, tenantId, x.term.id)) || PS.dstr(x.term.starts_on), true);
          const e = await PS.enroll(conn, tenantId, { program: p.program, term: x.term, group: x.group, personId: participant, guardianId: guardian, priceCents: x.list_cents, discountCents: x.discount_cents || 0, paidCents: paidShare[k], bundleId: p.reg.bundle ? p.reg.bundle.id : null, orderId, mustFit: true, details: PS.detailsOf(p.reg, x, ln) });
          const ticket = await PS.issueTicket(conn, tenantId, { program: p.program, group: x.group, personId: participant, orderId, enrollmentId: e.id });
          await audit(conn, req, 'enroll', 'programs', p.program.id, { person_id: participant, term_id: x.term.id, group_id: x.group.id, order_id: orderId, order_item: itemId });
          done.programs.push({ enrollment_id: e.id, program_id: p.program.id, person_id: participant, name: `${p.program.name}: ${x.term.name}, ${PS.WEEKDAYS[x.group.weekday]}s`, ticket: ticket ? ticket.code : null });
        }
      } else if (p.type === 'program') {
        const participant = personOf(ln);
        const { pg, existing } = await programCheck(p, participant);
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
        if (card.status !== 'active') throw conflict('That gift card has been canceled');
        if (card.expires_on && card.expires_on < today) throw conflict('That gift card has expired');
        if (card.balance_cents < p.amount_cents) throw conflict(`That gift card only has ${money(card.balance_cents)} left`, { balance_cents: card.balance_cents });
        const left = card.balance_cents - p.amount_cents;
        await conn.query('UPDATE gift_cards SET balance_cents = ? WHERE id = ? AND tenant_id = ?', [left, card.id, tenantId]);
        await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, order_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, ?, 'redeem', ?, ?)", [tenantId, card.id, orderId, -p.amount_cents, left]);
        cardId = card.id;
      }
      if (p.tender === 'cash' && p.tendered_cents && p.tendered_cents > p.amount_cents) change += p.tendered_cents - p.amount_cents;
      if (p.terminal_payment_id) {
        // Paid on the card reader: the payment Stripe took, on the mountain's account, so it refunds like an online one.
        if (p.tender !== 'card') throw bad('A card reader payment must be recorded as a card');
        const tp = await terminal.attach(conn, tenantId, p.terminal_payment_id, p.amount_cents, orderId);
        await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, card_brand, card_last4, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, ?, ?, 'stripe', ?, ?)",
          [tenantId, orderId, p.amount_cents, tp.intent, tp.brand, tp.last4, tp.account, tp.fee]);
        continue;
      }
      await conn.query('INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, tendered_cents, reference, gift_card_id, card_brand, card_last4, auth_code, processor, comp_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [tenantId, orderId, p.tender, p.amount_cents, p.tendered_cents ?? null, p.reference ?? null, cardId, p.card_brand ?? null, p.card_last4 ?? null, p.auth_code ?? null, p.processor ?? null, p.comp_reason ?? null]);
    }

    await audit(conn, req, 'create', 'orders', orderId, { total_cents: t.total, tickets: done.tickets.length, lessons: done.lessons.length, rentals: done.rentals.length, programs: done.programs.length, activities: done.activities.length, gift_cards: done.gift_cards.length, tenders: body.payments.map((p) => p.tender), tax_cents: t.tax });
    return {
      id: orderId, person_id: buyer.id, customer: buyer.id ? { id: buyer.id, created: buyer.created, matched: buyer.matched } : null,
      subtotal_cents: t.subtotal, discount_cents: t.discount, tax_cents: t.tax, taxes: t.taxes, total_cents: t.total, change_due_cents: change,
      lines: priced.map(describe), payments: body.payments.map((p) => ({ tender: p.tender, amount_cents: p.amount_cents })),
      type_changes: typeChanges, warnings: LS.dayWarnings(priced), over_limit: over, missing: softMissing, rewards: rewardsUsed,
      ...done,
    };
  }
}

checkout.post('/', requireRole(...sellers), validate(checkoutSchema), async (req, res) => {
  const result = await tx((conn) => runSale(conn, req, req.body));
  if (result.program_adjustments && result.program_adjustments.length) await PP.afterPassBought(req.auth.tenantId, result.program_adjustments).catch(() => {});
  // each lesson booked gets its confirmation (lib/lessonconfirm.js), after the sale has committed
  await LS.confirmAll(req, result.lessons);
  res.status(201).json(result);
});

/**
 * The same sale, checked but not made: the customer and participants, guardians, waivers, limits, ages, places and gear
 * are all held to the rules of a real sale, and the answer is the quote, or the refusal the sale would get. The counter
 * asks this before taking any money (cash, or a card on the reader), so a guest is never paid up and then turned away.
 * Nothing is kept: not even a new customer's details, which are saved when the sale is made.
 */
checkout.post('/check', requireRole(...sellers), validate(checkoutSchema), async (req, res) => {
  let out;
  try {
    await tx((conn) => runSale(conn, req, req.body, { check: true }));
  } catch (err) {
    if (!(err instanceof Checked)) throw err;
    out = err.result;
  }
  res.json(out);
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
    if (card.status === 'void') throw conflict('Already canceled');
    await conn.query("UPDATE gift_cards SET status = 'void', balance_cents = 0 WHERE id = ? AND tenant_id = ?", [card.id, req.auth.tenantId]);
    await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, 'void', ?, 0)", [req.auth.tenantId, card.id, -card.balance_cents]);
    await audit(conn, req, 'void', 'gift_cards', card.id, { balance_cents: card.balance_cents });
  });
  res.json({ ok: true });
});

module.exports = { checkout, giftCards };
