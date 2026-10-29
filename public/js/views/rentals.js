import { get, post, patch } from '../api.js';
import { h, clear, can, isManager, table, state, input, select, field, button, toast, formDialog, dialog, tabs, val, num, todayStr, nowInput, fmtDateTime, label, empty, money, toCents, centsToInput, addDays } from '../ui.js';
import { personPicker, waiverPanel } from '../widgets.js';
import { code128 } from '../barcode.js';
import { printDialog } from '../print.js';
import * as more from './rentals-more.js';
import * as fit from './rentals-fit.js';
import * as ret from './rentals-returns.js';
import { drawReports as shopReports } from './rentals-reports.js';

export const CATEGORIES = ['ski', 'snowboard', 'boot', 'helmet', 'pole', 'other'];
const ITEM_STATUS = ['available', 'rented', 'maintenance', 'lost', 'retired'];
const gearName = (i) => [i.brand, i.model, i.size].filter(Boolean).join(' ');

export async function render(root) {
  const items = [['counter', 'Counter', fit.drawCounter], ['forms', 'Forms', async (b) => (await import('./rentals-forms.js')).drawForms(b)], ['returns', 'Returns', ret.drawReturns], ['out', 'Out now', ret.drawOut], ['groups', 'Groups', async (b) => (await import('./rentals-groups.js')).drawGroups(b)], ['reservations', 'Reservations', more.drawReservations], ['board', 'Queue board', fit.drawBoard]];
  if (can('counter')) items.push(['inventory', 'Inventory', drawInventory], ['service', 'Service', more.drawService]);
  if (isManager()) items.push(['reports', 'Reports', shopReports]);
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Rentals')), tabs(items));
}

/** Setup shown in Settings, Rentals (managers): late fees, deposits, service, the binding rules and the binding chart. */
export const settingsPages = {
  settings: { title: 'Fees, service and the binding chart', render: (panel) => more.drawSettings(panel) },
};

// Out now, the Returns tab, check in, extend, swap and fees live in rentals-returns.js; the shop manager's reports in rentals-reports.js.

// ---------------------------------------------------------------- inventory
async function drawInventory(box) {
  const { data } = await get('/rentals/items?limit=500');
  const reload = async () => { const n = h('div'); await drawInventory(n); clear(box).append(...n.childNodes); };
  const counts = ITEM_STATUS.map((s) => `${data.filter((i) => i.status === s).length} ${label(s).toLowerCase()}`).join(', ');
  const needle = input({ type: 'search', placeholder: 'Search SKU, brand, model or serial', 'aria-label': 'Search inventory' });
  const body = h('div');
  const catSel = select([['', 'All types'], ...CATEGORIES.map((c) => [c, label(c)])], '');
  function drawRows() {
    const q = needle.value.trim().toLowerCase();
    const shown = data.filter((i) => (!catSel.value || i.category === catSel.value) && (!q || [i.sku, i.brand, i.model, i.serial_no].filter(Boolean).join(' ').toLowerCase().includes(q)));
    clear(body).append(shown.length ? table([
      { head: 'SKU', cell: (i) => h('strong', null, i.sku) },
      { head: 'Type', cell: (i) => label(i.category) + (i.tier === 'performance' ? ' (perf.)' : '') },
      { head: 'Gear', cell: (i) => [i.brand, i.model].filter(Boolean).join(' ') },
      { head: 'Size', cell: (i) => i.size || '' },
      { head: 'Uses', cell: (i) => String(i.uses_count) },
      { head: 'Status', cell: (i) => state(label(i.status), i.status === 'available' ? 'good' : i.status === 'rented' ? 'neutral' : 'warn') },
      { head: '', actions: true, cell: (i) => h('span', { class: 'row' }, button('History', () => history(i), { small: true }), button('Tag', () => printTags([i]), { small: true }), isManager() ? button('Edit', () => editItem(i, reload), { small: true }) : null) },
    ], shown) : empty('No gear matches.'));
  }
  needle.addEventListener('input', drawRows); catSel.addEventListener('change', drawRows);
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, counts), h('span', { class: 'row' },
      button('Print tags', () => printTags(data.filter((i) => !catSel.value || i.category === catSel.value).slice(0, 60)), { small: true }),
      isManager() ? button('Import list', () => importItems(reload), { small: true }) : null,
      isManager() ? button('Add gear', () => editItem(null, reload), { kind: 'primary' }) : null)),
    h('div', { class: 'row' }, needle, catSel), body));
  drawRows();
}

function printTags(list) {
  if (!list.length) return;
  printDialog('Gear tags', h('div', { class: 'tag-sheet' }, ...list.map((i) => h('div', { class: 'gear-tag' }, code128(i.sku, { height: 40, module: 1.6 }), h('div', null, h('strong', null, i.sku)), h('div', { class: 'small' }, `${label(i.category)} ${gearName(i)}`)))));
}

async function history(i) {
  const r = await get(`/rentals/items/${i.id}/history`);
  dialog(`${i.sku} history`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${[i.brand, i.model, i.size].filter(Boolean).join(' ')} · ${r.item.uses_count} rentals${r.item.last_service_at ? ` · last service ${fmtDateTime(r.item.last_service_at)}` : ''}`),
    h('h3', null, 'Service'), r.service.length ? table([{ head: 'When', cell: (s) => fmtDateTime(s.done_at) }, { head: 'Work', cell: (s) => label(s.kind) }, { head: 'Notes', cell: (s) => s.notes || '' }, { head: 'By', cell: (s) => s.done_by || '' }], r.service) : h('p', { class: 'muted' }, 'No service recorded.'),
    h('h3', null, 'Recent rentals'), r.rentals.length ? table([{ head: 'Renter', cell: (x) => `${x.first_name} ${x.last_name}` }, { head: 'Out', cell: (x) => fmtDateTime(x.created_at) }, { head: 'Setting', cell: (x) => (x.din_setting == null ? '' : `${Number(x.din_setting)}${x.tech_name ? ` by ${x.tech_name}` : ''}`) }, { head: 'Damage', cell: (x) => x.damage_notes || '' }], r.rentals) : h('p', { class: 'muted' }, 'Not rented yet.')), { wide: true });
}

function importItems(done) {
  const ta = h('textarea', { name: 'csv', rows: 10, placeholder: 'sku,category,brand,model,size,serial_no,tier,boot_sole_mm,location\nSK-101,ski,Brand,Model,160,SER123,standard,,Rack A' });
  formDialog('Import gear', h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Paste rows from a spreadsheet saved as CSV. The first row is the column names. Existing SKUs are skipped.'), ta), async () => {
    const lines = ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('Add a header row and at least one gear row');
    const head = lines[0].split(',').map((c) => c.trim());
    if (!head.includes('sku') || !head.includes('category')) throw new Error('The first row needs at least sku and category');
    const rows = lines.slice(1).map((l) => {
      const cells = l.split(',').map((c) => c.trim());
      const o = {};
      head.forEach((k, n) => { if (cells[n]) o[k] = ['boot_sole_mm'].includes(k) ? Number(cells[n]) : cells[n]; });
      return o;
    });
    const r = await post('/rentals/items/import', { rows });
    toast(`${r.added} added${r.skipped.length ? `, ${r.skipped.length} already existed` : ''}`);
    await done();
  }, { submitText: 'Import', wide: true });
}

function editItem(i, done) {
  const f = h('div', { class: 'form' },
    field('SKU', input({ name: 'sku', required: true, maxlength: 60, value: i ? i.sku : '' }), 'The code on the gear tag'),
    field('Type', select(CATEGORIES, i ? i.category : 'ski', { name: 'category' })),
    field('Level', select([['standard', 'Standard'], ['performance', 'Performance']], i ? i.tier : 'standard', { name: 'tier' })),
    field('Brand', input({ name: 'brand', maxlength: 100, value: i && i.brand ? i.brand : '' })),
    field('Model', input({ name: 'model', maxlength: 100, value: i && i.model ? i.model : '' })),
    field('Size', input({ name: 'size', maxlength: 30, value: i && i.size ? i.size : '' })),
    field('Serial number', input({ name: 'serial', maxlength: 80, value: i && i.serial_no ? i.serial_no : '' })),
    field('Boot sole length (mm)', input({ name: 'sole', type: 'number', min: '150', max: '400', value: i && i.boot_sole_mm ? i.boot_sole_mm : '' })),
    field('Condition', select([['', 'Not graded'], ['A', 'A (like new)'], ['B', 'B'], ['C', 'C'], ['D', 'D (retire soon)']], i && i.grade ? i.grade : '', { name: 'grade' })),
    field('Bought on', input({ name: 'bought', type: 'date', value: i && i.purchased_on ? String(i.purchased_on).slice(0, 10) : '' })),
    field('Cost ($)', input({ name: 'cost', type: 'number', min: '0', step: '0.01', value: i && i.cost_cents != null ? centsToInput(i.cost_cents) : '' })),
    field('Location', input({ name: 'location', maxlength: 60, value: i && i.location ? i.location : '' }), 'Rack, bay or shelf'),
    i ? field('Status', select(ITEM_STATUS, i.status, { name: 'status' })) : null,
    field('Notes', input({ name: 'notes', maxlength: 500, value: i && i.notes ? i.notes : '' })));
  formDialog(i ? `Edit ${i.sku}` : 'Add gear', f, async (fd) => {
    const body = { sku: val(fd, 'sku'), category: val(fd, 'category'), tier: val(fd, 'tier'), brand: val(fd, 'brand'), model: val(fd, 'model'), size: val(fd, 'size'), serial_no: val(fd, 'serial'), boot_sole_mm: num(fd, 'sole'), grade: val(fd, 'grade'), purchased_on: val(fd, 'bought'), cost_cents: val(fd, 'cost') === null ? null : toCents(val(fd, 'cost')), location: val(fd, 'location'), notes: val(fd, 'notes') };
    if (i) { body.status = val(fd, 'status'); await patch(`/rentals/items/${i.id}`, body); } else await post('/rentals/items', body);
    toast('Gear saved');
    await done();
  }, { wide: true });
}
