'use strict';
// Which migration steps have finished (2026.11.11). Used by db/migrate.js.
//
// A step can hold several statements (add a column, then fill it). Before this, a migration cut off between them (Cloud
// Shell disconnect, Ctrl-C, a killed job) left the column in place, the re-run saw it, skipped the step, and the fill
// never ran. Now each step is written to schema_steps when it starts and after each statement, and counts as done only
// once finished_at is set. A re-run picks up a started step where it stopped. A change statement that already took effect
// (the column, key or table is there) is passed over; a data statement and its progress row are saved together.
//
// The first run on a database from before this (schema_steps is empty) records every step its own check says is done,
// so nothing re-runs. For the steps that hold more than one statement, FINISHED looks at the step's last effect, so a
// step cut off by an older release is finished now instead of recorded as done.
//
// When every step has finished, the run writes "release <version>". /readyz (src/lib/schemaready.js) checks for it.

const TABLE = `CREATE TABLE IF NOT EXISTS schema_steps (
  name            VARCHAR(191) NOT NULL PRIMARY KEY,
  statements_done SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at     DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

// "Already there" errors, passed over only when a started step is picked up again.
const ALREADY = new Set([
  1050, // table exists
  1060, // duplicate column
  1061, // duplicate key name
  1068, // multiple primary key
  1091, // cannot drop: it is already gone
  1826, // duplicate foreign key name
]);
const isChange = (sql) => /^\s*(ALTER|CREATE|DROP|RENAME)\b/i.test(sql);

const any = async (c, sql) => { try { return (await c.query(sql))[0].length > 0; } catch (_) { return false; } };
const missing = async (c, sql) => { try { return (await c.query(sql))[0].length === 0; } catch (_) { return true; } };

// Steps with more than one statement: true when the LAST thing the step does is there. Only asked on a database that has
// no schema_steps yet, about a step whose own check says done. Each looks for the state a cut-off run leaves behind.
// tenants.mfa_for_patrol is left out on purpose: cut off, it leaves two-step due now for patrol (the stricter state).
const FINISHED = {
  'incidents.report_state': async (c) => !((await any(c, "SELECT 1 FROM incidents WHERE status = 'closed' LIMIT 1"))
    && (await missing(c, "SELECT 1 FROM incidents WHERE report_state <> 'draft' LIMIT 1"))),
  'patrol_members.access_level': async (c) => !((await any(c, "SELECT 1 FROM patrol_members WHERE level IN ('director','leader') LIMIT 1"))
    && (await missing(c, "SELECT 1 FROM patrol_members WHERE access_level <> 'patrol' LIMIT 1"))),
  'care entries client_ref': (c) => any(c, "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'incident_events' AND column_name = 'client_ref'"),
  'program_enrollments one per session': (c) => missing(c, "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'program_enrollments' AND index_name = 'uq_enrollment'"),
  'offline signatures and witnesses': (c) => any(c, "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'incident_skips' AND column_name = 'client_ref'"),
  'billing: season billing, and the Resort and Patrol price changes': async (c) =>
    (await any(c, "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tenant_billing' AND column_name = 'season_paused_until'"))
    && (await missing(c, "SELECT 1 FROM billing_plans WHERE code = 'patrol' AND kind = 'addon' AND monthly_cents = 17900 LIMIT 1")),
  // The fill gives every lesson a level, and every kids, teens or adults lesson an age.
  'lesson_sessions.level_min': async (c) => !(
    ((await any(c, 'SELECT 1 FROM lesson_sessions LIMIT 1')) && (await missing(c, 'SELECT 1 FROM lesson_sessions WHERE level_min IS NOT NULL LIMIT 1')))
    || ((await any(c, "SELECT 1 FROM lesson_sessions WHERE age_group IN ('kids','teens','adults') LIMIT 1")) && (await missing(c, 'SELECT 1 FROM lesson_sessions WHERE age_min IS NOT NULL LIMIT 1')))),
  'people.ski_level': async (c) => !((await any(c, 'SELECT 1 FROM people WHERE ability_level IS NOT NULL LIMIT 1'))
    && (await missing(c, 'SELECT 1 FROM people WHERE ski_level IS NOT NULL OR snowboard_level IS NOT NULL OR level_source IS NOT NULL LIMIT 1'))),
  'lesson_sessions.plan_id': (c) => any(c, "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'lesson_sessions' AND index_name = 'ix_lessons_plan'"),
};

/**
 * Returns run(name, done, ddl): true when it applied (or finished) the step, false when it was already done or skipped.
 * skippedCount() reads db/migrate.js's count of uniqueness steps put off because of duplicates (never recorded as done).
 */
async function stepRunner(conn, skippedCount = () => 0) {
  await conn.query(TABLE);
  const [rows] = await conn.query('SELECT name, statements_done, finished_at FROM schema_steps');
  const seen = new Map(rows.map((r) => [r.name, r]));
  const firstRun = rows.length === 0;
  const save = (name, n, finished) => conn.query(
    `INSERT INTO schema_steps (name, statements_done, finished_at) VALUES (?, ?, ${finished ? 'UTC_TIMESTAMP()' : 'NULL'})
     ON DUPLICATE KEY UPDATE statements_done = VALUES(statements_done), finished_at = VALUES(finished_at)`, [name, n]);

  async function run(name, done, ddl) {
    const list = Array.isArray(ddl) ? ddl : [ddl];
    const rec = seen.get(name);
    if (rec && rec.finished_at) return false;
    let from = 0;
    let resuming = Boolean(rec);
    if (rec) {
      from = Number(rec.statements_done) || 0;
      console.log(`Finishing a step that was cut off: ${name} (${from} of ${list.length} done)`);
    } else {
      const before = skippedCount();
      const already = await done(conn);
      if (skippedCount() > before) return false; // put off until duplicates are cleaned up: not done
      if (already) {
        const check = list.length > 1 ? FINISHED[name] : null;
        if (!check || (await check(conn))) { await save(name, list.length, true); return false; }
        console.log(`Finishing a step an earlier migration left half done: ${name}`);
        resuming = true;
      }
      await save(name, 0, false);
    }
    for (let i = from; i < list.length; i += 1) {
      const sql = list[i];
      if (isChange(sql)) {
        try { await conn.query(sql); } catch (e) { if (!(resuming && ALREADY.has(e.errno))) throw e; }
        await save(name, i + 1, false);
      } else {
        // A data statement and the note that it ran are saved together, so a cut-off never runs it twice.
        await conn.beginTransaction();
        try { await conn.query(sql); await save(name, i + 1, false); await conn.commit(); } catch (e) { await conn.rollback().catch(() => {}); throw e; }
      }
    }
    await save(name, list.length, true);
    return true;
  }
  run.firstRun = firstRun;
  /** Every step has finished: say so for this release, for /readyz. */
  run.release = (version) => save(`release ${version}`, 0, true);
  return run;
}

module.exports = { stepRunner, FINISHED, TABLE };
