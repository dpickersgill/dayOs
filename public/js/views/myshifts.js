import { get, post, put } from '../api.js';
import { h, clear, ctx, table, state, input, select, field, button, toast, dialog, fmtRange, fmtDateTime, empty, errorBox } from '../ui.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Weekly availability editor. It opens with what is saved (saving replaces the whole pattern, so it must start from it),
 * and an empty pattern means "can work any time".
 */
export async function availabilityDialog(staffId, name, onSaved) {
  const { windows: saved } = await get(`/workforce/staff/${staffId}/availability`);
  const rows = h('div', { class: 'stack' });
  const none = h('p', { class: 'muted' }, 'No windows: can be scheduled any time.');
  const sync = () => { none.hidden = rows.children.length > 0; };
  const addRow = (w = { weekday: 1, start_time: '08:00', end_time: '17:00' }) => {
    const day = select(WEEKDAYS.map((d, i) => [i, d]), w.weekday, { 'aria-label': 'Day' });
    const s = input({ type: 'time', value: String(w.start_time).slice(0, 5), 'aria-label': 'From' });
    const e = input({ type: 'time', value: String(w.end_time).slice(0, 5), 'aria-label': 'Until' });
    const rm = h('button', { type: 'button', class: 'btn small' }, 'Remove');
    const row = h('div', { class: 'inline-form' }, field('Day', day), field('From', s), field('Until', e), rm);
    row.get = () => ({ weekday: Number(day.value), start_time: s.value, end_time: e.value });
    rm.addEventListener('click', () => { row.remove(); sync(); });
    rows.append(row);
    sync();
  };
  saved.forEach((w) => addRow(w));
  sync();
  const save = button('Save availability', async () => {
    const windows = [...rows.children].map((r) => r.get());
    for (const w of windows) if (!w.start_time || !w.end_time || w.end_time <= w.start_time) throw new Error('Each window needs a start before its end');
    await put(`/workforce/staff/${staffId}/availability`, { windows });
    toast('Availability saved');
    dlg.close();
    if (onSaved) await onSaved();
  }, { kind: 'primary' });
  const dlg = dialog(`Weekly availability${name ? ` for ${name}` : ''}`, [
    h('p', { class: 'muted' }, 'The times in each week this person can work. Shifts and lessons outside them are flagged when scheduling (a manager can still choose them). Dates marked open on Availability count too.'),
    none, rows, h('div', { class: 'row' }, button('Add a window', () => addRow(), { small: true })), h('div', { class: 'footer row' }, save)], { wide: true });
}

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'My shifts')));
  const me = await get('/workforce/me');
  if (!me.linked) {
    root.append(empty('Your login is not linked to a staff record, so there are no shifts to show. Ask a manager to link it in Account.'));
    return;
  }
  const instructor = ctx.me && ctx.me.role === 'instructor';
  const clock = h('section', { class: 'panel stack' });
  const day = h('section', { class: 'section' });
  const shifts = h('section', { class: 'section' });
  root.append(clock, day, shifts);
  // Instructors: today's lessons and program groups first, the same My day as in Ski school.
  if (instructor) {
    day.append(h('header', null, h('h2', null, 'My day')));
    try { const myDay = await import('./school-myday.js'); await myDay.render(day, { compact: true }); } catch (err) { day.append(errorBox(err)); }
  }

  async function draw() {
    const m = await get('/workforce/me');
    clear(clock);
    if (m.open_entry) {
      clock.append(h('div', { class: 'spread' }, state(`Clocked in since ${fmtDateTime(m.open_entry.clock_in)}`, 'good'),
        button('Clock out', async () => { await post('/workforce/time/clock-out', {}); toast('Clocked out'); await draw(); }, { kind: 'primary' })));
    } else {
      clock.append(h('div', { class: 'spread' }, state('Not clocked in', 'neutral'),
        button('Clock in', async () => { await post('/workforce/time/clock-in', {}); toast('Clocked in'); await draw(); }, { kind: 'primary' })));
    }
    // One place for availability: instructors use the Availability page (dates and their weekly pattern); others the weekly pattern here.
    clock.append(h('div', { class: 'row' }, instructor ? h('a', { class: 'btn small', href: '#/availability' }, 'My availability') : button('Set my weekly availability', () => availabilityDialog(m.staff_id, ''), { small: true })));
    // Lessons and program groups count as work too: an instructor with lessons never sees "No published shifts".
    let lessons = [];
    if (ctx.me && ['instructor', 'manager', 'owner'].includes(ctx.me.role)) { try { lessons = (await get('/skischool/my-schedule')).data; } catch (_) { lessons = []; } }
    const all = [...m.shifts.map((x) => ({ ...x, what: x.position })), ...lessons.map((x) => ({ starts_at: x.starts_at, ends_at: x.ends_at, what: `${x.kind === 'program' ? 'Program: ' : 'Lesson: '}${x.title}${x.level_words && x.level_words !== 'All levels' ? `, ${x.level_words}` : ''}` }))]
      .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
    clear(shifts).append(h('header', null, h('h2', null, 'Coming up')),
      all.length ? table([
        { head: 'When', cell: (x) => fmtRange(x.starts_at, x.ends_at) },
        { head: 'What', cell: (x) => x.what },
      ], all) : empty('Nothing scheduled yet. Your manager publishes the schedule when it is ready.'));
  }
  await draw();
}
