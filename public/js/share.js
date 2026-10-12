// Share a record with people at this mountain: a Share button on a patrol case, customer, order, asset, work order,
// waiver or document opens "Send to", and the message arrives in their Inbox with a link that opens the record.
// The link shows only what each reader is allowed to see.

import { h, clear, button, dialog, toast, errorBox, input } from './ui.js';
import { get, post } from './api.js';
import { icon } from './icons.js';

export const LINK_TYPES = {
  patrol_case: { label: 'Patrol case', path: (id) => `#/patrol/case/${id}` },
  asset: { label: 'Asset', path: (id) => `#/assets/a/${id}` },
  work_order: { label: 'Work order', path: (id) => `#/conditions/wo/${id}` },
  customer: { label: 'Customer', path: (id) => `#/people/${id}` },
  order: { label: 'Order', path: (id) => `#/sell/order/${id}` },
  waiver: { label: 'Waiver', path: (id) => `#/waivers/w/${id}` },
  document: { label: 'Document', path: (id) => `#/documents/d/${id}` },
};
const PATTERNS = Object.entries(LINK_TYPES).map(([type, t]) => [type, new RegExp(`${t.path('(\\d+)').replace(/[/]/g, '\\/')}`, 'g')]);

/** App links in a piece of text: the refs they point to, and the text with those links taken out. */
export function linksIn(text) {
  const refs = [];
  let rest = String(text || '');
  for (const [type, re] of PATTERNS) {
    rest = rest.replace(new RegExp(`(?:https?://[^\\s#]*)?${re.source}`, 'g'), (_m, id) => { refs.push({ type, id: Number(id) }); return ''; });
  }
  return { refs, text: rest.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim() };
}

/** A small Share button for a record. */
export function shareButton(type, id, { small = true } = {}) {
  const b = button('Share', () => shareDialog({ type, id }), { small, label: `Share this ${LINK_TYPES[type].label.toLowerCase()} in the Inbox` });
  b.prepend(icon('share', 16), ' ');
  b.classList.add('share-btn');
  return b;
}

/** A link card, as it appears in a message and in the composer. */
export function linkCard(l, { onRemove } = {}) {
  const remove = onRemove ? h('button', { type: 'button', class: 'link-remove', 'aria-label': 'Remove link', onclick: onRemove }, '×') : null;
  if (l.state === 'ok') {
    return h('div', { class: 'link-card' }, h('a', { href: l.path, class: 'link-open' }, h('small', null, l.label), h('strong', null, l.title), l.subtitle ? h('span', null, l.subtitle) : null), remove);
  }
  const why = l.state === 'gone' ? 'No longer there' : 'You cannot open this';
  return h('div', { class: 'link-card off' }, h('span', { class: 'link-open' }, h('small', null, l.label), h('strong', null, why)), remove);
}

/** Send to: people (each gets it in your one-to-one conversation) and your group conversations. */
export async function shareDialog(ref) {
  let people = []; let threads = []; let preview = null;
  try {
    [{ data: people }, { data: threads }, { data: [preview] }] = await Promise.all([get('/inbox/people'), get('/inbox/threads'), post('/inbox/links', { refs: [ref] })]);
  } catch (err) { toast(err.message || 'Could not open sharing', 'error'); return; }
  const groups = threads.filter((t) => t.kind === 'group');
  const chosen = new Set();
  const q = input({ type: 'search', placeholder: 'Find a person or group', 'aria-label': 'Find a person or group' });
  const list = h('div', { class: 'pick-list', role: 'group', 'aria-label': 'Send to' });
  const note = h('textarea', { rows: 3, maxlength: 4000, placeholder: 'Add a note (optional)', 'aria-label': 'Note' });
  const err = h('div');
  const send = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Send');
  const count = () => { send.disabled = !chosen.size; send.textContent = chosen.size > 1 ? `Send to ${chosen.size}` : 'Send'; };
  const row = (key, title, sub) => {
    const cb = h('input', { type: 'checkbox', checked: chosen.has(key) });
    cb.addEventListener('change', () => { if (cb.checked) chosen.add(key); else chosen.delete(key); count(); });
    return h('label', { class: 'check pick' }, cb, h('span', null, h('b', null, title), sub ? h('small', null, sub) : null));
  };
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const g = groups.filter((t) => !term || t.title.toLowerCase().includes(term));
    const p = people.filter((x) => !term || x.name.toLowerCase().includes(term));
    clear(list).append(...[
      g.length ? h('p', { class: 'pick-head' }, 'Groups') : null, ...g.map((t) => row(`t:${t.id}`, t.title, `${t.members.length + 1} people`)),
      p.length ? h('p', { class: 'pick-head' }, 'People') : null, ...p.map((x) => row(`u:${x.id}`, x.name, x.role)),
      !g.length && !p.length ? h('p', { class: 'muted' }, 'Nobody matches that.') : null].filter(Boolean));
  };
  q.addEventListener('input', draw);
  draw();
  const dlg = dialog(`Share: ${preview && preview.state === 'ok' ? preview.title : LINK_TYPES[ref.type].label}`, h('div', { class: 'stack' },
    preview ? linkCard(preview) : null,
    h('p', { class: 'muted small' }, 'People you send it to see the record only if their own access lets them open it.'),
    q, list, note, err, h('div', { class: 'footer row' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), send)), { wide: true });
  send.addEventListener('click', async () => {
    clear(err); send.disabled = true;
    const body = note.value.trim();
    let sent = 0;
    try {
      for (const key of chosen) {
        const [kind, id] = key.split(':');
        if (kind === 'u') await post('/inbox/threads', { user_ids: [Number(id)], body, refs: [ref] });
        else await post(`/inbox/threads/${id}/messages`, { body, refs: [ref] });
        sent += 1;
        chosen.delete(key); // sent: a retry after an error does not send it twice
      }
      dlg.close();
      toast(`Sent to ${sent === 1 ? '1 conversation' : `${sent} conversations`}`);
      window.dispatchEvent(new Event('inbox:changed'));
    } catch (ex) {
      err.append(errorBox(ex));
      if (sent) err.append(h('p', { class: 'muted small' }, `Sent to ${sent} already; those are no longer ticked.`));
      draw(); count();
    }
  });
}
