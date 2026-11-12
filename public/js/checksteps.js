// Check steps that ask for a reading or a date, shared by the mountain's own checklists (Assets) and patrol gear checks.
// stepsEditor: the manager's list of steps (what to check, and for a reading or a date, the rule it must meet).
// answerSheet: the person doing the check answers each step; a reading or date outside its rule shows as failing at once.
// Asset checklists (muni release 1) also have choices, yes or no, a few words and a condition score, and any step can
// need a photo; stepsEditor({ more: true }) offers them. Old checklists keep working unchanged.
import { h, input, select, button, todayStr, addDays, clear } from './ui.js';

const TYPES = [['pass', 'Pass or fail'], ['number', 'Reading (a number)'], ['date', 'Date (expiry)']];
const MORE_TYPES = [['choice', 'Choice from a list'], ['yesno', 'Yes or no'], ['text', 'A few words'], ['condition', 'Condition score (1 to 5)']];
/** The condition scores, as the asset screens word them. */
export const CONDITION_WORDS = ['New or like new', 'Good', 'Fair', 'Poor', 'Failed or failing'];
const listOf = (text) => String(text || '').split(',').map((x) => x.trim()).filter(Boolean);
const keyOf = (label, used, i) => {
  let k = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || `step_${i + 1}`;
  while (used.has(k)) k = `${k.slice(0, 26)}_${i + 1}`;
  used.add(k);
  return k;
};
const numOrNull = (el) => (el.value.trim() === '' ? null : Number(el.value));

/**
 * An editable list of steps. Returns { el, get() } where get() throws a plain message for a mistake. opts.more offers the
 * asset kinds of step (choice, yes or no, text, condition) and the photo and run hour meter flags.
 */
export function stepsEditor(steps, opts = {}) {
  const list = h('div', { class: 'steps-ed' });
  const rows = [];
  const kinds = opts.more ? [...TYPES, ...MORE_TYPES] : TYPES;
  function addRow(s = { label: '', type: 'pass' }) {
    const labelIn = input({ maxlength: 150, value: s.label || '', placeholder: 'What to check, e.g. Cylinder pressure', 'aria-label': 'What to check' });
    const type = select(kinds, s.type || 'pass', { 'aria-label': 'Kind of answer' });
    const unit = input({ maxlength: 20, value: s.unit || '', placeholder: 'Unit, e.g. psi', 'aria-label': 'Unit' });
    const min = input({ type: 'number', step: 'any', value: s.min ?? '', placeholder: 'Lowest OK', 'aria-label': 'Lowest allowed reading' });
    const max = input({ type: 'number', step: 'any', value: s.max ?? '', placeholder: 'Highest OK', 'aria-label': 'Highest allowed reading' });
    const days = input({ type: 'number', min: 0, max: 3650, value: s.within_days ?? '', placeholder: 'e.g. 30', 'aria-label': 'Fails this many days before the date' });
    const mini = (text, el) => h('label', { class: 'steps-mini' }, h('span', null, text), el);
    const runHours = h('input', { type: 'checkbox', checked: Boolean(s.run_hours) });
    const numBox = h('div', { class: 'row tight steps-rule' }, mini('Unit', unit), mini('Lowest OK', min), mini('Highest OK', max),
      opts.more ? h('label', { class: 'check' }, runHours, ' A pump\'s run hour meter') : null);
    const dateBox = h('label', { class: 'row tight steps-rule' }, 'Fails', days, 'days before');
    const options = input({ maxlength: 400, value: (s.options || []).join(', '), placeholder: 'Good, Needs cleaning, Damaged', 'aria-label': 'Choices, separated by commas' });
    const failOptions = input({ maxlength: 400, value: (s.fail_options || []).join(', '), placeholder: 'Damaged', 'aria-label': 'Choices that fail, separated by commas' });
    const choiceBox = h('div', { class: 'row tight steps-rule' }, mini('Choices (commas between)', options), mini('These fail', failOptions));
    const failOn = select([['', 'Neither'], ['yes', 'Yes'], ['no', 'No']], s.fail_on || '', { 'aria-label': 'Which answer fails' });
    const ynBox = h('div', { class: 'row tight steps-rule' }, mini('Fails on', failOn));
    const failAt = select([['', 'Never fails by itself'], ...[5, 4, 3].map((n) => [String(n), `${n} or worse fails`])], s.fail_at ? String(s.fail_at) : '', { 'aria-label': 'Condition that fails' });
    const condBox = h('div', { class: 'row tight steps-rule' }, mini('Fails at', failAt));
    const photo = h('input', { type: 'checkbox', checked: Boolean(s.photo) });
    // A safety-critical step on a vehicle (brakes, steering, lights, tires): failing it takes the vehicle out of service.
    const stops = h('input', { type: 'checkbox', checked: Boolean(s.stops_use) });
    const photoBox = opts.more ? h('div', { class: 'row tight steps-rule' }, h('label', { class: 'check' }, photo, ' Needs a photo'), h('label', { class: 'check' }, stops, ' A fail takes it out of service')) : null;
    const show = () => {
      numBox.hidden = type.value !== 'number'; dateBox.hidden = type.value !== 'date'; choiceBox.hidden = type.value !== 'choice';
      ynBox.hidden = type.value !== 'yesno'; condBox.hidden = type.value !== 'condition';
    };
    type.addEventListener('change', show); show();
    const row = { s, labelIn, type, unit, min, max, days, options, failOptions, failOn, failAt, photo, runHours, stops };
    const remove = button('Remove', () => { el.remove(); rows.splice(rows.indexOf(row), 1); }, { small: true, kind: 'quiet', label: `Remove ${s.label || 'step'}` });
    const el = h('div', { class: 'steps-row' }, h('div', { class: 'row tight' }, labelIn, type, remove), numBox, dateBox, choiceBox, ynBox, condBox, photoBox);
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
      if (step.type === 'number' && opts.more && r.runHours.checked) step.run_hours = true;
      if (step.type === 'choice') {
        step.options = listOf(r.options.value); step.fail_options = listOf(r.failOptions.value);
        if (step.options.length < 2) throw new Error(`${labelText}: give at least two choices, with commas between them`);
        const bad = step.fail_options.find((f) => !step.options.includes(f));
        if (bad) throw new Error(`${labelText}: "${bad}" fails, but it is not one of the choices`);
      }
      if (step.type === 'yesno') step.fail_on = r.failOn.value || null;
      if (step.type === 'condition') step.fail_at = r.failAt.value ? Number(r.failAt.value) : null;
      if (opts.more && r.photo.checked) step.photo = true;
      if (opts.more && r.stops.checked) step.stops_use = true;
      out.push(step);
    });
    return out;
  }
  return { el, get };
}

/** What a reading or date step allows, in words. */
export function ruleText(s) {
  const u = (n) => `${n}${s.unit ? ` ${s.unit}` : ''}`;
  // A lowest reading of 0 with no highest is no rule at all (a count cannot be below 0): nothing is said (2026.11.20).
  const min = s.min != null && !(Number(s.min) === 0 && s.max == null) ? s.min : null;
  const or = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}` : list[0]);
  if (s.type === 'number') return min != null && s.max != null ? `OK: ${u(min)} to ${u(s.max)}` : min != null ? `OK: at least ${u(min)}` : s.max != null ? `OK: at most ${u(s.max)}` : '';
  if (s.type === 'date') return s.within_days ? `Fails within ${s.within_days} days of the date` : 'Fails once the date has passed';
  if (s.type === 'choice' && (s.fail_options || []).length) return `Fails if: ${or(s.fail_options)}`;
  if (s.type === 'yesno' && s.fail_on) return `Fails if: ${s.fail_on === 'yes' ? 'Yes' : 'No'}`;
  if (s.type === 'condition') return s.fail_at ? `Fails if: ${s.fail_at} or worse` : '1 new to 5 failed';
  return '';
}
/** Would this answer fail its rule? (The server decides; this only shows it straight away.) */
function failsRule(s, v) {
  if (v === '' || v === null || v === undefined) return null;
  if (s.type === 'choice') return (s.fail_options || []).includes(v);
  if (s.type === 'yesno') return Boolean(s.fail_on) && v === s.fail_on;
  if (s.type === 'condition') return Boolean(s.fail_at) && Number(v) >= s.fail_at;
  if (s.type === 'number') { const n = Number(v); if (!Number.isFinite(n)) return null; return (s.min != null && n < s.min) || (s.max != null && n > s.max); }
  if (s.type === 'date') { const today = todayStr(); return v < today || (s.within_days ? v <= addDays(today, s.within_days) : false); }
  return null;
}

/** A photo button for a step that needs one: takes the picture, sends it (opts.photo(file) returns its id) and shows it is in. */
function photoTaker(s, sendPhoto) {
  let id = null;
  const status = h('span', { class: 'muted small', role: 'status' }, 'Photo needed');
  const pick = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', 'aria-label': `Photo: ${s.label}` });
  const take = h('button', { type: 'button', class: 'btn small' }, 'Take photo');
  take.addEventListener('click', () => pick.click());
  pick.addEventListener('change', async () => {
    const f = pick.files && pick.files[0];
    if (!f) return;
    take.disabled = true; clear(status).append('Sending…');
    try { id = await sendPhoto(f); clear(status).append('Photo added'); take.textContent = 'Take another'; } catch (err) { clear(status).append(err.message || 'The photo did not send. Try again.'); }
    take.disabled = false;
  });
  return { el: h('span', { class: 'row tight' }, take, pick, status), get: () => id };
}

/** Pick one: a row of chips (choices, yes or no, condition 1 to 5). Fires 'change' on the group. */
function pickChips(id, labelledBy, options) {
  let cur = '';
  const row = h('div', { class: 'chip-row', role: 'group', id, 'aria-labelledby': labelledBy });
  for (const [v, t] of options) {
    const b = h('button', { type: 'button', class: 'chip', 'data-value': v, 'aria-pressed': 'false' }, t);
    b.addEventListener('click', () => { cur = cur === v ? '' : v; for (const x of row.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.value === cur)); row.dispatchEvent(new window.Event('change', { bubbles: true })); });
    row.append(b);
  }
  return { el: row, get: () => cur };
}

/**
 * Answers for a list of steps. `chips(id, labelledBy)` makes the pass/fail/na control a screen already uses
 * ({ el, get, set }). opts.photo(file) sends a photo for a step that needs one and returns its id. Returns
 * { el, answers: [{ key, get(), missing(), needsNote(), needsPhoto(), focus() }], markRestPass(), hasPassItems }.
 */
export function answerSheet(steps, chips, opts = {}) {
  // opts.record: what the item's own record already says, for steps that ask for it (2026.11.20). turns: a valve's turns
  // to close ({ value, estimated, words }) or null when the record has neither the turns nor a size to estimate them from.
  // Without opts.record (an asset, a building), every step is asked as it is.
  const turns = opts.record ? opts.record.turns || null : undefined;
  const answers = steps.map((raw, i) => {
    const s = { ...raw, type: raw.type || 'pass' }; // checklists made before readings have no type: pass or fail
    const id = `ins-${i}`;
    if (s.key === 'turns_expected' && s.type === 'number' && turns !== undefined) {
      // Not asked: shown from the record (or left out when the record cannot say), never "0 turns expected".
      const fact = turns ? h('div', { class: 'ins-item' }, h('span', { class: 'ins-label' }, 'Turns expected'), h('p', { class: 'muted' }, turns.words)) : h('span', { hidden: true });
      return { key: s.key, step: s, el: fact, get: () => (turns ? { key: s.key, value: turns.value, note: turns.estimated ? 'Estimate from the valve size' : null } : { key: s.key, result: 'na' }),
        missing: () => false, needsNote: () => false, needsPhoto: () => false, focus: () => {}, pass: () => {} };
    }
    const note = input({ maxlength: 255, placeholder: 'What is wrong', 'aria-label': `What is wrong: ${s.label}`, hidden: true });
    const rule = ruleText(s);
    const expect = s.key === 'turns_counted' && turns ? `Expected ${turns.estimated ? 'about ' : ''}${turns.value}` : '';
    const head = h('span', { id: `${id}-l`, class: 'ins-label' }, s.label, (rule || expect) && s.type !== 'pass' ? h('small', { class: 'muted' }, ` ${[expect, rule].filter(Boolean).join('. ')}`) : null);
    const photo = s.photo && opts.photo ? photoTaker(s, opts.photo) : null;
    const withPhoto = (a) => (photo && a.result !== 'na' ? { ...a, photo_id: photo.get() } : a);
    const needsPhoto = (isNa) => Boolean(photo) && !isNa && !photo.get();
    if (s.type === 'pass') {
      const c = chips(id, `${id}-l`);
      c.el.addEventListener('change', () => { note.hidden = c.get() !== 'fail'; if (!note.hidden) note.focus(); });
      return { key: s.key, step: s, el: h('div', { class: 'ins-item' }, head, c.el, photo ? photo.el : null, note),
        get: () => withPhoto({ key: s.key, result: c.get(), note: note.value.trim() || null }), missing: () => !c.get(), needsNote: () => c.get() === 'fail' && !note.value.trim(),
        needsPhoto: () => needsPhoto(c.get() === 'na'), focus: () => note.focus(), pass: () => { if (!c.get()) c.set('pass'); } };
    }
    const na = h('input', { type: 'checkbox' });
    const flag = h('span', { class: 'state', dataset: { state: 'bad' }, hidden: true }, 'Fails');
    let field; let read;
    if (s.type === 'number' || s.type === 'date' || s.type === 'text') {
      field = s.type === 'number' ? input({ type: 'number', step: 'any', inputmode: 'decimal', 'aria-labelledby': `${id}-l`, placeholder: s.unit || '' })
        : s.type === 'date' ? input({ type: 'date', 'aria-labelledby': `${id}-l` }) : input({ maxlength: 500, 'aria-labelledby': `${id}-l`, placeholder: 'What you found' });
      read = () => field.value.trim();
    } else {
      const opts2 = s.type === 'choice' ? (s.options || []).map((o) => [o, o]) : s.type === 'yesno' ? [['yes', 'Yes'], ['no', 'No']] : [1, 2, 3, 4, 5].map((n) => [String(n), `${n} ${CONDITION_WORDS[n - 1]}`]);
      field = pickChips(id, `${id}-l`, opts2);
      read = () => field.get();
    }
    const control = field.el || field;
    // A count well short of the valve's expected turns is pointed out; the crew decides whether it operated fully.
    const short = expect ? h('span', { class: 'muted small', hidden: true }, 'Fewer turns than expected: check that it closed fully.') : null;
    const update = () => {
      const f = !na.checked && failsRule(s, read()); flag.hidden = !f; if (control.tagName === 'INPUT') control.disabled = na.checked; else control.hidden = na.checked;
      if (short) short.hidden = na.checked || read() === '' || Number(read()) >= turns.value * 0.8;
    };
    control.addEventListener(control.tagName === 'INPUT' ? 'input' : 'change', update); na.addEventListener('change', update);
    const value = () => (s.type === 'number' || s.type === 'condition' ? Number(read()) : read());
    return { key: s.key, step: s, el: h('div', { class: 'ins-item' }, head, h('div', { class: 'row tight' }, control, s.type === 'number' && s.unit ? h('span', { class: 'muted' }, s.unit) : null, flag, h('label', { class: 'check' }, na, ' N/A')), short, photo ? photo.el : null, note),
      get: () => (na.checked ? { key: s.key, result: 'na' } : withPhoto({ key: s.key, value: value(), note: note.value.trim() || null })),
      missing: () => !na.checked && read() === '', needsNote: () => false, needsPhoto: () => needsPhoto(na.checked), focus: () => (control.focus ? control.focus() : null), pass: () => {} };
  });
  const el = h('div', { class: 'stack' }, answers.map((a) => a.el));
  // hasPassItems: whether "Mark the rest as pass" can do anything (readings, dates and choices are never passed for you).
  return { el, answers, markRestPass: () => answers.forEach((a) => a.pass()), hasPassItems: answers.some((a) => a.step.type === 'pass') };
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
