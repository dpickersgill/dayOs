'use strict';
// Guests round 2, Track LOYALTY: birthdays, loyalty rules, milestones, the first-timer ladder and recaps. The shared
// tables (guest_settings, guest_rewards) are in guests.js; these are the loyalty track's own.
module.exports = ({ tableExists }) => [
  // ---- settings guest_settings does not hold: the evening time for day recaps, what the loyalty rules give, and which
  // season's recap was sent. One row per mountain; defaults in src/lib/loyalty.js.
  ['guest_loyalty_settings', (c) => tableExists(c, 'guest_loyalty_settings'), `CREATE TABLE guest_loyalty_settings (
    tenant_id              BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    recap_time             CHAR(5) NOT NULL DEFAULT '18:00',
    loyalty_product_id     BIGINT UNSIGNED NULL,
    milestone_credit_cents INT UNSIGNED NULL,
    milestone_percent      TINYINT UNSIGNED NULL,
    firsttimer_percent     TINYINT UNSIGNED NOT NULL DEFAULT 50,
    firsttimer_product_id  BIGINT UNSIGNED NULL,
    top_credit_cents       INT UNSIGNED NULL,
    season_recap_sent      VARCHAR(7) NULL,
    updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_guest_loyalty_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // ---- one row per person per recap (a day, or a season). A family's recaps go in one email: they share group_id (the
  // id of the first row). The private page link is the token (stored hashed); share_sha is the link without private details.
  ['guest_recaps', (c) => tableExists(c, 'guest_recaps'), `CREATE TABLE guest_recaps (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    kind        ENUM('day','season') NOT NULL,
    period      VARCHAR(10) NOT NULL,
    person_id   BIGINT UNSIGNED NOT NULL,
    group_id    BIGINT UNSIGNED NULL,
    to_person_id BIGINT UNSIGNED NULL,
    stats       JSON NULL,
    token_sha   CHAR(64) NULL,
    share_sha   CHAR(64) NULL,
    emailed     TINYINT(1) NOT NULL DEFAULT 0,
    texted      TINYINT(1) NOT NULL DEFAULT 0,
    viewed_at   DATETIME NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_guest_recaps_once (tenant_id, kind, period, person_id),
    UNIQUE KEY uq_guest_recaps_token (token_sha),
    UNIQUE KEY uq_guest_recaps_share (share_sha),
    KEY ix_guest_recaps_group (tenant_id, group_id),
    CONSTRAINT fk_guest_recaps_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
  ) ENGINE=InnoDB`],
  // ---- the email that told a guest (or their parent) about a reward from loyalty: once per reward.
  ['guest_reward_mails', (c) => tableExists(c, 'guest_reward_mails'), `CREATE TABLE guest_reward_mails (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    reward_id   BIGINT UNSIGNED NOT NULL,
    to_person_id BIGINT UNSIGNED NULL,
    emailed     TINYINT(1) NOT NULL DEFAULT 0,
    sent_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, reward_id)
  ) ENGINE=InnoDB`],
  // ---- a guest who asked for no more recap emails (from the link in any recap).
  ['guest_recap_stops', (c) => tableExists(c, 'guest_recap_stops'), `CREATE TABLE guest_recap_stops (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    person_id   BIGINT UNSIGNED NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, person_id)
  ) ENGINE=InnoDB`],
];
