'use strict';
// Forecast data collection (ai/data, 2026.11). Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and
// MariaDB, and on a 2026.11.13 database.
//   daily_snapshots            what the morning looked like, one row per mountain, kind and day: presales for the next
//                              14 days, the hourly weather forecast, staffing and the online prices offered (lib/snapshots.js).
//                              Counts, prices and weather only, never a person. Kept 3 years.
//   tenants.wx_summit_lat/lng  an optional second weather point at the top of the mountain (the map point is the base)
module.exports = ({ tableExists, columnExists }) => [
  ['daily_snapshots', (c) => tableExists(c, 'daily_snapshots'), `CREATE TABLE daily_snapshots (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    on_date     DATE NOT NULL,
    kind        VARCHAR(20) NOT NULL,
    taken_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    backfilled  TINYINT(1) NOT NULL DEFAULT 0,
    data        MEDIUMTEXT NOT NULL,
    UNIQUE KEY uq_snapshots_day (tenant_id, kind, on_date),
    KEY ix_snapshots_date (on_date),
    CONSTRAINT fk_snapshots_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
  ['tenants.wx_summit_lat', (c) => columnExists(c, 'tenants', 'wx_summit_lat'), 'ALTER TABLE tenants ADD COLUMN wx_summit_lat DECIMAL(9,6) NULL, ADD COLUMN wx_summit_lng DECIMAL(9,6) NULL'],
];
