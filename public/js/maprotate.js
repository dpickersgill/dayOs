// A Leaflet map turned to match the mountain's trail map (help/places), for the terrain park's daily map. Leaflet cannot
// turn a map itself, so the map's box is made big enough to cover its frame when turned (its diagonal), turned with CSS,
// and the map's own reading of taps, clicks and drags is turned back, so a tap still lands where the finger is and a drag
// moves the way the finger moves. Rotation only, never a mirror. The zoom and layer buttons stay upright, outside the
// turned box, and a north arrow shows where true north is. Marker letters and popups are turned back to stay upright.
import { svg } from './ui.js';
import { norm, northOnScreen } from './mapturn.js';

const turnOf = (el) => { const box = el && el.closest ? el.closest('[data-map-rotate]') : null; return box ? Number(box.dataset.mapRotate) || 0 : 0; };
// The screen angle of the turn: with `up` at the top, the map is turned by -up degrees.
const screenRad = (up) => (-norm(up) * Math.PI) / 180;

let patched = false;
/** Leaflet's dragging (the map and markers), turned back once for every turned map on the page. */
function patchDragging(L) {
  if (patched || !L.Draggable) return;
  patched = true;
  const P = L.Draggable.prototype;
  const down = P._onDown; const move = P._onMove;
  P._onDown = function onDown(e) {
    down.call(this, e);
    if (turnOf(this._element)) this._parentScale = { x: 1, y: 1 }; // the turned box measures larger; it is not scaled
  };
  P._onMove = function onMove(e) {
    const up = turnOf(this._element);
    if (!up || !this._startPoint || (e.touches && e.touches.length > 1)) return move.call(this, e);
    const t = e.touches && e.touches.length === 1 ? e.touches[0] : e;
    const a = -screenRad(up); // screen movement turned back into the map's own frame
    const dx = t.clientX - this._startPoint.x; const dy = t.clientY - this._startPoint.y;
    const fake = {
      clientX: this._startPoint.x + dx * Math.cos(a) - dy * Math.sin(a), clientY: this._startPoint.y + dx * Math.sin(a) + dy * Math.cos(a),
      target: e.target, srcElement: e.srcElement, type: e.type,
      preventDefault: () => e.preventDefault && e.preventDefault(), stopPropagation: () => e.stopPropagation && e.stopPropagation(),
    };
    return move.call(this, fake);
  };
}

/**
 * Turns a Leaflet map so `up` (compass degrees) is at the top. el: the map's box (the Leaflet container). Does nothing
 * for 0. Returns a function that sizes it again (it also follows its frame's size by itself).
 */
export function turnLeafletMap(L, map, el, up) {
  up = norm(up);
  if (!up || !el || !el.parentNode) return () => {};
  patchDragging(L);
  // The frame keeps the box's place and size on the page; the box inside it is the frame's diagonal, turned.
  const frame = document.createElement('div');
  frame.className = `${el.className.split(' ').filter((c) => c && !c.startsWith('leaflet')).join(' ')} map-turn-wrap`;
  el.parentNode.insertBefore(frame, el);
  frame.append(el);
  el.dataset.mapRotate = String(up);
  el.style.setProperty('--map-turn', `${-up}deg`);
  el.style.transform = `rotate(${-up}deg)`;
  // The zoom and layer buttons and the attribution: upright, in the frame.
  const controls = el.querySelector('.leaflet-control-container');
  if (controls) frame.append(controls);
  const n = northOnScreen(up);
  frame.append(Object.assign(document.createElement('div'), { className: 'map-north', title: 'North' }));
  frame.lastChild.append(svg('svg', { viewBox: '-17 -17 34 34', role: 'img', 'aria-label': 'North arrow' },
    svg('line', { x1: -n.x * 10, y1: -n.y * 10, x2: n.x * 10, y2: n.y * 10 }), svg('circle', { cx: n.x * 10, cy: n.y * 10, r: 3.5 }),
    svg('text', { x: -n.x * 3 + (n.x >= 0 ? -10 : 4), y: -n.y * 3 + 4 }, 'N')));
  function size() {
    const w = frame.clientWidth; const h = frame.clientHeight;
    if (!w || !h) return;
    const d = Math.ceil(Math.hypot(w, h));
    Object.assign(el.style, { width: `${d}px`, height: `${d}px`, left: `${(w - d) / 2}px`, top: `${(h - d) / 2}px` });
    map.invalidateSize({ animate: false });
  }
  // A tap or click: where it is on the turned box, measured from the middle (the middle does not move when turning).
  map.mouseEventToContainerPoint = function containerPoint(e) {
    const r = frame.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2); const dy = e.clientY - (r.top + r.height / 2);
    const a = -screenRad(up);
    return L.point(dx * Math.cos(a) - dy * Math.sin(a) + el.offsetWidth / 2, dx * Math.sin(a) + dy * Math.cos(a) + el.offsetHeight / 2);
  };
  size();
  if (typeof window.ResizeObserver === 'function') new window.ResizeObserver(size).observe(frame);
  return size;
}
