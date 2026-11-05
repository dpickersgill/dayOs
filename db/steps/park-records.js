'use strict';
// 2026.11.12 terrain park records. Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   park_inspections   the inspection type, the checklist answers, what was fixed, the phone's id and when it arrived,
//                      and corrections (a manager marks one entered in error; a corrected row points at the original)
//   park_feature_changes  before and after values of every change to a feature or an area's rating, with who, when, why
//   park_photos        photos of a feature, kept as uploaded with their SHA-256 (the patrol photo pattern)
//   park_area_days     an area's opening sign-off and its closures (weather, visibility), per day
//   park_placement_corrections  a past day's placement changed by a manager: the values before and after, and why
//   incident_park_links  a patrol case linked to a placed feature, with a snapshot of the feature as it was
//   park_features.status 'new'  a feature not inspected yet (a new one no longer starts as Ready)
//   park_areas.level   S, M, L, XL and a beginner or progression zone (Learning, Small, Medium, Large, Pro move across)
const enumHas = async (c, table, column, value) => {
  const [[r]] = await c.query('SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r && String(r.t || r.COLUMN_TYPE).includes(`'${value}'`));
};

module.exports = ({ tableExists, columnExists }) => [
  // ---- area levels: widen, move the old values across, then narrow
  ['park_areas.level S M L XL (widen)', (c) => enumHas(c, 'park_areas', 'level', 'xl'),
    "ALTER TABLE park_areas MODIFY level ENUM('learn','small','medium','large','pro','beginner','s','m','l','xl') NOT NULL DEFAULT 's'"],
  ['park_areas.level S M L XL (move)', async (c) => {
    const [[r]] = await c.query("SELECT COUNT(*) AS n FROM park_areas WHERE level IN ('learn','small','medium','large','pro')");
    return Number(r.n) === 0;
  }, "UPDATE park_areas SET level = CASE level WHEN 'learn' THEN 'beginner' WHEN 'small' THEN 's' WHEN 'medium' THEN 'm' WHEN 'large' THEN 'l' WHEN 'pro' THEN 'xl' ELSE level END WHERE level IN ('learn','small','medium','large','pro')"],
  ['park_areas.level S M L XL (narrow)', async (c) => !(await enumHas(c, 'park_areas', 'level', 'pro')),
    "ALTER TABLE park_areas MODIFY level ENUM('beginner','s','m','l','xl') NOT NULL DEFAULT 's'"],

  // ---- features
  ['park_features.needs_post_incident', (c) => columnExists(c, 'park_features', 'needs_post_incident'),
    'ALTER TABLE park_features ADD COLUMN needs_post_incident TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN closed_for_incident_id BIGINT UNSIGNED NULL'],

  // A feature added to the catalog is "not inspected yet" until its first inspection passes (it used to start as Ready).
  ["park_features.status 'new'", (c) => enumHas(c, 'park_features', 'status', 'new'),
    "ALTER TABLE park_features MODIFY status ENUM('new','ready','needs_attention','closed','retired') NOT NULL DEFAULT 'new'"],

  // ---- inspections
  ['park_inspections.kind', (c) => columnExists(c, 'park_inspections', 'kind'),
    `ALTER TABLE park_inspections ADD COLUMN kind ENUM('morning','midday','after_grooming','after_snow','after_change','post_incident') NULL,
      ADD COLUMN checklist JSON NULL, ADD COLUMN fixed VARCHAR(255) NULL, ADD COLUMN no_photo_reason VARCHAR(255) NULL,
      ADD COLUMN client_ref VARCHAR(40) NULL, ADD COLUMN received_at TIMESTAMP NULL,
      ADD COLUMN reopened TINYINT(1) NOT NULL DEFAULT 0,
      ADD COLUMN voided_at DATETIME NULL, ADD COLUMN voided_by BIGINT UNSIGNED NULL, ADD COLUMN void_reason VARCHAR(255) NULL,
      ADD COLUMN corrects_id BIGINT UNSIGNED NULL`],
  ['park_inspections one per phone id', async (c) => {
    const [r] = await c.query("SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'park_inspections' AND index_name = 'uq_park_inspection_ref'");
    return r.length > 0;
  }, 'ALTER TABLE park_inspections ADD UNIQUE KEY uq_park_inspection_ref (tenant_id, client_ref)'],

  // ---- placements: roped off, late entries, entered in error
  ['park_placements.roped_off', (c) => columnExists(c, 'park_placements', 'roped_off'),
    `ALTER TABLE park_placements ADD COLUMN roped_off TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN roped_note VARCHAR(255) NULL,
      ADD COLUMN roped_by BIGINT UNSIGNED NULL, ADD COLUMN roped_at TIMESTAMP NULL,
      ADD COLUMN late TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN late_reason VARCHAR(255) NULL,
      ADD COLUMN size_override VARCHAR(255) NULL,
      ADD COLUMN voided_at DATETIME NULL, ADD COLUMN voided_by BIGINT UNSIGNED NULL, ADD COLUMN void_reason VARCHAR(255) NULL,
      ADD COLUMN created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP`],

  ['park_feature_changes', (c) => tableExists(c, 'park_feature_changes'), `CREATE TABLE park_feature_changes (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    feature_id  BIGINT UNSIGNED NULL,
    area_id     BIGINT UNSIGNED NULL,
    on_date     DATE NULL,
    field       VARCHAR(20) NOT NULL,
    before_value VARCHAR(255) NULL,
    after_value  VARCHAR(255) NULL,
    reason      VARCHAR(255) NULL,
    source      VARCHAR(20) NOT NULL DEFAULT 'edit',
    ref_id      BIGINT UNSIGNED NULL,
    changed_by  BIGINT UNSIGNED NULL,
    changed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_park_change_feature (tenant_id, feature_id, changed_at),
    KEY ix_park_change_area (tenant_id, area_id, changed_at),
    CONSTRAINT fk_park_change_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['park_photos', (c) => tableExists(c, 'park_photos'), `CREATE TABLE park_photos (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    feature_id    BIGINT UNSIGNED NOT NULL,
    inspection_id BIGINT UNSIGNED NULL,
    mime          VARCHAR(40) NOT NULL,
    file_name     VARCHAR(200) NULL,
    bytes         INT UNSIGNED NOT NULL,
    sha256        CHAR(64) NOT NULL,
    original      LONGBLOB NOT NULL,
    caption       VARCHAR(255) NULL,
    taken_at      DATETIME NULL,
    taken_lat     DECIMAL(9,6) NULL,
    taken_lng     DECIMAL(9,6) NULL,
    client_ref    VARCHAR(40) NULL,
    uploaded_by   BIGINT UNSIGNED NULL,
    uploaded_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_park_photo_ref (tenant_id, client_ref),
    KEY ix_park_photo_feature (tenant_id, feature_id, id),
    KEY ix_park_photo_inspection (tenant_id, inspection_id),
    CONSTRAINT fk_park_photo_feature FOREIGN KEY (tenant_id, feature_id) REFERENCES park_features(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['park_area_days', (c) => tableExists(c, 'park_area_days'), `CREATE TABLE park_area_days (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    area_id         BIGINT UNSIGNED NOT NULL,
    on_date         DATE NOT NULL,
    action          ENUM('open','close') NOT NULL,
    checklist       JSON NULL,
    supervisor_name VARCHAR(100) NULL,
    reason_kind     VARCHAR(20) NULL,
    reason          VARCHAR(255) NULL,
    at              TIMESTAMP NULL,
    features_closed SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    client_ref      VARCHAR(40) NULL,
    signed_by       BIGINT UNSIGNED NULL,
    received_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_park_area_day_ref (tenant_id, client_ref),
    KEY ix_park_area_day (tenant_id, area_id, on_date),
    CONSTRAINT fk_park_area_day_area FOREIGN KEY (tenant_id, area_id) REFERENCES park_areas(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['park_placement_corrections', (c) => tableExists(c, 'park_placement_corrections'), `CREATE TABLE park_placement_corrections (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    placement_id BIGINT UNSIGNED NOT NULL,
    feature_id   BIGINT UNSIGNED NOT NULL,
    on_date      DATE NOT NULL,
    action       ENUM('change','remove','restore') NOT NULL,
    before_json  JSON NULL,
    after_json   JSON NULL,
    reason       VARCHAR(255) NOT NULL,
    corrected_by BIGINT UNSIGNED NULL,
    corrected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_park_place_corr (tenant_id, on_date, feature_id),
    CONSTRAINT fk_park_place_corr_feature FOREIGN KEY (tenant_id, feature_id) REFERENCES park_features(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],

  ['incident_park_links', (c) => tableExists(c, 'incident_park_links'), `CREATE TABLE incident_park_links (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    incident_id BIGINT UNSIGNED NOT NULL,
    feature_id  BIGINT UNSIGNED NOT NULL,
    on_date     DATE NOT NULL,
    snapshot    JSON NOT NULL,
    linked_by   BIGINT UNSIGNED NULL,
    linked_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at   TIMESTAMP NULL,
    voided_at   DATETIME NULL,
    voided_by   BIGINT UNSIGNED NULL,
    void_reason VARCHAR(255) NULL,
    KEY ix_incident_park_case (tenant_id, incident_id),
    KEY ix_incident_park_feature (tenant_id, feature_id),
    CONSTRAINT fk_incident_park_feature FOREIGN KEY (tenant_id, feature_id) REFERENCES park_features(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];
