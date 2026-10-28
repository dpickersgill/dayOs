// Attractions: the mountain's other things to do (zipline, mountain coaster, tubing, the rink and the rest).
//   Settings, Attractions (settingsPages below): the list, with add, edit (name, type, limits, waiver, order and the
//     attraction's own opening checks), archive and restore. Managers.
//   Mountain status (drawAttractions, from conditions.js): Open, On hold or Closed like a lift, today's opening
//     inspection item by item, and downtime with a reason. A failed inspection blocks opening until a new one passes.
//   Settings, Staff and schedule (drawStaffSuggestions, from workforce.js): the positions and certifications each type
//     usually needs, added in one step.
import { get, post, patch, put } from '../api.js';
import { h, clear, isManager, input, select, field, button, toast, formDialog, dialog, confirmDialog, table, state, empty, errorBox, fail, fmtTime, nowInput, label } from '../ui.js';

const STATES = [['open', 'Open', 'good'], ['hold', 'On hold', 'warn'], ['closed', 'Closed', 'bad']];
let metaCache = null;
/** The types (with their default checks) and the downtime reasons, read once. */
async function meta() {
  if (!metaCache) metaCache = get('/attractions/meta').catch((err) => { metaCache = null; throw err; });
  return metaCache;
}
const typeOptions = (types) => types.map((t) => [t.key, t.label]);
const reasonText = (reasons, v) => (reasons.find((r) => r.value === v) || { label: label(v) }).label;

/** "48 in and taller, 50 to 275 lb, 7 and older, waiver" */
export function limitsText(a) {
  const bits = [];
  if (a.min_height_in) bits.push(`${a.min_height_in} in and taller`);
  if (a.min_weight_lb && a.max_weight_lb) bits.push(`${a.min_weight_lb} to ${a.max_weight_lb} lb`);
  else if (a.min_weight_lb) bits.push(`at least ${a.min_weight_lb} lb`);
  else if (a.max_weight_lb) bits.push(`up to ${a.max_weight_lb} lb`);
  if (a.min_age) bits.push(`${a.min_age} and older`);
  if (a.waiver_required) bits.push('waiver');
  return bits.join(', ');
}

// ================================================================ Settings, Attractions
export const settingsPages = {
  attractions: { title: 'Your attractions', who: 'manager', render: (panel) => drawSetup(panel) },
};

async function drawSetup(panel) {
  let showArchived = false;
  const listBox = h('div', { class: 'stack' });
  const archivedToggle = h('input', { type: 'checkbox' });
  archivedToggle.addEventListener('change', () => { showArchived = archivedToggle.checked; load().catch(fail); });
  const add = button('Add attraction', () => editDialog(null, load), { kind: 'primary', small: true });
  clear(panel).append(h('div', { class: 'stack attr-setup' },
    h('p', { class: 'muted' }, 'Ziplines, a mountain coaster, tubing, the ice rink and anything else guests do beside skiing and riding. Each one has Open, On hold and Closed like a lift on Mountain status, a daily opening inspection, and the height, weight and age limits the counter and the online shop show.'),
    h('div', { class: 'spread' }, add, h('label', { class: 'check' }, archivedToggle, ' Show archived')),
    listBox));

  async function load() {
    const { data } = await get('/attractions?all=1'); // with each one's opening checks, for Edit
    const list = data.filter((a) => (showArchived ? true : a.active));
    clear(listBox);
    if (!list.length) { listBox.append(empty('No attractions yet. Add your zipline, coaster, tubing hill or rink.')); return; }
    listBox.append(table([
      { head: 'Attraction', cell: (a) => h('span', null, h('b', null, a.name), a.active ? null : h('span', { class: 'muted' }, ' (archived)')) },
      { head: 'Type', cell: (a) => a.type_label },
      { head: 'Limits', cell: (a) => limitsText(a) || h('span', { class: 'muted' }, 'None') },
      { head: 'Opening checks', cell: (a) => (a.checklist ? `${a.checklist.length} items${a.checklist_custom ? '' : ', the defaults'}` : '') },
      { head: '', actions: true, cell: (a) => (a.active ? [
        button('Edit', () => editDialog(a, load), { small: true, label: `Edit ${a.name}` }),
        button('Archive', () => confirmDialog(`Archive ${a.name}?`, 'It closes and leaves Mountain status, selling and the patrol list. Patrol reports, inspections and sales that name it keep it. You can restore it later.', 'Archive', async () => {
          await post(`/attractions/${a.id}/archive`); toast(`${a.name} archived`); await load();
        }), { small: true, label: `Archive ${a.name}` }),
      ] : button('Restore', async () => { await post(`/attractions/${a.id}/restore`); toast(`${a.name} restored`); await load(); }, { small: true, label: `Restore ${a.name}` })) },
    ], list));
  }
  await load();
}

/** The opening checks as a list a manager can reword, reorder, add to and take from. */
function checksEditor(start, defaultsFor) {
  let items = start.map((i) => ({ ...i }));
  let touched = false;
  const box = h('ol', { class: 'attr-checks-edit' });
  const draw = () => {
    clear(box);
    items.forEach((it, i) => {
      const text = input({ value: it.label, maxlength: 200, 'aria-label': `Check ${i + 1}` });
      text.addEventListener('input', () => { it.label = text.value; touched = true; });
      const up = h('button', { type: 'button', class: 'btn small quiet', 'aria-label': `Move check ${i + 1} up`, disabled: i === 0 }, 'Up');
      up.addEventListener('click', () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; touched = true; draw(); });
      const rm = h('button', { type: 'button', class: 'btn small quiet', 'aria-label': `Remove check ${i + 1}` }, 'Remove');
      rm.addEventListener('click', () => { items.splice(i, 1); touched = true; draw(); });
      box.append(h('li', null, text, up, rm));
    });
  };
  draw();
  const addBtn = h('button', { type: 'button', class: 'btn small' }, 'Add a check');
  addBtn.addEventListener('click', () => { items.push({ label: '' }); touched = true; draw(); box.lastChild.querySelector('input').focus(); });
  const reset = h('button', { type: 'button', class: 'btn small quiet' }, 'Use the defaults for this type');
  reset.addEventListener('click', () => { items = defaultsFor().map((i) => ({ ...i })); touched = 'defaults'; draw(); });
  return {
    el: h('div', { class: 'stack tight' }, box, h('div', { class: 'row' }, addBtn, reset)),
    /** null: leave as it is; 'defaults': back to the type's list; otherwise the items to save. */
    value: () => (touched === 'defaults' ? 'defaults' : touched ? items.map((i) => ({ ...(i.key ? { key: i.key } : {}), label: String(i.label || '').trim() })).filter((i) => i.label) : null),
    replace: (next) => { if (touched) return; items = next.map((i) => ({ ...i })); draw(); },
  };
}

async function editDialog(a, done) {
  const m = await meta();
  const tdef = (k) => (m.types.find((t) => t.key === k) || m.types[m.types.length - 1]);
  const type = select(typeOptions(m.types), a ? a.type : 'zipline', { name: 'type', required: true });
  const n = (name, v, attrs) => input({ name, type: 'number', min: 0, inputmode: 'numeric', value: v ?? '', ...attrs });
  const checks = checksEditor(a ? a.checklist : tdef(type.value).checks, () => tdef(type.value).checks);
  type.addEventListener('change', () => checks.replace(tdef(type.value).checks)); // a new attraction follows its type until edited
  const waiver = h('input', { type: 'checkbox', name: 'waiver_required', checked: a ? a.waiver_required : true });
  formDialog(a ? `Edit ${a.name}` : 'Add an attraction', h('div', { class: 'stack' },
    h('div', { class: 'form' },
      field('Name', input({ name: 'name', required: true, maxlength: 100, value: a ? a.name : '', placeholder: 'For example "Summit Zip" or "Alpine Coaster"' })),
      field('Type', type, 'Choose "Something else" for anything not listed.'),
      field('Shortest rider', h('span', { class: 'set-amount' }, n('min_height_in', a && a.min_height_in, { max: 96 }), ' in'), 'Blank for no limit'),
      field('Youngest rider', h('span', { class: 'set-amount' }, n('min_age', a && a.min_age, { max: 99 }), ' years')),
      field('Lightest rider', h('span', { class: 'set-amount' }, n('min_weight_lb', a && a.min_weight_lb, { max: 600 }), ' lb')),
      field('Heaviest rider', h('span', { class: 'set-amount' }, n('max_weight_lb', a && a.max_weight_lb, { max: 600 }), ' lb')),
      field('Order on lists', n('sort', a ? a.sort : '', { min: -1000, max: 1000 }), 'Lower numbers come first')),
    h('label', { class: 'check' }, waiver, ' Guests need a signed waiver'),
    h('fieldset', { class: 'attr-checks-field' }, h('legend', null, 'Daily opening checks'),
      h('p', { class: 'muted small' }, 'Start from the defaults for the type and make them match your manufacturer\'s daily inspection and your state inspector\'s rules, which come first. An inspection already done keeps the words it was done with.'),
      checks.el)),
  async (fd) => {
    const numOrNull = (k) => { const v = String(fd.get(k) || '').trim(); return v === '' ? null : Number(v); };
    const body = { name: String(fd.get('name') || '').trim(), type: type.value, min_height_in: numOrNull('min_height_in'), min_weight_lb: numOrNull('min_weight_lb'), max_weight_lb: numOrNull('max_weight_lb'), min_age: numOrNull('min_age'), waiver_required: waiver.checked };
    const sort = numOrNull('sort'); if (sort !== null) body.sort = sort;
    if (!body.name) throw new Error('Give it a name');
    const list = checks.value();
    if (Array.isArray(list) && !list.length) throw new Error('Keep at least one opening check, or use the defaults for this type');
    if (a) {
      await patch(`/attractions/${a.id}`, body);
      if (list) await put(`/attractions/${a.id}/checklist`, { items: list === 'defaults' ? null : list });
    } else {
      await post('/attractions', { ...body, ...(Array.isArray(list) ? { checklist: list } : {}) });
    }
    toast(a ? 'Attraction saved' : 'Attraction added');
    await done();
  }, { submitText: a ? 'Save' : 'Add attraction', wide: true });
}

// ================================================================ Mountain status
/** The Attractions section beside Lifts and Trails. canSet: may change status and inspect (staff, patrol, managers). */
export async function drawAttractions(box, canSet) {
  const [{ data, date }, m] = await Promise.all([get('/attractions/today'), meta()]);
  clear(box);
  if (!data.length) {
    if (isManager()) box.append(h('header', null, h('h2', null, 'Attractions')), empty('No attractions yet.', h('a', { class: 'btn small', href: '#/settings/attractions' }, 'Add them in Settings')));
    else box.hidden = true;
    return;
  }
  box.hidden = false;
  const again = () => drawAttractions(box, canSet).catch((err) => clear(box).append(errorBox(err)));
  box.append(h('header', null, h('h2', null, `Attractions (${data.filter((a) => a.status === 'open').length} of ${data.length} open)`),
    isManager() ? h('a', { class: 'btn small', href: '#/settings/attractions' }, 'Set up') : null));
  box.append(table([
    { head: 'Attraction', cell: (a) => h('span', { class: 'attr-name' }, h('strong', null, a.name), h('small', { class: 'muted' }, a.type_label)) },
    { head: 'Status', cell: (a) => h('div', { class: 'stack tight' }, statusControl(a, canSet, m, again), a.status !== 'open' && a.status_note ? h('small', { class: 'muted attr-note' }, a.status_note) : null) },
    { head: 'Opening check', cell: (a) => checkCell(a, canSet, again) },
    { head: 'Down since', cell: (a) => (a.down ? h('span', null, fmtTime(a.down.started_at), h('small', { class: 'muted' }, ` ${reasonText(m.downtime_reasons, a.down.reason)}`)) : h('span', { class: 'muted' }, a.status === 'open' ? 'Running' : '')) },
  ], data, { rowClass: (a) => (a.blocked ? 'attr-blocked' : null) }));
  if (canSet) {
    const down = h('div', { class: 'stack tight attr-downtime' });
    box.append(down);
    await drawDowntime(down, date, data, m, again);
  }
}

/** Open, On hold, Closed. Hold asks why (shown to staff); Closed asks why (closed for the day by default). */
function statusControl(a, canSet, m, again) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': `${a.name} status` });
  for (const [value, text, tone] of STATES) {
    const b = h('button', { type: 'button', 'aria-pressed': String(value === a.status), dataset: { tone }, disabled: !canSet || (value === 'open' && a.blocked) }, text);
    if (value === 'open' && a.blocked) b.title = 'Failed its opening inspection today';
    b.addEventListener('click', async () => {
      if (value === a.status && value === 'open') return;
      if (value === 'open') {
        b.disabled = true;
        try { await patch(`/attractions/${a.id}/status`, { status: 'open' }); toast(`${a.name} open`); await again(); } catch (err) { fail(err); b.disabled = false; }
        return;
      }
      statusDialog(a, value, m, again);
    });
    wrap.append(b);
  }
  return wrap;
}

function statusDialog(a, value, m, again) {
  const reasons = m.downtime_reasons.filter((r) => value === 'closed' || r.value !== 'day_end');
  const reason = select(reasons.map((r) => [r.value, r.label]), value === 'closed' ? 'day_end' : 'weather', { name: 'reason' });
  const note = input({ name: 'note', maxlength: 255, required: value === 'hold', value: a.status === value ? a.status_note || '' : '', placeholder: value === 'hold' ? 'For example "Wind over 30 mph at the top platform"' : 'Optional' });
  formDialog(value === 'hold' ? `Put ${a.name} on hold` : `Close ${a.name}`, h('div', { class: 'form' },
    field('Why', reason), field(value === 'hold' ? 'Note for staff' : 'Note for staff (optional)', note)), async (fd) => {
    const text = String(fd.get('note') || '').trim();
    if (value === 'hold' && !text) throw new Error('Say why it is on hold');
    await patch(`/attractions/${a.id}/status`, { status: value, reason: reason.value, note: text || null });
    toast(value === 'hold' ? `${a.name} on hold` : `${a.name} closed`);
    await again();
  }, { submitText: value === 'hold' ? 'Put on hold' : 'Close' });
}

function checkCell(a, canSet, again) {
  const c = a.check;
  const tag = !c ? state('Not inspected yet', 'neutral')
    : c.status === 'pass' ? state(`Passed ${fmtTime(c.finished_at)}`, 'good')
      : c.status === 'fail' ? state('Failed: cannot open', 'bad')
        : state(`Under way, ${c.items.filter((i) => i.result).length} of ${c.items.length}`, 'warn');
  const who = c && c.status !== 'in_progress' && c.finished_by ? h('small', { class: 'muted' }, ` by ${c.finished_by}`) : null;
  let act = null;
  if (canSet && (!c || c.status !== 'pass')) {
    const text = !c ? 'Start check' : c.status === 'in_progress' ? 'Continue check' : 'Check again';
    act = button(text, async () => {
      const chk = c && c.status === 'in_progress' ? c : await post(`/attractions/${a.id}/checks`);
      inspectionDialog(a, chk, again);
    }, { small: true, kind: c && c.status === 'fail' ? undefined : 'primary', label: `${text}: ${a.name}` });
  }
  return h('div', { class: 'row tight wrap' }, tag, who, act);
}

/** Today's opening inspection: Pass or Fail on each item (a fail needs a note), saved as you go, then Finish. */
function inspectionDialog(a, chk, again) {
  let check = chk;
  const list = h('ol', { class: 'attr-check-list' });
  const progress = h('p', { class: 'muted small', role: 'status' });
  const overall = input({ maxlength: 500, placeholder: 'Optional note for the whole inspection', 'aria-label': 'Note for the inspection' });
  const save = async (key, result, note) => {
    check = await patch(`/attractions/checks/${check.id}`, { items: [{ key, result, note: note || null }] });
    draw();
  };
  function draw() {
    clear(list);
    for (const it of check.items) {
      const note = input({ maxlength: 300, value: it.note || '', placeholder: it.result === 'fail' ? 'What is wrong (needed)' : 'Note (optional)', 'aria-label': `Note for ${it.label}` });
      note.addEventListener('change', () => { if (it.result) save(it.key, it.result, note.value.trim()).catch(fail); });
      const pick = (result, text, tone) => {
        const b = h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(it.result === result), dataset: { tone } }, text);
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await save(it.key, it.result === result ? null : result, note.value.trim()); } catch (err) { fail(err); b.disabled = false; }
        });
        return b;
      };
      list.append(h('li', { class: `attr-item${it.result ? ` is-${it.result}` : ''}`, dataset: { key: it.key } },
        h('span', { class: 'attr-item-label' }, it.label),
        h('div', { class: 'attr-item-act', role: 'group', 'aria-label': it.label }, pick('pass', 'Pass', 'good'), pick('fail', 'Fail', 'bad')),
        it.result === 'fail' || it.note ? note : h('div', { class: 'attr-note-slot' }, (() => { const more = h('button', { type: 'button', class: 'linklike' }, 'Add a note'); more.addEventListener('click', () => { more.replaceWith(note); note.focus(); }); return more; })()),
        it.by ? h('small', { class: 'muted' }, `${it.result === 'pass' ? 'Passed' : 'Failed'} by ${it.by}, ${fmtTime(it.at)}`) : null));
    }
    const done = check.items.filter((i) => i.result).length; const failed = check.items.filter((i) => i.result === 'fail').length;
    progress.textContent = `${done} of ${check.items.length} checked${failed ? `, ${failed} failed` : ''}.`;
    finish.textContent = failed ? 'Finish: failed' : 'Finish: passed';
    finish.className = failed ? 'btn danger' : 'btn primary';
    finish.disabled = !failed && done < check.items.length;
  }
  const finish = h('button', { type: 'button', class: 'btn primary' }, 'Finish');
  const close = h('button', { type: 'button', class: 'btn' }, 'Keep for later');
  const errSlot = h('div');
  const dlg = dialog(`Opening inspection: ${a.name}`, [
    h('p', { class: 'muted small' }, `Attempt ${check.attempt}, started by ${check.started_by || 'staff'} at ${fmtTime(check.started_at)}. Every tick is saved as you go. The manufacturer's manual and your state inspector's rules come first.`),
    list, field('Note', overall), progress, errSlot], { wide: true, footer: h('div', { class: 'row' }, close, finish), onClose: () => { again(); } });
  close.addEventListener('click', dlg.close);
  finish.addEventListener('click', async () => {
    clear(errSlot); finish.disabled = true;
    try {
      const out = await post(`/attractions/checks/${check.id}/finish`, { note: overall.value.trim() || null });
      toast(out.status === 'pass' ? `${a.name} passed its opening inspection` : `${a.name} failed its inspection${out.closed ? ' and was closed' : ''}. It cannot open until a new inspection passes.`, out.status === 'pass' ? 'ok' : 'warn');
      dlg.close();
    } catch (err) { errSlot.append(errorBox(err)); draw(); }
  });
  draw();
}

// ---------------------------------------------------------------- downtime
async function drawDowntime(box, date, attractions, m, again) {
  const { data } = await get(`/attractions/downtime?from=${date}`);
  const minutes = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`);
  clear(box).append(h('div', { class: 'spread' }, h('h3', null, 'Downtime today'), button('Log downtime', () => downDialog(null, attractions, m, again), { small: true })),
    data.length ? table([
      { head: 'Attraction', cell: (d) => d.attraction },
      { head: 'Stopped', cell: (d) => fmtTime(d.started_at) },
      { head: 'Restarted', cell: (d) => (d.ended_at ? fmtTime(d.ended_at) : state('Still down', 'warn')) },
      { head: 'Why', cell: (d) => h('span', null, reasonText(m.downtime_reasons, d.reason), d.note ? h('small', { class: 'muted' }, ` ${d.note}`) : null) },
      { head: 'For', num: true, cell: (d) => minutes(d.minutes) },
      { head: '', actions: true, cell: (d) => button('Edit', () => downDialog(d, attractions, m, again), { small: true, label: `Edit downtime for ${d.attraction}` }) },
    ], data) : h('p', { class: 'muted' }, 'No downtime today.'));
}

/** Log a stop by hand (new), or put the right reason and times on one (edit). Entries are never deleted. */
function downDialog(d, attractions, m, again) {
  const which = d ? null : select(attractions.map((a) => [a.id, a.name]), attractions[0] && attractions[0].id, { name: 'attraction_id' });
  const reason = select(m.downtime_reasons.filter((r) => r.value !== 'day_end').map((r) => [r.value, r.label]), d ? d.reason : 'mechanical', { name: 'reason' });
  const from = input({ type: 'datetime-local', name: 'started_at', required: true, value: d ? String(d.started_at).replace(' ', 'T').slice(0, 16) : nowInput() });
  const to = input({ type: 'datetime-local', name: 'ended_at', value: d && d.ended_at ? String(d.ended_at).replace(' ', 'T').slice(0, 16) : '' });
  const note = input({ name: 'note', maxlength: 255, value: d ? d.note || '' : '' });
  formDialog(d ? `Downtime: ${d.attraction}` : 'Log downtime', h('div', { class: 'form' },
    which ? field('Attraction', which) : null, field('Why', reason), field('Stopped', from), field('Restarted', to, 'Blank while it is still down'), h('div', { class: 'wide' }, field('Note', note))), async () => {
    const body = { reason: reason.value, started_at: from.value, ended_at: to.value || null, note: note.value.trim() || null };
    if (d) await patch(`/attractions/downtime/${d.id}`, body); else await post('/attractions/downtime', { ...body, attraction_id: Number(which.value) });
    toast('Downtime saved');
    await again();
  });
}

// ================================================================ Staff suggestions
/** For Settings, Staff and schedule: the positions and certifications each attraction type usually needs. */
export async function drawStaffSuggestions(panel) {
  const { data } = await get('/workforce/attraction-staff');
  clear(panel);
  if (!data.length) {
    panel.append(h('p', { class: 'muted' }, 'Add your attractions in ', h('a', { href: '#/settings/attractions' }, 'Settings, Attractions'), ' first. Suggested positions and certifications for each one show here.'));
    return;
  }
  panel.append(h('p', { class: 'muted' }, 'Suggestions for the attractions you run. Adding makes only what you do not have yet, in the Attractions department, with the certifications each position requires. Rename them to your own words afterward. Then schedule them like any other position.'));
  for (const t of data) {
    const missing = t.positions.filter((p) => !p.exists);
    panel.append(h('section', { class: 'attr-staff stack tight' },
      h('div', { class: 'spread' }, h('h3', null, `${t.type_label}: ${t.attractions}`),
        missing.length ? button(`Add ${missing.length === 1 ? 'this position' : `these ${missing.length} positions`}`, async () => {
          const out = await post('/workforce/attraction-staff', { type: t.type, positions: missing.map((p) => p.name) });
          toast(`Added ${[out.positions.length ? `${out.positions.length} ${out.positions.length === 1 ? 'position' : 'positions'}` : null, out.certifications.length ? `${out.certifications.length} ${out.certifications.length === 1 ? 'certification' : 'certifications'}` : null].filter(Boolean).join(' and ') || 'nothing new'}`);
          await drawStaffSuggestions(panel);
        }, { small: true, kind: 'primary', label: `Add suggested positions for ${t.type_label}` }) : state('All added', 'good')),
      h('ul', { class: 'plain' }, t.positions.map((p) => h('li', null, h('b', null, p.name), p.requires.length ? ` requires ${p.requires.join(', ')}` : ', no certification needed', p.exists ? h('span', { class: 'muted' }, ' (you have it)') : null)))));
  }
}

