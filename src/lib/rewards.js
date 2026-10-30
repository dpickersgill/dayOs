'use strict';
// What a guest holds (guest_rewards): a birthday gift, a milestone, a loyalty day, a first-timer offer, a closure or
// conditions credit, a goodwill credit. Each offer carries options (any of free_ticket, percent, credit); the guest or the
// cashier picks one when it is used, once, online or at the window. Shared by the window (Sell), the online shop and the
// household account, the welcome-back card, and whatever issues them (lib/loyalty.js, lib/fairprice.js).
const crypto = require('crypto');
const { one, rows } = require('../db');
const { conflict, notFound } = require('./errors');

const CHOICES = ['free_ticket', 'percent', 'credit'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I, so it reads aloud at the window
const newCode = () => Array.from(crypto.randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join('');

/**
 * Offers a reward. options: { free_ticket: { product_id }, percent: { percent }, credit: { cents } } (any subset, at
 * least one). sourceKey makes it once only per person (for example 'birthday:2026-27'): a repeat returns the first.
 */
async function issue(conn, tenantId, { personId, kind, reason, options, validFrom, validTo, sourceKey = null }) {
  const opts = Object.fromEntries(Object.entries(options || {}).filter(([k, v]) => CHOICES.includes(k) && v));
  if (!Object.keys(opts).length) throw conflict('A reward needs at least one choice');
  if (sourceKey) {
    const had = await one(conn, 'SELECT * FROM guest_rewards WHERE tenant_id = ? AND person_id = ? AND source_key = ?', [tenantId, personId, sourceKey]);
    if (had) return had;
  }
  for (let i = 0; i < 5; i += 1) {
    try {
      const [r] = await conn.query(`INSERT INTO guest_rewards (tenant_id, person_id, kind, reason, options, code, valid_from, valid_to, source_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, personId, kind, reason || null, JSON.stringify(opts), newCode(), validFrom, validTo, sourceKey]);
      return one(conn, 'SELECT * FROM guest_rewards WHERE tenant_id = ? AND id = ?', [tenantId, r.insertId]);
    } catch (err) { if (err.code !== 'ER_DUP_ENTRY' || (sourceKey && /source/.test(err.message))) throw err; }
  }
  throw conflict('Could not make a reward code');
}

const shape = (r) => ({ ...r, options: typeof r.options === 'string' ? JSON.parse(r.options) : r.options });

/** Rewards a person (or several, a household) can use on a day (YYYY-MM-DD, the mountain's day). */
async function usable(db, tenantId, personIds, day) {
  const ids = [].concat(personIds).filter(Boolean);
  if (!ids.length) return [];
  return (await rows(db, `SELECT * FROM guest_rewards WHERE tenant_id = ? AND person_id IN (?) AND status = 'offered' AND valid_from <= ? AND valid_to >= ?
    ORDER BY valid_to, id`, [tenantId, ids, day, day])).map(shape);
}

/** A reward by its code (case-insensitive), or null. */
async function byCode(db, tenantId, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(c)) return null;
  const r = await one(db, 'SELECT * FROM guest_rewards WHERE tenant_id = ? AND code = ?', [tenantId, c]);
  return r ? shape(r) : null;
}

/**
 * What a choice is worth against a line (or the whole order for a credit), in cents. line: { product_id, unit_cents }.
 * free_ticket: the full price of one matching product (any product when the offer names none); percent: of the line;
 * credit: up to the credit, at most the order total.
 */
function valueOf(reward, choice, { line = null, orderCents = 0 } = {}) {
  const o = shape(reward).options[choice];
  if (!o) return 0;
  if (choice === 'free_ticket') return line && (!o.product_id || Number(o.product_id) === Number(line.product_id)) ? Number(line.unit_cents) : 0;
  if (choice === 'percent') return line && (!o.product_id || Number(o.product_id) === Number(line.product_id)) ? Math.round(Number(line.unit_cents) * Math.min(100, Number(o.percent)) / 100) : 0; // a percent offer may name one product (a season pass offer)
  return Math.min(Number(o.cents), Math.max(0, Number(orderCents)));
}

/** Marks a reward used, inside the sale's transaction (row locked). Refuses one used, expired or not valid that day. */
async function redeem(conn, tenantId, rewardId, { choice, day, orderId, userId = null, personIds = null }) {
  const r = await one(conn, 'SELECT * FROM guest_rewards WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, rewardId]);
  if (!r) throw notFound('Reward');
  const s = shape(r);
  if (s.status !== 'offered') throw conflict('That reward has already been used');
  const from = String(s.valid_from instanceof Date ? s.valid_from.toISOString() : s.valid_from).slice(0, 10);
  const to = String(s.valid_to instanceof Date ? s.valid_to.toISOString() : s.valid_to).slice(0, 10);
  if (day < from || day > to) throw conflict(`That reward is good from ${from} to ${to}`);
  if (!s.options[choice]) throw conflict('That choice is not part of this reward');
  if (personIds && !personIds.map(Number).includes(Number(s.person_id))) throw conflict('That reward belongs to someone else');
  const o = s.options[choice];
  await conn.query(`UPDATE guest_rewards SET status = 'redeemed', chosen = ?, product_id = ?, percent = ?, credit_cents = ?, order_id = ?, redeemed_at = UTC_TIMESTAMP(), redeemed_by = ?
    WHERE tenant_id = ? AND id = ?`, [choice, o.product_id || null, o.percent || null, o.cents || null, orderId || null, userId, tenantId, rewardId]);
  return { ...s, chosen: choice };
}

/** Puts a reward back (the order it paid for was refunded or canceled). */
async function release(conn, tenantId, orderId) {
  await conn.query("UPDATE guest_rewards SET status = 'offered', chosen = NULL, order_id = NULL, redeemed_at = NULL, redeemed_by = NULL WHERE tenant_id = ? AND order_id = ? AND status = 'redeemed'", [tenantId, orderId]);
}

/**
 * Gives rewards back after a refund of some lines of an order (itemIds, already marked refunded). A reward is put back
 * whole once every line it paid for is refunded. While some of its lines stand (a credit spread over two tickets, one
 * refunded), it stays used, and the refunded lines' part (order_items.reward_cents) comes back as a new credit, good
 * until the old one ran out (at least 30 days): the guest gets back exactly what the refund took, never more.
 * whole: the whole order is refunded (a reward on no line, from before lines carried it, is put back whole then).
 * Returns { released: [ids], reissued: [{ from, id, cents }] }.
 */
async function giveBack(conn, tenantId, orderId, itemIds, { whole = false } = {}) {
  const out = { released: [], reissued: [] };
  const ids = [].concat(itemIds).map(Number);
  const used = await rows(conn, "SELECT * FROM guest_rewards WHERE tenant_id = ? AND order_id = ? AND status = 'redeemed' FOR UPDATE", [tenantId, orderId]);
  const t = used.length ? await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]) : null;
  const today = t ? new Intl.DateTimeFormat('en-CA', { timeZone: t.timezone || 'America/New_York' }).format(new Date()) : null;
  const d10 = (x) => String(x instanceof Date ? x.toISOString() : x).slice(0, 10);
  for (const r of used) {
    const lines = await rows(conn, 'SELECT id, refunded_at, reward_cents FROM order_items WHERE tenant_id = ? AND order_id = ? AND reward_id = ?', [tenantId, orderId, r.id]);
    const before = await one(conn, 'SELECT id FROM guest_rewards WHERE tenant_id = ? AND person_id = ? AND source_key LIKE ? LIMIT 1', [tenantId, r.person_id, `reissue:${r.id}:%`]);
    const now = lines.filter((l) => ids.includes(Number(l.id)));
    if (!lines.length ? whole && !before : now.length && lines.every((l) => l.refunded_at) && !before) {
      await conn.query("UPDATE guest_rewards SET status = 'offered', chosen = NULL, order_id = NULL, redeemed_at = NULL, redeemed_by = NULL WHERE tenant_id = ? AND id = ? AND status = 'redeemed'", [tenantId, r.id]);
      out.released.push(r.id);
      continue;
    }
    const cents = now.reduce((n, l) => n + Number(l.reward_cents || 0), 0);
    if (!now.length || cents <= 0) continue;
    const plus30 = new Date(`${today}T12:00:00Z`); plus30.setUTCDate(plus30.getUTCDate() + 30);
    const until = d10(r.valid_to) > plus30.toISOString().slice(0, 10) ? d10(r.valid_to) : plus30.toISOString().slice(0, 10);
    const fresh = await issue(conn, tenantId, { personId: r.person_id, kind: r.kind, reason: `Given back from ${r.code} after a refund`, options: { credit: { cents } },
      validFrom: today, validTo: until, sourceKey: `reissue:${r.id}:${Math.min(...now.map((l) => Number(l.id)))}` });
    out.reissued.push({ from: r.id, id: fresh.id, cents });
  }
  return out;
}

/** Plain words for a reward's choices: "a free All-day ticket, 50% off, or a 25.00 credit". */
function words(reward, productNames = {}) {
  const o = shape(reward).options;
  const parts = [];
  if (o.free_ticket) parts.push(`a free ${productNames[o.free_ticket.product_id] || 'day ticket'}`);
  if (o.percent) parts.push(`${o.percent.percent}% off`);
  if (o.credit) parts.push(`a ${(o.credit.cents / 100).toFixed(2)} credit`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}` : parts[0] || '';
}

module.exports = { CHOICES, issue, usable, byCode, valueOf, redeem, release, giveBack, words, shape, newCode };
