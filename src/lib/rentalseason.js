'use strict';

// Season rentals: the daily job emails each season renter once in March (the gear is due back soon), and once more
// when the gear is overdue. reminded_at on the contract records the last one sent: a reminder sent before the due date
// leaves room for the overdue one, and the overdue one (sent after the due date) is the last. Claimed before sending,
// so two runs never send twice; put back when the email could not be sent, so the next run tries again.
const { pool, rows } = require('../db');
const mailer = require('./mailer');
const { todayIn, nowIn } = require('./util');
const { logFailure } = require('./jobs');

const longDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${String(d).slice(0, 10)}T12:00:00Z`));

/** opts.today: a YYYY-MM-DD to act as today (tests only); otherwise each mountain's own today. */
async function remindAll(opts = {}) {
  if (!mailer.enabled()) return { skipped: 'email is not set up' };
  const tenants = await rows(pool, `SELECT DISTINCT t.id, t.name, t.phone, t.timezone FROM rental_contracts c JOIN tenants t ON t.id = c.tenant_id
    WHERE t.status = 'active' AND c.kind = 'season' AND c.status IN ('out','overdue')`);
  const out = { march: 0, overdue: 0, failed: 0 };
  for (const t of tenants) {
    const today = opts.today || todayIn(t.timezone);
    const now = nowIn(t.timezone);
    const march = today.slice(5, 7) === '03';
    const due = await rows(pool, `SELECT c.id, c.due_at, c.reminded_at, p.first_name, p.email,
        (SELECT GROUP_CONCAT(r.sku ORDER BY r.sku SEPARATOR ', ') FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id
          WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND l.returned_at IS NULL) AS tags
      FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
      WHERE c.tenant_id = ? AND c.kind = 'season' AND c.status IN ('out','overdue') AND p.email IS NOT NULL AND p.email <> ''
        AND ((c.due_at < ? AND (c.reminded_at IS NULL OR c.reminded_at <= c.due_at)) OR (? AND c.due_at >= ? AND c.reminded_at IS NULL))`, [t.id, now, march ? 1 : 0, now]);
    for (const c of due) {
      const overdue = String(c.due_at) < now;
      const [claim] = await pool.query('UPDATE rental_contracts SET reminded_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND reminded_at <=> ?', [t.id, c.id, c.reminded_at]);
      if (!claim.affectedRows) continue;
      const text = [`Hi ${c.first_name},`, '',
        overdue ? `Your season rental from ${t.name} was due back on ${longDay(c.due_at)}. Please bring it back as soon as you can.` : `Your season rental from ${t.name} is due back by ${longDay(c.due_at)}.`,
        c.tags ? `Gear: ${c.tags}.` : '',
        overdue ? 'If you would like to keep the gear, ask the rental shop about buying it.' : 'Bring everything to the rental shop. If you would like to keep the gear, ask the shop about buying it.',
        '', t.phone ? `Questions? Call ${t.phone}.` : '', t.name].filter((x, i, a) => x || (a[i - 1] && a[i - 1] !== '')).join('\n');
      const r = await mailer.send({ tenantId: t.id, to: c.email, fromName: t.name, subject: overdue ? 'Your season rental is overdue' : 'Your season rental is due back soon', text, tag: 'rental-season' }).catch((err) => ({ ok: false, error: err.message }));
      if (r.ok) out[overdue ? 'overdue' : 'march'] += 1;
      else {
        out.failed += 1;
        await pool.query('UPDATE rental_contracts SET reminded_at = ? WHERE tenant_id = ? AND id = ?', [c.reminded_at, t.id, c.id]);
        logFailure({ job: 'rental_season_reminders', tenant: t.id, contract: c.id, message: r.error });
      }
    }
  }
  return out;
}

module.exports = { remindAll };
