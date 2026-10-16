-- Patrol operations: who is on duty, the closing sweep, opening checks, lift evacuation, the daily log, medications and
-- oxygen, avalanche work, records requests, lost-person searches and phone alerts. Patient care is in patrol.sql.

-- How these work at one mountain. One row per mountain, made the first time it is saved; missing means the defaults.
CREATE TABLE IF NOT EXISTS patrol_settings (
  tenant_id           BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  min_days            SMALLINT UNSIGNED NULL,          -- volunteer days a season (none = no minimum)
  min_days_candidate  SMALLINT UNSIGNED NULL,          -- for candidates, if different
  self_signup         TINYINT(1) NOT NULL DEFAULT 0,   -- patrollers may put themselves on open published shifts
  remind_dates        VARCHAR(40) NOT NULL DEFAULT '01-15,03-01', -- MM-DD, reminders to anyone behind pace
  last_reminded       DATE NULL,
  medical_director    VARCHAR(150) NULL,
  protocol_version    VARCHAR(60) NULL,
  sweep_late_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 45,
  controlled_counts   TINYINT(1) NOT NULL DEFAULT 0,   -- two-person counts for controlled medications
  avalanche           TINYINT(1) NOT NULL DEFAULT 0,
  sms_critical        TINYINT(1) NOT NULL DEFAULT 1,   -- text responders on critical calls as well as the phone alert
  o2_refill_psi       SMALLINT UNSIGNED NOT NULL DEFAULT 500,
  updated_by          BIGINT UNSIGNED NULL,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_psettings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- On duty: a patroller signs in when they reach the patrol room and out when they leave. Times are the mountain's clock.
-- open_key keeps one open sign-in per person.
CREATE TABLE IF NOT EXISTS patrol_duty (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  staff_id        BIGINT UNSIGNED NOT NULL,
  on_date         DATE NOT NULL,
  signed_in_at    DATETIME NOT NULL,
  signed_out_at   DATETIME NULL,
  station_id      BIGINT UNSIGNED NULL,
  radio           VARCHAR(30) NULL,
  patrol_shift_id BIGINT UNSIGNED NULL,
  source          ENUM('phone','room') NOT NULL DEFAULT 'phone',
  signed_in_by    BIGINT UNSIGNED NULL,
  signed_out_by   BIGINT UNSIGNED NULL,
  auto_closed     TINYINT(1) NOT NULL DEFAULT 0,
  open_key        BIGINT UNSIGNED AS (IF(signed_out_at IS NULL, staff_id, NULL)) STORED,
  UNIQUE KEY uq_pduty_open (tenant_id, open_key),
  KEY ix_pduty_day (tenant_id, on_date),
  KEY ix_pduty_staff (tenant_id, staff_id, on_date),
  CONSTRAINT fk_pduty_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  CONSTRAINT fk_pduty_station FOREIGN KEY (tenant_id, station_id) REFERENCES patrol_stations(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- closing sweep
CREATE TABLE IF NOT EXISTS patrol_sweep_routes (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  station_id  BIGINT UNSIGNED NULL,
  sort        SMALLINT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_psroute_name (tenant_id, name),
  UNIQUE KEY uq_psroute_tenant_id (tenant_id, id),
  CONSTRAINT fk_psroute_station FOREIGN KEY (tenant_id, station_id) REFERENCES patrol_stations(tenant_id, id)
) ENGINE=InnoDB;

-- The runs and lifts on a route, in the order they are swept. A label covers places that are neither (a lodge deck).
CREATE TABLE IF NOT EXISTS patrol_sweep_items (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  route_id   BIGINT UNSIGNED NOT NULL,
  trail_id   BIGINT UNSIGNED NULL,
  lift_id    BIGINT UNSIGNED NULL,
  label      VARCHAR(100) NULL,
  sort       SMALLINT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_psitem_tenant_id (tenant_id, id),
  KEY ix_psitem_route (tenant_id, route_id, sort),
  CONSTRAINT fk_psitem_route FOREIGN KEY (tenant_id, route_id) REFERENCES patrol_sweep_routes(tenant_id, id),
  CONSTRAINT fk_psitem_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id),
  CONSTRAINT fk_psitem_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id)
) ENGINE=InnoDB;

-- One sweep a day: started by the leader, "mountain clear" when every route is clear.
CREATE TABLE IF NOT EXISTS patrol_sweeps (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  on_date         DATE NOT NULL,
  status          ENUM('running','clear') NOT NULL DEFAULT 'running',
  started_at      DATETIME NOT NULL,
  started_by      BIGINT UNSIGNED NOT NULL,
  clear_at        DATETIME NULL,
  clear_by        BIGINT UNSIGNED NULL,
  clear_note      VARCHAR(255) NULL,
  late_alerted_at DATETIME NULL,
  UNIQUE KEY uq_psweep_day (tenant_id, on_date),
  UNIQUE KEY uq_psweep_tenant_id (tenant_id, id)
) ENGINE=InnoDB;

-- A route in today's sweep, and who sweeps it.
CREATE TABLE IF NOT EXISTS patrol_sweep_runs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  sweep_id    BIGINT UNSIGNED NOT NULL,
  route_id    BIGINT UNSIGNED NOT NULL,
  staff_id    BIGINT UNSIGNED NULL,
  status      ENUM('waiting','sweeping','clear') NOT NULL DEFAULT 'waiting',
  cleared_at  DATETIME NULL,
  note        VARCHAR(255) NULL,
  UNIQUE KEY uq_psrun (tenant_id, sweep_id, route_id),
  UNIQUE KEY uq_psrun_tenant_id (tenant_id, id),
  CONSTRAINT fk_psrun_sweep FOREIGN KEY (tenant_id, sweep_id) REFERENCES patrol_sweeps(tenant_id, id),
  CONSTRAINT fk_psrun_route FOREIGN KEY (tenant_id, route_id) REFERENCES patrol_sweep_routes(tenant_id, id),
  CONSTRAINT fk_psrun_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- Each run or lift swept, with anything found.
CREATE TABLE IF NOT EXISTS patrol_sweep_marks (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  run_id    BIGINT UNSIGNED NOT NULL,
  item_id   BIGINT UNSIGNED NOT NULL,
  swept_at  DATETIME NOT NULL,
  by_staff  BIGINT UNSIGNED NULL,
  by_user   BIGINT UNSIGNED NOT NULL,
  flag      ENUM('none','person','hazard','rope','other') NOT NULL DEFAULT 'none',
  note      VARCHAR(255) NULL,
  call_id   BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_psmark (tenant_id, run_id, item_id),
  CONSTRAINT fk_psmark_run FOREIGN KEY (tenant_id, run_id) REFERENCES patrol_sweep_runs(tenant_id, id),
  CONSTRAINT fk_psmark_item FOREIGN KEY (tenant_id, item_id) REFERENCES patrol_sweep_items(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- opening checks
-- A run checked before it opens. The decision sets the trail on Mountain status.
CREATE TABLE IF NOT EXISTS patrol_opening_checks (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  on_date         DATE NOT NULL,
  trail_id        BIGINT UNSIGNED NOT NULL,
  checked_at      DATETIME NOT NULL,
  checked_by      BIGINT UNSIGNED NULL,            -- staff
  by_user         BIGINT UNSIGNED NOT NULL,
  hazards_marked  TINYINT(1) NOT NULL DEFAULT 0,
  ropes_signs     TINYINT(1) NOT NULL DEFAULT 0,
  padding         TINYINT(1) NOT NULL DEFAULT 0,
  hazards         VARCHAR(500) NULL,
  decision        ENUM('open','hold','closed') NOT NULL,
  reason          VARCHAR(200) NULL,
  KEY ix_popen_day (tenant_id, on_date, trail_id),
  CONSTRAINT fk_popen_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- lift evacuation
CREATE TABLE IF NOT EXISTS patrol_lift_plans (
  tenant_id           BIGINT UNSIGNED NOT NULL,
  lift_id             BIGINT UNSIGNED NOT NULL,
  plan                TEXT NULL,
  equipment           VARCHAR(500) NULL,
  equipment_location  VARCHAR(200) NULL,
  patrollers_needed   TINYINT UNSIGNED NULL,
  updated_by          BIGINT UNSIGNED NULL,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, lift_id),
  CONSTRAINT fk_pliftplan_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id)
) ENGINE=InnoDB;

-- A drill or a real evacuation.
CREATE TABLE IF NOT EXISTS patrol_lift_evacs (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  lift_id      BIGINT UNSIGNED NOT NULL,
  kind         ENUM('drill','real') NOT NULL DEFAULT 'drill',
  started_at   DATETIME NOT NULL,
  ended_at     DATETIME NULL,
  guests       SMALLINT UNSIGNED NULL,
  notes        TEXT NULL,
  recorded_by  BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_plevac_tenant_id (tenant_id, id),
  KEY ix_plevac_lift (tenant_id, lift_id, started_at),
  CONSTRAINT fk_plevac_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patrol_lift_evac_people (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  evac_id    BIGINT UNSIGNED NOT NULL,
  staff_id   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (tenant_id, evac_id, staff_id),
  CONSTRAINT fk_plevacp_evac FOREIGN KEY (tenant_id, evac_id) REFERENCES patrol_lift_evacs(tenant_id, id),
  CONSTRAINT fk_plevacp_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- daily patrol log
CREATE TABLE IF NOT EXISTS patrol_daily_log (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  on_date    DATE NOT NULL,
  notes      TEXT NULL,
  updated_by BIGINT UNSIGNED NULL,
  signed_by  BIGINT UNSIGNED NULL,
  signed_at  DATETIME NULL,
  PRIMARY KEY (tenant_id, on_date),
  CONSTRAINT fk_pdlog_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patrol_daily_addenda (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  on_date    DATE NOT NULL,
  body       TEXT NOT NULL,
  by_user    BIGINT UNSIGNED NOT NULL,
  at         DATETIME NOT NULL,
  KEY ix_pdadd_day (tenant_id, on_date)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- medications
-- The drugs a patrol may give, set by its medical director.
CREATE TABLE IF NOT EXISTS patrol_formulary (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  authority   ENUM('standing_order','assist_own','medical_control') NOT NULL DEFAULT 'standing_order',
  routes      VARCHAR(120) NULL,                   -- comma list of allowed routes
  max_dose    DECIMAL(10,2) NULL,
  dose_unit   ENUM('mg','mcg','g','mL','units','puffs','tablets','drops','L/min') NULL,
  min_cert    ENUM('none','oec','emr','emt','aemt','paramedic','rn','md') NOT NULL DEFAULT 'oec',
  controlled  TINYINT(1) NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  notes       VARCHAR(255) NULL,
  UNIQUE KEY uq_pform_name (tenant_id, name),
  UNIQUE KEY uq_pform_tenant_id (tenant_id, id),
  CONSTRAINT fk_pform_tenant2 FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- A lot of a drug at a station.
CREATE TABLE IF NOT EXISTS patrol_med_stock (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  formulary_id  BIGINT UNSIGNED NOT NULL,
  station_id    BIGINT UNSIGNED NULL,
  lot           VARCHAR(40) NULL,
  expires_on    DATE NULL,
  quantity      DECIMAL(10,2) NOT NULL DEFAULT 0,
  unit          VARCHAR(20) NOT NULL DEFAULT 'doses',
  low_at        DECIMAL(10,2) NULL,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_pstock_tenant_id (tenant_id, id),
  KEY ix_pstock_drug (tenant_id, formulary_id),
  CONSTRAINT fk_pstock_drug FOREIGN KEY (tenant_id, formulary_id) REFERENCES patrol_formulary(tenant_id, id),
  CONSTRAINT fk_pstock_station FOREIGN KEY (tenant_id, station_id) REFERENCES patrol_stations(tenant_id, id)
) ENGINE=InnoDB;

-- Every change to a stock quantity, with why.
CREATE TABLE IF NOT EXISTS patrol_med_moves (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  stock_id      BIGINT UNSIGNED NOT NULL,
  delta         DECIMAL(10,2) NOT NULL,
  reason        ENUM('received','used','wasted','expired','count','adjust') NOT NULL,
  incident_id   BIGINT UNSIGNED NULL,
  treatment_id  BIGINT UNSIGNED NULL,
  by_user       BIGINT UNSIGNED NOT NULL,
  witness_staff BIGINT UNSIGNED NULL,
  at            DATETIME NOT NULL,
  note          VARCHAR(255) NULL,
  KEY ix_pmove_stock (tenant_id, stock_id, at),
  CONSTRAINT fk_pmove_stock FOREIGN KEY (tenant_id, stock_id) REFERENCES patrol_med_stock(tenant_id, id)
) ENGINE=InnoDB;

-- A two-person count of controlled drugs at a change of shift.
CREATE TABLE IF NOT EXISTS patrol_med_counts (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  counted_at    DATETIME NOT NULL,
  by_user       BIGINT UNSIGNED NOT NULL,
  witness_staff BIGINT UNSIGNED NOT NULL,
  count_lines   TEXT NOT NULL,                 -- JSON [{stock_id, expected, counted}]
  discrepancy   TINYINT(1) NOT NULL DEFAULT 0,
  note          VARCHAR(500) NULL,
  KEY ix_pcount (tenant_id, counted_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- avalanche
CREATE TABLE IF NOT EXISTS patrol_avy_paths (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  name      VARCHAR(100) NOT NULL,
  trail_id  BIGINT UNSIGNED NULL,
  active    TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_pavyp_name (tenant_id, name),
  UNIQUE KEY uq_pavyp_tenant_id (tenant_id, id),
  CONSTRAINT fk_pavyp_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patrol_avy_obs (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  observed_at   DATETIME NOT NULL,
  by_staff      BIGINT UNSIGNED NULL,
  by_user       BIGINT UNSIGNED NOT NULL,
  hn24_cm       SMALLINT UNSIGNED NULL,
  hst_cm        SMALLINT UNSIGNED NULL,
  wind          ENUM('calm','light','moderate','strong','extreme') NULL,
  wind_dir      VARCHAR(3) NULL,
  temp_trend    ENUM('warming','steady','cooling') NULL,
  tests         VARCHAR(500) NULL,
  hazard_below  TINYINT UNSIGNED NULL,
  hazard_near   TINYINT UNSIGNED NULL,
  hazard_above  TINYINT UNSIGNED NULL,
  notes         TEXT NULL,
  KEY ix_pavyo (tenant_id, observed_at)
) ENGINE=InnoDB;

-- A control shot or ski cut and its result.
CREATE TABLE IF NOT EXISTS patrol_avy_shots (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  shot_at     DATETIME NOT NULL,
  path_id     BIGINT UNSIGNED NOT NULL,
  method      ENUM('hand_charge','avalauncher','gas','ski_cut','cornice','other') NOT NULL,
  by_staff    BIGINT UNSIGNED NULL,
  by_user     BIGINT UNSIGNED NOT NULL,
  result      ENUM('no_result','sluff','slide') NOT NULL DEFAULT 'no_result',
  size_r      TINYINT UNSIGNED NULL,
  size_d      DECIMAL(2,1) NULL,
  crown_cm    SMALLINT UNSIGNED NULL,
  notes       VARCHAR(500) NULL,
  KEY ix_pavys (tenant_id, shot_at),
  CONSTRAINT fk_pavys_path FOREIGN KEY (tenant_id, path_id) REFERENCES patrol_avy_paths(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- records requests
CREATE TABLE IF NOT EXISTS patrol_records_requests (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  incident_id     BIGINT UNSIGNED NOT NULL,
  requester_kind  ENUM('patient','guardian','insurer','attorney','police','court','other') NOT NULL,
  requester_name  VARCHAR(150) NOT NULL,
  contact         VARCHAR(255) NULL,
  received_on     DATE NOT NULL,
  authorization   ENUM('signed_release','subpoena','court_order','police_request','patient_self','none') NOT NULL DEFAULT 'none',
  auth_note       VARCHAR(255) NULL,
  status          ENUM('open','released','denied','withdrawn') NOT NULL DEFAULT 'open',
  version_id      BIGINT UNSIGNED NULL,
  release_no      VARCHAR(20) NULL,
  released_at     DATETIME NULL,
  decided_by      BIGINT UNSIGNED NULL,
  decision_note   VARCHAR(500) NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_prr_tenant_id (tenant_id, id),
  KEY ix_prr_incident (tenant_id, incident_id),
  KEY ix_prr_status (tenant_id, status),
  CONSTRAINT fk_prr_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- lost-person search
CREATE TABLE IF NOT EXISTS incident_search (
  tenant_id        BIGINT UNSIGNED NOT NULL,
  incident_id      BIGINT UNSIGNED NOT NULL,
  person_name      VARCHAR(150) NULL,
  age_years        TINYINT UNSIGNED NULL,
  last_seen_at     DATETIME NULL,
  last_seen_place  VARCHAR(255) NULL,
  description      VARCHAR(500) NULL,
  clothing         VARCHAR(500) NULL,
  phone            VARCHAR(40) NULL,
  reported_by      VARCHAR(255) NULL,
  found_at         DATETIME NULL,
  found_place      VARCHAR(255) NULL,
  outcome          ENUM('found_well','found_injured','self_returned','not_found','other') NULL,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, incident_id),
  CONSTRAINT fk_isearch_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_search_areas (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  incident_id  BIGINT UNSIGNED NOT NULL,
  area         VARCHAR(150) NOT NULL,
  trail_id     BIGINT UNSIGNED NULL,
  staff_id     BIGINT UNSIGNED NULL,
  status       ENUM('assigned','searched') NOT NULL DEFAULT 'assigned',
  assigned_at  DATETIME NOT NULL,
  searched_at  DATETIME NULL,
  note         VARCHAR(255) NULL,
  KEY ix_isarea (tenant_id, incident_id),
  CONSTRAINT fk_isarea_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- phone alerts
-- A phone that agreed to alerts (Web Push). One login can have several phones.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  endpoint    VARCHAR(600) NOT NULL,
  endpoint_hash CHAR(64) NOT NULL,
  p256dh      VARCHAR(200) NOT NULL,
  auth        VARCHAR(60) NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_ok_at  DATETIME NULL,
  failures    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_push_endpoint (endpoint_hash),
  KEY ix_push_user (tenant_id, user_id)
) ENGINE=InnoDB;

-- Server keys made once (the push signing key when none is configured).
CREATE TABLE IF NOT EXISTS app_secrets (
  name   VARCHAR(60) NOT NULL PRIMARY KEY,
  value  TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
