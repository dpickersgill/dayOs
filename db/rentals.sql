-- The rental shop: settings, sizing profiles, fees, reservations, service history and the binding chart.
-- Gear and contract columns are added by db/migrate.js, because those tables already exist.
CREATE TABLE IF NOT EXISTS rental_settings (
  tenant_id              BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  late_fee_cents_per_day INT UNSIGNED NOT NULL DEFAULT 0,
  late_grace_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 60,
  require_binding_record TINYINT(1) NOT NULL DEFAULT 0,
  service_every_uses     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  default_deposit_cents  INT UNSIGNED NOT NULL DEFAULT 0,
  hold_until_hour        TINYINT UNSIGNED NOT NULL DEFAULT 12,
  CONSTRAINT fk_rsettings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rental_profiles (
  tenant_id    BIGINT UNSIGNED NOT NULL,
  person_id    BIGINT UNSIGNED NOT NULL,
  skier_type   VARCHAR(4) NULL,
  boot_sole_mm SMALLINT UNSIGNED NULL,
  shoe_size    VARCHAR(10) NULL,
  stance       ENUM('regular','goofy') NULL,
  helmet_size  VARCHAR(10) NULL,
  notes        VARCHAR(300) NULL,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, person_id),
  CONSTRAINT fk_rprofiles_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS binding_chart (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  skier_type  VARCHAR(4) NOT NULL,
  weight_lb_min SMALLINT UNSIGNED NOT NULL,
  weight_lb_max SMALLINT UNSIGNED NOT NULL,
  height_in_min SMALLINT UNSIGNED NULL,
  height_in_max SMALLINT UNSIGNED NULL,
  sole_mm_min SMALLINT UNSIGNED NULL,
  sole_mm_max SMALLINT UNSIGNED NULL,
  din         DECIMAL(3,1) NOT NULL,
  KEY ix_chart (tenant_id, skier_type, weight_lb_min),
  CONSTRAINT fk_chart_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rental_charges (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  contract_id BIGINT UNSIGNED NOT NULL,
  kind        ENUM('late','damage','loss','deposit','other') NOT NULL,
  cents       INT UNSIGNED NOT NULL,
  note        VARCHAR(200) NULL,
  status      ENUM('due','paid','waived') NOT NULL DEFAULT 'due',
  order_id    BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at DATETIME NULL,
  KEY ix_rcharges (tenant_id, status, created_at),
  KEY ix_rcharges_contract (tenant_id, contract_id),
  CONSTRAINT fk_rcharges_contract FOREIGN KEY (tenant_id, contract_id) REFERENCES rental_contracts(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rental_service_log (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  rental_item_id BIGINT UNSIGNED NOT NULL,
  kind           ENUM('tune','wax','repair','binding_test','inspection','other') NOT NULL,
  notes          VARCHAR(500) NULL,
  cost_cents     INT UNSIGNED NOT NULL DEFAULT 0,
  done_by        VARCHAR(100) NULL,
  done_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_rservice_item (tenant_id, rental_item_id, done_at),
  CONSTRAINT fk_rservice_item FOREIGN KEY (tenant_id, rental_item_id) REFERENCES rental_items(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rental_reservations (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  person_id   BIGINT UNSIGNED NOT NULL,
  pickup_on   DATE NOT NULL,
  days        SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  status      ENUM('held','picked_up','no_show','cancelled') NOT NULL DEFAULT 'held',
  notes       VARCHAR(500) NULL,
  contract_id BIGINT UNSIGNED NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rres_tenant_id (tenant_id, id),
  KEY ix_rres_pickup (tenant_id, status, pickup_on),
  CONSTRAINT fk_rres_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rental_reservation_lines (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  reservation_id BIGINT UNSIGNED NOT NULL,
  category       ENUM('ski','snowboard','boot','helmet','pole','other') NOT NULL,
  tier           ENUM('standard','performance') NOT NULL DEFAULT 'standard',
  quantity       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  for_person_id  BIGINT UNSIGNED NULL,
  size_note      VARCHAR(60) NULL,
  KEY ix_rresl (tenant_id, reservation_id),
  CONSTRAINT fk_rresl_res FOREIGN KEY (tenant_id, reservation_id) REFERENCES rental_reservations(tenant_id, id)
) ENGINE=InnoDB;
