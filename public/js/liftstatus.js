// One word for a lift's status, the same on every screen (2026.11.10): Mountain status, Today, the wall screen, a patrol
// report and the claim file all say Open, On hold, Wind hold or Closed, and Cannot open when today's inspection failed.
// The server uses the same words (src/lib/liftstatus.js), so the board's notes and the public conditions feed match.
export const LIFT_STATES = [['open', 'Open', 'good'], ['hold', 'On hold', 'warn'], ['wind_hold', 'Wind hold', 'warn'], ['closed', 'Closed', 'neutral']];
export const CANNOT_OPEN = ['Cannot open', 'bad'];

/** [word, kind] for a lift: its status, or Cannot open when today's inspection failed and it is not open. */
export function liftWord(status, check = null) {
  if (check === 'fail' && status !== 'open') return CANNOT_OPEN;
  const s = LIFT_STATES.find((x) => x[0] === status);
  return s ? [s[1], s[2]] : ['Not set', 'neutral'];
}
/** Just the word. */
export const liftText = (status, check = null) => liftWord(status, check)[0];
