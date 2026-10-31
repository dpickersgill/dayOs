'use strict';
// 2026.11.11, Track OPS. Loaded by db/migrate.js. Additive and safe to run twice.
//   scans by time alone: the guests job (every 5 minutes) asks which mountains had scans in the last 40 minutes or day
//   (routes/guestsfair.js, lib/loyalty.js). The only time index led with tenant_id, so that read every scan of every
//   mountain each time. Built online (the table stays usable while it is made).
module.exports = () => [
  ['scans scanned_at alone index', async (c) => {
    const [r] = await c.query("SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'scans' AND index_name = 'ix_scans_at' LIMIT 1");
    return r.length > 0;
  }, 'ALTER TABLE scans ADD KEY ix_scans_at (scanned_at), ALGORITHM=INPLACE, LOCK=NONE'],
];
