// Check steps that ask for a reading or a date, shared by the mountain's own checklists (Assets) and patrol gear checks.
// stepsEditor: the manager's list of steps (what to check, and for a reading or a date, the rule it must meet).
// answerSheet: the person doing the check answers each step; a reading or date outside its rule shows as failing at once.
import { h, input, select, button, todayStr, addDays } from './ui.js';

const TYPES = [['pass', 'Pass or fail'], ['number', 'Reading (a number)'], ['date', 'Date (expiry)']];
const keyOf = (label, used, i) => {
  let k = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || `step_${i + 1}`;
  while (used.has(k)) k = `${k.slice(0, 26)}_${i + 1}`;
  used.add(k);
  return k;
};
const numOrNull = (el) => (el.value.trim() === '' ? null : Number(el.value));

/** An editable list of steps. Returns { el, get() } where get() throws a plain message for a mistake. */
export function stepsEditor(steps) {
  const list = h('div', { class: 'steps-ed' });
  const rows = [];
  function addRow(s = { label: '', type: 'pass' }) {
    const labelIn = input({ maxlength: 150, value: s.label || '', placeholder: 'What to check, e.g. Cylinder pressure', 'aria-label': 'What to check' });
    const type = select(TYPES, s.type || 'pass', { 'aria-label': 'Kind of answer' });
    const unit = input({ maxlength: 20, value: s.unit || '', placeholder: 'Unit, e.g. psi', 'aria-label': 'Unit' });
    const min = input({ type: 'number', step: 'any', value: s.min ?? '', placeholder: 'Lowest OK', 'aria-label': 'Lowest allowed reading' });
    const max = input({ type: 'number', step: 'any', value: s.max ?? '', placeholder: 'Highest OK', 'aria-label': 'Highest allowed reading' });
    const days = input({ type: 'number', min: 0, max: 3650, value: s.within_days ?? '', placeholder: 'e.g. 30', 'aria-label': 'Fails this many days before the date' });
    const mini = (text, el) => h('label', { class: 'steps-mini' }, h('span', null, text), el);
    const numBox = h('div', { class: 'row tight steps-rule' }, mini('Unit', unit), mini('Lowest OK', min), mini('Highest OK', max));
    const dateBox = h('label', { class: 'row tight steps-rule' }, 'Fails', days, 'days before');
    const show = () => { numBox.hidden = type.value !== 'number'; dateBox.hidden = type.value !== 'date'; };
    type.addEventListener('change', show); show();
    const row = { s, labelIn, type, unit, min, max, days };
    const remove = button('Remove', () => { el.remove(); rows.splice(rows.indexOf(row), 1); }, { small: true, kind: 'quiet', label: `Remove ${s.label || 'step'}` });
    const el = h('div', { class: 'steps-row' }, h('div', { class: 'row tight' }, labelIn, type, remove), numBox, dateBox);
    row.el = el;
    rows.push(row); list.append(el);
  }
  for (const s of steps.length ? steps : [{ label: '', type: 'pass' }]) addRow(s);
  const el = h('div', { class: 'stack' }, list, h('div', { class: 'row' }, button('Add a step', () => { addRow(); rows.at(-1).labelIn.focus(); }, { small: true })));
  function get() {
    const used = new Set();
    const out = [];
    rows.forEach((r, i) => {
      const labelText = r.labelIn.value.trim();
      if (!labelText) return;
      // Keep the key of a step whose wording stays, so earlier checks still line up.
      const key = r.s.key && r.s.label === labelText && !used.has(r.s.key) ? (used.add(r.s.key), r.s.key) : keyOf(labelText, used, i);
      const step = { key, label: labelText.slice(0, 150), type: r.type.value };
      if (step.type === 'number') {
        step.unit = r.unit.value.trim() || null; step.min = numOrNull(r.min); step.max = numOrNull(r.max);
        if (step.min !== null && step.max !== null && step.min > step.max) throw new Error(`${labelText}: the lowest OK reading is above the highest`);
      }
      if (step.type === 'date') step.within_days = numOrNull(r.days);
      out.push(step);
    });
    return out;
  }
  return { el, get };
}

/** What a reading or date step allows, in words. */
export function ruleText(s) {
  const u = (n) => `${n}${s.unit ? ` ${s.unit}` : ''}`;
  if (s.type === 'number') return s.min != null && s.max != null ? `${u(s.min)} to ${u(s.max)}` : s.min != null ? `at least ${u(s.min)}` : s.max != null ? `at most ${u(s.max)}` : (s.unit || '');
  if (s.type === 'date') return s.within_days ? `fails within ${s.within_days} days` : 'fails once passed';
  return '';
}
/** Would this answer fail its rule? (The server decides; this only shows it straight away.) */
function failsRule(s, v) {
  if (v === '' || v === null || v === undefined) return null;
  if (s.type === 'number') { const n = Number(v); if (!Number.isFinite(n)) return null; return (s.min != null && n < s.min) || (s.max != null && n > s.max); }
  if (s.type === 'date') { const today = todayStr(); return v < today || (s.within_days ? v <= addDays(today, s.within_days) : false); }
  return null;
}

/**
 * Answers for a list of steps. `chips(id, labelledBy)` makes the pass/fail/na control a screen already uses
 * ({ el, get, set }). Returns { el, answers: [{ key, get(), missing(), needsNote(), focus() }], markRestPass() }.
 */
export function answerSheet(steps, chips) {
  const answers = steps.map((raw, i) => {
    const s = { ...raw, type: raw.type || 'pass' }; // checklists made before readings have no type: pass or fail
    const id = `ins-${i}`;
    const note = input({ maxlength: 255, placeholder: 'What is wrong', 'aria-label': `What is wrong: ${s.label}`, hidden: true });
    const head = h('span', { id: `${id}-l`, class: 'ins-label' }, s.label, s.type !== 'pass' ? h('small', { class: 'muted' }, ` ${ruleText(s)}`) : null);
    if (s.type === 'pass') {
      const c = chips(id, `${id}-l`);
      c.el.addEventListener('change', () => { note.hidden = c.get() !== 'fail'; if (!note.hidden) note.focus(); });
      return { key: s.key, step: s, el: h('div', { class: 'ins-item' }, head, c.el, note),
        get: () => ({ key: s.key, result: c.get(), note: note.value.trim() || null }), missing: () => !c.get(), needsNote: () => c.get() === 'fail' && !note.value.trim(), focus: () => note.focus(), pass: () => { if (!c.get()) c.set('pass'); } };
    }
    const field = s.type === 'number'
      ? input({ type: 'number', step: 'any', inputmode: 'decimal', 'aria-labelledby': `${id}-l`, placeholder: s.unit || '' })
      : input({ type: 'date', 'aria-labelledby': `${id}-l` });
    const na = h('input', { type: 'checkbox' });
    const flag = h('span', { class: 'state', dataset: { state: 'bad' }, hidden: true }, 'Fails');
    const update = () => { const f = !na.checked && failsRule(s, field.value); flag.hidden = !f; field.disabled = na.checked; };
    field.addEventListener('input', update); na.addEventListener('change', update);
    return { key: s.key, step: s, el: h('div', { class: 'ins-item' }, head, h('div', { class: 'row tight' }, field, s.type === 'number' && s.unit ? h('span', { class: 'muted' }, s.unit) : null, flag, h('label', { class: 'check' }, na, ' N/A')), note),
      get: () => (na.checked ? { key: s.key, result: 'na' } : { key: s.key, value: s.type === 'number' ? Number(field.value) : field.value, note: note.value.trim() || null }),
      missing: () => !na.checked && field.value === '', needsNote: () => false, focus: () => field.focus(), pass: () => {} };
  });
  const el = h('div', { class: 'stack' }, answers.map((a) => a.el));
  return { el, answers, markRestPass: () => answers.forEach((a) => a.pass()) };
}

/** Pass, Fail and N/A as three chips; tap again to clear. Fires 'change' on the group. */
export function resultChips(id, labelledBy) {
  let cur = '';
  const row = h('div', { class: 'chip-row', role: 'group', id, 'aria-labelledby': labelledBy });
  for (const [v, t] of [['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A']]) {
    const b = h('button', { type: 'button', class: `chip result-${v}`, 'data-value': v, 'aria-pressed': 'false' }, t);
    b.addEventListener('click', () => { cur = cur === v ? '' : v; for (const x of row.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.value === cur)); row.dispatchEvent(new window.Event('change', { bubbles: true })); });
    row.append(b);
  }
  return { el: row, get: () => cur || null, set: (v) => { cur = v; for (const x of row.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.value === cur)); } };
}
