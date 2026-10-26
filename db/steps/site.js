'use strict';
// Product website changes (contact form kinds and the like).
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => { void tableExists; void columnExists; return []; };
