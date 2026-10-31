// Lift inspections by lift type (2026.11.10, SLIM 7d), the Lift inspections tab inside Mountain status, Maintenance.
//   Each lift, its type, today's daily inspection and its last weekly one, with Start, Continue and History.
//   An inspection is ticked item by item (saved as you go), then signed off. A failed required item fails it: the lift
//   says Cannot open until a new inspection of that kind passes. A failed optional item still opens a work order.
//   Managers set each lift's type and edit the mountain's own copy of each type's daily and weekly list.
import { get, post, patch, put } from '../api.js';
import { liftWord } from '../liftstatus.js';
import { h, clear, isManager, input, select, field, button, toast, dialog, formDialog, table, state, empty, errorBox, fail, fmtDate, fmtTime, todayStr } from '../ui.js';

const RESULT_WORD = { pass: 'Pass', fail: 'Fail', na: 'Not needed' };

export async function drawChecks(box) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Date' });
  const body = h('div');
  const head = h('div', { class: 'row wrap' }, field('Date', date));
  if (isManager()) head.append(button('Checklists by lift type', () => listsDialog(), { small: true }));
  clear(box).append(h('header', null, h('h2', null, 'Lift inspections'), head),
    h('p', { class: 'muted small' }, 'Each lift is inspected from the list for its type: a daily one before it carries anyone, and a weekly one. A failed required item opens a work order, and the lift cannot be set to open until a new inspection passes.'), body);
  let meta = null;
  async function load() {
    if (!meta) meta = await get('/ops/lift-types');
    const day = await get(`/ops/lift-inspections/day?date=${date.value}`);
    clear(body);
    if (!day.data.length) { body.append(empty('No lifts yet. Add them on the Status tab.')); return; }
    if (isManager() && day.data.some((l) => !l.lift_type)) body.append(h('p', { class: 'note-box' }, 'Some lifts have no type yet, so they use the standard list. Choose a type for each to use the right checklist.'));
    body.append(table([
      { head: 'Lift', cell: (l) => h('span', { class: 'stack tight' }, h('strong', null, l.name), h('span', { class: 'muted small' }, l.lift_type_label)) },
      { head: 'Lift status', cell: (l) => { const [t, k] = liftWord(l.status, l.blocked ? 'fail' : null); return state(t, k); } },
      { head: 'Daily', cell: (l) => dailyCell(l) },
      { head: 'Weekly', cell: (l) => weeklyCell(l) },
      { head: '', actions: true, cell: (l) => actions(l, day.today) },
    ], day.data));
  }
  function dailyCell(l) {
    const c = l.daily;
    if (c && c.status === 'in_progress') return state(`Under way, ${c.items.filter((i) => i.result).length} of ${c.items.length}`, 'warn');
    if (l.daily_result === 'pass') return h('span', { class: 'stack tight' }, state('Passed', 'good'), c && c.finished_by ? h('small', { class: 'muted' }, `${c.finished_by}, ${fmtTime(c.finished_at)}`) : null);
    if (l.daily_result === 'fail') return state('Failed', 'bad');
    return state('Not done', 'warn');
  }
  function weeklyCell(l) {
    const w = l.weekly;
    if (w && w.status === 'in_progress') return state(`Under way, ${w.items.filter((i) => i.result).length} of ${w.items.length}`, 'warn');
    if (l.weekly_result === 'fail') return state(`Failed ${fmtDate(l.weekly_date)}`, 'bad');
    if (!l.weekly_result) return state('Never done', 'warn');
    return state(`Passed ${fmtDate(l.weekly_date)}`, l.weekly_due ? 'warn' : 'good');
  }
  function actions(l, live) {
    const out = h('span', { class: 'row tight wrap' });
    if (live) {
      const d = l.daily && l.daily.status === 'in_progress';
      out.append(button(d ? 'Continue daily' : l.daily_result ? 'Inspect again' : 'Daily inspection', () => begin(l, 'daily'), { small: true, kind: !l.daily_result || d ? 'primary' : undefined, label: `Daily inspection: ${l.name}` }));
      const w = l.weekly && l.weekly.status === 'in_progress';
      out.append(button(w ? 'Continue weekly' : 'Weekly inspection', () => begin(l, 'periodic'), { small: true, label: `Weekly inspection: ${l.name}` }));
    }
    out.append(button('History', () => history(l), { small: true, label: `Inspection history: ${l.name}` }));
    if (isManager()) out.append(button('Type', () => typeDialog(l), { small: true, label: `Lift type: ${l.name}` }));
    return out;
  }
  async function begin(l, kind) {
    try {
      const c = await post(`/ops/lifts/${l.id}/inspections`, { kind });
      inspectionDialog(l, c, load);
    } catch (err) { fail(err); }
  }
  function typeDialog(l) {
    const pick = select([['', 'Not set (standard list)'], ...meta.types.map((t) => [t.key, t.label])], l.lift_type || '', { name: 'lift_type' });
    formDialog(`Lift type: ${l.name}`, h('div', { class: 'form' }, field('Type', pick, 'Picks the daily and weekly checklist this lift is inspected with.')), async () => {
      await patch(`/ops/lifts/${l.id}/type`, { lift_type: pick.value || null });
      toast(`${l.name} saved`);
      await load();
    }, { submitText: 'Save type' });
  }
  async function history(l) {
    const { data } = await get(`/ops/lifts/${l.id}/inspections`);
    const problems = (c) => c.items.filter((i) => i.result === 'fail').map((i) => `${i.label}: ${i.note}`).join('; ');
    dialog(`${l.name} inspections`, data.length ? table([
      { head: 'Date', cell: (c) => fmtDate(c.check_date) },
      { head: 'Kind', cell: (c) => c.kind_label },
      { head: 'Result', cell: (c) => (c.status === 'pass' ? state('Passed', 'good') : c.status === 'fail' ? state('Failed', 'bad') : state('Not signed off', 'warn')) },
      { head: 'Signed off by', cell: (c) => (c.finished_by ? `${c.finished_by}, ${fmtTime(c.finished_at)}` : '') },
      { head: 'Problems', cell: (c) => problems(c) },
    ], data) : empty('No inspections yet with the checklists by lift type. Older ones are in the daily report.'), { wide: true });
  }
  function listsDialog() {
    const type = select(meta.types.map((t) => [t.key, t.label]), meta.types[0].key, { 'aria-label': 'Lift type' });
    const kind = select(meta.kinds.map((k) => [k.key, k.long]), 'daily', { 'aria-label': 'Which inspection' });
    const slot = h('div');
    const errSlot = h('div');
    let editor = null;
    const current = () => meta.types.find((t) => t.key === type.value).lists[kind.value];
    const draw = () => { editor = listEditor(current()); clear(slot).append(h('p', { class: 'muted small' }, current().custom ? 'Your mountain\'s own list.' : 'The built-in list. Your changes make it your mountain\'s own.'), editor.el); };
    type.addEventListener('change', draw); kind.addEventListener('change', draw);
    const save = h('button', { type: 'button', class: 'btn primary' }, 'Save list');
    const dlg = dialog('Checklists by lift type', [
      h('p', { class: 'muted small' }, 'Start from the built-in list and make it match your manufacturer\'s manual, your own lift procedures and your state inspector\'s rules, which come first. Inspections already done keep the words they were done with.'),
      h('div', { class: 'row wrap' }, field('Lift type', type), field('Inspection', kind)), slot, errSlot,
    ], { wide: true, footer: h('div', { class: 'row' }, save) });
    save.addEventListener('click', async () => {
      clear(errSlot);
      const v = editor.value();
      if (v === null) { dlg.close(); return; }
      try {
        const out = await put(`/ops/lift-templates/${type.value}/${kind.value}`, { items: v === 'defaults' ? null : v });
        const t = meta.types.find((x) => x.key === type.value);
        t.lists[kind.value] = { ...t.lists[kind.value], items: out.items, custom: out.custom };
        toast('Checklist saved');
        draw();
      } catch (err) { errSlot.append(errorBox(err)); }
    });
    draw();
  }
  date.addEventListener('change', () => date.value && load().catch(fail));
  await load();
}

/** Edit a list: words, required or not, order, add and remove, or go back to the built-in list. */
function listEditor(list) {
  let items = list.items.map((i) => ({ ...i }));
  let touched = false;
  const box = h('ol', { class: 'liftchk-edit' });
  const draw = () => {
    clear(box);
    items.forEach((it, i) => {
      const text = input({ value: it.label, maxlength: 200, 'aria-label': `Item ${i + 1}` });
      text.addEventListener('input', () => { it.label = text.value; touched = true; });
      const req = h('input', { type: 'checkbox', checked: it.required !== false, 'aria-label': `Item ${i + 1} is required` });
      req.addEventListener('change', () => { it.required = req.checked; touched = true; });
      const up = h('button', { type: 'button', class: 'btn small quiet', 'aria-label': `Move item ${i + 1} up`, disabled: i === 0 }, 'Up');
      up.addEventListener('click', () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; touched = true; draw(); });
      const rm = h('button', { type: 'button', class: 'btn small quiet', 'aria-label': `Remove item ${i + 1}` }, 'Remove');
      rm.addEventListener('click', () => { items.splice(i, 1); touched = true; draw(); });
      box.append(h('li', null, text, h('label', { class: 'liftchk-req' }, req, ' Required'), up, rm));
    });
  };
  draw();
  const addBtn = h('button', { type: 'button', class: 'btn small' }, 'Add an item');
  addBtn.addEventListener('click', () => { items.push({ label: '', required: true }); touched = true; draw(); box.lastChild.querySelector('input').focus(); });
  const reset = h('button', { type: 'button', class: 'btn small quiet' }, 'Use the built-in list');
  reset.addEventListener('click', () => { items = list.built_in.map((i) => ({ ...i })); touched = 'defaults'; draw(); });
  return {
    el: h('div', { class: 'stack tight' }, box, h('div', { class: 'row' }, addBtn, reset)),
    value: () => (touched === 'defaults' ? 'defaults' : touched ? items.map((i) => ({ ...(i.key ? { key: i.key } : {}), label: String(i.label || '').trim(), required: i.required !== false })).filter((i) => i.label) : null),
  };
}

/** One inspection: Pass or Fail on each item (a fail needs a note; an optional item can be Not needed), then Sign off. */
function inspectionDialog(l, chk, again) {
  let check = chk;
  const list = h('ol', { class: 'attr-check-list' });
  const progress = h('p', { class: 'muted small', role: 'status' });
  const overall = input({ maxlength: 500, placeholder: 'Optional note for the whole inspection', 'aria-label': 'Note for the inspection' });
  const save = async (key, result, note) => {
    check = await patch(`/ops/lift-inspections/${check.id}`, { items: [{ key, result, note: note || null }] });
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
        h('span', { class: 'attr-item-label' }, it.label, it.required ? null : h('small', { class: 'muted' }, ' (optional)')),
        h('div', { class: 'attr-item-act', role: 'group', 'aria-label': it.label }, pick('pass', 'Pass', 'good'), pick('fail', 'Fail', 'bad'), it.required ? null : pick('na', 'Not needed', 'neutral')),
        it.result === 'fail' || it.note ? note : h('div', { class: 'attr-note-slot' }, (() => { const more = h('button', { type: 'button', class: 'linklike' }, 'Add a note'); more.addEventListener('click', () => { more.replaceWith(note); note.focus(); }); return more; })()),
        it.by ? h('small', { class: 'muted' }, `${RESULT_WORD[it.result]}: ${it.by}, ${fmtTime(it.at)}`) : null));
    }
    const done = check.items.filter((i) => i.result).length;
    const failedReq = check.items.filter((i) => i.result === 'fail' && i.required).length;
    const failed = check.items.filter((i) => i.result === 'fail').length;
    progress.textContent = `${done} of ${check.items.length} checked${failed ? `, ${failed} failed` : ''}.`;
    finish.textContent = failedReq ? 'Sign off: failed' : 'Sign off: passed';
    finish.className = failedReq ? 'btn danger' : 'btn primary';
    finish.disabled = !failedReq && done < check.items.length;
  }
  const finish = h('button', { type: 'button', class: 'btn primary' }, 'Sign off');
  const close = h('button', { type: 'button', class: 'btn' }, 'Keep for later');
  const errSlot = h('div');
  const dlg = dialog(`${check.kind_label}: ${l.name}`, [
    h('p', { class: 'muted small' }, `${l.lift_type_label}. Started by ${check.started_by || 'staff'} at ${fmtTime(check.started_at)}. Every tick is saved as you go. The manufacturer's manual and your state inspector's rules come first.`),
    list, field('Note', overall), progress, errSlot], { wide: true, footer: h('div', { class: 'row' }, close, finish), onClose: () => { again().catch(fail); } });
  close.addEventListener('click', dlg.close);
  finish.addEventListener('click', async () => {
    clear(errSlot); finish.disabled = true;
    try {
      const out = await post(`/ops/lift-inspections/${check.id}/finish`, { note: overall.value.trim() || null });
      if (out.status === 'pass') toast(`${l.name} passed${out.work_order_id ? '. A work order was opened for the problems found.' : ''}`, 'ok');
      else toast(`${l.name} failed. A work order was opened, and it cannot open until a new inspection passes.${out.lift_open ? ' It is open now: stop loading and close it on the Status tab.' : ''}`, 'warn');
      dlg.close();
    } catch (err) { errSlot.append(errorBox(err)); draw(); }
  });
  draw();
}
