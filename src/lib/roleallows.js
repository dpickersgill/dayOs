'use strict';
// The role check every route makes (middleware/auth requireRole), asked directly by code that runs for a person outside
// a route of its own: an approved draft (lib/proposals.js) does what that person could do on the screen, no more.
// The owner always may; someone on the patrol roster counts as patrol, as on every route.
function roleAllows(auth, roles) {
  const { requireRole } = require('../middleware/auth');
  let ok = false;
  requireRole(...roles)({ auth, originalUrl: '/api/v1/ai' }, null, (err) => { ok = !err; });
  return ok;
}
module.exports = { roleAllows };
