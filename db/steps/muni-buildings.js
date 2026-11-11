'use strict';
// Buildings (muni release 1, the `buildings` add-on): a municipality's own properties and the life-safety work on them.
// Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   buildings                  a property with an address, type, year built and size; its place on the asset register is
//                              an asset_locations row (kind 'building'), and its rooms are locations inside that one
//   building_settings          one row per municipality: when the life-safety library was seeded, the Documents category for
//                              certificates and the Inbox conversation for certificate reminders
//   life_safety_tasks          the library: recurring checks (who does them, how often, the standard, the checklist)
//   building_plans             which service plan (pm_tasks) is which library check on which piece of equipment
//   building_visits, _items    a vendor's visit: the items it covered, the result of each, and the report or certificate
//   building_certificates      certificates of operation (elevator, boiler) with their expiry dates
//   building_cert_reminders    the 60, 30 and 7 day reminders already sent for a certificate
//   building_rounds, _stops    a staff round through a building's items (the custodian's monthly round)
//   building_photos            a photo taken on a round, kept as taken with its SHA-256
//   building_deficiencies      something found wrong (a failed check, a vendor's finding) and the work order that fixes it
//   building_documents         reports, certificates and plans filed under a building (the files live in Documents)
// No table here holds a resident's name, phone, email or address.

const BLURB = 'Life-safety inspections for the municipality\'s own buildings: the calendar of checks, vendor visits and certificates, staff rounds, and the binder for the insurer or fire marshal.';
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

module.exports = ({ tableExists }) => [
  ['buildings', (c) => tableExists(c, 'buildings'), `CREATE TABLE buildings (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    location_id  BIGINT UNSIGNED NOT NULL,
    name         VARCHAR(100) NOT NULL,
    type         ENUM('office','police','garage','library','community','pump_house','park','pool','other') NOT NULL DEFAULT 'other',
    street_id    BIGINT UNSIGNED NULL,
    house_number VARCHAR(20) NULL,
    address      VARCHAR(150) NULL,
    year_built   SMALLINT UNSIGNED NULL,
    square_feet  INT UNSIGNED NULL,
    notes        VARCHAR(500) NULL,
    active       TINYINT(1) NOT NULL DEFAULT 1,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_buildings_tenant_id (tenant_id, id),
    UNIQUE KEY uq_buildings_name (tenant_id, name),
    UNIQUE KEY uq_buildings_location (tenant_id, location_id),
    CONSTRAINT fk_buildings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_buildings_location FOREIGN KEY (tenant_id, location_id) REFERENCES asset_locations(tenant_id, id),
    CONSTRAINT fk_buildings_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_settings', (c) => tableExists(c, 'building_settings'), `CREATE TABLE building_settings (
    tenant_id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    library_seeded_at DATETIME NULL,
    doc_category_id   BIGINT UNSIGNED NULL,
    thread_id         BIGINT UNSIGNED NULL,
    CONSTRAINT fk_bset_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['life_safety_tasks', (c) => tableExists(c, 'life_safety_tasks'), `CREATE TABLE life_safety_tasks (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    code          VARCHAR(40) NULL,
    name          VARCHAR(120) NOT NULL,
    kind          VARCHAR(30) NOT NULL,
    who           ENUM('staff','vendor') NOT NULL DEFAULT 'staff',
    interval_days SMALLINT UNSIGNED NOT NULL,
    standard      VARCHAR(120) NULL,
    template_id   BIGINT UNSIGNED NULL,
    certificate   VARCHAR(80) NULL,
    vendor_id     BIGINT UNSIGNED NULL,
    notes         VARCHAR(500) NULL,
    active        TINYINT(1) NOT NULL DEFAULT 1,
    sort          SMALLINT UNSIGNED NOT NULL DEFAULT 100,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_lst_tenant_id (tenant_id, id),
    UNIQUE KEY uq_lst_name (tenant_id, name),
    UNIQUE KEY uq_lst_code (tenant_id, code),
    KEY ix_lst_kind (tenant_id, kind, active),
    CONSTRAINT fk_lst_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_lst_template FOREIGN KEY (tenant_id, template_id) REFERENCES inspection_templates(tenant_id, id),
    CONSTRAINT fk_lst_vendor FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_plans', (c) => tableExists(c, 'building_plans'), `CREATE TABLE building_plans (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    pm_task_id  BIGINT UNSIGNED NOT NULL,
    task_id     BIGINT UNSIGNED NOT NULL,
    asset_id    BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY uq_bplan_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bplan_pm (tenant_id, pm_task_id),
    UNIQUE KEY uq_bplan_task_asset (tenant_id, task_id, asset_id),
    CONSTRAINT fk_bplan_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bplan_pm FOREIGN KEY (tenant_id, pm_task_id) REFERENCES pm_tasks(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_bplan_task FOREIGN KEY (tenant_id, task_id) REFERENCES life_safety_tasks(tenant_id, id),
    CONSTRAINT fk_bplan_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_visits', (c) => tableExists(c, 'building_visits'), `CREATE TABLE building_visits (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    vendor_id   BIGINT UNSIGNED NOT NULL,
    visit_on    DATE NOT NULL,
    technician  VARCHAR(100) NULL,
    notes       VARCHAR(1000) NULL,
    document_id BIGINT UNSIGNED NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bvisit_tenant_id (tenant_id, id),
    KEY ix_bvisit_on (tenant_id, visit_on),
    CONSTRAINT fk_bvisit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bvisit_vendor FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_certificates', (c) => tableExists(c, 'building_certificates'), `CREATE TABLE building_certificates (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    asset_id    BIGINT UNSIGNED NOT NULL,
    name        VARCHAR(80) NOT NULL,
    number      VARCHAR(60) NULL,
    issued_on   DATE NULL,
    expires_on  DATE NOT NULL,
    document_id BIGINT UNSIGNED NULL,
    visit_id    BIGINT UNSIGNED NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bcert_tenant_id (tenant_id, id),
    KEY ix_bcert_asset (tenant_id, asset_id, expires_on),
    KEY ix_bcert_expires (tenant_id, expires_on),
    CONSTRAINT fk_bcert_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bcert_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_visit_items', (c) => tableExists(c, 'building_visit_items'), `CREATE TABLE building_visit_items (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    visit_id       BIGINT UNSIGNED NOT NULL,
    pm_task_id     BIGINT UNSIGNED NULL,
    task_id        BIGINT UNSIGNED NULL,
    asset_id       BIGINT UNSIGNED NOT NULL,
    task_name      VARCHAR(120) NOT NULL,
    result         ENUM('pass','fail','na') NOT NULL,
    note           VARCHAR(500) NULL,
    inspection_id  BIGINT UNSIGNED NULL,
    work_order_id  BIGINT UNSIGNED NULL,
    certificate_id BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_bvitem_tenant_id (tenant_id, id),
    KEY ix_bvitem_visit (tenant_id, visit_id),
    KEY ix_bvitem_asset (tenant_id, asset_id),
    CONSTRAINT fk_bvitem_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bvitem_visit FOREIGN KEY (tenant_id, visit_id) REFERENCES building_visits(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_bvitem_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_cert_reminders', (c) => tableExists(c, 'building_cert_reminders'), `CREATE TABLE building_cert_reminders (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    certificate_id BIGINT UNSIGNED NOT NULL,
    days           SMALLINT NOT NULL,
    state          ENUM('sent','skipped') NOT NULL DEFAULT 'sent',
    at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bcrem_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bcrem_once (tenant_id, certificate_id, days),
    CONSTRAINT fk_bcrem_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bcrem_cert FOREIGN KEY (tenant_id, certificate_id) REFERENCES building_certificates(tenant_id, id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['building_rounds', (c) => tableExists(c, 'building_rounds'), `CREATE TABLE building_rounds (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    building_id BIGINT UNSIGNED NOT NULL,
    status      ENUM('open','done') NOT NULL DEFAULT 'open',
    started_by  BIGINT UNSIGNED NULL,
    started_at  DATETIME NOT NULL,
    finished_at DATETIME NULL,
    note        VARCHAR(500) NULL,
    UNIQUE KEY uq_bround_tenant_id (tenant_id, id),
    KEY ix_bround_building (tenant_id, building_id, started_at),
    CONSTRAINT fk_bround_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bround_building FOREIGN KEY (tenant_id, building_id) REFERENCES buildings(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_round_stops', (c) => tableExists(c, 'building_round_stops'), `CREATE TABLE building_round_stops (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    round_id      BIGINT UNSIGNED NOT NULL,
    pm_task_id    BIGINT UNSIGNED NOT NULL,
    task_id       BIGINT UNSIGNED NOT NULL,
    asset_id      BIGINT UNSIGNED NOT NULL,
    sort          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    result        ENUM('pass','fail','missing','skipped') NULL,
    note          VARCHAR(500) NULL,
    scanned       TINYINT(1) NOT NULL DEFAULT 0,
    inspection_id BIGINT UNSIGNED NULL,
    work_order_id BIGINT UNSIGNED NULL,
    checked_at    DATETIME NULL,
    checked_by    BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_bstop_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bstop_plan (tenant_id, round_id, pm_task_id),
    CONSTRAINT fk_bstop_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bstop_round FOREIGN KEY (tenant_id, round_id) REFERENCES building_rounds(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_bstop_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_photos', (c) => tableExists(c, 'building_photos'), `CREATE TABLE building_photos (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    building_id   BIGINT UNSIGNED NOT NULL,
    asset_id      BIGINT UNSIGNED NULL,
    stop_id       BIGINT UNSIGNED NULL,
    inspection_id BIGINT UNSIGNED NULL,
    mime          VARCHAR(40) NOT NULL,
    bytes         INT UNSIGNED NOT NULL,
    sha256        CHAR(64) NOT NULL,
    original      MEDIUMBLOB NOT NULL,
    taken_at      DATETIME NULL,
    uploaded_by   BIGINT UNSIGNED NULL,
    uploaded_at   DATETIME NOT NULL,
    UNIQUE KEY uq_bphoto_tenant_id (tenant_id, id),
    KEY ix_bphoto_stop (tenant_id, stop_id),
    CONSTRAINT fk_bphoto_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bphoto_building FOREIGN KEY (tenant_id, building_id) REFERENCES buildings(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_deficiencies', (c) => tableExists(c, 'building_deficiencies'), `CREATE TABLE building_deficiencies (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    building_id   BIGINT UNSIGNED NOT NULL,
    asset_id      BIGINT UNSIGNED NULL,
    description   VARCHAR(500) NOT NULL,
    found_on      DATE NOT NULL,
    source        ENUM('round','visit','manual') NOT NULL DEFAULT 'manual',
    visit_id      BIGINT UNSIGNED NULL,
    round_id      BIGINT UNSIGNED NULL,
    inspection_id BIGINT UNSIGNED NULL,
    work_order_id BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bdef_tenant_id (tenant_id, id),
    KEY ix_bdef_building (tenant_id, building_id, found_on),
    KEY ix_bdef_wo (tenant_id, work_order_id),
    CONSTRAINT fk_bdef_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bdef_building FOREIGN KEY (tenant_id, building_id) REFERENCES buildings(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['building_documents', (c) => tableExists(c, 'building_documents'), `CREATE TABLE building_documents (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    building_id BIGINT UNSIGNED NOT NULL,
    document_id BIGINT UNSIGNED NOT NULL,
    visit_id    BIGINT UNSIGNED NULL,
    asset_id    BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_bdoc_tenant_id (tenant_id, id),
    UNIQUE KEY uq_bdoc_once (tenant_id, building_id, document_id),
    CONSTRAINT fk_bdoc_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_bdoc_building FOREIGN KEY (tenant_id, building_id) REFERENCES buildings(tenant_id, id),
    CONSTRAINT fk_bdoc_document FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  // The foundation seeded the Buildings add-on as "each permit's binder" (code enforcement); release 1's Buildings is the
  // municipality's own properties and their life-safety inspections, so the plan says that.
  ['billing_plans muni-buildings blurb', async (c) => {
    const [r] = await c.query("SELECT blurb FROM billing_plans WHERE code = 'muni-buildings'");
    return !r.length || r[0].blurb === BLURB;
  }, `UPDATE billing_plans SET blurb = ${q(BLURB)} WHERE code = 'muni-buildings'`],
];

module.exports.BLURB = BLURB;
