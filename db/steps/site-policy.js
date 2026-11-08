'use strict';
// Website policy and brand review (November 2026): the Good Day scorecard's emailed results, kept in the console's Leads.
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Safe to run twice.

const typeHas = async (conn, table, column, needle) => {
  const [r] = await conn.query('SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r.length && String(r[0].t).includes(needle));
};

module.exports = () => [
  ['site_leads scorecard kind', (c) => typeHas(c, 'site_leads', 'kind', "'scorecard'"),
    "ALTER TABLE site_leads MODIFY kind ENUM('walkthrough','trial','founding','question','patrol','review','setup','scorecard') NOT NULL DEFAULT 'walkthrough'"],
];
