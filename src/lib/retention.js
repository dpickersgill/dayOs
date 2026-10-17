'use strict';

// What is kept, and for how long (the daily job). Closed mountains go after their export window, old website requests
// after two years, ended sign-in sessions after a month, and finished demos. Each run is written to the audit trail.
const { pool } = require('../db');
const { trail } = require('./audit');

const LEAD_YEARS = 2;

async function runAll() {
  const out = { sessions: 0, challenges: 0, access_ended: 0, leads: 0, demos: 0, mountains: 0 };
  out.sessions = await require('./sessions').prune();
  out.challenges = await require('./challenges').prune();
  // Seasonal logins whose last day has passed: their sessions end now (signing in is already refused).
  const [ended] = await pool.query("UPDATE user_sessions s JOIN users u ON u.id = s.user_id SET s.ended_at = UTC_TIMESTAMP(), s.ended_why = 'access_ended' WHERE s.ended_at IS NULL AND u.access_ends_on IS NOT NULL AND u.access_ends_on < CURDATE()");
  out.access_ended = ended.affectedRows;
  // Operators' openings of a mountain that ran out are kept as history; nothing to delete.
  const [l] = await pool.query('DELETE FROM site_leads WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? YEAR)', [LEAD_YEARS]);
  out.leads = l.affectedRows;
  const S = require('./sandbox');
  out.demos = await S.purgeExpired();
  const [due] = await pool.query("SELECT id, slug FROM tenants WHERE status = 'suspended' AND delete_after IS NOT NULL AND delete_after <= CURDATE() AND sandbox_expires_at IS NULL");
  for (const t of due) {
    try {
      if (await S.purgeTenant(t.id, { closed: true })) {
        out.mountains += 1;
        await pool.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (?, ?, ?, ?)', [t.id, 'deleted_after_close', 'daily job', JSON.stringify({ slug: t.slug })]);
      }
    } catch (e) { console.error('Could not delete closed mountain', t.id, e.message); }
  }
  trail({ action: 'retention_run', actor: 'daily job', detail: JSON.stringify(out) });
  return out;
}

module.exports = { runAll, LEAD_YEARS };
