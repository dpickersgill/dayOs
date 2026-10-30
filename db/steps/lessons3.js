'use strict';
// Lesson planning, best of breed (2026.11.9): the season plan (day types, periods, exceptions, publish and undo), pool
// slots, spots that follow staff, private lesson hours, level placement and the school director role. Shared schema for
// every track; each track adds its own db/steps/lessons3-<track>.js for anything more. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => [
  // ---- the season plan. doc is JSON: { day_types: [{ key, name, color, slots: [slot], private: { start, end, at_once, lengths } }],
  //      weekdays: [7 day type keys, Sunday first], periods: [{ from, to, day_type }], exceptions: [{ date, day_type?, add: [slot], remove: [slot key] }] }
  //      A slot: { key, start, end, product_id, kind: pool|class, format, discipline, level_min, level_max, age_min, age_max,
  //      spots, spots_mode: staff|fixed, meeting_place, cert, instructor_id }
  ['lesson_plans', (c) => tableExists(c, 'lesson_plans'), `CREATE TABLE lesson_plans (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    name         VARCHAR(80) NOT NULL,
    from_on      DATE NOT NULL,
    to_on        DATE NOT NULL,
    doc          MEDIUMTEXT NOT NULL,
    status       ENUM('draft','published') NOT NULL DEFAULT 'draft',
    created_by   BIGINT UNSIGNED NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    published_at DATETIME NULL,
    published_by BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_lesson_plans_tenant_id (tenant_id, id),
    KEY ix_lesson_plans (tenant_id, from_on),
    CONSTRAINT fk_lesson_plans_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // A saved pattern (day types and the weekday defaults) to reuse on another plan or next season.
  ['lesson_patterns', (c) => tableExists(c, 'lesson_patterns'), `CREATE TABLE lesson_patterns (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(80) NOT NULL,
    doc        MEDIUMTEXT NOT NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_lesson_patterns_name (tenant_id, name),
    CONSTRAINT fk_lesson_patterns_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // Each publish: what it created and what it changed (the earlier values of unbooked lessons), for undo.
  ['lesson_plan_publishes', (c) => tableExists(c, 'lesson_plan_publishes'), `CREATE TABLE lesson_plan_publishes (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    plan_id     BIGINT UNSIGNED NOT NULL,
    created_n   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    updated_n   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    removed_n   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    kept_n      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_ids MEDIUMTEXT NULL,
    before_rows MEDIUMTEXT NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    undone_at   DATETIME NULL,
    undone_by   BIGINT UNSIGNED NULL,
    KEY ix_lesson_plan_publishes (tenant_id, plan_id, created_at),
    CONSTRAINT fk_lesson_plan_publishes_plan FOREIGN KEY (tenant_id, plan_id) REFERENCES lesson_plans(tenant_id, id)
  ) ENGINE=InnoDB`],
  // A lesson made by a plan knows its plan and slot (so a re-publish finds it), whether it is a pool or a set class, and
  // whether its spots follow staff (capacity is then kept up to date by lib/lessonspots.js, never below what is booked).
  ['lesson_sessions.plan_id', (c) => columnExists(c, 'lesson_sessions', 'plan_id'), [
    "ALTER TABLE lesson_sessions ADD COLUMN plan_id BIGINT UNSIGNED NULL, ADD COLUMN plan_slot VARCHAR(40) NULL, ADD COLUMN kind ENUM('class','pool') NOT NULL DEFAULT 'class', ADD COLUMN spots_mode ENUM('fixed','staff') NOT NULL DEFAULT 'fixed', ADD COLUMN spots_cap SMALLINT UNSIGNED NULL",
    'ALTER TABLE lesson_sessions ADD KEY ix_lessons_plan (tenant_id, plan_id, plan_slot, starts_at)',
  ]],
  // Private lesson hours for a day, written when a plan is published. No row: any time inside mountain hours (as before).
  ['lesson_private_hours', (c) => tableExists(c, 'lesson_private_hours'), `CREATE TABLE lesson_private_hours (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    on_date    DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time   TIME NOT NULL,
    at_once    SMALLINT UNSIGNED NULL,
    lengths    VARCHAR(40) NOT NULL DEFAULT '60,120,180,360',
    closed     TINYINT(1) NOT NULL DEFAULT 0,
    plan_id    BIGINT UNSIGNED NULL,
    PRIMARY KEY (tenant_id, on_date),
    CONSTRAINT fk_lesson_private_hours_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // Level placement: the guest's answers when booking, and the level they point to.
  ['lesson_bookings.placement_level', (c) => columnExists(c, 'lesson_bookings', 'placement_level'),
    'ALTER TABLE lesson_bookings ADD COLUMN placement_level TINYINT UNSIGNED NULL, ADD COLUMN placement_answers VARCHAR(400) NULL'],
  // School settings: how privates are confirmed, the placement questions (null: the built-in ones), and the default spots mode for pools.
  ['school_settings.private_confirm', (c) => columnExists(c, 'school_settings', 'private_confirm'),
    "ALTER TABLE school_settings ADD COLUMN private_confirm ENUM('accept','auto') NOT NULL DEFAULT 'accept', ADD COLUMN placement_questions MEDIUMTEXT NULL, ADD COLUMN pool_spots_mode ENUM('staff','fixed') NOT NULL DEFAULT 'staff'"],
  // The school director role: an access level on the instructor's teaching profile.
  ['instructor_profiles.school_access', (c) => columnExists(c, 'instructor_profiles', 'school_access'),
    "ALTER TABLE instructor_profiles ADD COLUMN school_access ENUM('instructor','supervisor','director') NOT NULL DEFAULT 'instructor'"],
];
