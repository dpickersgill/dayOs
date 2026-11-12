'use strict';
// Release 2026.11.21, workstream "pins": a person's own pins at the top of their menu. Loaded by db/migrate.js.
// Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   user_nav   one row for a person who has arranged their own menu: their pins in order ([{ id, label, href, app,
//              icon? }], at most 12) and, when they chose it, the page addresses on their phone's bottom bar (bar, at
//              most 4; NULL is the standard bar). No row means the role's menu (tenants.role_menus). The row goes when
//              the login is deleted.

module.exports = ({ tableExists }) => [
  ['user_nav', (c) => tableExists(c, 'user_nav'), `CREATE TABLE user_nav (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    user_id     BIGINT UNSIGNED NOT NULL,
    pins        JSON NOT NULL,
    bar         JSON NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, user_id),
    KEY ix_user_nav_user (user_id),
    CONSTRAINT fk_user_nav_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_user_nav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
];
