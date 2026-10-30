'use strict';
// Guests, round 2, Track FAIR (2026.11.8): fair by design. The price promise, closure credits, the conditions guarantee,
// fair scan checks with blocks a guest can answer, payment plans on the mountain's own Stripe account, auto-renew and a
// waitlist for capped passes. Loaded by db/migrate.js right after guests. Each entry: [name, (conn) => done?, ddl].
const typeHas = async (c, table, column, text) => {
  const [r] = await c.query('SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r.length && String(r[0].t).includes(text));
};

module.exports = ({ tableExists }) => [
  // The rest of a mountain's fair settings (the switches themselves are in guest_settings): when passes renew and at
  // what price, and how quickly a pass may move between two lifts before the scan review asks a manager to look.
  ['fair_settings', (c) => tableExists(c, 'fair_settings'), `CREATE TABLE fair_settings (
    tenant_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    renew_on       DATE NULL,
    renew_rule     ENUM('lower','current') NOT NULL DEFAULT 'lower',
    travel_minutes TINYINT UNSIGNED NOT NULL DEFAULT 5,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_fair_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // Per product: whether it can be paid in installments (season passes always can), and a cap on how many are sold.
  ['fair_products', (c) => tableExists(c, 'fair_products'), `CREATE TABLE fair_products (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    plan_ok    TINYINT(1) NOT NULL DEFAULT 0,
    cap        INT UNSIGNED NULL,
    PRIMARY KEY (tenant_id, product_id),
    CONSTRAINT fk_fair_products_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
  ) ENGINE=InnoDB`],
  // The guest's private links (the conditions guarantee on a ticket, a blocked pass's reply page, a payment plan's card
  // page, a waitlist offer, a renewal). Only the SHA-256 of the token is kept.
  ['fair_links', (c) => tableExists(c, 'fair_links'), `CREATE TABLE fair_links (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    kind       ENUM('guarantee','blocked','plan','offer','renew') NOT NULL,
    ref_id     BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NULL,
    UNIQUE KEY uq_fair_links_token (token_hash),
    KEY ix_fair_links_ref (tenant_id, kind, ref_id),
    CONSTRAINT fk_fair_links_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // The price promise: one row per ticket per lower price, so the same drop is never refunded twice.
  ['fair_price_drops', (c) => tableExists(c, 'fair_price_drops'), `CREATE TABLE fair_price_drops (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    ticket_id    BIGINT UNSIGNED NOT NULL,
    order_id     BIGINT UNSIGNED NOT NULL,
    from_cents   INT UNSIGNED NOT NULL,
    to_cents     INT UNSIGNED NOT NULL,
    refund_cents INT UNSIGNED NOT NULL,
    refund_id    BIGINT UNSIGNED NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fair_price_drops (tenant_id, ticket_id, to_cents),
    CONSTRAINT fk_fair_price_drops_ticket FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets(tenant_id, id)
  ) ENGINE=InnoDB`],
  // Closure credits: the day a manager closed the mountain or its main lifts, and what was given for it.
  ['fair_closures', (c) => tableExists(c, 'fair_closures'), `CREATE TABLE fair_closures (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    on_date      DATE NOT NULL,
    scope        ENUM('mountain','main_lifts') NOT NULL DEFAULT 'mountain',
    closed_from  TIME NULL,
    reason       VARCHAR(200) NULL,
    issued_count INT UNSIGNED NOT NULL DEFAULT 0,
    issued_cents INT UNSIGNED NOT NULL DEFAULT 0,
    created_by   BIGINT UNSIGNED NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fair_closures_day (tenant_id, on_date),
    CONSTRAINT fk_fair_closures_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // Days a manager turned the conditions guarantee off.
  ['fair_guarantee_off', (c) => tableExists(c, 'fair_guarantee_off'), `CREATE TABLE fair_guarantee_off (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    on_date    DATE NOT NULL,
    user_id    BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, on_date),
    CONSTRAINT fk_fair_guarantee_off_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // Scan review: something unusual, with the evidence, for a manager to look at. Nothing is blocked by a flag.
  ['fair_flags', (c) => tableExists(c, 'fair_flags'), `CREATE TABLE fair_flags (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    ticket_id   BIGINT UNSIGNED NULL,
    kind        ENUM('far_apart','two_gates','failed_reloads') NOT NULL,
    dedupe      VARCHAR(80) NOT NULL,
    evidence    JSON NOT NULL,
    status      ENUM('open','dismissed','blocked') NOT NULL DEFAULT 'open',
    reviewed_by BIGINT UNSIGNED NULL,
    reviewed_at DATETIME NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fair_flags (tenant_id, kind, dedupe),
    KEY ix_fair_flags_status (tenant_id, status, created_at),
    CONSTRAINT fk_fair_flags_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // A pass or ticket a manager blocked, with the reason the guest is told, the guest's reply, and the unblock.
  ['fair_blocks', (c) => tableExists(c, 'fair_blocks'), `CREATE TABLE fair_blocks (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    ticket_id  BIGINT UNSIGNED NOT NULL,
    flag_id    BIGINT UNSIGNED NULL,
    reason     VARCHAR(300) NOT NULL,
    status     ENUM('active','lifted') NOT NULL DEFAULT 'active',
    blocked_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reply      VARCHAR(2000) NULL,
    replied_at DATETIME NULL,
    lifted_by  BIGINT UNSIGNED NULL,
    lifted_at  DATETIME NULL,
    lift_note  VARCHAR(300) NULL,
    KEY ix_fair_blocks_ticket (tenant_id, ticket_id, status),
    CONSTRAINT fk_fair_blocks_ticket FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets(tenant_id, id)
  ) ENGINE=InnoDB`],
  // Failed card reloads (the online reload calls fairprice.noteFailedReload), so many in a row can be reviewed.
  ['fair_reload_failures', (c) => tableExists(c, 'fair_reload_failures'), `CREATE TABLE fair_reload_failures (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    uid        VARCHAR(64) NOT NULL,
    why        VARCHAR(120) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_fair_reload_failures (tenant_id, uid, created_at),
    CONSTRAINT fk_fair_reload_failures_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // A guest's card saved on the mountain's own Stripe account, for payment plan installments and auto-renew.
  // provider: only 'stripe' now (Affirm later).
  ['fair_cards', (c) => tableExists(c, 'fair_cards'), `CREATE TABLE fair_cards (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    person_id      BIGINT UNSIGNED NULL,
    email          VARCHAR(255) NULL,
    provider       ENUM('stripe') NOT NULL DEFAULT 'stripe',
    account        VARCHAR(64) NULL,
    customer       VARCHAR(255) NULL,
    payment_method VARCHAR(255) NULL,
    payment_intent VARCHAR(255) NULL,
    brand          VARCHAR(20) NULL,
    last4          CHAR(4) NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_fair_cards_person (tenant_id, person_id),
    CONSTRAINT fk_fair_cards_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // Payment plans: one per order, and its installments. The first is paid at checkout; the job charges the rest.
  ['payment_plans', (c) => tableExists(c, 'payment_plans'), `CREATE TABLE payment_plans (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    order_id    BIGINT UNSIGNED NOT NULL,
    person_id   BIGINT UNSIGNED NULL,
    email       VARCHAR(255) NULL,
    name        VARCHAR(200) NULL,
    provider    ENUM('stripe') NOT NULL DEFAULT 'stripe',
    card_id     BIGINT UNSIGNED NULL,
    count       TINYINT UNSIGNED NOT NULL,
    total_cents INT UNSIGNED NOT NULL,
    status      ENUM('active','late','suspended','paid','canceled','settled') NOT NULL DEFAULT 'active',
    note        VARCHAR(300) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_payment_plans_order (tenant_id, order_id),
    KEY ix_payment_plans_status (tenant_id, status),
    CONSTRAINT fk_payment_plans_order FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['payment_plan_charges', (c) => tableExists(c, 'payment_plan_charges'), `CREATE TABLE payment_plan_charges (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    plan_id     BIGINT UNSIGNED NOT NULL,
    n           TINYINT UNSIGNED NOT NULL,
    due_on      DATE NOT NULL,
    cents       INT UNSIGNED NOT NULL,
    status      ENUM('due','paid','failed','canceled','settled') NOT NULL DEFAULT 'due',
    attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
    next_try_on DATE NULL,
    last_error  VARCHAR(255) NULL,
    reference   VARCHAR(255) NULL,
    paid_at     DATETIME NULL,
    UNIQUE KEY uq_plan_charges (plan_id, n),
    KEY ix_plan_charges_due (tenant_id, status, due_on),
    CONSTRAINT fk_plan_charges_plan FOREIGN KEY (plan_id) REFERENCES payment_plans(id)
  ) ENGINE=InnoDB`],
  // Auto-renew: a pass holder who said yes, the card, and the season it last renewed or reminded for.
  ['fair_renewals', (c) => tableExists(c, 'fair_renewals'), `CREATE TABLE fair_renewals (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    person_id      BIGINT UNSIGNED NOT NULL,
    product_id     BIGINT UNSIGNED NOT NULL,
    from_ticket_id BIGINT UNSIGNED NULL,
    card_id        BIGINT UNSIGNED NULL,
    email          VARCHAR(255) NULL,
    status         ENUM('on','off') NOT NULL DEFAULT 'on',
    reminded_for   VARCHAR(10) NULL,
    renewed_for    VARCHAR(10) NULL,
    new_order_id   BIGINT UNSIGNED NULL,
    last_error     VARCHAR(255) NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fair_renewals (tenant_id, person_id, product_id),
    CONSTRAINT fk_fair_renewals_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
  ) ENGINE=InnoDB`],
  // The waitlist for a capped pass: first come, first offered, like the lesson waitlist.
  ['fair_waitlist', (c) => tableExists(c, 'fair_waitlist'), `CREATE TABLE fair_waitlist (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    product_id       BIGINT UNSIGNED NOT NULL,
    first_name       VARCHAR(100) NOT NULL,
    last_name        VARCHAR(100) NOT NULL,
    email            VARCHAR(255) NOT NULL,
    status           ENUM('waiting','offered','taken','expired','left') NOT NULL DEFAULT 'waiting',
    offered_at       DATETIME NULL,
    offer_expires_at DATETIME NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fair_waitlist_email (tenant_id, product_id, email),
    KEY ix_fair_waitlist_order (tenant_id, product_id, status, id),
    CONSTRAINT fk_fair_waitlist_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
  ) ENGINE=InnoDB`],
  // The gate: a blocked pass and a payment plan left unpaid are refused with their own result.
  ['scans.result blocked', (c) => typeHas(c, 'scans', 'result', "'plan_unpaid'"),
    "ALTER TABLE scans MODIFY result ENUM('ok','expired','not_yet_valid','void','no_uses','unknown','duplicate','card_blocked','wrong_place','too_early','too_late','not_included','blocked','plan_unpaid') NOT NULL"],
];
