// Inbox: conversations with the people who work at this mountain. Pick a conversation on the left (or the whole screen
// on a phone), read and reply on the right. Links to records (from a Share button, or pasted from the address bar)
// show as cards that open the record. New messages arrive by checking every few seconds while the page is open.

import { get, post, patch, del } from '../api.js';
import { h, clear, button, formDialog, confirmDialog, toast, empty, errorBox, input, field, fmtDate, fmtTime } from '../ui.js';
import { linkCard, linksIn, LINK_TYPES } from '../share.js';

const ONE = /^\d+$/;
const POLL_MS = 8000;
const LIST_MS = 20000;

const when = (s) => {
  const d = new Date(`${String(s).replace(' ', 'T').replace(/Z?$/, 'Z')}`);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? fmtTime(s) : fmtDate(s);
};

export async function render(root, params = []) {
  const openId = ONE.test(params[0] || '') ? Number(params[0]) : null;
  const listBox = h('div', { class: 'inbox-list' });
  const threadBox = h('section', { class: 'inbox-thread', 'aria-label': 'Conversation' });
  const layout = h('div', { class: `inbox${openId ? ' has-thread' : ''}` }, h('aside', { class: 'inbox-side' },
    h('div', { class: 'row between' }, h('h2', null, 'Conversations'), button('New message', () => newConversation(), { kind: 'primary', small: true })), listBox), threadBox);
  root.append(h('div', { class: 'page-head inbox-head' }, h('div', null, h('h1', null, 'Inbox'), h('p', { class: 'muted' }, 'Messages with your team. Use Share on a case, customer, order, asset, work order, waiver or document to send a link to it.'))), layout);

  let threads = [];
  async function loadList() {
    try { threads = (await get('/inbox/threads')).data; } catch (err) { clear(listBox).append(errorBox(err)); return; }
    clear(listBox);
    if (!threads.length) { listBox.append(empty('No conversations yet.', button('Start one', () => newConversation(), { small: true }))); return; }
    listBox.append(h('ul', { class: 'thread-list' }, threads.map((t) => h('li', null, h('a', { href: `#/inbox/${t.id}`, class: 'thread-row', 'aria-current': t.id === openId ? 'page' : null },
      h('span', { class: 'thread-top' }, h('b', null, t.title), h('small', null, when(t.last_at))),
      h('span', { class: 'thread-last' }, t.last ? `${t.last.by ? `${t.last.by}: ` : ''}${t.last.text}` : 'No messages yet'),
      t.unread ? h('span', { class: 'unread-dot', 'aria-label': `${t.unread} unread` }, String(t.unread)) : null)))));
  }
  await loadList();
  const listTimer = setInterval(() => { if (!root.isConnected) { clearInterval(listTimer); return; } if (!document.hidden) loadList(); }, LIST_MS);
  listTimer.unref?.(); // (test runners only: a pending timer must not keep the process alive)

  if (openId) await openThread(threadBox, openId, loadList);
  else threadBox.append(h('div', { class: 'thread-empty' }, h('p', null, threads.length ? 'Pick a conversation.' : 'Start a conversation with someone on your team.')));
}

async function openThread(box, id, onChange) {
  let info;
  try { info = await get(`/inbox/threads/${id}`); } catch (err) { clear(box).append(errorBox(err), h('a', { href: '#/inbox' }, 'Back to the inbox')); return; }
  const list = h('ol', { class: 'msg-list', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'msg-scroll' }, list);
  let firstId = null; let lastId = 0; let moreBefore = false;
  const olderBtn = button('Show earlier messages', () => loadOlder(), { small: true });
  olderBtn.hidden = true;
  scroller.prepend(h('div', { class: 'msg-older' }, olderBtn));

  const head = h('header', { class: 'thread-head' },
    h('a', { href: '#/inbox', class: 'thread-back', 'aria-label': 'Back to conversations' }, '‹'),
    h('div', { class: 'stack tight' }, h('h2', null, info.title), h('small', { class: 'muted' }, info.members.map((m) => (m.you ? 'You' : m.name)).join(', '))),
    info.kind === 'group' ? h('div', { class: 'row' },
      button('Add people', () => addPeople(), { small: true }),
      button('Rename', () => rename(), { small: true }),
      button('Leave', () => confirmDialog('Leave this conversation?', 'You will stop getting its messages. If someone adds you back, you will see messages from then on, not the ones while you were away.', 'Leave', async () => { await post(`/inbox/threads/${id}/leave`); toast('You left the conversation'); location.hash = '#/inbox'; window.dispatchEvent(new Event('inbox:changed')); }), { small: true })) : null);

  // ---- composer
  let pending = []; // links waiting to be sent: { ref, card }
  const text = h('textarea', { rows: 2, maxlength: 4000, placeholder: 'Write a message. Paste a link to a case, customer or order to attach it.', 'aria-label': 'Message' });
  const chips = h('div', { class: 'compose-links' });
  const sendBtn = h('button', { type: 'submit', class: 'btn primary' }, 'Send');
  const err = h('div');
  const form = h('form', { class: 'composer' }, chips, h('div', { class: 'compose-row' }, text, sendBtn), err);
  async function pickUpLinks() {
    const { refs, text: rest } = linksIn(text.value);
    if (!refs.length) return;
    const fresh = refs.filter((r) => !pending.some((p) => p.ref.type === r.type && p.ref.id === r.id));
    if (fresh.length > 5 - pending.length) { toast('A message can carry up to 5 links. Send the rest in another message.', 'error'); return; }
    text.value = rest;
    if (!fresh.length) return;
    try {
      const { data } = await post('/inbox/links', { refs: fresh });
      for (const l of data) pending.push({ ref: { type: l.type, id: l.id }, card: l });
    } catch (_) { for (const r of fresh) pending.push({ ref: r, card: { ...r, label: LINK_TYPES[r.type].label, state: 'no_access' } }); }
    drawChips();
  }
  function drawChips() {
    clear(chips).append(...pending.map((p, i) => linkCard(p.card, { onRemove: () => { pending.splice(i, 1); drawChips(); } })));
  }
  text.addEventListener('paste', () => setTimeout(pickUpLinks, 0));
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await pickUpLinks();
    const body = text.value.trim();
    if (!body && !pending.length) return;
    clear(err); sendBtn.disabled = true;
    try {
      await post(`/inbox/threads/${id}/messages`, { body, refs: pending.map((p) => p.ref) });
      text.value = ''; pending = []; drawChips();
      await loadNew();
      onChange();
    } catch (ex) { err.append(errorBox(ex)); }
    sendBtn.disabled = false;
    text.focus();
  });

  clear(box).append(head, scroller, form);

  // ---- messages
  function msgEl(m) {
    if (!m.by) return h('li', { class: 'msg system', dataset: { id: m.id } }, h('span', null, m.body), h('small', null, when(m.at)));
    const mine = m.by.you;
    const bubble = h('div', { class: 'bubble' },
      m.removed ? h('em', { class: 'muted' }, 'Message removed') : (m.body ? h('p', null, m.body) : null),
      m.links.length ? h('div', { class: 'msg-links' }, m.links.map((l) => linkCard(l))) : null);
    const remove = mine && !m.removed ? h('button', { type: 'button', class: 'linklike msg-remove', onclick: () => confirmDialog('Remove this message?', 'It is replaced by "Message removed" for everyone in the conversation.', 'Remove', async () => { await del(`/inbox/messages/${m.id}`); await reloadAll(); }) }, 'Remove') : null;
    return h('li', { class: `msg${mine ? ' mine' : ''}`, dataset: { id: m.id } },
      h('div', { class: 'msg-meta' }, h('b', null, mine ? 'You' : m.by.name), h('small', null, when(m.at)), remove), bubble);
  }
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  async function markRead() {
    if (!lastId) return;
    try { await post(`/inbox/threads/${id}/read`, { up_to: lastId }); window.dispatchEvent(new Event('inbox:changed')); onChange(); } catch (_) { /* next time */ }
  }
  async function reloadAll() {
    const out = await get(`/inbox/threads/${id}/messages?limit=50`);
    clear(list).append(...out.data.map(msgEl));
    firstId = out.data.length ? out.data[0].id : null; lastId = out.data.length ? out.data[out.data.length - 1].id : 0;
    moreBefore = out.more_before; olderBtn.hidden = !moreBefore;
    scroller.scrollTop = scroller.scrollHeight;
    if (!out.data.length) list.append(h('li', { class: 'msg system' }, h('span', null, 'No messages yet. Say hello.')));
    await markRead();
  }
  async function loadOlder() {
    if (!firstId) return;
    const before = scroller.scrollHeight;
    const out = await get(`/inbox/threads/${id}/messages?before=${firstId}&limit=50`);
    list.prepend(...out.data.map(msgEl));
    if (out.data.length) firstId = out.data[0].id;
    moreBefore = out.more_before; olderBtn.hidden = !moreBefore;
    scroller.scrollTop = scroller.scrollHeight - before;
  }
  async function loadNew() {
    const out = await get(`/inbox/threads/${id}/messages?after=${lastId}&limit=100`);
    if (!out.data.length) return;
    const stick = nearBottom();
    const placeholder = list.querySelector('.msg.system:not([data-id])');
    if (placeholder) placeholder.remove();
    list.append(...out.data.map(msgEl));
    lastId = out.data[out.data.length - 1].id;
    if (stick || out.data.some((m) => m.by && m.by.you)) scroller.scrollTop = scroller.scrollHeight;
    await markRead();
  }

  async function addPeople() {
    const { data: people } = await get('/inbox/people');
    const inIt = new Set(info.members.map((m) => m.id));
    const choices = people.filter((p) => !inIt.has(p.id));
    if (!choices.length) { toast('Everyone is already in this conversation'); return; }
    const picked = new Set();
    formDialog('Add people', h('div', { class: 'pick-list' }, choices.map((p) => {
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => (cb.checked ? picked.add(p.id) : picked.delete(p.id)));
      return h('label', { class: 'check pick' }, cb, h('span', null, h('b', null, p.name), h('small', null, p.role)));
    })), async () => {
      if (!picked.size) throw new Error('Choose someone to add');
      await post(`/inbox/threads/${id}/members`, { user_ids: [...picked] });
      await openThread(box, id, onChange); onChange();
    }, { submitText: 'Add' });
  }
  function rename() {
    const name = input({ name: 'name', maxlength: 80, value: info.name || '', placeholder: 'For example Lift ops' });
    formDialog('Rename conversation', field('Name', name, 'Leave it empty to show the names of the people in it.'), async () => {
      await patch(`/inbox/threads/${id}`, { name: name.value.trim() || null });
      await openThread(box, id, onChange); onChange();
    });
  }

  await reloadAll();
  text.focus({ preventScroll: true });
  const timer = setInterval(() => { if (!box.isConnected || !box.contains(form)) { clearInterval(timer); return; } if (!document.hidden) loadNew().catch(() => {}); }, POLL_MS);
  timer.unref?.();
}

/** New message: pick one person (a one-to-one conversation) or several (a group, with an optional name). */
async function newConversation() {
  const { data: people } = await get('/inbox/people');
  if (!people.length) { toast('Nobody else signs in at this mountain yet. Add staff logins under Account.'); return; }
  const picked = new Set();
  const q = input({ type: 'search', placeholder: 'Find a person', 'aria-label': 'Find a person' });
  const list = h('div', { class: 'pick-list' });
  const name = input({ name: 'name', maxlength: 80, placeholder: 'For example Lift ops' });
  const nameField = field('Group name (optional)', name);
  nameField.hidden = true;
  const msg = h('textarea', { rows: 3, maxlength: 4000, placeholder: 'First message (optional)', 'aria-label': 'First message' });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    clear(list).append(...people.filter((p) => !term || p.name.toLowerCase().includes(term)).map((p) => {
      const cb = h('input', { type: 'checkbox', checked: picked.has(p.id) });
      cb.addEventListener('change', () => { if (cb.checked) picked.add(p.id); else picked.delete(p.id); nameField.hidden = picked.size < 2; });
      return h('label', { class: 'check pick' }, cb, h('span', null, h('b', null, p.name), h('small', null, p.role)));
    }));
  };
  q.addEventListener('input', draw);
  draw();
  formDialog('New message', h('div', { class: 'stack' }, q, list, nameField, msg), async () => {
    if (!picked.size) throw new Error('Choose who to message');
    const { refs, text } = linksIn(msg.value);
    if (refs.length > 5) throw new Error('A message can carry up to 5 links');
    const out = await post('/inbox/threads', { user_ids: [...picked], name: picked.size > 1 && name.value.trim() ? name.value.trim() : undefined, body: text, refs: refs.slice(0, 5) });
    window.dispatchEvent(new Event('inbox:changed'));
    location.hash = `#/inbox/${out.id}`;
  }, { submitText: 'Start', wide: true });
}

