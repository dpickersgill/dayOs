// Show or hide a password: a button with an eye inside every password box in the app and the platform console (sign in,
// change password, reset, a new login, the console), so a person can check what they typed. Not on PIN boxes (numbers
// only), which stay hidden. The box goes back to hidden when its form is sent.

import { h, svg } from './ui.js';

const EYE = 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
const EYE_OFF = 'M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2';

const isPin = (el) => el.inputMode === 'numeric' || el.getAttribute('inputmode') === 'numeric' || el.dataset.noReveal !== undefined;
let n = 0;

function eye(off) {
  return svg('svg', { class: 'ico', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: off ? EYE_OFF : EYE }));
}

/** Adds the show/hide button to one password box (once). */
export function addReveal(input) {
  if (!input || input.dataset.reveal || isPin(input) || !input.parentNode) return;
  input.dataset.reveal = '1';
  if (!input.id) { n += 1; input.id = `pw-${n}-${Math.random().toString(36).slice(2, 7)}`; }
  const say = h('span', { class: 'sr' }, 'Show password');
  const btn = h('button', { type: 'button', class: 'pw-reveal', 'aria-pressed': 'false', 'aria-controls': input.id, title: 'Show password' }, eye(false), say);
  const wrap = h('span', { class: 'pw-wrap' });
  input.replaceWith(wrap);
  wrap.append(input, btn);
  const set = (show) => {
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    say.textContent = show ? 'Hide password' : 'Show password';
    btn.title = say.textContent;
    btn.replaceChild(eye(show), btn.firstChild);
  };
  btn.addEventListener('click', (e) => { e.preventDefault(); set(input.type === 'password'); input.focus(); });
  const form = input.form;
  if (form) form.addEventListener('submit', () => set(false), true);
}

function scan(root) {
  if (!root || !root.querySelectorAll) return;
  if (root.matches && root.matches('input[type=password]')) addReveal(root);
  for (const el of root.querySelectorAll('input[type=password]')) addReveal(el);
}

/** Watches the page: every password box that appears gets the button. */
export function watchPasswords(root = document.body) {
  scan(root);
  new MutationObserver((list) => { for (const m of list) for (const node of m.addedNodes) if (node.nodeType === 1) scan(node); })
    .observe(root, { childList: true, subtree: true });
}
