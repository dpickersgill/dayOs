'use strict';

// What is kept, and for how long (the daily job). Old website requests go after two years, ended sign-in sessions after
// a month, and finished demos. Each run is written to the audit trail.
//
// A real mountain that has closed is never deleted by the job. Once its export window passes, the job marks it due for
// deletion and tells the operator (the console's history and its list of mountains). Deleting it is then a deliberate
// operator action (deleteClosed below) that is refused while any case is on legal hold, needs the owner's export recorded,
// runs in one transaction, and keeps the records the mountain must still be able to produce: patrol reports, signed
// waivers, the audit trail, and the OSHA injury log until five years after its year.
const { pool } = require('../db');
const { trail } = require('./audit');

const LEAD_YEARS = 2;
// OSHA (29 CFR 1904.33): the 300 log, the 300A summary and the 301 forms are kept five years after the end of their year.
const OSHA_YEARS = 5;

// Kept when a closed mountain's data is deleted. Patrol reports and everything filed with them (incident_* covers the
// patients, care, statements, photos, frozen versions and signatures), what was released to whom, signed waivers and the
// wording signed, and the audit trail that shows who saw a record. No retention runs out for these on its own.
const KEEP = new Set(['incidents', 'patrol_scenes', 'patrol_witness_links', 'patrol_records_requests', 'claim_shares', 'claim_share_views',
  'waivers', 'waiver_signings', 'waiver_texts', 'audit_log']);
const kept = (name) => KEEP.has(name) || name.startsWith('incident_');
// Kept until OSHA's five years after the year are over, then deleted by the next deletion run.
const OSHA = ['staff_injuries', 'staff_injury_years'];
// Rows the kept records name (the patient or signer, the responder, the trail): only those rows are kept.
const NAMED = {
  people: [['waivers', 'person_id'], ['waivers', 'signed_by_person_id'], ['waiver_signings', 'signer_person_id'], ['incident_patients', 'person_id'], ['incidents', 'person_id'], ['users', 'person_id']],
  staff: [['incident_responders', 'staff_id'], ['staff_injuries', 'staff_id'], ['users', 'staff_id']],
  trails: [['incidents', 'trail_id']],
  lifts: [['incidents', 'lift_id']],
  attractions: [['incidents', 'attraction_id']],
};
// Logins are kept (switched off) because the records name who wrote, signed and approved them; what lets anyone sign in goes.

/** Closed real mountains whose export window has passed: marked due for deletion once, with a note in the console's history. */
async function markDue() {
  const [due] = await pool.query(`SELECT t.id, t.slug, (SELECT COUNT(*) FROM incidents i WHERE i.tenant_id = t.id AND i.legal_hold = 1) AS holds FROM tenants t
    WHERE t.status = 'suspended' AND t.closed_at IS NOT NULL AND t.delete_after IS NOT NULL AND t.delete_after <= CURDATE()
      AND t.sandbox_expires_at IS NULL AND t.delete_due_at IS NULL AND t.data_deleted_at IS NULL`);
  for (const t of due) {
    await pool.query('UPDATE tenants SET delete_due_at = UTC_TIMESTAMP() WHERE id = ? AND delete_due_at IS NULL', [t.id]);
    await pool.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (?, ?, ?, ?)', [t.id, 'due_for_deletion', 'daily job', JSON.stringify({ slug: t.slug, legal_holds: Number(t.holds) })]);
  }
  return due.length;
}

async function runAll() {
  const out = { sessions: 0, challenges: 0, access_ended: 0, leads: 0, demos: 0, due_for_deletion: 0 };
  out.sessions = await require('./sessions').prune();
  out.challenges = await require('./challenges').prune();
  // Seasonal logins whose last day has passed: their sessions end now (signing in is already refused).
  const [ended] = await pool.query("UPDATE user_sessions s JOIN users u ON u.id = s.user_id SET s.ended_at = UTC_TIMESTAMP(), s.ended_why = 'access_ended' WHERE s.ended_at IS NULL AND u.access_ends_on IS NOT NULL AND u.access_ends_on < CURDATE()");
  out.access_ended = ended.affectedRows;
  // Operators' openings of a mountain that ran out are kept as history; nothing to delete.
  const [l] = await pool.query('DELETE FROM site_leads WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? YEAR)', [LEAD_YEARS]);
  out.leads = l.affectedRows;
  out.demos = await require('./sandbox').purgeExpired();
  out.due_for_deletion = await markDue();
  trail({ action: 'retention_run', actor: 'daily job', detail: JSON.stringify(out) });
  return out;
}

class Refused extends Error {}

/**
 * Deletes a closed real mountain's data, keeping its records (see KEEP, OSHA and NAMED above). Only after its export
 * window; refused while any case is on legal hold. Everything happens in one transaction: it finishes or nothing changes.
 * Safe to run again later: a second run deletes OSHA rows whose five years have passed. `record(conn)` writes the
 * console's history inside the same transaction. Returns { deleted: rows removed, kept: { table: rows } }.
 */
async function deleteClosed(id, record) {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0'); // tables are emptied in any order; the kept rows keep their ids
    await conn.beginTransaction();
    try {
      const [[t]] = await conn.query(`SELECT id, slug FROM tenants WHERE id = ? AND status = 'suspended' AND closed_at IS NOT NULL
        AND delete_after IS NOT NULL AND delete_after <= CURDATE() AND sandbox_expires_at IS NULL FOR UPDATE`, [id]);
      if (!t) throw new Refused('Only a closed mountain whose export window has passed can be deleted.');
      const [[h]] = await conn.query('SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND legal_hold = 1 FOR UPDATE', [id]);
      if (Number(h.n)) throw new Refused(`${h.n} patrol case${Number(h.n) === 1 ? ' is' : 's are'} on legal hold. Nothing is deleted until every hold is lifted.`);
      const [tables] = await conn.query(
        `SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
         WHERE c.table_schema = DATABASE() AND c.column_name = 'tenant_id' AND x.table_type = 'BASE TABLE' AND c.table_name NOT IN ('tenants', 'sandbox_signups', 'platform_audit', 'users')`,
      );
      const q = (n) => '`' + String(n).replace(/`/g, '') + '`';
      let deleted = 0;
      const del = async (sql, params) => { const [r] = await conn.query(sql, params); deleted += r.affectedRows; };
      await del('DELETE FROM user_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)', [id]);
      for (const { t: name } of tables) {
        if (kept(name)) continue;
        if (OSHA.includes(name)) { await del(`DELETE FROM ${q(name)} WHERE tenant_id = ? AND year + ? < YEAR(CURDATE())`, [id, OSHA_YEARS]); continue; }
        const refs = NAMED[name];
        if (refs) {
          const keep = refs.map(([tbl, col]) => `id NOT IN (SELECT ${q(col)} FROM ${q(tbl)} WHERE tenant_id = ? AND ${q(col)} IS NOT NULL)`).join(' AND ');
          await del(`DELETE FROM ${q(name)} WHERE tenant_id = ? AND ${keep}`, [id, ...refs.map(() => id)]);
          continue;
        }
        await del(`DELETE FROM ${q(name)} WHERE tenant_id = ?`, [id]);
      }
      await conn.query("UPDATE users SET active = 0, password_hash = '!', pin_hash = NULL, totp_enabled = 0, totp_secret = NULL WHERE tenant_id = ?", [id]);
      await conn.query('UPDATE tenants SET data_deleted_at = UTC_TIMESTAMP() WHERE id = ?', [id]);
      const left = {};
      for (const name of [...tables.map((x) => x.t).filter((n) => kept(n) || OSHA.includes(n) || NAMED[n]), 'users']) {
        const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM ${q(name)} WHERE tenant_id = ?`, [id]);
        if (Number(c.n)) left[name] = Number(c.n);
      }
      if (record) await record(conn, { deleted, kept: left });
      await conn.commit();
      require('./modules').invalidate(id);
      return { deleted, kept: left };
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
    conn.release();
  }
}

module.exports = { runAll, markDue, deleteClosed, Refused, LEAD_YEARS, OSHA_YEARS, KEEP };
