-- Mountain operations: grooming, snow and weather, snowmaking, the fleet, work orders, preventive maintenance,
-- lift inspections, lift downtime and shift handoffs. Applied by db/migrate.js. Everything is
-- CREATE TABLE IF NOT EXISTS, so it is safe to re-run. User ids are plain numbers (no foreign key) so removing a login
-- never erases the operating record.

-- Machines and equipment: groomers, snowmobiles, vehicles, snow guns, tools, buildings.
CREATE TABLE IF NOT EXISTS ops_assets (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  kind        VARCHAR(30)  NOT NULL,
  make_model  VARCHAR(100) NULL,
  serial      VARCHAR(80)  NULL,
  hours       DECIMAL(9,1) NOT NULL DEFAULT 0,
  status      ENUM('in_service','needs_service','out_of_service','retired') NOT NULL DEFAULT 'in_service',
  notes       VARCHAR(500) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ops_asset_name (tenant_id, name),
  UNIQUE KEY uq_ops_asset_tenant_id (tenant_id, id),
  CONSTRAINT fk_ops_asset_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- The nightly (or daytime) grooming plan: which trail, which machine, who drives, in what order.
CREATE TABLE IF NOT EXISTS groom_plans (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  plan_date     DATE NOT NULL,
  shift         ENUM('night','day') NOT NULL DEFAULT 'night',
  trail_id      BIGINT UNSIGNED NOT NULL,
  asset_id      BIGINT UNSIGNED NULL,
  operator_staff_id BIGINT UNSIGNED NULL,
  priority      SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  status        ENUM('planned','in_progress','done','skipped') NOT NULL DEFAULT 'planned',
  started_at    DATETIME NULL,
  finished_at   DATETIME NULL,
  machine_hours DECIMAL(5,1) NULL,
  fuel_gal      DECIMAL(5,1) NULL,
  note          VARCHAR(255) NULL,
  UNIQUE KEY uq_groom_plan (tenant_id, plan_date, shift, trail_id),
  KEY ix_groom_plan_day (tenant_id, plan_date, shift, priority),
  CONSTRAINT fk_groom_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id),
  CONSTRAINT fk_groom_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id),
  CONSTRAINT fk_groom_operator FOREIGN KEY (tenant_id, operator_staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- Snow depth and surface, per trail or for the mountain as a whole (trail_id empty).
CREATE TABLE IF NOT EXISTS snow_readings (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  trail_id     BIGINT UNSIGNED NULL,
  read_at      DATETIME NOT NULL,
  base_in      DECIMAL(5,1) NULL,
  new_snow_in  DECIMAL(4,1) NULL,
  surface      VARCHAR(30) NULL,
  quality      ENUM('poor','fair','good','excellent') NULL,
  note         VARCHAR(255) NULL,
  user_id      BIGINT UNSIGNED NULL,
  KEY ix_snow_when (tenant_id, read_at),
  CONSTRAINT fk_snow_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id)
) ENGINE=InnoDB;

-- Snowmaking: when the guns ran on a trail.
CREATE TABLE IF NOT EXISTS snowmaking_runs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  trail_id    BIGINT UNSIGNED NOT NULL,
  started_at  DATETIME NOT NULL,
  ended_at    DATETIME NULL,
  guns        SMALLINT UNSIGNED NULL,
  temp_f      DECIMAL(4,1) NULL,
  water_gal   INT UNSIGNED NULL,
  note        VARCHAR(255) NULL,
  user_id     BIGINT UNSIGNED NULL,
  KEY ix_snowmaking_when (tenant_id, started_at),
  CONSTRAINT fk_snowmaking_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS weather_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  logged_at   DATETIME NOT NULL,
  place       VARCHAR(40) NOT NULL DEFAULT 'Base',
  temp_f      DECIMAL(4,1) NULL,
  wind_mph    SMALLINT UNSIGNED NULL,
  gust_mph    SMALLINT UNSIGNED NULL,
  wind_dir    VARCHAR(3) NULL,
  sky         ENUM('clear','partly','overcast','snow','rain','mixed','fog') NULL,
  precip_in   DECIMAL(4,2) NULL,
  note        VARCHAR(255) NULL,
  user_id     BIGINT UNSIGNED NULL,
  KEY ix_weather_when (tenant_id, logged_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS work_orders (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  title         VARCHAR(150) NOT NULL,
  description   TEXT NULL,
  priority      ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status        ENUM('open','in_progress','waiting_parts','done','cancelled') NOT NULL DEFAULT 'open',
  asset_id      BIGINT UNSIGNED NULL,
  lift_id       BIGINT UNSIGNED NULL,
  location      VARCHAR(120) NULL,
  source        ENUM('manual','inspection','preventive') NOT NULL DEFAULT 'manual',
  assigned_staff_id BIGINT UNSIGNED NULL,
  due_date      DATE NULL,
  opened_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opened_by     BIGINT UNSIGNED NULL,
  completed_at  DATETIME NULL,
  labor_hours   DECIMAL(5,1) NULL,
  parts_note    VARCHAR(255) NULL,
  resolution    VARCHAR(500) NULL,
  KEY ix_wo_status (tenant_id, status, priority),
  UNIQUE KEY uq_wo_tenant_id (tenant_id, id),
  CONSTRAINT fk_wo_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id),
  CONSTRAINT fk_wo_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id),
  CONSTRAINT fk_wo_staff FOREIGN KEY (tenant_id, assigned_staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS work_order_notes (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  work_order_id BIGINT UNSIGNED NOT NULL,
  at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id     BIGINT UNSIGNED NULL,
  body        VARCHAR(1000) NOT NULL,
  KEY ix_won (tenant_id, work_order_id),
  CONSTRAINT fk_won_wo FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Recurring jobs that come due by date, by machine hours, or both.
CREATE TABLE IF NOT EXISTS pm_tasks (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  name           VARCHAR(150) NOT NULL,
  asset_id       BIGINT UNSIGNED NULL,
  lift_id        BIGINT UNSIGNED NULL,
  interval_days  SMALLINT UNSIGNED NULL,
  interval_hours DECIMAL(7,1) NULL,
  last_done_on   DATE NULL,
  last_done_hours DECIMAL(9,1) NULL,
  notes          VARCHAR(500) NULL,
  active         TINYINT(1) NOT NULL DEFAULT 1,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pm_tenant_id (tenant_id, id),
  CONSTRAINT fk_pm_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id),
  CONSTRAINT fk_pm_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS pm_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  pm_task_id  BIGINT UNSIGNED NOT NULL,
  done_on     DATE NOT NULL,
  hours       DECIMAL(9,1) NULL,
  user_id     BIGINT UNSIGNED NULL,
  note        VARCHAR(255) NULL,
  KEY ix_pm_log (tenant_id, pm_task_id, done_on),
  CONSTRAINT fk_pm_log_task FOREIGN KEY (tenant_id, pm_task_id) REFERENCES pm_tasks(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A lift's daily inspection. `items` is JSON: [{ key, label, result: pass|fail|na, note }]. A failed item blocks opening that day.
CREATE TABLE IF NOT EXISTS lift_checks (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  lift_id     BIGINT UNSIGNED NOT NULL,
  check_date  DATE NOT NULL,
  kind        ENUM('pre_open','post_close') NOT NULL DEFAULT 'pre_open',
  result      ENUM('pass','fail') NOT NULL,
  items       MEDIUMTEXT NOT NULL,
  inspector   VARCHAR(100) NULL,
  user_id     BIGINT UNSIGNED NULL,
  checked_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note        VARCHAR(500) NULL,
  work_order_id BIGINT UNSIGNED NULL,
  KEY ix_lift_checks (tenant_id, lift_id, check_date),
  CONSTRAINT fk_lift_checks_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id)
) ENGINE=InnoDB;

-- Every time a lift stopped carrying guests, and why.
CREATE TABLE IF NOT EXISTS lift_downtime (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  lift_id     BIGINT UNSIGNED NOT NULL,
  started_at  DATETIME NOT NULL,
  ended_at    DATETIME NULL,
  reason      ENUM('wind','mechanical','electrical','weather','rescue','staffing','inspection','scheduled','other') NOT NULL DEFAULT 'other',
  note        VARCHAR(255) NULL,
  work_order_id BIGINT UNSIGNED NULL,
  user_id     BIGINT UNSIGNED NULL,
  KEY ix_downtime (tenant_id, lift_id, started_at),
  CONSTRAINT fk_downtime_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id)
) ENGINE=InnoDB;

-- Notes passed from one shift to the next, per department.
CREATE TABLE IF NOT EXISTS ops_handoffs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  dept        ENUM('grooming','lifts','snowmaking','maintenance','park','general') NOT NULL DEFAULT 'general',
  shift_date  DATE NOT NULL,
  shift       ENUM('day','night') NOT NULL DEFAULT 'day',
  body        VARCHAR(2000) NOT NULL,
  user_id     BIGINT UNSIGNED NULL,
  author      VARCHAR(100) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ack_by      VARCHAR(100) NULL,
  ack_at      DATETIME NULL,
  KEY ix_handoff (tenant_id, shift_date, dept)
) ENGINE=InnoDB;
