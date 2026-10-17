// The operator's console at /platform: every mountain, which apps each one has, pause and resume, storage limits and owner password resets.
// It signs in with the platform key, your name and (when the service has PLATFORM_TOTP_SECRET set) a code from your
// authenticator app. The 2-hour session is kept only in this tab's memory.

import { h, clear, button, field, input, table, dialog, formDialog, confirmDialog, toast, fail, empty, errorBox, state } from './ui.js';
import { qr } from './barcode.js';

const app = document.getElementById('app');
let session = '';
let apps = [];
let me = { name: '', operator: false }; // who is signed in, and whether with their own login (not the platform key)

async function call(method, path, body) {
  const res = await fetch(`/api/v1/platform${path}`, { method, headers: { 'content-type': 'application/json', 'x-platform-session': session }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (!res.ok) { const e = new Error((json && json.error) || 'Something went wrong'); e.status = res.status; throw e; }
  return json;
}

// ---------------------------------------------------------------- signing in
async function opened(out) {
  session = out.session;
  me = { name: out.name || '', operator: Boolean(out.operator) };
  apps = (await call('GET', '/modules')).data;
  await home();
}

/** Email, password, then the code from the authenticator app. The platform key is a link underneath, for emergencies. */
function signIn(message) {
  session = ''; me = { name: '', operator: false };
  clear(app);
  const err = h('div');
  const email = input({ type: 'email', name: 'email', autocomplete: 'username', required: true, maxlength: 255 });
  const pw = input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: 200 });
  const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456' });
  const codeField = field('Code from your authenticator app', code, 'The six-digit code SummitOps platform shows in your app.');
  codeField.hidden = true;
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Sign in');
  const form = h('form', { class: 'stack', novalidate: true }, field('Email', email), field('Password', pw), codeField, err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err); go.disabled = true;
    try {
      const out = await call('POST', '/login', { email: email.value.trim(), password: pw.value, code: code.value.trim() || undefined });
      if (out.setup_required) { setupTwoStep(out); return; }
      if (out.code_required) { codeField.hidden = false; code.focus(); go.disabled = false; return; }
      await opened(out);
    } catch (ex) { err.append(errorBox(ex)); go.disabled = false; if (!codeField.hidden) { code.value = ''; code.focus(); } }
  });
  const keyLink = h('button', { type: 'button', class: 'linklike' }, 'Sign in with the platform key instead');
  keyLink.addEventListener('click', () => keySignIn());
  app.append(h('main', { class: 'platform-box stack' }, h('h1', null, 'SummitOps platform'), message ? h('p', { class: 'muted' }, message) : null, form,
    h('p', { class: 'muted small' }, 'No login yet? Sign in once with the platform key and add yourself under Operators. ', keyLink)));
  email.focus();
}

/** First sign-in: set up the authenticator app, then you are in. */
function setupTwoStep(out) {
  clear(app);
  const err = h('div');
  const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456', required: true });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Turn on and sign in');
  const form = h('form', { class: 'stack', novalidate: true }, field('Code from the app', code), err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err); go.disabled = true;
    try { await opened(await call('POST', '/login/setup', { setup_token: out.setup_token, code: code.value.trim() })); } catch (ex) { err.append(errorBox(ex)); go.disabled = false; code.value = ''; code.focus(); }
  });
  app.append(h('main', { class: 'platform-box stack' }, h('h1', null, 'Set up two-step sign-in'),
    h('p', null, 'The console needs a code from an authenticator app every time you sign in (Google Authenticator, Microsoft Authenticator, 1Password and others work).'),
    h('ol', { class: 'stack tight' },
      h('li', null, 'Open the app and add an account by scanning this code.'),
      h('li', null, 'Type the six-digit code the app shows for SummitOps platform.')),
    h('div', { class: 'qr-box' }, qr(out.otpauth_uri, { size: 200 })),
    h('p', { class: 'muted small' }, 'Cannot scan? Choose "enter a setup key" in the app and type: ', h('code', null, out.secret.replace(/(.{4})/g, '$1 ').trim())),
    form, button('Cancel', () => signIn(), { small: true })));
  code.focus();
}

/** Break-glass: the platform key (the BOOTSTRAP_KEY setting), your name, and a code when PLATFORM_TOTP_SECRET is set. */
function keySignIn(message) {
  clear(app);
  const err = h('div');
  const k = input({ type: 'password', name: 'key', autocomplete: 'off', required: true });
  const who = input({ name: 'name', autocomplete: 'name', required: true, maxlength: 100 });
  const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '123456' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Open console');
  const form = h('form', { class: 'stack', novalidate: true }, field('Platform key', k, 'The BOOTSTRAP_KEY setting for the service. It is not saved.'),
    field('Your name', who, 'Recorded with every change you make.'), field('Code from your authenticator app', code, 'Only when two-step sign-in is set up for the platform key (PLATFORM_TOTP_SECRET).'), err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err); go.disabled = true;
    try {
      const out = await call('POST', '/session', { key: k.value, name: who.value.trim(), code: code.value.trim() || undefined });
      await opened({ ...out, name: who.value.trim(), operator: false });
    } catch (ex) { session = ''; err.append(errorBox(ex)); go.disabled = false; }
  });
  app.append(h('main', { class: 'platform-box stack' }, h('h1', null, 'Sign in with the platform key'),
    h('p', { class: 'muted' }, message || 'For setting up the first operator, or if nobody can sign in. Anyone with the key is treated as an operator, so keep it secret.'), form,
    button('Back to email sign-in', () => signIn(), { small: true })));
  k.focus();
}

const badge = (text, cls = '') => h('span', { class: `badge ${cls}`.trim() }, text);

async function home() {
  clear(app);
  const body = h('div', { class: 'stack' });
  const filter = input({ type: 'search', placeholder: 'Find a mountain', 'aria-label': 'Find a mountain' });
  app.append(h('main', { class: 'platform-box wide stack' },
    h('header', { class: 'row between' }, h('h1', null, 'Mountains'),
      h('div', { class: 'row' }, button('Add a mountain', () => addMountain(), { kind: 'primary' }), leadsButton(), button('Plans and prices', () => billingPlans(), { small: true }), button('Demos', () => demos(), { small: true }), button('Injury report', () => injuryReport(), { small: true }), button('Releases', () => releases(), { small: true }), button('Activity', () => activity(), { small: true }), button('Operators', () => operators(), { small: true }), me.operator ? button('Change my password', () => myPassword(), { small: true }) : null, button('Sign out', () => signIn('Signed out.'), { small: true }))),
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
      { head: 'Status', cell: (t) => t.status === 'active' ? badge('Active', 'ok') : t.delete_after ? badge(`Closed, deleted ${String(t.delete_after).slice(0, 10)}`, 'bad') : badge('Paused', 'warn') },
      { head: 'Billing', cell: (t) => billBadge(t.billing) },
      { head: 'Apps', cell: (t) => `${t.modules.length} of ${apps.length} on` },
      { head: 'Logins', num: true, cell: (t) => String(t.users) },
      { head: 'Storage', cell: (t) => `${t.storage_used_mb} of ${t.storage_cap_mb} MB` },
      { actions: true, cell: (t) => button('Manage', () => manage(t.id), { small: true }) },
    ], data));
    };
    filter.addEventListener('input', draw);
    draw();
  } catch (ex) { if (ex.status === 403) signIn('Your session ended. Sign in again.'); else body.append(errorBox(ex)); }
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
    { head: 'Login', cell: (u) => [u.username || '', u.email ? h('span', { class: 'muted' }, ` ${u.email}`) : null] }, { head: 'Role', cell: (u) => u.role },
    { head: 'Two-step', cell: (u) => (u.totp_enabled ? 'On' : 'Off') },
    { actions: true, cell: (u) => button('Reset password', () => resetPassword(id, u), { small: true }) },
  ], t.users) : empty('No owner or manager logins.');
  const paused = t.status === 'suspended';
  const dlg = dialog(t.name, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${t.slug}. Added ${String(t.created_at).slice(0, 10)}. ${t.delete_after ? `Closed: everything in it is deleted on ${String(t.delete_after).slice(0, 10)}. Resume it before then to keep it.` : paused ? 'Paused: nobody can sign in and public pages are off.' : 'Active.'}`),
    h('div', { class: 'row' },
      button(paused ? 'Resume mountain' : 'Pause mountain', () => confirmDialog(paused ? 'Resume this mountain?' : 'Pause this mountain?', paused ? 'People can sign in again.' : 'Everyone is signed out and its public pages stop working. Nothing is deleted.', paused ? 'Resume' : 'Pause', async () => { await call('PATCH', `/tenants/${id}`, { status: paused ? 'active' : 'suspended' }); dlg.close(); home(); manage(id); }, { danger: !paused })),
      button('Rename or set storage', () => editBasics(t, () => { dlg.close(); home(); manage(id); }), { small: true }),
      t.delete_after ? null : button('Close mountain', () => closeMountain(t, () => { dlg.close(); home(); manage(id); }), { small: true })),
    h('h3', null, 'Billing'), billingPanel(t, () => { dlg.close(); home(); manage(id); }),
    h('h3', null, 'Apps'), h('p', { class: 'hint' }, 'Changes apply within a few seconds. Turning an app off hides it and refuses its requests; its data is kept.'), list,
    h('h3', null, 'Storage'), h('p', null, `${t.storage_used_mb} MB used of ${t.storage_cap_mb} MB for document files.`),
    h('h3', null, 'Owner and manager logins'), people,
    t.history.length ? h('div', { class: 'stack tight' }, h('h3', null, 'Recent changes'), ...t.history.slice(0, 8).map((x) => h('p', { class: 'small muted' }, `${String(x.at).replace('T', ' ').slice(0, 16)}  ${x.action}  ${x.detail || ''}`))) : null), { wide: true });
}

// A mountain that has left: paused now, deleted for good once its export window passes.
function closeMountain(t, done) {
  const days = input({ name: 'days', type: 'number', min: 7, max: 365, value: 60 });
  const slug = input({ name: 'slug', required: true, autocomplete: 'off' });
  formDialog(`Close ${t.name}`, h('div', { class: 'stack' },
    h('p', null, 'Everyone is signed out and the mountain is paused now. After the number of days below, everything in it is deleted for good: people, sales, patrol records and files. Give the owner time to export first.'),
    field('Delete after (days)', days), field(`Type ${t.slug} to confirm`, slug)), async () => {
    const out = await call('POST', `/tenants/${t.id}/close`, { days: Number(days.value), confirm_slug: slug.value.trim() });
    toast(`Closed. Deleted on ${String(out.delete_after).slice(0, 10)} unless resumed.`); done();
  });
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
  const temp = h('input', { type: 'checkbox', checked: true });
  formDialog(`Reset password for ${u.username || u.email}`, h('div', { class: 'stack' }, field('New password', pw, 'At least 10 characters. Tell them in person or by phone.'),
    h('label', { class: 'check' }, temp, 'Temporary: they choose their own password when they next sign in'),
    u.totp_enabled ? h('label', { class: 'check' }, clearTwo, 'Also turn off their two-step sign-in (use when they lost their phone)') : null), async () => {
    await call('POST', `/tenants/${id}/reset-password`, { user_id: u.id, password: pw.value, clear_two_step: Boolean(u.totp_enabled && clearTwo.checked), temporary: temp.checked });
    toast('Password reset. They are signed out everywhere.');
  }, { submitText: 'Reset password' });
}

function addMountain(pre = {}, after) {
  const f = {
    name: input({ name: 'name', required: true, value: pre.name || '' }), slug: input({ name: 'slug', required: true, autocapitalize: 'none', spellcheck: 'false' }),
    tz: input({ name: 'tz', value: 'America/New_York' }), first: input({ name: 'first', required: true, value: pre.first || '' }), last: input({ name: 'last', required: true, value: pre.last || '' }),
    email: input({ name: 'email', type: 'email', required: true, value: pre.email || '' }), pw: input({ name: 'pw', type: 'password', autocomplete: 'new-password', required: true }),
    cap: input({ name: 'cap', type: 'number', min: 10, max: 100000, value: 500 }),
    billing: h('select', { name: 'billing' }, h('option', { value: 'trial' }, '14-day free trial, then they pay'), h('option', { value: 'comped' }, 'Free (no charge)')),
  };
  const picks = new Map();
  const checks = apps.map((a) => { const cb = h('input', { type: 'checkbox' }); cb.checked = true; picks.set(a.key, cb); return h('label', { class: 'check' }, cb, a.label); });
  f.name.addEventListener('input', () => { if (!f.slug.dataset.touched) f.slug.value = f.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); });
  f.slug.addEventListener('input', () => { f.slug.dataset.touched = '1'; });
  formDialog('Add a mountain', h('div', { class: 'stack' },
    field('Mountain name', f.name), field('Web name', f.slug, 'Lowercase letters, numbers and dashes. People type this to sign in.'), field('Time zone', f.tz),
    h('div', { class: 'grid2' }, field('Owner first name', f.first), field('Owner last name', f.last)), field('Owner email', f.email), field('Owner password', f.pw, 'At least 10 characters.'),
    field('Document storage limit (MB)', f.cap), field('Billing', f.billing, 'You can change this later on the mountain\'s Manage page.'), h('fieldset', { class: 'stack tight' }, h('legend', null, 'Apps to turn on'), ...checks)), async () => {
    const modules = Object.fromEntries([...picks].map(([k, cb]) => [k, cb.checked]));
    const made = await call('POST', '/tenants', { slug: f.slug.value.trim(), name: f.name.value.trim(), timezone: f.tz.value.trim(), storage_cap_mb: Number(f.cap.value), modules, billing: f.billing.value,
      owner: { email: f.email.value.trim(), password: f.pw.value, first_name: f.first.value.trim(), last_name: f.last.value.trim() } });
    toast('Mountain added.'); if (after) await after(made); home();
  }, { submitText: 'Add mountain', wide: true });
  if (pre.name) f.name.dispatchEvent(new Event('input'));
}

// ---------------------------------------------------------------- website leads: walkthrough and trial requests from the Contact page
function leadsButton() {
  const b = button('Leads', () => leads(), { small: true });
  call('GET', '/leads?status=new').then((r) => { if (r.new_count) b.append(' ', badge(String(r.new_count), 'warn')); }).catch(() => {});
  return b;
}
const LEAD_KIND = { walkthrough: 'Walkthrough', trial: 'Trial', founding: 'Founding group', question: 'Question' };
const LEAD_STATUS = [['new', 'New'], ['contacted', 'Contacted'], ['trial', 'On a trial'], ['won', 'Paying'], ['lost', 'Not now']];
async function leads() {
  let r;
  try { r = await call('GET', '/leads'); } catch (ex) { fail(ex); return; }
  const dlg = dialog('Leads from the website', r.data.length ? h('div', { class: 'stack' },
    h('p', { class: 'hint' }, 'Requests sent from the Contact page, newest first. Each was also emailed to SITE_CONTACT_EMAIL when email is set up.'),
    table([
      { head: 'When', cell: (l) => dayTime(l.created_at) },
      { head: 'Who', cell: (l) => h('span', null, h('b', null, l.mountain), h('br'), `${l.name}${l.role ? `, ${l.role}` : ''}`, h('br'), h('a', { href: `mailto:${l.email}` }, l.email), l.phone ? ` ${l.phone}` : '') },
      { head: 'Wants', cell: (l) => h('span', null, LEAD_KIND[l.kind] || l.kind, l.founding && l.kind !== 'founding' ? ', founding group' : '', l.plan_interest ? h('span', { class: 'muted small' }, ` (${l.plan_interest})`) : null, l.lifts ? h('span', { class: 'muted small' }, `, ${l.lifts} lifts`) : null, l.message ? h('p', { class: 'small' }, l.message) : null) },
      { head: 'Status', cell: (l) => { const sel = h('select', { 'aria-label': `Status for ${l.mountain}`, style: 'min-width:9.5em' }, ...LEAD_STATUS.map(([v, t]) => { const o = h('option', { value: v }, t); o.selected = l.status === v; return o; })); sel.addEventListener('change', async () => { try { await call('PATCH', `/leads/${l.id}`, { status: sel.value }); toast('Saved.'); } catch (ex) { fail(ex); } }); return h('span', null, sel, l.slug ? h('div', { class: 'small muted' }, `Mountain: ${l.slug}`) : null, l.operator_note ? h('div', { class: 'small' }, l.operator_note) : null); } },
      { actions: true, cell: (l) => h('span', { class: 'row' }, ...[
        !l.tenant_id ? button('Make their mountain', () => { const [first, ...rest] = l.name.split(' '); addMountain({ name: l.mountain, email: l.email, first, last: rest.join(' ') || first }, async (made) => { await call('PATCH', `/leads/${l.id}`, { tenant_id: made.id, status: 'trial' }); dlg.close(); }); }, { small: true }) : null,
        button('Note', () => { const n = input({ name: 'note', maxlength: 1000, value: l.operator_note || '' }); formDialog(`Note on ${l.mountain}`, field('Your note', n, 'Only operators see this.'), async () => { await call('PATCH', `/leads/${l.id}`, { operator_note: n.value.trim() || null }); toast('Saved.'); dlg.close(); leads(); }); }, { small: true }),
      ].filter(Boolean)) },
    ], r.data)) : empty('No requests yet. They appear here when someone sends the form on the Contact page.'), { wide: true });
}

// ---------------------------------------------------------------- billing: plans, prices and each mountain's subscription
const dollars = (c) => `$${(Number(c || 0) / 100).toFixed(2).replace(/\.00$/, '')}`;
const BILL_WORDS = { comped: 'Free', subscribed: 'Paying', cancelling: 'Cancelling', paid_manually: 'Paid manually', trial: 'Trial', payment_failed: 'Payment failed', trial_ended: 'Trial ended', paid_time_ended: 'Paid time ended', canceled: 'Cancelled' };
function billBadge(b) {
  if (!b) return '';
  const text = `${BILL_WORDS[b.kind] || b.kind}${b.kind === 'trial' && b.days_left != null ? `, ${b.days_left} days left` : ''}${b.read_only ? ', read only' : b.state === 'grace' ? `, grace to ${b.until}` : ''}`;
  return h('span', null, badge(text, b.read_only ? 'bad' : b.state === 'grace' ? 'warn' : b.kind === 'comped' ? '' : 'ok'), b.plan ? h('span', { class: 'muted small' }, ` ${b.plan}${b.interval === 'year' ? ', yearly' : ''}`) : null);
}

async function billingPlans() {
  let r;
  try { r = await call('GET', '/billing/plans'); } catch (ex) { fail(ex); return; }
  const body = h('div', { class: 'stack' });
  const dlg = dialog('Plans and prices', body, { wide: true });
  const reload = async () => { dlg.close(); await billingPlans(); };
  const appName = (k) => (r.modules.find((m) => m.key === k) || { label: k }).label;
  const rowsOf = (kind) => r.data.filter((p) => p.kind === kind);
  const synced = (p) => (p.stripe_product && (!p.monthly_cents || (p.stripe_month && Number(p.stripe_month_cents) === p.monthly_cents)) && (!p.yearly_cents || (p.stripe_year && Number(p.stripe_year_cents) === p.yearly_cents)));
  const list = (kind) => (rowsOf(kind).length ? table([
    { head: 'Name', cell: (p) => h('span', null, h('b', null, p.name), h('span', { class: 'muted' }, ` ${p.code}`), p.active ? null : h('span', null, ' ', badge('Hidden', 'warn'))) },
    { head: 'Monthly', num: true, cell: (p) => (p.monthly_cents ? dollars(p.monthly_cents) : '') },
    { head: 'Yearly', num: true, cell: (p) => (p.yearly_cents ? dollars(p.yearly_cents) : '') },
    { head: kind === 'plan' ? 'Apps' : 'App', cell: (p) => p.modules.map(appName).join(', ') },
    { head: 'Stripe', cell: (p) => (synced(p) ? badge('Ready', 'ok') : badge('Not synced', 'warn')) },
    { actions: true, cell: (p) => h('span', { class: 'row' }, button('Edit', () => planForm(p, r, reload), { small: true }), r.stripe ? button('Sync to Stripe', async () => { await call('POST', `/billing/plans/${p.id}/sync`); toast('Synced with Stripe.'); await reload(); }, { small: true }) : null) },
  ], rowsOf(kind)) : empty(kind === 'plan' ? 'No plans yet. Add one so mountains can pay.' : 'No add-ons.'));
  body.append(
    r.stripe ? h('p', { class: 'hint' }, 'Mountains see active plans on Settings, Billing. Prices are in US dollars. Changing a price makes a new Stripe price for new subscribers; current subscribers keep theirs until you move them.')
      : h('p', { class: 'hint' }, 'Stripe is not set up on this service (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET), so mountains cannot pay online yet. You can still set plans, and mark mountains paid or free.'),
    h('div', { class: 'row between' }, h('h3', null, 'Plans'), button('Add a plan', () => planForm({ kind: 'plan' }, r, reload), { small: true, kind: 'primary' })), list('plan'),
    h('div', { class: 'row between' }, h('h3', null, 'Add-ons'), button('Add an add-on', () => planForm({ kind: 'addon' }, r, reload), { small: true })), list('addon'));
}

function planForm(p, r, done) {
  const isNew = !p.id; const addon = p.kind === 'addon';
  const f = {
    name: input({ name: 'name', required: true, maxlength: 100, value: p.name || '' }),
    code: input({ name: 'code', required: true, maxlength: 40, pattern: '[a-z0-9_-]{2,40}', value: p.code || '', disabled: !isNew }),
    blurb: input({ name: 'blurb', maxlength: 500, value: p.blurb || '' }),
    monthly: input({ name: 'monthly', type: 'number', min: 0, step: '0.01', value: p.monthly_cents ? (p.monthly_cents / 100).toFixed(2) : '' }),
    yearly: input({ name: 'yearly', type: 'number', min: 0, step: '0.01', value: p.yearly_cents ? (p.yearly_cents / 100).toFixed(2) : '' }),
    sort: input({ name: 'sort', type: 'number', min: 0, max: 999, value: p.sort ?? 0 }),
    active: h('input', { type: 'checkbox' }),
  };
  f.active.checked = p.active !== false;
  if (isNew) f.name.addEventListener('input', () => { if (!f.code.dataset.touched) f.code.value = f.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40); });
  f.code.addEventListener('input', () => { f.code.dataset.touched = '1'; });
  const have = new Set(p.modules || []);
  const picks = r.modules.map((m) => { const cb = h('input', { type: addon ? 'radio' : 'checkbox', name: 'apps', value: m.key }); cb.checked = have.has(m.key); return h('label', { class: 'check' }, cb, m.label); });
  const cents = (el) => Math.round(Number(el.value || 0) * 100);
  formDialog(isNew ? (addon ? 'Add an add-on' : 'Add a plan') : `Edit ${p.name}`, h('div', { class: 'stack' },
    field('Name', f.name, 'What mountains see, such as Base, Full mountain or Patrol only'), field('Code', f.code, isNew ? 'Lowercase letters, numbers and dashes. It cannot change later.' : 'Cannot change.'),
    field('Short description', f.blurb), h('div', { class: 'grid2' }, field('Monthly price ($)', f.monthly, 'Leave empty if not offered monthly'), field('Yearly price ($)', f.yearly, 'Leave empty if not offered yearly')),
    field('Order on the page', f.sort, 'Lower numbers show first'), h('label', { class: 'check' }, f.active, 'Show to mountains'),
    h('fieldset', { class: 'stack tight' }, h('legend', null, addon ? 'The app this add-on turns on' : 'Apps in this plan'), ...picks)), async () => {
    const modules = picks.map((l) => l.querySelector('input')).filter((cb) => cb.checked).map((cb) => cb.value);
    if (!cents(f.monthly) && !cents(f.yearly)) throw new Error('Give a monthly or yearly price');
    const body = { name: f.name.value.trim(), blurb: f.blurb.value.trim() || null, monthly_cents: cents(f.monthly), yearly_cents: cents(f.yearly), sort: Number(f.sort.value || 0), active: f.active.checked, modules };
    if (isNew) await call('POST', '/billing/plans', { ...body, code: f.code.value.trim(), kind: p.kind });
    else await call('PATCH', `/billing/plans/${p.id}`, body);
    toast('Saved.'); await done();
  }, { submitText: 'Save', wide: true });
}

function billingPanel(t, done) {
  const b = t.billing || {}; const s = t.billing_standing || {};
  const words = s.kind === 'trial' ? `Trial to ${s.until}` : s.kind === 'subscribed' ? `Paying through Stripe${b.pay_method ? ` by ${b.pay_method}` : ''}, renews ${String(b.period_end || '').slice(0, 10)}` : s.kind === 'paid_manually' ? `Paid through ${s.until}` : s.kind === 'comped' ? 'Free (no charge)' : `${BILL_WORDS[s.kind] || s.kind}${s.read_only ? '. Read only.' : s.until ? `. Grace until ${s.until}.` : ''}`;
  return h('div', { class: 'stack tight' },
    h('p', null, billBadge({ ...s, plan: null }), ' ', words),
    b.stripe_customer_id ? h('p', { class: 'small muted' }, `Stripe customer ${b.stripe_customer_id}${b.stripe_subscription_id ? `, subscription ${b.stripe_subscription_id} (${b.sub_status})` : ''}`) : null,
    b.notes ? h('p', { class: 'small' }, `Notes: ${b.notes}`) : null,
    h('div', { class: 'row' }, button('Change billing', () => billingForm(t, done), { small: true })),
    (t.billing_events || []).length ? h('details', null, h('summary', null, 'Billing history'), ...t.billing_events.slice(0, 15).map((e) => h('p', { class: 'small muted' }, `${String(e.at).replace('T', ' ').slice(0, 16)}  ${e.kind}${e.by_operator ? ` (${e.by_operator})` : ''}  ${e.detail || ''}`))) : null);
}

async function billingForm(t, done) {
  let r;
  try { r = await call('GET', '/billing/plans'); } catch (ex) { fail(ex); return; }
  const b = t.billing || {};
  const opt = (v, text, on) => { const o = h('option', { value: String(v) }, text); o.selected = Boolean(on); return o; };
  const plan = h('select', { name: 'plan' }, opt('', 'None chosen', !b.plan_id), ...r.data.filter((p) => p.kind === 'plan' && (p.active || Number(b.plan_id) === p.id)).map((p) => opt(p.id, `${p.name} (${dollars(p.monthly_cents)}/mo, ${dollars(p.yearly_cents)}/yr)`, Number(b.plan_id) === p.id)));
  const interval = h('select', { name: 'interval' }, opt('month', 'Monthly', b.billing_interval !== 'year'), opt('year', 'Yearly', b.billing_interval === 'year'));
  const addonBoxes = r.data.filter((p) => p.kind === 'addon' && (p.active || (b.addons || []).includes(p.id))).map((p) => { const cb = h('input', { type: 'checkbox', value: String(p.id) }); cb.checked = (b.addons || []).includes(p.id); return h('label', { class: 'check' }, cb, p.name); });
  const comped = h('input', { type: 'checkbox' }); comped.checked = t.billing ? Boolean(b.comped) : true;
  const trial = input({ name: 'trial', type: 'date', value: b.trial_ends_on || '' });
  const paid = input({ name: 'paid', type: 'date', value: b.paid_until || '' });
  const email = input({ name: 'email', type: 'email', maxlength: 255, value: b.billing_email || '' });
  const notes = input({ name: 'notes', maxlength: 500, value: b.notes || '' });
  const applyApps = h('input', { type: 'checkbox' });
  formDialog(`Billing for ${t.name}`, h('div', { class: 'stack' },
    h('label', { class: 'check' }, comped, 'Free: this mountain is never charged'),
    h('div', { class: 'grid2' }, field('Plan', plan), field('Billing period', interval)),
    addonBoxes.length ? h('fieldset', { class: 'stack tight' }, h('legend', null, 'Add-ons'), ...addonBoxes) : null,
    h('div', { class: 'grid2' }, field('Trial ends', trial, 'Extend a trial by moving this date'), field('Paid until', paid, 'For a payment taken outside Stripe, such as a check')),
    field('Billing email', email), field('Notes', notes, 'Only operators see this'),
    h('label', { class: 'check' }, applyApps, 'Also set the mountain\'s apps to match the plan and add-ons now')), async () => {
    await call('PUT', `/tenants/${t.id}/billing`, {
      comped: comped.checked, plan_id: plan.value ? Number(plan.value) : null, interval: interval.value,
      addons: addonBoxes.map((l) => l.querySelector('input')).filter((cb) => cb.checked).map((cb) => Number(cb.value)),
      trial_ends_on: trial.value || null, paid_until: paid.value || null, billing_email: email.value.trim() || null, notes: notes.value.trim() || null, apply_apps: applyApps.checked,
    });
    toast('Billing saved.'); done();
  }, { submitText: 'Save', wide: true });
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
    stat(summary.made_changes, 'Made changes', pct(summary.made_changes)),
    stat(summary.took_tour || 0, 'Took a guided tour', pct(summary.took_tour || 0))));

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
      { head: 'Tours', cell: (x) => (x.tours && x.tours.length ? h('span', { title: x.tours.map((t) => `${TOUR_NAMES[t.tour] || t.tour}: ${t.finished ? 'finished' : `step ${t.steps_seen} of ${t.steps_total}`}`).join('\n') }, `${x.tours.filter((t) => t.finished).length} of ${x.tours.length} finished`) : h('span', { class: 'muted' }, 'None')) },
      { head: 'Apps used', cell: (x) => (x.apps.length ? x.apps.slice(0, 3).map((a) => a.label).join(', ') + (x.apps.length > 3 ? ` +${x.apps.length - 3}` : '') : h('span', { class: 'muted' }, 'None yet')) },
      { actions: true, cell: (x) => (x.status !== 'removed' ? button('Delete', () => remove(x), { small: true }) : '') },
    ], rows.slice(0, limit)), more);
  };
  q.addEventListener('input', () => { limit = 50; draw(); });
  drawFilters(); draw();

  const csv = () => {
    const cols = ['at', 'name', 'email', 'mountain', 'status', 'last_used_at', 'sign_ins', 'requests', 'changes', 'apps', 'tours'];
    const cell = (v) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(t)) t = `'${t}`; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [cols.join(','), ...data.map((x) => cols.map((c) => cell(c === 'apps' ? x.apps.map((a) => a.label).join('; ') : c === 'tours' ? (x.tours || []).map((t) => `${t.tour} ${t.finished ? 'finished' : `${t.steps_seen}/${t.steps_total}`}`).join('; ') : x[c])).join(','))];
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

/** What is live, every version that has started, and the full change log (including the notes only the console sees). */
async function releases() {
  try {
    const r = await call('GET', '/releases');
    const when = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');
    const who = { null: 'Everyone', platform: 'Console only' };
    dialog('Releases', h('div', { class: 'stack' },
      h('p', null, h('b', null, `Live: ${r.version}`), ` build ${r.build}${r.built_at ? `, made ${when(r.built_at)}` : ''}`),
      h('h3', null, 'Deploy history'),
      r.deploys.length ? table([{ head: 'Version', cell: (d) => h('b', null, d.version) }, { head: 'Build', cell: (d) => d.build }, { head: 'First started', cell: (d) => when(d.first_started_at) }, { head: 'Last started', cell: (d) => when(d.last_started_at) }, { head: 'Deployed by', cell: (d) => d.deployed_by || '' }], r.deploys)
        : empty('Nothing recorded yet. Each version is recorded when it first starts.'),
      h('h3', null, 'Change log'),
      ...r.releases.map((x) => h('section', { class: 'stack tight' }, h('h4', null, `${x.version}, ${x.date}${x.title ? `: ${x.title}` : ''}`),
        table([{ head: 'Kind', cell: (n) => n.kind }, { head: 'App', cell: (n) => n.app || '' }, { head: 'Who sees it', cell: (n) => (Array.isArray(n.who) ? n.who.join(', ') : who[String(n.who)]) }, { head: 'Note', cell: (n) => n.text }], x.notes)))),
    { wide: true });
  } catch (ex) { fail(ex); }
}

async function activity() {
  try {
    const { data } = await call('GET', '/audit');
    dialog('Recent activity', data.length ? table([{ head: 'When', cell: (x) => String(x.at).replace('T', ' ').slice(0, 16) }, { head: 'Mountain', cell: (x) => x.slug || '' }, { head: 'Who', cell: (x) => x.actor || '' }, { head: 'What', cell: (x) => x.action }, { head: 'Details', cell: (x) => x.detail || '' }], data) : empty('Nothing yet.'), { wide: true });
  } catch (e) { fail(e); }
}

// ---------------------------------------------------------------- operators: who can use this console
const newPassword = () => input({ type: 'password', name: 'password', autocomplete: 'new-password', required: true, minlength: 10, maxlength: 200 });

async function operators() {
  clear(app);
  const body = h('div', { class: 'stack' });
  app.append(h('main', { class: 'platform-box wide stack' },
    h('header', { class: 'row between' },
      h('div', { class: 'stack tight' }, h('h1', null, 'Operators'), h('p', { class: 'muted' }, 'The people who can use this console. Each signs in with their own email, password and authenticator app.')),
      h('div', { class: 'row' }, button('Add an operator', () => addOperator(), { kind: 'primary' }), button('Back to mountains', () => home(), { small: true }))),
    body));
  let data;
  try { ({ data } = await call('GET', '/operators')); } catch (ex) { if (ex.status === 403) signIn('Your session ended. Sign in again.'); else body.append(errorBox(ex)); return; }
  if (!data.length) {
    body.append(h('div', { class: 'callout' }, h('b', null, 'No operators yet. '), 'Add yourself first: your email, your name and a password. Then sign out and sign in with your email; it walks you through setting up your authenticator app.'));
    return;
  }
  const act = (label, fn, opts) => button(label, fn, { small: true, ...opts });
  body.append(table([
    { head: 'Name', cell: (o) => h('span', null, h('b', null, o.name), o.you ? h('span', { class: 'muted' }, ' (you)') : null) },
    { head: 'Email', cell: (o) => o.email },
    { head: 'Status', cell: (o) => (!o.active ? state('Switched off', 'neutral') : o.locked ? state('Locked for a few minutes', 'warn') : state('Active', 'good')) },
    { head: 'Two-step', cell: (o) => (o.two_step ? 'On' : 'Set up at next sign-in') },
    { head: 'Last sign-in', cell: (o) => (o.last_login_at ? ago(o.last_login_at) : 'Never') },
    { actions: true, cell: (o) => (o.you ? '' : h('div', { class: 'row' },
      act('New password', () => formDialog(`New password for ${o.name}`, h('div', { class: 'form' }, field('New password', newPassword(), 'At least 10 characters. Tell them in person or by phone; they can change it after signing in.')), async (fd) => {
        await call('POST', `/operators/${o.id}/password`, { password: fd.get('password') }); toast('Password changed. Their open sessions have ended.'); operators();
      }, { submitText: 'Set password' })),
      o.two_step ? act('Reset two-step', () => confirmDialog(`Reset two-step for ${o.name}?`, 'Use this when they have lost their phone. They set up their authenticator app again the next time they sign in. Their open sessions end now.', 'Reset two-step', async () => {
        try { await call('POST', `/operators/${o.id}/reset-two-step`); toast('Two-step reset.'); operators(); } catch (e) { fail(e); }
      }, { danger: true })) : null,
      act(o.active ? 'Switch off' : 'Switch on', () => (o.active
        ? confirmDialog(`Switch off ${o.name}?`, 'They can no longer sign in, and any open session ends now. You can switch them back on later.', 'Switch off', async () => {
          try { await call('POST', `/operators/${o.id}/active`, { active: false }); toast('Switched off.'); operators(); } catch (e) { fail(e); }
        }, { danger: true })
        : call('POST', `/operators/${o.id}/active`, { active: true }).then(() => { toast('Switched on.'); operators(); }, fail))))) },
  ], data));
  if (!me.operator) body.append(h('p', { class: 'muted' }, 'You are signed in with the platform key. Once your own login works, you can turn key sign-in off (RUNBOOK.md, "Platform console").'));
}

function addOperator() {
  formDialog('Add an operator', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100, autocomplete: 'off' }), 'Shown in the Activity log next to everything they do.'),
    field('Email', input({ name: 'email', type: 'email', required: true, maxlength: 255, autocomplete: 'off' }), 'What they sign in with.'),
    field('First password', newPassword(), 'At least 10 characters. They set up their authenticator app the first time they sign in, then can change this.')), async (fd) => {
    await call('POST', '/operators', { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') });
    toast('Operator added.'); operators();
  }, { submitText: 'Add operator' });
}

function myPassword() {
  formDialog('Change my password', h('div', { class: 'form' },
    field('Current password', input({ type: 'password', name: 'current', autocomplete: 'current-password', required: true, maxlength: 200 })),
    field('New password', newPassword(), 'At least 10 characters.')), async (fd) => {
    const out = await call('POST', '/me/password', { current: fd.get('current'), password: fd.get('password') });
    session = out.session; toast('Password changed.');
  }, { submitText: 'Change password' });
}

signIn();

// ---------------------------------------------------------------- injury network report
// De-identified injury counts across the mountains that share, for the National Ski Patrol, NSAA and researchers.
// Counts from 1 to 4 (and one more where needed) come back from the server already hidden; this page only shows them.
const seasonNow = () => { const d = new Date(); const y = d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; };
const TOUR_NAMES = { morning: 'Morning', sell: 'Sell', gate: 'Gate and RFID', patrol: 'Patrol', staff: 'Staff', assets: 'Assets', waivers: 'Waivers' };
const shown = (c) => (c.hidden ? 'Not shown' : String(c.n));

async function injuryReport(query = { season: seasonNow(), region: '' }) {
  clear(app);
  const body = h('div', { class: 'stack' });
  const y = Number(seasonNow().slice(0, 4));
  const seasons = [0, 1, 2, 3].map((k) => `${y - k}-${String((y - k + 1) % 100).padStart(2, '0')}`);
  const seasonSel = h('select', { 'aria-label': 'Season' }, seasons.map((s) => h('option', { value: s, selected: s === query.season }, `${s} season`)));
  const regionSel = h('select', { 'aria-label': 'Region' }, h('option', { value: '' }, 'All regions'));
  const qs = () => `season=${encodeURIComponent(query.season)}${query.region ? `&region=${query.region}` : ''}`;
  const csv = button('Download spreadsheet', async () => {
    const res = await fetch(`/api/v1/platform/safety.csv?${qs()}`, { headers: { 'x-platform-session': session } });
    if (!res.ok) { let m = 'Could not download'; try { m = (await res.json()).error || m; } catch (_) { /* not JSON */ } throw new Error(m); }
    const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `injury-network-${query.season}${query.region ? `-${query.region}` : ''}.csv` });
    document.body.append(a); a.click(); a.remove();
  }, { small: true });
  app.append(h('main', { class: 'platform-box wider stack injury-report' },
    h('header', { class: 'row between no-print' },
      h('div', { class: 'stack tight' }, h('h1', null, 'Injury network'), h('p', { class: 'muted' }, 'De-identified injury counts from the mountains that share. For the National Ski Patrol, NSAA and safety researchers.')),
      h('div', { class: 'row' }, button('Back to mountains', () => home(), { small: true }), button('Who shares', () => sharingList(), { small: true }), csv, button('Print', () => window.print(), { small: true }))),
    h('div', { class: 'row no-print' }, seasonSel, regionSel),
    body));
  seasonSel.addEventListener('change', () => injuryReport({ ...query, season: seasonSel.value }));
  regionSel.addEventListener('change', () => injuryReport({ ...query, region: regionSel.value }));

  body.append(h('p', { class: 'loading' }, 'Loading…'));
  let r;
  try { r = await call('GET', `/safety?${qs()}`); } catch (ex) { clear(body); if (ex.status === 403) signIn('Your session ended. Sign in again.'); else body.append(errorBox(ex)); return; }
  clear(body);
  for (const g of r.regions_list) regionSel.append(h('option', { value: g.value, selected: g.value === query.region }, g.label));
  const where = query.region ? (r.regions_list.find((g) => g.value === query.region) || {}).label : 'All regions';
  body.append(h('p', { class: 'print-only' }, `Injury network, ${r.period.from} to ${r.period.to}, ${where}.`));
  if (r.period.partial) body.append(h('p', { class: 'muted' }, `This season so far, to the end of the last full month (${r.period.to}). Reports for a season in progress stop at a month end, so two downloads cannot be compared to give one week.`));
  if (r.empty_period) { body.append(empty('The season has no full month yet.')); return; }
  if (r.too_few_mountains) { body.append(empty(r.reason === 'rest_of_network' ? 'A region is shown on its own only when the rest of the network is none or at least 3 mountains. Otherwise the two reports together would show one or two mountains.' : `Nothing is shown until at least ${r.rules.min_mountains} mountains share${query.region ? ' in this region' : ''}. ${r.mountains.sharing} so far.`)); return; }

  const fig = (value, name, note) => h('div', { class: 'figure' }, h('strong', null, value === null || value === undefined ? '—' : String(value)), h('span', null, name), note ? h('em', null, note) : null);
  body.append(h('div', { class: 'figures' },
    fig(r.mountains.sharing, 'Mountains', `${r.mountains.named} named, ${r.mountains.anonymous} anonymous`),
    fig(r.hidden ? 'Not shown' : r.patients, 'Patients counted'),
    fig(r.visits ? `About ${r.visits.toLocaleString()}` : null, 'Skier visits', `At the ${r.mountains.with_visits} mountains that scan tickets, to the nearest 1,000`),
    fig(r.per_1000, 'Patients per 1,000 visits', r.per_1000 === null ? 'Needs 3 mountains with gate scans, and none or 3 without' : 'Those mountains only')));
  body.append(h('p', { class: 'muted small' }, `Left out, as in NSAA injury studies: ${r.excluded.map((e) => `${e.label.toLowerCase()} (${e.hidden ? 'not shown' : e.n})`).join('; ')}. `,
    `Counts from 1 to ${r.rules.min_cell - 1} are not shown, nor other counts in the same list where needed so that none can be worked out. Only reports that were submitted or approved, and not entered in error, are counted. Rates per category appear only when every mountain scans tickets.`));
  if (r.hidden || !r.breakdowns) return;

  const list = (b) => h('section', { class: 'panel stack' }, h('h3', null, b.title),
    table([{ head: '', cell: (c) => c.label }, { head: 'Patients', num: true, cell: shown }, { head: '%', num: true, cell: (c) => (c.pct === null ? '' : `${c.pct}%`) }, { head: 'Per 1,000 visits', num: true, cell: (c) => (c.per_1000 === null ? '' : String(c.per_1000)) }],
      b.cells.filter((c) => c.n !== 0)),
    b.recorded_pct !== null && b.recorded_pct < 100 ? h('p', { class: 'muted small' }, `Recorded on ${b.recorded_pct}% of reports.`) : null);
  const inj = r.injuries;
  const grid = !inj ? null : h('section', { class: 'panel stack wide-panel' }, h('h3', null, `Injuries by body area and type (${inj.total} injuries)`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, h('th', null, ''), inj.types.map((t) => h('th', { scope: 'col' }, t.label)))),
      h('tbody', null, inj.body.map((b, i) => h('tr', null, h('th', { scope: 'row' }, b.label), inj.cells[i].map((n) => h('td', { class: 'num' }, n === null ? '·' : n === 0 ? '' : String(n)))))))),
    h('p', { class: 'muted small' }, '· not shown. A patient can have more than one injury. Row and column totals are left out: with them, hidden counts could be worked out.'));
  body.append(...(grid ? [grid] : []), h('div', { class: 'two-col' }, Object.values(r.breakdowns).map(list)));

  if (r.regions.length) body.append(h('section', { class: 'panel stack' }, h('h3', null, 'By region'), table([
    { head: 'Region', cell: (g) => g.label }, { head: 'Mountains', num: true, cell: (g) => String(g.mountains) },
    { head: 'Patients', num: true, cell: (g) => (g.too_few_mountains ? 'Not shown: too few mountains' : g.patients === null ? 'Not shown' : String(g.patients)) },
    { head: 'Per 1,000 visits', num: true, cell: (g) => (g.per_1000 === null || g.per_1000 === undefined ? '' : String(g.per_1000)) }], r.regions),
    h('p', { class: 'muted small' }, 'A region is shown with at least 3 sharing mountains, and only when the mountains outside the shown regions are none or at least 3.')));
  if (r.named.length) body.append(h('section', { class: 'panel stack' }, h('h3', null, 'Taking part, and agreed to be named'), table([
    { head: 'Mountain', cell: (m) => m.name }, { head: 'State or province', cell: (m) => m.state || '' }, { head: 'Region', cell: (m) => m.region || '' }], r.named),
    h('p', { class: 'muted small' }, `And ${r.mountains.anonymous} more taking part without being named. No mountain's own counts are shown.`)));
}

async function sharingList() {
  let data;
  try { ({ data } = await call('GET', '/safety/members')); } catch (ex) { fail(ex); return; }
  const day = (s) => (s ? String(s).slice(0, 10) : '');
  dialog('Who shares', data.length ? table([
    { head: 'Mountain', cell: (m) => m.name },
    { head: 'Sharing', cell: (m) => (m.share ? (m.named ? badge('Named', 'ok') : badge('Anonymous', 'ok')) : badge('Stopped', 'warn')) },
    { head: 'Region', cell: (m) => [m.region, m.state].filter(Boolean).join(', ') },
    { head: 'Agreed by', cell: (m) => [m.agreed_name, m.agreed_title].filter(Boolean).join(', ') },
    { head: 'On', cell: (m) => day(m.agreed_at) },
    { head: 'Terms', cell: (m) => (m.current_terms ? `Version ${m.agreement_version}` : `Old version ${m.agreement_version || ''}`) },
  ], data) : empty('No mountain has chosen to share yet. The patrol director turns it on in Patrol, Cases, Injury network.'), { wide: true });
}
