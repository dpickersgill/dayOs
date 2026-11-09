// The phone's GPS for marking a spot, as the terrain park pins do it: watch the fix improve, say how good it is, and only
// let a mark go down once it is close enough. Used by mapping the mountain and "Guest needs help here".

export const MARK_MAX_M = 30; // the server refuses a mark from a fix this far out or worse
export const WAIT_MS = 20000; // after this, say what to do instead of only waiting

const m = (x) => `${Math.max(1, Math.round(Number(x)))} m`;

/** Words for a fix: good, fair or weak against the limit. */
export function quality(fix, max = MARK_MAX_M) {
  if (!fix) return 'Finding your location…';
  if (fix.acc < max * 0.5) return `GPS good: within ${m(fix.acc)}`;
  if (fix.acc < max) return `GPS fair: within ${m(fix.acc)}`;
  return `GPS weak: within ${m(fix.acc)}. Wait for under ${max} m. Step into the open, away from trees and buildings.`;
}

/** True when a fix may be used to mark a spot. */
export const goodEnough = (fix, max = MARK_MAX_M) => Boolean(fix) && Number.isFinite(fix.acc) && fix.acc < max;

/**
 * Watches the GPS. onFix({ lat, lng, acc }) on every fix; onError(text) when there is none. Returns stop().
 * With no GPS on the device, onError is called at once.
 */
export function watchFix(onFix, onError = () => {}) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) { onError('This device has no GPS, or the browser cannot reach it.'); return () => {}; }
  let id = null;
  try {
    id = navigator.geolocation.watchPosition(
      (pos) => onFix({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : 999 }),
      (err) => onError(err && err.code === 1 ? 'Location is switched off for this site. Allow it in the browser settings.' : 'No GPS signal yet. Step into the open.'),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  } catch (_) { onError('No GPS signal yet. Step into the open.'); }
  return () => { if (id !== null) navigator.geolocation.clearWatch(id); id = null; };
}

/** One fix, the best within waitMs (or the first under `good` m). Resolves null when there is none. */
export function bestFix({ waitMs = 8000, good = 15 } = {}) {
  return new Promise((resolve) => {
    let best = null;
    let stop = () => {};
    const done = () => { clearTimeout(timer); stop(); resolve(best); };
    const timer = setTimeout(done, waitMs);
    stop = watchFix((f) => { if (!best || f.acc < best.acc) best = f; if (f.acc <= good) done(); }, () => { if (!best) done(); });
  });
}

/** A link that opens a point in the phone's own maps app. */
export const mapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
