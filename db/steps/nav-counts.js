'use strict';
// Release 2026.11.21, workstream "counts": the forecast fix. Loaded by db/migrate.js. Safe to run twice.
//   (data) daily_snapshots   forecast data is a ski area's (presales, ticket prices, mountain weather, lib/snapshots.js).
//                            Before this release the morning run and scripts/snapshot-backfill.js wrote rows for
//                            municipalities too. They are removed here; nothing reads them, and none are written again.

module.exports = ({ tableExists }) => [
  ['daily_snapshots: none for a municipality', async (c) => {
    if (!(await tableExists(c, 'daily_snapshots'))) return true;
    const [r] = await c.query("SELECT COUNT(*) AS n FROM daily_snapshots s JOIN tenants t ON t.id = s.tenant_id WHERE t.org_type = 'municipality'");
    return Number(r[0].n) === 0;
  }, "DELETE s FROM daily_snapshots s JOIN tenants t ON t.id = s.tenant_id WHERE t.org_type = 'municipality'"],
];
