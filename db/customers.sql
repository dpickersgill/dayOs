-- The customer record, release 1: consent history, staff flags, dated notes, and a trail of merges and erasures.
CREATE TABLE IF NOT EXISTS consent_events (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  person_id      BIGINT UNSIGNED NOT NULL,
  channel        ENUM('email','sms') NOT NULL,
  status         ENUM('opted_in','opted_out') NOT NULL,
  source         VARCHAR(30) NOT NULL,
  wording        VARCHAR(40) NULL,
  recorded_by    BIGINT UNSIGNED NULL,
  recorded_by_name VARCHAR(100) NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_consent_person (tenant_id, person_id, channel, id),
  CONSTRAINT fk_consent_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS person_flags (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  person_id  BIGINT UNSIGNED NOT NULL,
  kind       ENUM('do_not_rent','unpaid_balance','medical_alert','vip','banned','other') NOT NULL,
  message    VARCHAR(200) NOT NULL,
  expires_on DATE NULL,
  set_by     BIGINT UNSIGNED NULL,
  set_by_name VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cleared_at TIMESTAMP NULL,
  cleared_by_name VARCHAR(100) NULL,
  KEY ix_flags_person (tenant_id, person_id, cleared_at),
  CONSTRAINT fk_flags_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS person_notes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  person_id  BIGINT UNSIGNED NOT NULL,
  category   ENUM('general','service','complaint','preference','follow_up') NOT NULL DEFAULT 'general',
  body       VARCHAR(1000) NOT NULL,
  author_id  BIGINT UNSIGNED NULL,
  author_name VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_notes_person (tenant_id, person_id, id),
  CONSTRAINT fk_pnotes_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

-- What happened to a record that no longer stands on its own: merged into another, or anonymised. No personal details kept.
CREATE TABLE IF NOT EXISTS person_tombstones (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  old_id     BIGINT UNSIGNED NOT NULL,
  kept_id    BIGINT UNSIGNED NULL,
  action     ENUM('merge','anonymise') NOT NULL,
  done_by    BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_tomb_old (tenant_id, old_id),
  CONSTRAINT fk_tomb_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- Bring existing customers across once: today's consent flag becomes the first consent event, today's note the first dated note.
INSERT INTO consent_events (tenant_id, person_id, channel, status, source, wording, created_at)
  SELECT p.tenant_id, p.id, 'email', 'opted_in', 'earlier_record', NULL, COALESCE(p.marketing_opt_in_at, p.created_at)
  FROM people p WHERE p.marketing_opt_in = 1
  AND NOT EXISTS (SELECT 1 FROM consent_events c WHERE c.tenant_id = p.tenant_id AND c.person_id = p.id AND c.channel = 'email');
INSERT INTO person_notes (tenant_id, person_id, category, body, author_name, created_at)
  SELECT p.tenant_id, p.id, 'general', p.notes, 'Earlier note', p.created_at
  FROM people p WHERE p.notes IS NOT NULL AND p.notes <> ''
  AND NOT EXISTS (SELECT 1 FROM person_notes n WHERE n.tenant_id = p.tenant_id AND n.person_id = p.id);
