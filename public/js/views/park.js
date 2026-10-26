// The terrain park: where the crew puts every feature each day, the catalog of features, areas and inspections.
// Tap the map to put a feature down, drag it to adjust. A past day is a record, so it opens read-only for the crew.

import { get, post, put, patch, del } from '../api.js';
import { h, clear, can, isManager, state, input, select, field, button, toast, formDialog, dialog, confirmDialog, tabs, table, val, num, todayStr, addDays, fmtDateLong, fmtDateTime, fmtDate, label, empty, errorBox, fail, appendAll } from '../ui.js';
import { loadLeaflet, makeMap, removeWhenGone, fitMap } from './incident-map.js';

const SIZES = [['xs', 'Extra small'], ['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Extra large']];
const LEVELS = [['learn', 'Learning'], ['small', 'Small'], ['medium', 'Medium'], ['large', 'Large'], ['pro', 'Pro']];
const STATUS = {
  ready: ['Ready', 'good'], needs_attention: ['Needs attention', 'warn'], closed: ['Closed', 'bad'], retired: ['Retired', 'neutral'],
};
const RESULT = { ok: 'OK, ready', needs_attention: 'Needs attention', closed: 'Close it' };
const GROUP_LETTER = { rails: 'R', boxes: 'B', jumps: 'J', pipes: 'P', other: '•' };
const US_VIEW = { lat: 39.8283, lng: -98.5795, zoom: 4 };
const round6 = (n) => Math.round(n * 1e6) / 1e6;

let kindsCache = null;
async function kinds() {
  if (!kindsCache) kindsCache = (await get('/park/kinds')).data;
  return kindsCache;
}
const kindInfo = (list, key) => list.find((k) => k.key === key) || { key, label: label(key), group: 'other', group_label: 'Other' };
const statusChip = (s) => state(...(STATUS[s] || [label(s), 'neutral']));

export async function render(root, params = []) {
  const list = await kinds();
  const items = [
    ['layout', 'Daily map', (b) => drawLayout(b, list)],
    ['features', 'Features', (b) => drawFeatures(b, list)],
    ['areas', 'Areas', drawAreas],
  ];
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Terrain park')), tabs(items, items.some((i) => i[0] === params[0]) ? params[0] : 'layout'));
}

// ---------------------------------------------------------------- the daily map
// A phone's GPS is good to a few meters in the open and much worse under trees or beside the lodge. A pin goes down by
// itself once the fix is within GOOD_M; past OK_M the crew is warned and can drop anyway or tap the map instead.
const GOOD_M = 8; const OK_M = 15; const WAIT_MS = 20000;
const ft = (m) => `${Math.max(1, Math.round(Number(m) * 3.281))} ft`;
const PLACED = { gps: (p) => (p.accuracy_m != null ? `Placed by GPS, within ${ft(p.accuracy_m)}` : 'Placed by GPS'), map: () => 'Placed by tapping the map', drag: () => 'Moved by hand on the map', copy: () => 'Copied from another day' };

async function drawLayout(box, list) {
  const canEdit = can('staff');
  let date = todayStr();
  let data = { placed: [], unplaced: [], editable: false };
  let placing = null; // the feature waiting to be put down
  let areas = [];
  const markers = new Map();

  const dateInput = input({ type: 'date', value: date, 'aria-label': 'Day' });
  const heading = h('h2', { class: 'park-day' });
  const summary = h('p', { class: 'muted small', role: 'status' });
  const banner = h('div', { class: 'park-banner', role: 'status', hidden: true });
  const mapEl = h('div', { class: 'map-box tall park-map', role: 'application', 'aria-label': 'Map of terrain park features for the day' });
  const onMap = h('div', { class: 'park-list' });
  const waiting = h('div', { class: 'park-list' });
  const copySel = select([['', 'Copy from…']], '', { 'aria-label': 'Copy another day onto this one' });
  const copyBtn = button('Copy', copyDay, { small: true });
  const controls = h('div', { class: 'park-controls' },
    button('‹', () => go(addDays(date, -1)), { small: true }), dateInput, button('›', () => go(addDays(date, 1)), { small: true }), button('Today', () => go(todayStr()), { small: true }),
    canEdit ? h('span', { class: 'row' }, copySel, copyBtn) : null);

  clear(box).append(h('div', { class: 'stack' }, controls, heading, summary, banner,
    h('div', { class: 'park-layout' }, mapEl, h('div', { class: 'park-side' }, h('h3', null, 'On the map'), onMap, h('h3', null, 'Not on the map'), waiting))));

  let L; let cfg;
  try { [L, cfg] = await Promise.all([loadLeaflet(), get('/park/map')]); } catch (err) { clear(box).append(errorBox(err)); return; }
  const start = cfg.center ? { lat: cfg.center.lat, lng: cfg.center.lng, zoom: cfg.center.zoom } : US_VIEW;
  const map = makeMap(L, mapEl, cfg, start);
  removeWhenGone(mapEl, map);
  if (isManager()) {
    box.firstChild.append(h('div', { class: 'row' }, button('Open the map here by default', async () => {
      const c = map.getCenter();
      try { await put('/patrol/map-config', { lat: round6(c.lat), lng: round6(c.lng), zoom: Math.round(map.getZoom()) }); toast('The map will open on this view'); } catch (err) { fail(err); }
    }, { small: true })));
  }
  if (!cfg.center && navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => { if (!markers.size) map.setView([p.coords.latitude, p.coords.longitude], 17); }, () => {}, { timeout: 5000 });

  const icon = (p) => {
    const k = kindInfo(list, p.kind);
    const el = h('span', { class: `park-pin st-${p.feature_status}${date === cfg.today && !p.inspected_result ? ' uninspected' : ''}` }, GROUP_LETTER[k.group] || '•');
    return L.divIcon({ className: 'park-pin-wrap', html: el, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18] });
  };

  function popup(p) {
    const k = kindInfo(list, p.kind);
    const body = h('div', { class: 'map-pop park-pop' },
      h('b', null, p.name), h('div', { class: 'muted small' }, `${k.label}${p.dimensions ? `, ${p.dimensions}` : ''}`),
      h('div', null, statusChip(p.feature_status)),
      p.area ? h('div', null, `Area: ${p.area}`) : null, p.note ? h('div', null, p.note) : null,
      p.placed_how ? h('div', { class: 'muted small' }, PLACED[p.placed_how](p)) : null,
      h('div', { class: 'muted small' }, p.inspected_result ? `Inspected: ${RESULT[p.inspected_result]}` : date === cfg.today ? 'Not inspected yet today' : ''));
    if (canEdit) {
      const row = h('div', { class: 'row' }, button('Inspect', () => inspectDialog(p, refresh), { small: true }));
      if (data.editable) row.append(button('Details', () => detailsDialog(p), { small: true }), button('Remove', () => removeFromMap(p), { small: true }));
      body.append(row);
    }
    return body;
  }

  async function putPlacement(featureId, lat, lng, extra = {}) {
    await put(`/park/placements/${date}/${featureId}`, { lat: round6(lat), lng: round6(lng), ...extra });
  }

  function drawMarkers(fit) {
    for (const m of markers.values()) m.remove();
    markers.clear();
    for (const p of data.placed) {
      const m = L.marker([p.lat, p.lng], { icon: icon(p), title: p.name, draggable: canEdit && data.editable, keyboard: true }).addTo(map);
      m.bindPopup(() => popup(p));
      m.on('dragend', async () => {
        const at = m.getLatLng();
        try { await putPlacement(p.feature_id, at.lat, at.lng, { area_id: p.area_id, note: p.note, how: 'drag' }); toast(`${p.name} moved`); } catch (err) { fail(err); }
        await refresh();
      });
      markers.set(p.feature_id, m);
    }
    if (fit && data.placed.length) fitMap(map, L.latLngBounds(data.placed.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 18 });
  }

  function drawLists() {
    const mark = (p) => h('li', null, h('button', { type: 'button', class: 'park-row', onclick: () => { const m = markers.get(p.feature_id); if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 18)); m.openPopup(); } } },
      h('b', null, p.name), ' ', statusChip(p.feature_status), p.inspected_result ? h('span', { class: 'muted small' }, ` ${RESULT[p.inspected_result]}`) : date === cfg.today ? h('span', { class: 'muted small' }, ' not inspected') : null));
    appendAll(clear(onMap), data.placed.length ? h('ul', null, data.placed.map(mark)) : h('p', { class: 'muted small' }, 'Nothing is on the map for this day yet.'),
      data.placed.length > 0 && canEdit && data.editable ? h('p', { class: 'muted small' }, 'Drag a pin to fine-tune where it is.') : null);
    const todo = (f) => h('li', null, h('span', { class: 'park-row' }, h('b', null, f.name), ' ', statusChip(f.status), h('span', { class: 'muted small' }, ` ${kindInfo(list, f.kind).label}`),
      canEdit && data.editable ? button('Place', () => startPlacing(f), { small: true }) : null));
    appendAll(clear(waiting), data.unplaced.length > 0 && canEdit && data.editable && navigator.geolocation && !walking
      ? h('div', { class: 'row' }, button('Walk the park', startWalk, { kind: 'primary', small: true }), h('span', { class: 'muted small' }, 'Go feature to feature and drop each pin where you stand.')) : null,
    data.unplaced.length ? h('ul', null, data.unplaced.map(todo)) : h('p', { class: 'muted small' }, 'Every feature is on the map.'));
    const missing = date === cfg.today ? data.placed.filter((p) => !p.inspected_result).length : 0;
    summary.textContent = `${data.placed.length} on the map, ${data.unplaced.length} not placed${missing ? `, ${missing} not inspected yet` : ''}.${!data.editable ? ' This day is over, so it is a record. A manager can change it.' : ''}`;
  }

  // ---- GPS: a pin only goes down from a fix that is close enough, and the crew sees how close it is as it improves.
  let watchId = null; let fix = null; let meDot = null; let meRing = null; let gpsLine = null; let waitTimer = null;
  function drawMe() {
    if (!fix) return;
    const at = [fix.lat, fix.lng];
    if (!meRing) meRing = L.circle(at, { radius: fix.acc, className: 'gps-ring', interactive: false }).addTo(map); else meRing.setLatLng(at).setRadius(fix.acc);
    if (!meDot) meDot = L.circleMarker(at, { radius: 7, className: 'gps-dot', interactive: false }).addTo(map); else meDot.setLatLng(at);
  }
  function startGps(onFix) {
    if (watchId !== null || !navigator.geolocation) return;
    fix = null;
    watchId = navigator.geolocation.watchPosition((pos) => {
      fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 999 };
      drawMe();
      if (onFix) onFix(fix);
    }, (err) => { if (gpsLine) gpsLine.textContent = err.code === 1 ? 'Location is switched off for this site. Allow it in the browser, or tap the map instead.' : 'No GPS signal yet. Step into the open, or tap the map instead.'; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null; fix = null; clearTimeout(waitTimer);
    if (meDot) { meDot.remove(); meDot = null; }
    if (meRing) { meRing.remove(); meRing = null; }
  }
  const quality = (f) => (!f ? 'Finding your location…' : f.acc <= GOOD_M ? `GPS good: within ${ft(f.acc)}` : f.acc <= OK_M ? `GPS fair: within ${ft(f.acc)}` : `GPS weak: within ${ft(f.acc)}. Step into the open, away from trees and buildings.`);

  function startPlacing(f) {
    placing = f;
    appendAll(clear(banner), h('b', null, `Putting down ${f.name}. `), 'Tap the map where it goes. ',
      navigator.geolocation ? button('Use my location', useMyLocation, { small: true }) : null, button('Cancel', stopPlacing, { small: true }));
    banner.hidden = false;
    mapEl.classList.add('placing');
  }
  function stopPlacing() { placing = null; banner.hidden = true; mapEl.classList.remove('placing'); if (!walking) stopGps(); }
  async function dropAt(lat, lng, extra = { how: 'map' }) {
    const f = placing;
    if (!f) return;
    stopPlacing();
    try { await putPlacement(f.id, lat, lng, extra); toast(`${f.name} is on the map${extra.how === 'gps' ? ` (within ${ft(extra.accuracy_m)})` : ''}`); } catch (err) { fail(err); }
    await refresh();
    const m = markers.get(f.id);
    if (m) m.openPopup();
  }
  /** Waits for a fix within GOOD_M and drops the pin itself; after WAIT_MS the crew can drop on what there is, or tap the map. */
  function useMyLocation() {
    const f = placing;
    gpsLine = h('span', { class: 'gps-line' }, quality(null));
    const now = button('Drop here now', () => { if (fix) dropAt(fix.lat, fix.lng, { how: 'gps', accuracy_m: Math.round(fix.acc) }); }, { small: true });
    now.disabled = true;
    appendAll(clear(banner), h('b', null, `Putting down ${f.name}. `), gpsLine, ' ', now, button('Cancel', stopPlacing, { small: true }));
    startGps((x) => {
      gpsLine.textContent = quality(x);
      now.disabled = false;
      if (x.acc <= GOOD_M && placing === f) dropAt(x.lat, x.lng, { how: 'gps', accuracy_m: Math.round(x.acc) });
    });
    waitTimer = setTimeout(() => { if (placing === f && fix && fix.acc > GOOD_M) gpsLine.textContent = `${quality(fix)} You can drop it now, or tap the map.`; }, WAIT_MS);
  }

  // ---- Walk the park: feature after feature, each pin dropped from where the crew member is standing.
  let walking = null;
  function startWalk() {
    stopPlacing();
    walking = { skipped: new Set(), done: 0 };
    gpsLine = h('span', { class: 'gps-line' }, quality(null));
    startGps((x) => { if (gpsLine) gpsLine.textContent = quality(x); drawWalk(); });
    drawWalk();
    drawLists();
    mapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function stopWalk(msg) {
    const n = walking ? walking.done : 0;
    walking = null; stopGps(); banner.hidden = true; drawLists();
    if (msg || n) toast(msg || `${n} feature${n === 1 ? '' : 's'} placed`);
  }
  function nextFeature() { return data.unplaced.find((f) => !walking.skipped.has(f.id)); }
  function drawWalk() {
    if (!walking) return;
    const f = nextFeature();
    if (!f) { stopWalk(data.unplaced.length ? 'Walk finished. The skipped features are still waiting.' : 'Every feature is on the map.'); return; }
    const left = data.unplaced.filter((x) => !walking.skipped.has(x.id)).length;
    const drop = button(fix && fix.acc > OK_M ? 'Drop here (weak signal)' : 'Drop here', async () => {
      if (!fix) return;
      const at = { ...fix };
      drop.disabled = true;
      try { await putPlacement(f.id, at.lat, at.lng, { how: 'gps', accuracy_m: Math.round(at.acc) }); walking.done += 1; toast(`${f.name} placed, within ${ft(at.acc)}`); } catch (err) { fail(err); }
      await refresh();
      drawWalk();
    }, { kind: 'primary', small: true });
    drop.disabled = !fix;
    appendAll(clear(banner), h('div', { class: 'stack' },
      h('div', null, h('b', null, `Walking the park: next is ${f.name}`), h('span', { class: 'muted' }, ` (${left} to go). Stand at it, then press Drop here.`)),
      gpsLine,
      h('div', { class: 'row' }, drop, button('Skip', () => { walking.skipped.add(f.id); drawWalk(); }, { small: true }), button('Stop', () => stopWalk(), { small: true }))));
    banner.hidden = false;
  }
  removeWhenGone(mapEl, { remove: stopGps });

  map.on('click', (e) => { if (placing) dropAt(e.latlng.lat, e.latlng.lng, { how: 'map' }); });

  async function removeFromMap(p) {
    confirmDialog('Take it off the map?', `${p.name} stays in your list of features.`, 'Take off', async () => { await del(`/park/placements/${date}/${p.feature_id}`); map.closePopup(); toast('Taken off the map'); await refresh(); });
  }

  function detailsDialog(p) {
    const areaSel = select([['', 'No area'], ...areas.filter((a) => a.active).map((a) => [a.id, a.name])], p.area_id || '', { name: 'area_id' });
    formDialog(p.name, h('div', { class: 'form' }, field('Area', areaSel), h('div', { class: 'wide' }, field('Note for the crew', input({ name: 'note', value: p.note || '', maxlength: 255, placeholder: 'For example: set 10 ft below the lip' })))),
      async (fd) => { await putPlacement(p.feature_id, p.lat, p.lng, { area_id: num(fd, 'area_id'), note: val(fd, 'note') }); toast('Saved'); map.closePopup(); await refresh(); });
  }

  async function copyDay() {
    if (!copySel.value) { toast('Pick the day to copy from.', 'error'); return; }
    try {
      const r = await post(`/park/placements/${date}/copy`, { from: copySel.value });
      toast(r.copied ? `${r.copied} feature${r.copied === 1 ? '' : 's'} copied` : 'Nothing new to copy. Those features are already placed.');
    } catch (err) { fail(err); }
    await refresh(true);
  }

  async function refresh(fit = false) {
    try {
      data = await get(`/park/placements/${date}`);
      areas = (await get('/park/areas')).data;
      const days = (await get('/park/days')).data.filter((d) => String(d.on_date).slice(0, 10) !== date);
      clear(copySel).append(...[['', 'Copy from…'], ...days.map((d) => [String(d.on_date).slice(0, 10), `${fmtDate(String(d.on_date).slice(0, 10))} (${d.features})`])].map(([v, t]) => h('option', { value: v }, t)));
      heading.textContent = fmtDateLong(date);
      drawMarkers(fit);
      drawLists();
    } catch (err) { summary.textContent = err.message; }
  }
  async function go(d) { if (!d) return; if (walking) stopWalk(); date = d; dateInput.value = d; stopPlacing(); await refresh(true); }
  dateInput.addEventListener('change', () => go(dateInput.value));
  await refresh(true);
}

// ---------------------------------------------------------------- inspections
function inspectDialog(f, again) {
  const result = select(Object.entries(RESULT), 'ok', { name: 'result' });
  const d = formDialog(`Inspect ${f.name}`, h('div', { class: 'form' }, field('Result', result),
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 255, placeholder: 'Required if something is wrong' })))),
  async (fd) => {
    await post(`/park/features/${f.feature_id || f.id}/inspections`, { result: val(fd, 'result'), notes: val(fd, 'notes') || undefined });
    toast('Inspection saved');
    await again();
  }, { submitText: 'Save inspection' });
  return d;
}

// ---------------------------------------------------------------- the catalog of features
async function drawFeatures(box, list) {
  const canEdit = can('staff');
  const again = async () => { const n = h('div'); await drawFeatures(n, list); clear(box).append(...n.childNodes); };
  const { data } = await get('/park/features');
  const q = input({ type: 'search', placeholder: 'Find a feature', 'aria-label': 'Find a feature' });
  const tableBox = h('div');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = data.filter((f) => !t || `${f.name} ${kindInfo(list, f.kind).label}`.toLowerCase().includes(t));
    clear(tableBox).append(rows.length ? table([
      { head: 'Feature', cell: (f) => h('b', null, f.name) },
      { head: 'Type', cell: (f) => kindInfo(list, f.kind).label },
      { head: 'Size', cell: (f) => `${label(SIZES.find((s) => s[0] === f.size)[1])}${f.dimensions ? `, ${f.dimensions}` : ''}` },
      { head: 'Moves daily', cell: (f) => (f.portable ? 'Yes' : 'No, built') },
      { head: 'Status', cell: (f) => statusChip(f.status) },
      { head: 'Last inspection', cell: (f) => (f.last_inspected_at ? h('span', null, fmtDateTime(f.last_inspected_at), h('span', { class: 'muted' }, ` ${RESULT[f.last_result] || ''}`), f.last_notes ? h('div', { class: 'muted small' }, f.last_notes) : null) : h('span', { class: 'muted' }, 'Never')) },
      { head: '', actions: true, cell: (f) => h('span', { class: 'row' },
        canEdit && f.status !== 'retired' ? button('Inspect', () => inspectDialog(f, again), { small: true }) : null,
        button('Where it has been', () => historyDialog(f), { small: true }),
        canEdit ? button('Edit', () => featureDialog(f, list, again), { small: true }) : null) },
    ], rows, { rowClass: (f) => (f.status === 'retired' ? 'muted-row' : null) }) : empty(data.length ? 'No feature matches.' : 'No features yet. Add the rails, boxes and jumps your crew builds with.'));
  };
  q.addEventListener('input', draw);
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'spread' }, q, canEdit ? button('Add a feature', () => featureDialog(null, list, again), { kind: 'primary' }) : null), tableBox));
  draw();
}

function featureDialog(f, list, again) {
  const groups = [...new Set(list.map((k) => k.group_label))];
  const kind = select(groups.flatMap((g) => list.filter((k) => k.group_label === g).map((k) => [k.key, `${g}: ${k.label}`])), f ? f.kind : 'butter_box', { name: 'kind' });
  const portable = input({ type: 'checkbox', name: 'portable', checked: f ? f.portable : true });
  const status = f ? field('Status', select([['ready', 'Ready'], ['needs_attention', 'Needs attention'], ['closed', 'Closed'], ['retired', 'Retired (no longer used)']], f.status, { name: 'status' })) : null;
  if (!f) kind.addEventListener('change', () => { portable.checked = kindInfo(list, kind.value).portable; });
  formDialog(f ? `Edit ${f.name}` : 'Add a feature', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100, value: f ? f.name : '', placeholder: 'For example: Butter box 2' })),
    field('Type', kind), field('Size', select(SIZES, f ? f.size : 'm', { name: 'size' })),
    field('Length or height', input({ name: 'dimensions', maxlength: 60, value: (f && f.dimensions) || '', placeholder: 'For example: 12 ft' })),
    h('label', { class: 'check' }, portable, ' The crew moves it from day to day'), status,
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 500, value: (f && f.notes) || '' })))),
  async (fd) => {
    const body = { name: val(fd, 'name'), kind: val(fd, 'kind'), size: val(fd, 'size'), dimensions: val(fd, 'dimensions'), portable: portable.checked, notes: val(fd, 'notes') };
    if (f) { body.status = val(fd, 'status'); await patch(`/park/features/${f.id}`, body); } else await post('/park/features', body);
    toast(f ? 'Saved' : 'Feature added');
    await again();
  }, { submitText: f ? 'Save' : 'Add feature' });
}

async function historyDialog(f) {
  const [{ data: places }, { data: checks }] = await Promise.all([get(`/park/features/${f.id}/history`), get(`/park/features/${f.id}/inspections`)]);
  dialog(f.name, h('div', { class: 'stack' },
    h('h3', null, 'Where it has been'),
    places.length ? table([{ head: 'Day', cell: (p) => fmtDate(String(p.on_date).slice(0, 10)) }, { head: 'Area', cell: (p) => p.area || '' }, { head: 'Position', cell: (p) => `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}` }, { head: 'Note', cell: (p) => p.note || '' }], places) : empty('It has not been placed yet.'),
    h('h3', null, 'Inspections'),
    checks.length ? table([{ head: 'When', cell: (c) => fmtDateTime(c.inspected_at) }, { head: 'Result', cell: (c) => RESULT[c.result] }, { head: 'By', cell: (c) => c.inspected_by || '' }, { head: 'Notes', cell: (c) => c.notes || '' }], checks) : empty('No inspections yet.')), { wide: true });
}

// ---------------------------------------------------------------- areas
async function drawAreas(box) {
  const canEdit = can('staff');
  const again = async () => { const n = h('div'); await drawAreas(n); clear(box).append(...n.childNodes); };
  const { data } = await get('/park/areas');
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'An area is a park or zone, like the main park or the kids park. You can tag features with one on the map.'), canEdit ? button('Add an area', () => areaDialog(null, again), { kind: 'primary' }) : null),
    data.length ? table([
      { head: 'Area', cell: (a) => h('b', null, a.name) }, { head: 'Level', cell: (a) => (LEVELS.find((l) => l[0] === a.level) || [0, label(a.level)])[1] },
      { head: 'Status', cell: (a) => (a.active ? state(label(a.status), a.status === 'open' ? 'good' : 'bad') : state('Not used', 'neutral')) }, { head: 'Notes', cell: (a) => a.notes || '' },
      { head: '', actions: true, cell: (a) => (canEdit ? button('Edit', () => areaDialog(a, again), { small: true }) : null) },
    ], data) : empty('No areas yet. Add your main park, a kids park or a pipe zone.')));
}
function areaDialog(a, again) {
  const active = input({ type: 'checkbox', name: 'active', checked: a ? Boolean(a.active) : true });
  formDialog(a ? `Edit ${a.name}` : 'Add an area', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100, value: a ? a.name : '' })), field('Level', select(LEVELS, a ? a.level : 'small', { name: 'level' })),
    field('Status', select([['open', 'Open'], ['closed', 'Closed']], a ? a.status : 'open', { name: 'status' })),
    a ? h('label', { class: 'check' }, active, ' In use') : null,
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 255, value: (a && a.notes) || '' })))),
  async (fd) => {
    const body = { name: val(fd, 'name'), level: val(fd, 'level'), status: val(fd, 'status'), notes: val(fd, 'notes') };
    if (a) { body.active = active.checked; await patch(`/park/areas/${a.id}`, body); } else await post('/park/areas', body);
    toast('Saved');
    await again();
  });
}
