'use strict';
// The kinds of attraction a mountain can run beside skiing and riding. A mountain adds its own attractions (Settings,
// Attractions) and picks a type for each; 'other' is any attraction not listed, with its own name.
// The type decides the default opening checks, the patrol activity on reports, and whether it sells by time slot.
// Shared by Mountain status, Patrol, selling and staff: add a type here, never in one of those places alone.
const TYPES = [
  { key: 'zipline', label: 'Zipline or canopy tour', season: 'all', group: 'Rides' },
  { key: 'coaster', label: 'Mountain coaster', season: 'all', group: 'Rides' },
  { key: 'tubing', label: 'Snow tubing', season: 'winter', group: 'Snow' },
  { key: 'ice_rink', label: 'Ice skating', season: 'winter', group: 'Snow' },
  { key: 'scenic_lift', label: 'Scenic lift ride', season: 'summer', group: 'Summer' },
  { key: 'bike_park', label: 'Bike park', season: 'summer', group: 'Summer' },
  { key: 'disc_golf', label: 'Disc golf', season: 'summer', group: 'Summer' },
  { key: 'aerial_park', label: 'Aerial adventure park', season: 'summer', group: 'Summer' },
  { key: 'climbing_wall', label: 'Climbing wall', season: 'all', group: 'Summer' },
  { key: 'other', label: 'Something else', season: 'all', group: 'Other' },
];
const TYPE_KEYS = TYPES.map((t) => t.key);
const byKey = Object.fromEntries(TYPES.map((t) => [t.key, t]));
const typeLabel = (k) => (byKey[k] ? byKey[k].label : 'Attraction');

module.exports = { TYPES, TYPE_KEYS, typeLabel };
