'use strict';
// The ski school, round 2, the director's tools (Track DIRECTOR): copying a day and day templates, the weather playbook
// with each family's choice, school holidays for the staffing view, and shift offers. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => [
  // ---- copy a day, and templates ("Holiday Saturday")
  ['lesson_copies', (c) => tableExists(c, 'lesson_copies'), `CREATE TABLE lesson_copies (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    kind             ENUM('day','template') NOT NULL,
    label            VARCHAR(160) NOT NULL,
    target_dates     VARCHAR(800) NOT NULL,
    lessons_n        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    with_instructors TINYINT(1) NOT NULL DEFAULT 0,
    created_by       BIGINT UNSIGNED NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    undone_at        DATETIME NULL,
    undone_by        BIGINT UNSIGNED NULL,
    KEY ix_lesson_copies (tenant_id, created_at),
    CONSTRAINT fk_lesson_copies_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['lesson_sessions.copy_id', (c) => columnExists(c, 'lesson_sessions', 'copy_id'), 'ALTER TABLE lesson_sessions ADD COLUMN copy_id BIGINT UNSIGNED NULL, ADD KEY ix_lessons_copy (tenant_id, copy_id)'],
  ['lesson_day_templates', (c) => tableExists(c, 'lesson_day_templates'), `CREATE TABLE lesson_day_templates (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    name        VARCHAR(80) NOT NULL,
    lessons     MEDIUMTEXT NOT NULL,
    source_date DATE NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_day_templates_name (tenant_id, name),
    CONSTRAINT fk_day_templates_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- the weather playbook: one row per call (delay, cancel, move), and one choice per family per lesson or meeting
  ['weather_calls', (c) => tableExists(c, 'weather_calls'), `CREATE TABLE weather_calls (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    action        ENUM('delay','cancel','move') NOT NULL,
    on_date       DATE NOT NULL,
    from_time     TIME NULL,
    to_time       TIME NULL,
    delay_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    makeup_date   DATE NULL,
    reason        VARCHAR(300) NOT NULL,
    lessons_n     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    meetings_n    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    families_n    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_by    BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_weather_calls (tenant_id, on_date),
    CONSTRAINT fk_weather_calls_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['weather_choices', (c) => tableExists(c, 'weather_choices'), `CREATE TABLE weather_choices (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id         BIGINT UNSIGNED NOT NULL,
    call_id           BIGINT UNSIGNED NOT NULL,
    kind              ENUM('lesson','program') NOT NULL,
    booking_id        BIGINT UNSIGNED NULL,
    session_id        BIGINT UNSIGNED NULL,
    enrollment_id     BIGINT UNSIGNED NULL,
    meeting_id        BIGINT UNSIGNED NULL,
    person_id         BIGINT UNSIGNED NOT NULL,
    token_sha         CHAR(64) NOT NULL,
    email             VARCHAR(255) NULL,
    phone             VARCHAR(40) NULL,
    text_ok           TINYINT(1) NOT NULL DEFAULT 0,
    value_cents       INT UNSIGNED NOT NULL DEFAULT 0,
    refund_order_id   BIGINT UNSIGNED NULL,
    on_package        TINYINT(1) NOT NULL DEFAULT 0,
    choice            ENUM('open','makeup','credit','refund') NOT NULL DEFAULT 'open',
    chosen_at         DATETIME NULL,
    chosen_via        ENUM('family','staff','auto','move') NULL,
    makeup_session_id BIGINT UNSIGNED NULL,
    makeup_meeting_id BIGINT UNSIGNED NULL,
    credit_id         BIGINT UNSIGNED NULL,
    refund_how        ENUM('card','desk','none') NULL,
    refund_cents      INT UNSIGNED NOT NULL DEFAULT 0,
    refund_id         BIGINT UNSIGNED NULL,
    expires_at        DATETIME NOT NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_weather_choices_token (token_sha),
    KEY ix_weather_choices_call (tenant_id, call_id),
    KEY ix_weather_choices_open (choice, expires_at),
    KEY ix_weather_choices_person (tenant_id, person_id),
    CONSTRAINT fk_weather_choices_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // Which lesson product a program family's weather credit is for (a lesson credit needs a product). NULL: the cheapest group lesson.
  ['school_director_settings', (c) => tableExists(c, 'school_director_settings'), `CREATE TABLE school_director_settings (
    tenant_id                  BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    weather_credit_product_id  BIGINT UNSIGNED NULL,
    choice_days                TINYINT UNSIGNED NOT NULL DEFAULT 7,
    CONSTRAINT fk_director_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- staffing: school holidays the director lists (busier days), and offers of extra shifts to instructors
  ['school_holidays', (c) => tableExists(c, 'school_holidays'), `CREATE TABLE school_holidays (
    id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    on_date   DATE NOT NULL,
    name      VARCHAR(80) NOT NULL,
    UNIQUE KEY uq_school_holidays (tenant_id, on_date),
    CONSTRAINT fk_school_holidays_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['shift_offers', (c) => tableExists(c, 'shift_offers'), `CREATE TABLE shift_offers (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    starts_at   DATETIME NOT NULL,
    ends_at     DATETIME NOT NULL,
    discipline  ENUM('ski','snowboard','telemark','adaptive') NOT NULL DEFAULT 'ski',
    level_min   TINYINT UNSIGNED NULL,
    level_max   TINYINT UNSIGNED NULL,
    kids        TINYINT(1) NOT NULL DEFAULT 0,
    session_id  BIGINT UNSIGNED NULL,
    spots       TINYINT UNSIGNED NOT NULL DEFAULT 1,
    note        VARCHAR(200) NULL,
    status      ENUM('open','filled','closed') NOT NULL DEFAULT 'open',
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_shift_offers (tenant_id, starts_at),
    CONSTRAINT fk_shift_offers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['shift_offer_sends', (c) => tableExists(c, 'shift_offer_sends'), `CREATE TABLE shift_offer_sends (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    offer_id    BIGINT UNSIGNED NOT NULL,
    staff_id    BIGINT UNSIGNED NOT NULL,
    via         ENUM('text','email','app') NOT NULL DEFAULT 'app',
    answer      ENUM('none','yes','no','late') NOT NULL DEFAULT 'none',
    answered_at DATETIME NULL,
    told_filled TINYINT(1) NOT NULL DEFAULT 0,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_shift_offer_sends (tenant_id, offer_id, staff_id),
    KEY ix_shift_offer_staff (tenant_id, staff_id),
    CONSTRAINT fk_shift_offer_sends_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
];
