'use strict';
// The Resort plan's one line on the website (2026.11.2): it now names attractions. Changed here only while the line is
// still the launch wording, so a mountain's own wording from the console is kept. Loaded by db/migrate.js.
// Each entry: [name, (conn) => Promise<boolean> already done, ddl].

const OLD = 'Larger operations with a patrol department, a terrain park and many hands.';
const NEW = 'Larger operations with a patrol, a terrain park and attractions to run.';

module.exports = ({ tableExists }) => [
  ['billing_plans resort blurb names attractions', async (c) => {
    if (!(await tableExists(c, 'billing_plans'))) return true;
    const [r] = await c.query('SELECT COUNT(*) AS n FROM billing_plans WHERE code = ? AND blurb = ?', ['resort', OLD]);
    return !Number(r[0].n);
  }, `UPDATE billing_plans SET blurb = '${NEW}' WHERE code = 'resort' AND blurb = '${OLD}'`],
];
