// The scene diagram's drawing, as an SVG string. Pure: no DOM, so the server renders the stored copy from the same
// code (src/lib/scene.js) and the case page draws the editor with it. Text is escaped; only known shapes are drawn.

export const W = 800;
export const H = 560;
export const GRID = 40;
export const MAX_ITEMS = 120;

// Two-point items run from (x, y) to (x2, y2); the rest sit at (x, y), turned by r degrees.
export const KINDS = [
  ['travel', 'Direction of travel', 'two'],
  ['impact', 'Point of impact', 'point'],
  ['guest', 'Guest', 'point'],
  ['rider', 'Other skier or rider', 'point'],
  ['patroller', 'Patroller', 'point'],
  ['tree', 'Tree', 'point'],
  ['rock', 'Rock', 'point'],
  ['sign', 'Sign', 'point'],
  ['rope', 'Rope line', 'two'],
  ['tower', 'Lift tower', 'point'],
  ['gun', 'Snow gun', 'point'],
  ['groomer', 'Grooming vehicle', 'point'],
  ['line', 'Line', 'two'],
  ['text', 'Label', 'point'],
];
export const KIND = Object.fromEntries(KINDS.map(([k, label, shape]) => [k, { label, shape }]));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v, lo, hi, d = 0) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d; };

/** Only what can be drawn: known kinds, numbers inside the drawing, short labels. Throws on a bad drawing. */
export function clean(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw new Error('A drawing needs a list of items');
  if (data.items.length > MAX_ITEMS) throw new Error(`A drawing can have up to ${MAX_ITEMS} items`);
  const items = [];
  for (const [i, it] of data.items.entries()) {
    if (!it || !KIND[it.t]) throw new Error('Unknown item in the drawing');
    const o = { id: String(it.id || `i${i}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || `i${i}`, t: it.t, x: n(it.x, 0, W), y: n(it.y, 0, H) };
    if (KIND[it.t].shape === 'two') { o.x2 = n(it.x2, 0, W, o.x + 120); o.y2 = n(it.y2, 0, H, o.y); } else o.r = n(it.r, -360, 360);
    const label = String(it.label || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
    if (label) o.label = label;
    if (it.t === 'text' && !o.label) continue;
    items.push(o);
  }
  const compass = data.compass && typeof data.compass === 'object' ? { mode: data.compass.mode === 'north' ? 'north' : 'uphill', angle: n(data.compass.angle, -360, 360) } : { mode: 'uphill', angle: 0 };
  return { v: 1, items, compass, note: String(data.note || '').trim().slice(0, 300) };
}

function marker(it) {
  const at = `translate(${it.x} ${it.y}) rotate(${it.r || 0})`;
  switch (it.t) {
    case 'impact': return `<g transform="${at}"><path d="M-14 -14 L14 14 M14 -14 L-14 14" stroke="#c0281d" stroke-width="6" stroke-linecap="round"/></g>`;
    case 'guest': return `<g transform="${at}"><circle r="15" fill="#1f63c6" stroke="#fff" stroke-width="3"/><text y="5" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">G</text></g>`;
    case 'rider': return `<g transform="${at}"><circle r="15" fill="#7b3fb3" stroke="#fff" stroke-width="3"/><text y="5" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">R</text></g>`;
    case 'patroller': return `<g transform="${at}"><circle r="15" fill="#c0281d" stroke="#fff" stroke-width="3"/><path d="M-7 0 H7 M0 -7 V7" stroke="#fff" stroke-width="4"/></g>`;
    case 'tree': return `<g transform="${at}"><path d="M0 -20 L14 8 H-14 Z" fill="#2f7a3d"/><rect x="-3" y="8" width="6" height="8" fill="#6b4a2b"/></g>`;
    case 'rock': return `<g transform="${at}"><path d="M-16 8 L-10 -8 L4 -12 L16 -2 L12 10 Z" fill="#8a8f96" stroke="#5c6168" stroke-width="2"/></g>`;
    case 'sign': return `<g transform="${at}"><rect x="-14" y="-18" width="28" height="18" rx="2" fill="#f2c230" stroke="#6b5310" stroke-width="2"/><path d="M0 0 V16" stroke="#6b5310" stroke-width="3"/></g>`;
    case 'tower': return `<g transform="${at}"><path d="M-8 18 L-3 -16 H3 L8 18 Z" fill="#596572"/><path d="M-16 -16 H16" stroke="#596572" stroke-width="4"/></g>`;
    case 'gun': return `<g transform="${at}"><path d="M-4 16 V-4 M-4 -4 L14 -14" stroke="#3c4a57" stroke-width="5" stroke-linecap="round"/><circle cx="18" cy="-17" r="4" fill="#9fd2f0"/></g>`;
    case 'groomer': return `<g transform="${at}"><rect x="-20" y="-10" width="40" height="16" rx="3" fill="#d3462f"/><rect x="-8" y="-20" width="16" height="10" fill="#d3462f"/><rect x="-22" y="6" width="44" height="7" rx="3" fill="#222"/></g>`;
    case 'text': return '';
    default: return '';
  }
}

function two(it) {
  const dx = it.x2 - it.x; const dy = it.y2 - it.y;
  const len = Math.hypot(dx, dy) || 1;
  if (it.t === 'rope') {
    const posts = Math.max(2, Math.round(len / 60) + 1);
    let p = '';
    for (let k = 0; k < posts; k++) { const f = k / (posts - 1); p += `<circle cx="${Math.round(it.x + dx * f)}" cy="${Math.round(it.y + dy * f)}" r="4" fill="#d8731b"/>`; }
    return `<line x1="${it.x}" y1="${it.y}" x2="${it.x2}" y2="${it.y2}" stroke="#d8731b" stroke-width="3" stroke-dasharray="10 6"/>${p}`;
  }
  if (it.t === 'travel') {
    const ux = dx / len; const uy = dy / len;
    const hx = it.x2 - ux * 22; const hy = it.y2 - uy * 22;
    const head = `${it.x2},${it.y2} ${Math.round(hx - uy * 12)},${Math.round(hy + ux * 12)} ${Math.round(hx + uy * 12)},${Math.round(hy - ux * 12)}`;
    return `<line x1="${it.x}" y1="${it.y}" x2="${Math.round(hx)}" y2="${Math.round(hy)}" stroke="#1f63c6" stroke-width="6" stroke-linecap="round"/><polygon points="${head}" fill="#1f63c6"/>`;
  }
  return `<line x1="${it.x}" y1="${it.y}" x2="${it.x2}" y2="${it.y2}" stroke="#222" stroke-width="3" stroke-linecap="round"/>`;
}

function labelOf(it) {
  if (!it.label) return '';
  const two_ = KIND[it.t].shape === 'two';
  const x = two_ ? Math.round((it.x + it.x2) / 2) : it.x;
  const y = two_ ? Math.round((it.y + it.y2) / 2) - 12 : it.t === 'text' ? it.y : it.y + 32;
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="${it.t === 'text' ? 18 : 14}" font-weight="600" fill="#1b2630" stroke="#fff" stroke-width="4" paint-order="stroke">${esc(it.label)}</text>`;
}

/**
 * The drawing as an SVG document. opts.selected draws handles on that item (the editor); opts.interactive tags each
 * item with data-id so the editor can find what was touched. trail and when are printed in the corner.
 */
export function sceneSvg(data, { trail = '', when = '', selected = null, interactive = false } = {}) {
  const d = clean(data);
  const grid = [];
  for (let x = GRID; x < W; x += GRID) grid.push(`<path d="M${x} 0 V${H}" stroke="#e3e9ee" stroke-width="1"/>`);
  for (let y = GRID; y < H; y += GRID) grid.push(`<path d="M0 ${y} H${W}" stroke="#e3e9ee" stroke-width="1"/>`);
  const body = d.items.map((it) => {
    const shape = KIND[it.t].shape === 'two' ? two(it) : marker(it);
    const hit = interactive ? (KIND[it.t].shape === 'two'
      ? `<line x1="${it.x}" y1="${it.y}" x2="${it.x2}" y2="${it.y2}" stroke="transparent" stroke-width="28"/>`
      : `<circle cx="${it.x}" cy="${it.y}" r="26" fill="transparent"/>`) : '';
    return `<g${interactive ? ` data-id="${esc(it.id)}" class="scene-item"` : ''}>${hit}${shape}${labelOf(it)}</g>`;
  }).join('');
  let handles = '';
  const sel = selected ? d.items.find((it) => it.id === selected) : null;
  if (sel) {
    handles = KIND[sel.t].shape === 'two'
      ? `<circle data-handle="a" cx="${sel.x}" cy="${sel.y}" r="14" fill="#fff" stroke="#1f63c6" stroke-width="4"/><circle data-handle="b" cx="${sel.x2}" cy="${sel.y2}" r="14" fill="#fff" stroke="#1f63c6" stroke-width="4"/>`
      : `<circle cx="${sel.x}" cy="${sel.y}" r="28" fill="none" stroke="#1f63c6" stroke-width="3" stroke-dasharray="6 4"/>`;
  }
  const c = d.compass;
  const compass = `<g transform="translate(${W - 50} 50)"><circle r="34" fill="#fff" stroke="#9aa7b2" stroke-width="2"/><g transform="rotate(${c.angle})"><path d="M0 -26 L9 6 L0 0 L-9 6 Z" fill="#1b2630"/></g><text y="52" text-anchor="middle" font-size="13" font-weight="700" fill="#1b2630">${c.mode === 'north' ? 'North' : 'Uphill'}</text></g>`;
  const head = [trail ? esc(trail) : '', when ? esc(when) : ''].filter(Boolean).join(', ');
  const title = head ? `<text x="14" y="26" font-size="16" font-weight="700" fill="#1b2630" stroke="#fff" stroke-width="4" paint-order="stroke">${head}</text>` : '';
  const note = d.note ? `<text x="14" y="${H - 14}" font-size="13" fill="#44515c" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(d.note)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" role="img" aria-label="Scene diagram${head ? `: ${head}` : ''}"><rect width="${W}" height="${H}" fill="#fbfdfe"/>${grid.join('')}${body}${handles}${compass}${title}${note}</svg>`;
}
