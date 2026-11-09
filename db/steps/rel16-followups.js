'use strict';
// Guest help release follow-ups (2026.11.16). Loaded by db/migrate.js, after help-places, help-guest and help-sms.
// Safe to run twice, on MySQL 8.4 and MariaDB, and on a 2026.11.12 or later database.
//
//   patrol_help_lines.help_number nullable   the one place for a mountain's two guest numbers (Patrol settings, Text
//                                            HELP): the number guests text, and the patrol phone. A mountain may set
//                                            the patrol phone (Call patrol on the guest page) without Text HELP.
//   tenants.guest_help_phone/_sms moved      a database that ran the help/guest branch before the merge has the patrol
//                                            phone and the text number on tenants too. Their values move to
//                                            patrol_help_lines (a value already there wins), then the columns go.

// A number as Text HELP keeps it (+16105550100): 10 digits are a US or Canadian number, 11 starting with 1 the same with
// its country code, and a number written with + keeps its digits. Anything else is left out (NULL).
const e164 = (col) => `(CASE
    WHEN ${col} IS NULL THEN NULL
    WHEN TRIM(${col}) LIKE '+%' AND CHAR_LENGTH(REGEXP_REPLACE(${col}, '[^0-9]', '')) BETWEEN 8 AND 15 THEN CONCAT('+', REGEXP_REPLACE(${col}, '[^0-9]', ''))
    WHEN CHAR_LENGTH(REGEXP_REPLACE(${col}, '[^0-9]', '')) = 10 THEN CONCAT('+1', REGEXP_REPLACE(${col}, '[^0-9]', ''))
    WHEN CHAR_LENGTH(REGEXP_REPLACE(${col}, '[^0-9]', '')) = 11 AND REGEXP_REPLACE(${col}, '[^0-9]', '') LIKE '1%' THEN CONCAT('+', REGEXP_REPLACE(${col}, '[^0-9]', ''))
    ELSE NULL END)`;

module.exports = ({ columnExists }) => [
  ['patrol_help_lines.help_number nullable', async (c) => {
    const [r] = await c.query("SELECT is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'patrol_help_lines' AND column_name = 'help_number'");
    return !r.length || r[0].n === 'YES';
  }, 'ALTER TABLE patrol_help_lines MODIFY COLUMN help_number VARCHAR(16) NULL'],

  // Done when tenants has no guest_help_phone (every database made from this release on, and every one that never ran
  // the help/guest branch). The copy takes a text number only when no other mountain has it (it is unique, and an
  // inbound text finds its mountain by it); the patrol phone always comes along. Then the duplicates are dropped.
  ['tenants.guest_help_phone moved', async (c) => !(await columnExists(c, 'tenants', 'guest_help_phone')), [
    `INSERT INTO patrol_help_lines (tenant_id, help_number, patrol_phone)
      SELECT x.id, IF(x.sms IS NULL OR EXISTS (SELECT 1 FROM patrol_help_lines o WHERE o.help_number COLLATE utf8mb4_unicode_ci = x.sms AND o.tenant_id <> x.id)
          OR EXISTS (SELECT 1 FROM tenants y WHERE y.id < x.id AND ${e164('y.guest_help_sms')} = x.sms), NULL, x.sms), x.phone
      FROM (SELECT t.id, ${e164('t.guest_help_sms')} AS sms, LEFT(COALESCE(${e164('t.guest_help_phone')}, NULLIF(TRIM(t.guest_help_phone), '')), 20) AS phone
        FROM tenants t WHERE NULLIF(TRIM(t.guest_help_phone), '') IS NOT NULL OR NULLIF(TRIM(t.guest_help_sms), '') IS NOT NULL) x
      WHERE x.sms IS NOT NULL OR x.phone IS NOT NULL
      ON DUPLICATE KEY UPDATE help_number = COALESCE(patrol_help_lines.help_number, VALUES(help_number)),
        patrol_phone = COALESCE(patrol_help_lines.patrol_phone, VALUES(patrol_phone))`,
    'ALTER TABLE tenants DROP COLUMN guest_help_phone, DROP COLUMN guest_help_sms',
  ]],
];
