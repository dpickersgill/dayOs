-- The day board: each person's chosen tiles, a manager's default per role, and shift notes.
CREATE TABLE IF NOT EXISTS board_layouts (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  owner_type ENUM('user','role') NOT NULL,
  owner_key  VARCHAR(40) NOT NULL,
  tiles      VARCHAR(2000) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, owner_type, owner_key),
  CONSTRAINT fk_board_layout_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS board_notes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  body       VARCHAR(1000) NOT NULL,
  pinned     TINYINT(1) NOT NULL DEFAULT 0,
  user_id    BIGINT UNSIGNED NULL,
  author     VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_board_notes (tenant_id, pinned, created_at),
  CONSTRAINT fk_board_note_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;
