'use strict';

// PHASE 1 STUB (workstream "tonnage"): the one function of src/lib/collection.js (workstream "schedule") that carts and
// tonnage call, with the spec's signature, until "schedule" is merged. Phase 2 deletes this file, and lib/carts.js and lib/tonnage.js
// requires ./collection directly.
const { rows } = require('../db');

/**
 * zoneFor(conn, tenantId, { streetId, houseNo }) -> { zoneId, zoneName } | { notCollected: true } | null
 * House number ranges and odd/even sides respected; a whole street has both ends empty.
 */
async function zoneFor(conn, tenantId, { streetId, houseNo }) {
  const list = await rows(conn, `SELECT zs.zone_id, zs.from_no, zs.to_no, zs.side, zs.not_collected, z.name AS zone_name
    FROM collection_zone_streets zs LEFT JOIN collection_zones z ON z.tenant_id = zs.tenant_id AND z.id = zs.zone_id
    WHERE zs.tenant_id = ? AND zs.street_id = ? ORDER BY (zs.from_no IS NULL AND zs.to_no IS NULL), zs.id`, [tenantId, streetId]);
  const n = houseNo === null || houseNo === undefined || houseNo === '' ? null : Number(houseNo);
  for (const r of list) {
    const whole = r.from_no === null && r.to_no === null;
    if (!whole) {
      if (n === null) continue;
      if (r.from_no !== null && n < Number(r.from_no)) continue;
      if (r.to_no !== null && n > Number(r.to_no)) continue;
    }
    if (n !== null && r.side === 'odd' && n % 2 === 0) continue;
    if (n !== null && r.side === 'even' && n % 2 === 1) continue;
    if (Number(r.not_collected)) return { notCollected: true };
    if (r.zone_id) return { zoneId: Number(r.zone_id), zoneName: r.zone_name };
  }
  return null;
}

const requireAddon = (key) => (req, _res, next) => {
  require('./modules').stateOf(req.auth.tenantId).then((s) => {
    if (s.on.has(key)) return next();
    const { AppError } = require('./errors');
    const e = new AppError(403, `${key} is not turned on`); e.details = { code: 'module_disabled', module: key };
    return next(e);
  }, next);
};

module.exports = { zoneFor, requireAddon };
