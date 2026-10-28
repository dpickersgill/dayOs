// Patrol access levels: what each level can do, and who has which level. For patrol Admins only.

import { get, put, del } from '../api.js';
import { h, clear, button, toast, confirmDialog, select, empty, fail } from '../ui.js';

export async function drawLevels(box) {
  const data = await get('/patrol/access');
  const saved = JSON.parse(JSON.stringify(data.matrix));
  const edit = JSON.parse(JSON.stringify(data.matrix));
  const boxes = new Map();
  const dirty = () => data.levels.some((l) => data.features.some((f) => edit[l.key][f.key] !== saved[l.key][f.key]));
  const saveBtn = button('Save changes', save, { kind: 'primary' });
  const sync = () => { saveBtn.disabled = !dirty(); };

  async function save() {
    const rules = [];
    for (const l of data.levels) for (const f of data.features) if (l.key !== 'admin' && edit[l.key][f.key] !== saved[l.key][f.key]) rules.push({ level: l.key, feature: f.key, allowed: edit[l.key][f.key] });
    if (!rules.length) return;
    try { await put('/patrol/access/rules', { rules }); toast('Access saved'); await drawLevels(box); } catch (err) { fail(err); }
  }
  function reset() {
    confirmDialog('Back to the standard levels?', 'Every level goes back to what it can do out of the box. Nobody\'s level changes.', 'Reset', async () => {
      await del('/patrol/access/rules'); toast('Levels reset'); await drawLevels(box);
    });
  }

  const head = h('tr', null, h('th', { scope: 'col' }, 'Feature'), data.levels.map((l) => h('th', { scope: 'col', class: `center${l.key === 'admin' ? ' lv-admin' : ''}`, title: l.about }, h('div', null, l.label), h('div', { class: 'lv-about' }, l.about))));
  const body = [];
  let group = null;
  const order = [...new Set(data.features.map((f) => f.group))];
  const features = [...data.features].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  for (const f of features) {
    if (f.group !== group) { group = f.group; body.push(h('tr', { class: 'group-row' }, h('th', { colspan: String(data.levels.length + 1), scope: 'colgroup' }, group))); }
    body.push(h('tr', { 'data-feature': f.key }, h('th', { scope: 'row' }, h('div', { class: 'f-label' }, f.label), h('div', { class: 'f-about' }, f.about)),
      data.levels.map((l) => {
        const cb = h('input', { type: 'checkbox', 'aria-label': `${l.label}: ${f.label}`, 'data-level': l.key, 'data-key': f.key });
        cb.checked = Boolean(edit[l.key][f.key]);
        if (l.key === 'admin') cb.disabled = true;
        cb.addEventListener('change', () => { edit[l.key][f.key] = cb.checked; sync(); });
        boxes.set(`${l.key}|${f.key}`, cb);
        return h('td', { class: `center${l.key === 'admin' ? ' lv-admin' : ''}` }, cb);
      })));
  }

  const people = data.people.map((p) => {
    const sel = select(data.levels.map((l) => [l.key, l.label]), p.access_level, { name: 'level', 'aria-label': `Access level for ${p.name}`, 'data-staff': String(p.staff_id) });
    sel.addEventListener('change', async () => {
      try { await put(`/patrol/team/${p.staff_id}/access`, { access_level: sel.value }); toast(`${p.name} is now ${data.levels.find((l) => l.key === sel.value).label}`); } catch (err) { fail(err); sel.value = p.access_level; }
    });
    return h('tr', null, h('th', { scope: 'row' }, p.name, p.callsign ? h('span', { class: 'muted' }, ` · ${p.callsign}`) : null), h('td', { class: 'muted' }, p.rank_level), h('td', null, sel));
  });

  sync();
  clear(box).append(h('div', { class: 'stack levels' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'Pick what each level can do. Owners and managers of the mountain are always Admins, and the Admin level always has everything.'),
      h('span', { class: 'row' }, button('Reset to standard', reset, {}), saveBtn)),
    h('details', { class: 'lv-legend' }, h('summary', null, 'What each level is for'), h('ul', null, data.levels.map((l) => h('li', null, h('b', null, l.label), ` ${l.about}`)))),
    h('div', { class: 'table-wrap' }, h('table', { class: 'matrix' }, h('thead', null, head), h('tbody', null, body))),
    h('h2', null, 'People'),
    h('p', { class: 'muted small' }, 'Rank on the roster (Patrol, People, Roster) is for training and seniority. The access level here decides what a person can open and do.'),
    people.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'matrix people' }, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Rank'), h('th', null, 'Access level'))), h('tbody', null, people))) : empty('No one is on the patrol roster yet.')));
}
