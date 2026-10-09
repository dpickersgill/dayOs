-- Instructor availability: an optional public profile for each instructor and the dates and times they have marked as open.
-- Applied by db/migrate.js. Everything is CREATE TABLE IF NOT EXISTS, so it is safe to re-run.

CREATE TABLE IF NOT EXISTS instructor_profiles (
  tenant_id    BIGINT UNSIGNED NOT NULL,
  staff_id     BIGINT UNSIGNED NOT NULL,
  is_public    TINYINT(1) NOT NULL DEFAULT 0,
  display_name VARCHAR(60) NULL,
  bio          VARCHAR(600) NULL,
  disciplines  VARCHAR(100) NOT NULL DEFAULT '',
  levels       VARCHAR(100) NOT NULL DEFAULT '',
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, staff_id),
  CONSTRAINT fk_iprofile_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS instructor_open (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  staff_id   BIGINT UNSIGNED NOT NULL,
  open_date  DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL,
  note       VARCHAR(120) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_iopen_day (tenant_id, open_date),
  KEY ix_iopen_staff (tenant_id, staff_id, open_date),
  CONSTRAINT fk_iopen_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;
