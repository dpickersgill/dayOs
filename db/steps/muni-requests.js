'use strict';
// Resident requests with a repair record (muni release 1, workstream "requests"). Loaded by db/migrate.js.
// Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   residents              a resident contact, separate from customers and from everything public (shared with bulk pickup
//                          and street notices through src/lib/residents.js upsertResident)
//   resident_consent       every yes or no a resident gave to texts and emails, one row each, never edited
//   request_categories     what residents can report (Pothole, Street light out, ...), set by a manager
//   request_standards      the manager's response standard: hours to make safe and to fix, per category and street class
//   request_settings       the after-hours number, the public map switch, who is alerted about new requests
//   requests               one report: where, what, who told us and when, and every time that proves what was done
//   request_photos         photos kept as taken, each with its SHA-256 fingerprint and who added it when
//   request_events         the request's own timeline: internal notes and what happened
//   request_messages       each status text or email to the resident (the kind and whether it went, never the address)
//   streets.street_class   Local, Collector or Arterial, for response standards by street class
//   work_orders.request_id and source 'request' (spec: the union of every workstream's sources)

const typeHas = async (conn, table, column, needle) => {
  const [r] = await conn.query('SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r.length && String(r[0].t).includes(needle));
};
const indexExists = async (conn, table, index) => {
  const [r] = await conn.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1', [table, index]);
  return r.length > 0;
};

// The residents table exactly as the shared spec lists it. Other workstreams create the same definition until this one is
// merged; the assembler keeps this one.
const RESIDENTS = `CREATE TABLE residents (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(120) NULL,
    phone         VARCHAR(30) NULL,
    email         VARCHAR(190) NULL,
    street_id     BIGINT UNSIGNED NULL,
    house_number  VARCHAR(20) NULL,
    unit          VARCHAR(20) NULL,
    texts_ok      TINYINT(1) NOT NULL DEFAULT 0,
    emails_ok     TINYINT(1) NOT NULL DEFAULT 0,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_residents_tenant_id (tenant_id, id),
    KEY ix_residents_email (tenant_id, email),
    KEY ix_residents_street (tenant_id, street_id),
    CONSTRAINT fk_residents_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_residents_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id)
  ) ENGINE=InnoDB`;

module.exports = ({ tableExists, columnExists }) => [
  ['streets.street_class', (c) => columnExists(c, 'streets', 'street_class'),
    "ALTER TABLE streets ADD COLUMN street_class ENUM('local','collector','arterial') NOT NULL DEFAULT 'local'"],
  ['residents', (c) => tableExists(c, 'residents'), RESIDENTS],
  ['resident_consent', (c) => tableExists(c, 'resident_consent'), `CREATE TABLE resident_consent (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    resident_id   BIGINT UNSIGNED NOT NULL,
    channel       ENUM('email','sms') NOT NULL,
    status        ENUM('opted_in','opted_out') NOT NULL,
    source        VARCHAR(30) NOT NULL,
    wording       VARCHAR(20) NOT NULL,
    recorded_by   BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_resident_consent_tenant_id (tenant_id, id),
    KEY ix_resident_consent (tenant_id, resident_id, channel, id),
    CONSTRAINT fk_resident_consent_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_resident_consent_resident FOREIGN KEY (tenant_id, resident_id) REFERENCES residents(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['request_categories', (c) => tableExists(c, 'request_categories'), `CREATE TABLE request_categories (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    name           VARCHAR(60) NOT NULL,
    needs_contact  TINYINT(1) NOT NULL DEFAULT 0,
    after_hours    TINYINT(1) NOT NULL DEFAULT 0,
    color          CHAR(7) NOT NULL DEFAULT '#5b6770',
    active         TINYINT(1) NOT NULL DEFAULT 1,
    sort           SMALLINT NOT NULL DEFAULT 0,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_request_categories_tenant_id (tenant_id, id),
    UNIQUE KEY uq_request_categories_name (tenant_id, name),
    CONSTRAINT fk_request_categories_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['request_standards', (c) => tableExists(c, 'request_standards'), `CREATE TABLE request_standards (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    category_id      BIGINT UNSIGNED NOT NULL,
    street_class     ENUM('any','local','collector','arterial') NOT NULL DEFAULT 'any',
    make_safe_hours  INT UNSIGNED NULL,
    fix_hours        INT UNSIGNED NULL,
    updated_by       BIGINT UNSIGNED NULL,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_request_standards_tenant_id (tenant_id, id),
    UNIQUE KEY uq_request_standards_key (tenant_id, category_id, street_class),
    CONSTRAINT fk_request_standards_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_request_standards_category FOREIGN KEY (tenant_id, category_id) REFERENCES request_categories(tenant_id, id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['request_settings', (c) => tableExists(c, 'request_settings'), `CREATE TABLE request_settings (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id          BIGINT UNSIGNED NOT NULL,
    after_hours_phone  VARCHAR(30) NULL,
    office_phone       VARCHAR(30) NULL,
    intro              VARCHAR(500) NULL,
    public_map         TINYINT(1) NOT NULL DEFAULT 0,
    alert_user_ids     VARCHAR(1000) NULL,
    alert_thread_id    BIGINT UNSIGNED NULL,
    updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_request_settings_tenant_id (tenant_id, id),
    UNIQUE KEY uq_request_settings_tenant (tenant_id),
    CONSTRAINT fk_request_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['requests', (c) => tableExists(c, 'requests'), `CREATE TABLE requests (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id         BIGINT UNSIGNED NOT NULL,
    reference         VARCHAR(12) NOT NULL,
    status_token      CHAR(32) NOT NULL,
    category_id       BIGINT UNSIGNED NOT NULL,
    street_id         BIGINT UNSIGNED NULL,
    house_number      VARCHAR(20) NULL,
    cross_street      VARCHAR(120) NULL,
    lat               DECIMAL(9,6) NULL,
    lng               DECIMAL(9,6) NULL,
    accuracy_m        INT UNSIGNED NULL,
    description       VARCHAR(1000) NULL,
    source            ENUM('web','phone','walk_in','crew','email','text') NOT NULL DEFAULT 'web',
    resident_id       BIGINT UNSIGNED NULL,
    updates_by_text   TINYINT(1) NOT NULL DEFAULT 0,
    updates_by_email  TINYINT(1) NOT NULL DEFAULT 0,
    reported_at       DATETIME NOT NULL,
    status            ENUM('new','assigned','made_safe','fixed','closed_no_action','duplicate','referred') NOT NULL DEFAULT 'new',
    priority          ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
    referred_to       VARCHAR(120) NULL,
    referred_at       DATETIME NULL,
    duplicate_of      BIGINT UNSIGNED NULL,
    closed_reason     VARCHAR(500) NULL,
    work_order_id     BIGINT UNSIGNED NULL,
    assigned_at       DATETIME NULL,
    made_safe_at      DATETIME NULL,
    made_safe_note    VARCHAR(500) NULL,
    fixed_at          DATETIME NULL,
    closed_at         DATETIME NULL,
    public_note       VARCHAR(500) NULL,
    request_key       CHAR(32) NULL,
    sender_hash       CHAR(16) NULL,
    created_by        BIGINT UNSIGNED NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_requests_tenant_id (tenant_id, id),
    UNIQUE KEY uq_requests_reference (tenant_id, reference),
    UNIQUE KEY uq_requests_token (status_token),
    UNIQUE KEY uq_requests_key (tenant_id, request_key),
    KEY ix_requests_status (tenant_id, status, reported_at),
    KEY ix_requests_street (tenant_id, street_id, reported_at),
    KEY ix_requests_reported (tenant_id, reported_at),
    KEY ix_requests_work_order (tenant_id, work_order_id),
    CONSTRAINT fk_requests_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_requests_category FOREIGN KEY (tenant_id, category_id) REFERENCES request_categories(tenant_id, id),
    CONSTRAINT fk_requests_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id),
    CONSTRAINT fk_requests_resident FOREIGN KEY (tenant_id, resident_id) REFERENCES residents(tenant_id, id),
    CONSTRAINT fk_requests_duplicate FOREIGN KEY (tenant_id, duplicate_of) REFERENCES requests(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['request_photos', (c) => tableExists(c, 'request_photos'), `CREATE TABLE request_photos (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    request_id    BIGINT UNSIGNED NOT NULL,
    stage         ENUM('report','before','made_safe','after') NOT NULL,
    mime          VARCHAR(40) NOT NULL,
    bytes         INT UNSIGNED NOT NULL,
    sha256        CHAR(64) NOT NULL,
    original      MEDIUMBLOB NOT NULL,
    taken_at      DATETIME NULL,
    taken_from    ENUM('photo','phone') NULL,
    taken_lat     DECIMAL(9,6) NULL,
    taken_lng     DECIMAL(9,6) NULL,
    client_ref    VARCHAR(40) NULL,
    by_resident   TINYINT(1) NOT NULL DEFAULT 0,
    uploaded_by   BIGINT UNSIGNED NULL,
    uploaded_at   DATETIME NOT NULL,
    UNIQUE KEY uq_request_photos_tenant_id (tenant_id, id),
    UNIQUE KEY uq_request_photos_ref (tenant_id, client_ref),
    KEY ix_request_photos (tenant_id, request_id, stage),
    CONSTRAINT fk_request_photos_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_request_photos_request FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['request_events', (c) => tableExists(c, 'request_events'), `CREATE TABLE request_events (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    request_id    BIGINT UNSIGNED NOT NULL,
    at            DATETIME NOT NULL,
    kind          ENUM('note','event') NOT NULL DEFAULT 'event',
    body          VARCHAR(1000) NOT NULL,
    user_id       BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_request_events_tenant_id (tenant_id, id),
    KEY ix_request_events (tenant_id, request_id, id),
    CONSTRAINT fk_request_events_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_request_events_request FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['request_messages', (c) => tableExists(c, 'request_messages'), `CREATE TABLE request_messages (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    request_id    BIGINT UNSIGNED NOT NULL,
    kind          ENUM('received','scheduled','fixed','closed') NOT NULL,
    channel       ENUM('sms','email') NOT NULL,
    ok            TINYINT(1) NOT NULL DEFAULT 0,
    error         VARCHAR(200) NULL,
    at            DATETIME NOT NULL,
    UNIQUE KEY uq_request_messages_tenant_id (tenant_id, id),
    KEY ix_request_messages (tenant_id, request_id, kind),
    CONSTRAINT fk_request_messages_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_request_messages_request FOREIGN KEY (tenant_id, request_id) REFERENCES requests(tenant_id, id)
  ) ENGINE=InnoDB`],
  // Work order additions, exactly as the spec defines them (assets-core owns them; guarded so either may add them first).
  ['work_orders.request_id', (c) => columnExists(c, 'work_orders', 'request_id'), 'ALTER TABLE work_orders ADD COLUMN request_id BIGINT UNSIGNED NULL'],
  ['work_orders source request', (c) => typeHas(c, 'work_orders', 'source', "'request'"),
    "ALTER TABLE work_orders MODIFY source ENUM('manual','inspection','preventive','request','program','notice') NOT NULL DEFAULT 'manual'"],
  ['work_orders by request', (c) => indexExists(c, 'work_orders', 'ix_wo_request'), 'ALTER TABLE work_orders ADD INDEX ix_wo_request (tenant_id, request_id)'],
];

module.exports.RESIDENTS = RESIDENTS;
