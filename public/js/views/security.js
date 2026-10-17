// Account: how you sign in. Passkeys (the strongest way in), your PIN for shared terminals, where you are signed in and
// the devices you have used; for managers, this mountain's shared terminals; for the owner, the patrol two-step rule.

import { get, post, put, patch, del } from '../api.js';
import { h, clear, ctx, isManager, table, state, input, field, button, toast, formDialog, confirmDialog, errorBox, empty } from '../ui.js';
import * as passkey from '../passkey.js';
import { readTerminal, saveTerminal } from '../terminal.js';

const when = (v) => (v ? new Date(`${String(v).replace(' ', 'T')}Z`).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never');
const METHOD = { password: 'Password', mfa: 'Password and code', passkey: 'Passkey', email: 'Password and emailed code', pin: 'PIN' };

/** Add a passkey on this device. Resolves with its id. */
export async function addPasskey(name) {
  const { handle, options } = await post('/auth/passkeys/options');
  const response = await passkey.create(options);
  return post('/auth/passkeys', { handle, response, name: name || undefined });
}

/** Your passkeys. onChange runs after one is added or removed (the forced setup screen uses it to carry on). */
export function passkeysPanel(onChange) {
  const box = h('section', { class: 'panel stack', 'data-panel': 'passkeys' });
  async function draw() {
    let sec;
    try { sec = await get('/auth/security'); } catch (err) { clear(box).append(errorBox(err)); return; }
    clear(box).append(h('h2', null, 'Passkeys'),
      h('p', null, 'A passkey signs you in with your fingerprint, face or the PIN of your phone or computer. Nobody can phish it or guess it, and there is no code to type. It also works as your second step.'),
      sec.passkeys.length ? table([
        { head: 'Name', cell: (k) => h('strong', null, k.name) },
        { head: 'Added', cell: (k) => when(k.created_at) },
        { head: 'Last used', cell: (k) => when(k.last_used_at) },
        { head: '', actions: true, cell: (k) => [
          button('Rename', () => formDialog('Rename passkey', h('div', { class: 'form' }, field('Name', input({ name: 'name', value: k.name, maxlength: 60, required: true }), 'For example: My iPhone, Office PC')), async (fd) => { await patch(`/auth/passkeys/${k.id}`, { name: String(fd.get('name') || '').trim() }); await draw(); }), { small: true }),
          button('Remove', () => confirmDialog('Remove this passkey?', `"${k.name}" will no longer sign you in. Remove it if that device is lost or no longer yours.`, 'Remove', async () => { await del(`/auth/passkeys/${k.id}`); toast('Passkey removed'); await draw(); if (onChange) await onChange(); }, { danger: true }), { small: true, kind: 'danger' }),
        ] },
      ], sec.passkeys) : h('p', { class: 'muted' }, 'No passkeys yet.'),
      passkey.supported()
        ? h('div', { class: 'row' }, button(sec.passkeys.length ? 'Add a passkey on this device' : 'Add a passkey', () => {
          const name = input({ name: 'name', maxlength: 60, placeholder: 'For example: My iPhone' });
          formDialog('Add a passkey', h('div', { class: 'stack' }, h('p', null, 'Your phone or computer will ask for your fingerprint, face or its own PIN. The passkey stays on the device; SummitOps keeps only a public key.'), h('div', { class: 'form' }, field('Name for this passkey', name, 'So you can tell your devices apart'))),
            async () => { await addPasskey(name.value.trim()); toast('Passkey added. Next time, press "Sign in with a passkey"'); await draw(); if (onChange) await onChange(); }, { submitText: 'Continue' });
        }, { kind: sec.passkeys.length ? undefined : 'primary' }))
        : h('p', { class: 'muted small' }, 'This browser cannot make passkeys. Use a recent Chrome, Safari, Edge or Firefox, or use an authenticator app below.'));
  }
  draw();
  return box;
}

/** Your PIN for shared terminals (counter, instructor and lift staff only). */
function pinPanel(sec) {
  const box = h('section', { class: 'panel stack', 'data-panel': 'pin' });
  const set = () => {
    const pw = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const pin = input({ name: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, required: true });
    const again = input({ name: 'again', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, required: true });
    formDialog(sec.pin_set ? 'Change your PIN' : 'Set your PIN', h('div', { class: 'form' }, field('Your password', pw), field('New PIN', pin, '6 to 8 digits. Not a run (123456), a repeat (111111) or a year.'), field('New PIN again', again)), async () => {
      if (pin.value !== again.value) throw new Error('The two PINs are not the same');
      await put('/auth/pin', { password: pw.value, pin: pin.value.trim() });
      toast('PIN saved. Use it on the shared terminals'); sec.pin_set = true; draw();
    }, { submitText: 'Save PIN' });
  };
  function draw() {
    clear(box).append(h('h2', null, 'PIN for shared terminals'),
      h('p', null, 'At the ticket window, rental counter or other shared computers a manager has set up, switch in with your username and PIN instead of your password. Keep it to yourself: everything you do there is recorded as you.'),
      h('p', null, sec.pin_set ? state('Set', 'good') : h('span', { class: 'muted' }, 'Not set')),
      h('div', { class: 'row' }, button(sec.pin_set ? 'Change PIN' : 'Set a PIN', set, { small: !!sec.pin_set, kind: sec.pin_set ? undefined : 'primary' }),
        sec.pin_set ? button('Remove PIN', () => confirmDialog('Remove your PIN?', 'You will sign in to shared terminals with your password until you set a new one.', 'Remove', async () => { await del('/auth/pin'); sec.pin_set = false; draw(); }), { small: true }) : null));
  }
  draw();
  return box;
}

/** Where you are signed in now, and the devices you have used. */
function sessionsPanel(sec, redraw) {
  return h('section', { class: 'panel stack', 'data-panel': 'sessions' },
    h('h2', null, 'Where you are signed in'),
    h('p', null, 'Each sign-in ends after an hour unused, or 8 hours at most. If you see one that is not you, sign it out and change your password.'),
    table([
      { head: 'Device', cell: (x) => [h('strong', null, x.device), x.current ? h('span', { class: 'muted small' }, ' (this one)') : null] },
      { head: 'How', cell: (x) => METHOD[x.method] || x.method },
      { head: 'Signed in', cell: (x) => when(x.created_at) },
      { head: 'Last active', cell: (x) => when(x.last_seen) },
      { head: '', actions: true, cell: (x) => (x.current ? null : button('Sign out', async () => { await del(`/auth/sessions/${x.id}`); toast('Signed out there'); redraw(); }, { small: true })) },
    ], sec.sessions),
    sec.sessions.length > 1 ? h('div', { class: 'row' }, button('Sign out everywhere else', () => confirmDialog('Sign out everywhere else?', 'Every other phone and computer signed in as you is signed out now.', 'Sign out', async () => { await post('/auth/sessions/end-others'); toast('Signed out everywhere else'); redraw(); }, { danger: true }), { small: true })) : null,
    h('h3', null, 'Devices you have used'),
    h('p', { class: 'muted small' }, 'A sign-in from a device not on this list is emailed to you. Without two-step sign-in, a code is emailed first. Forget a device you no longer use.'),
    sec.devices.length ? table([
      { head: 'Device', cell: (d) => [h('strong', null, d.label || 'A device'), d.current ? h('span', { class: 'muted small' }, ' (this one)') : null] },
      { head: 'First used', cell: (d) => when(d.first_seen) },
      { head: 'Last used', cell: (d) => when(d.last_seen) },
      { head: '', actions: true, cell: (d) => (d.current ? null : button('Forget', async () => { await del(`/auth/devices/${d.id}`); toast('Forgotten'); redraw(); }, { small: true })) },
    ], sec.devices) : empty('None recorded yet.'));
}

/** This mountain's shared terminals (managers): enroll this computer, see the others, remove one. */
function terminalsPanel() {
  const box = h('section', { class: 'panel stack', 'data-panel': 'terminals' });
  async function draw() {
    let data;
    try { ({ data } = await get('/terminals')); } catch (err) { clear(box).append(errorBox(err)); return; }
    const here = readTerminal();
    const live = data.filter((t) => !t.revoked_at);
    clear(box).append(...[h('h2', null, 'Shared terminals'),
      h('p', null, 'Computers that several people use, like the ticket window or rental counter. On an enrolled one, counter, instructor and lift staff switch in with their username and PIN, so nobody shares a login and everything is recorded as the right person. Managers and patrol still sign in with their passkey or two-step. A terminal\'s sign-in ends after 15 minutes unused.'),
      here && here.tenant === ctx.me.tenant ? h('p', null, state('This computer is a shared terminal', 'good'), ` (${here.name}). `, button('Stop using it as one', () => { saveTerminal(null); toast('This computer is no longer a shared terminal here'); draw(); }, { small: true })) : null,
      live.length ? table([
        { head: 'Name', cell: (t) => h('strong', null, t.name) },
        { head: 'Enrolled', cell: (t) => [when(t.created_at), t.enrolled_by ? h('span', { class: 'muted small' }, ` by ${t.enrolled_by}`) : null] },
        { head: 'Last used', cell: (t) => when(t.last_seen) },
        { head: '', actions: true, cell: (t) => button('Remove', () => confirmDialog(`Remove ${t.name}?`, 'Anyone switched in there is signed out now, and the PIN screen stops working on that computer.', 'Remove', async () => { await del(`/terminals/${t.id}`); if (here && here.id === t.id) saveTerminal(null); toast('Terminal removed'); await draw(); }, { danger: true }), { small: true, kind: 'danger' }) },
      ], live) : h('p', { class: 'muted' }, 'No shared terminals yet.'),
      here && here.tenant === ctx.me.tenant ? null : h('div', { class: 'row' }, button('Make this computer a shared terminal', () => {
        const name = input({ name: 'name', maxlength: 60, required: true, placeholder: 'For example: Ticket window 1' });
        formDialog('Make this computer a shared terminal', h('div', { class: 'stack' }, h('p', null, 'Do this on the shared computer itself, signed in as a manager. Afterwards, signing out here shows the PIN screen. Do not do this on your own phone or laptop.'), h('div', { class: 'form' }, field('Name', name, 'Shown on its PIN screen and in the activity log'))), async () => {
          const t = await post('/terminals', { name: name.value.trim() });
          saveTerminal({ id: t.id, name: t.name, tenant: t.tenant, secret: t.secret });
          toast(`${t.name} is set up. Sign out to see the PIN screen`);
          await draw();
        }, { submitText: 'Enroll this computer' });
      }, { small: true }))].filter(Boolean));
  }
  draw();
  return box;
}

/** The owner's rules: patrollers and two-step (on by default). */
function rulesPanel() {
  const box = h('section', { class: 'panel stack', 'data-panel': 'sign-in-rules' });
  (async () => {
    let r;
    try { r = await get('/tenant/sign-in-rules'); } catch (err) { box.append(errorBox(err)); return; }
    const owner = ctx.me.role === 'owner';
    const on = h('input', { type: 'checkbox', name: 'mfa_for_patrol', checked: r.mfa_for_patrol, disabled: !owner });
    on.addEventListener('change', async () => {
      on.disabled = true;
      try { await put('/tenant/sign-in-rules', { mfa_for_patrol: on.checked }); toast('Saved'); } catch (err) { on.checked = !on.checked; box.append(errorBox(err)); }
      on.disabled = false;
    });
    box.append(h('h2', null, 'Who must use two-step sign-in'),
      h('ul', { class: 'plain stack tight' },
        h('li', null, h('strong', null, 'Owners and managers: '), 'always, with a passkey or an authenticator app.'),
        h('li', null, h('strong', null, 'Patrol Admins and Managers: '), 'always.'),
        h('li', null, h('strong', null, 'Patrollers: '), r.mfa_for_patrol ? `yes, because Patrol holds patient details${r.patrol_mfa_from && r.patrol_mfa_from > new Date().toISOString().slice(0, 10) ? ` (from ${r.patrol_mfa_from})` : ''}.` : 'no (turned off by the owner).'),
        h('li', null, h('strong', null, 'Counter, instructor and lift staff: '), 'not required. They use a password, or a PIN on a shared terminal. A sign-in from a new device sends them a code by email when they have one.')),
      h('label', { class: 'check' }, on, owner ? ' Patrollers must use two-step sign-in (recommended)' : ' Patrollers must use two-step sign-in (only the owner can change this)'),
      r.season_ends_on ? h('p', { class: 'muted small' }, `Seasonal logins end after ${r.season_ends_on}. Change it under Logins, Season end.`) : '');
  })();
  return box;
}

/** The sign-in parts of Account, in order. */
export async function signInSection(afterPasskeys) {
  const wrap = h('div', { class: 'stack' });
  const draw = async () => {
    let sec;
    try { sec = await get('/auth/security'); } catch (err) { clear(wrap).append(errorBox(err)); return; }
    clear(wrap);
    if (sec.signed_in_with === 'pin') {
      wrap.append(h('section', { class: 'panel' }, h('p', null, 'You switched in with your PIN on a shared terminal. To change your password, PIN or passkeys, sign in with your password on your own device.')));
      wrap.append(sessionsPanel(sec, draw));
      return;
    }
    wrap.append(passkeysPanel(() => draw()));
    if (afterPasskeys) wrap.append(afterPasskeys());
    if (sec.can_have_pin) wrap.append(pinPanel(sec));
    wrap.append(sessionsPanel(sec, draw));
    if (isManager()) wrap.append(terminalsPanel(), rulesPanel());
  };
  await draw();
  return wrap;
}
