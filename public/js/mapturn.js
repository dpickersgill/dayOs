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
