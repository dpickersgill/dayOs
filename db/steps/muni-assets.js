'use strict';
// Municipal edition, release 1: asset management for water, sewer and stormwater (the "assets" workstream). Loaded by
// db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB. Most of it helps a ski area too.
//   condition_score, criticality,       on the asset register (ops_assets) and the map (map_features); risk is worked out
//   ownership                           (condition is a reserved word in MySQL, so the column is condition_score)
//   map_features.tag                    a valve or hydrant's own ID ("V-114"), one per tenant
//   work_orders                         map_feature_id, request_id, program_id, and source 'request','program','notice'
//   asset_inspections                   on a map feature as well as an asset (asset_id NULL-able), the condition score set
//   inspection_templates                map kinds it is for, "sets condition", and the built-in pack it came from
//   asset_template_packs                which built-in template packs a tenant has been given (never given twice)
//   asset_photos                        photos on an asset or map feature, kept as taken with their SHA-256
//   station_run_hours                   pump hour-meter readings taken on an inspection (run hours by month)
//   asset_programs, _targets            one job over many assets or map features (valve exercising, hydrant flushing)

const typeHas = async (conn, table, column, needle) => {
  const [r] = await conn.query('SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r.length && String(r[0].t).includes(needle));
};
const nullable = async (conn, table, column) => {
  const [r] = await conn.query('SELECT IS_NULLABLE AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r.length && r[0].n === 'YES');
};
const indexExists = async (conn, table, name) => {
  const [r] = await conn.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return r.length > 0;
};

// The work order source ENUM, as the shared spec lists it (the union every workstream uses).
const SOURCES = "'manual','inspection','preventive','request','program','notice'";

module.exports = ({ tableExists, columnExists }) => {
  const col = (table, name, ddl) => [`${table}.${name}`, (c) => columnExists(c, table, name), `ALTER TABLE ${table} ADD COLUMN ${ddl}`];
  return [
    // ---- condition, criticality and ownership (all tenants); risk = condition x criticality, never stored
    col('ops_assets', 'condition_score', 'condition_score TINYINT UNSIGNED NULL'),
    col('ops_assets', 'criticality', 'criticality TINYINT UNSIGNED NULL'),
    col('ops_assets', 'ownership', "ownership ENUM('own','authority','private','state','other') NULL"),
    col('ops_assets', 'material', 'material VARCHAR(40) NULL'),
    col('ops_assets', 'size', 'size VARCHAR(40) NULL'),
    col('ops_assets', 'installed_year', 'installed_year SMALLINT UNSIGNED NULL'),
    col('map_features', 'condition_score', 'condition_score TINYINT UNSIGNED NULL'),
    col('map_features', 'criticality', 'criticality TINYINT UNSIGNED NULL'),
    col('map_features', 'ownership', "ownership ENUM('own','authority','private','state','other') NULL"),
    col('map_features', 'tag', 'tag VARCHAR(30) NULL'),
    ['map_features unique tag', (c) => indexExists(c, 'map_features', 'uq_map_features_tag'), 'ALTER TABLE map_features ADD UNIQUE KEY uq_map_features_tag (tenant_id, tag)'],
    ['map_features unique tenant id', (c) => indexExists(c, 'map_features', 'uq_map_features_tenant_id'), 'ALTER TABLE map_features ADD UNIQUE KEY uq_map_features_tenant_id (tenant_id, id)'],

    // ---- work orders on map features, from requests, programs and notices (columns exactly as the shared spec gives them)
    col('work_orders', 'map_feature_id', 'map_feature_id BIGINT UNSIGNED NULL'),
    col('work_orders', 'request_id', 'request_id BIGINT UNSIGNED NULL'),
    col('work_orders', 'program_id', 'program_id BIGINT UNSIGNED NULL'),
    ['work_orders.source request, program and notice', (c) => typeHas(c, 'work_orders', 'source', "'notice'"),
      `ALTER TABLE work_orders MODIFY source ENUM(${SOURCES}) NOT NULL DEFAULT 'manual'`],
    ['work_orders by map feature', (c) => indexExists(c, 'work_orders', 'ix_wo_feature'), 'ALTER TABLE work_orders ADD INDEX ix_wo_feature (tenant_id, map_feature_id, status)'],
    ['work_orders by program', (c) => indexExists(c, 'work_orders', 'ix_wo_program'), 'ALTER TABLE work_orders ADD INDEX ix_wo_program (tenant_id, program_id)'],

    // ---- inspections on a map feature as well as an asset (one of the two, checked by the app as map_features.asset_id is)
    col('asset_inspections', 'map_feature_id', 'map_feature_id BIGINT UNSIGNED NULL'),
    col('asset_inspections', 'program_id', 'program_id BIGINT UNSIGNED NULL'),
    col('asset_inspections', 'condition_score', 'condition_score TINYINT UNSIGNED NULL'),
    ['asset_inspections.asset_id optional', (c) => nullable(c, 'asset_inspections', 'asset_id'), 'ALTER TABLE asset_inspections MODIFY asset_id BIGINT UNSIGNED NULL'],
    ['asset_inspections by map feature', (c) => indexExists(c, 'asset_inspections', 'ix_ainsp_feature'), 'ALTER TABLE asset_inspections ADD INDEX ix_ainsp_feature (tenant_id, map_feature_id, done_at)'],
    ['asset_inspections unique tenant id', (c) => indexExists(c, 'asset_inspections', 'uq_ainsp_tenant_id'), 'ALTER TABLE asset_inspections ADD UNIQUE KEY uq_ainsp_tenant_id (tenant_id, id)'],
    col('inspection_templates', 'map_kinds', 'map_kinds VARCHAR(500) NULL'),
    col('inspection_templates', 'sets_condition', 'sets_condition TINYINT(1) NOT NULL DEFAULT 0'),
    col('inspection_templates', 'pack', 'pack VARCHAR(20) NULL'),

    ['asset_template_packs', (c) => tableExists(c, 'asset_template_packs'), `CREATE TABLE asset_template_packs (
      id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id   BIGINT UNSIGNED NOT NULL,
      pack        VARCHAR(20) NOT NULL,
      templates   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
      seeded_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_atpacks_tenant_id (tenant_id, id),
      UNIQUE KEY uq_atpacks_pack (tenant_id, pack),
      CONSTRAINT fk_atpacks_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

    ['asset_photos', (c) => tableExists(c, 'asset_photos'), `CREATE TABLE asset_photos (
      id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id      BIGINT UNSIGNED NOT NULL,
      asset_id       BIGINT UNSIGNED NULL,
      map_feature_id BIGINT UNSIGNED NULL,
      inspection_id  BIGINT UNSIGNED NULL,
      mime           VARCHAR(60) NOT NULL,
      file_name      VARCHAR(200) NULL,
      bytes          INT UNSIGNED NOT NULL,
      sha256         CHAR(64) NOT NULL,
      original       MEDIUMBLOB NOT NULL,
      caption        VARCHAR(255) NULL,
      taken_at       DATETIME NULL,
      taken_lat      DECIMAL(9,6) NULL,
      taken_lng      DECIMAL(9,6) NULL,
      client_ref     VARCHAR(40) NULL,
      uploaded_by    BIGINT UNSIGNED NULL,
      uploaded_at    DATETIME NOT NULL,
      UNIQUE KEY uq_aphotos_tenant_id (tenant_id, id),
      UNIQUE KEY uq_aphotos_ref (tenant_id, client_ref),
      KEY ix_aphotos_asset (tenant_id, asset_id, id),
      KEY ix_aphotos_feature (tenant_id, map_feature_id, id),
      KEY ix_aphotos_inspection (tenant_id, inspection_id),
      CONSTRAINT fk_aphotos_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      CONSTRAINT fk_aphotos_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

    ['station_run_hours', (c) => tableExists(c, 'station_run_hours'), `CREATE TABLE station_run_hours (
      id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id      BIGINT UNSIGNED NOT NULL,
      asset_id       BIGINT UNSIGNED NULL,
      map_feature_id BIGINT UNSIGNED NULL,
      inspection_id  BIGINT UNSIGNED NOT NULL,
      item_key       VARCHAR(30) NOT NULL,
      label          VARCHAR(150) NOT NULL,
      hours          DECIMAL(10,1) NOT NULL,
      read_at        DATETIME NOT NULL,
      UNIQUE KEY uq_srh_tenant_id (tenant_id, id),
      UNIQUE KEY uq_srh_reading (tenant_id, inspection_id, item_key),
      KEY ix_srh_feature (tenant_id, map_feature_id, item_key, read_at),
      KEY ix_srh_asset (tenant_id, asset_id, item_key, read_at),
      CONSTRAINT fk_srh_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      CONSTRAINT fk_srh_inspection FOREIGN KEY (tenant_id, inspection_id) REFERENCES asset_inspections(tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

    ['asset_programs', (c) => tableExists(c, 'asset_programs'), `CREATE TABLE asset_programs (
      id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id         BIGINT UNSIGNED NOT NULL,
      name              VARCHAR(120) NOT NULL,
      template_id       BIGINT UNSIGNED NOT NULL,
      due_on            DATE NULL,
      assigned_staff_id BIGINT UNSIGNED NULL,
      crew              VARCHAR(120) NULL,
      notes             VARCHAR(1000) NULL,
      status            ENUM('open','closed') NOT NULL DEFAULT 'open',
      copied_from       BIGINT UNSIGNED NULL,
      created_by        BIGINT UNSIGNED NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at         DATETIME NULL,
      closed_by         BIGINT UNSIGNED NULL,
      UNIQUE KEY uq_aprog_tenant_id (tenant_id, id),
      KEY ix_aprog_status (tenant_id, status, due_on),
      CONSTRAINT fk_aprog_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      CONSTRAINT fk_aprog_template FOREIGN KEY (tenant_id, template_id) REFERENCES inspection_templates(tenant_id, id),
      CONSTRAINT fk_aprog_staff FOREIGN KEY (tenant_id, assigned_staff_id) REFERENCES staff(tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

    ['asset_program_targets', (c) => tableExists(c, 'asset_program_targets'), `CREATE TABLE asset_program_targets (
      id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id      BIGINT UNSIGNED NOT NULL,
      program_id     BIGINT UNSIGNED NOT NULL,
      asset_id       BIGINT UNSIGNED NULL,
      map_feature_id BIGINT UNSIGNED NULL,
      status         ENUM('todo','done','skipped') NOT NULL DEFAULT 'todo',
      result         ENUM('pass','fail') NULL,
      skip_reason    VARCHAR(255) NULL,
      inspection_id  BIGINT UNSIGNED NULL,
      work_order_id  BIGINT UNSIGNED NULL,
      done_at        DATETIME NULL,
      done_by        BIGINT UNSIGNED NULL,
      UNIQUE KEY uq_aptgt_tenant_id (tenant_id, id),
      UNIQUE KEY uq_aptgt_asset (tenant_id, program_id, asset_id),
      UNIQUE KEY uq_aptgt_feature (tenant_id, program_id, map_feature_id),
      KEY ix_aptgt_program (tenant_id, program_id, status),
      CONSTRAINT fk_aptgt_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      CONSTRAINT fk_aptgt_program FOREIGN KEY (tenant_id, program_id) REFERENCES asset_programs(tenant_id, id),
      CONSTRAINT fk_aptgt_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ];
};
