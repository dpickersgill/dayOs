'use strict';
// Trash and recycling, the full app (release 2026.11.22, workstream "tonnage"): carts, weigh tickets and tonnage, and the
// annual recycling report. Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//
// The collection streams and zones it points at are made by db/steps/trash-schedule.js, which runs first.
//
// This workstream's own tables:
//   cart_settings           one row per municipality: online cart requests on or off, extra carts allowed per stream
//   cart_options            the cart sizes offered per stream (35, 65, 95 gallons) and the fee for an extra or a replacement
//   carts                   the carts at each address (a service address when the water customer list has it, else street
//                           and house number): stream, size, serial or tag, delivered on, condition
//   cart_stock              carts in the yard by stream and size (never below zero), and cart_stock_moves, every change
//   cart_requests           new, extra, replacement and stolen cart requests, from the public page or taken by staff: the
//                           optional fee paid online through the municipality's own Stripe account, the delivery day
//   tonnage_facilities      landfills, transfer stations, recycling processors and compost sites, with the usual tipping
//                           fee per ton and the residue share the processor reports
//   weigh_ticket_imports    a facility's or a hauler's monthly report brought in from a spreadsheet
//   weigh_tickets           one weigh ticket: date, truck, stream and material, facility, gross, tare, net pounds, the fee
//   weigh_ticket_photos     the ticket's photo, kept exactly as taken with a SHA-256
//   recycling_reports       the year's Act 101 recycling report (opens in December, due to the county in February)
//   recycling_reporters     the haulers and businesses that must report to the municipality (FM-12/FM-13, FM-11)
//   recycling_report_forms  one reporter's online form for one year: its link (stored hashed), when it was sent,
//                           reminded and answered
//   recycling_report_lines  what a reporter (or the office for them) gave: tons of one material in the four columns,
//                           the residue, and the processor or market

module.exports = ({ tableExists }) => [
  // ---------------------------------------------------------------- carts
  ['cart_settings', (c) => tableExists(c, 'cart_settings'), `CREATE TABLE cart_settings (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    online         TINYINT(1) NOT NULL DEFAULT 1,
    max_extra      TINYINT UNSIGNED NOT NULL DEFAULT 2,
    rules_text     TEXT NULL,
    updated_by     BIGINT UNSIGNED NULL,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_cart_settings_tenant_id (tenant_id, id),
    UNIQUE KEY uq_cart_settings_tenant (tenant_id),
    CONSTRAINT fk_cart_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  ['cart_options', (c) => tableExists(c, 'cart_options'), `CREATE TABLE cart_options (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id               BIGINT UNSIGNED NOT NULL,
    stream_id               BIGINT UNSIGNED NOT NULL,
    size_gal                SMALLINT UNSIGNED NOT NULL,
    extra_fee_cents         INT UNSIGNED NOT NULL DEFAULT 0,
    replacement_fee_cents   INT UNSIGNED NOT NULL DEFAULT 0,
    active                  TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_cart_options_tenant_id (tenant_id, id),
    UNIQUE KEY uq_cart_options_size (tenant_id, stream_id, size_gal),
    CONSTRAINT fk_cart_options_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_cart_options_stream FOREIGN KEY (tenant_id, stream_id) REFERENCES collection_streams(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['carts', (c) => tableExists(c, 'carts'), `CREATE TABLE carts (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id           BIGINT UNSIGNED NOT NULL,
    service_address_id  BIGINT UNSIGNED NULL,
    street_id           BIGINT UNSIGNED NOT NULL,
    house_number        VARCHAR(20) NOT NULL,
    house_no            INT UNSIGNED NULL,
    unit                VARCHAR(20) NULL,
    stream_id           BIGINT UNSIGNED NOT NULL,
    size_gal            SMALLINT UNSIGNED NOT NULL,
    serial              VARCHAR(40) NULL,
    delivered_on        DATE NULL,
    cond                ENUM('good','damaged') NOT NULL DEFAULT 'good',
    status              ENUM('in_use','removed','stolen') NOT NULL DEFAULT 'in_use',
    removed_on          DATE NULL,
    request_id          BIGINT UNSIGNED NULL,
    note                VARCHAR(200) NULL,
    created_by          BIGINT UNSIGNED NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_carts_tenant_id (tenant_id, id),
    KEY ix_carts_address (tenant_id, street_id, house_no, status),
    KEY ix_carts_serial (tenant_id, serial),
    CONSTRAINT fk_carts_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_carts_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id),
    CONSTRAINT fk_carts_stream FOREIGN KEY (tenant_id, stream_id) REFERENCES collection_streams(tenant_id, id),
    CONSTRAINT fk_carts_service_address FOREIGN KEY (tenant_id, service_address_id) REFERENCES service_addresses(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['cart_stock', (c) => tableExists(c, 'cart_stock'), `CREATE TABLE cart_stock (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    stream_id   BIGINT UNSIGNED NOT NULL,
    size_gal    SMALLINT UNSIGNED NOT NULL,
    on_hand     INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_cart_stock_tenant_id (tenant_id, id),
    UNIQUE KEY uq_cart_stock_size (tenant_id, stream_id, size_gal),
    CONSTRAINT fk_cart_stock_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_cart_stock_stream FOREIGN KEY (tenant_id, stream_id) REFERENCES collection_streams(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['cart_stock_moves', (c) => tableExists(c, 'cart_stock_moves'), `CREATE TABLE cart_stock_moves (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    stream_id   BIGINT UNSIGNED NOT NULL,
    size_gal    SMALLINT UNSIGNED NOT NULL,
    delta       INT NOT NULL,
    reason      ENUM('received','delivered','returned','scrapped','count') NOT NULL,
    note        VARCHAR(200) NULL,
    request_id  BIGINT UNSIGNED NULL,
    on_hand     INT UNSIGNED NOT NULL,
    by_user     BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_cart_stock_moves_tenant_id (tenant_id, id),
    KEY ix_cart_stock_moves_when (tenant_id, created_at),
    CONSTRAINT fk_cart_stock_moves_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_cart_stock_moves_stream FOREIGN KEY (tenant_id, stream_id) REFERENCES collection_streams(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['cart_requests', (c) => tableExists(c, 'cart_requests'), `CREATE TABLE cart_requests (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id           BIGINT UNSIGNED NOT NULL,
    reference           VARCHAR(8) NOT NULL,
    view_token          CHAR(32) NOT NULL,
    kind                ENUM('new','extra','replacement','stolen') NOT NULL,
    stream_id           BIGINT UNSIGNED NOT NULL,
    size_gal            SMALLINT UNSIGNED NOT NULL,
    street_id           BIGINT UNSIGNED NOT NULL,
    house_number        VARCHAR(20) NOT NULL,
    house_no            INT UNSIGNED NULL,
    unit                VARCHAR(20) NULL,
    service_address_id  BIGINT UNSIGNED NULL,
    resident_id         BIGINT UNSIGNED NULL,
    contact_name        VARCHAR(120) NULL,
    contact_phone       VARCHAR(30) NULL,
    contact_email       VARCHAR(190) NULL,
    texts_ok            TINYINT(1) NOT NULL DEFAULT 0,
    emails_ok           TINYINT(1) NOT NULL DEFAULT 0,
    note                VARCHAR(300) NULL,
    police_report       VARCHAR(40) NULL,
    source              ENUM('online','staff') NOT NULL DEFAULT 'online',
    status              ENUM('awaiting_payment','open','scheduled','delivered','cancelled','expired') NOT NULL DEFAULT 'open',
    deliver_on          DATE NULL,
    delivered_at        DATETIME NULL,
    delivered_by        BIGINT UNSIGNED NULL,
    cart_id             BIGINT UNSIGNED NULL,
    old_cart_id         BIGINT UNSIGNED NULL,
    pay_method          ENUM('card','office','free') NOT NULL DEFAULT 'free',
    pay_status          ENUM('not_needed','due','paid','refund_due','refunded') NOT NULL DEFAULT 'not_needed',
    fee_cents           INT UNSIGNED NOT NULL DEFAULT 0,
    paid_cents          INT UNSIGNED NOT NULL DEFAULT 0,
    refunded_cents      INT UNSIGNED NOT NULL DEFAULT 0,
    paid_at             DATETIME NULL,
    pay_tries           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    stripe_session_id   VARCHAR(255) NULL,
    payment_intent      VARCHAR(255) NULL,
    processor_account   VARCHAR(64) NULL,
    platform_fee_cents  INT UNSIGNED NOT NULL DEFAULT 0,
    cancelled_at        DATETIME NULL,
    cancelled_by        BIGINT UNSIGNED NULL,
    cancel_reason       VARCHAR(200) NULL,
    created_by          BIGINT UNSIGNED NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_cart_requests_tenant_id (tenant_id, id),
    UNIQUE KEY uq_cart_requests_ref (tenant_id, reference),
    UNIQUE KEY uq_cart_requests_token (view_token),
    KEY ix_cart_requests_status (tenant_id, status, deliver_on),
    KEY ix_cart_requests_address (tenant_id, street_id, house_no),
    CONSTRAINT fk_cart_requests_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_cart_requests_stream FOREIGN KEY (tenant_id, stream_id) REFERENCES collection_streams(tenant_id, id),
    CONSTRAINT fk_cart_requests_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id),
    CONSTRAINT fk_cart_requests_resident FOREIGN KEY (tenant_id, resident_id) REFERENCES residents(tenant_id, id)
  ) ENGINE=InnoDB`],

  // ---------------------------------------------------------------- tonnage
  ['tonnage_facilities', (c) => tableExists(c, 'tonnage_facilities'), `CREATE TABLE tonnage_facilities (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id           BIGINT UNSIGNED NOT NULL,
    name                VARCHAR(120) NOT NULL,
    kind                ENUM('landfill','transfer','recycling','compost','other') NOT NULL,
    address             VARCHAR(200) NULL,
    fee_per_ton_cents   INT UNSIGNED NULL,
    residue_pct         DECIMAL(5,2) NOT NULL DEFAULT 0,
    active              TINYINT(1) NOT NULL DEFAULT 1,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_tonnage_facilities_tenant_id (tenant_id, id),
    UNIQUE KEY uq_tonnage_facilities_name (tenant_id, name),
    CONSTRAINT fk_tonnage_facilities_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  ['weigh_ticket_imports', (c) => tableExists(c, 'weigh_ticket_imports'), `CREATE TABLE weigh_ticket_imports (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    source_name   VARCHAR(120) NOT NULL,
    file_name     VARCHAR(160) NULL,
    rows_added    INT UNSIGNED NOT NULL DEFAULT 0,
    rows_skipped  INT UNSIGNED NOT NULL DEFAULT 0,
    created_by    BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_weigh_ticket_imports_tenant_id (tenant_id, id),
    CONSTRAINT fk_weigh_ticket_imports_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  ['weigh_tickets', (c) => tableExists(c, 'weigh_tickets'), `CREATE TABLE weigh_tickets (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    on_date         DATE NOT NULL,
    ticket_no       VARCHAR(40) NULL,
    facility_id     BIGINT UNSIGNED NOT NULL,
    stream_id       BIGINT UNSIGNED NULL,
    stream_kind     ENUM('trash','recycling','yard','food','other') NOT NULL,
    material        VARCHAR(30) NOT NULL,
    sector          ENUM('res_curb','res_dropoff','com_curb','com_dropoff') NOT NULL DEFAULT 'res_curb',
    zone_id         BIGINT UNSIGNED NULL,
    truck_asset_id  BIGINT UNSIGNED NULL,
    truck_label     VARCHAR(60) NULL,
    gross_lb        INT UNSIGNED NULL,
    tare_lb         INT UNSIGNED NULL,
    net_lb          INT UNSIGNED NOT NULL,
    fee_cents       INT UNSIGNED NULL,
    source          ENUM('office','driver','import') NOT NULL DEFAULT 'office',
    import_id       BIGINT UNSIGNED NULL,
    hauler          VARCHAR(120) NULL,
    note            VARCHAR(300) NULL,
    voided_at       DATETIME NULL,
    voided_by       BIGINT UNSIGNED NULL,
    void_reason     VARCHAR(200) NULL,
    entered_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_weigh_tickets_tenant_id (tenant_id, id),
    UNIQUE KEY uq_weigh_tickets_number (tenant_id, facility_id, ticket_no),
    KEY ix_weigh_tickets_date (tenant_id, on_date),
    CONSTRAINT fk_weigh_tickets_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_weigh_tickets_facility FOREIGN KEY (tenant_id, facility_id) REFERENCES tonnage_facilities(tenant_id, id),
    CONSTRAINT fk_weigh_tickets_stream FOREIGN KEY (tenant_id, stream_id) REFERENCES collection_streams(tenant_id, id),
    CONSTRAINT fk_weigh_tickets_zone FOREIGN KEY (tenant_id, zone_id) REFERENCES collection_zones(tenant_id, id),
    CONSTRAINT fk_weigh_tickets_truck FOREIGN KEY (tenant_id, truck_asset_id) REFERENCES ops_assets(tenant_id, id),
    CONSTRAINT fk_weigh_tickets_import FOREIGN KEY (tenant_id, import_id) REFERENCES weigh_ticket_imports(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['weigh_ticket_photos', (c) => tableExists(c, 'weigh_ticket_photos'), `CREATE TABLE weigh_ticket_photos (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    ticket_id     BIGINT UNSIGNED NOT NULL,
    mime          VARCHAR(40) NOT NULL,
    bytes         INT UNSIGNED NOT NULL,
    sha256        CHAR(64) NOT NULL,
    original      MEDIUMBLOB NOT NULL,
    taken_at      DATETIME NULL,
    client_ref    VARCHAR(40) NULL,
    uploaded_by   BIGINT UNSIGNED NULL,
    uploaded_at   DATETIME NOT NULL,
    UNIQUE KEY uq_weigh_ticket_photos_tenant_id (tenant_id, id),
    UNIQUE KEY uq_weigh_ticket_photos_ref (tenant_id, client_ref),
    KEY ix_weigh_ticket_photos_ticket (tenant_id, ticket_id),
    CONSTRAINT fk_weigh_ticket_photos_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_weigh_ticket_photos_ticket FOREIGN KEY (tenant_id, ticket_id) REFERENCES weigh_tickets(tenant_id, id)
  ) ENGINE=InnoDB`],

  // ---------------------------------------------------------------- the annual recycling report
  ['recycling_reports', (c) => tableExists(c, 'recycling_reports'), `CREATE TABLE recycling_reports (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    year          SMALLINT UNSIGNED NOT NULL,
    status        ENUM('open','closed') NOT NULL DEFAULT 'open',
    county        VARCHAR(60) NOT NULL DEFAULT 'Chester',
    due_on        DATE NOT NULL,
    followup_on   DATE NOT NULL,
    households    INT UNSIGNED NULL,
    population    INT UNSIGNED NULL,
    notes         TEXT NULL,
    opened_at     DATETIME NOT NULL,
    opened_by     BIGINT UNSIGNED NULL,
    followup_done_at DATETIME NULL,
    closed_at     DATETIME NULL,
    closed_by     BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_recycling_reports_tenant_id (tenant_id, id),
    UNIQUE KEY uq_recycling_reports_year (tenant_id, year),
    CONSTRAINT fk_recycling_reports_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  ['recycling_reporters', (c) => tableExists(c, 'recycling_reporters'), `CREATE TABLE recycling_reporters (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(120) NOT NULL,
    kind          ENUM('hauler','business') NOT NULL,
    contact_name  VARCHAR(120) NULL,
    email         VARCHAR(255) NULL,
    phone         VARCHAR(40) NULL,
    active        TINYINT(1) NOT NULL DEFAULT 1,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_recycling_reporters_tenant_id (tenant_id, id),
    UNIQUE KEY uq_recycling_reporters_name (tenant_id, name),
    CONSTRAINT fk_recycling_reporters_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  ['recycling_report_forms', (c) => tableExists(c, 'recycling_report_forms'), `CREATE TABLE recycling_report_forms (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    report_id     BIGINT UNSIGNED NOT NULL,
    reporter_id   BIGINT UNSIGNED NOT NULL,
    token_hash    CHAR(64) NULL,
    sent_at       DATETIME NULL,
    reminded_at   DATETIME NULL,
    followup_at   DATETIME NULL,
    answered_at   DATETIME NULL,
    answered_by   ENUM('reporter','office') NULL,
    answer_name   VARCHAR(120) NULL,
    none_to_report TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE KEY uq_recycling_report_forms_tenant_id (tenant_id, id),
    UNIQUE KEY uq_recycling_report_forms_one (tenant_id, report_id, reporter_id),
    UNIQUE KEY uq_recycling_report_forms_token (token_hash),
    CONSTRAINT fk_recycling_report_forms_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_recycling_report_forms_report FOREIGN KEY (tenant_id, report_id) REFERENCES recycling_reports(tenant_id, id),
    CONSTRAINT fk_recycling_report_forms_reporter FOREIGN KEY (tenant_id, reporter_id) REFERENCES recycling_reporters(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['recycling_report_lines', (c) => tableExists(c, 'recycling_report_lines'), `CREATE TABLE recycling_report_lines (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    form_id       BIGINT UNSIGNED NOT NULL,
    material      VARCHAR(30) NOT NULL,
    res_curb      DECIMAL(10,2) NOT NULL DEFAULT 0,
    res_dropoff   DECIMAL(10,2) NOT NULL DEFAULT 0,
    com_curb      DECIMAL(10,2) NOT NULL DEFAULT 0,
    com_dropoff   DECIMAL(10,2) NOT NULL DEFAULT 0,
    residue       DECIMAL(10,2) NOT NULL DEFAULT 0,
    processor     VARCHAR(160) NOT NULL,
    UNIQUE KEY uq_recycling_report_lines_tenant_id (tenant_id, id),
    KEY ix_recycling_report_lines_form (tenant_id, form_id),
    CONSTRAINT fk_recycling_report_lines_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_recycling_report_lines_form FOREIGN KEY (tenant_id, form_id) REFERENCES recycling_report_forms(tenant_id, id)
  ) ENGINE=InnoDB`],
];
