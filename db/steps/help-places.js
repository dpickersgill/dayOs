'use strict';
// Guest help release (help/places): places patrol maps on the mountain. Loaded by db/migrate.js. Safe to run twice.
//   mountain_places          trail signs, lift towers, junctions and buildings, each with a short sign code ("R7") and
//                            where it is, so a phone's position can be put in the words patrollers use
//   tenants.map_rotation_deg a manual compass direction at the top of the mountain's maps (NULL: base at the bottom, worked out)
//   dispatch_calls.source    gains 'staff': "Guest needs help here", pressed by lift, rental or other staff on duty
module.exports = ({ tableExists, columnExists }) => [
  ['mountain_places', (c) => tableExists(c, 'mountain_places'), `CREATE TABLE IF NOT EXISTS mountain_places (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    kind        ENUM('sign','tower','junction','building','lift_top','lift_bottom','park_feature','parking','other') NOT NULL DEFAULT 'sign',
    name        VARCHAR(100) NOT NULL,
    code        VARCHAR(5) NOT NULL,
    lift_id     BIGINT UNSIGNED NULL,
    tower_no    SMALLINT UNSIGNED NULL,
    trail_id    BIGINT UNSIGNED NULL,
    lat         DECIMAL(9,6) NOT NULL,
    lng         DECIMAL(9,6) NOT NULL,
    accuracy_m  SMALLINT UNSIGNED NULL,
    marked_by   BIGINT UNSIGNED NULL,
    marked_at   DATETIME NOT NULL,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mplaces_code (tenant_id, code),
    UNIQUE KEY uq_mplaces_tenant_id (tenant_id, id),
    KEY ix_mplaces_near (tenant_id, active, lat, lng),
    KEY ix_mplaces_lift (tenant_id, lift_id, tower_no),
    CONSTRAINT fk_mplaces_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_mplaces_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id),
    CONSTRAINT fk_mplaces_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
  // Map orientation: a manual compass direction at the top of every map that plots GPS points (0 north up, 180 turned
  // around). NULL, the default, is automatic: the base at the bottom, worked out from the lifts or the weather points.
  ['tenants.map_rotation_deg', (c) => columnExists(c, 'tenants', 'map_rotation_deg'), 'ALTER TABLE tenants ADD COLUMN map_rotation_deg SMALLINT UNSIGNED NULL DEFAULT NULL'],
  // Every source the column already has stays (school from 2026.11.13); 'staff' is added at the end.
  ['dispatch_calls.source staff', async (c) => columnExists(c, 'dispatch_calls', 'source') && (await c.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dispatch_calls' AND column_name = 'source' AND column_type LIKE '%''staff''%'",
  ))[0].length > 0,
  "ALTER TABLE dispatch_calls MODIFY COLUMN source ENUM('patrol','radio','phone','guest','school','staff') NOT NULL DEFAULT 'radio'"],
];
