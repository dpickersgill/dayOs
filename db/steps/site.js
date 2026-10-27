'use strict';
// Product website changes (contact form kinds and the like). Loaded by db/migrate.js.
// Each entry: [name, (conn) => Promise<boolean> already done, ddl].

// Does the column's type already list this value? (An ENUM gaining a value.)
const typeHas = async (conn, table, column, needle) => {
  const [r] = await conn.query('SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r.length && String(r[0].t).includes(needle));
};

module.exports = () => [
  // "Score ten of our reports, free": a request from the incident report guide, kept in the console's Leads.
  ['site_leads review kind', (c) => typeHas(c, 'site_leads', 'kind', "'review'"),
    "ALTER TABLE site_leads MODIFY kind ENUM('walkthrough','trial','founding','question','patrol','review') NOT NULL DEFAULT 'walkthrough'"],
];
