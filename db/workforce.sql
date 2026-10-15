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
