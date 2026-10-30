'use strict';
// What the confirmation and the morning-of message say about arriving (account_settings, one row per mountain): where to
// park, where to go first, and when the morning-of message goes (default 7:00 AM mountain time). A mountain with no row
// gets the defaults. Also today's conditions in a few words, from the data the app keeps (calendar, snow, lifts).
const { one } = require('../db');
const { z } = require('./util');

const DEFAULTS = {
  park_text: 'Park in the main lot and walk to the base lodge.',
  first_text: 'With your ticket on your phone, go straight to the lift. No stop at the window.',
  morning_on: 1, morning_time: '07:00',
};
const schema = z.object({
  park_text: z.string().trim().max(300).nullable(), first_text: z.string().trim().max(300).nullable(),
  morning_on: z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0)),
  morning_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 07:00'),
}).partial();

async function get(db, tenantId) {
  const r = await one(db, 'SELECT park_text, first_text, morning_on, morning_time FROM account_settings WHERE tenant_id = ?', [tenantId]);
  const out = { ...DEFAULTS };
  if (r) for (const k of Object.keys(DEFAULTS)) if (r[k] !== null && r[k] !== undefined && r[k] !== '') out[k] = r[k];
  out.morning_on = Number(out.morning_on);
  return out;
}
async function save(conn, tenantId, f) {
  const keys = Object.keys(f).filter((k) => k in DEFAULTS);
  if (!keys.length) return;
  await conn.query(`INSERT INTO account_settings (tenant_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(', ')}`, [tenantId, ...keys.map((k) => f[k])]);
}

const hm = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

/** Today's conditions: { lifts_open, lifts_total, new_snow_in, base_in, status, open_time, words } or null when there is nothing. */
async function conditions(db, tenantId, day) {
  const [cal, snow, lifts] = await Promise.all([
    one(db, 'SELECT status, open_time, close_time FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [tenantId, day]),
    one(db, 'SELECT base_in, new_snow_in FROM snow_readings WHERE tenant_id = ? ORDER BY read_at DESC LIMIT 1', [tenantId]),
    one(db, "SELECT COUNT(*) AS total, SUM(status = 'open') AS open FROM lifts WHERE tenant_id = ?", [tenantId]),
  ]);
  const c = { status: cal ? cal.status : null, open_time: cal ? cal.open_time : null, base_in: snow ? snow.base_in : null, new_snow_in: snow ? Number(snow.new_snow_in || 0) : null,
    lifts_open: Number(lifts.total) ? Number(lifts.open || 0) : null, lifts_total: Number(lifts.total) };
  const bits = [];
  if (c.status === 'closed') bits.push('closed today');
  else {
    if (c.lifts_open !== null) bits.push(`${c.lifts_open} ${c.lifts_open === 1 ? 'lift' : 'lifts'} open`);
    if (c.new_snow_in) bits.push(`${c.new_snow_in} new ${c.new_snow_in === 1 ? 'inch' : 'inches'}`);
    if (c.open_time) bits.push(`first chair ${hm(c.open_time)}`);
  }
  c.words = bits.join(', ');
  return bits.length ? c : null;
}

module.exports = { DEFAULTS, schema, get, save, conditions, hm };
