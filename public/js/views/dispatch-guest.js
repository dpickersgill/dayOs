// The call view's Guest section (help/guest): what the guest tapped on their phone, in plain words; the pass hint; the
// phone's latest position; and messages both ways with quick replies. The location panel and the map belong to
// help/places and sit elsewhere on the call view.

import { poll, post } from '../api.js';
import { h, state, button, toast, fmtTime } from '../ui.js';

// Quick replies, in the guest's page language.
const QUICK = [
  ['Stay where you are.', 'Quédese donde está.'],
  ['Patrol is on the way.', 'La patrulla va en camino.'],
  ['Look for a patroller in a red jacket.', 'Busque a un patrullero con chaqueta roja.'],
  ['Can you see a lift tower? Tell us the number.', '¿Ve una torre del telesilla? Díganos el número.'],
];
const LANG = { en: 'English', es: 'Spanish' };

/** The section for a call from the guest help page, or null. redraw() redraws the whole call. */
export function guestSection(c, redraw) {
  const g = c.guest;
  if (!g) return null;
  const box = h('section', { class: 'guest-box stack', 'aria-label': 'From the guest' });
  if (g.hidden) return appendTo(box, h('h3', null, 'From the guest'), h('p', { class: 'muted' }, 'Hidden: this call has a case you cannot open.'));
  const live = ['new', 'dispatched', 'on_scene', 'transporting'].includes(c.status);
  const es = g.lang === 'es';
  const facts = [
    ['Who needs help', g.who_text], ['Page language', LANG[g.lang] || null],
    ...g.answers.map((a) => [a.label, a.alert ? state(a.value, 'bad') : a.value]),
    ['Pass hint', g.scan_hint],
  ].filter(([, v]) => v);
  const p = g.positions[0];
  const where = p ? h('p', null, h('b', null, 'Latest from their phone: '), `${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)}`,
    p.accuracy_m != null ? `, within about ${p.accuracy_m} m` : '', `, taken ${fmtTime(p.taken_at)}`, g.positions.length > 1 ? h('span', { class: 'muted' }, ` (${g.positions.length} positions kept)`) : null,
    g.live_off_at ? h('span', { class: 'muted' }, `. The guest turned live location off at ${fmtTime(g.live_off_at)}.`) : null) : null;
  const text = h('textarea', { rows: 2, maxlength: 1000, 'aria-label': 'Message to the guest', placeholder: es ? 'This guest’s page is in Spanish' : 'Message to the guest' });
  const send = async (body) => {
    if (!body.trim()) return;
    try {
      const r = await post(`/patrol/dispatch/${c.id}/messages`, { body: body.trim() });
      toast(r.texted ? 'Sent to the guest (page and text)' : 'Sent to the guest');
      text.value = '';
      await redraw();
    } catch (err) { toast(err.message, 'error'); }
  };
  const msgs = h('ul', { class: 'guest-msgs' }, g.messages.length ? g.messages.map((m) => h('li', { class: m.direction === 'from_guest' ? 'from-guest' : 'to-guest' },
    h('span', { class: 'muted' }, `${fmtTime(m.at)} ${m.direction === 'from_guest' ? 'Guest' : 'Dispatch'}${m.channel === 'sms' ? ' (text)' : ''}: `), m.body,
    m.direction === 'to_guest' ? h('span', { class: 'muted' }, m.delivered ? ' Seen' : ' Not seen yet') : null)) : h('li', { class: 'muted' }, 'No messages yet.'));
  return appendTo(box,
    h('h3', null, 'From the guest'),
    facts.length ? h('dl', { class: 'facts' }, facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : h('p', { class: 'muted' }, 'No answers yet. They appear here as the guest taps them.'),
    where,
    h('h3', null, 'Messages'), msgs,
    live ? h('div', { class: 'stack' },
      h('div', { class: 'row guest-quick' }, QUICK.map(([en, sp]) => button(es ? sp : en, () => send(es ? sp : en), { small: true }))),
      h('div', { class: 'row' }, text, button('Send', () => send(text.value), { kind: 'primary' })),
      h('p', { class: 'muted' }, g.can_text ? 'Messages show on the guest’s page and are texted to the phone they gave.' : 'Messages show on the guest’s page while it is open.')) : null);
}
function appendTo(el, ...kids) { for (const k of kids) if (k) el.append(k); return el; }

/** While the call is open, check for new guest replies every 10 seconds and redraw when there are. */
export function watchGuest(holder, id, count, redraw) {
  let seen = count;
  const timer = setInterval(async () => {
    if (!holder.isConnected) { clearInterval(timer); return; }
    try {
      const c = await poll(`/patrol/dispatch/${id}`);
      const n = c.guest && c.guest.messages ? c.guest.messages.length : 0;
      if (n !== seen) { seen = n; await redraw(); }
    } catch (_) { /* next time */ }
  }, 10000);
  return () => clearInterval(timer);
}
