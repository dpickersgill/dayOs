'use strict';

// Partner passes: a pass sold by someone else that gets its holder days here, such as the Indy Pass or a neighbor's
// reciprocal pass. The mountain sets the rules once (free days a season, then a number of days at a discount, blackout
// dates for levels that have them, a daily limit, whether ID is checked), and every visit is a redemption tied to an
// ordinary $0 or discounted day ticket, so the gate, RFID cards, refunds and reports work as for any ticket.
//
// A redemption counts while it is active and its ticket's line has not been refunded. Refunding the ticket, or a
// manager voiding the redemption, gives the day back.
//
// Indy Pass's own records are kept by Indy: staff still record each visit there as Indy asks. The redemption report
// here is what the mountain checks Indy's statement against.

const { one, rows } = require('../db');
const { bad, conflict, notFound } = require('./errors');
const { seasonFor } = require('./util');

const DEFAULT_LEVELS = [{ key: 'base', label: 'Base', blackouts: true }, { key: 'plus', label: 'Plus', blackouts: false }];
// The Indy Pass as it worked for 2025-26: two free days, then one day at 25% off; Base has blackout dates, Indy+ does not.
const INDY = { name: 'Indy Pass', number_label: 'Indy customer number', free_days: 2, discount_days: 1, discount_percent: 25, id_check: 1,
  levels: [{ key: 'base', label: 'Indy Base', blackouts: true }, { key: 'plus', label: 'Indy+', blackouts: false }],
  staff_note: 'Check photo ID against the name on the Indy account, and record the visit in Indy as Indy asks.' };

/** A pass number as typed: spaces and dashes dropped, capitals, up to 40 characters. */
const cleanNumber = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '').slice(0, 40);

function levelsOf(p) {
  let l = null;
  try { l = JSON.parse(p.levels || 'null'); } catch (_) { l = null; }
  return Array.isArray(l) && l.length ? l : DEFAULT_LEVELS;
}

function shape(p) {
  return { ...p, levels: levelsOf(p), id_check: Boolean(p.id_check), online: Boolean(p.online), reservation_required: Boolean(p.reservation_required), active: Boolean(p.active) };
}

/** Redemptions that still count: active, and their ticket line not refunded. */
const COUNTS = `r.status = 'active' AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.tenant_id = r.tenant_id AND oi.id = r.order_item_id AND oi.refunded_at IS NOT NULL)`;

/**
 * What a pass holder gets on a day, or why not. Throws a 409 with a plain reason when the day cannot be redeemed.
 * Returns { program, level, kind: 'free'|'discount', percent, used: { free, discount }, history }.
 * With lock, the program row is locked first so two windows cannot give the same pass the same day at once.
 */
async function check(conn, tenantId, programId, { number, level, date, lock = false }) {
  const program = await one(conn, `SELECT * FROM partner_programs WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, programId]);
  if (!program) throw notFound('Partner pass');
  if (!program.active) throw conflict(`${program.name} is switched off here`);
  const num = cleanNumber(number);
  if (num.length < 3) throw bad(`Enter the ${program.number_label.toLowerCase()}`);
  const levels = levelsOf(program);
  const lv = levels.find((x) => x.key === level) || (levels.length === 1 ? levels[0] : null);
  if (!lv) throw bad(`Choose which ${program.name} it is: ${levels.map((x) => x.label).join(' or ')}`);
  if (lv.blackouts && await one(conn, 'SELECT 1 AS x FROM partner_blackouts WHERE tenant_id = ? AND program_id = ? AND on_date = ?', [tenantId, program.id, date])) {
    throw conflict(`${date} is a blackout date for ${lv.label}`);
  }
  const season = seasonFor(date);
  const history = await rows(conn, `SELECT r.id, r.on_date, r.kind, r.charged_cents, r.channel FROM partner_redemptions r
    WHERE r.tenant_id = ? AND r.program_id = ? AND r.number = ? AND r.season = ? AND ${COUNTS} ORDER BY r.on_date`, [tenantId, program.id, num, season]);
  if (history.some((h) => String(h.on_date).slice(0, 10) === date)) throw conflict(`This pass already has ${date} here`);
  const used = { free: history.filter((h) => h.kind === 'free').length, discount: history.filter((h) => h.kind === 'discount').length };
  let kind = null; let percent = 0;
  if (used.free < program.free_days) kind = 'free';
  else if (used.discount < program.discount_days) { kind = 'discount'; percent = program.discount_percent; }
  if (!kind) throw conflict(`This pass has used its ${program.free_days + program.discount_days} ${program.name} days here this season`, { used, history });
  if (program.daily_limit !== null) {
    const [[d]] = await conn.query(`SELECT COUNT(*) AS n FROM partner_redemptions r WHERE r.tenant_id = ? AND r.program_id = ? AND r.on_date = ? AND ${COUNTS}`, [tenantId, program.id, date]);
    if (Number(d.n) >= program.daily_limit) throw conflict(`${program.name} is full on ${date} (${program.daily_limit} a day)`);
  }
  return { program, level: lv, number: num, season, kind, percent, used, history };
}

/** The price for a redemption: free, or the day's window price less the discount (rounded to the cent). */
const chargeFor = (windowCents, c) => (c.kind === 'free' ? 0 : Math.round((windowCents * (100 - c.percent)) / 100));

async function record(conn, tenantId, c, { date, windowCents, chargedCents, personId, orderId, itemId, ticketId, channel, idChecked, userId }) {
  const [r] = await conn.query(`INSERT INTO partner_redemptions (tenant_id, program_id, number, level, season, on_date, kind, percent_off, window_cents, charged_cents, person_id, order_id, order_item_id, ticket_id, channel, id_checked, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [tenantId, c.program.id, c.number, c.level.key, c.season, date, c.kind, c.percent, windowCents, chargedCents, personId ?? null, orderId ?? null, itemId ?? null, ticketId ?? null, channel || 'window', idChecked ? 1 : 0, userId ?? null]);
  return r.insertId;
}

module.exports = { INDY, DEFAULT_LEVELS, COUNTS, cleanNumber, levelsOf, shape, check, chargeFor, record };
