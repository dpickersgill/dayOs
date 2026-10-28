import { get, poll, put, post, patch, del } from '../api.js';
import { icon } from '../icons.js';
import { ctx, h, svg, can, clear, money, state, input, field, select, button, todayStr, fmtDate, fmtDateLong, fmtTime, fmtDateTime, label, empty, errorBox, loading, toast, fail, isManager, confirmDialog } from '../ui.js';

const ROLES = [['counter', 'Counter'], ['instructor', 'Instructors'], ['patrol', 'Patrol'], ['staff', 'Staff'], ['manager', 'Managers and owners']];

export async function render(root) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Day' });
  const alertsBox = h('div', { class: 'board-alerts' });
  const grid = h('div', { class: 'board-grid' });
  const bar = h('div', { class: 'actions' });
  const editBar = h('div', { class: 'board-edit', hidden: true });
  const wallHost = h('div', { class: 'board-host' }, alertsBox, grid);
  const scoreHost = h('div', { class: 'docscore-host', hidden: true });
  const jobsHost = h('div', { class: 'jobs-host' });
  root.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Today'), h('p', { class: 'muted', id: 'dash-sub' })), bar),
    jobsHost, editBar, scoreHost, wallHost);
  if (!isManager()) jobButtons(jobsHost);
  docScoreCard(scoreHost);

  let board = null; // last answer from /board
  let editing = null; // working list of tile keys while customizing
  let wall = false; let timer = null;

  const dayField = isManager() ? field('Day', date) : null;
  const customize = button('Customize', () => startEdit(), { small: true });
  const wallBtn = button('Wall screen', () => toggleWall(true), { small: true });
  bar.append(...[dayField, customize, wallBtn].filter(Boolean));

  async function load(quiet, timed) { // timed: the wall screen's own refresh, which is not someone using the app
    if (!quiet) clear(grid).append(loading());
    try {
      board = await (timed ? poll : get)(`/board${isManager() && date.value && date.value !== todayStr() ? `?date=${date.value}` : ''}`);
      root.querySelector('#dash-sub').textContent = fmtDateLong(board.date);
      draw();
    } catch (err) { clear(grid).append(errorBox(err)); }
  }

  function draw() {
    clear(alertsBox).append(...alertList(board.alerts));
    clear(grid);
    const keys = editing || board.layout.tiles;
    if (!keys.length) grid.append(empty(editing ? 'No tiles yet. Add one below.' : 'Nothing on your board. Press Customize to choose tiles.'));
    keys.forEach((key, i) => {
      const tile = TILES[key];
      const meta = board.catalog.find((c) => c.key === key);
      if (!tile || !meta) return;
      const body = board.data[key] ? tile(board.data[key], board, () => load(true)) : h('p', { class: 'muted' }, 'Appears after you save.');
      const head = h('header', null, h('h2', null, meta.label), editing ? h('span', { class: 'bd-tools' },
        iconBtn('Move up', '↑', () => move(i, -1), i === 0), iconBtn('Move down', '↓', () => move(i, 1), i === keys.length - 1), iconBtn(`Remove ${meta.label}`, '×', () => { editing.splice(i, 1); draw(); drawEdit(); })) : null);
      grid.append(h('section', { class: `bd-tile bd-${key}` }, head, body));
    });
  }
  const iconBtn = (text, glyph, fn, off) => { const b = h('button', { type: 'button', class: 'btn small icon', 'aria-label': text, title: text }, glyph); if (off) b.disabled = true; b.addEventListener('click', fn); return b; };
  const move = (i, d) => { const k = editing.splice(i, 1)[0]; editing.splice(i + d, 0, k); draw(); drawEdit(); };

  // ------------------------------------------------------------ customizing
  function startEdit() { editing = [...board.layout.tiles]; editBar.hidden = false; customize.hidden = true; draw(); drawEdit(); }
  function stopEdit() { editing = null; editBar.hidden = true; customize.hidden = false; draw(); }
  function drawEdit() {
    clear(editBar);
    const spare = board.catalog.filter((c) => !editing.includes(c.key));
    const roleSel = select(ROLES, board.role === 'owner' ? 'manager' : board.role, { 'aria-label': 'Role to set the default for' });
    editBar.append(
      h('div', { class: 'stack tight' },
        h('p', null, h('b', null, 'Customizing your board. '), 'Use the arrows on a tile to move it, or × to take it off.'),
        spare.length ? h('div', { class: 'row wrap' }, h('span', { class: 'muted' }, 'Add:'), spare.map((c) => button(`+ ${c.label}`, () => { editing.push(c.key); draw(); drawEdit(); }, { small: true }))) : h('p', { class: 'muted' }, 'Every tile available to you is on the board.'),
        h('div', { class: 'row wrap' },
          button('Save', async () => { await put('/board/layout', { tiles: editing }); toast('Board saved'); editing = null; editBar.hidden = true; customize.hidden = false; await load(true); }, { kind: 'primary', small: true }),
          button('Cancel', () => stopEdit(), { small: true }),
          button('Back to the standard board', () => confirmDialog('Back to the standard board', 'This drops your own choices and uses the default for your role.', 'Reset', async () => { await del('/board/layout'); toast('Board reset'); editing = null; editBar.hidden = true; customize.hidden = false; await load(true); }), { small: true }),
          board.can_set_default ? h('span', { class: 'row wrap grow-end' }, h('label', { class: 'muted' }, 'Make this the default for'), roleSel,
            button('Set default', async () => { await put(`/board/layout/role/${roleSel.value}`, { tiles: editing }); toast('Default saved for that role. People who chose their own tiles keep them.'); }, { small: true }),
            button('Clear default', async () => { await del(`/board/layout/role/${roleSel.value}`); toast('Default cleared for that role'); }, { small: true })) : null)));
  }

  // ------------------------------------------------------------ wall screen
  function toggleWall(on) {
    wall = on; root.classList.toggle('wall', on);
    clearInterval(timer);
    if (on) {
      timer = setInterval(() => { if (!root.isConnected) { clearInterval(timer); return; } load(true, true); }, 60000);
      if (wallHost.requestFullscreen) wallHost.requestFullscreen().catch(() => {});
      wallHost.prepend(h('button', { type: 'button', class: 'btn small wall-exit', onclick: () => { if (document.fullscreenElement) document.exitFullscreen(); toggleWall(false); } }, 'Close wall screen'));
    } else wallHost.querySelectorAll('.wall-exit').forEach((b) => b.remove());
  }
  document.addEventListener('fullscreenchange', () => { if (wall && !document.fullscreenElement) toggleWall(false); });

  date.addEventListener('change', () => date.value && load());
  await load();
}

// ------------------------------------------------------------------ job buttons (everyone but managers)
// Big, labeled buttons for the work of the day, straight to the screen that does it. Only apps this person may open.
const ALWAYS_ON = ['dashboard', 'inbox', 'people', 'waivers', 'lostfound', 'myshifts'];
const appOn = (key) => ALWAYS_ON.includes(key) || !ctx.me || !ctx.me.modules || ctx.me.modules.includes(key);
const MAY = { sell: () => can('counter'), shop: () => can('counter'), gate: () => can('counter', 'staff'), conditions: () => can('patrol', 'staff'), lostfound: () => can('counter', 'staff'),
  school: () => can('instructor', 'counter'), availability: () => can('instructor', 'counter'), patrol: () => can('patrol') };
export const mayOpen = (key) => appOn(key) && Boolean(MAY[key] && MAY[key]());
const JOB_ICON = { check: 'M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10', alert: 'M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' };
const jobIcon = (name) => (JOB_ICON[name] ? svg('svg', { class: 'ico', width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: JOB_ICON[name] })) : icon(name, 28));
const JOBS = {
  staff: [
    { app: 'conditions', act: 'opening-check', label: 'Opening check', note: 'Lift inspections before opening', href: '#/conditions?tab=maint&sub=checks', icon: 'check' },
    { app: 'gate', act: 'scan', label: 'Scan tickets', note: 'Check tickets and cards', href: '#/gate', icon: 'gate' },
    { app: 'conditions', act: 'work-order', label: 'Report a problem', note: 'A work order for maintenance', href: '#/conditions/wo/new', icon: 'alert' },
    { app: 'lostfound', act: 'lost-found', label: 'Lost and found', note: 'Log something handed in', href: '#/lostfound', icon: 'lostfound' },
  ],
  instructor: [
    { app: 'school', act: 'lessons', label: 'Today\'s lessons', note: 'Who you teach, and where to meet', href: '#/school?tab=today', icon: 'school' },
    { app: 'availability', act: 'availability', label: 'My availability', note: 'Mark the days you can teach', href: '#/availability', icon: 'availability' },
  ],
  counter: [
    { app: 'sell', act: 'sell', label: 'Sell', note: 'Tickets, lessons, rentals and gift cards', href: '#/sell', icon: 'sell' },
    { app: 'shop', act: 'will-call', label: 'Will-call pickups', note: 'Hand over online orders', href: '#/shop?tab=willcall', icon: 'shop' },
  ],
  patrol: [
    { app: 'patrol', act: 'on-duty', label: 'On duty', note: 'Sign in for your shift and see who is on', href: '#/patrol/now?tab=duty', icon: 'patrol' },
    { app: 'patrol', act: 'new-case', label: 'New case', note: 'Start a patient report', href: '#/patrol/new', icon: 'plus', needs: 'create_case' },
  ],
};
/** The job buttons for this person: their role's, plus patrol's for a staff member who is also on patrol. */
export function jobsFor(me) {
  if (!me || ['owner', 'manager', 'area'].includes(me.role)) return [];
  const list = [...(JOBS[me.role] || []), ...(me.role !== 'patrol' && me.on_patrol ? JOBS.patrol : [])];
  return list.filter((j) => mayOpen(j.app));
}
async function jobButtons(host) {
  let jobs = jobsFor(ctx.me);
  if (!jobs.length) return;
  // New case only for patrollers whose access level can start one (a Host cannot).
  if (jobs.some((j) => j.needs)) {
    let features = [];
    try { features = (await get('/patrol/me')).features || []; } catch (_) { /* no patrol access: no New case */ }
    jobs = jobs.filter((j) => !j.needs || features.includes(j.needs));
  }
  clear(host).append(h('nav', { class: 'today-jobs', 'aria-label': 'Your work today' },
    ...jobs.map((j, i) => h('a', { class: `job-btn${i === 0 ? ' is-first' : ''}`, href: j.href, 'data-job': j.act },
      jobIcon(j.icon), h('span', { class: 'job-text' }, h('strong', null, j.label), h('span', null, j.note))))));
}

// ------------------------------------------------------------------ patrol documentation score (owners, managers, patrol admins)
// Hidden for anyone the server says no to, and when Patrol is off.
async function docScoreCard(host) {
  if (!(isManager() || (ctx.me && (ctx.me.role === 'patrol' || ctx.me.on_patrol)))) return;
  let s;
  try { s = await get('/patrol/doc-score?brief=1'); } catch (_) { return; }
  const tone = (n) => (n === null || n === undefined ? 'neutral' : n >= 90 ? 'good' : n >= 70 ? 'warn' : 'bad');
  const cell = (big, small, href, kind) => h('a', { class: `ds-cell${kind ? ` is-${kind}` : ''}`, href }, h('b', null, big), h('span', null, small));
  clear(host).append(h('section', { class: 'docscore-card', 'aria-label': 'Patrol documentation' },
    h('div', { class: 'ds-head' }, h('b', null, 'Patrol documentation'), h('span', { class: 'muted' }, `Season ${s.season} · ${s.reports} ${s.reports === 1 ? 'report' : 'reports'} signed off`), h('a', { href: '#/patrol/cases?tab=risk', class: 'ds-more' }, 'Risk report')),
    h('div', { class: 'ds-row' },
      cell(s.score === null ? '–' : `${s.score}%`, 'Documentation score', '#/patrol/cases?tab=risk', tone(s.score)),
      cell(s.on_time_pct === null ? '–' : `${s.on_time_pct}%`, 'Signed off within 24 hours', '#/patrol/cases?tab=risk', s.on_time_pct === null ? null : s.on_time_pct >= 90 ? 'good' : 'warn'),
      cell(String(s.reviews_overdue), 'Reviews overdue', '#/patrol/cases?tab=review', s.reviews_overdue ? 'warn' : 'good'),
      cell(s.red_flags ? `${s.red_flags_management}/${s.red_flags}` : '0', 'Red-flag cases with management told', '#/patrol/cases?tab=risk', s.red_flags && s.red_flags_management < s.red_flags ? 'bad' : null))));
  host.hidden = false;
}

// ------------------------------------------------------------------ the band at the top
function alertList(alerts) {
  if (!alerts.length) return [h('p', { class: 'board-clear' }, state('Nothing needs attention right now', 'good'))];
  return alerts.map((a) => h('a', { class: `board-alert ${a.level}`, href: `#/${a.link}` },
    h('span', { class: 'ba-tag' }, { stop: 'Blocks opening', warn: 'Needs a look', info: 'Waiting' }[a.level]), h('span', null, a.text)));
}

// ------------------------------------------------------------------ tiles
const link = (text, key) => h('a', { href: `#/${key}` }, text);
const big = (n, text, sub) => h('div', { class: 'figure' }, h('strong', null, String(n)), h('span', null, text), sub ? h('em', null, sub) : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const LIFT = { open: ['Open', 'good'], hold: ['On hold', 'warn'], wind_hold: ['Wind hold', 'warn'], closed: ['Closed', 'neutral'] };

// The morning board: one dark card with every lift and why, patrol's opening, grooming, machines due, and three numbers.
const SHAPE = { good: '<circle cx="6" cy="6" r="5"/>', warn: '<rect x="1" y="1" width="10" height="10"/>', bad: '<path d="M6 0.5 L11.5 6 L6 11.5 L0.5 6 Z"/>', neutral: '<circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' };
function chip(text, kind) {
  const c = h('span', { class: `mb-chip ${kind}` });
  c.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" fill="currentColor">${SHAPE[kind] || SHAPE.neutral}</svg>`;
  c.append(text);
  return c;
}
const mbRow = (name, detail, chipEl) => h('div', { class: 'mb-row' }, h('div', null, h('div', { class: 'mb-n' }, name), detail ? h('div', { class: 'mb-d' }, detail) : null), chipEl || h('span'));
const mbHead = (text, href) => h('div', { class: 'mb-t' }, href ? h('a', { href: `#/${href}` }, text) : text);
function serviceWhen(f) {
  if (f.hours_left !== null && f.hours_left !== undefined) return f.hours_left <= 0 ? `${f.task}: ${Math.abs(f.hours_left)} hours overdue` : `${f.task} due in ${f.hours_left} hours`;
  if (f.miles_left !== null && f.miles_left !== undefined) return f.miles_left <= 0 ? `${f.task}: ${Math.abs(f.miles_left)} miles overdue` : `${f.task} due in ${f.miles_left} miles`;
  return f.due_on ? `${f.task} ${f.state === 'overdue' ? 'overdue since' : 'due'} ${fmtDate(`${f.due_on}T12:00:00`)}` : f.task;
}

const TILES = {
  morning: (d) => {
    const LIFTCHIP = { open: ['Open', 'good'], hold: ['On hold', 'warn'], wind_hold: ['Wind hold', 'warn'], closed: ['Closed', 'neutral'] };
    const liftCol = [mbHead('Lifts', 'conditions')];
    if (!d.lifts.length) liftCol.push(mbRow('No lifts set up yet', null, null));
    for (const l of d.lifts) {
      const [t, k] = l.check === 'fail' ? ['Cannot open', 'bad'] : LIFTCHIP[l.status] || [label(l.status), 'neutral'];
      liftCol.push(mbRow(l.name, l.detail, chip(t, k)));
    }
    const parts = [];
    if (d.patrol) {
      const p = d.patrol; const done = p.trails && p.checked >= p.trails;
      parts.push(mbHead('Patrol', 'patrol'));
      parts.push(mbRow(`${p.on_duty} on duty, ${p.checked} of ${p.trails} runs checked`,
        p.holds.length ? `${p.holds.map((x) => `${x.name} on hold${x.reason ? `: ${x.reason}` : ''}`).join('; ')}` : (done ? 'Every run checked today' : null),
        chip(p.holds.length ? `${p.holds.length} on hold` : done ? 'Checked' : p.checked ? 'Opening' : 'Not started', p.holds.length ? 'warn' : done ? 'good' : 'warn')));
    }
    const g = d.grooming; const planned = Object.values(g.plan || {}).reduce((a, b) => a + b, 0);
    parts.push(mbHead('Grooming', 'conditions'));
    if (planned) {
      const left = (g.plan.planned || 0) + (g.plan.in_progress || 0);
      parts.push(mbRow(`${g.plan.done || 0} of ${planned} trails groomed`, left ? `${left} still to do${g.plan.in_progress ? `, ${g.plan.in_progress} in progress` : ''}` : `${g.open} of ${g.total} trails open`, chip(left ? 'In progress' : 'Done', left ? 'warn' : 'good')));
    } else parts.push(mbRow(`${g.open} of ${g.total} trails open`, 'No grooming plan for today', null));
    if (d.fleet && (d.fleet.due.length || d.fleet.out_of_service)) {
      parts.push(mbHead('Fleet and service', 'assets'));
      for (const f of d.fleet.due) parts.push(mbRow(f.name, serviceWhen(f), chip(f.state === 'overdue' ? 'Overdue' : 'Service soon', f.state === 'overdue' ? 'bad' : 'warn')));
      const more = d.fleet.due_count - d.fleet.due.length;
      if (more > 0 || d.fleet.out_of_service) parts.push(mbRow([more > 0 ? `${more} more due for service` : null, d.fleet.out_of_service ? `${d.fleet.out_of_service} out of service` : null].filter(Boolean).join(', '), null, null));
    }
    const nums = [
      d.counts.unfilled !== undefined ? [d.counts.unfilled, d.counts.unfilled === 1 ? 'shift still unfilled today' : 'shifts still unfilled today', 'workforce'] : null,
      [d.counts.open_orders, d.counts.open_orders === 1 ? 'open work order' : 'open work orders', 'conditions'],
      d.counts.incidents !== undefined ? [d.counts.incidents, d.counts.incidents === 1 ? 'incident open' : 'incidents open', 'patrol'] : null,
    ].filter(Boolean);
    return h('div', { class: 'mboard' },
      h('div', { class: 'mb-h' }, h('b', null, 'Morning board'), h('span', null, d.as_of ? `As of ${fmtTime(String(d.as_of).replace(' ', 'T'))}` : '')),
      h('div', { class: 'mb-s' }, h('div', { class: 'mb-col' }, ...liftCol), h('div', { class: 'mb-col' }, ...parts)),
      h('div', { class: 'mb-foot', style: `grid-template-columns:repeat(${nums.length},1fr)` }, ...nums.map(([n, t, href]) => h('a', { href: `#/${href}` }, h('b', null, String(n)), h('span', null, t)))));
  },
  lifts: (d) => {
    if (!d.lifts.length) return empty('No lifts set up yet.', link('Add lifts', 'conditions'));
    return h('ul', { class: 'bd-list' }, d.lifts.map((l) => {
      const [text, kind] = l.check === 'fail' ? ['Cannot open', 'bad'] : LIFT[l.status] || [label(l.status), 'neutral'];
      return h('li', null, h('span', null, h('b', null, l.name), l.check === 'fail' ? h('small', null, ' failed inspection') : l.check === 'pass' ? h('small', null, ' inspected') : null), state(text, kind));
    }));
  },
  trails: (d) => {
    const plan = d.plan; const planned = Object.values(plan).reduce((a, b) => a + b, 0);
    return h('div', { class: 'stack tight' },
      h('div', { class: 'figures' }, big(`${d.open} of ${d.total}`, 'trails open'), big(d.groomed, 'groomed')),
      planned ? h('p', null, `Tonight's plan: ${plan.done || 0} done, ${plan.in_progress || 0} in progress, ${plan.planned || 0} still to do`, plan.skipped ? `, ${plan.skipped} skipped` : '', '. ', link('Grooming', 'conditions')) : h('p', { class: 'muted' }, 'No grooming plan for today.'));
  },
  snow: (d) => {
    const r = d.reading; const w = d.weather;
    if (!r && !w) return empty('No readings yet.', link('Log one', 'conditions'));
    return h('div', { class: 'stack tight' },
      r ? h('p', null, h('b', null, `${r.base_in ?? '–'} in base`), r.new_snow_in ? `, ${r.new_snow_in} in new` : '', r.surface ? `, ${label(r.surface)}` : '', h('small', { class: 'muted' }, ` (${fmtDateTime(r.read_at)})`)) : null,
      w ? h('p', null, [w.temp_f !== null ? `${Math.round(w.temp_f)}°F` : null, w.wind_mph !== null ? `wind ${w.wind_mph} mph${w.wind_dir ? ` ${w.wind_dir}` : ''}${w.gust_mph ? `, gusts ${w.gust_mph}` : ''}` : null, w.sky ? label(w.sky) : null].filter(Boolean).join(', '), h('small', { class: 'muted' }, ` at ${w.place}, ${fmtTime(w.logged_at)}`)) : null);
  },
  maintenance: (d) => {
    if (!d.open) return h('p', null, state('No open work orders', 'good'));
    return h('div', { class: 'stack tight' },
      h('p', null, `${plural(d.open, 'open work order')}`, d.urgent ? `, ${d.urgent} urgent` : '', d.high ? `, ${d.high} high priority` : '', '. ', link('See all', 'conditions')),
      d.top.length ? h('ul', { class: 'bd-list' }, d.top.map((w) => h('li', null, h('span', null, w.title), state(label(w.priority), w.priority === 'urgent' ? 'bad' : 'warn')))) : null);
  },
  gate: (d) => h('div', { class: 'figures' }, big(d.guests, 'guests scanned')),
  sales: (d) => h('div', { class: 'stack tight' },
    h('div', { class: 'figures' }, big(money(d.revenue_cents), 'sold', plural(d.orders, 'order')), big(d.guests_scanned, 'guests scanned')),
    d.refunds_cents ? h('p', { class: 'muted' }, `${money(d.refunds_cents)} refunded`) : null,
    d.top_products.length ? h('ul', { class: 'bd-list' }, d.top_products.map((p) => h('li', null, h('span', null, p.name), h('b', null, `${p.units}`)))) : h('p', { class: 'muted' }, 'No sales yet for this day. ', link('Sell a ticket', 'sell'))),
  rentals: (d) => h('div', { class: 'stack tight' },
    h('div', { class: 'figures' }, big(d.out, 'out now'), big(d.overdue, 'overdue'), big(d.due_soon, 'due in 2 hours')),
    d.reservations_today ? h('p', null, `${plural(d.reservations_today, 'reservation')} to pick up today. `, link('Open Rentals', 'rentals')) : link('Open Rentals', 'rentals')),
  lessons: (d) => h('div', { class: 'stack tight' },
    d.sessions.length ? h('ul', { class: 'bd-list' }, d.sessions.map((s) => h('li', null, h('span', null, h('b', null, fmtTime(s.starts_at)), ` ${s.name}`, h('small', { class: 'muted' }, ` ${label(s.discipline)}, ${label(s.ability_level)}`)),
      state(`${s.booked} of ${s.capacity}`, s.booked >= s.capacity ? 'warn' : 'neutral')))) : h('p', { class: 'muted' }, 'No lessons scheduled.'),
    d.pending_requests ? h('p', null, plural(d.pending_requests, 'online request'), ' waiting. ', link('Answer them', 'school')) : null),
  staffing: (d) => h('div', { class: 'stack tight' },
    h('div', { class: 'figures' }, big(d.shifts, 'shifts today'), big(d.unfilled.length, 'unfilled'), big(d.clocked_in, 'clocked in')),
    d.unfilled.length ? h('ul', { class: 'bd-list' }, d.unfilled.map((s) => h('li', null, h('span', null, s.position), h('span', { class: 'muted' }, `${fmtTime(s.starts_at)} to ${fmtTime(s.ends_at)}`)))) : null,
    d.unfilled.length ? link('Fill them', 'workforce') : null),
  certs: (d) => (d.list.length ? h('ul', { class: 'bd-list' }, d.list.map((c) => h('li', null, h('span', null, h('b', null, c.name), ` ${c.certification}`), state(c.overdue ? `Expired ${fmtDate(c.expires_on)}` : fmtDate(c.expires_on), c.overdue ? 'bad' : 'warn')))) : h('p', null, state('Nothing expires in the next 30 days', 'good'))),
  patrol: (d) => h('div', { class: 'stack tight' },
    h('div', { class: 'figures' }, big(d.active_calls, 'active calls'), big(d.open_incidents, 'open incidents')),
    d.recent.length ? h('ul', { class: 'bd-list' }, d.recent.map((i) => h('li', null, h('span', null, `${label(i.category)} at ${i.location}`), state(label(i.severity), i.severity === 'critical' || i.severity === 'serious' ? 'bad' : 'neutral')))) : h('p', null, state('No open incidents', 'good')),
    link('Open Patrol', 'patrol')),
  notes: (d, board, reload) => {
    const text = input({ placeholder: 'Leave a note for the next shift', maxlength: 1000, 'aria-label': 'New shift note' });
    const form = h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); if (!text.value.trim()) return; try { await post('/board/notes', { body: text.value.trim() }); text.value = ''; reload(); } catch (err) { fail(err); } } },
      text, h('button', { type: 'submit', class: 'btn small' }, 'Add'));
    const list = d.notes.length ? h('ul', { class: 'notes' }, d.notes.map((n) => h('li', { class: n.pinned ? 'pinned' : '' },
      h('p', null, n.body),
      h('small', { class: 'muted' }, `${n.pinned ? 'Pinned. ' : ''}${n.author || 'Someone'}, ${fmtDateTime(n.created_at)} `),
      board.can_set_default ? h('button', { type: 'button', class: 'linklike', onclick: async () => { try { await patch(`/board/notes/${n.id}`, { pinned: !n.pinned }); reload(); } catch (err) { fail(err); } } }, n.pinned ? 'Unpin' : 'Pin') : null,
      n.mine || board.can_set_default ? h('button', { type: 'button', class: 'linklike', onclick: async () => { try { await del(`/board/notes/${n.id}`); reload(); } catch (err) { fail(err); } } }, 'Remove') : null))) : h('p', { class: 'muted' }, 'No notes yet.');
    return h('div', { class: 'stack tight' }, form, list);
  },
};
