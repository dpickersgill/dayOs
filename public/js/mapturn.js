// Turning a map to match the mountain's trail map (help/places). Pure math, no page: the compass direction the mountain
// wants at the top of its maps (0 north up, 180 turned around), and where a point lands on screen once turned. A turn is
// a rotation only, never a mirror image, so left and right stay on the same side as on the real mountain.

export const norm = (d) => ((Math.round(Number(d) || 0) % 360) + 360) % 360;

/**
 * Screen offsets for a point east/north meters from the middle, with `up` (compass degrees) at the top of the screen.
 * x grows to the right, y grows down (as on a screen). up = 0 gives x = east, y = -north.
 */
export function turn(east, north, up) {
  const r = (norm(up) * Math.PI) / 180;
  return { x: east * Math.cos(r) - north * Math.sin(r), y: -(east * Math.sin(r) + north * Math.cos(r)) };
}

/** Where true north points on screen, as a unit offset (x right, y down). */
export const northOnScreen = (up) => turn(0, 1, up);

const POINTS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
/** "northeast" for 45. */
export const compassWord = (deg) => POINTS[Math.round(norm(deg) / 22.5) % 16];

/**
 * "Which way is uphill from the base?": the 8 compass points, each with its plain word and an arrow. Picking one turns the
 * maps so that direction is at the top: uphill north is 0, north-east 45, east 90, and so on round to north-west 315.
 */
export const UPHILL = [
  { key: 'N', word: 'north', label: 'North', arrow: '\u2191', deg: 0 },
  { key: 'NE', word: 'north-east', label: 'North-east', arrow: '\u2197', deg: 45 },
  { key: 'E', word: 'east', label: 'East', arrow: '\u2192', deg: 90 },
  { key: 'SE', word: 'south-east', label: 'South-east', arrow: '\u2198', deg: 135 },
  { key: 'S', word: 'south', label: 'South', arrow: '\u2193', deg: 180 },
  { key: 'SW', word: 'south-west', label: 'South-west', arrow: '\u2199', deg: 225 },
  { key: 'W', word: 'west', label: 'West', arrow: '\u2190', deg: 270 },
  { key: 'NW', word: 'north-west', label: 'North-west', arrow: '\u2196', deg: 315 },
];
/** The rotation for an uphill direction ("NW" is 315), or null. */
export const uphillDeg = (key) => { const u = UPHILL.find((x) => x.key === String(key).toUpperCase()); return u ? u.deg : null; };
/** The compass point a rotation is exactly on ("north-west" for 315), or null when it is between them (100). */
export const uphillWord = (deg) => { const u = UPHILL.find((x) => x.deg === norm(deg)); return u ? u.word : null; };
