// Settings, You: your username and password, passkeys, the authenticator app, your PIN for shared computers, where
// you are signed in and the devices you have used, and light or dark on this device.
import { get, post, session } from '../api.js';
import { h, clear, ctx, input, field, button, toast, formDialog, errorBox, select } from '../ui.js';
import { mfaPanel } from './mfa.js';
import { passkeysPanel, pinPanel, sessionsPanel } from './security.js';
import { card, row } from './settings-kit.js';

export async function renderSettingsPage(root) {
  root.append(accountCard(), passwordCard());
  const sign = h('div', { class: 'stack set-panels' });
  root.append(sign, themeCard());
  const draw = async () => {
    let sec;
    try { sec = await get('/auth/security'); } catch (err) { clear(sign).append(errorBox(err)); return; }
    clear(sign);
    if (sec.signed_in_with === 'pin') {
      sign.append(h('div', { class: 'callout' }, 'You switched in with your PIN on a shared computer. To change your password, PIN or passkeys, sign in with your password on your own device.'), sessionsPanel(sec, draw));
      return;
    }
    sign.append(passkeysPanel(() => draw()), mfaPanel());
    if (sec.can_have_pin) sign.append(pinPanel(sec));
    sign.append(sessionsPanel(sec, draw));
  };
  await draw();
}

/** Who you are signed in as, and your username. */
function accountCard() {
  const name = h('b', null, ctx.me.username || '');
  const change = ctx.me.username ? button('Change', () => formDialog('Change your username', h('div', { class: 'form' },
    field('Username', input({ name: 'username', value: ctx.me.username, required: true, maxlength: 40, autocapitalize: 'none', spellcheck: 'false' }), 'What you type to sign in. Letters, numbers, dots and dashes.')), async (fd) => {
    const r = await post('/auth/username', { username: String(fd.get('username') || '') });
    ctx.me.username = r.username;
    name.textContent = r.username;
    toast(`You now sign in as ${r.username}`);
  }), { small: true, label: 'Change your username' }) : null;
  const how = ctx.me.username && ctx.me.email ? `You can sign in with your username or ${ctx.me.email}.` : `You sign in as ${ctx.me.username || ctx.me.email}.`;
  return card('You', [
    row('Username', h('span', { class: 'row' }, name, change), how),
    ctx.me.email ? row('Email', h('span', null, ctx.me.email), 'Sign-in notices and emailed codes go here. A manager can change it under Team and logins.') : null,
  ]);
}

/** Change your password: the current one, then the new one twice. Every other device is signed out. */
function passwordCard() {
  const cur = input({ type: 'password', name: 'current', autocomplete: 'current-password', required: true });
  const next = input({ type: 'password', name: 'next', autocomplete: 'new-password', required: true, minlength: 12 });
  const again = input({ type: 'password', name: 'again', autocomplete: 'new-password', required: true });
  const slot = h('div');
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Change password');
  const form = h('form', { class: 'stack set-form', novalidate: true },
    h('div', { class: 'form' }, field('Current password', cur), field('New password', next, 'At least 12 characters. A short phrase of a few words is easiest to remember. Not your name or the mountain\'s.'), field('Repeat new password', again)),
    slot, h('div', { class: 'row' }, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(slot);
    if (next.value !== again.value) { slot.append(errorBox(new Error('The new passwords do not match'))); return; }
    go.disabled = true;
    try {
      const out = await post('/auth/change-password', { current_password: cur.value, new_password: next.value });
      session.token = out.token; // this device stays signed in; every other session ends
      cur.value = next.value = again.value = '';
      toast('Password changed. Other devices were signed out');
    } catch (err) {
      slot.append(errorBox(err));
    } finally {
      go.disabled = false;
    }
  });
  return card('Password', [form]);
}

// ---------------------------------------------------------------- light or dark
const THEME_KEY = 'verdynt.theme';
const readTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'device'; } catch (_) { return 'device'; } };
const deviceTheme = () => (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

/** Light, dark, or whatever this phone or computer is set to. Kept on this device only, and used straight away. */
function themeCard() {
  const pick = select([['device', 'Match this device'], ['light', 'Light'], ['dark', 'Dark']], readTheme(), { name: 'theme' });
  pick.addEventListener('change', () => {
    const v = pick.value;
    try { if (v === 'device') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, v); } catch (_) { /* this device only, best effort */ }
    document.documentElement.setAttribute('data-theme', v === 'device' ? deviceTheme() : v);
    window.dispatchEvent(new Event('theme:changed'));
    toast(v === 'device' ? 'Light or dark now follows this device' : `${v === 'light' ? 'Light' : 'Dark'} on this device`);
  });
  return card('Light or dark', [row('Colors', pick, 'For this phone or computer only. You can also switch next to your name in the menu.')]);
}
