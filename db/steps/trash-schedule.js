'use strict';
// Trash and recycling, the full app (release 2026.11.22, workstream "schedule"). Loaded by db/migrate.js.
// Additive and safe to run twice, on MySQL 8.4 and MariaDB.
//
// The shared tables (the release spec defines them; "routes" and "tonnage" create the same definitions, guarded, until
// this file is merged, so each CREATE here checks tableExists first):
//   collection_settings      one row per municipality: who collects (own crew, one hauler, licensed haulers), the hauler's
//                            contact for residents, the holiday rule, the reminder hour, and when setup was finished
//   collection_streams       Trash, Recycling, Yard waste...: how often, the week it runs on, its season, what goes in
//   collection_zones         a part of town with its own collection days ("Monday north")
//   collection_zone_days     the weekday each stream is collected in each zone (1 Monday ... 7 Sunday)
//   collection_zone_streets  the streets of a zone, whole or by house-number range and side; a street marked "not
//                            collected" has no zone
//   collection_holidays      the holidays the holiday rule moves collection around
//   collection_events        leaf collection, Christmas trees, household hazardous waste days: dated, for some or all zones
//   collection_changes       a collection day moved (or canceled) for snow, weather or another reason, for some or all zones
// This workstream's own:
//   collection_settings.ordinance_materials / curb_by / repeat_thread_id   the recycling ordinance's list, "out by" time,
//                            and the managers' Inbox conversation for repeat missed pickups (added apart from the shared
//                            CREATE, so they arrive whichever copy of the table was made first)
//   collection_reminder_sends  one row per night-before reminder per phone or email and day (so each goes once); the
//                            address is kept only as a keyed hash
//   collection_education     the Act 101 education log: each reminder, mailer, newsletter or event, and when
//   alert_signups.collection_streams  which streams an alert sign-up wants a reminder for the night before
//   street_notices.collection_zone_ids the zones a street notice was aimed at (its streets come from them)
//   request_categories.code  'missed' marks the Missed pickup category (renamed from "Missed trash or recycling" by id)
//   requests.stream_id, requests.pickup_check   the stream a missed pickup is about, and what the schedule check said
//   billing_plans            muni-routes and muni-hauler ($1,200 a year each), and the Trash and recycling blurb

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
const SOLIDWASTE_BLURB = 'The collection schedule and calendar for residents, reminders, missed pickups, carts, bulk pickup booked and paid online, and the annual recycling report.';
const PLANS = [
  ['muni-routes', 'Collection routes', 'For a borough with its own crew: the driver\'s route on a phone, each street marked done or not collected, weigh tickets, tonnage and what each collection day costs.', 'collectionroutes', 10000, 6],
  ['muni-hauler', 'Hauler oversight', 'For a borough with a contracted hauler: the contract, missed pickups sent to the hauler, the hauler\'s monthly reports and a scorecard.', 'hauler', 10000, 7],
];
const indexExists = async (c, table, name) => (await c.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1', [table, name]))[0].length > 0;

module.exports = ({ tableExists, columnExists }) => [
  ['collection_settings', (c) => tableExists(c, 'collection_settings'), `CREATE TABLE collection_settings (
    tenant_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    model          ENUM('inhouse','contract','subscription') NOT NULL DEFAULT 'inhouse',
    hauler_name    VARCHAR(120) NULL,
    hauler_phone   VARCHAR(40) NULL,
    hauler_email   VARCHAR(255) NULL,
    hauler_url     VARCHAR(255) NULL,
    holiday_rule   ENUM('shift','none','skip') NOT NULL DEFAULT 'shift',
    reminder_hour  TINYINT NOT NULL DEFAULT 18,
    setup_done_at  DATETIME NULL,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_collection_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['collection_streams', (c) => tableExists(c, 'collection_streams'), `CREATE TABLE collection_streams (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    name          VARCHAR(60) NOT NULL,
    kind          ENUM('trash','recycling','yard','food','other') NOT NULL DEFAULT 'other',
    frequency     ENUM('weekly','biweekly','monthly') NOT NULL DEFAULT 'weekly',
    anchor_date   DATE NULL,
    season_start  CHAR(5) NULL,
    season_end    CHAR(5) NULL,
    color         VARCHAR(7) NOT NULL DEFAULT '#5b6770',
    materials     TEXT NULL,
    not_accepted  TEXT NULL,
    sort          INT NOT NULL DEFAULT 0,
    active        TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_collection_streams_tenant_id (tenant_id, id),
    CONSTRAINT fk_collection_streams_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['collection_zones', (c) => tableExists(c, 'collection_zones'), `CREATE TABLE collection_zones (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    name       VARCHAR(60) NOT NULL,
    sort       INT NOT NULL DEFAULT 0,
    active     TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_collection_zones_tenant_id (tenant_id, id),
    CONSTRAINT fk_collection_zones_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['collection_zone_days', (c) => tableExists(c, 'collection_zone_days'), `CREATE TABLE collection_zone_days (
    tenant_id  BIGINT UNSIGNED NOT NULL,
    zone_id    BIGINT UNSIGNED NOT NULL,
    stream_id  BIGINT UNSIGNED NOT NULL,
    weekday    TINYINT NOT NULL,
    PRIMARY KEY (tenant_id, zone_id, stream_id),
    CONSTRAINT fk_collection_zone_days_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_collection_zone_days_zone FOREIGN KEY (tenant_id, zone_id) REFERENCES collection_zones(tenant_id, id),
    CONSTRAINT fk_collection_zone_days_stream FOREIGN KEY (tenant_id, stream_id) REFERENCES collection_streams(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['collection_zone_streets', (c) => tableExists(c, 'collection_zone_streets'), `CREATE TABLE collection_zone_streets (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    zone_id        BIGINT UNSIGNED NULL,
    street_id      BIGINT UNSIGNED NOT NULL,
    from_no        INT NULL,
    to_no          INT NULL,
    side           ENUM('both','odd','even') NOT NULL DEFAULT 'both',
    not_collected  TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE KEY uq_collection_zone_streets_tenant_id (tenant_id, id),
    KEY ix_collection_zone_streets_street (tenant_id, street_id),
    KEY ix_collection_zone_streets_zone (tenant_id, zone_id),
    CONSTRAINT fk_collection_zone_streets_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_collection_zone_streets_zone FOREIGN KEY (tenant_id, zone_id) REFERENCES collection_zones(tenant_id, id),
    CONSTRAINT fk_collection_zone_streets_street FOREIGN KEY (tenant_id, street_id) REFERENCES streets(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['collection_holidays', (c) => tableExists(c, 'collection_holidays'), `CREATE TABLE collection_holidays (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    on_date    DATE NOT NULL,
    name       VARCHAR(80) NOT NULL,
    UNIQUE KEY uq_collection_holidays_tenant_id (tenant_id, id),
    UNIQUE KEY uq_collection_holidays_date (tenant_id, on_date),
    CONSTRAINT fk_collection_holidays_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['collection_events', (c) => tableExists(c, 'collection_events'), `CREATE TABLE collection_events (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    kind       ENUM('leaf','tree','hazardous','other') NOT NULL DEFAULT 'other',
    name       VARCHAR(120) NOT NULL,
    starts_on  DATE NOT NULL,
    ends_on    DATE NOT NULL,
    notes      TEXT NULL,
    zone_ids   JSON NULL,
    UNIQUE KEY uq_collection_events_tenant_id (tenant_id, id),
    KEY ix_collection_events_dates (tenant_id, starts_on),
    CONSTRAINT fk_collection_events_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['collection_changes', (c) => tableExists(c, 'collection_changes'), `CREATE TABLE collection_changes (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    on_date     DATE NOT NULL,
    moved_to    DATE NULL,
    zone_ids    JSON NULL,
    reason      ENUM('snow','weather','holiday','other') NOT NULL DEFAULT 'other',
    note        VARCHAR(255) NULL,
    notice_id   BIGINT UNSIGNED NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_collection_changes_tenant_id (tenant_id, id),
    KEY ix_collection_changes_date (tenant_id, on_date),
    KEY ix_collection_changes_moved (tenant_id, moved_to),
    CONSTRAINT fk_collection_changes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],

  // ---- this workstream's own
  ['collection_settings.ordinance_materials', (c) => columnExists(c, 'collection_settings', 'ordinance_materials'), 'ALTER TABLE collection_settings ADD COLUMN ordinance_materials TEXT NULL'],
  ['collection_settings.curb_by', (c) => columnExists(c, 'collection_settings', 'curb_by'), "ALTER TABLE collection_settings ADD COLUMN curb_by VARCHAR(80) NULL"],
  ['collection_settings.repeat_thread_id', (c) => columnExists(c, 'collection_settings', 'repeat_thread_id'), 'ALTER TABLE collection_settings ADD COLUMN repeat_thread_id BIGINT UNSIGNED NULL'],
  ['collection_reminder_sends', (c) => tableExists(c, 'collection_reminder_sends'), `CREATE TABLE collection_reminder_sends (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    for_date    DATE NOT NULL,
    channel     ENUM('sms','email') NOT NULL,
    addr_hash   CHAR(64) NOT NULL,
    signup_id   BIGINT UNSIGNED NULL,
    streams     VARCHAR(200) NOT NULL,
    status      ENUM('sending','sent','failed','opted_out') NOT NULL DEFAULT 'sending',
    error       VARCHAR(200) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_collection_reminder_sends_tenant_id (tenant_id, id),
    UNIQUE KEY uq_collection_reminder_once (tenant_id, for_date, channel, addr_hash),
    KEY ix_collection_reminder_month (tenant_id, for_date, status),
    CONSTRAINT fk_collection_reminder_sends_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['collection_education', (c) => tableExists(c, 'collection_education'), `CREATE TABLE collection_education (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    on_date     DATE NOT NULL,
    kind        ENUM('mailer','newsletter','website','event','notice','reminder','other') NOT NULL DEFAULT 'other',
    printed     TINYINT(1) NOT NULL DEFAULT 0,
    title       VARCHAR(160) NOT NULL,
    audience    VARCHAR(160) NULL,
    copies      INT UNSIGNED NULL,
    note        VARCHAR(500) NULL,
    created_by  BIGINT UNSIGNED NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_collection_education_tenant_id (tenant_id, id),
    KEY ix_collection_education_date (tenant_id, on_date),
    CONSTRAINT fk_collection_education_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['alert_signups.collection_streams', (c) => columnExists(c, 'alert_signups', 'collection_streams'), 'ALTER TABLE alert_signups ADD COLUMN collection_streams VARCHAR(500) NULL'],
  ['street_notices.collection_zone_ids', (c) => columnExists(c, 'street_notices', 'collection_zone_ids'), 'ALTER TABLE street_notices ADD COLUMN collection_zone_ids JSON NULL'],
  ['request_categories.code', (c) => columnExists(c, 'request_categories', 'code'), 'ALTER TABLE request_categories ADD COLUMN code VARCHAR(20) NULL'],
  ['request_categories one code per municipality', (c) => indexExists(c, 'request_categories', 'uq_request_categories_code'), 'ALTER TABLE request_categories ADD UNIQUE KEY uq_request_categories_code (tenant_id, code)'],
  // The missed pickup category is found once by its old name and marked; from then on it is known by its code (its id),
  // so a manager who renames it again changes nothing here. Requests keep pointing at the same category id.
  ['request_categories: mark the missed pickup category', async (c) => {
    const [r] = await c.query("SELECT COUNT(*) AS n FROM request_categories WHERE name = 'Missed trash or recycling' AND code IS NULL");
    return Number(r[0].n) === 0;
  }, "UPDATE IGNORE request_categories SET code = 'missed' WHERE name = 'Missed trash or recycling' AND code IS NULL"],
  // IGNORE: a municipality that already has a category called Missed pickup keeps both names as they are.
  ['request_categories: Missed pickup', async (c) => {
    const [r] = await c.query("SELECT COUNT(*) AS n FROM request_categories WHERE code = 'missed' AND name = 'Missed trash or recycling'");
    return Number(r[0].n) === 0;
  }, "UPDATE IGNORE request_categories SET name = 'Missed pickup' WHERE code = 'missed' AND name = 'Missed trash or recycling'"],
  ['requests.stream_id', (c) => columnExists(c, 'requests', 'stream_id'), 'ALTER TABLE requests ADD COLUMN stream_id BIGINT UNSIGNED NULL'],
  ['requests.pickup_check', (c) => columnExists(c, 'requests', 'pickup_check'), 'ALTER TABLE requests ADD COLUMN pickup_check VARCHAR(20) NULL'],
  ['requests missed pickups by address', (c) => indexExists(c, 'requests', 'ix_requests_place'), 'ALTER TABLE requests ADD KEY ix_requests_place (tenant_id, street_id, house_number, reported_at)'],

  // ---- billing
  ...PLANS.map(([code, name, blurb, modules, monthly, sort]) => [`billing_plans ${code}`, async (c) => {
    if (!(await tableExists(c, 'billing_plans'))) return true;
    const [r] = await c.query('SELECT COUNT(*) AS n FROM billing_plans WHERE code = ?', [code]);
    return Number(r[0].n) > 0;
  }, `INSERT INTO billing_plans (code, name, blurb, kind, modules, monthly_cents, yearly_cents, sort, org_type)
     SELECT ${q(code)}, ${q(name)}, ${q(blurb)}, 'addon', ${q(modules)}, ${monthly}, ${monthly * 12}, ${sort}, 'municipality' FROM DUAL
     WHERE NOT EXISTS (SELECT 1 FROM billing_plans WHERE code = ${q(code)})`]),
  ['billing_plans muni-solidwaste blurb', async (c) => {
    if (!(await tableExists(c, 'billing_plans'))) return true;
    const [r] = await c.query("SELECT COUNT(*) AS n FROM billing_plans WHERE code = 'muni-solidwaste' AND blurb <> ?", [SOLIDWASTE_BLURB]);
    return Number(r[0].n) === 0;
  }, `UPDATE billing_plans SET blurb = ${q(SOLIDWASTE_BLURB)} WHERE code = 'muni-solidwaste'`],
];

module.exports.PLANS = PLANS;
