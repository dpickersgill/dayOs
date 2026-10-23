// The patrol map: drop a pin on an incident's location, and see every case's pin on one map.
// Leaflet is loaded from our own server the first time a map opens (the page's security policy allows scripts
// from nowhere else). Map tiles come from the tile servers the server lists in GET /patrol/map.

import { get, put } from '../api.js';
import { h, clear, button, toast, dialog, field, input, select, state, fmtDateTime, label, todayStr, errorBox, empty } from '../ui.js';

let leafletReady = null;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletReady) {
    leafletReady = new Promise((resolve, reject) => {
      document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css' }));
      const s = h('script', { src: '/vendor/leaflet/leaflet.js' });
      s.addEventListener('load', () => resolve(window.L));
      s.addEventListener('error', () => { leafletReady = null; reject(new Error('The map could not be loaded. Check your connection and try again.')); });
      document.head.append(s);
    });
  }
  return leafletReady;
}

// Fetched each time a map opens (it is small) so a different person signing in on the same tab never sees stale rights or views.
const loadConfig = () => get('/patrol/map');
export const forgetMapConfig = () => {};

const US_VIEW = { lat: 39.8283, lng: -98.5795, zoom: 4 };
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const fmtCoord = (lat, lng) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

/**
 * A map with the mountain's tile layers (and a switch when there is more than one). Each layer is drawn from its own
 * deepest tiles and enlarged past them, so every map zooms in far enough to place a single valve. `base` picks the
 * layer it opens on (the asset map opens on Satellite); the person's last choice on that map is remembered.
 */
export function makeMap(L, el, cfg, view, { base, remember } = {}) {
  const deepest = cfg.max_zoom || 21;
  const map = L.map(el, { zoomControl: true, attributionControl: true, maxZoom: deepest }).setView([view.lat, view.lng], view.zoom);
  const layers = cfg.layers.map((l) => [l.name, L.tileLayer(l.url, { attribution: l.attribution, maxNativeZoom: l.maxZoom, maxZoom: deepest, referrerPolicy: 'origin' })]);
  let saved = null;
  try { saved = remember ? localStorage.getItem(`so.map.${remember}`) : null; } catch (_) { /* private mode */ }
  const first = layers.find(([n]) => n === saved) || layers.find(([n]) => n === base) || layers[0];
  first[1].addTo(map);
  if (remember) map.on('baselayerchange', (e) => { try { localStorage.setItem(`so.map.${remember}`, e.name); } catch (_) { /* private mode */ } });
  if (layers.length > 1) L.control.layers(Object.fromEntries(layers), null, { collapsed: true }).addTo(map);
  // The map is often built while its box is still detached from the page or being sized, so Leaflet measures it at zero.
  // When the box gets a real size, re-measure it and put the view back where it was asked to be.
  setTimeout(() => map.invalidateSize(), 60);
  let sized = el.clientWidth > 0 && el.clientHeight > 0;
  if (typeof window.ResizeObserver === 'function') {
    const watch = new window.ResizeObserver(() => {
      const now = el.clientWidth > 0 && el.clientHeight > 0;
      if (!now) { sized = false; return; }
      map.invalidateSize({ animate: false });
      if (!sized) { sized = true; if (map._lastFit) map.fitBounds(map._lastFit.bounds, map._lastFit.opts); else map.setView([view.lat, view.lng], view.zoom, { animate: false }); }
    });
    watch.observe(el);
  }
  return map;
}

/** fitBounds that is remembered, so it is repeated once the map's box has its real size. */
export function fitMap(map, bounds, opts) {
  map._lastFit = { bounds, opts };
  const box = map.getContainer ? map.getContainer() : null;
  if (box && !(box.clientWidth > 0 && box.clientHeight > 0)) return; // no size yet; done when the box is sized
  map.fitBounds(bounds, opts);
}

/** Removes the map when its dialog is closed (the dialog's own close button does not tell us). */
export function removeWhenGone(box, map) {
  if (!window.MutationObserver) return;
  const watch = new window.MutationObserver(() => {
    if (!box.isConnected) { watch.disconnect(); try { map.remove(); } catch (_) { /* already gone */ } }
  });
  watch.observe(document.body, { childList: true, subtree: true });
}

const pinIcon = (L, severity) => L.divIcon({ className: `map-pin${severity ? ` sev-${severity}` : ''}`, html: '<span></span>', iconSize: [34, 34], iconAnchor: [17, 40] });

function startView(cfg, at) {
  if (at) return { lat: at.lat, lng: at.lng, zoom: 17 };
  if (cfg.center) return { lat: cfg.center.lat, lng: cfg.center.lng, zoom: cfg.center.zoom };
  return US_VIEW;
}

/** Saves the current map view as where the map opens for this mountain (managers and the patrol director). */
function defaultViewButton(map, cfg) {
  if (!cfg.can_admin) return null;
  return button('Open the map here by default', async () => {
    const c = map.getCenter();
    await put('/patrol/map-config', { lat: round6(c.lat), lng: round6(c.lng), zoom: Math.round(map.getZoom()) });
    forgetMapConfig();
    toast('The map will open on this view');
  }, { small: true });
}

/**
 * The pin dialog for one incident. Tap or click the map to drop the pin; drag it to adjust.
 * at: { lat, lng } of an existing pin, or null. onSave({ lat, lng }) records it. editable false shows the pin only.
 */
export async function pinDialog({ at = null, editable = true, title = 'Incident location', onSave } = {}) {
  const [L, cfg] = await Promise.all([loadLeaflet(), loadConfig()]);
  let pin = at ? { lat: Number(at.lat), lng: Number(at.lng) } : null;
  let marker = null;
  const mapEl = h('div', { class: 'map-box', role: 'application', 'aria-label': 'Map. Tap to drop the pin on the incident location.' });
  const readout = h('p', { class: 'map-readout', role: 'status', 'aria-live': 'polite' });
  const accuracy = h('span', { class: 'muted small' });
  const save = editable ? button('Save pin', async () => { await onSave({ lat: round6(pin.lat), lng: round6(pin.lng) }); dlg.close(); }, { kind: 'primary' }) : null;
  if (save) save.disabled = !pin;

  const view = startView(cfg, pin);
  const hint = !pin && !cfg.center ? 'Zoom to your mountain, or use your location, then tap the map to drop the pin.' : (editable ? 'Tap the map to drop the pin. Drag the pin to adjust it.' : '');
  const here = editable ? button('Use my location', () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('This browser cannot share a location')); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      place(p.coords.latitude, p.coords.longitude);
      map.setView([p.coords.latitude, p.coords.longitude], 18);
      accuracy.textContent = Number.isFinite(p.coords.accuracy) ? ` Device accuracy about ${Math.round(p.coords.accuracy)} m.` : '';
      resolve();
    }, () => reject(new Error('Location was not shared. Allow location for this site, or tap the map instead.')), { enableHighAccuracy: true, timeout: 15000 });
  }), { small: true }) : null;

  const dlg = dialog(title, [hint ? h('p', { class: 'muted' }, hint) : null, mapEl, readout, h('div', { class: 'row' }, here, defaultViewButton({ getCenter: () => map.getCenter(), getZoom: () => map.getZoom() }, cfg), save)], { wide: true });
  const map = makeMap(L, mapEl, cfg, view);
  removeWhenGone(dlg.box, map);

  function show() {
    clear(readout);
    if (pin) readout.append(h('strong', null, 'Pin: '), fmtCoord(pin.lat, pin.lng), accuracy);
    else readout.append(h('span', { class: 'muted' }, 'No pin yet.'));
    if (save) save.disabled = !pin;
  }
  function place(lat, lng) {
    pin = { lat, lng };
    if (marker) marker.setLatLng([lat, lng]);
    else {
      marker = L.marker([lat, lng], { icon: pinIcon(L), draggable: editable, keyboard: editable, title: 'Incident location' }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); pin = { lat: p.lat, lng: p.lng }; accuracy.textContent = ''; show(); });
    }
    show();
  }
  if (pin) place(pin.lat, pin.lng); else show();
  if (editable) map.on('click', (e) => { accuracy.textContent = ''; place(e.latlng.lat, e.latlng.lng); });
  return dlg;
}

// ---------------------------------------------------------------- the Map tab: every case's pin

export async function drawMapTab(box, { canAdmin } = {}) {
  const season = (() => { const t = todayStr(); const y = Number(t.slice(0, 4)); return Number(t.slice(5, 7)) >= 8 ? y : y - 1; })();
  const from = input({ type: 'date', 'aria-label': 'From', value: `${season}-08-01` });
  const to = input({ type: 'date', 'aria-label': 'To', value: todayStr() });
  const cat = select([['', 'Any type'], ['injury', 'Injury'], ['medical', 'Medical'], ['hazard', 'Hazard'], ['other', 'Other']], '', { 'aria-label': 'Type' });
  const info = h('p', { class: 'muted small', role: 'status' });
  const mapEl = h('div', { class: 'map-box tall', role: 'application', 'aria-label': 'Map of incident pins' });
  const wrap = h('div', { class: 'stack' }, h('div', { class: 'filters' }, from, to, cat), info, mapEl);
  clear(box).append(wrap);

  let L; let cfg;
  try { [L, cfg] = await Promise.all([loadLeaflet(), loadConfig()]); } catch (err) { clear(box).append(errorBox(err)); return; }
  const map = makeMap(L, mapEl, cfg, startView(cfg, null));
  removeWhenGone(mapEl, map);
  const group = [];
  const admin = defaultViewButton(map, { can_admin: canAdmin });
  if (admin) wrap.append(h('div', { class: 'row' }, admin));

  async function load() {
    const qs = [from.value && `from=${from.value}`, to.value && `to=${to.value}`, cat.value && `category=${cat.value}`].filter(Boolean).join('&');
    let data;
    try { ({ data } = await get(`/patrol/map-pins${qs ? `?${qs}` : ''}`)); } catch (err) { info.textContent = err.message; return; }
    for (const m of group) m.remove();
    group.length = 0;
    const pts = [];
    for (const c of data) {
      const m = L.marker([c.gps_lat, c.gps_lng], { icon: pinIcon(L, c.severity), title: c.case_number || `Case ${c.id}` }).addTo(map);
      m.bindPopup(h('div', { class: 'map-pop' }, h('a', { href: `#/patrol/case/${c.id}` }, c.case_number || `Case ${c.id}`), h('div', null, fmtDateTime(c.occurred_at)), h('div', null, `${label(c.category)}, ${label(c.severity)}`), h('div', null, c.summary)));
      group.push(m);
      pts.push([c.gps_lat, c.gps_lng]);
    }
    info.textContent = data.length ? `${data.length} case${data.length === 1 ? '' : 's'} with a pin in this range. Open a case and use "Drop a pin on the map" to add more.` : 'No cases with a pin in this range. Open a case and use "Drop a pin on the map" in its location section.';
    if (pts.length) fitMap(map, L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
  }
  for (const el of [from, to, cat]) el.addEventListener('change', load);
  await load();
}
export { field, state, empty };
