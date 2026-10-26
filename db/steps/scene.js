'use strict';
// Witness statements by link and the scene diagram (src/routes/patrolscene.js).
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => { void tableExists; void columnExists; return []; };
