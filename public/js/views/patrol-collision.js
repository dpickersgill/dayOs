// The collision report. On the case page it is a panel for recording who was involved and what happened at the scene; the
// printable report (#/patrol/collision/:id) is for an insurer or the risk manager and carries no medical details.

import { get, post, put, patch, del } from '../api.js';
import { h, state, input, select, field, button, toast, formDialog, confirmDialog, val, num, fmtDateTime, label, errorBox } from '../ui.js';

const TYPES = [['skier_skier', 'Skier or rider with another skier or rider'], ['skier_object', 'Skier or rider with an object (tree, fence, sign)'], ['skier_lift_structure', 'With a lift tower or structure'], ['skier_vehicle', 'With a vehicle (groomer, snowmobile)'], ['skier_animal', 'With an animal'], ['other', 'Other']];
const ROLES = [['skier', 'Skier'], ['snowboarder', 'Snowboarder'], ['other_snow', 'Other snow sport'], ['pedestrian', 'Pedestrian'], ['employee', 'Employee'], ['vehicle', 'Vehicle driver'], ['unknown', 'Unknown']];
const POSITIONS = [['unknown', 'Not known'], ['uphill', 'Uphill (behind)'], ['downhill', 'Downhill (ahead)'], ['side_by_side', 'Side by side'], ['crossing', 'Crossing the other\'s path'], ['stopped', 'Stopped']];
const SPEEDS = [['unknown', 'Not known'], ['stopped', 'Stopped'], ['slow', 'Slow'], ['moderate', 'Moderate'], ['fast', 'Fast']];
export const FACTORS = [['speed', 'Speed for the conditions'], ['blind_roll', 'Blind roll or poor sightline'], ['merging', 'Trails merging or crossing'], ['stopped_in_path', 'Stopped in the path of travel'], ['out_of_control', 'Out of control'], ['crowding', 'Crowding or congestion'], ['conditions', 'Snow or visibility conditions'], ['equipment', 'Equipment problem'], ['inattention', 'Not looking ahead'], ['alcohol_drugs', 'Alcohol or drugs suspected'], ['jump_feature', 'Jump or terrain feature']];
const factorList = (s) => String(s || '').split(',').filter(Boolean);
const factorText = (s) => factorList(s).map((k) => (FACTORS.find((f) => f[0] === k) || [k, label(k)])[1]);
const yn = (v) => (v ? 'Yes' : 'No');
const typeText = (t) => (TYPES.find((x) => x[0] === t) || [0, label(t)])[1];
const partyName = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.role === 'unknown' ? 'Unidentified person' : label(p.role));

/** The panel on the case page. opts: { id, editable, reload } */
export function collisionPanel(c, { id, editable, reload }) {
  const col = c.collision;
  const body = col ? h('div', { class: 'stack' },
    h('p', null, h('b', null, typeText(col.collision_type)), col.hit_and_run ? ' ' : null, col.hit_and_run ? state('Other party left the scene', 'bad') : null, col.legal_hold ? ' ' : null, col.legal_hold ? state('Legal hold', 'warn') : null),
    col.right_of_way ? h('p', null, h('b', null, 'Right of way: '), col.right_of_way) : null,
    factorList(col.factors).length ? h('p', null, h('b', null, 'Factors: '), factorText(col.factors).join(', ')) : null,
    col.hit_and_run && col.unknown_party_description ? h('p', null, h('b', null, 'Description of the other party: '), col.unknown_party_description) : null)
    : h('p', { class: 'muted' }, 'Nothing recorded yet. Add each person involved, then the details of the scene.');
  const people = c.parties.length ? h('ul', { class: 'plain parties' }, c.parties.map((p) => h('li', { class: 'spread', 'data-party': p.id },
    h('span', null, h('b', null, partyName(p)), ` ${label(p.role)}`, p.position && p.position !== 'unknown' ? `, ${label(p.position)}` : '', p.speed && p.speed !== 'unknown' ? `, ${p.speed} speed` : '', p.left_scene ? ' ' : '', p.left_scene ? state('Left the scene', 'bad') : null,
      p.patient_id ? ' ' : '', p.patient_id ? state('Patient on this report', 'neutral') : null, h('span', { class: 'muted' }, ` ${[p.phone, p.email].filter(Boolean).join(', ')}`)),
    editable ? h('span', { class: 'row' }, button('Edit', () => partyDialog(c, p, { id, reload }), { small: true }), button('Remove', () => confirmDialog('Remove this person?', partyName(p), 'Remove', async () => { await del(`/patrol/incidents/${id}/parties/${p.id}`); await reload(); }, { danger: true }), { small: true })) : null))) : null;
  return h('section', { class: 'panel stack', 'data-area': 'collision', 'data-collision': '' },
    h('div', { class: 'spread' }, h('h2', null, 'Collision report'),
      h('div', { class: 'row' }, editable ? button('Add person involved', () => partyDialog(c, null, { id, reload }), { small: true, kind: 'primary' }) : null, editable ? button(col ? 'Edit scene details' : 'Add scene details', () => sceneDialog(c, { id, reload }), { small: true }) : null,
        h('a', { class: 'btn small', href: `#/patrol/collision/${id}` }, 'Printable report'))),
    body, people || h('p', { class: 'muted' }, 'No people added yet.'));
}

function sceneDialog(c, { id, reload }) {
  const col = c.collision || {};
  const checks = FACTORS.map(([k, text]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `f_${k}`, checked: factorList(col.factors).includes(k) }), ' ', text));
  const box = (name, text, on) => h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name, checked: Boolean(on) }), ' ', text);
  formDialog('Collision scene details', h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('What was involved', select(TYPES, col.collision_type || 'skier_skier', { name: 'collision_type' }))),
    box('hit_and_run', 'The other party left the scene', col.hit_and_run),
    h('div', { class: 'wide' }, field('Describe the party who left', input({ name: 'unknown_party_description', maxlength: 1000, value: col.unknown_party_description || '', placeholder: 'Jacket, helmet, equipment, direction, anyone who saw them' }))),
    h('div', { class: 'wide' }, field('Who had the right of way, and why', h('textarea', { name: 'right_of_way', rows: 3, maxlength: 1000 }, col.right_of_way || ''), 'The skier ahead has the right of way. Write what you saw and what people told you, not a conclusion about fault.')),
    h('fieldset', { class: 'wide checks' }, h('legend', null, 'Contributing factors'), checks),
    box('police_notified', 'Police were notified', col.police_notified),
    field('Agency', input({ name: 'police_agency', maxlength: 150, value: col.police_agency || '' })), field('Police report number', input({ name: 'police_report_no', maxlength: 60, value: col.police_report_no || '' })),
    box('risk_notified', 'Risk manager or patrol supervisor notified', col.risk_notified),
    h('div', { class: 'wide' }, field('Equipment tagged and held', input({ name: 'equipment_held', maxlength: 500, value: col.equipment_held || '' }))),
    h('div', { class: 'wide' }, field('Property damage', input({ name: 'property_damage', maxlength: 1000, value: col.property_damage || '' }))),
    h('div', { class: 'wide' }, field('Findings and notes', h('textarea', { name: 'findings', rows: 3, maxlength: 20000 }, col.findings || ''))),
    box('legal_hold', 'Legal hold: keep everything about this case', col.legal_hold)),
  async (fd) => {
    const get_ = (n) => fd.get(n) === 'on';
    await put(`/patrol/incidents/${id}/collision`, {
      collision_type: val(fd, 'collision_type'), hit_and_run: get_('hit_and_run'), unknown_party_description: val(fd, 'unknown_party_description'), right_of_way: val(fd, 'right_of_way'),
      factors: FACTORS.filter(([k]) => get_(`f_${k}`)).map(([k]) => k), police_notified: get_('police_notified'), police_agency: val(fd, 'police_agency'), police_report_no: val(fd, 'police_report_no'),
      risk_notified: get_('risk_notified'), equipment_held: val(fd, 'equipment_held'), property_damage: val(fd, 'property_damage'), findings: val(fd, 'findings'), legal_hold: get_('legal_hold'),
    });
    toast('Scene details saved');
    await reload();
  }, { wide: true });
}

function partyDialog(c, p, { id, reload }) {
  const cur = p || {};
  const patients = [['', 'Not a patient on this report'], ...c.patients.filter((x) => !x.voided_at).map((x) => [x.id, `${x.first_name} ${x.last_name}`.trim()])];
  const box = (name, text, on) => h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name, checked: Boolean(on) }), ' ', text);
  formDialog(p ? 'Edit person involved' : 'Add a person involved', h('div', { class: 'form' },
    field('Role', select(ROLES, cur.role || 'skier', { name: 'role' })), field('Is this a patient?', select(patients, cur.patient_id || '', { name: 'patient_id' })),
    field('First name', input({ name: 'first_name', maxlength: 100, value: cur.first_name || '' })), field('Last name', input({ name: 'last_name', maxlength: 100, value: cur.last_name || '' })),
    field('Age', input({ name: 'age_years', type: 'number', min: 0, max: 120, value: cur.age_years ?? '' })), field('Phone', input({ name: 'phone', type: 'tel', maxlength: 40, value: cur.phone || '' })),
    field('Email', input({ name: 'email', type: 'email', maxlength: 255, value: cur.email || '' })), field('Home address', input({ name: 'address', maxlength: 255, value: cur.address || '' })),
    field('Helmet', select([['unknown', 'Not known'], ['yes', 'Yes'], ['no', 'No']], cur.helmet || 'unknown', { name: 'helmet' })), field('Equipment', input({ name: 'equipment', maxlength: 255, value: cur.equipment || '', placeholder: 'Skis, board, color' })),
    field('Position before impact', select(POSITIONS, cur.position || 'unknown', { name: 'position' })), field('Speed', select(SPEEDS, cur.speed || 'unknown', { name: 'speed' })),
    h('div', { class: 'wide' }, field('Direction of travel', input({ name: 'direction', maxlength: 255, value: cur.direction || '' }))),
    h('div', { class: 'wide' }, field('Their statement', h('textarea', { name: 'statement', rows: 4, maxlength: 10000 }, cur.statement || ''), 'In their own words. Take each statement separately.')),
    box('left_scene', 'Left the scene', cur.left_scene), box('refused_contact_info', 'Refused to give contact details', cur.refused_contact_info)),
  async (fd) => {
    const body = {
      role: val(fd, 'role'), patient_id: num(fd, 'patient_id'), first_name: val(fd, 'first_name'), last_name: val(fd, 'last_name'), age_years: num(fd, 'age_years'), phone: val(fd, 'phone'), email: val(fd, 'email'), address: val(fd, 'address'),
      helmet: val(fd, 'helmet'), equipment: val(fd, 'equipment'), position: val(fd, 'position'), speed: val(fd, 'speed'), direction: val(fd, 'direction'), statement: val(fd, 'statement'), left_scene: fd.get('left_scene') === 'on', refused_contact_info: fd.get('refused_contact_info') === 'on',
    };
    if (p) await patch(`/patrol/incidents/${id}/parties/${p.id}`, body); else await post(`/patrol/incidents/${id}/parties`, body);
    toast('Saved');
    await reload();
  }, { wide: true });
}

/** The printable report. It leaves out every medical detail: vitals, injuries, treatment and allergies stay on the patient record. */
export async function renderCollisionReport(root, id) {
  const page = h('div', { class: 'stack' });
  root.append(page);
  let c;
  try { c = await get(`/patrol/incidents/${id}`); } catch (err) { page.append(h('p', null, h('a', { href: '#/patrol' }, 'Back to patrol')), errorBox(err)); return; }
  const col = c.collision || {};
  const f = c.form || {};
  const section = (title, ...kids) => h('section', { class: 'hs' }, h('h3', null, title), ...kids);
  const kvp = (k, v) => (v ? h('p', null, h('b', null, `${k}: `), v) : null);
  const conditions = [f.weather && `Weather ${label(f.weather)}`, f.light && `Light ${label(f.light)}`, f.temperature && `Temperature ${label(f.temperature)}`, f.snow && `New snow ${label(f.snow)}`, f.surface && `Surface ${label(f.surface)}`].filter(Boolean).join('; ');
  const where = [c.location, c.trail && !String(c.location).includes(c.trail) ? c.trail : null, f.run_classification && label(f.run_classification), c.gps_lat != null ? `GPS ${c.gps_lat}, ${c.gps_lng}` : null].filter(Boolean).join('. ');
  const logPrint = () => post(`/patrol/incidents/${id}/collision-printed`, {}).catch(() => {});
  const tools = h('div', { class: 'handoff-tools row' }, h('a', { class: 'btn', href: `#/patrol/case/${id}` }, 'Back to the case'), button('Print', async () => { await logPrint(); window.print(); }, { kind: 'primary' }));
  const partyBlock = (p, i) => h('div', { class: 'party-card' },
    h('h4', null, `Party ${i + 1}: ${partyName(p)}`),
    h('p', { class: 'muted' }, [label(p.role), p.age_years != null && `${p.age_years} years`, p.helmet === 'yes' ? 'Helmet' : p.helmet === 'no' ? 'No helmet' : null, p.equipment].filter(Boolean).join(', ')),
    kvp('Contact', [p.phone, p.email, p.address].filter(Boolean).join(', ') || (p.refused_contact_info ? 'Refused to give details' : 'Not recorded')),
    kvp('Before impact', [p.position && p.position !== 'unknown' && label(p.position), p.speed && p.speed !== 'unknown' && `${p.speed} speed`, p.direction].filter(Boolean).join(', ')),
    p.left_scene ? h('p', null, h('b', null, 'Left the scene')) : null,
    p.statement ? h('p', { class: 'prewrap' }, h('b', null, 'Statement: '), p.statement) : null);
  page.append(h('article', { class: 'handoff', 'data-collision-report': id },
    tools,
    h('header', { class: 'hs-head' },
      h('div', null, h('p', { class: 'eyebrow' }, 'Collision report'), h('h1', null, c.case_number || `Case ${id}`), h('p', null, typeText(col.collision_type || 'skier_skier'))),
      h('div', { class: 'hs-meta' }, h('b', null, c.resort.legal_name || c.resort.name), h('span', null, fmtDateTime(c.occurred_at)), h('span', null, where))),
    col.hit_and_run ? h('div', { class: 'hs-alert' }, h('div', null, h('span', { class: 'k' }, 'Other party left the scene'), h('b', null, col.unknown_party_description || 'No description recorded'))) : null,
    section('People involved', c.parties.length ? h('div', { class: 'parties-grid' }, c.parties.map(partyBlock)) : h('p', { class: 'muted' }, 'No one recorded.')),
    h('div', { class: 'hs-grid' },
      h('div', { class: 'stack' },
        section('What happened', h('p', { class: 'prewrap' }, c.narrative || c.summary), kvp('Right of way', col.right_of_way), factorList(col.factors).length ? kvp('Contributing factors', factorText(col.factors).join(', ')) : null),
        section('Scene', kvp('Place', where), kvp('Conditions', conditions || 'Not recorded'))),
      h('div', { class: 'stack' },
        section('Notifications and holds', kvp('Police', col.police_notified ? [col.police_agency || 'Notified', col.police_report_no && `report ${col.police_report_no}`].filter(Boolean).join(', ') : 'Not notified'), kvp('Risk manager or supervisor', yn(col.risk_notified)),
          kvp('Equipment held', col.equipment_held || 'None'), kvp('Property damage', col.property_damage || 'None reported'), col.legal_hold ? h('p', null, h('b', null, 'Legal hold: keep everything about this case')) : null))),
    section('Witnesses', c.witnesses.length ? h('ul', { class: 'plain' }, c.witnesses.map((w) => h('li', { class: 'stack tight' }, h('span', null, h('b', null, w.name), ` ${[w.relation && label(w.relation), w.phone, w.email].filter(Boolean).join(', ')}`), w.statement ? h('span', { class: 'prewrap' }, w.statement) : null))) : h('p', { class: 'muted' }, 'No witnesses recorded.')),
    col.findings ? section('Findings and notes', h('p', { class: 'prewrap' }, col.findings)) : null,
    h('div', { class: 'hs-sign' },
      h('div', null, h('span', { class: 'k' }, 'Prepared by (patrol)'), h('div', { class: 'line' }, (c.responders.find((r) => r.role === 'lead') || {}).first_name ? `${c.responders.find((r) => r.role === 'lead').first_name} ${c.responders.find((r) => r.role === 'lead').last_name}` : '')),
      h('div', null, h('span', { class: 'k' }, 'Signature'), h('div', { class: 'line' })), h('div', null, h('span', { class: 'k' }, 'Reviewed by (risk manager)'), h('div', { class: 'line' })), h('div', null, h('span', { class: 'k' }, 'Date'), h('div', { class: 'line' }))),
    h('p', { class: 'hs-foot muted small' }, 'Confidential. This report has no medical information. Printing it is logged. Share it only with the people involved, the insurer and authorities.')));
}
