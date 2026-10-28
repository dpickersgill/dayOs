// Settings, Team and logins: three tabs. Logins (who can sign in, their role, staff record, password and PIN, season
// end), Two-step sign-in (who must use it), and Menus for each role.
import { get, post, put, patch, del } from '../api.js';
import { h, clear, ctx, table, state, input, select, field, button, toast, formDialog, confirmDialog, val, num, label, empty, tabs } from '../ui.js';
import { card, row, toggle, formTracker } from './settings-kit.js';

const ROLES = ['manager', 'staff', 'counter', 'instructor', 'patrol', 'area'];
// The ski area's free read-only login: the patrol summary and approved reports only.
const roleName = (r) => (r === 'area' ? 'Ski area (read-only)' : label(r));

const TABS = [['logins', 'Logins'], ['twostep', 'Two-step sign-in'], ['menus', 'Menus for each role']];

export async function renderSettingsPage(root) {
  const wanted = new URLSearchParams(location.hash.split('?')[1] || '').get('tab');
  const initial = TABS.some((t) => t[0] === wanted) ? wanted : 'logins';
  root.append(tabs([
    ['logins', 'Logins', (box) => drawLogins(box)],
    ['twostep', 'Two-step sign-in', (box) => drawTwoStep(box)],
    ['menus', 'Menus for each role', async (box) => (await import('./settings-menus.js')).drawMenus(box)],
  ], initial, { param: 'tab' }));
}

// ---------------------------------------------------------------- logins
async function drawLogins(box) {
  const [{ data: users }, { data: staff }] = await Promise.all([get('/users'), get('/workforce/staff')]);
  const staffName = new Map(staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`]));
  const reload = async () => { const n = h('div'); await drawLogins(n); clear(box).append(...n.childNodes); };
  const isOwner = ctx.me.role === 'owner';
  const canManage = (u) => u.role !== 'owner' && (isOwner || u.role !== 'manager');

  clear(box).append(
    h('section', { class: 'set-card', 'data-card': 'logins' },
      h('div', { class: 'set-card-head' }, h('h2', null, 'Logins'),
        h('div', { class: 'row' }, button('Season end', () => seasonEnd(reload), { small: true }), button('Add login', () => addLogin(staff, isOwner, reload), { kind: 'primary', small: true }))),
      h('p', { class: 'set-card-intro' }, 'Who can sign in to this mountain. Everyone signs in with their username, or their email if they have one; only managers must have an email. Link a login to a staff member so they can see their shifts and clock in.'),
      users.length ? table([
        { head: 'Username', cell: (u) => [h('strong', null, u.username || ''), u.must_change_password ? h('small', { class: 'muted' }, ' (temporary password)') : null] },
        { head: 'Email', cell: (u) => u.email || h('span', { class: 'muted' }, 'None') },
        { head: 'Role', cell: (u) => roleName(u.role) },
        { head: 'Staff record', cell: (u) => (u.staff_id ? staffName.get(u.staff_id) || `#${u.staff_id}` : h('span', { class: 'muted' }, 'Not linked')) },
        { head: 'Status', cell: (u) => state(u.active ? 'Active' : 'Deactivated', u.active ? 'good' : 'neutral') },
        { head: 'Two-step', cell: (u) => (u.mfa_enabled ? state(Number(u.passkeys) ? (u.app_enabled ? 'Passkey and app' : 'Passkey') : 'App', 'good') : h('span', { class: 'muted' }, 'Off')) },
        { head: 'Access ends', cell: (u) => (u.access_ends_on ? (String(u.access_ends_on).slice(0, 10) < today() ? state(`Ended ${String(u.access_ends_on).slice(0, 10)}`, 'neutral') : String(u.access_ends_on).slice(0, 10)) : h('span', { class: 'muted' }, '-')) },
        { head: '', actions: true, cell: (u) => (canManage(u) ? [
          button('Edit', () => editLogin(u, reload), { small: true, label: `Edit ${u.username}` }),
          button('Link staff', () => linkStaff(u, staff, reload), { small: true }),
          button('Role', () => changeRole(u, isOwner, reload), { small: true }),
          button('New password', () => resetPassword(u), { small: true }),
          u.mfa_enabled ? button('Reset two-step', () => resetMfa(u, reload), { small: true }) : null,
          u.pin_set ? button('Clear PIN', () => confirmDialog(`Clear ${who(u)}'s PIN?`, 'They are switched out of any shared computer now and set a new PIN under Settings, Your profile and sign-in.', 'Clear PIN', async () => { await del(`/users/${u.id}/pin`); toast('PIN cleared'); await reload(); }), { small: true }) : null,
          u.id === ctx.me.id ? null : button(u.active ? 'Deactivate' : 'Reactivate', () => toggleActive(u, reload), { small: true, kind: u.active ? 'danger' : undefined }),
        ] : null) },
      ], users) : empty('No logins.')));
}

function roleOptions(isOwner) { return (isOwner ? ROLES : ROLES.filter((r) => r !== 'manager')); }

const who = (u) => u.username || u.email;
const needsEmail = (role) => ['owner', 'manager', 'area'].includes(role);
const today = () => new Date().toISOString().slice(0, 10);

/** A new login: a username (filled in from the staff member's name), an email if they have one (managers must). */
function addLogin(staff, isOwner, done) {
  const uname = input({ name: 'username', required: true, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 40 });
  const email = input({ name: 'email', type: 'email', autocomplete: 'off' });
  const role = select(roleOptions(isOwner).map((r) => [r, roleName(r)]), 'staff', { name: 'role' });
  const staffSel = select([['', 'Not linked'], ...staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`])], '', { name: 'staff_id' });
  const emailHint = h('span', { class: 'hint' });
  let typed = false;
  uname.addEventListener('input', () => { typed = true; });
  const suggest = async () => {
    if (typed) return;
    try { uname.value = (await get(`/users/suggest-username?staff_id=${staffSel.value || ''}&email=${encodeURIComponent(email.value.trim())}`)).username; } catch (_) { /* leave it */ }
  };
  const syncHint = () => { emailHint.textContent = role.value === 'area' ? 'Required. A ski area login sees the patrol summary and approved reports only, uses two-step sign-in, and is free.' : needsEmail(role.value) ? 'Required for managers.' : 'Optional. They can sign in with either.'; };
  staffSel.addEventListener('change', suggest); email.addEventListener('change', suggest); role.addEventListener('change', syncHint);
  syncHint();
  const f = h('div', { class: 'form' },
    field('Staff record', staffSel, 'Linking lets them see their shifts and clock in'),
    field('Username', uname, 'What they type to sign in. Letters, numbers, dots and dashes.'),
    h('label', { class: 'field' }, 'Email', email, emailHint),
    field('Role', role),
    field('Temporary password', input({ name: 'password', type: 'text', required: true, minlength: 12, autocomplete: 'off' }), 'At least 12 characters. Tell them in person or by phone.'),
    h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'temporary', checked: true }), ' They choose their own password when they first sign in'));
  formDialog('Add a login', f, async (fd) => {
    if (needsEmail(val(fd, 'role')) && !val(fd, 'email')) throw new Error(val(fd, 'role') === 'area' ? 'A ski area login needs an email' : 'Managers need an email');
    const r = await post('/users', { username: val(fd, 'username') || undefined, email: val(fd, 'email') || undefined, password: fd.get('password'), role: val(fd, 'role'), staff_id: num(fd, 'staff_id') || undefined, temporary: Boolean(fd.get('temporary')) });
    toast(`Login created. They sign in as ${r.username}`);
    await done();
  }, { submitText: 'Create login' });
  suggest();
}

function editLogin(u, done) {
  formDialog(`Edit ${who(u)}`, h('div', { class: 'form' },
    field('Username', input({ name: 'username', value: u.username || '', required: true, maxlength: 40, autocapitalize: 'none', spellcheck: 'false' }), 'Letters, numbers, dots and dashes'),
    field('Email', input({ name: 'email', type: 'email', value: u.email || '' }), needsEmail(u.role) ? 'Required for managers.' : 'Optional. Leave blank if they have none.'),
    needsEmail(u.role) ? null : field('Access ends after', input({ name: 'access_ends_on', type: 'date', value: u.access_ends_on ? String(u.access_ends_on).slice(0, 10) : '' }), 'They cannot sign in after this day. Leave blank for no end. Clear it to bring someone back.')), async (fd) => {
    await patch(`/users/${u.id}`, { username: val(fd, 'username'), email: val(fd, 'email'), ...(needsEmail(u.role) ? {} : { access_ends_on: val(fd, 'access_ends_on') }) });
    toast('Saved');
    await done();
  });
}

/** The last day of the season: seasonal logins stop working after it, and new ones get it too. */
async function seasonEnd(done) {
  const r = await get('/tenant/sign-in-rules');
  const date = input({ name: 'date', type: 'date', value: r.season_ends_on || '', min: today() });
  const now = h('input', { type: 'checkbox', name: 'now', checked: true });
  formDialog('Season end', h('div', { class: 'stack' },
    h('p', null, 'Seasonal staff stop being able to sign in after this day, so logins do not linger over the summer. Owners and managers are never affected. To bring someone back, edit their login and clear or move the date.'),
    h('div', { class: 'form' }, field('Last day of the season', date, 'Leave blank to have no season end for new logins')),
    h('label', { class: 'check' }, now, ' Also set it on every current counter, instructor, staff and patrol login')), async () => {
    const out = await post('/users/season-end', { date: date.value || null, apply_to_current: now.checked });
    toast(out.season_ends_on ? `Season ends ${out.season_ends_on}. ${out.changed} login${out.changed === 1 ? '' : 's'} updated` : 'No season end for new logins');
    await done();
  }, { submitText: 'Save' });
}

function linkStaff(u, staff, done) {
  formDialog(`Staff record for ${who(u)}`, h('div', { class: 'form' },
    field('Staff member', select([['', 'Not linked'], ...staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`])], u.staff_id || '', { name: 'staff_id' }), 'Each staff member can have one login')), async (fd) => {
    await patch(`/users/${u.id}`, { staff_id: num(fd, 'staff_id') || null });
    toast('Saved');
    await done();
  });
}

function changeRole(u, isOwner, done) {
  formDialog(`Role for ${who(u)}`, h('div', { class: 'form' }, field('Role', select(roleOptions(isOwner).map((r) => [r, roleName(r)]), u.role, { name: 'role' }))), async (fd) => {
    await patch(`/users/${u.id}`, { role: val(fd, 'role') });
    toast('Role changed. It applies right away');
    await done();
  });
}

function resetPassword(u) {
  formDialog(`New password for ${who(u)}`, h('div', { class: 'form' },
    field('New password', input({ name: 'password', type: 'text', required: true, minlength: 12, autocomplete: 'off' }), 'At least 12 characters. They are signed out everywhere until they use it. Tell them in person or by phone.'),
    h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'temporary', checked: true }), ' Temporary: they choose their own password when they next sign in')), async (fd) => {
    await post(`/users/${u.id}/reset-password`, { new_password: fd.get('password'), temporary: Boolean(fd.get('temporary')) });
    toast(`Password reset. They sign in as ${who(u)}`);
  }, { submitText: 'Reset password' });
}

function toggleActive(u, done) {
  const off = u.active;
  confirmDialog(off ? 'Deactivate this login?' : 'Reactivate this login?', off ? `${who(u)} is signed out immediately and cannot sign in.` : `${who(u)} can sign in again.`, off ? 'Deactivate' : 'Reactivate', async () => {
    await patch(`/users/${u.id}`, { active: !off });
    toast(off ? 'Login deactivated' : 'Login reactivated');
    await done();
  }, { danger: off });
}

function resetMfa(u, done) {
  confirmDialog('Reset two-step sign-in?', `${who(u)} will sign in with just their password until they set two-step up again. Do this when they have lost their phone and their recovery codes.`, 'Reset two-step', async () => {
    await post(`/users/${u.id}/reset-mfa`);
    toast('Two-step sign-in reset');
    await done();
  }, { danger: true });
}

// ---------------------------------------------------------------- two-step sign-in
/** Who must use two-step sign-in: the fixed rules, and the two the owner chooses (patrollers, and everyone). */
async function drawTwoStep(box) {
  const [r, t] = await Promise.all([get('/tenant/sign-in-rules'), get('/tenant/profile')]);
  const owner = ctx.me.role === 'owner';
  const f = formTracker(async (changed) => {
    if (changed(patrol)) await put('/tenant/sign-in-rules', { mfa_for_patrol: patrol.checked });
    if (changed(everyone)) await put('/tenant/profile', { require_mfa: everyone.checked });
  });
  const patrol = f.track(toggle({ name: 'mfa_for_patrol', checked: r.mfa_for_patrol, disabled: !owner }));
  const everyone = f.track(toggle({ name: 'require_mfa', checked: Boolean(t.require_mfa), disabled: !owner }));
  const soon = r.patrol_mfa_from && r.patrol_mfa_from > today() ? ` (from ${r.patrol_mfa_from})` : '';
  box.append(
    card('Always required', [
      h('ul', { class: 'set-list' },
        h('li', null, h('strong', null, 'Owners and managers: '), 'always, with a passkey or an authenticator app.'),
        h('li', null, h('strong', null, 'Patrol Admins and Managers: '), 'always.'),
        h('li', null, h('strong', null, 'Counter, instructor and lift staff: '), 'not required. They use a password, or a PIN on a shared computer. A sign-in from a new device sends them a code by email when they have one.')),
    ]),
    card('Your rules', [
      row('Patrollers must use two-step sign-in', patrol, `Recommended, because Patrol holds patient details${soon}.`),
      row('Everyone must use two-step sign-in', everyone, 'Each person, including you, is asked to set it up on their next screen.'),
      owner ? null : h('p', { class: 'set-card-intro' }, 'Only the owner can change these.'),
      r.season_ends_on ? h('p', { class: 'set-card-intro' }, `Seasonal logins end after ${r.season_ends_on}. Change it under Logins, Season end.`) : null,
    ], { id: 'mfa-rules' }),
    f.bar);
}
