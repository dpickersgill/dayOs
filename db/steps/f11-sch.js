'use strict';
// 2026.11.11 fixes, track SCHOOL AND GUEST. Loaded by db/migrate.js. Additive and safe to run twice.
//   household_invites  a second adult added on a household account is only given the email typed for them once that
//                      person confirms it from the email (G3). Until then the record has no email, so no sign-in or online
//                      sale can match it. The table is created last, so an interrupted run repeats the backfill (INSERT
//                      IGNORE) before it counts as done.
//   guardian backfill  the family page now counts only guardian links (G1). Children staff enrolled with a guardian named
//                      (a window sale, or the desk's Enroll, recorded in the audit log) get that guardian link, so their
//                      parents keep seeing them. Online registrations and waitlist entries are never backfilled.
//   people.source      records already added on a household account (audit 'account_person_add') are marked 'household',
//                      so online sales stop matching them by the name and email the other guest typed.
module.exports = ({ tableExists }) => [
  ['household_invites', (c) => tableExists(c, 'household_invites'), [
    `INSERT IGNORE INTO person_links (tenant_id, adult_id, member_id, relation)
      SELECT DISTINCT e.tenant_id, e.guardian_id, e.person_id, 'guardian' FROM program_enrollments e
      WHERE e.guardian_id IS NOT NULL AND e.guardian_id <> e.person_id
        AND NOT EXISTS (SELECT 1 FROM person_links l WHERE l.tenant_id = e.tenant_id AND ((l.adult_id = e.guardian_id AND l.member_id = e.person_id) OR (l.adult_id = e.person_id AND l.member_id = e.guardian_id)))
        AND (EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = e.tenant_id AND o.id = e.order_id AND o.channel <> 'online')
          OR EXISTS (SELECT 1 FROM audit_log a WHERE a.tenant_id = e.tenant_id AND a.action = 'enroll' AND a.entity = 'programs' AND a.entity_id = e.program_id AND a.user_id IS NOT NULL
            AND CAST(JSON_UNQUOTE(JSON_EXTRACT(a.detail, '$.person_id')) AS UNSIGNED) = e.person_id))`,
    `UPDATE people p JOIN audit_log a ON a.tenant_id = p.tenant_id AND a.entity = 'people' AND a.entity_id = p.id AND a.action = 'account_person_add'
      SET p.source = 'household' WHERE p.source = 'online'`,
    `CREATE TABLE household_invites (
      id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id    BIGINT UNSIGNED NOT NULL,
      person_id    BIGINT UNSIGNED NOT NULL,
      invited_by   BIGINT UNSIGNED NOT NULL,
      email        VARCHAR(255) NOT NULL,
      token_hash   CHAR(64) NOT NULL,
      expires_at   DATETIME NOT NULL,
      confirmed_at DATETIME NULL,
      created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_household_invite (token_hash),
      KEY ix_household_invite_person (tenant_id, person_id),
      KEY ix_household_invite_by (tenant_id, invited_by, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ]],
];
