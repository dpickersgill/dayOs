'use strict';
// The ski school, round 2, families (Track PARENTS): the family booking basket, a lift ticket and rental with a lesson,
// waitlists, recaps with photos, the follow-up after a first lesson, and the families' settings. Loaded by db/migrate.js
// right after lessons2. Each entry: [name, (conn) => done?, ddl].
module.exports = ({ tableExists, columnExists }) => [
  // ---- one family booking online: several students, each with their own lesson, plus tickets and rentals, one payment
  ['lesson_baskets', (c) => tableExists(c, 'lesson_baskets'), `CREATE TABLE lesson_baskets (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id         BIGINT UNSIGNED NOT NULL,
    reference         CHAR(8) NOT NULL,
    contact_email     VARCHAR(255) NOT NULL,
    status            ENUM('pending','awaiting_payment','paid','expired','cancelled') NOT NULL DEFAULT 'pending',
    amount_cents      INT UNSIGNED NOT NULL DEFAULT 0,
    extras            TEXT NULL,
    extras_order_id   BIGINT UNSIGNED NULL,
    stripe_session_id VARCHAR(255) NULL,
    payment_intent    VARCHAR(255) NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at           DATETIME NULL,
    UNIQUE KEY uq_baskets_ref (tenant_id, reference),
    CONSTRAINT fk_lbasket_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['lesson_requests.basket_id', (c) => columnExists(c, 'lesson_requests', 'basket_id'), 'ALTER TABLE lesson_requests ADD COLUMN basket_id BIGINT UNSIGNED NULL, ADD KEY ix_requests_basket (tenant_id, basket_id)'],

  // ---- what a lesson product offers with it online: a lift ticket and a rental, each its own product and price
  ['lesson_product_extras', (c) => tableExists(c, 'lesson_product_extras'), `CREATE TABLE lesson_product_extras (
    tenant_id         BIGINT UNSIGNED NOT NULL,
    product_id        BIGINT UNSIGNED NOT NULL,
    ticket_product_id BIGINT UNSIGNED NULL,
    rental_product_id BIGINT UNSIGNED NULL,
    PRIMARY KEY (tenant_id, product_id),
    CONSTRAINT fk_lpx_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- the waitlist for a full lesson: the first family gets an offer with a link, valid for a short while
  ['lesson_waitlist', (c) => tableExists(c, 'lesson_waitlist'), `CREATE TABLE lesson_waitlist (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    session_id      BIGINT UNSIGNED NOT NULL,
    contact_name    VARCHAR(150) NOT NULL,
    contact_email   VARCHAR(255) NOT NULL,
    contact_phone   VARCHAR(40) NULL,
    text_ok         TINYINT(1) NOT NULL DEFAULT 0,
    student         TEXT NOT NULL,
    status          ENUM('waiting','offered','claimed','expired','removed') NOT NULL DEFAULT 'waiting',
    token_sha       CHAR(64) NULL,
    offered_at      DATETIME NULL,
    offer_expires_at DATETIME NULL,
    request_id      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_waitlist_token (token_sha),
    KEY ix_waitlist_session (tenant_id, session_id, status, id),
    CONSTRAINT fk_lwait_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- the recap after a lesson: skills, the level now, a note, the words the family reads, and who approved it
  ['lesson_recaps', (c) => tableExists(c, 'lesson_recaps'), `CREATE TABLE lesson_recaps (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    booking_id    BIGINT UNSIGNED NOT NULL,
    session_id    BIGINT UNSIGNED NOT NULL,
    person_id     BIGINT UNSIGNED NOT NULL,
    staff_id      BIGINT UNSIGNED NULL,
    status        ENUM('due','draft','sent','skipped') NOT NULL DEFAULT 'due',
    skills        TEXT NULL,
    level         TINYINT UNSIGNED NULL,
    note          VARCHAR(1000) NULL,
    body          TEXT NULL,
    ai_used       TINYINT(1) NOT NULL DEFAULT 0,
    token_sha     CHAR(64) NULL,
    approved_by   BIGINT UNSIGNED NULL,
    sent_at       DATETIME NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_recap_booking (tenant_id, booking_id),
    UNIQUE KEY uq_recap_token (token_sha),
    KEY ix_recap_session (tenant_id, session_id),
    KEY ix_recap_person (tenant_id, person_id),
    CONSTRAINT fk_lrecap_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // Photos only for a child whose family said yes (lesson_bookings.photo_ok); resized on the phone; deleted after 90 days.
  ['lesson_recap_photos', (c) => tableExists(c, 'lesson_recap_photos'), `CREATE TABLE lesson_recap_photos (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    recap_id    BIGINT UNSIGNED NOT NULL,
    booking_id  BIGINT UNSIGNED NOT NULL,
    mime        VARCHAR(60) NOT NULL,
    bytes       INT UNSIGNED NOT NULL,
    data        MEDIUMBLOB NOT NULL,
    uploaded_by BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_recap_photos (tenant_id, recap_id),
    KEY ix_recap_photos_age (created_at),
    CONSTRAINT fk_lrecap_photo_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- the follow-up after a first or second lesson, sent once
  ['lesson_bookings.followup_sent_at', (c) => columnExists(c, 'lesson_bookings', 'followup_sent_at'), 'ALTER TABLE lesson_bookings ADD COLUMN followup_sent_at DATETIME NULL'],

  // ---- the families' settings that are not in school_settings: next-step offers, the follow-up, what to bring
  ['school_family_settings', (c) => tableExists(c, 'school_family_settings'), `CREATE TABLE school_family_settings (
    tenant_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    next_lesson_on TINYINT(1) NOT NULL DEFAULT 1,
    pack_on        TINYINT(1) NOT NULL DEFAULT 1,
    pack_credit    TINYINT(1) NOT NULL DEFAULT 0,
    pass_on        TINYINT(1) NOT NULL DEFAULT 0,
    pass_words     VARCHAR(300) NULL,
    followup_on    TINYINT(1) NOT NULL DEFAULT 1,
    what_to_bring  VARCHAR(500) NULL,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_lfam_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
];
