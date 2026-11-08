'use strict';
// Ski school safety (feat/school-safety): pickup by authorized adults, lost child tied to patrol dispatch, ratios by
// age band, adaptive intake, live updates during the lesson, and where each group was last seen. Loaded by db/migrate.js.
// Each entry: [name, (conn) => done?, ddl]. Safe to run twice and on a 2026.11.12 database.
module.exports = ({ tableExists, columnExists }) => [
  // ---- the school's safety settings: age bands with class sizes, the adaptive ratio, pickup windows, named spots (JSON)
  ['school_settings.ratio_bands', (c) => columnExists(c, 'school_settings', 'ratio_bands'),
    'ALTER TABLE school_settings ADD COLUMN ratio_bands TEXT NULL, ADD COLUMN ratio_adaptive TINYINT UNSIGNED NOT NULL DEFAULT 1, ADD COLUMN pickup_windows TEXT NULL, ADD COLUMN group_places TEXT NULL'],

  // ---- on each booking: who it was released to at pickup, the jacket and helmet colors, live updates off, an age override
  ['lesson_bookings.released_at', (c) => columnExists(c, 'lesson_bookings', 'released_at'), `ALTER TABLE lesson_bookings
    ADD COLUMN released_at DATETIME NULL, ADD COLUMN released_to VARCHAR(150) NULL, ADD COLUMN released_adult_id BIGINT UNSIGNED NULL,
    ADD COLUMN released_by BIGINT UNSIGNED NULL, ADD COLUMN released_id_seen TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN release_reason VARCHAR(300) NULL,
    ADD COLUMN jacket_color VARCHAR(40) NULL, ADD COLUMN helmet_color VARCHAR(40) NULL,
    ADD COLUMN updates_off TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN override_reason VARCHAR(300) NULL`],

  // ---- the adults a family says may pick a child up (per booking), with an optional photo kept like other photos
  ['lesson_pickup_adults', (c) => tableExists(c, 'lesson_pickup_adults'), `CREATE TABLE lesson_pickup_adults (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    booking_id    BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(150) NOT NULL,
    relationship  VARCHAR(60) NULL,
    phone         VARCHAR(40) NULL,
    photo         MEDIUMTEXT NULL,
    photo_consent_at DATETIME NULL,
    added_via     ENUM('desk','online','family','window') NOT NULL DEFAULT 'desk',
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_pickup_adults_booking (tenant_id, booking_id),
    CONSTRAINT fk_pickup_adults_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- adaptive intake: what the instructors need to know for an adaptive lesson (one per booking)
  ['lesson_adaptive_intake', (c) => tableExists(c, 'lesson_adaptive_intake'), `CREATE TABLE lesson_adaptive_intake (
    tenant_id     BIGINT UNSIGNED NOT NULL,
    booking_id    BIGINT UNSIGNED NOT NULL,
    needs         VARCHAR(1000) NULL,
    equipment     VARCHAR(200) NULL,
    extra_staff   TINYINT UNSIGNED NOT NULL DEFAULT 0,
    notes         VARCHAR(1000) NULL,
    updated_by    BIGINT UNSIGNED NULL,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, booking_id),
    CONSTRAINT fk_adaptive_intake_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- a lost child report: tied to the patrol dispatch call it opened
  ['school_lost_children', (c) => tableExists(c, 'school_lost_children'), `CREATE TABLE school_lost_children (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    booking_id    BIGINT UNSIGNED NOT NULL,
    session_id    BIGINT UNSIGNED NOT NULL,
    call_id       BIGINT UNSIGNED NULL,
    jacket_color  VARCHAR(40) NULL,
    helmet_color  VARCHAR(40) NULL,
    last_seen     VARCHAR(200) NULL,
    status        ENUM('open','found','cancelled') NOT NULL DEFAULT 'open',
    reported_by   BIGINT UNSIGNED NULL,
    reported_at   DATETIME NOT NULL,
    found_by      VARCHAR(150) NULL,
    found_where   VARCHAR(200) NULL,
    found_at      DATETIME NULL,
    closed_by     BIGINT UNSIGNED NULL,
    KEY ix_lost_children (tenant_id, status, reported_at),
    KEY ix_lost_children_call (tenant_id, call_id),
    CONSTRAINT fk_lost_children_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['dispatch_calls.call_type', (c) => columnExists(c, 'dispatch_calls', 'call_type'), [
    'ALTER TABLE dispatch_calls ADD COLUMN call_type VARCHAR(30) NULL',
    "ALTER TABLE dispatch_calls MODIFY COLUMN source ENUM('patrol','radio','phone','guest','school') NOT NULL DEFAULT 'radio'",
  ]],

  // ---- live updates from the lesson: one line or a photo, kept like recap photos (deleted after 90 days)
  ['lesson_live_updates', (c) => tableExists(c, 'lesson_live_updates'), `CREATE TABLE lesson_live_updates (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    session_id  BIGINT UNSIGNED NOT NULL,
    staff_id    BIGINT UNSIGNED NULL,
    body        VARCHAR(280) NULL,
    mime        VARCHAR(60) NULL,
    bytes       INT UNSIGNED NULL,
    data        MEDIUMBLOB NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_live_updates (tenant_id, session_id, id),
    KEY ix_live_updates_age (created_at),
    CONSTRAINT fk_live_updates_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- "We're at": an instructor's tap on a named spot. Kept for the day only (the daily job deletes older rows).
  ['school_group_places', (c) => tableExists(c, 'school_group_places'), `CREATE TABLE school_group_places (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    session_id  BIGINT UNSIGNED NOT NULL,
    on_date     DATE NOT NULL,
    place       VARCHAR(80) NOT NULL,
    at          DATETIME NOT NULL,
    staff_id    BIGINT UNSIGNED NULL,
    KEY ix_group_places (tenant_id, on_date, session_id),
    CONSTRAINT fk_group_places_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- one level scale: the customer form's old "Ability level" is now the ski level (1 to 9)
  ['customer_form_config ability to level', async (c) => {
    if (!(await tableExists(c, 'customer_form_config'))) return true;
    const [r] = await c.query("SELECT COUNT(*) AS n FROM customer_form_config WHERE field_key = 'ability_level'");
    return Number(r[0].n) === 0;
  }, [
    "INSERT IGNORE INTO customer_form_config (tenant_id, scope, field_key, required) SELECT tenant_id, scope, 'ski_level', required FROM customer_form_config WHERE field_key = 'ability_level'",
    "DELETE FROM customer_form_config WHERE field_key = 'ability_level'",
  ]],
];
