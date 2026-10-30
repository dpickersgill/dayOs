'use strict';
// The 20-second window (Track WINDOW, 2026.11.8): group prices, rewards used at the window, what a light (day ticket)
// sale did not ask for, and reading what the cashier scans into the one search box (an order, a ticket, a lesson, a card,
// a reward, a driver's license). Used by routes/checkout.js and routes/guestswindow.js.
const { one, rows } = require('../db');
const { bad, conflict, notFound } = require('./errors');
const R = require('./rewards');
const GT = require('./guesttypes');
const { addDays } = require('./util');

// ---------------------------------------------------------------- group prices
/**
 * A product's group price (a price per person from N people, a manager setting) replaces the unit price on its ticket
 * lines when the basket has at least N of it for the same day and the group price is lower. Partner pass days are left alone.
 */
async function applyGroupPrices(conn, tenantId, priced) {
  const lines = priced.filter((p) => p.type === 'ticket' && p.product && !p.partner);
  if (!lines.length) return;
  const gp = await rows(conn, 'SELECT product_id, min_people, price_cents FROM group_prices WHERE tenant_id = ? AND product_id IN (?)', [tenantId, [...new Set(lines.map((p) => p.product.id))]]);
  if (!gp.length) return;
  const count = new Map();
  for (const p of lines) { const k = `${p.product.id}|${p.validOn}`; count.set(k, (count.get(k) || 0) + p.quantity); }
  for (const p of lines) {
    const g = gp.find((x) => Number(x.product_id) === Number(p.product.id));
    if (!g || count.get(`${p.product.id}|${p.validOn}`) < g.min_people || g.price_cents >= p.unit) continue;
    p.group = { min_people: g.min_people, price_cents: g.price_cents, was_cents: p.unit };
    p.unit = g.price_cents;
    p.detail = `${p.detail}, group price`;
  }
}

// ---------------------------------------------------------------- rewards at the window
const day10 = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/**
 * Applies the rewards a guest is using to the priced basket: each one comes off one unit of one line (a free ticket on a
 * ticket line, a percent off any line), and a credit comes off the basket from the first line on (never a gift card).
 * Sets p.unitOff (cents off each unit), p.unitReward (the reward on each unit) and p.rewardsUsed. With lock the reward
 * rows are locked (the sale's transaction), so two sales at once cannot both use one: the second waits, then is refused.
 * Returns [{ id, code, kind, choice, value_cents, person_id, line }].
 */
async function applyRewards(conn, tenantId, priced, uses, today, { lock = false } = {}) {
  if (!uses || !uses.length) return [];
  const out = [];
  const seen = new Set();
  for (const u of uses) {
    let r;
    if (u.reward_id) r = await one(conn, `SELECT * FROM guest_rewards WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, u.reward_id]);
    else {
      const byCode = await R.byCode(conn, tenantId, u.code);
      r = byCode && lock ? await one(conn, 'SELECT * FROM guest_rewards WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, byCode.id]) : byCode;
    }
    if (!r) throw notFound('Reward');
    r = R.shape(r);
    if (seen.has(r.id)) throw bad('The same reward is on this sale twice');
    seen.add(r.id);
    if (r.status === 'redeemed') throw conflict('That reward has already been used');
    if (r.status !== 'offered') throw conflict(`That reward is ${r.status === 'void' ? 'canceled' : r.status}`);
    if (today < day10(r.valid_from) || today > day10(r.valid_to)) throw conflict(`That reward is good from ${day10(r.valid_from)} to ${day10(r.valid_to)}`);
    if (!r.options[u.choice]) throw conflict('That choice is not part of this reward');
    for (const p of priced) { if (!p.unitOff) { p.unitOff = Array(p.type === 'ticket' ? p.quantity : 1).fill(0); p.unitReward = p.unitOff.map(() => null); } }
    const unitsLeft = (p) => p.unitOff.map((off, k) => ({ k, left: p.unit - off })).filter((x) => x.left > 0);
    let value = 0; let lineIndex = null;
    if (u.choice === 'credit') {
      let left = Number(r.options.credit.cents);
      for (const p of priced) {
        if (p.type === 'gift_card' || left <= 0) continue;
        for (const x of unitsLeft(p)) {
          const take = Math.min(left, x.left);
          if (take <= 0) break;
          p.unitOff[x.k] += take; if (!p.unitReward[x.k]) p.unitReward[x.k] = r.id;
          left -= take; value += take;
          if (lineIndex === null) lineIndex = p.i;
          (p.rewardsUsed = p.rewardsUsed || []).includes(r.id) || p.rewardsUsed.push(r.id);
          if (left <= 0) break;
        }
      }
    } else {
      const fits = (p) => p.type !== 'gift_card' && (u.choice !== 'free_ticket' || p.type === 'ticket') && unitsLeft(p).some((x) => x.left === p.unit)
        && R.valueOf(r, u.choice, { line: { product_id: p.product ? p.product.id : null, unit_cents: p.unit } }) > 0;
      const p = u.line !== undefined ? priced.find((x) => x.i === u.line) : priced.find(fits);
      if (!p || !fits(p)) throw conflict(u.choice === 'free_ticket' ? 'This reward is for a ticket that is not in the basket' : 'Nothing in the basket can take this reward');
      const x = unitsLeft(p).find((y) => y.left === p.unit);
      value = Math.min(x.left, R.valueOf(r, u.choice, { line: { product_id: p.product ? p.product.id : null, unit_cents: p.unit } }));
      p.unitOff[x.k] += value; p.unitReward[x.k] = r.id;
      (p.rewardsUsed = p.rewardsUsed || []).push(r.id);
      lineIndex = p.i;
    }
    if (value <= 0) throw conflict('Nothing in the basket can take this reward');
    out.push({ id: r.id, code: r.code, kind: r.kind, choice: u.choice, value_cents: value, person_id: r.person_id, line: lineIndex });
  }
  return out;
}

/** The details a day ticket did not ask for, so the window can ask next time (never blocking). */
function softGaps(person) {
  const out = [];
  if (!person.date_of_birth) out.push('Date of birth');
  if (!person.sex) out.push('Sex');
  return out;
}

// ---------------------------------------------------------------- birthdays
/** This person's next birthday within the week from day (today counts), or null. */
function birthdayThisWeek(dob, day) {
  if (!dob) return null;
  const born = (dob instanceof Date ? dob.toISOString() : String(dob)).slice(0, 10);
  const md = born.slice(5);
  for (let i = 0; i < 7; i += 1) {
    const d = addDays(day, i);
    // a Feb 29 birthday is kept on Feb 28 in a year without one
    if (d.slice(5) === md || (md === '02-29' && d.slice(5) === '02-28' && !addDays(d, 1).endsWith('-02-29'))) {
      return { on: d, today: i === 0, weekday: i === 0 ? 'today' : new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${d}T12:00:00Z`)), turning: GT.ageOn(born, d) };
    }
  }
  return null;
}

// ---------------------------------------------------------------- what was scanned
/**
 * A US or Canadian driver's license or ID (the AAMVA PDF417 barcode, read by a USB scanner that types it): the name and
 * date of birth only. The license number and address are never returned or kept. Scanners send the line breaks as
 * newlines, carriage returns, record separators or (from the scan box) a "|". Returns null when it is not a license.
 */
const AAMVA_IDS = ['DAA', 'DAB', 'DAC', 'DAD', 'DAE', 'DAF', 'DAG', 'DAH', 'DAI', 'DAJ', 'DAK', 'DAL', 'DAM', 'DAN', 'DAO', 'DAP', 'DAQ', 'DAR', 'DAS', 'DAT', 'DAU', 'DAV', 'DAW', 'DAX', 'DAY', 'DAZ',
  'DBA', 'DBB', 'DBC', 'DBD', 'DBE', 'DBF', 'DBG', 'DBH', 'DBI', 'DBJ', 'DBK', 'DBL', 'DBM', 'DBN', 'DBO', 'DBP', 'DBQ', 'DBR', 'DBS',
  'DCA', 'DCB', 'DCD', 'DCE', 'DCF', 'DCG', 'DCH', 'DCI', 'DCJ', 'DCK', 'DCL', 'DCM', 'DCN', 'DCO', 'DCP', 'DCQ', 'DCR', 'DCS', 'DCT', 'DCU',
  'DDA', 'DDB', 'DDC', 'DDD', 'DDE', 'DDF', 'DDG', 'DDH', 'DDI', 'DDJ', 'DDK', 'DDL'];
function parseLicense(raw) {
  const s = String(raw || '');
  if (!/ANSI ?\d{6}|AAMVA/i.test(s) && !(/DBB\d{8}/.test(s) && /DC[ST]|DAC|DAA/.test(s))) return null;
  let parts = s.split(/[\r\n\x1e\x1d|]+/);
  if (parts.length < 4) parts = s.split(new RegExp(`(?=${AAMVA_IDS.join('|')})`)); // the line breaks were lost
  const f = {};
  for (const line of parts) {
    const m = /(D[A-D][A-Z])(.*)$/.exec(line.trim());
    if (!m || !AAMVA_IDS.includes(m[1]) || f[m[1]]) continue;
    f[m[1]] = m[2].trim();
  }
  const title = (v) => String(v || '').trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
  let first = f.DAC || f.DCT || ''; let last = f.DCS || f.DAB || '';
  if (!first && !last && f.DAA) { const [l, fi] = f.DAA.split(/[,$]/); last = l; first = fi || ''; }
  first = first.split(/[\s,$]/).filter(Boolean)[0] || '';
  const d = String(f.DBB || '').replace(/\D/g, '');
  let dob = null;
  if (d.length === 8) {
    // US cards write MMDDYYYY, Canadian cards YYYYMMDD
    const us = `${d.slice(4, 8)}-${d.slice(0, 2)}-${d.slice(2, 4)}`; const ca = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const ok = (x) => /^(19|20)\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(x);
    dob = ok(us) ? us : ok(ca) ? ca : null;
  }
  if (!first && !last) return null;
  return { first_name: title(first), last_name: title(last), date_of_birth: dob };
}

/**
 * What one scan or typed code is: { kind, ... }. kind is 'license', 'order' (ORD-12 or #12), 'lesson' (L345), 'shop'
 * (an 8-letter online order reference), 'reward' (a 10-letter reward code), 'ticket' (a ticket or pass code), 'card' (an
 * RFID chip serial) or 'text' (a name, phone or email to search for).
 */
function classify(raw) {
  const s = String(raw || '').trim();
  const lic = parseLicense(s);
  if (lic) return { kind: 'license', license: lic };
  const c = s.toUpperCase().replace(/\s+/g, '');
  let m = /^(?:ORD-?|#)(\d{1,12})$/.exec(c);
  if (m) return { kind: 'order', order_id: Number(m[1]) };
  m = /^L(\d{1,12})$/.exec(c);
  if (m) return { kind: 'lesson', booking_id: Number(m[1]) };
  if (/^[0-9A-F]{20}$/.test(c)) return { kind: 'ticket', code: c };
  if (/^[A-HJ-NP-Z2-9]{10}$/.test(c) && /[A-Z]/.test(c)) return { kind: 'reward', code: c };
  if (/^[A-HJ-NP-Z2-9]{8}$/.test(c) && /[A-Z]/.test(c) && /\d/.test(c)) return { kind: 'shop', reference: c };
  if (/^[0-9A-F:.\s-]{8,40}$/i.test(s) && !/@/.test(s) && s.replace(/[^0-9A-F]/gi, '').length >= 8) return { kind: 'card', raw: s };
  return { kind: 'text', q: s };
}

module.exports = { birthdayThisWeek, applyGroupPrices, applyRewards, softGaps, parseLicense, classify };
