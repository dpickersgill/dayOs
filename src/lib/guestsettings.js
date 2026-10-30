'use strict';
// A mountain's guest settings (guest_settings, one row per mountain): birthdays and loyalty, recaps, the fair pricing
// promises, payment plans and the counter's refund limit. A mountain with no row gets the defaults.
const { one } = require('../db');
const { z } = require('./util');

const DEFAULTS = {
  season_opens_on: null,
  birthday_on: 1, birthday_ticket_product_id: null, birthday_percent: null, birthday_credit_cents: null, birthday_window: 'week',
  recap_day_on: 1, recap_season_on: 1, milestones_on: 0, firsttimer_on: 0, loyalty_every_n: null, loyalty_top_n: null,
  walkup_cap_on: 0, walkup_cap_cents: null, price_promise_on: 0, closure_credit_on: 0, conditions_guarantee_on: 0, conditions_hours: 2,
  plans_on: 0, plans_count: 3, autorenew_on: 0,
  counter_refund_limit_cents: 0,
};
const bool = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0));
const cents = z.number().int().min(0).max(10_000_000).nullable();
const schema = z.object({
  season_opens_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  birthday_on: bool, birthday_ticket_product_id: z.number().int().positive().nullable(), birthday_percent: z.number().int().min(1).max(100).nullable(),
  birthday_credit_cents: cents, birthday_window: z.enum(['week', 'month']),
  recap_day_on: bool, recap_season_on: bool, milestones_on: bool, firsttimer_on: bool,
  loyalty_every_n: z.number().int().min(2).max(50).nullable(), loyalty_top_n: z.number().int().min(5).max(1000).nullable(),
  walkup_cap_on: bool, walkup_cap_cents: cents, price_promise_on: bool, closure_credit_on: bool, conditions_guarantee_on: bool,
  conditions_hours: z.number().int().min(1).max(8), plans_on: bool, plans_count: z.number().int().min(2).max(6), autorenew_on: bool,
  counter_refund_limit_cents: z.number().int().min(0).max(10_000_000),
}).partial();

async function get(db, tenantId) {
  const row = await one(db, 'SELECT * FROM guest_settings WHERE tenant_id = ?', [tenantId]);
  const out = { ...DEFAULTS };
  if (row) for (const k of Object.keys(DEFAULTS)) if (row[k] !== undefined) out[k] = row[k];
  if (out.season_opens_on instanceof Date) out.season_opens_on = out.season_opens_on.toISOString().slice(0, 10);
  return out;
}
async function save(conn, tenantId, fields) {
  const keys = Object.keys(fields).filter((k) => k in DEFAULTS);
  if (!keys.length) return;
  await conn.query(`INSERT INTO guest_settings (tenant_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(', ')}`, [tenantId, ...keys.map((k) => fields[k])]);
}
module.exports = { DEFAULTS, schema, get, save };
