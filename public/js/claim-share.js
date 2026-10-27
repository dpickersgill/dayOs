// What a secure link opens (/c/<token>), with no sign-in: a released claim file for an insurer, or the season risk
// report for a broker. A claim file link usually asks for the 6-digit passcode the mountain sent separately. Every
// opening is logged by the mountain. The passcode stays in this tab only, so reloading does not ask again.
import { h, clear } from './ui.js';
import { claimDoc, riskDoc, when } from './views/claim-render.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('page');
const api = `/api/v1/public/claim-share/${encodeURIComponent(token)}`;
const KEY = `claim-share:${token.slice(0, 12)}`;
const saved = () => { try { return sessionStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
const keep = (code) => { try { sessionStorage.setItem(KEY, code); } catch (_) { /* private mode: asks again on reload */ } };

function message(title, text) {
  clear(root).append(h('div', { class: 'cs-msg' }, h('h1', null, title), h('p', { class: 'muted' }, text)));
}

function askCode(problem, kind) {
  const code = h('input', { id: 'cs-code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: 6, required: '', placeholder: '6 digits', 'aria-describedby': 'cs-hint' });
  const err = h('p', { class: 'help-msg', role: 'alert' }, problem || '');
  const form = h('form', { class: 'cs-gate help-done stack', onsubmit: (e) => { e.preventDefault(); const v = code.value.replace(/\D/g, ''); if (v.length !== 6) { err.textContent = 'The passcode is 6 digits.'; return; } load(v); } },
    h('h1', null, kind === 'risk' ? 'Season risk report' : 'Claim file'),
    h('p', null, 'This link is protected. Enter the 6-digit passcode the mountain sent you separately (by phone or text).'),
    h('div', { class: 'field' }, h('label', { for: 'cs-code' }, 'Passcode'), code, h('span', { class: 'hint', id: 'cs-hint' }, 'Opening this is logged by the mountain.')),
    err, h('button', { type: 'submit', class: 'btn primary' }, 'Open'));
  clear(root).append(form);
  code.focus();
}

async function load(code) {
  const headers = code ? { 'x-share-code': code } : {};
  let res; let body;
  try { res = await fetch(api, { headers }); body = await res.json(); } catch (_) { message('Could not open this link', 'Check your connection and try again.'); return; }
  if (res.status === 401 && body.needs_code) { askCode(code ? body.error : '', body.kind); return; }
  if (!res.ok) { message(res.status === 404 ? 'This link is not valid' : 'This link is closed', body.error || 'Ask the mountain for a new link.'); return; }
  if (code) keep(code);
  document.title = body.kind === 'risk' ? `${body.resort.name}: season risk report ${body.season}` : `${body.resort.name}: claim file ${body.case_number}`;
  root.classList.add('cs-wide');
  const header = h('div', { class: 'cs-banner no-print' },
    h('span', null, `Shared with ${body.shared_with}. Open until ${when(body.expires_at)}. Every opening is logged by the mountain.`),
    h('button', { type: 'button', class: 'btn small', onclick: () => window.print() }, 'Print or save as PDF'));
  const photoSrc = (p, img) => { img.src = `${api}/photos/${p.id}?k=${encodeURIComponent(body.view_key)}`; img.addEventListener('error', () => img.replaceWith(h('div', { class: 'cf-nophoto' }, 'No preview')), { once: true }); };
  clear(root).append(body.kind === 'risk' ? riskDoc(body, { header }) : claimDoc(body, { photoSrc, header }));
}

if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) message('This link is not valid', 'Check that the whole address was copied, or ask the mountain for a new link.');
else load(saved());
