// Staff and schedule > Setup: positions (with what each requires and how many people work it), certification types,
// saved week templates and the time clock kiosk. Set up once, then left alone.
import { get, post, put, patch, del } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, confirmDialog, table, label, empty } from '../ui.js';
import { drawKiosk } from './kiosk-admin.js';
import { DEPARTMENTS } from './workforce-common.js';

export async function drawSetup(box) {
  const positions = h('section', { class: 'section' });
  const certs = h('section', { class: 'section' });
  const templates = h('section', { class: 'section' });
  const kiosk = h('section', { class: 'section' });
  clear(box).append(h('div', { class: 'stack setup-page' }, positions, certs, templates, h('h2', { class: 'setup-h' }, 'Time clock kiosk'), kiosk));

  async function drawPositions() {
    const [{ data }, { data: certTypes }] = await Promise.all([get('/workforce/positions-overview'), get('/workforce/certifications?limit=500')]);
    clear(positions).append(h('header', { class: 'spread' }, h('h2', null, 'Positions'), button('Add position', () => editPosition(null, drawPositions), { kind: 'primary', small: true })),
      data.length ? table([
        { head: 'Position', cell: (p) => h('b', null, p.name) },
        { head: 'Department', cell: (p) => label(p.department) },
        { head: 'Requires', cell: (p) => (p.requires.length ? p.requires.map((c) => c.name).join(', ') : h('span', { class: 'muted' }, 'Nothing')) },
        { head: 'People trained', num: true, cell: (p) => String(p.trained) },
        { head: 'Guests per staff member', num: true, cell: (p) => (p.visits_per_staff ? String(p.visits_per_staff) : '') },
        { head: '', actions: true, cell: (p) => [button('Edit', () => editPosition(p, drawPositions), { small: true, label: `Edit ${p.name}` }), button('Required certifications', () => requirements(p, certTypes, drawPositions), { small: true, label: `Required certifications for ${p.name}` })] },
      ], data) : empty('No positions yet, such as Lift operator or Rental tech.'));
  }
  async function drawCerts() {
    const { data } = await get('/workforce/certifications?limit=500');
    clear(certs).append(h('header', { class: 'spread' }, h('h2', null, 'Certification types'), button('Add certification', () => editCert(null, async () => { await drawCerts(); await drawPositions(); }), { small: true })),
      data.length ? table([{ head: 'Name', cell: (c) => c.name }, { head: '', actions: true, cell: (c) => button('Rename', () => editCert(c, async () => { await drawCerts(); await drawPositions(); }), { small: true, label: `Rename ${c.name}` }) }], data)
        : empty('No certification types yet, such as Outdoor Emergency Care.'));
  }
  async function drawTemplates() {
    const { data } = await get('/workforce/shift-templates');
    clear(templates).append(h('header', null, h('h2', null, 'Week templates')),
      h('p', { class: 'muted' }, 'Saved from the Schedule tab (Templates), and applied there to any week.'),
      data.length ? table([{ head: 'Template', cell: (t) => t.name }, { head: 'Shifts', num: true, cell: (t) => String(t.shifts) },
        { head: '', actions: true, cell: (t) => button('Delete', () => confirmDialog(`Delete ${t.name}?`, 'Shifts already made from it stay.', 'Delete', async () => { await del(`/workforce/shift-templates/${t.id}`); toast('Template deleted'); await drawTemplates(); }, { danger: true }), { small: true, label: `Delete ${t.name}` }) }], data)
        : empty('No templates yet.'));
  }
  await Promise.all([drawPositions(), drawCerts(), drawTemplates(), drawKiosk(kiosk)]);
}

function editPosition(p, done) {
  formDialog(p ? `Edit ${p.name}` : 'Add a position', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, value: p ? p.name : '' })),
    field('Department', select(DEPARTMENTS, p ? p.department : 'lifts', { name: 'department' })),
    field('Guests per staff member', input({ name: 'visits', type: 'number', min: 1, value: p && p.visits_per_staff ? p.visits_per_staff : '' }), 'Used by Staffing needs: one person for every this many expected guests')), async (fd) => {
    const visits = String(fd.get('visits') || '');
    const body = { name: String(fd.get('name') || '').trim(), department: String(fd.get('department')), visits_per_staff: visits ? Number(visits) : null };
    if (p) await patch(`/workforce/positions/${p.id}`, body); else await post('/workforce/positions', body);
    toast('Position saved');
    await done();
  });
}

function editCert(c, done) {
  formDialog(c ? `Rename ${c.name}` : 'Add a certification type', h('div', { class: 'form' }, field('Name', input({ name: 'name', required: true, maxlength: 100, value: c ? c.name : '' }))), async (fd) => {
    const name = String(fd.get('name') || '').trim();
    if (c) await patch(`/workforce/certifications/${c.id}`, { name }); else await post('/workforce/certifications', { name });
    toast('Saved');
    await done();
  });
}

/** What a position requires. The boxes start from what is saved, because saving replaces the list. */
async function requirements(p, certTypes, done) {
  if (!certTypes.length) { toast('Add certification types first', 'error'); return; }
  const { certification_ids: have } = await get(`/workforce/positions/${p.id}/requirements`);
  const boxes = certTypes.map((c) => ({ c, cb: h('input', { type: 'checkbox', checked: have.includes(Number(c.id)) }) }));
  formDialog(`Required for ${p.name}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Nobody can be put on this position without every certification ticked here, current on the day of the shift.'),
    h('div', { class: 'checks' }, boxes.map((b) => h('label', { class: 'check' }, b.cb, ` ${b.c.name}`)))), async () => {
    await put(`/workforce/positions/${p.id}/requirements`, { certification_ids: boxes.filter((b) => b.cb.checked).map((b) => Number(b.c.id)) });
    toast('Requirements saved');
    await done();
  }, { submitText: 'Save requirements' });
}
