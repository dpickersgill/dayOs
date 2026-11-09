// A small map of mapped places drawn as SVG: the mountain's own points with their codes, no map tiles and no outside
// service. Used by mapping the mountain (every point) and a call's location panel (the places near the caller, the
// caller's accuracy circle and their last positions as a trail).
import { svg } from './ui.js';

const M_PER_DEG = 111320;

/**
 * points: [{ lat, lng, code, name, kind, id }]. opts: focus { lat, lng, acc } (the caller), trail [{ lat, lng }],
 * width/height (viewBox units), label (draw codes), onPick(point), span (meters shown at least, around the focus).
 */
export function placeMap(points, { focus = null, trail = [], width = 360, height = 240, label = true, onPick = null, span = 0, title = 'Map of mapped places' } = {}) {
  const all = [...points, ...trail, ...(focus ? [focus] : [])].filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
  const pad = 22;
  const el = svg('svg', { class: 'place-map', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title, preserveAspectRatio: 'xMidYMid meet' });
  el.append(svg('rect', { x: 0, y: 0, width, height, class: 'pm-bg' }));
  if (!all.length) { el.append(svg('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'pm-empty' }, 'Nothing marked yet')); return el; }
  const lat0 = all.reduce((s, p) => s + Number(p.lat), 0) / all.length;
  const k = Math.cos(lat0 * Math.PI / 180);
  const xy = (p) => ({ x: Number(p.lng) * M_PER_DEG * k, y: -Number(p.lat) * M_PER_DEG });
  const pts = all.map(xy);
  let minX = Math.min(...pts.map((p) => p.x)); let maxX = Math.max(...pts.map((p) => p.x));
  let minY = Math.min(...pts.map((p) => p.y)); let maxY = Math.max(...pts.map((p) => p.y));
  const want = Math.max(span, 60); // never zoom closer than 60 m across, so one point is not a blur
  if (focus) {
    const f = xy(focus); const r = Math.max(want / 2, Number(focus.acc) || 0);
    minX = Math.min(minX, f.x - r); maxX = Math.max(maxX, f.x + r); minY = Math.min(minY, f.y - r); maxY = Math.max(maxY, f.y + r);
  }
  if (maxX - minX < want) { const c = (maxX + minX) / 2; minX = c - want / 2; maxX = c + want / 2; }
  if (maxY - minY < want) { const c = (maxY + minY) / 2; minY = c - want / 2; maxY = c + want / 2; }
  const scale = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY));
  const ox = (width - (maxX - minX) * scale) / 2; const oy = (height - (maxY - minY) * scale) / 2;
  const at = (p) => { const q = xy(p); return { x: ox + (q.x - minX) * scale, y: oy + (q.y - minY) * scale }; };

  // A scale bar: a round number of meters about a quarter of the width.
  const meters = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((n) => n * scale >= width / 6) || 5000;
  const bar = meters * scale;
  el.append(svg('g', { class: 'pm-scale' }, svg('line', { x1: 10, y1: height - 10, x2: 10 + bar, y2: height - 10 }),
    svg('text', { x: 10 + bar + 4, y: height - 6 }, meters >= 1000 ? `${meters / 1000} km` : `${meters} m`)));
  el.append(svg('text', { x: width - 8, y: 16, 'text-anchor': 'end', class: 'pm-north' }, 'N ↑'));

  if (focus && Number(focus.acc) > 0) { const c = at(focus); el.append(svg('circle', { cx: c.x, cy: c.y, r: Math.max(4, Number(focus.acc) * scale), class: 'pm-ring' })); }
  if (trail.length > 1) el.append(svg('polyline', { points: trail.map((p) => { const c = at(p); return `${c.x.toFixed(1)},${c.y.toFixed(1)}`; }).join(' '), class: 'pm-trail' }));
  for (const p of trail.slice(0, -1)) { const c = at(p); el.append(svg('circle', { cx: c.x, cy: c.y, r: 3, class: 'pm-trail-dot' })); }

  const labels = []; // drawn last, over every mark, so a code is never hidden
  for (const p of points) {
    const c = at(p);
    const g = svg('g', { class: `pm-point pm-${p.kind || 'other'}${onPick ? ' pm-pick' : ''}`, ...(onPick ? { tabindex: '0', role: 'button', 'aria-label': `${p.code ? `${p.code}, ` : ''}${p.name || ''}` } : {}) },
      p.kind === 'tower' ? svg('rect', { x: c.x - 5, y: c.y - 5, width: 10, height: 10 }) : svg('circle', { cx: c.x, cy: c.y, r: 6 }),
      svg('title', null, `${p.code ? `${p.code}: ` : ''}${p.name || ''}`));
    if (label && p.code) labels.push(svg('text', { x: c.x + 8, y: c.y + 4, class: 'pm-label', 'aria-hidden': 'true' }, p.code));
    if (onPick) {
      g.addEventListener('click', () => onPick(p));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(p); } });
    }
    el.append(g);
  }
  if (focus) { const c = at(focus); el.append(svg('circle', { cx: c.x, cy: c.y, r: 8, class: 'pm-focus' })); }
  el.append(...labels);
  return el;
}
