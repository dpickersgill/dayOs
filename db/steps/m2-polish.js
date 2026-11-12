'use strict';
// Release 2026.11.20, workstream "polish" (the public works director's walkthrough). Loaded by db/migrate.js. Additive
// and safe to run twice, on MySQL 8.4 and MariaDB.
//   request_numbers        the last request number given out in each municipality: new requests are R-1001, R-1002, ...
//                          in the order they come in (older random references stay as they were)
//   map_features.turns_expected  a valve's turns to close fully, from the record (the valve exercise compares with it)

module.exports = ({ tableExists, columnExists }) => [
  ['request_numbers', (c) => tableExists(c, 'request_numbers'), `CREATE TABLE request_numbers (
    tenant_id   BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    last_n      INT UNSIGNED NOT NULL,
    CONSTRAINT fk_request_numbers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['map_features.turns_expected', (c) => columnExists(c, 'map_features', 'turns_expected'), 'ALTER TABLE map_features ADD COLUMN turns_expected SMALLINT UNSIGNED NULL'],
];
