-- Staff and schedule: which positions each person works, saved week templates. Applied by db/migrate.js; safe to re-run.
-- (Shift notes and time-entry approval and corrections are columns added by the migration steps.)

-- The positions a person is trained for. Used to put the right people first when filling a shift; it does not block.
CREATE TABLE IF NOT EXISTS staff_positions (
  tenant_id    BIGINT UNSIGNED NOT NULL,
  staff_id     BIGINT UNSIGNED NOT NULL,
  position_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (tenant_id, staff_id, position_id),
  KEY ix_staff_positions_pos (tenant_id, position_id),
  CONSTRAINT fk_staffpos_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  CONSTRAINT fk_staffpos_position FOREIGN KEY (tenant_id, position_id) REFERENCES positions(tenant_id, id)
) ENGINE=InnoDB;

-- A saved week ("Weekday standard", "Holiday week"), applied to any week as draft shifts.
CREATE TABLE IF NOT EXISTS shift_templates (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(80) NOT NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shift_templates_name (tenant_id, name),
  UNIQUE KEY uq_shift_templates_tenant_id (tenant_id, id),
  CONSTRAINT fk_shift_templates_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS shift_template_items (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  template_id  BIGINT UNSIGNED NOT NULL,
  day_offset   TINYINT UNSIGNED NOT NULL,      -- 0 = Monday ... 6 = Sunday
  start_time   TIME NOT NULL,
  minutes      SMALLINT UNSIGNED NOT NULL,     -- length, so a shift can run past midnight
  position_id  BIGINT UNSIGNED NOT NULL,
  staff_id     BIGINT UNSIGNED NULL,           -- kept when the person can still work it, otherwise the shift is left unfilled
  notes        VARCHAR(200) NULL,
  KEY ix_template_items (tenant_id, template_id),
  CONSTRAINT fk_template_items_template FOREIGN KEY (tenant_id, template_id) REFERENCES shift_templates(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_template_items_position FOREIGN KEY (tenant_id, position_id) REFERENCES positions(tenant_id, id)
) ENGINE=InnoDB;

-- The patrol schedule, kept apart from Staff and schedule: built in Patrol by those with the schedule permission. A
-- shift can be left open (no one on it yet). Volunteers are on it as well as paid patrollers.
CREATE TABLE IF NOT EXISTS patrol_shifts (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  staff_id    BIGINT UNSIGNED NULL,
  starts_at   DATETIME NOT NULL,            -- the mountain's local time, like Staff and schedule shifts
  ends_at     DATETIME NOT NULL,
  station_id  BIGINT UNSIGNED NULL,
  role_label  VARCHAR(60) NULL,             -- "Patrol leader", "Sweep", "Aid room"
  notes       VARCHAR(200) NULL,
  status      ENUM('draft','published','cancelled') NOT NULL DEFAULT 'draft',
  created_by  BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_patrol_shifts_tenant_id (tenant_id, id),
  KEY ix_patrol_shifts_time (tenant_id, starts_at),
  KEY ix_patrol_shifts_staff (tenant_id, staff_id, starts_at),
  CONSTRAINT fk_patrol_shifts_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  CONSTRAINT fk_patrol_shifts_station FOREIGN KEY (tenant_id, station_id) REFERENCES patrol_stations(tenant_id, id)
) ENGINE=InnoDB;

-- One patroller's exceptions to their access level, set by a patrol Admin: allowed = 1 adds a feature their level does
-- not have, allowed = 0 takes one away. Patrol Admins, owners and managers always have everything.
CREATE TABLE IF NOT EXISTS patrol_member_access (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  staff_id   BIGINT UNSIGNED NOT NULL,
  feature    VARCHAR(40) NOT NULL,
  allowed    TINYINT(1) NOT NULL,
  set_by     BIGINT UNSIGNED NULL,
  set_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, staff_id, feature),
  CONSTRAINT fk_pma_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- Shift cover: a patroller who cannot work a published patrol shift asks for cover, and someone else on the roster
-- takes it. With approval on, a schedule builder confirms the swap before the shift changes hands.
--   open       waiting for someone to take it
--   pending    someone offered to take it; waiting for a schedule builder (approval on)
--   covered    the shift now belongs to taken_by
--   withdrawn  the patroller who asked took it back
--   closed     the shift was cancelled or reassigned on the schedule, so the request no longer applies
-- A request whose shift has started without being covered is shown as expired; nothing needs to change it.
CREATE TABLE IF NOT EXISTS patrol_cover_requests (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  patrol_shift_id BIGINT UNSIGNED NOT NULL,
  staff_id        BIGINT UNSIGNED NOT NULL,          -- who asked (on the shift when they asked)
  reason          VARCHAR(200) NULL,
  status          ENUM('open','pending','covered','withdrawn','closed') NOT NULL DEFAULT 'open',
  taken_by        BIGINT UNSIGNED NULL,              -- staff who took it or offered to
  taken_at        DATETIME NULL,
  decided_by      BIGINT UNSIGNED NULL,              -- the login that approved, declined or closed it
  decided_note    VARCHAR(200) NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pcr_tenant_id (tenant_id, id),
  KEY ix_pcr_status (tenant_id, status),
  KEY ix_pcr_shift (tenant_id, patrol_shift_id),
  CONSTRAINT fk_pcr_shift FOREIGN KEY (tenant_id, patrol_shift_id) REFERENCES patrol_shifts(tenant_id, id),
  CONSTRAINT fk_pcr_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  CONSTRAINT fk_pcr_taker FOREIGN KEY (tenant_id, taken_by) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- How shift cover works at a mountain, and the patrol's Inbox conversation where requests are announced.
CREATE TABLE IF NOT EXISTS patrol_cover_settings (
  tenant_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  needs_approval  TINYINT(1) NOT NULL DEFAULT 0,
  thread_id       BIGINT UNSIGNED NULL,
  updated_by      BIGINT UNSIGNED NULL,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pcs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;
