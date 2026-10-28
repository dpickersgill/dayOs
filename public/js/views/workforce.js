// Staff and schedule: the week as a grid of people by day (one day at a time on a phone), hours worked and approval,
// the staff list with a page for each person. Setup (positions, certifications, templates, the time clock kiosk) is in
// Settings, Staff and schedule (settingsPages below).
import { get } from '../api.js';
import { h, clear, select, button, toast, tabs, todayStr, addDays, weekStart, label, empty, errorBox, ctx } from '../ui.js';
import { hm, spanShort, minutes, hrs, dayShort, dayLong, weekLabel, weekDays, DEPARTMENTS, fullName } from './workforce-common.js';
import { shiftDialog, copyWeek, templatesDialog, publishWeek, staffingNeeds } from './workforce-shift.js';
import { drawHours } from './workforce-hours.js';
import { drawStaff, personPage } from './workforce-staff.js';
import { drawSetup } from './workforce-setup.js';
import { drawInjuries } from './staff-injuries.js';

const OVERTIME = 40 * 60;

export async function render(root, params = []) {
  if (params[0] === 'staff' && /^\d+$/.test(params[1] || '')) { await personPage(root, Number(params[1])); return; }
  // The staff injury register is private: its tab shows only to the owner and those the owner names.
  const injuries = Boolean(ctx.me && ctx.me.staff_injuries);
  // Setup (positions, certifications, templates, the time clock) is in Settings, Staff and schedule; the old address goes there.
  if (params[0] === 'setup' && location.hash.startsWith('#/workforce/setup')) { location.replace('#/settings/workforce'); return; }
  const initial = ['hours', 'staff', ...(injuries ? ['injuries'] : [])].includes(params[0]) ? params[0] : 'schedule';
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Staff and schedule')),
    tabs([['schedule', 'Schedule', drawSchedule], ['hours', 'Hours', drawHours], ['staff', 'Staff', drawStaff], ...(injuries ? [['injuries', 'Injuries', drawInjuries]] : [])], initial));
}

/** Setup shown in Settings, Staff and schedule (managers): positions, certifications, templates and the time clock. */
export const settingsPages = {
  setup: { title: 'Positions, certifications and the time clock', render: (panel) => drawSetup(panel) },
};

// ---------------------------------------------------------------- the week
async function drawSchedule(box) {
  const today = todayStr();
  let start = weekStart(today);
  let dept = '';
  let phoneDay = today;
  let showIdle = false;
  let patrolShifts = [];
  // Patrol is scheduled in Patrol: its positions are not offered here, and its shifts show read only.
  const positions = (await get('/workforce/positions?limit=500')).data.filter((p) => p.department !== 'patrol');
  const head = h('div', { class: 'sched-head' });
  const body = h('div', { class: 'sched-body' });
  clear(box).append(head, body);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading the week…'));
    try {
      const [{ data: shifts }, { data: staff }, { data: patrol }] = await Promise.all([
        get(`/workforce/shifts?from=${start}&to=${addDays(start, 6)}`),
        get('/workforce/staff?status=active'),
        get(`/workforce/patrol-coverage?from=${start}&to=${addDays(start, 6)}`).catch(() => ({ data: [] })),
      ]);
      patrolShifts = patrol;
      draw(shifts, staff);
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  const go = (d) => { start = d; if (!weekDays(start).includes(phoneDay)) phoneDay = start; return load(); };

  function draw(all, staff) {
    const days = weekDays(start);
    const shifts = dept ? all.filter((s) => s.department === dept) : all;
    const drafts = all.filter((s) => s.status === 'draft').length;
    const unfilled = shifts.filter((s) => !s.staff_id);
    const open = (s) => shiftDialog({ shift: s, positions, onDone: load });
    const add = (date, staffId) => shiftDialog({ date, staffId, positions, onDone: load });

    // ---- header: week, then actions
    clear(head).append(
      h('div', { class: 'week-bar' },
        h('div', { class: 'week-nav' },
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Previous week', onclick: () => go(addDays(start, -7)) }, '‹'),
          h('h2', { class: 'week-title' }, weekLabel(start)),
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Next week', onclick: () => go(addDays(start, 7)) }, '›'),
          start !== weekStart(today) ? button('This week', () => go(weekStart(today)), { small: true }) : null),
        h('div', { class: 'week-actions' },
          button('Add shift', () => add(days.includes(today) ? today : start, null), { kind: 'primary' }),
          button('Copy last week', () => copyWeek(start, load)),
          button('Templates', () => templatesDialog(start, load)),
          button('Staffing needs', () => staffingNeeds(start, today)),
          drafts ? button(`Publish ${drafts} draft${drafts === 1 ? '' : 's'}`, () => publishWeek(start, drafts, load), { kind: 'primary' }) : null)),
      h('div', { class: 'week-filter' },
        (() => { const s = select([['', 'All departments'], ...DEPARTMENTS.map((d) => [d, label(d)])], dept, { 'aria-label': 'Department' }); s.addEventListener('change', () => { dept = s.value; draw(all, staff); }); return s; })(),
        h('p', { class: 'muted' }, shifts.length ? [`${shifts.length} shift${shifts.length === 1 ? '' : 's'}`, unfilled.length ? `${unfilled.length} unfilled` : 'all filled', drafts ? `${drafts} not published yet` : 'all published'].join(', ') : '')));

    if (!all.length) {
      clear(body).append(empty(`Nothing scheduled for ${weekLabel(start)}.`, h('div', { class: 'row' },
        button('Add shift', () => add(days.includes(today) ? today : start, null), { kind: 'primary' }), button('Copy last week', () => copyWeek(start, load)), button('Templates', () => templatesDialog(start, load)))));
      return;
    }

    // ---- who is on what
    const byPerson = new Map();
    for (const s of shifts) if (s.staff_id) { const k = Number(s.staff_id); if (!byPerson.has(k)) byPerson.set(k, []); byPerson.get(k).push(s); }
    const weekMin = new Map();
    // a paid patroller's patrol shifts count toward their week too
    for (const s of [...all, ...patrolShifts]) if (s.staff_id) weekMin.set(Number(s.staff_id), (weekMin.get(Number(s.staff_id)) || 0) + minutes(s.starts_at, s.ends_at));
    const people = staff.map((p) => ({ ...p, id: Number(p.id) }));
    // people on a shift this week who are not active any more still show, so their shifts are not hidden
    for (const s of shifts) if (s.staff_id && !people.some((p) => p.id === Number(s.staff_id))) people.push({ id: Number(s.staff_id), first_name: s.first_name, last_name: s.last_name, positions: [] });
    const working = people.filter((p) => byPerson.has(p.id)).sort((a, b) => fullName(a).localeCompare(fullName(b)));
    const idle = people.filter((p) => !byPerson.has(p.id) && (!dept || (p.positions || []).some((x) => positions.find((q) => q.id === x.id && q.department === dept))));

    const block = (s, showName) => h('button', {
      type: 'button', class: `shift-block${s.status === 'draft' ? ' is-draft' : ''}${s.staff_id ? '' : ' is-open'}`, 'data-dept': s.department,
      'aria-label': `${s.position}, ${dayLong(s.starts_at.slice(0, 10))}, ${hm(s.starts_at)} to ${hm(s.ends_at)}, ${s.staff_id ? `${s.first_name} ${s.last_name}` : 'unfilled'}${s.status === 'draft' ? ', draft' : ''}`,
      onclick: () => (s.department === 'patrol' ? toast('Patrol shifts are kept in Patrol. This one is from before patrol had its own schedule.') : open(s)),
    }, h('b', null, spanShort(s.starts_at, s.ends_at)), h('span', null, showName && s.staff_id ? `${s.first_name} ${s.last_name}` : s.position),
    showName && s.staff_id ? h('span', { class: 'sb-sub' }, s.position) : null,
    s.status === 'draft' || s.notes ? h('span', { class: 'sb-sub' }, [s.status === 'draft' ? 'Draft' : null, s.notes].filter(Boolean).join('. ')) : null);
    const cellAdd = (d, p) => h('button', { type: 'button', class: 'cell-add', 'aria-label': `Add a shift${p ? ` for ${fullName(p)}` : ''} on ${dayLong(d)}`, onclick: () => add(d, p ? p.id : null) }, '+');

    // ---- the grid (wide screens)
    const grid = h('div', { class: 'sched-grid', role: 'table', 'aria-label': `Schedule for ${weekLabel(start)}` });
    grid.append(h('div', { class: 'sg-row sg-headrow', role: 'row' },
      h('div', { class: 'sg-name', role: 'columnheader' }, 'Person'),
      ...days.map((d) => {
        const n = shifts.filter((s) => s.starts_at.startsWith(d));
        const open_ = n.filter((s) => !s.staff_id).length;
        return h('div', { class: `sg-day${d === today ? ' is-today' : ''}`, role: 'columnheader' }, h('b', null, `${dayShort(d)} ${Number(d.slice(8))}`), h('small', null, n.length ? `${n.length} shift${n.length === 1 ? '' : 's'}${open_ ? `, ${open_} open` : ''}` : 'None'));
      }),
      h('div', { class: 'sg-hours', role: 'columnheader' }, 'Hours')));
    if (unfilled.length) {
      grid.append(h('div', { class: 'sg-row sg-open', role: 'row' },
        h('div', { class: 'sg-name', role: 'rowheader' }, h('b', null, 'Unfilled'), h('small', null, `${unfilled.length} to fill`)),
        ...days.map((d) => h('div', { class: 'sg-cell', role: 'cell' }, unfilled.filter((s) => s.starts_at.startsWith(d)).map((s) => block(s, false)))),
        h('div', { class: 'sg-hours', role: 'cell' })));
    }
    const showPatrol = (!dept || dept === 'patrol') && patrolShifts.length;
    if (showPatrol) {
      const pblock = (s) => h('a', { class: `shift-block is-readonly${s.staff_id ? '' : ' is-open'}${s.status === 'draft' ? ' is-draft' : ''}`, 'data-dept': 'patrol', href: '#/patrol/people?tab=schedule', title: 'Scheduled in Patrol' },
        h('b', null, spanShort(s.starts_at, s.ends_at)), h('span', null, s.staff_id ? `${s.first_name} ${s.last_name}` : 'Open'), s.station ? h('span', { class: 'sb-sub' }, s.station) : null);
      grid.append(h('div', { class: 'sg-row sg-patrol', role: 'row' },
        h('div', { class: 'sg-name', role: 'rowheader' }, h('b', null, 'Patrol'), h('small', null, 'Scheduled in Patrol. ', h('a', { href: '#/patrol/people?tab=schedule' }, 'Open'))),
        ...days.map((d) => h('div', { class: 'sg-cell', role: 'cell' }, patrolShifts.filter((s) => s.starts_at.startsWith(d)).map(pblock))),
        h('div', { class: 'sg-hours', role: 'cell' })));
    }
    const personRow = (p) => {
      const mine = byPerson.get(p.id) || [];
      const m = weekMin.get(p.id) || 0;
      return h('div', { class: 'sg-row', role: 'row' },
        h('div', { class: 'sg-name', role: 'rowheader' }, h('a', { href: `#/workforce/staff/${p.id}` }, fullName(p)), h('small', null, (p.positions || []).map((x) => x.name).join(', '))),
        ...days.map((d) => h('div', { class: 'sg-cell', role: 'cell' }, mine.filter((s) => s.starts_at.startsWith(d)).map((s) => block(s, false)), cellAdd(d, p))),
        h('div', { class: `sg-hours${m > OVERTIME ? ' is-over' : ''}`, role: 'cell', title: m > OVERTIME ? 'Over 40 hours: overtime' : '' }, m ? hrs(m) : ''));
    };
    grid.append(...working.map(personRow));
    if (idle.length) {
      grid.append(h('div', { class: 'sg-row sg-toggle', role: 'row' }, h('div', { role: 'cell' },
        h('button', { type: 'button', class: 'linkish', 'aria-expanded': String(showIdle), onclick: () => { showIdle = !showIdle; draw(all, staff); } },
          showIdle ? `Hide the ${idle.length} not scheduled` : `Show ${idle.length} more ${idle.length === 1 ? 'person' : 'people'} not scheduled this week`))));
      if (showIdle) grid.append(...idle.sort((a, b) => fullName(a).localeCompare(fullName(b))).map(personRow));
    }

    // ---- one day at a time (phones)
    const phone = h('div', { class: 'sched-phone' });
    const dayShifts = shifts.filter((s) => s.starts_at.startsWith(phoneDay));
    phone.append(h('div', { class: 'day-strip', role: 'tablist', 'aria-label': 'Day' }, ...days.map((d) => {
      const n = shifts.filter((s) => s.starts_at.startsWith(d));
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(d === phoneDay), class: d === today ? 'is-today' : null, onclick: () => { phoneDay = d; draw(all, staff); } },
        h('span', null, dayShort(d)), h('b', null, String(Number(d.slice(8)))), h('small', { class: n.some((s) => !s.staff_id) ? 'has-open' : null }, n.length ? String(n.length) : ''));
    })), h('h3', { class: 'day-title' }, dayLong(phoneDay)));
    if (!dayShifts.length) phone.append(empty('No shifts this day.', button('Add shift', () => add(phoneDay, null), { kind: 'primary' })));
    else {
      const open_ = dayShifts.filter((s) => !s.staff_id);
      if (open_.length) phone.append(h('p', { class: 'day-group' }, `Unfilled (${open_.length})`), h('div', { class: 'day-list' }, open_.map((s) => block(s, false))));
      const filled = dayShifts.filter((s) => s.staff_id).sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.position.localeCompare(b.position));
      if (filled.length) phone.append(h('p', { class: 'day-group' }, `On shift (${filled.length})`), h('div', { class: 'day-list' }, filled.map((s) => block(s, true))));
      phone.append(h('div', { class: 'row' }, button('Add shift', () => add(phoneDay, null), { small: true })));
    }

    clear(body).append(h('div', { class: 'sched-wide' }, grid), phone,
      h('p', { class: 'muted small sched-key' }, 'A dashed outline is a draft that staff cannot see yet. Hours over 40 in a week are marked as overtime, and include a paid patroller\'s patrol shifts. Patrol is scheduled in Patrol and shown here read only.'));
  }

  await load();
}

