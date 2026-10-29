'use strict';

// Gear coming back: shared by the contract check-in (Out now), the Returns tab's scan box and the season buyout, so a
// piece is returned by one set of rules. Only a contract with gear out takes returns: a paid rental still waiting to be
// fitted (to_fit) or a cancelled one has nothing to bring back.
const { rows, one } = require('../db');
const { notFound, conflict, bad } = require('./errors');
const R = require('./rentals');

const OPEN = ['out', 'overdue'];
const sqlTime = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v));

/** The contract, locked, if it has gear out. Call inside a transaction. */
async function lockOpen(conn, tenantId, contractId) {
  const contract = await one(conn, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, contractId]);
  if (!contract) throw notFound('Contract');
  if (contract.status === 'returned') throw conflict('Contract is already fully returned');
  if (!OPEN.includes(contract.status)) throw conflict(contract.status === 'to_fit' ? 'That rental has not been handed out yet' : `That contract is ${contract.status.replace('_', ' ')}`);
  return contract;
}

/**
 * Checks in some or all of the open lines on a locked contract. items: [{ rental_item_id, damage_notes?, lost?, fee_cents? }]
 * or null for everything still out. Damaged gear goes to service, lost gear is marked lost, a fee becomes a charge, and
 * when the last piece is back the contract closes and the shop's late fee is added. Returns { status, outstanding, fees, returned }.
 */
async function checkinLines(conn, tenantId, contract, items) {
  const contractId = contract.id;
  const open = await rows(conn, 'SELECT * FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? AND returned_at IS NULL', [tenantId, contractId]);
  const details = new Map((items || []).map((i) => [i.rental_item_id, i]));
  const returning = items ? open.filter((o) => details.has(o.rental_item_id)) : open;
  if (items && returning.length !== details.size) throw bad('One or more items are not outstanding on this contract');

  const fees = [];
  for (const line of returning) {
    const d = details.get(line.rental_item_id) || {};
    const newStatus = d.sold ? 'sold' : await R.returnStatus(conn, tenantId, line.rental_item_id, d.lost ? 'lost' : d.damage_notes ? 'maintenance' : 'available'); // held after a patrol case: to the shop
    await conn.query('UPDATE rental_contract_items SET returned_at = NOW(), damage_notes = ? WHERE id = ? AND tenant_id = ?', [d.damage_notes ?? (d.lost ? 'Lost' : null), line.id, tenantId]);
    await conn.query('UPDATE rental_items SET status = ? WHERE tenant_id = ? AND id = ?', [newStatus, tenantId, line.rental_item_id]);
    if (d.fee_cents > 0) {
      const kind = d.lost ? 'loss' : 'damage';
      const sku = (await one(conn, 'SELECT sku FROM rental_items WHERE tenant_id = ? AND id = ?', [tenantId, line.rental_item_id])).sku;
      await conn.query('INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note) VALUES (?, ?, ?, ?, ?)', [tenantId, contractId, kind, d.fee_cents, `${sku}${d.damage_notes ? `: ${d.damage_notes}` : ''}`.slice(0, 200)]);
      fees.push({ kind, cents: d.fee_cents });
    }
  }
  const remaining = open.length - returning.length;
  const finalStatus = remaining === 0 ? 'returned' : contract.status;
  if (remaining === 0) {
    await conn.query('UPDATE rental_contracts SET status = ?, checked_in_at = NOW() WHERE tenant_id = ? AND id = ?', [finalStatus, tenantId, contractId]);
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
    // A season rental bought out (every piece sold) is not late: the gear is the renter's now.
    const allSold = returning.length > 0 && returning.every((l) => (details.get(l.rental_item_id) || {}).sold);
    const late = allSold ? { cents: 0 } : R.lateFee(sqlTime(contract.due_at), await R.getSettings(conn, tenantId), tenant.timezone);
    if (late.cents > 0) {
      await conn.query("INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note) VALUES (?, ?, 'late', ?, ?)", [tenantId, contractId, late.cents, `${late.days} day${late.days === 1 ? '' : 's'} late`]);
      fees.push({ kind: 'late', cents: late.cents });
    }
  }
  return { status: finalStatus, outstanding: remaining, fees, returned: returning.map((r) => r.rental_item_id) };
}

/** A contract as the return screens show it: renter, due back, deposit, every piece (still out first) and fees due. */
async function contractView(conn, tenantId, contractId) {
  const c = await one(conn, `SELECT c.id, c.person_id, c.status, c.kind, c.due_at, c.checked_out_at, c.checked_in_at, c.group_name, c.group_id, c.deposit_cents,
      c.deposit_mode, c.deposit_status, c.deposit_card, p.first_name, p.last_name, p.phone
    FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.id = ?`, [tenantId, contractId]);
  if (!c) return null;
  c.items = await rows(conn, `SELECT l.id AS line_id, l.rental_item_id, l.returned_at, l.damage_notes, l.person_id, r.sku, r.category, r.brand, r.model, r.size, r.status AS item_status, r.cost_cents,
      pp.first_name AS user_first, pp.last_name AS user_last
    FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id
    LEFT JOIN people pp ON pp.id = l.person_id AND pp.tenant_id = l.tenant_id
    WHERE l.tenant_id = ? AND l.contract_id = ? AND l.swap_reason IS NULL ORDER BY (l.returned_at IS NOT NULL), l.id`, [tenantId, contractId]);
  c.charges = await rows(conn, "SELECT id, kind, cents, note, status FROM rental_charges WHERE tenant_id = ? AND contract_id = ? ORDER BY id", [tenantId, contractId]);
  c.deposit = await one(conn, "SELECT id, kind, status, amount_cents, card_brand, card_last4, expires_at, taken_cents FROM rental_deposits WHERE tenant_id = ? AND contract_id = ? AND status IN ('held','saved','captured','charged','released') ORDER BY id DESC LIMIT 1", [tenantId, contractId]);
  c.fees_due_cents = c.charges.filter((x) => x.status === 'due' && x.kind !== 'deposit').reduce((a, x) => a + Number(x.cents), 0);
  return c;
}

module.exports = { OPEN, lockOpen, checkinLines, contractView, sqlTime };
