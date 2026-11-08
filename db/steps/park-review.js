'use strict';
// Terrain park review fixes (after 2026.11.12). Loaded by db/migrate.js. Additive and safe to run twice.
//   park_photos.via_inspection  1 when the photo was taken in a feature's inspection (only those count on an inspection)
//   park_photos.late_reason     why a manager added a photo to an inspection from another day or one entered in error
module.exports = ({ columnExists }) => [
  ['park_photos.via_inspection', (c) => columnExists(c, 'park_photos', 'via_inspection'),
    'ALTER TABLE park_photos ADD COLUMN via_inspection TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN late_reason VARCHAR(255) NULL'],
];
