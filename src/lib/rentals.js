'use strict';

// Shared by the counter's Rentals screen and the Sell basket, so gear is checked out by one set of rules.
const { rows, one } = require('../db');
const { z, nowIn } = require('./util');
const { notFound, conflict, bad } = require('./errors');

const CATEGORIES = ['ski', 'snowboard', 'boot', 'helmet', 'pole', 'other'];
const TIERS = ['standard', 'performance'];

/** One piece of gear on a contract: which item, who uses it, and (for skis) the binding record. */
const gearLine = z.object({
  rental_item_id: z.number().int().positive(),
  person_id: z.number().int().positive().optional(),
  din_setting: z.number().min(0.5).max(20).optional(),
  boot_sole_mm: z.number().int().min(150).max(400).optional(),
  skier_type: z.string().max(4).optional(),
  tech_name: z.string().max(100).optional(),
  test_result: z.enum(['pass', 'fail']).optional(),
});

const DEFAULTS = { late_fee_cents_per_day: 0, late_grace_minutes: 60, require_binding_record: 0, service_every_uses: 0, default_deposit_cents: 0, hold_until_hour: 12, hold_after_incident: 1 };

async function getSettings(conn, tenantId) {
  const r = await one(conn, 'SELECT * FROM rental_settings WHERE tenant_id = ?', [tenantId]);
  return { ...DEFAULTS, ...(r || {}), require_binding_record: Boolean(r && r.require_binding_record), hold_after_incident: r ? Boolean(Number(r.hold_after_incident)) : true };
}

/**
 * Locks the gear, checks it is free, applies the shop's binding-record rule, writes the contract lines and marks the gear rented.
 * Returns the locked item rows. Call inside a transaction.
 */
async function insertGear(conn, tenantId, contractId, gear, settings) {
  const ids = gear.map((g) => g.rental_item_id);
  if (new Set(ids).size !== ids.length) throw bad('The same rental item was chosen twice');
  const locked = await rows(conn, 'SELECT id, sku, status, category FROM rental_items WHERE tenant_id = ? AND id IN (?) FOR UPDATE', [tenantId, ids]);
  if (locked.length !== ids.length) throw notFound('One or more rental items');
  const unavailable = locked.filter((r) => r.status !== 'available');
  if (unavailable.length) throw conflict('Some gear is not available', unavailable.map((u) => ({ sku: u.sku, status: u.status })));
  const byId = new Map(locked.map((l) => [l.id, l]));
  for (const g of gear) {
    const item = byId.get(g.rental_item_id);
    if (g.test_result === 'fail') throw bad(`${item.sku} failed its binding test, so it cannot go out`);
    if (settings.require_binding_record && item.category === 'ski' && (g.din_setting == null || !g.tech_name)) {
      throw bad(`Record the binding setting and who set it for ${item.sku}`);
    }
    if (g.person_id) {
      const ok = await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, g.person_id]);
      if (!ok) throw notFound('Person');
    }
    await conn.query(
      `INSERT INTO rental_contract_items (tenant_id, contract_id, rental_item_id, person_id, din_setting, boot_sole_mm, skier_type, tech_name, set_at, test_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, contractId, g.rental_item_id, g.person_id ?? null, g.din_setting ?? null, g.boot_sole_mm ?? null, g.skier_type ?? null, g.tech_name ?? null, g.din_setting != null ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, g.test_result ?? null],
    );
  }
  await conn.query("UPDATE rental_items SET status = 'rented', uses_count = uses_count + 1 WHERE tenant_id = ? AND id IN (?)", [tenantId, ids]);
  return locked;
}

/** Whole days late after the grace period, times the shop's daily late fee. */
function lateFee(dueAt, settings, timeZone) {
  if (!settings.late_fee_cents_per_day) return { days: 0, cents: 0 };
  const ms = (s) => Date.parse(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);
  const late = Math.floor((ms(nowIn(timeZone)) - ms(dueAt)) / 60000) - settings.late_grace_minutes;
  if (late <= 0) return { days: 0, cents: 0 };
  const days = Math.ceil(late / 1440);
  return { days, cents: days * settings.late_fee_cents_per_day };
}

/**
 * The open patrol hold on a rental item, if any: gear involved in a patrol case waits for the shop's inspection before it
 * goes back on the rack. Returns { id, incident_id, case_number } or null.
 */
async function patrolHold(conn, tenantId, itemId) {
  const [[r]] = await conn.query(`SELECT r.id, r.incident_id, CONCAT(i.season, '-', LPAD(i.seq, 4, '0')) AS case_number FROM incident_rentals r JOIN incidents i ON i.tenant_id = r.tenant_id AND i.id = r.incident_id
    WHERE r.tenant_id = ? AND r.rental_item_id = ? AND r.held = 1 AND r.released_at IS NULL ORDER BY r.id DESC LIMIT 1`, [tenantId, itemId]);
  return r || null;
}
/** The status gear goes to when it comes back: a patrol hold sends it to the shop instead of the rack. */
async function returnStatus(conn, tenantId, itemId, wanted) {
  return wanted === 'available' && (await patrolHold(conn, tenantId, itemId)) ? 'maintenance' : wanted;
}

module.exports = { CATEGORIES, TIERS, gearLine, getSettings, insertGear, lateFee, patrolHold, returnStatus };
