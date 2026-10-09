import { get, post, put, del } from '../api.js';
import { h, clear, ctx, isManager, tabs, table, state, input, select, field, button, toast, formDialog, val, todayStr, addDays, fmtDate, empty, fail } from '../ui.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PRESETS = [['Morning', '09:00', '12:00'], ['Afternoon', '13:00', '16:00'], ['All day', '09:00', '16:00'], ['Evening', '16:00', '20:00']];
const dateObj = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthTitle = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(dateObj(s));
const nextMonth = (s, n) => { const d = dateObj(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const clock = (t) => { const hr = +t.slice(0, 2); const m = t.slice(3, 5); return `${hr % 12 || 12}${m === '00' ? '' : `:${m}`}${hr < 12 ? 'a' : 'p'}`; };
const range = (w) => `${clock(w.start_time)}–${clock(w.end_time)}`;
const longClock = (t) => { const hr = +t.slice(0, 2); return `${hr % 12 || 12}:${t.slice(3, 5)} ${hr < 12 ? 'AM' : 'PM'}`; };

export async function render(root) {
  const settings = await get('/availability/settings');
  const linked = Boolean(ctx.me.staff_id) && ctx.me.role === 'instructor';
  const items = [];
  if (linked || isManager()) items.push(['mine', isManager() && !linked ? 'Set availability' : 'My availability', (box) => drawMine(box, settings)]);
  items.push(['all', 'Everyone', drawAll]);
  if (isManager()) items.push(['public', 'Public page', (box) => drawPublic(box, settings)]);
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Instructor availability'),
    h('p', { class: 'page-note' }, 'Mark the dates and times you are open. Change them whenever plans change.')), tabs(items, items[0][0]));
}

// ---------------------------------------------------------------- the calendar an instructor edits
async function drawMine(box, settings) {
  let staffId = null;
  let data;
  const picker = h('div');
  const body = h('div', { class: 'stack' });
  clear(box).append(picker, body);
  if (isManager()) {
    const { data: list } = await get('/availability/instructors');
    if (!list.length) { body.append(empty('No instructors yet. Create an instructor login and link it to a staff member first.')); return; }
    const sel = select(list.map((i) => [i.id, i.name]), ctx.me.staff_id && list.find((i) => i.id === ctx.me.staff_id) ? ctx.me.staff_id : list[0].id, { 'aria-label': 'Instructor' });
    staffId = Number(sel.value);
    sel.addEventListener('change', () => { staffId = Number(sel.value); load().catch(fail); selected.clear(); });
    picker.append(h('div', { class: 'row' }, field('Instructor', sel)));
  }
  const q = () => (staffId ? `?staff_id=${staffId}` : '');
  let month = monthStart(todayStr());
  const selected = new Set();
  const byDate = new Map();

  async function load() {
    data = await get(`/availability/me${q()}`);
    byDate.clear();
    for (const w of data.windows) { if (!byDate.has(w.open_date)) byDate.set(w.open_date, []); byDate.get(w.open_date).push(w); }
    draw();
  }

  function draw() {
    clear(body);
    const p = data.profile;
    body.append(h('div', { class: 'row' },
      h('div', { class: 'stack tight' }, h('strong', null, data.staff.name),
        p.is_public && settings.public ? state(`Listed on the public page as ${p.shown_as}`, 'good') : p.is_public ? state('Opted in, but the public page is off', 'warn') : state('Not listed publicly', 'neutral')),
      h('span', { class: 'row grow-end' }, button('Public profile', () => editProfile(), { small: true }))));
    body.append(calendar(), picker2());
  }

  function calendar() {
    const today = data.today;
    const first = dateObj(month);
    const lead = first.getUTCDay();
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const grid = h('div', { class: 'cal', role: 'group', 'aria-label': monthTitle(month) }, ...WEEKDAYS.map((d) => h('span', { class: 'cal-dow' }, d)));
    for (let i = 0; i < lead; i++) grid.append(h('span', { class: 'cal-pad', 'aria-hidden': 'true' }));
    for (let n = 1; n <= last; n++) {
      const date = `${month.slice(0, 8)}${String(n).padStart(2, '0')}`;
      const past = date < today;
      const ws = byDate.get(date) || [];
      const cell = h('button', { type: 'button', class: `cal-day${ws.length ? ' open' : ''}${date === today ? ' today' : ''}`, 'aria-pressed': String(selected.has(date)), disabled: past,
        'aria-label': `${fmtDate(date)}${ws.length ? `, open ${ws.map(range).join(', ')}` : ''}` },
      h('span', { class: 'cal-n' }, String(n)), ...ws.slice(0, 2).map((w) => h('span', { class: 'cal-t' }, range(w))), ws.length > 2 ? h('span', { class: 'cal-t' }, `+${ws.length - 2} more`) : null);
      cell.addEventListener('click', () => { if (selected.has(date)) selected.delete(date); else selected.add(date); draw(); });
      grid.append(cell);
    }
    const pick = (test) => { for (let n = 1; n <= last; n++) { const date = `${month.slice(0, 8)}${String(n).padStart(2, '0')}`; if (date >= today && test(dateObj(date).getUTCDay())) selected.add(date); } draw(); };
    return h('section', { class: 'section' }, h('header', null, h('h2', null, monthTitle(month)),
      h('div', { class: 'row' }, button('Previous', () => { month = nextMonth(month, -1); draw(); }, { small: true }), button('Today', () => { month = monthStart(today); draw(); }, { small: true }), button('Next', () => { month = nextMonth(month, 1); draw(); }, { small: true }))),
    h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Tap days to select them, then choose times below.'),
      h('span', { class: 'row grow-end' }, button('All weekends', () => pick((d) => d === 0 || d === 6), { small: true }), button('All weekdays', () => pick((d) => d > 0 && d < 6), { small: true }), selected.size ? button('Clear selection', () => { selected.clear(); draw(); }, { small: true }) : null)),
    grid);
  }

  function picker2() {
    const days = [...selected].sort();
    if (!days.length) return h('p', { class: 'muted' }, 'Select one or more days to mark them open.');
    const start = input({ type: 'time', value: '09:00', 'aria-label': 'From' });
    const end = input({ type: 'time', value: '16:00', 'aria-label': 'Until' });
    const note = input({ maxlength: 120, placeholder: 'Optional, such as "Kids lessons only"', 'aria-label': 'Note' });
    const presets = h('div', { class: 'row' }, ...PRESETS.map(([name, a, b]) => button(name, () => { start.value = a; end.value = b; }, { small: true })));
    const existing = days.length === 1 ? (byDate.get(days[0]) || []) : [];
    return h('section', { class: 'section stack' }, h('h2', null, days.length === 1 ? fmtDate(days[0]) : `${days.length} days selected`),
      existing.length ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Open now:'), ...existing.map((w) => h('span', { class: 'time-chip' }, `${longClock(w.start_time)} to ${longClock(w.end_time)}${w.note ? `, ${w.note}` : ''}`,
        button('Remove', async () => { await del(`/availability/windows/${w.id}`); toast('Time removed'); await load(); }, { small: true }))) ) : null,
      presets, h('div', { class: 'form' }, field('From', start), field('Until', end), field('Note', note)),
      h('div', { class: 'row' },
        button('Mark open', async () => {
          await post('/availability/windows', { ...(staffId ? { staff_id: staffId } : {}), dates: days, start_time: start.value, end_time: end.value, note: note.value.trim() || null });
          toast(`Marked open on ${days.length} day${days.length === 1 ? '' : 's'}`); selected.clear(); await load();
        }, { kind: 'primary' }),
        button('Clear open times from these days', async () => { const r = await post('/availability/windows/clear', { ...(staffId ? { staff_id: staffId } : {}), dates: days }); toast(r.cleared ? 'Cleared' : 'Nothing to clear'); selected.clear(); await load(); })));
  }

  function editProfile() {
    const p = data.profile;
    get('/availability/meta').then((meta) => {
      const checks = (name, list, on) => h('div', { class: 'row' }, ...list.map((x) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, value: x.value, checked: on.includes(x.value) }), x.label)));
      formDialog('Public profile', h('div', { class: 'form' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'is_public', checked: p.is_public }), 'List me on the public availability page'),
        field('Name to show', input({ name: 'display_name', maxlength: 60, value: p.display_name || '', placeholder: p.shown_as }), 'Leave blank to show your first name and last initial.'),
        field('About you', h('textarea', { name: 'bio', rows: 4, maxlength: 600 }, p.bio || ''), 'A few sentences. No photo, phone number or email.'),
        h('fieldset', { class: 'stack' }, h('legend', null, 'What you teach'), checks('disciplines', meta.disciplines, p.disciplines)),
        h('fieldset', { class: 'stack' }, h('legend', null, 'Levels'), checks('levels', meta.levels, p.levels)),
        h('p', { class: 'muted small' }, 'Guests can only see your name, bio, what you teach and the times you mark open. They cannot book or contact you from the page.')), async (fd) => {
        await put('/availability/profile', { ...(staffId ? { staff_id: staffId } : {}), is_public: fd.get('is_public') === 'on', display_name: val(fd, 'display_name'), bio: val(fd, 'bio'), disciplines: fd.getAll('disciplines'), levels: fd.getAll('levels') });
        toast('Profile saved'); await load();
      });
    }).catch(fail);
  }
  await load();
}

// ---------------------------------------------------------------- everyone (for the ski school desk)
async function drawAll(box) {
  const from = todayStr();
  const { data } = await get(`/availability/overview?from=${from}&to=${addDays(from, 13)}`);
  clear(box).append(h('header', null, h('h2', null, 'Open instructors, next two weeks')));
  if (!data.length) { box.append(empty('No instructor has marked any open times yet.')); return; }
  const days = [...new Set(data.map((w) => w.open_date))];
  for (const day of days) {
    box.append(h('h3', null, fmtDate(day)), table([
      { head: 'Instructor', cell: (w) => h('strong', null, w.name) },
      { head: 'Open', cell: (w) => `${longClock(w.start_time)} to ${longClock(w.end_time)}` },
      { head: 'Note', cell: (w) => w.note || '' },
      { head: 'Public', cell: (w) => (w.is_public ? state('Listed', 'good') : state('Not listed', 'neutral')) },
    ], data.filter((w) => w.open_date === day)));
  }
}

// ---------------------------------------------------------------- the public page switch (managers)
async function drawPublic(box, settings) {
  const link = `${location.origin}/availability/${settings.slug}`;
  const on = h('input', { type: 'checkbox', checked: settings.public, id: 'pub-on' });
  on.addEventListener('change', async () => {
    try { await put('/availability/settings', { public: on.checked }); settings.public = on.checked; toast(on.checked ? 'Public page is on' : 'Public page is off'); draw(); } catch (e) { on.checked = !on.checked; fail(e); }
  });
  const slot = h('div', { class: 'stack' });
  function draw() {
    clear(slot);
    if (settings.public) slot.append(h('p', null, 'Share this link on your website or social media:'), h('p', null, h('a', { href: link, target: '_blank', rel: 'noopener' }, link)),
      button('Copy link', async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch (_) { toast('Select the link and copy it'); } }, { small: true }));
  }
  clear(box).append(h('section', { class: 'section stack' }, h('h2', null, 'Public availability page'),
    h('p', { class: 'muted' }, 'Guests can see which instructors are open and when. They cannot book or send a request from it. Only instructors who choose to be listed appear, and they control their own bio and times.'),
    h('label', { class: 'check', for: 'pub-on' }, on, 'Show the public availability page'), slot));
  draw();
}
