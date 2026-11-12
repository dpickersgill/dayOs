// A municipality's departments, funds and labor rates (release 2026.11.20, workstream "money"), in Assets and fleet,
// Settings (managers). Every work order is charged to a department and a fund; each department has a default fund; a
// fund marked Liquid Fuels is the one the Liquid Fuels report by street reads. Each crew member's labor rate is what an
// hour of their time costs a job (pay plus benefits, if you like); without one, the shop labor rate is used.
// API: /assets/books, /assets/departments, /assets/funds, /assets/labor-rates (routes/workmoney.js).
import { get, post, patch, put } from '../api.js';
import { h, clear, button, toast, formDialog, field, input, select, val, num, money, toCents, centsToInput, empty } from '../ui.js';

export function booksSettings() {
  const box = h('div', { class: 'stack' });
  draw(box).catch(() => box.append(empty('Could not load departments and funds.')));
  return box;
}

async function draw(box) {
  const [b, rates] = await Promise.all([get('/assets/books'), get('/assets/labor-rates')]);
  const again = () => draw(box);
  const fundName = (id) => (b.funds.find((f) => f.id === id) || {}).name;
  clear(box).append(
    h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Departments'), button('Add a department', () => deptDialog(null, b, again), { small: true })),
      h('p', { class: 'muted small' }, 'Each work order is charged to a department and its fund. Work orders take theirs from the asset or map item (water, sewer, stormwater), else from the request or the place; you can change any of them.'),
      h('ul', { class: 'plain rows' }, b.departments.map((d) => h('li', { class: 'spread' },
        h('span', null, h('b', null, d.name), h('span', { class: 'muted small' }, ` Charges ${fundName(d.fund_id) || 'no fund'} by default${d.active ? '' : ' · not in use'}`)),
        button('Edit', () => deptDialog(d, b, again), { small: true, label: `Edit ${d.name}` }))))),
    h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Funds'), button('Add a fund', () => fundDialog(null, again), { small: true })),
      h('ul', { class: 'plain rows' }, b.funds.map((f) => h('li', { class: 'spread' },
        h('span', null, h('b', null, f.name), h('span', { class: 'muted small' }, `${f.code ? ` Fund ${f.code}` : ''}${f.kind === 'liquid_fuels' ? ' · Liquid Fuels: on the Liquid Fuels report by street' : ''}${f.active ? '' : ' · not in use'}`)),
        button('Edit', () => fundDialog(f, again), { small: true, label: `Edit ${f.name}` }))))),
    h('section', { class: 'panel stack' }, h('h2', null, 'Labor rates'),
      h('p', { class: 'muted small' }, `What an hour of each person's time costs a job. Leave it blank to use the shop labor rate (${money(rates.shop_rate_cents)} an hour). Only managers see rates and labor costs; the crew sees hours.`),
      rates.data.length ? h('ul', { class: 'plain rows' }, rates.data.map((r) => {
        const amt = input({ inputmode: 'decimal', class: 'short-num', value: centsToInput(r.rate_cents), placeholder: centsToInput(rates.shop_rate_cents), 'aria-label': `Labor rate for ${r.name}, dollars an hour` });
        return h('li', { class: 'spread' }, h('span', null, h('b', null, r.name), h('span', { class: 'muted small' }, r.rate_cents === null ? ' Shop rate' : ` ${money(r.rate_cents)} an hour`)),
          h('span', { class: 'row tight' }, amt, button('Save', async () => {
            const v = amt.value.trim(); const c = v ? toCents(v) : null;
            if (v && c === null) throw new Error('The rate must be an amount, like 38 or 38.50');
            await put(`/assets/labor-rates/${r.staff_id}`, { rate_cents: c }); toast('Saved'); await again();
          }, { small: true, label: `Save the rate for ${r.name}` })));
      })) : h('p', { class: 'muted' }, 'Add your crew in Staff and schedule to give each a rate.')));
}

function deptDialog(d, b, done) {
  const cur = d || {};
  formDialog(d ? `Edit ${d.name}` : 'Add a department', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 60, value: cur.name || '' })),
    field('Charges this fund by default', select([['', 'None'], ...b.funds.filter((f) => f.active || f.id === cur.fund_id).map((f) => [f.id, f.name])], cur.fund_id || '', { name: 'fund_id' })),
    d ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(cur.active) }), ' In use') : null),
  async (fd) => {
    const body = { name: val(fd, 'name'), fund_id: num(fd, 'fund_id') };
    if (d) await patch(`/assets/departments/${d.id}`, { ...body, active: fd.get('active') === 'on' }); else await post('/assets/departments', body);
    toast('Saved'); await done();
  });
}

function fundDialog(f, done) {
  const cur = f || {};
  formDialog(f ? `Edit ${f.name}` : 'Add a fund', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 60, value: cur.name || '' })),
    field('Fund number', input({ name: 'code', maxlength: 20, value: cur.code || '', placeholder: '35' }), 'As your chart of accounts numbers it, if it does'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'liquid_fuels', checked: cur.kind === 'liquid_fuels' }), ' Liquid Fuels (state highway aid): show its spending by street on the monthly report'),
    f ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(cur.active) }), ' In use') : null),
  async (fd) => {
    const body = { name: val(fd, 'name'), code: val(fd, 'code'), liquid_fuels: fd.get('liquid_fuels') === 'on' };
    if (f) await patch(`/assets/funds/${f.id}`, { ...body, active: fd.get('active') === 'on' }); else await post('/assets/funds', body);
    toast('Saved'); await done();
  });
}
