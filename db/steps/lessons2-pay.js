'use strict';
// The ski school, round 2 (Track PAY): instructor pay rates, private lessons asked for by name, and payroll exports.
// Loaded by db/migrate.js right after lessons2. Each entry: [name, (conn) => done?, ddl].
module.exports = ({ tableExists }) => [
  // What the school pays: one row per kind and start date. staff_id NULL is the school's default for everyone.
  // group, semi_private and private are per lesson; hourly is per hour (also used for lineup time); program is per meeting.
  ['instructor_pay_rates', (c) => tableExists(c, 'instructor_pay_rates'), `CREATE TABLE instructor_pay_rates (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    staff_id       BIGINT UNSIGNED NULL,
    staff_key      BIGINT UNSIGNED AS (IFNULL(staff_id, 0)) STORED,
    kind           ENUM('group','semi_private','private','hourly','program') NOT NULL,
    cents          INT UNSIGNED NOT NULL,
    effective_from DATE NOT NULL,
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pay_rates (tenant_id, staff_key, kind, effective_from),
    CONSTRAINT fk_pay_rates_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // The private lessons a family can ask for online: a length, the lesson product it is sold as, and how many may share it.
  ['private_offers', (c) => tableExists(c, 'private_offers'), `CREATE TABLE private_offers (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id           BIGINT UNSIGNED NOT NULL,
    product_id          BIGINT UNSIGNED NOT NULL,
    minutes             SMALLINT UNSIGNED NOT NULL,
    max_students        TINYINT UNSIGNED NOT NULL DEFAULT 1,
    extra_student_cents INT UNSIGNED NOT NULL DEFAULT 0,
    meeting_place       VARCHAR(120) NULL,
    active              TINYINT(1) NOT NULL DEFAULT 1,
    KEY ix_private_offers (tenant_id, active),
    CONSTRAINT fk_private_offers_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
  ) ENGINE=InnoDB`],

  // A private lesson asked for online, by name or "any instructor". Paid first (or at the desk when card payment is off),
  // then it waits for the instructor until deadline_at (UTC). Accepting makes the lesson; declining or no answer offers the
  // family another instructor or refunds them, by the school's setting.
  ['private_requests', (c) => tableExists(c, 'private_requests'), `CREATE TABLE private_requests (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    reference        CHAR(8) NOT NULL,
    token_sha        CHAR(64) NOT NULL,
    status           ENUM('awaiting_payment','waiting','offered','accepted','refunded','declined','cancelled','expired') NOT NULL DEFAULT 'awaiting_payment',
    source           ENUM('public','rebook') NOT NULL DEFAULT 'public',
    staff_id         BIGINT UNSIGNED NULL,
    any_instructor   TINYINT(1) NOT NULL DEFAULT 0,
    declined_ids     VARCHAR(500) NOT NULL DEFAULT '',
    offer_id         BIGINT UNSIGNED NOT NULL,
    product_id       BIGINT UNSIGNED NOT NULL,
    discipline       ENUM('ski','snowboard','telemark','adaptive') NOT NULL DEFAULT 'ski',
    starts_at        DATETIME NOT NULL,
    minutes          SMALLINT UNSIGNED NOT NULL,
    students         TEXT NOT NULL,  -- JSON { contact: { first_name, last_name }, students: [{ first_name, last_name, date_of_birth, sex, level, allergies, medical, photo_ok }] }
    contact_name     VARCHAR(150) NOT NULL,
    contact_email    VARCHAR(255) NOT NULL,
    contact_phone    VARCHAR(40) NOT NULL,
    text_ok          TINYINT(1) NOT NULL DEFAULT 0,
    note             VARCHAR(500) NULL,
    waiver_accepted  TINYINT(1) NOT NULL DEFAULT 0,
    waiver_text_sha  CHAR(64) NULL,
    amount_cents     INT UNSIGNED NOT NULL DEFAULT 0,
    quote_json       TEXT NULL,
    pay_at_desk      TINYINT(1) NOT NULL DEFAULT 0,
    stripe_session_id VARCHAR(255) NULL,
    payment_intent   VARCHAR(255) NULL,
    payee_account    VARCHAR(64) NULL,
    fee_cents        INT UNSIGNED NOT NULL DEFAULT 0,
    deadline_at      DATETIME NULL,
    session_id       BIGINT UNSIGNED NULL,
    lesson_request_id BIGINT UNSIGNED NULL,
    refund_cents     INT UNSIGNED NOT NULL DEFAULT 0,
    decided_by       BIGINT UNSIGNED NULL,
    decided_at       DATETIME NULL,
    staff_note       VARCHAR(300) NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_private_ref (tenant_id, reference),
    UNIQUE KEY uq_private_token (token_sha),
    KEY ix_private_status (tenant_id, status, deadline_at),
    KEY ix_private_staff (tenant_id, staff_id, status),
    CONSTRAINT fk_private_requests_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // Payroll: a pay period, which instructors' lines a manager approved, and every line once exported (so nothing is paid twice).
  ['payroll_runs', (c) => tableExists(c, 'payroll_runs'), `CREATE TABLE payroll_runs (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    period_from  DATE NOT NULL,
    period_to    DATE NOT NULL,
    status       ENUM('open','exported') NOT NULL DEFAULT 'open',
    created_by   BIGINT UNSIGNED NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    exported_by  BIGINT UNSIGNED NULL,
    exported_at  DATETIME NULL,
    UNIQUE KEY uq_payroll_period (tenant_id, period_from, period_to),
    CONSTRAINT fk_payroll_runs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['payroll_approvals', (c) => tableExists(c, 'payroll_approvals'), `CREATE TABLE payroll_approvals (
    tenant_id    BIGINT UNSIGNED NOT NULL,
    run_id       BIGINT UNSIGNED NOT NULL,
    staff_id     BIGINT UNSIGNED NOT NULL,
    cents        INT NOT NULL DEFAULT 0,
    approved_by  BIGINT UNSIGNED NULL,
    approved_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, run_id, staff_id)
  ) ENGINE=InnoDB`],
  ['payroll_items', (c) => tableExists(c, 'payroll_items'), `CREATE TABLE payroll_items (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    run_id       BIGINT UNSIGNED NOT NULL,
    staff_id     BIGINT UNSIGNED NOT NULL,
    line_key     VARCHAR(80) NOT NULL,
    kind         VARCHAR(20) NOT NULL,
    work_day     DATE NOT NULL,
    minutes      INT NOT NULL DEFAULT 0,
    cents        INT NOT NULL DEFAULT 0,
    words        VARCHAR(255) NULL,
    UNIQUE KEY uq_payroll_line (tenant_id, staff_id, line_key),
    KEY ix_payroll_run (tenant_id, run_id)
  ) ENGINE=InnoDB`],
];
