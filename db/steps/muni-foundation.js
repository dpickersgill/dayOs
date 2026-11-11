'use strict';
// The municipal edition's foundation (muni release 1): a tenant is a ski area (mountain) or a municipality, billing plans
// belong to one or the other, and a municipality keeps its list of streets. Loaded by db/migrate.js.
// Additive and safe to run twice, on MySQL 8.4 and MariaDB. Every existing tenant and plan stays 'mountain'.
//   tenants.org_type        mountain or municipality, chosen when the tenant is created and never changed
//   billing_plans.org_type  which kind of tenant a plan or add-on is sold to (the ski pricing page lists only mountain rows)
//   streets                 a municipality's street list: requests, bulk pickup and street notices pick from it
//   municipal plans         Public Works, and the Water, Sewer, Stormwater, Trash and recycling and Buildings add-ons

// Municipal prices: yearly is twelve times monthly (no yearly discount for a public body's budget year).
const PLANS = [
  ['muni-core', 'Public Works', 'Resident requests, work orders and service plans, the asset register, staff and schedule, documents and messages for a borough, township or authority.', 'plan', 'assets,workforce,documents,messages,requests', 40000, 1],
  ['muni-water', 'Water', 'Water mains, valves, hydrants and meters on the asset register, with their inspections and programs.', 'addon', 'water', 20000, 1],
  ['muni-sewer', 'Sewer', 'Sewer mains, manholes and pump stations on the asset register, with their inspections and programs.', 'addon', 'sewer', 20000, 2],
  ['muni-stormwater', 'Stormwater', 'Inlets, outfalls and basins on the asset register, with their inspections and programs.', 'addon', 'stormwater', 10000, 3],
  ['muni-solidwaste', 'Trash and recycling', 'Residents book and pay for bulk trash pickup online, and the crew sees each day\'s route.', 'addon', 'solidwaste', 15000, 4],
  ['muni-buildings', 'Buildings', 'The building inspection calendar and each permit\'s binder.', 'addon', 'buildings', 10000, 5],
];

const hasPlan = async (c, code) => {
  const [r] = await c.query('SELECT COUNT(*) AS n FROM billing_plans WHERE code = ?', [code]);
  return Number(r[0].n) > 0;
};
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

module.exports = ({ tableExists, columnExists }) => [
  ['tenants.org_type', (c) => columnExists(c, 'tenants', 'org_type'),
    "ALTER TABLE tenants ADD COLUMN org_type ENUM('mountain','municipality') NOT NULL DEFAULT 'mountain'"],
  ['billing_plans.org_type', (c) => columnExists(c, 'billing_plans', 'org_type'),
    "ALTER TABLE billing_plans ADD COLUMN org_type ENUM('mountain','municipality') NOT NULL DEFAULT 'mountain'"],
  ['streets', (c) => tableExists(c, 'streets'), `CREATE TABLE streets (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    name        VARCHAR(120) NOT NULL,
    aliases     VARCHAR(255) NULL,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_streets_tenant_id (tenant_id, id),
    UNIQUE KEY uq_streets_name (tenant_id, name),
    KEY ix_streets_active (tenant_id, active, name),
    CONSTRAINT fk_streets_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ...PLANS.map(([code, name, blurb, kind, modules, monthly, sort]) => [`billing_plans ${code}`, (c) => hasPlan(c, code),
    `INSERT INTO billing_plans (code, name, blurb, kind, modules, monthly_cents, yearly_cents, sort, org_type)
     SELECT ${q(code)}, ${q(name)}, ${q(blurb)}, ${q(kind)}, ${q(modules)}, ${monthly}, ${monthly * 12}, ${sort}, 'municipality' FROM DUAL
     WHERE NOT EXISTS (SELECT 1 FROM billing_plans WHERE code = ${q(code)})`]),
];

module.exports.PLANS = PLANS;
