// Patrol > Team > Schedule: the patrol schedule, kept apart from Staff and schedule. The week as a grid of the roster by
// day (one day at a time on a phone), open shifts in their own row. Those with the schedule permission add, change,
// copy and publish shifts; everyone else on patrol sees the published schedule, with their own shifts marked.
import { get, post, patch, del, download } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, confirmDialog, dialog, table, label, empty, errorBox, todayStr, addDays, weekStart } from '../ui.js';
import { spanShort, span, minutes, hrs, dayShort, dayLong, monthDay, weekLabel, weekDays } from './workforce-common.js';
import { coverChip, callDialog, signupsDialog } from './patrol-crews.js';

export async function drawSchedule(box) {
  const today = todayStr();
  let start = weekStart(today);
  let phoneDay = today;
  const head = h('div', { class: 'sched-head' });
  const body = h('div');
  clear(box).append(head, body);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading the patrol schedule…'));
    try { draw(await get(`/patrol/schedule?from=${start}&to=${addDays(start, 6)}`)); } catch (err) { clear(body).append(errorBox(err)); }
  }
  const go = (d) => { start = d; if (!weekDays(start).includes(phoneDay)) phoneDay = start; return load(); };

  function draw(w) {
    const days = weekDays(start);
    const edit = w.can_edit;
    const drafts = w.shifts.filter((s) => s.status === 'draft').length;
    const open = w.shifts.filter((s) => !s.staff_id);
    const add = (date, staffId) => shiftDialog({ date, staffId, stations: w.stations, onDone: load });
    const change = (s) => (edit ? shiftDialog({ shift: s, stations: w.stations, onDone: load }) : null);

    clear(head).append(h('div', { class: 'week-bar' },
      h('div', { class: 'week-nav' },
        h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Previous week', onclick: () => go(addDays(start, -7)) }, '‹'),
        h('h2', { class: 'week-title' }, weekLabel(start)),
        h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Next week', onclick: () => go(addDays(start, 7)) }, '›'),
        start !== weekStart(today) ? button('This week', () => go(weekStart(today)), { small: true }) : null),
      h('div', { class: 'week-actions' },
        edit ? button('Add shift', () => add(days.includes(today) ? today : start, null), { kind: 'primary' }) : null,
        edit ? button('Copy last week', () => copyWeek(start, load)) : null,
        button('Days patrolled', () => daysDialog()),
        edit && w.signups && w.signups.length ? button(`Sign-ups waiting (${w.signups.length})`, () => signupsDialog(w.signups, load), { kind: 'primary' }) : null,
        edit && drafts ? button(`Publish ${drafts} draft${drafts === 1 ? '' : 's'}`, () => publish(start, drafts, load), { kind: 'primary' }) : null,
        edit && (w.crews || []).length ? button('Publish more', () => publishMore(start, w.crews, load)) : null)),
    h('p', { class: 'muted' }, edit
      ? `${w.shifts.length} patrol shift${w.shifts.length === 1 ? '' : 's'}${open.length ? `, ${open.length} open` : ''}${drafts ? `, ${drafts} not published yet` : ''}. This schedule is kept in Patrol; Staff and schedule shows it but cannot change it.`
      : 'The published patrol schedule. Your shifts are marked.'));

    if (!w.shifts.length && !edit) { clear(body).append(empty(`Nothing published for ${weekLabel(start)} yet.`)); return; }
    if (!w.roster.length) { clear(body).append(empty('No one is on the patrol roster yet. Add people on the Team tab.')); return; }

    const block = (s, withName) => h('button', {
      type: 'button', class: `shift-block${s.status === 'draft' ? ' is-draft' : ''}${s.staff_id ? '' : ' is-open'}${w.me && s.staff_id && Number(s.staff_id) === Number(w.me) ? ' is-mine' : ''}`, 'data-dept': 'patrol', disabled: !edit,
      'aria-label': `Patrol, ${dayLong(s.starts_at.slice(0, 10))}, ${span(s.starts_at, s.ends_at)}, ${s.staff_id ? s.name : 'open'}${s.station ? `, ${s.station}` : ''}${s.status === 'draft' ? ', draft' : ''}${s.cover_status ? ', needs cover' : ''}${s.no_show ? ', not signed in' : ''}`,
      onclick: () => change(s),
    }, h('b', null, spanShort(s.starts_at, s.ends_at)), h('span', null, withName ? (s.staff_id ? s.name : 'Open') : [s.station, s.role_label].filter(Boolean).join(', ') || 'Patrol'),
    withName && (s.station || s.role_label) ? h('span', { class: 'sb-sub' }, [s.station, s.role_label].filter(Boolean).join(', ')) : null,
    s.status === 'draft' || s.notes ? h('span', { class: 'sb-sub' }, [s.status === 'draft' ? 'Draft' : null, s.notes].filter(Boolean).join('. ')) : null,
    s.cover_status ? h('span', { class: 'sb-cover' }, s.cover_status === 'pending' ? 'Cover offered' : 'Needs cover') : null,
    s.no_show ? h('span', { class: 'sb-noshow' }, 'Not signed in') : null,
    Number(s.extra) && !s.staff_id ? h('span', { class: 'sb-sub' }, 'Extra spot') : null);
    const cellAdd = (d, m) => (edit ? h('button', { type: 'button', class: 'cell-add', 'aria-label': `Add a patrol shift${m ? ` for ${m.name}` : ''} on ${dayLong(d)}`, onclick: () => add(d, m ? m.staff_id : null) }, '+') : null);

    const grid = h('div', { class: 'sched-grid', role: 'table', 'aria-label': `Patrol schedule for ${weekLabel(start)}` });
    grid.append(h('div', { class: 'sg-row sg-headrow', role: 'row' }, h('div', { class: 'sg-name', role: 'columnheader' }, 'Patroller'),
      ...days.map((d) => { const n = w.shifts.filter((s) => s.starts_at.startsWith(d)); const o = n.filter((s) => !s.staff_id).length; return h('div', { class: `sg-day${d === today ? ' is-today' : ''}`, role: 'columnheader' }, h('b', null, `${dayShort(d)} ${Number(d.slice(8))}`), h('small', null, n.length ? `${n.length - o} on patrol${o ? `, ${o} open` : ''}` : 'None')); }),
      h('div', { class: 'sg-hours', role: 'columnheader' }, 'Hours')));
    // Each crew's coverage by day: filled against needed, short days in color; select one to call for extra patrollers.
    const cov = w.coverage || [];
    const covOn = (d) => cov.filter((c) => c.date === d && (edit || c.generated));
    const covClick = (c) => (edit && c.generated && c.date >= today ? () => callDialog(c, load) : null);
    if (cov.length) {
      grid.append(h('div', { class: 'sg-row sg-crews', role: 'row' }, h('div', { class: 'sg-name', role: 'rowheader' }, h('b', null, 'Crews'), h('small', null, 'Filled of needed')),
        ...days.map((d) => h('div', { class: 'sg-cell', role: 'cell' }, covOn(d).map((c) => coverChip(c, covClick(c))))), h('div', { class: 'sg-hours', role: 'cell' })));
    }
    if (open.length || edit) {
      grid.append(h('div', { class: 'sg-row sg-open', role: 'row' }, h('div', { class: 'sg-name', role: 'rowheader' }, h('b', null, 'Open'), h('small', null, open.length ? `${open.length} to fill` : 'None')),
        ...days.map((d) => h('div', { class: 'sg-cell', role: 'cell' }, open.filter((s) => s.starts_at.startsWith(d)).map((s) => block(s, false)), cellAdd(d, null))), h('div', { class: 'sg-hours', role: 'cell' })));
    }
    const active = w.roster.filter((m) => m.status === 'active' || w.shifts.some((s) => Number(s.staff_id) === Number(m.staff_id)));
    for (const m of active) {
      const mine = w.shifts.filter((s) => Number(s.staff_id) === Number(m.staff_id));
      if (!edit && !mine.length) continue;
      const total = mine.reduce((n, s) => n + minutes(s.starts_at, s.ends_at), 0);
      grid.append(h('div', { class: `sg-row${w.me && Number(m.staff_id) === Number(w.me) ? ' is-me' : ''}`, role: 'row' },
        h('div', { class: 'sg-name', role: 'rowheader' }, h('b', null, m.name), h('small', null, [label(m.level), m.callsign, m.in_workforce ? 'paid' : 'volunteer'].filter(Boolean).join(', '))),
        ...days.map((d) => h('div', { class: 'sg-cell', role: 'cell' }, mine.filter((s) => s.starts_at.startsWith(d)).map((s) => block(s, false)), cellAdd(d, m))),
        h('div', { class: 'sg-hours', role: 'cell' }, total ? hrs(total) : '')));
    }

    const phone = h('div', { class: 'sched-phone' });
    const dayShifts = w.shifts.filter((s) => s.starts_at.startsWith(phoneDay)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    phone.append(h('div', { class: 'day-strip', role: 'tablist', 'aria-label': 'Day' }, ...days.map((d) => {
      const n = w.shifts.filter((s) => s.starts_at.startsWith(d));
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(d === phoneDay), class: d === today ? 'is-today' : null, onclick: () => { phoneDay = d; draw(w); } },
        h('span', null, dayShort(d)), h('b', null, String(Number(d.slice(8)))), h('small', { class: n.some((s) => !s.staff_id) ? 'has-open' : null }, n.length ? String(n.length) : ''));
    })), h('h3', { class: 'day-title' }, dayLong(phoneDay)));
    if (covOn(phoneDay).length) phone.append(h('div', { class: 'crew-chips' }, covOn(phoneDay).map((c) => coverChip(c, covClick(c)))));
    if (!dayShifts.length) phone.append(empty('No patrol shifts this day.', edit ? button('Add shift', () => add(phoneDay, null), { kind: 'primary' }) : null));
    else {
      phone.append(h('div', { class: 'day-list' }, dayShifts.map((s) => block(s, true))));
      if (edit) phone.append(h('div', { class: 'row' }, button('Add shift', () => add(phoneDay, null), { small: true })));
    }
    clear(body).append(h('div', { class: 'sched-wide' }, grid), phone,
      h('p', { class: 'muted small sched-key' }, edit ? 'A dashed outline is a draft that patrollers cannot see yet. Volunteers and paid patrollers are both scheduled here. Crews and their spots are set up on the Crews tab.' : 'Shifts with a thick outline are yours.'));
  }
  await load();
}

/** Add or change a patrol shift: times, station, role, note, and who (the roster, free people first, with reasons). */
function shiftDialog({ shift, date, staffId, stations, onDone }) {
  const editing = Boolean(shift);
  const day = input({ type: 'date', name: 'day', required: true, value: editing ? shift.starts_at.slice(0, 10) : date });
  const from = input({ type: 'time', name: 'from', required: true, value: editing ? shift.starts_at.slice(11, 16) : '08:00' });
  const to = input({ type: 'time', name: 'to', required: true, value: editing ? shift.ends_at.slice(11, 16) : '16:30' });
  const station = select([['', 'No station (roving)'], ...stations.map((s) => [s.id, s.name])], editing ? shift.station_id || '' : '', { name: 'station' });
  const role = input({ name: 'role', maxlength: 60, value: editing ? shift.role_label || '' : '', placeholder: 'Optional, for example "Sweep" or "Patrol leader"' });
  const notes = input({ name: 'notes', maxlength: 200, value: editing ? shift.notes || '' : '' });
  const who = h('div', { class: 'cand-list', role: 'radiogroup', 'aria-label': 'Who is on this shift' });
  let chosen = editing ? Number(shift.staff_id || 0) : Number(staffId || 0);
  const times = () => { const d = day.value; return [`${d}T${from.value}`, `${to.value <= from.value ? addDays(d, 1) : d}T${to.value}`]; };
  let token = 0;
  async function load() {
    const my = ++token;
    if (!day.value || !from.value || !to.value) return;
    const [s, e] = times();
    clear(who).append(h('p', { class: 'loading' }, 'Checking who is free…'));
    try {
      const { data } = await post('/patrol/schedule/candidates', { starts_at: s, ends_at: e, shift_id: editing ? Number(shift.id) : undefined });
      if (my !== token) return;
      const opt = (value, main, sub, disabled, tone) => { const r = h('input', { type: 'radio', name: 'who', value: String(value), checked: chosen === value, disabled }); r.addEventListener('change', () => { chosen = value; }); return h('label', { class: `cand${disabled ? ' is-blocked' : ''}`, 'data-tone': tone }, r, h('span', { class: 'cand-text' }, main, sub)); };
      const line = (c) => h('span', { class: 'cand-sub' }, [`${label(c.level)}, ${hrs(c.week_minutes)} this week`, ...c.problems].join('. '));
      const free = data.filter((c) => c.ok); const busy = data.filter((c) => !c.ok);
      clear(who).append(opt(0, h('b', null, 'Leave open'), h('span', { class: 'cand-sub' }, 'Shown in the Open row until someone takes it'), false, null),
        free.length ? h('div', { class: 'cand-group' }, h('p', { class: 'cand-title' }, 'Free'), free.map((c) => opt(c.staff_id, h('b', null, c.name, c.current ? h('small', { class: 'muted' }, ' (on it now)') : null), line(c), false, 'good'))) : null,
        busy.length ? h('div', { class: 'cand-group' }, h('p', { class: 'cand-title' }, 'Not free'), busy.map((c) => opt(c.staff_id, h('b', null, c.name), line(c), true, null))) : null);
    } catch (err) { if (my === token) clear(who).append(errorBox(err)); }
  }
  for (const el of [day, from, to]) el.addEventListener('change', load);
  const dlg = formDialog(editing ? `Patrol, ${dayLong(shift.starts_at.slice(0, 10))}` : 'Add a patrol shift', h('div', { class: 'stack' },
    h('div', { class: 'shift-when' }, field('Day', day), field('Starts', from), field('Ends', to)),
    h('div', { class: 'shift-when two' }, field('Station', station), field('Role', role)), field('Note', notes),
    h('fieldset', { class: 'cand-box' }, h('legend', null, 'Who'), who),
    editing && shift.cover_status ? h('p', { class: 'cover-why' }, `${shift.name} has asked for cover on this shift (see the Cover tab). Putting someone else on it counts as covered; leaving it open or canceling it closes the request.`) : null,
    editing ? h('p', { class: 'muted small' }, shift.status === 'published' ? 'Published: anyone taken off, put on, or whose shift changes gets a message in their Inbox.' : 'A draft: patrollers see it once you publish.') : null), async () => {
    const [s, e] = times();
    const body = { starts_at: s, ends_at: e, station_id: station.value ? Number(station.value) : null, role_label: role.value.trim() || null, notes: notes.value.trim() || null, staff_id: chosen || null };
    if (editing) { await patch(`/patrol/schedule/${shift.id}`, body); toast('Patrol shift saved'); } else { await post('/patrol/schedule', body); toast('Patrol shift added as a draft'); }
    await onDone();
  }, { submitText: editing ? 'Save shift' : 'Add shift', wide: true });
  if (editing) {
    const cancel = button('Cancel this shift', () => confirmDialog('Cancel this patrol shift?', `${dayShort(shift.starts_at.slice(0, 10))} ${span(shift.starts_at, shift.ends_at)}.${shift.status === 'published' && shift.staff_id ? ' The patroller on it gets a message.' : ''}`, 'Cancel shift', async () => {
      await del(`/patrol/schedule/${shift.id}`); toast('Patrol shift canceled'); dlg.close(); await onDone();
    }, { danger: true }), { kind: 'danger' });
    cancel.classList.add('footer-start');
    dlg.box.querySelector('form .footer').prepend(cancel);
  }
  load();
}

function copyWeek(start, onDone) {
  const prev = addDays(start, -7);
  confirmDialog('Copy last week?', `Copies the patrol shifts from ${weekLabel(prev)} into ${weekLabel(start)} as drafts. Patrollers stay on them where they are still free and on the roster; otherwise the shift is left open.`, 'Copy as drafts', async () => {
    const r = await post('/patrol/schedule/copy', { from: prev, to: start });
    await onDone();
    const parts = [h('p', null, `${r.created} shift${r.created === 1 ? '' : 's'} added as drafts${r.unfilled ? `, ${r.unfilled} open` : ''}.${r.skipped ? ` ${r.skipped} already there, skipped.` : ''}`)];
    if (r.left_open.length) parts.push(h('ul', null, r.left_open.map((x) => h('li', null, `${dayShort(x.starts_at.slice(0, 10))} ${monthDay(x.starts_at.slice(0, 10))}: ${x.reason}`))));
    dialog('Week copied', parts);
  });
}

function publish(start, n, onDone) {
  confirmDialog(`Publish ${n} patrol shift${n === 1 ? '' : 's'}?`, `Patrollers see ${weekLabel(start)} on this tab and in My shifts, and everyone on a shift gets an Inbox message listing theirs. Changes after this are messaged to the people they affect.`, 'Publish', async () => {
    const r = await post('/patrol/schedule/publish', { from: start, to: addDays(start, 6) });
    toast(`${r.published} published${r.notified ? `, ${r.notified} told` : ''}`);
    await onDone();
  });
}

/** Publish a month or the rest of the season at once (the crews' days are usually made for the whole season). */
function publishMore(start, crews, onDone) {
  const ends = crews.map((c) => c.to_date).filter(Boolean).sort();
  const seasonEnd = ends.length ? ends[ends.length - 1] : addDays(start, 120);
  const monthEnd = (() => { const d = new Date(`${start}T12:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10); })();
  const pick = select([['week', `This week (${weekLabel(start)})`], ['month', `To the end of the month (${monthDay(monthEnd)})`], ['season', `To the end of the season (${monthDay(seasonEnd)})`]], 'month');
  formDialog('Publish drafts', h('div', { class: 'stack' }, field('Publish', pick),
    h('p', { class: 'muted small' }, 'Patrollers see the published days on the Schedule and can sign up for open spots. Each patroller on a spot gets one Inbox message listing theirs.')), async () => {
    const to = pick.value === 'week' ? addDays(start, 6) : pick.value === 'month' ? monthEnd : seasonEnd;
    const r = await post('/patrol/schedule/publish', { from: start, to });
    toast(`${r.published} published${r.notified ? `, ${r.notified} told` : ''}`);
    await onDone();
  }, { submitText: 'Publish' });
}

/** Days and hours patrolled this season, per person, with a download (volunteer credit, the season report). */
export async function daysDialog() {
  const r = await get('/patrol/schedule/days');
  dialog(`Days patrolled, ${r.season} season`, [
    h('p', { class: 'muted' }, 'A day counts when someone signed in on duty or was posted on Today\'s posts (before sign-in was used, a published patrol shift that ended). Hours are signed-in time.'),
    r.data.length ? table([
      { head: 'Patroller', cell: (d) => d.name },
      { head: 'Rank', cell: (d) => label(d.level) },
      { head: '', cell: (d) => (d.paid ? 'Paid' : 'Volunteer') },
      { head: 'Days', num: true, cell: (d) => (d.target ? `${d.days} of ${d.target}` : String(d.days)) },
      { head: 'Hours', num: true, cell: (d) => (d.minutes ? hrs(d.minutes) : '') },
    ], r.data) : empty('No one on the roster yet.'),
    h('div', { class: 'footer row' }, button('Download', () => download('/patrol/schedule/days?format=csv', `patrol-days-${r.season}.csv`), { kind: 'primary' }))], { wide: true });
}

