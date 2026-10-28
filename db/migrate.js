'use strict';

// Applies db/schema.sql, then the additive steps below. Everything is idempotent, so it is safe to
// re-run, and it upgrades an existing database in place without touching its data.
//
// MySQL 8 has no "ADD COLUMN IF NOT EXISTS", so each step checks information_schema first.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

const has = async (conn, sql, params) => (await conn.query(sql, params))[0].length > 0;

const columnExists = (conn, table, column) =>
  has(conn, 'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
const constraintExists = (conn, table, name) =>
  has(conn, 'SELECT 1 FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?', [table, name]);
const columnTypeHas = (conn, table, column, text) =>
  has(conn, 'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? AND column_type LIKE ?', [table, column, `%${text}%`]);
const indexExists = (conn, table, name) =>
  has(conn, 'SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);

// Each step: [description, check that returns true when already applied, DDL to apply].
// An index that forbids duplicates cannot be added while duplicates exist, so such a step is skipped (with a note) until they are cleaned up.
let skipped = 0;
const hasDuplicates = async (conn, table, col, where) => {
  const [r] = await conn.query(`SELECT 1 FROM \`${table}\` WHERE ${where} GROUP BY tenant_id, ${col} HAVING COUNT(*) > 1 LIMIT 1`);
  if (r.length) console.warn(`  Skipped a uniqueness rule on ${table}: some people already have two open rows there. Close the extras, then run the migration again.`);
  if (r.length) skipped += 1;
  return r.length > 0;
};

const steps = [
  ['documents.text_status', (c) => columnExists(c, 'documents', 'text_status'), "ALTER TABLE documents ADD COLUMN text_status ENUM('pending','indexed','needs_ocr','none','unsupported','failed') NOT NULL DEFAULT 'pending'"],
  ['documents.text_method', (c) => columnExists(c, 'documents', 'text_method'), "ALTER TABLE documents ADD COLUMN text_method VARCHAR(10) NULL"],
  ['documents.file_at', (c) => columnExists(c, 'documents', 'file_at'), 'ALTER TABLE documents ADD COLUMN file_at TIMESTAMP NULL'],
  ['documents.version_note', (c) => columnExists(c, 'documents', 'version_note'), "ALTER TABLE documents ADD COLUMN version_note VARCHAR(200) NULL"],
  ['tenants.show_instructor_availability', (c) => columnExists(c, 'tenants', 'show_instructor_availability'), 'ALTER TABLE tenants ADD COLUMN show_instructor_availability TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.status', (c) => columnExists(c, 'tenants', 'status'), "ALTER TABLE tenants ADD COLUMN status ENUM('active','suspended') NOT NULL DEFAULT 'active'"],
  ['tenants.storage_cap_mb', (c) => columnExists(c, 'tenants', 'storage_cap_mb'), 'ALTER TABLE tenants ADD COLUMN storage_cap_mb INT UNSIGNED NOT NULL DEFAULT 500'],
  ['tenants.platform_notes', (c) => columnExists(c, 'tenants', 'platform_notes'), 'ALTER TABLE tenants ADD COLUMN platform_notes VARCHAR(500) NULL'],
  ['tenants.sandbox_expires_at', (c) => columnExists(c, 'tenants', 'sandbox_expires_at'), 'ALTER TABLE tenants ADD COLUMN sandbox_expires_at DATETIME NULL'],
  ['rental_items.serial_no', (cn) => columnExists(cn, 'rental_items', 'serial_no'), 'ALTER TABLE rental_items ADD COLUMN serial_no VARCHAR(60) NULL'],
  ['rental_items.tier', (cn) => columnExists(cn, 'rental_items', 'tier'), "ALTER TABLE rental_items ADD COLUMN tier ENUM('standard','performance') NOT NULL DEFAULT 'standard'"],
  ['rental_items.boot_sole_mm', (cn) => columnExists(cn, 'rental_items', 'boot_sole_mm'), 'ALTER TABLE rental_items ADD COLUMN boot_sole_mm SMALLINT UNSIGNED NULL'],
  ['rental_items.purchased_on', (cn) => columnExists(cn, 'rental_items', 'purchased_on'), 'ALTER TABLE rental_items ADD COLUMN purchased_on DATE NULL'],
  ['rental_items.cost_cents', (cn) => columnExists(cn, 'rental_items', 'cost_cents'), 'ALTER TABLE rental_items ADD COLUMN cost_cents INT UNSIGNED NULL'],
  ['rental_items.grade', (cn) => columnExists(cn, 'rental_items', 'grade'), "ALTER TABLE rental_items ADD COLUMN grade ENUM('A','B','C','D') NULL"],
  ['rental_items.location', (cn) => columnExists(cn, 'rental_items', 'location'), 'ALTER TABLE rental_items ADD COLUMN location VARCHAR(60) NULL'],
  ['rental_items.uses_count', (cn) => columnExists(cn, 'rental_items', 'uses_count'), 'ALTER TABLE rental_items ADD COLUMN uses_count INT UNSIGNED NOT NULL DEFAULT 0'],
  ['rental_items.uses_at_service', (cn) => columnExists(cn, 'rental_items', 'uses_at_service'), 'ALTER TABLE rental_items ADD COLUMN uses_at_service INT UNSIGNED NOT NULL DEFAULT 0'],
  ['rental_items.last_service_at', (cn) => columnExists(cn, 'rental_items', 'last_service_at'), 'ALTER TABLE rental_items ADD COLUMN last_service_at DATETIME NULL'],
  ['rental_contracts.group_name', (cn) => columnExists(cn, 'rental_contracts', 'group_name'), 'ALTER TABLE rental_contracts ADD COLUMN group_name VARCHAR(120) NULL'],
  ['rental_contracts.deposit_cents', (cn) => columnExists(cn, 'rental_contracts', 'deposit_cents'), 'ALTER TABLE rental_contracts ADD COLUMN deposit_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['rental_contracts.reservation_id', (cn) => columnExists(cn, 'rental_contracts', 'reservation_id'), 'ALTER TABLE rental_contracts ADD COLUMN reservation_id BIGINT UNSIGNED NULL'],
  ['rental_contracts.notes', (cn) => columnExists(cn, 'rental_contracts', 'notes'), 'ALTER TABLE rental_contracts ADD COLUMN notes VARCHAR(300) NULL'],
  ['rental_contract_items.person_id', (cn) => columnExists(cn, 'rental_contract_items', 'person_id'), 'ALTER TABLE rental_contract_items ADD COLUMN person_id BIGINT UNSIGNED NULL'],
  ['rental_contract_items.boot_sole_mm', (cn) => columnExists(cn, 'rental_contract_items', 'boot_sole_mm'), 'ALTER TABLE rental_contract_items ADD COLUMN boot_sole_mm SMALLINT UNSIGNED NULL'],
  ['rental_contract_items.skier_type', (cn) => columnExists(cn, 'rental_contract_items', 'skier_type'), 'ALTER TABLE rental_contract_items ADD COLUMN skier_type VARCHAR(4) NULL'],
  ['rental_contract_items.tech_name', (cn) => columnExists(cn, 'rental_contract_items', 'tech_name'), 'ALTER TABLE rental_contract_items ADD COLUMN tech_name VARCHAR(100) NULL'],
  ['rental_contract_items.set_at', (cn) => columnExists(cn, 'rental_contract_items', 'set_at'), 'ALTER TABLE rental_contract_items ADD COLUMN set_at DATETIME NULL'],
  ['rental_contract_items.test_result', (cn) => columnExists(cn, 'rental_contract_items', 'test_result'), "ALTER TABLE rental_contract_items ADD COLUMN test_result ENUM('pass','fail') NULL"],
  ['rental_contract_items.swap_reason', (cn) => columnExists(cn, 'rental_contract_items', 'swap_reason'), 'ALTER TABLE rental_contract_items ADD COLUMN swap_reason VARCHAR(200) NULL'],
  ['documents.require_ack', (c) => columnExists(c, 'documents', 'require_ack'), 'ALTER TABLE documents ADD COLUMN require_ack TINYINT(1) NOT NULL DEFAULT 0'],
  ['till_sessions.open_key', (c) => columnExists(c, 'till_sessions', 'open_key'), "ALTER TABLE till_sessions ADD COLUMN open_key BIGINT UNSIGNED AS (IF(status = 'open', opened_by, NULL)) STORED"],
  ['till_sessions one open drawer per person', async (c) => (await indexExists(c, 'till_sessions', 'uq_till_open')) || hasDuplicates(c, 'till_sessions', 'opened_by', "status = 'open'"), 'ALTER TABLE till_sessions ADD UNIQUE KEY uq_till_open (tenant_id, open_key)'],
  ['time_entries.open_key', (c) => columnExists(c, 'time_entries', 'open_key'), 'ALTER TABLE time_entries ADD COLUMN open_key BIGINT UNSIGNED AS (IF(clock_out IS NULL, staff_id, NULL)) STORED'],
  ['time_entries one open punch per person', async (c) => (await indexExists(c, 'time_entries', 'uq_time_open')) || hasDuplicates(c, 'time_entries', 'staff_id', 'clock_out IS NULL'), 'ALTER TABLE time_entries ADD UNIQUE KEY uq_time_open (tenant_id, open_key)'],
  ['users.staff_id', (c) => columnExists(c, 'users', 'staff_id'), 'ALTER TABLE users ADD COLUMN staff_id BIGINT UNSIGNED NULL AFTER person_id'],
  ['users.password_changed_at', (c) => columnExists(c, 'users', 'password_changed_at'), 'ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMP NULL'],
  ['users unique staff link', (c) => indexExists(c, 'users', 'uq_users_staff'), 'ALTER TABLE users ADD UNIQUE KEY uq_users_staff (tenant_id, staff_id)'],
  ['users.staff_id foreign key', (c) => constraintExists(c, 'users', 'fk_users_staff'),
    'ALTER TABLE users ADD CONSTRAINT fk_users_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)'],
];

// Patrol: incidents grow into full patient care reports. Legacy rows are kept and backfilled below.
const incidentCol = (name, ddl, after) => [`incidents.${name}`, (c) => columnExists(c, 'incidents', name), after ? [ddl, after] : ddl];
const patrolSteps = [
  incidentCol('season', 'ALTER TABLE incidents ADD COLUMN season VARCHAR(10) NULL'),
  incidentCol('seq', 'ALTER TABLE incidents ADD COLUMN seq INT UNSIGNED NULL'),
  ['incidents case number key', (c) => indexExists(c, 'incidents', 'uq_incidents_case'), 'ALTER TABLE incidents ADD UNIQUE KEY uq_incidents_case (tenant_id, season, seq)'],
  // Reports that were already closed before sign-off existed are treated as approved.
  incidentCol('report_state', "ALTER TABLE incidents ADD COLUMN report_state ENUM('draft','submitted','approved') NOT NULL DEFAULT 'draft'",
    "UPDATE incidents SET report_state = 'approved' WHERE status = 'closed'"),
  incidentCol('submitted_by', 'ALTER TABLE incidents ADD COLUMN submitted_by BIGINT UNSIGNED NULL'),
  incidentCol('submitted_at', 'ALTER TABLE incidents ADD COLUMN submitted_at DATETIME NULL'),
  incidentCol('approved_by', 'ALTER TABLE incidents ADD COLUMN approved_by BIGINT UNSIGNED NULL'),
  incidentCol('approved_at', 'ALTER TABLE incidents ADD COLUMN approved_at DATETIME NULL'),
  incidentCol('weather', 'ALTER TABLE incidents ADD COLUMN weather VARCHAR(100) NULL'),
  incidentCol('gps_lat', 'ALTER TABLE incidents ADD COLUMN gps_lat DECIMAL(9,6) NULL'),
  incidentCol('gps_lng', 'ALTER TABLE incidents ADD COLUMN gps_lng DECIMAL(9,6) NULL'),
  incidentCol('trail_id', 'ALTER TABLE incidents ADD COLUMN trail_id BIGINT UNSIGNED NULL'),
  ['incidents.trail_id foreign key', (c) => constraintExists(c, 'incidents', 'fk_incidents_trail'),
    'ALTER TABLE incidents ADD CONSTRAINT fk_incidents_trail FOREIGN KEY (tenant_id, trail_id) REFERENCES trails(tenant_id, id)'],
  // Guest help page: off until a manager turns it on.
  ['tenants.guest_help_enabled', (c) => columnExists(c, 'tenants', 'guest_help_enabled'), 'ALTER TABLE tenants ADD COLUMN guest_help_enabled TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.guest_help_message', (c) => columnExists(c, 'tenants', 'guest_help_message'), 'ALTER TABLE tenants ADD COLUMN guest_help_message VARCHAR(300) NULL'],
  // NSAAR incident form: form values stored as JSON text, full witness details, the resort's legal name.
  ['incidents.form', (c) => columnExists(c, 'incidents', 'form'), 'ALTER TABLE incidents ADD COLUMN form TEXT NULL'],
  ['incident_patients.form', (c) => columnExists(c, 'incident_patients', 'form'), 'ALTER TABLE incident_patients ADD COLUMN form TEXT NULL'],
  ['incident_witnesses.relation', (c) => columnExists(c, 'incident_witnesses', 'relation'), "ALTER TABLE incident_witnesses ADD COLUMN relation ENUM('witnessed_by','accompanied_by','collided_with','other') NULL"],
  ['incident_witnesses.address', (c) => columnExists(c, 'incident_witnesses', 'address'), 'ALTER TABLE incident_witnesses ADD COLUMN address VARCHAR(255) NULL'],
  ['incident_witnesses.city', (c) => columnExists(c, 'incident_witnesses', 'city'), 'ALTER TABLE incident_witnesses ADD COLUMN city VARCHAR(100) NULL'],
  ['incident_witnesses.region', (c) => columnExists(c, 'incident_witnesses', 'region'), 'ALTER TABLE incident_witnesses ADD COLUMN region VARCHAR(60) NULL'],
  ['incident_witnesses.postal', (c) => columnExists(c, 'incident_witnesses', 'postal'), 'ALTER TABLE incident_witnesses ADD COLUMN postal VARCHAR(20) NULL'],
  ['tenants.legal_name', (c) => columnExists(c, 'tenants', 'legal_name'), 'ALTER TABLE tenants ADD COLUMN legal_name VARCHAR(255) NULL'],
  // Collision report, follow-up email and donations (Updates 2 to 4).
  ['incident_patients.email', (c) => columnExists(c, 'incident_patients', 'email'), 'ALTER TABLE incident_patients ADD COLUMN email VARCHAR(255) NULL'],
  ['incident_patients.guardian_name', (c) => columnExists(c, 'incident_patients', 'guardian_name'), 'ALTER TABLE incident_patients ADD COLUMN guardian_name VARCHAR(150) NULL'],
  ['incident_patients.guardian_email', (c) => columnExists(c, 'incident_patients', 'guardian_email'), 'ALTER TABLE incident_patients ADD COLUMN guardian_email VARCHAR(255) NULL'],
  ['incident_patients.no_followup', (c) => columnExists(c, 'incident_patients', 'no_followup'), 'ALTER TABLE incident_patients ADD COLUMN no_followup TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.followup_enabled', (c) => columnExists(c, 'tenants', 'followup_enabled'), 'ALTER TABLE tenants ADD COLUMN followup_enabled TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.followup_days', (c) => columnExists(c, 'tenants', 'followup_days'), 'ALTER TABLE tenants ADD COLUMN followup_days TINYINT UNSIGNED NOT NULL DEFAULT 5'],
  ['tenants.patrol_org_name', (c) => columnExists(c, 'tenants', 'patrol_org_name'), 'ALTER TABLE tenants ADD COLUMN patrol_org_name VARCHAR(150) NULL'],
  ['tenants.mail_address', (c) => columnExists(c, 'tenants', 'mail_address'), 'ALTER TABLE tenants ADD COLUMN mail_address VARCHAR(300) NULL'],
  ['tenants.donate_amounts', (c) => columnExists(c, 'tenants', 'donate_amounts'), 'ALTER TABLE tenants ADD COLUMN donate_amounts VARCHAR(60) NOT NULL DEFAULT \'25,50,100,250\''],
  ['tenants.donate_blurb', (c) => columnExists(c, 'tenants', 'donate_blurb'), 'ALTER TABLE tenants ADD COLUMN donate_blurb VARCHAR(600) NULL'],
  ['tenants.tax_note', (c) => columnExists(c, 'tenants', 'tax_note'), 'ALTER TABLE tenants ADD COLUMN tax_note VARCHAR(500) NULL'],
  ['tenants.reply_to', (c) => columnExists(c, 'tenants', 'reply_to'), 'ALTER TABLE tenants ADD COLUMN reply_to VARCHAR(255) NULL'],
  // Patrol map: where the map opens for this mountain.
  ['tenants.map_lat', (c) => columnExists(c, 'tenants', 'map_lat'), 'ALTER TABLE tenants ADD COLUMN map_lat DECIMAL(9,6) NULL'],
  ['tenants.map_lng', (c) => columnExists(c, 'tenants', 'map_lng'), 'ALTER TABLE tenants ADD COLUMN map_lng DECIMAL(9,6) NULL'],
  ['tenants.map_zoom', (c) => columnExists(c, 'tenants', 'map_zoom'), 'ALTER TABLE tenants ADD COLUMN map_zoom TINYINT UNSIGNED NULL'],
  // Shared customer record (CRM): the people table now carries the standard contact details every module uses.
  ['people.address_line1', (c) => columnExists(c, 'people', 'address_line1'), "ALTER TABLE people ADD COLUMN address_line1 VARCHAR(255) NULL"],
  ['people.address_line2', (c) => columnExists(c, 'people', 'address_line2'), "ALTER TABLE people ADD COLUMN address_line2 VARCHAR(255) NULL"],
  ['people.city', (c) => columnExists(c, 'people', 'city'), "ALTER TABLE people ADD COLUMN city VARCHAR(100) NULL"],
  ['people.region', (c) => columnExists(c, 'people', 'region'), "ALTER TABLE people ADD COLUMN region VARCHAR(60) NULL"],
  ['people.postal_code', (c) => columnExists(c, 'people', 'postal_code'), "ALTER TABLE people ADD COLUMN postal_code VARCHAR(20) NULL"],
  ['people.country', (c) => columnExists(c, 'people', 'country'), "ALTER TABLE people ADD COLUMN country VARCHAR(60) NULL"],
  ['people.emergency_name', (c) => columnExists(c, 'people', 'emergency_name'), "ALTER TABLE people ADD COLUMN emergency_name VARCHAR(150) NULL"],
  ['people.emergency_phone', (c) => columnExists(c, 'people', 'emergency_phone'), "ALTER TABLE people ADD COLUMN emergency_phone VARCHAR(40) NULL"],
  ['people.discipline', (c) => columnExists(c, 'people', 'discipline'), "ALTER TABLE people ADD COLUMN discipline ENUM('ski','snowboard','telemark','adaptive') NULL"],
  ['people.ability_level', (c) => columnExists(c, 'people', 'ability_level'), "ALTER TABLE people ADD COLUMN ability_level ENUM('first_timer','beginner','intermediate','advanced') NULL"],
  ['people.marketing_opt_in', (c) => columnExists(c, 'people', 'marketing_opt_in'), "ALTER TABLE people ADD COLUMN marketing_opt_in TINYINT(1) NOT NULL DEFAULT 0"],
  ['people.marketing_opt_in_at', (c) => columnExists(c, 'people', 'marketing_opt_in_at'), "ALTER TABLE people ADD COLUMN marketing_opt_in_at TIMESTAMP NULL"],
  ['people.source', (c) => columnExists(c, 'people', 'source'), "ALTER TABLE people ADD COLUMN source VARCHAR(20) NULL"],
  ['people.notes', (c) => columnExists(c, 'people', 'notes'), "ALTER TABLE people ADD COLUMN notes VARCHAR(1000) NULL"],
  ['people.anonymised_at', (c) => columnExists(c, 'people', 'anonymised_at'), "ALTER TABLE people ADD COLUMN anonymised_at TIMESTAMP NULL"],
  ['people.updated_at', (c) => columnExists(c, 'people', 'updated_at'), "ALTER TABLE people ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"],
  ['people phone index', (c) => indexExists(c, 'people', 'ix_people_phone'), 'ALTER TABLE people ADD KEY ix_people_phone (tenant_id, phone)'],
  // One basket for everything: order lines can be tickets, lessons, rentals, programs or gift cards.
  ['order_items.line_kind', (c) => columnExists(c, 'order_items', 'line_kind'), "ALTER TABLE order_items ADD COLUMN line_kind ENUM('ticket','lesson','rental','program','gift_card') NOT NULL DEFAULT 'ticket' AFTER product_id"],
  ['order_items.person_id', (c) => columnExists(c, 'order_items', 'person_id'), 'ALTER TABLE order_items ADD COLUMN person_id BIGINT UNSIGNED NULL AFTER line_kind'],
  ['order_items.session_id', (c) => columnExists(c, 'order_items', 'session_id'), 'ALTER TABLE order_items ADD COLUMN session_id BIGINT UNSIGNED NULL AFTER person_id'],
  ['order_items.program_id', (c) => columnExists(c, 'order_items', 'program_id'), 'ALTER TABLE order_items ADD COLUMN program_id BIGINT UNSIGNED NULL AFTER session_id'],
  ['order_items.contract_id', (c) => columnExists(c, 'order_items', 'contract_id'), 'ALTER TABLE order_items ADD COLUMN contract_id BIGINT UNSIGNED NULL AFTER program_id'],
  ['order_items.gift_card_id', (c) => columnExists(c, 'order_items', 'gift_card_id'), 'ALTER TABLE order_items ADD COLUMN gift_card_id BIGINT UNSIGNED NULL AFTER contract_id'],
  ['order_items.product_id optional', async (c) => (await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_items' AND column_name = 'product_id' AND is_nullable = 'YES'"))[0].length > 0, 'ALTER TABLE order_items MODIFY COLUMN product_id BIGINT UNSIGNED NULL'],
  ['order_items order index', (c) => indexExists(c, 'order_items', 'ix_order_items_order'), 'ALTER TABLE order_items ADD KEY ix_order_items_order (tenant_id, order_id)'],
  // Phone numbers compared by their last 10 digits, so (610) 555-0100 and 610-555-0100 are the same number.
  ['audit_log time index', (c) => indexExists(c, 'audit_log', 'ix_audit_time'), 'ALTER TABLE audit_log ADD KEY ix_audit_time (tenant_id, at)'],
  ['people.sex', (c) => columnExists(c, 'people', 'sex'), "ALTER TABLE people ADD COLUMN sex ENUM('female','male','other') NULL AFTER date_of_birth"],
  // Tax, refunds, till, family, passes, two-step sign-in, receipts (new tables are created by schema.sql).
  ['tenants.address', (c) => columnExists(c, 'tenants', 'address'), 'ALTER TABLE tenants ADD COLUMN address VARCHAR(255) NULL'],
  ['tenants.phone', (c) => columnExists(c, 'tenants', 'phone'), 'ALTER TABLE tenants ADD COLUMN phone VARCHAR(40) NULL'],
  ['tenants.receipt_footer', (c) => columnExists(c, 'tenants', 'receipt_footer'), 'ALTER TABLE tenants ADD COLUMN receipt_footer VARCHAR(500) NULL'],
  ['tenants.waiver_text', (c) => columnExists(c, 'tenants', 'waiver_text'), 'ALTER TABLE tenants ADD COLUMN waiver_text TEXT NULL'],
  ['tenants.require_mfa', (c) => columnExists(c, 'tenants', 'require_mfa'), 'ALTER TABLE tenants ADD COLUMN require_mfa TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.comp_counter_limit_cents', (c) => columnExists(c, 'tenants', 'comp_counter_limit_cents'), 'ALTER TABLE tenants ADD COLUMN comp_counter_limit_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['tenants.scan_passback_seconds', (c) => columnExists(c, 'tenants', 'scan_passback_seconds'), 'ALTER TABLE tenants ADD COLUMN scan_passback_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 120'],
  ['lesson_sessions.format', (c) => columnExists(c, 'lesson_sessions', 'format'), "ALTER TABLE lesson_sessions ADD COLUMN format ENUM('group','semi_private','private') NOT NULL DEFAULT 'group'"],
  ['lesson_sessions.age_group', (c) => columnExists(c, 'lesson_sessions', 'age_group'), "ALTER TABLE lesson_sessions ADD COLUMN age_group ENUM('all','kids','teens','adults') NOT NULL DEFAULT 'all'"],
  ['lesson_sessions.meeting_place', (c) => columnExists(c, 'lesson_sessions', 'meeting_place'), 'ALTER TABLE lesson_sessions ADD COLUMN meeting_place VARCHAR(120) NULL'],
  ['lesson_sessions.notes', (c) => columnExists(c, 'lesson_sessions', 'notes'), 'ALTER TABLE lesson_sessions ADD COLUMN notes VARCHAR(1000) NULL'],
  ['lesson_sessions.tip_cents', (c) => columnExists(c, 'lesson_sessions', 'tip_cents'), 'ALTER TABLE lesson_sessions ADD COLUMN tip_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['lesson_bookings.unpaid', (c) => columnExists(c, 'lesson_bookings', 'unpaid'), 'ALTER TABLE lesson_bookings ADD COLUMN unpaid TINYINT(1) NOT NULL DEFAULT 0'],
  ['lesson_bookings.credit_id', (c) => columnExists(c, 'lesson_bookings', 'credit_id'), 'ALTER TABLE lesson_bookings ADD COLUMN credit_id BIGINT UNSIGNED NULL'],
  ['lesson_bookings.instructor_notes', (c) => columnExists(c, 'lesson_bookings', 'instructor_notes'), 'ALTER TABLE lesson_bookings ADD COLUMN instructor_notes VARCHAR(1000) NULL'],
  ['lesson_bookings.requested_instructor_id', (c) => columnExists(c, 'lesson_bookings', 'requested_instructor_id'), 'ALTER TABLE lesson_bookings ADD COLUMN requested_instructor_id BIGINT UNSIGNED NULL'],
  ['tenants.online_booking', (c) => columnExists(c, 'tenants', 'online_booking'), 'ALTER TABLE tenants ADD COLUMN online_booking TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.booking_notice_hours', (c) => columnExists(c, 'tenants', 'booking_notice_hours'), 'ALTER TABLE tenants ADD COLUMN booking_notice_hours SMALLINT UNSIGNED NOT NULL DEFAULT 12'],
  ['tenants.booking_message', (c) => columnExists(c, 'tenants', 'booking_message'), 'ALTER TABLE tenants ADD COLUMN booking_message VARCHAR(500) NULL'],
  ['tenants.cancel_hours', (c) => columnExists(c, 'tenants', 'cancel_hours'), 'ALTER TABLE tenants ADD COLUMN cancel_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24'],
  ['lesson_bookings.request_id', (c) => columnExists(c, 'lesson_bookings', 'request_id'), 'ALTER TABLE lesson_bookings ADD COLUMN request_id BIGINT UNSIGNED NULL'],
  ['lesson_requests.amount_cents', (c) => columnExists(c, 'lesson_requests', 'amount_cents'), 'ALTER TABLE lesson_requests ADD COLUMN amount_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['lesson_requests.stripe_session_id', (c) => columnExists(c, 'lesson_requests', 'stripe_session_id'), 'ALTER TABLE lesson_requests ADD COLUMN stripe_session_id VARCHAR(120) NULL'],
  ['lesson_requests.payment_intent', (c) => columnExists(c, 'lesson_requests', 'payment_intent'), 'ALTER TABLE lesson_requests ADD COLUMN payment_intent VARCHAR(120) NULL'],
  ['lesson_requests.order_id', (c) => columnExists(c, 'lesson_requests', 'order_id'), 'ALTER TABLE lesson_requests ADD COLUMN order_id BIGINT UNSIGNED NULL'],
  ['lesson_requests.refund_cents', (c) => columnExists(c, 'lesson_requests', 'refund_cents'), 'ALTER TABLE lesson_requests ADD COLUMN refund_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['lesson_requests.policy_accepted', (c) => columnExists(c, 'lesson_requests', 'policy_accepted'), 'ALTER TABLE lesson_requests ADD COLUMN policy_accepted TINYINT(1) NOT NULL DEFAULT 0'],
  ['lesson_requests.status awaiting_payment', async (c) => (await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lesson_requests' AND column_name = 'status' AND column_type LIKE '%awaiting_payment%'"))[0].length > 0,
    "ALTER TABLE lesson_requests MODIFY COLUMN status ENUM('pending','confirmed','declined','cancelled','awaiting_payment','expired') NOT NULL DEFAULT 'pending'"],
  // Online shop: the guest page for tickets and passes. Off until a manager turns it on; each product is also opt-in.
  ['tenants.weekly_report', (c) => columnExists(c, 'tenants', 'weekly_report'), 'ALTER TABLE tenants ADD COLUMN weekly_report TINYINT(1) NOT NULL DEFAULT 1'],
  // Selling rules: which weekdays a product is sold (bit per day, Sunday = 1) and the most tickets for one day.
  ['products.sale_days', (c) => columnExists(c, 'products', 'sale_days'), 'ALTER TABLE products ADD COLUMN sale_days SMALLINT UNSIGNED NULL'],
  ['products.online_daily_limit', (c) => columnExists(c, 'products', 'online_daily_limit'), 'ALTER TABLE products ADD COLUMN online_daily_limit INT UNSIGNED NULL'],
  ['products.advance_days', (c) => columnExists(c, 'products', 'advance_days'), 'ALTER TABLE products ADD COLUMN advance_days SMALLINT UNSIGNED NULL'],
  ['products.advance_percent', (c) => columnExists(c, 'products', 'advance_percent'), 'ALTER TABLE products ADD COLUMN advance_percent TINYINT UNSIGNED NULL'],
  ['shop_orders.recovery_sent_at', (c) => columnExists(c, 'shop_orders', 'recovery_sent_at'), 'ALTER TABLE shop_orders ADD COLUMN recovery_sent_at TIMESTAMP NULL'],
  ['shop_orders.reminder_sent_at', (c) => columnExists(c, 'shop_orders', 'reminder_sent_at'), 'ALTER TABLE shop_orders ADD COLUMN reminder_sent_at TIMESTAMP NULL'],
  ['shop_orders.thanks_sent_at', (c) => columnExists(c, 'shop_orders', 'thanks_sent_at'), 'ALTER TABLE shop_orders ADD COLUMN thanks_sent_at TIMESTAMP NULL'],
  ['tenants.shop_recovery', (c) => columnExists(c, 'tenants', 'shop_recovery'), 'ALTER TABLE tenants ADD COLUMN shop_recovery TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.shop_change_hours', (c) => columnExists(c, 'tenants', 'shop_change_hours'), 'ALTER TABLE tenants ADD COLUMN shop_change_hours SMALLINT UNSIGNED NULL'],
  ['tenants.shop_change_fee_cents', (c) => columnExists(c, 'tenants', 'shop_change_fee_cents'), 'ALTER TABLE tenants ADD COLUMN shop_change_fee_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['users.mfa_failures', (c) => columnExists(c, 'users', 'mfa_failures'), 'ALTER TABLE users ADD COLUMN mfa_failures TINYINT UNSIGNED NOT NULL DEFAULT 0'],
  ['users.mfa_locked_until', (c) => columnExists(c, 'users', 'mfa_locked_until'), 'ALTER TABLE users ADD COLUMN mfa_locked_until DATETIME NULL'],
  ['platform_audit.actor', (c) => columnExists(c, 'platform_audit', 'actor'), 'ALTER TABLE platform_audit ADD COLUMN actor VARCHAR(100) NULL AFTER action'],
  ['order_items.line_kind fee', (c) => columnTypeHas(c, 'order_items', 'line_kind', "'fee'"), "ALTER TABLE order_items MODIFY line_kind ENUM('ticket','lesson','rental','program','gift_card','fee') NOT NULL DEFAULT 'ticket'"],
  ['order_items.label', (c) => columnExists(c, 'order_items', 'label'), 'ALTER TABLE order_items ADD COLUMN label VARCHAR(80) NULL'],
  ['shop_changes.basis_cents', (c) => columnExists(c, 'shop_changes', 'basis_cents'), 'ALTER TABLE shop_changes ADD COLUMN basis_cents INT UNSIGNED NULL'],
  ['order_refunds card status', (c) => columnExists(c, 'order_refunds', 'card_status'), [
    "ALTER TABLE order_refunds ADD COLUMN card_status ENUM('pending','sent','failed') NULL, ADD COLUMN card_ref VARCHAR(255) NULL, ADD COLUMN card_key VARCHAR(100) NULL, ADD COLUMN card_error VARCHAR(255) NULL, ADD COLUMN card_refund_id VARCHAR(255) NULL",
  ]],
  ['order_refunds.till_id', (c) => columnExists(c, 'order_refunds', 'till_id'), 'ALTER TABLE order_refunds ADD COLUMN till_id BIGINT UNSIGNED NULL'],
  ['tenants.quick_sale', (c) => columnExists(c, 'tenants', 'quick_sale'), 'ALTER TABLE tenants ADD COLUMN quick_sale TINYINT(1) NOT NULL DEFAULT 1'],
  ['shop_orders.promo_code', (c) => columnExists(c, 'shop_orders', 'promo_code'), 'ALTER TABLE shop_orders ADD COLUMN promo_code VARCHAR(40) NULL'],
  ['scans index by ticket', (c) => indexExists(c, 'scans', 'ix_scans_ticket'), 'ALTER TABLE scans ADD INDEX ix_scans_ticket (tenant_id, ticket_id)'],
  ['tickets index by end date', (c) => indexExists(c, 'tickets', 'ix_tickets_valid_to'), 'ALTER TABLE tickets ADD INDEX ix_tickets_valid_to (tenant_id, valid_to)'],
  ['tenants.online_daily_limit', (c) => columnExists(c, 'tenants', 'online_daily_limit'), 'ALTER TABLE tenants ADD COLUMN online_daily_limit INT UNSIGNED NULL'],
  ['tenants.online_shop', (c) => columnExists(c, 'tenants', 'online_shop'), 'ALTER TABLE tenants ADD COLUMN online_shop TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.shop_message', (c) => columnExists(c, 'tenants', 'shop_message'), 'ALTER TABLE tenants ADD COLUMN shop_message VARCHAR(500) NULL'],
  ['products.online', (c) => columnExists(c, 'products', 'online'), 'ALTER TABLE products ADD COLUMN online TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.online_payment', (c) => columnExists(c, 'tenants', 'online_payment'), 'ALTER TABLE tenants ADD COLUMN online_payment TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.refund_full_hours', (c) => columnExists(c, 'tenants', 'refund_full_hours'), 'ALTER TABLE tenants ADD COLUMN refund_full_hours SMALLINT UNSIGNED NOT NULL DEFAULT 48'],
  ['tenants.refund_half_hours', (c) => columnExists(c, 'tenants', 'refund_half_hours'), 'ALTER TABLE tenants ADD COLUMN refund_half_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24'],
  ['tenants.refund_half_percent', (c) => columnExists(c, 'tenants', 'refund_half_percent'), 'ALTER TABLE tenants ADD COLUMN refund_half_percent TINYINT UNSIGNED NOT NULL DEFAULT 50'],
  ['tenants.cancel_note', (c) => columnExists(c, 'tenants', 'cancel_note'), 'ALTER TABLE tenants ADD COLUMN cancel_note VARCHAR(500) NULL'],
  ['users.totp_secret', (c) => columnExists(c, 'users', 'totp_secret'), 'ALTER TABLE users ADD COLUMN totp_secret VARCHAR(255) NULL'],
  ['users.totp_enabled', (c) => columnExists(c, 'users', 'totp_enabled'), 'ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0'],
  ['users.totp_last_step', (c) => columnExists(c, 'users', 'totp_last_step'), 'ALTER TABLE users ADD COLUMN totp_last_step BIGINT NULL'],
  ['people.height_in', (c) => columnExists(c, 'people', 'height_in'), 'ALTER TABLE people ADD COLUMN height_in SMALLINT UNSIGNED NULL'],
  ['people.weight_lb', (c) => columnExists(c, 'people', 'weight_lb'), 'ALTER TABLE people ADD COLUMN weight_lb SMALLINT UNSIGNED NULL'],
  ['people.boot_size', (c) => columnExists(c, 'people', 'boot_size'), 'ALTER TABLE people ADD COLUMN boot_size VARCHAR(10) NULL'],
  ['people.stance', (c) => columnExists(c, 'people', 'stance'), "ALTER TABLE people ADD COLUMN stance ENUM('regular','goofy') NULL"],
  ['people.skier_type', (c) => columnExists(c, 'people', 'skier_type'), 'ALTER TABLE people ADD COLUMN skier_type VARCHAR(4) NULL'],
  ['people.photo', (c) => columnExists(c, 'people', 'photo'), 'ALTER TABLE people ADD COLUMN photo MEDIUMTEXT NULL'],
  ['waivers.signed_by_person_id', (c) => columnExists(c, 'waivers', 'signed_by_person_id'), 'ALTER TABLE waivers ADD COLUMN signed_by_person_id BIGINT UNSIGNED NULL'],
  ['waivers.signed_by_name', (c) => columnExists(c, 'waivers', 'signed_by_name'), 'ALTER TABLE waivers ADD COLUMN signed_by_name VARCHAR(200) NULL'],
  ['waivers.signer_relation', (c) => columnExists(c, 'waivers', 'signer_relation'), 'ALTER TABLE waivers ADD COLUMN signer_relation VARCHAR(40) NULL'],
  ['waivers.text_sha', (c) => columnExists(c, 'waivers', 'text_sha'), 'ALTER TABLE waivers ADD COLUMN text_sha CHAR(64) NULL'],
  ['orders.tax_cents', (c) => columnExists(c, 'orders', 'tax_cents'), 'ALTER TABLE orders ADD COLUMN tax_cents INT UNSIGNED NOT NULL DEFAULT 0 AFTER total_cents'],
  ['orders.refunded_cents', (c) => columnExists(c, 'orders', 'refunded_cents'), 'ALTER TABLE orders ADD COLUMN refunded_cents INT UNSIGNED NOT NULL DEFAULT 0 AFTER tax_cents'],
  ['orders.user_id', (c) => columnExists(c, 'orders', 'user_id'), 'ALTER TABLE orders ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER refunded_cents'],
  ['order_items.discount_cents', (c) => columnExists(c, 'order_items', 'discount_cents'), 'ALTER TABLE order_items ADD COLUMN discount_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['order_items.tax_cents', (c) => columnExists(c, 'order_items', 'tax_cents'), 'ALTER TABLE order_items ADD COLUMN tax_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['order_items.refunded_at', (c) => columnExists(c, 'order_items', 'refunded_at'), 'ALTER TABLE order_items ADD COLUMN refunded_at TIMESTAMP NULL'],
  ['order_items.refund_id', (c) => columnExists(c, 'order_items', 'refund_id'), 'ALTER TABLE order_items ADD COLUMN refund_id BIGINT UNSIGNED NULL'],
  ['order_payments.tender comp', async (c) => (await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'order_payments' AND column_name = 'tender' AND column_type LIKE '%comp%'"))[0].length > 0,
    "ALTER TABLE order_payments MODIFY COLUMN tender ENUM('cash','card','gift_card','other','comp') NOT NULL"],
  ['order_payments.card_brand', (c) => columnExists(c, 'order_payments', 'card_brand'), 'ALTER TABLE order_payments ADD COLUMN card_brand VARCHAR(20) NULL'],
  ['order_payments.card_last4', (c) => columnExists(c, 'order_payments', 'card_last4'), 'ALTER TABLE order_payments ADD COLUMN card_last4 CHAR(4) NULL'],
  ['order_payments.auth_code', (c) => columnExists(c, 'order_payments', 'auth_code'), 'ALTER TABLE order_payments ADD COLUMN auth_code VARCHAR(30) NULL'],
  ['order_payments.processor', (c) => columnExists(c, 'order_payments', 'processor'), 'ALTER TABLE order_payments ADD COLUMN processor VARCHAR(30) NULL'],
  ['order_payments.comp_reason', (c) => columnExists(c, 'order_payments', 'comp_reason'), 'ALTER TABLE order_payments ADD COLUMN comp_reason VARCHAR(40) NULL'],
  ['scans.result duplicate', async (c) => (await c.query("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'scans' AND column_name = 'result' AND column_type LIKE '%duplicate%'"))[0].length > 0,
    "ALTER TABLE scans MODIFY COLUMN result ENUM('ok','expired','not_yet_valid','void','no_uses','unknown','duplicate') NOT NULL"],
  ['people.phone_key', (c) => columnExists(c, 'people', 'phone_key'), "ALTER TABLE people ADD COLUMN phone_key VARCHAR(10) GENERATED ALWAYS AS (NULLIF(RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10), '')) STORED AFTER phone"],
  ['people phone_key index', (c) => indexExists(c, 'people', 'ix_people_phone_key'), 'ALTER TABLE people ADD KEY ix_people_phone_key (tenant_id, phone_key)'],
];

/** Ski season label, same rule as the API: August to July, labeled 2026-27. */
function seasonOf(dateTime) {
  const [y, m] = String(dateTime).slice(0, 10).split('-').map(Number);
  const start = m >= 8 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Give every report that predates case numbers one, in the order it was filed. */
// Time clock kiosk: how each punch was made, and the per-mountain snapshot settings (snapshots stay off until a manager turns them on).
const kioskSteps = [
  ['time_entries.in_method', (c) => columnExists(c, 'time_entries', 'in_method'), "ALTER TABLE time_entries ADD COLUMN in_method ENUM('login','pin','badge','manager') NULL"],
  ['time_entries.out_method', (c) => columnExists(c, 'time_entries', 'out_method'), "ALTER TABLE time_entries ADD COLUMN out_method ENUM('login','pin','badge','manager') NULL"],
  ['time_entries.in_device_id', (c) => columnExists(c, 'time_entries', 'in_device_id'), 'ALTER TABLE time_entries ADD COLUMN in_device_id BIGINT UNSIGNED NULL'],
  ['time_entries.out_device_id', (c) => columnExists(c, 'time_entries', 'out_device_id'), 'ALTER TABLE time_entries ADD COLUMN out_device_id BIGINT UNSIGNED NULL'],
  ['tenants.kiosk_photos', (c) => columnExists(c, 'tenants', 'kiosk_photos'), 'ALTER TABLE tenants ADD COLUMN kiosk_photos TINYINT(1) NOT NULL DEFAULT 0'],
  ['tenants.kiosk_photo_days', (c) => columnExists(c, 'tenants', 'kiosk_photo_days'), 'ALTER TABLE tenants ADD COLUMN kiosk_photo_days SMALLINT UNSIGNED NOT NULL DEFAULT 30'],
];

// Waivers signed on a screen: who signed, for whom, and the ability to void one or ask everyone to sign again.
const waiverSteps = [
  ['waivers.signing_id', (c) => columnExists(c, 'waivers', 'signing_id'), 'ALTER TABLE waivers ADD COLUMN signing_id BIGINT UNSIGNED NULL'],
  ['waivers.method', (c) => columnExists(c, 'waivers', 'method'), "ALTER TABLE waivers ADD COLUMN method ENUM('signed_online','signed_counter','accepted_online','recorded_by_staff') NULL"],
  ['waivers.voided', (c) => columnExists(c, 'waivers', 'voided_at'), 'ALTER TABLE waivers ADD COLUMN voided_at TIMESTAMP NULL, ADD COLUMN void_reason VARCHAR(300) NULL, ADD COLUMN voided_by BIGINT UNSIGNED NULL'],
  ['waivers.recorded_by', (c) => columnExists(c, 'waivers', 'recorded_by'), 'ALTER TABLE waivers ADD COLUMN recorded_by BIGINT UNSIGNED NULL'],
  ['tenants.waiver_resign_at', (c) => columnExists(c, 'tenants', 'waiver_resign_at'), 'ALTER TABLE tenants ADD COLUMN waiver_resign_at TIMESTAMP NULL'],
  ['tenants.waiver_resign_id', (c) => columnExists(c, 'tenants', 'waiver_resign_id'), 'ALTER TABLE tenants ADD COLUMN waiver_resign_id BIGINT UNSIGNED NULL'],
  ['waiver_signings.covered_names', (c) => columnExists(c, 'waiver_signings', 'covered_names'), 'ALTER TABLE waiver_signings ADD COLUMN covered_names TEXT NULL AFTER signer_dob'],
  ['sandbox_signups usage', (c) => columnExists(c, 'sandbox_signups', 'last_used_at'), 'ALTER TABLE sandbox_signups ADD COLUMN first_used_at DATETIME NULL, ADD COLUMN last_used_at DATETIME NULL, ADD COLUMN sign_ins INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN requests INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN changes INT UNSIGNED NULL, ADD COLUMN ended_at DATETIME NULL'],
  ['waivers index by signing', (c) => indexExists(c, 'waivers', 'ix_waivers_signing'), 'ALTER TABLE waivers ADD INDEX ix_waivers_signing (tenant_id, signing_id)'],
];

// Patrol access levels. Existing roster ranks carry over: director -> admin, leader -> manager, everyone else -> patrol.
const accessSteps = [
  ['patrol_members.access_level', (c) => columnExists(c, 'patrol_members', 'access_level'), [
    "ALTER TABLE patrol_members ADD COLUMN access_level ENUM('admin','manager','approver','patrol','host') NOT NULL DEFAULT 'patrol'",
    "UPDATE patrol_members SET access_level = CASE level WHEN 'director' THEN 'admin' WHEN 'leader' THEN 'manager' ELSE 'patrol' END",
  ]],
];

// Patient care: rows are marked "entered in error" instead of deleted, entries carry the time they were typed in (so late
// entries show), vitals keep the parts of the GCS and each pupil, treatments carry structured details (CMS checks, oxygen,
// medication), the next vitals check lives on the patient, the receiving provider signs, and each submitted or approved
// report is kept as a frozen copy.
const tableExists = (c, t) => has(c, 'SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]);
const VOID_COLS = 'ADD COLUMN voided_at DATETIME NULL, ADD COLUMN void_reason VARCHAR(255) NULL, ADD COLUMN voided_by BIGINT UNSIGNED NULL';
const careSteps = [
  ['incident_vitals care columns', (c) => columnExists(c, 'incident_vitals', 'gcs_e'), `ALTER TABLE incident_vitals ADD COLUMN gcs_e TINYINT UNSIGNED NULL, ADD COLUMN gcs_v TINYINT UNSIGNED NULL, ADD COLUMN gcs_m TINYINT UNSIGNED NULL, ADD COLUMN pupil_left VARCHAR(30) NULL, ADD COLUMN pupil_right VARCHAR(30) NULL, ADD COLUMN entered_at DATETIME NULL, ${VOID_COLS}`],
  ['incident_injuries entered in error', (c) => columnExists(c, 'incident_injuries', 'voided_at'), `ALTER TABLE incident_injuries ${VOID_COLS}`],
  ['incident_treatments care columns', (c) => columnExists(c, 'incident_treatments', 'detail'), `ALTER TABLE incident_treatments ADD COLUMN detail TEXT NULL, ADD COLUMN entered_at DATETIME NULL, ${VOID_COLS}`],
  ['incident_treatments.kind rosc', (c) => columnTypeHas(c, 'incident_treatments', 'kind', "'rosc'"), "ALTER TABLE incident_treatments MODIFY kind ENUM('splint','spinal_motion_restriction','bandage','ice','oxygen','aed','cpr','airway','medication','warming','rosc','other') NOT NULL"],
  ['incident_events care columns', (c) => columnExists(c, 'incident_events', 'voided_at'), `ALTER TABLE incident_events ADD COLUMN entered_at DATETIME NULL, ${VOID_COLS}`],
  ['incident_patients care columns', (c) => columnExists(c, 'incident_patients', 'voided_at'), `ALTER TABLE incident_patients ADD COLUMN vitals_due_at DATETIME NULL, ${VOID_COLS}`],
  ['incident_signatures.signer_role', (c) => columnExists(c, 'incident_signatures', 'signer_role'), 'ALTER TABLE incident_signatures ADD COLUMN signer_role VARCHAR(150) NULL'],
  ['incident_signatures.kind receiving_provider', (c) => columnTypeHas(c, 'incident_signatures', 'kind', "'receiving_provider'"), "ALTER TABLE incident_signatures MODIFY kind ENUM('refusal_of_care','patient_acknowledgment','witness','patroller','receiving_provider') NOT NULL"],
  ['patrol_members.patrol_number', (c) => columnExists(c, 'patrol_members', 'patrol_number'), 'ALTER TABLE patrol_members ADD COLUMN patrol_number VARCHAR(20) NULL'],
  ['incident_versions', (c) => tableExists(c, 'incident_versions'), `CREATE TABLE incident_versions (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    incident_id BIGINT UNSIGNED NOT NULL,
    version_no  INT UNSIGNED NOT NULL,
    kind        ENUM('submitted','approved') NOT NULL,
    snapshot    MEDIUMTEXT NOT NULL,
    created_by  BIGINT UNSIGNED NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_iversions (tenant_id, incident_id, version_no),
    CONSTRAINT fk_iversions_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
  ) ENGINE=InnoDB`],
  // An entry sent again by a phone that lost its signal mid-send is recognized by the id the phone gave it, and saved once.
  ['care entries client_ref', (c) => columnExists(c, 'incident_vitals', 'client_ref'), [
    'ALTER TABLE incident_vitals ADD COLUMN client_ref VARCHAR(40) NULL, ADD UNIQUE KEY uq_ivitals_ref (tenant_id, client_ref)',
    'ALTER TABLE incident_injuries ADD COLUMN client_ref VARCHAR(40) NULL, ADD UNIQUE KEY uq_iinjuries_ref (tenant_id, client_ref)',
    'ALTER TABLE incident_treatments ADD COLUMN client_ref VARCHAR(40) NULL, ADD UNIQUE KEY uq_itreat_ref (tenant_id, client_ref)',
    'ALTER TABLE incident_events ADD COLUMN client_ref VARCHAR(40) NULL, ADD UNIQUE KEY uq_ievents_ref (tenant_id, client_ref)',
  ]],
  ['incident_events.patient_id', (c) => columnExists(c, 'incident_events', 'patient_id'), 'ALTER TABLE incident_events ADD COLUMN patient_id BIGINT UNSIGNED NULL'],
  ['incident_versions index', (c) => indexExists(c, 'incident_versions', 'ix_iversions_incident'), 'ALTER TABLE incident_versions ADD INDEX ix_iversions_incident (tenant_id, incident_id, created_at)'],
];

// Assets and fleet: the register grows into a full record (tag, place, parent part, year, VIN, plate, purchase, warranty,
// registration, insurance and inspection dates, miles); service plans can count miles and link to their work orders;
// work orders carry the meter reading, outside vendor cost and the plan they came from.
const assetCol = (name, ddl) => [`ops_assets.${name}`, (c) => columnExists(c, 'ops_assets', name), `ALTER TABLE ops_assets ADD COLUMN ${ddl}`];
const assetSteps = [
  assetCol('asset_tag', 'asset_tag VARCHAR(20) NULL'),
  ['ops_assets unique tag', (c) => indexExists(c, 'ops_assets', 'uq_ops_asset_tag'), 'ALTER TABLE ops_assets ADD UNIQUE KEY uq_ops_asset_tag (tenant_id, asset_tag)'],
  assetCol('category', "category ENUM('fleet','lift','snowmaking','facility','equipment','other') NULL"),
  assetCol('parent_id', 'parent_id BIGINT UNSIGNED NULL'),
  assetCol('location_id', 'location_id BIGINT UNSIGNED NULL'),
  assetCol('lift_id', 'lift_id BIGINT UNSIGNED NULL'),
  assetCol('model_year', 'model_year SMALLINT UNSIGNED NULL'),
  assetCol('vin', 'vin VARCHAR(40) NULL'),
  assetCol('plate', 'plate VARCHAR(20) NULL'),
  assetCol('miles', 'miles DECIMAL(10,1) NULL'),
  assetCol('fuel_type', "fuel_type ENUM('diesel','gasoline','propane','electric','other','none') NULL"),
  assetCol('purchased_on', 'purchased_on DATE NULL'),
  assetCol('purchase_cents', 'purchase_cents BIGINT UNSIGNED NULL'),
  assetCol('vendor_id', 'vendor_id BIGINT UNSIGNED NULL'),
  assetCol('useful_life_years', 'useful_life_years TINYINT UNSIGNED NULL'),
  assetCol('salvage_cents', 'salvage_cents BIGINT UNSIGNED NULL'),
  assetCol('warranty_expires', 'warranty_expires DATE NULL'),
  assetCol('warranty_note', 'warranty_note VARCHAR(255) NULL'),
  assetCol('registration_expires', 'registration_expires DATE NULL'),
  assetCol('insurance_expires', 'insurance_expires DATE NULL'),
  assetCol('inspection_expires', 'inspection_expires DATE NULL'),
  assetCol('critical', 'critical TINYINT(1) NOT NULL DEFAULT 0'),
  assetCol('retired_on', 'retired_on DATE NULL'),
  ['pm_tasks miles', (c) => columnExists(c, 'pm_tasks', 'interval_miles'), 'ALTER TABLE pm_tasks ADD COLUMN interval_miles DECIMAL(9,1) NULL, ADD COLUMN last_done_miles DECIMAL(10,1) NULL, ADD COLUMN checklist VARCHAR(2000) NULL'],
  ['work_orders asset costs', (c) => columnExists(c, 'work_orders', 'pm_task_id'), 'ALTER TABLE work_orders ADD COLUMN pm_task_id BIGINT UNSIGNED NULL, ADD COLUMN meter_hours DECIMAL(10,1) NULL, ADD COLUMN meter_miles DECIMAL(10,1) NULL, ADD COLUMN vendor_id BIGINT UNSIGNED NULL, ADD COLUMN vendor_cost_cents INT UNSIGNED NULL, ADD COLUMN downtime_hours DECIMAL(7,1) NULL'],
  ['work_orders by asset', (c) => indexExists(c, 'work_orders', 'ix_wo_asset'), 'ALTER TABLE work_orders ADD INDEX ix_wo_asset (tenant_id, asset_id, status)'],
  // Labor is now the sum of logged entries, which can pass 9,999.9 hours on a long job.
  ['work_orders labor width', (c) => columnTypeHas(c, 'work_orders', 'labor_hours', '8,1'), 'ALTER TABLE work_orders MODIFY labor_hours DECIMAL(8,1) NULL'],
  // A plan is marked done once per work order, even if the order is reopened and completed again.
  ['pm_log work order', (c) => columnExists(c, 'pm_log', 'work_order_id'), 'ALTER TABLE pm_log ADD COLUMN work_order_id BIGINT UNSIGNED NULL, ADD UNIQUE KEY uq_pm_log_wo (tenant_id, work_order_id)'],
];

// Gate: a scan remembers the card and the device it came from, and a device's own id for it, so a scan sent twice
// (from a gate that was offline) is saved once.
// Patrol operations (2026.10.11): trail holds, certification level, equipment expiry and oxygen, legal hold, offline
// case starts, responder alerts, tourniquet and pelvic binder.
// Security hardening: password lockout per login, and a date after which a closed mountain's data is deleted.
const securitySteps = [
  ['users.login_failures', (c) => columnExists(c, 'users', 'login_failures'), 'ALTER TABLE users ADD COLUMN login_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN login_locked_until DATETIME NULL'],
  ['tenants.delete_after', (c) => columnExists(c, 'tenants', 'delete_after'), 'ALTER TABLE tenants ADD COLUMN closed_at DATETIME NULL, ADD COLUMN delete_after DATE NULL'],
  // A closed mountain is never deleted by the daily job: it is marked due, and an operator deletes it (keeping its records).
  ['tenants.delete_due_at', (c) => columnExists(c, 'tenants', 'delete_due_at'), 'ALTER TABLE tenants ADD COLUMN delete_due_at DATETIME NULL, ADD COLUMN data_deleted_at DATETIME NULL'],
  // 2026.10.17: how each session was opened (password, two-step, passkey, emailed code or PIN), on which device or
  // terminal, and when the person last proved it was them for a sensitive action.
  ['user_sessions.method', (c) => columnExists(c, 'user_sessions', 'method'), "ALTER TABLE user_sessions ADD COLUMN method VARCHAR(12) NOT NULL DEFAULT 'password', ADD COLUMN device_hash CHAR(64) NULL, ADD COLUMN terminal_id BIGINT UNSIGNED NULL, ADD COLUMN stepped_up_at DATETIME NULL"],
  // 2026.10.28: a session turned into a display screen (the patrol-room screen) is locked to what that screen shows.
  ['user_sessions.display', (c) => columnExists(c, 'user_sessions', 'display'), 'ALTER TABLE user_sessions ADD COLUMN display VARCHAR(20) NULL'],
  ['users.pin_hash', (c) => columnExists(c, 'users', 'pin_hash'), 'ALTER TABLE users ADD COLUMN pin_hash VARCHAR(100) NULL, ADD COLUMN pin_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN pin_locked_until DATETIME NULL'],
  ['users.access_ends_on', (c) => columnExists(c, 'users', 'access_ends_on'), 'ALTER TABLE users ADD COLUMN access_ends_on DATE NULL'],
  // 2026.10.18: the ski area's free read-only login for a patrol on Verdynt/OS Patrol.
  ['site_leads patrol kind', (c) => columnTypeHas(c, 'site_leads', 'kind', "'patrol'"), "ALTER TABLE site_leads MODIFY kind ENUM('walkthrough','trial','founding','question','patrol') NOT NULL DEFAULT 'walkthrough'"],
  ['users.role area', (c) => columnTypeHas(c, 'users', 'role', "'area'"), "ALTER TABLE users MODIFY role ENUM('owner','manager','staff','patrol','instructor','counter','area') NOT NULL DEFAULT 'staff'"],
  // Patrollers must use two-step too; mountains that already exist get two weeks before it is enforced.
  ['tenants.mfa_for_patrol', (c) => columnExists(c, 'tenants', 'mfa_for_patrol'), [
    'ALTER TABLE tenants ADD COLUMN mfa_for_patrol TINYINT(1) NOT NULL DEFAULT 1, ADD COLUMN patrol_mfa_from DATE NULL, ADD COLUMN season_ends_on DATE NULL',
    'UPDATE tenants SET patrol_mfa_from = DATE_ADD(CURDATE(), INTERVAL 14 DAY)',
  ]],
  // Wrong codes per login per day: after 50 in a day, signing in with an emailed code stops for that login until a full
  // sign-in another way (password and its second step, or a passkey) or a manager or operator reset.
  ['users.codes_blocked_at', (c) => columnExists(c, 'users', 'codes_blocked_at'), 'ALTER TABLE users ADD COLUMN code_day_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN code_day_from DATETIME NULL, ADD COLUMN codes_blocked_at DATETIME NULL'],
];
// 2026.10.22: Stripe Connect. Each mountain's guest card payments go to its own Stripe account (a Standard account it
// controls), with an optional platform fee per mountain, 0 unless the console sets one.
const connectSteps = [
  ['tenants.stripe_account', (c) => columnExists(c, 'tenants', 'stripe_account'), 'ALTER TABLE tenants ADD COLUMN stripe_account VARCHAR(64) NULL, ADD COLUMN stripe_charges_enabled TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN stripe_payouts_enabled TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN stripe_details_submitted TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN stripe_connected_at DATETIME NULL, ADD COLUMN stripe_checked_at DATETIME NULL, ADD UNIQUE KEY uq_tenants_stripe_account (stripe_account)'],
  ['tenants.platform_fee_bps', (c) => columnExists(c, 'tenants', 'platform_fee_bps'), 'ALTER TABLE tenants ADD COLUMN platform_fee_bps SMALLINT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN platform_fee_cents SMALLINT UNSIGNED NOT NULL DEFAULT 0'],
  ['order_payments.processor_account', (c) => columnExists(c, 'order_payments', 'processor_account'), 'ALTER TABLE order_payments ADD COLUMN processor_account VARCHAR(64) NULL, ADD COLUMN platform_fee_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['order_refunds.card_account', (c) => columnExists(c, 'order_refunds', 'card_account'), 'ALTER TABLE order_refunds ADD COLUMN card_account VARCHAR(64) NULL'],
  ['donations.stripe_account', (c) => columnExists(c, 'donations', 'stripe_account'), 'ALTER TABLE donations ADD COLUMN stripe_account VARCHAR(64) NULL'],
];
// Demo sign-up email check (2026.10.28): a 6-digit code is emailed before a demo is built, so every demo lead is a real,
// reachable address. Codes are kept hashed and expire after 15 minutes.
const trySteps = [
  ['sandbox_codes', (c) => tableExists(c, 'sandbox_codes'), `CREATE TABLE sandbox_codes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    code_hash CHAR(64) NOT NULL,
    ip_hash CHAR(16) NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    KEY ix_sandbox_codes_email (email, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
  ['sandbox_signups.email_verified', (c) => columnExists(c, 'sandbox_signups', 'email_verified'), 'ALTER TABLE sandbox_signups ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 0'],
];

// Card readers at the counter (2026.10.29): Stripe Terminal smart readers on each mountain's own Stripe account.
const terminalSteps = [
  ['tenants.terminal_location', (c) => columnExists(c, 'tenants', 'terminal_location'), 'ALTER TABLE tenants ADD COLUMN terminal_location VARCHAR(64) NULL, ADD COLUMN terminal_location_account VARCHAR(64) NULL'],
  ['terminal_readers', (c) => tableExists(c, 'terminal_readers'), `CREATE TABLE terminal_readers (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    stripe_reader  VARCHAR(64) NOT NULL,
    account        VARCHAR(64) NULL,
    label          VARCHAR(100) NOT NULL,
    device_type    VARCHAR(40) NULL,
    serial         VARCHAR(64) NULL,
    simulated      TINYINT(1) NOT NULL DEFAULT 0,
    active         TINYINT(1) NOT NULL DEFAULT 1,
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_terminal_reader (stripe_reader),
    KEY ix_terminal_readers_tenant (tenant_id, active)
  ) ENGINE=InnoDB`],
  ['terminal_payments', (c) => tableExists(c, 'terminal_payments'), `CREATE TABLE terminal_payments (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    reader_id      BIGINT UNSIGNED NOT NULL,
    intent         VARCHAR(64) NOT NULL,
    account        VARCHAR(64) NULL,
    amount_cents   INT UNSIGNED NOT NULL,
    fee_cents      INT UNSIGNED NOT NULL DEFAULT 0,
    status         ENUM('waiting','succeeded','failed','canceled','refunded') NOT NULL DEFAULT 'waiting',
    failure        VARCHAR(255) NULL,
    card_brand     VARCHAR(20) NULL,
    card_last4     CHAR(4) NULL,
    order_id       BIGINT UNSIGNED NULL,
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_terminal_intent (intent),
    KEY ix_terminal_payments_tenant (tenant_id, status, created_at)
  ) ENGINE=InnoDB`],
];

// Paid card pages we cannot honor: a lesson request canceled while the guest was still on Stripe's page, a lesson that
// filled, an amount that does not match, or a payment that cannot be matched to what it was for. The whole payment goes
// back, written down here as owed before it is sent (one row per payment, so a repeated Stripe event never owes it
// twice), and retried by the daily job until Stripe has it.
const cardReturnSteps = [
  ['card_returns', (c) => tableExists(c, 'card_returns'), `CREATE TABLE card_returns (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    kind             VARCHAR(20) NOT NULL,
    row_id           BIGINT UNSIGNED NULL,
    checkout_session VARCHAR(255) NULL,
    payment_intent   VARCHAR(255) NOT NULL,
    account          VARCHAR(64) NULL,
    amount_cents     INT UNSIGNED NOT NULL,
    reason           VARCHAR(300) NOT NULL,
    card_status      ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
    card_key         VARCHAR(100) NOT NULL,
    card_error       VARCHAR(255) NULL,
    card_refund_id   VARCHAR(255) NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_card_returns_intent (tenant_id, payment_intent),
    KEY ix_card_returns_status (card_status, created_at),
    KEY ix_card_returns_row (tenant_id, kind, row_id),
    CONSTRAINT fk_card_returns_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
];

// Canceling lessons (2026.10.29): a canceled lesson keeps who canceled it, when and why.
// Better pin dropping (2026.10.29): how a pin was put down (GPS, a tap on the map, a drag) and how close the GPS was.
const pinSteps = [
  ['park_placements.accuracy_m', (c) => columnExists(c, 'park_placements', 'accuracy_m'), "ALTER TABLE park_placements ADD COLUMN accuracy_m SMALLINT UNSIGNED NULL, ADD COLUMN placed_how ENUM('gps','map','drag','copy') NULL"],
];

// Guest types each mountain can edit (2026.10.29). The fixed list of five becomes a table per mountain (made with the
// same five the first time it is read), and the three columns that held a type take any code, keeping every value.
// Every night the daily job writes down how each day went: the weather (from Open-Meteo, at the mountain's map point),
// the crew's new-snow reading, whether the mountain was open, visits, tickets sold and sold ahead online, and lesson
// students. A year of these is what the visitor forecast learns from.
const dayRecordSteps = [
  ['day_records', (c) => tableExists(c, 'day_records'), `CREATE TABLE day_records (
    tenant_id        BIGINT UNSIGNED NOT NULL,
    on_date          DATE NOT NULL,
    weekday          TINYINT UNSIGNED NOT NULL,
    status           VARCHAR(10) NULL,
    high_f           DECIMAL(5,1) NULL,
    low_f            DECIMAL(5,1) NULL,
    snowfall_in      DECIMAL(5,1) NULL,
    precip_in        DECIMAL(5,2) NULL,
    wind_mph         DECIMAL(5,1) NULL,
    gust_mph         DECIMAL(5,1) NULL,
    weather_code     SMALLINT NULL,
    weather_source   VARCHAR(20) NULL,
    crew_new_snow_in DECIMAL(5,1) NULL,
    crew_base_in     DECIMAL(5,1) NULL,
    visits           INT UNSIGNED NOT NULL DEFAULT 0,
    tickets_sold     INT UNSIGNED NOT NULL DEFAULT 0,
    tickets_for_day  INT UNSIGNED NOT NULL DEFAULT 0,
    presold_online   INT UNSIGNED NOT NULL DEFAULT 0,
    lesson_students  INT UNSIGNED NOT NULL DEFAULT 0,
    revenue_cents    BIGINT NOT NULL DEFAULT 0,
    recorded_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, on_date),
    CONSTRAINT fk_day_records_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
];

// The asset map: points, lines and areas for what lies where (valves, pipes, power lines, ponds), each optionally tied to
// an asset in the register.
const mapFeatureSteps = [
  ['map_features', (c) => tableExists(c, 'map_features'), `CREATE TABLE map_features (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    kind           VARCHAR(30) NOT NULL,
    geometry       ENUM('point','line','area') NOT NULL,
    name           VARCHAR(100) NULL,
    points         MEDIUMTEXT NOT NULL,
    lat            DECIMAL(10,7) NOT NULL,
    lng            DECIMAL(10,7) NOT NULL,
    size           VARCHAR(40) NULL,
    material       VARCHAR(40) NULL,
    depth_ft       DECIMAL(5,1) NULL,
    installed_year SMALLINT UNSIGNED NULL,
    status         ENUM('in_service','out_of_service','abandoned','planned') NOT NULL DEFAULT 'in_service',
    notes          VARCHAR(1000) NULL,
    asset_id       BIGINT UNSIGNED NULL,
    accuracy_m     DECIMAL(6,1) NULL,
    placed_how     ENUM('gps','map','walk','import') NOT NULL DEFAULT 'map',
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_map_features_tenant (tenant_id, kind),
    KEY ix_map_features_asset (tenant_id, asset_id),
    CONSTRAINT fk_map_features_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
];
const programSessionSteps = [
  // A program runs as one or more sessions a season (Session 1 in January, Session 2 in February). Each session meets on
  // one or more weekdays, each its own group with its own spots (the parent picks the day), for a number of weeks, plus
  // makeup weeks that are held in reserve and only used when a meeting is canceled for weather.
  ['programs session settings', (c) => columnExists(c, 'programs', 'level_mode'), `ALTER TABLE programs
    ADD COLUMN description TEXT NULL, ADD COLUMN age_min TINYINT UNSIGNED NULL, ADD COLUMN age_max TINYINT UNSIGNED NULL,
    ADD COLUMN online TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1,
    ADD COLUMN includes_ticket TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN ticket_product_id BIGINT UNSIGNED NULL,
    ADD COLUMN includes_rental TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN rental_product_id BIGINT UNSIGNED NULL,
    ADD COLUMN sibling_mode ENUM('none','percent','amount') NOT NULL DEFAULT 'none', ADD COLUMN sibling_value INT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN level_mode ENUM('on_arrival','preset') NOT NULL DEFAULT 'on_arrival'`],
  ['program_terms', (c) => tableExists(c, 'program_terms'), `CREATE TABLE program_terms (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    program_id     BIGINT UNSIGNED NOT NULL,
    name           VARCHAR(100) NOT NULL,
    starts_on      DATE NOT NULL,
    weeks          TINYINT UNSIGNED NOT NULL,
    makeup_weeks   TINYINT UNSIGNED NOT NULL DEFAULT 1,
    start_time     TIME NOT NULL,
    end_time       TIME NOT NULL,
    price_cents    INT UNSIGNED NOT NULL,
    price_steps    TEXT NULL,
    skip_dates     TEXT NULL,
    reg_opens_on   DATE NULL,
    reg_closes_on  DATE NULL,
    status         ENUM('draft','open','closed','archived') NOT NULL DEFAULT 'draft',
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pterms_tenant_id (tenant_id, id),
    KEY ix_pterms_program (tenant_id, program_id, starts_on),
    CONSTRAINT fk_pterms_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs(tenant_id, id)
  )`],
  ['program_groups', (c) => tableExists(c, 'program_groups'), `CREATE TABLE program_groups (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    term_id        BIGINT UNSIGNED NOT NULL,
    weekday        TINYINT UNSIGNED NOT NULL,
    start_time     TIME NULL,
    end_time       TIME NULL,
    capacity       SMALLINT UNSIGNED NULL,
    price_cents    INT UNSIGNED NULL,
    coach_staff_id BIGINT UNSIGNED NULL,
    UNIQUE KEY uq_pgroups_tenant_id (tenant_id, id),
    UNIQUE KEY uq_pgroups_day (tenant_id, term_id, weekday),
    CONSTRAINT fk_pgroups_term FOREIGN KEY (tenant_id, term_id) REFERENCES program_terms(tenant_id, id)
  )`],
  ['program_levels', (c) => tableExists(c, 'program_levels'), `CREATE TABLE program_levels (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    group_id       BIGINT UNSIGNED NOT NULL,
    name           VARCHAR(60) NOT NULL,
    coach_staff_id BIGINT UNSIGNED NULL,
    sort           SMALLINT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_plevels_tenant_id (tenant_id, id),
    CONSTRAINT fk_plevels_group FOREIGN KEY (tenant_id, group_id) REFERENCES program_groups(tenant_id, id)
  )`],
  ['program_bundles', (c) => tableExists(c, 'program_bundles'), `CREATE TABLE program_bundles (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    program_id  BIGINT UNSIGNED NOT NULL,
    name        VARCHAR(100) NOT NULL,
    price_cents INT UNSIGNED NOT NULL,
    term_ids    TEXT NOT NULL,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_pbundles_tenant_id (tenant_id, id),
    CONSTRAINT fk_pbundles_program FOREIGN KEY (tenant_id, program_id) REFERENCES programs(tenant_id, id)
  )`],
  ['program_sessions meeting columns', (c) => columnExists(c, 'program_sessions', 'group_id'), `ALTER TABLE program_sessions
    ADD COLUMN term_id BIGINT UNSIGNED NULL, ADD COLUMN group_id BIGINT UNSIGNED NULL,
    ADD COLUMN kind ENUM('regular','makeup','extra') NOT NULL DEFAULT 'regular',
    ADD COLUMN status ENUM('scheduled','standby','cancelled') NOT NULL DEFAULT 'scheduled',
    ADD COLUMN cancel_reason VARCHAR(255) NULL, ADD COLUMN cancelled_at DATETIME NULL,
    ADD KEY ix_psessions_group (tenant_id, group_id, starts_at), ADD KEY ix_psessions_day (tenant_id, starts_at)`],
  ['program_enrollments session columns', (c) => columnExists(c, 'program_enrollments', 'group_id'), `ALTER TABLE program_enrollments
    ADD COLUMN term_id BIGINT UNSIGNED NULL, ADD COLUMN group_id BIGINT UNSIGNED NULL, ADD COLUMN level_id BIGINT UNSIGNED NULL,
    ADD COLUMN bundle_id BIGINT UNSIGNED NULL, ADD COLUMN any_day TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN price_cents INT UNSIGNED NULL, ADD COLUMN discount_cents INT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN order_id BIGINT UNSIGNED NULL, ADD COLUMN ticket_id BIGINT UNSIGNED NULL,
    ADD COLUMN term_key BIGINT UNSIGNED AS (IFNULL(term_id, 0)) STORED,
    ADD KEY ix_penroll_group (tenant_id, group_id, status)`],
  // One place per person per session (a program without sessions keeps one place per person, as before).
  ['program_enrollments one per session', (c) => indexExists(c, 'program_enrollments', 'uq_enrollment_term'), [
    'ALTER TABLE program_enrollments ADD UNIQUE KEY uq_enrollment_term (tenant_id, program_id, term_key, person_id)',
    'ALTER TABLE program_enrollments DROP INDEX uq_enrollment',
  ]],
  ['program_registrations', (c) => tableExists(c, 'program_registrations'), `CREATE TABLE program_registrations (
    id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id         BIGINT UNSIGNED NOT NULL,
    reference         VARCHAR(12) NOT NULL,
    view_token        CHAR(32) NOT NULL,
    contact_name      VARCHAR(150) NOT NULL,
    contact_email     VARCHAR(255) NOT NULL,
    contact_phone     VARCHAR(40) NOT NULL,
    basket            MEDIUMTEXT NOT NULL,
    amount_cents      INT UNSIGNED NOT NULL,
    waiver_accepted   TINYINT(1) NOT NULL DEFAULT 0,
    status            ENUM('awaiting_payment','paid','expired','refunded') NOT NULL DEFAULT 'awaiting_payment',
    stripe_session_id VARCHAR(255) NULL,
    payment_intent    VARCHAR(255) NULL,
    order_id          BIGINT UNSIGNED NULL,
    note              VARCHAR(300) NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at           DATETIME NULL,
    UNIQUE KEY uq_preg_ref (tenant_id, reference),
    UNIQUE KEY uq_preg_token (view_token),
    CONSTRAINT fk_preg_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
];
const programPlusSteps = [
  // Program types each mountain names for itself (Multi-week lessons, Race team, Homeschool...), in place of the fixed kinds.
  ['program_types', (c) => tableExists(c, 'program_types'), `CREATE TABLE program_types (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(60) NOT NULL,
    sort_no    SMALLINT NOT NULL DEFAULT 0,
    hidden     TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE KEY uq_ptypes_name (tenant_id, name),
    UNIQUE KEY uq_ptypes_tenant_id (tenant_id, id),
    CONSTRAINT fk_ptypes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
  ['programs best of breed', (c) => columnExists(c, 'programs', 'type_id'), `ALTER TABLE programs
    ADD COLUMN type_id BIGINT UNSIGNED NULL, ADD COLUMN offers_helmet TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN meeting_place VARCHAR(160) NULL, ADD COLUMN what_to_bring VARCHAR(300) NULL, ADD COLUMN policy_text VARCHAR(1000) NULL,
    ADD COLUMN cancel_days SMALLINT UNSIGNED NULL, ADD COLUMN cancel_fee_cents INT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN allow_switch TINYINT(1) NOT NULL DEFAULT 1, ADD COLUMN late_join ENUM('closed','prorate','full') NOT NULL DEFAULT 'prorate',
    ADD COLUMN disciplines VARCHAR(40) NOT NULL DEFAULT 'ski,snowboard', ADD COLUMN snowboard_age_min TINYINT UNSIGNED NULL,
    ADD COLUMN ask_safety TINYINT(1) NOT NULL DEFAULT 1`],
  // The price of a place is built from parts: lessons, a lift ticket (not for a season pass holder), rental, a helmet.
  ['program_terms price parts', (c) => columnExists(c, 'program_terms', 'ticket_cents'), `ALTER TABLE program_terms
    ADD COLUMN ticket_cents INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN rental_cents INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN helmet_cents INT UNSIGNED NOT NULL DEFAULT 0`],
  ['program_groups.discipline', (c) => columnExists(c, 'program_groups', 'discipline'), "ALTER TABLE program_groups ADD COLUMN discipline ENUM('any','ski','snowboard') NOT NULL DEFAULT 'any'"],
  ['program_levels.school_level_id', (c) => columnExists(c, 'program_levels', 'school_level_id'), 'ALTER TABLE program_levels ADD COLUMN school_level_id BIGINT UNSIGNED NULL'],
  ['program_enrollments child details', (c) => columnExists(c, 'program_enrollments', 'pass_status'), `ALTER TABLE program_enrollments
    ADD COLUMN discipline ENUM('ski','snowboard') NULL,
    ADD COLUMN pass_status ENUM('none','verified','claimed','no_pass') NOT NULL DEFAULT 'none',
    ADD COLUMN needs_rental TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN needs_helmet TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN lesson_cents INT UNSIGNED NULL, ADD COLUMN ticket_cents INT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN rental_cents INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN helmet_cents INT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN allergies VARCHAR(300) NULL, ADD COLUMN medical VARCHAR(500) NULL, ADD COLUMN pickup TEXT NULL,
    ADD COLUMN adjust_cents INT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN adjust_how VARCHAR(20) NULL, ADD COLUMN adjust_ref VARCHAR(60) NULL, ADD COLUMN adjusted_at DATETIME NULL,
    ADD COLUMN withdrawn_at DATETIME NULL, ADD COLUMN refund_cents INT UNSIGNED NOT NULL DEFAULT 0`],
  ['program_settings', (c) => tableExists(c, 'program_settings'), `CREATE TABLE program_settings (
    tenant_id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    pass_later         ENUM('none','refund','credit') NOT NULL DEFAULT 'none',
    pass_later_share   ENUM('unused','full') NOT NULL DEFAULT 'unused',
    reminders          ENUM('off','first','every') NOT NULL DEFAULT 'first',
    text_cancellations TINYINT(1) NOT NULL DEFAULT 1,
    CONSTRAINT fk_progsettings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
  ['program_reminders', (c) => tableExists(c, 'program_reminders'), `CREATE TABLE program_reminders (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    meeting_id BIGINT UNSIGNED NOT NULL,
    email      VARCHAR(255) NOT NULL,
    sent_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, meeting_id, email)
  )`],
  // The parent account: a sign-in link by email, then a session kept on the parent's phone.
  ['family_tokens', (c) => tableExists(c, 'family_tokens'), `CREATE TABLE family_tokens (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    email      VARCHAR(255) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    kind       ENUM('link','session') NOT NULL,
    expires_at DATETIME NOT NULL,
    used_at    DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_family_token (token_hash),
    KEY ix_family_email (tenant_id, email, created_at),
    CONSTRAINT fk_family_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
];
const fieldKitSteps = [
  // Photos on a patrol case. The file is kept exactly as uploaded, with its SHA-256 recorded at upload, so anyone can show
  // it has not changed since; a smaller preview is shown first. Never deleted: a wrong photo is marked entered in error.
  ['incident_media', (c) => tableExists(c, 'incident_media'), `CREATE TABLE incident_media (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    incident_id   BIGINT UNSIGNED NOT NULL,
    patient_id    BIGINT UNSIGNED NULL,
    mime          VARCHAR(60) NOT NULL,
    file_name     VARCHAR(200) NULL,
    bytes         INT UNSIGNED NOT NULL,
    sha256        CHAR(64) NOT NULL,
    original      MEDIUMBLOB NOT NULL,
    preview       MEDIUMBLOB NULL,
    caption       VARCHAR(255) NULL,
    taken_at      DATETIME NULL,
    taken_lat     DECIMAL(9,6) NULL,
    taken_lng     DECIMAL(9,6) NULL,
    client_ref    VARCHAR(40) NULL,
    uploaded_by   BIGINT UNSIGNED NULL,
    uploaded_at   DATETIME NOT NULL,
    voided_at     DATETIME NULL,
    voided_by     BIGINT UNSIGNED NULL,
    void_reason   VARCHAR(255) NULL,
    UNIQUE KEY uq_media_ref (tenant_id, client_ref),
    KEY ix_media_incident (tenant_id, incident_id, id),
    CONSTRAINT fk_media_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
  ) ENGINE=InnoDB`],
  // The preview's own fingerprint, so a frozen version names the exact preview too (set once, while the case is editable).
  ['incident_media.preview_sha256', (c) => columnExists(c, 'incident_media', 'preview_sha256'), 'ALTER TABLE incident_media ADD COLUMN preview_sha256 CHAR(64) NULL AFTER preview'],
  // Check steps for each kind of patrol gear (readings with ranges, dates with expiry rules), and the answers on a check.
  ['patrol_gear_checklists', (c) => tableExists(c, 'patrol_gear_checklists'), `CREATE TABLE patrol_gear_checklists (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    kind        VARCHAR(30) NOT NULL,
    items       TEXT NOT NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, kind),
    CONSTRAINT fk_gearcl_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['equipment_checks items', (c) => columnExists(c, 'equipment_checks', 'items'), 'ALTER TABLE equipment_checks ADD COLUMN items TEXT NULL'],
  // Locating a caller: dispatch texts a one-time link, and the guest's phone sends back where it is.
  ['dispatch_calls locate', (c) => columnExists(c, 'dispatch_calls', 'located_at'), `ALTER TABLE dispatch_calls ADD COLUMN locate_token CHAR(32) NULL,
    ADD COLUMN locate_sent_at DATETIME NULL, ADD COLUMN located_at DATETIME NULL, ADD COLUMN located_accuracy_m INT UNSIGNED NULL, ADD UNIQUE KEY uq_dcall_locate (locate_token)`],
];

// Staff injuries, first step: when the owner and GM were told a patient is staff, and told again when they went to hospital.
// Demos built on a real mountain: what OpenStreetMap says about a ski area, kept a week so a visitor's choice is quick.
const reportRuleSteps = [
  // Report requirements: each change to a mountain's rules is a version; a report keeps the version it was submitted under.
  ['patrol_rule_versions', (c) => tableExists(c, 'patrol_rule_versions'), `CREATE TABLE patrol_rule_versions (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    rules      MEDIUMTEXT NOT NULL,
    preset     VARCHAR(20) NULL,
    note       VARCHAR(255) NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_prv_tenant (tenant_id, id),
    CONSTRAINT fk_prv_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // N/A with a reason, per field: { field_key: { reason, note, by, at } } on the case and on each patient.
  ['incidents.rules_version_id', (c) => columnExists(c, 'incidents', 'rules_version_id'), 'ALTER TABLE incidents ADD COLUMN rules_version_id BIGINT UNSIGNED NULL, ADD COLUMN na TEXT NULL'],
  // A checklist item skipped before the patient left (with the reason), and an item approved with an exception.
  ['incident_skips', (c) => tableExists(c, 'incident_skips'), `CREATE TABLE incident_skips (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    incident_id BIGINT UNSIGNED NOT NULL,
    patient_id  BIGINT UNSIGNED NULL,
    gate        VARCHAR(20) NOT NULL DEFAULT 'leave',
    item_key    VARCHAR(40) NOT NULL,
    reason      VARCHAR(20) NOT NULL,
    note        VARCHAR(300) NULL,
    skipped_by  BIGINT UNSIGNED NULL,
    skipped_at  DATETIME NOT NULL,
    KEY ix_skips_case (tenant_id, incident_id),
    CONSTRAINT fk_skips_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['incident_exceptions', (c) => tableExists(c, 'incident_exceptions'), `CREATE TABLE incident_exceptions (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    incident_id BIGINT UNSIGNED NOT NULL,
    patient_id  BIGINT UNSIGNED NULL,
    scope       VARCHAR(10) NOT NULL,
    item_key    VARCHAR(40) NOT NULL,
    label       VARCHAR(255) NOT NULL,
    reason      VARCHAR(500) NOT NULL,
    approved_by BIGINT UNSIGNED NOT NULL,
    approved_at DATETIME NOT NULL,
    KEY ix_exc_case (tenant_id, incident_id),
    CONSTRAINT fk_exc_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
  ) ENGINE=InnoDB`],
  // Signatures, witnesses and skips can wait on a phone with no signal: client_ref stops a second copy when it is sent again.
  ['offline signatures and witnesses', (c) => columnExists(c, 'incident_signatures', 'client_ref'), [
    'ALTER TABLE incident_signatures ADD COLUMN client_ref VARCHAR(40) NULL, ADD UNIQUE KEY uq_isig_ref (tenant_id, client_ref)',
    'ALTER TABLE incident_witnesses ADD COLUMN client_ref VARCHAR(40) NULL, ADD UNIQUE KEY uq_iwit_ref (tenant_id, client_ref)',
    'ALTER TABLE incident_skips ADD COLUMN client_ref VARCHAR(40) NULL, ADD UNIQUE KEY uq_iskip_ref (tenant_id, client_ref)',
  ]],
  ['incident_patients.na', (c) => columnExists(c, 'incident_patients', 'na'), 'ALTER TABLE incident_patients ADD COLUMN na TEXT NULL'],
];

// Patrol crews: a repeating shift (Saturday day crew) with how many it needs, the least it can run with, and the roles it
// must have. Generating a season makes one open spot per person needed; patrollers sign up for the spots (with approval
// when the patrol wants it), and standing members are put on their crew's days first.
const crewSteps = [
  ['patrol_crews', (c) => tableExists(c, 'patrol_crews'), `CREATE TABLE patrol_crews (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    name        VARCHAR(80) NOT NULL,
    days        VARCHAR(20) NOT NULL,
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    station_id  BIGINT UNSIGNED NULL,
    target      SMALLINT UNSIGNED NOT NULL,
    minimum     SMALLINT UNSIGNED NOT NULL,
    roles       TEXT NULL,
    from_date   DATE NULL,
    to_date     DATE NULL,
    skip_dates  TEXT NULL,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_crews_tenant (tenant_id, active),
    CONSTRAINT fk_crews_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['patrol_crew_members', (c) => tableExists(c, 'patrol_crew_members'), `CREATE TABLE patrol_crew_members (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    crew_id    BIGINT UNSIGNED NOT NULL,
    staff_id   BIGINT UNSIGNED NOT NULL,
    role_label VARCHAR(60) NULL,
    PRIMARY KEY (tenant_id, crew_id, staff_id),
    CONSTRAINT fk_pcm_crew FOREIGN KEY (crew_id) REFERENCES patrol_crews(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  // Each spot knows its crew, and what a role spot needs (a rank or a medical certification at least).
  ['patrol_shifts.crew_id', (c) => columnExists(c, 'patrol_shifts', 'crew_id'),
    'ALTER TABLE patrol_shifts ADD COLUMN crew_id BIGINT UNSIGNED NULL, ADD COLUMN need_rank VARCHAR(12) NULL, ADD COLUMN need_cert VARCHAR(12) NULL, ADD COLUMN extra TINYINT(1) NOT NULL DEFAULT 0, ADD KEY ix_ps_crew (tenant_id, crew_id, starts_at)'],
  ['patrol_signups', (c) => tableExists(c, 'patrol_signups'), `CREATE TABLE patrol_signups (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    patrol_shift_id BIGINT UNSIGNED NOT NULL,
    staff_id        BIGINT UNSIGNED NOT NULL,
    status          ENUM('pending','approved','declined','withdrawn') NOT NULL DEFAULT 'pending',
    decided_by      BIGINT UNSIGNED NULL,
    decided_at      DATETIME NULL,
    note            VARCHAR(200) NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_signups_shift (tenant_id, patrol_shift_id, status),
    KEY ix_signups_status (tenant_id, status)
  ) ENGINE=InnoDB`],
  ['patrol_settings.signup_approval', (c) => columnExists(c, 'patrol_settings', 'signup_approval'),
    'ALTER TABLE patrol_settings ADD COLUMN signup_approval TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN short_alert TINYINT(1) NOT NULL DEFAULT 1, ADD COLUMN short_alert_last DATE NULL'],
];

// Patrol reports: the conditions at the time (a snapshot of the mountain's own records), who was told and when, and the
// lift and rental gear involved. Rental gear on a case is held until the rental shop inspects it.
const caseLinkSteps = [
  ['incidents.conditions', (c) => columnExists(c, 'incidents', 'conditions'),
    'ALTER TABLE incidents ADD COLUMN conditions TEXT NULL, ADD COLUMN lift_id BIGINT UNSIGNED NULL, ADD COLUMN lift_chair VARCHAR(12) NULL'],
  ['incident_contacts', (c) => tableExists(c, 'incident_contacts'), `CREATE TABLE incident_contacts (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    incident_id BIGINT UNSIGNED NOT NULL,
    patient_id  BIGINT UNSIGNED NULL,
    who         ENUM('management','insurer','parent','ems','police','owner','other') NOT NULL,
    who_name    VARCHAR(120) NULL,
    method      ENUM('phone','in_person','text','radio','email') NOT NULL DEFAULT 'phone',
    at          DATETIME NOT NULL,
    note        VARCHAR(300) NULL,
    recorded_by BIGINT UNSIGNED NOT NULL,
    entered_at  DATETIME NULL,
    voided_at   DATETIME NULL,
    void_reason VARCHAR(255) NULL,
    voided_by   BIGINT UNSIGNED NULL,
    client_ref  VARCHAR(40) NULL,
    UNIQUE KEY uq_icontact_ref (tenant_id, client_ref),
    KEY ix_icontacts_case (tenant_id, incident_id, at),
    CONSTRAINT fk_icontacts_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['incident_rentals', (c) => tableExists(c, 'incident_rentals'), `CREATE TABLE incident_rentals (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    incident_id     BIGINT UNSIGNED NOT NULL,
    patient_id      BIGINT UNSIGNED NULL,
    contract_id     BIGINT UNSIGNED NULL,
    rental_item_id  BIGINT UNSIGNED NOT NULL,
    detail          TEXT NULL,
    held            TINYINT(1) NOT NULL DEFAULT 0,
    status_before   VARCHAR(20) NULL,
    released_at     DATETIME NULL,
    released_by     BIGINT UNSIGNED NULL,
    inspection_note VARCHAR(500) NULL,
    added_by        BIGINT UNSIGNED NOT NULL,
    added_at        DATETIME NOT NULL,
    UNIQUE KEY uq_irental (tenant_id, incident_id, rental_item_id),
    KEY ix_irental_item (tenant_id, rental_item_id, held),
    CONSTRAINT fk_irental_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['rental_settings.hold_after_incident', (c) => columnExists(c, 'rental_settings', 'hold_after_incident'), 'ALTER TABLE rental_settings ADD COLUMN hold_after_incident TINYINT(1) NOT NULL DEFAULT 1'],
];

// The staff injury register: work injuries and illnesses for the owner, with the fields of OSHA's Forms 300 and 301. Patrol
// cases where the patient is staff or a volunteer on duty appear on their own; others are added by hand. Only the owner and
// those the owner names can open it, and every look is logged.
const injuryRegisterSteps = [
  ['staff_injuries', (c) => tableExists(c, 'staff_injuries'), `CREATE TABLE staff_injuries (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    year            SMALLINT UNSIGNED NOT NULL,
    seq             SMALLINT UNSIGNED NOT NULL,
    source          ENUM('patrol','manual') NOT NULL DEFAULT 'manual',
    incident_id     BIGINT UNSIGNED NULL,
    patient_id      BIGINT UNSIGNED NULL,
    staff_id        BIGINT UNSIGNED NULL,
    volunteer       TINYINT(1) NOT NULL DEFAULT 0,
    employee_name   VARCHAR(150) NOT NULL,
    job_title       VARCHAR(100) NULL,
    occurred_at     DATETIME NOT NULL,
    place           VARCHAR(150) NULL,
    description     VARCHAR(500) NULL,
    kind            ENUM('injury','skin','respiratory','poisoning','hearing','other_illness') NOT NULL DEFAULT 'injury',
    outcome         ENUM('death','days_away','restricted','other_recordable','not_recordable') NULL,
    days_away       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    days_restricted SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    privacy_case    TINYINT(1) NOT NULL DEFAULT 0,
    began_work_at   TIME NULL,
    activity        VARCHAR(500) NULL,
    how_happened    VARCHAR(1000) NULL,
    object          VARCHAR(255) NULL,
    treated_by      VARCHAR(150) NULL,
    facility        VARCHAR(200) NULL,
    er              TINYINT(1) NOT NULL DEFAULT 0,
    overnight       TINYINT(1) NOT NULL DEFAULT 0,
    died_on         DATE NULL,
    status          ENUM('open','closed') NOT NULL DEFAULT 'open',
    created_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sinj_seq (tenant_id, year, seq),
    UNIQUE KEY uq_sinj_patient (tenant_id, patient_id),
    KEY ix_sinj_year (tenant_id, year),
    CONSTRAINT fk_sinj_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['staff_injury_access', (c) => tableExists(c, 'staff_injury_access'), `CREATE TABLE staff_injury_access (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    granted_by BIGINT UNSIGNED NULL,
    granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, user_id)
  ) ENGINE=InnoDB`],
  ['staff_injury_years', (c) => tableExists(c, 'staff_injury_years'), `CREATE TABLE staff_injury_years (
    tenant_id     BIGINT UNSIGNED NOT NULL,
    year          SMALLINT UNSIGNED NOT NULL,
    hours_worked  INT UNSIGNED NULL,
    avg_employees SMALLINT UNSIGNED NULL,
    certified_by  VARCHAR(150) NULL,
    certified_at  DATE NULL,
    PRIMARY KEY (tenant_id, year)
  ) ENGINE=InnoDB`],
];

// Lost and found: what is handed in, what guests report missing (at the counter or on the website), matches between
// them, and how each found item left (returned with an ID check, donated or thrown away).
const lostFoundSteps = [
  ['lost_items', (c) => tableExists(c, 'lost_items'), `CREATE TABLE lost_items (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    number      INT UNSIGNED NOT NULL,
    kind        VARCHAR(20) NOT NULL,
    description VARCHAR(255) NULL,
    brand       VARCHAR(60) NULL,
    color       VARCHAR(40) NULL,
    found_where VARCHAR(150) NULL,
    found_at    DATETIME NOT NULL,
    found_by    VARCHAR(150) NULL,
    bin         VARCHAR(40) NULL,
    valuable    TINYINT(1) NOT NULL DEFAULT 0,
    photo       MEDIUMTEXT NULL,
    status      ENUM('held','matched','returned','donated','discarded') NOT NULL DEFAULT 'held',
    report_id   BIGINT UNSIGNED NULL,
    returned_to VARCHAR(150) NULL,
    id_checked  TINYINT(1) NOT NULL DEFAULT 0,
    closed_at   DATETIME NULL,
    closed_by   BIGINT UNSIGNED NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_lost_number (tenant_id, number),
    KEY ix_lost_status (tenant_id, status, found_at),
    CONSTRAINT fk_lost_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['lost_reports', (c) => tableExists(c, 'lost_reports'), `CREATE TABLE lost_reports (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    kind        VARCHAR(20) NOT NULL,
    description VARCHAR(255) NULL,
    brand       VARCHAR(60) NULL,
    color       VARCHAR(40) NULL,
    lost_where  VARCHAR(150) NULL,
    lost_on     DATE NOT NULL,
    name        VARCHAR(120) NOT NULL,
    email       VARCHAR(255) NULL,
    phone       VARCHAR(40) NULL,
    source      ENUM('counter','web') NOT NULL DEFAULT 'counter',
    status      ENUM('open','found','closed') NOT NULL DEFAULT 'open',
    item_id     BIGINT UNSIGNED NULL,
    told_at     DATETIME NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_lostrep_status (tenant_id, status, lost_on),
    CONSTRAINT fk_lostrep_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['lost_found_settings', (c) => tableExists(c, 'lost_found_settings'), `CREATE TABLE lost_found_settings (
    tenant_id  BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    keep_days  SMALLINT UNSIGNED NOT NULL DEFAULT 60,
    web_form   TINYINT(1) NOT NULL DEFAULT 1,
    pickup     VARCHAR(255) NULL
  ) ENGINE=InnoDB`],
];

// Patrol kits: trauma bags, packed toboggans and lift evacuation kits. Each kind has its contents (with quantities and
// which items expire) and how often it is checked; each kit has a number, a place and a QR label. Checks, restocks and
// supplies used on a case are logged per kit, and work with no signal (client_ref).
const kitSteps = [
  ['patrol_kit_types', (c) => tableExists(c, 'patrol_kit_types'), `CREATE TABLE patrol_kit_types (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    name        VARCHAR(80) NOT NULL,
    prefix      VARCHAR(8) NOT NULL,
    every_days  SMALLINT UNSIGNED NOT NULL DEFAULT 7,
    contents    TEXT NOT NULL,
    active      TINYINT(1) NOT NULL DEFAULT 1,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_kittypes (tenant_id, active),
    CONSTRAINT fk_kittypes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['patrol_kits', (c) => tableExists(c, 'patrol_kits'), `CREATE TABLE patrol_kits (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    type_id         BIGINT UNSIGNED NOT NULL,
    label           VARCHAR(20) NOT NULL,
    location        VARCHAR(120) NULL,
    station_id      BIGINT UNSIGNED NULL,
    lift_id         BIGINT UNSIGNED NULL,
    status          ENUM('ready','not_ready','needs_restock','out_of_service') NOT NULL DEFAULT 'not_ready',
    sealed          TINYINT(1) NOT NULL DEFAULT 0,
    seal_no         VARCHAR(30) NULL,
    stock           TEXT NULL,
    earliest_expiry DATE NULL,
    last_check_at   DATETIME NULL,
    active          TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_kit_label (tenant_id, label),
    KEY ix_kits_type (tenant_id, type_id),
    CONSTRAINT fk_kits_type FOREIGN KEY (type_id) REFERENCES patrol_kit_types(id)
  ) ENGINE=InnoDB`],
  ['patrol_kit_checks', (c) => tableExists(c, 'patrol_kit_checks'), `CREATE TABLE patrol_kit_checks (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    kit_id      BIGINT UNSIGNED NOT NULL,
    kind        ENUM('full','seal','restock','use') NOT NULL,
    result      ENUM('ready','not_ready','needs_restock') NOT NULL,
    items       TEXT NULL,
    seal_no     VARCHAR(30) NULL,
    note        VARCHAR(300) NULL,
    incident_id BIGINT UNSIGNED NULL,
    done_by     BIGINT UNSIGNED NOT NULL,
    done_at     DATETIME NOT NULL,
    client_ref  VARCHAR(40) NULL,
    UNIQUE KEY uq_kitcheck_ref (tenant_id, client_ref),
    KEY ix_kitchecks (tenant_id, kit_id, done_at),
    KEY ix_kitchecks_case (tenant_id, incident_id)
  ) ENGINE=InnoDB`],
  ['patrol_settings.kit_seals', (c) => columnExists(c, 'patrol_settings', 'kit_seals'), 'ALTER TABLE patrol_settings ADD COLUMN kit_seals TINYINT(1) NOT NULL DEFAULT 0'],
];

// Rotating teams: a patrol's teams (A team, B team) take turns on a crew, by week or by each day it runs. The team on a
// day is put on its spots first, with the crew's standing members.
const teamSteps = [
  ['patrol_teams', (c) => tableExists(c, 'patrol_teams'), `CREATE TABLE patrol_teams (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(60) NOT NULL,
    active     TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_pteam_name (tenant_id, name),
    CONSTRAINT fk_pteam_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['patrol_team_members', (c) => tableExists(c, 'patrol_team_members'), `CREATE TABLE patrol_team_members (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    team_id    BIGINT UNSIGNED NOT NULL,
    staff_id   BIGINT UNSIGNED NOT NULL,
    role_label VARCHAR(60) NULL,
    PRIMARY KEY (tenant_id, team_id, staff_id),
    CONSTRAINT fk_ptm_team FOREIGN KEY (team_id) REFERENCES patrol_teams(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['patrol_crews.rotation', (c) => columnExists(c, 'patrol_crews', 'rotation'), 'ALTER TABLE patrol_crews ADD COLUMN rotation TEXT NULL'],
  ['patrol_shifts.team_id', (c) => columnExists(c, 'patrol_shifts', 'team_id'), 'ALTER TABLE patrol_shifts ADD COLUMN team_id BIGINT UNSIGNED NULL'],
];

// Prospects in the platform console: the ski areas we sell to, the people there, and the pipeline (src/lib/prospects.js).
const prospectSteps = [
  ['prospects', (c) => tableExists(c, 'prospects'), `CREATE TABLE prospects (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(150) NOT NULL,
    state       CHAR(2) NULL,
    town        VARCHAR(120) NULL,
    region      VARCHAR(60) NULL,
    website     VARCHAR(500) NULL,
    phone       VARCHAR(60) NULL,
    ownership   VARCHAR(600) NULL,
    indy_pass   TINYINT(1) NULL,
    vertical_ft INT NULL,
    lifts       INT NULL,
    trails      INT NULL,
    acres       INT NULL,
    offers      TEXT NULL,
    patrol      VARCHAR(20) NULL,
    software    TEXT NULL,
    fit_notes   TEXT NULL,
    sources     TEXT NULL,
    stage       VARCHAR(20) NOT NULL DEFAULT 'research',
    priority    TINYINT NOT NULL DEFAULT 2,
    plan_interest VARCHAR(60) NULL,
    next_step   VARCHAR(300) NULL,
    next_on     DATE NULL,
    owner_name  VARCHAR(100) NULL,
    tenant_id   BIGINT UNSIGNED NULL,
    lead_id     BIGINT UNSIGNED NULL,
    checked_on  DATE NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_prospect (name, state),
    KEY ix_prospect_stage (stage, priority),
    KEY ix_prospect_next (next_on)
  ) ENGINE=InnoDB`],
  ['prospect_contacts', (c) => tableExists(c, 'prospect_contacts'), `CREATE TABLE prospect_contacts (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    prospect_id BIGINT UNSIGNED NOT NULL,
    role        VARCHAR(30) NOT NULL DEFAULT 'other',
    name        VARCHAR(120) NULL,
    title       VARCHAR(200) NULL,
    email       VARCHAR(200) NULL,
    phone       VARCHAR(80) NULL,
    source_url  VARCHAR(500) NULL,
    note        VARCHAR(500) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_pc_prospect (prospect_id),
    CONSTRAINT fk_pc_prospect FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['prospect_notes', (c) => tableExists(c, 'prospect_notes'), `CREATE TABLE prospect_notes (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    prospect_id BIGINT UNSIGNED NOT NULL,
    kind        VARCHAR(20) NOT NULL DEFAULT 'note',
    body        TEXT NOT NULL,
    actor       VARCHAR(120) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_pn_prospect (prospect_id, id),
    CONSTRAINT fk_pn_prospect FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['prospect_batches', (c) => tableExists(c, 'prospect_batches'), `CREATE TABLE prospect_batches (
    name       VARCHAR(100) NOT NULL PRIMARY KEY,
    added      INT NOT NULL DEFAULT 0,
    loaded_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`],
];

// Partner passes (Indy Pass, a neighbor's reciprocal pass): the program's rules, its blackout dates, and every day a
// pass holder skied here (src/lib/partnerpasses.js).
const partnerSteps = [
  ['partner_programs', (c) => tableExists(c, 'partner_programs'), `CREATE TABLE partner_programs (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    name             VARCHAR(80) NOT NULL,
    product_id       BIGINT UNSIGNED NOT NULL,
    levels           TEXT NULL,
    number_label     VARCHAR(60) NOT NULL DEFAULT 'Pass number',
    free_days        TINYINT UNSIGNED NOT NULL DEFAULT 2,
    discount_days    TINYINT UNSIGNED NOT NULL DEFAULT 1,
    discount_percent TINYINT UNSIGNED NOT NULL DEFAULT 25,
    daily_limit      INT UNSIGNED NULL,
    id_check         TINYINT(1) NOT NULL DEFAULT 1,
    online           TINYINT(1) NOT NULL DEFAULT 0,
    reservation_required TINYINT(1) NOT NULL DEFAULT 0,
    staff_note       VARCHAR(500) NULL,
    active           TINYINT(1) NOT NULL DEFAULT 1,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_partner_name (tenant_id, name),
    CONSTRAINT fk_partner_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['partner_blackouts', (c) => tableExists(c, 'partner_blackouts'), `CREATE TABLE partner_blackouts (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    program_id BIGINT UNSIGNED NOT NULL,
    on_date    DATE NOT NULL,
    PRIMARY KEY (tenant_id, program_id, on_date),
    CONSTRAINT fk_pblack_program FOREIGN KEY (program_id) REFERENCES partner_programs(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['partner_redemptions', (c) => tableExists(c, 'partner_redemptions'), `CREATE TABLE partner_redemptions (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    program_id    BIGINT UNSIGNED NOT NULL,
    number        VARCHAR(40) NOT NULL,
    level         VARCHAR(30) NULL,
    season        VARCHAR(9) NOT NULL,
    on_date       DATE NOT NULL,
    kind          ENUM('free','discount') NOT NULL,
    percent_off   TINYINT UNSIGNED NOT NULL DEFAULT 0,
    window_cents  INT UNSIGNED NOT NULL DEFAULT 0,
    charged_cents INT UNSIGNED NOT NULL DEFAULT 0,
    person_id     BIGINT UNSIGNED NULL,
    order_id      BIGINT UNSIGNED NULL,
    order_item_id BIGINT UNSIGNED NULL,
    ticket_id     BIGINT UNSIGNED NULL,
    channel       VARCHAR(10) NOT NULL DEFAULT 'window',
    id_checked    TINYINT(1) NOT NULL DEFAULT 0,
    status        ENUM('active','void') NOT NULL DEFAULT 'active',
    void_reason   VARCHAR(200) NULL,
    created_by    BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_pred_number (tenant_id, program_id, number, season),
    KEY ix_pred_day (tenant_id, program_id, on_date),
    CONSTRAINT fk_pred_program FOREIGN KEY (program_id) REFERENCES partner_programs(id)
  ) ENGINE=InnoDB`],
];

// Prospect outreach: emails from the operator's own mailbox on a cadence, until a reply, a bounce or "not interested"
// (src/lib/outreach.js). The suppression list is permanent.
const outreachSteps = [
  ['outreach_settings', (c) => tableExists(c, 'outreach_settings'), `CREATE TABLE outreach_settings (
    id            TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    sender_name   VARCHAR(100) NULL,
    company_line  VARCHAR(150) NULL,
    postal_address VARCHAR(300) NULL,
    daily_cap     INT UNSIGNED NOT NULL DEFAULT 25,
    send_from_hour TINYINT UNSIGNED NOT NULL DEFAULT 9,
    send_to_hour  TINYINT UNSIGNED NOT NULL DEFAULT 16,
    timezone      VARCHAR(40) NOT NULL DEFAULT 'America/New_York',
    offsets       VARCHAR(100) NOT NULL DEFAULT '[0,7,16,30,45]',
    nurture_days  INT UNSIGNED NOT NULL DEFAULT 90,
    use_ai        TINYINT(1) NOT NULL DEFAULT 1,
    paused        TINYINT(1) NOT NULL DEFAULT 0,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`],
  ['outreach_templates', (c) => tableExists(c, 'outreach_templates'), `CREATE TABLE outreach_templates (
    step       TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    subject    VARCHAR(200) NOT NULL,
    body       TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`],
  ['outreach_suppress', (c) => tableExists(c, 'outreach_suppress'), `CREATE TABLE outreach_suppress (
    email      VARCHAR(200) NOT NULL PRIMARY KEY,
    reason     VARCHAR(30) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`],
  ['outreach_sequences', (c) => tableExists(c, 'outreach_sequences'), `CREATE TABLE outreach_sequences (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    prospect_id BIGINT UNSIGNED NOT NULL,
    contact_id  BIGINT UNSIGNED NOT NULL,
    email       VARCHAR(200) NOT NULL,
    token       CHAR(32) NOT NULL,
    status      ENUM('pending','active','nurture','replied','bounced','stopped','not_interested') NOT NULL DEFAULT 'pending',
    step        TINYINT UNSIGNED NOT NULL DEFAULT 0,
    next_at     DATETIME NULL,
    thread_id   VARCHAR(40) NULL,
    first_message_id VARCHAR(300) NULL,
    first_subject VARCHAR(200) NULL,
    started_at  DATETIME NULL,
    stopped_at  DATETIME NULL,
    stop_reason VARCHAR(200) NULL,
    created_by  VARCHAR(120) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_os_token (token),
    KEY ix_os_due (status, next_at),
    KEY ix_os_prospect (prospect_id),
    CONSTRAINT fk_os_prospect FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE,
    CONSTRAINT fk_os_contact FOREIGN KEY (contact_id) REFERENCES prospect_contacts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['outreach_messages', (c) => tableExists(c, 'outreach_messages'), `CREATE TABLE outreach_messages (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    sequence_id BIGINT UNSIGNED NOT NULL,
    step        TINYINT UNSIGNED NOT NULL,
    subject     VARCHAR(200) NOT NULL,
    body        TEXT NOT NULL,
    status      ENUM('draft','approved','sent','failed','skipped') NOT NULL DEFAULT 'draft',
    drafted_by  VARCHAR(20) NOT NULL DEFAULT 'template',
    gmail_id    VARCHAR(40) NULL,
    approved_by VARCHAR(120) NULL,
    sent_at     DATETIME NULL,
    error       VARCHAR(300) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_om_seq (sequence_id, step),
    KEY ix_om_sent (status, sent_at),
    CONSTRAINT fk_om_seq FOREIGN KEY (sequence_id) REFERENCES outreach_sequences(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
];

// Research batches shipped in db/data are loaded once each (by batch name), so deleting a prospect never brings it back.
async function loadProspectBatches(conn) {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) return;
  const { importBatch } = require('../src/lib/prospects');
  for (const f of fs.readdirSync(dir).filter((x) => /^prospects-.*\.json$/.test(x)).sort()) {
    const file = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const name = String(file.batch || f).slice(0, 100);
    const [[done]] = await conn.query('SELECT name FROM prospect_batches WHERE name = ?', [name]);
    if (done) continue;
    const r = await importBatch(conn, file.prospects || [], { checkedOn: file.checked_on || null });
    await conn.query('INSERT INTO prospect_batches (name, added) VALUES (?, ?)', [name, r.added]);
    console.log(`Prospects: loaded "${name}" (${r.added} new, ${r.contacts} contacts)`);
  }
  // Indy Pass partner resorts came off the list (Oct 26, 2026). Where the first batch was loaded before that, the ones
  // nobody has worked on yet are removed once: still being researched, with nothing on their timeline.
  const cleanup = 'cleanup: Indy Pass resorts 2026-10';
  const [[cleaned]] = await conn.query('SELECT name FROM prospect_batches WHERE name = ?', [cleanup]);
  if (!cleaned) {
    const first = path.join(dir, 'prospects-2026-10.json');
    const names = fs.existsSync(first) ? JSON.parse(fs.readFileSync(first, 'utf8')).excluded_indy_pass || [] : [];
    const [r] = await conn.query(`DELETE FROM prospects WHERE stage = 'research' AND (indy_pass = 1${names.length ? ` OR name IN (${names.map(() => '?').join(', ')})` : ''})
      AND NOT EXISTS (SELECT 1 FROM prospect_notes n WHERE n.prospect_id = prospects.id)`, names);
    await conn.query('INSERT INTO prospect_batches (name, added) VALUES (?, 0)', [cleanup]);
    if (r.affectedRows) console.log(`Prospects: removed ${r.affectedRows} Indy Pass resort${r.affectedRows === 1 ? '' : 's'}`);
  }
}

const skiAreaSteps = [
  ['ski_area_cache', (c) => tableExists(c, 'ski_area_cache'), `CREATE TABLE ski_area_cache (
    ref        VARCHAR(40) NOT NULL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    data       MEDIUMTEXT NOT NULL,
    fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`],
  ['sandbox_signups.area_ref', (c) => columnExists(c, 'sandbox_signups', 'area_ref'), 'ALTER TABLE sandbox_signups ADD COLUMN area_ref VARCHAR(40) NULL'],
];

const staffInjurySteps = [
  ['incident_patients staff notices', (c) => columnExists(c, 'incident_patients', 'staff_serious_noted_at'), 'ALTER TABLE incident_patients ADD COLUMN staff_noted_at DATETIME NULL, ADD COLUMN staff_serious_noted_at DATETIME NULL'],
];

const demoMailSteps = [
  // Demo emails from the founder: the welcome with a sign-in link, a nudge on day 2, a note before the demo ends.
  // open_nonce makes the sign-in link (changing it, from the console, retires every link sent before).
  ['sandbox_signups demo emails', (c) => columnExists(c, 'sandbox_signups', 'emails_stopped_at'), `ALTER TABLE sandbox_signups ADD COLUMN open_nonce CHAR(16) NULL,
    ADD COLUMN welcome_sent_at DATETIME NULL, ADD COLUMN nudge_sent_at DATETIME NULL, ADD COLUMN ending_sent_at DATETIME NULL, ADD COLUMN emails_stopped_at DATETIME NULL`],
];

const assistantSteps = [
  // The Verdynt/OS Assistant: what each mountain turned on, and every question asked (for the cap, the console and feedback).
  ['assistant_settings', (c) => tableExists(c, 'assistant_settings'), `CREATE TABLE assistant_settings (
    tenant_id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    staff_on          TINYINT(1) NOT NULL DEFAULT 1,
    guest_pages       VARCHAR(100) NOT NULL DEFAULT '',
    contact_email     VARCHAR(255) NULL,
    monthly_cap_cents INT UNSIGNED NOT NULL DEFAULT 5000,
    CONSTRAINT fk_asettings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
  ['assistant_log', (c) => tableExists(c, 'assistant_log'), `CREATE TABLE assistant_log (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    audience      ENUM('staff','guest') NOT NULL,
    user_id       BIGINT UNSIGNED NULL,
    page          VARCHAR(40) NULL,
    question      VARCHAR(1000) NOT NULL,
    answer        TEXT NULL,
    sources       TEXT NULL,
    tools         TEXT NULL,
    model         VARCHAR(60) NULL,
    input_tokens  INT UNSIGNED NOT NULL DEFAULT 0,
    output_tokens INT UNSIGNED NOT NULL DEFAULT 0,
    cost_micros   INT UNSIGNED NOT NULL DEFAULT 0,
    unanswered    TINYINT(1) NOT NULL DEFAULT 0,
    rating        TINYINT NULL,
    escalated_at  DATETIME NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_alog_tenant (tenant_id, created_at),
    KEY ix_alog_flags (rating, escalated_at),
    CONSTRAINT fk_alog_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
];
const storyFillSteps = [
  ['patrol_settings.story_fill', (c) => columnExists(c, 'patrol_settings', 'story_fill'), 'ALTER TABLE patrol_settings ADD COLUMN story_fill TINYINT(1) NOT NULL DEFAULT 0'],
];
const guestTypeSteps = [
  ['guest_types', (c) => tableExists(c, 'guest_types'), `CREATE TABLE guest_types (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    code       VARCHAR(30) NOT NULL,
    name       VARCHAR(60) NOT NULL,
    min_age    TINYINT UNSIGNED NULL,
    max_age    TINYINT UNSIGNED NULL,
    online     TINYINT(1) NOT NULL DEFAULT 1,
    hidden     TINYINT(1) NOT NULL DEFAULT 0,
    sort       SMALLINT NOT NULL DEFAULT 100,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_guest_type (tenant_id, code)
  ) ENGINE=InnoDB`],
  ['price_tiers.tier any code', (c) => columnTypeHas(c, 'price_tiers', 'tier', 'varchar'), "ALTER TABLE price_tiers MODIFY tier VARCHAR(30) NOT NULL"],
  ['price_calendar.tier any code', (c) => columnTypeHas(c, 'price_calendar', 'tier', 'varchar'), 'ALTER TABLE price_calendar MODIFY tier VARCHAR(30) NULL'],
  ['order_items.tier any code', (c) => columnTypeHas(c, 'order_items', 'tier', 'varchar'), "ALTER TABLE order_items MODIFY tier VARCHAR(30) NOT NULL DEFAULT 'adult'"],
];

const lessonCancelSteps = [
  ['lesson_sessions.cancel_reason', (c) => columnExists(c, 'lesson_sessions', 'cancel_reason'), 'ALTER TABLE lesson_sessions ADD COLUMN cancel_reason VARCHAR(300) NULL, ADD COLUMN cancelled_at DATETIME NULL, ADD COLUMN cancelled_by BIGINT UNSIGNED NULL'],
];

const opsSteps = [
  ['trails hold status', (c) => columnTypeHas(c, 'trails', 'status', "'hold'"), "ALTER TABLE trails MODIFY status ENUM('open','hold','closed') NOT NULL DEFAULT 'closed'"],
  ['trails.closure_reason', (c) => columnExists(c, 'trails', 'closure_reason'), 'ALTER TABLE trails ADD COLUMN closure_reason VARCHAR(200) NULL, ADD COLUMN status_by BIGINT UNSIGNED NULL'],
  ['patrol_members.cert_level', (c) => columnExists(c, 'patrol_members', 'cert_level'), "ALTER TABLE patrol_members ADD COLUMN cert_level ENUM('none','oec','emr','emt','aemt','paramedic','rn','md') NOT NULL DEFAULT 'oec'"],
  ['patrol_equipment expiry and oxygen', (c) => columnExists(c, 'patrol_equipment', 'pads_expire_on'), 'ALTER TABLE patrol_equipment ADD COLUMN expires_on DATE NULL, ADD COLUMN pads_expire_on DATE NULL, ADD COLUMN battery_expire_on DATE NULL, ADD COLUMN o2_size VARCHAR(10) NULL, ADD COLUMN o2_psi SMALLINT UNSIGNED NULL, ADD COLUMN needs_download TINYINT(1) NOT NULL DEFAULT 0'],
  ['incidents.legal_hold', (c) => columnExists(c, 'incidents', 'legal_hold'), 'ALTER TABLE incidents ADD COLUMN legal_hold TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN legal_hold_note VARCHAR(255) NULL, ADD COLUMN protocol_stamp VARCHAR(255) NULL'],
  ['incidents.client_ref', (c) => columnExists(c, 'incidents', 'client_ref'), 'ALTER TABLE incidents ADD COLUMN client_ref VARCHAR(40) NULL, ADD UNIQUE KEY uq_incidents_client_ref (tenant_id, client_ref)'],
  ['dispatch_responders alerts', (c) => columnExists(c, 'dispatch_responders', 'acked_at'), 'ALTER TABLE dispatch_responders ADD COLUMN notified_at DATETIME NULL, ADD COLUMN acked_at DATETIME NULL, ADD COLUMN texted_at DATETIME NULL'],
  ['incident_treatments tourniquet', (c) => columnTypeHas(c, 'incident_treatments', 'kind', "'tourniquet'"), "ALTER TABLE incident_treatments MODIFY kind ENUM('splint','spinal_motion_restriction','bandage','ice','oxygen','aed','cpr','airway','medication','warming','rosc','tourniquet','pelvic_binder','other') NOT NULL"],
];

const gateSteps = [
  ['scans.media_uid', (c) => columnExists(c, 'scans', 'media_uid'), 'ALTER TABLE scans ADD COLUMN media_uid VARCHAR(32) NULL, ADD COLUMN device_id BIGINT UNSIGNED NULL, ADD COLUMN client_ref VARCHAR(64) NULL, ADD COLUMN via ENUM(\'code\',\'rfid\',\'device\',\'offline\') NULL'],
  ['scans card_blocked result', (c) => columnTypeHas(c, 'scans', 'result', 'card_blocked'), "ALTER TABLE scans MODIFY result ENUM('ok','expired','not_yet_valid','void','no_uses','unknown','duplicate','card_blocked') NOT NULL"],
  ['tenants.gate_open_ms', (c) => columnExists(c, 'tenants', 'gate_open_ms'), 'ALTER TABLE tenants ADD COLUMN gate_open_ms SMALLINT UNSIGNED NOT NULL DEFAULT 3000'],
  ['scans by device ref', (c) => indexExists(c, 'scans', 'uq_scans_device_ref'), 'ALTER TABLE scans ADD UNIQUE KEY uq_scans_device_ref (tenant_id, device_id, client_ref)'],
  ['incidents review columns', (c) => columnExists(c, 'incidents', 'review_round'), 'ALTER TABLE incidents ADD COLUMN review_round SMALLINT UNSIGNED NOT NULL DEFAULT 0, ADD COLUMN returned_at DATETIME NULL, ADD COLUMN returned_by BIGINT UNSIGNED NULL, ADD COLUMN escalated_at DATETIME NULL, ADD COLUMN escalated_by BIGINT UNSIGNED NULL, ADD COLUMN escalation_note VARCHAR(1000) NULL, ADD COLUMN last_nudge_at DATETIME NULL'],
  ['incidents waiting for review', (c) => indexExists(c, 'incidents', 'ix_incidents_review'), 'ALTER TABLE incidents ADD KEY ix_incidents_review (tenant_id, report_state, submitted_at)'],
  ['chat_members.visible_from_id', (c) => columnExists(c, 'chat_members', 'visible_from_id'), 'ALTER TABLE chat_members ADD COLUMN visible_from_id BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_read_id'],
  ['users.seen_version', (c) => columnExists(c, 'users', 'seen_version'), 'ALTER TABLE users ADD COLUMN seen_version VARCHAR(20) NULL'],
  ['shifts.notes', (c) => columnExists(c, 'shifts', 'notes'), 'ALTER TABLE shifts ADD COLUMN notes VARCHAR(200) NULL'],
  ['time_entries approval and corrections', (c) => columnExists(c, 'time_entries', 'edit_note'), 'ALTER TABLE time_entries ADD COLUMN approved_at DATETIME NULL, ADD COLUMN approved_by BIGINT UNSIGNED NULL, ADD COLUMN edited_at DATETIME NULL, ADD COLUMN edited_by BIGINT UNSIGNED NULL, ADD COLUMN edit_note VARCHAR(200) NULL'],
  ['time entries by day', (c) => indexExists(c, 'time_entries', 'ix_time_day'), 'ALTER TABLE time_entries ADD KEY ix_time_day (tenant_id, clock_in)'],
  // Patrol keeps its own roster and schedule. A staff record with in_workforce = 0 is a patroller only (often a
  // volunteer): on the patrol roster, not in Staff and schedule. Paid patrollers stay on the staff list.
  ['staff.in_workforce', (c) => columnExists(c, 'staff', 'in_workforce'), 'ALTER TABLE staff ADD COLUMN in_workforce TINYINT(1) NOT NULL DEFAULT 1'],
  ['time_entries.patrol_shift_id', (c) => columnExists(c, 'time_entries', 'patrol_shift_id'), 'ALTER TABLE time_entries ADD COLUMN patrol_shift_id BIGINT UNSIGNED NULL'],
  // Sign in with a username or an email. Email is optional except for owners and managers (checked by the app).
  ['users.username', (c) => columnExists(c, 'users', 'username'), 'ALTER TABLE users ADD COLUMN username VARCHAR(40) NULL AFTER email'],
  ['users.must_change_password', (c) => columnExists(c, 'users', 'must_change_password'), 'ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0'],
  ['users.email optional', (c) => has(c, "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'email' AND is_nullable = 'YES'"), 'ALTER TABLE users MODIFY email VARCHAR(255) NULL'],
];
// The unique username index is added after every login has a username (backfillUsernames), so it is the last step.
const usernameIndex = ['users one username per mountain', (c) => indexExists(c, 'users', 'uq_users_username'), 'ALTER TABLE users ADD UNIQUE KEY uq_users_username (tenant_id, username)'];

/**
 * Every login gets a username so it can sign in without an email: first initial and last name ("mellis"), else the part
 * of the email before the @, else "user" and its number; a number is added when the name is taken at that mountain.
 * Only logins without one are touched, so it is safe to re-run.
 */
async function backfillUsernames(conn) {
  const { suggestUsername } = require('../src/lib/usernames');
  const [list] = await conn.query(`SELECT u.id, u.tenant_id, u.email, COALESCE(p.first_name, sp.first_name) AS first_name, COALESCE(p.last_name, sp.last_name) AS last_name
    FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id
    LEFT JOIN staff s ON s.tenant_id = u.tenant_id AND s.id = u.staff_id LEFT JOIN people sp ON sp.tenant_id = s.tenant_id AND sp.id = s.person_id
    WHERE u.username IS NULL ORDER BY u.id`);
  for (const u of list) {
    const [taken] = await conn.query('SELECT username FROM users WHERE tenant_id = ? AND username IS NOT NULL', [u.tenant_id]);
    const name = suggestUsername(u, new Set(taken.map((r) => r.username)));
    await conn.query('UPDATE users SET username = ? WHERE id = ?', [name, u.id]);
  }
  return list.length;
}

/**
 * Patrol shifts used to be made in Staff and schedule, as shifts for a Patrol-department position. Upcoming ones move to
 * the Patrol schedule (same person, times, note and status) and the originals are canceled with a note saying where
 * they went. Past ones stay where they are, as history. Safe to re-run: a moved shift is canceled, so it is not seen again.
 */
async function movePatrolShifts(conn) {
  const [list] = await conn.query(`SELECT s.id, s.tenant_id, s.staff_id, s.starts_at, s.ends_at, s.notes, s.status, pos.name AS position FROM shifts s
    JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id AND pos.department = 'patrol'
    WHERE s.status <> 'cancelled' AND s.ends_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`);
  for (const s of list) {
    await conn.query('INSERT INTO patrol_shifts (tenant_id, staff_id, starts_at, ends_at, role_label, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [s.tenant_id, s.staff_id, s.starts_at, s.ends_at, s.position === 'Patroller' ? null : String(s.position).slice(0, 60), s.notes, s.status]);
    await conn.query("UPDATE shifts SET status = 'cancelled', notes = LEFT(CONCAT('Moved to the Patrol schedule. ', COALESCE(notes, '')), 200) WHERE id = ?", [s.id]);
  }
  return list.length;
}

async function backfillCaseNumbers(conn) {
  const [rows] = await conn.query('SELECT id, tenant_id, occurred_at FROM incidents WHERE seq IS NULL ORDER BY tenant_id, id');
  const next = new Map();
  for (const r of rows) {
    const season = seasonOf(r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at);
    const key = `${r.tenant_id}|${season}`;
    if (!next.has(key)) {
      const [[m]] = await conn.query('SELECT COALESCE(MAX(seq), 0) AS n FROM incidents WHERE tenant_id = ? AND season = ?', [r.tenant_id, season]);
      next.set(key, Number(m.n));
    }
    const seq = next.get(key) + 1;
    next.set(key, seq);
    await conn.query('UPDATE incidents SET season = ?, seq = ? WHERE id = ?', [season, seq, r.id]);
  }
  return rows.length;
}

// The launch plans and add-ons, as the product website lists them, made once when there are none. Prices and what each
// includes are changed afterwards in the console (Plans and prices), and the website follows.
async function seedPlans(conn) {
  const [[n]] = await conn.query('SELECT COUNT(*) AS n FROM billing_plans');
  if (Number(n.n)) return;
  const yearly = (m) => Math.round(m * 12 * 0.85) * 100; // 15% off, charged once a year
  const base = ['sell', 'catalog', 'gate', 'conditions', 'documents'];
  const mid = [...base, 'rentals', 'school', 'availability', 'programs', 'workforce', 'money'];
  const rows = [
    ['lodge', 'Lodge', 'Small hills and community areas that need to sell, scan and keep the lifts honest.', 'plan', base, 199, 1],
    ['mountain', 'Mountain', 'The typical independent mountain, with a ski school, a rental shop and a crew to schedule.', 'plan', mid, 449, 2],
    // Resort holds everything Mountain does plus five apps, for less than adding them one by one.
    ['resort', 'Resort', 'Larger operations with a patrol department, a terrain park and many hands.', 'plan', [...mid, 'patrol', 'park', 'shop', 'assets', 'messages'], 799, 3],
    // Patrol is the same price on its own or with a plan (see seedPatrolPlan).
    ['patrol', 'Patrol', 'Patient care reports, dispatch, duty, the closing sweep, medications and records, for any plan.', 'addon', ['patrol'], 149, 1],
    ['shop', 'Online shop', 'Guests buy lift tickets, passes and gift cards online, picking the day first.', 'addon', ['shop'], 79, 2],
    ['assets', 'Assets and fleet', 'Every machine and building system on one register, serviced on time and costed.', 'addon', ['assets'], 89, 3],
    ['messages', 'Messages', 'Email and texts to the guests who agreed to hear from you.', 'addon', ['messages'], 39, 4],
    ['doc-ocr', 'Document text recognition', 'Scanned PDFs and photos of paper become searchable.', 'addon', ['doc_ocr'], 29, 5],
    ['park', 'Terrain park', 'Features, daily inspections and the park map.', 'addon', ['park'], 49, 6],
  ];
  for (const [code, name, blurb, kind, modules, monthly, sort] of rows) {
    await conn.query('INSERT IGNORE INTO billing_plans (code, name, blurb, kind, modules, monthly_cents, yearly_cents, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [code, name, blurb, kind, modules.join(','), monthly * 100, code === 'patrol' ? 150000 : yearly(monthly), sort]);
  }
  console.log('Added the launch plans and add-ons (change them in the console, Plans and prices)');
}

// Verdynt/OS Patrol (2026.10.18): the plan for a patrol on its own, added once to installs that already have plans.
async function seedPatrolPlan(conn) {
  const [[has]] = await conn.query("SELECT COUNT(*) AS n FROM billing_plans WHERE code = 'patrol-only'");
  if (Number(has.n)) return;
  const [[top]] = await conn.query("SELECT COALESCE(MAX(sort), 0) AS s FROM billing_plans WHERE kind = 'plan'");
  await conn.query("INSERT INTO billing_plans (code, name, blurb, kind, modules, monthly_cents, yearly_cents, sort) VALUES ('patrol-only', 'Patrol only', ?, 'plan', 'patrol,documents', 14900, 150000, ?)",
    ['For a ski patrol on its own: patient care reports, dispatch, the roster and schedule, training, equipment, the closing sweep and records. The ski area gets a free read-only login.', Number(top.s) + 1]);
  console.log('Added the Patrol plan (for a patrol on its own)');
}

// The Assistant Plus add-on (2026.10.37): live questions about the mountain's own data, and the guest assistant.
async function seedAssistantAddon(conn) {
  const [[has]] = await conn.query("SELECT COUNT(*) AS n FROM billing_plans WHERE code = 'assistant-plus'");
  if (Number(has.n)) return;
  const [[any]] = await conn.query('SELECT COUNT(*) AS n FROM billing_plans');
  if (!Number(any.n)) return; // a fresh install seeds its plans first; this runs on the next migration
  const [[top]] = await conn.query("SELECT COALESCE(MAX(sort), 0) AS s FROM billing_plans WHERE kind = 'addon'");
  await conn.query("INSERT INTO billing_plans (code, name, blurb, kind, modules, monthly_cents, yearly_cents, sort) VALUES ('assistant-plus', 'Assistant Plus', ?, 'addon', 'assistant_plus', 6900, 70400, ?)",
    ['Ask about your own numbers (sales, rosters, lessons, who is on), and an assistant for guests on your online pages.', Number(top.s) + 1]);
  console.log('Added the Assistant Plus add-on');
}

async function main() {
  const conn = await mysql.createConnection({
    socketPath: config.db.socketPath,
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
    ssl: config.db.sslOptions,
  });
  await conn.query("SET time_zone = '+00:00'"); // the same clock as the app
  await conn.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'patrol.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'kiosk.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'park.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'ops.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'docs.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'availability.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'platform.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'rentals.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'board.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'customers.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'messages.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'shop.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'weekly.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'waivers.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'assets.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'gate.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'safety.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'inbox.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'review.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'release.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'workforce.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'patrolops.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'billing.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'site.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'security.sql'), 'utf8'));
  await conn.query(fs.readFileSync(path.join(__dirname, 'zerotrust.sql'), 'utf8'));
  await seedPlans(conn);
  await seedPatrolPlan(conn);
  await seedAssistantAddon(conn);
  let applied = 0;
  for (const [name, done, ddl] of [...steps, ...patrolSteps, ...kioskSteps, ...accessSteps, ...waiverSteps, ...careSteps, ...assetSteps, ...gateSteps, ...opsSteps, ...securitySteps, ...connectSteps, ...trySteps, ...terminalSteps, ...cardReturnSteps, ...lessonCancelSteps, ...pinSteps, ...guestTypeSteps, ...dayRecordSteps, ...mapFeatureSteps, ...storyFillSteps, ...programSessionSteps, ...programPlusSteps, ...assistantSteps, ...demoMailSteps, ...fieldKitSteps, ...staffInjurySteps, ...skiAreaSteps, ...reportRuleSteps, ...crewSteps, ...caseLinkSteps, ...injuryRegisterSteps, ...lostFoundSteps, ...kitSteps, ...teamSteps, ...prospectSteps, ...partnerSteps, ...outreachSteps, ...require('./steps/claims')({ tableExists, columnExists }), ...require('./steps/scene')({ tableExists, columnExists }), ...require('./steps/site')({ tableExists, columnExists }), ...require('./steps/pricing')({ tableExists, columnExists }), ...require('./steps/records')({ tableExists, columnExists })]) {
    if (await done(conn)) continue;
    for (const statement of Array.isArray(ddl) ? ddl : [ddl]) await conn.query(statement);
    applied += 1;
    console.log('Applied:', name);
  }
  const named = await backfillUsernames(conn);
  if (named) console.log(`Gave ${named} existing login${named === 1 ? '' : 's'} a username (their email still signs in too)`);
  if (!(await usernameIndex[1](conn))) { await conn.query(usernameIndex[2]); applied += 1; console.log('Applied:', usernameIndex[0]); }
  const moved = await movePatrolShifts(conn);
  if (moved) console.log(`Moved ${moved} upcoming patrol shift${moved === 1 ? '' : 's'} to the Patrol schedule`);
  // Keep the wording each mountain uses today, so waivers already signed against it can be shown word for word.
  await conn.query('INSERT IGNORE INTO waiver_texts (tenant_id, sha, body) SELECT id, SHA2(waiver_text, 256), waiver_text FROM tenants WHERE CHAR_LENGTH(waiver_text) > 0');
  await loadProspectBatches(conn);
  const numbered = await backfillCaseNumbers(conn);
  if (numbered) console.log(`Numbered ${numbered} existing incident report${numbered === 1 ? '' : 's'}`);
  await conn.end();
  if (skipped) {
    console.error(`Schema NOT complete on ${config.db.database}: ${applied} change${applied === 1 ? '' : 's'} applied, ${skipped} skipped (see the notes above). Fix them and run the migration again.`);
    process.exitCode = 2;
    return;
  }
  console.log(`Schema up to date on ${config.db.database} (${applied} change${applied === 1 ? '' : 's'} applied)`);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
