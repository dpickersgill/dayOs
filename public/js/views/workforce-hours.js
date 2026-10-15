// Staff and schedule > Hours: a week of punches per person beside their scheduled hours, with overtime, fixing a missed
// or wrong punch (a reason is required and kept), adding a forgotten one, approving the week and the payroll export.
import { get, post, patch, del, download } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, confirmDialog, table, state, empty, errorBox, todayStr, addDays, weekStart } from '../ui.js';
import { hm, hrs, dayShort, monthDay, weekLabel } from './workforce-common.js';

const FLAG = { missed_clock_out: ['Missed clock-out', 'bad'], clocked_in: ['Clocked in now', 'good'], long: ['Over 14 hours', 'warn'], no_shift: ['No shift', 'neutral'] };

export async function drawHours(box) {
  const today = todayStr();
  let start = weekStart(today);
  const open = new Set();
  const head = h('div', { class: 'sched-head' });
  const body = h('div');
  clear(box).append(head, body);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading hours…'));
    try { draw(await get(`/workforce/time/week?start=${start}`)); } catch (err) { clear(body).append(errorBox(err)); }
  }
  const go = (d) => { start = d; open.clear(); return load(); };

  function draw(w) {
    const list = w.data;
    const ended = addDays(start, 6) < today; // compare worked with scheduled only once the week is over
    const waiting = list.filter((p) => !p.approved && p.entries.some((e) => !e.approved && e.flags.every((f) => f !== 'clocked_in' && f !== 'missed_clock_out')));
    const attention = list.filter((p) => p.needs_attention).length;
    clear(head).append(
      h('div', { class: 'week-bar' },
        h('div', { class: 'week-nav' },
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Previous week', onclick: () => go(addDays(start, -7)) }, '‹'),
          h('h2', { class: 'week-title' }, weekLabel(start)),
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Next week', onclick: () => go(addDays(start, 7)) }, '›'),
          start !== weekStart(today) ? button('This week', () => go(weekStart(today)), { small: true }) : null),
        h('div', { class: 'week-actions' },
          button('Add a missed punch', () => addPunch(start, load)),
          button('Export for payroll', () => download(`/workforce/time/export?start=${start}`, `hours-${start}.csv`)),
          button('Export every punch', () => download(`/workforce/time/export?start=${start}&detail=1`, `hours-${start}-detail.csv`)),
          waiting.length ? button(`Approve ${waiting.length === list.length ? 'the week' : `${waiting.length} ${waiting.length === 1 ? 'person' : 'people'}`}`, () => approve(start, waiting.length, attention, load), { kind: 'primary' }) : null)),
      h('p', { class: 'muted' }, list.length ? `${hrs(list.reduce((n, p) => n + p.worked_minutes, 0))} worked by ${list.length} ${list.length === 1 ? 'person' : 'people'}. ${attention ? `${attention} need${attention === 1 ? 's' : ''} a look before approving.` : ''}` : ''));
    if (!list.length) { clear(body).append(empty(`No shifts or punches for ${weekLabel(start)}.`)); return; }

    const rows = [];
    for (const p of list) {
      const isOpen = open.has(p.staff_id);
      const toggle = h('button', { type: 'button', class: 'linkish', 'aria-expanded': String(isOpen), onclick: () => { if (isOpen) open.delete(p.staff_id); else open.add(p.staff_id); draw(w); } }, isOpen ? 'Hide punches' : `${p.entries.length} punch${p.entries.length === 1 ? '' : 'es'}`);
      const status = p.needs_attention ? state('Needs a look', 'bad') : p.approved ? state('Approved', 'good') : p.entries.length ? state('Not approved', 'neutral') : state('No punches', 'neutral');
      rows.push(h('tr', { class: p.needs_attention ? 'attention' : null },
        h('td', { 'data-label': 'Person' }, h('a', { href: `#/workforce/staff/${p.staff_id}` }, h('b', null, p.name))),
        h('td', { class: 'num', 'data-label': 'Scheduled' }, p.scheduled_minutes ? hrs(p.scheduled_minutes) : ''),
        h('td', { class: 'num', 'data-label': 'Worked' }, hrs(p.worked_minutes), ended && p.scheduled_minutes && Math.abs(p.worked_minutes - p.scheduled_minutes) >= 60 ? h('small', { class: 'muted' }, ` (${p.worked_minutes > p.scheduled_minutes ? '+' : '−'}${hrs(Math.abs(p.worked_minutes - p.scheduled_minutes))})`) : null),
        h('td', { class: 'num', 'data-label': 'Overtime' }, p.overtime_minutes ? state(hrs(p.overtime_minutes), 'warn') : ''),
        h('td', { 'data-label': 'Status' }, status),
        h('td', { class: 'actions', 'data-label': '' }, p.entries.length ? toggle : null, p.approved ? button('Reopen', async () => { await post('/workforce/time/unapprove', { start, staff_id: p.staff_id }); toast('Reopened'); await load(); }, { small: true, label: `Reopen ${p.name}'s week` }) : null)));
      if (isOpen) rows.push(h('tr', { class: 'punch-row' }, h('td', { colspan: 6 }, punches(p, load))));
    }
    clear(body).append(h('div', { class: 'table-wrap' }, h('table', { class: 'rt hours-table' },
      h('thead', null, h('tr', null, ['Person', 'Scheduled', 'Worked', 'Overtime', 'Status', ''].map((t, i) => h('th', { scope: 'col', class: i >= 1 && i <= 3 ? 'num' : null }, t || h('span', { class: 'sr' }, 'Actions'))))),
      h('tbody', null, rows))),
    h('p', { class: 'muted small' }, `Overtime is time over ${w.overtime_after_minutes / 60} hours in the week (Monday to Sunday), the US federal rule. Some states count daily overtime too; check yours.`));
  }
  await load();
}

function punches(p, done) {
  return table([
    { head: 'Day', cell: (e) => `${dayShort(e.clock_in.slice(0, 10))} ${monthDay(e.clock_in.slice(0, 10))}` },
    { head: 'In', cell: (e) => hm(e.clock_in) },
    { head: 'Out', cell: (e) => (e.clock_out ? hm(e.clock_out) : '') },
    { head: 'Hours', num: true, cell: (e) => hrs(e.minutes) },
    { head: 'Shift', cell: (e) => (e.shift ? `${e.shift.position}, ${hm(e.shift.starts_at)} to ${hm(e.shift.ends_at)}` : '') },
    { head: 'Notes', cell: (e) => [...e.flags.filter((f) => FLAG[f]).map((f) => state(FLAG[f][0], FLAG[f][1])), e.edited ? h('small', { class: 'muted' }, ` Corrected: ${e.edit_note || ''}`) : null, e.approved ? h('small', { class: 'muted' }, ' Approved') : null] },
    { head: '', actions: true, cell: (e) => [button('Fix', () => fixPunch(p, e, done), { small: true, label: `Fix the punch on ${dayShort(e.clock_in.slice(0, 10))}` }),
      button('Remove', () => removePunch(e, done), { small: true, label: `Remove the punch on ${dayShort(e.clock_in.slice(0, 10))}` })] },
  ], p.entries, { rowClass: (e) => (e.flags.includes('missed_clock_out') ? 'attention' : null) });
}

const local = (s) => (s ? s.slice(0, 16).replace(' ', 'T') : '');

function fixPunch(p, e, done) {
  const missed = e.flags.includes('missed_clock_out');
  const suggest = !e.clock_out && e.shift ? e.shift.ends_at : null;
  formDialog(`Fix ${p.name}'s punch`, h('div', { class: 'form' },
    field('Clocked in', input({ type: 'datetime-local', name: 'in', value: local(e.clock_in), required: true })),
    field('Clocked out', input({ type: 'datetime-local', name: 'out', value: local(e.clock_out || suggest), required: missed }), missed ? 'They forgot to clock out. Their shift end is filled in; change it if they left at another time.' : 'Leave blank only if they are still working.'),
    field('Why', input({ name: 'note', required: true, maxlength: 200, placeholder: 'For example "Forgot to clock out, left at close"' }), 'Kept with the punch and in the audit log, with the old times.')), async (fd) => {
    const out = String(fd.get('out') || '');
    await patch(`/workforce/time/entries/${e.id}`, { clock_in: String(fd.get('in')), clock_out: out || null, note: String(fd.get('note') || '') });
    toast('Punch fixed');
    await done();
  }, { submitText: 'Save fix' });
}

function removePunch(e, done) {
  const note = input({ name: 'note', maxlength: 200, placeholder: 'For example "Double tap at the kiosk"', 'aria-label': 'Why' });
  confirmDialog('Remove this punch?', `${dayShort(e.clock_in.slice(0, 10))} ${hm(e.clock_in)}${e.clock_out ? ` to ${hm(e.clock_out)}` : ''}. Its times and your reason stay in the audit log.`, 'Remove punch', async () => {
    await del(`/workforce/time/entries/${e.id}`, { note: note.value.trim() });
    toast('Punch removed');
    await done();
  }, { danger: true }).body.querySelector('p').after(field('Why', note));
}

async function addPunch(start, done) {
  const { data: staff } = await get('/workforce/staff');
  const d = todayStr() < addDays(start, 6) ? todayStr() : addDays(start, 6);
  formDialog('Add a missed punch', h('div', { class: 'form' },
    field('Who', select(staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`]), '', { name: 'staff_id', required: true })),
    field('Clocked in', input({ type: 'datetime-local', name: 'in', value: `${d}T08:00`, required: true })),
    field('Clocked out', input({ type: 'datetime-local', name: 'out', value: `${d}T16:30`, required: true })),
    field('Why', input({ name: 'note', required: true, maxlength: 200, placeholder: 'For example "Kiosk was down"' }), 'Kept with the punch and in the audit log.')), async (fd) => {
    await post('/workforce/time/entries', { staff_id: Number(fd.get('staff_id')), clock_in: String(fd.get('in')), clock_out: String(fd.get('out')), note: String(fd.get('note') || '') });
    toast('Punch added');
    await done();
  }, { submitText: 'Add punch' });
}

function approve(start, n, attention, done) {
  confirmDialog('Approve hours?', `Approves the closed punches of ${n} ${n === 1 ? 'person' : 'people'} for ${weekLabel(start)}.${attention ? ` ${attention} ${attention === 1 ? 'person has' : 'people have'} a missed clock-out and ${attention === 1 ? 'is' : 'are'} skipped until it is fixed.` : ''} Fixing a punch later undoes its approval.`, 'Approve', async () => {
    const r = await post('/workforce/time/approve', { start });
    toast(`${r.approved} punch${r.approved === 1 ? '' : 'es'} approved${r.skipped_people ? `, ${r.skipped_people} still clocked in or missing a clock-out` : ''}`);
    await done();
  });
}
