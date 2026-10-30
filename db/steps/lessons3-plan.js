'use strict';
// Lesson planning, best of breed (2026.11.9), Track PLAN: lessons made by a season plan carry origin 'plan' (with plan_id
// and plan_slot from lessons3), so a re-publish finds them and undo removes only them. Loaded by db/migrate.js right after
// lessons3. Each entry: [name, (conn) => done?, ddl].
const typeHas = async (c, table, column, text) => {
  const [r] = await c.query('SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r.length && String(r[0].t).includes(text));
};

module.exports = ({ columnExists }) => [
  // Every value the column had before stays; 'plan' is added at the end.
  ['lesson_sessions.origin plan', (c) => typeHas(c, 'lesson_sessions', 'origin', "'plan'"),
    "ALTER TABLE lesson_sessions MODIFY COLUMN origin ENUM('manual','series','copy','split','request','rebook','plan') NOT NULL DEFAULT 'manual'"],
  // A publish also keeps the private lesson hours it replaced (so undo puts them back) its counts in words, and
  // a fingerprint of the plan it published (the editor says "Changes not published yet" when the plan differs).
  ['lesson_plan_publishes.private_before', (c) => columnExists(c, 'lesson_plan_publishes', 'private_before'),
    'ALTER TABLE lesson_plan_publishes ADD COLUMN private_before MEDIUMTEXT NULL, ADD COLUMN summary VARCHAR(400) NULL, ADD COLUMN doc_sha CHAR(64) NULL'],
];
