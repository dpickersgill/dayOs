'use strict';
// 2026.11.10, READY ("ready for the busiest morning"). Loaded by db/migrate.js.
//   rate_limits   the rate limits' counts, shared by every server (src/lib/ratestore.js). k is a SHA-256 of the limit's
//                 name and the visitor's address (no address is stored), hits the count in the current window, reset_ms
//                 when that window ends (milliseconds since 1970). The daily job removes rows a day past their window.
//   status_notes  the public status page's incidents and planned maintenance (/status on the website), written by the
//                 platform operator in the console. parts lists the parts of the service it is about (app, guest,
//                 payments, email, texts); impact is what people notice while it lasts. No customer data goes here.
module.exports = ({ tableExists }) => [
  ['rate_limits', (c) => tableExists(c, 'rate_limits'), `CREATE TABLE rate_limits (
    k        BINARY(32) NOT NULL PRIMARY KEY,
    hits     INT UNSIGNED NOT NULL DEFAULT 0,
    reset_ms BIGINT UNSIGNED NOT NULL,
    KEY ix_rate_limits_reset (reset_ms)
  ) ENGINE=InnoDB`],
  ['status_notes', (c) => tableExists(c, 'status_notes'), `CREATE TABLE status_notes (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    kind       ENUM('incident','maintenance') NOT NULL,
    title      VARCHAR(150) NOT NULL,
    body       TEXT NULL,
    parts      VARCHAR(100) NOT NULL DEFAULT '',
    impact     ENUM('none','slow','down') NOT NULL DEFAULT 'slow',
    starts_at  DATETIME NOT NULL,
    ends_at    DATETIME NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_status_notes_starts (starts_at)
  ) ENGINE=InnoDB`],
];
