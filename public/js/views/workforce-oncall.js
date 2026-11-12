// Staff and schedule > On call (release 2026.11.20): who answers after hours, per department or crew. Each rotation is
// a list of people who take turns (a week each by default, changing hands at 7:00 AM); a swap, a holiday or cover gives
// the turn to someone else for some days. The calendar shows four weeks. A request in one of the rotation's categories
// that comes in after hours (outside the working day, on a weekend or a holiday) sends the person on call a phone alert.
// The API is routes/crew.js under /workforce/oncall.
import { get, post, patch, del } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, confirmDialog, table, empty, errorBox, todayStr, addDays, weekStart, label, fmtDate, isMuni } from '../ui.js';
import { dayShort, monthDay, tod, fullName } from './workforce-common.js';

const REASONS = [['swap', 'Swap'], ['holiday', 'Holiday'], ['cover', 'Cover (sick or away)']];

export async function drawOnCall(box) {
  let from = weekStart(todayStr());
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  let staff = [];
  try { staff = (await get('/workforce/staff?status=active')).data || []; } catch (_) { staff = []; }

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading on call…'));
    let d; let hol;
    try { [d, hol] = await Promise.all([get(`/workforce/oncall?from=${from}&days=${window.matchMedia && window.matchMedia('(max-width: 860px)').matches ? 14 : 28}`), get(`/workforce/oncall/holidays?year=${from.slice(0, 4)}`)]); } catch (err) { clear(body).append(errorBox(err)); return; }
    draw(d, hol);
  }
  const go = (x) => { from = x; return load(); };

  let rotationsCache = []; // for the swap dialog's picker
  function draw(d, hol) {
    rotationsCache = d.rotations;
    const today = d.today;
    const holidays = new Map(d.holidays.map((x) => [x.day, x.name]));
    const cats = new Map(d.categories.map((c) => [c.id, c.name]));
    clear(body).append(
      h('div', { class: 'week-bar' },
        h('div', { class: 'week-nav' },
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Earlier', onclick: () => go(addDays(from, -7)) }, '‹'),
          h('h2', { class: 'week-title' }, `${monthDay(d.from)} to ${monthDay(d.to)}`),
          h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Later', onclick: () => go(addDays(from, 7)) }, '›'),
          from !== weekStart(todayStr()) ? button('This week', () => go(weekStart(todayStr())), { small: true }) : null),
        d.can_manage ? h('div', { class: 'week-actions' },
          button('Add a rotation', () => rotationDialog(null), { kind: 'primary' }),
          d.rotations.length ? button('Swap or cover', () => overrideDialog(d.rotations[0], from)) : null) : null),
      h('p', { class: 'muted' }, 'Who takes the after-hours calls. A water or sewer request reported after hours goes to the person on call as a phone alert. Turns change hands at each rotation’s handover time.'),
      d.rotations.length ? calendarTable(d, holidays, today) : empty(d.can_manage ? 'No rotations yet. Add one for each crew that takes after-hours calls, such as Water and sewer, or Streets.' : 'No on-call rotation yet.'),
      ...d.rotations.map((r) => rotationPanel(r, d, cats)),
      holidaysPanel(hol, d.can_manage));
  }

  function calendarTable(d, holidays, today) {
    const cols = [{ head: 'Day', cell: (date) => h('span', { class: holidays.has(date) ? 'is-holiday' : null }, `${dayShort(date)} ${monthDay(date)}`, holidays.has(date) ? h('span', { class: 'muted small' }, ` ${holidays.get(date)}`) : null) },
      ...d.rotations.filter((r) => r.active).map((r) => ({ head: r.name, cell: (date) => { const x = r.days.find((y) => y.date === date); return x && x.name ? h('span', null, x.name, x.why && x.why !== 'rotation' ? h('span', { class: 'muted small' }, ` (${label(x.why)})`) : null) : h('span', { class: 'muted' }, 'Nobody'); } }))];
    return h('div', { class: 'oncall-cal' }, table(cols, d.dates, { rowClass: (date) => (date === today ? 'is-today' : null) }));
  }

  function rotationPanel(r, d, cats) {
    const mine = d.overrides.filter((o) => o.rotation_id === r.id);
    return h('section', { class: 'panel stack', dataset: { rotation: r.name } },
      h('div', { class: 'spread' }, h('h3', null, r.name, r.active ? null : h('span', { class: 'muted small' }, ' (paused)')),
        d.can_manage ? h('div', { class: 'row' }, button('Edit', () => rotationDialog(r), { small: true }), button('Swap or cover', () => overrideDialog(r, from), { small: true }),
          button('Delete', () => confirmDialog(`Delete ${r.name}?`, 'The rotation, its swaps and its record of alerts go. Nobody is on call for it after this.', 'Delete', async () => { await del(`/workforce/oncall/rotations/${r.id}`); toast('Rotation deleted'); await load(); }, { danger: true }), { small: true })) : null),
      h('p', null, r.member_names.length ? `Takes turns: ${r.member_names.map((m) => m.name).join(', then ')}.` : 'Nobody in the rotation yet.',
        ` Each turn is ${r.period_days === 7 ? 'a week' : `${r.period_days} day${r.period_days === 1 ? '' : 's'}`}, changing hands at ${tod(r.handover)}.`),
      h('p', { class: 'muted small' }, `Office hours ${tod(r.workday_start)} to ${tod(r.workday_end)}, Monday to Friday. After hours: ${r.category_ids.length ? r.category_ids.map((c) => cats.get(c) || 'a category no longer used').join(', ') : 'no request categories alert this rotation'}.`),
      mine.length ? h('ul', { class: 'plain' }, mine.map((o) => h('li', null, `${label(o.reason)}: ${o.name}, ${o.starts_on === o.ends_on ? fmtDate(o.starts_on) : `${fmtDate(o.starts_on)} to ${fmtDate(o.ends_on)}`}${o.note ? ` (${o.note})` : ''} `,
        d.can_manage ? button('Remove', async () => { await del(`/workforce/oncall/overrides/${o.id}`); toast('Removed'); await load(); }, { small: true }) : null))) : null);
  }

  function rotationDialog(r) {
    const memberBoxes = staff.map((s) => ({ s, el: h('input', { type: 'checkbox', checked: Boolean(r && r.members.includes(Number(s.id))) }) }));
    // The order is the rotation's: picked people keep the order they were in, new ones go to the end.
    const order = r ? [...r.members] : [];
    const cats = h('div', { class: 'stack tight' });
    get('/workforce/oncall').then((d) => {
      const want = r ? r.category_ids : d.categories.filter((c) => c.after_hours).map((c) => c.id);
      cats.append(...(d.categories.length ? d.categories.map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'cat', value: String(c.id), checked: want.includes(c.id) }), ` ${c.name}`)) : [h('p', { class: 'muted small' }, 'No request categories yet.')]));
    }).catch(() => {});
    formDialog(r ? `Edit ${r.name}` : 'Add a rotation', h('div', { class: 'form' },
      field('Name', input({ name: 'name', required: true, maxlength: 80, value: r ? r.name : '', placeholder: isMuni() ? 'Water and sewer' : 'Maintenance' })),
      field('Department or crew', input({ name: 'department', maxlength: 60, value: r && r.department ? r.department : '', placeholder: 'Water' })),
      h('div', { class: 'wide' }, h('p', { class: 'field-label' }, 'Who takes turns'), h('p', { class: 'muted small' }, 'In the order ticked. The first person has the first turn.'),
        staff.length ? h('div', { class: 'stack tight' }, memberBoxes.map((b) => { b.el.addEventListener('change', () => { const id = Number(b.s.id); const i = order.indexOf(id); if (b.el.checked && i < 0) order.push(id); if (!b.el.checked && i >= 0) order.splice(i, 1); }); return h('label', { class: 'check' }, b.el, ` ${fullName(b.s)}`); })) : h('p', { class: 'muted' }, 'Add staff first.')),
      field('First turn starts', input({ name: 'starts_on', type: 'date', required: true, value: r ? r.starts_on : weekStart(todayStr()) })),
      field('Each turn lasts (days)', input({ name: 'period_days', type: 'number', min: '1', max: '31', value: r ? r.period_days : 7 }), '7 is a week'),
      field('Changes hands at', input({ name: 'handover', type: 'time', value: r ? r.handover : '07:00' })),
      field('Office hours start', input({ name: 'workday_start', type: 'time', value: r ? r.workday_start : '07:00' })),
      field('Office hours end', input({ name: 'workday_end', type: 'time', value: r ? r.workday_end : '15:30' }), 'After this, and on weekends and holidays, is after hours'),
      h('div', { class: 'wide' }, h('p', { class: 'field-label' }, 'After-hours requests that alert the person on call'), cats)), async (fd) => {
      const b = {
        name: String(fd.get('name') || '').trim(), department: String(fd.get('department') || '').trim() || null, members: order.filter((id) => memberBoxes.some((x) => Number(x.s.id) === id && x.el.checked)),
        starts_on: fd.get('starts_on'), period_days: Number(fd.get('period_days')) || 7, handover: fd.get('handover') || '07:00', workday_start: fd.get('workday_start') || '07:00', workday_end: fd.get('workday_end') || '15:30',
        category_ids: [...cats.querySelectorAll('input[name=cat]:checked')].map((x) => Number(x.value)),
      };
      if (r) await patch(`/workforce/oncall/rotations/${r.id}`, b); else await post('/workforce/oncall/rotations', b);
      toast(r ? 'Rotation saved' : 'Rotation added');
      await load();
    }, { submitText: r ? 'Save' : 'Add rotation', wide: true });
  }

  function overrideDialog(r, start) {
    formDialog('Swap or cover', h('div', { class: 'form' },
      field('Rotation', select(rotationsCache.map((x) => [x.id, x.name]), r.id, { name: 'rotation_id' })),
      field('Who takes it', select([['', 'Choose a person'], ...staff.map((s) => [s.id, fullName(s)])], '', { name: 'staff_id', required: true })),
      field('First day', input({ name: 'starts_on', type: 'date', required: true, value: start < todayStr() ? todayStr() : start })),
      field('Last day', input({ name: 'ends_on', type: 'date', required: true, value: addDays(start < todayStr() ? todayStr() : start, 6) })),
      field('Why', select(REASONS, 'swap', { name: 'reason' })),
      field('Note', input({ name: 'note', maxlength: 200, placeholder: 'Swapped with Dana for her vacation' }))), async (fd) => {
      if (!fd.get('staff_id')) throw new Error('Choose who takes the turn');
      await post('/workforce/oncall/overrides', { rotation_id: Number(fd.get('rotation_id')), staff_id: Number(fd.get('staff_id')), starts_on: fd.get('starts_on'), ends_on: fd.get('ends_on'), reason: fd.get('reason'), note: String(fd.get('note') || '').trim() || null });
      toast('Saved. The calendar shows who has it.');
      await load();
    }, { submitText: 'Save' });
  }

  function holidaysPanel(hol, manage) {
    return h('section', { class: 'panel stack', dataset: { part: 'holidays' } },
      h('div', { class: 'spread' }, h('h3', null, `Holidays in ${hol.year}`),
        manage ? h('div', { class: 'row' },
          button(`Add the usual ${hol.year} holidays`, async () => { const r = await post('/workforce/oncall/holidays/usual', { year: hol.year }); toast(r.added ? `${r.added} holiday${r.added === 1 ? '' : 's'} added` : 'They are all there already'); await load(); }, { small: true }),
          button('Add a holiday', () => formDialog('Add a holiday', h('div', { class: 'form' }, field('Day', input({ name: 'day', type: 'date', required: true })), field('Name', input({ name: 'name', required: true, maxlength: 80, placeholder: 'Good Friday' }))), async (fd) => {
            await post('/workforce/oncall/holidays', { day: fd.get('day'), name: String(fd.get('name') || '').trim() }); toast('Holiday added'); await load();
          }, { submitText: 'Add' }), { small: true })) : null),
      h('p', { class: 'muted small' }, 'A holiday is after hours all day: requests that day go to the person on call.'),
      hol.data.length ? h('ul', { class: 'plain' }, hol.data.map((x) => h('li', null, `${fmtDate(x.day)}: ${x.name} `, manage ? button('Remove', async () => { await del(`/workforce/oncall/holidays/${x.id}`); await load(); }, { small: true, label: `Remove ${x.name}` }) : null))) : h('p', { class: 'muted' }, 'No holidays yet.'));
  }

  await load();
}
