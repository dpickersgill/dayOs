-- Gate: RFID cards and the hardware that reads them.
-- A card is identified by its chip's serial number (UID). It carries one ticket or pass at a time and can be reloaded
-- with another later (keycards are reused season to season). A lost card is blocked; its ticket moves to a new card.

CREATE TABLE IF NOT EXISTS rfid_cards (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  uid          VARCHAR(32) NOT NULL,           -- the chip serial, uppercase hex, no separators
  label        VARCHAR(40) NULL,               -- the number printed on the card, if any
  ticket_id    BIGINT UNSIGNED NULL,
  status       ENUM('free','assigned','lost','retired') NOT NULL DEFAULT 'free',
  assigned_at  DATETIME NULL,
  last_seen_at DATETIME NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rfid_uid (tenant_id, uid),
  UNIQUE KEY uq_rfid_tenant_id (tenant_id, id),
  KEY ix_rfid_ticket (tenant_id, ticket_id),
  CONSTRAINT fk_rfid_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- Gates, turnstiles and handheld readers. Paired like the time clock tablet: a manager's one-time code is traded for
-- the device's own key, which is the only credential it holds.
CREATE TABLE IF NOT EXISTS access_devices (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(100) NOT NULL,
  location        VARCHAR(100) NULL,           -- written on each scan, e.g. "Summit Quad"
  kind            ENUM('gate','turnstile','handheld','reader') NOT NULL DEFAULT 'gate',
  token_hash      CHAR(64) NULL,
  pair_hash       CHAR(64) NULL,
  pair_expires_at DATETIME NULL,
  active          TINYINT(1) NOT NULL DEFAULT 1,
  paired_at       DATETIME NULL,
  last_seen_at    DATETIME NULL,
  last_list_at    DATETIME NULL,               -- when it last fetched the offline list
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_access_token (token_hash),
  UNIQUE KEY uq_access_pair (pair_hash),
  UNIQUE KEY uq_access_tenant_id (tenant_id, id),
  KEY ix_access_tenant (tenant_id),
  CONSTRAINT fk_access_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;
