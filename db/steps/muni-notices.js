'use strict';
// Street notices and resident alerts (muni release 1, workstream "notices"). Loaded by db/migrate.js.
// Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   residents                   a resident contact (owned by the requests workstream; created here only when it is not
//                               there yet, with exactly the columns the shared spec lists)
//   alert_signups               one address a resident signed up for alerts at, the topics they picked, the phone and
//                               email they gave for it (alerts go to exactly these, once confirmed), and the code
//   alert_addresses             a phone (10-digit key) or email address: confirmed (code or link), stopped (STOP, an
//                               unsubscribe link) and how many codes it was sent. A "no" belongs to the address, not the record.
//   alert_consent_events        every yes and no to alert texts or emails, never edited
//   street_notices              a notice: type, message, times, the certified operator for a boil water advisory, status
//   street_notice_areas         the streets it covers: a whole street or a house-number range (odd, even or both sides)
//   street_notice_updates       each send: the first message, follow-ups, and "Ended"
//   street_notice_deliveries    the send queue and the log: one row per resident, channel and send, with its status
//   street_notice_settings      Crew logins who may send, and the municipality's own texting number (optional)
//   work_orders.source          gains 'notice' (the union every workstream lists)

const SOURCE_UNION = "'manual','inspection','preventive','request','program','notice'";

module.exports = ({ tableExists, columnExists }) => [
  ['residents', (c) => tableExists(c, 'residents'), `CREATE TABLE residents (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(120) NULL,
    phone         VARCHAR(40) NULL,
    email         VARCHAR(255) NULL,
    street_id     BIGINT UNSIGNED NULL,
    house_number  VARCHAR(20) NULL,
    unit          VARCHAR(20) NULL,
    texts_ok      TINYINT(1) NOT NULL DEFAULT 0,
    emails_ok     TINYINT(1) NOT NULL DEFAULT 0,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_residents_tenant_id (tenant_id, id),
    KEY ix_residents_phone (tenant_id, phone),
    KEY ix_residents_email (tenant_id, email),
    KEY ix_residents_street (tenant_id, street_id),
    CONSTRAINT fk_residents_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_residents_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['alert_signups', (c) => tableExists(c, 'alert_signups'), `CREATE TABLE alert_signups (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    resident_id      BIGINT UNSIGNED NOT NULL,
    street_id        BIGINT UNSIGNED NOT NULL,
    house_number     VARCHAR(20) NULL,
    house_no         INT UNSIGNED NULL,
    unit             VARCHAR(20) NULL,
    phone            VARCHAR(40) NULL,
    email            VARCHAR(255) NULL,
    topics           SET('water','streets','trash','leaves','news') NOT NULL DEFAULT 'water',
    by_text          TINYINT(1) NOT NULL DEFAULT 0,
    by_email         TINYINT(1) NOT NULL DEFAULT 0,
    status           ENUM('pending','active','ended') NOT NULL DEFAULT 'pending',
    source           ENUM('web','import','staff') NOT NULL DEFAULT 'web',
    consent_note     VARCHAR(300) NULL,
    code_hash        CHAR(64) NULL,
    code_expires_at  DATETIME NULL,
    code_tries       TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_by       BIGINT UNSIGNED NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at     DATETIME NULL,
    ended_at         DATETIME NULL,
    UNIQUE KEY uq_alert_signups_tenant_id (tenant_id, id),
    KEY ix_alert_signups_street (tenant_id, street_id, status, house_no),
    KEY ix_alert_signups_resident (tenant_id, resident_id, status),
    KEY ix_alert_signups_created (tenant_id, created_at),
    CONSTRAINT fk_alert_signups_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_alert_signups_resident FOREIGN KEY (tenant_id, resident_id) REFERENCES residents(tenant_id, id),
    CONSTRAINT fk_alert_signups_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['alert_addresses', (c) => tableExists(c, 'alert_addresses'), `CREATE TABLE alert_addresses (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    channel       ENUM('sms','email') NOT NULL,
    addr          VARCHAR(255) NOT NULL,
    confirmed_at  DATETIME NULL,
    confirmed_by  ENUM('code','link','import') NULL,
    stopped_at    DATETIME NULL,
    stop_source   VARCHAR(30) NULL,
    codes_sent    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    codes_from    DATETIME NULL,
    UNIQUE KEY uq_alert_addresses_tenant_id (tenant_id, id),
    UNIQUE KEY uq_alert_addresses_addr (tenant_id, channel, addr),
    KEY ix_alert_addresses_sms (channel, addr),
    CONSTRAINT fk_alert_addresses_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['alert_consent_events', (c) => tableExists(c, 'alert_consent_events'), `CREATE TABLE alert_consent_events (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    address_id    BIGINT UNSIGNED NOT NULL,
    status        ENUM('opted_in','opted_out') NOT NULL,
    source        VARCHAR(30) NOT NULL,
    recorded_by   BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_alert_consent_tenant_id (tenant_id, id),
    KEY ix_alert_consent_address (tenant_id, address_id, id),
    CONSTRAINT fk_alert_consent_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_alert_consent_address FOREIGN KEY (tenant_id, address_id) REFERENCES alert_addresses(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['street_notices', (c) => tableExists(c, 'street_notices'), `CREATE TABLE street_notices (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id         BIGINT UNSIGNED NOT NULL,
    code              CHAR(6) NOT NULL,
    type              ENUM('water_outage','boil_water','sewer','street_closure','paving','trash_change','leaf_collection','general') NOT NULL,
    title             VARCHAR(120) NOT NULL,
    sms_text          VARCHAR(320) NOT NULL,
    body              TEXT NULL,
    starts_at         DATETIME NULL,
    ends_expected_at  DATETIME NULL,
    status            ENUM('draft','scheduled','active','ended','cancelled') NOT NULL DEFAULT 'draft',
    issued_by_user_id BIGINT UNSIGNED NULL,
    issued_by_name    VARCHAR(120) NULL,
    work_order_id     BIGINT UNSIGNED NULL,
    created_by        BIGINT UNSIGNED NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at           DATETIME NULL,
    ended_at          DATETIME NULL,
    UNIQUE KEY uq_street_notices_tenant_id (tenant_id, id),
    UNIQUE KEY uq_street_notices_code (tenant_id, code),
    KEY ix_street_notices_status (tenant_id, status, id),
    CONSTRAINT fk_street_notices_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['street_notice_areas', (c) => tableExists(c, 'street_notice_areas'), `CREATE TABLE street_notice_areas (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    notice_id   BIGINT UNSIGNED NOT NULL,
    street_id   BIGINT UNSIGNED NOT NULL,
    from_no     INT UNSIGNED NULL,
    to_no       INT UNSIGNED NULL,
    side        ENUM('both','odd','even') NOT NULL DEFAULT 'both',
    UNIQUE KEY uq_street_notice_areas_tenant_id (tenant_id, id),
    KEY ix_street_notice_areas_notice (tenant_id, notice_id),
    CONSTRAINT fk_street_notice_areas_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_street_notice_areas_notice FOREIGN KEY (tenant_id, notice_id) REFERENCES street_notices(tenant_id, id),
    CONSTRAINT fk_street_notice_areas_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['street_notice_updates', (c) => tableExists(c, 'street_notice_updates'), `CREATE TABLE street_notice_updates (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    notice_id      BIGINT UNSIGNED NOT NULL,
    kind           ENUM('first','update','ended') NOT NULL,
    sms_text       VARCHAR(320) NOT NULL,
    body           TEXT NULL,
    status         ENUM('scheduled','queued','done','cancelled') NOT NULL DEFAULT 'queued',
    send_at        DATETIME NULL,
    base_url       VARCHAR(200) NULL,
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    queued_at      DATETIME NULL,
    UNIQUE KEY uq_street_notice_updates_tenant_id (tenant_id, id),
    KEY ix_street_notice_updates_notice (tenant_id, notice_id, id),
    KEY ix_street_notice_updates_due (status, send_at),
    CONSTRAINT fk_street_notice_updates_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_street_notice_updates_notice FOREIGN KEY (tenant_id, notice_id) REFERENCES street_notices(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['street_notice_deliveries', (c) => tableExists(c, 'street_notice_deliveries'), `CREATE TABLE street_notice_deliveries (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    notice_id     BIGINT UNSIGNED NOT NULL,
    update_id     BIGINT UNSIGNED NOT NULL,
    resident_id   BIGINT UNSIGNED NOT NULL,
    channel       ENUM('sms','email') NOT NULL,
    to_addr       VARCHAR(255) NULL,
    status        ENUM('queued','sending','sent','failed','opted_out') NOT NULL DEFAULT 'queued',
    error         VARCHAR(200) NULL,
    provider_id   VARCHAR(64) NULL,
    claim         CHAR(16) NULL,
    send_after    DATETIME NOT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at       DATETIME NULL,
    UNIQUE KEY uq_street_notice_deliveries_tenant_id (tenant_id, id),
    UNIQUE KEY uq_street_notice_deliveries_one (tenant_id, update_id, channel, to_addr),
    KEY ix_street_notice_deliveries_due (status, send_after),
    KEY ix_street_notice_deliveries_claim (claim),
    KEY ix_street_notice_deliveries_notice (tenant_id, notice_id, status),
    CONSTRAINT fk_street_notice_deliveries_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_street_notice_deliveries_update FOREIGN KEY (tenant_id, update_id) REFERENCES street_notice_updates(tenant_id, id),
    CONSTRAINT fk_street_notice_deliveries_resident FOREIGN KEY (tenant_id, resident_id) REFERENCES residents(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['street_notice_settings', (c) => tableExists(c, 'street_notice_settings'), `CREATE TABLE street_notice_settings (
    tenant_id     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    crew_senders  VARCHAR(500) NULL,
    from_number   VARCHAR(20) NULL,
    updated_by    BIGINT UNSIGNED NULL,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_street_notice_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // A work order opened from an outage notice says so (the shared definition: the union of every workstream's sources).
  ['work_orders.source notice', async (c) => {
    if (!(await columnExists(c, 'work_orders', 'source'))) return true;
    const [r] = await c.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'source'");
    return String((r[0] || {}).t || (r[0] || {}).COLUMN_TYPE || '').includes("'notice'");
  }, `ALTER TABLE work_orders MODIFY source ENUM(${SOURCE_UNION}) NOT NULL DEFAULT 'manual'`],
];
