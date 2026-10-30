'use strict';
// Auto-renew and the pass waitlist (Track FAIR).
// Auto-renew: a pass holder says yes from the household account (ACCOUNT shows the switch and calls the guests route).
// A week before the mountain's renewal day they get a reminder with the price and an easy way to turn it off; on the day
// their saved card (on the mountain's own Stripe account) is charged at the guaranteed price: the lower of what they paid
// last time and this season's price (or this season's price, as the mountain sets), and the new pass is made.
// Waitlist: a manager can cap how many of a pass are sold. When a place opens (a pass refunded, the cap raised), the
// first guest waiting gets an offer by email, held 48 hours, then the next. Like the lesson waitlist.
const { pool, tx, rows, one } = require('../db');
const stripe = require('./stripe');
const connect = require('./connect');
const G = require('./guestsettings');
const F = require('./fairprice');
const PP = require('./paymentplans');
const { audit } = require('./audit');
const { money, dayText } = require('./format');
const { addDays, todayIn, seasonFor, newCode } = require('./util');
const { conflict, notFound } = require('./errors');

const OFFER_HOURS = 48;
const dstr = (d) => String(d || '').slice(0, 10);

// ---------------------------------------------------------------- auto-renew
/** The pass a person held most recently (this season or last), or null. */
async function lastPass(db, tenantId, personId, today) {
  return one(db, `SELECT k.id, k.product_id, k.valid_from, k.valid_to, k.order_item_id, p.name, i.unit_price_cents, i.tier FROM tickets k JOIN products p ON p.tenant_id = k.tenant_id AND p.id = k.product_id
    JOIN order_items i ON i.tenant_id = k.tenant_id AND i.id = k.order_item_id
    WHERE k.tenant_id = ? AND k.person_id = ? AND p.kind = 'season_pass' AND k.status <> 'void' AND k.valid_to >= ? ORDER BY k.valid_from DESC LIMIT 1`, [tenantId, personId, addDays(today, -400)]);
}
/** The guaranteed price for a renewal (before tax): { cents, last_cents, now_cents, rule }. */
async function renewPrice(db, tenantId, r, day) {
  const f = await F.settings(db, tenantId);
  const from = r.from_ticket_id ? await one(db, 'SELECT i.unit_price_cents, i.tier FROM tickets k JOIN order_items i ON i.tenant_id = k.tenant_id AND i.id = k.order_item_id WHERE k.tenant_id = ? AND k.id = ?', [tenantId, r.from_ticket_id]) : null;
  const tier = (from && from.tier) || 'adult';
  let now = null;
  try { now = (await require('./pricing').unitPrice(db, tenantId, r.product_id, tier, day)).cents; } catch (_) { now = null; }
  const last = from ? Number(from.unit_price_cents) : null;
  const cents = f.renew_rule === 'current' || last === null ? now : now === null ? last : Math.min(last, now);
  return { cents, last_cents: last, now_cents: now, rule: f.renew_rule, tier };
}
/** The day a renewed pass starts: the season's opening day when it is still ahead, else the renewal day. */
const startOf = (s, f) => (s.season_opens_on && s.season_opens_on > f.renew_on ? s.season_opens_on : f.renew_on);

/** For the household account: each person's pass, whether it renews, the price and the card. personIds: the household. */
async function household(db, tenantId, personIds) {
  const s = await G.get(db, tenantId); const f = await F.settings(db, tenantId);
  const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const out = [];
  for (const id of personIds) {
    const pass = await lastPass(db, tenantId, id, today);
    if (!pass) continue;
    const r = await one(db, 'SELECT * FROM fair_renewals WHERE tenant_id = ? AND person_id = ? AND product_id = ?', [tenantId, id, pass.product_id]);
    const person = await one(db, 'SELECT first_name, last_name FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id]);
    const card = r && r.card_id ? await one(db, 'SELECT brand, last4, payment_method FROM fair_cards WHERE id = ?', [r.card_id]) : null;
    const price = f.renew_on ? await renewPrice(db, tenantId, { product_id: pass.product_id, from_ticket_id: pass.id }, startOf(s, f)) : null;
    out.push({ person_id: id, name: `${person.first_name} ${person.last_name}`, product_id: pass.product_id, pass: pass.name, valid_to: dstr(pass.valid_to), on: Boolean(r && r.status === 'on'),
      renews_on: f.renew_on, price_cents: price ? price.cents : null, card: card && card.payment_method ? { brand: card.brand, last4: card.last4 } : null, renewed_for: r ? r.renewed_for : null });
  }
  return { available: Boolean(Number(s.autorenew_on)), renews_on: f.renew_on, people: out };
}
/**
 * Turns auto-renew on or off for one person's pass. Returns { on, needs_card, link } where link is the guest's private
 * renewal page (add a card there). by: the req for the audit.
 */
async function setRenew(req, tenantId, { personId, on, email = null }, base) {
  const s = await G.get(pool, tenantId);
  if (on && !Number(s.autorenew_on)) throw conflict('Auto-renew is not offered at this mountain');
  const t = await one(pool, 'SELECT slug, timezone FROM tenants WHERE id = ?', [tenantId]);
  const pass = await lastPass(pool, tenantId, personId, todayIn(t.timezone));
  if (!pass) throw notFound('Season pass');
  await pool.query(`INSERT INTO fair_renewals (tenant_id, person_id, product_id, from_ticket_id, email, status) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE status = VALUES(status), from_ticket_id = VALUES(from_ticket_id), email = COALESCE(VALUES(email), email)`, [tenantId, personId, pass.product_id, pass.id, email, on ? 'on' : 'off']);
  const r = await one(pool, 'SELECT * FROM fair_renewals WHERE tenant_id = ? AND person_id = ? AND product_id = ?', [tenantId, personId, pass.product_id]);
  if (!r.card_id) {
    // A card saved with a payment plan for this person is used, so a plan holder does not add it twice.
    const c = await one(pool, 'SELECT id FROM fair_cards WHERE tenant_id = ? AND person_id = ? AND (payment_method IS NOT NULL OR payment_intent IS NOT NULL) ORDER BY id DESC LIMIT 1', [tenantId, personId]);
    if (c) { await pool.query('UPDATE fair_renewals SET card_id = ? WHERE id = ?', [c.id, r.id]); r.card_id = c.id; }
  }
  await audit(pool, req, on ? 'autorenew_on' : 'autorenew_off', 'fair_renewals', r.id, { person_id: personId, product_id: pass.product_id });
  const link = `${F.baseOf(base)}/renew/${t.slug}/${await F.newLink(pool, tenantId, 'renew', r.id, { days: 400 })}`;
  return { on: Boolean(on), needs_card: Boolean(on && !r.card_id), link };
}
async function renewView(db, l) {
  const r = await one(db, 'SELECT * FROM fair_renewals WHERE tenant_id = ? AND id = ?', [l.tenant_id, l.ref_id]);
  if (!r) throw notFound('Renewal');
  const s = await G.get(db, l.tenant_id); const f = await F.settings(db, l.tenant_id);
  const p = await one(db, 'SELECT first_name FROM people WHERE tenant_id = ? AND id = ?', [l.tenant_id, r.person_id]);
  const prod = await one(db, 'SELECT name FROM products WHERE tenant_id = ? AND id = ?', [l.tenant_id, r.product_id]);
  const card = r.card_id ? await one(db, 'SELECT brand, last4, payment_method, payment_intent FROM fair_cards WHERE id = ?', [r.card_id]) : null;
  const price = f.renew_on ? await renewPrice(db, l.tenant_id, r, startOf(s, f)) : null;
  return { mountain: l.mountain, phone: l.phone, first_name: p ? p.first_name : null, pass: prod ? prod.name : 'Season pass', on: r.status === 'on', available: Boolean(Number(s.autorenew_on)),
    renews_on: f.renew_on, price_cents: price ? price.cents : null, last_cents: price ? price.last_cents : null, renewed_for: r.renewed_for, last_error: r.last_error,
    card: card && (card.payment_method || card.payment_intent) ? { brand: card.brand, last4: card.last4 } : null };
}
async function renewSwitch(l, on) {
  const r = await one(pool, 'SELECT * FROM fair_renewals WHERE tenant_id = ? AND id = ?', [l.tenant_id, l.ref_id]);
  await setRenew(F.system(l.tenant_id), l.tenant_id, { personId: r.person_id, on }, null);
  return renewView(pool, l);
}
async function renewCardDone(l, sessionId) {
  const r = await one(pool, 'SELECT * FROM fair_renewals WHERE tenant_id = ? AND id = ?', [l.tenant_id, l.ref_id]);
  const id = await PP.cardDone(l.tenant_id, r.card_id, sessionId, { kind: 'renew', refId: r.id, email: r.email, personId: r.person_id });
  await pool.query('UPDATE fair_renewals SET card_id = ?, last_error = NULL WHERE id = ?', [id, r.id]);
  await audit(pool, F.system(l.tenant_id), 'autorenew_card', 'fair_renewals', r.id, {});
  return renewView(pool, l);
}

/** Charges one renewal and makes the new pass. Returns 'renewed', 'failed' or 'skipped'. */
async function renewOne(tenantId, r, s, f, season, base) {
  const day = startOf(s, f);
  const price = await renewPrice(pool, tenantId, r, day);
  if (price.cents === null) return 'skipped';
  const has = await one(pool, `SELECT k.id FROM tickets k WHERE k.tenant_id = ? AND k.person_id = ? AND k.product_id = ? AND k.status <> 'void' AND k.valid_from >= ? LIMIT 1`, [tenantId, r.person_id, r.product_id, day]);
  if (has) { await pool.query('UPDATE fair_renewals SET renewed_for = ? WHERE id = ?', [season, r.id]); return 'skipped'; }
  const { loadRules, applyTax } = require('./tax');
  const priced = [{ type: 'ticket', cents: price.cents }];
  const { tax, taxes } = applyTax(priced, 0, await loadRules(pool, tenantId));
  const total = price.cents + tax;
  let card = r.card_id ? await one(pool, 'SELECT * FROM fair_cards WHERE id = ?', [r.card_id]) : null;
  let error = null; let ref = null; let fee = 0;
  try {
    if (!card) throw new Error('No card saved');
    if (!card.payment_method && card.payment_intent) {
      const got = await stripe.get(`/v1/payment_intents/${encodeURIComponent(card.payment_intent)}`, { account: card.account || null });
      await pool.query('UPDATE fair_cards SET payment_method = ?, customer = COALESCE(customer, ?) WHERE id = ?', [got.payment_method || null, got.customer || null, card.id]);
      card = { ...card, payment_method: got.payment_method, customer: card.customer || got.customer };
    }
    if (!card.payment_method || !card.customer) throw new Error('No card saved');
    const p = await connect.payee(tenantId);
    fee = p.ok && (p.account || null) === (card.account || null) ? connect.feeFor(p, total) : 0;
    const res = await stripe.tryCall('/v1/payment_intents', { amount: total, currency: 'usd', customer: card.customer, payment_method: card.payment_method, payment_method_types: ['card'], off_session: true, confirm: true,
      description: `Season pass renewal ${season}`, metadata: { tenant_id: String(tenantId), kind: 'pass_renewal', renewal_id: String(r.id) }, ...(fee ? { application_fee_amount: fee } : {}) },
    { account: card.account || null, idempotencyKey: `renew-${r.id}-${season}` });
    if (!res.ok) error = res.error; else if (res.json.status !== 'succeeded') error = 'The bank asked the guest to confirm this payment'; else ref = res.json.id;
  } catch (err) { error = err.message; }
  const t = await one(pool, 'SELECT name, slug FROM tenants WHERE id = ?', [tenantId]);
  const who = await one(pool, 'SELECT first_name, email FROM people WHERE tenant_id = ? AND id = ?', [tenantId, r.person_id]);
  const email = r.email || (who && who.email);
  const link = async () => `${F.baseOf(base)}/renew/${t.slug}/${await F.newLink(pool, tenantId, 'renew', r.id, { days: 60 })}`;
  if (!ref) {
    await pool.query('UPDATE fair_renewals SET last_error = ? WHERE id = ?', [String(error).slice(0, 250), r.id]);
    await audit(pool, F.system(tenantId), 'autorenew_failed', 'fair_renewals', r.id, { error: String(error).slice(0, 200) });
    if (email) await F.mail(tenantId, email, `Your pass did not renew yet at ${t.name}`, [`Hi ${who ? who.first_name : 'there'},`, '', `We tried to renew your season pass for ${money(total)} and the card did not go through.`, 'Add or update your card here and we will try again tomorrow:', await link()], 'autorenew-failed').catch(() => {});
    return 'failed';
  }
  const prod = await one(pool, 'SELECT * FROM products WHERE tenant_id = ? AND id = ?', [tenantId, r.product_id]);
  const code = newCode();
  const validTo = addDays(day, Math.max(Number(prod.valid_days), 1) - 1);
  await tx(async (conn) => {
    const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, 'paid', ?, ?, ?, 'online', ?)", [tenantId, r.person_id, price.cents, tax, total, ref]);
    for (const x of taxes) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, o.insertId, x.name, x.rate_bps, x.amount_cents]);
    const [i] = await conn.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, tax_cents, label) VALUES (?, ?, ?, 'ticket', ?, ?, 1, ?, ?, ?, 'Renewed automatically')",
      [tenantId, o.insertId, r.product_id, r.person_id, price.tier, price.cents, day, tax]);
    await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, i.insertId, r.person_id, r.product_id, code, day, validTo, prod.uses ?? null]);
    await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, card_brand, card_last4, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, ?, ?, 'stripe', ?, ?)",
      [tenantId, o.insertId, total, ref, card.brand || null, card.last4 || null, card.account || null, fee]);
    await conn.query('UPDATE fair_renewals SET renewed_for = ?, new_order_id = ?, last_error = NULL WHERE id = ?', [season, o.insertId, r.id]);
    await audit(conn, F.system(tenantId), 'autorenew_charged', 'orders', o.insertId, { renewal_id: r.id, cents: total, price_cents: price.cents, last_cents: price.last_cents, now_cents: price.now_cents });
  });
  if (email) await F.mail(tenantId, email, `Your ${prod.name} is renewed at ${t.name}`, [`Hi ${who ? who.first_name : 'there'},`, '', `Your ${prod.name} for ${season} is renewed. We charged ${money(total)} to your card${card.last4 ? ` ending ${card.last4}` : ''}.`,
    price.last_cents !== null && price.now_cents !== null && price.cents < price.now_cents ? `That is last season's price, ${money(price.now_cents - price.cents)} less than this season's.` : '', '', `Your pass: ${code}`, `Good from ${dayText(day)} to ${dayText(validTo)}.`], 'autorenew-done').catch(() => {});
  return 'renewed';
}

/** Daily: reminders a week before the renewal day, and renewals on the day (and for two weeks after, for a new card). */
async function daily(tenantId, base) {
  const s = await G.get(pool, tenantId); const f = await F.settings(pool, tenantId);
  if (!Number(s.autorenew_on) || !f.renew_on) return { reminded: 0, renewed: 0 };
  const t = await one(pool, 'SELECT name, slug, timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const season = seasonFor(startOf(s, f));
  const out = { reminded: 0, renewed: 0, failed: 0 };
  if (today >= addDays(f.renew_on, -7) && today < f.renew_on) {
    const due = await rows(pool, "SELECT * FROM fair_renewals WHERE tenant_id = ? AND status = 'on' AND (reminded_for IS NULL OR reminded_for <> ?)", [tenantId, season]);
    for (const r of due) {
      const [u] = await pool.query("UPDATE fair_renewals SET reminded_for = ? WHERE id = ? AND (reminded_for IS NULL OR reminded_for <> ?)", [season, r.id, season]);
      if (!u.affectedRows) continue;
      const who = await one(pool, 'SELECT first_name, email FROM people WHERE tenant_id = ? AND id = ?', [tenantId, r.person_id]);
      const email = r.email || (who && who.email);
      const price = await renewPrice(pool, tenantId, r, startOf(s, f));
      const card = r.card_id ? await one(pool, 'SELECT last4 FROM fair_cards WHERE id = ?', [r.card_id]) : null;
      const link = `${F.baseOf(base)}/renew/${t.slug}/${await F.newLink(pool, tenantId, 'renew', r.id, { days: 60 })}`;
      if (email) await F.mail(tenantId, email, `Your season pass renews on ${dayText(f.renew_on)}`, [`Hi ${who ? who.first_name : 'there'},`, '',
        `Your season pass at ${t.name} renews automatically on ${dayText(f.renew_on)} for ${money(price.cents)} plus any tax.`,
        card ? `We will charge your card${card.last4 ? ` ending ${card.last4}` : ''}.` : 'We do not have a card for it yet. Please add one:', '', 'To change your card or turn auto-renew off:', link], 'autorenew-reminder').catch(() => {});
      out.reminded += 1;
    }
  }
  if (today >= f.renew_on && today <= addDays(f.renew_on, 14)) {
    const due = await rows(pool, "SELECT * FROM fair_renewals WHERE tenant_id = ? AND status = 'on' AND (renewed_for IS NULL OR renewed_for <> ?)", [tenantId, season]);
    for (const r of due) { const x = await renewOne(tenantId, r, s, f, season, base); if (x === 'renewed') out.renewed += 1; else if (x === 'failed') out.failed += 1; }
  }
  return out;
}
async function renewalList(db, tenantId) {
  return (await rows(db, `SELECT r.id, r.status, r.reminded_for, r.renewed_for, r.last_error, r.updated_at, p.first_name, p.last_name, pr.name AS pass, c.last4 FROM fair_renewals r
    JOIN people p ON p.tenant_id = r.tenant_id AND p.id = r.person_id JOIN products pr ON pr.tenant_id = r.tenant_id AND pr.id = r.product_id LEFT JOIN fair_cards c ON c.id = r.card_id
    WHERE r.tenant_id = ? ORDER BY r.status = 'on' DESC, p.last_name, p.first_name LIMIT 500`, [tenantId])).map((r) => ({ ...r, name: `${r.first_name} ${r.last_name}`, has_card: Boolean(r.last4) }));
}

// ---------------------------------------------------------------- the waitlist for capped passes
/** Places for a capped pass: { cap, sold, held, left } (left Infinity when there is no cap). email: whose offer counts as theirs. */
async function passPlaces(db, tenantId, productId, { email = null } = {}) {
  const c = await one(db, 'SELECT cap FROM fair_products WHERE tenant_id = ? AND product_id = ?', [tenantId, productId]);
  if (!c || c.cap === null) return { cap: null, sold: null, held: 0, left: Infinity, mine: false };
  const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const sold = await one(db, "SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND product_id = ? AND status <> 'void' AND valid_to >= ?", [tenantId, productId, todayIn(t.timezone)]);
  const held = await rows(db, "SELECT email FROM fair_waitlist WHERE tenant_id = ? AND product_id = ? AND status = 'offered' AND offer_expires_at > UTC_TIMESTAMP()", [tenantId, productId]);
  const mine = Boolean(email && held.some((h) => h.email === String(email).toLowerCase()));
  return { cap: Number(c.cap), sold: Number(sold.n), held: held.length, left: Math.max(Number(c.cap) - Number(sold.n) - held.length + (mine ? 1 : 0), 0), mine };
}
/** A guest joins the waitlist. The answer is the same whether or not they were already on it. */
async function join(tenantId, productId, { first_name, last_name, email }) {
  const c = await one(pool, 'SELECT cap FROM fair_products WHERE tenant_id = ? AND product_id = ? AND cap IS NOT NULL', [tenantId, productId]);
  if (!c) throw notFound('Waitlist');
  await pool.query('INSERT IGNORE INTO fair_waitlist (tenant_id, product_id, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)', [tenantId, productId, first_name, last_name, String(email).toLowerCase()]);
}
/** The job: offers that ran out or were taken, then offers to the next guests while places are open. */
async function waitlistTick(tenantId, base) {
  const out = { offered: 0, expired: 0, taken: 0 };
  const t = await one(pool, 'SELECT name, slug FROM tenants WHERE id = ?', [tenantId]);
  // An offer is taken when a pass of that product was sold to someone with that email after the offer went out.
  const [tk] = await pool.query(`UPDATE fair_waitlist w SET w.status = 'taken' WHERE w.tenant_id = ? AND w.status = 'offered' AND EXISTS (
      SELECT 1 FROM tickets k JOIN order_items i ON i.tenant_id = k.tenant_id AND i.id = k.order_item_id JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
        LEFT JOIN people hp ON hp.tenant_id = k.tenant_id AND hp.id = k.person_id LEFT JOIN people bp ON bp.tenant_id = o.tenant_id AND bp.id = o.person_id
      WHERE k.tenant_id = w.tenant_id AND k.product_id = w.product_id AND k.status <> 'void' AND o.created_at >= w.offered_at AND (hp.email = w.email OR bp.email = w.email))`, [tenantId]);
  out.taken = tk.affectedRows;
  const [ex] = await pool.query("UPDATE fair_waitlist SET status = 'expired' WHERE tenant_id = ? AND status = 'offered' AND offer_expires_at <= UTC_TIMESTAMP()", [tenantId]);
  out.expired = ex.affectedRows;
  const capped = await rows(pool, "SELECT f.product_id, p.name FROM fair_products f JOIN products p ON p.tenant_id = f.tenant_id AND p.id = f.product_id WHERE f.tenant_id = ? AND f.cap IS NOT NULL", [tenantId]);
  for (const c of capped) {
    let places = await passPlaces(pool, tenantId, c.product_id);
    while (places.left > 0) {
      const next = await one(pool, "SELECT * FROM fair_waitlist WHERE tenant_id = ? AND product_id = ? AND status = 'waiting' ORDER BY id LIMIT 1", [tenantId, c.product_id]);
      if (!next) break;
      const [u] = await pool.query("UPDATE fair_waitlist SET status = 'offered', offered_at = UTC_TIMESTAMP(), offer_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR) WHERE id = ? AND status = 'waiting'", [OFFER_HOURS, next.id]);
      if (!u.affectedRows) continue;
      const link = `${F.baseOf(base)}/pass-offer/${t.slug}/${await F.newLink(pool, tenantId, 'offer', next.id, { days: 3 })}`;
      await F.mail(tenantId, next.email, `A ${c.name} is open for you at ${t.name}`, [`Hi ${next.first_name},`, '', `Good news: a place opened for the ${c.name}, and you are next on the waitlist.`, `It is held for you for ${OFFER_HOURS} hours. Buy it here:`, link, '', 'If you do not want it, you can say so on that page and we will offer it to the next person.'], 'pass-offer').catch(() => {});
      await audit(pool, F.system(tenantId), 'pass_offer', 'fair_waitlist', next.id, { product_id: c.product_id });
      out.offered += 1;
      places = await passPlaces(pool, tenantId, c.product_id);
    }
  }
  return out;
}
async function offerView(db, l) {
  const w = await one(db, 'SELECT w.*, p.name FROM fair_waitlist w JOIN products p ON p.tenant_id = w.tenant_id AND p.id = w.product_id WHERE w.tenant_id = ? AND w.id = ?', [l.tenant_id, l.ref_id]);
  if (!w) throw notFound('Offer');
  const live = w.status === 'offered' && new Date(`${String(w.offer_expires_at).replace(' ', 'T')}Z`) > new Date();
  return { mountain: l.mountain, phone: l.phone, first_name: w.first_name, pass: w.name, product_id: w.product_id, status: live ? 'offered' : w.status === 'offered' ? 'expired' : w.status,
    expires_at: w.offer_expires_at ? `${String(w.offer_expires_at).replace(' ', 'T')}Z` : null, shop_url: `/shop/${encodeURIComponent(l.slug)}?pass=${w.product_id}` };
}
async function offerDecline(l) {
  await pool.query("UPDATE fair_waitlist SET status = 'left' WHERE tenant_id = ? AND id = ? AND status IN ('offered','waiting')", [l.tenant_id, l.ref_id]);
  await audit(pool, F.system(l.tenant_id), 'pass_offer_declined', 'fair_waitlist', l.ref_id, {});
  return offerView(pool, l);
}
async function waitlistList(db, tenantId) {
  const caps = await rows(db, `SELECT p.id, p.name, p.kind, f.cap, f.plan_ok FROM products p LEFT JOIN fair_products f ON f.tenant_id = p.tenant_id AND f.product_id = p.id
    WHERE p.tenant_id = ? AND p.active = 1 AND p.kind IN ('season_pass','multi_day','punch_card') ORDER BY p.kind, p.name`, [tenantId]);
  const out = [];
  for (const c of caps) {
    const places = await passPlaces(db, tenantId, c.id);
    const people = c.cap !== null ? await rows(db, "SELECT id, first_name, last_name, email, status, offered_at, offer_expires_at, created_at FROM fair_waitlist WHERE tenant_id = ? AND product_id = ? AND status IN ('waiting','offered') ORDER BY id", [tenantId, c.id]) : [];
    out.push({ product_id: c.id, name: c.name, kind: c.kind, cap: c.cap === null ? null : Number(c.cap), plan_ok: c.kind === 'season_pass' || Boolean(Number(c.plan_ok)), sold: places.sold, left: places.left === Infinity ? null : places.left, waiting: people });
  }
  return out;
}

module.exports = { lastPass, renewPrice, household, setRenew, renewView, renewSwitch, renewCardDone, renewOne, daily, renewalList, passPlaces, join, waitlistTick, offerView, offerDecline, waitlistList, OFFER_HOURS };
