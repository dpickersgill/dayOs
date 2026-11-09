// A call's location panel (help/places): where the caller is in the words patrollers use, how sure that is, a small map
// of the mapped places near them with their last positions as a trail, the sign they scanned, and when they last moved.
// It keeps itself up to date while the call is open (every 10 seconds), so a new position from the guest shows here.
import { get, poll } from '../api.js';
import { h, clear, state } from '../ui.js';
import { placeMap } from '../placemap.js';

const CONFIDENCE = { high: ['Location good', 'good'], medium: ['Location fair', 'warn'], low: ['Location rough', 'bad'] };
const ago = (n) => (n === null || n === undefined ? '' : n < 1 ? 'Last moved under a minute ago' : `Last moved ${n} min ago`);

/** The panel for one call, in its own section. Returns the section; it stops refreshing once it is off the page. */
export function wherePanel(callId) {
  const body = h('div', { class: 'where-body' }, h('p', { class: 'loading' }, 'Finding the place…'));
  const sec = h('section', { class: 'call-where stack tight', 'data-area': 'where', 'aria-label': 'Where the caller is' }, h('h3', null, 'Where'), body);
  let last = '';
  async function fill(timed) {
    let w;
    try { w = await (timed ? poll : get)(`/patrol/dispatch/${callId}/where`); } catch (_) { if (!timed) clear(body).append(h('p', { class: 'muted' }, 'The place could not be loaded.')); return; }
    const key = JSON.stringify([w.position, w.trail, w.scanned, w.minutes_since_move]);
    if (key === last) return;
    last = key;
    draw(w);
  }
  function draw(w) {
    if (!w.position) {
      clear(body).append(...[scannedLine(w), h('p', { class: 'muted' }, 'No position from the caller’s phone yet.')].filter(Boolean));
      return;
    }
    const p = w.position;
    const c = w.words && CONFIDENCE[w.words.confidence];
    clear(body).append(...[
      h('p', { class: 'where-words' }, w.words ? w.words.text : w.place_text || 'Nothing mapped near this position'),
      h('div', { class: 'row where-facts' },
        c ? state(c[0], c[1]) : null,
        p.accuracy_m !== null && p.accuracy_m !== undefined ? h('span', null, `Phone within about ${p.accuracy_m} m`) : h('span', { class: 'muted' }, 'Accuracy not known'),
        w.minutes_since_move !== null ? h('span', { class: 'where-moved' }, ago(w.minutes_since_move)) : null),
      scannedLine(w),
      placeMap(w.places, { focus: { lat: p.lat, lng: p.lng, acc: p.accuracy_m || 0 }, trail: w.trail.length > 1 ? w.trail : [], width: 360, height: 220, span: 200, title: `Map: the caller and ${w.places.length} mapped places near them` }),
      h('p', { class: 'muted small' }, w.trail.length > 1 ? `The ring is how sure the phone is; the line is its last ${w.trail.length} positions. ` : 'The ring is how sure the phone is. ',
        `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)} `,
        h('a', { href: w.maps_url, target: '_blank', rel: 'noopener' }, 'Open in maps')),
    ].filter(Boolean));
  }
  const scannedLine = (w) => (w.scanned ? h('p', { class: 'where-scan' }, h('b', null, 'Sign scanned: '), w.scanned.code, w.scanned.name ? ` (${w.scanned.name})` : '') : null);
  fill(false);
  const timer = setInterval(() => { if (!sec.isConnected) { clearInterval(timer); return; } fill(true); }, 10000);
  if (timer && timer.unref) timer.unref();
  return sec;
}
