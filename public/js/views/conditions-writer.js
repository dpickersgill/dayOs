// The conditions writer on Mountain status (AI Operations add-on): Draft now, and for managers its settings (the time of
// the morning draft, and up to 5 past snow reports or posts that teach it the mountain's voice). The draft itself is
// read, edited and approved on Today, under Ready for you (ai-ready.js).
import { get, post, put } from '../api.js';
import { ctx, h, clear, button, toast, isManager, field, input } from '../ui.js';

const MAX_EXAMPLES = 5;

export const writerOn = () => Boolean(ctx.me && Array.isArray(ctx.me.modules) && ctx.me.modules.includes('assistant_plus') && ctx.me.modules.includes('conditions')
  && isManager()); // owners and managers: approving publishes on the public conditions page

export async function drawWriter(box) {
  if (!writerOn()) return;
  let s;
  try { s = await get('/ai/conditions/settings'); } catch (_) { return; }
  if (!s.available) return;
  const when = s.auto_on ? `Each morning at ${clock(s.draft_at)} a draft of the conditions note, snow report, social post and passholder email appears on Today, under Ready for you.` : 'The morning draft is off. Press Draft now when you want one.';
  const draft = button('Draft now', async () => {
    const r = await post('/ai/conditions/draft');
    toast(r.by === 'assistant' ? 'Drafted. It is on Today, under Ready for you.' : 'Filled in from today’s records. It is on Today, under Ready for you.');
    location.hash = '#/dashboard';
  }, { kind: 'primary' });
  clear(box).append(h('header', null, h('h2', null, 'Conditions writer'), h('span', { class: 'ready-chip' }, 'AI Operations (add-on)')),
    h('p', { class: 'muted' }, when, ' It uses only the numbers in your records. Nothing is published or sent until someone approves it.'),
    h('div', { class: 'row wrap' }, draft, isManager() ? button('Settings', () => settingsForm(box, s)) : null));
  box.hidden = false;
}

function clock(t) {
  const [hh, mm] = String(t || '07:00').split(':').map(Number);
  return `${hh % 12 === 0 ? 12 : hh % 12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${hh < 12 ? 'AM' : 'PM'}`;
}

function settingsForm(box, s) {
  const auto = h('input', { type: 'checkbox', id: 'cw-auto', checked: s.auto_on });
  const at = input({ type: 'time', id: 'cw-at', value: s.draft_at || '07:00' });
  const examples = Array.from({ length: MAX_EXAMPLES }, (_, i) => {
    const t = h('textarea', { id: `cw-ex-${i}`, rows: 3, maxlength: 2000, class: 'ready-text', placeholder: i === 0 ? 'Paste a past snow report or post' : '' });
    t.value = s.voice[i] || '';
    return t;
  });
  const save = button('Save settings', async () => {
    await put('/ai/conditions/settings', { auto_on: auto.checked, draft_at: at.value || '07:00', voice: examples.map((t) => t.value.trim()).filter(Boolean) });
    toast('Settings saved');
    await drawWriter(box);
  }, { kind: 'primary' });
  clear(box).append(h('header', null, h('h2', null, 'Conditions writer settings')),
    h('label', { class: 'ready-check', for: 'cw-auto' }, auto, h('span', null, h('b', null, 'Draft every morning'), h('small', null, 'Only on days that are on your calendar.'))),
    field('Draft time', at, 'After grooming and lift status are usually in.'),
    h('fieldset', { class: 'cw-voice' }, h('legend', null, 'Your voice: up to 5 past snow reports or posts'),
      h('p', { class: 'muted small' }, 'The assistant copies their tone, not their facts. Their numbers are hidden from it, and only the first part of each is used.'),
      ...examples.map((t, i) => h('div', { class: 'ready-field' }, h('label', { for: t.id }, `Example ${i + 1}`), t))),
    h('div', { class: 'row wrap' }, save, button('Cancel', () => drawWriter(box))));
}
