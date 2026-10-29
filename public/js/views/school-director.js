// The ski school, round 2 (director). school.js adds these tabs to Ski school and these pages to Settings, Ski school.
// tabs(ctx): [[key, label, (panel) => render]], ctx = { staff, names, certs }. settingsPages: { key: { title, render(panel) } }.
//   Copy a day: copy a day or a weekend to other days (instructors too, when they are free), templates, undo.
//   Weather: delay, cancel or move a day's lessons and program meetings in one place; each family chooses what they want.
//   Staffing: booked and expected students against instructors for the next 14 days, holidays, shift offers, certifications.
//   Reports: seat fill, revenue, first lesson to return, no-shows, privates and requests, recaps and tips (counts).
//   Shift offers (instructors): offers sent to me, first to say yes gets it.
import { get, post, put, del, download } from '../api.js';
import { h, clear, isManager, can, ctx as uiCtx, table, state, input, select, field, button, toast, formDialog, dialog, confirmDialog, val, num, todayStr, addDays, fmtDate, fmtDateLong, fmtTime, fmtRange, label, empty, errorBox, money, fail, appendAll, loading, hashParam } from '../ui.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const dayWords = (d) => fmtDateLong(`${d} 12:00:00`);
const clock = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const stat = (big, small) => h('div', { class: 'stat' }, h('strong', null, String(big)), h('span', null, small));
const isInstructorOnly = () => !isManager() && uiCtx.me && uiCtx.me.role === 'instructor';

export function tabs(ctx) {
  const out = [];
  if (isManager()) {
    out.push(['copy', 'Copy a day', (p) => copyTab(p, ctx)]);
    out.push(['weather', 'Weather', (p) => weatherTab(p, ctx)]);
    out.push(['staffing', 'Staffing', (p) => staffingTab(p, ctx)]);
    out.push(['reports', 'Reports', (p) => reportsTab(p)]);
  } else if (can('counter')) {
    out.push(['weather', 'Weather', (p) => weatherTab(p, ctx)]);
  }
  if (isInstructorOnly()) out.push(['offers', 'Shift offers', (p) => offersTab(p)]);
  return out;
}

export const settingsPages = {
  weather: { title: 'Weather and makeups', render: (panel) => weatherSettings(panel) },
};

// ---------------------------------------------------------------- copy a day
/** The last Saturday before today (or today when it is one): the usual day to copy from. */
function lastSaturday() { let d = todayStr(); while (weekday(d) !== 6) d = addDays(d, -1); return d; }

async function copyTab(root, { names }) {
  const kind = select([['day', 'One day'], ['weekend', 'A weekend (2 days)'], ['template', 'A saved template']], 'day', { name: 'copy-kind' });
  const from = input({ type: 'date', value: lastSaturday() });
  const tplSel = select([['', 'No templates yet']], '');
  const keep = h('input', { type: 'checkbox', checked: true });
  const targets = new Set([addDays(from.value, 7)]);
  const pick = input({ type: 'date', value: addDays(from.value, 14) });
  const chips = h('div', { class: 'copy-days', 'aria-live': 'polite' });
  const result = h('div', { class: 'stack', 'aria-live': 'polite' });
  const recent = h('div');
  const tplBox = h('div');
  const fromField = field('Copy from', from, 'The first day; a weekend takes the next day too');
  const tplField = field('Template', tplSel);
  tplField.hidden = true;
  let templates = [];
  let seen = null;

  const drawChips = () => {
    clear(chips).append(...[...targets].sort().map((d) => h('span', { class: 'copy-day' }, `${dayWords(d)}${kind.value === 'weekend' ? ` and ${fmtDate(`${addDays(d, 1)} 12:00:00`)}` : ''}`,
      button('Remove', () => { targets.delete(d); drawChips(); seen = null; clear(result); }, { small: true, kind: 'quiet', label: `Remove ${dayWords(d)}` }))));
    if (!targets.size) chips.append(h('p', { class: 'muted small' }, 'Add at least one day to copy to.'));
  };
  const body = () => ({
    source: kind.value === 'template' ? { template_id: Number(tplSel.value) } : { from: from.value, days: kind.value === 'weekend' ? 2 : 1 },
    targets: [...targets].sort(), with_instructors: keep.checked,
  });
  kind.addEventListener('change', () => { tplField.hidden = kind.value !== 'template'; fromField.hidden = kind.value === 'template'; drawChips(); seen = null; clear(result); });
  from.addEventListener('change', () => { if (targets.size <= 1) { targets.clear(); targets.add(addDays(from.value, 7)); pick.value = addDays(from.value, 14); drawChips(); } seen = null; clear(result); });

  async function preview() {
    if (!targets.size) { toast('Add a day to copy to', 'error'); return; }
    clear(result).append(loading('Checking'));
    try {
      const p = await post('/skischool/director/copy/preview', body());
      seen = JSON.stringify(body());
      const byDay = p.days.map((d) => {
        const ls = p.lessons.filter((l) => l.date === d);
        return h('details', { class: 'panel', open: p.days.length === 1 },
          h('summary', null, h('strong', null, dayWords(d)), h('span', { class: 'muted' }, `  ${plural(ls.filter((l) => !l.skip).length, 'lesson')} to make`)),
          table([
            { head: 'Time', cell: (l) => `${clock(l.start)} to ${clock(l.end)}` },
            { head: 'Lesson', cell: (l) => h('span', null, h('strong', null, l.product), h('div', { class: 'muted small' }, `${label(l.discipline)}, ${l.level_words}${l.format !== 'group' ? `, ${label(l.format)}` : ''}`)) },
            { head: 'Instructor', cell: (l) => (l.skip ? state(l.skip, 'neutral') : l.instructor_problem ? h('span', null, state('Copied without', 'warn'), h('div', { class: 'muted small' }, l.instructor_problem)) : l.instructor_id ? names.get(l.instructor_id) || 'Kept' : 'Assign later') },
          ], ls));
      });
      appendAll(clear(result),
        h('p', null, h('strong', null, `${plural(p.to_make, 'lesson')} will be made`), p.skipped ? ` (${p.skipped} already there)` : '', p.without_instructor ? `. ${plural(p.without_instructor, 'lesson')} without an instructor, see why below.` : '.'),
        ...byDay,
        p.to_make ? h('div', { class: 'row' }, button(`Make ${plural(p.to_make, 'lesson')}`, make, { kind: 'primary' })) : null);
    } catch (err) { clear(result).append(errorBox(err)); }
  }
  async function make() {
    if (seen !== JSON.stringify(body())) { await preview(); return; }
    const r = await post('/skischool/director/copy', body());
    toast(`${plural(r.to_make, 'lesson')} made`);
    clear(result).append(h('div', { class: 'notice good stack' }, h('p', null, `${plural(r.to_make, 'lesson')} made on ${r.days.map(dayWords).join(', ')}.`),
      h('div', { class: 'row' }, button('Undo this copy', () => undo(r.id), { small: true }))));
    seen = null;
    await loadRecent();
  }
  async function undo(id) {
    confirmDialog('Undo this copy?', 'The copied lessons nobody has booked are deleted. Lessons with bookings stay.', 'Undo copy', async () => {
      try {
        const r = await post(`/skischool/director/copies/${id}/undo`, {});
        toast(`${plural(r.deleted, 'lesson')} deleted`);
        if (r.kept.length) dialog('Some lessons stayed', h('div', { class: 'stack' }, h('p', null, 'These have bookings, so they stay. Cancel them from the Lessons tab if you need to.'), h('ul', null, r.kept.map((k) => h('li', null, `${k.product}, ${fmtRange(k.starts_at, k.starts_at)}`)))));
        clear(result); await loadRecent();
      } catch (err) { fail(err); }
    }, { danger: true });
  }
  async function loadRecent() {
    try {
      const { data } = await get('/skischool/director/copies');
      clear(recent).append(data.length ? table([
        { head: 'Made', cell: (c) => fmtDate(c.created_at) },
        { head: 'Copy', cell: (c) => c.label },
        { head: 'To', cell: (c) => JSON.parse(c.target_dates).map((d) => fmtDate(`${d} 12:00:00`)).join(', ') },
        { head: 'Lessons', num: true, cell: (c) => String(c.lessons_n) },
        { head: '', actions: true, cell: (c) => (c.undone_at ? state('Undone', 'neutral') : button('Undo', () => undo(c.id), { small: true })) },
      ], data) : h('p', { class: 'muted' }, 'No copies yet.'));
    } catch (err) { clear(recent).append(errorBox(err)); }
  }
  async function loadTemplates() {
    try {
      templates = (await get('/skischool/director/templates')).data;
      clear(tplSel).append(...(templates.length ? templates.map((t) => h('option', { value: String(t.id) }, `${t.name} (${plural(t.lessons, 'lesson')})`)) : [h('option', { value: '' }, 'No templates yet')]));
      clear(tplBox).append(templates.length ? h('ul', { class: 'plain stack' }, templates.map((t) => h('li', { class: 'spread' },
        h('span', null, h('strong', null, t.name), h('span', { class: 'muted small' }, `  ${plural(t.lessons, 'lesson')}, ${clock(t.first)} to ${clock(t.last)}`)),
        h('span', { class: 'row tight' },
          button('Use', () => { kind.value = 'template'; tplSel.value = String(t.id); kind.dispatchEvent(new Event('change')); from.focus(); window.scrollTo({ top: 0, behavior: 'smooth' }); }, { small: true, label: `Use template ${t.name}` }),
          button('Delete', () => confirmDialog(`Delete the template ${t.name}?`, 'Lessons already made from it stay.', 'Delete', async () => { await del(`/skischool/director/templates/${t.id}`); await loadTemplates(); }, { danger: true }), { small: true, kind: 'quiet', label: `Delete template ${t.name}` }))))) : h('p', { class: 'muted' }, 'Save a busy day as a template ("Holiday Saturday") and apply it to any date.'));
    } catch (err) { clear(tplBox).append(errorBox(err)); }
  }
  const saveTemplate = () => formDialog('Save a day as a template', h('div', { class: 'form' },
    field('Day', input({ type: 'date', name: 'date', value: from.value, required: true })),
    field('Name', input({ name: 'name', required: true, maxlength: 80, placeholder: 'Holiday Saturday' }), 'Saving with a name you already used replaces that template')), async (fd) => {
    const r = await post('/skischool/director/templates', { name: val(fd, 'name'), date: val(fd, 'date') });
    toast(`Template saved with ${plural(r.lessons, 'lesson')}`);
    await loadTemplates();
  });

  root.append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Copy every lesson from a day or a weekend: times, lesson, levels, ages, spots, meeting place and type. Check what will be made, then make it. A copy made by mistake can be undone.'),
    h('section', { class: 'panel stack', 'aria-labelledby': 'copy-h' }, h('h2', { id: 'copy-h' }, 'Copy lessons'),
      h('div', { class: 'form' }, field('What to copy', kind), fromField, tplField),
      h('div', { class: 'stack' }, h('p', { class: 'small' }, h('strong', null, 'Copy to')), chips,
        h('div', { class: 'inline-form' }, field('Add a day', pick),
          button('Add', () => { if (pick.value) { targets.add(pick.value); pick.value = addDays(pick.value, 7); drawChips(); seen = null; clear(result); } }),
          button('Next 4 weeks', () => { const s = kind.value === 'template' ? todayStr() : from.value; for (let i = 1; i <= 4; i += 1) targets.add(addDays(s, 7 * i)); drawChips(); seen = null; clear(result); }, { label: 'Add the same day for the next 4 weeks' }))),
      h('label', { class: 'check' }, keep, ' Keep the instructors (only when they are free and cleared that day)'),
      h('div', { class: 'row' }, button('Check what will be made', preview, { kind: 'primary' })),
      result),
    h('section', { class: 'panel stack', 'aria-labelledby': 'tpl-h' }, h('div', { class: 'spread' }, h('h2', { id: 'tpl-h' }, 'Templates'), button('Save a day as a template', saveTemplate, { small: true })), tplBox),
    h('section', { class: 'panel stack', 'aria-labelledby': 'recent-h' }, h('h2', { id: 'recent-h' }, 'Recent copies'), recent)));
  drawChips();
  await Promise.all([loadRecent(), loadTemplates()]);
}

// ---------------------------------------------------------------- the weather playbook
const ACTIONS = [
  ['delay', 'Delay', 'Start later. Families and instructors are told the new time.'],
  ['cancel', 'Cancel', 'Each family picks a makeup day, a lesson credit or a refund.'],
  ['move', 'Move to a makeup day', 'Same times on another day. Families are booked there and can take a credit or refund instead.'],
];

async function weatherTab(root) {
  const history = h('div', { class: 'stack' });
  if (isManager()) root.append(callForm(() => loadHistory()));
  root.append(h('section', { class: 'panel stack', 'aria-labelledby': 'wx-hist' }, h('h2', { id: 'wx-hist' }, 'Weather calls and family choices'),
    h('p', { class: 'muted small' }, 'See what each family chose. If a family calls or comes to the window, choose for them here.'), history));
  async function loadHistory() {
    clear(history).append(loading());
    try {
      const { data } = await get('/skischool/director/weather/calls');
      clear(history).append(data.length ? h('ul', { class: 'plain stack' }, data.map((c) => {
        const ch = c.choices || {};
        const total = Object.values(ch).reduce((a, b) => a + b, 0);
        return h('li', { class: 'spread' },
          h('span', null, h('strong', null, `${label(c.action === 'move' ? 'moved' : c.action === 'delay' ? 'delayed' : 'canceled')} ${dayWords(String(c.on_date).slice(0, 10))}`),
            h('div', { class: 'muted small' }, `${c.reason}. ${plural(c.lessons_n, 'lesson')}, ${plural(c.meetings_n, 'program meeting')}${c.action === 'delay' ? `, ${c.delay_minutes} minutes` : ''}${c.makeup_date ? `, to ${fmtDate(`${String(c.makeup_date).slice(0, 10)} 12:00:00`)}` : ''}.`),
            total ? h('div', { class: 'small' }, [['open', 'still to choose'], ['makeup', 'makeup'], ['credit', 'credit'], ['refund', 'refund']].filter(([k]) => ch[k]).map(([k, w]) => `${ch[k]} ${w}`).join(', ')) : null),
          total ? button('Families', () => familiesDialog(c, loadHistory), { small: true, label: `Families for ${dayWords(String(c.on_date).slice(0, 10))}` }) : null);
      })) : h('p', { class: 'muted' }, 'No weather calls yet.'));
    } catch (err) { clear(history).append(errorBox(err)); }
  }
  await loadHistory();
}

function callForm(done) {
  const asked = hashParam('day');
  const date = input({ type: 'date', value: /^\d{4}-\d{2}-\d{2}$/.test(asked || '') ? asked : todayStr() });
  const some = h('input', { type: 'checkbox' });
  const fromT = input({ type: 'time', value: '09:00' });
  const toT = input({ type: 'time', value: '12:00' });
  const times = h('div', { class: 'inline-form', hidden: true }, field('From', fromT), field('Until', toT));
  const minutes = select([['15', '15 minutes'], ['30', '30 minutes'], ['45', '45 minutes'], ['60', '1 hour'], ['90', '1 hour 30 minutes'], ['120', '2 hours']], '30');
  const makeup = input({ type: 'date', value: addDays(todayStr(), 1) });
  const reason = input({ maxlength: 300, placeholder: 'For example: wind hold on the main lift' });
  const minutesF = field('How long', minutes); const makeupF = field('Makeup day', makeup, 'Lessons keep their times');
  const what = h('div', { class: 'stack', 'aria-live': 'polite' });
  let action = 'delay';
  const radios = ACTIONS.map(([k, t, d]) => {
    const r = h('input', { type: 'radio', name: 'wx-action', value: k, checked: k === action });
    r.addEventListener('change', () => { action = k; sync(); look(); });
    return h('label', { class: 'wx-choice' }, r, h('span', null, h('strong', null, t), h('small', null, d)));
  });
  const go = button('Delay', run, { kind: 'primary' });
  const sync = () => {
    minutesF.hidden = action !== 'delay'; makeupF.hidden = action !== 'move'; times.hidden = !some.checked;
    go.textContent = action === 'delay' ? 'Delay' : action === 'cancel' ? 'Cancel' : 'Move';
  };
  const scope = () => ({ action, date: date.value, ...(some.checked ? { from_time: fromT.value, to_time: toT.value } : {}), ...(action === 'delay' ? { delay_minutes: Number(minutes.value) } : {}), ...(action === 'move' ? { makeup_date: makeup.value } : {}) });
  let last = null;
  async function look() {
    clear(what).append(loading('Checking'));
    try {
      const p = await post('/skischool/director/weather/preview', scope());
      last = { key: JSON.stringify(scope()), p };
      const c = p.counts;
      appendAll(clear(what),
        c.lessons || c.meetings ? h('p', { class: 'notice' }, p.words) : empty('No lessons or program meetings are scheduled then.'),
        c.lessons ? h('details', null, h('summary', null, plural(c.lessons, 'lesson')), h('ul', { class: 'plain' }, p.lessons.map((s) => h('li', null, `${fmtTime(s.starts_at)} ${s.product}, ${s.level_words}: ${plural(s.booked, 'student')}`)))) : null,
        c.meetings ? h('details', null, h('summary', null, plural(c.meetings, 'program meeting')), h('ul', { class: 'plain' }, p.meetings.map((m) => h('li', null, `${fmtTime(m.starts_at)} ${m.program}${m.term ? `, ${m.term}` : ''}: ${plural(m.enrolled, 'child', 'children')}${action === 'cancel' ? (m.makeup_date ? `. Makeup week ${fmtDate(`${m.makeup_date} 12:00:00`)}` : '. No makeup week left') : ''}`)))) : null,
        action !== 'delay' && (c.paid_online || c.paid_desk || c.on_package) ? h('p', { class: 'muted small' }, `How they paid: ${[c.paid_online ? `${c.paid_online} online` : null, c.paid_desk ? `${c.paid_desk} at the desk` : null, c.on_package ? `${c.on_package} on a package` : null, c.unpaid ? `${c.unpaid} not yet` : null].filter(Boolean).join(', ')}. Card refunds go back to the card; the rest are listed for the desk.`) : null,
        action !== 'delay' && c.meetings && !p.credit_product ? h('p', { class: 'notice warn' }, 'Program families can only choose a makeup or a refund: add a single lesson product to offer a lesson credit too.') : null);
      go.disabled = !(c.lessons || c.meetings);
    } catch (err) { clear(what).append(errorBox(err)); go.disabled = true; }
  }
  async function run() {
    if (!reason.value.trim() || reason.value.trim().length < 3) { reason.focus(); toast('Say why in a few words. Families see it.', 'error'); return; }
    if (!last || last.key !== JSON.stringify(scope())) { await look(); return; }
    const verb = action === 'delay' ? 'Delay' : action === 'cancel' ? 'Cancel' : 'Move';
    confirmDialog(`${verb} ${dayWords(date.value)}?`, last.p.words, `${verb} now`, async () => {
      try {
        const r = await post('/skischool/director/weather', { ...scope(), reason: reason.value.trim() });
        toast(`Done. ${plural(r.emails, 'email')}${r.texts ? ` and ${plural(r.texts, 'text')}` : ''} sent`);
        if ((r.not_moved && r.not_moved.length) || (r.instructors_dropped && r.instructors_dropped.length)) {
          dialog('Check these', h('div', { class: 'stack' },
            r.not_moved.length ? [h('p', null, h('strong', null, 'Not moved (they have a link to choose):')), h('ul', null, r.not_moved.map((x) => h('li', null, `${x.name}: ${x.why}`)))] : null,
            r.instructors_dropped.length ? [h('p', null, h('strong', null, 'Moved without their instructor:')), h('ul', null, r.instructors_dropped.map((x) => h('li', null, `${x.session} ${fmtTime(x.at)}: ${x.why}`)))] : null));
        }
        last = null; reason.value = '';
        await look(); await done();
      } catch (err) { fail(err); }
    }, { danger: action !== 'delay' });
  }
  [date, fromT, toT, minutes, makeup].forEach((el) => el.addEventListener('change', look));
  some.addEventListener('change', () => { sync(); look(); });
  sync(); look();
  return h('section', { class: 'panel stack', 'aria-labelledby': 'wx-h' },
    h('h2', { id: 'wx-h' }, 'Make a weather call'),
    h('p', { class: 'muted small' }, 'One place for lessons and program meetings together. All of it happens at once, or none of it does.'),
    h('div', { class: 'inline-form' }, field('Day', date), h('label', { class: 'check' }, some, ' Only some times')), times,
    h('fieldset', { class: 'wx-choices' }, h('legend', null, 'What to do'), ...radios),
    h('div', { class: 'inline-form' }, minutesF, makeupF, field('Why', reason, 'Goes in the message to families')),
    what, h('div', { class: 'row' }, go));
}

async function familiesDialog(call, reload) {
  const body = h('div', { class: 'stack' }, loading());
  const close = dialog(`Families: ${dayWords(String(call.on_date).slice(0, 10))}`, body, { wide: true });
  async function load() {
    try {
      const { data } = await get(`/skischool/director/weather/calls/${call.id}/choices`);
      const deskOwed = data.filter((c) => c.refund_how === 'desk');
      appendAll(clear(body),
        deskOwed.length ? h('div', { class: 'notice warn stack' }, h('b', null, 'Refund these at the desk'), h('ul', { class: 'plain' }, deskOwed.map((c) => h('li', null, `${c.first_name} ${c.last_name}: ${money(c.refund_cents)}`)))) : null,
        table([
          { head: 'Student', cell: (c) => h('span', null, h('strong', null, `${c.first_name} ${c.last_name}`), h('div', { class: 'muted small' }, `${c.what || ''} ${c.starts_at ? fmtTime(c.starts_at) : ''}`)) },
          { head: 'Choice', cell: (c) => h('span', null, state(c.choice === 'open' ? 'Still to choose' : label(c.choice), c.choice === 'open' ? 'warn' : 'good'),
            h('div', { class: 'muted small' }, c.choice === 'open' ? (c.on_package || c.value_cents || c.kind === 'program' ? `Becomes a credit ${fmtDate(c.expires_at)}` : `Not paid: stays canceled after ${fmtDate(c.expires_at)}`) : c.choice === 'makeup' && (c.makeup_at || c.makeup_meeting_at) ? fmtDate(c.makeup_at || c.makeup_meeting_at) : c.choice === 'refund' ? `${money(c.refund_cents)}${c.refund_how === 'card' ? ' to the card' : c.refund_how === 'desk' ? ' at the desk' : ''}` : c.chosen_via === 'auto' ? 'No answer, so a credit' : '')) },
          { head: 'Paid', cell: (c) => (c.on_package ? 'Package' : c.value_cents ? money(c.value_cents) : 'Not paid') },
          { head: '', actions: true, cell: (c) => (['open', 'makeup'].includes(c.choice) ? button('Choose for them', () => chooseFor(c, async () => { await load(); await reload(); }), { small: true, label: `Choose for ${c.first_name}` }) : null) },
        ], data));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
  return close;
}

async function chooseFor(c, done) {
  let v;
  try { v = await get(`/skischool/director/weather/choices/${c.id}`); } catch (err) { fail(err); return; }
  const opts = [];
  for (const m of v.makeups) opts.push([`m${m.id}`, `Makeup: ${fmtRange(m.starts_at, m.ends_at)}${m.product ? `, ${m.product}` : ''}${m.spots_left ? ` (${m.spots_left} left)` : ''}`]);
  if (v.credit_ok) opts.push(['credit', v.credit_words ? `Credit: ${v.credit_words}` : 'Lesson credit']);
  if (v.refund_ok) opts.push(['refund', `Refund ${money(v.refund.cents)}${v.refund.how === 'card' ? ' to the card' : ' at the desk'}`]);
  if (!opts.length) { toast('There is nothing to choose right now', 'error'); return; }
  formDialog(`Choose for ${c.first_name}`, h('div', { class: 'form' }, h('div', { class: 'wide' }, field('What they want', select(opts, opts[0][0], { name: 'pick' })))), async (fd) => {
    const p = val(fd, 'pick');
    const bodyOf = p.startsWith('m') ? (v.kind === 'lesson' ? { choice: 'makeup', session_id: Number(p.slice(1)) } : { choice: 'makeup', meeting_id: Number(p.slice(1)) }) : { choice: p };
    await post(`/skischool/director/weather/choices/${c.id}/choose`, bodyOf);
    toast('Saved');
    await done();
  });
}

async function weatherSettings(panel) {
  const s = await get('/skischool/director/settings');
  const { data } = await get('/products?kind=lesson&active=1&limit=500');
  const singles = data.filter((p) => !(p.uses > 1));
  const prod = select([['', 'The cheapest group lesson'], ...singles.map((p) => [String(p.id), p.name])], s.weather_credit_product_id ? String(s.weather_credit_product_id) : '');
  const days = input({ type: 'number', min: 1, max: 30, value: s.choice_days });
  // Saved with its own button (not the page's save bar), like the other Ski school parts.
  const save = button('Save weather settings', async () => {
    try { await put('/skischool/director/settings', { weather_credit_product_id: prod.value ? Number(prod.value) : null, choice_days: Number(days.value) || 7 }); toast('Saved'); } catch (err) { fail(err); }
  }, { kind: 'primary' });
  panel.append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'When lessons or program meetings are canceled for weather, each family gets a link to choose a makeup, a lesson credit or a refund.'),
    h('div', { class: 'form' }, field('Days families have to choose', days, 'After that, an open choice becomes a lesson credit'),
      field('Lesson credit for program families', prod, 'A program family who takes a credit gets one of these lessons')),
    h('div', { class: 'row' }, save)));
}

// ---------------------------------------------------------------- staffing
async function staffingTab(root) {
  const from = input({ type: 'date', value: todayStr() });
  const onlyGaps = h('input', { type: 'checkbox' });
  const body = h('div', { class: 'stack' });
  const offers = h('div'); const holidays = h('div'); const certs = h('div');
  root.append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'The next 14 days: students booked at each lesson time, the walk-ups to expect (from the same weekday so far this season), and the instructors on those lessons. A gap means more instructors are needed.'),
    h('div', { class: 'inline-form' }, field('From', from), h('label', { class: 'check' }, onlyGaps, ' Only times that need more instructors'), button('Show', () => load(), { kind: 'primary' })),
    body,
    h('section', { class: 'panel stack', 'aria-labelledby': 'off-h' }, h('h2', { id: 'off-h' }, 'Shift offers'), offers),
    h('section', { class: 'panel stack', 'aria-labelledby': 'hol-h' }, h('div', { class: 'spread' }, h('h2', { id: 'hol-h' }, 'School holidays'), button('Add a holiday', addHoliday, { small: true })),
      h('p', { class: 'muted small' }, 'Busier days. They are compared with past holidays, or counted half again busier than a usual day.'), holidays),
    h('section', { class: 'panel stack', 'aria-labelledby': 'cert-h' }, h('h2', { id: 'cert-h' }, 'Certifications'), certs)));
  onlyGaps.addEventListener('change', () => load());
  async function load() {
    clear(body).append(loading());
    try {
      const v = await get(`/skischool/director/staffing?from=${from.value}`);
      const slots = onlyGaps.checked ? v.slots.filter((s) => s.gap) : v.slots;
      const gaps = v.slots.filter((s) => s.gap);
      const days = [...new Set(slots.map((s) => s.date))];
      appendAll(clear(body),
        h('div', { class: 'stats' }, stat(v.slots.reduce((n, s) => n + s.booked, 0), 'students booked'), stat(v.slots.reduce((n, s) => n + s.walkups, 0), 'walk-ups expected'), stat(gaps.length, gaps.length === 1 ? 'time short of instructors' : 'times short of instructors'), stat(`${v.ratio_kids} / ${v.ratio_adults}`, 'students per instructor, kids / adults')),
        gaps.length ? h('div', { class: 'notice warn' }, h('ul', { class: 'plain' }, gaps.slice(0, 6).map((g) => h('li', null, g.words, g.available ? ` (${g.available} free to ask)` : ' (nobody free to ask)')))) : null,
        days.length ? days.map((d) => h('section', { class: 'stack staffing-day' }, h('h3', null, dayWords(d), v.holidays.includes(d) ? h('span', null, ' ', state('Holiday', 'neutral')) : null),
          table([
            { head: 'Time', cell: (s) => h('strong', null, clock(s.time)) },
            { head: 'Lessons', cell: (s) => h('span', null, `${s.band === 'kids' ? 'Kids' : s.band === 'adults' ? 'Teens and adults' : 'All ages'} ${s.discipline === 'ski' ? 'ski' : label(s.discipline).toLowerCase()}`, h('div', { class: 'muted small' }, `${s.level_words}, ${plural(s.lessons, 'lesson')}${s.unassigned ? `, ${s.unassigned} without an instructor` : ''}`)) },
            { head: 'Booked', num: true, cell: (s) => String(s.booked) },
            { head: 'Walk-ups', num: true, cell: (s) => (s.snow_in !== null && s.snow_in >= 6 ? h('span', { title: `${s.snow_in} in of snow forecast` }, `${s.walkups} (snow)`) : String(s.walkups)) },
            { head: 'Need', num: true, cell: (s) => String(s.need) },
            { head: 'Have', num: true, cell: (s) => String(s.scheduled) },
            { head: 'Gap', cell: (s) => (s.gap ? state(`${s.gap} more`, 'warn') : !s.need ? state('Nobody yet', 'neutral') : state('Covered', 'good')) },
            { head: '', actions: true, cell: (s) => (s.gap ? button('Offer shift', () => offerDialog(s, async () => { await load(); await loadOffers(); }), { small: true, label: `Offer a shift ${dayWords(s.date)} ${clock(s.time)}` }) : null) },
          ], slots.filter((s) => s.date === d), { rowClass: (s) => (s.gap ? 'attention' : null) }))) : empty(onlyGaps.checked ? 'Every lesson time is covered.' : 'No lessons in the next 14 days.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  async function loadOffers() {
    try {
      const { data } = await get('/skischool/director/offers');
      clear(offers).append(data.length ? h('ul', { class: 'plain stack' }, data.map((o) => {
        const yes = o.sends.filter((x) => x.answer === 'yes');
        return h('li', { class: 'spread' }, h('span', null, h('strong', null, o.words), h('div', { class: 'muted small' }, `Sent to ${plural(o.sends.length, 'instructor')}. ${yes.length ? `Taken by ${yes.map((x) => x.name).join(', ')}` : o.status === 'closed' ? 'Closed' : 'Nobody yet'}${o.sends.some((x) => x.answer === 'no') ? `. Said no: ${o.sends.filter((x) => x.answer === 'no').map((x) => x.name).join(', ')}` : ''}`)),
          h('span', { class: 'row tight' }, state(o.status === 'filled' ? 'Filled' : o.status === 'closed' ? 'Closed' : 'Open', o.status === 'filled' ? 'good' : o.status === 'open' ? 'warn' : 'neutral'),
            o.status === 'open' ? button('Close', async () => { try { await post(`/skischool/director/offers/${o.id}/close`, {}); await loadOffers(); } catch (err) { fail(err); } }, { small: true, kind: 'quiet', label: `Close the offer for ${o.words}` }) : null));
      })) : h('p', { class: 'muted' }, 'No offers out. Use Offer shift on a time with a gap.'));
    } catch (err) { clear(offers).append(errorBox(err)); }
  }
  async function loadHolidays() {
    try {
      const { data } = await get('/skischool/director/holidays');
      clear(holidays).append(data.length ? h('ul', { class: 'plain' }, data.map((x) => h('li', { class: 'spread' }, h('span', null, h('strong', null, x.name), `  ${dayWords(String(x.on_date).slice(0, 10))}`),
        button('Remove', async () => { try { await del(`/skischool/director/holidays/${x.id}`); await loadHolidays(); await load(); } catch (err) { fail(err); } }, { small: true, kind: 'quiet', label: `Remove ${x.name}` })))) : h('p', { class: 'muted' }, 'No holidays listed.'));
    } catch (err) { clear(holidays).append(errorBox(err)); }
  }
  function addHoliday() {
    formDialog('Add a school holiday', h('div', { class: 'form' }, field('Day', input({ type: 'date', name: 'on_date', required: true, value: todayStr() })), field('Name', input({ name: 'name', required: true, maxlength: 80, placeholder: 'Presidents Day' }))), async (fd) => {
      await post('/skischool/director/holidays', { on_date: val(fd, 'on_date'), name: val(fd, 'name') });
      toast('Holiday added'); await loadHolidays(); await load();
    });
  }
  async function loadCerts() {
    try {
      const c = await get('/skischool/director/certs');
      appendAll(clear(certs),
        h('h3', null, 'Running out in the next 30 days'),
        c.expiring.length ? h('ul', { class: 'plain' }, c.expiring.map((x) => h('li', null, h('strong', null, x.name), `: ${x.certification}, `, x.expired ? state(`expired ${fmtDate(`${String(x.expires_on).slice(0, 10)} 12:00:00`)}`, 'bad') : `ends ${fmtDate(`${String(x.expires_on).slice(0, 10)} 12:00:00`)}`))) : h('p', { class: 'muted' }, 'None.'),
        h('h3', null, 'Lessons whose instructor is missing a required certification'),
        c.missing.length ? h('ul', { class: 'plain' }, c.missing.map((x) => h('li', null, h('strong', null, x.name), `: ${x.certification} for ${x.product}, ${fmtDate(x.starts_at)} ${fmtTime(x.starts_at)}`))) : h('p', { class: 'muted' }, 'None.'));
    } catch (err) { clear(certs).append(errorBox(err)); }
  }
  await Promise.all([load(), loadOffers(), loadHolidays(), loadCerts()]);
}

async function offerDialog(s, done) {
  const kids = s.band === 'kids' ? '1' : '0';
  let free;
  try { free = (await get(`/skischool/director/offers/free?starts_at=${encodeURIComponent(s.starts_at)}&ends_at=${encodeURIComponent(s.ends_at)}&discipline=${s.discipline}&kids=${kids}${s.level_max ? `&level_max=${s.level_max}` : ''}`)).data; } catch (err) { fail(err); return; }
  if (!free.length) { dialog('Nobody to ask', h('p', null, 'No instructor is free, available and cleared for that time. Check Staff and schedule, or ask someone to mark the day open.')); return; }
  const boxes = free.map((i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `s${i.id}`, checked: true }), ` ${i.name}`, h('span', { class: 'muted small' }, i.has_phone ? '  text' : i.has_email ? '  email' : '  in the app only')));
  formDialog(`Offer ${dayWords(s.date)} ${clock(s.time)}`, h('div', { class: 'stack' },
    h('p', null, `${s.band === 'kids' ? 'Kids' : s.band === 'adults' ? 'Teens and adults' : 'All ages'} ${s.discipline}, ${s.level_words}. The first to say yes gets it; the others are told it is filled.`),
    h('fieldset', { class: 'stack' }, h('legend', null, 'Ask'), ...boxes),
    h('div', { class: 'form' }, field('Spots', input({ type: 'number', name: 'spots', min: 1, max: 20, value: s.gap })), field('Note (optional)', input({ name: 'note', maxlength: 200, placeholder: 'Meet at the kids center at 9:30' })))), async (fd) => {
    const ids = free.filter((i) => fd.get(`s${i.id}`)).map((i) => i.id);
    if (!ids.length) throw new Error('Pick at least one instructor');
    const r = await post('/skischool/director/offers', { starts_at: s.starts_at, ends_at: s.ends_at, discipline: s.discipline, level_min: s.level_min || undefined, level_max: s.level_max || undefined, kids: s.band === 'kids', spots: num(fd, 'spots') || 1, note: val(fd, 'note') || undefined, staff_ids: ids });
    toast(`Offer sent to ${plural(r.sent_to, 'instructor')}`);
    await done();
  }, { submitText: 'Send offer' });
}

// ---------------------------------------------------------------- shift offers, for instructors
async function offersTab(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'Extra lessons the ski school needs help with. The first to say yes gets it.'), body);
  async function load() {
    clear(body).append(loading());
    try {
      const { data } = await get('/skischool/offers/mine');
      clear(body).append(data.length ? h('div', { class: 'stack' }, data.map((o) => h('article', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('strong', null, o.words), o.answer === 'yes' ? state('Yours', 'good') : o.status !== 'open' ? state('Filled', 'neutral') : o.answer === 'no' ? state('You said no', 'neutral') : null),
        h('div', { class: 'muted small' }, fmtRange(o.starts_at, o.ends_at)), o.note ? h('p', { class: 'small' }, o.note) : null,
        o.status === 'open' && o.answer === 'none' ? h('div', { class: 'row' },
          button('Yes, I can', async () => { try { await post(`/skischool/offers/${o.id}/accept`, {}); toast('It is yours. Thank you!'); } catch (err) { fail(err); } await load(); }, { kind: 'primary', label: `Yes, I can teach ${o.words}` }),
          button('No', async () => { try { await post(`/skischool/offers/${o.id}/decline`, {}); } catch (err) { fail(err); } await load(); }, { label: `No, I cannot teach ${o.words}` })) : null))) : empty('No offers right now.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

// ---------------------------------------------------------------- reports
async function reportsTab(root) {
  const from = input({ type: 'date', value: addDays(todayStr(), -30) });
  const to = input({ type: 'date', value: todayStr() });
  const by = select([['by_day', 'By day'], ['by_time', 'By time'], ['by_product', 'By lesson'], ['by_level', 'By level']], 'by_day', { 'aria-label': 'Seat fill grouped' });
  const body = h('div', { class: 'stack' });
  let data = null;
  root.append(h('div', { class: 'inline-form' }, field('From', from), field('To', to), button('Show', () => load(), { kind: 'primary' })), body);
  const csv = (part) => button('Download', () => download(`/skischool/director/reports?from=${from.value}&to=${to.value}&format=csv&part=${part}`, `ski-school-${part}-${from.value}-to-${to.value}.csv`).catch(fail), { small: true, label: `Download ${part.replace('_', ' ')} as a spreadsheet` });
  const fillTable = h('div');
  const drawFill = () => {
    if (!data) return;
    clear(fillTable).append(data.fill[by.value].length ? table([
      { head: by.value === 'by_day' ? 'Day' : by.value === 'by_time' ? 'Time' : by.value === 'by_level' ? 'Levels' : 'Lesson', cell: (x) => (by.value === 'by_day' ? fmtDate(`${x.label} 12:00:00`) : by.value === 'by_time' ? clock(x.label) : x.label) },
      { head: 'Lessons', num: true, cell: (x) => String(x.lessons) },
      { head: 'Seats', num: true, cell: (x) => String(x.seats) },
      { head: 'Students', num: true, cell: (x) => String(x.students) },
      { head: 'Full', num: true, cell: (x) => { const b = h('span', { class: 'fillbar' }, `${x.fill_pct}%`); b.style.setProperty('--fill', `${Math.min(100, x.fill_pct)}%`); return b; } },
      { head: 'Revenue', num: true, cell: (x) => money(x.revenue_cents) },
    ], data.fill[by.value]) : empty('No lessons.'));
  };
  by.addEventListener('change', drawFill);
  async function load() {
    clear(body).append(loading());
    try {
      data = await get(`/skischool/director/reports?from=${from.value}&to=${to.value}`);
      const t = data.totals;
      appendAll(clear(body),
        h('div', { class: 'stats' }, stat(`${t.fill_pct}%`, `seats filled (${t.students} of ${t.seats})`), stat(money(t.revenue_cents), 'lesson revenue'), stat(t.lessons, 'lessons'),
          stat(`${data.returning.total.back_30_pct}%`, 'first-timers back within 30 days'), stat(t.no_shows, 'no-shows'), stat(t.privates, 'privates'),
          stat(t.recaps_sent === null ? 'Not yet' : t.recaps_sent, 'recaps sent'), stat(t.tips_paid, 'tips given')),
        h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Seat fill'), h('span', { class: 'row tight' }, by, csv({ by_day: 'fill_day', by_time: 'fill_time', by_product: 'fill_product', by_level: 'fill_level' }[by.value] || 'fill_day'))), fillTable),
        h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Instructors'), csv('instructors')),
          data.per_instructor.length ? table([
            { head: 'Instructor', cell: (x) => h('strong', null, x.name) },
            { head: 'Lessons', num: true, cell: (x) => String(x.lessons) },
            { head: 'Students', num: true, cell: (x) => String(x.students) },
            { head: 'Revenue', num: true, cell: (x) => money(x.revenue_cents) },
            { head: 'Privates', num: true, cell: (x) => String(x.privates) },
            { head: 'Asked for by name', num: true, cell: (x) => String(x.requested) },
            { head: 'No-shows', num: true, cell: (x) => String(x.no_shows) },
            { head: 'Tips', num: true, cell: (x) => String(x.tips) },
          ], data.per_instructor) : empty('No lessons.'),
          h('details', null, h('summary', null, 'How revenue is counted'), h('p', { class: 'small' }, 'Each lesson counts what was paid for a seat in it, before tax, less refunds. A lesson sold at the counter counts its line on the order. A lesson booked online shares its order evenly between the students on it. A package lesson counts the package price shared over its lessons. A weather credit or an unpaid booking counts nothing (the money was counted on the first lesson). A lesson\'s revenue goes to the instructor who taught it. Tips are counted, never added in.'))),
        h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'First lesson to return'), csv('returning')),
          h('p', { class: 'muted small' }, 'Students whose first lesson was in these dates, and how many booked another lesson or a program within 30 and 60 days.'),
          data.returning.by_product.length ? table([
            { head: 'First lesson', cell: (x) => x.product },
            { head: 'First-timers', num: true, cell: (x) => String(x.first_timers) },
            { head: 'Back in 30 days', num: true, cell: (x) => `${x.back_30} (${x.back_30_pct}%)` },
            { head: 'Back in 60 days', num: true, cell: (x) => `${x.back_60} (${x.back_60_pct}%)` },
          ], data.returning.by_product) : empty('No first lessons in these dates.')),
        h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Every lesson'), csv('lessons')),
          h('details', null, h('summary', null, `${plural(data.per_lesson.length, 'lesson')}, ${plural(data.no_shows.length, 'with no-shows', 'with no-shows')}`),
            table([
              { head: 'When', cell: (x) => `${fmtDate(x.starts_at)} ${fmtTime(x.starts_at)}` },
              { head: 'Lesson', cell: (x) => h('span', null, x.product, h('div', { class: 'muted small' }, x.level_words)) },
              { head: 'Instructor', cell: (x) => x.instructor || state('None', 'warn') },
              { head: 'Students', num: true, cell: (x) => `${x.students} of ${x.capacity}` },
              { head: 'No-shows', num: true, cell: (x) => String(x.no_shows) },
              { head: 'Revenue', num: true, cell: (x) => money(x.revenue_cents) },
            ], data.per_lesson))));
      drawFill();
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}
