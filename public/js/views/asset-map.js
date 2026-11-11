// Assets and fleet, Map: what lies where on the mountain. Points (valves, hydrants, pumps), lines (water, air and
// power lines) and areas (ponds, buildings), each in its system's color and switched on and off as a layer. The crew
// adds them from the snow with the phone's GPS, or by tapping the map; a line can be recorded by walking it.
// Deep links: #/assets/map/f<id> opens one item; #/assets/map/a<assetId> shows an asset's items, or starts putting it on.
// Municipal edition (muni release 1): hydrants, manholes, pump stations, outfalls and the rest come with their add-on.
// Each item has a tag, a condition and a criticality (risk is the two multiplied), and a panel with its inspections,
// work orders, photos and, for a pump station, run hours by month. The map can color by risk, show only higher risk,
// and rings items that have open work orders.

import { get, post, patch, put, del } from '../api.js';
import { h, clear, button, toast, formDialog, confirmDialog, dialog, state, field, input, select, val, num, label, isManager, can, errorBox, fail, appendAll, isMuni, fmtDateTime } from '../ui.js';
import { loadLeaflet, makeMap, removeWhenGone, fitMap } from './incident-map.js';
import { CONDITIONS, CRITICALITIES, OWNERSHIP, riskState, riskColor, scoreSelect, photoStrip, runHoursTable, miniMap, inspectDialog, inspectionRows } from './asset-bits.js';
import { workOrderSheet } from './asset-page.js';

const GOOD_M = 8; const OK_M = 15; const STEP_M = 6;
const US_VIEW = { lat: 39.8283, lng: -98.5795, zoom: 4 };
const ft = (m) => `${Math.max(1, Math.round(Number(m) * 3.281)).toLocaleString('en-US')} ft`;
const acres = (m2) => (m2 >= 4047 ? `${(m2 / 4046.86).toFixed(1)} acres` : `${Math.round(m2 * 10.764).toLocaleString('en-US')} sq ft`);
const round7 = (n) => Math.round(n * 1e7) / 1e7;
const STATUS = [['in_service', 'In service'], ['out_of_service', 'Out of service'], ['abandoned', 'Abandoned in place'], ['planned', 'Planned']];
const HOW = { gps: 'Placed by GPS', map: 'Placed on the map', walk: 'Recorded by walking it', import: 'Imported' };
const GEO_WORD = { point: 'point', line: 'line', area: 'area' };
// The asset register's kinds that have a natural map kind, for "put this asset on the map".
const FROM_ASSET = { pump: 'pump', snow_gun: 'hydrant', generator: 'other_point', electrical: 'panel', building: 'structure', boiler: 'structure', hvac: 'structure' };

/** Distance in meters between two [lat, lng]. */
function dist(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const s = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export async function drawMap(box, deep = '') {
  const canEdit = can('staff');
  let cfg; let L;
  try { [L, cfg] = await Promise.all([loadLeaflet(), get('/assets/map')]); } catch (err) { clear(box).append(errorBox(err)); return; }
  const sys = Object.fromEntries(cfg.systems.map((s) => [s.key, s]));
  const kindOf = (k) => cfg.kinds.find((x) => x.key === k) || { key: k, label: label(k), geometry: 'point', system: 'other' };
  const systemColor = (f) => (sys[f.system] || sys.other || { color: '#8A6D3B' }).color;
  let byRisk = false; // color by risk instead of by system
  let minRisk = 0; // show only this risk score or more (0: everything)
  const color = (f) => (byRisk ? riskColor(f.risk ? f.risk.level : 'none') : systemColor(f));
  const visible = (f) => shown.has(f.system) && (!minRisk || (f.risk && f.risk.score >= minRisk));
  const shown = new Set(cfg.systems.map((s) => s.key));
  let features = cfg.features;
  const drawn = new Map(); // id -> leaflet layer

  const search = input({ type: 'search', placeholder: 'Find a valve, tag, line or asset', 'aria-label': 'Find on the map' });
  const colorBy = select([['system', 'Color by system'], ['risk', 'Color by risk']], 'system', { 'aria-label': 'Color the map by' });
  const riskFilter = select([['0', 'Any risk'], ...cfg.risk_levels.filter((r) => r.min > 1).reverse().map((r) => [String(r.min), `${r.label} risk or more`])], '0', { 'aria-label': 'Show by risk' });
  colorBy.addEventListener('change', () => { byRisk = colorBy.value === 'risk'; redraw(); });
  riskFilter.addEventListener('change', () => { minRisk = Number(riskFilter.value); redraw(); });
  const banner = h('div', { class: 'park-banner', role: 'status', hidden: true });
  const mapEl = h('div', { class: 'map-box tall park-map', role: 'application', 'aria-label': isMuni() ? 'Map of the municipality’s pipes, lines and equipment' : 'Map of the mountain’s pipes, lines and equipment' });
  const layersEl = h('div', { class: 'amap-layers' });
  const listEl = h('div', { class: 'park-list' });
  const tools = h('div', { class: 'row' },
    canEdit ? button('Add a point', () => startAdd('point'), { small: true, kind: 'primary' }) : null,
    canEdit ? button('Draw a line', () => startAdd('line'), { small: true }) : null,
    canEdit ? button('Draw an area', () => startAdd('area'), { small: true }) : null,
    h('a', { class: 'btn small', href: '/api/v1/assets/map/export.geojson', download: '' }, 'Download for GIS'));
  clear(box).append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Where the valves, hydrants, pumps and pipe runs are. Add them from the snow with your phone’s location, or tap the map. Switch to Satellite in the map’s corner to see the ground.'),
    h('div', { class: 'row' }, search, colorBy, riskFilter, tools), banner,
    h('div', { class: 'park-layout' }, mapEl, h('div', { class: 'park-side' }, h('h3', null, 'Layers'), layersEl, h('h3', null, 'On the map'), listEl))));

  const start = cfg.center || US_VIEW;
  const map = makeMap(L, mapEl, cfg, start, { base: 'Satellite', remember: 'assets' });
  removeWhenGone(mapEl, map);
  if (isManager()) {
    tools.append(button('Open maps here by default', async () => {
      const c = map.getCenter();
      try { await put('/assets/map/view', { lat: round7(c.lat), lng: round7(c.lng), zoom: Math.round(map.getZoom()) }); toast('Maps will open on this view'); } catch (err) { fail(err); }
    }, { small: true }));
  }
  if (!cfg.center && navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => { if (!features.length) map.setView([p.coords.latitude, p.coords.longitude], 17); }, () => {}, { timeout: 5000 });

  // ---- drawing what is there
  // A ring around an item with open work orders.
  const dotIcon = (f) => L.divIcon({ className: 'amap-dot-wrap', html: `<span class="amap-dot${f.status !== 'in_service' ? ' off' : ''}${f.open_orders ? ' wo' : ''}" style="--c:${color(f)}"></span>`, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12] });
  const lineStyle = (f) => ({ color: color(f), weight: 5, opacity: 0.95, dashArray: f.status === 'in_service' ? null : '8 8', lineCap: 'round' });
  function layerFor(f) {
    const pts = f.points;
    const lyr = f.geometry === 'point' ? L.marker(pts[0], { icon: dotIcon(f), title: f.name || f.kind_label, keyboard: true })
      : f.geometry === 'line' ? L.polyline(pts, lineStyle(f))
        : L.polygon(pts, { ...lineStyle(f), weight: 3, fillOpacity: 0.2 });
    lyr.bindPopup(() => popup(f), { maxWidth: 300 });
    if (f.geometry !== 'point') lyr.bindTooltip(`${title(f)}${f.open_orders ? `: ${f.open_orders} open work order${f.open_orders === 1 ? '' : 's'}` : ''}`, { sticky: true });
    return lyr;
  }
  function redraw(fit) {
    for (const l of drawn.values()) l.remove();
    drawn.clear();
    for (const f of features) {
      if (!visible(f)) continue;
      const l = layerFor(f).addTo(map);
      drawn.set(f.id, l);
    }
    if (fit && features.length) fitMap(map, L.latLngBounds(features.flatMap((f) => f.points)), { padding: [40, 40], maxZoom: 18 });
    drawSide();
  }
  const measure = (f) => (f.length_m != null ? ft(f.length_m) : f.area_m2 != null ? acres(f.area_m2) : null);
  const title = (f) => f.name || (f.tag ? `${f.kind_label} ${f.tag}` : f.kind_label);
  function popup(f) {
    const facts = [f.size, f.material, f.depth_ft != null ? `${f.depth_ft} ft deep` : null, f.installed_year ? `installed ${f.installed_year}` : null, measure(f)].filter(Boolean).join(', ');
    const body = h('div', { class: 'map-pop' },
      h('b', null, title(f)), h('div', { class: 'muted small' }, `${f.kind_label}${f.tag && f.name ? ` ${f.tag}` : ''}, ${(sys[f.system] || sys.other).label}`),
      facts ? h('div', null, facts) : null,
      f.condition_score || f.criticality ? h('div', null, `Condition ${f.condition_score || '–'}, criticality ${f.criticality || '–'} `, riskState(f.risk)) : null,
      f.open_orders ? h('div', null, h('b', null, `${f.open_orders} open work order${f.open_orders === 1 ? '' : 's'}`)) : null,
      f.last_inspected ? h('div', { class: 'muted small' }, `Last inspected ${fmtDateTime(f.last_inspected)}`) : null,
      f.status !== 'in_service' ? h('div', null, h('b', null, (STATUS.find((s) => s[0] === f.status) || [null, label(f.status)])[1])) : null,
      f.asset_id ? h('div', null, 'Asset: ', h('a', { href: `#/assets/a/${f.asset_id}` }, `${f.asset_name}${f.asset_tag ? ` (${f.asset_tag})` : ''}`)) : null,
      f.notes ? h('div', null, f.notes) : null,
      h('div', { class: 'muted small' }, `${HOW[f.placed_how] || ''}${f.accuracy_m != null ? `, within ${ft(f.accuracy_m)}` : ''}`));
    body.append(h('div', { class: 'row' }, button('Open', () => { map.closePopup(); panel(f.id); }, { small: true, kind: 'primary' })));
    if (canEdit) {
      body.append(h('div', { class: 'row' },
        button('Edit', () => { map.closePopup(); details(f); }, { small: true }),
        button(f.geometry === 'point' ? 'Move' : 'Change shape', () => { map.closePopup(); reshape(f); }, { small: true }),
        cfg.can_delete ? button('Delete', () => { map.closePopup(); remove(f); }, { small: true }) : null));
    }
    return body;
  }
  function focus(f) {
    const l = drawn.get(f.id);
    if (!l) { shown.add(f.system); redraw(); }
    const lyr = drawn.get(f.id);
    if (f.geometry === 'point') map.setView(f.points[0], Math.max(map.getZoom(), 19)); else fitMap(map, L.latLngBounds(f.points), { padding: [40, 40], maxZoom: 19 });
    if (lyr) setTimeout(() => lyr.openPopup(f.geometry === 'point' ? undefined : L.latLngBounds(f.points).getCenter()), 250);
  }
  function drawSide() {
    const q = (search.value || '').trim().toLowerCase();
    clear(layersEl).append(h('ul', { class: 'amap-legend' }, cfg.systems.map((s) => {
      const mine = features.filter((f) => f.system === s.key);
      if (!mine.length) return null;
      const length = mine.reduce((n, f) => n + (f.length_m || 0), 0);
      const box2 = h('input', { type: 'checkbox', checked: shown.has(s.key) });
      box2.addEventListener('change', () => { if (box2.checked) shown.add(s.key); else shown.delete(s.key); redraw(); });
      return h('li', null, h('label', null, box2, h('span', { class: 'amap-swatch', style: `--c:${s.color}` }), ` ${s.label}`,
        h('span', { class: 'muted small' }, ` ${mine.length} item${mine.length === 1 ? '' : 's'}${length ? `, ${ft(length)} of line` : ''}`)));
    }).filter(Boolean)));
    if (byRisk) layersEl.append(h('ul', { class: 'amap-legend' }, [...cfg.risk_levels.map((r) => [r.key, `${r.label} risk`]), ['none', 'Not scored']].map(([k, t]) => h('li', null, h('span', { class: 'amap-swatch', style: `--c:${riskColor(k)}` }), ` ${t}`))));
    if (!features.length) layersEl.append(h('p', { class: 'muted small' }, isMuni() ? 'Nothing on the map yet. Start with the valves and hydrants on Main Street.' : 'Nothing on the map yet. Start with the pump house and the main water line.'));
    const hits = features.filter((f) => (!minRisk || (f.risk && f.risk.score >= minRisk)) && (!q || [f.name, f.tag, f.kind_label, f.asset_name, f.asset_tag, f.size, f.material, f.notes].some((v) => v && String(v).toLowerCase().includes(q))));
    clear(listEl).append(hits.length ? h('ul', null, hits.slice(0, 200).map((f) => h('li', null, h('button', { type: 'button', class: 'park-row', onclick: () => focus(f) },
      h('span', { class: 'amap-swatch', style: `--c:${color(f)}` }), ' ', h('b', null, title(f)), h('span', { class: 'muted small' }, ` ${f.name ? f.kind_label : ''}${measure(f) ? ` ${measure(f)}` : ''}${f.risk ? ` · ${f.risk.label.toLowerCase()} risk` : ''}${f.open_orders ? ` · ${f.open_orders} open` : ''}`)))))
      : h('p', { class: 'muted small' }, q ? 'Nothing matches.' : ''));
  }
  search.addEventListener('input', drawSide);

  async function reload(fit, openId) {
    try { features = (await get('/assets/map')).features; } catch (err) { fail(err); return; }
    redraw(fit);
    const f = openId && features.find((x) => x.id === openId);
    if (f) focus(f);
  }

  // ---- GPS, as on the park map: the fix and its accuracy are shown as they improve.
  let watchId = null; let fix = null; let meDot = null; let meRing = null; let onFix = null;
  const quality = (f) => (!f ? 'Finding your location…' : f.acc <= GOOD_M ? `GPS good: within ${ft(f.acc)}` : f.acc <= OK_M ? `GPS fair: within ${ft(f.acc)}` : `GPS weak: within ${ft(f.acc)}. Step into the open.`);
  function startGps(cb) {
    onFix = cb;
    if (watchId !== null || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition((pos) => {
      fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 999 };
      const at = [fix.lat, fix.lng];
      if (!meRing) meRing = L.circle(at, { radius: fix.acc, className: 'gps-ring', interactive: false }).addTo(map); else meRing.setLatLng(at).setRadius(fix.acc);
      if (!meDot) meDot = L.circleMarker(at, { radius: 7, className: 'gps-dot', interactive: false }).addTo(map); else meDot.setLatLng(at);
      if (onFix) onFix(fix);
    }, (err) => { if (onFix) onFix(null, err); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null; fix = null; onFix = null;
    if (meDot) { meDot.remove(); meDot = null; }
    if (meRing) { meRing.remove(); meRing = null; }
  }

  // ---- adding: choose what it is, then put it down
  let drawing = null; // { kind, geometry, pts, how, acc, preview, walk, assetId, feature (when reshaping) }
  function kindPicker(geometry, preset) {
    const el = h('select', { name: 'kind', required: true });
    for (const s of cfg.systems) {
      const opts = cfg.kinds.filter((k) => k.system === s.key && (!geometry || (k.geometries || [k.geometry]).includes(geometry)));
      if (opts.length) el.append(h('optgroup', { label: s.label }, opts.map((k) => h('option', { value: k.key, selected: k.key === preset }, k.label))));
    }
    return el;
  }
  function startAdd(geometry, { assetId, preset } = {}) {
    stopDrawing();
    formDialog(`Add a ${GEO_WORD[geometry]}`, h('div', { class: 'stack' }, field('What is it?', kindPicker(geometry, preset))), async (fd) => {
      const kind = val(fd, 'kind');
      drawing = { kind, geometry, pts: [], how: 'map', acc: null, assetId: assetId || null };
      mapEl.classList.add('placing');
      prompt();
    }, { submitText: geometry === 'point' ? 'Put it on the map' : 'Start drawing' });
  }
  function previewShape() {
    if (!drawing) return;
    if (drawing.preview) drawing.preview.remove();
    const style = { color: color({ system: kindOf(drawing.kind).system, status: 'in_service' }), weight: 5, dashArray: '2 8', lineCap: 'round' };
    if (drawing.pts.length >= 2) drawing.preview = (drawing.geometry === 'area' ? L.polygon(drawing.pts, { ...style, fillOpacity: 0.15 }) : L.polyline(drawing.pts, style)).addTo(map);
    else if (drawing.pts.length === 1) drawing.preview = L.circleMarker(drawing.pts[0], { radius: 6, color: style.color }).addTo(map);
    else drawing.preview = null;
  }
  function prompt(extra) {
    const k = kindOf(drawing.kind);
    if (drawing.geometry === 'point') {
      appendAll(clear(banner), h('b', null, `Putting down: ${k.label}. `), extra || 'Tap the map where it is. ',
        navigator.geolocation ? button('Use my location', usePointGps, { small: true }) : null, button('Cancel', stopDrawing, { small: true }));
    } else {
      const n = drawing.pts.length; const need = drawing.geometry === 'line' ? 2 : 3;
      const len = drawing.geometry === 'line' && n > 1 ? drawing.pts.slice(1).reduce((m, p, i) => m + dist(drawing.pts[i], p), 0) : 0;
      appendAll(clear(banner), h('b', null, `${drawing.feature ? 'Changing' : 'Drawing'}: ${k.label}. `),
        h('span', { class: 'gps-line' }, `${n} point${n === 1 ? '' : 's'}${len ? `, ${ft(len)}` : ''}. `), extra || (drawing.walk ? '' : 'Tap the map along it. '),
        navigator.geolocation && !drawing.feature ? button(drawing.walk ? 'Stop recording' : 'Record as I walk', toggleWalk, { small: true }) : null,
        navigator.geolocation && !drawing.walk && !drawing.feature ? button('Add my location', addGpsVertex, { small: true }) : null,
        n ? button('Undo', () => { drawing.pts.pop(); previewShape(); prompt(); }, { small: true }) : null,
        button(drawing.feature ? 'Save shape' : 'Finish', () => finish(), { small: true, kind: n >= need ? 'primary' : undefined }),
        button('Cancel', stopDrawing, { small: true }));
    }
    banner.hidden = false;
  }
  function stopDrawing() {
    if (drawing && drawing.preview) drawing.preview.remove();
    if (drawing && drawing.handles) drawing.handles.forEach((m) => m.remove());
    if (drawing && drawing.feature) { const l = drawn.get(drawing.feature.id); if (l && l.dragging) l.dragging.disable(); }
    drawing = null; banner.hidden = true; mapEl.classList.remove('placing'); stopGps();
  }
  map.on('click', (e) => {
    if (!drawing || drawing.feature || drawing.walk) return;
    const at = [round7(e.latlng.lat), round7(e.latlng.lng)];
    if (drawing.geometry === 'point') { drawing.pts = [at]; drawing.how = 'map'; finish(); return; }
    drawing.pts.push(at); previewShape(); prompt();
  });
  function usePointGps() {
    const d = drawing;
    const now = button('Drop here now', () => { if (fix && drawing === d) { d.pts = [[round7(fix.lat), round7(fix.lng)]]; d.how = 'gps'; d.acc = Math.round(fix.acc); finish(); } }, { small: true });
    now.disabled = true;
    const line = h('span', { class: 'gps-line' }, quality(null));
    appendAll(clear(banner), h('b', null, `Putting down: ${kindOf(d.kind).label}. `), line, ' ', now, button('Cancel', stopDrawing, { small: true }));
    startGps((x, err) => {
      if (!x) { line.textContent = err && err.code === 1 ? 'Location is off for this site. Allow it, or tap the map.' : 'No GPS signal yet. Step into the open, or tap the map.'; return; }
      line.textContent = quality(x); now.disabled = false;
      if (x.acc <= GOOD_M && drawing === d) { d.pts = [[round7(x.lat), round7(x.lng)]]; d.how = 'gps'; d.acc = Math.round(x.acc); finish(); }
    });
  }
  function addGpsVertex() {
    const d = drawing;
    startGps((x) => {
      if (!x || drawing !== d || d.walk) return;
      if (d.pendingGps) { d.pendingGps = false; d.pts.push([round7(x.lat), round7(x.lng)]); d.how = 'gps'; d.acc = Math.max(d.acc || 0, Math.round(x.acc)); previewShape(); prompt(`Added (${quality(x).toLowerCase()}). `); }
    });
    d.pendingGps = true;
    if (fix) onFix(fix);
    else prompt('Finding your location… ');
  }
  /** Walking a line: a point is added each time the crew member has moved STEP_M on a fix within OK_M. */
  function toggleWalk() {
    const d = drawing;
    if (d.walk) { d.walk = false; stopGps(); prompt(); return; }
    d.walk = true; d.how = 'walk';
    startGps((x) => {
      if (!x || drawing !== d || !d.walk) return;
      const last = d.pts[d.pts.length - 1];
      if (x.acc <= OK_M && (!last || dist(last, [x.lat, x.lng]) >= STEP_M)) { d.pts.push([round7(x.lat), round7(x.lng)]); d.acc = Math.max(d.acc || 0, Math.round(x.acc)); previewShape(); }
      prompt(`${quality(x)}. Walk along it; a point is added every ${Math.round(STEP_M * 3.281)} ft. `);
    });
    prompt('Finding your location… ');
  }
  async function finish() {
    const d = drawing;
    const need = { point: 1, line: 2, area: 3 }[d.geometry];
    if (d.pts.length < need) { toast(`A ${GEO_WORD[d.geometry]} needs at least ${need} point${need === 1 ? '' : 's'}`); return; }
    if (d.feature) {
      const f = d.feature; const pts = d.pts;
      stopDrawing();
      try { await patch(`/assets/map/features/${f.id}`, { points: pts, placed_how: 'map', accuracy_m: null }); toast('Shape saved'); } catch (err) { fail(err); }
      await reload(false, f.id);
      return;
    }
    const kind = d.kind; const pts = d.pts; const how = d.how; const acc = d.acc; const assetId = d.assetId;
    stopDrawing();
    details({ kind, geometry: d.geometry, points: pts, placed_how: how, accuracy_m: acc, asset_id: assetId, status: 'in_service' }, true);
  }

  // ---- the details form, for a new item and for editing one
  function details(f, isNew = false) {
    const k = kindOf(f.kind);
    const assetSel = select([['', 'Not linked'], ...cfg.assets.map((a) => [a.id, `${a.name}${a.asset_tag ? ` (${a.asset_tag})` : ''}`])], f.asset_id || '', { name: 'asset_id' });
    const body = h('div', { class: 'form' },
      field('What is it?', kindPicker(f.geometry || k.geometry, f.kind)),
      field('Name (optional)', input({ name: 'name', value: f.name || '', maxlength: 100, placeholder: k.geometry === 'line' ? (isMuni() ? 'For example: Main Street main' : 'For example: Main line, pond to summit') : 'For example: Valve 12' })),
      field('Tag or ID (optional)', input({ name: 'tag', value: f.tag || '', maxlength: 30, placeholder: 'For example: V-114' }), 'One map item\'s own. Shown on the map and the panel.'),
      field('Condition', scoreSelect('condition_score', CONDITIONS, f.condition_score), '1 is new, 5 is failed or failing'),
      field('Criticality', scoreSelect('criticality', CRITICALITIES, f.criticality), 'What happens if it fails: 1 little, 5 severe'),
      field('Owned by', select([['', 'Not set'], ...OWNERSHIP], f.ownership || '', { name: 'ownership' })),
      field('Size', input({ name: 'size', value: f.size || '', maxlength: 40, placeholder: k.geometry === 'line' ? 'For example: 8 in' : '' })),
      field('Material', input({ name: 'material', value: f.material || '', maxlength: 40, placeholder: k.geometry === 'line' ? 'For example: ductile iron, HDPE' : '' })),
      field('Depth (ft)', input({ name: 'depth_ft', type: 'number', step: '0.5', min: '0', value: f.depth_ft ?? '' })),
      field('Year installed', input({ name: 'installed_year', type: 'number', min: '1900', max: '2100', value: f.installed_year ?? '' })),
      field('Status', select(STATUS, f.status || 'in_service', { name: 'status' })),
      field('Asset in the register', assetSel, 'Ties this to an asset, so its record links here.'),
      field('Notes', h('textarea', { name: 'notes', rows: 3, maxlength: 1000 }, f.notes || '')));
    formDialog(isNew ? `New ${k.label.toLowerCase()}` : `Edit ${title(f)}`, body, async (fd) => {
      const b = { kind: val(fd, 'kind'), name: val(fd, 'name'), tag: val(fd, 'tag'), size: val(fd, 'size'), material: val(fd, 'material'), depth_ft: num(fd, 'depth_ft'), installed_year: num(fd, 'installed_year'),
        status: val(fd, 'status'), asset_id: num(fd, 'asset_id'), notes: val(fd, 'notes'), condition_score: num(fd, 'condition_score'), criticality: num(fd, 'criticality'), ownership: val(fd, 'ownership') };
      let saved;
      if (isNew) saved = await post('/assets/map/features', { ...b, geometry: f.geometry, points: f.points, placed_how: f.placed_how, accuracy_m: f.accuracy_m });
      else saved = await patch(`/assets/map/features/${f.id}`, b);
      toast(isNew ? `${title(saved)} is on the map` : 'Saved');
      await reload(false, saved.id);
    }, { submitText: isNew ? 'Save' : 'Save changes' });
  }

  // ---- moving and reshaping
  function reshape(f) {
    stopDrawing();
    const lyr = drawn.get(f.id);
    if (f.geometry === 'point') {
      if (!lyr || !lyr.dragging) return;
      lyr.dragging.enable();
      drawing = { feature: f, kind: f.kind, geometry: 'point', pts: f.points.slice() };
      appendAll(clear(banner), h('b', null, `Moving ${title(f)}. `), 'Drag it to where it is, then save. ',
        button('Save', async () => { const at = lyr.getLatLng(); drawing.pts = [[round7(at.lat), round7(at.lng)]]; await finish(); }, { small: true, kind: 'primary' }),
        button('Cancel', async () => { stopDrawing(); await reload(false); }, { small: true }));
      banner.hidden = false;
      return;
    }
    // Lines and areas: a handle on each point; drag one to move it, tap the map to add one at the end.
    drawing = { feature: f, kind: f.kind, geometry: f.geometry, pts: f.points.map((p) => p.slice()), handles: [] };
    if (lyr) lyr.remove();
    const handle = (i) => {
      const m = L.marker(drawing.pts[i], { draggable: true, icon: L.divIcon({ className: 'amap-handle', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
      m.on('drag', () => { const at = m.getLatLng(); drawing.pts[i] = [round7(at.lat), round7(at.lng)]; previewShape(); });
      return m;
    };
    drawing.handles = drawing.pts.map((_, i) => handle(i));
    previewShape();
    prompt('Drag a point to move it. ');
  }
  function remove(f) {
    confirmDialog(`Delete ${title(f)}?`, 'It comes off the map for everyone. The change is kept in the activity log.', 'Delete', async () => {
      await del(`/assets/map/features/${f.id}`); toast('Deleted'); await reload(false);
    }, { danger: true });
  }

  // ---- one item's panel: what it is, its scores, inspections, work orders, photos and run hours
  let meta = null;
  async function panel(id) {
    let f;
    try { f = await get(`/assets/map/features/${id}`); } catch (err) { fail(err); return; }
    const again = async () => { dlg.close(); await reload(false); await panel(id); };
    const facts = [
      ['Kind', `${f.kind_label}, ${(sys[f.system] || sys.other || { label: '' }).label}`], ['Tag', f.tag], ['Size', f.size], ['Material', f.material],
      ['Depth', f.depth_ft != null ? `${f.depth_ft} ft` : null], ['Year installed', f.installed_year], ['Length or area', measure(f)],
      ['Status', f.status !== 'in_service' ? (STATUS.find((x) => x[0] === f.status) || [null, label(f.status)])[1] : null],
      ['Owned by', f.ownership ? (OWNERSHIP.find((o) => o[0] === f.ownership) || [null, f.ownership])[1] : null],
      ['Asset', f.asset_id ? h('a', { href: `#/assets/a/${f.asset_id}` }, `${f.asset_name}${f.asset_tag ? ` (${f.asset_tag})` : ''}`) : null], ['Notes', f.notes],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');
    const cond = scoreSelect('condition_score', CONDITIONS, f.condition_score); cond.setAttribute('aria-label', 'Condition');
    const crit = scoreSelect('criticality', CRITICALITIES, f.criticality); crit.setAttribute('aria-label', 'Criticality');
    const saveScores = async () => { try { await patch(`/assets/map/features/${id}`, { condition_score: cond.value ? Number(cond.value) : null, criticality: crit.value ? Number(crit.value) : null }); toast('Saved'); await again(); } catch (err) { fail(err); } };
    if (canEdit) { cond.addEventListener('change', saveScores); crit.addEventListener('change', saveScores); } else { cond.disabled = true; crit.disabled = true; }
    const openOrders = f.work_orders.filter((w) => !['done', 'cancelled'].includes(w.status));
    const mapSlot = h('div');
    const body = h('div', { class: 'stack feature-panel' },
      h('div', { class: 'row' }, riskState(f.risk) || h('span', { class: 'muted' }, 'Risk not scored'), openOrders.length ? state(`${openOrders.length} open work order${openOrders.length === 1 ? '' : 's'}`, 'warn') : null,
        f.last_inspection ? h('span', { class: 'muted small' }, `Last inspected ${fmtDateTime(f.last_inspection.done_at)}: ${f.last_inspection.result === 'pass' ? 'passed' : 'failed'}`) : h('span', { class: 'muted small' }, 'Never inspected')),
      canEdit ? h('div', { class: 'row asset-actions' },
        button('Inspect', async () => { meta = meta || await get('/assets/meta'); inspectDialog({ type: 'feature', kind: f.kind, id, name: title(f) }, meta.templates, { photoPath: `/assets/map/features/${id}/photos`, save: (b) => post(`/assets/map/features/${id}/inspections`, b), done: again }); }, { kind: 'primary' }),
        button('Open a work order', () => woDialog(f, again)),
        button('Edit', () => { dlg.close(); details(features.find((x) => x.id === id) || f); })) : null,
      h('div', { class: 'form' }, h('label', null, 'Condition ', cond), h('label', null, 'Criticality ', crit)),
      h('dl', { class: 'kv' }, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      mapSlot,
      h('section', { class: 'stack tight' }, h('h3', null, 'Work orders'), f.work_orders.length ? h('ul', { class: 'plain rows' }, f.work_orders.map((w) => h('li', { class: 'spread' },
        h('span', null, h('b', null, w.title), ' ', state(label(w.status), w.status === 'done' ? 'good' : w.status === 'cancelled' ? 'neutral' : 'warn')),
        button('Open', () => workOrderSheet(w.id, null, again), { small: true, label: `Open work order: ${w.title}` })))) : h('p', { class: 'muted' }, 'None.')),
      h('section', { class: 'stack tight' }, h('h3', null, 'Inspections'), inspectionRows(f.inspections)),
      f.kind === 'lift_station' || f.run_hours ? h('section', { class: 'stack tight' }, h('h3', null, 'Run hours by month'), runHoursTable(f.run_hours, `/assets/map/features/${id}/run-hours?format=csv`, `${(f.tag || `station-${id}`).replace(/[^A-Za-z0-9-]+/g, '-')}-run-hours.csv`)) : null,
      h('section', { class: 'stack tight' }, h('h3', null, 'Photos'), canEdit ? photoStrip(f.photos, `/assets/map/features/${id}/photos`, again) : (f.photos.length ? photoStrip(f.photos, `/assets/map/features/${id}/photos`, again) : h('p', { class: 'muted' }, 'No photos.'))),
      f.programs.length ? h('section', { class: 'stack tight' }, h('h3', null, 'Programs'), h('ul', { class: 'plain' }, f.programs.map((p) => h('li', null, h('a', { href: `#/assetprograms/${p.id}` }, p.name), h('span', { class: 'muted small' }, ` ${p.status === 'closed' ? 'closed' : { todo: 'to do', done: 'done', skipped: 'skipped' }[p.target_status]}`))))) : null);
    const dlg = dialog(title(f), body, { wide: true });
    miniMap(f, { label: `Map of ${title(f)}` }).then((el) => mapSlot.append(el));
  }
  function woDialog(f, done) {
    formDialog(`Work order: ${title(f)}`, h('div', { class: 'form' },
      h('div', { class: 'wide' }, field('What is wrong', input({ name: 'title', required: true, minlength: 3, maxlength: 150, placeholder: 'Valve box broken, hydrant leaking, manhole lid loose' }))),
      h('div', { class: 'wide' }, field('Details', h('textarea', { name: 'description', rows: 3, maxlength: 5000 }))),
      field('Priority', select([['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent'], ['low', 'Low']], 'normal', { name: 'priority' })),
      field('Due', input({ name: 'due_date', type: 'date' })),
      h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'out_of_service' }), ' Mark it out of service now')),
    async (fd) => {
      await post(`/assets/map/features/${f.id}/work-orders`, { title: val(fd, 'title'), description: val(fd, 'description'), priority: val(fd, 'priority'), due_date: val(fd, 'due_date'), out_of_service: fd.get('out_of_service') === 'on' });
      toast('Work order opened');
      await done();
    }, { submitText: 'Open work order' });
  }

  // ---- first draw, and a deep link
  redraw(!cfg.center);
  const fm = /^f(\d+)$/.exec(deep || ''); const am = /^a(\d+)$/.exec(deep || '');
  if (fm) { const f = features.find((x) => x.id === Number(fm[1])); if (f) { focus(f); panel(f.id); } }
  if (am) {
    const id = Number(am[1]);
    const mine = features.filter((f) => f.asset_id === id);
    if (mine.length) { fitMap(map, L.latLngBounds(mine.flatMap((f) => f.points)), { padding: [60, 60], maxZoom: 19 }); if (mine.length === 1) focus(mine[0]); } else if (canEdit) {
      const a = cfg.assets.find((x) => x.id === id);
      startAdd('point', { assetId: id, preset: a && FROM_ASSET[a.kind] });
    }
  }
}

/** For the asset page: a link to this asset on the map (or to put it there). */
export function assetMapLink(assetId, onMap) {
  return h('a', { class: 'btn small', href: `#/assets/map/a${assetId}` }, onMap ? 'Show on the map' : 'Put it on the map');
}
