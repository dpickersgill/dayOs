// Staff and schedule > Overtime (release 2026.11.20): hours over 40 a week per person, from the time clock, and the
// call-outs (punches marked as a call-out, from Today's "Clock in for a call-out" or marked here). One week or up to
// thirteen; the spreadsheet carries the same columns as the screen (GET /workforce/overtime and /overtime/export).
// Overtime here is the US federal rule (over 40 hours in a Monday-to-Sunday week); check your own contracts and state rules.
import { get, patch, download } from '../api.js';
import { h, clear, select, button, toast, table, state, empty, errorBox, todayStr, addDays, weekStart, fmtDateTime, dialog } from '../ui.js';
import { hrs, monthDay, weekLabel } from './workforce-common.js';

export async function drawOvertime(box) {
  // The last four weeks, this one included, to begin with.
  let start = addDays(weekStart(todayStr()), -21);
  let weeks = 4;
  const head = h('div', { class: 'sched-head' });
  const body = h('div', { class: 'stack' });
  clear(box).append(head, body);
  const span = select([['1', 'One week'], ['4', 'Four weeks'], ['13', 'Thirteen weeks (a quarter)']], '4', { 'aria-label': 'How many weeks', style: 'width:auto' });
  span.addEventListener('change', () => { weeks = Number(span.value); start = addDays(weekStart(todayStr()), -7 * (weeks - 1)); load(); });

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading overtime…'));
    try { draw(await get(`/workforce/overtime?start=${start}&weeks=${weeks}`)); } catch (err) { clear(body).append(errorBox(err)); }
  }
  const go = (d) => { start = d; return load(); };

  function draw(o) {
    clear(head).append(h('div', { class: 'week-bar' },
      h('div', { class: 'week-nav' },
        h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Earlier', onclick: () => go(addDays(start, -7 * weeks)) }, '‹'),
        h('h2', { class: 'week-title' }, weeks === 1 ? weekLabel(start) : `${monthDay(o.start)} to ${monthDay(o.end)}`),
        h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Later', onclick: () => go(addDays(start, 7 * weeks)) }, '›'),
        addDays(start, 7 * (weeks - 1)) !== weekStart(todayStr()) ? button('This week', () => go(addDays(weekStart(todayStr()), -7 * (weeks - 1))), { small: true }) : null),
      h('div', { class: 'week-actions' }, span,
        button('Download spreadsheet', () => download(`/workforce/overtime/export?start=${start}&weeks=${weeks}`, `overtime-${start}.csv`)))));
    const t = o.totals;
    clear(body).append(
      h('p', { class: 'muted' }, `${hrs(t.worked_minutes)} worked, ${hrs(t.overtime_minutes)} over 40 hours a week, ${t.callouts} call-out${t.callouts === 1 ? '' : 's'} (${hrs(t.callout_minutes)}). Overtime is time over 40 hours in a Monday-to-Sunday week, from the time clock.`),
      o.data.length ? table([
        { head: 'Person', cell: (r) => h('b', null, r.name) },
        ...(weeks > 1 ? [{ head: 'Week of', cell: (r) => monthDay(r.week) }] : []),
        { head: 'Worked', num: true, cell: (r) => hrs(r.worked_minutes) },
        { head: 'Regular', num: true, cell: (r) => hrs(r.regular_minutes) },
        { head: 'Over 40', num: true, cell: (r) => (r.overtime_minutes ? state(hrs(r.overtime_minutes), 'warn') : '0h') },
        { head: 'Call-outs', num: true, cell: (r) => (r.callouts ? `${r.callouts} (${hrs(r.callout_minutes)})` : '0') },
        { head: '', actions: true, cell: (r) => button('Punches', () => punches(r), { small: true, label: `Punches for ${r.name}` }) },
      ], o.data) : empty('No time clock punches in these weeks.'));
  }

  function punches(r) {
    const list = h('div');
    const drawList = () => clear(list).append(table([
      { head: 'In', cell: (e) => fmtDateTime(e.clock_in) },
      { head: 'Out', cell: (e) => (e.clock_out ? fmtDateTime(e.clock_out) : state('Still in', 'good')) },
      { head: 'Time', num: true, cell: (e) => hrs(e.minutes) },
      { head: 'Call-out', cell: (e) => { const c = h('input', { type: 'checkbox', checked: e.callout, 'aria-label': 'Call-out' }); c.addEventListener('change', async () => { try { await patch(`/workforce/overtime/entries/${e.id}`, { callout: c.checked }); e.callout = c.checked; toast(c.checked ? 'Marked as a call-out' : 'No longer a call-out'); } catch (err) { c.checked = !c.checked; toast(err.message, 'error'); } }); return c; } },
    ], r.entries));
    drawList();
    dialog(`${r.name}, week of ${monthDay(r.week)}`, h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Tick a punch that was a call-out (called in after hours). The change is logged.'), list), { onClose: () => load() });
  }

  await load();
}
