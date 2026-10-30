'use strict';

// Gate decisions: one rule for every way a ticket is shown. A barcode (the ticket's own code), an RFID card (its chip
// serial, looked up to the ticket it carries), a hardware gate asking online, or a gate that decided offline and
// reports later. Every scan is logged, with the card and the device when there was one.

const crypto = require('crypto');
const config = require('../config');
const { one, rows } = require('../db');
const { todayIn, nowIn, seasonFor } = require('./util');
const { ON_FILE } = require('./waivers');
const ACT = require('./activities');

/**
 * The ways one chip serial can arrive. Readers differ: phones give "04:A2:3B:..", desk readers type hex or a decimal
 * number, and some readers give the bytes in reverse order. Cards are stored as plain uppercase hex, so every reading
 * of the same chip maps to a short list of hex forms to look up, most likely first.
 * A run of digits is ambiguous (it is valid hex too): ten digits is how decimal readers print a 4-byte chip, so that is
 * read as decimal first; any other run of digits as hex first. Both readings are always tried.
 */
const reverseBytes = (hex) => hex.match(/../g).reverse().join('');
function uidCandidates(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/[\s:.-]/g, '');
  const hex = [];
  if (/^[0-9A-F]{8,32}$/.test(s)) { hex.push(s); if (s.length % 2 === 0) hex.push(reverseBytes(s)); }
  const dec = [];
  if (/^\d{6,20}$/.test(s)) {
    let h = BigInt(s).toString(16).toUpperCase();
    if (h.length % 2) h = `0${h}`;
    while (h.length < 8) h = `00${h}`;
    if (h.length <= 32) dec.push(h, reverseBytes(h));
  }
  const ordered = /^\d{10}$/.test(s) ? [...dec, ...hex] : [...hex, ...dec];
  return [...new Set(ordered)];
}

/** The form a card is saved under: the most likely reading. Null when it is not a chip serial. */
function normUid(raw) {
  return uidCandidates(raw)[0] || null;
}

/** Find a card by any reading of its serial: a blocked card wins (fail closed), then the most likely reading. */
async function findCard(conn, tenantId, raw, { lock = false } = {}) {
  const cands = uidCandidates(raw);
  if (!cands.length) return { card: null, cands };
  const card = await one(conn, `SELECT * FROM rfid_cards WHERE tenant_id = ? AND uid IN (?) ORDER BY FIELD(status, 'lost', 'retired', 'assigned', 'free'), FIELD(uid, ?) LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [tenantId, cands, cands]);
  return { card, cands };
}

const looksLikeTicketCode = (s) => /^[0-9A-F]{20}$/.test(s);

/** A compact welcome for the gate: { visit, first_visit, birthday } (birthday: 'today', a weekday, or null). Nothing private. */
async function gateWelcome(conn, tenantId, personId, today, tz) {
  const v = await require('./guestvisits').summary(conn, tenantId, personId, today, tz);
  const p = await one(conn, 'SELECT date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  const b = require('./windowsale').birthdayThisWeek(p && p.date_of_birth, today);
  return { visit: Math.max(v.this_season, 1), first_visit: v.total <= 1, birthday: b ? b.weekday : null };
}

/**
 * Decide and log one scan, inside the caller's transaction.
 * input: { code?, uid?, location?, override?, deviceId?, clientRef?, via, attractionId? }
 * A code that is not a ticket is tried as a card serial, so a desk RFID reader that types into the scan box just works.
 * attractionId: the attraction this gate stands at (null for a lift gate). An activity ticket is good only at its own
 * attraction in its slot; another ticket only at an attraction its product includes (lib/activities.js gateRule).
 */
async function decide(conn, tenantId, input) {
  // The ticket (or card) is locked before anything else is read. InnoDB takes a transaction's snapshot at its first
  // plain read, so reading after the lock means a scan that another gate just committed for this ticket is seen, and
  // two gates tapping the same pass at once cannot both pass the pass-back check.
  const raw = String(input.code || input.uid || '').trim().toUpperCase();
  let t = null; let card = null; let uid = null; let via = input.via || 'code';

  if (input.code && !input.uid) {
    const code = raw.replace(/[\s-]/g, '');
    t = await one(conn, 'SELECT * FROM tickets WHERE tenant_id = ? AND code = ? FOR UPDATE', [tenantId, code]);
  }
  if (!t) {
    const found = await findCard(conn, tenantId, raw, { lock: true });
    card = found.card;
    if (card) {
      uid = card.uid;
      if (via === 'code') via = 'rfid';
      if (card.ticket_id && card.status === 'assigned') t = await one(conn, 'SELECT * FROM tickets WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, card.ticket_id]);
    } else if (found.cands.length && !looksLikeTicketCode(raw.replace(/[\s-]/g, ''))) uid = found.cands[0];
  }
  const tenant = await one(conn, 'SELECT timezone, scan_passback_seconds, waiver_text, gate_open_ms FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);

  let result = 'ok';
  let previous = null;
  let rule = null;
  if (card && (card.status === 'lost' || card.status === 'retired')) result = 'card_blocked';
  else if (!t) result = 'unknown';
  else if (t.status === 'void') result = 'void';
  else if (t.status === 'used_up' || (t.uses_remaining !== null && t.uses_remaining < 1)) result = 'no_uses';
  else if (today < t.valid_from) result = 'not_yet_valid';
  else if (today > t.valid_to) result = 'expired';
  else if ((rule = await ACT.gateRule(conn, tenantId, t, input.attractionId || null, nowIn(tenant.timezone)))) result = rule.result;
  else if ((rule = await require('./fairprice').holdFor(conn, tenantId, t))) result = rule.result; // FAIR: a blocked pass, a plan left unpaid
  else if (tenant.scan_passback_seconds > 0 && !input.override) {
    previous = await one(conn, "SELECT scanned_at, location FROM scans WHERE tenant_id = ? AND ticket_id = ? AND result = 'ok' AND scanned_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND) ORDER BY id DESC LIMIT 1", [tenantId, t.id, tenant.scan_passback_seconds]);
    if (previous) result = 'duplicate';
  }

  if (result === 'ok' && t.uses_remaining !== null) {
    const left = t.uses_remaining - 1;
    await conn.query('UPDATE tickets SET uses_remaining = ?, status = ? WHERE id = ? AND tenant_id = ?', [left, left < 1 ? 'used_up' : 'active', t.id, tenantId]);
    t.uses_remaining = left; // what is left after this ride is what the gate shows
  }
  if (card) await conn.query('UPDATE rfid_cards SET last_seen_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [tenantId, card.id]);
  const logged = t ? t.code : raw.replace(/[^0-9A-Z]/g, '').slice(0, 20) || '?';
  await conn.query('INSERT INTO scans (tenant_id, ticket_id, code, location, result, media_uid, device_id, client_ref, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, t ? t.id : null, logged, input.location ?? null, result, uid, input.deviceId ?? null, input.clientRef ?? null, via]);

  let holder = null;
  if (t) {
    const p = await one(conn, `SELECT p.id, p.first_name, p.last_name, p.photo, pr.name AS product, pr.kind, i.tier, gt.name AS tier_name FROM tickets k JOIN products pr ON pr.id = k.product_id AND pr.tenant_id = k.tenant_id
      LEFT JOIN people p ON p.id = k.person_id AND p.tenant_id = k.tenant_id LEFT JOIN order_items i ON i.id = k.order_item_id AND i.tenant_id = k.tenant_id
      LEFT JOIN guest_types gt ON gt.tenant_id = i.tenant_id AND gt.code = i.tier WHERE k.tenant_id = ? AND k.id = ?`, [tenantId, t.id]);
    holder = { name: p && p.first_name ? `${p.first_name} ${p.last_name}` : null, first_name: p ? p.first_name || null : null, photo: p ? p.photo || null : null, product: p ? p.product : null, kind: p ? p.kind : null,
      // the guest type the ticket was sold as, shown big at the gate so an adult on a child's ticket is caught
      guest_type: p && p.tier ? p.tier : null, guest_type_name: p && p.tier ? (p.tier_name || p.tier.charAt(0).toUpperCase() + p.tier.slice(1)) : null };
    // Only when the mountain uses waivers and the ticket has a named holder: true or false, otherwise null (nothing to show).
    holder.waiver = tenant.waiver_text && p && p.id ? Boolean(await one(conn, ON_FILE, [tenantId, p.id, seasonFor(today)])) : null;
    // The welcome back at the gate (Track WINDOW, display only): the visit number this season and a birthday this week.
    holder.welcome = p && p.id && result === 'ok' ? await gateWelcome(conn, tenantId, p.id, today, tenant.timezone).catch(() => null) : null;
    if (!rule && p && p.kind === 'activity' && result === 'no_uses') rule = { reason: 'Already used. An activity ticket lets one guest in once.' };
    if (!rule && p && p.kind === 'activity' && (result === 'not_yet_valid' || result === 'expired')) rule = { reason: `This ticket is for ${String(t.valid_from).slice(0, 10)} only.` };
  }
  return {
    result,
    valid: result === 'ok',
    reason: rule ? rule.reason : null, // why it was refused, in words, when the plain result needs explaining
    holder,
    scanned_before: previous ? { at: previous.scanned_at, location: previous.location } : null,
    ticket: t ? { code: t.code, valid_from: t.valid_from, valid_to: t.valid_to, uses_remaining: t.uses_remaining } : null,
    card: card ? { id: card.id, uid: card.uid, label: card.label, status: card.status } : (uid ? { uid, status: 'not_registered' } : null),
    open_ms: tenant.gate_open_ms,
  };
}

/**
 * What an offline gate needs to decide alone for today: every chip and ticket that is good today, and the chips that
 * are blocked. Ticket codes are bearer credentials, so they are sent as keyed hashes, never as codes: the device hashes
 * the code it reads with the day's key and compares. Chip serials are readable from the card itself, so they are sent
 * as they are. No names, photos or contact details leave the server. The body changes only when the list does, so a
 * device that sends If-None-Match gets 304 Not Modified while nothing has changed.
 */
const LIST_HASH_CHARS = 32;
const listKey = (tenantId, day) => crypto.createHmac('sha256', `${config.kioskSecret}:gate-list`).update(`${tenantId}.${day}`).digest('hex');
const codeHash = (key, code) => crypto.createHmac('sha256', key).update(String(code).toUpperCase()).digest('hex').slice(0, LIST_HASH_CHARS);
async function allowlist(conn, tenantId, { attractionId = null } = {}) {
  const tenant = await one(conn, 'SELECT timezone, scan_passback_seconds FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const key = listKey(tenantId, today);
  // A lift gate gets no activity tickets. A gate at an attraction gets that attraction's activity tickets and the lift
  // tickets that include it. (Offline, a gate cannot check the time slot: that is checked when it is online.)
  const where = attractionId
    ? "AND ((p.kind = 'activity' AND p.attraction_id = ?) OR (p.kind <> 'activity' AND EXISTS (SELECT 1 FROM product_attractions pa WHERE pa.tenant_id = t.tenant_id AND pa.product_id = t.product_id AND pa.attraction_id = ?)))"
    : "AND p.kind <> 'activity'";
  const items = await rows(conn,
    `SELECT t.code, t.uses_remaining, c.uid
       FROM tickets t JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
       LEFT JOIN rfid_cards c ON c.tenant_id = t.tenant_id AND c.ticket_id = t.id AND c.status = 'assigned'
      WHERE t.tenant_id = ? AND t.status = 'active' AND t.valid_from <= ? AND t.valid_to >= ? AND (t.uses_remaining IS NULL OR t.uses_remaining > 0) ${where}
        AND NOT EXISTS (SELECT 1 FROM fair_blocks b WHERE b.tenant_id = t.tenant_id AND b.ticket_id = t.id AND b.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM payment_plans pp JOIN order_items oi ON oi.tenant_id = pp.tenant_id AND oi.order_id = pp.order_id WHERE pp.tenant_id = t.tenant_id AND oi.id = t.order_item_id AND pp.status = 'suspended')
      ORDER BY t.id`, [tenantId, today, today, ...(attractionId ? [attractionId, attractionId] : [])]);
  const blocked = await rows(conn, "SELECT uid FROM rfid_cards WHERE tenant_id = ? AND status IN ('lost','retired') ORDER BY uid", [tenantId]);
  return {
    date: today,
    passback_seconds: tenant.scan_passback_seconds,
    code_hash: { alg: 'HMAC-SHA256', key, hex_chars: LIST_HASH_CHARS, input: 'the ticket code in uppercase' },
    items: items.map((r) => ({ code_hash: codeHash(key, r.code), uid: r.uid || null, uses_remaining: r.uses_remaining })),
    blocked: blocked.map((r) => r.uid),
  };
}

module.exports = { uidCandidates, normUid, findCard, decide, allowlist, codeHash };
