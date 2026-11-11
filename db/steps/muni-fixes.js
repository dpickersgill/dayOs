'use strict';
// Review fixes for the municipal release (2026.11.19). Loaded by db/migrate.js. Additive and safe to run twice, on
// MySQL 8.4 and MariaDB.
//   requests.contact_*, bulk_bookings.contact_*   what the person typed on the report or booking (name, phone, email),
//                                                  kept on the row itself: a public form never rewrites a resident
//   alert_signups.name, resident_id NULL           a sign-up keeps the name it was given, and joins a resident only once
//                                                  a phone or email on it is confirmed (code or link)
//   street_notice_settings.certified_operators     the logins a manager marked as certified water operators (boil water)
//   street_notice_settings unique from_number      a texting number belongs to one municipality only
//   bulk_bookings.message_note                     "Text not sent: daily limit for this phone", for staff
//   public_sends                                   per-destination counts for messages the public pages trigger (a keyed
//                                                  hash of the phone or email, never the address itself)

const num = async (c, sql) => Number((await c.query(sql))[0][0].n);
const indexExists = async (c, table, name) => {
  const [r] = await c.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?', [table, name]);
  return r.length > 0;
};
const nullable = async (c, table, column) => {
  const [r] = await c.query('SELECT is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r[0] && r[0].n === 'YES');
};

module.exports = ({ tableExists, columnExists }) => [
  ['requests.contact_name', (c) => columnExists(c, 'requests', 'contact_name'),
    'ALTER TABLE requests ADD COLUMN contact_name VARCHAR(120) NULL, ADD COLUMN contact_phone VARCHAR(30) NULL, ADD COLUMN contact_email VARCHAR(190) NULL'],
  ['requests.contact backfill', async (c) => !(await columnExists(c, 'requests', 'contact_name')) || (await num(c, `SELECT COUNT(*) AS n FROM requests r JOIN residents x ON x.tenant_id = r.tenant_id AND x.id = r.resident_id
      WHERE r.contact_name IS NULL AND r.contact_phone IS NULL AND r.contact_email IS NULL AND (x.name IS NOT NULL OR x.phone IS NOT NULL OR x.email IS NOT NULL)`)) === 0,
  `UPDATE requests r JOIN residents x ON x.tenant_id = r.tenant_id AND x.id = r.resident_id SET r.contact_name = x.name, r.contact_phone = x.phone, r.contact_email = x.email
      WHERE r.contact_name IS NULL AND r.contact_phone IS NULL AND r.contact_email IS NULL`],
  ['bulk_bookings.contact_name', (c) => columnExists(c, 'bulk_bookings', 'contact_name'),
    'ALTER TABLE bulk_bookings ADD COLUMN contact_name VARCHAR(120) NULL, ADD COLUMN contact_phone VARCHAR(30) NULL, ADD COLUMN contact_email VARCHAR(190) NULL'],
  ['bulk_bookings.contact backfill', async (c) => !(await columnExists(c, 'bulk_bookings', 'contact_name')) || (await num(c, `SELECT COUNT(*) AS n FROM bulk_bookings b JOIN residents x ON x.tenant_id = b.tenant_id AND x.id = b.resident_id
      WHERE b.contact_name IS NULL AND b.contact_phone IS NULL AND b.contact_email IS NULL AND (x.name IS NOT NULL OR x.phone IS NOT NULL OR x.email IS NOT NULL)`)) === 0,
  `UPDATE bulk_bookings b JOIN residents x ON x.tenant_id = b.tenant_id AND x.id = b.resident_id SET b.contact_name = x.name, b.contact_phone = x.phone, b.contact_email = x.email
      WHERE b.contact_name IS NULL AND b.contact_phone IS NULL AND b.contact_email IS NULL`],
  ['alert_signups.name', (c) => columnExists(c, 'alert_signups', 'name'), 'ALTER TABLE alert_signups ADD COLUMN name VARCHAR(120) NULL AFTER resident_id'],
  ['alert_signups.name backfill', async (c) => !(await columnExists(c, 'alert_signups', 'name')) || (await num(c, `SELECT COUNT(*) AS n FROM alert_signups s JOIN residents x ON x.tenant_id = s.tenant_id AND x.id = s.resident_id
      WHERE s.name IS NULL AND x.name IS NOT NULL`)) === 0,
  'UPDATE alert_signups s JOIN residents x ON x.tenant_id = s.tenant_id AND x.id = s.resident_id SET s.name = x.name WHERE s.name IS NULL'],
  ['alert_signups.resident_id nullable', (c) => nullable(c, 'alert_signups', 'resident_id'), 'ALTER TABLE alert_signups MODIFY COLUMN resident_id BIGINT UNSIGNED NULL'],
  ['street_notice_settings.certified_operators', (c) => columnExists(c, 'street_notice_settings', 'certified_operators'),
    'ALTER TABLE street_notice_settings ADD COLUMN certified_operators VARCHAR(1000) NULL'],
  // A number given to two municipalities keeps only the first; the platform operator sets the other one again.
  ['street_notice_settings.from_number one owner', async (c) => (await num(c, `SELECT COUNT(*) AS n FROM street_notice_settings a JOIN street_notice_settings b
      ON b.from_number = a.from_number AND b.tenant_id < a.tenant_id WHERE a.from_number IS NOT NULL`)) === 0,
  `UPDATE street_notice_settings a JOIN (SELECT from_number, MIN(tenant_id) AS keep FROM street_notice_settings WHERE from_number IS NOT NULL GROUP BY from_number) k
      ON k.from_number = a.from_number SET a.from_number = NULL WHERE a.tenant_id <> k.keep`],
  ['street_notice_settings unique from_number', (c) => indexExists(c, 'street_notice_settings', 'uq_street_notice_settings_from'),
    'ALTER TABLE street_notice_settings ADD UNIQUE KEY uq_street_notice_settings_from (from_number)'],
  ['bulk_bookings.message_note', (c) => columnExists(c, 'bulk_bookings', 'message_note'), 'ALTER TABLE bulk_bookings ADD COLUMN message_note VARCHAR(200) NULL'],
  ['street_notices.held_note', (c) => columnExists(c, 'street_notices', 'held_note'), 'ALTER TABLE street_notices ADD COLUMN held_note VARCHAR(255) NULL'],
  ['public_sends', (c) => tableExists(c, 'public_sends'), `CREATE TABLE public_sends (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    kind        ENUM('submit','sms','email','skipped') NOT NULL,
    channel     ENUM('sms','email') NOT NULL,
    dest        CHAR(64) NOT NULL,
    tag         VARCHAR(40) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_public_sends_tenant_id (tenant_id, id),
    KEY ix_public_sends_dest (tenant_id, dest, kind, created_at),
    KEY ix_public_sends_created (created_at),
    CONSTRAINT fk_public_sends_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
];
