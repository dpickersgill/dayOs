// Take-home sheets: plain advice handed to a patient who is released. General first-aid guidance only; it does not replace a
// clinician. Each sheet ends with a space for the patrol's phone number, so a guest knows who to call with questions.

import { get } from '../api.js';
import { h, clear, button, toast, fmtDate, errorBox, nowInput } from '../ui.js';

export const SHEETS = [
  {
    id: 'concussion', title: 'Head injury and concussion',
    intro: 'You hit your head or were shaken hard. Most people recover fully, but a head injury can change over the next day or two.',
    sections: [
      ['Call 911 or go to the emergency room right away if you or the person with you notices', [
        'A headache that keeps getting worse', 'Vomiting more than once', 'Unusual sleepiness, or you cannot be woken', 'Confusion, strange behavior or trouble remembering', 'A seizure or fainting',
        'Weakness, numbness or clumsiness in an arm or leg', 'Slurred speech, double vision, or one pupil bigger than the other', 'Clear fluid or blood from the nose or ears', 'A stiff neck or neck pain']],
      ['For the first 24 hours', ['Have a responsible adult stay with you.', 'Rest. Avoid screens, loud places and hard thinking if they make you feel worse.', 'Do not drink alcohol.', 'Do not drive if you are dizzy or foggy.']],
      ['Getting back to normal', ['Return to daily activities slowly, as symptoms allow.', 'Do not ski, ride or do any activity where you could fall or be hit until a doctor or other clinician says you are clear.', 'See your doctor in the next few days, sooner if symptoms are not improving.', 'Wear a helmet. A helmet that has taken a hard hit should be replaced.']]],
  },
  {
    id: 'injury', title: 'Sprain, strain, bruise or suspected break',
    intro: 'Your injury was checked and cared for by ski patrol. This is not a final diagnosis. Some breaks and ligament injuries only show up days later.',
    sections: [
      ['Get medical care right away if', ['The limb looks bent or out of shape', 'You cannot put weight on it or use it', 'It is numb, tingling, pale, blue or cold', 'The swelling or pain is severe or spreading', 'You have a fever, or the skin over the injury is open or red']],
      ['The first two days', ['Rest it. Do not push through the pain.', 'Ice for 15 to 20 minutes every two to three hours while awake, with a cloth between the ice and your skin.', 'Wrap it snugly, not tight. If your toes or fingers go numb or turn color, loosen it.', 'Raise it above the level of your heart when you can.']],
      ['After that', ['See your doctor within a day or two if it is not clearly improving, or if you are unsure.', 'Ask your doctor before going back to skiing or riding.', 'Ask a pharmacist or doctor which pain relief is right for you.']],
    ],
  },
  {
    id: 'general', title: 'After patrol helped you',
    intro: 'Thank you for letting us help. Some problems do not show up right away, especially after a hard fall or collision.',
    sections: [
      ['Call 911 or go to the emergency room if you get', ['Chest pain or trouble breathing', 'Pain in the belly, shoulder tip or back that is getting worse, or blood in your urine', 'Dizziness, faintness, or feeling very unwell', 'Severe pain, or numbness and weakness', 'A headache that gets worse, repeated vomiting, or confusion']],
      ['Over the next few days', ['Rest and take it easy.', 'Expect to be sore. Bruising often shows up a day later.', 'See your doctor if you are worried, or if you are not getting better.']],
    ],
  },
];

export function sheetText(sheet, resort, name, date) {
  const L = [`${resort}: ${sheet.title}`, `For ${name}, ${date}`, '', sheet.intro, ''];
  for (const [t, items] of sheet.sections) { L.push(`${t}:`, ...items.map((x) => `  - ${x}`), ''); }
  L.push('If you are in an emergency, call 911. This is general first-aid advice and does not replace a doctor.');
  return L.join('\n');
}

export async function renderTakehome(root, id, pid, kind) {
  const page = h('div', { class: 'stack' });
  root.append(page);
  let c;
  try { c = await get(`/patrol/incidents/${id}`); } catch (err) { page.append(h('p', null, h('a', { href: `#/patrol/case/${id}` }, 'Back to the case')), errorBox(err)); return; }
  const p = c.patients.find((x) => x.id === Number(pid));
  if (!p) { page.append(h('p', null, h('a', { href: `#/patrol/case/${id}` }, 'Back to the case')), errorBox(new Error('Patient not found on this case'))); return; }
  const head = p.injuries.some((i) => !i.voided_at && (i.injury_type === 'concussion' || i.body_region === 'head'));
  let current = SHEETS.find((s) => s.id === kind) || SHEETS.find((s) => s.id === (head ? 'concussion' : 'injury'));
  const resort = c.resort.legal_name || c.resort.name;
  const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'the patient';
  const date = fmtDate(nowInput().replace('T', ' ') + ':00');
  const body = h('div');
  const picks = h('div', { class: 'chip-row handoff-tools', role: 'group', 'aria-label': 'Choose a sheet' });
  function draw() {
    for (const b of picks.querySelectorAll('button[data-sheet]')) b.setAttribute('aria-pressed', String(b.dataset.sheet === current.id));
    clear(body).append(h('header', { class: 'hs-head' },
      h('div', null, h('p', { class: 'eyebrow' }, 'Take-home sheet'), h('h1', null, current.title), h('p', null, `For ${name}`)),
      h('div', { class: 'hs-meta' }, h('b', null, resort), h('span', null, date))),
    h('p', { class: 'lead-text' }, current.intro),
    ...current.sections.map(([t, items], i) => h('section', { class: `hs${i === 0 ? ' urgent' : ''}` }, h('h3', null, t), h('ul', { class: 'plain bullets' }, items.map((x) => h('li', null, x))))),
    h('p', { class: 'emergency' }, 'In an emergency, call 911.'),
    h('div', { class: 'hs-sign' }, h('div', null, h('span', { class: 'k' }, 'Questions? Patrol phone'), h('div', { class: 'line' })), h('div', null, h('span', { class: 'k' }, 'Given by'), h('div', { class: 'line' }))),
    h('p', { class: 'hs-foot muted small' }, 'General first-aid advice from ski patrol. It does not replace a doctor. Follow any instructions a doctor gives you.'));
  }
  for (const s of SHEETS) { const b = h('button', { type: 'button', class: 'chip', 'data-sheet': s.id }, s.title); b.addEventListener('click', () => { current = s; draw(); }); picks.append(b); }
  const tools = h('div', { class: 'handoff-tools row' }, h('a', { class: 'btn', href: `#/patrol/case/${id}` }, 'Back to the case'), button('Print', () => window.print(), { kind: 'primary' }),
    button('Copy as text', async () => { try { await navigator.clipboard.writeText(sheetText(current, resort, name, date)); toast('Copied'); } catch (_) { toast('Could not copy. Use Print instead.', 'error'); } }));
  page.append(h('article', { class: 'handoff takehome', 'data-takehome': p.id }, tools, picks, body));
  draw();
}
