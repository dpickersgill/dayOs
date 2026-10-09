// Refusal of care: what was offered, what was explained, and the signature. The page prints as a one-page form;
// "Record the refusal" saves the answers on the patient, sets the outcome to refused care and collects the signatures.
// Every answer starts blank, so nothing is recorded that was not asked. A patient who is not able to decide cannot refuse:
// care continues under implied consent. A parent or guardian signs for anyone under 18. A witness can sign too.

import { get, post, patch } from '../api.js';
import { h, clear, button, toast, formDialog, field, input, select, val, fmtDateTime, label, errorBox, state } from '../ui.js';
import { has } from './patrol-feat.js';
import { signaturePad } from '../sigpad.js';

const SCOPE = [['all_care', 'All care'], ['transport', 'Transport to higher care'], ['some_treatment', 'Some treatment'], ['further_evaluation', 'Further evaluation']];
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
    const wsig = [...c.signatures].reverse().find((s) => s.kind === 'witness' && s.patient_id === p.id);
    const image = async (s) => { if (!s) return null; try { return (await get(`/patrol/incidents/${id}/signatures/${s.id}`)).image; } catch (_) { return null; } };
    const [img, wimg] = await Promise.all([image(sig), image(wsig)]);
    clear(page).append(sheet(c, p, sig, img, wsig, wimg));
  }

  function sheet(c, p, sig, img, wsig, wimg) {
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
        row('Complaint', p.chief_complaint), row('Care and transport offered', f.refusal_care_offered), row('What was refused', (SCOPE.find((x) => x[0] === f.refusal_scope) || [0, ''])[1])),
      h('section', { class: 'hs' }, h('h3', null, 'Decision'),
        row('Patient alert and able to decide', yes(f.refusal_capacity)), row('Risks explained, including that the condition could worsen', yes(f.refusal_risks_explained)), row('Reason given', f.refusal_reason), row('Advice about when to seek care', f.refusal_advice),
        f.refusal_signer === 'guardian' ? row('Signed by a parent or guardian', [f.refusal_guardian_name, f.refusal_guardian_relation].filter(Boolean).join(', ')) : null),
      f.refusal_capacity === 'no' ? h('p', { class: 'refusal-block', role: 'alert' }, h('b', null, 'This patient cannot refuse care. '), 'They were recorded as not able to decide. Continue care under implied consent and escalate to the patrol lead or EMS.') : null,
      h('section', { class: 'hs' }, h('h3', null, 'Statement read to the patient'), h('p', { class: 'statement' }, STATEMENT)),
      h('div', { class: 'hs-sign' },
        h('div', null, h('span', { class: 'k' }, f.refusal_signer === 'guardian' ? 'Parent or guardian signature' : 'Patient signature'), h('div', { class: 'line sigbox' }, img ? h('img', { class: 'sig-img', src: img, alt: `Signature of ${sig.signer_name}` }) : null), sig ? h('span', { class: 'muted small' }, `${sig.signer_name}${sig.signer_role ? ` (${sig.signer_role})` : ''}, ${fmtDateTime(sig.signed_at)}`) : null),
        h('div', null, h('span', { class: 'k' }, 'Witness'), h('div', { class: 'line sigbox' }, wimg ? h('img', { class: 'sig-img', src: wimg, alt: `Signature of ${wsig.signer_name}` }) : (f.refusal_witness || '')), wsig ? h('span', { class: 'muted small' }, `${wsig.signer_name}, ${fmtDateTime(wsig.signed_at)}`) : null),
        h('div', null, h('span', { class: 'k' }, 'Patroller'), h('div', { class: 'line' }, (c.responders.find((r) => r.role === 'lead') ? `${c.responders.find((r) => r.role === 'lead').first_name} ${c.responders.find((r) => r.role === 'lead').last_name}` : ''))),
        h('div', null, h('span', { class: 'k' }, 'Date and time'), h('div', { class: 'line' }, sig ? fmtDateTime(sig.signed_at) : ''))),
      !sig ? h('p', null, state('Not signed yet', 'warn')) : null,
      h('p', { class: 'hs-foot muted small' }, 'Confidential patient information. A patient who refuses care needs this signed before the report can be submitted.'));
  }

  function dialog(c, p, already) {
    const f = p.form || {};
    const minor = p.age_years !== null && p.age_years !== undefined && Number(p.age_years) < 18;
    const pad = signaturePad();
    const wpad = signaturePad();
    const clearBtn = (pd) => { const b = h('button', { type: 'button', class: 'btn small' }, 'Clear'); b.addEventListener('click', () => pd.clear()); return b; };
    const patientName = `${p.first_name || ''} ${p.last_name || ''}`.trim();
    // Nothing is chosen for the patroller: each answer is asked and tapped.
    const scope = select([['', 'Choose'], ...SCOPE], f.refusal_scope || '', { name: 'refusal_scope', required: true });
    const capacity = select([['', 'Choose'], ['yes', 'Yes'], ['no', 'No']], f.refusal_capacity || '', { name: 'refusal_capacity', required: true });
    const risks = select([['', 'Choose'], ['yes', 'Yes'], ['no', 'No']], f.refusal_risks_explained || '', { name: 'refusal_risks_explained', required: true });
    const signerSel = select([['patient', 'The patient'], ['guardian', 'A parent or guardian']], minor ? 'guardian' : (f.refusal_signer || 'patient'), { name: 'refusal_signer', disabled: minor });
    const gName = input({ name: 'refusal_guardian_name', maxlength: 150, value: f.refusal_guardian_name || '' });
    const gRel = input({ name: 'refusal_guardian_relation', maxlength: 100, value: f.refusal_guardian_relation || '', placeholder: 'Mother, father, legal guardian' });
    const guardian = h('div', { class: 'form wide' }, field('Parent or guardian name', gName), field('Relationship to the patient', gRel));
    const signer = input({ name: 'signer_name', maxlength: 150, value: patientName });
    const block = h('p', { class: 'refusal-block', role: 'alert', hidden: true }, h('b', null, 'This patient cannot refuse care. '), 'A patient who is not alert and able to decide cannot make an informed refusal. Continue care under implied consent and escalate to the patrol lead or EMS.');
    const risksNote = h('p', { class: 'refusal-block', role: 'alert', hidden: true }, 'Explain the risks, including that the condition could get worse, before the patient decides.');
    const signBlock = h('div', { class: 'stack' });
    const reflect = () => {
      const g = minor || signerSel.value === 'guardian';
      guardian.hidden = !g;
      if (g && (!signer.value || signer.value === patientName)) signer.value = gName.value;
      block.hidden = capacity.value !== 'no';
      risksNote.hidden = risks.value !== 'no';
      signBlock.hidden = capacity.value === 'no';
    };
    for (const el of [capacity, risks, signerSel]) el.addEventListener('change', reflect);
    gName.addEventListener('input', () => { signer.value = gName.value; });
    signBlock.append(
      h('p', { class: 'statement small' }, STATEMENT),
      h('div', { class: 'form' }, h('div', { class: 'wide' }, field('Printed name of the person signing', signer))),
      h('div', { class: 'field' }, h('span', null, minor ? 'Parent or guardian signature' : 'Signature of the person refusing'), pad.el), h('div', { class: 'row' }, clearBtn(pad)),
      h('div', { class: 'form' }, h('div', { class: 'wide' }, field('Witness to the refusal (name)', input({ name: 'refusal_witness', maxlength: 150, value: f.refusal_witness || '' }), 'Another patroller or someone with the patient. Their signature is optional but makes the record stronger.'))),
      h('div', { class: 'field' }, h('span', null, 'Witness signature (optional)'), wpad.el), h('div', { class: 'row' }, clearBtn(wpad)));
    const form = formDialog(already ? 'Update the refusal' : 'Record the refusal', h('div', { class: 'stack' },
      h('div', { class: 'form' },
        h('div', { class: 'wide' }, field('Care and transport offered', h('textarea', { name: 'refusal_care_offered', rows: 2, maxlength: 2000 }, f.refusal_care_offered || ''), 'What you offered, in plain words: "Splint, ambulance to hospital for an X-ray"')),
        field('What was refused', scope), field('Alert and able to decide', capacity),
        field('Risks explained, including that it could get worse', risks), field('Who signs', signerSel, minor ? `${p.age_years} years old: a parent or guardian signs` : null),
        guardian,
        h('div', { class: 'wide' }, field('Reason given', input({ name: 'refusal_reason', maxlength: 255, value: f.refusal_reason || '' }))),
        h('div', { class: 'wide' }, field('Advice given about when to seek care', input({ name: 'refusal_advice', maxlength: 255, value: f.refusal_advice || '', placeholder: 'See a doctor if pain grows, numbness, headache, vomiting' })))),
      block, risksNote,
      already ? h('p', { class: 'muted small' }, 'The signature on file is kept. Sign again below only if the refusal is signed again.') : null,
      signBlock),
    async (fd) => {
      if (!val(fd, 'refusal_scope') || !val(fd, 'refusal_capacity') || !val(fd, 'refusal_risks_explained')) throw new Error('Answer what was refused, whether the patient can decide, and whether the risks were explained');
      if (val(fd, 'refusal_capacity') === 'no') throw new Error('A patient who is not able to decide cannot refuse care. Continue care under implied consent and escalate.');
      if (val(fd, 'refusal_risks_explained') !== 'yes') throw new Error('Explain the risks before the patient decides');
      const g = minor || signerSel.value === 'guardian';
      if (g && (!val(fd, 'refusal_guardian_name') || !val(fd, 'refusal_guardian_relation'))) throw new Error('Give the parent or guardian\'s name and relationship');
      const needSig = !already || !pad.isEmpty();
      if (needSig && pad.isEmpty()) throw new Error('The signature area is empty');
      await patch(`/patrol/incidents/${id}/patients/${p.id}`, { disposition: 'refused_care', form: {
        refusal_scope: val(fd, 'refusal_scope'), refusal_capacity: val(fd, 'refusal_capacity'), refusal_risks_explained: val(fd, 'refusal_risks_explained'),
        refusal_witness: val(fd, 'refusal_witness'), refusal_reason: val(fd, 'refusal_reason'), refusal_advice: val(fd, 'refusal_advice'), refusal_care_offered: val(fd, 'refusal_care_offered'),
        refusal_signer: g ? 'guardian' : 'patient', refusal_guardian_name: g ? val(fd, 'refusal_guardian_name') : null, refusal_guardian_relation: g ? val(fd, 'refusal_guardian_relation') : null,
      } });
      if (needSig) await post(`/patrol/incidents/${id}/signatures`, { kind: 'refusal_of_care', signer_name: val(fd, 'signer_name') || (g ? val(fd, 'refusal_guardian_name') : patientName) || 'Patient', signer_role: g ? val(fd, 'refusal_guardian_relation') : 'Patient', patient_id: p.id, image: pad.toDataUrl() });
      if (!wpad.isEmpty()) await post(`/patrol/incidents/${id}/signatures`, { kind: 'witness', signer_name: val(fd, 'refusal_witness') || 'Witness', signer_role: 'Witness to the refusal', patient_id: p.id, image: wpad.toDataUrl() });
      toast('Refusal recorded');
      await load();
    }, { submitText: 'Save refusal', wide: true });
    reflect();
    return form;
  }

  await load();
}
