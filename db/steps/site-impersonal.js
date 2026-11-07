'use strict';
// The website and its emails speak as the company, never as a named person. Loaded by db/migrate.js. Safe to run twice.
//   goodday_settings.from_name  the default sender is "The Good Day"; a row still on the old personal default moves too
//                               (a name an operator typed in the console is left as it is)
const OLD = 'Dan at The Good Day';
const columnDefault = async (c, table, column) => {
  const [[r]] = await c.query('SELECT column_default AS d FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return r ? String(r.d || r.COLUMN_DEFAULT || '').replace(/^'|'$/g, '') : null;
};

module.exports = ({ tableExists }) => [
  ['goodday_settings.from_name default', async (c) => !(await tableExists(c, 'goodday_settings')) || (await columnDefault(c, 'goodday_settings', 'from_name')) !== OLD,
    "ALTER TABLE goodday_settings MODIFY from_name VARCHAR(100) NOT NULL DEFAULT 'The Good Day'"],
  ['goodday_settings.from_name company', async (c) => {
    if (!(await tableExists(c, 'goodday_settings'))) return true;
    const [[r]] = await c.query('SELECT COUNT(*) AS n FROM goodday_settings WHERE from_name = ?', [OLD]);
    return Number(r.n) === 0;
  }, `UPDATE goodday_settings SET from_name = 'The Good Day' WHERE from_name = '${OLD}'`],
];
