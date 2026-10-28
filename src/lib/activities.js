'use strict';

// Activities: places on an attraction sold like any other product (the counter, the online shop, refunds, the drawer and
// the reports all treat an activity line as one more kind of line). What is particular to them lives here:
//   - when an activity runs: its time slots on a day (from its schedules), or the whole day for a day pass;
//   - how many places are left in a slot: places booked plus online baskets still on the card page (the same 40 minute
//     hold as the shop's daily limits), counted under the product's row lock so two sales cannot take the last place;
//   - the attraction's limits (height, weight, age) in words, and whether a rider must confirm them;
//   - what a gate at an attraction says to an activity ticket (right attraction, right day, from 15 minutes before the
//     slot to its end, once).
const { rows, one } = require('../db');
const { conflict, bad } = require('./errors');
const { allowedOn } = require('./saledays');

const HOLD_MINUTES = 40; // an online basket waiting on the card page holds its places this long (as the shop's day limits)
const EARLY_MINUTES = 15; // a rider can scan in this long before their slot starts
const MAX_TIMES = 60; // start times in one schedule

const pad = (n) => String(n).padStart(2, '0');
/** 'H:MM', 'HH:MM' or 'HH:MM:SS' -> 'HH:MM', or null when it is not a time of day. */
function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(s || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${pad(Number(m[1]))}:${m[2]}`;
}
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (n) => `${pad(Math.floor(n / 60) % 24)}:${pad(n % 60)}`;
/** A schedule's start times, sorted and without repeats. */
function parseTimes(text) {
  const out = new Set();
  for (const bit of String(text || '').split(/[\s,;]+/)) { const t = hhmm(bit); if (t) out.add(t); }
  return [...out].sort();
}
/** '2:00 PM' */
function clock(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
const dstr = (d) => (d ? String(d).slice(0, 10) : null);

/** The attraction's limits in words, for the counter and the shop: "Riders must be at least 48 inches tall, ...". */
function limitsText(a) {
  if (!a) return null;
  const bits = [];
  if (a.min_height_in) bits.push(`be at least ${a.min_height_in} inches tall`);
  if (a.min_weight_lb && a.max_weight_lb) bits.push(`weigh ${a.min_weight_lb} to ${a.max_weight_lb} pounds`);
  else if (a.min_weight_lb) bits.push(`weigh at least ${a.min_weight_lb} pounds`);
  else if (a.max_weight_lb) bits.push(`weigh no more than ${a.max_weight_lb} pounds`);
  if (a.min_age) bits.push(`be ${a.min_age} or older`);
  if (!bits.length) return null;
  const list = bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')}${bits.length > 2 ? ',' : ''} and ${bits[bits.length - 1]}`;
  return `Riders must ${list}.`;
}
const hasLimits = (a) => Boolean(a && (a.min_height_in || a.min_weight_lb || a.max_weight_lb || a.min_age));
/** Age in whole years on a day. */
function ageOn(dob, day) {
  const b = dstr(dob); if (!b) return null;
  let n = Number(day.slice(0, 4)) - Number(b.slice(0, 4));
  if (day.slice(5) < b.slice(5)) n -= 1;
  return n;
}
/** What a screen needs about an attraction. */
const attractionOut = (a) => ({
  id: a.id, name: a.name, type: a.type, status: a.status, status_note: a.status_note || null,
  min_height_in: a.min_height_in, min_weight_lb: a.min_weight_lb, max_weight_lb: a.max_weight_lb, min_age: a.min_age,
  waiver_required: Boolean(a.waiver_required), limits_text: limitsText(a), has_limits: hasLimits(a),
});
const ATTRACTION_COLS = 'id, name, type, status, status_note, min_height_in, min_weight_lb, max_weight_lb, min_age, waiver_required, active, sort';
async function attractionOf(db, tenantId, id) {
  return id ? one(db, `SELECT ${ATTRACTION_COLS} FROM attractions WHERE tenant_id = ? AND id = ?`, [tenantId, id]) : null;
}
async function activeAttractions(db, tenantId) {
  return rows(db, `SELECT ${ATTRACTION_COLS} FROM attractions WHERE tenant_id = ? AND active = 1 ORDER BY sort, name`, [tenantId]);
}

// ---------------------------------------------------------------- schedules and slots
const scheduleOut = (s) => ({ id: s.id, days: Number(s.days), starts_on: dstr(s.starts_on), ends_on: dstr(s.ends_on), start_times: parseTimes(s.start_times), slot_minutes: s.slot_minutes, capacity: s.capacity, active: Boolean(s.active) });

/**
 * The time slots of a timed activity on one day, from its active schedules: [{ start, end, capacity }], by start time.
 * Two schedules that give the same start time count once (the later schedule, which is usually the correction, wins).
 */
async function slotsOn(db, tenantId, productId, day) {
  const list = await rows(db, 'SELECT * FROM activity_schedules WHERE tenant_id = ? AND product_id = ? AND active = 1 AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?) ORDER BY id', [tenantId, productId, day, day]);
  const by = new Map();
  for (const s of list) {
    if (!allowedOn(s.days, day)) continue;
    for (const t of parseTimes(s.start_times)) by.set(t, { start: t, end: fromMin(Math.min(toMin(t) + s.slot_minutes, 24 * 60 - 1)), capacity: s.capacity, minutes: s.slot_minutes });
  }
  return [...by.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Places spoken for on a day, per product and start time ('' for a day pass): booked places (any channel, not
 * cancelled) plus online baskets still on the card page. lock: read the latest committed rows with shared locks (inside a
 * selling transaction, after the product rows are locked), so a sale that just finished is always counted.
 * Returns Map `${productId}|${start}` -> n.
 */
async function taken(db, tenantId, productIds, day, { lock = false } = {}) {
  const out = new Map();
  if (!productIds.length) return out;
  const bump = (k, n = 1) => out.set(k, (out.get(k) || 0) + n);
  const share = lock ? ' LOCK IN SHARE MODE' : '';
  // Baskets first, then bookings: a paid basket turns into bookings in one step, so it is never counted twice or missed.
  const holds = await rows(db, `SELECT basket FROM shop_orders WHERE tenant_id = ? AND status = 'awaiting_payment' AND created_at > DATE_SUB(NOW(), INTERVAL ${HOLD_MINUTES} MINUTE)${share}`, [tenantId]);
  const ids = new Set(productIds.map(Number));
  for (const h of holds) {
    let b; try { b = JSON.parse(h.basket); } catch (_) { continue; }
    for (const a of (b.quote && b.quote.activities) || []) if (ids.has(Number(a.product_id)) && a.valid_on === day) bump(`${a.product_id}|${a.start_time || ''}`);
  }
  const booked = await rows(db, `SELECT product_id, start_time, COUNT(*) AS n FROM activity_bookings WHERE tenant_id = ? AND product_id IN (?) AND on_date = ? AND status = 'booked' GROUP BY product_id, start_time${share}`, [tenantId, [...ids], day]);
  for (const r of booked) bump(`${r.product_id}|${r.start_time ? hhmm(r.start_time) : ''}`, Number(r.n));
  return out;
}

/**
 * What can be booked for one activity product on one day: { timed, slots: [{ start, end, label, capacity, left, past }] }.
 * A day pass is one entry with start null (capacity null when there is no cap). `now` ('HH:MM', local) marks today's
 * slots that have already ended as past.
 */
async function dayOf(db, tenantId, product, day, { now = null, used = null } = {}) {
  const use = used || await taken(db, tenantId, [product.id], day);
  if (!product.timed) {
    const n = use.get(`${product.id}|`) || 0;
    const cap = product.day_capacity === null || product.day_capacity === undefined ? null : Number(product.day_capacity);
    return { timed: false, slots: [{ start: null, end: null, label: 'All day', capacity: cap, left: cap === null ? null : Math.max(cap - n, 0), past: false }] };
  }
  const slots = (await slotsOn(db, tenantId, product.id, day)).map((s) => {
    const n = use.get(`${product.id}|${s.start}`) || 0;
    return { start: s.start, end: s.end, label: `${clock(s.start)} to ${clock(s.end)}`, capacity: s.capacity, left: Math.max(s.capacity - n, 0), past: Boolean(now && s.end <= now) };
  });
  return { timed: true, slots };
}

/** Lock activity products (sorted, so two baskets never wait on each other) before counting their places. */
async function lockProducts(conn, tenantId, ids) {
  const list = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  if (!list.length) return;
  await conn.query('SELECT id FROM products WHERE tenant_id = ? AND id IN (?) ORDER BY id FOR UPDATE', [tenantId, list]);
}

/**
 * The slot a line asks for, checked: the product is an activity on sale, the attraction is active, the day is a day it
 * runs and the start time is one of its slots (a day pass takes no start time). Returns { product, attraction, slot }.
 */
async function slotFor(db, tenantId, product, day, start, { today, now } = {}) {
  if (product.kind !== 'activity') throw bad(`${product.name} is not an activity`);
  const attraction = await attractionOf(db, tenantId, product.attraction_id);
  if (!attraction || !attraction.active) throw conflict(`${product.name} is not linked to an open attraction. A manager sets this in Products and prices.`);
  if (!product.timed) {
    if (start) throw bad(`${product.name} is sold for the whole day, with no time slot`);
    return { attraction, slot: { start: null, end: null, minutes: null, capacity: product.day_capacity } };
  }
  const t = hhmm(start);
  if (!t) throw bad(`Choose a time slot for ${product.name}`);
  const slot = (await slotsOn(db, tenantId, product.id, day)).find((s) => s.start === t);
  if (!slot) throw conflict(`${product.name} has no ${clock(t)} slot on ${day}`);
  if (today && day === today && now && slot.end <= now) throw conflict(`The ${clock(t)} slot for ${product.name} has already ended`);
  return { attraction, slot };
}

/**
 * Checks there are places for `want` more guests in a slot, counted with the latest committed sales. Call inside the
 * selling transaction after lockProducts. `extra` is places already taken by earlier lines of the same basket.
 */
async function ensurePlaces(conn, tenantId, product, day, slot, want, { lock = true, extra = 0 } = {}) {
  if (slot.capacity === null || slot.capacity === undefined) return null;
  const use = await taken(conn, tenantId, [product.id], day, { lock });
  const left = Number(slot.capacity) - (use.get(`${product.id}|${slot.start || ''}`) || 0) - extra;
  if (left < want) {
    const when = slot.start ? `the ${clock(slot.start)} slot` : day;
    throw conflict(left <= 0 ? `${product.name} is full for ${when}` : `${product.name} has only ${left} place${left === 1 ? '' : 's'} left for ${when}`, { left: Math.max(left, 0) });
  }
  return left;
}

/** One place, written down. */
async function book(conn, tenantId, { product, attractionId, day, slot, personId, orderItemId, ticketId, channel, limitsBy = null }) {
  const [r] = await conn.query('INSERT INTO activity_bookings (tenant_id, product_id, attraction_id, on_date, start_time, end_time, person_id, order_item_id, ticket_id, channel, limits_ok_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, product.id, attractionId, day, slot.start || null, slot.end || null, personId || null, orderItemId || null, ticketId || null, channel || 'window', limitsBy]);
  return r.insertId;
}

/** A refund (or a canceled sale) frees the places of these order lines. Returns how many were freed. */
async function release(conn, tenantId, orderItemIds) {
  if (!orderItemIds.length) return 0;
  const [r] = await conn.query("UPDATE activity_bookings SET status = 'cancelled' WHERE tenant_id = ? AND order_item_id IN (?) AND status = 'booked'", [tenantId, orderItemIds]);
  return r.affectedRows;
}

// ---------------------------------------------------------------- the gate
/**
 * What a gate at `attractionId` (null: a lift gate or the counter's scanner) says to a ticket that is otherwise good
 * today. now: local 'YYYY-MM-DD HH:MM:SS'. Returns null to let them in, or { result, reason } to refuse.
 *   - An activity ticket: only at its own attraction, and for a timed slot only from 15 minutes before the start to the end.
 *   - Any other ticket at an attraction: only when its product says it includes that attraction.
 */
async function gateRule(conn, tenantId, ticket, attractionId, now) {
  const p = await one(conn, 'SELECT id, kind, name, attraction_id FROM products WHERE tenant_id = ? AND id = ?', [tenantId, ticket.product_id]);
  if (!p) return null;
  if (p.kind === 'activity') {
    const home = await attractionOf(conn, tenantId, p.attraction_id);
    const name = home ? home.name : 'its attraction';
    if (!attractionId || Number(attractionId) !== Number(p.attraction_id)) {
      const here = attractionId ? await attractionOf(conn, tenantId, attractionId) : null;
      return { result: 'wrong_place', reason: `This ticket is for ${name}${here ? `, not ${here.name}` : ''}. Scan it at ${name}.` };
    }
    const b = await one(conn, "SELECT on_date, start_time, end_time FROM activity_bookings WHERE tenant_id = ? AND ticket_id = ? AND status = 'booked'", [tenantId, ticket.id]);
    if (!b || !b.start_time) return null; // a day pass: the ticket's own day is the rule (checked before this)
    const start = hhmm(b.start_time); const end = hhmm(b.end_time) || start;
    const hm = now.slice(11, 16);
    const opens = fromMin(Math.max(toMin(start) - EARLY_MINUTES, 0));
    if (dstr(b.on_date) === now.slice(0, 10) && hm < opens) return { result: 'too_early', reason: `Too early. This ticket is for the ${clock(start)} slot. Come back at ${clock(opens)}.` };
    if (dstr(b.on_date) === now.slice(0, 10) && hm > end) return { result: 'too_late', reason: `Too late. The ${clock(start)} slot ended at ${clock(end)}. Send the guest to the window.` };
    return null;
  }
  if (!attractionId) return null;
  const inc = await one(conn, 'SELECT 1 AS ok FROM product_attractions WHERE tenant_id = ? AND product_id = ? AND attraction_id = ?', [tenantId, p.id, attractionId]);
  if (inc) return null;
  const here = await attractionOf(conn, tenantId, attractionId);
  return { result: 'not_included', reason: `${p.name} does not include ${here ? here.name : 'this attraction'}. The guest needs a ticket for it.` };
}

module.exports = {
  HOLD_MINUTES, EARLY_MINUTES, MAX_TIMES, hhmm, parseTimes, clock, limitsText, hasLimits, ageOn, attractionOut, attractionOf, activeAttractions,
  scheduleOut, slotsOn, taken, dayOf, lockProducts, slotFor, ensurePlaces, book, release, gateRule,
};
