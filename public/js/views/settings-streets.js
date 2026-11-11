// Settings, Apps, Streets (muni release 1): the municipality's street list. Requests, bulk pickup and street notices pick
// from it, and the public report form lists it. Managers add a street, import a whole list (one per line, or CSV with
// name,aliases), rename one, give it other spellings, and mark one not in use. Nothing is deleted, so old requests keep
// their street. API: /api/v1/requests/streets (src/routes/streets.js).
import { get, post, patch } from '../api.js';
import { h, clear, table, state, input, select, field, button, toast, formDialog, val, empty, isManager } from '../ui.js';
import { card } from './settings-kit.js';

export async function renderSettingsPage(root) {
  const body = h('div');
  const showAll = h('input', { type: 'checkbox', name: 'all' });
  const manager = isManager();
  root.append(card('Streets', [
    h('p', { class: 'set-card-intro' }, 'Residents and staff pick a street from this list when they report a problem, book a bulk pickup or send a street notice. Add other spellings people use, so "Main St" finds Main Street.'),
    h('div', { class: 'row' },
      manager ? button('Add a street', () => edit(null), { kind: 'primary', small: true }) : null,
      manager ? button('Import a list', () => importList(), { small: true }) : null,
      h('label', { class: 'check' }, showAll, ' Show streets not in use')),
    body,
  ], { id: 'streets' }));
  showAll.addEventListener('change', () => load());

  async function load() {
    const { data } = await get(`/requests/streets${showAll.checked ? '?all=1' : ''}`);
    clear(body);
    if (!data.length) { body.append(empty(showAll.checked ? 'No streets yet.' : 'No streets yet. Import your street list to start: paste one street per line.')); return; }
    body.append(h('p', { class: 'muted small' }, `${data.filter((s) => s.active).length} street${data.filter((s) => s.active).length === 1 ? '' : 's'} in use.`), table([
      { head: 'Street', cell: (s) => h('strong', null, s.name) },
      { head: 'Other spellings', cell: (s) => s.aliases || h('span', { class: 'muted' }, 'None') },
      { head: 'Status', cell: (s) => state(s.active ? 'In use' : 'Not in use', s.active ? 'good' : 'neutral') },
      { head: '', actions: true, cell: (s) => (manager ? [
        button('Edit', () => edit(s), { small: true, label: `Edit ${s.name}` }),
        button(s.active ? 'Mark not in use' : 'Put back in use', async () => { await patch(`/requests/streets/${s.id}`, { active: !s.active }); toast(s.active ? `${s.name} is no longer offered` : `${s.name} is in use again`); await load(); }, { small: true }),
      ] : null) },
    ], data));
  }

  function edit(s) {
    formDialog(s ? `Edit ${s.name}` : 'Add a street', h('div', { class: 'form' },
      field('Street name', input({ name: 'name', required: true, maxlength: 120, value: s ? s.name : '', placeholder: 'Main Street' }), s ? 'Renaming keeps every request and pickup on this street.' : 'As it is written on the street sign.'),
      field('Other spellings', input({ name: 'aliases', maxlength: 255, value: s ? s.aliases || '' : '', placeholder: 'Main St, Main' }), 'Separate them with commas. Optional.')), async (fd) => {
      const b = { name: val(fd, 'name'), aliases: val(fd, 'aliases') };
      if (s) await patch(`/requests/streets/${s.id}`, b); else await post('/requests/streets', b);
      toast(s ? 'Street saved' : 'Street added');
      await load();
    }, { submitText: s ? 'Save' : 'Add street' });
  }

  function importList() {
    const format = select([['lines', 'One street per line'], ['csv', 'CSV: name,aliases']], 'lines', { name: 'format' });
    formDialog('Import a street list', h('div', { class: 'form' },
      field('What you are pasting', format),
      field('Streets', h('textarea', { name: 'text', rows: 12, required: true, placeholder: 'Main Street\nBridge Street\nChurch Street' }), 'Streets already on the list are kept, put back in use, and gain any new spellings. Nothing is removed.')), async (fd) => {
      const out = await post('/requests/streets/import', { text: String(fd.get('text') || ''), format: val(fd, 'format') || 'lines' });
      toast(`${out.added} added, ${out.updated} updated${out.skipped.length ? `, ${out.skipped.length} skipped` : ''}`);
      await load();
    }, { submitText: 'Import', wide: true });
  }

  await load();
}
