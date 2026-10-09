-- Messages to customers: campaigns, and a log of everything sent (so nothing goes twice and a guest can see what they were sent).
CREATE TABLE IF NOT EXISTS campaigns (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(120) NOT NULL,
  channel     ENUM('email','sms') NOT NULL,
  subject     VARCHAR(200) NULL,
  body        TEXT NOT NULL,
  audience    VARCHAR(40) NOT NULL,
  status      ENUM('draft','sending','sent') NOT NULL DEFAULT 'draft',
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at     TIMESTAMP NULL,
  total       INT UNSIGNED NOT NULL DEFAULT 0,
  sent        INT UNSIGNED NOT NULL DEFAULT 0,
  failed      INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_campaigns_tenant_id (tenant_id, id),
  KEY ix_campaigns_tenant (tenant_id, created_at),
  CONSTRAINT fk_campaigns_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- No foreign key to people on purpose: a merge or an anonymise must never be blocked by old messages.
CREATE TABLE IF NOT EXISTS message_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  campaign_id BIGINT UNSIGNED NULL,
  person_id   BIGINT UNSIGNED NOT NULL,
  kind        VARCHAR(30) NOT NULL,
  ref_id      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  channel     ENUM('email','sms') NOT NULL,
  to_addr     VARCHAR(255) NOT NULL,
  status      ENUM('sent','failed') NOT NULL,
  error       VARCHAR(200) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_message_once (tenant_id, kind, ref_id, person_id, channel),
  KEY ix_message_person (tenant_id, person_id, id),
  KEY ix_message_campaign (tenant_id, campaign_id),
  CONSTRAINT fk_message_log_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;
