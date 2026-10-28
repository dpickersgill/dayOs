'use strict';
// Attractions: a mountain's other things to do beside skiing and riding (zipline, mountain coaster, ice rink, tubing,
// scenic lift rides, bike park and so on), with the same open, hold and closed status as a lift. Each entry:
// [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js. Types are listed in src/lib/attractions.js.
module.exports = ({ tableExists, columnExists }) => [
  ['attractions', (c) => tableExists(c, 'attractions'), `CREATE TABLE IF NOT EXISTS attractions (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    name             VARCHAR(100) NOT NULL,
    type             VARCHAR(40)  NOT NULL,
    status           ENUM('open','hold','closed') NOT NULL DEFAULT 'closed',
    status_note      VARCHAR(255) NULL,
    min_height_in    SMALLINT UNSIGNED NULL,
    min_weight_lb    SMALLINT UNSIGNED NULL,
    max_weight_lb    SMALLINT UNSIGNED NULL,
    min_age          TINYINT UNSIGNED NULL,
    waiver_required  TINYINT(1) NOT NULL DEFAULT 1,
    sort             SMALLINT NOT NULL DEFAULT 0,
    active           TINYINT(1) NOT NULL DEFAULT 1,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_attractions_name (tenant_id, name),
    UNIQUE KEY uq_attractions_tenant_id (tenant_id, id),
    KEY ix_attractions_active (tenant_id, active, sort),
    CONSTRAINT fk_attractions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // Where a patrol case happened, when it was at an attraction (location text stays as it is).
  ['incidents.attraction_id', (c) => columnExists(c, 'incidents', 'attraction_id'),
    'ALTER TABLE incidents ADD COLUMN attraction_id BIGINT UNSIGNED NULL, ADD KEY ix_incidents_attraction (tenant_id, attraction_id)'],
  // Staff positions for attractions: zip guides, coaster operators, rink attendants.
  ['positions.department attractions', async (c) => {
    const [[r]] = await c.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'positions' AND column_name = 'department'");
    return !r || /'attractions'/.test(r.t);
  }, "ALTER TABLE positions MODIFY department ENUM('lifts','rentals','ski_school','patrol','food','guest_services','grooming','maintenance','admin','attractions') NOT NULL"],
];
