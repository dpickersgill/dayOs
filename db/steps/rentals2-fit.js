'use strict';
// The rental shop, round 2, the fitting track: when a paid rental reached the station it is waiting at, so each station's
// queue shows how long that person has waited there (not since they paid). Loaded by db/migrate.js after rentals2.
module.exports = ({ columnExists }) => [
  ['rental_contracts.stage_at', (c) => columnExists(c, 'rental_contracts', 'stage_at'), 'ALTER TABLE rental_contracts ADD COLUMN stage_at DATETIME NULL'],
];
