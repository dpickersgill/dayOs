'use strict';
// Claim files, documentation score, season risk report and insurer sharing (src/routes/patrolclaims.js).
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => { void tableExists; void columnExists; return []; };
