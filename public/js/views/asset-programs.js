// Programs (muni release 1): one job over many assets or map items, such as "Exercise zone 3 valves", "Spring hydrant
// flushing, north side" or "Screen 25% of outfalls".
//   #/assetprograms        the list: open ones first, with their progress; a manager starts a new one
//   #/assetprograms/<id>   one program on a phone: its targets on a map colored by state, and a list nearest first
//                          (when the phone shares its location). Inspect each one, or skip it with a reason. Failures
//                          list their work orders. A manager closes it when done and copies it for next year.

import { get, post, patch, download } from '../api.js';
import { h, clear, state, button, toast, formDialog, confirmDialog, field, input, select, val, num, table, empty, errorBox, fmtDate, fmtDateTime, isManager, tabs } from '../ui.js';
import { loadLeaflet, makeMap, removeWhenGone, fitMap } from './incident-map.js';
import { inspectDialog } from './asset-bits.js';
import { workOrderSheet } from './asset-page.js';

const STATE = { todo: ['To do', 'neutral'], done: ['Done', 'good'], skipped: ['Skipped', 'neutral'] };
const css = (name, fallback) => (window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
const stateColor = (g) => (g.result === 'fail' ? css('--prog-failed', '#c62828') : g.status === 'done' ? css('--prog-done', '#2e7d32') : g.status === 'skipped' ? css('--prog-skipped', '#8a8f94') : css('--prog-todo', '#1f5fd1'));
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const dist = (a, b) => { const s = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(s))); };
const away = (m) => (m < 160 ? `${Math.round(m * 3.281)} ft` : `${(m / 1609.34).toFixed(m < 16000 ? 1 : 0)} mi`);

export async function render(root, params = []) {
  if (/^\d+$/.test(params[0] || '')) { await renderProgram(root, Number(params[0])); return; }
  await renderList(root);
}

/** Progress as a bar and words: "12 of 40 done, 2 skipped, 1 failed". */
function progress(p) {
  const pr = p.progress;
  const pct = (n) => (pr.total ? `${(n / pr.total) * 100}%` : '0');
  // The server's words (routes/assetprograms.js), the same ones Today shows (2026.11.20).
  const words = pr.words || `${pr.done} of ${pr.total} done${pr.skipped ? `, ${pr.skipped} skipped` : ''}${pr.failed ? `, ${pr.failed} failed` : ''}${pr.todo ? `, ${pr.todo} to do` : ''}`;
  return h('div', { class: 'stack tight' },
    h('div', { class: 'prog-bar', role: 'img', 'aria-label': words },
      h('span', { class: 'done', style: `width:${pct(pr.done - pr.failed)}` }), h('span', { class: 'failed', style: `width:${pct(pr.failed)}` }), h('span', { class: 'skipped', style: `width:${pct(pr.skipped)}` })),
    h('span', { class: 'muted small' }, words));
}

// ---------------------------------------------------------------- the list
async function renderList(root) {
  const show = select([['open', 'Open'], ['closed', 'Closed'], ['all', 'All']], 'open', { 'aria-label': 'Show' });
  const mine = h('input', { type: 'checkbox' });
  const body = h('div');
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Programs'),
    h('p', { class: 'page-note' }, 'One job over many assets or map items: valve exercising, hydrant flushing, outfall screening. The crew works through it on a phone, nearest first.')));
  root.append(head, h('div', { class: 'stack' }, h('div', { class: 'spread' }, h('div', { class: 'row filters' }, show, h('label', { class: 'check' }, mine, ' Led by me')),
    isManager() ? button('New program', () => programDialog(null, (id) => { location.hash = `#/assetprograms/${id}`; }), { kind: 'primary', small: true }) : null), body));
  async function load() {
    clear(body);
    let r;
    try { r = await get(`/assets/programs?status=${show.value}${mine.checked ? '&mine=1' : ''}`); } catch (err) { body.append(errorBox(err)); return; }
    if (!r.data.length) { body.append(empty(show.value === 'open' ? (isManager() ? 'No open programs. Start one: pick a checklist and the valves, hydrants or outfalls it covers.' : 'No open programs right now.') : 'None.')); return; }
    body.append(table([
      { head: 'Program', cell: (p) => h('span', { class: 'stack tight' }, h('a', { href: `#/assetprograms/${p.id}` }, h('strong', null, p.name)), h('span', { class: 'muted small' }, [p.template_name, p.assignee, p.crew].filter(Boolean).join(' · '))) },
      { head: 'Due', cell: (p) => (p.status === 'closed' ? state('Closed', 'neutral') : p.due_on ? (p.overdue ? state(`Was due ${fmtDate(p.due_on)}`, 'bad') : fmtDate(p.due_on)) : '') },
      { head: 'Progress', cell: progress },
    ], r.data));
  }
  show.addEventListener('change', load); mine.addEventListener('change', load);
  await load();
}

// ---------------------------------------------------------------- new program, and changing one
/**
 * A manager names it, picks the checklist, the due date and who leads it, and (new only) what it covers: kinds of map
 * item, optionally only inside a box drawn on the map, and assets from the register.
 */
async function programDialog(p, done) {
  const [meta, mapCfg, staff, reg] = await Promise.all([get('/assets/meta'), p ? null : get('/assets/map'), get('/workforce/staff?status=active').catch(() => ({ data: [] })), p ? null : get('/assets/register')]);
  const templates = meta.templates.filter((t) => t.active || (p && t.id === p.template_id));
  if (!templates.length) { toast('Add a checklist under Assets and fleet, Settings, first', 'error'); return; }
  const tplSel = select(templates.map((t) => [t.id, t.name]), p ? p.template_id : templates[0].id, { name: 'template_id' });
  const fields = h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Name', input({ name: 'name', required: true, minlength: 3, maxlength: 120, value: p ? p.name : '', placeholder: 'Spring hydrant flushing, north side' }))),
    field('Checklist', tplSel), field('Due', input({ name: 'due_on', type: 'date', value: p && p.due_on ? p.due_on : '' })),
    field('Led by', select([['', 'No one yet'], ...staff.data.map((s) => [s.id, `${s.first_name} ${s.last_name}`])], p && p.assigned_staff_id ? p.assigned_staff_id : '', { name: 'assigned_staff_id' })),
    field('Crew', input({ name: 'crew', maxlength: 120, value: p && p.crew ? p.crew : '', placeholder: 'Water crew: Luis and Kevin' })),
    h('div', { class: 'wide' }, field('Notes for the crew', h('textarea', { name: 'notes', rows: 2, maxlength: 1000 }, p && p.notes ? p.notes : ''))));
  let pickEl = null; let readTargets = null;
  if (!p) [pickEl, readTargets] = await targetPicker(mapCfg, reg.data, meta, tplSel);
  formDialog(p ? `Change ${p.name}` : 'New program', h('div', { class: 'stack' }, fields, pickEl), async (fd) => {
    const b = { name: val(fd, 'name'), template_id: num(fd, 'template_id'), due_on: val(fd, 'due_on'), assigned_staff_id: num(fd, 'assigned_staff_id'), crew: val(fd, 'crew'), notes: val(fd, 'notes') };
    if (p) { await patch(`/assets/programs/${p.id}`, b); toast('Saved'); await done(p.id); return; }
    const targets = readTargets();
    const r = await post('/assets/programs', { ...b, targets });
    toast(`Program started with ${r.targets} target${r.targets === 1 ? '' : 's'}`);
    await done(r.id);
  }, { wide: true, submitText: p ? 'Save' : 'Start the program' });
}

/** What a new program covers: kinds of map item (only inside a box drawn on the map, if one is drawn) and assets. */
async function targetPicker(cfg, assets, meta, tplSel) {
  const L = await loadLeaflet();
  const used = [...new Set(cfg.features.map((f) => f.kind))];
  const kinds = cfg.kinds.filter((k) => used.includes(k.key));
  const tplKinds = () => (meta.templates.find((t) => String(t.id) === tplSel.value) || { map_kinds: [] }).map_kinds;
  const boxes = kinds.map((k) => h('input', { type: 'checkbox', value: k.key, checked: tplKinds().includes(k.key) }));
  tplSel.addEventListener('change', () => { for (const b of boxes) b.checked = tplKinds().includes(b.value); redraw(); });
  const count = h('p', { class: 'muted', role: 'status' });
  const mapEl = h('div', { class: 'map-box mini-map', role: 'application', 'aria-label': 'Map of what the program covers' });
  const assetSel = h('select', { multiple: true, size: Math.min(6, Math.max(3, assets.length)), 'aria-label': 'Assets in the register' }, assets.map((a) => h('option', { value: a.id }, `${a.name} (${a.asset_tag})`)));
  let rect = null; let corner = null; let drawingBox = false;
  const boxBtn = button('Draw a box on the map', () => { drawingBox = true; corner = null; if (rect) { rect.remove(); rect = null; } count.textContent = 'Tap one corner of the area, then the opposite corner.'; }, { small: true });
  const clearBtn = button('Whole map', () => { if (rect) rect.remove(); rect = null; drawingBox = false; redraw(); }, { small: true });
  const el = h('fieldset', { class: 'stack tight' }, h('legend', null, 'What it covers'),
    kinds.length ? h('div', { class: 'checks' }, kinds.map((k, i) => h('label', { class: 'check' }, boxes[i], ` ${k.label}`))) : h('p', { class: 'muted' }, 'Nothing is on the map yet.'),
    h('div', { class: 'row' }, boxBtn, clearBtn), mapEl, count,
    assets.length ? field('Assets from the register (hold Ctrl or Command for more than one)', assetSel) : null);
  const map = makeMap(L, mapEl, cfg, cfg.center || { lat: 39.8283, lng: -98.5795, zoom: 4 }, { base: 'Satellite', remember: 'assets' });
  removeWhenGone(mapEl, map);
  const layer = L.layerGroup().addTo(map);
  const chosen = () => boxes.filter((b) => b.checked).map((b) => b.value);
  let fitted = false; // the map fits what is picked once, then stays where the manager moves it
  const picked = () => cfg.features.filter((f) => chosen().includes(f.kind) && ['in_service', 'out_of_service'].includes(f.status) && (!rect || rect.getBounds().contains(anchor(f))));
  const anchor = (f) => (f.geometry === 'point' ? f.points[0] : f.points[Math.floor(f.points.length / 2)]);
  function redraw() {
    layer.clearLayers();
    const list = picked();
    for (const f of cfg.features.filter((x) => chosen().includes(x.kind))) {
      L.circleMarker(anchor(f), { radius: 6, weight: 2, color: list.includes(f) ? css('--prog-todo', '#1f5fd1') : css('--prog-skipped', '#8a8f94'), fillOpacity: list.includes(f) ? 0.7 : 0.2 }).addTo(layer);
    }
    count.textContent = `${list.length} map item${list.length === 1 ? '' : 's'}${rect ? ' inside the box' : ''}.`;
    if (!fitted && list.length) { fitted = true; fitMap(map, L.latLngBounds(list.map(anchor)), { padding: [20, 20], maxZoom: 18 }); }
  }
  map.on('click', (e) => {
    if (!drawingBox) return;
    if (!corner) { corner = e.latlng; count.textContent = 'Now tap the opposite corner.'; return; }
    rect = L.rectangle(L.latLngBounds(corner, e.latlng), { color: css('--prog-todo', '#1f5fd1'), weight: 2, fillOpacity: 0.05 }).addTo(map);
    drawingBox = false; corner = null;
    redraw();
  });
  for (const b of boxes) b.addEventListener('change', redraw);
  redraw();
  const read = () => {
    const out = {};
    if (chosen().length) {
      out.pick = { kinds: chosen() };
      if (rect) { const bd = rect.getBounds(); out.pick.box = { south: bd.getSouth(), west: bd.getWest(), north: bd.getNorth(), east: bd.getEast() }; }
    }
    const ids = [...assetSel.selectedOptions].map((o) => Number(o.value));
    if (ids.length) out.assets = ids;
    if (!out.pick && !out.assets) throw new Error('Choose what the program covers: a kind of map item, or assets from the register');
    return out;
  };
  return [el, read];
}

// ---------------------------------------------------------------- one program
async function renderProgram(root, id) {
  const page = h('div', { class: 'stack' });
  root.append(page);
  let here = null; // [lat, lng] from the phone, when it shares it
  let watch = null;
  async function load() {
    let p;
    try { p = await get(`/assets/programs/${id}`); } catch (err) { clear(page).append(h('p', { class: 'back' }, h('a', { href: '#/assetprograms' }, '‹ Programs')), errorBox(err)); return; }
    draw(p);
  }
  function draw(p) {
    const open = p.status === 'open';
    const mapEl = h('div', { class: 'map-box', role: 'application', 'aria-label': `Map of ${p.name}: blue to do, green done, red failed, gray skipped` });
    const listBox = h('div');
    const tpl = p.template ? [{ ...p.template, kinds: [], map_kinds: [], active: true }] : [];
    const doTarget = (g) => inspectDialog({ type: g.type, kind: g.kind, id: g.asset_id || g.map_feature_id, name: g.name, turns: g.turns }, tpl, {
      preferId: p.template_id, title: `${p.template ? p.template.name : 'Inspect'}: ${g.name}`, meters: g.type === 'asset',
      photoPath: g.type === 'asset' ? `/assets/register/${g.asset_id}/photos` : `/assets/map/features/${g.map_feature_id}/photos`,
      save: (b) => post(`/assets/programs/${p.id}/targets/${g.id}/inspect`, b), done: load,
    });
    const skip = (g) => formDialog(`Skip ${g.name}`, h('div', { class: 'form' }, h('div', { class: 'wide' }, field('Why', input({ name: 'reason', required: true, minlength: 3, maxlength: 255, placeholder: 'Paved over, behind a locked fence, under water' })))),
      async (fd) => { await post(`/assets/programs/${p.id}/targets/${g.id}/skip`, { reason: val(fd, 'reason') }); toast('Skipped'); await load(); }, { submitText: 'Skip it' });
    const row = (g) => h('li', { class: 'prog-target' },
      h('span', null, h('span', { class: 'amap-swatch', style: `--c:${stateColor(g)}` }), ' ', g.map_feature_id ? h('a', { href: `#/assets/map/f${g.map_feature_id}` }, h('b', null, g.name)) : h('a', { href: `#/assets/a/${g.asset_id}` }, h('b', null, g.name)),
        h('span', { class: 'muted small' }, ` ${g.kind_label}${g.tag && !g.name.includes(g.tag) ? ` ${g.tag}` : ''}`),
        here && g.lat !== null ? h('span', { class: 'muted small dist' }, ` · ${away(dist(here, [g.lat, g.lng]))} away`) : null,
        g.status === 'skipped' ? h('span', { class: 'muted small' }, ` · Skipped: ${g.skip_reason}`) : null,
        g.status === 'done' ? h('span', { class: 'muted small' }, ` · ${fmtDateTime(g.done_at)}${g.done_by ? `, ${g.done_by}` : ''}`) : null),
      h('span', { class: 'row tight' },
        g.status !== 'todo' ? state(g.result === 'fail' ? 'Failed' : STATE[g.status][0], g.result === 'fail' ? 'bad' : STATE[g.status][1]) : null,
        g.work_order ? button('Work order', () => workOrderSheet(g.work_order.id, null, load), { small: true, label: `Work order: ${g.work_order.title}` }) : null,
        open && g.status === 'todo' ? button('Inspect', () => doTarget(g), { small: true, kind: 'primary', label: `Inspect ${g.name}` }) : null,
        open && g.status === 'todo' ? button('Skip', () => skip(g), { small: true, label: `Skip ${g.name}` }) : null,
        open && g.status === 'skipped' && p.can_manage ? button('Back on the list', async () => { await post(`/assets/programs/${p.id}/targets/${g.id}/reopen`, {}); await load(); }, { small: true }) : null));
    const sortNear = (list) => (here ? [...list].sort((a, b) => (a.lat === null ? 1e12 : dist(here, [a.lat, a.lng])) - (b.lat === null ? 1e12 : dist(here, [b.lat, b.lng]))) : list);
    const listOf = (list, none) => (list.length ? h('ul', { class: 'plain rows' }, list.map(row)) : h('p', { class: 'muted' }, none));
    const todo = p.targets.filter((g) => g.status === 'todo');
    const tabItems = [
      ['todo', `To do (${todo.length})`, (b) => { if (!here) b.append(h('p', { class: 'muted small' }, 'Share your location to list the nearest first.')); b.append(listOf(sortNear(todo), 'Nothing left to do.')); }],
      ['done', `Done (${p.progress.done})`, (b) => { b.append(listOf(p.targets.filter((g) => g.status === 'done'), 'None done yet.')); }],
      ['failed', `Failures (${p.failures.length})`, (b) => { b.append(listOf(p.failures, 'No failures.')); }],
      ['skipped', `Skipped (${p.progress.skipped})`, (b) => { b.append(listOf(p.targets.filter((g) => g.status === 'skipped'), 'None skipped.')); }],
    ];
    clear(listBox).append(tabs(tabItems, 'todo', { param: 'list' }));
    const tools = h('div', { class: 'row' },
      navigator.geolocation ? button(here ? 'Update my location' : 'Use my location', () => locate(), { small: true }) : null,
      button('Download spreadsheet', () => download(`/assets/programs/${p.id}/export.csv`, `program-${p.id}.csv`), { small: true }),
      p.can_manage && open ? button('Change', () => programDialog(p, load), { small: true }) : null,
      p.can_manage && open ? button('Close the program', () => closeDialog(p, load), { small: true }) : null,
      p.can_manage ? button('Copy for next year', () => copyDialog(p), { small: true }) : null);
    clear(page).append(
      h('p', { class: 'back' }, h('a', { href: '#/assetprograms' }, '‹ Programs')),
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, p.name),
        h('p', { class: 'page-note' }, [p.template_name, p.due_on ? `due ${fmtDate(p.due_on)}` : null, p.assignee && `led by ${p.assignee}`, p.crew].filter(Boolean).join(' · ')),
        p.status === 'closed' ? state('Closed', 'neutral') : p.overdue ? state('Past its due date', 'bad') : null)),
      h('section', { class: 'panel stack' }, progress(p), p.notes ? h('p', { class: 'prewrap' }, p.notes) : null, tools),
      mapEl,
      h('section', { class: 'panel stack' }, listBox));
    drawMap(mapEl, p);
  }
  async function drawMap(mapEl, p) {
    let L; let cfg;
    try { [L, cfg] = await Promise.all([loadLeaflet(), get('/assets/map/view')]); } catch (err) { mapEl.replaceWith(errorBox(err)); return; }
    const pts = p.targets.filter((g) => g.lat !== null);
    const map = makeMap(L, mapEl, cfg, cfg.center || (pts[0] ? { lat: pts[0].lat, lng: pts[0].lng, zoom: 16 } : { lat: 39.8283, lng: -98.5795, zoom: 4 }), { base: 'Satellite', remember: 'assets' });
    removeWhenGone(mapEl, map);
    for (const g of pts) {
      const c = stateColor(g);
      const m = g.points && g.points.length > 1 ? L.polyline(g.points, { color: c, weight: 5 }) : L.circleMarker([g.lat, g.lng], { radius: 8, color: c, weight: 3, fillOpacity: 0.7 });
      m.bindTooltip(`${g.name}: ${g.result === 'fail' ? 'failed' : STATE[g.status][0].toLowerCase()}`);
      m.addTo(map);
    }
    if (here) L.circleMarker(here, { radius: 7, className: 'gps-dot', interactive: false }).addTo(map);
    if (pts.length) fitMap(map, L.latLngBounds(pts.map((g) => [g.lat, g.lng])), { padding: [30, 30], maxZoom: 18 });
  }
  function locate() {
    if (!navigator.geolocation) return;
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = navigator.geolocation.watchPosition((pos) => {
      const first = !here;
      here = [pos.coords.latitude, pos.coords.longitude];
      if (first) load();
      navigator.geolocation.clearWatch(watch); watch = null;
    }, () => toast('Location was not shared. Allow it for this site to list the nearest first.', 'error'), { enableHighAccuracy: true, timeout: 20000 });
  }
  // A phone that already allows location lists the nearest first without asking.
  try { if (navigator.permissions && navigator.geolocation) navigator.permissions.query({ name: 'geolocation' }).then((s) => { if (s.state === 'granted') locate(); }).catch(() => {}); } catch (_) { /* no permissions API */ }
  await load();
}

function closeDialog(p, done) {
  if (!p.progress.todo) {
    confirmDialog(`Close ${p.name}?`, 'Everything in it is done or skipped. It stays on the list as closed; copy it to run it again.', 'Close it', async () => { await post(`/assets/programs/${p.id}/close`, {}); toast('Program closed'); await done(); });
    return;
  }
  formDialog(`Close ${p.name}?`, h('div', { class: 'stack' },
    h('p', null, `${p.progress.todo} ${p.progress.todo === 1 ? 'is' : 'are'} still to do. ${p.progress.todo === 1 ? 'It is' : 'They are'} marked skipped, with this reason.`),
    field('Why the rest are skipped', input({ name: 'reason', required: true, minlength: 3, maxlength: 255, placeholder: 'Moved to next year\'s program' }))),
  async (fd) => { const r = await post(`/assets/programs/${p.id}/close`, { skip_rest_reason: val(fd, 'reason') }); toast(`Program closed. ${r.skipped_at_close} skipped.`); await done(); }, { submitText: 'Close it' });
}

function copyDialog(p) {
  const next = p.due_on ? `${Number(p.due_on.slice(0, 4)) + 1}${p.due_on.slice(4)}` : '';
  formDialog(`Copy ${p.name}`, h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Name', input({ name: 'name', required: true, minlength: 3, maxlength: 120, value: p.name.replace(/\b(20\d\d)\b/, (y) => String(Number(y) + 1)) }))),
    field('Due', input({ name: 'due_on', type: 'date', value: next })),
    h('p', { class: 'muted small wide' }, `Same checklist, crew and ${p.progress.total} targets, all to do. Retired assets and abandoned map items are left out.`)),
  async (fd) => { const r = await post(`/assets/programs/${p.id}/copy`, { name: val(fd, 'name'), due_on: val(fd, 'due_on') }); toast(`Copied with ${r.targets} targets`); location.hash = `#/assetprograms/${r.id}`; }, { submitText: 'Copy' });
}

