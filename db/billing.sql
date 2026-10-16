-- SummitOps subscriptions: what each mountain pays SummitOps (not the mountain's own sales).
-- Plans and add-ons are set by the operator in the console, with monthly and yearly prices; Stripe holds the matching
-- products and prices (made by "Sync to Stripe") and collects by card, US bank account (ACH) or emailed invoice.

CREATE TABLE IF NOT EXISTS billing_plans (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code             VARCHAR(40) NOT NULL UNIQUE,
  name             VARCHAR(100) NOT NULL,
  blurb            VARCHAR(500) NULL,
  kind             ENUM('plan','addon') NOT NULL DEFAULT 'plan',
  modules          VARCHAR(500) NOT NULL DEFAULT '',     -- app keys a plan includes; for an add-on, the add-on's app key
  monthly_cents    INT UNSIGNED NOT NULL DEFAULT 0,
  yearly_cents     INT UNSIGNED NOT NULL DEFAULT 0,
  active           TINYINT(1) NOT NULL DEFAULT 1,
  sort             SMALLINT NOT NULL DEFAULT 0,
  stripe_product   VARCHAR(60) NULL,
  stripe_month     VARCHAR(60) NULL,                     -- price ids, and the amounts they were made for
  stripe_month_cents INT UNSIGNED NULL,
  stripe_year      VARCHAR(60) NULL,
  stripe_year_cents  INT UNSIGNED NULL,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- One row per paying mountain. A mountain with no row (made before billing, or a demo) is free ("comped").
CREATE TABLE IF NOT EXISTS tenant_billing (
  tenant_id              BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  plan_id                BIGINT UNSIGNED NULL,
  addons                 VARCHAR(300) NOT NULL DEFAULT '',  -- add-on plan ids, comma separated
  billing_interval       ENUM('month','year') NOT NULL DEFAULT 'month',
  comped                 TINYINT(1) NOT NULL DEFAULT 0,
  trial_ends_on          DATE NULL,
  paid_until             DATE NULL,                         -- set by the operator for a payment taken outside Stripe
  billing_email          VARCHAR(255) NULL,
  pay_method             ENUM('card','bank','invoice') NULL,
  stripe_customer_id     VARCHAR(60) NULL,
  stripe_subscription_id VARCHAR(60) NULL,
  sub_status             VARCHAR(30) NULL,                  -- Stripe's subscription status
  period_end             DATETIME NULL,
  cancel_at_period_end   TINYINT(1) NOT NULL DEFAULT 0,
  past_due_since         DATETIME NULL,
  reminded               VARCHAR(40) NULL,                  -- the last reminder email sent, so each goes once
  notes                  VARCHAR(500) NULL,
  updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tbill_sub (stripe_subscription_id),
  KEY ix_tbill_customer (stripe_customer_id),
  CONSTRAINT fk_tbill_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- What happened to a mountain's subscription, newest last; Stripe events by id so a repeat is ignored.
CREATE TABLE IF NOT EXISTS billing_events (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind            VARCHAR(40) NOT NULL,
  detail          VARCHAR(1000) NULL,
  by_user         BIGINT UNSIGNED NULL,
  by_operator     VARCHAR(100) NULL,
  stripe_event_id VARCHAR(80) NULL,
  UNIQUE KEY uq_bevent_stripe (stripe_event_id),
  KEY ix_bevent_tenant (tenant_id, at)
) ENGINE=InnoDB;
