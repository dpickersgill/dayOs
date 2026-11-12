'use strict';
// Release 2026.11.20, workstream "utilities": main breaks, the water customer list, Chapter 94, MS4, illicit discharge
// cases, the bulk pickup route order. Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   map_features.street_id            the street a main, valve, hydrant or manhole is on (search, valves along the same street)
//   map_features.pump_gpm             a pump station's rated flow per pump, JSON { "pump1_hours": 350 } (Chapter 94 flow)
//   main_breaks, main_break_valves    a break on a water main: when, where, cause, the pipe, customers out, boil water,
//                                     its work order and repair; the valves operated to shut it down
//   service_address_imports           each import of the water customer list, with the consent attestation (audited)
//   service_addresses                 a water service address from the billing system: street, house number, unit,
//                                     account number, and a phone or email only when the import attested consent
//   street_notice_deliveries          resident_id may be empty; service_address_id for a message to a water customer
//   sewer_ch94_years                  new connections (EDUs) entered per year for the Chapter 94 report
//   sewer_overflows                   sanitary sewer overflows (SSOs)
//   ms4_settings, ms4_activities      the MS4 permit number and screenings required; the year's records by minimum
//                                     control measure (education, involvement, construction, post-construction, housekeeping)
//   idd_cases, idd_case_entries       illicit discharge cases opened from a failed outfall screening, and their tracing log
//   bulk_route_order                  the order streets are driven on each collection weekday, and house number direction
// Map items are referred to without a foreign key (a map item can be deleted or abandoned; its records stay readable).

const indexExists = async (c, table, name) => {
  const [r] = await c.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return r.length > 0;
};
const nullable = async (c, table, column) => {
  const [r] = await c.query('SELECT is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r[0] && r[0].n === 'YES');
};

module.exports = ({ tableExists, columnExists }) => [
  ['map_features.street_id', (c) => columnExists(c, 'map_features', 'street_id'), 'ALTER TABLE map_features ADD COLUMN street_id BIGINT UNSIGNED NULL'],
  ['map_features by street', (c) => indexExists(c, 'map_features', 'ix_mf_street'), 'ALTER TABLE map_features ADD INDEX ix_mf_street (tenant_id, street_id, kind)'],
  ['map_features.pump_gpm', (c) => columnExists(c, 'map_features', 'pump_gpm'), 'ALTER TABLE map_features ADD COLUMN pump_gpm VARCHAR(300) NULL'],

  ['main_breaks', (c) => tableExists(c, 'main_breaks'), `CREATE TABLE main_breaks (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    main_id         BIGINT UNSIGNED NULL,
    street_id       BIGINT UNSIGNED NULL,
    location        VARCHAR(200) NULL,
    lat             DECIMAL(9,6) NULL,
    lng             DECIMAL(9,6) NULL,
    broke_at        DATETIME NOT NULL,
    cause           ENUM('age','corrosion','frost','ground_movement','pressure','joint','third_party','unknown','other') NOT NULL DEFAULT 'unknown',
    pipe_material   VARCHAR(40) NULL,
    pipe_size       VARCHAR(40) NULL,
    customers_out   INT UNSIGNED NULL,
    boil_water      TINYINT(1) NOT NULL DEFAULT 0,
    notice_id       BIGINT UNSIGNED NULL,
    work_order_id   BIGINT UNSIGNED NULL,
    water_off_at    DATETIME NULL,
    water_on_at     DATETIME NULL,
    repair          VARCHAR(1000) NULL,
    repaired_at     DATETIME NULL,
    status          ENUM('open','repaired') NOT NULL DEFAULT 'open',
    notes           VARCHAR(1000) NULL,
    created_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_main_breaks_tenant_id (tenant_id, id),
    KEY ix_main_breaks_main (tenant_id, main_id, broke_at),
    KEY ix_main_breaks_when (tenant_id, broke_at),
    CONSTRAINT fk_main_breaks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_main_breaks_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['main_break_valves', (c) => tableExists(c, 'main_break_valves'), `CREATE TABLE main_break_valves (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    break_id    BIGINT UNSIGNED NOT NULL,
    valve_id    BIGINT UNSIGNED NOT NULL,
    closed_at   DATETIME NULL,
    opened_at   DATETIME NULL,
    turns       DECIMAL(5,1) NULL,
    note        VARCHAR(255) NULL,
    UNIQUE KEY uq_mbv_tenant_id (tenant_id, id),
    UNIQUE KEY uq_mbv_one (tenant_id, break_id, valve_id),
    KEY ix_mbv_valve (tenant_id, valve_id),
    CONSTRAINT fk_mbv_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_mbv_break FOREIGN KEY (tenant_id, break_id) REFERENCES main_breaks(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['service_address_imports', (c) => tableExists(c, 'service_address_imports'), `CREATE TABLE service_address_imports (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    file_name      VARCHAR(200) NULL,
    rows_in        INT UNSIGNED NOT NULL DEFAULT 0,
    added          INT UNSIGNED NOT NULL DEFAULT 0,
    updated        INT UNSIGNED NOT NULL DEFAULT 0,
    ended          INT UNSIGNED NOT NULL DEFAULT 0,
    skipped        INT UNSIGNED NOT NULL DEFAULT 0,
    with_contacts  INT UNSIGNED NOT NULL DEFAULT 0,
    consent        TINYINT(1) NOT NULL DEFAULT 0,
    consent_note   VARCHAR(300) NULL,
    replace_all    TINYINT(1) NOT NULL DEFAULT 0,
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sai_tenant_id (tenant_id, id),
    CONSTRAINT fk_sai_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['service_addresses', (c) => tableExists(c, 'service_addresses'), `CREATE TABLE service_addresses (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    street_id       BIGINT UNSIGNED NOT NULL,
    house_number    VARCHAR(20) NULL,
    house_no        INT UNSIGNED NULL,
    unit            VARCHAR(20) NULL,
    account_number  VARCHAR(40) NULL,
    match_key       VARCHAR(160) NOT NULL,
    phone           VARCHAR(40) NULL,
    email           VARCHAR(255) NULL,
    contact_ok      TINYINT(1) NOT NULL DEFAULT 0,
    import_id       BIGINT UNSIGNED NULL,
    active          TINYINT(1) NOT NULL DEFAULT 1,
    ended_at        DATETIME NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_service_addresses_tenant_id (tenant_id, id),
    UNIQUE KEY uq_service_addresses_key (tenant_id, match_key),
    KEY ix_service_addresses_street (tenant_id, street_id, active, house_no),
    CONSTRAINT fk_service_addresses_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_service_addresses_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id),
    CONSTRAINT fk_service_addresses_import FOREIGN KEY (tenant_id, import_id) REFERENCES service_address_imports(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['street_notice_deliveries.resident_id optional', (c) => nullable(c, 'street_notice_deliveries', 'resident_id'), 'ALTER TABLE street_notice_deliveries MODIFY resident_id BIGINT UNSIGNED NULL'],
  ['street_notice_deliveries.service_address_id', (c) => columnExists(c, 'street_notice_deliveries', 'service_address_id'), 'ALTER TABLE street_notice_deliveries ADD COLUMN service_address_id BIGINT UNSIGNED NULL'],

  ['sewer_ch94_years', (c) => tableExists(c, 'sewer_ch94_years'), `CREATE TABLE sewer_ch94_years (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    year            SMALLINT UNSIGNED NOT NULL,
    new_edus        INT UNSIGNED NOT NULL DEFAULT 0,
    projected_edus  INT UNSIGNED NULL,
    notes           VARCHAR(500) NULL,
    updated_by      BIGINT UNSIGNED NULL,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ch94_tenant_id (tenant_id, id),
    UNIQUE KEY uq_ch94_year (tenant_id, year),
    CONSTRAINT fk_ch94_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['sewer_overflows', (c) => tableExists(c, 'sewer_overflows'), `CREATE TABLE sewer_overflows (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id           BIGINT UNSIGNED NOT NULL,
    map_feature_id      BIGINT UNSIGNED NULL,
    location            VARCHAR(200) NULL,
    started_at          DATETIME NOT NULL,
    ended_at            DATETIME NULL,
    gallons             INT UNSIGNED NULL,
    cause               ENUM('rain','blockage','grease','roots','pump_failure','power','other') NOT NULL DEFAULT 'other',
    reached_water       TINYINT(1) NOT NULL DEFAULT 0,
    reported_to_dep_at  DATETIME NULL,
    notes               VARCHAR(1000) NULL,
    created_by          BIGINT UNSIGNED NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sso_tenant_id (tenant_id, id),
    KEY ix_sso_when (tenant_id, started_at),
    CONSTRAINT fk_sso_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  ['ms4_settings', (c) => tableExists(c, 'ms4_settings'), `CREATE TABLE ms4_settings (
    tenant_id            BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    permit_number        VARCHAR(40) NULL,
    screenings_required  INT UNSIGNED NULL,
    updated_by           BIGINT UNSIGNED NULL,
    updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ms4_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['ms4_activities', (c) => tableExists(c, 'ms4_activities'), `CREATE TABLE ms4_activities (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    kind            ENUM('education','involvement','construction','post_construction','housekeeping','training') NOT NULL,
    on_date         DATE NOT NULL,
    title           VARCHAR(200) NOT NULL,
    audience        VARCHAR(200) NULL,
    people          INT UNSIGNED NULL,
    location        VARCHAR(200) NULL,
    attendees       TEXT NULL,
    result          ENUM('pass','fail','na') NOT NULL DEFAULT 'na',
    map_feature_id  BIGINT UNSIGNED NULL,
    notes           VARCHAR(1000) NULL,
    created_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ms4_act_tenant_id (tenant_id, id),
    KEY ix_ms4_act_date (tenant_id, on_date, kind),
    CONSTRAINT fk_ms4_act_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  ['idd_cases', (c) => tableExists(c, 'idd_cases'), `CREATE TABLE idd_cases (
    id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id          BIGINT UNSIGNED NOT NULL,
    reference          VARCHAR(20) NOT NULL,
    outfall_id         BIGINT UNSIGNED NULL,
    inspection_id      BIGINT UNSIGNED NULL,
    opened_at          DATETIME NOT NULL,
    status             ENUM('open','source_found','resolved','closed') NOT NULL DEFAULT 'open',
    description        VARCHAR(1000) NULL,
    suspected_source   VARCHAR(200) NULL,
    responsible_party  VARCHAR(200) NULL,
    resolution         VARCHAR(1000) NULL,
    resolved_at        DATETIME NULL,
    closed_at          DATETIME NULL,
    created_by         BIGINT UNSIGNED NULL,
    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_idd_tenant_id (tenant_id, id),
    UNIQUE KEY uq_idd_reference (tenant_id, reference),
    KEY ix_idd_outfall (tenant_id, outfall_id, status),
    CONSTRAINT fk_idd_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['idd_case_entries', (c) => tableExists(c, 'idd_case_entries'), `CREATE TABLE idd_case_entries (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    case_id         BIGINT UNSIGNED NOT NULL,
    kind            ENUM('trace','upstream','sample','notice','note') NOT NULL DEFAULT 'note',
    on_date         DATE NOT NULL,
    body            VARCHAR(2000) NOT NULL,
    map_feature_id  BIGINT UNSIGNED NULL,
    user_id         BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_idde_tenant_id (tenant_id, id),
    KEY ix_idde_case (tenant_id, case_id, on_date),
    CONSTRAINT fk_idde_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_idde_case FOREIGN KEY (tenant_id, case_id) REFERENCES idd_cases(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['bulk_route_order', (c) => tableExists(c, 'bulk_route_order'), `CREATE TABLE bulk_route_order (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    weekday     TINYINT UNSIGNED NOT NULL,
    street_id   BIGINT UNSIGNED NOT NULL,
    position    SMALLINT UNSIGNED NOT NULL,
    direction   ENUM('up','down') NOT NULL DEFAULT 'up',
    updated_by  BIGINT UNSIGNED NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bro_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bro_street (tenant_id, weekday, street_id),
    CONSTRAINT fk_bro_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bro_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id)
  ) ENGINE=InnoDB`],
];
