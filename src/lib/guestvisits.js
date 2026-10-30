'use strict';
// How often a guest comes: the days they skied (a good gate scan on their ticket or pass), had a lesson or rented, by
// season. Shared by the welcome-back card, loyalty and birthdays (who is a past guest), recaps and the reports.
const { one, rows } = require('../db');
const { seasonFor } = require('./util');

/** Season label for a day, the way the rest of the app writes it: '2026-27'. */
const seasonOf = (day) => seasonFor(day);
/** The first and last day of a season label, as dates (Aug 1 to Jul 31). */
function seasonRange(label) {
  const start = Number(String(label).slice(0, 4));
  return [`${start}-08-01`, `${start + 1}-07-31`];
}

/**
 * The days a person was here in a date range (mountain-local days), newest first: a good scan on their ticket, a lesson
 * attended or booked, a rental handed out. Scans are stored in UTC; tz is the mountain's time zone.
 */
async function daysHere(db, tenantId, personId, from, to, tz = 'America/New_York') {
  const r = await rows(db, `SELECT d FROM (
      SELECT DATE(CONVERT_TZ(s.scanned_at, '+00:00', ?)) AS d FROM scans s JOIN tickets t ON t.tenant_id = s.tenant_id AND t.id = s.ticket_id
        WHERE s.tenant_id = ? AND t.person_id = ? AND s.result = 'ok'
      UNION SELECT DATE(ls.starts_at) FROM lesson_bookings b JOIN lesson_sessions ls ON ls.tenant_id = b.tenant_id AND ls.id = b.session_id
        WHERE b.tenant_id = ? AND b.person_id = ? AND b.status = 'attended'
      UNION SELECT DATE(rc.checked_out_at) FROM rental_contracts rc
        WHERE rc.tenant_id = ? AND rc.person_id = ? AND rc.status IN ('out','returned','overdue')
    ) x WHERE d BETWEEN ? AND ? ORDER BY d DESC`, [tz, tenantId, personId, tenantId, personId, tenantId, personId, from, to]);
  return r.map((x) => (x.d instanceof Date ? x.d.toISOString().slice(0, 10) : String(x.d).slice(0, 10)));
}

/** { this_season, last_season, total, first_day, last_day } for a person, with seasons by the given day. */
async function summary(db, tenantId, personId, day, tz) {
  const label = seasonOf(day);
  const [from] = seasonRange(label);
  const prevLabel = seasonOf(`${Number(label.slice(0, 4)) - 1}-12-01`);
  const [pFrom, pTo] = seasonRange(prevLabel);
  const all = await daysHere(db, tenantId, personId, '2000-01-01', day, tz);
  return {
    this_season: all.filter((d) => d >= from).length,
    last_season: all.filter((d) => d >= pFrom && d <= pTo).length,
    total: all.length,
    first_day: all.length ? all[all.length - 1] : null,
    last_day: all.length ? all[0] : null,
  };
}

/** A past guest: here this season or last, or holding a season pass for either. */
async function isPastGuest(db, tenantId, personId, day, tz) {
  const s = await summary(db, tenantId, personId, day, tz);
  if (s.this_season || s.last_season) return true;
  const label = seasonOf(day);
  const [, to] = seasonRange(label);
  const prevStart = `${Number(label.slice(0, 4)) - 1}-08-01`;
  return Boolean(await one(db, `SELECT t.id FROM tickets t JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
    WHERE t.tenant_id = ? AND t.person_id = ? AND p.kind = 'season_pass' AND t.status <> 'void' AND t.valid_to >= ? AND t.valid_from <= ? LIMIT 1`, [tenantId, personId, prevStart, to]));
}

module.exports = { seasonOf, seasonRange, daysHere, summary, isPastGuest };
