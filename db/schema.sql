-- DAY/OS schema (MySQL 8 / MariaDB 10.6+, InnoDB, utf8mb4)
-- Multi-tenant by shared schema: every business table carries tenant_id, and
-- every composite foreign key includes tenant_id so rows cannot cross tenants.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS tenants (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug          VARCHAR(63)  NOT NULL UNIQUE,
  name          VARCHAR(255) NOT NULL,
  timezone      VARCHAR(63)  NOT NULL DEFAULT 'America/New_York',
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  address       VARCHAR(255) NULL,
  phone         VARCHAR(40)  NULL,
  receipt_footer VARCHAR(500) NULL,
  waiver_text   TEXT NULL,
  require_mfa   TINYINT(1) NOT NULL DEFAULT 0,
  comp_counter_limit_cents INT UNSIGNED NOT NULL DEFAULT 0,
  scan_passback_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 120
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS people (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NULL,
  phone         VARCHAR(40)  NULL,
  phone_key     VARCHAR(10) GENERATED ALWAYS AS (NULLIF(RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10), '')) STORED,
  date_of_birth DATE         NULL,
  sex           ENUM('female','male','other') NULL,
  height_in     SMALLINT UNSIGNED NULL,
  weight_lb     SMALLINT UNSIGNED NULL,
  boot_size     VARCHAR(10) NULL,
  stance        ENUM('regular','goofy') NULL,
  skier_type    VARCHAR(4) NULL,
  photo         MEDIUMTEXT NULL,
  address_line1 VARCHAR(255) NULL,
  address_line2 VARCHAR(255) NULL,
  city          VARCHAR(100) NULL,
  region        VARCHAR(60)  NULL,
  postal_code   VARCHAR(20)  NULL,
  country       VARCHAR(60)  NULL,
  emergency_name  VARCHAR(150) NULL,
  emergency_phone VARCHAR(40)  NULL,
  discipline    ENUM('ski','snowboard','telemark','adaptive') NULL,
  ability_level ENUM('first_timer','beginner','intermediate','advanced') NULL,
  marketing_opt_in    TINYINT(1) NOT NULL DEFAULT 0,
  marketing_opt_in_at TIMESTAMP  NULL,
  source        VARCHAR(20)  NULL,
  notes         VARCHAR(1000) NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_people_tenant_id (tenant_id, id),
  KEY ix_people_name (tenant_id, last_name, first_name),
  KEY ix_people_email (tenant_id, email),
  KEY ix_people_phone (tenant_id, phone),
  KEY ix_people_phone_key (tenant_id, phone_key),
  CONSTRAINT fk_people_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  person_id     BIGINT UNSIGNED NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('owner','manager','staff','patrol','instructor','counter') NOT NULL DEFAULT 'staff',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  totp_secret   VARCHAR(255) NULL,
  totp_enabled  TINYINT(1)   NOT NULL DEFAULT 0,
  totp_last_step BIGINT      NULL,
  UNIQUE KEY uq_users_email (tenant_id, email),
  CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_users_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS waivers (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  person_id  BIGINT UNSIGNED NOT NULL,
  season     VARCHAR(20)  NOT NULL,
  kind       VARCHAR(40)  NOT NULL DEFAULT 'general',
  signed_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  signed_by_person_id BIGINT UNSIGNED NULL,
  signed_by_name VARCHAR(200) NULL,
  signer_relation VARCHAR(40) NULL,
  text_sha   CHAR(64) NULL,
  KEY ix_waivers_person (tenant_id, person_id, season),
  CONSTRAINT fk_waivers_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

-- Which customer details a mountain makes mandatory when selling tickets or booking lessons.
CREATE TABLE IF NOT EXISTS customer_form_config (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  scope      ENUM('ticket','lesson') NOT NULL,
  field_key  VARCHAR(40) NOT NULL,
  required   TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, scope, field_key),
  CONSTRAINT fk_cform_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- products & pricing
CREATE TABLE IF NOT EXISTS products (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id        BIGINT UNSIGNED NOT NULL,
  kind             ENUM('day_ticket','multi_day','season_pass','punch_card','lesson','rental','program','voucher') NOT NULL,
  name             VARCHAR(255) NOT NULL,
  base_price_cents INT UNSIGNED NOT NULL DEFAULT 0,
  valid_days       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  uses             SMALLINT UNSIGNED NULL,
  active           TINYINT(1)   NOT NULL DEFAULT 1,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_products_tenant_id (tenant_id, id),
  KEY ix_products_kind (tenant_id, kind, active),
  CONSTRAINT fk_products_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS price_tiers (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  product_id  BIGINT UNSIGNED NOT NULL,
  tier        ENUM('adult','youth','child','senior','military') NOT NULL,
  price_cents INT UNSIGNED NOT NULL,
  UNIQUE KEY uq_price_tier (tenant_id, product_id, tier),
  CONSTRAINT fk_tiers_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
) ENGINE=InnoDB;

-- Date-specific overrides (holiday peaks, midweek specials, blackout = price NULL + blackout 1)
CREATE TABLE IF NOT EXISTS price_calendar (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  product_id  BIGINT UNSIGNED NOT NULL,
  on_date     DATE NOT NULL,
  tier        ENUM('adult','youth','child','senior','military') NULL,
  price_cents INT UNSIGNED NULL,
  blackout    TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_price_calendar (tenant_id, product_id, on_date, tier),
  CONSTRAINT fk_calendar_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS promo_codes (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id        BIGINT UNSIGNED NOT NULL,
  code             VARCHAR(40) NOT NULL,
  percent_off      TINYINT UNSIGNED NULL,
  amount_off_cents INT UNSIGNED NULL,
  starts_on        DATE NULL,
  ends_on          DATE NULL,
  max_uses         INT UNSIGNED NULL,
  used_count       INT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_promo (tenant_id, code),
  CONSTRAINT fk_promo_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- orders & tickets
CREATE TABLE IF NOT EXISTS orders (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  person_id    BIGINT UNSIGNED NULL,
  status       ENUM('pending','paid','refunded','cancelled') NOT NULL DEFAULT 'paid',
  promo_code   VARCHAR(40) NULL,
  subtotal_cents INT UNSIGNED NOT NULL DEFAULT 0,
  discount_cents INT UNSIGNED NOT NULL DEFAULT 0,
  total_cents  INT UNSIGNED NOT NULL DEFAULT 0,
  tax_cents    INT UNSIGNED NOT NULL DEFAULT 0,
  refunded_cents INT UNSIGNED NOT NULL DEFAULT 0,
  user_id      BIGINT UNSIGNED NULL,
  channel      ENUM('window','online','phone','group') NOT NULL DEFAULT 'window',
  payment_ref  VARCHAR(100) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_orders_tenant_id (tenant_id, id),
  KEY ix_orders_created (tenant_id, created_at),
  CONSTRAINT fk_orders_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id        BIGINT UNSIGNED NOT NULL,
  order_id         BIGINT UNSIGNED NOT NULL,
  product_id       BIGINT UNSIGNED NULL,
  line_kind        ENUM('ticket','lesson','rental','program','gift_card') NOT NULL DEFAULT 'ticket',
  person_id        BIGINT UNSIGNED NULL,
  session_id       BIGINT UNSIGNED NULL,
  program_id       BIGINT UNSIGNED NULL,
  contract_id      BIGINT UNSIGNED NULL,
  gift_card_id     BIGINT UNSIGNED NULL,
  tier             ENUM('adult','youth','child','senior','military') NOT NULL DEFAULT 'adult',
  quantity         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  unit_price_cents INT UNSIGNED NOT NULL,
  valid_on         DATE NULL,
  discount_cents   INT UNSIGNED NOT NULL DEFAULT 0,
  tax_cents        INT UNSIGNED NOT NULL DEFAULT 0,
  refunded_at      TIMESTAMP NULL,
  refund_id        BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_order_items_tenant_id (tenant_id, id),
  KEY ix_order_items_order (tenant_id, order_id),
  CONSTRAINT fk_items_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  CONSTRAINT fk_items_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
) ENGINE=InnoDB;

-- Gift cards: a code with a balance, sold from the basket and spent as a payment. The ledger records every change.
CREATE TABLE IF NOT EXISTS gift_cards (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  code          CHAR(20) NOT NULL,
  initial_cents INT UNSIGNED NOT NULL,
  balance_cents INT UNSIGNED NOT NULL,
  status        ENUM('active','void') NOT NULL DEFAULT 'active',
  purchaser_id  BIGINT UNSIGNED NULL,
  recipient_name VARCHAR(150) NULL,
  message       VARCHAR(300) NULL,
  expires_on    DATE NULL,
  order_id      BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gift_cards_code (tenant_id, code),
  UNIQUE KEY uq_gift_cards_tenant_id (tenant_id, id),
  CONSTRAINT fk_gift_cards_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gift_card_txns (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  gift_card_id  BIGINT UNSIGNED NOT NULL,
  order_id      BIGINT UNSIGNED NULL,
  kind          ENUM('issue','redeem','refund','void') NOT NULL,
  delta_cents   INT NOT NULL,
  balance_after_cents INT UNSIGNED NOT NULL,
  at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_gift_txns_card (tenant_id, gift_card_id, id),
  CONSTRAINT fk_gift_txns_card FOREIGN KEY (tenant_id, gift_card_id) REFERENCES gift_cards(tenant_id, id)
) ENGINE=InnoDB;

-- How an order was paid. An order can be split across tenders; a gift card tender points at the card.
CREATE TABLE IF NOT EXISTS order_payments (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  order_id       BIGINT UNSIGNED NOT NULL,
  tender         ENUM('cash','card','gift_card','other','comp') NOT NULL,
  amount_cents   INT UNSIGNED NOT NULL,
  tendered_cents INT UNSIGNED NULL,
  reference      VARCHAR(100) NULL,
  gift_card_id   BIGINT UNSIGNED NULL,
  card_brand     VARCHAR(20) NULL,
  card_last4     CHAR(4) NULL,
  auth_code      VARCHAR(30) NULL,
  processor      VARCHAR(30) NULL,
  comp_reason    VARCHAR(40) NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_payments_order (tenant_id, order_id),
  KEY ix_payments_time (tenant_id, created_at),
  CONSTRAINT fk_payments_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tickets (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  order_item_id  BIGINT UNSIGNED NOT NULL,
  person_id      BIGINT UNSIGNED NULL,
  product_id     BIGINT UNSIGNED NOT NULL,
  code           CHAR(20) NOT NULL,
  valid_from     DATE NOT NULL,
  valid_to       DATE NOT NULL,
  uses_remaining SMALLINT UNSIGNED NULL,
  status         ENUM('active','void','used_up') NOT NULL DEFAULT 'active',
  UNIQUE KEY uq_ticket_code (code),
  UNIQUE KEY uq_tickets_tenant_id (tenant_id, id),
  KEY ix_tickets_person (tenant_id, person_id),
  CONSTRAINT fk_tickets_item FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items(tenant_id, id),
  CONSTRAINT fk_tickets_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS scans (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  ticket_id  BIGINT UNSIGNED NULL,
  code       CHAR(20) NOT NULL,
  location   VARCHAR(100) NULL,
  result     ENUM('ok','expired','not_yet_valid','void','no_uses','unknown','duplicate') NOT NULL,
  scanned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_scans_time (tenant_id, scanned_at),
  CONSTRAINT fk_scans_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- rentals
CREATE TABLE IF NOT EXISTS rental_items (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  sku        VARCHAR(60)  NOT NULL,
  category   ENUM('ski','snowboard','boot','helmet','pole','other') NOT NULL,
  brand      VARCHAR(100) NULL,
  model      VARCHAR(100) NULL,
  size       VARCHAR(30)  NULL,
  status     ENUM('available','rented','maintenance','lost','retired') NOT NULL DEFAULT 'available',
  notes      VARCHAR(500) NULL,
  UNIQUE KEY uq_rental_sku (tenant_id, sku),
  UNIQUE KEY uq_rental_items_tenant_id (tenant_id, id),
  KEY ix_rental_status (tenant_id, category, status),
  CONSTRAINT fk_rental_items_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rental_contracts (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  person_id      BIGINT UNSIGNED NOT NULL,
  order_id       BIGINT UNSIGNED NULL,
  status         ENUM('out','returned','overdue','lost') NOT NULL DEFAULT 'out',
  checked_out_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at         DATETIME NOT NULL,
  checked_in_at  DATETIME NULL,
  UNIQUE KEY uq_contracts_tenant_id (tenant_id, id),
  KEY ix_contracts_status (tenant_id, status),
  CONSTRAINT fk_contracts_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS rental_contract_items (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  contract_id    BIGINT UNSIGNED NOT NULL,
  rental_item_id BIGINT UNSIGNED NOT NULL,
  din_setting    DECIMAL(3,1) NULL,
  returned_at    DATETIME NULL,
  damage_notes   VARCHAR(500) NULL,
  CONSTRAINT fk_rci_contract FOREIGN KEY (tenant_id, contract_id) REFERENCES rental_contracts(tenant_id, id),
  CONSTRAINT fk_rci_item FOREIGN KEY (tenant_id, rental_item_id) REFERENCES rental_items(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- schedule & conditions
CREATE TABLE IF NOT EXISTS calendar_days (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  on_date    DATE NOT NULL,
  status     ENUM('open','limited','closed') NOT NULL DEFAULT 'open',
  open_time  TIME NULL,
  close_time TIME NULL,
  notes      VARCHAR(500) NULL,
  PRIMARY KEY (tenant_id, on_date),
  CONSTRAINT fk_calendar_days_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lifts (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(100) NOT NULL,
  status     ENUM('open','hold','wind_hold','closed') NOT NULL DEFAULT 'closed',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lifts_name (tenant_id, name),
  UNIQUE KEY uq_lifts_tenant_id (tenant_id, id),
  CONSTRAINT fk_lifts_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trails (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(100) NOT NULL,
  difficulty ENUM('green','blue','black','double_black','park') NOT NULL DEFAULT 'green',
  status     ENUM('open','closed') NOT NULL DEFAULT 'closed',
  groomed    TINYINT(1) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_trails_name (tenant_id, name),
  UNIQUE KEY uq_trails_tenant_id (tenant_id, id),
  CONSTRAINT fk_trails_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS events (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  title       VARCHAR(255) NOT NULL,
  starts_at   DATETIME NOT NULL,
  ends_at     DATETIME NULL,
  description TEXT NULL,
  KEY ix_events_start (tenant_id, starts_at),
  CONSTRAINT fk_events_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- workforce
CREATE TABLE IF NOT EXISTS positions (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(100) NOT NULL,
  department ENUM('lifts','rentals','ski_school','patrol','food','guest_services','grooming','maintenance','admin') NOT NULL,
  visits_per_staff INT UNSIGNED NULL,  -- staffing ratio hint: 1 person per N forecast visits
  UNIQUE KEY uq_positions_name (tenant_id, name),
  UNIQUE KEY uq_positions_tenant_id (tenant_id, id),
  CONSTRAINT fk_positions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS certifications (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(100) NOT NULL,
  UNIQUE KEY uq_cert_name (tenant_id, name),
  UNIQUE KEY uq_certs_tenant_id (tenant_id, id),
  CONSTRAINT fk_certs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS position_certifications (
  tenant_id        BIGINT UNSIGNED NOT NULL,
  position_id      BIGINT UNSIGNED NOT NULL,
  certification_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (tenant_id, position_id, certification_id),
  CONSTRAINT fk_pc_position FOREIGN KEY (tenant_id, position_id) REFERENCES positions(tenant_id, id),
  CONSTRAINT fk_pc_cert FOREIGN KEY (tenant_id, certification_id) REFERENCES certifications(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS staff (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  person_id  BIGINT UNSIGNED NOT NULL,
  status     ENUM('applicant','onboarding','active','inactive') NOT NULL DEFAULT 'active',
  hired_on   DATE NULL,
  needs_housing TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uq_staff_person (tenant_id, person_id),
  UNIQUE KEY uq_staff_tenant_id (tenant_id, id),
  CONSTRAINT fk_staff_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS staff_certifications (
  tenant_id        BIGINT UNSIGNED NOT NULL,
  staff_id         BIGINT UNSIGNED NOT NULL,
  certification_id BIGINT UNSIGNED NOT NULL,
  issued_on        DATE NULL,
  expires_on       DATE NULL,
  PRIMARY KEY (tenant_id, staff_id, certification_id),
  CONSTRAINT fk_sc_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  CONSTRAINT fk_sc_cert FOREIGN KEY (tenant_id, certification_id) REFERENCES certifications(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS availability (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  staff_id   BIGINT UNSIGNED NOT NULL,
  weekday    TINYINT UNSIGNED NOT NULL,      -- 0 = Sunday ... 6 = Saturday
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL,
  CONSTRAINT fk_avail_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS shifts (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  position_id BIGINT UNSIGNED NOT NULL,
  staff_id    BIGINT UNSIGNED NULL,
  starts_at   DATETIME NOT NULL,
  ends_at     DATETIME NOT NULL,
  status      ENUM('draft','published','cancelled') NOT NULL DEFAULT 'draft',
  UNIQUE KEY uq_shifts_tenant_id (tenant_id, id),
  KEY ix_shifts_time (tenant_id, starts_at),
  KEY ix_shifts_staff (tenant_id, staff_id, starts_at),
  CONSTRAINT fk_shifts_position FOREIGN KEY (tenant_id, position_id) REFERENCES positions(tenant_id, id),
  CONSTRAINT fk_shifts_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS time_entries (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  staff_id   BIGINT UNSIGNED NOT NULL,
  shift_id   BIGINT UNSIGNED NULL,
  clock_in   DATETIME NOT NULL,
  clock_out  DATETIME NULL,
  KEY ix_time_open (tenant_id, staff_id, clock_out),
  CONSTRAINT fk_time_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- ski school
CREATE TABLE IF NOT EXISTS lesson_sessions (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  product_id    BIGINT UNSIGNED NOT NULL,
  discipline    ENUM('ski','snowboard','telemark','adaptive') NOT NULL DEFAULT 'ski',
  ability_level ENUM('first_timer','beginner','intermediate','advanced') NOT NULL DEFAULT 'beginner',
  starts_at     DATETIME NOT NULL,
  ends_at       DATETIME NOT NULL,
  capacity      SMALLINT UNSIGNED NOT NULL DEFAULT 6,
  instructor_id BIGINT UNSIGNED NULL,
  required_certification_id BIGINT UNSIGNED NULL,
  status        ENUM('scheduled','completed','cancelled') NOT NULL DEFAULT 'scheduled',
  UNIQUE KEY uq_lessons_tenant_id (tenant_id, id),
  KEY ix_lessons_time (tenant_id, starts_at),
  CONSTRAINT fk_lessons_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
  CONSTRAINT fk_lessons_instructor FOREIGN KEY (tenant_id, instructor_id) REFERENCES staff(tenant_id, id),
  CONSTRAINT fk_lessons_cert FOREIGN KEY (tenant_id, required_certification_id) REFERENCES certifications(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lesson_bookings (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  person_id  BIGINT UNSIGNED NOT NULL,
  status     ENUM('booked','attended','no_show','cancelled') NOT NULL DEFAULT 'booked',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_lesson_booking (tenant_id, session_id, person_id),
  CONSTRAINT fk_lb_session FOREIGN KEY (tenant_id, session_id) REFERENCES lesson_sessions(tenant_id, id),
  CONSTRAINT fk_lb_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS student_progress (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  person_id  BIGINT UNSIGNED NOT NULL,
  discipline ENUM('ski','snowboard','telemark','adaptive') NOT NULL,
  level      TINYINT UNSIGNED NOT NULL,
  notes      VARCHAR(1000) NULL,
  recorded_by BIGINT UNSIGNED NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_progress_person (tenant_id, person_id, recorded_at),
  CONSTRAINT fk_progress_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- patrol
CREATE TABLE IF NOT EXISTS incidents (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  occurred_at       DATETIME NOT NULL,
  location          VARCHAR(255) NOT NULL,
  category          ENUM('injury','collision','lost_person','equipment','medical','conduct','other') NOT NULL,
  severity          ENUM('minor','moderate','serious','critical') NOT NULL DEFAULT 'minor',
  person_id         BIGINT UNSIGNED NULL,
  reported_by_staff BIGINT UNSIGNED NULL,
  summary           VARCHAR(500) NOT NULL,
  narrative         TEXT NULL,
  disposition       ENUM('treated_released','transported','refused_care','no_injury','other') NULL,
  status            ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_incidents_tenant_id (tenant_id, id),
  KEY ix_incidents_time (tenant_id, occurred_at),
  CONSTRAINT fk_incidents_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id),
  CONSTRAINT fk_incidents_staff FOREIGN KEY (tenant_id, reported_by_staff) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_notes (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  incident_id BIGINT UNSIGNED NOT NULL,
  author_user BIGINT UNSIGNED NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notes_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS trail_checks (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  trail_id   BIGINT UNSIGNED NOT NULL,
  checked_by BIGINT UNSIGNED NULL,
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  hazards    VARCHAR(500) NULL,
  CONSTRAINT fk_checks_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- clubs & programs
CREATE TABLE IF NOT EXISTS programs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(255) NOT NULL,
  kind        ENUM('club','race_team','school_program','camp','league') NOT NULL,
  season      VARCHAR(20) NOT NULL,
  capacity    SMALLINT UNSIGNED NULL,
  price_cents INT UNSIGNED NOT NULL DEFAULT 0,
  starts_on   DATE NULL,
  ends_on     DATE NULL,
  UNIQUE KEY uq_programs_tenant_id (tenant_id, id),
  CONSTRAINT fk_programs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS program_enrollments (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  program_id  BIGINT UNSIGNED NOT NULL,
  person_id   BIGINT UNSIGNED NOT NULL,
  guardian_id BIGINT UNSIGNED NULL,
  status      ENUM('enrolled','waitlist','withdrawn') NOT NULL DEFAULT 'enrolled',
  paid_cents  INT UNSIGNED NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_enrollment (tenant_id, program_id, person_id),
  CONSTRAINT fk_enroll_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs(tenant_id, id),
  CONSTRAINT fk_enroll_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id),
  CONSTRAINT fk_enroll_guardian FOREIGN KEY (tenant_id, guardian_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS program_sessions (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  program_id   BIGINT UNSIGNED NOT NULL,
  starts_at    DATETIME NOT NULL,
  ends_at      DATETIME NOT NULL,
  coach_staff_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_psessions_tenant_id (tenant_id, id),
  CONSTRAINT fk_psessions_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs(tenant_id, id),
  CONSTRAINT fk_psessions_coach FOREIGN KEY (tenant_id, coach_staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS attendance (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  person_id  BIGINT UNSIGNED NOT NULL,
  present    TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, session_id, person_id),
  CONSTRAINT fk_att_session FOREIGN KEY (tenant_id, session_id) REFERENCES program_sessions(tenant_id, id),
  CONSTRAINT fk_att_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- audit
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NULL,
  action     VARCHAR(60)  NOT NULL,
  entity     VARCHAR(60)  NOT NULL,
  entity_id  BIGINT UNSIGNED NULL,
  detail     JSON NULL,
  at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit (tenant_id, entity, entity_id, at),
  KEY ix_audit_time (tenant_id, at)
) ENGINE=InnoDB;


-- ---------------------------------------------------------------- tax, refunds, till, family, sign-in recovery
-- A tax rule applies a rate (in basis points: 600 = 6%) to one kind of sale, or to everything. Tax is added on top of prices.
CREATE TABLE IF NOT EXISTS tax_rules (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(80) NOT NULL,
  applies_to ENUM('all','ticket','lesson','rental','program','gift_card') NOT NULL DEFAULT 'all',
  rate_bps   SMALLINT UNSIGNED NOT NULL,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_tax_name (tenant_id, name),
  CONSTRAINT fk_tax_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- The tax charged on an order, per rule, as it was at the time of sale (receipts and reports read this).
CREATE TABLE IF NOT EXISTS order_taxes (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  order_id     BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(80) NOT NULL,
  rate_bps     SMALLINT UNSIGNED NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  KEY ix_order_taxes_order (tenant_id, order_id),
  CONSTRAINT fk_order_taxes_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
) ENGINE=InnoDB;

-- Every refund, whole or partial: why, how much (tax included), and how the money went back.
CREATE TABLE IF NOT EXISTS order_refunds (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  order_id     BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NULL,
  reason       VARCHAR(40) NOT NULL,
  note         VARCHAR(300) NULL,
  amount_cents INT UNSIGNED NOT NULL,
  tax_cents    INT UNSIGNED NOT NULL DEFAULT 0,
  method       ENUM('cash','card','gift_card','other') NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_refunds_order (tenant_id, order_id),
  KEY ix_refunds_time (tenant_id, created_at),
  CONSTRAINT fk_refunds_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
) ENGINE=InnoDB;

-- A cash drawer: opened with a float, closed with a count. Expected cash is worked out from the sales, refunds and moves in between.
CREATE TABLE IF NOT EXISTS till_sessions (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  opened_by          BIGINT UNSIGNED NOT NULL,
  opened_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opening_float_cents INT UNSIGNED NOT NULL DEFAULT 0,
  status             ENUM('open','closed') NOT NULL DEFAULT 'open',
  closed_at          TIMESTAMP NULL,
  counted_cents      INT NULL,
  expected_cents     INT NULL,
  variance_cents     INT NULL,
  notes              VARCHAR(500) NULL,
  KEY ix_till_tenant (tenant_id, status, opened_at),
  CONSTRAINT fk_till_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS till_moves (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  till_id      BIGINT UNSIGNED NOT NULL,
  kind         ENUM('paid_in','payout','drop') NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  reason       VARCHAR(200) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_moves_till (tenant_id, till_id),
  CONSTRAINT fk_moves_till FOREIGN KEY (till_id) REFERENCES till_sessions(id)
) ENGINE=InnoDB;

-- Family: 'guardian' means adult_id is a parent or guardian of member_id. 'family' is a household link in either direction.
CREATE TABLE IF NOT EXISTS person_links (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  adult_id   BIGINT UNSIGNED NOT NULL,
  member_id  BIGINT UNSIGNED NOT NULL,
  relation   ENUM('guardian','family') NOT NULL DEFAULT 'guardian',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, adult_id, member_id),
  KEY ix_links_member (tenant_id, member_id),
  CONSTRAINT fk_links_adult FOREIGN KEY (tenant_id, adult_id) REFERENCES people(tenant_id, id),
  CONSTRAINT fk_links_member FOREIGN KEY (tenant_id, member_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

-- One-time recovery codes for two-step sign-in (stored as hashes).
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  code_hash  CHAR(64) NOT NULL,
  used_at    TIMESTAMP NULL,
  KEY ix_recovery_user (user_id),
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- ski school: levels, skills, packages, online requests
-- The level ladder per discipline (Level 1 = first timer ...), and the skills a student must show to pass each level.
CREATE TABLE IF NOT EXISTS school_levels (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  discipline  ENUM('ski','snowboard','telemark','adaptive') NOT NULL,
  rank_no     TINYINT UNSIGNED NOT NULL,
  name        VARCHAR(80) NOT NULL,
  description VARCHAR(300) NULL,
  UNIQUE KEY uq_school_level (tenant_id, discipline, rank_no),
  UNIQUE KEY uq_school_levels_tenant_id (tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS school_skills (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  level_id  BIGINT UNSIGNED NOT NULL,
  name      VARCHAR(160) NOT NULL,
  sort_no   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY uq_school_skills_tenant_id (tenant_id, id),
  KEY ix_skills_level (tenant_id, level_id),
  CONSTRAINT fk_skills_level FOREIGN KEY (tenant_id, level_id) REFERENCES school_levels(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS student_skills (
  tenant_id BIGINT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED NOT NULL,
  skill_id  BIGINT UNSIGNED NOT NULL,
  passed_on DATE NOT NULL,
  user_id   BIGINT UNSIGNED NULL,
  PRIMARY KEY (tenant_id, person_id, skill_id),
  CONSTRAINT fk_ss_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id),
  CONSTRAINT fk_ss_skill FOREIGN KEY (tenant_id, skill_id) REFERENCES school_skills(tenant_id, id)
) ENGINE=InnoDB;

-- A package ("5 lessons") sold from the basket: one row per package, spent one lesson at a time.
CREATE TABLE IF NOT EXISTS lesson_credits (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  person_id     BIGINT UNSIGNED NOT NULL,
  product_id    BIGINT UNSIGNED NOT NULL,
  order_item_id BIGINT UNSIGNED NULL,
  total         SMALLINT UNSIGNED NOT NULL,
  used          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  expires_on    DATE NULL,
  status        ENUM('active','void') NOT NULL DEFAULT 'active',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_credits_tenant_id (tenant_id, id),
  KEY ix_credits_person (tenant_id, person_id),
  CONSTRAINT fk_credits_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id),
  CONSTRAINT fk_credits_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
) ENGINE=InnoDB;

-- Online lesson requests from the public booking page. They hold no spot until staff confirm them.
CREATE TABLE IF NOT EXISTS lesson_requests (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  session_id    BIGINT UNSIGNED NOT NULL,
  reference     CHAR(8) NOT NULL,
  contact_name  VARCHAR(150) NOT NULL,
  contact_email VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(40) NOT NULL,
  students      TEXT NOT NULL,
  waiver_accepted TINYINT(1) NOT NULL DEFAULT 0,
  waiver_text_sha CHAR(64) NULL,
  note          VARCHAR(500) NULL,
  status        ENUM('pending','confirmed','declined','cancelled') NOT NULL DEFAULT 'pending',
  staff_note    VARCHAR(300) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at    TIMESTAMP NULL,
  UNIQUE KEY uq_requests_ref (tenant_id, reference),
  KEY ix_requests_status (tenant_id, status, created_at),
  KEY ix_requests_session (tenant_id, session_id, status),
  CONSTRAINT fk_requests_session FOREIGN KEY (tenant_id, session_id) REFERENCES lesson_sessions(tenant_id, id)
) ENGINE=InnoDB;
