'use strict';

// Online registration for programs run in sessions (lib/programsessions.js). A parent picks a program, a session and a
// day (or a bundle of sessions with a day in each), adds each child, accepts the waiver and pays by card into the
// mountain's own Stripe account. Nothing is held until the payment lands: then the places are made, the included lift
// tickets issued and the confirmation emailed with every lesson date. A day that filled up while they paid is refunded.
// A full day takes a waitlist sign-up instead (no payment; the mountain takes payment when a place opens).
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { z, dateStr, validate, todayIn, seasonFor } = require('../lib/util');
const { notFound, conflict, bad, Unhonourable } = require('../lib/errors');
const { baseUrl } = require('../lib/baseurl');
const stripe = require('../lib/stripe');
const connect = require('../lib/connect');
const cardrefund = require('../lib/cardrefund');
const { logFailure } = require('../lib/jobs');
const sandbox = require('../lib/sandbox');
const mailer = require('../lib/mailer');
const { audit } = require('../lib/audit');
const { loadRules, applyTax } = require('../lib/tax');
const { resolvePerson } = require('../lib/customers');
const { addLink, mayActAsGuardian, isMinor } = require('../lib/family');
const { contactPerson } = require('../lib/onlinesale');
const { ON_FILE, shaOf } = require('../lib/waivers');
const { money } = require('../lib/format');
const PS = require('../lib/programsessions');
const PP = require('../lib/programplus');

const publicRouter = express.Router();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const MAX_OPEN = 150;

async function tenantFor(slug) {
  const t = await one(pool, 'SELECT id, name, slug, phone, timezone, waiver_text, waiver_resign_id, online_shop, stripe_account, stripe_charges_enabled FROM tenants WHERE slug = ?', [slug]);
  if (!t || !t.online_shop) throw notFound('Registration');
  t.open = connect.readyRow(t) && !(await sandbox.isSandbox(t.id));
  return t;
}

const child = z.object({ first_name: z.string().trim().min(1).max(60), last_name: z.string().trim().min(1).max(60), date_of_birth: dateStr });
const pickup = z.array(z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().max(40).optional(), relation: z.string().trim().max(40).optional() })).max(6);
const sizes = z.object({ height_in: z.number().int().min(20).max(90).optional(), weight_lb: z.number().int().min(20).max(400).optional(), boot_size: z.string().trim().max(10).optional() });
const regSchema = z.object({
  // The child's answers: ski or snowboard, a season pass (no lift ticket part), rental (with sizes), a helmet, and
  // the safety details the instructors see: allergies, medical notes, who may pick them up.
  discipline: z.enum(['ski', 'snowboard']).optional(), has_pass: z.boolean().optional(), needs_rental: z.boolean().optional(), needs_helmet: z.boolean().optional(),
  sizes: sizes.optional(), allergies: z.string().trim().max(300).optional(), medical: z.string().trim().max(500).optional(), pickup: pickup.optional(),
  program_id: z.number().int().positive(),
  term_id: z.number().int().positive().optional(), group_id: z.number().int().positive().optional(),
  bundle_id: z.number().int().positive().optional(), groups: z.array(z.object({ term_id: z.number().int().positive(), group_id: z.number().int().positive() })).max(8).optional(),
  child,
});
const regsShape = { registrations: z.array(regSchema).min(1).max(10) };
const childKey = (c) => `${c.first_name.toLowerCase()}|${c.last_name.toLowerCase()}|${c.date_of_birth}`;

/** Prices a basket of registrations: list price, sibling discounts, tax. */
async function quote(conn, t, regs, today, { paying = false } = {}) {
  const priced = [];
  for (const r of regs) {
    if (!r.term_id && !r.bundle_id) throw bad('Choose a session');
    const age = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${r.child.date_of_birth}T12:00:00Z`)) / (365.25 * 86400000));
    // once paid, a session that just closed still counts
    const p = await PS.priceRegistration(conn, t.id, { ...r, age }, today, { online: !paying, pass: PP.passResolver(conn, t.id, { child: r.child }, Boolean(r.has_pass)) });
    if ((p.program.age_min != null && age < p.program.age_min) || (p.program.age_max != null && age > p.program.age_max)) {
      throw bad(`${r.child.first_name} is ${age}. ${p.program.name} is for ages ${p.program.age_min ?? 0} to ${p.program.age_max ?? 99}.`);
    }
    priced.push({ ...p, child: childKey(r.child), childDetails: r.child, answers: r });
  }
  const seen = new Set();
  for (const p of priced) for (const x of p.parts) {
    const k = `${p.child}|${x.term.id}`;
    if (seen.has(k)) throw bad(`${p.childDetails.first_name} is in ${x.term.name} twice`);
    seen.add(k);
  }
  PS.applySiblings(priced);
  const rules = await loadRules(conn, t.id);
  const lines = priced.map((p) => ({ type: 'program', cents: p.unit_cents }));
  const { tax, taxes } = applyTax(lines, 0, rules);
  priced.forEach((p, i) => { p.tax_cents = lines[i].tax; });
  const subtotal = priced.reduce((n, p) => n + p.unit_cents, 0);
  return { priced, subtotal, tax, taxes, total: subtotal + tax };
}

const shapeQuote = (q) => ({
  lines: q.priced.map((p) => ({ name: p.name, detail: p.detail, child: `${p.childDetails.first_name} ${p.childDetails.last_name}`, list_cents: p.list_cents, sibling_cents: p.sibling_cents, unit_cents: p.unit_cents, tax_cents: p.tax_cents, step: p.step,
    lesson_cents: p.lesson_cents, ticket_cents: p.ticket_cents, rental_cents: p.rental_cents, helmet_cents: p.helmet_cents, late: p.late,
    pass: p.program.includes_ticket ? (p.parts.every((x) => x.pass_status === 'verified') ? 'found' : p.parts.some((x) => x.pass_status === 'claimed') ? 'check' : 'none') : null })),
  subtotal_cents: q.subtotal, tax_cents: q.tax, total_cents: q.total,
});

/** What is open for registration: each program with its sessions, days (places left, price now) and bundles. */
publicRouter.get('/:slug/programs', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const today = todayIn(t.timezone);
  const programs = await rows(pool, 'SELECT * FROM programs WHERE tenant_id = ? AND online = 1 AND active = 1 ORDER BY name', [t.id]);
  const types = await PP.listTypes(pool, t.id);
  const typeName = new Map(types.map((x) => [x.id, x.name])); const typeSort = new Map(types.map((x) => [x.id, x.sort]));
  const out = [];
  for (const p of programs) {
    const terms = (await rows(pool, "SELECT * FROM program_terms WHERE tenant_id = ? AND program_id = ? AND status = 'open' ORDER BY starts_on", [t.id, p.id])).filter((x) => PS.regOpen(x, today));
    if (!terms.length) continue;
    const detail = [];
    for (const x of terms) {
      const d = await PS.termDetail(pool, t.id, x.id, today);
      const groupsRaw = new Map((await rows(pool, 'SELECT id, discipline FROM program_groups WHERE tenant_id = ? AND term_id = ?', [t.id, x.id])).map((g) => [g.id, g]));
      detail.push({ ...d, ticket_cents: x.ticket_cents, rental_cents: x.rental_cents, helmet_cents: x.helmet_cents, groups: d.groups.map((g) => ({ id: g.id, weekday: g.weekday, day: g.day, discipline: (groupsRaw.get(g.id) || {}).discipline || 'any', start_time: g.start_time, end_time: g.end_time, left: g.left, price_now: g.price_now,
        dates: g.meetings.filter((m) => m.status === 'scheduled').map((m) => m.date), makeup_dates: g.meetings.filter((m) => m.status === 'standby').map((m) => m.date) })) });
    }
    const open = new Set(terms.map((x) => x.id));
    const bundles = (await rows(pool, 'SELECT id, name, price_cents, term_ids FROM program_bundles WHERE tenant_id = ? AND program_id = ? AND active = 1', [t.id, p.id]))
      .map((b) => ({ id: b.id, name: b.name, price_cents: b.price_cents, term_ids: PS.parseJson(b.term_ids, []).map(Number) })).filter((b) => b.term_ids.every((id) => open.has(id)));
    out.push({ id: p.id, name: p.name, type: typeName.get(p.type_id) || null, type_sort: typeSort.get(p.type_id) ?? 999, description: p.description, age_min: p.age_min, age_max: p.age_max, includes_ticket: Boolean(p.includes_ticket), includes_rental: Boolean(p.includes_rental),
      offers_helmet: Boolean(p.offers_helmet), disciplines: String(p.disciplines || 'ski,snowboard').split(','), snowboard_age_min: p.snowboard_age_min, meeting_place: p.meeting_place, what_to_bring: p.what_to_bring,
      policy_text: p.policy_text, cancel_days: p.cancel_days, cancel_fee_cents: p.cancel_fee_cents, allow_switch: Boolean(p.allow_switch), ask_safety: Boolean(p.ask_safety),
      sibling: p.sibling_mode === 'none' || !p.sibling_value ? null : { mode: p.sibling_mode, value: p.sibling_value }, terms: detail, bundles });
  }
  out.sort((a, b) => a.type_sort - b.type_sort || a.name.localeCompare(b.name));
  res.json({ mountain: t.name, phone: t.phone, open: t.open, today, waiver_text: t.waiver_text || null, programs: out });
});

publicRouter.post('/:slug/programs/quote', validate(z.object(regsShape)), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  res.json(shapeQuote(await quote(pool, t, req.body.registrations, todayIn(t.timezone))));
});

const contactShape = {
  contact_first_name: z.string().trim().min(1).max(60), contact_last_name: z.string().trim().min(1).max(60),
  contact_email: z.string().trim().toLowerCase().email().max(255), contact_phone: z.string().trim().min(7).max(40),
  website: z.string().max(200).optional(), // the hidden field a robot fills
};

publicRouter.post('/:slug/programs/register', validate(z.object({ ...contactShape, ...regsShape, waiver_accepted: z.boolean().optional() })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const b = req.body;
  res.set('Cache-Control', 'no-store');
  if (b.website) return res.status(202).json({ ok: true });
  // Card payments must be set up before anyone fills in the form (the page checks `open` first and says so too).
  if (!t.open) throw conflict(`${t.name} cannot take card payments online yet, so you cannot sign up here.${t.phone ? ` Please call ${t.phone} to sign up.` : ' Please sign up at the ski school desk.'}`);
  if (t.waiver_text && !b.waiver_accepted) throw bad('Please read and accept the waiver');
  const today = todayIn(t.timezone);
  const made = await tx(async (conn) => {
    await conn.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [t.id]);
    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_registrations WHERE tenant_id = ? AND status = 'awaiting_payment' AND created_at > DATE_SUB(NOW(), INTERVAL 40 MINUTE)", [t.id]);
    if (Number(n) >= MAX_OPEN) throw conflict('A lot of people are registering right now. Please try again in a few minutes.');
    const q = await quote(conn, t, b.registrations, today);
    await PS.checkRoom(conn, t.id, q.priced);
    const basket = JSON.stringify({ contact: { first_name: b.contact_first_name, last_name: b.contact_last_name }, registrations: b.registrations, total: q.total, waiver_sha: t.waiver_text ? shaOf(t.waiver_text) : null });
    for (let attempt = 0; ; attempt++) {
      const ref = reference(); const token = crypto.randomBytes(16).toString('hex');
      try {
        const [r] = await conn.query('INSERT INTO program_registrations (tenant_id, reference, view_token, contact_name, contact_email, contact_phone, basket, amount_cents, waiver_accepted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [t.id, ref, token, `${b.contact_first_name} ${b.contact_last_name}`, b.contact_email, b.contact_phone, basket, q.total, b.waiver_accepted ? 1 : 0]);
        return { id: r.insertId, ref, token, q };
      } catch (err) { if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue; throw err; }
    }
  });
  let co;
  try {
    const pay = connect.checkoutFor(await connect.payeeOrThrow(t.id), made.q.total, { tenant_id: String(t.id), registration_id: String(made.id), kind: 'program', reference: made.ref });
    co = await stripe.createCheckout({
      amountCents: made.q.total, name: `${t.name}: program registration`, description: made.q.priced.map((p) => `${p.childDetails.first_name}: ${p.name}, ${p.detail}`).join('; ').slice(0, 480),
      email: b.contact_email, reference: made.ref, ...pay, idempotencyKey: `program-${made.id}`,
      successUrl: `${baseUrl(req)}/programs/${req.params.slug}?registration=${made.token}`, cancelUrl: `${baseUrl(req)}/programs/${req.params.slug}?cancelled=${made.token}`,
    });
  } catch (err) {
    await pool.query("UPDATE program_registrations SET status = 'expired' WHERE tenant_id = ? AND id = ?", [t.id, made.id]);
    throw err;
  }
  await pool.query('UPDATE program_registrations SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [co.id, t.id, made.id]);
  res.status(201).json({ ok: true, reference: made.ref, checkout_url: co.url, amount_cents: made.q.total });
});

/** A full day: join its waitlist (or "any day works"). No payment now; the mountain is in touch when a place opens. */
publicRouter.post('/:slug/programs/waitlist', validate(z.object({ ...contactShape, program_id: z.number().int().positive(), term_id: z.number().int().positive(), group_id: z.number().int().positive(), any_day: z.boolean().optional(), child })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const b = req.body;
  if (b.website) return res.status(202).json({ ok: true });
  const today = todayIn(t.timezone);
  const out = await tx(async (conn) => {
    const reg = await PS.priceRegistration(conn, t.id, b, today, { online: true });
    const x = reg.parts[0];
    const contact = await contactPerson(conn, t.id, { first_name: b.contact_first_name, last_name: b.contact_last_name, email: b.contact_email, phone: b.contact_phone });
    const kid = await childPerson(conn, t.id, contact, b.child, today);
    const e = await PS.enroll(conn, t.id, { program: reg.program, term: x.term, group: x.group, personId: kid, guardianId: contact.id, priceCents: x.list_cents, anyDay: b.any_day });
    if (e.status === 'enrolled') throw conflict(`There is a place on ${PS.WEEKDAYS[x.group.weekday]}s: register and pay instead`);
    await audit(conn, { auth: { tenantId: t.id, userId: null } }, 'waitlist_online', 'programs', reg.program.id, { term_id: x.term.id, group_id: x.group.id });
    return { status: e.status, day: PS.WEEKDAYS[x.group.weekday], term: x.term.name };
  }); // a day with room after all is rolled back: the place is theirs by registering and paying
  res.status(201).json(out);
});

async function childPerson(conn, tenantId, contact, c, today, sizes = null) {
  const details = { first_name: c.first_name, last_name: c.last_name, date_of_birth: c.date_of_birth };
  if (sizes) for (const k of ['height_in', 'weight_lb', 'boot_size']) if (sizes[k] != null && sizes[k] !== '') details[k] = sizes[k];
  const who = await resolvePerson(conn, tenantId, { details, scope: 'none', source: 'online', fillOnly: true });
  if (!who.id) throw bad(`Could not save ${c.first_name} ${c.last_name}`);
  if (isMinor(c.date_of_birth, today) && await mayActAsGuardian(conn, tenantId, contact.id, who.id, who.created)) await addLink(conn, tenantId, contact.id, who.id, 'guardian');
  return who.id;
}

/** The registration after paying: each child, the session, the day and every date. */
async function viewOf(tenantId, token) {
  const r = await one(pool, 'SELECT * FROM program_registrations WHERE tenant_id = ? AND view_token = ?', [tenantId, token]);
  if (!r) throw notFound('Registration');
  const places = r.order_id ? await rows(pool, `SELECT e.id, e.group_id, e.status, p.first_name, p.last_name, pr.name AS program, pt.name AS term, g.weekday, tk.code AS ticket_code
    FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id JOIN programs pr ON pr.tenant_id = e.tenant_id AND pr.id = e.program_id
    JOIN program_terms pt ON pt.tenant_id = e.tenant_id AND pt.id = e.term_id JOIN program_groups g ON g.tenant_id = e.tenant_id AND g.id = e.group_id
    LEFT JOIN tickets tk ON tk.tenant_id = e.tenant_id AND tk.id = e.ticket_id
    WHERE e.tenant_id = ? AND e.order_id = ? ORDER BY p.first_name, pt.starts_on`, [tenantId, r.order_id]) : [];
  for (const p of places) {
    const m = await rows(pool, "SELECT starts_at, kind, status FROM program_sessions WHERE tenant_id = ? AND group_id = ? ORDER BY starts_at", [tenantId, p.group_id]);
    p.day = PS.WEEKDAYS[p.weekday];
    p.dates = m.filter((x) => x.status === 'scheduled').map((x) => ({ date: PS.dstr(x.starts_at), time: String(x.starts_at).slice(11, 16), makeup: x.kind !== 'regular' }));
    p.cancelled = m.filter((x) => x.status === 'cancelled').map((x) => PS.dstr(x.starts_at));
    p.makeup_reserve = m.filter((x) => x.status === 'standby').map((x) => PS.dstr(x.starts_at));
    delete p.group_id; delete p.weekday;
  }
  return { reference: r.reference, status: r.status, amount_cents: r.amount_cents, contact_name: r.contact_name, note: r.note, places };
}

publicRouter.get('/:slug/programs/registrations/:token', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  if (!/^[a-f0-9]{32}$/.test(req.params.token)) throw notFound('Registration');
  res.json({ mountain: t.name, phone: t.phone, ...(await viewOf(t.id, req.params.token)) });
});

/** Makes the places once the card payment lands. Throws an Unhonourable error when a day filled up meanwhile. */
async function fulfil(conn, tenantId, row, { paymentIntent, payee = { account: null, feeCents: 0 } }) {
  let basket; try { basket = JSON.parse(row.basket); } catch (_) { throw bad('The saved registration is unreadable'); }
  const t = await one(conn, 'SELECT id, timezone, waiver_text, waiver_resign_id, phone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  // Prices are the ones the parent saw (a step may have ended while they paid); the room is checked again now.
  const q = await quote(conn, t, basket.registrations, today, { paying: true });
  if (q.total !== row.amount_cents) {
    // An early-bird price ended while they were paying: they still get the price they paid for.
    const scale = row.amount_cents / (q.total || 1);
    for (const p of q.priced) { p.unit_cents = Math.round(p.unit_cents * scale); p.tax_cents = Math.round(p.tax_cents * scale); }
  }
  await PS.checkRoom(conn, tenantId, q.priced);
  const c = basket.contact;
  const contact = await contactPerson(conn, tenantId, { first_name: c.first_name, last_name: c.last_name, email: row.contact_email, phone: row.contact_phone });
  const waiverOk = row.waiver_accepted && !(t.waiver_resign_id && basket.waiver_sha !== (t.waiver_text ? shaOf(t.waiver_text) : null));
  const subtotal = q.priced.reduce((n, p) => n + p.unit_cents, 0); const tax = q.priced.reduce((n, p) => n + p.tax_cents, 0);
  const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, user_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, NULL, 'paid', ?, 0, ?, ?, 'online', ?)", [tenantId, contact.id, subtotal, tax, row.amount_cents, paymentIntent]);
  const orderId = o.insertId;
  for (const tx_ of q.taxes) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, orderId, tx_.name, tx_.rate_bps, tx_.amount_cents]);
  const waiverNeeded = [];
  for (const p of q.priced) {
    const kid = await childPerson(conn, tenantId, contact, p.childDetails, today, p.answers.sizes);
    const season = seasonFor(PS.dstr(p.parts[0].term.starts_on));
    if (!(await one(conn, ON_FILE, [tenantId, kid, season]))) {
      if (waiverOk && t.waiver_text) {
        await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_person_id, signed_by_name, signer_relation, text_sha, method) VALUES (?, ?, ?, 'general', ?, ?, 'guardian', ?, 'accepted_online')", [tenantId, kid, season, contact.id, row.contact_name, basket.waiver_sha]);
      } else if (t.waiver_text) waiverNeeded.push(p.childDetails.first_name);
    }
    const [it] = await conn.query("INSERT INTO order_items (tenant_id, order_id, line_kind, person_id, program_id, tier, quantity, unit_price_cents, discount_cents, tax_cents, label) VALUES (?, ?, 'program', ?, ?, 'child', 1, ?, 0, ?, ?)",
      [tenantId, orderId, kid, p.program.id, p.unit_cents, p.tax_cents, p.name.slice(0, 80)]);
    const share = p.parts.map((x) => x.list_cents - (x.discount_cents || 0));
    for (const [k, x] of p.parts.entries()) {
      if (x.pass_status === 'claimed') x.pass_status = await PP.passStatus(conn, tenantId, { personId: kid }, (await PP.termStart(conn, tenantId, x.term.id)) || PS.dstr(x.term.starts_on), true);
      const e = await PS.enroll(conn, tenantId, { program: p.program, term: x.term, group: x.group, personId: kid, guardianId: contact.id, priceCents: x.list_cents, discountCents: x.discount_cents || 0, paidCents: share[k], bundleId: p.bundle ? p.bundle.id : null, orderId, mustFit: true, details: PS.detailsOf(p, x, p.answers) });
      await PS.issueTicket(conn, tenantId, { program: p.program, group: x.group, personId: kid, orderId, enrollmentId: e.id });
    }
    await audit(conn, { auth: { tenantId, userId: null } }, 'register_online', 'programs', p.program.id, { order_id: orderId, order_item: it.insertId });
  }
  await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, 'stripe', ?, ?)",
    [tenantId, orderId, row.amount_cents, paymentIntent, payee.account || null, payee.feeCents || 0]);
  await conn.query("UPDATE program_registrations SET status = 'paid', paid_at = NOW(), order_id = ?, payment_intent = COALESCE(?, payment_intent), note = ? WHERE tenant_id = ? AND id = ?",
    [orderId, paymentIntent, waiverNeeded.length ? `Waiver still to sign: ${waiverNeeded.join(', ')}.` : null, tenantId, row.id]);
  return { orderId };
}

async function emailConfirmation(tenantId, id, base) {
  const row = await one(pool, 'SELECT * FROM program_registrations WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!row || row.status !== 'paid' || !mailer.enabled()) return false;
  const t = await one(pool, 'SELECT name, slug, phone FROM tenants WHERE id = ?', [tenantId]);
  const v = await viewOf(tenantId, row.view_token);
  const lines = v.places.flatMap((p) => [`${p.first_name} ${p.last_name}: ${p.program}, ${p.term}, ${p.day}s`,
    `  Lessons: ${p.dates.map((d) => PS.longDay(d.date)).join('; ')}`,
    ...(p.makeup_reserve.length ? [`  Makeup date if a lesson is canceled for weather: ${p.makeup_reserve.map(PS.longDay).join('; ')}`] : []),
    ...(p.ticket_code ? [`  Lift ticket: ${p.ticket_code}`] : []), '']);
  const text = [`Hi ${row.contact_name.split(' ')[0]},`, '', `Thank you for registering at ${t.name} (reference ${row.reference}, ${money(row.amount_cents)}).`, '', ...lines,
    `Your registration: ${base}/programs/${t.slug}?registration=${row.view_token}`, `Your family page (dates, weather changes, report cards): ${base}/family/${t.slug}`, '', ...(row.note ? [row.note, ''] : []), t.phone ? `Questions? Call ${t.phone}.` : ''].join('\n');
  const r = await mailer.send({ tenantId, to: row.contact_email, fromName: t.name, subject: `You are registered: ${t.name}`, text, tag: 'program-registered' });
  return r.ok;
}

/** Stripe webhook for registrations (metadata.kind === 'program'). A repeat changes nothing; a full day is refunded in full. */
async function handleWebhook(event, obj, base) {
  const tenantId = Number(obj.metadata.tenant_id); const id = Number(obj.metadata.registration_id);
  if (event.type === 'checkout.session.expired') {
    await pool.query("UPDATE program_registrations SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND (stripe_session_id = ? OR stripe_session_id IS NULL)", [tenantId, id, obj.id]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  let failed = null; let stray = null; let out;
  try {
    out = await tx(async (conn) => {
      failed = null; stray = null;
      const row = await one(conn, 'SELECT * FROM program_registrations WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
      if (!row) { logFailure({ job: 'stripe_webhook', tenant: tenantId, message: `a paid card page names program registration ${id}, which is not on file` }); return { ignored: true }; }
      if (row.payment_intent === String(obj.payment_intent) || await cardrefund.returned(conn, tenantId, obj.payment_intent)) return { duplicate: true }; // a repeat
      // Only a registration still waiting (or let go while the parent paid), for its own card page; with no page saved
      // (that save failed), the payment is accepted when the amount is right. Anything else goes back in full.
      if (!['awaiting_payment', 'expired'].includes(row.status)) { stray = 'the registration was already settled'; return { problem: true }; }
      if (row.stripe_session_id && row.stripe_session_id !== obj.id) { stray = 'it was not the card page saved for this registration'; return { problem: true }; }
      if (Number(obj.amount_total) !== row.amount_cents) { failed = 'the amount did not match'; return { problem: true }; }
      if (!row.stripe_session_id) await conn.query('UPDATE program_registrations SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [obj.id, tenantId, row.id]);
      try { return { ...(await fulfil(conn, tenantId, row, { paymentIntent: obj.payment_intent, payee: connect.paidTo(event) })), ok: true }; } catch (err) {
        if (err.status && err.status < 500) throw new Unhonourable(err.message);
        throw err;
      }
    });
  } catch (err) {
    if (!(err instanceof Unhonourable)) throw err;
    failed = err.message; out = { problem: true };
  }
  if (stray) return cardrefund.returnStray({ tenantId, kind: 'program', rowId: id, obj, account: event.account || null, why: stray });
  if (failed) {
    // Written down as owed with the registration's new state in one step, then sent; retried daily if Stripe is slow.
    const owed = await tx(async (conn) => {
      const [u] = await conn.query("UPDATE program_registrations SET status = 'refunded', payment_intent = ?, note = ? WHERE tenant_id = ? AND id = ? AND status IN ('awaiting_payment','expired')", [obj.payment_intent || null, `Refunded automatically: ${failed}`.slice(0, 300), tenantId, id]);
      if (u.affectedRows !== 1) return null;
      return cardrefund.oweReturn(conn, { tenantId, kind: 'program', rowId: id, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account: event.account || null, reason: failed });
    });
    if (owed) await cardrefund.sendReturn(owed);
    return { refunded: true };
  }
  if (out.ok) await emailConfirmation(tenantId, id, base).catch(() => {});
  return { ok: Boolean(out.ok), duplicate: out.duplicate, ignored: out.ignored };
}

module.exports = { publicRouter, handleWebhook, quote, fulfil, viewOf };
