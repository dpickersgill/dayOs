'use strict';
// School only (2026.11.9): a ski school that signs up on its own, the way Patrol only already can. Loaded by db/migrate.js.

// Does the column's type already list this value? (An ENUM gaining a value.)
const typeHas = async (conn, table, column, needle) => {
  const [r] = await conn.query('SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r.length && String(r[0].t).includes(needle));
};

module.exports = () => [
  // "School only, for our ski school" on the Contact form, the same way "Patrol only" already is.
  ['site_leads school kind', (c) => typeHas(c, 'site_leads', 'kind', "'school'"),
    "ALTER TABLE site_leads MODIFY kind ENUM('walkthrough','trial','founding','question','patrol','review','setup','scorecard','school') NOT NULL DEFAULT 'walkthrough'"],
];
