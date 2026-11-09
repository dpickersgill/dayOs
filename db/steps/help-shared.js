'use strict';
// The shared Text HELP number (help/shared, after 2026.11.16). Loaded by db/migrate.js, last. Additive and safe to run
// twice, on MySQL 8.4 and MariaDB, and on a 2026.11.12 or later database (help-sms adds patrol_help_lines first).
//
//   platform_settings              settings that belong to Verdynt/OS itself, not to a mountain: the shared help number
//                                  (E.164) every mountain uses for Text HELP by default (SHARED_HELP_NUMBER is the fallback).
//   tenants.help_tag               the mountain's tag, 1 to 3 letters, unique: a text to the shared number that says
//                                  "HELP BR R7" reaches the mountain tagged BR. Given from the name when first needed.
//   patrol_help_lines.help_mode    'shared' (the shared number) or 'own' (the mountain's own help_number). NULL on rows
//                                  from before: own when the row has a help number, else shared. No row: shared.
//   help_pending                   a text to the shared number that did not say which ski area yet: the phone, its texts in
//                                  order, a locate link token, and where it went (resolved_tenant, the call) once matched.
//                                  Patrol and dispatch data: never AI. Deleted 30 days after it came in (the texts are on
//                                  the call by then); one that was never matched holds no mountain.
//   help_shared_optouts            phones that texted STOP to the shared number (START removes the row). Never texted from it.
//   help_shared_log                one row per text in or out on the shared number before a mountain is known, with no
//                                  words: Twilio's message id (a repeat is taken once) and the phone, for the caps. 7 days.
module.exports = ({ tableExists, columnExists }) => [
  ['platform_settings', (c) => tableExists(c, 'platform_settings'), `CREATE TABLE platform_settings (
    name        VARCHAR(64) NOT NULL PRIMARY KEY,
    value       VARCHAR(500) NULL,
    updated_by  VARCHAR(100) NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['tenants.help_tag', (c) => columnExists(c, 'tenants', 'help_tag'),
    'ALTER TABLE tenants ADD COLUMN help_tag VARCHAR(3) NULL, ADD UNIQUE KEY uq_tenants_help_tag (help_tag)'],
  ['patrol_help_lines.help_mode', (c) => columnExists(c, 'patrol_help_lines', 'help_mode'),
    "ALTER TABLE patrol_help_lines ADD COLUMN help_mode ENUM('shared','own') NULL"],
  ['help_pending', (c) => tableExists(c, 'help_pending'), `CREATE TABLE help_pending (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    phone            VARCHAR(16) NOT NULL,
    phone_key        VARCHAR(15) NOT NULL,
    first_text       VARCHAR(1600) NOT NULL,
    texts            MEDIUMTEXT NOT NULL,
    lang             CHAR(2) NOT NULL DEFAULT 'en',
    lost_child       TINYINT(1) NOT NULL DEFAULT 0,
    locate_token     CHAR(32) NOT NULL,
    choices          VARCHAR(200) NULL,
    created_at       DATETIME NOT NULL,
    last_in_at       DATETIME NOT NULL,
    nudged_at        DATETIME NULL,
    expired_at       DATETIME NULL,
    resolved_tenant  BIGINT UNSIGNED NULL,
    resolved_call_id BIGINT UNSIGNED NULL,
    resolved_by      ENUM('tag','position','name','console') NULL,
    resolved_at      DATETIME NULL,
    UNIQUE KEY uq_hpending_token (locate_token),
    KEY ix_hpending_phone (phone_key, resolved_at, expired_at),
    KEY ix_hpending_open (resolved_at, expired_at, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['help_shared_optouts', (c) => tableExists(c, 'help_shared_optouts'), `CREATE TABLE help_shared_optouts (
    phone_key     VARCHAR(15) NOT NULL PRIMARY KEY,
    opted_out_at  DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['help_shared_log', (c) => tableExists(c, 'help_shared_log'), `CREATE TABLE help_shared_log (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    phone_key    VARCHAR(15) NULL,
    direction    ENUM('in','out') NOT NULL,
    message_sid  VARCHAR(40) NULL,
    at           DATETIME NOT NULL,
    UNIQUE KEY uq_hshared_sid (message_sid),
    KEY ix_hshared_out (direction, at),
    KEY ix_hshared_phone (phone_key, direction, at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];
