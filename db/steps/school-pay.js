'use strict';
// Ski school pay, reports and group programs (feat/school-pay). Loaded by db/migrate.js. Additive and safe to run twice,
// on MySQL 8.4 and MariaDB, and on a 2026.11.12 database.
//   instructor_profiles.psia_level  the certification level: PSIA-AASI 1, 2, 3 and Trainer/Examiner, CSIA 1-4, CASI 1-4
//                                   (the old level1-3 values move to psia1-3)
//   instructor_profiles.credentials specialist credentials: Children's Specialist 1 and 2, Freestyle, Adaptive
//   school_pay_ladder               the school's rate by certification level, and add-ons per specialist credential
//   school_trainings, school_training_staff  training sessions the director logs, with who came and for how long
//   pay_line_flags                  an instructor flags a pay line before payroll; the director answers
//   user_notices                    notes a person dismissed (the "setup moved to Settings" banner), per login
//   lesson_ratings                  a family's 0-10 "would you recommend your instructor", with an optional comment
//   learn_ladders                   a learn to ski package: lessons, included ticket and rental, the graduate pass offer
//   group_programs (+ students, chaperones, handoffs)  a school or club books a weekly program by private link
const enumHas = async (c, table, column, value) => {
  const [[r]] = await c.query('SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r && String(r.t || r.COLUMN_TYPE).includes(`'${value}'`));
};
const CERTS_WIDE = "'none','level1','level2','level3','psia1','psia2','psia3','psia_te','csia1','csia2','csia3','csia4','casi1','casi2','casi3','casi4'";
const CERTS = "'none','psia1','psia2','psia3','psia_te','csia1','csia2','csia3','csia4','casi1','casi2','casi3','casi4'";

module.exports = ({ tableExists, columnExists }) => [
  // ---- certification levels: widen, move the old values across, then narrow
  ['instructor_profiles.psia_level certs (widen)', (c) => enumHas(c, 'instructor_profiles', 'psia_level', 'casi4'),
    `ALTER TABLE instructor_profiles MODIFY psia_level ENUM(${CERTS_WIDE}) NOT NULL DEFAULT 'none'`],
  ['instructor_profiles.psia_level certs (move)', async (c) => {
    if (!(await enumHas(c, 'instructor_profiles', 'psia_level', 'level1'))) return true;
    const [[r]] = await c.query("SELECT COUNT(*) AS n FROM instructor_profiles WHERE psia_level IN ('level1','level2','level3')");
    return Number(r.n) === 0;
  }, "UPDATE instructor_profiles SET psia_level = CASE psia_level WHEN 'level1' THEN 'psia1' WHEN 'level2' THEN 'psia2' WHEN 'level3' THEN 'psia3' ELSE psia_level END WHERE psia_level IN ('level1','level2','level3')"],
  ['instructor_profiles.psia_level certs (narrow)', async (c) => !(await enumHas(c, 'instructor_profiles', 'psia_level', 'level1')),
    `ALTER TABLE instructor_profiles MODIFY psia_level ENUM(${CERTS}) NOT NULL DEFAULT 'none'`],
  ['instructor_profiles.credentials', (c) => columnExists(c, 'instructor_profiles', 'credentials'),
    "ALTER TABLE instructor_profiles ADD COLUMN credentials SET('kids1','kids2','freestyle','adaptive') NULL"],

  // ---- the pay ladder: a rung is a certification level (psia1...) or a credential (kids1...)
  ['school_pay_ladder', (c) => tableExists(c, 'school_pay_ladder'), `CREATE TABLE school_pay_ladder (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    rung VARCHAR(20) NOT NULL,
    kind ENUM('group','semi_private','private','hourly','program','lesson_addon','hourly_addon') NOT NULL,
    cents INT UNSIGNED NOT NULL,
    effective_from DATE NOT NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pay_ladder (tenant_id, rung, kind, effective_from),
    CONSTRAINT fk_pay_ladder_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- training time
  ['school_trainings', (c) => tableExists(c, 'school_trainings'), `CREATE TABLE school_trainings (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    title VARCHAR(160) NOT NULL,
    starts_at DATETIME NOT NULL,
    ends_at DATETIME NOT NULL,
    notes VARCHAR(1000) NULL,
    status ENUM('held','cancelled') NOT NULL DEFAULT 'held',
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_trainings_day (tenant_id, starts_at),
    CONSTRAINT fk_trainings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['school_training_staff', (c) => tableExists(c, 'school_training_staff'), `CREATE TABLE school_training_staff (
    tenant_id BIGINT UNSIGNED NOT NULL,
    training_id BIGINT UNSIGNED NOT NULL,
    staff_id BIGINT UNSIGNED NOT NULL,
    minutes INT UNSIGNED NULL,
    PRIMARY KEY (tenant_id, training_id, staff_id),
    KEY ix_training_staff (tenant_id, staff_id)
  ) ENGINE=InnoDB`],

  // ---- an instructor flags a pay line
  ['pay_line_flags', (c) => tableExists(c, 'pay_line_flags'), `CREATE TABLE pay_line_flags (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    staff_id BIGINT UNSIGNED NOT NULL,
    line_key VARCHAR(80) NOT NULL,
    work_day DATE NOT NULL,
    line_words VARCHAR(300) NULL,
    message VARCHAR(1000) NOT NULL,
    status ENUM('open','answered') NOT NULL DEFAULT 'open',
    answer VARCHAR(1000) NULL,
    answered_by BIGINT UNSIGNED NULL,
    answered_at DATETIME NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_pay_flags (tenant_id, staff_id, work_day),
    KEY ix_pay_flags_open (tenant_id, status)
  ) ENGINE=InnoDB`],

  // ---- notes a person dismissed
  ['user_notices', (c) => tableExists(c, 'user_notices'), `CREATE TABLE user_notices (
    tenant_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    notice_key VARCHAR(60) NOT NULL,
    dismissed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, user_id, notice_key)
  ) ENGINE=InnoDB`],

  // ---- would you recommend your instructor
  ['lesson_ratings', (c) => tableExists(c, 'lesson_ratings'), `CREATE TABLE lesson_ratings (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    booking_id BIGINT UNSIGNED NOT NULL,
    session_id BIGINT UNSIGNED NOT NULL,
    staff_id BIGINT UNSIGNED NULL,
    score TINYINT UNSIGNED NOT NULL,
    comment VARCHAR(1000) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rating_booking (tenant_id, booking_id),
    KEY ix_rating_staff (tenant_id, staff_id, created_at)
  ) ENGINE=InnoDB`],

  // ---- learn to ski ladder
  ['learn_ladders', (c) => tableExists(c, 'learn_ladders'), `CREATE TABLE learn_ladders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    ticket_product_id BIGINT UNSIGNED NULL,
    rental_product_id BIGINT UNSIGNED NULL,
    pass_product_id BIGINT UNSIGNED NULL,
    pass_percent TINYINT UNSIGNED NOT NULL DEFAULT 0,
    pass_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ladder_product (tenant_id, product_id)
  ) ENGINE=InnoDB`],

  // ---- school and group programs
  ['group_programs', (c) => tableExists(c, 'group_programs'), `CREATE TABLE group_programs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    program_id BIGINT UNSIGNED NOT NULL,
    org_name VARCHAR(160) NOT NULL,
    leader_name VARCHAR(160) NOT NULL,
    leader_email VARCHAR(255) NULL,
    leader_phone VARCHAR(40) NULL,
    weekday TINYINT UNSIGNED NOT NULL,
    first_day DATE NOT NULL,
    weeks TINYINT UNSIGNED NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    max_students SMALLINT UNSIGNED NOT NULL DEFAULT 30,
    per_chaperone TINYINT UNSIGNED NOT NULL DEFAULT 10,
    deadline_hours SMALLINT UNSIGNED NOT NULL DEFAULT 72,
    deadline_at DATETIME NOT NULL,
    token_sha CHAR(64) NOT NULL,
    status ENUM('open','cancelled') NOT NULL DEFAULT 'open',
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_group_token (token_sha),
    KEY ix_group_programs (tenant_id, first_day)
  ) ENGINE=InnoDB`],
  ['group_program_students', (c) => tableExists(c, 'group_program_students'), `CREATE TABLE group_program_students (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    group_id BIGINT UNSIGNED NOT NULL,
    person_id BIGINT UNSIGNED NOT NULL,
    guardian_name VARCHAR(160) NULL,
    guardian_email VARCHAR(255) NULL,
    guardian_phone VARCHAR(40) NULL,
    waiver_token_sha CHAR(64) NOT NULL,
    waiver_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_group_student (tenant_id, group_id, person_id),
    UNIQUE KEY uq_group_waiver_token (waiver_token_sha)
  ) ENGINE=InnoDB`],
  ['group_program_chaperones', (c) => tableExists(c, 'group_program_chaperones'), `CREATE TABLE group_program_chaperones (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    group_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(160) NOT NULL,
    phone VARCHAR(40) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_group_chaperones (tenant_id, group_id)
  ) ENGINE=InnoDB`],
  ['group_program_handoffs', (c) => tableExists(c, 'group_program_handoffs'), `CREATE TABLE group_program_handoffs (
    tenant_id BIGINT UNSIGNED NOT NULL,
    group_id BIGINT UNSIGNED NOT NULL,
    meeting_id BIGINT UNSIGNED NOT NULL,
    dropoff_at DATETIME NULL,
    dropoff_by VARCHAR(160) NULL,
    dropoff_count SMALLINT UNSIGNED NULL,
    pickup_at DATETIME NULL,
    pickup_by VARCHAR(160) NULL,
    pickup_count SMALLINT UNSIGNED NULL,
    recorded_by BIGINT UNSIGNED NULL,
    PRIMARY KEY (tenant_id, group_id, meeting_id)
  ) ENGINE=InnoDB`],
];
