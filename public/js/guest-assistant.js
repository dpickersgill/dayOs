// The guest assistant: a "Questions?" button on the mountain's public pages (the online shop, program registration,
// lesson booking and the family page), shown only where the mountain turned it on (Assistant Plus). It answers from the
// mountain's public facts, and on the family page from that family's own places. What it cannot answer, the guest can
// send to the mountain with their email, and the mountain replies to them directly.
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const base = `/api/v1/public/${encodeURIComponent(slug)}/assistant`;

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

async function call(method, path, body, headers) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || json.message || 'That did not work. Please call the mountain.');
  return json;
}

/** Adds the button if the mountain has the assistant on for this page. session() returns the family page's session. */
export async function mountGuestAssistant(page, { session } = {}) {
  if (!slug) return;
  let on = false;
  try { on = (await call('GET', `?page=${page}`)).on; } catch (_) { on = false; }
  if (!on) return;
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('../css/guest-assistant.css', import.meta.url).href }));
  const chat = [];
  const log = el('div', { class: 'ga-log', 'aria-live': 'polite' });
  const box = el('textarea', { rows: '2', maxlength: '600', placeholder: 'Ask about hours, prices, programs…', 'aria-label': 'Your question' });
  const sendBtn = el('button', { type: 'button', class: 'ga-send' }, 'Ask');
  const closeBtn = el('button', { type: 'button', class: 'ga-close', 'aria-label': 'Close' }, '×');
  const panel = el('div', { class: 'ga-panel', role: 'dialog', 'aria-label': 'Questions', hidden: true },
    el('div', { class: 'ga-head' }, el('strong', null, 'Questions?'), closeBtn),
    el('p', { class: 'ga-note' }, 'Answers come from the mountain\'s own information. For anything else, send them a message.'),
    log, el('div', { class: 'ga-box' }, box, sendBtn));
  const open = el('button', { type: 'button', class: 'ga-open', 'aria-expanded': 'false' }, 'Questions?');
  const show = (yes) => { panel.hidden = !yes; open.hidden = yes; open.setAttribute('aria-expanded', String(yes)); if (yes) box.focus(); else open.focus(); };
  open.addEventListener('click', () => show(true));
  closeBtn.addEventListener('click', () => show(false));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(false); });

  function contactForm(answerId, question) {
    const email = el('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'Your email', 'aria-label': 'Your email' });
    const name = el('input', { type: 'text', autocomplete: 'name', placeholder: 'Your name (optional)', 'aria-label': 'Your name' });
    const msg = el('textarea', { rows: '3', maxlength: '2000', 'aria-label': 'Your message' }); msg.value = question || '';
    const trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'ga-trap', 'aria-hidden': 'true' });
    const go = el('button', { type: 'submit', class: 'ga-send' }, 'Send to the mountain');
    const err = el('p', { class: 'ga-err', role: 'alert' });
    const form = el('form', { class: 'ga-contact' }, el('p', null, 'The mountain replies to your email.'), email, name, msg, trap, err, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!email.value.trim() || !msg.value.trim()) { err.textContent = 'Add your email and your question.'; return; }
      go.disabled = true;
      try {
        await call('POST', '/contact', { page, email: email.value.trim(), name: name.value.trim() || undefined, message: msg.value.trim(), answer_id: answerId || undefined, website: trap.value || undefined });
        form.replaceWith(el('p', { class: 'ga-sent', role: 'status' }, 'Sent. The mountain will reply to your email.'));
      } catch (x) { err.textContent = x.message; go.disabled = false; }
    });
    return form;
  }

  async function ask() {
    const q = box.value.trim();
    if (q.length < 2) return;
    box.value = ''; sendBtn.disabled = true;
    const item = el('div', { class: 'ga-item' }, el('p', { class: 'ga-q' }, q), el('p', { class: 'ga-wait', role: 'status' }, 'Thinking…'));
    log.append(item); item.scrollIntoView({ block: 'end' });
    try {
      const s = session ? session() : null;
      const r = await call('POST', '/ask', { question: q, page, history: chat.slice(-3) }, s ? { 'x-family-session': s } : {});
      chat.push({ q, a: r.answer });
      const contact = el('button', { type: 'button', class: 'ga-link' }, 'Ask the mountain instead');
      contact.addEventListener('click', () => contact.replaceWith(contactForm(r.id, q)));
      item.lastChild.replaceWith(el('div', { class: 'ga-a' }, String(r.answer).split('\n').filter((l) => l.trim()).map((l) => el('p', null, l.replace(/\*\*/g, '')))),
        r.unsure ? contactForm(r.id, q) : contact, r.unsure && r.phone ? el('p', { class: 'ga-note' }, `Or call ${r.phone}.`) : null);
    } catch (x) {
      item.lastChild.replaceWith(el('p', { class: 'ga-err' }, x.message), contactForm(null, q));
    }
    sendBtn.disabled = false; box.focus();
  }
  sendBtn.addEventListener('click', ask);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
  document.body.append(open, panel);
}
