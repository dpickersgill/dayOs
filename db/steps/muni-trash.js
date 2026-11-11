'use strict';
// Bulk trash pickup booked and paid online (muni release 1, workstream "trash"). Loaded by db/migrate.js.
// Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   residents                 a resident's contact (name, phone, email, address, yes to texts and emails). The requests
//                             workstream owns this table; this step makes the same table only when it is not there yet.
//   bulk_settings             one row per municipality: collection days, the booking cutoff, stops a day, how residents
//                             pay, the rules shown to them, and what a not-out pickup gets by default
//   bulk_sizes                the item sizes residents pick from (Small, Medium, Large, Metal), each with its price
//   bulk_skip_dates           collection days with no pickup (holidays), with a note residents see
//   bulk_bookings             one pickup at one address on one collection day: payment, the crew's outcome, refunds
//   bulk_booking_items        what is going out, by size and quantity, at the price on the day it was booked
//   bulk_photos               the crew's photos of a not-out or not-accepted stop, kept exactly as taken with a SHA-256

module.exports = ({ tableExists }) => [
  ['residents', (c) => tableExists(c, 'residents'), `CREATE TABLE residents (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(120) NOT NULL,
    phone         VARCHAR(40) NULL,
    email         VARCHAR(255) NULL,
    street_id     BIGINT UNSIGNED NULL,
    house_number  VARCHAR(20) NULL,
    unit          VARCHAR(20) NULL,
    texts_ok      TINYINT(1) NOT NULL DEFAULT 0,
    emails_ok     TINYINT(1) NOT NULL DEFAULT 0,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_residents_tenant_id (tenant_id, id),
    KEY ix_residents_email (tenant_id, email),
    KEY ix_residents_phone (tenant_id, phone),
    CONSTRAINT fk_residents_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['bulk_settings', (c) => tableExists(c, 'bulk_settings'), `CREATE TABLE bulk_settings (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id           BIGINT UNSIGNED NOT NULL,
    online              TINYINT(1) NOT NULL DEFAULT 1,
    collection_days     VARCHAR(20) NOT NULL DEFAULT '1',
    cutoff_days_before  TINYINT UNSIGNED NOT NULL DEFAULT 4,
    cutoff_time         TIME NOT NULL DEFAULT '12:00:00',
    capacity            SMALLINT UNSIGNED NOT NULL DEFAULT 40,
    curb_by             TIME NOT NULL DEFAULT '06:00:00',
    pay_card            TINYINT(1) NOT NULL DEFAULT 1,
    pay_stickers        TINYINT(1) NOT NULL DEFAULT 1,
    office_name         VARCHAR(80) NOT NULL DEFAULT 'Borough Hall',
    rules_text          TEXT NULL,
    not_out_policy      ENUM('no_refund','credit','refund') NOT NULL DEFAULT 'no_refund',
    updated_by          BIGINT UNSIGNED NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bulk_settings_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bulk_settings_tenant (tenant_id),
    CONSTRAINT fk_bulk_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['bulk_sizes', (c) => tableExists(c, 'bulk_sizes'), `CREATE TABLE bulk_sizes (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    name         VARCHAR(40) NOT NULL,
    description  VARCHAR(255) NULL,
    price_cents  INT UNSIGNED NOT NULL DEFAULT 0,
    max_qty      TINYINT UNSIGNED NOT NULL DEFAULT 5,
    sort         SMALLINT NOT NULL DEFAULT 0,
    active       TINYINT(1) NOT NULL DEFAULT 1,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bulk_sizes_tenant_id (tenant_id, id),
    KEY ix_bulk_sizes_active (tenant_id, active, sort),
    CONSTRAINT fk_bulk_sizes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['bulk_skip_dates', (c) => tableExists(c, 'bulk_skip_dates'), `CREATE TABLE bulk_skip_dates (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    on_date     DATE NOT NULL,
    note        VARCHAR(120) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bulk_skip_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bulk_skip_date (tenant_id, on_date),
    CONSTRAINT fk_bulk_skip_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['bulk_bookings', (c) => tableExists(c, 'bulk_bookings'), `CREATE TABLE bulk_bookings (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id           BIGINT UNSIGNED NOT NULL,
    reference           VARCHAR(8) NOT NULL,
    view_token          CHAR(32) NOT NULL,
    collection_date     DATE NOT NULL,
    street_id           BIGINT UNSIGNED NOT NULL,
    house_number        VARCHAR(20) NOT NULL,
    unit                VARCHAR(20) NULL,
    resident_id         BIGINT UNSIGNED NULL,
    items_note          VARCHAR(300) NULL,
    source              ENUM('online','staff') NOT NULL DEFAULT 'online',
    status              ENUM('awaiting_payment','booked','cancelled','expired') NOT NULL DEFAULT 'booked',
    pay_method          ENUM('card','office','stickers','credit','free') NOT NULL,
    pay_status          ENUM('due','paid','not_needed','refund_due','refunded') NOT NULL DEFAULT 'due',
    total_cents         INT UNSIGNED NOT NULL DEFAULT 0,
    paid_cents          INT UNSIGNED NOT NULL DEFAULT 0,
    refunded_cents      INT UNSIGNED NOT NULL DEFAULT 0,
    paid_at             DATETIME NULL,
    pay_tries           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    held_until          DATETIME NULL,
    stripe_session_id   VARCHAR(255) NULL,
    payment_intent      VARCHAR(255) NULL,
    processor_account   VARCHAR(64) NULL,
    platform_fee_cents  INT UNSIGNED NOT NULL DEFAULT 0,
    texts_ok            TINYINT(1) NOT NULL DEFAULT 0,
    emails_ok           TINYINT(1) NOT NULL DEFAULT 0,
    reminded_at         DATETIME NULL,
    outcome             ENUM('picked_up','not_out','not_accepted') NULL,
    outcome_reason      VARCHAR(200) NULL,
    outcome_at          DATETIME NULL,
    outcome_by          BIGINT UNSIGNED NULL,
    outcome_lat         DECIMAL(9,6) NULL,
    outcome_lng         DECIMAL(9,6) NULL,
    outcome_photo_id    BIGINT UNSIGNED NULL,
    notified_at         DATETIME NULL,
    notified_via        VARCHAR(20) NULL,
    decision            ENUM('no_refund','refund','credit') NULL,
    decision_cents      INT UNSIGNED NULL,
    decision_note       VARCHAR(200) NULL,
    decided_by          BIGINT UNSIGNED NULL,
    decided_at          DATETIME NULL,
    credit_from_id      BIGINT UNSIGNED NULL,
    credit_used_by_id   BIGINT UNSIGNED NULL,
    cancelled_at        DATETIME NULL,
    cancelled_by        BIGINT UNSIGNED NULL,
    cancel_reason       VARCHAR(200) NULL,
    created_by          BIGINT UNSIGNED NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bulk_bookings_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bulk_bookings_ref (tenant_id, reference),
    UNIQUE KEY uq_bulk_bookings_token (view_token),
    KEY ix_bulk_bookings_day (tenant_id, collection_date, status),
    KEY ix_bulk_bookings_resident (tenant_id, resident_id),
    KEY ix_bulk_bookings_remind (status, reminded_at, collection_date),
    CONSTRAINT fk_bulk_bookings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bulk_bookings_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id),
    CONSTRAINT fk_bulk_bookings_resident FOREIGN KEY (tenant_id, resident_id) REFERENCES residents(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['bulk_booking_items', (c) => tableExists(c, 'bulk_booking_items'), `CREATE TABLE bulk_booking_items (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    booking_id   BIGINT UNSIGNED NOT NULL,
    size_id      BIGINT UNSIGNED NOT NULL,
    name         VARCHAR(40) NOT NULL,
    unit_cents   INT UNSIGNED NOT NULL DEFAULT 0,
    quantity     TINYINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_bulk_items_tenant_id (tenant_id, id),
    KEY ix_bulk_items_booking (tenant_id, booking_id),
    CONSTRAINT fk_bulk_items_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bulk_items_booking FOREIGN KEY (tenant_id, booking_id) REFERENCES bulk_bookings(tenant_id, id),
    CONSTRAINT fk_bulk_items_size FOREIGN KEY (tenant_id, size_id) REFERENCES bulk_sizes(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['bulk_photos', (c) => tableExists(c, 'bulk_photos'), `CREATE TABLE bulk_photos (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    booking_id    BIGINT UNSIGNED NOT NULL,
    mime          VARCHAR(40) NOT NULL,
    bytes         INT UNSIGNED NOT NULL,
    sha256        CHAR(64) NOT NULL,
    original      MEDIUMBLOB NOT NULL,
    taken_at      DATETIME NULL,
    taken_from    ENUM('photo','phone') NULL,
    taken_lat     DECIMAL(9,6) NULL,
    taken_lng     DECIMAL(9,6) NULL,
    client_ref    VARCHAR(40) NULL,
    uploaded_by   BIGINT UNSIGNED NULL,
    uploaded_at   DATETIME NOT NULL,
    UNIQUE KEY uq_bulk_photos_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bulk_photos_ref (tenant_id, client_ref),
    KEY ix_bulk_photos_booking (tenant_id, booking_id),
    CONSTRAINT fk_bulk_photos_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bulk_photos_booking FOREIGN KEY (tenant_id, booking_id) REFERENCES bulk_bookings(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];
