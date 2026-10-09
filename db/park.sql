-- Terrain park: areas, the features crew build with, where each one is placed each day, and inspections.
-- Applied by db/migrate.js. Everything is CREATE TABLE IF NOT EXISTS, so it is safe to re-run.

CREATE TABLE IF NOT EXISTS park_areas (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(100) NOT NULL,
  level      ENUM('learn','small','medium','large','pro') NOT NULL DEFAULT 'small',
  status     ENUM('open','closed') NOT NULL DEFAULT 'open',
  notes      VARCHAR(255) NULL,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_park_area_name (tenant_id, name),
  UNIQUE KEY uq_park_area_tenant_id (tenant_id, id),
  CONSTRAINT fk_park_area_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS park_features (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  kind        VARCHAR(30) NOT NULL,
  size        ENUM('xs','s','m','l','xl') NOT NULL DEFAULT 'm',
  dimensions  VARCHAR(60) NULL,
  portable    TINYINT(1) NOT NULL DEFAULT 1,
  status      ENUM('ready','needs_attention','closed','retired') NOT NULL DEFAULT 'ready',
  notes       VARCHAR(500) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_park_feature_name (tenant_id, name),
  UNIQUE KEY uq_park_feature_tenant_id (tenant_id, id),
  CONSTRAINT fk_park_feature_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS park_placements (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  on_date     DATE NOT NULL,
  feature_id  BIGINT UNSIGNED NOT NULL,
  area_id     BIGINT UNSIGNED NULL,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  note        VARCHAR(255) NULL,
  placed_by   BIGINT UNSIGNED NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_park_placement (tenant_id, on_date, feature_id),
  KEY ix_park_placement_feature (tenant_id, feature_id, on_date),
  CONSTRAINT fk_park_place_feature FOREIGN KEY (tenant_id, feature_id) REFERENCES park_features(tenant_id, id),
  CONSTRAINT fk_park_place_area FOREIGN KEY (tenant_id, area_id) REFERENCES park_areas(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS park_inspections (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  feature_id    BIGINT UNSIGNED NOT NULL,
  inspected_on  DATE NOT NULL,
  inspected_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  inspected_by  BIGINT UNSIGNED NULL,
  result        ENUM('ok','needs_attention','closed') NOT NULL,
  notes         VARCHAR(255) NULL,
  KEY ix_park_inspection (tenant_id, feature_id, inspected_at),
  KEY ix_park_inspection_day (tenant_id, inspected_on),
  CONSTRAINT fk_park_inspect_feature FOREIGN KEY (tenant_id, feature_id) REFERENCES park_features(tenant_id, id)
) ENGINE=InnoDB;
