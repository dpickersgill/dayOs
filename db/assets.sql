-- Assets and fleet (a paid add-on): where things are, their meters and fuel, inspections, parts and stock, vendors and
-- purchase orders, and what each work order cost. Builds on the operations tables (ops_assets, work_orders, pm_tasks);
-- the columns added to those are in db/migrate.js. Everything is CREATE TABLE IF NOT EXISTS, so it is safe to re-run.
-- Money is in cents. User ids are plain numbers (no foreign key), so removing a login never erases the record.

-- Places: a building, a shop, a yard, a lift terminal, a storage room. Can sit inside another place.
CREATE TABLE IF NOT EXISTS asset_locations (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  kind        ENUM('building','shop','yard','lift','storage','area','other') NOT NULL DEFAULT 'area',
  parent_id   BIGINT UNSIGNED NULL,
  notes       VARCHAR(255) NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_aloc_name (tenant_id, name),
  UNIQUE KEY uq_aloc_tenant_id (tenant_id, id),
  CONSTRAINT fk_aloc_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS vendors (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(150) NOT NULL,
  contact     VARCHAR(150) NULL,
  phone       VARCHAR(40) NULL,
  email       VARCHAR(255) NULL,
  account_no  VARCHAR(60) NULL,
  notes       VARCHAR(500) NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_vendor_name (tenant_id, name),
  UNIQUE KEY uq_vendor_tenant_id (tenant_id, id),
  CONSTRAINT fk_vendor_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- Every meter reading, so the history shows how a machine was used. ops_assets keeps the latest hours and miles.
CREATE TABLE IF NOT EXISTS asset_meters (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  asset_id    BIGINT UNSIGNED NOT NULL,
  meter       ENUM('hours','miles') NOT NULL,
  value       DECIMAL(10,1) NOT NULL,
  read_at     DATETIME NOT NULL,
  source      ENUM('manual','fuel','inspection','work_order','grooming') NOT NULL DEFAULT 'manual',
  user_id     BIGINT UNSIGNED NULL,
  KEY ix_ameter (tenant_id, asset_id, meter, read_at),
  CONSTRAINT fk_ameter_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS asset_fuel (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  asset_id    BIGINT UNSIGNED NOT NULL,
  filled_at   DATETIME NOT NULL,
  gallons     DECIMAL(8,2) NOT NULL,
  cost_cents  INT UNSIGNED NULL,
  fuel_type   ENUM('diesel','gasoline','propane','electric','other') NULL,
  hours       DECIMAL(10,1) NULL,
  miles       DECIMAL(10,1) NULL,
  vendor_id   BIGINT UNSIGNED NULL,
  note        VARCHAR(255) NULL,
  user_id     BIGINT UNSIGNED NULL,
  KEY ix_afuel (tenant_id, asset_id, filled_at),
  CONSTRAINT fk_afuel_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
) ENGINE=InnoDB;

-- Checklists: pre-use, pre-trip (DOT style), pre-shift. `items` is JSON: [{ key, label }].
CREATE TABLE IF NOT EXISTS inspection_templates (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(120) NOT NULL,
  kinds       VARCHAR(500) NULL,
  items       TEXT NOT NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_itpl_name (tenant_id, name),
  UNIQUE KEY uq_itpl_tenant_id (tenant_id, id),
  CONSTRAINT fk_itpl_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- A completed checklist. `items` is JSON: [{ key, label, result: pass|fail|na, note }]. A failure opens a work order.
CREATE TABLE IF NOT EXISTS asset_inspections (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  asset_id      BIGINT UNSIGNED NOT NULL,
  template_id   BIGINT UNSIGNED NULL,
  template_name VARCHAR(120) NOT NULL,
  result        ENUM('pass','fail') NOT NULL,
  items         TEXT NOT NULL,
  hours         DECIMAL(10,1) NULL,
  miles         DECIMAL(10,1) NULL,
  inspector     VARCHAR(100) NULL,
  note          VARCHAR(500) NULL,
  work_order_id BIGINT UNSIGNED NULL,
  user_id       BIGINT UNSIGNED NULL,
  done_at       DATETIME NOT NULL,
  KEY ix_ainsp (tenant_id, asset_id, done_at),
  CONSTRAINT fk_ainsp_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
) ENGINE=InnoDB;

-- Parts and supplies. Stock is one count per part, with a bin to find it in.
CREATE TABLE IF NOT EXISTS parts (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  sku            VARCHAR(60) NOT NULL,
  name           VARCHAR(150) NOT NULL,
  unit           VARCHAR(20) NOT NULL DEFAULT 'each',
  unit_cost_cents INT UNSIGNED NOT NULL DEFAULT 0,
  qty_on_hand    DECIMAL(10,2) NOT NULL DEFAULT 0,
  reorder_point  DECIMAL(10,2) NULL,
  reorder_qty    DECIMAL(10,2) NULL,
  vendor_id      BIGINT UNSIGNED NULL,
  vendor_part_no VARCHAR(60) NULL,
  location_id    BIGINT UNSIGNED NULL,
  bin            VARCHAR(40) NULL,
  fits           VARCHAR(255) NULL,
  active         TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_part_sku (tenant_id, sku),
  UNIQUE KEY uq_part_tenant_id (tenant_id, id),
  CONSTRAINT fk_part_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_part_vendor FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors(tenant_id, id)
) ENGINE=InnoDB;

-- Every change to stock, so the count can always be explained. qty is signed: + received or returned, - issued.
CREATE TABLE IF NOT EXISTS part_moves (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  part_id        BIGINT UNSIGNED NOT NULL,
  kind           ENUM('receive','issue','return','adjust','count') NOT NULL,
  qty            DECIMAL(10,2) NOT NULL,
  unit_cost_cents INT UNSIGNED NOT NULL DEFAULT 0,
  work_order_id  BIGINT UNSIGNED NULL,
  asset_id       BIGINT UNSIGNED NULL,
  po_id          BIGINT UNSIGNED NULL,
  note           VARCHAR(255) NULL,
  user_id        BIGINT UNSIGNED NULL,
  at             DATETIME NOT NULL,
  KEY ix_pmove_part (tenant_id, part_id, at),
  KEY ix_pmove_wo (tenant_id, work_order_id),
  KEY ix_pmove_asset (tenant_id, asset_id),
  CONSTRAINT fk_pmove_part FOREIGN KEY (tenant_id, part_id) REFERENCES parts(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  po_number    INT UNSIGNED NOT NULL,
  vendor_id    BIGINT UNSIGNED NOT NULL,
  status       ENUM('draft','ordered','partial','received','cancelled') NOT NULL DEFAULT 'draft',
  ordered_at   DATETIME NULL,
  expected_on  DATE NULL,
  received_at  DATETIME NULL,
  notes        VARCHAR(500) NULL,
  created_by   BIGINT UNSIGNED NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_po_number (tenant_id, po_number),
  UNIQUE KEY uq_po_tenant_id (tenant_id, id),
  CONSTRAINT fk_po_vendor FOREIGN KEY (tenant_id, vendor_id) REFERENCES vendors(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS po_lines (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  po_id          BIGINT UNSIGNED NOT NULL,
  part_id        BIGINT UNSIGNED NULL,
  description    VARCHAR(200) NOT NULL,
  qty            DECIMAL(10,2) NOT NULL,
  unit_cost_cents INT UNSIGNED NOT NULL DEFAULT 0,
  received_qty   DECIMAL(10,2) NOT NULL DEFAULT 0,
  work_order_id  BIGINT UNSIGNED NULL,
  KEY ix_poline (tenant_id, po_id),
  CONSTRAINT fk_poline_po FOREIGN KEY (tenant_id, po_id) REFERENCES purchase_orders(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_poline_part FOREIGN KEY (tenant_id, part_id) REFERENCES parts(tenant_id, id)
) ENGINE=InnoDB;

-- Who worked on a work order and for how long. The rate is copied at the time, so a later rate change keeps old costs.
CREATE TABLE IF NOT EXISTS work_order_labor (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  work_order_id BIGINT UNSIGNED NOT NULL,
  staff_id     BIGINT UNSIGNED NULL,
  worker       VARCHAR(100) NULL,
  hours        DECIMAL(6,2) NOT NULL,
  rate_cents   INT UNSIGNED NOT NULL DEFAULT 0,
  worked_on    DATE NOT NULL,
  note         VARCHAR(255) NULL,
  user_id      BIGINT UNSIGNED NULL,
  KEY ix_wol (tenant_id, work_order_id),
  CONSTRAINT fk_wol_wo FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One row per mountain: the shop labor rate and the rules for the repair-or-replace flag.
CREATE TABLE IF NOT EXISTS asset_settings (
  tenant_id          BIGINT UNSIGNED PRIMARY KEY,
  labor_rate_cents   INT UNSIGNED NOT NULL DEFAULT 4500,
  next_tag           INT UNSIGNED NOT NULL DEFAULT 1,
  next_po            INT UNSIGNED NOT NULL DEFAULT 1001,
  replace_pct        TINYINT UNSIGNED NOT NULL DEFAULT 50,
  expiry_warn_days   SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  CONSTRAINT fk_aset_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;
