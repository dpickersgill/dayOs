'use strict';
// The rental shop, round 2 (2026.11.4): paid and ready to fit, a fitting card per person with the renter's signed
// confirmation, a fitting queue for shops with stations, the guest rental form, groups, scan-to-return, season rentals,
// card deposits and the shop manager's reports. Loaded by db/migrate.js. Each entry: [name, (conn) => done?, ddl].
const has = async (conn, sql, params) => (await conn.query(sql, params))[0].length > 0;
const enumHas = (table, column, value) => (c) => has(c, `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? AND column_type LIKE ?`, [table, column, `%'${value}'%`]);

module.exports = ({ tableExists, columnExists }) => [
  // ---- contracts: a paid rental waiting to be fitted is a contract with no gear yet, status to_fit
  ['rental_contracts.status to_fit', enumHas('rental_contracts', 'status', 'to_fit'),
    "ALTER TABLE rental_contracts MODIFY status ENUM('to_fit','out','returned','overdue','lost','cancelled') NOT NULL DEFAULT 'out'"],
  ['rental_contracts.kind', (c) => columnExists(c, 'rental_contracts', 'kind'), "ALTER TABLE rental_contracts ADD COLUMN kind ENUM('day','season') NOT NULL DEFAULT 'day'"],
  // where a to_fit rental is in a shop with stations: the renter's form, boots, the ski tech, the door
  ['rental_contracts.stage', (c) => columnExists(c, 'rental_contracts', 'stage'), "ALTER TABLE rental_contracts ADD COLUMN stage ENUM('form','boots','tech','door','set') NULL"],
  ['rental_contracts.order_item_id', (c) => columnExists(c, 'rental_contracts', 'order_item_id'), 'ALTER TABLE rental_contracts ADD COLUMN order_item_id BIGINT UNSIGNED NULL, ADD KEY ix_contracts_order_item (tenant_id, order_item_id)'],
  ['rental_contracts.valid_on', (c) => columnExists(c, 'rental_contracts', 'valid_on'), 'ALTER TABLE rental_contracts ADD COLUMN valid_on DATE NULL, ADD KEY ix_contracts_fit (tenant_id, status, valid_on)'],
  ['rental_contracts.group_id', (c) => columnExists(c, 'rental_contracts', 'group_id'), 'ALTER TABLE rental_contracts ADD COLUMN group_id BIGINT UNSIGNED NULL, ADD KEY ix_contracts_group (tenant_id, group_id)'],
  // gear handed out with nothing paid: only with a manager's say-so, and the reason is kept
  ['rental_contracts.unpaid_reason', (c) => columnExists(c, 'rental_contracts', 'unpaid_reason'), 'ALTER TABLE rental_contracts ADD COLUMN unpaid_reason VARCHAR(200) NULL, ADD COLUMN unpaid_by BIGINT UNSIGNED NULL'],
  ['rental_contracts.deposit_mode', (c) => columnExists(c, 'rental_contracts', 'deposit_mode'), `ALTER TABLE rental_contracts
    ADD COLUMN deposit_mode ENUM('none','note','card_hold','card_saved') NOT NULL DEFAULT 'none',
    ADD COLUMN deposit_status ENUM('none','pending','held','released','captured','failed') NOT NULL DEFAULT 'none',
    ADD COLUMN deposit_ref VARCHAR(80) NULL,
    ADD COLUMN deposit_customer VARCHAR(80) NULL,
    ADD COLUMN deposit_card VARCHAR(40) NULL`],
  ['rental_contracts.reminded_at', (c) => columnExists(c, 'rental_contracts', 'reminded_at'), 'ALTER TABLE rental_contracts ADD COLUMN reminded_at DATETIME NULL'],

  // ---- gear: set aside the night before for a group; sold to a season renter at the end
  ['rental_items.status set_aside sold', enumHas('rental_items', 'status', 'set_aside'),
    "ALTER TABLE rental_items MODIFY status ENUM('available','rented','maintenance','lost','retired','set_aside','sold') NOT NULL DEFAULT 'available'"],
  ['rental_charges.kind buyout', enumHas('rental_charges', 'kind', 'buyout'),
    "ALTER TABLE rental_charges MODIFY kind ENUM('late','damage','loss','deposit','other','buyout') NOT NULL"],

  // ---- products: a rental product can be a season rental
  ['products.rental_kind', (c) => columnExists(c, 'products', 'rental_kind'), "ALTER TABLE products ADD COLUMN rental_kind ENUM('day','season') NOT NULL DEFAULT 'day'"],

  // ---- the shop's settings
  ['rental_settings round 2', (c) => columnExists(c, 'rental_settings', 'layout'), `ALTER TABLE rental_settings
    ADD COLUMN layout ENUM('counter','stations') NOT NULL DEFAULT 'counter',
    ADD COLUMN closing_time TIME NOT NULL DEFAULT '16:30:00',
    ADD COLUMN require_signoff TINYINT(1) NOT NULL DEFAULT 1,
    ADD COLUMN deposit_mode ENUM('none','note','card') NOT NULL DEFAULT 'note',
    ADD COLUMN season_return_md CHAR(5) NOT NULL DEFAULT '04-15',
    ADD COLUMN signoff_valid_days SMALLINT UNSIGNED NOT NULL DEFAULT 1`],

  // ---- the binding chart can say which ages a row is for (many charts move children and older skiers a row)
  ['binding_chart.age', (c) => columnExists(c, 'binding_chart', 'age_min'), 'ALTER TABLE binding_chart ADD COLUMN age_min TINYINT UNSIGNED NULL, ADD COLUMN age_max TINYINT UNSIGNED NULL'],

  // ---- the renter's signed confirmation of the details the binding setting is chosen from
  ['rental_signoffs', (c) => tableExists(c, 'rental_signoffs'), `CREATE TABLE rental_signoffs (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    person_id     BIGINT UNSIGNED NOT NULL,
    contract_id   BIGINT UNSIGNED NULL,
    form_id       BIGINT UNSIGNED NULL,
    signer_name   VARCHAR(120) NOT NULL,
    signer_relation ENUM('self','parent','guardian') NOT NULL DEFAULT 'self',
    details       JSON NOT NULL,
    signature     MEDIUMTEXT NOT NULL,
    via           ENUM('counter','form') NOT NULL DEFAULT 'counter',
    ip            VARCHAR(45) NULL,
    signed_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_signoffs_person (tenant_id, person_id, signed_at),
    KEY ix_signoffs_contract (tenant_id, contract_id),
    CONSTRAINT fk_signoffs_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
  ) ENGINE=InnoDB`],

  // ---- the guest rental form: filled in at home or in line, picked up at the counter
  ['rental_forms', (c) => tableExists(c, 'rental_forms'), `CREATE TABLE rental_forms (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    order_id      BIGINT UNSIGNED NULL,
    group_id      BIGINT UNSIGNED NULL,
    status        ENUM('waiting','used','discarded') NOT NULL DEFAULT 'waiting',
    contact_name  VARCHAR(120) NOT NULL,
    phone         VARCHAR(30) NULL,
    email         VARCHAR(255) NULL,
    rental_on     DATE NOT NULL,
    people        JSON NOT NULL,
    used_by       BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_forms_day (tenant_id, status, rental_on),
    KEY ix_forms_order (tenant_id, order_id),
    KEY ix_forms_group (tenant_id, group_id)
  ) ENGINE=InnoDB`],
  // a link token for the order's form, kept only as a hash
  ['orders.rental_form_token_sha', (c) => columnExists(c, 'orders', 'rental_form_token_sha'), 'ALTER TABLE orders ADD COLUMN rental_form_token_sha CHAR(64) NULL, ADD UNIQUE KEY uq_orders_rental_form (rental_form_token_sha)'],

  // ---- groups: a school or club rents together on one day
  ['rental_groups', (c) => tableExists(c, 'rental_groups'), `CREATE TABLE rental_groups (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(120) NOT NULL,
    leader_name   VARCHAR(120) NULL,
    leader_phone  VARCHAR(30) NULL,
    leader_email  VARCHAR(255) NULL,
    rental_on     DATE NOT NULL,
    days          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    status        ENUM('open','set','out','returned','closed') NOT NULL DEFAULT 'open',
    link_token_sha CHAR(64) NULL,
    notes         VARCHAR(500) NULL,
    created_by    BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_rental_groups_tenant_id (tenant_id, id),
    UNIQUE KEY uq_rental_groups_link (link_token_sha),
    KEY ix_rental_groups_day (tenant_id, rental_on),
    CONSTRAINT fk_rental_groups_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
];
