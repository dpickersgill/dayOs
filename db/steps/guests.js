'use strict';
// Guests, round 2 (2026.11.8): the welcome back, the household account, rewards and birthdays, fair pricing promises and
// payment plans. The shared tables. Track-only tables live in db/steps/guests-<track>.js.
// Each entry: [name, (conn) => done?, ddl].
module.exports = ({ tableExists, columnExists }) => [
  // ---- one row per mountain; defaults in src/lib/guestsettings.js. Dan's decisions (Oct 30, 2026): birthday gifts on by
  // default (each mountain can turn them off); the fair pricing promises off by default; recaps on for everyone.
  ['guest_settings', (c) => tableExists(c, 'guest_settings'), `CREATE TABLE guest_settings (
    tenant_id              BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    season_opens_on        DATE NULL,
    birthday_on            TINYINT(1) NOT NULL DEFAULT 1,
    birthday_ticket_product_id BIGINT UNSIGNED NULL,
    birthday_percent       TINYINT UNSIGNED NULL,
    birthday_credit_cents  INT UNSIGNED NULL,
    birthday_window        ENUM('week','month') NOT NULL DEFAULT 'week',
    recap_day_on           TINYINT(1) NOT NULL DEFAULT 1,
    recap_season_on        TINYINT(1) NOT NULL DEFAULT 1,
    milestones_on          TINYINT(1) NOT NULL DEFAULT 0,
    firsttimer_on          TINYINT(1) NOT NULL DEFAULT 0,
    loyalty_every_n        TINYINT UNSIGNED NULL,
    loyalty_top_n          SMALLINT UNSIGNED NULL,
    walkup_cap_on          TINYINT(1) NOT NULL DEFAULT 0,
    walkup_cap_cents       INT UNSIGNED NULL,
    price_promise_on       TINYINT(1) NOT NULL DEFAULT 0,
    closure_credit_on      TINYINT(1) NOT NULL DEFAULT 0,
    conditions_guarantee_on TINYINT(1) NOT NULL DEFAULT 0,
    conditions_hours       TINYINT UNSIGNED NOT NULL DEFAULT 2,
    plans_on               TINYINT(1) NOT NULL DEFAULT 0,
    plans_count            TINYINT UNSIGNED NOT NULL DEFAULT 3,
    autorenew_on           TINYINT(1) NOT NULL DEFAULT 0,
    counter_refund_limit_cents INT UNSIGNED NOT NULL DEFAULT 0,
    updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_guest_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // ---- what a guest is holding: a birthday gift, a milestone, a loyalty day, a closure or conditions credit, a goodwill
  // credit. One row per offer; the guest (or staff) picks one choice; used once, online or at the window (src/lib/rewards.js).
  ['guest_rewards', (c) => tableExists(c, 'guest_rewards'), `CREATE TABLE guest_rewards (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    person_id      BIGINT UNSIGNED NOT NULL,
    kind           ENUM('birthday','milestone','loyalty','firsttimer','closure','conditions','goodwill') NOT NULL,
    reason         VARCHAR(200) NULL,
    options        JSON NOT NULL,
    chosen         ENUM('free_ticket','percent','credit') NULL,
    product_id     BIGINT UNSIGNED NULL,
    percent        TINYINT UNSIGNED NULL,
    credit_cents   INT UNSIGNED NULL,
    code           CHAR(10) NOT NULL,
    valid_from     DATE NOT NULL,
    valid_to       DATE NOT NULL,
    status         ENUM('offered','redeemed','expired','void') NOT NULL DEFAULT 'offered',
    order_id       BIGINT UNSIGNED NULL,
    redeemed_at    DATETIME NULL,
    redeemed_by    BIGINT UNSIGNED NULL,
    source_key     VARCHAR(80) NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_guest_rewards_code (tenant_id, code),
    UNIQUE KEY uq_guest_rewards_source (tenant_id, person_id, source_key),
    KEY ix_guest_rewards_person (tenant_id, person_id, status, valid_to),
    CONSTRAINT fk_guest_rewards_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['order_items.reward_id', (c) => columnExists(c, 'order_items', 'reward_id'), 'ALTER TABLE order_items ADD COLUMN reward_id BIGINT UNSIGNED NULL'],
];
