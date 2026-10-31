'use strict';
// 2026.11.11 patrol fixes after the Oct 31 reviews. Loaded by db/migrate.js. Additive and safe to run twice.
//   patrol_sweep_marks.resolution/resolved_*  how a person or hazard found on the sweep was dealt with, or why it was
//                                             entered in error. A find is never overwritten or deleted (PATROL-3).
//   patrol_sweep_mark_log                     every mark, change, undo and resolution, append-only.
//   dispatch_calls.sender_hash/ip_hash/flood_of  guest help floods grouped, never refused (PATROL-4).
//   patrol_kits.changed_at, patrol_kit_checks.applied  a late offline kit check never undoes a newer change (PATROL-6).
//   incident_media.taken_from/taken_outside  where a photo's time came from (PATROL-10).
//   patrol_med_moves/counts.status, witness_*  controlled moves and counts wait for the witness to confirm (PATROL-7).
module.exports = ({ tableExists, columnExists }) => [
  ['patrol_sweep_marks.resolution', (c) => columnExists(c, 'patrol_sweep_marks', 'resolution'),
    "ALTER TABLE patrol_sweep_marks ADD COLUMN resolution VARCHAR(255) NULL, ADD COLUMN resolved_kind ENUM('dealt_with','error') NULL, ADD COLUMN resolved_at DATETIME NULL, ADD COLUMN resolved_by BIGINT UNSIGNED NULL"],
  ['patrol_sweep_mark_log', (c) => tableExists(c, 'patrol_sweep_mark_log'), `CREATE TABLE patrol_sweep_mark_log (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    run_id     BIGINT UNSIGNED NOT NULL,
    item_id    BIGINT UNSIGNED NOT NULL,
    mark_id    BIGINT UNSIGNED NULL,
    action     ENUM('mark','undo','resolve','error') NOT NULL,
    flag       ENUM('none','person','hazard','rope','other') NOT NULL,
    note       VARCHAR(255) NULL,
    reason     VARCHAR(255) NULL,
    at         DATETIME NOT NULL,
    by_user    BIGINT UNSIGNED NOT NULL,
    by_staff   BIGINT UNSIGNED NULL,
    KEY ix_psmlog_run (tenant_id, run_id, item_id),
    CONSTRAINT fk_psmlog_run FOREIGN KEY (tenant_id, run_id) REFERENCES patrol_sweep_runs(tenant_id, id)
  ) ENGINE=InnoDB`],
  // PATROL-4: guest help requests are always accepted; repeats from one phone (sender_hash) or address (ip_hash), both
  // keyed hashes, fold under the first of the group (flood_of) and patrol is alerted once (flood_alerted_at).
  ['dispatch_calls.sender_hash', (c) => columnExists(c, 'dispatch_calls', 'sender_hash'),
    'ALTER TABLE dispatch_calls ADD COLUMN sender_hash CHAR(64) NULL, ADD COLUMN ip_hash CHAR(64) NULL, ADD COLUMN flood_of BIGINT UNSIGNED NULL, ADD COLUMN flood_alerted_at DATETIME NULL, ADD KEY ix_dcall_sender (tenant_id, sender_hash, received_at), ADD KEY ix_dcall_ip (tenant_id, ip_hash, received_at)'],
  // PATROL-6: the time of the kit's newest change. A check that arrives late with an older time is kept (applied = 0)
  // but does not change the kit.
  ['patrol_kits.changed_at', (c) => columnExists(c, 'patrol_kits', 'changed_at'),
    'ALTER TABLE patrol_kits ADD COLUMN changed_at DATETIME NULL'],
  ['patrol_kits.changed_at backfill', async (c) => !(await columnExists(c, 'patrol_kits', 'changed_at')) || Number((await c.query('SELECT COUNT(*) AS n FROM patrol_kits k WHERE k.changed_at IS NULL AND EXISTS (SELECT 1 FROM patrol_kit_checks x WHERE x.tenant_id = k.tenant_id AND x.kit_id = k.id)'))[0][0].n) === 0,
    'UPDATE patrol_kits k SET k.changed_at = (SELECT MAX(x.done_at) FROM patrol_kit_checks x WHERE x.tenant_id = k.tenant_id AND x.kit_id = k.id) WHERE k.changed_at IS NULL'],
  // PATROL-7: a controlled-medication move or count waits (pending) until the witness confirms it themselves.
  ['patrol_med_moves.status', (c) => columnExists(c, 'patrol_med_moves', 'status'),
    "ALTER TABLE patrol_med_moves ADD COLUMN status ENUM('done','pending','declined') NOT NULL DEFAULT 'done', ADD COLUMN witness_user BIGINT UNSIGNED NULL, ADD COLUMN witness_confirmed_at DATETIME NULL, ADD COLUMN witness_via ENUM('login','pin') NULL"],
  ['patrol_med_counts.status', (c) => columnExists(c, 'patrol_med_counts', 'status'),
    "ALTER TABLE patrol_med_counts ADD COLUMN status ENUM('done','pending','declined') NOT NULL DEFAULT 'done', ADD COLUMN witness_user BIGINT UNSIGNED NULL, ADD COLUMN witness_confirmed_at DATETIME NULL, ADD COLUMN witness_via ENUM('login','pin') NULL"],
  // PATROL-10: where a photo's time came from (the photo file, or the phone), and a photo-file time outside the case.
  ['incident_media.taken_from', (c) => columnExists(c, 'incident_media', 'taken_from'),
    "ALTER TABLE incident_media ADD COLUMN taken_from ENUM('photo','phone') NULL, ADD COLUMN taken_outside TINYINT(1) NOT NULL DEFAULT 0"],
  ['patrol_kit_checks.applied', (c) => columnExists(c, 'patrol_kit_checks', 'applied'),
    'ALTER TABLE patrol_kit_checks ADD COLUMN applied TINYINT(1) NOT NULL DEFAULT 1'],
];
