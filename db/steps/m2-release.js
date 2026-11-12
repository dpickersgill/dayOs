'use strict';
// Release 2026.11.20, assembly: an on-call rotation belongs to one of the municipality's departments (workstream money's
// departments table) instead of a typed name. Loaded by db/migrate.js. Additive and safe to run twice.
//   oncall_rotations.department_id   the department (departments.id, same tenant); the old typed name stays in
//                                    oncall_rotations.department until it is matched or a manager picks one
//   (data)                           a typed name that is a department's name (any case) becomes that department

module.exports = ({ columnExists }) => [
  ['oncall_rotations.department_id', (c) => columnExists(c, 'oncall_rotations', 'department_id'),
    'ALTER TABLE oncall_rotations ADD COLUMN department_id BIGINT UNSIGNED NULL AFTER department'],
  ['oncall_rotations department names to departments', async (c) => {
    const [r] = await c.query(`SELECT COUNT(*) AS n FROM oncall_rotations r JOIN departments d ON d.tenant_id = r.tenant_id AND LOWER(d.name) = LOWER(TRIM(r.department))
      WHERE r.department_id IS NULL AND r.department IS NOT NULL`);
    return Number(r[0].n) === 0;
  }, `UPDATE oncall_rotations r JOIN departments d ON d.tenant_id = r.tenant_id AND LOWER(d.name) = LOWER(TRIM(r.department))
      SET r.department_id = d.id, r.department = NULL WHERE r.department_id IS NULL AND r.department IS NOT NULL`],
];
