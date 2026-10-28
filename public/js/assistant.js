// The Ask panel: a side panel any screen can open. It answers how-to questions from Help, questions about the
// mountain's own setup and, with Assistant Plus, about today's numbers. Answers link to the Help article and the screen;
// one it could not answer offers "Ask support", which emails Verdynt/OS support with the question and the screen.
import { h, ctx, toast } from './ui.js';
import { get, post, describeError } from './api.js';
import { icon } from './icons.js';

// Questions to start from, by screen. Plain ones work for everyone; the Plus ones need look-ups.
const STARTERS = {
  dashboard: ['What changed in the last update?', 'How do I find a page fast?'],
  sell: ['How do I take a card on the reader?', 'How do I refund part of an order?', 'How do I sell a season pass?'],
  gate: ['What does a passback warning mean?', 'How do I load a pass on an RFID card?'],
  school: ['How do I book a private lesson?', 'How do online lesson requests work?'],
  programs: ['How do I cancel one day for weather?', 'How do sibling discounts work?', 'What happens if a family buys a season pass later?'],
  patrol: ['How do I start a new case?', 'What does the report check look for?'],
  money: ['How do I close the cash drawer?', 'How do I export for the accountant?'],
  workforce: ['How do I fix a missed clock-out?', 'How do I approve hours?'],
  settings: ['How do I turn on the guest assistant?', 'How do I add a user?'],
};
const PLUS = { dashboard: ['How many scans so far today?', 'Who is working today?'], sell: ['What did we sell yesterday?'], school: ['What lessons are on tomorrow?'], programs: ['How full is each program day?'] };

let panel = null; let state = null;
const chat = []; // this visit's questions and answers, sent back so follow-ups make sense

/** Text with simple paragraphs, numbered steps and bullets, built as elements (never as HTML). */
function prose(text) {
  const out = []; let list = null;
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:(\d+)[.)]|[-*•])\s+(.*)$/.exec(line);
    if (m) {
      const tag = m[1] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag); out.push(list); }
      list.append(h('li', null, m[2].replace(/\*\*/g, '')));
    } else if (line.trim()) { list = null; out.push(h('p', null, line.replace(/\*\*/g, ''))); } else list = null;
  }
  return out;
}

function answerEl(q, r) {
  const box = h('div', { class: 'ask-a' });
  const links = r.links.length ? h('div', { class: 'ask-links' }, r.links.map((l) => {
    const a = h('a', { href: l.href, class: 'btn small' }, l.kind === 'help' ? icon('help', 16) : null, l.label || (l.kind === 'help' ? 'Help article' : `Open ${l.href.replace('#/', '')}`));
    return a;
  })) : null;
  const up = h('button', { type: 'button', class: 'ask-rate', 'aria-label': 'This helped', 'aria-pressed': 'false' }, 'Helped');
  const down = h('button', { type: 'button', class: 'ask-rate', 'aria-label': 'This did not help', 'aria-pressed': 'false' }, 'Did not help');
  const rate = (good) => {
    post(`/assistant/${r.id}/rate`, { helpful: good }).catch(() => {});
    up.setAttribute('aria-pressed', String(good)); down.setAttribute('aria-pressed', String(!good));
    if (!good && !box.querySelector('.ask-support')) foot.append(supportBtn());
  };
  up.addEventListener('click', () => rate(true));
  down.addEventListener('click', () => rate(false));
  const supportBtn = () => {
    const b = h('button', { type: 'button', class: 'btn small ask-support' }, 'Ask support');
    b.addEventListener('click', () => supportForm(b));
    return b;
  };
  function supportForm(b) {
    const note = h('textarea', { rows: 3, maxlength: 2000, placeholder: 'Anything to add? (optional)', 'aria-label': 'Anything to add' });
    const send = h('button', { type: 'button', class: 'btn small primary' }, 'Send to support');
    const form = h('div', { class: 'ask-escalate' }, h('p', null, `Your question, this answer and the screen you are on go to ${state.support_email}. They reply to your email.`), note, send);
    b.replaceWith(form);
    note.focus();
    send.addEventListener('click', async () => {
      send.disabled = true;
      try {
        const res = await post(`/assistant/${r.id}/escalate`, { note: note.value.trim() || undefined });
        form.replaceWith(h('p', { class: 'ask-sent', role: 'status' }, res.reply_to ? `Sent. Support will reply to ${res.reply_to}.` : 'Sent. Support will reply through your manager, as you have no email on file.'));
      } catch (err) { send.disabled = false; toast(describeError(err), 'error'); }
    });
  }
  const foot = h('div', { class: 'ask-foot' }, up, down, r.unsure ? supportBtn() : null);
  box.append(h('p', { class: 'ask-q' }, q), h('div', { class: 'ask-text' }, prose(r.answer)), links || '',
    r.looked_up && r.looked_up.length ? h('p', { class: 'ask-meta' }, `Looked up: ${r.looked_up.map((t) => t.replace(/_/g, ' ')).join(', ')}`) : '', foot);
  return box;
}

function starters(page) {
  const list = [...(STARTERS[page] || STARTERS.dashboard), ...(state.plus ? PLUS[page] || [] : [])].slice(0, 4);
  return h('div', { class: 'ask-starters' }, list.map((q) => { const b = h('button', { type: 'button', class: 'ask-chip' }, q); b.addEventListener('click', () => send(q)); return b; }));
}

let send = () => {};
let current = { page: null, views: [] };

/** Opens (or focuses) the panel. views: the screens this person can open, so answers only link those. */
export async function openAssistant({ page, views = ctx.views || [], question } = {}) {
  current = { page, views };
  if (panel && panel.isConnected) { if (question) send(question); else panel.querySelector('textarea').focus(); return; }
  if (!state) { try { state = await get('/assistant'); } catch (err) { toast(describeError(err), 'error'); return; } }
  if (!state.on) { toast('The assistant is not turned on for your mountain. Help still has every article.', 'error'); return; }
  const log = h('div', { class: 'ask-log', 'aria-live': 'polite' });
  const box = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Ask how to do something…', 'aria-label': 'Your question' });
  const go = h('button', { type: 'button', class: 'btn primary small' }, 'Ask');
  const close = h('button', { type: 'button', class: 'btn small', 'aria-label': 'Close the assistant' }, 'Close');
  panel = h('aside', { class: 'ask-panel', role: 'complementary', 'aria-label': 'Assistant' },
    h('header', null, h('h2', null, 'Ask'), close),
    h('p', { class: 'ask-intro' }, state.plus ? `Answers come from Help, ${ctx.me.tenant_name}'s setup and today's numbers. It can explain and link a screen, but never changes anything.` : `Answers come from Help and ${ctx.me.tenant_name}'s setup. It can explain and link a screen, but never changes anything.`),
    log, h('div', { class: 'ask-box' }, box, go));
  if (!chat.length) log.append(starters(page));
  else for (const c of chat) log.append(answerEl(c.q, c.r));
  send = async (q) => {
    q = String(q || box.value).trim();
    if (q.length < 2) return;
    box.value = ''; go.disabled = true;
    const st = log.querySelector('.ask-starters'); if (st) st.remove();
    const wait = h('div', { class: 'ask-a' }, h('p', { class: 'ask-q' }, q), h('p', { class: 'loading', role: 'status' }, 'Thinking…'));
    log.append(wait); wait.scrollIntoView({ block: 'end' });
    try {
      const r = await post('/assistant/ask', { question: q, page: current.page || undefined, views: current.views, history: chat.slice(-3).map((c) => ({ q: c.q, a: c.r.answer })) });
      chat.push({ q, r });
      wait.replaceWith(answerEl(q, r));
    } catch (err) { wait.replaceWith(h('div', { class: 'ask-a' }, h('p', { class: 'ask-q' }, q), h('p', { class: 'error-box', role: 'alert' }, describeError(err)))); }
    go.disabled = false; box.focus();
    log.lastElementChild.scrollIntoView({ block: 'end' });
  };
  go.addEventListener('click', () => send());
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  const shut = () => { panel.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('asking'); };
  const onKey = (e) => { if (e.key === 'Escape' && panel.contains(document.activeElement)) shut(); };
  close.addEventListener('click', shut);
  document.addEventListener('keydown', onKey);
  // A link in an answer opens that screen and leaves the panel open beside it (on a phone, the panel closes).
  panel.addEventListener('click', (e) => { if (e.target.closest('a') && window.matchMedia('(max-width: 900px)').matches) shut(); });
  document.body.append(panel);
  document.body.classList.add('asking');
  box.focus();
  if (question) send(question);
}

/** Whether to show the Ask buttons at all. */
export async function assistantOn() {
  try { state = await get('/assistant'); return Boolean(state.on); } catch (_) { return false; }
}
export const resetChat = () => { chat.length = 0; };
/** On sign-out: the panel, this visit's conversation and what was looked up go, so none of it reaches the next person. */
export function resetAssistant() {
  resetChat();
  if (panel) panel.remove();
  panel = null; state = null; send = () => {}; current = { page: null, views: [] };
  document.body.classList.remove('asking');
}
