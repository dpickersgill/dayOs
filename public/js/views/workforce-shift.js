// The shift dialog (add or change one shift) and the week actions: copy last week, templates, publish, staffing needs.
import { get, post, patch, del } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, confirmDialog, dialog, table, state, label, empty, errorBox, addDays } from '../ui.js';
import { span, hrs, dayLong, dayShort, monthDay, weekLabel, weekDays } from './workforce-common.js';

let lastPosition = null;

/**
 * Add or change a shift. The person is picked from a list that puts first whoever can work it (certified, free,
 * available, trained for the position), says why anyone else cannot, and shows each person's hours that week.
 */
export function shiftDialog({ shift, date, staffId, positions, onDone }) {
  if (!positions.length) { toast('Add a position first, on the Setup tab', 'error'); return; }
  const editing = Boolean(shift);
  const day = input({ type: 'date', name: 'day', required: true, value: editing ? shift.starts_at.slice(0, 10) : date });
  const from = input({ type: 'time', name: 'from', required: true, value: editing ? shift.starts_at.slice(11, 16) : '08:00' });
  const to = input({ type: 'time', name: 'to', required: true, value: editing ? shift.ends_at.slice(11, 16) : '16:30' });
  const pos = select(positions.map((p) => [p.id, `${p.name} (${label(p.department)})`]), editing ? shift.position_id : (lastPosition || positions[0].id), { name: 'position_id' });
  const notes = input({ name: 'notes', maxlength: 200, value: editing ? shift.notes || '' : '', placeholder: 'Optional, for example "Summit chair"' });
  const overnight = h('p', { class: 'muted small', hidden: true }, 'Ends the next day.');
  const who = h('div', { class: 'cand-list', role: 'radiogroup', 'aria-label': 'Who works this shift' });
  let chosen = editing ? Number(shift.staff_id || 0) : Number(staffId || 0);
  let cands = [];

  const times = () => {
    const d = day.value;
    const end = to.value <= from.value ? addDays(d, 1) : d;
    return [`${d}T${from.value}`, `${end}T${to.value}`];
  };

  let token = 0;
  async function loadCandidates() {
    const my = ++token;
    overnight.hidden = !(to.value && from.value && to.value <= from.value);
    if (!day.value || !from.value || !to.value) return;
    clear(who).append(h('p', { class: 'loading' }, 'Checking who can work it…'));
    const [s, e] = times();
    try {
      const same = editing && s.replace('T', ' ') === shift.starts_at.slice(0, 16) && e.replace('T', ' ') === shift.ends_at.slice(0, 16) && Number(pos.value) === Number(shift.position_id);
      const r = same ? await get(`/workforce/shifts/${shift.id}/candidates`) : await post('/workforce/shifts/candidates', { position_id: Number(pos.value), starts_at: s, ends_at: e });
      if (my !== token) return;
      cands = r.data;
      drawCandidates();
    } catch (err) { if (my === token) clear(who).append(errorBox(err)); }
  }

  function option(value, main, sub, { disabled = false, tone = null } = {}) {
    const radio = h('input', { type: 'radio', name: 'who', value: String(value), checked: chosen === value, disabled });
    radio.addEventListener('change', () => { chosen = value; });
    return h('label', { class: `cand${disabled ? ' is-blocked' : ''}`, 'data-tone': tone }, radio, h('span', { class: 'cand-text' }, main, sub));
  }
  function drawCandidates() {
    const groups = [
      ['Can work it', cands.filter((c) => c.ok)],
      ['Outside their availability (you can still choose them)', cands.filter((c) => !c.ok && c.overridable)],
      ['Cannot work it', cands.filter((c) => !c.ok && !c.overridable)],
    ];
    const line = (c) => h('span', { class: 'cand-sub' }, [`${hrs(c.week_minutes)} this week${c.trained ? ', trained for this position' : ''}`, ...c.problems].join('. '));
    const name = (c) => h('b', null, c.name, c.current ? h('small', { class: 'muted' }, ' (on it now)') : null);
    clear(who).append(option(0, h('b', null, 'Leave unfilled'), h('span', { class: 'cand-sub' }, 'Shown in the Unfilled row until someone is chosen')),
      ...groups.filter(([, list]) => list.length).map(([title, list], gi) => h('div', { class: 'cand-group' }, h('p', { class: 'cand-title' }, title),
        list.map((c) => option(c.staff_id, name(c), line(c), { disabled: gi === 2, tone: gi === 0 ? 'good' : gi === 1 ? 'warn' : null })))));
    if (!cands.length) who.append(h('p', { class: 'muted small' }, 'No active staff yet. Add people on the Staff tab.'));
  }
  for (const el of [day, from, to, pos]) el.addEventListener('change', loadCandidates);

  const fields = h('div', { class: 'stack' },
    h('div', { class: 'shift-when' }, field('Day', day), field('Starts', from), field('Ends', to)), overnight,
    field('Position', pos), field('Note', notes),
    h('fieldset', { class: 'cand-box' }, h('legend', null, 'Who works it'), who),
    editing ? h('p', { class: 'muted small' }, shift.status === 'published'
      ? 'This shift is published. Anyone taken off, put on, or whose time changes gets a message in their Inbox.'
      : 'This shift is a draft. Staff see it once the week is published.') : null);

  const dlg = formDialog(editing ? `${shift.position}, ${dayLong(shift.starts_at.slice(0, 10))}` : 'Add a shift', fields, async () => {
    const [s, e] = times();
    const c = cands.find((x) => x.staff_id === chosen);
    const body = { position_id: Number(pos.value), starts_at: s, ends_at: e, notes: notes.value.trim() || (editing ? null : undefined), override_availability: Boolean(c && c.overridable) };
    lastPosition = Number(pos.value);
    if (editing) {
      await patch(`/workforce/shifts/${shift.id}`, { ...body, staff_id: chosen || null });
      toast('Shift saved');
    } else {
      await post('/workforce/shifts', { ...body, staff_id: chosen || undefined });
      toast('Shift added as a draft');
    }
    await onDone();
  }, { submitText: editing ? 'Save shift' : 'Add shift', wide: true });
  if (editing) {
    const cancel = button('Cancel this shift', () => confirmDialog('Cancel this shift?', `${shift.position}, ${dayShort(shift.starts_at.slice(0, 10))} ${span(shift.starts_at, shift.ends_at)}.${shift.status === 'published' && shift.staff_id ? ' The person on it gets a message.' : ''}`, 'Cancel shift', async () => {
      await del(`/workforce/shifts/${shift.id}`);
      toast('Shift canceled');
      dlg.close();
      await onDone();
    }, { danger: true }), { kind: 'danger' });
    cancel.classList.add('footer-start');
    dlg.box.querySelector('form .footer').prepend(cancel);
  }
  loadCandidates();
  return dlg;
}

/** Copy last week into this one, as drafts. */
export function copyWeek(start, onDone) {
  const prev = addDays(start, -7);
  const keep = h('input', { type: 'checkbox', checked: true });
  const out = h('div');
  const go = button('Copy as drafts', async () => {
    clear(out);
    try {
      const r = await post('/workforce/shifts/copy', { from: prev, to: start, keep_people: keep.checked });
      dlg.close();
      await onDone();
      resultDialog('Week copied', r);
    } catch (err) { out.append(errorBox(err)); }
  }, { kind: 'primary' });
  const dlg = dialog('Copy last week', [
    h('p', null, `Copies every shift from ${weekLabel(prev)} into ${weekLabel(start)} as drafts. Nothing is published until you publish.`),
    h('label', { class: 'check' }, keep, ' Keep the same people where they can still work the shift'),
    h('p', { class: 'muted small' }, 'Anyone who no longer can (an expired certification, a clash, outside their availability) is left off, and the shift waits in the Unfilled row. Shifts already in this week are not doubled.'),
    out, h('div', { class: 'footer row' }, go)]);
}

function resultDialog(title, r) {
  const parts = [h('p', null, `${r.created} shift${r.created === 1 ? '' : 's'} added as drafts${r.unfilled ? `, ${r.unfilled} unfilled` : ''}.${r.skipped ? ` ${r.skipped} already there, skipped.` : ''}`)];
  if (r.left_open && r.left_open.length) {
    parts.push(h('p', null, 'Left unfilled because the person can no longer work it:'), h('ul', null, r.left_open.map((x) => h('li', null, `${dayShort(x.starts_at.slice(0, 10))} ${monthDay(x.starts_at.slice(0, 10))}: ${x.reason}`))));
  }
  dialog(title, parts);
}

/** Week templates: apply one to this week, save this week as one, or delete one. */
export async function templatesDialog(start, onDone) {
  const list = h('div');
  const name = input({ name: 'name', maxlength: 80, placeholder: 'For example "Weekday standard"', 'aria-label': 'Template name' });
  const keep = h('input', { type: 'checkbox', checked: true });
  const dlg = dialog('Week templates', [
    h('p', { class: 'muted' }, `Apply a saved week to ${weekLabel(start)} as drafts, or save this week to use again.`), list,
    h('h3', null, 'Save this week as a template'),
    h('div', { class: 'inline-form' }, field('Name', name), button('Save template', async () => {
      if (!name.value.trim()) throw new Error('Give the template a name');
      await post('/workforce/shift-templates', { name: name.value.trim(), from: start, keep_people: keep.checked });
      toast('Template saved');
      name.value = '';
      await draw();
    }, { kind: 'primary' })),
    h('label', { class: 'check' }, keep, ' Keep the people on each shift (they are checked again when it is applied)'),
    h('p', { class: 'muted small' }, 'Saving under a name already used replaces that template.')], { wide: true });
  async function draw() {
    const { data } = await get('/workforce/shift-templates');
    clear(list).append(data.length ? table([
      { head: 'Template', cell: (t) => h('b', null, t.name) },
      { head: 'Shifts', num: true, cell: (t) => String(t.shifts) },
      { head: '', actions: true, cell: (t) => [
        button('Apply to this week', async () => {
          const r = await post(`/workforce/shift-templates/${t.id}/apply`, { week: start });
          dlg.close();
          await onDone();
          resultDialog(`${t.name} applied`, r);
        }, { small: true, kind: 'primary', label: `Apply ${t.name} to this week` }),
        button('Delete', () => confirmDialog(`Delete ${t.name}?`, 'Shifts already made from it stay.', 'Delete', async () => { await del(`/workforce/shift-templates/${t.id}`); toast('Template deleted'); await draw(); }, { danger: true }), { small: true, label: `Delete ${t.name}` }),
      ] },
    ], data) : empty('No templates yet. Build a typical week, then save it here.'));
  }
  await draw();
}

/** Publish the week's drafts. Everyone on them is told in their Inbox. */
export function publishWeek(start, drafts, onDone) {
  confirmDialog(`Publish ${drafts} draft shift${drafts === 1 ? '' : 's'}?`, `Staff see ${weekLabel(start)} in My shifts, and everyone on a shift gets a message in their Inbox listing theirs. Changes after this are messaged to the people they affect.`, 'Publish', async () => {
    const r = await post('/workforce/shifts/publish', { from: start, to: addDays(start, 6) });
    toast(`${r.published} shift${r.published === 1 ? '' : 's'} published${r.notified ? `, ${r.notified} ${r.notified === 1 ? 'person' : 'people'} told` : ''}`);
    await onDone();
  });
}

/** How many people each position needs on a day of this week, against who is on a shift. */
export function staffingNeeds(start, today) {
  let date = weekDays(start).includes(today) ? today : start;
  const forecast = input({ type: 'number', min: 0, placeholder: 'Leave blank to estimate', 'aria-label': 'Expected guests' });
  const days = h('div', { class: 'seg day-seg', role: 'group', 'aria-label': 'Day' });
  const out = h('div');
  const drawDays = () => clear(days).append(...weekDays(start).map((d) => h('button', { type: 'button', 'aria-pressed': String(d === date), onclick: () => { date = d; drawDays(); run(); } }, `${dayShort(d)} ${Number(d.slice(8))}`)));
  async function run() {
    clear(out).append(h('p', { class: 'loading' }, 'Working it out…'));
    try {
      const q = `date=${date}${forecast.value !== '' ? `&forecast=${forecast.value}` : ''}`;
      const r = await get(`/workforce/staffing-suggestion?${q}`);
      clear(out).append(...[!r.forecast_visits ? h('p', { class: 'muted' }, 'No guests expected yet for this day (no tickets sold and no pass scans on this weekday lately). Type a number to plan with.') : null, h('p', { class: 'muted' }, r.basis === 'override' ? `${r.forecast_visits} expected guests (your number).`
        : `About ${r.forecast_visits} expected guests: ${r.tickets} day ticket${r.tickets === 1 ? '' : 's'} sold for ${dayLong(date)}, plus about ${r.pass_estimate} pass holder${r.pass_estimate === 1 ? '' : 's'} (the average on this weekday over the last four weeks).`)].filter(Boolean),
      r.data.length ? table([
        { head: 'Position', cell: (p) => p.position },
        { head: 'Needed', num: true, cell: (p) => String(p.suggested) },
        { head: 'On a shift', num: true, cell: (p) => String(p.scheduled) },
        { head: 'Unfilled shifts', num: true, cell: (p) => (p.unfilled ? String(p.unfilled) : '') },
        { head: '', cell: (p) => (!p.suggested ? '' : p.gap > 0 ? state(`${p.gap} short`, 'warn') : state('Covered', 'good')) },
      ], r.data) : empty('No position has "guests per staff member" set yet. Set it on the Setup tab.'));
    } catch (err) { clear(out).append(errorBox(err)); }
  }
  forecast.addEventListener('change', run);
  drawDays();
  dialog('Staffing needs', [days, h('div', { class: 'inline-form' }, field('Expected guests', forecast, 'Your own number replaces the estimate')), out], { wide: true });
  run();
}
