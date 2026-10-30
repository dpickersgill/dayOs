// Lesson planning, best of breed (2026.11.9), Track STAFF: tabs this part adds to Ski school.
// tabs(ctx) returns [key, label, render] items; school.js places them in its groups.
//   Fill and staff (Planning, key 'fill'): a month calendar with, per day, students booked and spots open, instructors
//   needed and free, a red, amber or green mark and the waitlist. Tap a day for each lesson time, why a lesson that
//   follows staff has the spots it has, and Fill the gap (one tap asks every free, cleared instructor). Supervisors see it;
//   the director acts on it. Below the calendar: sold-out demand and suggestions to add a slot (director only).
//   needsCard(el): the staffing target on My day for instructors ("Saturday, Jan 9 needs 2 more people") with I can work.
import { get, post } from '../api.js';
import { h, clear, ctx as uiCtx, schoolCan, state, button, toast, dialog, fmtDay, empty, errorBox, fail, loading, hashParam, withHashParam, label } from '../ui.js';
import * as planPart from './school-plan.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const clock = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const dayText = (d) => fmtDay(`${d} 12:00:00`);
const MARK = { red: ['Short now', 'bad'], amber: ['Tight', 'warn'], green: ['Covered', 'good'] };
const markState = (m) => (m && MARK[m] ? state(MARK[m][0], MARK[m][1]) : null);
const groupWords = (g) => `${g.band === 'kids' ? 'Kids' : g.band === 'adults' ? 'Teens and adults' : 'All ages'} ${g.discipline === 'ski' ? 'ski' : label(g.discipline).toLowerCase()}`;
const monthName = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const shiftMonth = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + k, 1)); return d.toISOString().slice(0, 7); };

export function tabs() {
  const out = [];
  if (schoolCan('supervisor')) out.push(['fill', 'Fill and staff', (p) => fillTab(p)]);
  return out;
}

/**
 * A month as a calendar: a 7-day grid on wide screens, a list of the days that have something on a phone (CSS).
 * days: [{ date, ... }]; renderDay(day) returns the inside of that day's cell. PLAN's drawMonth is used when it exists,
 * so the fill view sits on the same calendar as the season plan.
 */
function drawMonth(container, month, days, renderDay) {
  if (typeof planPart.drawMonth === 'function') return planPart.drawMonth(container, month, days, renderDay);
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const cells = [];
  for (let i = 0; i < first; i += 1) cells.push(h('div', { class: 'fill-cell blank', 'aria-hidden': 'true' }));
  for (let n = 1; n <= last; n += 1) {
    const date = `${month}-${String(n).padStart(2, '0')}`;
    const d = byDate.get(date);
    cells.push(h('div', { class: `fill-cell${d ? '' : ' none'}`, role: 'listitem' }, renderDay(d || { date })));
  }
  const grid = h('div', { class: 'fill-month', role: 'list', 'aria-label': monthName(month) },
    ...WEEKDAYS.map((w) => h('div', { class: 'fill-wd', 'aria-hidden': 'true' }, w)), ...cells);
  clear(container).append(grid);
  return grid;
}

async function fillTab(root) {
  let month = /^\d{4}-\d{2}$/.test(hashParam('month') || '') ? hashParam('month') : null;
  const title = h('h2', { class: 'fill-title', 'aria-live': 'polite' });
  const cal = h('div', { class: 'fill-cal' });
  const summary = h('div', { class: 'fill-summary' });
  const demand = h('div');
  const go = (k) => { month = shiftMonth(month, k); try { history.replaceState(null, '', withHashParam('month', month)); } catch (_) { /* stays */ } load(); };
  root.append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Each day: students booked and spots still open, the instructors needed for what is booked and the instructors free, and the waitlist. Lessons that follow staff open spots as instructors say they can work. Tap a day for each lesson time.'),
    h('div', { class: 'fill-bar' }, button('Previous month', () => go(-1), { small: true }), title, button('Next month', () => go(1), { small: true })),
    h('ul', { class: 'fill-legend plain', 'aria-label': 'What the marks mean' },
      h('li', null, state('Short now', 'bad'), ' more students booked than instructors free'),
      h('li', null, state('Tight', 'warn'), ' short if it keeps selling, or fewer than 2 spare'),
      h('li', null, state('Covered', 'good'), ' enough instructors')),
    summary, cal,
    schoolCan('director') ? h('section', { class: 'panel stack', 'aria-labelledby': 'dem-h' }, h('h2', { id: 'dem-h' }, 'Sold-out demand'), demand) : null));

  async function load() {
    clear(cal).append(loading());
    try {
      const v = await get(`/skischool/staff/fill${month ? `?month=${month}` : ''}`);
      month = v.month;
      title.textContent = monthName(month);
      const ahead = v.days.filter((d) => !d.past);
      const red = ahead.filter((d) => d.mark === 'red');
      clear(summary).append(h('div', { class: 'stats' },
        stat(ahead.reduce((n, d) => n + d.booked, 0), 'students booked'),
        stat(ahead.reduce((n, d) => n + d.open, 0), 'spots open'),
        stat(red.length, red.length === 1 ? 'day short now' : 'days short now'),
        stat(ahead.reduce((n, d) => n + d.waitlist, 0), 'on waitlists')),
        v.days.length ? null : empty('No lessons this month. Publish a season plan, or move to another month.'));
      drawMonth(cal, month, v.days, (d) => dayCell(d, v.today));
    } catch (err) { clear(cal).append(errorBox(err)); }
  }

  function dayCell(d, today) {
    const n = Number(d.date.slice(8));
    if (!d.lessons) return h('div', { class: 'fill-day empty' }, h('span', { class: 'fill-num' }, String(n)));
    const words = `${dayText(d.date)}: ${plural(d.booked, 'student')} booked, ${d.open} spots open, ${d.need} instructors needed, ${d.available} free${d.mark ? `, ${MARK[d.mark][0]}` : ''}${d.waitlist ? `, ${d.waitlist} on the waitlist` : ''}`;
    return h('button', { type: 'button', class: `fill-day${d.mark ? ` mark-${d.mark}` : ''}${d.past ? ' past' : ''}${d.date === today ? ' today' : ''}`, 'aria-label': words, onclick: () => dayDialog(d.date, load) },
      h('span', { class: 'fill-head' }, h('span', { class: 'fill-num' }, String(n)), h('span', { class: 'fill-wdname' }, dayText(d.date)), d.mark ? markState(d.mark) : null),
      h('span', { class: 'fill-line' }, `${d.booked} booked, ${d.open} open`),
      h('span', { class: 'fill-line' }, `Need ${d.need}, ${d.available} free`),
      d.waitlist ? h('span', { class: 'fill-line' }, `${d.waitlist} waiting`) : null,
      d.advance && !d.past ? h('span', { class: 'fill-line muted' }, 'No availability in yet') : null);
  }

  async function loadDemand() {
    if (!schoolCan('director')) return;
    try {
      const v = await get('/skischool/staff/demand');
      clear(demand).append(
        h('p', { class: 'muted small' }, 'Lesson times that filled this season, how early, and the guests turned away (waitlist sign-ups and booking page searches that found it full). Suggestions only: nothing is added unless you add it to the season plan.'),
        v.suggestions.length ? h('ul', { class: 'plain stack' }, v.suggestions.slice(0, 5).map((s) => h('li', { class: 'fill-suggest' },
          h('div', null, h('strong', null, s.words), h('div', { class: 'muted small' }, s.why)),
          h('a', { class: 'btn small', href: '#/school?tab=plan&view=season' }, 'Open the season plan')))) : h('p', null, 'No suggestions yet. They show up once a lesson time fills on two or more days.'),
        v.rows.length ? h('details', null, h('summary', null, `Every lesson time that filled or turned guests away (${v.rows.length})`),
          h('ul', { class: 'plain' }, v.rows.slice(0, 30).map((r) => h('li', null, r.words, ` ${plural(r.booked, 'lesson')} booked.`)))) : null);
    } catch (err) { clear(demand).append(errorBox(err)); }
  }

  await Promise.all([load(), loadDemand()]);
}

const stat = (big, small) => h('div', { class: 'stat' }, h('strong', null, String(big)), h('span', null, small));

/** One day: each lesson time with its numbers, each lesson's spots and why, Fill the gap, and who was asked. */
async function dayDialog(date, onChange) {
  const body = h('div', { class: 'stack fill-dlg', 'aria-live': 'polite' }, loading());
  const dlg = dialog(dayText(date), body, { wide: true });
  async function draw() {
    let v;
    try { v = await get(`/skischool/staff/fill/day?date=${date}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    clear(body);
    if (v.advance && !v.past) body.append(h('p', { class: 'notice' }, 'No instructor has said when they can work this day yet, so lessons that follow staff sell up to their cap. Spots start to follow staff once availability comes in.'));
    if (!v.groups.length) { body.append(empty('No lessons on this day.')); return; }
    for (const g of v.groups) {
      const head = h('div', { class: 'fill-ghead' }, h('h3', null, `${clock(g.time)}, ${groupWords(g)}`), markState(g.mark));
      const nums = h('p', { class: 'fill-nums' },
        `${plural(g.booked, 'student')} booked, ${g.open} spots open${g.waitlist ? `, ${g.waitlist} on the waitlist` : ''}. `,
        `Needs ${plural(g.need, 'instructor')} (${g.ratio} students each), ${g.available} free.`);
      const lessons = h('ul', { class: 'plain fill-lessons' }, g.lessons.map((l) => h('li', null,
        h('strong', null, l.product), ` ${clock(String(l.starts_at).slice(11, 16))} to ${clock(String(l.ends_at).slice(11, 16))}, ${l.level_words || 'All levels'}${l.instructor ? `, ${l.instructor}` : ''}`,
        h('div', { class: 'muted small' }, `${l.capacity} spots, ${l.booked} booked${l.held ? `, ${l.held} held` : ''}, ${l.open} open${l.waitlist ? `, ${l.waitlist} waiting` : ''}. `,
          l.follows_staff ? `Follows staff: ${l.reason || `cap ${l.cap}`}.` : 'Spots are the number typed.'))));
      const act = g.short && schoolCan('director') && !v.past
        ? button(`Fill the gap: ask for ${plural(g.short, 'instructor')}`, async () => {
          try {
            const r = await post('/skischool/staff/fill/ask', { date, time: g.time, discipline: g.discipline, band: g.band });
            toast(`Asked ${plural(r.asked.length, 'instructor')}: ${r.asked.join(', ')}`);
            await draw(); if (onChange) onChange();
          } catch (err) { fail(err); }
        }, { kind: 'primary', label: `Fill the gap at ${clock(g.time)}, ${groupWords(g)}: ask for ${plural(g.short, 'instructor')}` })
        : null;
      body.append(h('section', { class: `fill-group${g.mark ? ` mark-${g.mark}` : ''}` }, head, g.words ? h('p', { class: 'fill-short' }, g.words) : null, nums, lessons, act));
    }
    if (v.asks.length) {
      body.append(h('section', { class: 'stack' }, h('h3', null, 'Asked to fill the gap'), h('ul', { class: 'plain stack' }, v.asks.map((a) => h('li', null,
        h('strong', null, `${clock(a.time)}, ${groupWords(a)}: short ${a.short_n}`), ' ', state(a.status === 'filled' ? 'Filled' : a.status === 'closed' ? 'Closed' : 'Open', a.status === 'filled' ? 'good' : a.status === 'open' ? 'warn' : 'neutral'),
        h('div', { class: 'muted small' }, `Asked ${a.asked.join(', ') || 'nobody'}. ${a.accepted.length ? `Said yes: ${a.accepted.join(', ')}.` : 'Nobody has said yes yet.'}${a.declined.length ? ` Said no: ${a.declined.join(', ')}.` : ''}`))))));
    }
  }
  await draw();
  return dlg;
}

/** The staffing target on My day (instructors): the next 14 days short of people they could teach, with I can work. */
export async function needsCard(el) {
  if (!uiCtx.me || uiCtx.me.role !== 'instructor') return;
  const { data } = await get('/skischool/staff/needs');
  if (!data.length) return;
  const box = h('section', { class: 'panel stack fill-needs', 'aria-labelledby': 'needs-h' }, h('h2', { id: 'needs-h' }, 'The school needs people'));
  const list = h('ul', { class: 'plain stack' });
  for (const n of data.slice(0, 5)) {
    const li = h('li', { class: 'fill-need' }, h('span', null, n.words));
    if (n.counted) li.append(h('span', { class: 'muted small' }, 'You are down as free then. Thanks!'));
    else {
      li.append(button('I can work', async (b) => {
        try {
          await post('/skischool/staff/needs/can-work', { date: n.date, time: n.time, discipline: n.discipline, band: n.band });
          clear(li).append(h('span', null, n.words), h('span', { class: 'muted small' }, 'Thanks! You are marked free then. The director assigns the classes.'));
          toast('Marked free for that time');
        } catch (err) { fail(err); b.disabled = false; }
      }, { small: true, kind: 'primary', label: `I can work: ${n.words}` }));
    }
    list.append(li);
  }
  box.append(list);
  if (data.length > 5) box.append(h('p', { class: 'muted small' }, `${data.length - 5} more times in the next two weeks.`));
  el.append(box);
}
