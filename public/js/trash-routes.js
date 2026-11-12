// Trash and recycling: the Routes tab (Collection routes add-on) and the Hauler tab (Hauler oversight add-on), release
// 2026.11.22. Registered through trashtabs.js; the app's view (views/bulk-pickup.js) shows them after its own tabs.
//
// Routes
//   The crew (a phone, in gloves, in the sun): today's routes they are on (or can pick up), then one route as a list of
//   big rows, each street Done or Skip. Skip asks why (big buttons) and for a photo. Every tap is saved on the phone first
//   and sent in order (outbox.js, sealed); with no signal the list still works and says how many taps are waiting.
//   Starting a route: the truck (Assets and fleet), the pre-trip check (Assets and fleet's own checklist) and the odometer.
//   Finishing: the odometer, hours, and the landfill and recycling tickets.
//   The office (managers, front desk): each route's progress, truck and crew, a map of the marks, go-backs, and for
//   managers the snow day, the trucks that plow, and collection-day costs.
// Hauler
//   The contract's terms, missed pickups sent to the hauler (on time, late, collected), and the monthly scorecard.
//
// Address: #/bulk?tab=routes (&route=<id>, &view=gobacks|trucks|costs|snow) and #/bulk?tab=hauler (&view=scorecard).
import { get, post, put, fetchBlob } from './api.js';
import { registerTab } from './trashtabs.js';
import { send, sendPhoto, pending, onChange as onOutbox, flush, ROUTE_QUEUE, keepList, keptList } from './outbox.js';
import { h, clear, appendAll, ctx, state, button, field, input, select, toast, fail, formDialog, dialog, confirmDialog, empty, errorBox, loading, table, isManager, can, money, toCents, centsToInput, fmtDay, fmtDate, fmtDateTime, hashParam, nowStamp, todayStr } from './ui.js';

const on = (key) => Boolean(ctx.me && ctx.me.modules && ctx.me.modules.includes(key));
const crewOnly = () => Boolean(ctx.me && ctx.me.role === 'staff');
const t12 = (v) => { const m = /(\d{1,2}):(\d{2})/.exec(String(v || '').slice(11) || String(v || '')); if (!m) return ''; const hh = Number(m[1]); return `${hh % 12 || 12}:${m[2]} ${hh < 12 ? 'AM' : 'PM'}`; };
const TONE = { planned: 'neutral', started: 'good', done: 'good', delayed: 'warn' };
const newRef = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const setParam = (k, v) => { const u = new URL(location.href); const q = new URLSearchParams(u.hash.split('?')[1] || ''); if (v === null) q.delete(k); else q.set(k, v); const hash = `${u.hash.split('?')[0]}?${q}`; try { history.replaceState(null, '', hash); } catch (_) { /* the view still changes */ } };
let gps = null;
function watchGps() {
  if (!navigator.geolocation || watchGps.on) return;
  watchGps.on = true;
  try { navigator.geolocation.watchPosition((p) => { gps = { lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }; }, () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }); } catch (_) { /* no GPS: marks carry no position */ }
}
const progressBar = (p) => h('div', { class: 'rt-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(p.total), 'aria-valuenow': String(p.done + p.skipped), 'aria-label': `${p.done + p.skipped} of ${p.total} streets` },
  h('span', { class: 'rt-bar-done', style: `width:${p.total ? (p.done / p.total) * 100 : 0}%` }), h('span', { class: 'rt-bar-skip', style: `width:${p.total ? (p.skipped / p.total) * 100 : 0}%` }));

// ================================================================ the Routes tab
registerTab({
  id: 'routes', label: 'Routes', order: 15,
  show: (c) => (c && c.on ? c.on.includes('collectionroutes') : on('collectionroutes')) && (!c || !c.model || c.model === 'inhouse') && can('counter', 'staff'),
  render: async (el) => {
    watchGps();
    // Opening a route (#/bulk?tab=routes&route=<id>) or going back changes only the address's query: draw again then.
    let shown = null;
    const draw = async () => {
      const id = Number(hashParam('route')) || null;
      const key = `${id}|${hashParam('view') || ''}`;
      if (key === shown && el.childElementCount) return;
      shown = key;
      clear(el);
      if (id) return routePage(el, id);
      if (crewOnly()) return crewHome(el);
      return officeHome(el);
    };
    const onHash = () => { if (!el.isConnected) { window.removeEventListener('hashchange', onHash); return; } if (hashParam('tab') === 'routes') draw(); };
    window.addEventListener('hashchange', onHash);
    await draw();
  },
});

// ---------------------------------------------------------------- the crew's list of today's routes
async function crewHome(el) {
  let d;
  try { d = await get('/solid-waste/routes'); keepList('routes.today', [d]); } catch (err) {
    const kept = keptList('routes.today');
    if (!kept) { el.append(errorBox(err)); return; }
    d = kept[0];
    el.append(h('p', { class: 'callout' }, 'No signal. This is the list from the last time it loaded.'));
  }
  const mine = d.routes.filter((r) => r.crew.some((c) => c.user_id === ctx.me.id));
  const open = d.routes.filter((r) => !r.crew.length);
  appendAll(el,
    waitingStrip(),
    h('h2', { class: 'rt-h' }, `Today, ${fmtDay(d.date)}`),
    d.moved.length ? h('p', { class: 'callout' }, d.moved.map((m) => `${m.zones}: ${m.to ? `moved to ${fmtDay(m.to)}` : 'canceled'} (${m.reason === 'snow' ? 'snow' : m.reason})`).join('. ')) : null,
    mine.length ? h('ul', { class: 'plain rt-routes' }, mine.map(routeCard)) : null,
    open.length ? [h('h3', null, mine.length ? 'Other routes nobody is on yet' : 'Pick your route'), h('ul', { class: 'plain rt-routes' }, open.map(routeCard))] : null,
    !mine.length && !open.length ? empty(d.routes.length ? 'You are not on a route today.' : 'No collection routes today.') : null);
}
function routeCard(r) {
  return h('li', null, h('a', { class: `rt-card rt-${r.status}`, href: `#/bulk?tab=routes&route=${r.id}` },
    h('span', { class: 'rt-card-top' }, h('b', null, r.name), state(r.status_words, TONE[r.status])),
    progressBar(r.progress),
    h('span', { class: 'rt-card-meta' }, `${r.progress.done} done, ${r.progress.skipped} skipped, ${r.progress.left} to go`, r.truck ? ` · ${r.truck}` : '', r.crew.length ? ` · ${r.crew.map((c) => c.name).join(', ')}` : '')));
}

/** "3 taps waiting to send": what this phone has not got to the server yet. */
function waitingStrip() {
  const box = h('div', { class: 'rt-waiting', role: 'status' });
  const draw = () => {
    if (!box.isConnected && box.dataset.drawn) return;
    box.dataset.drawn = '1';
    const list = pending(ROUTE_QUEUE);
    const refused = list.filter((x) => x.error);
    clear(box);
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    appendAll(box, h('b', null, `${list.length - refused.length} saved on this phone, waiting to send.`), ' They go by themselves when the signal is back.',
      refused.length ? h('p', { class: 'rt-refused' }, `${refused.length} could not be saved: ${refused[0].error}`) : null);
  };
  draw();
  const stop = onOutbox(() => { if (!box.isConnected) { stop(); return; } draw(); });
  return box;
}

// ---------------------------------------------------------------- one route: the driver's list
async function routePage(el, id) {
  const key = `routes.r${id}`;
  let r;
  const body = h('div', { class: 'rt-route' });
  el.append(h('p', { class: 'no-print' }, h('a', { href: '#/bulk?tab=routes' }, crewOnly() ? '← My routes' : '← All routes')), body);
  async function load({ quiet = false } = {}) {
    if (!quiet) clear(body).append(loading('Loading the route'));
    try { r = await get(`/solid-waste/routes/${id}`); keepList(key, [r]); } catch (err) {
      const kept = keptList(key);
      if (!kept || (err.status && err.status < 500 && err.status !== 0)) { clear(body).append(errorBox(err)); return; }
      r = kept[0]; r.offline = true;
    }
    // Taps still waiting on this phone show as made.
    for (const x of pending(ROUTE_QUEUE)) {
      const m = /\/routes\/(\d+)\/stops\/(\d+)\/mark$/.exec(x.path);
      if (!m || Number(m[1]) !== id || x.error) continue;
      const s = r.stops.find((st) => st.id === Number(m[2]));
      if (s) Object.assign(s, { status: x.body.status, reason: x.body.reason || null, reason_words: x.body.reason ? REASON_WORDS[x.body.reason] : null, waiting: true });
    }
    draw();
  }
  function counts() {
    const total = r.stops.length; const done = r.stops.filter((s) => s.status === 'done').length; const skipped = r.stops.filter((s) => s.status === 'skipped').length;
    return { total, done, skipped, left: total - done - skipped };
  }
  function draw() {
    const p = counts();
    const working = r.can_work || (r.offline && crewOnly());
    appendAll(clear(body),
      waitingStrip(),
      h('header', { class: 'rt-head' },
        h('h2', null, r.name),
        h('p', { class: 'rt-sub' }, state(r.status_words, TONE[r.status]), r.truck ? ` ${r.truck}` : '', r.started_at ? ` · started ${t12(r.started_at)}` : '', r.offline ? ' · no signal: saved list' : ''),
        progressBar(p),
        h('p', { class: 'rt-count' }, h('b', null, `${p.done + p.skipped} of ${p.total}`), ` streets · ${p.done} done · ${p.skipped} skipped`)),
      r.status === 'delayed' ? h('p', { class: 'callout rt-delayed' }, `${r.status_words}. Nothing is collected on this route today.`) : null,
      working && r.status === 'planned' ? startPanel(r, () => load()) : null,
      h('ol', { class: 'plain rt-stops' }, r.stops.map((s) => stopRow(s, working && r.status !== 'planned'))),
      r.bulk && r.bulk.length ? [h('h3', { class: 'rt-h3' }, `Bulk pickups on this route (${r.bulk.length})`), h('ol', { class: 'plain rt-stops' }, r.bulk.map((b) => bulkRow(b, working && r.status !== 'planned')))] : null,
      working && r.status === 'started' ? h('div', { class: 'rt-finish' }, button('Finish the route', () => finishDialog(r, () => load()), { kind: 'primary' })) : null,
      isManager() && !r.offline ? managerTools(r, () => load()) : null);
  }
  function stopRow(s, canMark) {
    const row = h('li', { class: `rt-stop rt-${s.status}${s.waiting ? ' rt-waiting-row' : ''}`, dataset: { stop: s.id } },
      h('div', { class: 'rt-stop-words' },
        h('b', null, s.words), s.kind === 'goback' ? h('span', { class: 'rt-tag' }, 'Go-back') : null,
        s.status === 'skipped' ? h('span', { class: 'rt-why' }, `Skipped: ${s.reason_words}${s.note ? `, ${s.note}` : ''}`) : null,
        s.status === 'done' && s.marked_at ? h('span', { class: 'rt-why' }, `Done ${t12(s.marked_at)}`) : null,
        s.goback_note ? h('span', { class: 'rt-why' }, s.goback_note) : null,
        s.waiting ? h('span', { class: 'rt-why' }, 'Saved on this phone') : null));
    if (canMark) {
      if (s.status === 'todo') row.append(h('div', { class: 'rt-acts' },
        h('button', { type: 'button', class: 'rt-btn rt-done-btn', onclick: () => markDone(s) }, 'Done'),
        h('button', { type: 'button', class: 'rt-btn rt-skip-btn', onclick: () => skipSheet(s) }, 'Skip')));
      else row.append(h('div', { class: 'rt-acts' }, h('button', { type: 'button', class: 'rt-btn rt-undo-btn', onclick: () => confirmDialog('Undo this mark?', `${s.words} goes back to the list.`, 'Undo', () => mark(s, { status: 'todo' })) }, 'Undo')));
    }
    return row;
  }
  async function mark(s, body) {
    const path = `/solid-waste/routes/${id}/stops/${s.id}/mark`;
    const full = { ...body, at: nowStamp(), ...(gps ? gps : {}) };
    Object.assign(s, { status: body.status, reason: body.reason || null, reason_words: body.reason ? REASON_WORDS[body.reason] : null, note: body.note || null, marked_at: full.at.replace('T', ' '), waiting: true });
    draw();
    try {
      const out = await send('POST', path, full, { caseId: ROUTE_QUEUE, label: `${s.words}: ${body.status === 'todo' ? 'undo' : body.status}`, offlineBody: { ...full, queued: true } });
      if (!out.queued) { s.waiting = false; draw(); }
    } catch (err) { fail(err); await load({ quiet: true }); }
  }
  const markDone = (s) => mark(s, { status: 'done' });
  function skipSheet(s) {
    let reason = null;
    const reasons = h('div', { class: 'rt-reasons', role: 'group', 'aria-label': 'Why it was skipped' }, (r.reasons || Object.entries(REASON_WORDS).map(([k, w]) => ({ key: k, words: w }))).map((x) => {
      const b = h('button', { type: 'button', class: 'rt-btn rt-reason', 'aria-pressed': 'false', onclick: () => { reason = x.key; for (const o of reasons.children) o.setAttribute('aria-pressed', String(o === b)); note.hidden = x.key !== 'other'; } }, x.words);
      return b;
    }));
    const note = input({ maxlength: 200, placeholder: 'Say why', 'aria-label': 'Why', hidden: true, class: 'rt-note' });
    const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'rt-file', id: `rt-photo-${s.id}` });
    const preview = h('img', { class: 'rt-preview', alt: 'The photo you took', hidden: true });
    const photoBtn = h('label', { class: 'rt-btn rt-photo-btn', for: `rt-photo-${s.id}` }, 'Take a photo');
    file.addEventListener('change', () => { const f = file.files && file.files[0]; if (f) { preview.src = URL.createObjectURL(f); preview.hidden = false; photoBtn.textContent = 'Take it again'; } });
    formDialog(`Skip ${s.words}`, h('div', { class: 'stack rt-sheet' }, h('p', { class: 'rt-sheet-q' }, 'Why?'), reasons, note, file, photoBtn, preview,
      h('p', { class: 'muted small' }, 'A photo is needed for every skipped street. It stays with the route; residents never see it.')), async () => {
      if (!reason) throw new Error('Tap why it was skipped');
      if (reason === 'other' && !note.value.trim()) throw new Error('Say why it was skipped');
      const f = file.files && file.files[0];
      if (!f) throw new Error('Take a photo first');
      const ref = newRef();
      const q = new URLSearchParams({ stop_id: String(s.id), client_ref: ref, ...(gps ? { lat: String(gps.lat), lng: String(gps.lng) } : {}) });
      await sendPhoto(`/solid-waste/routes/${id}/photos?${q}`, f, { caseId: ROUTE_QUEUE, label: `Photo: ${s.words}`, ref });
      await mark(s, { status: 'skipped', reason, note: note.value.trim() || undefined, photo_ref: ref });
    }, { submitText: 'Save skip' });
  }
  function bulkRow(b, canMark) {
    const row = h('li', { class: `rt-stop rt-${b.outcome ? (b.outcome === 'picked_up' ? 'done' : 'skipped') : 'todo'}` },
      h('div', { class: 'rt-stop-words' }, h('b', null, b.words), h('span', { class: 'rt-tag' }, 'Bulk'), h('span', { class: 'rt-why' }, b.items), b.outcome ? h('span', { class: 'rt-why' }, { picked_up: 'Picked up', not_out: 'Not out', not_accepted: 'Not accepted' }[b.outcome]) : null));
    if (canMark && !b.outcome) row.append(h('div', { class: 'rt-acts' }, h('a', { class: 'rt-btn rt-skip-btn', href: `#/bulk?tab=day&date=${r.date}` }, 'Open')));
    return row;
  }
  await load();
  const again = setInterval(() => { if (!body.isConnected) { clearInterval(again); return; } if (navigator.onLine !== false && !pending(ROUTE_QUEUE).length && !document.querySelector('dialog[open]')) load({ quiet: true }); }, 60000);
  window.addEventListener('online', () => { flush().then(() => body.isConnected && load({ quiet: true })); }, { once: true });
}
const REASON_WORDS = { blocked: 'Blocked', parked_cars: 'Parked cars', contaminated: 'Contaminated', not_out: 'Not out', other: 'Other' };

/** Start: pick the truck, the pre-trip check, the odometer. */
function startPanel(r, reload) {
  const trucks = r.trucks || [];
  let truck = r.truck_id || (trucks.find((t) => !t.out_of_service && !t.on_route) || {}).id || null;
  const list = h('div', { class: 'rt-trucks', role: 'radiogroup', 'aria-label': 'Your truck' });
  const odo = input({ type: 'number', inputmode: 'numeric', min: 0, step: '1', class: 'rt-odo', 'aria-label': 'Odometer (miles)', placeholder: 'Miles' });
  const pre = h('div', { class: 'rt-pre' });
  let check = r.pretrip_check;
  const drawTrucks = () => clear(list).append(...trucks.map((t) => h('button', { type: 'button', class: 'rt-btn rt-truck', role: 'radio', 'aria-checked': String(t.id === truck), disabled: t.out_of_service,
    onclick: async () => { truck = t.id; drawTrucks(); odo.placeholder = t.miles ? `Last: ${Math.round(t.miles).toLocaleString('en-US')}` : 'Miles'; check = null; drawPre(); } },
  h('b', null, t.name), h('span', null, t.out_of_service ? 'Out of service' : t.on_route ? `On ${t.on_route}` : t.setup === 'plow' ? 'Set up to plow' : 'Ready'))));
  const drawPre = () => {
    clear(pre);
    if (check && check.done) pre.append(state(`Pre-trip done ${t12(check.done.at)}${check.done.result === 'fail' ? ': failed' : ''}`, check.done.result === 'fail' ? 'bad' : 'good'));
    else pre.append(button('Do the pre-trip check', async () => {
      if (!truck) { toast('Pick your truck first', 'error'); return; }
      try {
        const [{ inspectDialog }, tpl] = await Promise.all([import('./views/asset-bits.js'), get('/assets/templates')]);
        const t = trucks.find((x) => x.id === truck);
        inspectDialog({ type: 'asset', id: truck, kind: 'truck', name: t ? t.name : 'Truck' }, tpl.data.map((x) => ({ ...x, kinds: String(x.kinds || '').split(',').filter(Boolean), map_kinds: String(x.map_kinds || '').split(',').filter(Boolean) })), {
          save: (body) => post(`/assets/register/${truck}/inspections`, body), photoPath: `/assets/register/${truck}/photos`, title: `Pre-trip: ${t ? t.name : 'truck'}`, preferId: r.pretrip_check && r.pretrip_check.template_id,
          done: async () => { await reload(); },
        });
      } catch (err) { fail(err); }
    }, { kind: 'primary' }), ' ', button('Skip it today', () => go(true)));
  };
  async function go(skip = false) {
    if (!truck) { toast('Pick your truck', 'error'); return; }
    try {
      await post(`/solid-waste/routes/${r.id}/start`, { truck_id: truck, ...(odo.value ? { odometer: Number(odo.value) } : {}), ...(skip ? { pretrip_skipped: true } : {}), ...(gps || {}) });
      toast('Route started'); await reload();
    } catch (err) {
      if (err.details && err.details.code === 'pretrip_needed') { toast('Do the pre-trip check first, or tap Skip it today', 'error'); return; }
      fail(err);
    }
  }
  drawTrucks(); drawPre();
  return h('section', { class: 'panel rt-start' }, h('h3', null, 'Start the route'),
    trucks.length ? list : h('p', { class: 'muted' }, 'No trucks in Assets and fleet yet. Ask a manager to add them.'),
    field('Odometer', odo), pre,
    h('div', { class: 'rt-finish' }, button('Start', () => go(false), { kind: 'primary' })));
}

function finishDialog(r, reload) {
  const odo = input({ type: 'number', inputmode: 'numeric', min: 0, name: 'odometer', class: 'rt-odo', placeholder: r.odometer_start ? `Started at ${Math.round(r.odometer_start).toLocaleString('en-US')}` : 'Miles' });
  const hours = input({ type: 'number', inputmode: 'decimal', min: 0.25, max: 24, step: '0.25', name: 'truck_hours', placeholder: 'From the start and end' });
  const tickets = h('div', { class: 'stack' });
  const rows = [];
  const addTicket = () => {
    const t = { facility: input({ maxlength: 120, placeholder: 'Landfill or recycling place', 'aria-label': 'Where' }), no: input({ maxlength: 40, 'aria-label': 'Ticket number', placeholder: 'Ticket number' }),
      tons: input({ type: 'number', inputmode: 'decimal', min: 0.01, step: '0.01', 'aria-label': 'Net tons', placeholder: 'Net tons' }), fee: input({ type: 'number', inputmode: 'decimal', min: 0, step: '0.01', 'aria-label': 'Tipping fee ($)', placeholder: 'Fee $' }), ref: newRef() };
    rows.push(t);
    tickets.append(h('div', { class: 'panel form rt-ticket' }, field('Where', t.facility), field('Ticket', t.no), field('Net tons', t.tons), field('Tipping fee ($)', t.fee)));
  };
  formDialog(`Finish ${r.name}`, h('div', { class: 'stack' },
    h('div', { class: 'form' }, field('Odometer now', odo), field('Truck hours (leave empty to use the route\'s time)', hours)),
    h('h3', null, 'Landfill and recycling tickets'), tickets, button('Add a ticket', addTicket, { small: true }),
    h('p', { class: 'muted small' }, 'Your hours go on the day\'s work order for the Sanitation fund, at your labor rate. The tickets go to Tonnage.')), async () => {
    const list = rows.filter((t) => t.facility.value.trim() || t.tons.value).map((t) => {
      if (!t.facility.value.trim() || !Number(t.tons.value)) throw new Error('Each ticket needs where and the net tons');
      return { facility: t.facility.value.trim(), ticket_no: t.no.value.trim() || undefined, net_tons: Number(t.tons.value), fee_cents: t.fee.value ? toCents(t.fee.value) : undefined, client_ref: t.ref };
    });
    const body = { ...(odo.value ? { odometer: Number(odo.value) } : {}), ...(hours.value ? { truck_hours: Number(hours.value) } : {}), tickets: list };
    const out = await send('POST', `/solid-waste/routes/${r.id}/finish`, body, { caseId: ROUTE_QUEUE, label: `Finish ${r.name}` });
    toast(out.queued ? 'Saved on this phone. It is sent when the signal is back.' : out.left ? `Finished. ${out.left} street${out.left === 1 ? '' : 's'} not marked.` : 'Route finished');
    await reload();
  }, { submitText: 'Finish', wide: true });
  addTicket();
}

function managerTools(r, reload) {
  return h('section', { class: 'panel stack rt-tools' }, h('h3', null, 'Manager'),
    h('div', { class: 'row wrap' },
      button('Who is on it', async () => {
        let users;
        try { users = (await get('/users')).data || []; } catch (err) { fail(err); return; }
        const boxes = users.filter((u) => ['staff', 'manager', 'owner'].includes(u.role) && u.active !== false).map((u) => ({ u, el: h('input', { type: 'checkbox', checked: r.crew.some((c) => c.user_id === u.id) }) }));
        formDialog(`Crew on ${r.name}`, h('div', { class: 'checks' }, boxes.map((b) => h('label', { class: 'check' }, b.el, ` ${b.u.name || [b.u.first_name, b.u.last_name].filter(Boolean).join(' ') || b.u.username}`))), async () => {
          await put(`/solid-waste/routes/${r.id}/crew`, { user_ids: boxes.filter((b) => b.el.checked).map((b) => b.u.id) }); toast('Crew saved'); await reload();
        });
      }),
      r.status === 'started' && !r.can_work ? button('Finish for them', () => finishDialog(r, reload)) : null,
      r.work_order_id ? h('a', { class: 'btn', href: `#/works/${r.work_order_id}` }, 'The day\'s work order') : null));
}

// ---------------------------------------------------------------- the office
async function officeHome(el) {
  const views = [['board', 'Today\'s routes'], ['gobacks', 'Go-backs'], ...(isManager() ? [['trucks', 'Trucks and plowing'], ['snow', 'Snow days'], ['costs', 'Costs']] : [])];
  let view = views.some((v) => v[0] === hashParam('view')) ? hashParam('view') : 'board';
  const body = h('div');
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
  const drawSeg = () => clear(seg).append(...views.map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(view === k), onclick: () => { view = k; setParam('view', k); drawSeg(); show(); } }, t)));
  drawSeg();
  el.append(h('div', { class: 'week-bar' }, seg), body);
  const show = () => { clear(body); return ({ board: boardView, gobacks: gobacksView, trucks: trucksView, snow: snowView, costs: costsView })[view](body); };
  await show();
}

async function boardView(el) {
  let date = hashParam('date') || todayStr();
  const pick = input({ type: 'date', value: date, 'aria-label': 'Day' });
  const body = h('div');
  pick.addEventListener('change', () => { if (pick.value) { date = pick.value; setParam('date', date); load(); } });
  el.append(h('div', { class: 'row rt-daybar' }, field('Day', pick), button('Refresh', () => load(), { small: true })), body);
  let map = null; let layer = null;
  async function load() {
    clear(body).append(loading('Loading the routes'));
    let d;
    try { d = await get(`/solid-waste/routes/board?date=${date}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    const all = d.routes.reduce((a, r) => ({ total: a.total + r.progress.total, done: a.done + r.progress.done, skipped: a.skipped + r.progress.skipped }), { total: 0, done: 0, skipped: 0 });
    const mapBox = h('div', { class: 'map-box rt-map', role: 'application', 'aria-label': 'Map of the streets marked today' });
    appendAll(clear(body),
      d.moved.length ? h('p', { class: 'callout' }, d.moved.map((m) => `${m.zones}: ${m.to ? `moved to ${fmtDay(m.to)}` : 'canceled'} for ${m.reason}`).join('. ')) : null,
      d.moved_in.length ? h('p', { class: 'set-note' }, d.moved_in.map((m) => `${m.zones} from ${fmtDay(m.from)} (${m.reason})`).join('. ')) : null,
      !d.kept ? h('p', { class: 'muted' }, 'A later day: the routes as the schedule has them. They open on the day.') : null,
      d.routes.length ? h('div', { class: 'figures' }, h('div', { class: 'figure' }, h('strong', null, String(d.routes.length)), h('span', null, 'routes')),
        h('div', { class: 'figure' }, h('strong', null, `${all.total ? Math.round(((all.done + all.skipped) / all.total) * 100) : 0}%`), h('span', null, 'of streets marked')),
        h('div', { class: 'figure' }, h('strong', null, String(all.skipped)), h('span', null, 'skipped'))) : null,
      d.routes.length ? h('ul', { class: 'plain rt-routes rt-board' }, d.routes.map((r) => (r.id ? routeCard(r) : h('li', null, h('div', { class: 'rt-card' }, h('b', null, r.name), h('span', { class: 'muted' }, `${r.progress.total} streets`)))))) : empty('No collection routes this day.'),
      d.gobacks_unplaced ? h('p', { class: 'set-note' }, `${d.gobacks_unplaced} go-back${d.gobacks_unplaced === 1 ? '' : 's'} with no route that day. `, h('a', { href: '#/bulk?tab=routes&view=gobacks' }, 'See go-backs')) : null,
      d.kept && d.routes.length && can('staff') ? mapBox : null);
    if (!d.kept || !d.routes.length || !can('staff')) return; // the map's tiles come with Assets and fleet, which the front desk does not open
    try {
      const { loadLeaflet, makeMap, fitMap, removeWhenGone } = await import('./views/incident-map.js');
      const [L, cfg] = await Promise.all([loadLeaflet(), get('/assets/map')]);
      if (map) { try { map.remove(); } catch (_) { /* gone */ } }
      map = makeMap(L, mapBox, cfg, cfg.center || { lat: 40.13, lng: -75.51, zoom: 14 }, { remember: 'routes' });
      removeWhenGone(mapBox, map);
      layer = L.layerGroup().addTo(map);
      const pts = [];
      for (const p of d.points) {
        const color = p.status === 'done' ? 'var(--open)' : 'var(--closed)';
        L.circleMarker([p.lat, p.lng], { radius: 7, color, fillColor: color, fillOpacity: 0.85, weight: 2 }).bindPopup(`${p.words}: ${p.status === 'done' ? 'done' : 'skipped'} ${t12(p.at)}`).addTo(layer);
        pts.push([p.lat, p.lng]);
      }
      for (const r of d.routes) if (r.last) { L.circleMarker([r.last.lat, r.last.lng], { radius: 11, color: '#0e2632', weight: 3, fillColor: '#f2b33d', fillOpacity: 1 }).bindPopup(`${r.name}${r.truck ? `, ${r.truck}` : ''}: last seen ${t12(r.last.at)}`).addTo(layer); pts.push([r.last.lat, r.last.lng]); }
      if (pts.length) fitMap(map, pts, { padding: [24, 24], maxZoom: 17 });
      else mapBox.after(h('p', { class: 'muted small' }, 'Marks show on the map as the crew taps them (when their phone shares its location).'));
    } catch (_) { mapBox.replaceWith(h('p', { class: 'muted small' }, 'The map is not available here.')); }
  }
  await load();
}

async function gobacksView(el) {
  const body = h('div');
  let status = 'waiting';
  const pick = select([['waiting', 'Waiting'], ['done', 'Done'], ['cancelled', 'Canceled'], ['all', 'Everything']], status, { 'aria-label': 'Show' });
  pick.addEventListener('change', () => { status = pick.value; load(); });
  el.append(h('div', { class: 'week-bar' }, pick, can('counter') ? button('Add a go-back', () => gobackDialog(load), { kind: 'primary' }) : null), body);
  async function load() {
    clear(body).append(loading());
    let r;
    try { r = await get(`/solid-waste/routes/gobacks?status=${status}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    clear(body).append(r.data.length ? table([
      { head: 'Address', cell: (g) => g.words },
      { head: 'Stream', cell: (g) => g.stream || '' },
      { head: 'Day', cell: (g) => fmtDate(g.due_on) },
      { head: 'Route', cell: (g) => g.route || h('span', { class: 'muted' }, 'none yet') },
      { head: 'Request', cell: (g) => (g.request_id ? h('a', { href: `#/requests/${g.request_id}` }, g.request) : '') },
      { head: '', cell: (g) => (g.status === 'waiting' && can('counter') ? button('Cancel', () => confirmDialog('Cancel this go-back?', g.words, 'Cancel it', async () => { await post(`/solid-waste/routes/gobacks/${g.id}/cancel`); await load(); }), { small: true }) : state(g.status === 'done' ? `Done ${fmtDateTime(g.done_at)}` : g.status, g.status === 'done' ? 'good' : 'neutral')) },
    ], r.data) : empty(status === 'waiting' ? 'No go-backs waiting.' : 'Nothing here.'));
  }
  await load();
}
async function gobackDialog(done) {
  let streets; let streams = [];
  try { streets = (await get('/requests/streets')).data || []; } catch (err) { fail(err); return; }
  try { streams = (await get('/solid-waste/collection/streams')).data || []; } catch (_) { /* the schedule's list, when it is there */ }
  const tomorrow = new Date(Date.parse(`${todayStr()}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  formDialog('Add a go-back', h('div', { class: 'form' },
    field('Street', select([['', 'Choose a street'], ...streets.map((s) => [s.id, s.name])], '', { name: 'street_id', required: true })),
    field('House number', input({ name: 'house_number', maxlength: 20 })),
    streams.length ? field('Stream', select([['', 'Any'], ...streams.map((s) => [s.id, s.name])], '', { name: 'stream_id' })) : null,
    field('Day', input({ type: 'date', name: 'due_on', value: tomorrow, min: todayStr() })),
    h('div', { class: 'wide' }, field('Note for the crew', input({ name: 'note', maxlength: 200 })))), async (fd) => {
    const v = (k) => String(fd.get(k) || '').trim();
    const r = await post('/solid-waste/routes/gobacks', { street_id: Number(v('street_id')), house_number: v('house_number') || undefined, stream_id: v('stream_id') ? Number(v('stream_id')) : undefined, due_on: v('due_on') || undefined, note: v('note') || undefined });
    toast(`Go-back added for ${fmtDay(r.due_on)}`); await done();
  }, { submitText: 'Add' });
}

async function trucksView(el) {
  let list;
  try { list = (await get('/solid-waste/routes/trucks')).data; } catch (err) { el.append(errorBox(err)); return; }
  let all = [];
  try { all = ((await get('/assets/register?category=fleet')).data || []).filter((a) => a.kind === 'truck' && a.status !== 'retired'); } catch (_) { all = list; }
  const boxes = all.map((a) => { const cur = list.find((x) => x.id === a.id && x.listed); return { a, use: h('input', { type: 'checkbox', checked: Boolean(cur) }), plows: h('input', { type: 'checkbox', checked: Boolean(cur && cur.plows) }) }; });
  el.append(
    h('section', { class: 'panel stack' }, h('h3', null, 'Collection trucks'),
      h('p', { class: 'muted small' }, 'The trucks the crew picks from. With none ticked, every truck in Assets and fleet is offered.'),
      boxes.length ? table([{ head: 'Truck', cell: (b) => b.a.name }, { head: 'Collects', cell: (b) => b.use }, { head: 'Also plows', cell: (b) => b.plows }], boxes) : empty('No trucks in Assets and fleet yet.'),
      h('div', { class: 'row' }, button('Save', async () => { try { await put('/solid-waste/routes/trucks', { trucks: boxes.filter((b) => b.use.checked).map((b) => ({ truck_id: b.a.id, plows: b.plows.checked })) }); toast('Saved'); } catch (err) { fail(err); } }, { kind: 'primary' }))),
    h('section', { class: 'panel stack' }, h('h3', null, 'Plowing and changeovers'),
      h('p', { class: 'muted small' }, 'Plowing hours go on the Streets department and the Liquid Fuels fund; collection hours on Sanitation. A changeover is a short work order on the truck.'),
      list.length ? table([
        { head: 'Truck', cell: (t) => t.name },
        { head: 'Set up for', cell: (t) => (t.setup === 'plow' ? state('Plow and spreader', 'warn') : 'Collection') },
        { head: '', cell: (t) => h('div', { class: 'row' },
          button(t.setup === 'plow' ? 'Change back to collection' : 'Change over to plow', async () => { try { const r = await post(`/solid-waste/routes/trucks/${t.id}/changeover`, { to: t.setup === 'plow' ? 'collection' : 'plow' }); toast(`Work order ${r.work_order_id} made`); clear(el); trucksView(el); } catch (err) { fail(err); } }, { small: true }),
          button('Log plowing hours', () => hoursDialog(t), { small: true })) },
      ], list) : null));
}
function hoursDialog(t) {
  formDialog(`Plowing hours: ${t.name}`, h('div', { class: 'form' },
    field('Day', input({ type: 'date', name: 'on_date', value: todayStr(), max: todayStr() })), field('Truck hours', input({ type: 'number', name: 'hours', min: 0.25, max: 24, step: '0.25', required: true })),
    field('Odometer (optional)', input({ type: 'number', name: 'odometer', min: 0 }))), async (fd) => {
    await post(`/solid-waste/routes/trucks/${t.id}/hours`, { job: 'plowing', hours: Number(fd.get('hours')), on_date: String(fd.get('on_date')) || undefined, ...(fd.get('odometer') ? { odometer: Number(fd.get('odometer')) } : {}) });
    toast('Plowing hours saved');
  });
}

async function snowView(el) {
  let d;
  try { d = await get('/solid-waste/routes/snow-days'); } catch (err) { el.append(errorBox(err)); return; }
  const RULE = { shift: 'That day moves to the next day; on a whole-borough snow day the rest of the week moves a day too.', skip: 'That day\'s pickup is canceled.', none: 'That day moves to the next day.' };
  el.append(
    h('section', { class: 'panel stack' }, h('h3', null, 'Declare a snow day'),
      h('p', null, RULE[d.rule] || RULE.shift, ' ', h('span', { class: 'muted small' }, '(the holiday rule in Schedule)')),
      h('p', { class: 'muted small' }, 'The day\'s routes show Delayed for snow, and a street notice to the streets affected is drafted for you to read and send.'),
      h('div', { class: 'row' }, button('Declare a snow day', () => snowDialog(el), { kind: 'primary' }))),
    h('section', { class: 'panel stack' }, h('h3', null, 'Snow days'),
      d.data.length ? table([
        { head: 'Day', cell: (s) => fmtDay(s.on_date) },
        { head: 'Zones', cell: (s) => (s.zone_ids.length ? `${s.zone_ids.length} zone${s.zone_ids.length === 1 ? '' : 's'}` : 'Every zone') },
        { head: 'Street notice', cell: (s) => (s.notice_id ? [h('a', { href: s.notice_status === 'draft' ? '#/notices?tab=drafts' : '#/notices' }, s.notice_status === 'draft' ? 'Draft: read and send' : 'Sent'), ' ', s.notice_status === 'draft' ? state('Not sent yet', 'warn') : null] : '') },
        { head: '', cell: (s) => button('Undo', () => confirmDialog('Undo this snow day?', s.notice_status === 'draft' ? 'The days go back, and the draft notice is deleted.' : 'The days go back. The notice was sent already: send residents a follow-up from Street notices.', 'Undo', async () => { await post(`/solid-waste/routes/snow-days/${s.id}/undo`); toast('Undone'); clear(el); snowView(el); }), { small: true }) },
      ], d.data) : empty('No snow days.')));
}
async function snowDialog(el) {
  let zones = [];
  try { zones = (await get('/solid-waste/collection/zones')).data || []; } catch (_) { /* every zone */ }
  const boxes = zones.map((z) => ({ z, el: h('input', { type: 'checkbox' }) }));
  formDialog('Declare a snow day', h('div', { class: 'stack' },
    field('Day', input({ type: 'date', name: 'on_date', value: todayStr(), min: todayStr(), required: true })),
    boxes.length ? h('fieldset', { class: 'checks' }, h('legend', null, 'Zones (none ticked: every zone)'), boxes.map((b) => h('label', { class: 'check' }, b.el, ` ${b.z.name}`))) : null,
    field('Note (goes on the notice)', input({ name: 'note', maxlength: 255, placeholder: 'For example: roads are being plowed first' }))), async (fd) => {
    const r = await post('/solid-waste/routes/snow-days', { on_date: String(fd.get('on_date')), zone_ids: boxes.filter((b) => b.el.checked).map((b) => b.z.id), note: String(fd.get('note') || '').trim() || undefined });
    dialog('Snow day declared', h('div', { class: 'stack' },
      h('ul', null, r.changes.map((c) => h('li', null, `${fmtDay(c.from)}: ${c.to ? `moves to ${fmtDay(c.to)}` : 'canceled'}`))),
      h('p', null, `A street notice to ${r.notice.streets} street${r.notice.streets === 1 ? '' : 's'} is drafted. It is not sent until you send it.`),
      h('blockquote', { class: 'rt-quote' }, r.notice.sms_text),
      h('p', null, h('a', { class: 'btn primary', href: `#/notices?tab=drafts` }, 'Read and send the notice'))));
    clear(el); snowView(el);
  }, { submitText: 'Declare' });
}

async function costsView(el) {
  const first = `${todayStr().slice(0, 7)}-01`;
  const from = input({ type: 'date', value: first, 'aria-label': 'From' }); const to = input({ type: 'date', value: todayStr(), 'aria-label': 'To' });
  const body = h('div');
  el.append(h('div', { class: 'row rt-daybar' }, field('From', from), field('To', to), button('Show', () => load(), { small: true })), body);
  async function load() {
    clear(body).append(loading());
    let c;
    try { c = await get(`/solid-waste/routes/costs?from=${from.value}&to=${to.value}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    const t = c.totals;
    appendAll(clear(body),
      h('div', { class: 'figures' },
        h('div', { class: 'figure' }, h('strong', null, money(t.collection.total_cents || 0)), h('span', null, 'collection (Sanitation)')),
        h('div', { class: 'figure' }, h('strong', null, `${t.collection.tons}`), h('span', null, 'tons on tickets')),
        h('div', { class: 'figure' }, h('strong', null, t.collection.cost_per_ton_cents ? money(t.collection.cost_per_ton_cents) : '–'), h('span', null, 'a ton')),
        h('div', { class: 'figure' }, h('strong', null, money(t.plowing.total_cents || 0)), h('span', null, 'plowing (Streets, Liquid Fuels)'))),
      c.days.length ? table([
        { head: 'Day', cell: (x) => fmtDate(x.date) }, { head: 'Truck', cell: (x) => x.truck }, { head: 'Job', cell: (x) => (x.job === 'plowing' ? 'Plowing' : 'Collection') },
        { head: 'Crew hours', num: true, cell: (x) => String(x.crew_hours) }, { head: 'Truck hours', num: true, cell: (x) => String(x.truck_hours) }, { head: 'Tons', num: true, cell: (x) => (x.job === 'collection' ? String(x.tons) : '') },
        { head: 'Tipping', num: true, cell: (x) => (x.tipping_cents ? money(x.tipping_cents) : '') }, { head: 'Cost', num: true, cell: (x) => h('a', { href: `#/works/${x.work_order_id}` }, money(x.total_cents)) },
      ], c.days) : empty('No collection or plowing days costed in these dates.'),
      h('p', { class: 'muted small' }, 'Each truck\'s day is a work order: crew hours at their labor rate, truck hours at its hourly rate, tipping fees from the tickets. They are in the monthly report under Sanitation and Streets.'));
  }
  await load();
}

// ================================================================ the Hauler tab
registerTab({
  id: 'hauler', label: 'Hauler', order: 17,
  show: (c) => (c && c.on ? c.on.includes('hauler') : on('hauler')) && (!c || !c.model || c.model === 'contract') && can('counter'),
  render: async (el) => {
    const views = [['missed', 'Missed pickups'], ['scorecard', 'Scorecard'], ['contract', 'Contract']];
    let view = views.some((v) => v[0] === hashParam('view')) ? hashParam('view') : 'missed';
    const body = h('div');
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' });
    const drawSeg = () => clear(seg).append(...views.map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(view === k), onclick: () => { view = k; setParam('view', k); drawSeg(); show(); } }, t)));
    const show = () => { clear(body); return ({ missed: missedView, scorecard: scorecardView, contract: contractView })[view](body); };
    drawSeg();
    el.append(h('div', { class: 'week-bar' }, seg), body);
    // Another view by address (#/bulk?tab=hauler&view=scorecard) while the tab is open.
    const onHash = () => { if (!el.isConnected) { window.removeEventListener('hashchange', onHash); return; } const v = hashParam('view'); if (hashParam('tab') === 'hauler' && v && v !== view && views.some((x) => x[0] === v)) { view = v; drawSeg(); show(); } };
    window.addEventListener('hashchange', onHash);
    await show();
  },
});

async function missedView(el) {
  let show = 'open';
  const pick = select([['open', 'Not collected yet'], ['all', 'Everything']], show, { 'aria-label': 'Show' });
  const body = h('div');
  pick.addEventListener('change', () => { show = pick.value; load(); });
  el.append(h('div', { class: 'row' }, pick), body);
  async function load() {
    clear(body).append(loading());
    let d;
    try { d = await get(`/solid-waste/hauler/missed?show=${show}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    appendAll(clear(body),
      d.not_sent.length ? h('section', { class: 'panel stack' }, h('h3', null, 'Not sent to the hauler yet'),
        table([{ head: 'Address', cell: (q) => q.address }, { head: 'Reported', cell: (q) => fmtDateTime(q.reported_at) }, { head: '', cell: (q) => button('Send to the hauler', async () => { try { const r = await post(`/solid-waste/hauler/missed/${q.request_id}/forward`); toast(r.sent ? 'Sent' : `Not sent: ${r.error}`, r.sent ? 'ok' : 'error'); await load(); } catch (err) { fail(err); } }, { small: true }) }], d.not_sent)) : null,
      d.forwards.length ? table([
        { head: 'Address', cell: (f) => h('a', { href: `#/requests/${f.request_id}` }, f.address) },
        { head: 'Reported', cell: (f) => fmtDateTime(f.reported_at) },
        { head: 'Due by', cell: (f) => fmtDateTime(f.due_at) },
        { head: 'Status', cell: (f) => (f.collected_at ? state(`Collected ${fmtDateTime(f.collected_at)}${f.late ? ', late' : ''}`, f.late ? 'warn' : 'good') : f.late ? state('Late', 'bad') : f.send_error ? state('Email not sent', 'bad') : state(f.opened ? 'Hauler opened it' : 'Sent', 'neutral')) },
        { head: '', cell: (f) => (f.collected_at ? (f.collected_note || '') : h('div', { class: 'row' },
          button('Mark collected', () => formDialog(`Collected: ${f.address}`, h('div', { class: 'form' }, field('When', input({ type: 'datetime-local', name: 'at', value: nowStamp().slice(0, 16) })), field('Note', input({ name: 'note', maxlength: 300, placeholder: 'For example: the hauler called' }))), async (fd) => {
            await post(`/solid-waste/hauler/forwards/${f.id}/collected`, { at: String(fd.get('at') || '') || undefined, note: String(fd.get('note') || '').trim() || undefined }); toast('Marked collected'); await load();
          }), { small: true }),
          button(f.link_expired ? 'Send a new link' : 'Send again', async () => { try { await post(`/solid-waste/hauler/missed/${f.request_id}/forward`); toast('Sent again with a new link'); await load(); } catch (err) { fail(err); } }, { small: true }))) },
      ], d.forwards) : empty(show === 'open' ? 'Nothing waiting with the hauler.' : 'No missed pickups sent to the hauler yet.'),
      h('p', { class: 'muted small' }, 'A missed pickup is emailed to the hauler with a link to mark it collected (no login). The email has the address only, never the resident\'s name or contact details. The link works for 30 days.'));
  }
  await load();
}

async function scorecardView(el) {
  const month = input({ type: 'month', value: todayStr().slice(0, 7), 'aria-label': 'Month' });
  const body = h('div');
  month.addEventListener('change', () => load());
  el.append(h('div', { class: 'row no-print rt-daybar' }, field('Month', month), button('Print', () => window.print(), { small: true })), body);
  async function load() {
    clear(body).append(loading());
    let s;
    try { s = await get(`/solid-waste/hauler/scorecard?month=${month.value}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    const c = s.contract;
    appendAll(clear(body),
      h('h3', null, `${c ? c.hauler_name : 'Hauler'}: ${new Date(`${s.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`),
      c ? h('p', { class: 'muted' }, `Service level: missed pickups collected within ${c.service_hours} hours.`) : h('p', { class: 'callout' }, 'Add the contract to measure against its service level (24 hours is used until then).'),
      h('div', { class: 'figures' },
        h('div', { class: 'figure' }, h('strong', null, String(s.missed)), h('span', null, 'missed pickups')),
        h('div', { class: 'figure' }, h('strong', null, s.on_time_rate === null ? '–' : `${s.on_time_rate}%`), h('span', null, 'collected on time')),
        h('div', { class: 'figure' }, h('strong', null, String(s.late + s.open_late)), h('span', null, 'late')),
        h('div', { class: 'figure' }, h('strong', null, s.hours_to_collect ? `${s.hours_to_collect.average} h` : '–'), h('span', null, 'average to collect'))),
      s.penalties ? h('p', null, h('b', null, 'Penalties: '), s.penalties.per_late_cents === null ? 'none in the contract' : `${s.penalties.counted} late after the first ${s.penalties.free} free, ${money(s.penalties.per_late_cents)} each = ${money(s.penalties.total_cents)}`) : null,
      s.contract_month_cents !== undefined && s.contract_month_cents !== null ? h('p', null, h('b', null, 'Contract this month: '), money(s.contract_month_cents)) : null,
      s.by_zone.length ? [h('h4', null, 'By zone'), table([{ head: 'Zone', cell: (z) => z.zone }, { head: 'Missed', num: true, cell: (z) => String(z.missed) }, { head: 'On time', num: true, cell: (z) => String(z.on_time) }, { head: 'Late', num: true, cell: (z) => String(z.late) }, { head: 'Open', num: true, cell: (z) => String(z.open) }], s.by_zone)] : null,
      s.by_week.length ? [h('h4', null, 'By week'), table([{ head: 'Week of', cell: (w) => fmtDate(w.week_of) }, { head: 'Missed', num: true, cell: (w) => String(w.missed) }, { head: 'On time', num: true, cell: (w) => String(w.on_time) }, { head: 'Late', num: true, cell: (w) => String(w.late) }], s.by_week)] : null,
      s.complaints.length ? [h('h4', null, 'Complaints by kind'), table([{ head: 'Kind', cell: (x) => x.kind }, { head: 'Count', num: true, cell: (x) => String(x.count) }], s.complaints)] : null);
  }
  await load();
}

async function contractView(el) {
  let d;
  try { d = await get('/solid-waste/hauler/contract'); } catch (err) { el.append(errorBox(err)); return; }
  const c = d.contract || {};
  const f = {
    hauler_name: input({ value: c.hauler_name || d.hauler.name || '', maxlength: 120, required: true }), starts_on: input({ type: 'date', value: c.starts_on || '', required: true }), ends_on: input({ type: 'date', value: c.ends_on || '' }),
    service_hours: input({ type: 'number', min: 1, max: 336, value: c.service_hours || 24 }), households: input({ type: 'number', min: 0, value: c.households ?? '' }),
    price: input({ type: 'number', min: 0, step: '0.01', value: centsToInput(c.price_per_household_cents) }), penalty: input({ type: 'number', min: 0, step: '0.01', value: centsToInput(c.penalty_cents) }),
    free: input({ type: 'number', min: 0, value: c.penalty_after ?? 0 }), terms: h('textarea', { rows: 6, maxlength: 8000 }, c.terms || ''),
  };
  if (!d.can_edit) Object.values(f).forEach((x) => { x.disabled = true; });
  appendAll(el,
    d.model !== 'contract' ? h('p', { class: 'callout' }, 'Who collects is set to the borough\'s own crew in Schedule. Missed pickups go to a hauler only when it is set to a contracted hauler.') : null,
    h('p', null, h('b', null, 'Hauler: '), [d.hauler.name, d.hauler.phone, d.hauler.email].filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'set in Schedule, Who collects')),
    h('section', { class: 'panel form' },
      field('Hauler', f.hauler_name), field('Contract starts', f.starts_on), field('Ends', f.ends_on), field('Missed pickups collected within (hours)', f.service_hours),
      field('Households served', f.households), ...(d.can_edit ? [field('Price a household a year ($)', f.price), field('Penalty a late missed pickup ($)', f.penalty), field('Late ones before penalties start', f.free)] : []),
      h('div', { class: 'wide' }, field('Other terms (for the renewal or rebid)', f.terms)),
      d.can_edit ? h('div', { class: 'wide' }, button('Save the contract', async () => {
        try {
          await put('/solid-waste/hauler/contract', { ...(c.id ? { id: c.id } : {}), hauler_name: f.hauler_name.value.trim(), starts_on: f.starts_on.value, ends_on: f.ends_on.value || null, service_hours: Number(f.service_hours.value) || 24,
            households: f.households.value === '' ? null : Number(f.households.value), price_per_household_cents: f.price.value === '' ? null : toCents(f.price.value), penalty_cents: f.penalty.value === '' ? null : toCents(f.penalty.value),
            penalty_after: Number(f.free.value) || 0, terms: f.terms.value.trim() || null });
          toast('Contract saved'); clear(el); contractView(el);
        } catch (err) { fail(err); }
      }, { kind: 'primary' })) : null));
}

// The crew's Today ("My work today") asks for this: their routes as a small section (views/today-muni.js).
export async function myRoutesSection() {
  if (!on('collectionroutes')) return null;
  let r;
  try { r = await get('/solid-waste/routes/today'); } catch (_) { return null; }
  if (!r.cards.length) return null;
  return h('section', { class: 'panel', dataset: { part: 'routes' } }, h('h2', null, 'Collection routes'),
    h('ul', { class: 'myday-list' }, r.cards.map((c) => h('li', null, h('a', { class: 'myday-item', href: c.href }, h('span', { class: 'myday-title' }, h('b', null, c.title)), h('span', { class: 'myday-meta muted small' }, c.text))))));
}
