'use strict';
// The morning brief (ai/brief). Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB, and
// on a 2026.11.12 or 2026.11.13 database.
//   brief_prefs     one row per login that changed the default: on or off, and email, phone alert or both
//   morning_briefs  one brief per mountain, day and kind (operations, patrol, school): the facts it was made from and
//                   the text. Kept 30 days.
//   brief_sends     who was sent which day's brief, claimed before sending so nobody gets the same day twice. Kept 30 days.
//   lifts.wind_hold_mph  the gust speed at which the lift goes on wind hold (blank: not set)
module.exports = ({ tableExists, columnExists }) => [
  ['brief_prefs', (c) => tableExists(c, 'brief_prefs'), `CREATE TABLE brief_prefs (
    tenant_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    on_off TINYINT(1) NOT NULL DEFAULT 1,
    channel ENUM('both','email','push') NOT NULL DEFAULT 'both',
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['morning_briefs', (c) => tableExists(c, 'morning_briefs'), `CREATE TABLE morning_briefs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    sent_on DATE NOT NULL,
    for_date DATE NOT NULL,
    kind ENUM('ops','patrol','school') NOT NULL,
    data MEDIUMTEXT NOT NULL,
    body MEDIUMTEXT NOT NULL,
    source ENUM('ai','template') NOT NULL,
    fallback_reason VARCHAR(40) NULL,
    model VARCHAR(60) NULL,
    cost_micros INT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_brief_day (tenant_id, sent_on, kind),
    KEY ix_brief_made (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['brief_sends', (c) => tableExists(c, 'brief_sends'), `CREATE TABLE brief_sends (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    sent_on DATE NOT NULL,
    brief_id BIGINT UNSIGNED NULL,
    status ENUM('claimed','sent','failed') NOT NULL DEFAULT 'claimed',
    channel ENUM('both','email','push') NOT NULL DEFAULT 'both',
    email_ok TINYINT(1) NULL,
    phones SMALLINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME NULL,
    UNIQUE KEY uq_brief_send (tenant_id, user_id, sent_on),
    KEY ix_brief_send_made (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['lifts.wind_hold_mph', (c) => columnExists(c, 'lifts', 'wind_hold_mph'), 'ALTER TABLE lifts ADD COLUMN wind_hold_mph SMALLINT UNSIGNED NULL'],
];
