'use strict';

// Gate decisions: one rule for every way a ticket is shown. A barcode (the ticket's own code), an RFID card (its chip
// serial, looked up to the ticket it carries), a hardware gate asking online, or a gate that decided offline and
// reports later. Every scan is logged, with the card and the device when there was one.

const { one, rows } = require('../db');
const { todayIn, seasonFor } = require('./util');
const { ON_FILE } = require('./waivers');

/**
 * The ways one chip serial can arrive. Readers differ: phones give "04:A2:3B:..", desk readers type hex or a decimal
 * number, and some decimal readers reverse the byte order. Cards are stored as plain uppercase hex, so every reading
 * of the same chip maps to a short list of hex forms to look up.
 */
function uidCandidates(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/[\s:.-]/g, '');
  const out = new Set();
  if (/^[0-9A-F]{8,32}$/.test(s)) out.add(s);
  if (/^\d{6,20}$/.test(s)) {
    let hex = BigInt(s).toString(16).toUpperCase();
    if (hex.length % 2) hex = `0${hex}`;
    while (hex.length < 8) hex = `00${hex}`;
    if (hex.length <= 32) {
      out.add(hex);
      out.add(hex.match(/../g).reverse().join(''));
    }
  }
  return [...out];
}

/** The form a card is saved under: hex as given, or the first reading of a decimal number. Null when it is not a chip serial. */
function normUid(raw) {
  return uidCandidates(raw)[0] || null;
}

const looksLikeTicketCode = (s) => /^[0-9A-F]{20}$/.test(s);

/**
 * Decide and log one scan, inside the caller's transaction.
 * input: { code?, uid?, location?, override?, deviceId?, clientRef?, via }
 * A code that is not a ticket is tried as a card serial, so a desk RFID reader that types into the scan box just works.
 */
async function decide(conn, tenantId, input) {
  const tenant = await one(conn, 'SELECT timezone, scan_passback_seconds, waiver_text, gate_open_ms FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const raw = String(input.code || input.uid || '').trim().toUpperCase();
  let t = null; let card = null; let uid = null; let via = input.via || 'code';

  if (input.code && !input.uid) {
    const code = raw.replace(/[\s-]/g, '');
    t = await one(conn, 'SELECT * FROM tickets WHERE tenant_id = ? AND code = ? FOR UPDATE', [tenantId, code]);
  }
  if (!t) {
    const cands = uidCandidates(raw);
    if (cands.length) {
      card = await one(conn, 'SELECT * FROM rfid_cards WHERE tenant_id = ? AND uid IN (?) ORDER BY FIELD(status, \'assigned\', \'lost\', \'retired\', \'free\') LIMIT 1 FOR UPDATE', [tenantId, cands]);
      if (card) {
        uid = card.uid;
        if (via === 'code') via = 'rfid';
        if (card.ticket_id && card.status === 'assigned') t = await one(conn, 'SELECT * FROM tickets WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, card.ticket_id]);
      } else if (!looksLikeTicketCode(raw.replace(/[\s-]/g, ''))) uid = cands[0];
    }
  }

  let result = 'ok';
  let previous = null;
  if (card && (card.status === 'lost' || card.status === 'retired')) result = 'card_blocked';
  else if (!t) result = 'unknown';
  else if (t.status === 'void') result = 'void';
  else if (t.status === 'used_up' || (t.uses_remaining !== null && t.uses_remaining < 1)) result = 'no_uses';
  else if (today < t.valid_from) result = 'not_yet_valid';
  else if (today > t.valid_to) result = 'expired';
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
    const p = await one(conn, 'SELECT p.id, p.first_name, p.last_name, p.photo, pr.name AS product, pr.kind FROM tickets k JOIN products pr ON pr.id = k.product_id AND pr.tenant_id = k.tenant_id LEFT JOIN people p ON p.id = k.person_id AND p.tenant_id = k.tenant_id WHERE k.tenant_id = ? AND k.id = ?', [tenantId, t.id]);
    holder = { name: p && p.first_name ? `${p.first_name} ${p.last_name}` : null, first_name: p ? p.first_name || null : null, photo: p ? p.photo || null : null, product: p ? p.product : null, kind: p ? p.kind : null };
    // Only when the mountain uses waivers and the ticket has a named holder: true or false, otherwise null (nothing to show).
    holder.waiver = tenant.waiver_text && p && p.id ? Boolean(await one(conn, ON_FILE, [tenantId, p.id, seasonFor(today)])) : null;
  }
  return {
    result,
    valid: result === 'ok',
    holder,
    scanned_before: previous ? { at: previous.scanned_at, location: previous.location } : null,
    ticket: t ? { code: t.code, valid_from: t.valid_from, valid_to: t.valid_to, uses_remaining: t.uses_remaining } : null,
    card: card ? { id: card.id, uid: card.uid, label: card.label, status: card.status } : (uid ? { uid, status: 'not_registered' } : null),
    open_ms: tenant.gate_open_ms,
  };
}

/**
 * What an offline gate needs to decide alone for today: every chip and code that is good today, and the chips that are
 * blocked. No names, photos or contact details leave the server.
 */
async function allowlist(conn, tenantId) {
  const tenant = await one(conn, 'SELECT timezone, scan_passback_seconds FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const items = await rows(conn,
    `SELECT t.code, t.uses_remaining, t.valid_to, c.uid
       FROM tickets t LEFT JOIN rfid_cards c ON c.tenant_id = t.tenant_id AND c.ticket_id = t.id AND c.status = 'assigned'
      WHERE t.tenant_id = ? AND t.status = 'active' AND t.valid_from <= ? AND t.valid_to >= ? AND (t.uses_remaining IS NULL OR t.uses_remaining > 0)
      ORDER BY t.id`, [tenantId, today, today]);
  const blocked = await rows(conn, "SELECT uid FROM rfid_cards WHERE tenant_id = ? AND status IN ('lost','retired') ORDER BY uid", [tenantId]);
  return {
    date: today,
    passback_seconds: tenant.scan_passback_seconds,
    items: items.map((r) => ({ code: r.code, uid: r.uid || null, uses_remaining: r.uses_remaining })),
    blocked: blocked.map((r) => r.uid),
  };
}

module.exports = { uidCandidates, normUid, decide, allowlist };
