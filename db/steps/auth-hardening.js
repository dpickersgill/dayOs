'use strict';
// Sign-in and patient-record hardening (feat/auth-hardening). Loaded by db/migrate.js. Every step is additive and safe
// to run twice on MySQL 8.4 and MariaDB. Each entry: [name, (conn) => Promise<boolean> already done, ddl or [ddl, ...]].
const has = async (conn, sql, params) => (await conn.query(sql, params))[0].length > 0;

module.exports = ({ tableExists, columnExists }) => [
  // Emailed codes have their own count and lock: wrong emailed codes never lock the app code, recovery codes or passkeys.
  ['users.email_code_failures', (c) => columnExists(c, 'users', 'email_code_failures'),
    'ALTER TABLE users ADD COLUMN email_code_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN email_code_locked_until DATETIME NULL'],
  // Sessions: whether Remember me was allowed, the idle limit this session has (30 minutes for patrol and leaders), a
  // lock the tab asked for (quick resume), and the separate check for opening patient records.
  ['user_sessions.remember', (c) => columnExists(c, 'user_sessions', 'remember'),
    'ALTER TABLE user_sessions ADD COLUMN remember TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN idle_min SMALLINT UNSIGNED NULL, ADD COLUMN locked_at DATETIME NULL, ADD COLUMN records_checked_at DATETIME NULL'],
  // Kiosk: new PINs are 6 digits unless the mountain allows 4 (off for every mountain, existing ones too).
  ['tenants.kiosk_pin_four', (c) => columnExists(c, 'tenants', 'kiosk_pin_four'),
    'ALTER TABLE tenants ADD COLUMN kiosk_pin_four TINYINT(1) NOT NULL DEFAULT 0'],
  // The weekly patient-record access summary: on unless the owner turns it off; sent once a week.
  ['tenants.access_summary_off', (c) => columnExists(c, 'tenants', 'access_summary_off'),
    'ALTER TABLE tenants ADD COLUMN access_summary_off TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN access_summary_week DATE NULL'],
  // Who added a responder or a dispatch link, and when. Rows from before this are marked as added by someone else (0)
  // at their case's or call's time, so cases in progress on the day of the upgrade keep working for their responders.
  ['incident_responders.added_by', (c) => columnExists(c, 'incident_responders', 'added_by'), [
    'ALTER TABLE incident_responders ADD COLUMN added_by BIGINT UNSIGNED NULL, ADD COLUMN added_at DATETIME NULL',
    'UPDATE incident_responders r JOIN incidents i ON i.tenant_id = r.tenant_id AND i.id = r.incident_id SET r.added_by = 0, r.added_at = i.created_at WHERE r.added_by IS NULL',
  ]],
  ['dispatch_responders.added_by', (c) => columnExists(c, 'dispatch_responders', 'added_by'), [
    'ALTER TABLE dispatch_responders ADD COLUMN added_by BIGINT UNSIGNED NULL, ADD COLUMN added_at DATETIME NULL',
    'UPDATE dispatch_responders r JOIN dispatch_calls c ON c.tenant_id = r.tenant_id AND c.id = r.call_id SET r.added_by = 0, r.added_at = c.received_at WHERE r.added_by IS NULL',
  ]],
  // Every change to what a login can reach (patrol level, role, staff link): who, when, from what to what. A lowering
  // holds password and two-step resets of that login for 24 hours, and the person who lowered it can never reset it.
  ['login_access_changes', (c) => tableExists(c, 'login_access_changes'),
    `CREATE TABLE IF NOT EXISTS login_access_changes (
      id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id  BIGINT UNSIGNED NOT NULL,
      user_id    BIGINT UNSIGNED NULL,
      staff_id   BIGINT UNSIGNED NULL,
      kind       ENUM('lowered','raised','granted','linked','unlinked','role') NOT NULL,
      from_value VARCHAR(40) NULL,
      to_value   VARCHAR(40) NULL,
      by_user    BIGINT UNSIGNED NULL,
      at         DATETIME NOT NULL,
      KEY ix_lac_user (tenant_id, user_id, at),
      KEY ix_lac_staff (tenant_id, staff_id, at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
  ['login_access_changes.ix_lac_by', (c) => has(c, "SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'login_access_changes' AND index_name = 'ix_lac_by'"),
    'ALTER TABLE login_access_changes ADD KEY ix_lac_by (tenant_id, by_user, at)'],
];
