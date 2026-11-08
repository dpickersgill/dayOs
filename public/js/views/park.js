// The terrain park: where the crew puts every feature each day, the catalog of features, areas and inspections.
// Tap the map to put a feature down, drag it to adjust. A past day is a record: a manager corrects it, with a reason, and
// the original stays. Only an inspection opens a feature, and an area opens each day with its supervisor's sign-off.
// Inspections, pins, rope lines and area openings are kept on the phone with no signal and sent when it returns
// (the same outbox as patrol); photos need a signal.

import { get, post, put, patch, sendBytes } from '../api.js';
import { h, clear, can, isManager, state, input, select, field, button, toast, formDialog, dialog, confirmDialog, tabs, table, val, num, todayStr, addDays, fmtDateLong, fmtDateTime, fmtTime, fmtDate, label, empty, errorBox, fail, appendAll, nowStamp, ctx } from '../ui.js';
import { send, pending, onChange as onOutbox, flush, retry, fixClock, discard, PARK_QUEUE, keepList, keptList } from '../outbox.js';
import { loadLeaflet, makeMap, removeWhenGone, fitMap } from './incident-map.js';

const SIZES = [['xs', 'XS'], ['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']];
const LEVELS = [['beginner', 'Beginner or progression zone'], ['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']];
const STATUS = {
  new: ['Not inspected yet', 'neutral'], ready: ['Open', 'good'], needs_attention: ['Needs attention', 'warn'], closed: ['Closed', 'bad'], retired: ['Retired', 'neutral'],
};
// A pass says what was found, never that a feature is safe.
const RESULT = { ok: 'Inspected, no defects found, open', needs_attention: 'Needs attention', closed: 'Close it' };
const RESULT_SHORT = { ok: 'No defects found', needs_attention: 'Needs attention', closed: 'Closed' };
const KIND = [['morning', 'Morning'], ['midday', 'Mid-day'], ['after_grooming', 'After grooming'], ['after_snow', 'After new snow'], ['after_change', 'After a change'], ['post_incident', 'Post-incident']];
const SIGNOFF = [['entrance_sign', 'Entrance sign with the orange oval'], ['code_sign', 'Park SMART or code sign'], ['size_signs', 'Size signs match today\'s layout'], ['ropes', 'Rope lines and closures in place'], ['visibility', 'Visibility and surface checked'], ['test_ride', 'Test ride done on every jump and rail']];
const CLOSE_REASONS = [['weather', 'Weather'], ['visibility', 'Visibility or flat light'], ['wind', 'Wind'], ['hard_snow', 'Hard or icy snow'], ['other', 'Other']];
const AREA_TODAY = { open: ['Open today', 'good'], closed: ['Closed', 'bad'], not_opened: ['Not opened today', 'neutral'] };
const GROUP_LETTER = { rails: 'R', boxes: 'B', jumps: 'J', pipes: 'P', other: '•' };
const US_VIEW = { lat: 39.8283, lng: -98.5795, zoom: 4 };
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const sizeWord = (s) => (SIZES.find((x) => x[0] === s) || [s, label(s)])[1];
const levelWord = (l) => (LEVELS.find((x) => x[0] === l) || [l, label(l)])[1];
const LEVEL_MAX = { beginner: 's', s: 's', m: 'm', l: 'l', xl: 'xl' };
const overRating = (size, level) => Boolean(level && LEVEL_MAX[level]) && SIZES.findIndex((x) => x[0] === size) > SIZES.findIndex((x) => x[0] === LEVEL_MAX[level]);
const ref = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

let kindsCache = null;
async function kinds() {
  if (kindsCache) return kindsCache;
  try { kindsCache = (await get('/park/kinds')).data; keepList('park.kinds', kindsCache); } catch (err) { kindsCache = keptList('park.kinds'); if (!kindsCache) throw err; }
  return kindsCache;
}
const kindInfo = (list, key) => list.find((k) => k.key === key) || { key, label: label(key), group: 'other', group_label: 'Other', checks: [] };
const statusChip = (s) => state(...(STATUS[s] || [label(s), 'neutral']));
const sentWord = (r, done) => (r && r.queued ? 'No signal: kept on this phone, sent when the signal returns' : done);

export async function render(root, params = []) {
  const list = await kinds();
  if (params[0] === 'record' && params[1] && params[2]) { await drawRecord(root, list, Number(params[1]), params[2]); return; }
  const items = [
    ['layout', 'Daily map', (b) => drawLayout(b, list)],
    ['features', 'Features', (b) => drawFeatures(b, list)],
    ['areas', 'Areas', drawAreas],
  ];
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Terrain park')), tabs(items, items.some((i) => i[0] === params[0]) ? params[0] : 'layout'));
}

// ---------------------------------------------------------------- what waits on this phone
/** The park's entries kept on this phone with no signal, and any the server refused ("Not saved"), with what to do. */
function outboxStrip(again) {
  const box = h('div', { class: 'park-outbox', role: 'status' });
  const draw = () => {
    const list = pending(PARK_QUEUE);
    const waiting = list.filter((x) => !x.error); const refused = list.filter((x) => x.error);
    const offline = globalThis.navigator && navigator.onLine === false;
    clear(box);
    box.hidden = !list.length && !offline;
    if (box.hidden) return;
    box.append(h('div', { class: 'spread' }, h('span', null, h('b', null, offline ? 'No signal. ' : ''), waiting.length ? `${waiting.length} park entr${waiting.length === 1 ? 'y' : 'ies'} waiting to send.` : 'Inspections, pins and openings are kept on this phone and sent when the signal returns. Photos need a signal.'),
      waiting.length && !offline ? button('Send now', async () => { const n = await flush(); toast(n ? `Sent ${n}` : 'Still no connection', n ? 'ok' : 'warn'); if (n) again(); }, { small: true }) : null));
    for (const x of refused) {
      box.append(h('div', { class: 'spread refused' }, h('span', null, h('b', null, `Not saved: ${x.label}. `), x.error),
        h('span', { class: 'row tight' }, x.details && x.details.code === 'future_time' ? button('Fix the time and send', () => fixClock(x.id), { small: true, kind: 'primary' }) : button('Try again', () => retry(x.id), { small: true }),
          button('Discard', () => confirmDialog('Discard this entry?', `${x.label}, taken ${fmtDateTime(x.at)}. It was never saved.`, 'Discard', () => discard(x.id), { danger: true }), { small: true, kind: 'quiet-danger' }))));
    }
  };
  const off = onOutbox(() => { draw(); });
  removeWhenGone(box, { remove: off });
  window.addEventListener('online', draw); window.addEventListener('offline', draw);
  draw();
  return box;
}
const waitingFor = (featureId) => pending(PARK_QUEUE).filter((x) => x.path === `/park/features/${featureId}/inspections`);

// ---------------------------------------------------------------- the daily map
// A phone's GPS is good to a few meters in the open and much worse under trees or beside the lodge. A pin goes down by
// itself once the fix is within GOOD_M; past OK_M the crew is warned and can drop anyway or tap the map instead.
const GOOD_M = 8; const OK_M = 15; const WAIT_MS = 20000;
const ft = (m) => `${Math.max(1, Math.round(Number(m) * 3.281))} ft`;
const PLACED = { gps: (p) => (p.accuracy_m != null ? `Placed by GPS, within ${ft(p.accuracy_m)}` : 'Placed by GPS'), map: () => 'Placed by tapping the map', drag: () => 'Moved by hand on the map', copy: () => 'Copied from another day' };
const distM = (a, b) => { const R = 6371000; const r = (d) => (d * Math.PI) / 180; const dl = r(b.lat - a.lat); const dn = r(b.lng - a.lng); const x = Math.sin(dl / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

async function drawLayout(box, list) {
  const canEdit = can('staff');
  let date = todayStr();
  let data = { placed: [], unplaced: [], editable: false, correctable: false };
  let placing = null; // the feature waiting to be put down
  let areas = [];
  const markers = new Map();

  const dateInput = input({ type: 'date', value: date, 'aria-label': 'Day' });
  const heading = h('h2', { class: 'park-day' });
  const summary = h('p', { class: 'muted small', role: 'status' });
  const banner = h('div', { class: 'park-banner', role: 'status', hidden: true });
  const areaStrip = h('div', { class: 'park-areas' });
  const mapEl = h('div', { class: 'map-box tall park-map', role: 'application', 'aria-label': 'Map of terrain park features for the day' });
  const onMap = h('div', { class: 'park-list' });
  const waiting = h('div', { class: 'park-list' });
  const copySel = select([['', 'Copy from…']], '', { 'aria-label': 'Copy another day onto this one' });
  const copyBtn = button('Copy', copyDay, { small: true });
  const controls = h('div', { class: 'park-controls' },
    button('‹', () => go(addDays(date, -1)), { small: true, label: 'Day before' }), dateInput, button('›', () => go(addDays(date, 1)), { small: true, label: 'Day after' }), button('Today', () => go(todayStr()), { small: true }),
    canEdit ? h('span', { class: 'row' }, copySel, copyBtn) : null);

  clear(box).append(h('div', { class: 'stack' }, outboxStrip(() => refresh()), controls, heading, summary, areaStrip, banner,
    h('div', { class: 'park-layout' }, mapEl, h('div', { class: 'park-side' }, h('h3', null, 'On the map'), onMap, h('h3', null, 'Not on the map'), waiting))));

  let L; let cfg;
  try { [L, cfg] = await Promise.all([loadLeaflet(), get('/park/map')]); keepList('park.map', [cfg]); } catch (err) {
    const kept = keptList('park.map');
    if (!kept || !globalThis.L) { box.prepend(errorBox(err)); return; }
    [L, cfg] = [globalThis.L, kept[0]];
  }
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
  const isToday = () => date === cfg.today;

  const icon = (p) => {
    const k = kindInfo(list, p.kind);
    const el = h('span', { class: `park-pin st-${p.feature_status}${isToday() && !p.inspected_result ? ' uninspected' : ''}${p.roped_off ? ' roped' : ''}` }, GROUP_LETTER[k.group] || '•');
    return L.divIcon({ className: 'park-pin-wrap', html: el, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -18] });
  };

  const inspectedLine = (p) => (waitingFor(p.feature_id).length ? 'Inspection waiting to send' : p.inspected_result ? `Last inspection: ${RESULT_SHORT[p.inspected_result].toLowerCase()}, ${fmtTime(p.inspected_at)}` : isToday() ? 'Not inspected yet today' : '');
  function popup(p) {
    const k = kindInfo(list, p.kind);
    const body = h('div', { class: 'map-pop park-pop' },
      h('b', null, p.name), h('div', { class: 'muted small' }, `${k.label}, size ${sizeWord(p.size)}${p.dimensions ? `, ${p.dimensions}` : ''}`),
      h('div', null, statusChip(p.feature_status), p.roped_off ? state('Roped off', 'warn') : null, p.needs_post_incident ? state('Post-incident inspection needed', 'bad') : null),
      p.area ? h('div', null, `Area: ${p.area} (${p.area_level_label})`) : null, p.over_rating ? h('div', { class: 'warn-note small' }, `Larger than the area's rating: ${p.size_override}`) : null,
      p.late ? h('div', { class: 'muted small' }, `Late entry: ${p.late_reason}`) : null, p.note ? h('div', null, p.note) : null,
      p.placed_how ? h('div', { class: 'muted small' }, PLACED[p.placed_how](p)) : null,
      h('div', { class: 'muted small' }, inspectedLine(p)));
    if (canEdit) {
      const row = h('div', { class: 'row' }, isToday() ? button('Inspect', () => inspectDialog(p, list, refresh), { small: true }) : null);
      if (data.editable || data.correctable) row.append(button('Details', () => detailsDialog(p), { small: true }), button(data.editable ? 'Remove' : 'Remove (correction)', () => removeFromMap(p), { small: true }));
      if (isToday()) row.append(button(p.roped_off ? 'Take the rope down' : 'Rope off', () => ropeDialog(p), { small: true }));
      body.append(row);
    }
    return body;
  }

  async function putPlacement(featureId, lat, lng, extra = {}, f = null) {
    const area = extra.area_id ? areas.find((a) => a.id === extra.area_id) : null;
    const feat = f || data.placed.find((p) => p.feature_id === featureId) || data.unplaced.find((x) => x.id === featureId);
    const body = { lat: round6(lat), lng: round6(lng), ...extra };
    const past = !data.editable;
    if (past && !body.reason) body.reason = await askReason('Correct a past day', 'This day is over. Say why it is being changed; the original stays in the record.');
    if (area && feat && overRating(feat.size, area.level) && !body.size_override) {
      const p = data.placed.find((x) => x.feature_id === featureId);
      if (!(p && p.area_id === area.id && p.size_override)) body.size_override = await askReason('Larger than the area\'s rating', `${feat.name} is ${sizeWord(feat.size)}, and ${area.name} is rated ${levelWord(area.level)}. Say why it goes there anyway.`);
    }
    return send('PUT', `/park/placements/${date}/${featureId}`, body, { caseId: PARK_QUEUE, label: `Pin for ${feat ? feat.name : 'a feature'}` });
  }

  function drawMarkers(fit) {
    for (const m of markers.values()) m.remove();
    markers.clear();
    for (const p of data.placed) {
      const m = L.marker([p.lat, p.lng], { icon: icon(p), title: p.name, draggable: canEdit && data.editable, keyboard: true }).addTo(map);
      m.bindPopup(() => popup(p));
      m.on('dragend', async () => {
        const at = m.getLatLng();
        try { const r = await putPlacement(p.feature_id, at.lat, at.lng, { area_id: p.area_id, note: p.note, how: 'drag' }); toast(sentWord(r, `${p.name} moved`)); } catch (err) { fail(err); }
        await refresh();
      });
      markers.set(p.feature_id, m);
    }
    if (fit && data.placed.length) fitMap(map, L.latLngBounds(data.placed.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 18 });
  }

  /** One feature on the day's list: a big All checks OK button for a fast pass, and the full inspection. */
  function placedRow(p) {
    const k = kindInfo(list, p.kind);
    const queued = waitingFor(p.feature_id);
    const show = () => { const m = markers.get(p.feature_id); if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 18)); m.openPopup(); } };
    const canInspect = canEdit && isToday() && p.feature_status !== 'retired';
    return h('li', { class: `park-item st-${p.feature_status}`, 'data-feature': p.feature_id },
      h('button', { type: 'button', class: 'park-row', onclick: show },
        h('b', null, p.name), h('span', { class: 'muted small' }, ` ${k.label}, ${sizeWord(p.size)}${p.area ? `, ${p.area}` : ''}`), ' ', statusChip(p.feature_status),
        p.roped_off ? state('Roped off', 'warn') : null, p.needs_post_incident ? state('Post-incident', 'bad') : null,
        h('span', { class: 'muted small park-when' }, queued.length ? (queued.some((x) => x.error) ? 'Not saved' : 'Waiting to send') : inspectedLine(p))),
      canInspect ? h('div', { class: 'park-actions' },
        button(['closed', 'needs_attention'].includes(p.feature_status) ? 'Reopen: all checks OK' : 'All checks OK', () => inspectDialog(p, list, refresh, { quick: true }), { kind: 'primary big', label: `All checks OK: ${p.name}` }),
        button('Inspect', () => inspectDialog(p, list, refresh), { kind: 'big', label: `Inspect ${p.name}` })) : null);
  }

  function drawLists() {
    const nearest = canEdit && isToday() && data.placed.length && navigator.geolocation ? h('div', { class: 'row' }, button('Nearest feature', nearestFeature, { kind: 'big' }), h('span', { class: 'muted small' }, 'Opens the inspection for the feature closest to where you stand.')) : null;
    appendAll(clear(onMap), nearest, data.placed.length ? h('ul', { class: 'park-items' }, data.placed.map(placedRow)) : h('p', { class: 'muted small' }, 'Nothing is on the map for this day yet.'),
      data.placed.length > 0 && canEdit && data.editable ? h('p', { class: 'muted small' }, 'Drag a pin to fine-tune where it is.') : null);
    const todo = (f) => h('li', null, h('span', { class: 'park-row' }, h('b', null, f.name), ' ', statusChip(f.status), h('span', { class: 'muted small' }, ` ${kindInfo(list, f.kind).label}, ${sizeWord(f.size)}`),
      canEdit && (data.editable || data.correctable) ? button(data.editable ? 'Place' : 'Place (late entry)', () => startPlacing(f), { small: true }) : null));
    appendAll(clear(waiting), data.unplaced.length > 0 && canEdit && data.editable && navigator.geolocation && !walking
      ? h('div', { class: 'row' }, button('Walk the park', startWalk, { kind: 'primary', small: true }), h('span', { class: 'muted small' }, 'Go feature to feature and drop each pin where you stand.')) : null,
    data.unplaced.length ? h('ul', null, data.unplaced.map(todo)) : h('p', { class: 'muted small' }, 'Every feature is on the map.'));
    const missing = isToday() ? data.placed.filter((p) => !p.inspected_result).length : 0;
    summary.textContent = `${data.placed.length} on the map, ${data.unplaced.length} not placed${missing ? `, ${missing} not inspected yet` : ''}.${!data.editable ? ` This day is over, so it is a record.${data.correctable ? ' Changes are kept as corrections, with your reason.' : ' A manager can correct it.'}` : ''}`;
  }

  /** Today's areas: opened with a sign-off or not, with Open, Close and the day record. */
  function drawAreaStrip() {
    const live = areas.filter((a) => a.active);
    clear(areaStrip);
    if (!live.length) return;
    areaStrip.append(h('ul', { class: 'park-area-list' }, live.map((a) => {
      const today = isToday() ? AREA_TODAY[a.today_status] : null;
      return h('li', { class: 'park-area', 'data-area': a.id },
        h('span', null, h('b', null, a.name), h('span', { class: 'muted small' }, a.level === 'beginner' ? ` ${a.level_label}` : ` rated ${a.level_label}`), ' ', today ? state(...today) : null,
          isToday() && a.today ? h('span', { class: 'muted small' }, a.today.action === 'open' ? ` Signed off by ${a.today.supervisor_name}, ${fmtTime(a.today.at)}` : ` ${label(a.today.reason_kind)}, ${fmtTime(a.today.at)}`) : null),
        h('span', { class: 'row tight' },
          canEdit && isToday() && a.today_status !== 'open' ? button('Open the area', () => signOffDialog(a, data, refresh), { kind: 'primary', small: true }) : null,
          canEdit && isToday() && a.today_status === 'open' ? button('Close the area', () => closeAreaDialog(a, refresh), { small: true, kind: 'quiet-danger' }) : null,
          h('a', { class: 'btn small', href: `#/park/record/${a.id}/${date}` }, 'Day record')));
    })));
  }

  // ---- Nearest feature: one GPS fix, then the inspection for the closest placed feature.
  function nearestFeature() {
    toast('Finding your location…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const near = data.placed.map((p) => ({ p, d: distM(here, p) })).sort((a, b) => a.d - b.d)[0];
      if (!near) return;
      inspectDialog(near.p, list, refresh, { note: `Nearest to you: about ${ft(near.d)} away (GPS within ${ft(pos.coords.accuracy || 0)}).` });
    }, () => toast('No GPS fix. Step into the open, or pick the feature from the list.', 'warn'), { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
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
    try { const r = await putPlacement(f.id, lat, lng, extra, f); toast(sentWord(r, `${f.name} is on the map${extra.how === 'gps' ? ` (within ${ft(extra.accuracy_m)})` : ''}`)); } catch (err) { fail(err); }
    await refresh();
    const m = markers.get(f.id);
    if (m) m.openPopup();
  }
  /** Waits for a fix within GOOD_M and drops the pin itself; after WAIT_MS the crew can drop on what there is, or tap the map. */
  function useMyLocation() {
    const f = placing;
    gpsLine = h('span', { class: 'gps-line' }, quality(null));
    const now = button('Drop here now', () => { if (fix) dropAt(fix.lat, fix.lng, { how: 'gps', accuracy_m: Math.round(fix.acc) }); }, { kind: 'big' });
    now.disabled = true;
    appendAll(clear(banner), h('b', null, `Putting down ${f.name}. `), gpsLine, ' ', now, button('Cancel', stopPlacing, { kind: 'big' }));
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
      try { const r = await putPlacement(f.id, at.lat, at.lng, { how: 'gps', accuracy_m: Math.round(at.acc) }, f); walking.done += 1; toast(sentWord(r, `${f.name} placed, within ${ft(at.acc)}`)); } catch (err) { fail(err); }
      await refresh();
      drawWalk();
    }, { kind: 'primary big' });
    drop.disabled = !fix;
    appendAll(clear(banner), h('div', { class: 'stack' },
      h('div', null, h('b', null, `Walking the park: next is ${f.name}`), h('span', { class: 'muted' }, ` (${left} to go). Stand at it, then press Drop here.`)),
      gpsLine,
      h('div', { class: 'row' }, drop, button('Skip', () => { walking.skipped.add(f.id); drawWalk(); }, { kind: 'big' }), button('Stop', () => stopWalk(), { kind: 'big' }))));
    banner.hidden = false;
  }
  removeWhenGone(mapEl, { remove: stopGps });

  map.on('click', (e) => { if (placing) dropAt(e.latlng.lat, e.latlng.lng, { how: 'map' }); });

  async function removeFromMap(p) {
    if (data.editable) {
      confirmDialog('Take it off the map?', `${p.name} stays in your list of features.`, 'Take off', async () => { await send('DELETE', `/park/placements/${date}/${p.feature_id}`, {}, { caseId: PARK_QUEUE, label: `Take ${p.name} off the map` }); map.closePopup(); toast('Taken off the map'); await refresh(); });
      return;
    }
    let reason; try { reason = await askReason('Remove from a past day', `${p.name} stays in this day's record, struck through, with your reason.`); } catch (err) { fail(err); return; }
    try { await send('DELETE', `/park/placements/${date}/${p.feature_id}?reason=${encodeURIComponent(reason)}`, { reason }, { caseId: PARK_QUEUE, label: `Correction: take ${p.name} off ${fmtDate(date)}` }); map.closePopup(); toast('Corrected. The original stays in the record.'); } catch (err) { fail(err); }
    await refresh();
  }

  function detailsDialog(p) {
    const areaSel = select([['', 'No area'], ...areas.filter((a) => a.active).map((a) => [a.id, `${a.name} (${a.level_label})`])], p.area_id || '', { name: 'area_id' });
    const past = !data.editable;
    formDialog(p.name, h('div', { class: 'form' }, field('Area', areaSel), h('div', { class: 'wide' }, field('Note for the crew', input({ name: 'note', value: p.note || '', maxlength: 255, placeholder: 'For example: set 10 ft below the lip' }))),
      past ? h('div', { class: 'wide' }, field('Why this past day is being corrected', input({ name: 'reason', required: true, minlength: 3, maxlength: 255 }), 'The values before the correction stay in the record.')) : null),
    async (fd) => { const r = await putPlacement(p.feature_id, p.lat, p.lng, { area_id: num(fd, 'area_id'), note: val(fd, 'note'), ...(past ? { reason: val(fd, 'reason') } : {}) }); toast(sentWord(r, 'Saved')); map.closePopup(); await refresh(); });
  }

  function ropeDialog(p) {
    if (p.roped_off) {
      confirmDialog('Take the rope down?', `${p.name} counts again when its area opens: it needs an inspection today.`, 'Take it down', async () => {
        const r = await send('PUT', `/park/placements/${date}/${p.feature_id}/rope`, { roped_off: false, at: nowStamp() }, { caseId: PARK_QUEUE, label: `Rope down at ${p.name}` });
        toast(sentWord(r, 'Rope down')); map.closePopup(); await refresh();
      });
      return;
    }
    formDialog(`Rope off ${p.name}`, h('div', { class: 'form' }, h('div', { class: 'wide' }, field('Why', input({ name: 'note', required: true, maxlength: 255, placeholder: 'For example: being rebuilt, landing too hard' }), 'A roped-off feature does not stop its area opening.'))),
      async (fd) => {
        const r = await send('PUT', `/park/placements/${date}/${p.feature_id}/rope`, { roped_off: true, note: val(fd, 'note'), at: nowStamp() }, { caseId: PARK_QUEUE, label: `Rope off ${p.name}` });
        toast(sentWord(r, 'Roped off')); map.closePopup(); await refresh();
      }, { submitText: 'Rope off' });
  }

  async function copyDay() {
    if (!copySel.value) { toast('Pick the day to copy from.', 'error'); return; }
    try {
      const body = { from: copySel.value };
      if (!data.editable) body.reason = await askReason('Copy onto a past day', 'This day is over. Each copied feature is marked a late entry with your reason.');
      const r = await post(`/park/placements/${date}/copy`, body);
      toast(r.copied ? `${r.copied} feature${r.copied === 1 ? '' : 's'} copied. Each needs its inspection today.` : 'Nothing new to copy. Those features are already placed.');
    } catch (err) { fail(err); }
    await refresh(true);
  }

  async function refresh(fit = false) {
    try {
      data = await get(`/park/placements/${date}`);
      areas = (await get('/park/areas')).data;
      if (date === cfg.today) keepList(`park.day.${date}`, [{ data, areas }]);
      const days = (await get('/park/days')).data.filter((d) => String(d.on_date).slice(0, 10) !== date);
      clear(copySel).append(...[['', 'Copy from…'], ...days.map((d) => [String(d.on_date).slice(0, 10), `${fmtDate(String(d.on_date).slice(0, 10))} (${d.features})`])].map(([v, t]) => h('option', { value: v }, t)));
    } catch (err) {
      const kept = keptList(`park.day.${date}`);
      if (!kept) { summary.textContent = err.message; return; }
      ({ data, areas } = kept[0]);
      toast('No signal: showing the layout last loaded on this phone', 'warn');
    }
    heading.textContent = fmtDateLong(date);
    drawMarkers(fit);
    drawLists();
    drawAreaStrip();
  }
  async function go(d) { if (!d) return; if (walking) stopWalk(); date = d; dateInput.value = d; stopPlacing(); await refresh(true); }
  dateInput.addEventListener('change', () => go(dateInput.value));
  const offOutbox = onOutbox(() => { if (data.placed.length) drawLists(); });
  removeWhenGone(mapEl, { remove: offOutbox });
  await refresh(true);
  // Today's Inspections button (#/park?tab=layout&go=inspect): straight to the list of features to inspect.
  // The page is put on screen after it is drawn, so wait for that (up to 3 seconds).
  if (new URLSearchParams(location.hash.split('?')[1] || '').get('go') === 'inspect') {
    let tries = 0;
    const show = () => {
      const head = onMap.previousElementSibling;
      if (head && head.isConnected && head.scrollIntoView) { head.style.scrollMarginTop = '84px'; head.scrollIntoView({ block: 'start' }); } else if ((tries += 1) < 30) setTimeout(show, 100);
    };
    show();
  }
}

/** Asks for a short reason. Resolves with it, or rejects (quietly) when the dialog is closed. */
function askReason(title, why) {
  return new Promise((resolve, reject) => {
    let done = false;
    formDialog(title, h('div', { class: 'form' }, h('p', { class: 'wide' }, why), h('div', { class: 'wide' }, field('Reason', input({ name: 'reason', required: true, minlength: 3, maxlength: 255 })))),
      async (fd) => { done = true; resolve(val(fd, 'reason')); }, { submitText: 'Continue', onClose: () => { if (!done) reject(new Error('Not saved: no reason given')); } });
  });
}

// ---------------------------------------------------------------- inspections
/** Pass, fail or not applicable, as three big buttons (gloves). */
function threeWay(item, value, onChange) {
  const opts = [['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A']];
  const btns = opts.map(([v, t]) => {
    const b = h('button', { type: 'button', class: `seg seg-${v}`, 'aria-pressed': String(value === v), 'data-value': v }, t);
    b.addEventListener('click', () => { for (const x of btns) x.setAttribute('aria-pressed', String(x === b)); onChange(v); });
    return b;
  });
  return h('div', { class: 'segs', role: 'group', 'aria-label': item.label }, btns);
}

/**
 * The inspection: the inspection type, the feature type's checklist (each item pass, fail or N/A; a fail needs a note),
 * the result, and photos. A pass on a closed or needs-attention feature reopens it: what was fixed, and a photo. Quick
 * mode (All checks OK) opens with every item ticked Pass, and still saves each item.
 */
function inspectDialog(f, list, again, { quick = false, note } = {}) {
  const fid = f.feature_id || f.id;
  const status = f.feature_status || f.status;
  const k = kindInfo(list, f.kind);
  const items = k.checks || [];
  const ans = new Map(items.map((i) => [i.key, { result: quick ? 'pass' : null, note: '' }]));
  const hour = Number(nowStamp().slice(11, 13));
  const postIncident = Boolean(f.needs_post_incident);
  const kind = select(KIND, postIncident ? 'post_incident' : hour < 11 ? 'morning' : 'midday', { name: 'kind', class: 'big-select' });
  const result = select(Object.entries(RESULT), quick ? 'ok' : 'ok', { name: 'result', class: 'big-select' });
  const notes = input({ name: 'notes', maxlength: 255, placeholder: 'Required if something is wrong' });
  const fixed = input({ name: 'fixed', maxlength: 255, placeholder: 'For example: tightened the end cap bolts, reshaped the lip' });
  const noPhoto = input({ name: 'no_photo_reason', maxlength: 255, placeholder: 'For example: camera not working' });
  const fixedField = field('What was fixed', fixed, 'Needed to reopen a feature that was closed or needed attention.');
  const noPhotoField = field('No photo? Say why', noPhoto);
  const photoIds = [];
  const photoList = h('ul', { class: 'plain park-photos' });
  const fileIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, class: 'sr-file', 'aria-label': 'Add a photo' });
  const photoBtn = button('Take or add a photo', () => fileIn.click(), { kind: 'big' });
  const photoNote = h('p', { class: 'muted small' });
  fileIn.addEventListener('change', async () => {
    for (const file of [...fileIn.files]) {
      if (navigator.onLine === false) { toast('Photos need a signal. Try again when you have one.', 'warn'); break; }
      try {
        const q = new URLSearchParams({ client_ref: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, taken_at: nowStamp().slice(0, 16), file_name: file.name.slice(0, 200) });
        const r = await sendBytes('POST', `/park/features/${fid}/photos?${q}`, file);
        photoIds.push(r.id);
        photoList.append(h('li', null, state(`Photo ${photoIds.length} saved`, 'good'), h('span', { class: 'muted small' }, ` ${file.name}`)));
      } catch (err) { fail(err); }
    }
    fileIn.value = '';
    sync();
  });
  const rows = items.map((i) => {
    const a = ans.get(i.key);
    const noteIn = input({ maxlength: 255, placeholder: `What is wrong with the ${i.label.toLowerCase()}?`, 'aria-label': `Note: ${i.label}`, 'data-note': i.key });
    noteIn.hidden = a.result !== 'fail';
    noteIn.addEventListener('input', () => { a.note = noteIn.value.trim(); });
    const row = h('li', { class: 'park-check', 'data-item': i.key }, h('span', { class: 'park-check-label' }, i.label), threeWay(i, a.result, (v) => { a.result = v; noteIn.hidden = v !== 'fail'; if (v === 'fail' && result.value === 'ok') result.value = 'needs_attention'; sync(); }), noteIn);
    return row;
  });
  function sync() {
    const reopen = result.value === 'ok' && ['closed', 'needs_attention'].includes(status);
    fixedField.hidden = !reopen;
    noPhotoField.hidden = result.value !== 'closed' || photoIds.length > 0;
    photoNote.textContent = reopen ? 'A photo is needed to reopen it.' : result.value === 'closed' ? 'A photo is needed to close it (or say why there is none).' : 'Photos are optional on a pass.';
  }
  result.addEventListener('change', sync);
  const head = [
    note ? h('p', { class: 'wide park-nearest' }, note) : null,
    postIncident ? h('p', { class: 'wide warn-note' }, 'Closed after an incident: it reopens only through a post-incident inspection.') : null,
    h('p', { class: 'wide muted small' }, `${k.label}, size ${sizeWord(f.size)}. Now: ${(STATUS[status] || [status])[0]}.`),
  ];
  const d = formDialog(`${quick ? 'All checks OK' : 'Inspect'}: ${f.name}`, h('div', { class: 'form park-inspect' }, ...head,
    field('Inspection', kind), field('Result', result),
    h('div', { class: 'wide' }, h('h3', null, 'Checklist'), h('ul', { class: 'plain park-checks' }, rows)),
    h('div', { class: 'wide' }, field('Notes', notes)), h('div', { class: 'wide' }, fixedField),
    h('div', { class: 'wide stack' }, h('div', { class: 'row' }, photoBtn, fileIn), photoNote, photoList, noPhotoField)),
  async () => {
    const checklist = items.map((i) => ({ key: i.key, result: ans.get(i.key).result, note: ans.get(i.key).note || null }));
    const unanswered = items.filter((i) => !ans.get(i.key).result);
    if (unanswered.length) throw new Error(`Answer every item: ${unanswered.map((i) => i.label).join(', ')}`);
    const body = { result: result.value, kind: kind.value, checklist, notes: notes.value.trim() || null, fixed: fixed.value.trim() || null, photo_ids: photoIds, no_photo_reason: noPhoto.value.trim() || null, at: nowStamp() };
    const offline = navigator.onLine === false;
    if (offline && body.result === 'closed' && !photoIds.length && !body.no_photo_reason) body.no_photo_reason = 'No signal: photo to follow';
    if (offline && body.result === 'ok' && ['closed', 'needs_attention'].includes(status)) throw new Error('Reopening needs a photo, and photos need a signal. Keep it closed until you have one.');
    const r = await send('POST', `/park/features/${fid}/inspections`, body, { caseId: PARK_QUEUE, label: `Inspection of ${f.name}` });
    toast(sentWord(r, body.result === 'ok' ? `${f.name}: inspected, no defects found` : `${f.name}: ${RESULT_SHORT[body.result].toLowerCase()}`), r && r.queued ? 'warn' : 'ok');
    await again();
  }, { submitText: quick ? 'Save: all checks OK' : 'Save inspection', wide: true });
  d.box.classList.add('park-dialog');
  sync();
  return d;
}

// ---------------------------------------------------------------- opening and closing an area
async function signOffDialog(a, day, again) {
  let check;
  try { check = await get(`/park/areas/${a.id}/open-check`); } catch (err) { fail(err); return; }
  const ticks = new Map(SIGNOFF.map(([k]) => [k, false]));
  const me = ctx.me ? (ctx.me.name || ctx.me.login_name || ctx.me.email || '') : '';
  const name = input({ name: 'supervisor_name', required: true, maxlength: 100, value: me, autocomplete: 'name' });
  const blocked = check.blocking || [];
  const list = h('ul', { class: 'plain park-checks' }, SIGNOFF.map(([k, text]) => {
    const box = h('input', { type: 'checkbox', 'data-key': k });
    box.addEventListener('change', () => { ticks.set(k, box.checked); });
    return h('li', null, h('label', { class: 'check big-check' }, box, ` ${text}`));
  }));
  const blockBox = blocked.length ? h('div', { class: 'error-box park-blocked', role: 'alert' }, h('b', null, `${a.name} cannot open yet. `), 'Inspect each of these today, or rope it off:',
    h('ul', null, blocked.map((b) => h('li', null, `${b.name}: ${b.why.toLowerCase()}`)))) : h('p', { class: 'ok-note' }, 'Every feature placed here today is inspected and none is closed (or it is roped off).');
  const d = formDialog(`Open ${a.name}`, h('div', { class: 'form' }, h('div', { class: 'wide' }, blockBox), h('div', { class: 'wide' }, h('h3', null, 'Before the rope comes down'), list),
    field('Supervisor', name), h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 255 })))),
  async (fd) => {
    const body = { checklist: Object.fromEntries(ticks), supervisor_name: val(fd, 'supervisor_name'), notes: val(fd, 'notes'), at: nowStamp() };
    const r = await send('POST', `/park/areas/${a.id}/open`, body, { caseId: PARK_QUEUE, label: `Open ${a.name}` });
    toast(sentWord(r, `${a.name} is open`)); await again();
  }, { submitText: blocked.length ? 'Open the area' : 'Sign off and open', wide: true });
  d.box.classList.add('park-dialog');
  // No override: while a feature blocks the area (checked with the server each time this opens), the button stays off.
  if (blocked.length) { const b = d.box.querySelector('button[type=submit]'); b.disabled = true; b.title = 'Inspect or rope off the features listed above first'; }
}

function closeAreaDialog(a, again) {
  formDialog(`Close ${a.name}`, h('div', { class: 'form' },
    h('p', { class: 'wide' }, 'Every feature placed here today is closed, each with its own record. Each one reopens through an inspection.'),
    field('Why', select(CLOSE_REASONS, 'weather', { name: 'reason_kind', class: 'big-select' })), h('div', { class: 'wide' }, field('What is happening', input({ name: 'reason', required: true, minlength: 3, maxlength: 255, placeholder: 'For example: fog, cannot see the landings' })))),
  async (fd) => {
    const r = await send('POST', `/park/areas/${a.id}/close`, { reason_kind: val(fd, 'reason_kind'), reason: val(fd, 'reason'), at: nowStamp() }, { caseId: PARK_QUEUE, label: `Close ${a.name}` });
    toast(sentWord(r, r && r.closed !== undefined ? `${a.name} closed, ${r.closed} feature${r.closed === 1 ? '' : 's'} closed` : `${a.name} closed`)); await again();
  }, { submitText: 'Close the area' });
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
      { head: 'Size', cell: (f) => `${sizeWord(f.size)}${f.dimensions ? `, ${f.dimensions}` : ''}` },
      { head: 'Moves daily', cell: (f) => (f.portable ? 'Yes' : 'No, built') },
      { head: 'Status', cell: (f) => h('span', null, statusChip(f.status), f.needs_post_incident ? state('Post-incident inspection needed', 'bad') : null) },
      { head: 'Last inspection', cell: (f) => (f.last_inspected_at ? h('span', null, fmtDateTime(f.last_inspected_at), h('span', { class: 'muted' }, ` ${RESULT_SHORT[f.last_result] || ''}`), f.last_notes ? h('div', { class: 'muted small' }, f.last_notes) : null) : h('span', { class: 'muted' }, 'Never')) },
      { head: '', actions: true, cell: (f) => h('span', { class: 'row' },
        canEdit && f.status !== 'retired' ? button('Inspect', () => inspectDialog(f, list, again), { small: true }) : null,
        button('History', () => historyDialog(f, list), { small: true, label: `History of ${f.name}` }),
        canEdit ? button('Edit', () => featureDialog(f, list, again), { small: true }) : null,
        can('staff', 'patrol') && f.status !== 'retired' && !f.needs_post_incident ? button('Close for post-incident inspection', () => incidentCloseDialog(f, again), { small: true, kind: 'quiet-danger' }) : null,
        isManager() ? button(f.status === 'retired' ? 'Bring back' : 'Retire', () => retireDialog(f, again), { small: true }) : null) },
    ], rows, { rowClass: (f) => (f.status === 'retired' ? 'muted-row' : null) }) : empty(data.length ? 'No feature matches.' : 'No features yet. Add the rails, boxes and jumps your crew builds with.'));
  };
  q.addEventListener('input', draw);
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'spread' }, q, canEdit ? button('Add a feature', () => featureDialog(null, list, again), { kind: 'primary' }) : null),
    h('p', { class: 'muted small' }, 'A feature opens only through an inspection that finds no defects. Changes to size, type, dimensions and area are kept in its history.'), tableBox));
  draw();
}

function featureDialog(f, list, again) {
  const groups = [...new Set(list.map((k) => k.group_label))];
  const kind = select(groups.flatMap((g) => list.filter((k) => k.group_label === g).map((k) => [k.key, `${g}: ${k.label}`])), f ? f.kind : 'butter_box', { name: 'kind' });
  const portable = input({ type: 'checkbox', name: 'portable', checked: f ? f.portable : true });
  const size = select(SIZES, f ? f.size : 'm', { name: 'size' });
  const dims = input({ name: 'dimensions', maxlength: 60, value: (f && f.dimensions) || '', placeholder: 'For example: 12 ft' });
  const reason = input({ name: 'reason', maxlength: 255, placeholder: 'For example: rebuilt longer after the storm' });
  const reasonField = field('Why it changed', reason, 'Needed when the size or dimensions change. The old values stay in the history.');
  const syncReason = () => { if (!f) { reasonField.hidden = true; return; } const need = size.value !== f.size || dims.value.trim() !== (f.dimensions || ''); reasonField.hidden = !need; reason.required = need; };
  size.addEventListener('change', syncReason); dims.addEventListener('input', syncReason);
  if (!f) kind.addEventListener('change', () => { portable.checked = kindInfo(list, kind.value).portable; });
  formDialog(f ? `Edit ${f.name}` : 'Add a feature', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100, value: f ? f.name : '', placeholder: 'For example: Butter box 2' })),
    field('Type', kind), field('Size', size), field('Length or height', dims),
    h('label', { class: 'check' }, portable, ' The crew moves it from day to day'),
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 500, value: (f && f.notes) || '' }))),
    h('div', { class: 'wide' }, reasonField),
    f ? h('p', { class: 'wide muted small' }, 'Status is not set here: an inspection closes or opens a feature, and a manager retires it.') : h('p', { class: 'wide muted small' }, 'A new feature is not inspected yet. Its first inspection that finds no defects opens it.')),
  async (fd) => {
    const body = { name: val(fd, 'name'), kind: val(fd, 'kind'), size: val(fd, 'size'), dimensions: val(fd, 'dimensions'), portable: portable.checked, notes: val(fd, 'notes') };
    if (f) { if (val(fd, 'reason')) body.reason = val(fd, 'reason'); await patch(`/park/features/${f.id}`, body); } else await post('/park/features', body);
    toast(f ? 'Saved' : 'Feature added');
    await again();
  }, { submitText: f ? 'Save' : 'Add feature' });
  syncReason();
}

function retireDialog(f, again) {
  const back = f.status === 'retired';
  formDialog(back ? `Bring back ${f.name}` : `Retire ${f.name}`, h('div', { class: 'form' }, h('p', { class: 'wide' }, back ? 'It comes back as not inspected yet: its first inspection opens it.' : 'It leaves the daily map. Its history stays.'),
    h('div', { class: 'wide' }, field('Reason', input({ name: 'reason', required: true, minlength: 3, maxlength: 255 })))),
  async (fd) => { await post(`/park/features/${f.id}/${back ? 'unretire' : 'retire'}`, { reason: val(fd, 'reason') }); toast(back ? 'Brought back' : 'Retired'); await again(); }, { submitText: back ? 'Bring back' : 'Retire' });
}

function incidentCloseDialog(f, again) {
  formDialog(`Close ${f.name} for a post-incident inspection`, h('div', { class: 'form' },
    h('p', { class: 'wide' }, 'It closes now and the park supervisor is told in the Inbox and on their phone. It reopens only after a post-incident inspection finds no defects.'),
    h('div', { class: 'wide' }, field('Reason', input({ name: 'reason', required: true, minlength: 3, maxlength: 255, placeholder: 'For example: rider hurt on the landing, patrol on scene' }), 'No names or injury details here: those belong in the patrol case.'))),
  async (fd) => { await post(`/park/features/${f.id}/close-for-incident`, { reason: val(fd, 'reason') }); toast(`${f.name} closed. The park supervisor was told.`); await again(); }, { submitText: 'Close it' });
}

const CHANGE_FIELD = { size: 'Size', kind: 'Type', dimensions: 'Dimensions', name: 'Name', portable: 'Moves daily', status: 'Status', area: 'Area', roped: 'Rope line', rating: 'Rating' };
const changeValue = (field, v) => (v === null || v === undefined || v === '' ? 'none' : field === 'size' ? sizeWord(v) : field === 'rating' ? levelWord(v) : field === 'status' ? (STATUS[v] || [label(v)])[0] : field === 'portable' ? (Number(v) ? 'yes' : 'no') : v);
const SOURCE = { edit: 'Edited', inspection: 'Inspection', retire: 'Retired or brought back', area_close: 'Area closed', post_incident: 'Closed for a post-incident inspection', roped: 'Rope line', correction: 'Correction' };

async function historyDialog(f, list) {
  let hist; let checks;
  try { [hist, { data: checks }] = await Promise.all([get(`/park/features/${f.id}/history`), get(`/park/features/${f.id}/inspections`)]); } catch (err) { fail(err); return; }
  const again = () => historyDialog(f, list);
  const changeRows = hist.changes.length ? table([
    { head: 'When', cell: (c) => fmtDateTime(c.changed_at) },
    { head: 'What', cell: (c) => CHANGE_FIELD[c.field] || label(c.field) },
    { head: 'Change', cell: (c) => h('span', null, h('s', null, changeValue(c.field, c.before_value)), ' to ', h('b', null, changeValue(c.field, c.after_value))) },
    { head: 'Why', cell: (c) => h('span', null, c.reason || '', h('div', { class: 'muted small' }, SOURCE[c.source] || label(c.source))) },
    { head: 'By', cell: (c) => c.changed_by || 'A login since removed' },
  ], hist.changes) : empty('No changes yet.');
  const placeRows = hist.data.length ? table([
    { head: 'Day', cell: (p) => (p.voided_at ? h('s', null, fmtDate(String(p.on_date).slice(0, 10))) : fmtDate(String(p.on_date).slice(0, 10))) },
    { head: 'Area', cell: (p) => p.area || '' },
    { head: 'Note', cell: (p) => h('span', null, p.note || '', p.late ? h('div', { class: 'warn-note small' }, `Late entry: ${p.late_reason}`) : null, p.voided_at ? h('div', { class: 'muted small' }, `Removed by correction: ${p.void_reason}`) : null, p.roped_off ? h('div', { class: 'muted small' }, 'Roped off') : null) },
  ], hist.data) : empty('It has not been placed yet.');
  const corrRows = hist.corrections.length ? h('ul', { class: 'plain park-corrections' }, hist.corrections.map((c) => h('li', null,
    h('b', null, `${fmtDate(String(c.on_date).slice(0, 10))}: `), c.action === 'remove' ? 'taken off the day' : c.action === 'restore' ? 'put back on the day' : 'placement corrected',
    c.before ? h('span', null, ' (was ', h('s', null, `${c.before.lat.toFixed ? c.before.lat.toFixed(5) : c.before.lat}, ${c.before.lng.toFixed ? c.before.lng.toFixed(5) : c.before.lng}${c.before.note ? `, ${c.before.note}` : ''}`), ')') : null,
    h('div', { class: 'muted small' }, `${c.corrected_by || ''}, ${fmtDateTime(c.corrected_at)}. Why: ${c.reason}`)))) : null;
  const correct = (c) => (isManager() && !c.voided_at ? button('Correct', () => correctDialog(c, again), { small: true }) : null);
  const checkRows = checks.length ? table([
    { head: 'When', cell: (c) => h('span', null, c.voided_at ? h('s', null, fmtDateTime(c.inspected_at)) : fmtDateTime(c.inspected_at), c.received_at && c.received_at.slice(0, 16) !== String(c.inspected_at).slice(0, 16) ? h('div', { class: 'muted small' }, `Sent ${fmtTime(c.received_at)}`) : null) },
    { head: 'Inspection', cell: (c) => (c.voided_at ? h('s', null, c.kind_label || '') : c.kind_label || '') },
    { head: 'Result', cell: (c) => h('span', null, c.voided_at ? h('s', null, RESULT[c.result]) : RESULT[c.result], c.reopened ? h('div', { class: 'muted small' }, `Reopened. Fixed: ${c.fixed}`) : null, c.corrects_id ? h('div', { class: 'muted small' }, 'Correction of an earlier entry') : null) },
    { head: 'Checklist', cell: (c) => (c.checklist ? h('span', { class: 'small' }, c.checklist.filter((x) => x.result === 'fail').map((x) => `${x.label}: ${x.note}`).join('; ') || `${c.checklist.length} items, none failed`) : h('span', { class: 'muted small' }, 'No checklist')) },
    { head: 'By', cell: (c) => c.inspected_by || 'A login since removed' },
    { head: 'Notes', cell: (c) => h('span', null, c.notes || '', c.photos ? h('div', { class: 'muted small' }, `${c.photos} photo${c.photos === 1 ? '' : 's'}`) : null, c.voided_at ? h('div', { class: 'muted small' }, `Entered in error (${c.voided_by}, ${fmtDateTime(c.voided_at)}): ${c.void_reason}`) : null) },
    { head: '', actions: true, cell: correct },
  ], checks) : empty('No inspections yet.');
  dialog(f.name, h('div', { class: 'stack park-history' },
    h('h3', null, 'Changes'), changeRows,
    h('h3', null, 'Inspections'), checkRows,
    h('h3', null, 'Where it has been'), placeRows,
    corrRows ? h('h3', null, 'Corrections to past days') : null, corrRows,
    hist.incidents ? h('h3', null, 'Patrol cases') : null,
    hist.incidents ? (hist.incidents.length ? h('ul', { class: 'plain' }, hist.incidents.map((i) => h('li', null, h('b', null, i.case_number), `, ${fmtDate(i.date)}`))) : empty('No patrol case names this feature.')) : null), { wide: true });
}

function correctDialog(c, again) {
  const keep = input({ type: 'checkbox', name: 'replace' });
  const result = select(Object.entries(RESULT), c.result, { name: 'result' });
  const repl = h('div', { class: 'wide form', hidden: true }, field('Corrected result', result), h('div', { class: 'wide' }, field('Corrected notes', input({ name: 'notes', maxlength: 255, value: c.notes || '' }))));
  keep.addEventListener('change', () => { repl.hidden = !keep.checked; });
  formDialog('Correct an inspection', h('div', { class: 'form' },
    h('p', { class: 'wide' }, `${fmtDateTime(c.inspected_at)}, ${RESULT[c.result]}, by ${c.inspected_by || 'unknown'}. It stays in the record, struck through, with your name and reason. A correction never opens or closes the feature: only a new inspection does.`),
    h('div', { class: 'wide' }, field('Why', input({ name: 'reason', required: true, minlength: 3, maxlength: 255 }))),
    h('label', { class: 'check wide' }, keep, ' Add the corrected entry'), repl),
  async (fd) => {
    const body = { reason: val(fd, 'reason') };
    if (keep.checked) body.replacement = { result: val(fd, 'result'), notes: val(fd, 'notes') };
    await post(`/park/inspections/${c.id}/correct`, body); toast('Corrected'); again();
  }, { submitText: 'Save the correction' });
}

// ---------------------------------------------------------------- areas
async function drawAreas(box) {
  const canEdit = can('staff');
  const again = async () => { const n = h('div'); await drawAreas(n); clear(box).append(...n.childNodes); };
  const { data } = await get('/park/areas');
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'An area is a park or zone, rated S, M, L or XL like its size signs, or a beginner or progression zone. It opens each day with its supervisor\'s sign-off on the Daily map.'), canEdit ? button('Add an area', () => areaDialog(null, again), { kind: 'primary' }) : null),
    data.length ? table([
      { head: 'Area', cell: (a) => h('b', null, a.name) }, { head: 'Rating', cell: (a) => a.level_label || levelWord(a.level) },
      { head: 'Today', cell: (a) => (a.active ? state(...AREA_TODAY[a.today_status]) : state('Not used', 'neutral')) }, { head: 'Notes', cell: (a) => a.notes || '' },
      { head: '', actions: true, cell: (a) => h('span', { class: 'row' }, button('History', () => areaHistory(a), { small: true }), h('a', { class: 'btn small', href: `#/park/record/${a.id}/${todayStr()}` }, 'Day record'), canEdit ? button('Edit', () => areaDialog(a, again), { small: true }) : null) },
    ], data) : empty('No areas yet. Add your main park, a progression zone or a pipe zone.')));
}
function areaDialog(a, again) {
  const active = input({ type: 'checkbox', name: 'active', checked: a ? Boolean(a.active) : true });
  const level = select(LEVELS, a ? a.level : 's', { name: 'level' });
  const reason = input({ name: 'reason', maxlength: 255 });
  const reasonField = field('Why the rating changed', reason, 'The old rating stays in the history.');
  const sync = () => { const need = Boolean(a) && level.value !== a.level; reasonField.hidden = !need; reason.required = need; };
  level.addEventListener('change', sync);
  formDialog(a ? `Edit ${a.name}` : 'Add an area', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100, value: a ? a.name : '' })), field('Rating', level),
    a ? h('label', { class: 'check' }, active, ' In use') : null, h('div', { class: 'wide' }, reasonField),
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 255, value: (a && a.notes) || '' }))),
    h('p', { class: 'wide muted small' }, 'An area opens with the opening sign-off and closes with Close the area, both on the Daily map.')),
  async (fd) => {
    const body = { name: val(fd, 'name'), level: val(fd, 'level'), notes: val(fd, 'notes') };
    if (a) { body.active = active.checked; if (val(fd, 'reason')) body.reason = val(fd, 'reason'); await patch(`/park/areas/${a.id}`, body); } else await post('/park/areas', body);
    toast('Saved');
    await again();
  });
  sync();
}
async function areaHistory(a) {
  let d; try { d = await get(`/park/areas/${a.id}/history`); } catch (err) { fail(err); return; }
  dialog(a.name, h('div', { class: 'stack' },
    h('h3', null, 'Rating and name changes'), d.changes.length ? table([{ head: 'When', cell: (c) => fmtDateTime(c.changed_at) }, { head: 'Change', cell: (c) => h('span', null, h('s', null, changeValue(c.field, c.before_value)), ' to ', h('b', null, changeValue(c.field, c.after_value))) }, { head: 'Why', cell: (c) => c.reason || '' }, { head: 'By', cell: (c) => c.changed_by || '' }], d.changes) : empty('No changes yet.'),
    h('h3', null, 'Openings and closures'), d.days.length ? table([{ head: 'When', cell: (x) => fmtDateTime(x.at) }, { head: 'What', cell: (x) => (x.action === 'open' ? `Opened, signed off by ${x.supervisor_name}` : `Closed (${label(x.reason_kind)}): ${x.reason}, ${x.features_closed} closed`) }, { head: 'By', cell: (x) => x.signed_by || '' }], d.days) : empty('Not opened yet.')), { wide: true });
}

// ---------------------------------------------------------------- the printable day record
/** A plain plot of the day's pins (no map tiles, so it prints and works with no signal). */
function layoutSvg(features) {
  const pts = features.filter((f) => !f.voided_at);
  const W = 640; const H = 300; const pad = 30;
  const svg = (tag, attrs, ...kids) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); for (const c of kids) el.append(c); return el; };
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'park-plot', role: 'img', 'aria-label': 'Layout of the features that day' });
  root.append(svg('rect', { x: 0, y: 0, width: W, height: H, fill: '#fff', stroke: '#999' }));
  if (!pts.length) return root;
  const lats = pts.map((p) => p.lat); const lngs = pts.map((p) => p.lng);
  const [a, b, c, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  const sx = (x) => pad + ((x - c) / ((d - c) || 1e-6)) * (W - 2 * pad);
  const sy = (y) => H - pad - ((y - a) / ((b - a) || 1e-6)) * (H - 2 * pad);
  pts.forEach((p, i) => {
    const x = pts.length === 1 ? W / 2 : sx(p.lng); const y = pts.length === 1 ? H / 2 : sy(p.lat);
    root.append(svg('circle', { cx: x, cy: y, r: 11, fill: p.status === 'closed' ? '#b3201a' : p.status === 'needs_attention' ? '#b87400' : '#2f7d4f', stroke: '#000' }));
    const t = svg('text', { x, y: y + 4, 'text-anchor': 'middle', 'font-size': 11, fill: '#fff', 'font-weight': 700 }); t.textContent = String(i + 1); root.append(t);
    const right = x > W * 0.7; const n = svg('text', { x: right ? x - 14 : x + 14, y: y + 4, 'font-size': 11, fill: '#111', 'text-anchor': right ? 'end' : 'start' }); n.textContent = p.name; root.append(n);
  });
  return root;
}

async function drawRecord(root, list, areaId, date) {
  let r;
  try { r = await get(`/park/areas/${areaId}/record/${date}`); } catch (err) { root.append(errorBox(err)); return; }
  const byFeature = (id) => r.features.find((f) => Number(f.feature_id) === Number(id));
  const nameOf = (id) => (byFeature(id) || { name: 'Feature' }).name;
  const live = r.features.filter((f) => !f.voided_at);
  const plotted = live.length ? live : r.features;
  root.append(h('div', { class: 'stack park-record' },
    h('div', { class: 'page-head spread' }, h('h1', null, `${r.area.name}: day record`), h('span', { class: 'row no-print' }, h('a', { class: 'btn small', href: '#/park' }, 'Back to the park'), button('Print', () => window.print(), { kind: 'primary', small: true }))),
    h('p', null, h('b', null, `${r.area.name}, ${fmtDateLong(date)}`), ` · Rated ${r.area.level_label} · Times are ${r.timezone}`),
    h('h2', null, 'Opening sign-off and closures'),
    r.days.length ? h('ul', { class: 'plain' }, r.days.map((d) => h('li', null, d.action === 'open'
      ? h('span', null, h('b', null, `Opened ${fmtTime(d.at)}`), `, signed off by ${d.supervisor_name} (login ${d.signed_by || 'unknown'}). Checked: ${(d.checklist || []).map((c) => c.label).join('; ')}.${d.reason ? ` Notes: ${d.reason}` : ''}`)
      : h('span', null, h('b', null, `Closed ${fmtTime(d.at)}`), ` (${label(d.reason_kind)}): ${d.reason}. ${d.features_closed} feature${d.features_closed === 1 ? '' : 's'} closed, by ${d.signed_by || 'unknown'}.`)))) : h('p', { class: 'warn-note' }, 'No opening sign-off recorded for this day.'),
    h('h2', null, 'Layout'), layoutSvg(plotted),
    h('h2', null, 'Features'),
    r.features.length ? table([
      { head: '#', cell: (f) => String(plotted.indexOf(f) + 1 || '') },
      { head: 'Feature', cell: (f) => (f.voided_at ? h('s', null, f.name) : h('b', null, f.name)) },
      { head: 'Type and size', cell: (f) => `${f.kind_label}, ${f.size_label}${f.dimensions ? `, ${f.dimensions}` : ''}` },
      { head: 'Status now', cell: (f) => (STATUS[f.status] || [f.status])[0] },
      { head: 'Notes', cell: (f) => h('span', { class: 'small' }, [f.roped_off ? `Roped off: ${f.roped_note || ''}` : '', f.over_rating ? `Larger than the area's rating: ${f.size_override || ''}` : '', f.late ? `Late entry: ${f.late_reason}` : '', f.voided_at ? `Removed by correction: ${f.void_reason}` : ''].filter(Boolean).join('. ')) },
    ], r.features) : empty('No features were placed in this area that day.'),
    h('h2', null, 'Status changes'),
    r.changes.filter((c) => c.field === 'status' || c.field === 'roped' || c.field === 'area').length ? table([
      { head: 'Time', cell: (c) => fmtTime(c.changed_at) }, { head: 'Feature', cell: (c) => nameOf(c.feature_id) },
      { head: 'Change', cell: (c) => `${changeValue(c.field, c.before_value)} to ${changeValue(c.field, c.after_value)}` }, { head: 'Why', cell: (c) => `${SOURCE[c.source] || c.source}${c.reason ? `: ${c.reason}` : ''}` }, { head: 'By', cell: (c) => c.changed_by || 'A login since removed' },
    ], r.changes.filter((c) => c.field === 'status' || c.field === 'roped' || c.field === 'area')) : empty('No status changes.'),
    h('h2', null, 'Inspections'),
    r.inspections.length ? table([
      { head: 'Time', cell: (i) => (i.voided_at ? h('s', null, fmtTime(i.inspected_at)) : fmtTime(i.inspected_at)) }, { head: 'Feature', cell: (i) => nameOf(i.feature_id) }, { head: 'Inspection', cell: (i) => i.kind_label || '' },
      { head: 'Result', cell: (i) => (i.voided_at ? h('s', null, i.result_label) : i.result_label) }, { head: 'By', cell: (i) => i.inspected_by || 'A login since removed' },
      { head: 'Details', cell: (i) => h('span', { class: 'small' }, [i.checklist ? `${i.checklist.length} items${i.checklist.some((x) => x.result === 'fail') ? `, failed: ${i.checklist.filter((x) => x.result === 'fail').map((x) => `${x.label} (${x.note})`).join('; ')}` : ', none failed'}` : '', i.notes, i.fixed ? `Fixed: ${i.fixed}` : '', i.photos ? `${i.photos} photo${i.photos === 1 ? '' : 's'}` : '', i.voided_at ? `Entered in error by ${i.voided_by}, ${fmtDateTime(i.voided_at)}: ${i.void_reason}` : '', i.corrects_id ? 'Correction of an earlier entry' : ''].filter(Boolean).join('. ')) },
    ], r.inspections) : empty('No inspections that day.'),
    h('h2', null, 'Corrections'),
    r.corrections.length ? h('ul', { class: 'plain' }, r.corrections.map((c) => h('li', null, h('b', null, nameOf(c.feature_id)), `: ${c.action === 'remove' ? 'taken off the day' : c.action === 'restore' ? 'put back' : 'placement changed'} by ${c.corrected_by || 'unknown'}, ${fmtDateTime(c.corrected_at)}. Why: ${c.reason}`))) : h('p', { class: 'muted' }, 'No corrections.'),
    h('p', { class: 'muted small' }, 'This record lists what the crew recorded. It is not a statement that any feature is safe.')));
}
