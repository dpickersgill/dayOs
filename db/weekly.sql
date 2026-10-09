-- The weekly owner report: one row per mountain per week, kept so the numbers can be shown again and the email goes only once.
CREATE TABLE IF NOT EXISTS weekly_reports (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  week_start DATE NOT NULL,
  summary    MEDIUMTEXT NOT NULL,
  emailed_at DATETIME NULL,
  sent_to    VARCHAR(600) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_weekly_reports_week (tenant_id, week_start),
  CONSTRAINT fk_weekly_reports_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;
