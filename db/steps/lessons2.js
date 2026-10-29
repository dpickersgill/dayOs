'use strict';
// The ski school, round 2 (2026.11.5): one level scale (PSIA-AASI's nine levels), safety details and a link on every
// lesson booking, check-in and the lineup, the school's settings, and tips. Loaded by db/migrate.js.
// Each entry: [name, (conn) => done?, ddl]. Track-only tables live in db/steps/lessons2-<track>.js.
module.exports = ({ tableExists, columnExists }) => [
  // ---- one level scale: 1 (first time) to 9 (all terrain), the PSIA-AASI levels. A lesson teaches a range of levels.
  ['lesson_sessions.level_min', (c) => columnExists(c, 'lesson_sessions', 'level_min'), [
    'ALTER TABLE lesson_sessions ADD COLUMN level_min TINYINT UNSIGNED NULL, ADD COLUMN level_max TINYINT UNSIGNED NULL, ADD COLUMN age_min TINYINT UNSIGNED NULL, ADD COLUMN age_max TINYINT UNSIGNED NULL',
    // the old four words, on the new scale
    `UPDATE lesson_sessions SET
       level_min = CASE ability_level WHEN 'first_timer' THEN 1 WHEN 'beginner' THEN 2 WHEN 'intermediate' THEN 4 ELSE 7 END,
       level_max = CASE ability_level WHEN 'first_timer' THEN 1 WHEN 'beginner' THEN 3 WHEN 'intermediate' THEN 6 ELSE 9 END`,
    "UPDATE lesson_sessions SET age_min = CASE age_group WHEN 'kids' THEN 4 WHEN 'teens' THEN 13 WHEN 'adults' THEN 18 ELSE NULL END, age_max = CASE age_group WHEN 'kids' THEN 12 WHEN 'teens' THEN 17 ELSE NULL END",
  ]],
  // where the lesson came from: typed in, a series, copied from another day, split off at lineup, a private request, an instructor's rebooking
  ['lesson_sessions.origin', (c) => columnExists(c, 'lesson_sessions', 'origin'), "ALTER TABLE lesson_sessions ADD COLUMN origin ENUM('manual','series','copy','split','request','rebook') NOT NULL DEFAULT 'manual', ADD COLUMN delay_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0"],
  // the guest's own level, per discipline, saved on the customer so it follows them to the next lesson, season and program
  ['people.ski_level', (c) => columnExists(c, 'people', 'ski_level'), [
    "ALTER TABLE people ADD COLUMN ski_level TINYINT UNSIGNED NULL, ADD COLUMN snowboard_level TINYINT UNSIGNED NULL, ADD COLUMN level_source ENUM('quiz','instructor','staff','import') NULL, ADD COLUMN level_set_at DATETIME NULL",
    `UPDATE people SET
       snowboard_level = IF(discipline = 'snowboard', CASE ability_level WHEN 'first_timer' THEN 1 WHEN 'beginner' THEN 2 WHEN 'intermediate' THEN 4 WHEN 'advanced' THEN 7 END, NULL),
       ski_level = IF(discipline <=> 'snowboard', NULL, CASE ability_level WHEN 'first_timer' THEN 1 WHEN 'beginner' THEN 2 WHEN 'intermediate' THEN 4 WHEN 'advanced' THEN 7 END),
       level_source = IF(ability_level IS NULL, NULL, 'import')
     WHERE ability_level IS NOT NULL`,
  ]],
  // what an instructor may teach, on the same scale
  ['instructor_profiles.teach levels', (c) => columnExists(c, 'instructor_profiles', 'ski_level_max'), `ALTER TABLE instructor_profiles
    ADD COLUMN ski_level_max TINYINT UNSIGNED NULL, ADD COLUMN snowboard_level_max TINYINT UNSIGNED NULL,
    ADD COLUMN teaches_kids TINYINT(1) NOT NULL DEFAULT 1, ADD COLUMN teaches_adaptive TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN psia_level ENUM('none','level1','level2','level3') NOT NULL DEFAULT 'none'`],

  // ---- every lesson booking: safety details, who to call, consent, the level booked at, check-in, a private link
  ['lesson_bookings round 2', (c) => columnExists(c, 'lesson_bookings', 'token_sha'), `ALTER TABLE lesson_bookings
    ADD COLUMN allergies VARCHAR(300) NULL, ADD COLUMN medical VARCHAR(500) NULL, ADD COLUMN pickup VARCHAR(300) NULL,
    ADD COLUMN contact_name VARCHAR(150) NULL, ADD COLUMN contact_phone VARCHAR(40) NULL, ADD COLUMN contact_email VARCHAR(255) NULL,
    ADD COLUMN text_ok TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN photo_ok TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN level TINYINT UNSIGNED NULL,
    ADD COLUMN checked_in_at DATETIME NULL, ADD COLUMN checked_in_by BIGINT UNSIGNED NULL, ADD COLUMN checked_in_via ENUM('link','desk','instructor') NULL,
    ADD COLUMN moved_from_session_id BIGINT UNSIGNED NULL, ADD COLUMN moved_at DATETIME NULL,
    ADD COLUMN token_sha CHAR(64) NULL, ADD COLUMN confirmed_at DATETIME NULL,
    ADD UNIQUE KEY uq_lesson_bookings_token (token_sha), ADD KEY ix_lesson_bookings_person (tenant_id, person_id)`],

  // ---- the 9:45 lineup: lessons that start together for the same product, discipline and ages are one lineup
  ['lesson_lineups', (c) => tableExists(c, 'lesson_lineups'), `CREATE TABLE lesson_lineups (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    starts_at     DATETIME NOT NULL,
    product_id    BIGINT UNSIGNED NOT NULL,
    discipline    ENUM('ski','snowboard','telemark','adaptive') NOT NULL,
    age_group     ENUM('all','kids','teens','adults') NOT NULL DEFAULT 'all',
    ratio         TINYINT UNSIGNED NULL,
    status        ENUM('open','split','locked') NOT NULL DEFAULT 'open',
    split_at      DATETIME NULL,
    split_by      BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_lineups (tenant_id, starts_at, product_id, discipline, age_group),
    UNIQUE KEY uq_lineups_tenant_id (tenant_id, id),
    CONSTRAINT fk_lineups_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['lesson_sessions.lineup_id', (c) => columnExists(c, 'lesson_sessions', 'lineup_id'), 'ALTER TABLE lesson_sessions ADD COLUMN lineup_id BIGINT UNSIGNED NULL, ADD KEY ix_lessons_lineup (tenant_id, lineup_id)'],

  // ---- the school's settings, one row per mountain (src/lib/schoolsettings.js has the defaults)
  ['school_settings', (c) => tableExists(c, 'school_settings'), `CREATE TABLE school_settings (
    tenant_id               BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    confirm_email           TINYINT(1) NOT NULL DEFAULT 1,
    checkin_link            TINYINT(1) NOT NULL DEFAULT 1,
    ratio_kids              TINYINT UNSIGNED NOT NULL DEFAULT 5,
    ratio_adults            TINYINT UNSIGNED NOT NULL DEFAULT 6,
    recap_on                TINYINT(1) NOT NULL DEFAULT 1,
    recap_photos            TINYINT(1) NOT NULL DEFAULT 1,
    waitlist_claim_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 15,
    tips_on                 TINYINT(1) NOT NULL DEFAULT 1,
    tip_policy              VARCHAR(500) NULL,
    pay_mode                ENUM('per_lesson','hourly','both') NOT NULL DEFAULT 'per_lesson',
    lineup_paid             TINYINT(1) NOT NULL DEFAULT 0,
    lineup_minutes          SMALLINT UNSIGNED NOT NULL DEFAULT 15,
    request_bonus_cents     INT UNSIGNED NOT NULL DEFAULT 0,
    private_accept_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 120,
    private_decline         ENUM('offer_other','refund') NOT NULL DEFAULT 'offer_other',
    updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_school_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- tips: given by the family from the lesson recap, paid in full to the instructor
  ['lesson_tips', (c) => tableExists(c, 'lesson_tips'), `CREATE TABLE lesson_tips (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    booking_id     BIGINT UNSIGNED NOT NULL,
    session_id     BIGINT UNSIGNED NOT NULL,
    staff_id       BIGINT UNSIGNED NOT NULL,
    amount_cents   INT UNSIGNED NOT NULL,
    status         ENUM('pending','paid','refunded','failed') NOT NULL DEFAULT 'pending',
    stripe_session_id VARCHAR(255) NULL,
    payment_intent VARCHAR(255) NULL,
    order_id       BIGINT UNSIGNED NULL,
    paid_at        DATETIME NULL,
    paid_out_at    DATETIME NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_tips_staff (tenant_id, staff_id, status, paid_at),
    KEY ix_tips_booking (tenant_id, booking_id),
    CONSTRAINT fk_tips_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- lesson credits can come from weather or goodwill as well as from a package
  ['lesson_credits.source', (c) => columnExists(c, 'lesson_credits', 'source'), "ALTER TABLE lesson_credits ADD COLUMN source ENUM('package','weather','goodwill') NOT NULL DEFAULT 'package', ADD COLUMN note VARCHAR(200) NULL"],
];
