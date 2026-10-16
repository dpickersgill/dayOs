// Patrol > Now > Daily log: one page per day, filled from everything recorded that day (weather, who was on, cases,
// calls, opening checks, closures, the sweep, equipment flagged, avalanche work, evacuations), plus the leaders' notes.
// Once signed off it is read only; anything later goes in as an addendum.
import { get, put, post } from '../api.js';
import { h, clear, input, button, toast, formDialog, dialog, empty, errorBox, state, fmtTime, label, todayStr, addDays, act } from '../ui.js';
import { dayLong } from './workforce-common.js';

const t = (v) => (v ? fmtTime(String(v).replace(' ', 'T')) : '');

export async function drawLog(box) {
  let date = todayStr();
  const head = h('div', { class: 'week-bar' });
  const body = h('div', { class: 'stack' });
  clear(box).append(head, body);
  async function load() {
    try { draw(await get(`/patrol/daily-log?date=${date}`)); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function nav(d) {
    const q = input({ type: 'search', placeholder: 'Search the log', 'aria-label': 'Search the daily log' });
    q.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || q.value.trim().length < 2) return;
      const r = await get(`/patrol/daily-log/search?q=${encodeURIComponent(q.value.trim())}`);
      const dlg = dialog(`"${q.value.trim()}" in the log`, r.data.length ? h('ul', { class: 'duty-list' }, r.data.map((x) => h('li', null, h('a', { href: '#/patrol/log', onclick: (ev) => { ev.preventDefault(); date = x.date; dlg.close(); load(); } }, dayLong(x.date)), ` ${x.kind === 'addendum' ? '(addendum) ' : ''}${x.snippet}`))) : empty('Nothing found.'));
    });
    clear(head).append(h('div', { class: 'week-nav' },
      h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Day before', onclick: () => { date = addDays(date, -1); load(); } }, '‹'),
      h('h2', { class: 'week-title' }, dayLong(date)),
      h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Next day', disabled: date >= d.today, onclick: () => { date = addDays(date, 1); load(); } }, '›'),
      date !== d.today ? button('Today', () => { date = d.today; load(); }, { small: true }) : null), h('div', { class: 'grow search' }, q));
  }
  function section(title, rowsEl, none) { return h('section', { class: 'panel stack log-sec' }, h('h3', null, title), rowsEl || h('p', { class: 'muted small' }, none)); }
  const list = (items, fn) => (items && items.length ? h('ul', { class: 'duty-list' }, items.map((x) => h('li', null, ...[].concat(fn(x))))) : null);

  function draw(d) {
    nav(d);
    const notes = h('textarea', { rows: 6, maxlength: 20000, 'aria-label': 'Notes for the day', disabled: Boolean(d.signed) || !d.can_write }, d.notes || '');
    clear(body).append(
      h('section', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('h3', null, 'Leaders\' notes'), d.signed ? state(`Signed off ${t(d.signed.at)} by ${d.signed.by}`, 'good') : null),
        notes,
        d.can_write && !d.signed ? h('div', { class: 'row' },
          button('Save notes', (e) => act(e.currentTarget, async () => { await put('/patrol/daily-log', { date, notes: notes.value }); toast('Notes saved'); })(e), { small: true }),
          date <= d.today ? button('Sign off the day', (e) => act(e.currentTarget, async () => { await put('/patrol/daily-log', { date, notes: notes.value }); await post('/patrol/daily-log/sign', { date }); toast('Day signed off'); await load(); })(e), { small: true, kind: 'primary' }) : null) : null,
        d.addenda.length ? h('div', null, h('h4', null, 'Addenda'), list(d.addenda, (a) => [h('b', null, `${t(a.at)} ${a.by_name || ''}: `), a.body])) : null,
        d.signed && d.can_write ? button('Add an addendum', () => formDialog('Addendum', h('textarea', { name: 'body', rows: 5, required: true, maxlength: 5000 }), async (fd) => { await post('/patrol/daily-log/addenda', { date, body: String(fd.get('body')) }); toast('Addendum added'); await load(); }, { submitText: 'Add' }), { small: true }) : null),
      h('div', { class: 'log-grid' },
        section('Weather and snow', list([...d.weather.map((w) => `${t(w.logged_at)} ${w.place}: ${[w.temp_f != null && `${w.temp_f}°F`, w.wind_mph != null && `wind ${w.wind_mph} mph ${w.wind_dir || ''}`, w.sky && label(w.sky), w.note].filter(Boolean).join(', ')}`),
          ...d.snow.map((s) => `${t(s.read_at)} ${s.trail || 'Base'}: ${[s.new_snow_in != null && `${s.new_snow_in}" new`, s.base_in != null && `${s.base_in}" base`, s.surface, s.note].filter(Boolean).join(', ')}`)], (x) => x), 'Nothing logged on Mountain ops.'),
        section(`On duty (${d.duty.length})`, list(d.duty, (x) => [h('b', null, x.name), ` ${t(x.signed_in_at)} to ${x.signed_out_at ? t(x.signed_out_at) : 'now'}${Number(x.auto_closed) ? ' (auto)' : ''}${x.station ? `, ${x.station}` : ''}`]), 'Nobody signed in.'),
        section(`Cases (${d.case_count})`, d.cases ? list(d.cases, (c) => [h('a', { href: `#/patrol/case/${c.id}` }, c.case_number), ` ${t(c.occurred_at)} ${label(c.category)}, ${c.severity}: ${c.summary}`]) : (d.case_count ? h('p', { class: 'small' }, `${d.case_count} case${d.case_count === 1 ? '' : 's'}`) : null), 'No cases.'),
        section(`Calls (${d.calls.length})`, list(d.calls, (c) => `${c.call_no} ${t(c.received_at)} ${label(c.priority)}: ${c.location} (${label(c.status)})`), 'No calls.'),
        section('Opening and closures', list([...d.opening.map((o) => `${t(o.checked_at)} ${o.trail}: ${label(o.decision)}${o.reason ? `, ${o.reason}` : ''}${o.hazards ? `. ${o.hazards}` : ''}${o.by_name ? ` (${o.by_name})` : ''}`),
          ...d.closures.map((c) => `Now ${label(c.status)}: ${c.name}, ${c.closure_reason}`)], (x) => x), 'No opening checks.'),
        section('Sweep', d.sweep ? h('div', null, h('p', null, d.sweep.status === 'clear' ? h('b', null, `Mountain clear at ${t(d.sweep.clear_at)}`) : state('Not called clear', 'warn'), ` Started ${t(d.sweep.started_at)}.`),
          list(d.sweep.routes, (r) => `${r.route}: ${r.status === 'clear' ? `clear ${t(r.cleared_at)}` : label(r.status)}${r.by_name ? `, ${r.by_name}` : ''}${Number(r.finds) ? `, ${r.finds} found` : ''}`)) : null, 'No sweep recorded.'),
        section('Equipment flagged', list(d.flagged, (f) => `${t(f.checked_at)} ${f.name}: ${label(f.result)}${f.notes ? `, ${f.notes}` : ''}`), 'Nothing flagged.'),
        d.avalanche.obs.length || d.avalanche.shots.length ? section('Avalanche', list([...d.avalanche.obs.map((o) => `${t(o.observed_at)} ${o.hn24_cm != null ? `${o.hn24_cm} cm new, ` : ''}hazard ${[o.hazard_below, o.hazard_near, o.hazard_above].map((x) => x ?? '-').join('/')}`), ...d.avalanche.shots.map((s) => `${t(s.shot_at)} ${s.path}: ${label(s.method)}, ${label(s.result)}${s.size_d ? ` D${s.size_d}` : ''}`)], (x) => x)) : null,
        d.evacs.length ? section('Lift evacuations', list(d.evacs, (e) => `${t(e.started_at)} ${e.lift}: ${label(e.kind)}${e.guests != null ? `, ${e.guests} guests` : ''}`)) : null));
  }
  await load();
}
