'use strict';
// Release 2026.11.20, assembly: an on-call rotation belongs to one of the municipality's departments (workstream money's
// departments table) instead of a typed name. Loaded by db/migrate.js. Additive and safe to run twice.
//   oncall_rotations.department_id   the department (departments.id, same tenant); the old typed name stays in
//                                    oncall_rotations.department until it is matched or a manager picks one
//   (data)                           a typed name that is a department's name (any case) becomes that department
//   service_addresses.account_number  keeps only the last 4 letters or digits of a water customer's account number (the
//                                    import matches on match_key, a keyed hash, so the whole number is not needed)
//   sms_stops                        a texted STOP for the number it went to (scope_tenant 0: the shared numbers), kept
//                                    as a keyed hash of the phone even when no list has the phone yet

module.exports = ({ tableExists, columnExists }) => [
  ['oncall_rotations.department_id', (c) => columnExists(c, 'oncall_rotations', 'department_id'),
    'ALTER TABLE oncall_rotations ADD COLUMN department_id BIGINT UNSIGNED NULL AFTER department'],
  ['oncall_rotations department names to departments', async (c) => {
    const [r] = await c.query(`SELECT COUNT(*) AS n FROM oncall_rotations r JOIN departments d ON d.tenant_id = r.tenant_id AND LOWER(d.name) = LOWER(TRIM(r.department))
      WHERE r.department_id IS NULL AND r.department IS NOT NULL`);
    return Number(r[0].n) === 0;
  }, `UPDATE oncall_rotations r JOIN departments d ON d.tenant_id = r.tenant_id AND LOWER(d.name) = LOWER(TRIM(r.department))
      SET r.department_id = d.id, r.department = NULL WHERE r.department_id IS NULL AND r.department IS NOT NULL`],
  ['service_addresses.account_number to the last 4', async (c) => {
    if (!(await tableExists(c, 'service_addresses'))) return true;
    const [r] = await c.query("SELECT COUNT(*) AS n FROM service_addresses WHERE account_number IS NOT NULL AND (CHAR_LENGTH(account_number) > 4 OR account_number REGEXP '[^0-9A-Za-z]')");
    return Number(r[0].n) === 0;
  }, "UPDATE service_addresses SET account_number = NULLIF(RIGHT(REGEXP_REPLACE(account_number, '[^0-9A-Za-z]', ''), 4), '') WHERE account_number IS NOT NULL AND (CHAR_LENGTH(account_number) > 4 OR account_number REGEXP '[^0-9A-Za-z]')"],
  // A texted STOP, kept for the number it was sent to (lib/smsstops.js): a keyed hash of the phone, never the number.
  ['sms_stops', (c) => tableExists(c, 'sms_stops'), `CREATE TABLE sms_stops (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    phone_hash    CHAR(64) NOT NULL,
    scope_tenant  BIGINT UNSIGNED NOT NULL DEFAULT 0,
    stopped_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_sms_stops (phone_hash, scope_tenant)
  ) ENGINE=InnoDB`],
];
