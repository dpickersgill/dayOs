'use strict';
// The Mountain calendar (2026.11.10, Track CALENDAR). Events people add (src/lib/mountaincal.js gathers the rest from
// what the app already knows), and each person's private calendar feed link. Additive and safe to run twice.
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
module.exports = ({ tableExists }) => [
  // One event on the calendar. A date or a date range; all day, or the same start and end time on each day.
  // teams: a comma list of team keys (front_desk, rentals, ski_school, patrol, lifts, office); NULL is everyone.
  ['mountain_events', (c) => tableExists(c, 'mountain_events'), `CREATE TABLE mountain_events (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    title       VARCHAR(120) NOT NULL,
    kind        ENUM('event','meeting','training','closure','other') NOT NULL DEFAULT 'event',
    starts_on   DATE NOT NULL,
    ends_on     DATE NOT NULL,
    all_day     TINYINT(1) NOT NULL DEFAULT 1,
    start_time  TIME NULL,
    end_time    TIME NULL,
    place       VARCHAR(120) NULL,
    note        VARCHAR(1000) NULL,
    teams       VARCHAR(120) NULL,
    created_by  BIGINT UNSIGNED NULL,
    updated_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mountain_events_tenant_id (tenant_id, id),
    KEY ix_mountain_events_days (tenant_id, starts_on, ends_on),
    CONSTRAINT fk_mountain_events_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // A person's private calendar feed link (one per login). Only a hash of the link's secret is kept; a new link replaces
  // the old one, and turning it off deletes the row.
  ['calendar_feeds', (c) => tableExists(c, 'calendar_feeds'), `CREATE TABLE calendar_feeds (
    tenant_id    BIGINT UNSIGNED NOT NULL,
    user_id      BIGINT UNSIGNED NOT NULL,
    token_sha    CHAR(64) NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME NULL,
    PRIMARY KEY (tenant_id, user_id),
    UNIQUE KEY uq_calendar_feeds_token (token_sha),
    CONSTRAINT fk_calendar_feeds_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];
