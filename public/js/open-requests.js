// The public map of open reports (/open-requests/<municipality>), shown only when the municipality turned it on in
// Requests, Settings. What and roughly where: the category, the street's name, the status and the day. No names, no house
// numbers, no descriptions or photos, and every position rounded to about 50 m by the server.
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('app');
function h(tag, a, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(a || {})) if (v != null && v !== false) { if (k === 'class') el.className = v; else el.setAttribute(k, v); }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const loadLeaflet = () => (window.L ? Promise.resolve(window.L) : new Promise((ok, no) => { const s = h('script', { src: new URL('../../vendor/leaflet/leaflet.js', import.meta.url).href }); s.onload = () => ok(window.L); s.onerror = no; document.head.append(s); }));
const day = (s) => (s ? new Date(`${s}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

async function start() {
  let d;
  try {
    const r = await fetch(`/api/v1/public/${encodeURIComponent(slug)}/open-requests`);
    if (!r.ok) throw Object.assign(new Error('x'), { status: r.status });
    d = await r.json();
  } catch (err) {
    root.replaceChildren(h('h1', null, err.status === 404 ? 'This map is not available' : 'The map could not load'), h('p', null, err.status === 404 ? 'This municipality does not show its open reports online.' : 'Check your signal and try again.'));
    return;
  }
  document.title = `Open reports: ${d.municipality}`;
  const cats = new Map();
  for (const x of [...d.open, ...d.fixed]) cats.set(x.category, x.color);
  const rows = (list, fixed) => list.map((x) => h('tr', null, h('td', null, h('span', { class: 'dot', style: `background:${x.color}` }), x.category), h('td', null, x.street || 'Location on the map'), h('td', null, x.status), h('td', null, fixed ? day(x.fixed_on) : day(x.reported_on))));
  const mapEl = h('div', { id: 'map', role: 'application', 'aria-label': 'Map of open reports' });
  root.replaceChildren(h('h1', null, `Open reports in ${d.municipality}`),
    h('p', { class: 'muted' }, 'Problems residents and crews have reported that are still open, and those fixed in the last 30 days. Spots are shown roughly, never at one house.'),
    h('a', { class: 'cta', href: `/report/${encodeURIComponent(slug)}` }, 'Report a problem'),
    h('ul', { class: 'legend' }, [...cats].map(([name, color]) => h('li', null, h('span', { class: 'dot', style: `background:${color}` }), name))),
    mapEl,
    h('h2', null, `Open (${d.open.length})`), h('table', null, h('thead', null, h('tr', null, h('th', null, 'What'), h('th', null, 'Street'), h('th', null, 'Status'), h('th', null, 'Reported'))), h('tbody', null, rows(d.open, false))),
    h('h2', null, `Fixed in the last 30 days (${d.fixed.length})`), h('table', null, h('thead', null, h('tr', null, h('th', null, 'What'), h('th', null, 'Street'), h('th', null, 'Status'), h('th', null, 'Fixed'))), h('tbody', null, rows(d.fixed, true))));
  try {
    const L = await loadLeaflet();
    const pins = [...d.open, ...d.fixed].filter((x) => x.at);
    const map = L.map(mapEl, { maxZoom: d.max_zoom || 19 });
    const layers = d.layers.map((l) => [l.name, L.tileLayer(l.url, { attribution: l.attribution, maxNativeZoom: l.maxZoom, maxZoom: d.max_zoom || 19 })]);
    layers[0][1].addTo(map);
    if (layers.length > 1) L.control.layers(Object.fromEntries(layers)).addTo(map);
    for (const x of pins) L.circleMarker([x.at.lat, x.at.lng], { radius: 9, color: '#fff', weight: 2, fillColor: x.color, fillOpacity: x.status === 'Fixed' ? 0.45 : 0.95 }).bindPopup(h('div', null, h('strong', null, x.category), h('br'), x.street || '', h('br'), x.status)).addTo(map);
    if (pins.length) map.fitBounds(L.latLngBounds(pins.map((x) => [x.at.lat, x.at.lng])), { padding: [30, 30], maxZoom: 17 });
    else if (d.center) map.setView([d.center.lat, d.center.lng], d.center.zoom);
    else map.setView([39.8283, -98.5795], 4);
  } catch (_) { mapEl.replaceWith(h('p', { class: 'muted' }, 'The map could not load. The lists below have every report.')); }
}
start();
