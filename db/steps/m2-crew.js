'use strict';
// Release 2026.11.20, workstream "crew": the crew board, on-call, overtime and public works certifications. Loaded by
// db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   oncall_rotations           an on-call rotation (one per department or crew): who takes turns, in order, how long a
//                              turn lasts (a week by default), when it changes hands, the working day (after it is "after
//                              hours"), and the request categories that alert the person on call after hours
//   oncall_overrides           a swap, a holiday or cover: another person takes the rotation for those days
//   oncall_holidays            the municipality's holidays: after hours all day, for the after-hours alerts
//   oncall_alerts              each after-hours phone alert sent to the person on call about a new request (no resident
//                              details: the request, the rotation and the person alerted)
//   time_entries.callout       a punch for a call-out (called in after hours), for the Overtime view and payroll export
//   certifications.code        marks the built-in public works certification types (CDL, water operator ...) so the app
//                              can find them (the boil water operators list, the crew board), whatever the name says
//   the municipal certification types, for every municipality that does not have them yet

const MUNI_CERTS = require('../../src/lib/crewcerts').MUNI_CERTS;
const num = async (c, sql, params = []) => Number((await c.query(sql, params))[0][0].n);
const indexExists = async (c, table, name) => {
  const [r] = await c.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return r.length > 0;
};
const esc = (s) => String(s).replace(/'/g, "''");

module.exports = ({ tableExists, columnExists }) => [
  ['oncall_rotations', (c) => tableExists(c, 'oncall_rotations'), `CREATE TABLE oncall_rotations (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    name           VARCHAR(80) NOT NULL,
    department     VARCHAR(60) NULL,
    members        VARCHAR(1000) NOT NULL DEFAULT '',
    starts_on      DATE NOT NULL,
    period_days    TINYINT UNSIGNED NOT NULL DEFAULT 7,
    handover       TIME NOT NULL DEFAULT '07:00:00',
    workday_start  TIME NOT NULL DEFAULT '07:00:00',
    workday_end    TIME NOT NULL DEFAULT '15:30:00',
    category_ids   VARCHAR(500) NULL,
    active         TINYINT(1) NOT NULL DEFAULT 1,
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_oncall_rot_tenant_id (tenant_id, id),
    UNIQUE KEY uq_oncall_rot_name (tenant_id, name),
    CONSTRAINT fk_oncall_rot_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['oncall_overrides', (c) => tableExists(c, 'oncall_overrides'), `CREATE TABLE oncall_overrides (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    rotation_id  BIGINT UNSIGNED NOT NULL,
    starts_on    DATE NOT NULL,
    ends_on      DATE NOT NULL,
    staff_id     BIGINT UNSIGNED NOT NULL,
    reason       ENUM('swap','holiday','cover') NOT NULL DEFAULT 'swap',
    note         VARCHAR(200) NULL,
    created_by   BIGINT UNSIGNED NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_oncall_ovr_tenant_id (tenant_id, id),
    KEY ix_oncall_ovr_days (tenant_id, rotation_id, starts_on, ends_on),
    CONSTRAINT fk_oncall_ovr_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_oncall_ovr_rotation FOREIGN KEY (tenant_id, rotation_id) REFERENCES oncall_rotations(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_oncall_ovr_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['oncall_holidays', (c) => tableExists(c, 'oncall_holidays'), `CREATE TABLE oncall_holidays (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    day        DATE NOT NULL,
    name       VARCHAR(80) NOT NULL,
    UNIQUE KEY uq_oncall_hol_tenant_id (tenant_id, id),
    UNIQUE KEY uq_oncall_hol_day (tenant_id, day),
    CONSTRAINT fk_oncall_hol_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['oncall_alerts', (c) => tableExists(c, 'oncall_alerts'), `CREATE TABLE oncall_alerts (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    rotation_id  BIGINT UNSIGNED NOT NULL,
    request_id   BIGINT UNSIGNED NOT NULL,
    staff_id     BIGINT UNSIGNED NOT NULL,
    phones       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    sent_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_oncall_alert_tenant_id (tenant_id, id),
    UNIQUE KEY uq_oncall_alert_once (tenant_id, rotation_id, request_id),
    CONSTRAINT fk_oncall_alert_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_oncall_alert_rotation FOREIGN KEY (tenant_id, rotation_id) REFERENCES oncall_rotations(tenant_id, id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['time_entries.callout', (c) => columnExists(c, 'time_entries', 'callout'), 'ALTER TABLE time_entries ADD COLUMN callout TINYINT(1) NOT NULL DEFAULT 0'],
  ['certifications.code', (c) => columnExists(c, 'certifications', 'code'), 'ALTER TABLE certifications ADD COLUMN code VARCHAR(30) NULL'],
  ['certifications code index', (c) => indexExists(c, 'certifications', 'ix_cert_code'), 'CREATE INDEX ix_cert_code ON certifications (tenant_id, code)'],
  // The built-in public works certification types for every municipality made before this release (a new one gets them
  // when the platform console makes it). A type the municipality already has by the same name keeps its id and gets the code.
  ['certifications municipal types', async (c) => !(await columnExists(c, 'certifications', 'code')) || (await num(c, `SELECT COUNT(*) AS n FROM tenants t
      WHERE t.org_type = 'municipality' AND (SELECT COUNT(*) FROM certifications x WHERE x.tenant_id = t.id AND x.code IS NOT NULL) < ?`, [MUNI_CERTS.length])) === 0,
  MUNI_CERTS.map(([code, name]) => `INSERT INTO certifications (tenant_id, name, code) SELECT id, '${esc(name)}', '${esc(code)}' FROM tenants WHERE org_type = 'municipality'
      ON DUPLICATE KEY UPDATE code = COALESCE(code, VALUES(code))`)],
];
