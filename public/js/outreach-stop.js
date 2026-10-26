// "Not interested" from a Verdynt/OS outreach email (/o/<token>): one button, and that address is never emailed again.
import { h, clear } from './ui.js';

const token = location.pathname.split('/').filter(Boolean)[1] || '';
const root = document.getElementById('stop');
const api = `/api/v1/public/outreach-stop/${encodeURIComponent(token)}`;
const done = () => clear(root).append(h('div', { class: 'help-done' }, h('h1', null, 'Done'), h('p', null, 'You won\'t get any more emails from Verdynt/OS. Thank you for letting us know.')));

(async () => {
  let r;
  try { const res = await fetch(api); if (!res.ok) throw new Error(); r = await res.json(); } catch (_) {
    clear(root).append(h('h1', null, 'This link is not valid'), h('p', null, 'If you want us to stop emailing you, reply to the email and say so, and we will.'));
    return;
  }
  if (r.stopped) { done(); return; }
  const go = h('button', { type: 'button', class: 'btn primary big' }, 'Stop emails from Verdynt/OS');
  const msg = h('div', { role: 'status' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try { const res = await fetch(api, { method: 'POST' }); if (!res.ok) throw new Error(); done(); } catch (_) { go.disabled = false; msg.append(h('p', { class: 'error-box' }, 'That did not work. Reply to the email and say so, and we will stop.')); }
  });
  clear(root).append(h('h1', null, 'Not interested?'), h('p', null, 'Press the button and we will not email you again, about anything.'), go, msg);
})();
