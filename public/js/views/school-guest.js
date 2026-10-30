// Lesson planning, best of breed (2026.11.9, Track GUEST): the guest side's settings in Settings, Ski school.
//   Pools and privates: how a private asked for online is confirmed (the instructor accepts, or automatically when a
//   cleared instructor is free) and whether new pool lessons follow staff or keep the number typed.
//   Level questions: the three yes or no questions per discipline guests answer when they book, and the level each
//   answer leads to (lib/placement.js). The lineup's suggested split uses the level for a student with none yet.
// settingsPages: { key: { title, render(panel) } }, shown by settings-apps.js.
import { get, patch, put } from '../api.js';
import { h, clear, input, select, field, button, toast, fail } from '../ui.js';
import { levelList, levelName } from '../levels.js';

export function tabs() { return []; }

export const settingsPages = {
  'pools-privates': { title: 'Pools and privates', render: (panel) => choicesPage(panel) },
  placement: { title: 'Level questions', render: (panel) => placementPage(panel) },
};

// ---------------------------------------------------------------- pools and privates
async function choicesPage(panel) {
  const s = await get('/skischool/settings');
  const radios = (name, list, value) => h('div', { class: 'gs-radios', role: 'radiogroup' }, list.map(([v, text, hint]) => h('label', { class: 'check gs-radio' },
    h('input', { type: 'radio', name, value: v, checked: v === value }), h('span', null, h('strong', null, text), hint ? h('small', { class: 'muted' }, hint) : null))));
  const priv = radios('private_confirm', [
    ['accept', 'Instructor accepts each one', 'The instructor (or anyone for "any instructor") says yes on My day. This is how it worked before.'],
    ['auto', 'Confirm automatically when an instructor is free', 'Booked at once with the instructor asked for, or the best free instructor who is cleared for it. If nobody is free, the instructor accepts as usual.'],
  ], s.private_confirm);
  const pools = radios('pool_spots_mode', [
    ['staff', 'Follow staff', 'Open spots move with the instructors free at that time, times the students per instructor, never above the number you type.'],
    ['fixed', 'Keep the number I type', 'The spots stay at the number you type until you change it.'],
  ], s.pool_spots_mode);
  priv.setAttribute('aria-label', 'Private lessons asked for online');
  pools.setAttribute('aria-label', 'New pool lessons');
  const form = h('form', { class: 'stack', novalidate: true },
    h('fieldset', { class: 'gs-set' }, h('legend', null, 'Private lessons asked for online'), priv),
    h('fieldset', { class: 'gs-set' }, h('legend', null, 'New pool lessons in the season plan'), pools,
      h('p', { class: 'muted small' }, `Students per instructor: ${s.ratio_kids} for kids, ${s.ratio_adults} for adults. Change these in Lineup.`)),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pick = (name) => (form.querySelector(`input[name="${name}"]:checked`) || {}).value;
    try { await patch('/skischool/settings', { private_confirm: pick('private_confirm'), pool_spots_mode: pick('pool_spots_mode') }); toast('Saved'); } catch (err) { fail(err); }
  });
  panel.append(form);
}

// ---------------------------------------------------------------- level questions
const DISC = [['ski', 'Ski'], ['snowboard', 'Snowboard']];

async function placementPage(panel) {
  let data = await get('/skischool/placement');
  const body = h('div', { class: 'stack' });
  panel.append(h('p', { class: 'muted gs-intro' }, 'Guests answer three yes or no questions for each student when they book, unless they pick a level. Each answer leads to the next question or to a level. The lineup uses that level to place a student who has none yet. Telemark and adaptive students are placed by the instructor.'), body);

  function draw() {
    clear(body);
    const rows = {};
    for (const [d, dName] of DISC) {
      const qs = data.questions[d];
      rows[d] = qs.map((q, i) => {
        const last = i === qs.length - 1;
        const opts = [...(last ? [] : [['', 'The next question']]), ...levelList(d).map((l) => [String(l.level), levelName(l.level, d)])];
        const text = input({ value: q.text, maxlength: 160, required: true, 'aria-label': `${dName} question ${i + 1}` });
        const yes = select(opts, q.yes ?? '', { 'aria-label': `${dName} question ${i + 1}: yes leads to` });
        const no = select(opts, q.no ?? '', { 'aria-label': `${dName} question ${i + 1}: no leads to` });
        const looks = h('p', { class: 'muted small gs-looks' });
        const say = () => {
          const part = (sel, word) => { const lv = Number(sel.value); const row = lv ? levelList(d)[lv - 1] : null; return row ? `${word}: "${row.can}"` : null; };
          looks.textContent = [part(yes, 'Yes'), part(no, 'No')].filter(Boolean).join('  ');
        };
        yes.addEventListener('change', say); no.addEventListener('change', say); say();
        return { text, yes, no, el: h('div', { class: 'gs-q' }, h('span', { class: 'gs-num', 'aria-hidden': 'true' }, String(i + 1)), h('div', { class: 'gs-q-body' }, field(`Question ${i + 1}`, text), h('div', { class: 'gs-leads' }, field('Yes leads to', yes), field('No leads to', no)), looks)) };
      });
      body.append(h('section', { class: 'gs-disc' }, h('h3', null, dName), ...rows[d].map((r) => r.el)));
    }
    const save = button('Save the questions', async () => {
      const out = {};
      for (const [d, dName] of DISC) {
        out[d] = rows[d].map((r, i) => ({ text: r.text.value.trim(), yes: r.yes.value ? Number(r.yes.value) : null, no: r.no.value ? Number(r.no.value) : null, i }));
        const short = out[d].find((q) => q.text.length < 5);
        if (short) { fail(new Error(`${dName} question ${short.i + 1} needs a few more words`)); return; }
        out[d] = out[d].map(({ i, ...q }) => q);
      }
      try { data = { ...data, ...(await put('/skischool/placement', { questions: out })) }; toast('Saved'); draw(); } catch (err) { fail(err); }
    }, { kind: 'primary' });
    const reset = button('Use the built-in questions', async () => {
      try { data = { ...data, ...(await put('/skischool/placement', { questions: null })) }; toast('Back to the built-in questions'); draw(); } catch (err) { fail(err); }
    });
    body.append(h('p', { class: 'muted small' }, data.custom ? 'You are using your own questions.' : 'You are using the built-in questions.'), h('div', { class: 'row' }, save, reset));
  }
  draw();
}
