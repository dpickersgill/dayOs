'use strict';
// Release 2026.11.20, workstream "money": what public works costs, by department and fund, and the monthly report.
// Loaded by db/migrate.js. Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//   funds, departments            a municipality's funds (General, Water, Sewer, Sanitation, Liquid Fuels, Capital) and
//                                 departments (Streets, Water, ...), each department with the fund it charges by default
//   ops_assets                    department_id, fund_id (the asset's own), hourly_rate_cents (what an hour of it costs a job)
//   work_orders                   department_id, fund_id, street_id (for the Liquid Fuels report), books_checked (the
//                                 department, fund and street were filled in once, from the asset, map item or request)
//   staff_labor_rates             each crew member's hourly labor cost; without one the shop labor rate is used
//   work_order_labor.personal     the line was costed at the person's own rate (its cost is a manager's to see)
//   work_order_equipment          equipment hours on a job, at the asset's hourly rate when logged
//   work_order_materials          one-off materials on a job (not from stock): what, how many, at what unit cost

const indexExists = async (conn, table, name) => {
  const [r] = await conn.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return r.length > 0;
};

module.exports = ({ tableExists, columnExists }) => {
  const col = (table, name, ddl) => [`${table}.${name}`, (c) => columnExists(c, table, name), `ALTER TABLE ${table} ADD COLUMN ${ddl}`];
  const ix = (table, name, ddl) => [`${table} index ${name}`, (c) => indexExists(c, table, name), `ALTER TABLE ${table} ADD ${ddl}`];
  return [
    ['funds', (c) => tableExists(c, 'funds'), `CREATE TABLE funds (
      id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id   BIGINT UNSIGNED NOT NULL,
      name        VARCHAR(60) NOT NULL,
      code        VARCHAR(20) NULL,
      kind        VARCHAR(20) NULL,
      active      TINYINT(1) NOT NULL DEFAULT 1,
      sort        SMALLINT UNSIGNED NOT NULL DEFAULT 100,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_funds_tenant_id (tenant_id, id),
      UNIQUE KEY uq_funds_name (tenant_id, name),
      CONSTRAINT fk_funds_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ) ENGINE=InnoDB`],
    ['departments', (c) => tableExists(c, 'departments'), `CREATE TABLE departments (
      id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id   BIGINT UNSIGNED NOT NULL,
      name        VARCHAR(60) NOT NULL,
      kind        VARCHAR(20) NULL,
      fund_id     BIGINT UNSIGNED NULL,
      active      TINYINT(1) NOT NULL DEFAULT 1,
      sort        SMALLINT UNSIGNED NOT NULL DEFAULT 100,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_departments_tenant_id (tenant_id, id),
      UNIQUE KEY uq_departments_name (tenant_id, name),
      CONSTRAINT fk_departments_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      CONSTRAINT fk_departments_fund FOREIGN KEY (tenant_id, fund_id) REFERENCES funds(tenant_id, id)
    ) ENGINE=InnoDB`],

    col('ops_assets', 'department_id', 'department_id BIGINT UNSIGNED NULL'),
    col('ops_assets', 'fund_id', 'fund_id BIGINT UNSIGNED NULL'),
    col('ops_assets', 'hourly_rate_cents', 'hourly_rate_cents INT UNSIGNED NULL'),

    col('work_orders', 'department_id', 'department_id BIGINT UNSIGNED NULL'),
    col('work_orders', 'fund_id', 'fund_id BIGINT UNSIGNED NULL'),
    col('work_orders', 'street_id', 'street_id BIGINT UNSIGNED NULL'),
    col('work_orders', 'books_checked', 'books_checked TINYINT(1) NOT NULL DEFAULT 0'),
    ix('work_orders', 'ix_wo_department', 'INDEX ix_wo_department (tenant_id, department_id, status)'),
    ix('work_orders', 'ix_wo_completed', 'INDEX ix_wo_completed (tenant_id, completed_at)'),
    ix('work_orders', 'ix_wo_books', 'INDEX ix_wo_books (tenant_id, books_checked)'),

    col('work_order_labor', 'personal', 'personal TINYINT(1) NOT NULL DEFAULT 0'),
    ix('work_order_labor', 'ix_wol_day', 'INDEX ix_wol_day (tenant_id, worked_on)'),

    ['staff_labor_rates', (c) => tableExists(c, 'staff_labor_rates'), `CREATE TABLE staff_labor_rates (
      id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id   BIGINT UNSIGNED NOT NULL,
      staff_id    BIGINT UNSIGNED NOT NULL,
      rate_cents  INT UNSIGNED NOT NULL,
      updated_by  BIGINT UNSIGNED NULL,
      updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_slr_tenant_id (tenant_id, id),
      UNIQUE KEY uq_slr_staff (tenant_id, staff_id),
      CONSTRAINT fk_slr_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      CONSTRAINT fk_slr_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
    ) ENGINE=InnoDB`],
    ['work_order_equipment', (c) => tableExists(c, 'work_order_equipment'), `CREATE TABLE work_order_equipment (
      id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id     BIGINT UNSIGNED NOT NULL,
      work_order_id BIGINT UNSIGNED NOT NULL,
      asset_id      BIGINT UNSIGNED NOT NULL,
      hours         DECIMAL(7,2) NOT NULL,
      rate_cents    INT UNSIGNED NOT NULL DEFAULT 0,
      used_on       DATE NOT NULL,
      note          VARCHAR(255) NULL,
      user_id       BIGINT UNSIGNED NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_woe_tenant_id (tenant_id, id),
      KEY ix_woe_wo (tenant_id, work_order_id),
      KEY ix_woe_day (tenant_id, used_on),
      KEY ix_woe_asset (tenant_id, asset_id, used_on),
      CONSTRAINT fk_woe_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      CONSTRAINT fk_woe_wo FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_woe_asset FOREIGN KEY (tenant_id, asset_id) REFERENCES ops_assets(tenant_id, id)
    ) ENGINE=InnoDB`],
    ['work_order_materials', (c) => tableExists(c, 'work_order_materials'), `CREATE TABLE work_order_materials (
      id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id       BIGINT UNSIGNED NOT NULL,
      work_order_id   BIGINT UNSIGNED NOT NULL,
      description     VARCHAR(150) NOT NULL,
      qty             DECIMAL(10,2) NOT NULL,
      unit            VARCHAR(20) NULL,
      unit_cost_cents INT UNSIGNED NOT NULL DEFAULT 0,
      used_on         DATE NOT NULL,
      user_id         BIGINT UNSIGNED NULL,
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_wom_tenant_id (tenant_id, id),
      KEY ix_wom_wo (tenant_id, work_order_id),
      KEY ix_wom_day (tenant_id, used_on),
      CONSTRAINT fk_wom_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      CONSTRAINT fk_wom_wo FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE
    ) ENGINE=InnoDB`],
  ];
};
