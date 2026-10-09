// Refusal of care: what was offered, what was explained, and the patient's signature. The page prints as a one-page form;
// "Record the refusal" saves the answers on the patient, sets the outcome to refused care and collects the signature.

import { get, post, patch } from '../api.js';
import { h, clear, button, toast, formDialog, field, input, select, val, fmtDateTime, label, errorBox, state } from '../ui.js';
import { has } from './patrol-feat.js';
import { signaturePad } from '../sigpad.js';

const SCOPE = [['all_care', 'All care'], ['transport', 'Transport to higher care'], ['some_treatment', 'Some treatment'], ['further_evaluation', 'Further evaluation']];
const YN = [['', 'Not recorded'], ['yes', 'Yes'], ['no', 'No']];
const yes = (v) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : 'Not recorded');
export const STATEMENT = 'I have been told that I may be hurt more seriously than I feel, and that my condition could get worse if I do not accept the care or transport offered. The risks have been explained to me and I understand them. I choose to decline, and I will seek care right away if I get worse. I release the ski patrol and the mountain from responsibility for the result of my decision.';

export async function renderRefusal(root, id, pid) {
  const page = h('div', { class: 'stack' });
  root.append(page);
  async function load() {
    let c;
    try { c = await get(`/patrol/incidents/${id}`); } catch (err) { clear(page).append(h('p', null, h('a', { href: `#/patrol/case/${id}` }, 'Back to the case')), errorBox(err)); return; }
    const p = c.patients.find((x) => x.id === Number(pid));
    if (!p) { clear(page).append(h('p', null, h('a', { href: `#/patrol/case/${id}` }, 'Back to the case')), errorBox(new Error('Patient not found on this case'))); return; }
    const sig = [...c.signatures].reverse().find((s) => s.kind === 'refusal_of_care' && s.patient_id === p.id);
    let img = null;
    if (sig) { try { img = (await get(`/patrol/incidents/${id}/signatures/${sig.id}`)).image; } catch (_) { img = null; } }
    clear(page).append(sheet(c, p, sig, img));
  }

  function sheet(c, p, sig, img) {
    const editable = c.report_state === 'draft' || (c.report_state === 'submitted' && has('approve_case'));
    const f = p.form || {};
    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Name not known';
    const row = (k, v) => h('p', null, h('b', null, `${k}: `), v || h('span', { class: 'muted' }, 'Not recorded'));
    const tools = h('div', { class: 'handoff-tools row' }, h('a', { class: 'btn', href: `#/patrol/case/${id}` }, 'Back to the case'), button('Print', () => window.print(), { kind: 'primary' }), editable ? button(sig ? 'Update the answers' : 'Record the refusal', () => dialog(c, p, Boolean(sig)), { kind: sig ? undefined : 'primary' }) : null);
    return h('article', { class: 'handoff', 'data-refusal': p.id },
      tools,
      h('header', { class: 'hs-head' },
        h('div', null, h('p', { class: 'eyebrow' }, 'Refusal of care'), h('h1', null, name), h('p', null, [p.age_years != null && `${p.age_years} years`, p.sex && p.sex !== 'unknown' && label(p.sex)].filter(Boolean).join(', '))),
        h('div', { class: 'hs-meta' }, h('b', null, c.resort.legal_name || c.resort.name), h('span', null, c.case_number || `Case ${c.id}`), h('span', null, fmtDateTime(c.occurred_at)), h('span', { class: 'muted' }, c.location))),
      h('section', { class: 'hs' }, h('h3', null, 'What was found and offered'),
        row('Complaint', p.chief_complaint), row('Care offered', p.assessment ? p.assessment.slice(0, 300) : ''), row('What was refused', (SCOPE.find((x) => x[0] === f.refusal_scope) || [0, ''])[1])),
      h('section', { class: 'hs' }, h('h3', null, 'Decision'),
        row('Patient alert and able to decide', yes(f.refusal_capacity)), row('Risks explained, including that the condition could worsen', yes(f.refusal_risks_explained)), row('Reason given', f.refusal_reason), row('Advice about when to seek care', f.refusal_advice)),
      h('section', { class: 'hs' }, h('h3', null, 'Statement read to the patient'), h('p', { class: 'statement' }, STATEMENT)),
      h('div', { class: 'hs-sign' },
        h('div', null, h('span', { class: 'k' }, 'Patient signature'), h('div', { class: 'line sigbox' }, img ? h('img', { class: 'sig-img', src: img, alt: `Signature of ${sig.signer_name}` }) : null), sig ? h('span', { class: 'muted small' }, `${sig.signer_name}, ${fmtDateTime(sig.signed_at)}`) : null),
        h('div', null, h('span', { class: 'k' }, 'Witness'), h('div', { class: 'line' }, f.refusal_witness || '')),
        h('div', null, h('span', { class: 'k' }, 'Patroller'), h('div', { class: 'line' }, (c.responders.find((r) => r.role === 'lead') ? `${c.responders.find((r) => r.role === 'lead').first_name} ${c.responders.find((r) => r.role === 'lead').last_name}` : ''))),
        h('div', null, h('span', { class: 'k' }, 'Date and time'), h('div', { class: 'line' }, sig ? fmtDateTime(sig.signed_at) : ''))),
      !sig ? h('p', null, state('Not signed yet', 'warn')) : null,
      h('p', { class: 'hs-foot muted small' }, 'Confidential patient information. A patient who refuses care needs this signed before the report can be submitted.'));
  }

  function dialog(c, p, already) {
    const f = p.form || {};
    const pad = signaturePad();
    const clearBtn = h('button', { type: 'button', class: 'btn small' }, 'Clear');
    clearBtn.addEventListener('click', () => pad.clear());
    const signer = input({ name: 'signer_name', maxlength: 150, value: `${p.first_name || ''} ${p.last_name || ''}`.trim() });
    formDialog(already ? 'Update the refusal' : 'Record the refusal', h('div', { class: 'stack' },
      h('div', { class: 'form' },
        field('What was refused', select(SCOPE, f.refusal_scope || 'all_care', { name: 'refusal_scope' })), field('Alert and able to decide', select(YN, f.refusal_capacity || 'yes', { name: 'refusal_capacity' })),
        field('Risks explained, including that it could get worse', select(YN, f.refusal_risks_explained || 'yes', { name: 'refusal_risks_explained' })), field('Witness to the refusal', input({ name: 'refusal_witness', maxlength: 150, value: f.refusal_witness || '' })),
        h('div', { class: 'wide' }, field('Reason given', input({ name: 'refusal_reason', maxlength: 255, value: f.refusal_reason || '' }))),
        h('div', { class: 'wide' }, field('Advice given about when to seek care', input({ name: 'refusal_advice', maxlength: 255, value: f.refusal_advice || '', placeholder: 'See a doctor if pain grows, numbness, headache, vomiting' })))),
      already ? h('p', { class: 'muted small' }, 'The signature on file is kept. Add a new signature below only if the patient signs again.') : null,
      h('p', { class: 'statement small' }, STATEMENT),
      h('div', { class: 'form' }, h('div', { class: 'wide' }, field('Printed name of signer', signer))),
      h('div', { class: 'field' }, h('span', null, 'Patient signature'), pad.el), h('div', { class: 'row' }, clearBtn)),
    async (fd) => {
      const needSig = !already || !pad.isEmpty();
      if (needSig && pad.isEmpty()) throw new Error('The signature area is empty');
      await patch(`/patrol/incidents/${id}/patients/${p.id}`, { disposition: 'refused_care', form: { refusal_scope: val(fd, 'refusal_scope'), refusal_capacity: val(fd, 'refusal_capacity'), refusal_risks_explained: val(fd, 'refusal_risks_explained'), refusal_witness: val(fd, 'refusal_witness'), refusal_reason: val(fd, 'refusal_reason'), refusal_advice: val(fd, 'refusal_advice') } });
      if (needSig) await post(`/patrol/incidents/${id}/signatures`, { kind: 'refusal_of_care', signer_name: val(fd, 'signer_name') || 'Patient', patient_id: p.id, image: pad.toDataUrl() });
      toast('Refusal recorded');
      await load();
    }, { submitText: 'Save refusal', wide: true });
  }

  await load();
}
