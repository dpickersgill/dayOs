'use strict';

// The fitting side of the rental shop: a paid rental waiting to be fitted (status to_fit), the renter's details the binding
// setting is chosen from, the renter's signed confirmation of those details, the binding suggestion from the shop's own
// chart, and handing the gear out. Shared by the Rentals screen, Sell (checkout), the online shop and the group hand-out.
const { rows, one } = require('../db');
const { z, todayIn, addDays, seasonFor, dayRange, nowIn } = require('./util');
const { notFound, conflict, bad, forbidden } = require('./errors');
const { ON_FILE } = require('./waivers');
const R = require('./rentals');

/** Ability from three plain questions. The type is stored; staff and guests see the words. */
const ABILITY = { 1: 'Cautious', 2: 'Moderate', 3: 'Aggressive' };
const ABILITY_HELP = {
  1: 'Skis slowly and carefully, likes easy runs',
  2: 'Skis at different speeds on varied terrain',
  3: 'Skis fast and aggressively, steep terrain',
};
// Charts are often written with Roman numerals; both mean the same type.
const TYPE_ALIASES = { 1: ['1', 'I'], 2: ['2', 'II'], 3: ['3', 'III'] };
const typeOf = (t) => {
  const s = String(t || '').trim().toUpperCase();
  for (const [k, v] of Object.entries(TYPE_ALIASES)) if (v.includes(s)) return k;
  return null;
};

const STAGES = ['form', 'boots', 'tech', 'door'];
const nextStage = (s) => { const i = STAGES.indexOf(s); return i < 0 || i === STAGES.length - 1 ? null : STAGES[i + 1]; };
/** Gear that needs a binding set, so the renter signs that their details are true before it goes out. */
const NEEDS_SIGNOFF = ['ski', 'snowboard'];

const FIT_DEFAULTS = { layout: 'counter', closing_time: '16:30:00', require_signoff: 1, deposit_mode: 'note', season_return_md: '04-15', signoff_valid_days: 1 };

/** The shop's settings with the round 2 fields filled in when the shop has never saved settings. */
async function fitSettings(conn, tenantId) {
  const s = { ...FIT_DEFAULTS, ...(await R.getSettings(conn, tenantId)) };
  for (const [k, v] of Object.entries(FIT_DEFAULTS)) if (s[k] === undefined || s[k] === null) s[k] = v;
  s.require_signoff = Boolean(Number(s.require_signoff));
  s.signoff_valid_days = Number(s.signoff_valid_days) || 1;
  s.closing_time = String(s.closing_time).slice(0, 5);
  return s;
}

/** When the gear is due back: the last day at closing time, or for a season rental the season return date at closing time. */
function dueFor(settings, kind, validOn, days = 1) {
  const close = `${String(settings.closing_time || '16:30').slice(0, 5)}:00`;
  if (kind === 'season') {
    const md = /^\d{2}-\d{2}$/.test(String(settings.season_return_md)) ? settings.season_return_md : '04-15';
    let y = Number(validOn.slice(0, 4));
    if (`${y}-${md}` < validOn) y += 1;
    return `${y}-${md} ${close}`;
  }
  return `${addDays(validOn, Math.max(Number(days) || 1, 1) - 1)} ${close}`;
}

const ageOn = (dob, day) => {
  if (!dob) return null;
  const d = String(dob).slice(0, 10); const t = String(day).slice(0, 10);
  let a = Number(t.slice(0, 4)) - Number(d.slice(0, 4));
  if (t.slice(5) < d.slice(5)) a -= 1;
  return a;
};

// ---- the renter's details --------------------------------------------------------------------
const detailsSchema = z.object({
  height_in: z.number().int().min(20).max(100).nullable().optional(),
  weight_lb: z.number().int().min(20).max(500).nullable().optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  boot_size: z.string().max(10).nullable().optional(),
  boot_sole_mm: z.number().int().min(150).max(400).nullable().optional(),
  stance: z.enum(['regular', 'goofy']).nullable().optional(),
  skier_type: z.enum(['1', '2', '3']).nullable().optional(),
});
// What the binding setting depends on: a signoff counts only while these still match the card.
const MATCH_KEYS = ['height_in', 'weight_lb', 'date_of_birth', 'boot_sole_mm', 'skier_type'];

/** The details on file for one person: people for the body, rental_profiles for the boot sole length. */
async function detailsOf(conn, tenantId, personId) {
  const p = await one(conn, 'SELECT id, first_name, last_name, date_of_birth, height_in, weight_lb, boot_size, stance, skier_type, photo, phone, email FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  if (!p) throw notFound('Person');
  const rp = await one(conn, 'SELECT skier_type, boot_sole_mm, shoe_size, stance, helmet_size, notes FROM rental_profiles WHERE tenant_id = ? AND person_id = ?', [tenantId, personId]);
  return {
    person: p,
    details: {
      height_in: p.height_in ?? null, weight_lb: p.weight_lb ?? null, date_of_birth: p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : null,
      boot_size: p.boot_size ?? null, boot_sole_mm: rp && rp.boot_sole_mm ? Number(rp.boot_sole_mm) : null,
      stance: p.stance || (rp && rp.stance) || null, skier_type: typeOf(p.skier_type || (rp && rp.skier_type)),
    },
    profile: rp || null,
  };
}

/** Saves the card's details to the person and their rental profile. Only the fields given are changed. */
async function saveDetails(conn, tenantId, personId, d) {
  const pCols = ['height_in', 'weight_lb', 'date_of_birth', 'boot_size', 'stance', 'skier_type'].filter((k) => d[k] !== undefined);
  if (pCols.length) await conn.query(`UPDATE people SET ${pCols.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...pCols.map((k) => d[k]), tenantId, personId]);
  const rCols = ['boot_sole_mm', 'stance', 'skier_type'].filter((k) => d[k] !== undefined);
  if (rCols.length) {
    await conn.query(`INSERT INTO rental_profiles (tenant_id, person_id, ${rCols.join(', ')}) VALUES (?, ?, ${rCols.map(() => '?').join(', ')})
      ON DUPLICATE KEY UPDATE ${rCols.map((k) => `${k} = VALUES(${k})`).join(', ')}`, [tenantId, personId, ...rCols.map((k) => d[k])]);
  }
}

/** Fields whose value differs between what was signed and the card now (blank on either side is not a difference). */
function mismatch(signed, now) {
  if (!now) return [];
  const norm = (k, v) => (v === null || v === undefined || v === '' ? null : k === 'skier_type' ? typeOf(v) : k === 'date_of_birth' ? String(v).slice(0, 10) : String(Number(v)));
  return MATCH_KEYS.filter((k) => { const a = norm(k, signed && signed[k]); const b = norm(k, now[k]); return a !== null && b !== null && a !== b; });
}

/**
 * The renter's signed confirmation that still counts: signed within the shop's signoff_valid_days (on the mountain's
 * clock), at the counter or on the guest rental form, with details that match the card now. Returns
 * { signoff, mismatch: [] } for the newest one in the window, or null when none was signed in the window. A signoff at
 * the counter counts from the day it was signed; a form signoff counts for the rental day on its form.
 */
async function validSignoff(conn, tenantId, personId, details = null, { settings = null, timeZone = null, forDay = null } = {}) {
  const s = settings || await fitSettings(conn, tenantId);
  const tz = timeZone || (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  // forDay: the rental day being checked (a group page the night before looks at the group's day). Default today.
  const today = forDay && forDay > todayIn(tz) ? forDay : todayIn(tz);
  const fromDay = addDays(today, -(Math.max(s.signoff_valid_days, 1) - 1));
  const from = dayRange(tz, fromDay)[0];
  // A guest rental form is often filled in the night before: it counts for the day it was filled in for.
  const list = await rows(conn, `SELECT s.id, s.person_id, s.contract_id, s.form_id, s.signer_name, s.signer_relation, s.details, s.via, s.signed_at FROM rental_signoffs s
    LEFT JOIN rental_forms f ON f.tenant_id = s.tenant_id AND f.id = s.form_id
    WHERE s.tenant_id = ? AND s.person_id = ? AND (s.signed_at >= ? OR (s.via = 'form' AND f.rental_on BETWEEN ? AND ?)) ORDER BY s.signed_at DESC, s.id DESC LIMIT 5`, [tenantId, personId, from, fromDay, today]);
  if (!list.length) return null;
  for (const r of list) { if (typeof r.details === 'string') { try { r.details = JSON.parse(r.details); } catch (_) { r.details = {}; } } }
  const ok = list.find((r) => !mismatch(r.details, details).length);
  return ok ? { signoff: ok, mismatch: [] } : { signoff: list[0], mismatch: mismatch(list[0].details, details) };
}

const signoffSchema = z.object({
  signer_name: z.string().trim().min(2).max(120),
  signer_relation: z.enum(['self', 'parent', 'guardian']).default('self'),
  signature: z.string().max(90000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/, 'Sign in the box'),
  details: detailsSchema,
});

/** Writes the renter's signed confirmation. Under 18 needs a parent or guardian signing. */
async function writeSignoff(conn, tenantId, personId, s, { contractId = null, ip = null, today = null } = {}) {
  const p = await one(conn, 'SELECT date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  if (!p) throw notFound('Person');
  const dob = s.details.date_of_birth || p.date_of_birth;
  // With no date of birth anywhere we cannot tell a child from an adult, so nobody signs for themselves without one.
  if (s.signer_relation === 'self' && !dob) throw bad('Add the date of birth first. A renter under 18 needs a parent or guardian to sign.', { field: 'date_of_birth' });
  const day = today || todayIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
  const age = ageOn(dob, day);
  if (age !== null && age < 18 && s.signer_relation === 'self') throw bad('This renter is under 18. A parent or guardian signs for them.');
  const [r] = await conn.query("INSERT INTO rental_signoffs (tenant_id, person_id, contract_id, signer_name, signer_relation, details, signature, via, ip) VALUES (?, ?, ?, ?, ?, ?, ?, 'counter', ?)",
    [tenantId, personId, contractId, s.signer_name, s.signer_relation, JSON.stringify(s.details), s.signature, ip]);
  return r.insertId;
}

// ---- binding suggestion ---------------------------------------------------------------------
/**
 * The setting the shop's own chart gives for this person today. Rows for the ability type (1, 2, 3 or I, II, III), the
 * boot sole length and the age (rows with an age range win over rows with none). With weight and height both known, the
 * lower of the two settings is used, the same way the printed charts take the lower skier code. Advisory only.
 * Returns { din, rows, missing, note }.
 */
async function suggestBinding(conn, tenantId, { weight_lb, height_in, sole_mm, skier_type, age }) {
  const type = typeOf(skier_type);
  const missing = [];
  if (!type) missing.push('ability');
  if (!weight_lb && !height_in) missing.push('weight or height');
  if (missing.length) return { din: null, rows: [], missing, note: `Add the ${missing.join(' and ')} first.` };
  const all = await rows(conn, `SELECT * FROM binding_chart WHERE tenant_id = ? AND UPPER(skier_type) IN (?)
     AND (sole_mm_min IS NULL OR ? IS NULL OR sole_mm_min <= ?) AND (sole_mm_max IS NULL OR ? IS NULL OR sole_mm_max >= ?)`,
  [tenantId, TYPE_ALIASES[type], sole_mm ?? null, sole_mm ?? null, sole_mm ?? null, sole_mm ?? null]);
  const ageOk = (r) => (r.age_min == null || (age != null && age >= r.age_min)) && (r.age_max == null || (age != null && age <= r.age_max));
  const aged = all.filter((r) => (r.age_min != null || r.age_max != null) && ageOk(r));
  const pool_ = aged.length ? aged : all.filter((r) => r.age_min == null && r.age_max == null);
  const inRange = (v, lo, hi) => v != null && (lo == null || v >= lo) && (hi == null || v <= hi) && (lo != null || hi != null);
  const byW = weight_lb ? pool_.filter((r) => inRange(weight_lb, r.weight_lb_min, r.weight_lb_max)) : [];
  const byH = height_in ? pool_.filter((r) => inRange(height_in, r.height_in_min, r.height_in_max)) : [];
  const found = [...byW, ...byH];
  if (!found.length) return { din: null, rows: [], missing: [], note: 'Nothing in your chart matches. Set it by your shop procedure.' };
  const best = found.reduce((m, r) => (Number(r.din) < Number(m.din) ? r : m), found[0]);
  return { din: Number(best.din), rows: [best.id], missing: [], note: aged.length ? 'From the chart rows for this age.' : null };
}

// ---- paid and ready to fit -------------------------------------------------------------------
/**
 * A paid rental with no gear yet: one contract per renter, status to_fit, due back from the shop's closing time (or the
 * season return date), at the first station when the shop works in stations. Call inside a transaction.
 */
async function createToFit(conn, tenantId, { personId, orderId = null, orderItemId = null, validOn, product, settings = null, notes = null }) {
  const s = settings || await fitSettings(conn, tenantId);
  const kind = product && product.rental_kind === 'season' ? 'season' : 'day';
  const dueAt = dueFor(s, kind, validOn, product ? product.valid_days : 1);
  const stage = s.layout === 'stations' ? 'form' : null;
  const [c] = await conn.query(
    `INSERT INTO rental_contracts (tenant_id, person_id, order_id, order_item_id, status, kind, stage, stage_at, valid_on, due_at, notes)
     VALUES (?, ?, ?, ?, 'to_fit', ?, ?, IF(? IS NULL, NULL, NOW()), ?, ?, ?)`,
    [tenantId, personId, orderId, orderItemId, kind, stage, stage, validOn, dueAt, notes],
  );
  return { id: c.insertId, due_at: dueAt, kind, stage };
}

/**
 * The signoff check before gear goes out: when the shop requires it and skis or a snowboard are in the gear, each person
 * wearing them needs a signoff in the window whose details match what is on file now. Throws a conflict naming who.
 */
async function requireSignoffs(conn, tenantId, gear, defaultPersonId, settings) {
  const p = await signoffProblem(conn, tenantId, gear, defaultPersonId, settings);
  if (p) throw conflict(p.message, { person_id: p.person_id, signoff: p.signoff });
}

/** The same check, returning the first problem ({ message, person_id, signoff }) instead of throwing, or null. */
async function signoffProblem(conn, tenantId, gear, defaultPersonId, settings, { forDay = null } = {}) {
  if (!settings.require_signoff) return null;
  const ids = gear.map((g) => g.rental_item_id);
  if (!ids.length) return null;
  const cats = new Map((await rows(conn, 'SELECT id, category FROM rental_items WHERE tenant_id = ? AND id IN (?)', [tenantId, ids])).map((r) => [r.id, r.category]));
  const who = [...new Set(gear.filter((g) => NEEDS_SIGNOFF.includes(cats.get(g.rental_item_id))).map((g) => g.person_id || defaultPersonId))];
  for (const pid of who) {
    const { person, details } = await detailsOf(conn, tenantId, pid);
    const v = await validSignoff(conn, tenantId, pid, details, { settings, forDay });
    const name = `${person.first_name} ${person.last_name}`;
    if (!v) return { message: `${name} has not signed that their details are true. Have them sign on the fitting card first.`, person_id: pid, signoff: 'missing' };
    if (v.mismatch.length) return { message: `${name}'s details changed since they signed (${v.mismatch.map((k) => k.replace(/_/g, ' ')).join(', ')}). Have them sign again.`, person_id: pid, signoff: 'changed' };
  }
  return null;
}

const handoutSchema = z.object({
  items: z.array(R.gearLine).max(60), // empty is fine when gear was set aside on the contract (a group, the night before)
  due_at: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/).optional(),
  deposit_cents: z.number().int().min(0).max(1_000_000).optional(),
  // a rental with no paid sale behind it: managers only, and they say why
  unpaid_reason: z.string().max(200).optional(),
});

/**
 * Hands out gear on a to_fit contract: waivers for everyone wearing gear, the signoff, the binding record rule, then the
 * gear goes rented and the contract goes out. A note deposit (the shop's default, or what staff typed) is recorded as a
 * deposit charge, as before. Call inside a transaction. Returns the contract's new state.
 */
async function handout(conn, tenantId, contractId, body, req = null) {
  const c = await one(conn, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, contractId]);
  if (!c) throw notFound('Contract');
  if (c.status !== 'to_fit') throw conflict(c.status === 'out' ? 'That gear is already out' : `That rental is ${c.status.replace('_', ' ')}`);
  // Paid first: the sale behind this rental (still paid, its rental line not refunded), or for a group the group's
  // billing a manager recorded. With neither, counter staff are refused and a manager says why.
  const unpaid = await paymentProblem(conn, tenantId, c) ? await unpaidCheck(conn, req, { unpaid_reason: body.unpaid_reason }, { group: Boolean(c.group_id) }) : null;
  if (unpaid) await conn.query('UPDATE rental_contracts SET unpaid_reason = ?, unpaid_by = ? WHERE tenant_id = ? AND id = ?', [unpaid, (req && req.auth.userId) ?? null, tenantId, contractId]);
  const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const season = seasonFor(todayIn(tenant.timezone));
  const everyone = [...new Set([c.person_id, ...body.items.map((i) => i.person_id).filter(Boolean), ...(await rows(conn, 'SELECT person_id FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? AND returned_at IS NULL AND person_id IS NOT NULL', [tenantId, contractId])).map((r) => r.person_id)])];
  for (const pid of everyone) {
    if (!(await one(conn, ON_FILE, [tenantId, pid, season]))) {
      const p = await one(conn, 'SELECT first_name, last_name FROM people WHERE tenant_id = ? AND id = ?', [tenantId, pid]);
      throw conflict(`No signed waiver on file for ${p ? `${p.first_name} ${p.last_name}` : 'the renter'} for the ${season} season`);
    }
  }
  const settings = await fitSettings(conn, tenantId);
  // Gear already on the contract (set aside for a group the night before) stays: its lines are updated with anything
  // recorded now, and only new gear is added.
  const onIt = await rows(conn, 'SELECT id, rental_item_id, person_id FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? AND returned_at IS NULL', [tenantId, contractId]);
  const existing = new Map(onIt.map((l) => [l.rental_item_id, l]));
  const fresh = body.items.filter((i) => !existing.has(i.rental_item_id));
  if (!fresh.length && !onIt.length) throw bad('Choose the gear first');
  await requireSignoffs(conn, tenantId, [...onIt.map((l) => ({ rental_item_id: l.rental_item_id, person_id: l.person_id || undefined })), ...fresh], c.person_id, settings);
  for (const i of body.items.filter((x) => existing.has(x.rental_item_id))) {
    if (i.test_result === 'fail') throw bad('A binding that failed its test cannot go out');
    await conn.query(`UPDATE rental_contract_items SET din_setting = COALESCE(?, din_setting), tech_name = COALESCE(?, tech_name), test_result = COALESCE(?, test_result),
      boot_sole_mm = COALESCE(?, boot_sole_mm), skier_type = COALESCE(?, skier_type), set_at = IF(? IS NULL, set_at, NOW()) WHERE tenant_id = ? AND id = ?`,
    [i.din_setting ?? null, i.tech_name ?? null, i.test_result ?? null, i.boot_sole_mm ?? null, i.skier_type ?? null, i.din_setting ?? null, tenantId, existing.get(i.rental_item_id).id]);
  }
  if (onIt.length) {
    const lines = await rows(conn, 'SELECT l.din_setting, l.tech_name, l.test_result, r.sku, r.category FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND l.contract_id = ? AND l.returned_at IS NULL', [tenantId, contractId]);
    for (const l of lines) {
      if (l.test_result === 'fail') throw bad(`${l.sku} failed its binding test, so it cannot go out`);
      if (settings.require_binding_record && l.category === 'ski' && (l.din_setting == null || !l.tech_name)) throw bad(`Record the binding setting and who set it for ${l.sku}`);
    }
    await conn.query("UPDATE rental_items SET status = 'rented', uses_count = uses_count + 1 WHERE tenant_id = ? AND id IN (?) AND status IN ('set_aside','available')", [tenantId, onIt.map((l) => l.rental_item_id)]);
  }
  if (fresh.length) await R.insertGear(conn, tenantId, contractId, fresh, settings);
  const dueAt = body.due_at ? `${body.due_at.replace('T', ' ').slice(0, 16)}:00` : String(c.due_at);
  const deposit = settings.deposit_mode === 'note' ? (body.deposit_cents ?? settings.default_deposit_cents ?? 0) : 0;
  await conn.query("UPDATE rental_contracts SET status = 'out', stage = NULL, stage_at = NULL, checked_out_at = NOW(), due_at = ?, deposit_cents = ?, deposit_mode = ? WHERE tenant_id = ? AND id = ?",
    [dueAt, deposit, deposit > 0 ? 'note' : c.deposit_mode, tenantId, contractId]);
  if (deposit > 0) await conn.query("INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note) VALUES (?, ?, 'deposit', ?, 'Deposit held')", [tenantId, contractId, deposit]);
  // Signoffs made at the counter before the gear went out now point at this contract.
  await conn.query('UPDATE rental_signoffs SET contract_id = ? WHERE tenant_id = ? AND person_id IN (?) AND contract_id IS NULL AND via = \'counter\' AND signed_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)', [contractId, tenantId, everyone]);
  return { id: contractId, status: 'out', due_at: dueAt, deposit_cents: deposit, ...(unpaid ? { unpaid_reason: unpaid } : {}) };
}

/**
 * Why a sale does not pay for a rental, or null when it does: it must be at this mountain, still paid, and have a
 * rental line that is not refunded (the contract's own line when it has one).
 */
async function orderProblem(conn, tenantId, orderId, orderItemId = null) {
  const o = await one(conn, 'SELECT id, status FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, orderId]);
  if (!o) return 'That sale was not found at this mountain. Check the order number.';
  if (o.status !== 'paid') return `That sale is ${o.status}, so it does not pay for a rental.`;
  const line = await one(conn, `SELECT id FROM order_items WHERE tenant_id = ? AND order_id = ? AND line_kind = 'rental' AND refunded_at IS NULL${orderItemId ? ' AND id = ?' : ''} LIMIT 1`,
    orderItemId ? [tenantId, orderId, orderItemId] : [tenantId, orderId]);
  if (!line) return orderItemId ? 'The rental on that sale was refunded.' : 'That sale has no rental on it that is still paid.';
  return null;
}

/** Whether a group's billing is settled: a paid sale recorded for the group, or a manager's note (an invoice). */
async function groupBillingOk(conn, tenantId, groupId) {
  const g = await one(conn, 'SELECT billing_order_id, billing_note FROM rental_groups WHERE tenant_id = ? AND id = ?', [tenantId, groupId]);
  if (!g) return false;
  if (g.billing_note) return true;
  if (g.billing_order_id) return Boolean(await one(conn, "SELECT id FROM orders WHERE tenant_id = ? AND id = ? AND status = 'paid'", [tenantId, g.billing_order_id]));
  return false;
}

const GROUP_BILLING = 'A manager must record how this group pays';

/** Why a contract's gear is not paid for (a message), or null when it is: its own paid sale, or its group's billing. */
async function paymentProblem(conn, tenantId, c) {
  if (c.order_id && !(await orderProblem(conn, tenantId, c.order_id, c.order_item_id || null))) return null;
  if (c.group_id && await groupBillingOk(conn, tenantId, c.group_id)) return null;
  if (c.group_id) return GROUP_BILLING;
  return c.order_id ? await orderProblem(conn, tenantId, c.order_id, c.order_item_id || null) : 'Nothing has been paid for this rental.';
}

/**
 * Handing out gear: with an order_id the sale must be real and paid (orderProblem), for every caller. With nothing paid,
 * counter staff are sent to Sell; a manager can do it with a reason, kept on the contract (unpaid_reason, unpaid_by).
 * Returns the reason to keep, or null when the sale pays for it. Call inside the transaction.
 */
async function unpaidCheck(conn, req, body, { group = false } = {}) {
  if (body.order_id) {
    const why = await orderProblem(conn, req.auth.tenantId, body.order_id);
    if (why) throw conflict(why);
    return null;
  }
  const managerish = req && ['owner', 'manager'].includes(req.auth.role);
  if (!managerish) throw forbidden(group ? `${GROUP_BILLING}. Counter staff cannot hand out this gear until then.` : 'Sell the rental first. A manager can hand out gear without a sale.');
  const reason = String(body.unpaid_reason || '').trim();
  if (reason.length < 3) throw bad('Say why this gear goes out without a sale');
  return reason.slice(0, 200);
}

module.exports = {
  ABILITY, ABILITY_HELP, STAGES, NEEDS_SIGNOFF, nextStage, typeOf, ageOn, fitSettings, dueFor, detailsSchema, detailsOf, saveDetails,
  mismatch, validSignoff, signoffSchema, writeSignoff, suggestBinding, createToFit, requireSignoffs, signoffProblem, handoutSchema, handout, unpaidCheck, nowIn,
  orderProblem, groupBillingOk, paymentProblem, GROUP_BILLING,
};
