// Two-step sign-in: an authenticator app makes a six-digit code that changes every 30 seconds. Ten recovery codes
// (shown once) get someone in if the phone is lost. The owner can require it for the whole mountain.

import { get, post } from '../api.js';
import { h, clear, ctx, input, field, button, toast, formDialog, errorBox, state } from '../ui.js';
import { qr } from '../barcode.js';

const groupSecret = (s) => String(s).replace(/(.{4})/g, '$1 ').trim();

/** The section of the Account screen (and the forced setup screen). onChange runs when two-step is turned on or off. */
export function mfaPanel(onChange) {
  const box = h('section', { class: 'panel stack', 'data-panel': 'mfa' });
  async function draw() {
    clear(box);
    let me;
    try { me = await get('/auth/me'); } catch (err) { box.append(errorBox(err)); return; }
    ctx.me = { ...ctx.me, ...me };
    box.append(h('h2', null, 'Authenticator app'));
    if (me.app_enabled) {
      box.append(h('p', null, state('On', 'good'), me.passkeys ? ' You can sign in with a passkey, or with your password and a code from the app.' : ' You enter a code from your authenticator app each time you sign in.'),
        h('div', { class: 'row' },
          button('New recovery codes', () => newCodes(), { small: true }),
          me.mfa_required && !me.passkeys ? h('span', { class: 'muted small' }, 'You must have two-step sign-in, so it can only be turned off once you have a passkey.') : button('Turn off', () => turnOff(), { small: true, kind: 'danger' })));
      return;
    }
    box.append(h('p', null, me.passkeys
      ? 'Optional, as a backup to your passkey: a six-digit code from an app on your phone.'
      : 'A six-digit code from an app on your phone, as a second step after your password. It protects guest and patient information even if a password is guessed or leaked.'),
    h('div', { class: 'row' }, button('Set up an authenticator app', () => setup(), { kind: me.passkeys ? undefined : 'primary', small: Boolean(me.passkeys) })));
  }

  async function setup() {
    const out = await post('/auth/mfa/setup');
    const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, 'aria-label': 'Six-digit code' });
    formDialog('Set up two-step sign-in', h('div', { class: 'stack' },
      h('ol', { class: 'plain steps' },
        h('li', null, 'Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Authy or similar).'),
        h('li', null, 'In the app, add an account by scanning this picture, or type the key below.'),
        h('li', null, 'Type the six-digit code the app shows, then press Turn on.')),
      h('div', { class: 'qr-box' }, qr(out.otpauth_uri, { size: 180 }), h('div', { class: 'stack tight' }, h('small', { class: 'muted' }, 'Key to type instead'), h('div', { class: 'secret', 'data-secret': '' }, groupSecret(out.secret)))),
      h('div', { class: 'form' }, field('Code from the app', code))),
    async () => {
      const done = await post('/auth/mfa/enable', { code: code.value.trim() });
      toast('Two-step sign-in is on');
      showCodes(done.recovery_codes, async () => { await draw(); if (onChange) await onChange(); });
    }, { submitText: 'Turn on' });
  }

  function showCodes(codes, after) {
    const list = h('div', { class: 'recovery-codes', 'data-recovery': '' }, codes.map((c) => h('span', null, c)));
    const ok = h('input', { type: 'checkbox', name: 'saved' });
    const dlgForm = formDialog('Save your recovery codes', h('div', { class: 'stack' },
      h('p', null, 'If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe, such as a password manager or a printed copy locked away. They will not be shown again.'),
      list,
      h('div', { class: 'row' }, button('Copy', async () => { try { await navigator.clipboard.writeText(codes.join('\n')); toast('Copied'); } catch (_) { toast('Copy did not work: write them down instead', 'error'); } }, { small: true })),
      h('label', { class: 'check' }, ok, ' I have saved these codes')),
    async () => {
      if (!ok.checked) throw new Error('Tick the box to confirm you saved the codes');
      await after();
    }, { submitText: 'Done' });
    return dlgForm;
  }

  function newCodes() {
    const pw = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    formDialog('New recovery codes', h('div', { class: 'stack' }, h('p', null, 'This makes a fresh set of ten codes. The old ones stop working.'), h('div', { class: 'form' }, field('Your password', pw))),
      async () => { const out = await post('/auth/mfa/recovery-codes', { password: pw.value }); showCodes(out.recovery_codes, async () => {}); },
      { submitText: 'Make new codes' });
  }

  function turnOff() {
    const pw = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 12, required: true });
    formDialog('Turn off two-step sign-in', h('div', { class: 'stack' }, h('div', { class: 'form' }, field('Your password', pw), field('Code from the app (or a recovery code)', code))),
      async () => { await post('/auth/mfa/disable', { password: pw.value, code: code.value.trim() }); toast('Two-step sign-in is off'); await draw(); if (onChange) await onChange(); },
      { submitText: 'Turn off' });
  }

  draw();
  return box;
}
