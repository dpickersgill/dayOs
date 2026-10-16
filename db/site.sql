-- The product website: walkthrough and trial requests from the Contact page, kept for the operator console (Leads).
CREATE TABLE IF NOT EXISTS site_leads (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind          ENUM('walkthrough','trial','founding','question') NOT NULL DEFAULT 'walkthrough',
  name          VARCHAR(150) NOT NULL,
  mountain      VARCHAR(150) NOT NULL,
  role          VARCHAR(100) NULL,
  email         VARCHAR(255) NOT NULL,
  phone         VARCHAR(40) NULL,
  lifts         VARCHAR(20) NULL,
  plan_interest VARCHAR(60) NULL,
  message       VARCHAR(2000) NULL,
  founding      TINYINT(1) NOT NULL DEFAULT 0,
  status        ENUM('new','contacted','trial','won','lost') NOT NULL DEFAULT 'new',
  operator_note VARCHAR(1000) NULL,
  tenant_id     BIGINT UNSIGNED NULL,          -- the mountain made for them, once there is one
  ip_hash       CHAR(64) NULL,                 -- for spotting floods without keeping the address
  emailed       TINYINT(1) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_lead_status (status, created_at)
) ENGINE=InnoDB;
