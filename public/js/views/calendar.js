// The Mountain calendar (2026.11.10): what is happening at the mountain, for every staff member. Three views (a list of
// the next 14 days, a week and a month), filters by team and kind, events people add, and a private link that puts the
// calendar in a phone's own calendar app. The server (routes/mountaincal.js) only ever sends what this person may see.
// The view and the day in view live in the address (#/calendar?view=month&day=2026-12-01), so Back and a shared link work.
import { get, post, patch, del } from '../api.js';
import { h, clear, ctx, can, isManager, schoolCan, button, field, input, select, dialog, formDialog, confirmDialog, toast, errorBox, empty, loading, todayStr, addDays, fmtDate, fmtDateLong, fmtDay, hashParam, withHashParam, val } from '../ui.js';
import { icon } from '../icons.js';

const VIEWS = [['list', 'Next 14 days'], ['week', 'Week'], ['month', 'Month']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KIND_KEY = 'so.cal.kinds'; // the kinds this person switched off, on this device

// Which app a gathered item's link opens, and whether this person can open it (the same rules as the menu).
const OPENS = {
  conditions: ['Mountain status', () => true], rentals: ['Rentals', () => can('counter')], shop: ['Online shop', () => can('counter')],
  programs: ['Programs', () => can('instructor', 'counter')], school: ['Ski school', () => can('instructor', 'counter')], patrol: ['Patrol', () => can('patrol')],
  assets: ['Assets and fleet', () => can('staff')], catalog: ['Products and prices', () => isManager() || schoolCan('director')], sell: ['Sell', () => can('counter')],
};
function opener(link) {
  if (!link) return null;
  const key = link.replace(/^#\//, '').split(/[/?]/)[0];
  const o = OPENS[key];
  if (!o || !o[1]()) return null;
  if (ctx.views && !ctx.views.includes(key)) return null; // the app is off for this mountain
  return { href: link, text: `Open in ${o[0]}` };
}

/** '07:30' -> '7:30 AM'. */
export function fmtClock(t) {
  if (!t) return '';
  const [hh, mm] = t.split(':').map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}
const whenText = (x) => (x.all_day || !x.start_time ? 'All day' : `${fmtClock(x.start_time)}${x.end_time ? ` to ${fmtClock(x.end_time)}` : ''}`);
const spanText = (x) => (x.ends_on && x.ends_on !== x.starts_on ? `${fmtDate(x.starts_on)} to ${fmtDate(x.ends_on)}` : fmtDateLong(x.starts_on));
const monthStart = (d) => `${d.slice(0, 7)}-01`;
const sunday = (d) => { const wd = new Date(`${d}T12:00:00Z`).getUTCDay(); return addDays(d, -wd); };
const onDay = (x, d) => x.starts_on <= d && x.ends_on >= d;
const readOff = () => { try { return new Set(JSON.parse(localStorage.getItem(KIND_KEY) || '[]')); } catch (_) { return new Set(); } };
const saveOff = (s) => { try { localStorage.setItem(KIND_KEY, JSON.stringify([...s])); } catch (_) { /* private mode */ } };
const phone = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches;

/** One line on the calendar: a color bar by kind, the time, the title and where it is from. */
function itemRow(x, meta, onOpen, { day } = {}) {
  const kind = meta.kinds.find((k) => k.key === x.kind);
  const teams = x.teams ? x.teams.map((t) => (meta.teams.find((m) => m.key === t) || { label: t }).label).join(', ') : 'Everyone';
  const range = x.ends_on !== x.starts_on ? (day && day > x.starts_on ? `Until ${fmtDate(x.ends_on)}` : `${fmtDate(x.starts_on)} to ${fmtDate(x.ends_on)}`) : null;
  const b = h('button', { type: 'button', class: 'mcal-item', dataset: { kind: x.kind } },
    h('span', { class: 'mcal-when' }, whenText(x)),
    h('span', { class: 'mcal-what' }, h('b', null, x.title),
      h('span', { class: 'mcal-meta' }, [kind ? kind.label : null, range, x.place, `For: ${teams}`, x.source === 'added' ? null : x.source_label].filter(Boolean).join(' · '))));
  b.addEventListener('click', () => onOpen(x));
  return b;
}

export async function render(root) {
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Calendar'), h('p', { class: 'muted' }, 'What is happening at the mountain: events, closures, groups, training and upkeep. You see what is for everyone and for your teams.')));
  const actions = h('div', { class: 'actions' });
  head.append(actions);
  const bar = h('div', { class: 'mcal-bar' });
  const filters = h('div', { class: 'mcal-filters' });
  const body = h('div', { class: 'mcal-body', 'aria-live': 'polite' });
  root.append(head, bar, filters, body);

  const today = todayStr();
  let view = VIEWS.some((v) => v[0] === hashParam('view')) ? hashParam('view') : (phone() ? 'list' : 'month');
  let anchor = /^\d{4}-\d{2}-\d{2}$/.test(hashParam('day') || '') ? hashParam('day') : today;
  let team = '';
  const off = readOff();
  let meta = null; let data = null; let picked = null;
  const remember = () => { try { history.replaceState(null, '', withHashParam('day', anchor === today ? null : anchor, withHashParam('view', view))); } catch (_) { /* the view still changes */ } };

  function rangeOf() {
    if (view === 'list') return { from: anchor, to: addDays(anchor, 13) };
    if (view === 'week') { const s = sunday(anchor); return { from: s, to: addDays(s, 6) }; }
    const s = sunday(monthStart(anchor));
    const last = addDays(monthStart(addDays(monthStart(anchor), 32)), -1);
    return { from: s, to: addDays(sunday(last), 6) };
  }
  function titleOf() {
    if (view === 'list') return anchor === today ? 'Next 14 days' : `14 days from ${fmtDate(anchor)}`;
    if (view === 'week') { const { from, to } = rangeOf(); return `Week of ${fmtDate(from)} to ${fmtDate(to)}`; }
    return `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`;
  }
  const step = (n) => { anchor = view === 'month' ? addDays(monthStart(anchor), n > 0 ? 32 : -1).slice(0, 8).concat('01') : addDays(anchor, n * (view === 'week' ? 7 : 14)); picked = null; remember(); load(); };

  // ---- the bar: view, back and forward, today
  const segs = VIEWS.map(([k, text]) => { const b = h('button', { type: 'button', 'aria-pressed': String(k === view), dataset: { view: k } }, text); b.addEventListener('click', () => { view = k; picked = null; remember(); drawBar(); load(); }); return b; });
  const label = h('h2', { class: 'mcal-title', id: 'mcal-title' });
  function drawBar() {
    for (const b of segs) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    const prev = h('button', { type: 'button', class: 'btn small', 'aria-label': view === 'month' ? 'Last month' : view === 'week' ? 'Last week' : 'The 14 days before' }, '‹');
    const next = h('button', { type: 'button', class: 'btn small', 'aria-label': view === 'month' ? 'Next month' : view === 'week' ? 'Next week' : 'The next 14 days' }, '›');
    prev.addEventListener('click', () => step(-1)); next.addEventListener('click', () => step(1));
    const back = h('button', { type: 'button', class: 'btn small' }, 'Today');
    back.addEventListener('click', () => { anchor = today; picked = null; remember(); load(); });
    const jump = input({ type: 'date', value: anchor, 'aria-label': 'Go to a day', class: 'mcal-jump' });
    jump.addEventListener('change', () => { if (jump.value) { anchor = jump.value; picked = jump.value; remember(); load(); } });
    clear(bar).append(h('div', { class: 'seg mcal-seg', role: 'group', 'aria-label': 'View' }, segs), h('div', { class: 'mcal-nav' }, prev, back, next, jump), label);
  }

  // ---- filters: team and kind
  function drawFilters() {
    const mine = meta.teams.filter((t) => t.mine);
    const teamOpts = [['', 'My teams'], ...(meta.me.manager ? meta.teams : mine).map((t) => [t.key, t.label])];
    const teamSel = select(teamOpts, team, { 'aria-label': 'Team' });
    teamSel.addEventListener('change', () => { team = teamSel.value; load(); });
    const kinds = meta.kinds.map((k) => {
      const b = h('button', { type: 'button', class: 'mcal-kind', dataset: { kind: k.key }, 'aria-pressed': String(!off.has(k.key)) }, h('span', { class: 'mcal-swatch', 'aria-hidden': 'true' }), k.label);
      b.addEventListener('click', () => { if (off.has(k.key)) off.delete(k.key); else off.add(k.key); saveOff(off); b.setAttribute('aria-pressed', String(!off.has(k.key))); draw(); });
      return b;
    });
    clear(filters).append(field('Show', teamSel), h('div', { class: 'mcal-kinds', role: 'group', 'aria-label': 'Kinds to show' }, kinds));
  }

  function drawActions() {
    clear(actions);
    if (meta.me.add_for === 'all' || meta.me.add_for.length) actions.append(button('Add an event', () => eventForm(null), { kind: 'primary', small: true }));
    actions.append(h('button', { type: 'button', class: 'btn small', onclick: () => phoneDialog() }, icon('share', 16), h('span', null, 'On my phone')));
  }

  async function load() {
    const { from, to } = rangeOf();
    label.textContent = titleOf();
    clear(body).append(loading());
    try {
      const r = await get(`/calendar?from=${from}&to=${to}${team ? `&team=${team}` : ''}`);
      const first = !meta;
      meta = { teams: r.teams, kinds: r.kinds, me: r.me };
      data = r;
      if (first) { drawFilters(); drawActions(); }
      draw();
    } catch (err) { clear(body).append(errorBox(err)); }
  }

  const shown = () => data.items.filter((x) => !off.has(x.kind));

  function draw() {
    if (!data) return;
    clear(body);
    if (view === 'list') body.append(listView());
    else if (view === 'week') body.append(weekView());
    else body.append(monthView());
  }

  function dayBlock(d, items, { heading = 'h3', showEmpty = false, short = false } = {}) {
    const list = items.filter((x) => onDay(x, d));
    if (!list.length && !showEmpty) return null;
    return h('section', { class: `mcal-day${d === today ? ' mcal-today' : ''}`, 'aria-label': `${fmtDateLong(d)}${d === today ? ', today' : ''}` },
      h(heading, { class: 'mcal-day-head' }, d === today ? h('span', { class: 'mcal-today-tag' }, 'Today') : null, short ? fmtDate(d) : fmtDateLong(d)),
      list.length ? h('div', { class: 'mcal-list' }, list.map((x) => itemRow(x, meta, openItem, { day: d }))) : h('p', { class: 'muted mcal-none' }, 'Nothing on.'));
  }

  function listView() {
    const items = shown();
    const { from, to } = rangeOf();
    const out = [];
    const placed = new Set();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      // A long event shows once, on its first day in view, with its last day.
      const list = items.filter((x) => onDay(x, d) && !placed.has(x.id));
      list.forEach((x) => placed.add(x.id));
      if (!list.length && d !== today) continue;
      out.push(h('section', { class: `mcal-day${d === today ? ' mcal-today' : ''}`, 'aria-label': `${fmtDateLong(d)}${d === today ? ', today' : ''}` },
        h('h3', { class: 'mcal-day-head' }, d === today ? h('span', { class: 'mcal-today-tag' }, 'Today') : null, fmtDateLong(d)),
        list.length ? h('div', { class: 'mcal-list' }, list.map((x) => itemRow(x, meta, openItem, { day: d }))) : h('p', { class: 'muted mcal-none' }, 'Nothing on today.')));
    }
    if (!out.length || (out.length === 1 && !items.length)) return h('div', null, out, empty(off.size ? 'Nothing in these 14 days for the kinds shown. Switch more kinds on above.' : 'Nothing on the calendar in these 14 days.'));
    return h('div', { class: 'mcal-days' }, out);
  }

  function weekView() {
    const { from } = rangeOf();
    const items = shown();
    return h('div', { class: 'mcal-week' }, Array.from({ length: 7 }, (_, i) => dayBlock(addDays(from, i), items, { showEmpty: true, short: true })));
  }

  function monthView() {
    const { from, to } = rangeOf();
    const items = shown();
    const month = anchor.slice(0, 7);
    if (!picked || picked < from || picked > to) picked = today >= from && today <= to && today.slice(0, 7) === month ? today : `${month}-01`;
    const dayBox = h('div', { class: 'mcal-picked' });
    const cells = [];
    const grid = h('div', { class: 'mcal-month', role: 'grid', 'aria-labelledby': 'mcal-title' },
      h('div', { class: 'mcal-mhead', role: 'row' }, WEEKDAYS.map((w) => h('div', { role: 'columnheader' }, w))));
    for (let w = from; w <= to; w = addDays(w, 7)) {
      const row = h('div', { class: 'mcal-mweek', role: 'row' });
      for (let i = 0; i < 7; i += 1) {
        const d = addDays(w, i);
        const list = items.filter((x) => onDay(x, d));
        const out = d.slice(0, 7) !== month;
        const cell = h('button', { type: 'button', role: 'gridcell', class: `mcal-cell${out ? ' mcal-out' : ''}${d === today ? ' mcal-today' : ''}`, dataset: { day: d }, 'aria-selected': String(d === picked),
          'aria-label': `${fmtDateLong(d)}${d === today ? ', today' : ''}: ${list.length ? `${list.length} on the calendar` : 'nothing on'}` },
        h('span', { class: 'mcal-num', 'aria-hidden': 'true' }, String(Number(d.slice(8)))),
        h('span', { class: 'mcal-chips', 'aria-hidden': 'true' }, list.slice(0, 3).map((x) => h('span', { class: 'mcal-chip', dataset: { kind: x.kind } }, x.title)),
          list.length > 3 ? h('span', { class: 'mcal-more' }, `${list.length - 3} more`) : null),
        h('span', { class: 'mcal-dots', 'aria-hidden': 'true' }, list.slice(0, 4).map((x) => h('span', { class: 'mcal-dot', dataset: { kind: x.kind } }))));
        cell.addEventListener('click', () => { picked = d; for (const c of cells) c.setAttribute('aria-selected', String(c.dataset.day === d)); drawPicked(); });
        cells.push(cell);
        row.append(cell);
      }
      grid.append(row);
    }
    function drawPicked() { clear(dayBox).append(dayBlock(picked, items, { heading: 'h3', showEmpty: true })); }
    drawPicked();
    return h('div', { class: 'mcal-month-wrap' }, grid, dayBox);
  }

  // ---- one item: what, when, where, for whom, where it comes from, and its screen
  function openItem(x) {
    const kind = meta.kinds.find((k) => k.key === x.kind);
    const teams = x.teams ? x.teams.map((t) => (meta.teams.find((m) => m.key === t) || { label: t }).label).join(', ') : 'Everyone';
    const go = opener(x.link);
    const rows = [['When', `${spanText(x)}, ${whenText(x).toLowerCase() === 'all day' ? 'all day' : whenText(x)}${x.ends_on !== x.starts_on && !x.all_day ? ' each day' : ''}`],
      ['Kind', kind ? kind.label : x.kind], ['Where', x.place], ['For', teams], ['From', x.source_label], ['Note', x.note]].filter((r) => r[1]);
    const dlg = dialog(x.title, [
      h('dl', { class: 'mcal-facts' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      go ? h('p', null, h('a', { href: go.href, class: 'btn small', onclick: () => dlg.close() }, go.text)) : null,
      x.source !== 'added' ? h('p', { class: 'muted' }, 'This comes from another part of Verdynt/OS. Change it there.') : null,
      x.editable ? h('div', { class: 'footer row' },
        button('Delete', () => confirmDialog('Delete this event?', `"${x.title}" comes off the calendar for everyone.`, 'Delete', async () => { await del(`/calendar/events/${x.event_id}`); toast('Event deleted'); dlg.close(); await load(); }, { danger: true }), { small: true }),
        button('Edit', () => { dlg.close(); eventForm(x); }, { kind: 'primary', small: true })) : null,
    ]);
  }

  // ---- add or change an event
  function eventForm(x) {
    const all = meta.me.add_for === 'all';
    const allowed = all ? meta.teams.map((t) => t.key) : meta.me.add_for;
    const title = input({ name: 'title', required: true, maxlength: 120, value: x ? x.title : '' });
    const kind = select(meta.kinds.filter((k) => k.can_add).map((k) => [k.key, k.label]), x ? x.kind : 'event', { name: 'kind' });
    const first = input({ type: 'date', name: 'starts_on', required: true, value: x ? x.starts_on : (picked || anchor) });
    const last = input({ type: 'date', name: 'ends_on', value: x && x.ends_on !== x.starts_on ? x.ends_on : '' });
    const allDay = input({ type: 'checkbox', name: 'all_day', checked: x ? x.all_day : true });
    const start = input({ type: 'time', name: 'start_time', value: x && x.start_time ? x.start_time : '09:00' });
    const end = input({ type: 'time', name: 'end_time', value: x && x.end_time ? x.end_time : '' });
    const times = h('div', { class: 'mcal-pair mcal-times' }, field('Starts', start), field('Ends', end, 'Optional'));
    const syncTimes = () => { times.hidden = allDay.checked; };
    allDay.addEventListener('change', syncTimes); syncTimes();
    const place = input({ name: 'place', maxlength: 120, value: x && x.place ? x.place : '', placeholder: 'Base lodge, upstairs' });
    const note = h('textarea', { name: 'note', rows: 3, maxlength: 1000 }, x && x.note ? x.note : '');
    // Who sees it: everyone (owners and managers only), or chosen teams.
    const chosen = new Set(x && x.teams ? x.teams : (all ? [] : allowed));
    const everyone = h('input', { type: 'radio', name: 'who', value: 'all', checked: all && !(x && x.teams), disabled: !all });
    const some = h('input', { type: 'radio', name: 'who', value: 'teams', checked: !all || Boolean(x && x.teams) });
    const boxes = meta.teams.map((t) => {
      const c = h('input', { type: 'checkbox', value: t.key, checked: chosen.has(t.key), disabled: !allowed.includes(t.key) });
      return h('label', { class: 'check' }, c, t.label);
    });
    const teamBox = h('div', { class: 'mcal-team-picks' }, boxes);
    const syncWho = () => { teamBox.hidden = everyone.checked; };
    everyone.addEventListener('change', syncWho); some.addEventListener('change', syncWho); syncWho();
    const who = h('fieldset', { class: 'mcal-who' }, h('legend', null, 'Who sees it'),
      h('label', { class: 'check' }, everyone, 'Everyone'), h('label', { class: 'check' }, some, 'Chosen teams'), teamBox,
      all ? null : h('p', { class: 'hint' }, `You can add events for ${allowed.map((k) => (meta.teams.find((t) => t.key === k) || { label: k }).label).join(' and ')}.`));
    formDialog(x ? 'Change the event' : 'Add an event', h('div', { class: 'stack' },
      field('Title', title), field('Kind', kind, 'Sets its color on the calendar'),
      h('div', { class: 'mcal-pair' }, field('First day', first), field('Last day', last, 'Leave empty for one day')),
      h('label', { class: 'check' }, allDay, 'All day'), times, field('Place', place, 'Optional'), field('Note', note, 'Optional. Everyone who sees the event sees the note.'), who),
    async (fd) => {
      const teams = everyone.checked ? null : boxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.value);
      if (teams && !teams.length) throw new Error('Choose at least one team, or Everyone');
      const payload = { title: val(fd, 'title') || '', kind: val(fd, 'kind'), starts_on: val(fd, 'starts_on'), ends_on: val(fd, 'ends_on'), all_day: allDay.checked,
        start_time: allDay.checked ? null : val(fd, 'start_time'), end_time: allDay.checked ? null : val(fd, 'end_time'), place: val(fd, 'place'), note: val(fd, 'note'), teams };
      if (!payload.starts_on) throw new Error('Choose the first day');
      if (x) await patch(`/calendar/events/${x.event_id}`, payload); else await post('/calendar/events', payload);
      toast(x ? 'Event changed' : 'Event added');
      if (!x) { anchor = payload.starts_on; picked = payload.starts_on; remember(); }
      await load();
    }, { submitText: x ? 'Save' : 'Add event', wide: true });
  }

  // ---- the calendar on a phone's own calendar app
  async function phoneDialog() {
    const box = h('div', { class: 'stack' }, loading());
    const dlg = dialog('The calendar on your phone', box);
    async function show(made) {
      const st = made ? { on: true } : await get('/calendar/feed');
      clear(box).append(h('p', null, 'Add this calendar to the calendar app on your phone or computer. It shows what you see here and updates by itself about once an hour. Your phone may take a few hours to show changes.'));
      if (made) {
        const url = input({ value: made.url, readonly: true, 'aria-label': 'Your calendar link', class: 'mcal-link' });
        url.addEventListener('focus', () => url.select());
        box.append(
          h('p', null, h('b', null, 'Your private link. '), 'It is shown only now. Anyone with it can see your calendar, so do not share it.'),
          url,
          h('div', { class: 'row wrap' },
            h('a', { class: 'btn primary small', href: made.webcal }, 'Open in my calendar app'),
            button('Copy the link', async () => { try { await navigator.clipboard.writeText(made.url); toast('Link copied'); } catch (_) { url.select(); toast('Select the link and copy it'); } }, { small: true })),
          h('ul', { class: 'mcal-howto' },
            h('li', null, 'iPhone or iPad: tap Open in my calendar app, then Subscribe.'),
            h('li', null, 'Google Calendar: on a computer, open Other calendars, then From URL, and paste the link.'),
            h('li', null, 'Outlook: Add calendar, then Subscribe from web, and paste the link.')));
      } else if (st.on) {
        box.append(h('p', null, `Your link is on${st.last_used_at ? `. A calendar app last read it ${fmtDay(st.last_used_at)}` : ''}. For safety it is not shown again. Make a new link to see one; the old one stops working.`));
      } else {
        box.append(h('p', { class: 'muted' }, 'You have no link yet.'));
      }
      box.append(h('div', { class: 'footer row' },
        st.on ? button('Turn my link off', async () => { await del('/calendar/feed'); toast('Link turned off. Calendar apps stop updating.'); await show(null); }, { small: true }) : null,
        button(st.on ? 'Make a new link' : 'Make my link', async () => { const r = await post('/calendar/feed', {}); await show(r); }, { kind: 'primary', small: true })));
    }
    try { await show(null); } catch (err) { clear(box).append(errorBox(err)); }
    void dlg;
  }

  drawBar();
  await load();
}

/** The "Coming up" card on the Today page: today and the next two days, from the calendar. */
export async function comingUpCard(host) {
  let r;
  try { r = await get('/calendar/coming-up'); } catch (_) { host.hidden = true; return; }
  const today = r.today;
  const tomorrow = addDays(today, 1);
  const dayWord = (x) => (x.starts_on <= today ? 'Today' : x.starts_on === tomorrow ? 'Tomorrow' : fmtDate(x.starts_on));
  clear(host).append(h('section', { class: 'panel mcal-coming', 'aria-labelledby': 'mcal-coming-h' },
    h('header', { class: 'spread' }, h('h2', { id: 'mcal-coming-h' }, 'Coming up'), h('a', { href: '#/calendar', class: 'btn small' }, 'Calendar')),
    r.items.length ? h('ul', { class: 'mcal-coming-list' }, r.items.map((x) => h('li', { dataset: { kind: x.kind } },
      h('span', { class: 'mcal-coming-day' }, dayWord(x)),
      h('a', { href: `#/calendar?view=list${x.starts_on > today ? `&day=${x.starts_on}` : ''}` }, x.title),
      h('span', { class: 'muted' }, x.all_day || !x.start_time ? (x.ends_on !== x.starts_on ? `to ${fmtDate(x.ends_on)}` : 'All day') : `${fmtClock(x.start_time)}${x.end_time ? ` to ${fmtClock(x.end_time)}` : ''}`))))
      : h('p', { class: 'muted' }, 'Nothing on the calendar for today and the next two days.'),
    r.more ? h('p', { class: 'muted' }, `And ${r.more} more on the calendar.`) : null));
  host.hidden = false;
}
