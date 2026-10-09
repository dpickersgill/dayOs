import { get, post, put, patch, del } from '../api.js';
import { h, clear, table, state, input, field, button, toast, formDialog, confirmDialog, dialog, errorBox, empty, val, todayStr, addDays, fmtDateTime } from '../ui.js';
import { qr } from '../barcode.js';
import { printDialog } from '../print.js';

const hrs = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const METHOD = { login: 'Sign-in', pin: 'PIN', badge: 'Badge', manager: 'Manager' };

/** The Kiosk tab on the Workforce page: tablets, people's PINs and badges, snapshot settings, and punch review. */
export async function drawKiosk(box) {
  const data = await get('/kiosk-admin/overview');
  const mountainName = (data.mountain && data.mountain.name) || '';
  const body = h('div', { class: 'stack' });
  clear(box).append(body);

  async function reload() {
    const fresh = await get('/kiosk-admin/overview');
    data.devices = fresh.devices; data.people = fresh.people; data.settings = fresh.settings;
    draw();
  }

  function draw() {
    clear(body).append(
      h('p', { class: 'muted' }, 'A kiosk is a shared tablet by the door. People tap their name and enter a PIN, or scan a badge, to clock in and out. Nobody needs a login.'),
      tabletsPanel(), peoplePanel(), settingsPanel(), punchesPanel(),
    );
  }

  // ------------------------------------------------------------ tablets
  function pairDialog(res, title) {
    const link = res.link;
    const shown = res.code;
    dialog(title, h('div', { class: 'stack' },
      h('p', null, `On the tablet, open this page in Chrome and enter the code. It works once and expires in ${res.expires_in_minutes} minutes.`),
      h('p', { class: 'kiosk-link' }, h('strong', null, link.replace(/\/[A-Z0-9]+$/, ''))),
      h('div', { class: 'pair-code', 'data-pair-code': '' }, shown),
      h('div', { class: 'qr-box' }, qr(link, { size: 180 }), h('p', { class: 'muted small' }, 'Or scan this with the tablet camera to pair it directly.')),
    ));
  }

  function tabletsPanel() {
    const add = button('Add a tablet', () => {
      formDialog('Add a tablet', field('Name', input({ name: 'name', required: true, placeholder: 'Employee entrance' }), 'Shown in the list and on punch records.'), async (fd) => {
        const res = await post('/kiosk-admin/devices', { name: val(fd, 'name') });
        await reload();
        pairDialog(res, `Pair ${res.name}`);
      }, { submitText: 'Create pairing code' });
    }, { kind: 'primary' });
    const list = data.devices.length ? table([
      { head: 'Tablet', cell: (d) => d.name },
      { head: 'Status', cell: (d) => (!d.active ? state('Turned off', 'bad') : d.paired ? state('Paired', 'good') : d.waiting ? state('Waiting for code', 'warn') : state('Not paired', 'neutral')) },
      { head: 'Last used', cell: (d) => (d.last_seen_at ? fmtDateTime(d.last_seen_at) : 'Never') },
      { head: '', actions: true, cell: (d) => h('span', { class: 'row' },
        button(d.paired || d.waiting ? 'Pair again' : 'Get code', async () => { const r = await post(`/kiosk-admin/devices/${d.id}/pair-code`, {}); await reload(); pairDialog(r, `Pair ${d.name}`); }, { small: true }),
        button(d.active ? 'Turn off' : 'Turn on', async () => { await patch(`/kiosk-admin/devices/${d.id}`, { active: !d.active }); await reload(); }, { small: true }),
        button('Remove', () => confirmDialog('Remove tablet', `Remove ${d.name}? It stops working right away. Past punches keep their record.`, 'Remove', async () => { await del(`/kiosk-admin/devices/${d.id}`); await reload(); }, { danger: true }), { small: true, kind: 'quiet-danger' })) },
    ], data.devices) : empty('No tablets yet. Add one, then open the pairing link on the tablet.');
    return h('section', { class: 'panel stack', 'data-kiosk': 'tablets' }, h('div', { class: 'row between' }, h('h3', null, 'Tablets'), add), list);
  }

  // ------------------------------------------------------------ people
  function pinDialog(p) {
    const pin = input({ name: 'pin', inputmode: 'numeric', autocomplete: 'off', maxlength: 6, pattern: '[0-9]*', placeholder: 'Leave blank for a random PIN' });
    formDialog(`PIN for ${p.name}`, field('PIN (4 to 6 digits)', pin, 'Not 1234, 1111 and similar. It cannot be read back later, only replaced.'), async (fd) => {
      const res = await put(`/kiosk-admin/people/${p.staff_id}/pin`, { pin: val(fd, 'pin') || undefined });
      await reload();
      dialog(`PIN for ${p.name}`, h('div', { class: 'stack' }, h('p', null, 'Give them this PIN now. It is not shown again.'), h('div', { class: 'pair-code', 'data-new-pin': '' }, res.pin)));
    }, { submitText: 'Save PIN' });
  }

  async function badges(ids, title) {
    const { data: list } = await post('/kiosk-admin/badges', { staff_ids: ids });
    if (!list.length) { toast('No one to print', 'error'); return; }
    printDialog(title, h('div', { class: 'badge-grid' }, list.map((b) => badgeCard(b))));
    await reload();
  }
  const badgeCard = (b) => h('div', { class: 'sheet badge-card', 'data-badge': b.code }, h('strong', null, mountainName || 'Staff badge'), qr(b.code, { size: 150 }), h('span', { class: 'badge-name' }, b.name), h('small', null, 'Scan at the time clock'));

  function peoplePanel() {
    const ready = data.people.filter((p) => p.pin_set).length;
    const printAll = button('Print all badges', () => badges(data.people.map((p) => p.staff_id), 'Staff badges'), { small: true });
    const rows = data.people.length ? table([
      { head: 'Person', cell: (p) => p.name },
      { head: 'PIN', cell: (p) => (p.locked ? state('Locked', 'bad') : p.pin_set ? state('Set', 'good') : state('Not set', 'warn')) },
      { head: 'Badge', cell: (p) => (p.badge_issued ? state('Issued', 'good') : state('None', 'neutral')) },
      { head: '', actions: true, cell: (p) => h('span', { class: 'row' },
        button(p.pin_set ? 'Change PIN' : 'Set PIN', () => pinDialog(p), { small: true }),
        p.locked ? button('Unlock', async () => { await post(`/kiosk-admin/people/${p.staff_id}/unlock`, {}); toast(`${p.name} can try again`); await reload(); }, { small: true }) : null,
        button('Badge', () => badges([p.staff_id], `Badge for ${p.name}`), { small: true }),
        p.badge_issued ? button('Lost badge', () => confirmDialog('Replace badge', `${p.name}'s old badge stops working and a new one is made.`, 'Replace badge', async () => {
          const r = await post(`/kiosk-admin/people/${p.staff_id}/badge/reissue`, {});
          await reload();
          printDialog(`New badge for ${p.name}`, h('div', { class: 'badge-grid' }, badgeCard(r)));
        }, { danger: true }), { small: true }) : null,
        p.pin_set ? button('Remove PIN', () => confirmDialog('Remove PIN', `${p.name} will disappear from the tablet until a new PIN is set.`, 'Remove PIN', async () => { await del(`/kiosk-admin/people/${p.staff_id}/pin`); await reload(); }, { danger: true }), { small: true, kind: 'quiet-danger' }) : null) },
    ], data.people) : empty('No active staff yet.');
    return h('section', { class: 'panel stack', 'data-kiosk': 'people' }, h('div', { class: 'row between' }, h('h3', null, 'People'), printAll),
      h('p', { class: 'muted small' }, `${ready} of ${data.people.length} have a PIN and show on the tablet. Badges are optional and work without a PIN.`), rows);
  }

  // ------------------------------------------------------------ settings
  function settingsPanel() {
    const on = h('input', { type: 'checkbox', name: 'photos', checked: data.settings.photos });
    const days = input({ type: 'number', name: 'days', min: 1, max: 365, value: data.settings.photo_days });
    const save = button('Save', async () => {
      await put('/kiosk-admin/settings', { photos: on.checked, photo_days: Number(days.value) });
      toast('Saved'); await reload();
    }, { kind: 'primary' });
    return h('section', { class: 'panel stack', 'data-kiosk': 'settings' }, h('h3', null, 'Snapshots'),
      h('label', { class: 'check' }, on, ' Take a snapshot with each clock-in and clock-out'),
      field('Delete snapshots after (days)', days, 'The tablet shows a notice to everyone. Snapshots are only for checking timesheets, are never matched to faces, and can only be seen by managers (each view is logged).'),
      h('p', { class: 'muted small' }, 'Tell your staff in writing that snapshots are taken and how long they are kept. Check your state rules if you are unsure.'), save);
  }

  // ------------------------------------------------------------ punches
  function punchesPanel() {
    const from = input({ type: 'date', value: addDays(todayStr(), -7) });
    const to = input({ type: 'date', value: todayStr() });
    const out = h('div');
    async function load() {
      clear(out);
      try {
        const res = await get(`/kiosk-admin/punches?from=${from.value}&to=${to.value}`);
        if (!res.data.length) { out.append(empty('No punches in this range.')); return; }
        out.append(table([
          { head: 'Person', cell: (e) => e.name },
          { head: 'In', cell: (e) => h('span', null, fmtDateTime(e.clock_in), ' ', h('small', { class: 'muted' }, `${METHOD[e.in_method] || e.in_method}${e.in_device ? `, ${e.in_device}` : ''}`)) },
          { head: 'Out', cell: (e) => (e.clock_out ? h('span', null, fmtDateTime(e.clock_out), ' ', h('small', { class: 'muted' }, `${METHOD[e.out_method] || e.out_method}${e.out_device ? `, ${e.out_device}` : ''}`)) : state(e.long_open ? 'Open too long' : 'Clocked in', e.long_open ? 'bad' : 'good')) },
          { head: 'Hours', num: true, cell: (e) => hrs(e.minutes) },
          { head: '', actions: true, cell: (e) => h('span', { class: 'row' },
            e.photo_in ? button('In photo', () => showPhoto(e, 'in'), { small: true }) : null,
            e.photo_out ? button('Out photo', () => showPhoto(e, 'out'), { small: true }) : null,
            button('Fix times', () => fixDialog(e), { small: true })) },
        ], res.data, { rowClass: (e) => (e.long_open ? 'row-warn' : null) }));
      } catch (err) { out.append(errorBox(err)); }
    }
    function toLocalInput(s) { return s ? String(s).replace(' ', 'T').slice(0, 16) : ''; }
    function fixDialog(e) {
      formDialog(`Fix times for ${e.name}`, h('div', { class: 'form-grid' },
        field('Clock in', input({ type: 'datetime-local', name: 'in', value: toLocalInput(e.clock_in) })),
        field('Clock out', input({ type: 'datetime-local', name: 'out', value: toLocalInput(e.clock_out) }), e.clock_out ? null : 'Set this to close a forgotten clock-out.')), async (fd) => {
        const body = {};
        if (val(fd, 'in') && val(fd, 'in') !== toLocalInput(e.clock_in)) body.clock_in = val(fd, 'in');
        if (val(fd, 'out') && val(fd, 'out') !== toLocalInput(e.clock_out)) body.clock_out = val(fd, 'out');
        if (!Object.keys(body).length) throw new Error('Change a time first');
        await patch(`/kiosk-admin/entries/${e.id}`, body);
        toast('Times fixed. The change is in the audit log.');
        await load();
      });
    }
    async function showPhoto(e, kind) {
      const dlg = dialog(`${e.name}, clocked ${kind}`, h('p', { class: 'loading' }, 'Loading…'));
      try {
        const r = await get(`/kiosk-admin/photos/${e.id}/${kind}`);
        clear(dlg.body).append(h('img', { class: 'punch-photo', src: r.image, alt: `Snapshot of ${e.name} at clock ${kind}` }), h('p', { class: 'muted small' }, `Taken ${fmtDateTime(r.taken_at)}. Viewing is logged.`));
      } catch (err) { clear(dlg.body).append(errorBox(err)); }
    }
    queueMicrotask(load);
    return h('section', { class: 'panel stack', 'data-kiosk': 'punches' }, h('h3', null, 'Punches'),
      h('div', { class: 'inline-form' }, field('From', from), field('To', to), button('Show', load, { kind: 'primary' })), out);
  }

  draw();
}
