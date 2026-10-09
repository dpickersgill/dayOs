// The operator's console at /platform: every mountain, which apps each one has, pause and resume, storage limits and owner password resets.
// It signs in with the platform key, your name and (when the service has PLATFORM_TOTP_SECRET set) a code from your
// authenticator app. The 2-hour session is kept only in this tab's memory.

import { h, clear, button, field, input, table, dialog, formDialog, confirmDialog, toast, fail, empty, errorBox, state } from './ui.js';

const app = document.getElementById('app');
let session = '';
let apps = [];

async function call(method, path, body) {
  const res = await fetch(`/api/v1/platform${path}`, { method, headers: { 'content-type': 'application/json', 'x-platform-session': session }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (!res.ok) { const e = new Error((json && json.error) || 'Something went wrong'); e.status = res.status; throw e; }
  return json;
}

function signIn(message) {
  clear(app);
  const err = h('div');
  const k = input({ type: 'password', name: 'key', autocomplete: 'current-password', required: true });
  const who = input({ name: 'name', autocomplete: 'name', required: true, maxlength: 100 });
  const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Open console');
  const form = h('form', { class: 'stack', novalidate: true }, field('Platform key', k, 'The BOOTSTRAP_KEY setting for the service. It is not saved.'),
    field('Your name', who, 'Recorded with every change you make.'), field('Code from your authenticator app', code, 'Needed when two-step sign-in is set up for the console.'), err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err); go.disabled = true;
    try {
      session = (await call('POST', '/session', { key: k.value, name: who.value.trim(), code: code.value.trim() || undefined })).session;
      apps = (await call('GET', '/modules')).data; await home();
    } catch (ex) { session = ''; err.append(errorBox(ex)); go.disabled = false; }
  });
  app.append(h('main', { class: 'platform-box stack' }, h('h1', null, 'SummitOps platform'), message ? h('p', { class: 'muted' }, message) : null, form));
  k.focus();
}

const badge = (text, cls = '') => h('span', { class: `badge ${cls}`.trim() }, text);

async function home() {
  clear(app);
  const body = h('div', { class: 'stack' });
  const filter = input({ type: 'search', placeholder: 'Find a mountain', 'aria-label': 'Find a mountain' });
  app.append(h('main', { class: 'platform-box wide stack' },
    h('header', { class: 'row between' }, h('h1', null, 'Mountains'),
      h('div', { class: 'row' }, button('Add a mountain', () => addMountain(), { kind: 'primary' }), button('Demos', () => demos(), { small: true }), button('Activity', () => activity(), { small: true }), button('Lock console', () => { session = ''; signIn('Locked.'); }, { small: true }))),
    filter, body));
  try {
    const { data: all } = await call('GET', '/tenants');
    if (!all.length) { body.append(empty('No mountains yet.')); return; }
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      const data = all.filter((t) => !q || `${t.name} ${t.slug}`.toLowerCase().includes(q));
      clear(body);
      if (!data.length) { body.append(empty('No mountain matches that.')); return; }
      body.append(table([
      { head: 'Mountain', cell: (t) => h('span', null, h('b', null, t.name), h('span', { class: 'muted' }, ` ${t.slug}`)) },
      { head: 'Status', cell: (t) => t.status === 'active' ? badge('Active', 'ok') : badge('Paused', 'warn') },
      { head: 'Apps', cell: (t) => `${t.modules.length} of ${apps.length} on` },
      { head: 'Logins', num: true, cell: (t) => String(t.users) },
      { head: 'Storage', cell: (t) => `${t.storage_used_mb} of ${t.storage_cap_mb} MB` },
      { actions: true, cell: (t) => button('Manage', () => manage(t.id), { small: true }) },
    ], data));
    };
    filter.addEventListener('input', draw);
    draw();
  } catch (ex) { if (ex.status === 403) signIn('That key was not accepted.'); else body.append(errorBox(ex)); }
}

async function manage(id) {
  const t = await call('GET', `/tenants/${id}`).catch((e) => { fail(e); return null; });
  if (!t) return;
  const state = Object.fromEntries(apps.map((a) => [a.key, t.modules.includes(a.key)]));
  const list = h('div', { class: 'stack tight' });
  const boxes = new Map();
  const draw = () => {
    clear(list);
    for (const a of apps) {
      const cb = h('input', { type: 'checkbox', checked: state[a.key] ? 'checked' : null });
      cb.checked = state[a.key];
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        try {
          const out = await call('PUT', `/tenants/${id}/modules`, { modules: { [a.key]: cb.checked } });
          for (const x of apps) state[x.key] = out.modules.includes(x.key);
          const moved = apps.filter((x) => x.key !== a.key && (x.needs || []).includes(a.key) || (a.needs || []).includes(x.key)).map((x) => x.label);
          toast(`${a.label} turned ${state[a.key] ? 'on' : 'off'}${moved.length ? `, along with what it depends on (${moved.join(', ')})` : ''}.`);
        } catch (ex) { cb.checked = !cb.checked; fail(ex); }
        draw();
      });
      boxes.set(a.key, cb);
      list.append(h('label', { class: 'check app-row' }, cb, h('span', null, h('b', null, a.label), h('span', { class: 'hint' }, ` ${a.blurb}${(a.needs || []).length ? ' Needs: ' + a.needs.map((n) => apps.find((x) => x.key === n).label).join(', ') + '.' : ''}`))));
    }
  };
  draw();
  const people = t.users.length ? table([
    { head: 'Login', cell: (u) => u.email }, { head: 'Role', cell: (u) => u.role },
    { head: 'Two-step', cell: (u) => (u.totp_enabled ? 'On' : 'Off') },
    { actions: true, cell: (u) => button('Reset password', () => resetPassword(id, u), { small: true }) },
  ], t.users) : empty('No owner or manager logins.');
  const paused = t.status === 'suspended';
  const dlg = dialog(t.name, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${t.slug}. Added ${String(t.created_at).slice(0, 10)}. ${paused ? 'Paused: nobody can sign in and public pages are off.' : 'Active.'}`),
    h('div', { class: 'row' },
      button(paused ? 'Resume mountain' : 'Pause mountain', () => confirmDialog(paused ? 'Resume this mountain?' : 'Pause this mountain?', paused ? 'People can sign in again.' : 'Everyone is signed out and its public pages stop working. Nothing is deleted.', paused ? 'Resume' : 'Pause', async () => { await call('PATCH', `/tenants/${id}`, { status: paused ? 'active' : 'suspended' }); dlg.close(); home(); manage(id); }, { danger: !paused })),
      button('Rename or set storage', () => editBasics(t, () => { dlg.close(); home(); manage(id); }), { small: true })),
    h('h3', null, 'Apps'), h('p', { class: 'hint' }, 'Changes apply within a few seconds. Turning an app off hides it and refuses its requests; its data is kept.'), list,
    h('h3', null, 'Storage'), h('p', null, `${t.storage_used_mb} MB used of ${t.storage_cap_mb} MB for document files.`),
    h('h3', null, 'Owner and manager logins'), people,
    t.history.length ? h('div', { class: 'stack tight' }, h('h3', null, 'Recent changes'), ...t.history.slice(0, 8).map((x) => h('p', { class: 'small muted' }, `${String(x.at).replace('T', ' ').slice(0, 16)}  ${x.action}  ${x.detail || ''}`))) : null), { wide: true });
}

function editBasics(t, done) {
  const name = input({ name: 'name', value: t.name, required: true });
  const cap = input({ name: 'cap', type: 'number', min: 10, max: 100000, value: t.storage_cap_mb });
  const notes = input({ name: 'notes', value: t.platform_notes || '', maxlength: 500 });
  formDialog('Mountain details', h('div', { class: 'stack' }, field('Name', name), field('Document storage limit (MB)', cap, 'Uploads are refused once files reach this size.'), field('Your notes', notes, 'Only you see this.')), async () => {
    await call('PATCH', `/tenants/${t.id}`, { name: name.value.trim(), storage_cap_mb: Number(cap.value), platform_notes: notes.value.trim() || null });
    toast('Saved.'); done();
  });
}

function resetPassword(id, u) {
  const pw = input({ name: 'pw', type: 'password', autocomplete: 'new-password', required: true });
  const clearTwo = h('input', { type: 'checkbox' });
  formDialog(`Reset password for ${u.email}`, h('div', { class: 'stack' }, field('New password', pw, 'At least 10 characters. Tell them in person or by phone, and ask them to change it.'),
    u.totp_enabled ? h('label', { class: 'check' }, clearTwo, 'Also turn off their two-step sign-in (use when they lost their phone)') : null), async () => {
    await call('POST', `/tenants/${id}/reset-password`, { user_id: u.id, password: pw.value, clear_two_step: Boolean(u.totp_enabled && clearTwo.checked) });
    toast('Password reset. They are signed out everywhere.');
  }, { submitText: 'Reset password' });
}

function addMountain() {
  const f = {
    name: input({ name: 'name', required: true }), slug: input({ name: 'slug', required: true, autocapitalize: 'none', spellcheck: 'false' }),
    tz: input({ name: 'tz', value: 'America/New_York' }), first: input({ name: 'first', required: true }), last: input({ name: 'last', required: true }),
    email: input({ name: 'email', type: 'email', required: true }), pw: input({ name: 'pw', type: 'password', autocomplete: 'new-password', required: true }),
    cap: input({ name: 'cap', type: 'number', min: 10, max: 100000, value: 500 }),
  };
  const picks = new Map();
  const checks = apps.map((a) => { const cb = h('input', { type: 'checkbox' }); cb.checked = true; picks.set(a.key, cb); return h('label', { class: 'check' }, cb, a.label); });
  f.name.addEventListener('input', () => { if (!f.slug.dataset.touched) f.slug.value = f.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); });
  f.slug.addEventListener('input', () => { f.slug.dataset.touched = '1'; });
  formDialog('Add a mountain', h('div', { class: 'stack' },
    field('Mountain name', f.name), field('Web name', f.slug, 'Lowercase letters, numbers and dashes. People type this to sign in.'), field('Time zone', f.tz),
    h('div', { class: 'grid2' }, field('Owner first name', f.first), field('Owner last name', f.last)), field('Owner email', f.email), field('Owner password', f.pw, 'At least 10 characters.'),
    field('Document storage limit (MB)', f.cap), h('fieldset', { class: 'stack tight' }, h('legend', null, 'Apps to turn on'), ...checks)), async () => {
    const modules = Object.fromEntries([...picks].map(([k, cb]) => [k, cb.checked]));
    await call('POST', '/tenants', { slug: f.slug.value.trim(), name: f.name.value.trim(), timezone: f.tz.value.trim(), storage_cap_mb: Number(f.cap.value), modules,
      owner: { email: f.email.value.trim(), password: f.pw.value, first_name: f.first.value.trim(), last_name: f.last.value.trim() } });
    toast('Mountain added.'); home();
  }, { submitText: 'Add mountain', wide: true });
}

// ---------------------------------------------------------------- the Demos dashboard
const when = (v) => (v ? new Date(`${String(v).replace(' ', 'T')}Z`) : null);
function ago(v) {
  const d = when(v); if (!d) return 'Never';
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 2) return 'Just now';
  if (m < 60) return `${m} minutes ago`;
  const hr = Math.round(m / 60); if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const dd = Math.round(hr / 24); return `${dd} day${dd === 1 ? '' : 's'} ago`;
}
const day = (v) => { const d = when(v); return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''; };
const dayTime = (v) => { const d = when(v); return d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
function leftOf(v) {
  const d = when(v); if (!d) return '';
  const days = Math.ceil((d - Date.now()) / 86_400_000);
  return days <= 1 ? 'ends today' : `${days} days left`;
}
const STATUS = { running: ['Running', 'good'], expired: ['Ended, not yet removed', 'warn'], removed: ['Ended', 'neutral'] };

async function demos() {
  clear(app);
  const body = h('div', { class: 'stack' });
  app.append(h('main', { class: 'platform-box wider stack' },
    h('header', { class: 'row between' },
      h('div', { class: 'stack tight' }, h('h1', null, 'Demos'), h('p', { class: 'muted' }, 'Everyone who started a demo, newest first, and how they used it.')),
      h('div', { class: 'row' }, button('Back to mountains', () => home(), { small: true }), button('Refresh', () => demos(), { small: true }))),
    body));
  let res;
  try { res = await call('GET', '/sandboxes'); } catch (ex) { if (ex.status === 403) signIn('Your session ended. Sign in again.'); else body.append(errorBox(ex)); return; }
  const { data, summary } = res;
  const stat = (n, label, note) => h('div', { class: 'demo-stat' }, h('b', null, String(n)), h('span', null, label), note ? h('small', null, note) : null);
  const pct = (n) => (summary.total ? `${Math.round((n / summary.total) * 100)}% of all demos` : '');
  body.append(h('section', { class: 'demo-stats', 'aria-label': 'Summary' },
    stat(summary.running, 'Running now'),
    stat(summary.last_7_days, 'Started in the last 7 days'),
    stat(summary.last_30_days, 'Started in the last 30 days'),
    stat(summary.came_back, 'Came back later', pct(summary.came_back)),
    stat(summary.made_changes, 'Made changes', pct(summary.made_changes))));

  if (!data.length) { body.append(empty('No one has started a demo yet. Share /try to get the first one.')); return; }

  let show = 'all';
  let limit = 50;
  const q = input({ type: 'search', placeholder: 'Find a name, email or mountain', 'aria-label': 'Find a demo' });
  const filters = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Show' });
  const list = h('div');
  const opts = [['all', 'All'], ['running', 'Running'], ['ended', 'Ended'], ['used', 'Made changes']];
  const drawFilters = () => {
    clear(filters);
    for (const [k, label] of opts) filters.append(h('button', { type: 'button', class: 'chip', 'aria-pressed': String(show === k), onclick: () => { show = k; limit = 50; drawFilters(); draw(); } }, label));
  };
  const remove = (x) => confirmDialog('Delete this demo?', `The demo mountain for ${x.email} and everything in it is removed now. Their usage stays on this page.`, 'Delete demo', async () => {
    try { await call('POST', `/sandboxes/${x.id}/remove`); toast('Demo deleted.'); demos(); } catch (e) { fail(e); }
  }, { danger: true });
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    const rows = data.filter((x) => (show === 'all' || (show === 'running' && x.status === 'running') || (show === 'ended' && x.status !== 'running') || (show === 'used' && x.changes > 0))
      && (!term || `${x.name} ${x.email} ${x.mountain}`.toLowerCase().includes(term)));
    clear(list);
    if (!rows.length) { list.append(empty('No demo matches that.')); return; }
    const more = rows.length > limit ? button(`Show ${Math.min(50, rows.length - limit)} more (${rows.length - limit} not shown)`, () => { limit += 50; draw(); }, { small: true }) : null;
    list.append(table([
      { head: 'Started', cell: (x) => h('span', { title: dayTime(x.at) }, day(x.at)) },
      { head: 'Who', cell: (x) => h('span', { class: 'stack tight' }, h('b', null, x.name), h('a', { href: `mailto:${x.email}` }, x.email)) },
      { head: 'Mountain', cell: (x) => x.mountain },
      { head: 'Status', cell: (x) => h('span', { class: 'stack tight' }, state(...STATUS[x.status]), x.status === 'running' ? h('small', { class: 'muted' }, leftOf(x.expires_at)) : null) },
      { head: 'Last used', cell: (x) => h('span', { title: dayTime(x.last_used_at) }, ago(x.last_used_at)) },
      { head: 'Sign-ins', num: true, cell: (x) => String(x.sign_ins) },
      { head: 'Activity', num: true, cell: (x) => h('span', { title: 'Screens opened and actions taken' }, String(x.requests)) },
      { head: 'Changes', num: true, cell: (x) => String(x.changes) },
      { head: 'Apps used', cell: (x) => (x.apps.length ? x.apps.slice(0, 3).map((a) => a.label).join(', ') + (x.apps.length > 3 ? ` +${x.apps.length - 3}` : '') : h('span', { class: 'muted' }, 'None yet')) },
      { actions: true, cell: (x) => (x.status !== 'removed' ? button('Delete', () => remove(x), { small: true }) : '') },
    ], rows.slice(0, limit)), more);
  };
  q.addEventListener('input', () => { limit = 50; draw(); });
  drawFilters(); draw();

  const csv = () => {
    const cols = ['at', 'name', 'email', 'mountain', 'status', 'last_used_at', 'sign_ins', 'requests', 'changes', 'apps'];
    const cell = (v) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(t)) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [cols.join(','), ...data.map((x) => cols.map((c) => cell(c === 'apps' ? x.apps.map((a) => a.label).join('; ') : x[c])).join(','))];
    const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: 'summitops-demos.csv' });
    document.body.append(a); a.click(); a.remove();
  };
  body.append(h('div', { class: 'row between' }, h('div', { class: 'row' }, filters, q), null), list,
    h('p', { class: 'muted small' }, 'Activity counts screens opened and actions taken. Changes are things the visitor added or edited. Came back means used again more than an hour after starting.'),
    h('div', { class: 'row' },
      button('Download CSV', csv, { small: true }),
      button('Remove finished demos now', async () => { try { const r = await call('POST', '/sandboxes/purge'); toast(`${r.removed} finished demo${r.removed === 1 ? '' : 's'} removed.`); demos(); } catch (e) { fail(e); } }, { small: true }),
      summary.running ? button('Delete every demo', () => confirmDialog('Delete every demo?', `All ${res.active} demo mountain${res.active === 1 ? '' : 's'} are removed now, including ones people are using. Their usage stays on this page.`, 'Delete all demos', async () => {
        try { const r = await call('POST', '/sandboxes/remove-all'); toast(`${r.removed} demo${r.removed === 1 ? '' : 's'} deleted.`); demos(); } catch (e) { fail(e); }
      }, { danger: true }), { small: true, kind: 'danger' }) : null));
}

async function activity() {
  try {
    const { data } = await call('GET', '/audit');
    dialog('Recent activity', data.length ? table([{ head: 'When', cell: (x) => String(x.at).replace('T', ' ').slice(0, 16) }, { head: 'Mountain', cell: (x) => x.slug || '' }, { head: 'Who', cell: (x) => x.actor || '' }, { head: 'What', cell: (x) => x.action }, { head: 'Details', cell: (x) => x.detail || '' }], data) : empty('Nothing yet.'), { wide: true });
  } catch (e) { fail(e); }
}

signIn();
