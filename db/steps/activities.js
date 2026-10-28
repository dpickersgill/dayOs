'use strict';
// Activities: selling places on an attraction (zipline tours, coaster rides, tubing sessions, skating). An activity is a
// product of kind 'activity' linked to one attraction, sold by time slot (start times on some days of the week over a
// date range, a slot length and places per slot) or for the whole day (an ice skating day pass, say). Each guest gets a
// ticket good once, at that attraction, on that day and in that slot. A lift ticket can also say which attractions it
// includes, and a gate device can stand at one attraction.
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js. Additive and safe to run twice.
const enumHas = async (c, table, column, value) => {
  const [[r]] = await c.query('SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return !r || r.t.includes(`'${value}'`);
};

module.exports = ({ tableExists, columnExists }) => [
  ['products.kind activity', (c) => enumHas(c, 'products', 'kind', 'activity'),
    "ALTER TABLE products MODIFY kind ENUM('day_ticket','multi_day','season_pass','punch_card','lesson','rental','program','voucher','activity') NOT NULL"],
  ['order_items.line_kind activity', (c) => enumHas(c, 'order_items', 'line_kind', 'activity'),
    "ALTER TABLE order_items MODIFY line_kind ENUM('ticket','lesson','rental','program','gift_card','fee','activity') NOT NULL DEFAULT 'ticket'"],
  // The attraction an activity is for; sold by time slot (timed = 1) or for the whole day, with an optional cap a day.
  ['products.attraction_id', (c) => columnExists(c, 'products', 'attraction_id'),
    'ALTER TABLE products ADD COLUMN attraction_id BIGINT UNSIGNED NULL, ADD COLUMN timed TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN day_capacity INT UNSIGNED NULL, ADD KEY ix_products_attraction (tenant_id, attraction_id)'],
  // When an activity runs: start times on some weekdays (bit mask, Sunday = 1 as products.sale_days) between two dates.
  ['activity_schedules', (c) => tableExists(c, 'activity_schedules'), `CREATE TABLE IF NOT EXISTS activity_schedules (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    product_id    BIGINT UNSIGNED NOT NULL,
    days          SMALLINT UNSIGNED NOT NULL DEFAULT 127,
    starts_on     DATE NOT NULL,
    ends_on       DATE NULL,
    start_times   VARCHAR(600) NOT NULL,
    slot_minutes  SMALLINT UNSIGNED NOT NULL,
    capacity      SMALLINT UNSIGNED NOT NULL,
    active        TINYINT(1) NOT NULL DEFAULT 1,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_activity_schedules_tenant_id (tenant_id, id),
    KEY ix_activity_schedules_product (tenant_id, product_id, active),
    CONSTRAINT fk_activity_schedules_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // One place taken by one guest: the slot it is for, the order line and the ticket. A refund cancels it (the place is free again).
  ['activity_bookings', (c) => tableExists(c, 'activity_bookings'), `CREATE TABLE IF NOT EXISTS activity_bookings (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    product_id     BIGINT UNSIGNED NOT NULL,
    attraction_id  BIGINT UNSIGNED NOT NULL,
    on_date        DATE NOT NULL,
    start_time     TIME NULL,
    end_time       TIME NULL,
    person_id      BIGINT UNSIGNED NULL,
    order_item_id  BIGINT UNSIGNED NULL,
    ticket_id      BIGINT UNSIGNED NULL,
    channel        VARCHAR(10) NOT NULL DEFAULT 'window',
    limits_ok_by   BIGINT UNSIGNED NULL,
    status         ENUM('booked','cancelled') NOT NULL DEFAULT 'booked',
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_activity_bookings_tenant_id (tenant_id, id),
    UNIQUE KEY uq_activity_bookings_ticket (tenant_id, ticket_id),
    KEY ix_activity_bookings_slot (tenant_id, product_id, on_date, start_time, status),
    KEY ix_activity_bookings_item (tenant_id, order_item_id),
    KEY ix_activity_bookings_attraction (tenant_id, attraction_id, on_date),
    CONSTRAINT fk_activity_bookings_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // A lift ticket or pass that includes an attraction (a scenic ride with the summer pass): accepted at that attraction's gate.
  ['product_attractions', (c) => tableExists(c, 'product_attractions'), `CREATE TABLE IF NOT EXISTS product_attractions (
    tenant_id      BIGINT UNSIGNED NOT NULL,
    product_id     BIGINT UNSIGNED NOT NULL,
    attraction_id  BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, product_id, attraction_id),
    KEY ix_product_attractions_attraction (tenant_id, attraction_id),
    CONSTRAINT fk_product_attractions_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // A gate, turnstile or handheld that stands at one attraction.
  ['access_devices.attraction_id', (c) => columnExists(c, 'access_devices', 'attraction_id'),
    'ALTER TABLE access_devices ADD COLUMN attraction_id BIGINT UNSIGNED NULL'],
  // A sales tax can apply to activities alone (an amusement tax, say).
  ['tax_rules.applies_to activity', (c) => enumHas(c, 'tax_rules', 'applies_to', 'activity'),
    "ALTER TABLE tax_rules MODIFY applies_to ENUM('all','ticket','lesson','rental','program','gift_card','activity') NOT NULL DEFAULT 'all'"],
  // Why a gate said no to an activity ticket (or a lift ticket at an attraction).
  ['scans activity results', (c) => enumHas(c, 'scans', 'result', 'wrong_place'),
    "ALTER TABLE scans MODIFY result ENUM('ok','expired','not_yet_valid','void','no_uses','unknown','duplicate','card_blocked','wrong_place','too_early','too_late','not_included') NOT NULL"],
];
