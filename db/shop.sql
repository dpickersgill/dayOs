-- The online shop: one row per basket a guest sends to the card page. The real sale (order, tickets) is made only when the payment lands.
CREATE TABLE IF NOT EXISTS shop_orders (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  reference         CHAR(8) NOT NULL,
  view_token        CHAR(32) NOT NULL,
  contact_name      VARCHAR(150) NOT NULL,
  contact_email     VARCHAR(255) NOT NULL,
  contact_phone     VARCHAR(40) NULL,
  basket            MEDIUMTEXT NOT NULL,
  waiver_accepted   TINYINT(1) NOT NULL DEFAULT 0,
  waiver_text_sha   CHAR(64) NULL,
  news_opt_in       TINYINT(1) NOT NULL DEFAULT 0,
  status            ENUM('awaiting_payment','paid','expired','refunded') NOT NULL DEFAULT 'awaiting_payment',
  amount_cents      INT UNSIGNED NOT NULL DEFAULT 0,
  stripe_session_id VARCHAR(120) NULL,
  payment_intent    VARCHAR(100) NULL,
  order_id          BIGINT UNSIGNED NULL,
  emailed_at        DATETIME NULL,
  note              VARCHAR(300) NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at           DATETIME NULL,
  UNIQUE KEY uq_shop_orders_tenant_id (tenant_id, id),
  UNIQUE KEY uq_shop_orders_ref (tenant_id, reference),
  UNIQUE KEY uq_shop_orders_token (view_token),
  KEY ix_shop_orders_status (tenant_id, status, created_at),
  CONSTRAINT fk_shop_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- How a mountain looks on its public shop page, and the banner for presale season.
CREATE TABLE IF NOT EXISTS shop_brand (
  tenant_id    BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  color        CHAR(7) NULL,
  logo         MEDIUMTEXT NULL,
  hero         MEDIUMTEXT NULL,
  opening_day  DATE NULL,
  opening_note VARCHAR(200) NULL,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_shop_brand_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- Guests who asked to be told when a sold-out day opens up.
CREATE TABLE IF NOT EXISTS shop_waitlist (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  email       VARCHAR(255) NOT NULL,
  name        VARCHAR(150) NULL,
  on_date     DATE NOT NULL,
  party_size  TINYINT UNSIGNED NOT NULL DEFAULT 1,
  notified_at TIMESTAMP NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_waitlist (tenant_id, email, on_date),
  KEY ix_waitlist_day (tenant_id, on_date, notified_at),
  CONSTRAINT fk_waitlist_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- Groups, schools and companies asking for a quote.
CREATE TABLE IF NOT EXISTS group_enquiries (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  contact_name  VARCHAR(150) NOT NULL,
  organisation  VARCHAR(150) NULL,
  email         VARCHAR(255) NOT NULL,
  phone         VARCHAR(40) NULL,
  group_size    SMALLINT UNSIGNED NOT NULL,
  preferred_on  DATE NULL,
  note          VARCHAR(1000) NULL,
  status        ENUM('new','contacted','booked','closed') NOT NULL DEFAULT 'new',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_group_enq (tenant_id, status, created_at),
  CONSTRAINT fk_group_enq_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- A guest moving a ticket to another day. A fee or price rise is paid on Stripe first; free changes apply at once.
CREATE TABLE IF NOT EXISTS shop_changes (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  shop_order_id BIGINT UNSIGNED NOT NULL,
  ticket_id     BIGINT UNSIGNED NOT NULL,
  from_date     DATE NOT NULL,
  to_date       DATE NOT NULL,
  due_cents     INT UNSIGNED NOT NULL DEFAULT 0,
  status        ENUM('awaiting_payment','done','expired','refunded') NOT NULL DEFAULT 'awaiting_payment',
  stripe_session_id VARCHAR(255) NULL,
  order_id      BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_changes_order (tenant_id, shop_order_id),
  CONSTRAINT fk_changes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- A limit for one day that replaces the standing one (a holiday cap). product_id 0 = every product together.
CREATE TABLE IF NOT EXISTS shop_day_limits (
  tenant_id   BIGINT UNSIGNED NOT NULL,
  on_date     DATE NOT NULL,
  product_id  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  max_tickets INT UNSIGNED NOT NULL,
  PRIMARY KEY (tenant_id, on_date, product_id),
  CONSTRAINT fk_day_limits_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- How many times the shop page was opened each day, for the visit-to-sale funnel.
CREATE TABLE IF NOT EXISTS shop_visits (
  tenant_id BIGINT UNSIGNED NOT NULL,
  day       DATE NOT NULL,
  visits    INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day),
  CONSTRAINT fk_shop_visits_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;
