// Patrol > Now > Sweep and Opening.
//
// Sweep: at closing the lead starts the sweep and gives each route to someone on duty. Each patroller taps the stops on
// their route as they sweep them, flags anything found (a person becomes a dispatch call in one tap) and marks the route
// clear. When every route is clear the lead calls the mountain clear, with the time.
// Opening: before a run opens, someone checks it (hazards marked, ropes and signs, padding) and opens it, holds it or
// keeps it closed with a reason. That sets the run on Mountain status.
import { get, post, patch, del } from '../api.js';
import { h, clear, select, input, field, button, toast, formDialog, empty, errorBox, state, fmtTime, label, act } from '../ui.js';

const t = (v) => (v ? fmtTime(String(v).replace(' ', 'T')) : '');
const FLAGS = [['none', 'Clear'], ['person', 'Person found'], ['hazard', 'Hazard'], ['rope', 'Rope or sign down'], ['other', 'Other']];

export async function drawSweep(box) {
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  let timer = null;
  async function load() {
    try { draw(await get('/patrol/sweep')); } catch (err) { clear(body).append(errorBox(err)); }
  }
  const tick = () => { if (!body.isConnected) { clearInterval(timer); return; } load(); };
  function draw(d) {
    const s = d.sweep;
    const head = h('div', { class: 'spread' },
      h('div', null, h('h2', null, s ? (s.status === 'clear' ? `Mountain clear at ${t(s.clear_at)}` : `Sweep running since ${t(s.started_at)}`) : 'Closing sweep'),
        h('p', { class: 'muted' }, s ? (s.status === 'clear' ? `Called by ${s.clear_by_name || 'the lead'}${s.clear_note ? `. ${s.clear_note}` : ''}.` : `${s.runs.filter((r) => r.status === 'clear').length} of ${s.runs.length} routes clear.`) : 'Start it at closing. Each route is given to someone on duty, who marks each stop as they sweep it.')),
      h('div', { class: 'row' }, d.can_run ? button('Routes', () => routesDialog(load), { small: true }) : null,
        d.can_run && !s ? button('Start the sweep', () => startDialog(d, load), { kind: 'primary' }) : null,
        d.can_run && s && s.status === 'running' ? button('Call the mountain clear', () => clearDialog(s, load), { kind: 'primary', small: true }) : null));
    const parts = [head];
    if (d.late) parts.push(h('p', { class: 'warn-note', role: 'alert' }, `Running late: routes not clear after ${d.late_minutes} minutes. Leads and the patrollers on those routes have been alerted.`));
    if (!s) {
      parts.push(d.routes.length ? h('ul', { class: 'duty-list' }, d.routes.map((r) => h('li', null, h('b', null, r.name), h('span', { class: 'muted' }, ` ${r.items.length} stop${r.items.length === 1 ? '' : 's'}${r.station ? `, from ${r.station}` : ''}`))))
        : empty(d.can_run ? 'No sweep routes yet. Set them up with Routes: each is a list of runs and lifts in the order they are swept.' : 'No sweep routes have been set up yet.'));
    } else {
      parts.push(h('div', { class: 'sweep-grid' }, s.runs.map((r) => runCard(d, s, r, load))));
    }
    clear(body).append(...parts);
  }
  await load();
  timer = setInterval(tick, 20000); // everyone's taps show up on the lead's screen
  if (timer && timer.unref) timer.unref();
}

function runCard(d, s, r, again) {
  const mine = d.me && r.staff_id === d.me;
  const can = s.status === 'running' && r.status !== 'clear' && (mine || d.can_run);
  const done = r.stops.filter((x) => x.mark).length;
  const assign = d.can_run && s.status === 'running' && r.status !== 'clear'
    ? select([['', 'Nobody yet'], ...d.on_duty.map((p) => [p.staff_id, `${p.name}${p.radio ? `, radio ${p.radio}` : ''}`])], r.staff_id || '', { 'aria-label': `Who sweeps ${r.route}` })
    : null;
  if (assign) assign.addEventListener('change', async () => { await patch(`/patrol/sweep/runs/${r.id}`, { staff_id: assign.value ? Number(assign.value) : null }); toast('Assigned'); await again(); });
  return h('section', { class: `panel sweep-card${r.status === 'clear' ? ' is-clear' : ''}${mine ? ' is-mine' : ''}` },
    h('div', { class: 'spread' }, h('h3', null, r.route), state(r.status === 'clear' ? `Clear ${t(r.cleared_at)}` : `${done} of ${r.stops.length}`, r.status === 'clear' ? 'good' : done ? 'warn' : 'neutral')),
    assign || h('p', { class: 'muted small' }, r.staff_name ? `Swept by ${r.staff_name}` : 'Not assigned'),
    h('ol', { class: 'sweep-stops' }, r.stops.map((x) => {
      const m = x.mark;
      return h('li', { class: m ? (m.flag === 'none' ? 'is-swept' : 'is-flag') : null },
        h('span', { class: 'stop-name' }, h('b', null, x.name), h('small', null, ` ${label(x.kind)}`)),
        m ? h('span', { class: 'stop-mark' }, `${t(m.swept_at)}${m.flag !== 'none' ? `: ${label(m.flag)}${m.note ? `, ${m.note}` : ''}` : ''}`,
          m.flag === 'person' && !m.call_id ? button('Call it in', async () => { const c = await post(`/patrol/sweep/marks/${m.id}/call`); toast(`Call ${c.call_no} on the dispatch board`); await again(); }, { small: true, kind: 'danger' }) : null,
          m.call_id ? h('a', { class: 'small', href: '#/patrol/dispatch' }, ' Dispatch call') : null,
          can && !m.call_id ? button('Undo', async () => { await del(`/patrol/sweep/runs/${r.id}/marks/${x.id}`); await again(); }, { small: true, kind: 'ghost', label: `Undo ${x.name}` }) : null)
          : can ? h('span', { class: 'row tight' },
            button('Swept', (e) => act(e.currentTarget, async () => { await post(`/patrol/sweep/runs/${r.id}/marks`, { item_id: x.id }); await again(); })(e), { small: true, kind: 'primary', label: `${x.name} swept` }),
            button('Found something', () => flagDialog(r, x, again), { small: true })) : h('span', { class: 'muted small' }, 'Not yet'));
    })),
    can && done === r.stops.length ? h('div', { class: 'row' }, button('Route clear', (e) => act(e.currentTarget, async () => { await post(`/patrol/sweep/runs/${r.id}/clear`, {}); toast(`${r.route} clear`); await again(); })(e), { kind: 'primary' })) : null);
}

function flagDialog(r, x, again) {
  const flag = select(FLAGS.filter((f) => f[0] !== 'none'), 'person', { name: 'flag' });
  formDialog(`Found at ${x.name}`, h('div', { class: 'form' }, field('What', flag), h('div', { class: 'wide' }, field('Details', input({ name: 'note', required: true, maxlength: 255, placeholder: 'Skier resting by the trail sign, says they are fine' })))), async (fd) => {
    await post(`/patrol/sweep/runs/${r.id}/marks`, { item_id: x.id, flag: fd.get('flag'), note: String(fd.get('note')).trim() });
    toast(fd.get('flag') === 'person' ? 'Recorded. Call it in from the route if they need help.' : 'Recorded');
    await again();
  }, { submitText: 'Record' });
}

function startDialog(d, again) {
  const picks = d.routes.map((r) => ({ r, sel: select([['', 'Assign later'], ...d.on_duty.map((p) => [p.staff_id, p.name])], '', { 'aria-label': r.name }) }));
  formDialog('Start the sweep', h('div', { class: 'stack' },
    d.on_duty.length ? null : h('p', { class: 'warn-note' }, 'Nobody is signed in on duty. You can start and assign routes as people sign in.'),
    ...picks.map(({ r, sel }) => field(`${r.name} (${r.items.length} stops)`, sel))), async () => {
    await post('/patrol/sweep/start', { assignments: picks.filter((p) => p.sel.value).map((p) => ({ route_id: p.r.id, staff_id: Number(p.sel.value) })) });
    toast('Sweep started. Patrollers with a route have been alerted.');
    await again();
  }, { submitText: 'Start sweep', wide: true });
}

function clearDialog(s, again) {
  const open = s.runs.filter((r) => r.status !== 'clear');
  if (open.length) { toast(`Not every route is clear: ${open.map((r) => r.route).join(', ')}`, 'error'); return; }
  formDialog('Call the mountain clear?', h('div', { class: 'stack' }, h('p', null, 'Every route is clear. This records the time, and signs out anyone still signed in on duty.'), field('Note', input({ name: 'note', maxlength: 255, placeholder: 'Optional' }))), async (fd) => {
    const r = await post('/patrol/sweep/clear', { note: String(fd.get('note') || '').trim() || null });
    toast(`Mountain clear at ${t(r.clear_at)}`);
    await again();
  }, { submitText: 'Mountain clear' });
}

/** Set up the sweep routes: a name, where it starts, and its stops in order. */
async function routesDialog(again) {
  const d = await get('/patrol/sweep/routes');
  const list = h('div', { class: 'stack' });
  const draw = () => clear(list).append(...d.data.map((r) => h('div', { class: 'spread panel' }, h('div', null, h('b', null, r.name), r.active ? null : h('span', { class: 'muted' }, ' (not in use)'), h('p', { class: 'muted small' }, r.items.map((i) => i.name).join(' → ') || 'No stops')),
    button('Edit', () => routeDialog(d, r, async () => { Object.assign(d, await get('/patrol/sweep/routes')); draw(); await again(); }), { small: true }))),
  button('Add a route', () => routeDialog(d, null, async () => { Object.assign(d, await get('/patrol/sweep/routes')); draw(); await again(); }), { kind: 'primary' }));
  draw();
  formDialog('Sweep routes', list, async () => {}, { submitText: 'Done', wide: true });
}

function routeDialog(d, r, done) {
  const stops = r ? r.items.map((i) => ({ trail_id: i.trail_id ? Number(i.trail_id) : undefined, lift_id: i.lift_id ? Number(i.lift_id) : undefined, label: i.trail_id || i.lift_id ? undefined : i.name, name: i.name })) : [];
  const listEl = h('ol', { class: 'sweep-stops' });
  const choose = select([['', 'Add a stop…'], ...d.trails.map((x) => [`t${x.id}`, `Run: ${x.name}`]), ...d.lifts.map((x) => [`l${x.id}`, `Lift: ${x.name}`]), ['place', 'A named place…']], '', { 'aria-label': 'Add a stop' });
  const draw = () => clear(listEl).append(...stops.map((x, i) => h('li', null, h('span', { class: 'stop-name' }, x.name), h('span', { class: 'row tight' },
    i ? button('↑', () => { [stops[i - 1], stops[i]] = [stops[i], stops[i - 1]]; draw(); }, { small: true, label: `Move ${x.name} up` }) : null,
    button('Remove', () => { stops.splice(i, 1); draw(); }, { small: true, kind: 'ghost', label: `Remove ${x.name}` })))));
  choose.addEventListener('change', () => {
    const v = choose.value; choose.value = '';
    if (!v) return;
    if (v === 'place') { const name = prompt('Name of the place (for example "Summit lodge deck")'); if (name && name.trim()) stops.push({ label: name.trim().slice(0, 100), name: name.trim() }); }
    else if (v[0] === 't') { const x = d.trails.find((y) => `t${y.id}` === v); stops.push({ trail_id: Number(x.id), name: x.name }); }
    else { const x = d.lifts.find((y) => `l${y.id}` === v); stops.push({ lift_id: Number(x.id), name: x.name }); }
    draw();
  });
  draw();
  const active = h('input', { type: 'checkbox', name: 'active', checked: r ? r.active : true });
  formDialog(r ? `Route: ${r.name}` : 'Add a sweep route', h('div', { class: 'stack' },
    h('div', { class: 'form' }, field('Name', input({ name: 'name', required: true, maxlength: 100, value: r ? r.name : '', placeholder: 'For example "North side"' })),
      field('Starts from', select([['', 'No station'], ...d.stations.map((s) => [s.id, s.name])], r && r.station_id ? r.station_id : '', { name: 'station_id' }))),
    h('h3', null, 'Stops, in sweep order'), listEl, choose,
    r ? h('label', { class: 'check' }, active, ' In use') : null), async (fd) => {
    if (!stops.length) throw new Error('Add at least one stop');
    const body = { name: String(fd.get('name')).trim(), station_id: fd.get('station_id') ? Number(fd.get('station_id')) : null, items: stops.map(({ trail_id, lift_id, label: l }) => ({ trail_id, lift_id, label: l })) };
    if (r) await patch(`/patrol/sweep/routes/${r.id}`, { ...body, active: active.checked }); else await post('/patrol/sweep/routes', body);
    toast('Route saved');
    await done();
  }, { submitText: 'Save route', wide: true });
}

// ================================================================ opening checks
export async function drawOpening(box) {
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  async function load() {
    try { draw(await get('/patrol/opening')); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(d) {
    const checked = d.data.filter((x) => x.check).length;
    const tone = { open: 'good', hold: 'warn', closed: 'bad' };
    clear(body).append(
      h('div', null, h('h2', null, 'Opening checks'), h('p', { class: 'muted' }, `${checked} of ${d.data.length} runs checked today. Opening a run here needs each check ticked; holding or closing it needs a reason. Mountain status updates at once.`)),
      d.data.length ? h('div', { class: 'open-list' }, d.data.map((tr) => h('div', { class: 'open-row panel' },
        h('div', null, h('b', null, tr.name), ' ', state(label(tr.status), tone[tr.status]),
          tr.closure_reason ? h('span', { class: 'muted small' }, ` ${tr.closure_reason}`) : null,
          h('p', { class: 'muted small' }, tr.check ? `Checked ${t(tr.check.checked_at)}${tr.check.by_name ? ` by ${tr.check.by_name}` : ''}: ${label(tr.check.decision)}${tr.check.hazards ? `. ${tr.check.hazards}` : ''}` : 'Not checked today'),
          tr.spot_checks.length ? h('p', { class: 'muted small' }, `Spot checks: ${tr.spot_checks.map((c) => `${t(c.checked_at)} ${c.hazards || 'clear'}`).join('; ')}`) : null),
        d.can_check ? h('div', { class: 'row tight' },
          button(tr.check ? 'Check again' : 'Check', () => checkDialog(tr, load), { small: true, kind: tr.check ? null : 'primary' }),
          button('Spot check', () => spotDialog(tr, load), { small: true, kind: 'ghost' }),
          tr.status === 'open' ? button('Hold or close', () => statusDialog(tr, null, load), { small: true, kind: 'ghost' }) : tr.check && tr.check.decision === 'open' ? null : d.can_override ? button('Open without a check', () => statusDialog(tr, 'open', load), { small: true, kind: 'ghost' }) : null) : null)))
        : empty('No runs yet. Add them on Mountain status.'));
  }
  await load();
}

function checkDialog(tr, again) {
  const boxes = [['hazards_marked', 'Hazards marked (bamboo, discs, closures)'], ['ropes_signs', 'Rope lines and signs in place'], ['padding', 'Lift towers, snowmaking and obstacles padded']];
  const decision = select([['open', 'Open the run'], ['hold', 'Hold (opening later)'], ['closed', 'Keep closed']], 'open', { name: 'decision' });
  formDialog(`Opening check: ${tr.name}`, h('div', { class: 'stack' },
    ...boxes.map(([k, text]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: k }), ` ${text}`)),
    field('Hazards found', input({ name: 'hazards', maxlength: 500, placeholder: 'Leave blank if none' })),
    h('div', { class: 'form' }, field('Decision', decision), field('Reason (hold or closed)', input({ name: 'reason', maxlength: 200, placeholder: 'Thin cover at the cat track' })))), async (fd) => {
    await post('/patrol/opening', { trail_id: tr.id, hazards_marked: Boolean(fd.get('hazards_marked')), ropes_signs: Boolean(fd.get('ropes_signs')), padding: Boolean(fd.get('padding')), hazards: String(fd.get('hazards') || '').trim() || null, decision: fd.get('decision'), reason: String(fd.get('reason') || '').trim() || null });
    toast(`${tr.name}: ${label(fd.get('decision'))}`);
    await again();
  }, { submitText: 'Save check' });
}

function spotDialog(tr, again) {
  formDialog(`Spot check: ${tr.name}`, field('Hazards found', input({ name: 'hazards', maxlength: 500, placeholder: 'Leave blank if clear' })), async (fd) => {
    await post('/patrol/trail-checks', { trail_id: tr.id, hazards: String(fd.get('hazards') || '').trim() || undefined });
    toast('Spot check recorded'); await again();
  });
}

function statusDialog(tr, fixed, again) {
  const status = fixed ? null : select([['hold', 'Hold'], ['closed', 'Close']], 'hold', { name: 'status' });
  formDialog(fixed === 'open' ? `Open ${tr.name} without a check?` : `Hold or close ${tr.name}`, h('div', { class: 'form' },
    status ? field('Status', status) : h('p', { class: 'wide warn-note' }, 'It has not had an opening check today. Your reason is kept in the audit log.'),
    h('div', { class: 'wide' }, field(fixed === 'open' ? 'Why it can open without a check' : 'Reason', input({ name: 'reason', required: true, maxlength: 200 })))), async (fd) => {
    const reason = String(fd.get('reason')).trim();
    await post(`/patrol/trails/${tr.id}/status`, fixed === 'open' ? { status: 'open', override_reason: reason } : { status: fd.get('status'), reason });
    toast('Run status changed'); await again();
  }, { submitText: 'Save' });
}
