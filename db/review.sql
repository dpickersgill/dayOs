-- Patrol case review: the review group (the Patrol Director and named backups), which kinds of case it reviews,
-- and every review decision. Applied by db/migrate.js; safe to re-run.

CREATE TABLE IF NOT EXISTS patrol_review_settings (
  tenant_id     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  categories    VARCHAR(200) NOT NULL DEFAULT 'injury,collision,lost_person,equipment,medical,conduct,other',
  nudge_hours   SMALLINT UNSIGNED NOT NULL DEFAULT 72,
  thread_id     BIGINT UNSIGNED NULL,          -- the group's Inbox conversation, where new reports and nudges arrive
  updated_by    BIGINT UNSIGNED NULL,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_review_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patrol_reviewers (
  tenant_id     BIGINT UNSIGNED NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  is_lead       TINYINT(1) NOT NULL DEFAULT 0,  -- the Patrol Director
  added_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT fk_reviewers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- One row per decision: approved, sent back (with comments), escalated, or signed off without review (a kind of case
-- the group does not review).
CREATE TABLE IF NOT EXISTS incident_reviews (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  incident_id   BIGINT UNSIGNED NOT NULL,
  round         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  outcome       ENUM('approved','returned','escalated','not_required') NOT NULL,
  reviewer_user BIGINT UNSIGNED NULL,
  checklist     VARCHAR(1000) NULL,               -- JSON: which review checks were ticked
  comments      TEXT NULL,                        -- JSON: [{ section, text }] when sent back
  note          VARCHAR(1000) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_incident_reviews (tenant_id, incident_id, id),
  CONSTRAINT fk_incident_reviews FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;
