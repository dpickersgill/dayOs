-- Versions: every version that has started on this database (recorded by the server when it starts), for the
-- console's deploy history. Applied by db/migrate.js; safe to re-run. Who last opened What's new is users.seen_version.

CREATE TABLE IF NOT EXISTS app_deploys (
  version          VARCHAR(20) NOT NULL,
  build            VARCHAR(20) NOT NULL,
  first_started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_started_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deployed_by      VARCHAR(255) NULL,
  PRIMARY KEY (version, build),
  KEY ix_app_deploys_started (first_started_at)
) ENGINE=InnoDB;
