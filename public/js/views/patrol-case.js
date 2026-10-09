// The patient care report ("case"). One page that works on a phone: details, timeline, responders,
// patients (history, vitals, injuries, treatments), signatures, witnesses and notes.

import { get, post, patch, del } from '../api.js';
import { h, clear, ctx, state, input, select, field, button, toast, formDialog, dialog, confirmDialog, val, num, nowInput, fmtDateTime, fmtTime, label, empty, errorBox, fail } from '../ui.js';
import { has } from './patrol-feat.js';
import { signaturePad } from '../sigpad.js';
import { personPicker } from '../widgets.js';
import { loadForm, sectionPanel, sectionVisible } from './nsaar-form.js';
import { bedsideCard } from './patrol-bedside.js';
import { collisionPanel } from './patrol-collision.js';
import { checklistPanel, loadChecklists } from './patrol-checklists.js';

export const CATEGORIES = ['injury', 'collision', 'lost_person', 'equipment', 'medical', 'conduct', 'other'];
export const SEVERITY = ['minor', 'moderate', 'serious', 'critical'];
const INCIDENT_DISPOSITION = ['treated_released', 'transported', 'refused_care', 'no_injury', 'other'];
const EVENTS = [['call_received', 'Call received'], ['dispatched', 'Dispatched'], ['on_scene', 'On scene'], ['patient_contact', 'Patient contact'], ['transport_started', 'Transport started'], ['at_aid_room', 'At aid room'], ['handoff', 'Handoff'], ['cleared', 'Cleared'], ['other', 'Other']];
const REGIONS = ['head', 'face', 'neck', 'shoulder', 'arm', 'elbow', 'wrist_hand', 'chest', 'back', 'abdomen', 'pelvis', 'hip', 'thigh', 'knee', 'lower_leg', 'ankle_foot', 'multiple', 'other'];
const INJURY_TYPES = ['fracture', 'dislocation', 'sprain_strain', 'laceration', 'contusion', 'concussion', 'spinal', 'internal', 'cold_injury', 'illness', 'cardiac', 'other'];
const TREATMENTS = ['splint', 'spinal_motion_restriction', 'bandage', 'ice', 'oxygen', 'aed', 'cpr', 'airway', 'medication', 'warming', 'other'];
const SIGNATURE_KINDS = [['refusal_of_care', 'Refusal of care'], ['patient_acknowledgment', 'Patient acknowledgment'], ['witness', 'Witness'], ['patroller', 'Patroller']];
const sevTone = { minor: 'neutral', moderate: 'warn', serious: 'bad', critical: 'bad' };
const stateTone = { draft: 'warn', submitted: 'neutral', approved: 'good' };
const stateText = { draft: 'Draft', submitted: 'Waiting for approval', approved: 'Approved and locked' };

/** Drops blanks so optional API fields are simply left out. */
export const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(v)));
const opt = (list, blank = 'Not recorded') => [['', blank], ...list.map((x) => (Array.isArray(x) ? x : [x, label(x)]))];

/** Set by "New case" so the next screen carries on: add the patient, then take the first vitals. */
export const flow = { addPatient: false, vitalsNext: false };

export async function renderCase(root, id, { roster }) {
  const page = h('div');
  root.append(page);
  let def = null;
  let trails = null;
  let checklists = [];

  async function load() {
    const keep = window.scrollY;
    let c;
    try {
      [c, def] = await Promise.all([get(`/patrol/incidents/${id}`), loadForm()]);
      if (!trails) trails = (await get('/schedule/trails?limit=500')).data;
      if (!checklists.length) checklists = await loadChecklists();
    } catch (err) { clear(page).append(backLink(), errorBox(err)); return; }
    current = c;
    const open = openSections();
    clear(page).append(draw(c));
    restoreSections(open);
    window.scrollTo(0, keep);
    if (flow.addPatient && !c.patients.length && (c.report_state === 'draft')) { flow.addPatient = false; patientDialog(); }
  }

  // ---- keep the reader's place: a save redraws the page, so remember which sections were open
  const secKey = (d) => `${(d.closest('[data-patient]') || { dataset: {} }).dataset.patient || 'case'}:${d.dataset.section}`;
  const openSections = () => ({ paperwork: Boolean(page.querySelector('details.paperwork[open]')), keys: [...page.querySelectorAll('details[data-section][open]')].map(secKey) });
  function restoreSections(open) {
    if (open.paperwork) { const d = page.querySelector('details.paperwork'); if (d) d.open = true; }
    const want = new Set(open.keys);
    for (const d of page.querySelectorAll('details[data-section]')) if (want.has(secKey(d))) d.open = true;
    if (goNext) {
      const from = [...page.querySelectorAll('details[data-section]')].find((d) => secKey(d) === goNext);
      goNext = null;
      let next = from && from.nextElementSibling;
      while (next && !(next.matches && next.matches('details[data-section]'))) next = next.nextElementSibling;
      if (from && next) {
        from.open = false; next.open = true;
        const dp = page.querySelector('details.paperwork'); if (dp) dp.open = true;
        next.scrollIntoView({ block: 'start' });
        const first = next.querySelector('input:not([type=hidden]), select, textarea');
        if (first) first.focus({ preventScroll: true });
      }
    }
  }
  let goNext = null;

  /** Runs an API change, then redraws the whole report so what is on screen is what the server holds. */
  const change = (fn, message) => async () => { await fn(); if (message) toast(message); await load(); };

  function draw(c) {
    const editable = c.report_state === 'draft' || (c.report_state === 'submitted' && has('approve_case'));
    const paperwork = h('details', { class: 'paperwork panel', 'data-area': 'paperwork' },
      h('summary', null, h('span', null, 'Report paperwork'), h('span', { class: 'muted small' }, ' Incident details, the patient form, witnesses, location, conditions, signatures and sign off')),
      h('div', { class: 'stack' },
        detailsPanel(c, editable),
        c.patients.map((p) => patientCard(p, editable)),
        caseSection(c, editable, 'witness', witnessList(c, editable)),
        caseSection(c, editable, 'location'),
        caseSection(c, editable, 'conditions'),
        signaturesPanel(c, editable),
        caseSection(c, editable, 'signoff')));
    const showCollision = c.category === 'collision' || c.collision || c.parties.length;
    const parts = [
      header(c, editable),
      // While the call is going on, the time stamps come first: they are what gets tapped most.
      c.report_state === 'draft' ? stagesPanel(c, editable) : null,
      progressPanel(c, editable),
      patientsPanel(c, editable),
      showCollision ? collisionPanel(c, { id, editable, reload: load }) : (editable ? h('div', { class: 'row' }, button('Record a collision', () => collisionStart(c), { small: true })) : null),
      c.report_state === 'draft' ? null : stagesPanel(c, editable),
      checklistPanel(c, { id, editable, reload: load, defs: checklists }),
      respondersPanel(c, editable),
      paperwork,
      notesPanel(c),
    ];
    return h('div', { class: 'stack case' }, parts);
  }

  /** What the form needs to know about the rest of the report: who has signed and how many witnesses are on file. */
  const sigCtx = (c, patient) => ({
    witnessCount: c.witnesses.length,
    signed: (f) => c.signatures.some((x) => x.kind === f.kind && (!patient || x.patient_id === patient.id || x.patient_id === null)),
  });

  function caseSection(c, editable, sectionId, extra) {
    const section = def.sections.find((x) => x.id === sectionId);
    return sectionPanel({ def, section, scope: 'case', row: c, editable, required: def.required, ctx: sigCtx(c), trails, extra,
      onSave: async (body, o) => { await patch(`/patrol/incidents/${id}`, body); if (o && o.next) goNext = `case:${sectionId}`; await load(); } });
  }

  const backLink = () => h('p', null, h('a', { href: '#/patrol/cases' }, 'Back to cases'));

  /** Marks an element so a "missing" link can find it. */
  const anchor = (el, area) => { el.dataset.area = area; return el; };

  /**
   * Takes the reader to the thing a "missing" item points at: opens the section, scrolls to the field, puts the cursor in it
   * and outlines it for a moment. `where` is what the server sent with the problem.
   */
  function jumpTo(where) {
    let scope = page;
    if (where.patient_id) scope = page.querySelector(`[data-patient="${where.patient_id}"]`) || page;
    let el = null;
    if (where.section) {
      const sec = scope.querySelector(`details[data-section="${where.section}"]`);
      if (sec) { sec.open = true; el = (where.field && sec.querySelector(`[data-field="${where.field}"]`)) || sec; }
    } else if (where.area) {
      el = page.querySelector(`[data-area="${where.area}"]`);
    }
    if (!el) return;
    for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const target = el.matches('input, select, textarea, button') ? el : el.querySelector('input:not([type=hidden]), select, textarea, button');
    if (target) target.focus({ preventScroll: true });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2500);
  }

  // ------------------------------------------------------------ header and sign-off
  function header(c, editable) {
    const actions = [];
    if (c.report_state === 'draft') {
      const submit = button('Submit report', async () => {
        try { await post(`/patrol/incidents/${id}/submit`, {}); } catch (err) { showProblems(err, 'Not ready to submit', editable); return; }
        toast('Report submitted'); await load();
      }); // the progress panel shows the main button; this one stays quiet until then
      submit.dataset.act = 'submit';
      actions.push(submit);
    }
    if (has('approve_case') && c.report_state !== 'approved') actions.push(button('Approve and lock', () => confirmDialog('Approve this report?', 'Approved reports are locked. Corrections afterwards go in as notes, or you can reopen the report.', 'Approve', async () => {
      try { await post(`/patrol/incidents/${id}/approve`, {}); } catch (err) {
        if (err.status === 409 && Array.isArray(err.details) && err.details.length) { showProblems(err, 'Not ready to approve', editable); return; }
        throw err;
      }
      toast('Report approved');
      await load();
    })));
    if (has('approve_case') && c.report_state !== 'draft') actions.push(button(c.report_state === 'approved' ? 'Reopen' : 'Send back', () => reopenDialog(c)));
    const note = !editable
      ? (c.report_state === 'approved' ? 'This report is approved and locked. You can still add a note.' : 'This report is waiting for a manager. You can add a note; a manager can send it back for changes.')
      : null;
    actions.push(button('Print', () => { for (const d of page.querySelectorAll('details')) d.open = true; window.print(); }, { small: true }));
    return h('div', { class: 'stack' },
      h('p', { class: 'back' }, h('a', { href: '#/patrol/cases' }, 'Back to cases')),
      h('section', { class: 'panel case-head stack' },
        h('div', { class: 'case-title' },
          h('div', null, h('h1', null, c.case_number ? `Report ${c.case_number}` : `Case ${c.id}`),
            h('p', null, `${fmtDateTime(c.occurred_at)} at ${c.location}`),
            h('p', { class: 'muted small' }, `National Ski Area Accident Report for ${c.resort.legal_name || c.resort.name}${c.season ? `, season ${c.season}` : ''}`)),
          h('div', { class: 'row' }, state(stateText[c.report_state], stateTone[c.report_state]), state(label(c.severity), sevTone[c.severity]))),
        note ? h('p', { class: 'lock-note', role: 'status' }, note) : null,
        actions.length ? h('div', { class: 'row actions' }, actions) : null));
  }

  /** Lists what is missing. Each item is a link to the field when the report can be edited by this reader. */
  function showProblems(err, title = 'Not ready to submit', canJump = true) {
    const list = err && err.details && err.details.length ? err.details : [err.message || 'The report is not complete yet'];
    let dlg;
    const items = list.map((x) => {
      const where = typeof x === 'object' && x ? x : {};
      const text = typeof x === 'string' ? x : x.message || JSON.stringify(x);
      const jumpable = canJump && (where.section || where.area);
      if (!jumpable) return h('li', null, text);
      const link = h('button', { type: 'button', class: 'problem-link', title: 'Go to this field' }, text);
      link.addEventListener('click', () => { dlg.close(); jumpTo(where); });
      return h('li', null, link);
    });
    dlg = dialog(title, [h('p', null, canJump ? 'Select an item to go straight to it. Fix them, then try again.' : 'Fix these first, then try again:'), h('ul', { class: 'problems' }, items)]);
  }

  function reopenDialog(c) {
    formDialog(c.report_state === 'approved' ? 'Reopen report' : 'Send back for changes',
      field('Reason', h('textarea', { name: 'reason', maxlength: 500, required: true }), 'This is written into the record.'),
      async (fd) => {
        await post(`/patrol/incidents/${id}/reopen`, { reason: val(fd, 'reason') });
        toast('Report is a draft again');
        await load();
      }, { submitText: 'Reopen' });
  }

  // ------------------------------------------------------------ details
  function detailsPanel(c, editable) {
    if (!editable) {
      return h('section', { class: 'panel stack' }, h('h2', null, 'Incident'),
        kv([['Type', label(c.category)], ['Severity', label(c.severity)], ['Outcome', c.disposition && label(c.disposition)]]),
        h('p', null, h('strong', null, c.summary)), c.narrative ? h('p', { class: 'prewrap' }, c.narrative) : null);
    }
    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'form' },
        field('Incident date and time', input({ type: 'datetime-local', name: 'occurred_at', value: String(c.occurred_at).slice(0, 16).replace(' ', 'T'), required: true }), 'The time it was reported to the first patroller or dispatch, or the time the patient gave'),
        field('Type', select(CATEGORIES, c.category, { name: 'category' })),
        field('Severity', select(SEVERITY, c.severity, { name: 'severity' })),
        field('Outcome', select(opt(INCIDENT_DISPOSITION), c.disposition || '', { name: 'disposition' }))),
      anchor(field('Summary', input({ name: 'summary', value: c.summary, required: true, maxlength: 500 }), 'One line for the case list'), 'summary'),
      anchor(field('Narrative', h('textarea', { name: 'narrative', maxlength: 20000, rows: 5 }, c.narrative || ''), 'What happened, in order, in plain words'), 'narrative'),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save details')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        await patch(`/patrol/incidents/${id}`, { occurred_at: val(fd, 'occurred_at'), category: val(fd, 'category'), severity: val(fd, 'severity'), disposition: val(fd, 'disposition'), summary: val(fd, 'summary'), narrative: val(fd, 'narrative') });
        toast('Details saved');
        await load();
      } catch (err) { fail(err); btn.disabled = false; }
    });
    return h('section', { class: 'panel stack' }, h('h2', null, 'Incident'), form);
  }


  // ------------------------------------------------------------ progress: what is done, and the one next thing to do
  function progressPanel(c, editable) {
    if (c.report_state !== 'draft' || !editable) return null;
    const withPatients = ['injury', 'collision', 'medical'].includes(c.category) || c.patients.length > 0;
    const first = c.patients[0];
    const refused = c.patients.find((p) => p.disposition === 'refused_care');
    const steps = [];
    if (withPatients) {
      steps.push({ key: 'patient', text: 'Add the patient', done: c.patients.length > 0, go: () => patientDialog() });
      steps.push({ key: 'vitals', text: 'Take vitals', done: c.patients.some((p) => p.vitals.length), skip: !first, go: () => { const b = page.querySelector('[data-act=vitals]'); if (b) b.click(); } });
      steps.push({ key: 'care', text: 'Log injuries and treatment', done: c.patients.some((p) => p.injuries.length || p.treatments.length), skip: !first, go: () => injuryDialog(`/patrol/incidents/${id}/patients/${first.id}`) });
      steps.push({ key: 'outcome', text: 'Record the outcome', done: c.patients.length > 0 && c.patients.every((p) => p.disposition), skip: !first, go: () => { const p = c.patients.find((x) => !x.disposition) || first; jumpTo({ patient_id: p.id, section: 'transport', field: 'disposition' }); } });
    }
    if (refused) steps.push({ key: 'refusal', text: 'Get the refusal signed', done: c.signatures.some((x) => x.kind === 'refusal_of_care'), go: () => signatureDialog(c) });
    steps.push({ key: 'lead', text: 'Name the lead responder', done: c.responders.some((r) => r.role === 'lead'), go: () => responderDialog() });
    steps.push({ key: 'story', text: 'Say what happened', done: Boolean(c.narrative && c.narrative.trim()), go: () => jumpTo({ area: 'narrative' }) });
    const done = steps.filter((x) => x.done).length;
    const next = steps.find((x) => !x.done && !x.skip);
    const ready = !next;
    const run = (st) => () => st.go();
    const fill = h('i');
    fill.style.width = `${Math.round((done / steps.length) * 100)}%`;
    return h('section', { class: 'panel stack progress', 'data-area': 'progress' },
      h('div', { class: 'progress-top' },
        h('div', null, h('h2', null, ready ? 'Ready to submit' : 'Next step'), h('p', { class: 'muted' }, ready ? 'Everything the report needs is in. Check it over, then submit it for approval.' : `${done} of ${steps.length} steps done. ${next.text} is next.`)),
        ready ? button('Submit report', () => { const b = page.querySelector('[data-act=submit]'); if (b) b.click(); }, { kind: 'primary' }) : button(next.text, run(next), { kind: 'primary' })),
      h('div', { class: 'pbar', role: 'img', 'aria-label': `${done} of ${steps.length} steps done` }, fill),
      h('ol', { class: 'psteps' }, steps.map((st) => {
        const b = h('button', { type: 'button', class: `pstep${st.done ? ' done' : ''}${st === next ? ' next' : ''}`, 'data-step': st.key }, st.text);
        b.addEventListener('click', run(st));
        return h('li', null, b);
      })));
  }

  // ------------------------------------------------------------ the call, as stages
  const STAGES = ['call_received', 'dispatched', 'on_scene', 'patient_contact', 'transport_started', 'at_aid_room', 'handoff', 'cleared'];
  /** The care timeline as a row of stages: each shows the time it happened, or can be tapped to stamp it now. */
  function stagesPanel(c, editable) {
    const first = (k) => c.events.find((e) => e.kind === k);
    const chip = (k) => {
      const e = first(k);
      if (e) return h('span', { class: 'stage done', 'data-stage': k }, h('span', { class: 'sname' }, label(k)), h('b', null, fmtTime(e.at)));
      if (!editable) return h('span', { class: 'stage', 'data-stage': k }, h('span', { class: 'sname' }, label(k)), h('span', { class: 'muted' }, 'Not recorded'));
      const b = h('button', { type: 'button', class: 'stage todo', 'data-stage': k }, h('span', { class: 'sname' }, label(k)), h('span', null, 'Tap to stamp'));
      b.addEventListener('click', async () => { b.disabled = true; try { await post(`/patrol/incidents/${id}/events`, { kind: k }); toast(`${label(k)} stamped`); await load(); } catch (err) { fail(err); b.disabled = false; } });
      return b;
    };
    return h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Timeline'), editable ? button('Add with a time', () => eventDialog(), { small: true }) : null),
      h('div', { class: 'stages' }, STAGES.map(chip)),
      c.events.length ? h('details', { class: 'more' }, h('summary', null, `All entries (${c.events.length})`), h('ol', { class: 'timeline' }, c.events.map((e) => h('li', null, h('b', null, fmtTime(e.at)), ' ', label(e.kind), e.note ? h('span', { class: 'muted' }, ` ${e.note}`) : null,
        editable ? button('Remove', () => confirmDialog('Remove this entry?', `${label(e.kind)} at ${fmtTime(e.at)}`, 'Remove', change(() => del(`/patrol/incidents/${id}/events/${e.id}`)), { danger: true }), { small: true }) : null)))) : h('p', { class: 'muted' }, 'No times recorded yet.'));
  }
  function eventDialog() {
    formDialog('Add a timeline entry', h('div', { class: 'form' }, field('What happened', select(EVENTS, 'other', { name: 'kind' })), field('Time', input({ type: 'datetime-local', name: 'at', value: nowInput(), required: true })), h('div', { class: 'wide' }, field('Note', input({ name: 'note', maxlength: 255 })))),
      async (fd) => { await post(`/patrol/incidents/${id}/events`, compact({ kind: val(fd, 'kind'), at: val(fd, 'at'), note: val(fd, 'note') })); await load(); });
  }

  // ------------------------------------------------------------ responders
  function respondersPanel(c, editable) {
    return h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Responders'), editable ? anchor(button('Add responder', () => responderDialog(), { small: true }), 'responders') : null),
      c.responders.length ? h('ul', { class: 'plain' }, c.responders.map((r) => h('li', { class: 'spread' }, h('span', null, `${r.first_name} ${r.last_name} `, state(label(r.role), r.role === 'lead' ? 'good' : 'neutral')),
        editable ? button('Remove', change(() => del(`/patrol/incidents/${id}/responders/${r.id}`)), { small: true }) : null))) : h('p', { class: 'muted' }, 'No responders named yet.'));
  }
  function responderDialog() {
    const members = roster.filter((m) => m.staff_status === 'active');
    if (!members.length) { toast('Add patrollers to the Team list first', 'error'); return; }
    formDialog('Add a responder', h('div', { class: 'form' }, field('Patroller', select(members.map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`]), '', { name: 'staff_id' })), field('Role', select([['assist', 'Assist'], ['lead', 'Lead (replaces the current lead)'], ['transport', 'Transport'], ['dispatch', 'Dispatch']], 'assist', { name: 'role' }))),
      async (fd) => { await post(`/patrol/incidents/${id}/responders`, { staff_id: num(fd, 'staff_id'), role: val(fd, 'role') }); await load(); });
  }

  // ------------------------------------------------------------ patients
  function patientsPanel(c, editable) {
    const callbacks = { id, editable, reload: load, change, injuryDialog, treatmentDialog, quickTreatment, pullDialog, followupDialog };
    return h('section', { class: 'stack' },
      h('div', { class: 'spread' }, h('h2', null, c.patients.length === 1 ? 'Patient' : 'Patients'), editable ? anchor(button('Add patient', () => patientDialog(), { kind: 'primary', small: true }), 'patients') : null),
      c.patients.length ? c.patients.map((p) => bedsideCard(p, c, { ...callbacks, base: `/patrol/incidents/${id}/patients/${p.id}` })) : h('div', { class: 'empty' }, h('p', null, c.category === 'injury' || c.category === 'medical' ? 'Add the patient to start the care record.' : 'No patients on this report.')));
  }

  /** Marks the case as a collision and opens the scene form, so the collision panel appears. */
  async function collisionStart(c) {
    await patch(`/patrol/incidents/${id}`, { category: 'collision' });
    toast('Collision report started');
    await load();
  }

  /** Where the follow-up email goes. Kept apart from the clinical form so patrol can fill it in last. */
  function followupDialog(p) {
    const box = (name, text, on) => h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name, checked: Boolean(on) }), ' ', text);
    formDialog(`Follow-up contact: ${p.first_name} ${p.last_name}`.trim(), h('div', { class: 'form' },
      h('div', { class: 'wide' }, field('Patient email', input({ name: 'email', type: 'email', maxlength: 255, value: p.email || '' }), 'Only used for one thank-you email five days later. It never says what happened.')),
      field('Parent or guardian name', input({ name: 'guardian_name', maxlength: 150, value: p.guardian_name || '' })), field('Parent or guardian email', input({ name: 'guardian_email', type: 'email', maxlength: 255, value: p.guardian_email || '' }), 'Required for anyone under 18. Their own address is not used.'),
      box('no_followup', 'Do not contact this patient', p.no_followup)),
    async (fd) => {
      await patch(`/patrol/incidents/${id}/patients/${p.id}`, { email: val(fd, 'email'), guardian_name: val(fd, 'guardian_name'), guardian_email: val(fd, 'guardian_email'), no_followup: fd.get('no_followup') === 'on' });
      toast('Saved');
      await load();
    });
  }

  /** One tap logs a common treatment at the current time. A wrong tap is removed from the list below it. */
  async function quickTreatment(base, kind, text) {
    await post(`${base}/treatments`, { kind });
    toast(`${text} logged`);
    await load();
  }

  function patientCard(p, editable) {
    const base = `/patrol/incidents/${id}/patients/${p.id}`;
    const sections = def.sections.filter((x) => x.scope === 'patient' && sectionVisible(def, x, 'patient', p)).map((section) => sectionPanel({
      def, section, scope: 'patient', row: p, editable, required: def.required, ctx: sigCtx(c0(), p), trails, open: section.id === 'patient' && c0().patients.length === 1,
      onSave: async (body, o) => { await patch(base, body); if (o && o.next) goNext = `${p.id}:${section.id}`; await load(); },
    }));
    return h('article', { class: 'stack patient', 'data-patient': p.id }, h('h3', null, `Patient form: ${p.first_name} ${p.last_name}`), ...sections);
  }

  let current = null;
  const c0 = () => current;

  /** What patrol can see about a guest: details on file, the ticket they hold and the gear they rented that day. */
  async function pullSummary(personId) {
    const r = await get(`/patrol/pull/${personId}?incident_id=${id}`);
    const known = [r.person.age_years != null && `${r.person.age_years} years`, r.person.phone, [r.person.address, r.person.home_town, r.person.region, r.person.postal].filter(Boolean).join(', '), r.person.height, r.person.weight, r.person.discipline && label(r.person.discipline), r.person.ability_level && label(r.person.ability_level)].filter(Boolean).join(', ');
    const gear = (g) => [label(g.category), g.brand, g.model, g.size && `size ${g.size}`, g.din_setting != null && `DIN ${g.din_setting}`, `tag ${g.sku}`].filter(Boolean).join(' ');
    return h('div', { class: 'stack small pull-box' },
      h('p', null, h('b', null, 'On file: '), known || 'Name only'),
      h('p', null, h('b', null, 'Ticket: '), r.tickets.length ? r.tickets.map((t) => `${t.name} (valid ${t.valid_from} to ${t.valid_to})`).join('; ') : 'None found for this day'),
      h('p', null, h('b', null, 'Rented gear: '), r.rentals.length ? r.rentals.map(gear).join('; ') : 'None out on this day'),
      h('p', { class: 'muted small' }, 'Copied into the patient record when you save, filling blank fields only. Nothing you have entered is replaced, and the guest\'s customer, ticket and rental records are not changed. Looking this up is logged.'));
  }

  /** Pull ticket and rental details into a patient who is already on the report. */
  function pullDialog(p) {
    const slot = h('div', { class: 'wide' });
    const show = async (personId) => { clear(slot); if (!personId) return; try { slot.append(await pullSummary(personId)); } catch (err) { slot.append(errorBox(err)); } };
    const picker = p.person_id ? null : personPicker({ label: 'Guest on file', onPick: (g) => show(g && g.id) });
    if (p.person_id) show(p.person_id);
    return formDialog(`Pull from customer record: ${p.first_name} ${p.last_name}`, h('div', { class: 'form' }, picker ? h('div', { class: 'wide' }, picker.el) : null, slot), async () => {
      const personId = p.person_id || (picker.get() && picker.get().id);
      if (!personId) throw new Error('Find the guest first');
      const out = await post(`/patrol/incidents/${id}/patients/${p.id}/pull`, { person_id: personId });
      toast(out.filled.length ? `Filled ${out.filled.length} blank field${out.filled.length === 1 ? '' : 's'}` : 'Nothing new to fill in');
      await load();
    }, { submitText: 'Fill blank fields' });
  }

  /** Adding a patient needs only a name; everything else is on the form sections that follow. */
  function patientDialog() {
    const preview = h('div', { class: 'wide' });
    const picker = personPicker({ label: 'Find a guest on file', onPick: async (g) => {
      clear(preview);
      if (!g) return;
      try { preview.append(await pullSummary(g.id)); } catch (err) { preview.append(errorBox(err)); }
    } });
    formDialog('Add patient', h('div', { class: 'form' },
      h('div', { class: 'wide' }, picker.el), preview,
      field('First name', input({ name: 'first_name', maxlength: 100 })), field('Last name', input({ name: 'last_name', maxlength: 100 })),
      h('p', { class: 'wide muted small' }, 'If the patient cannot tell you, leave the name blank and fill it in as soon as you can. Every effort should be made to find it out.')),
    async (fd) => {
      const guest = picker.get();
      await post(`/patrol/incidents/${id}/patients`, compact({ first_name: val(fd, 'first_name'), last_name: val(fd, 'last_name'), person_id: guest ? guest.id : null }));
      toast('Patient added');
      const startVitals = flow.vitalsNext;
      flow.vitalsNext = false;
      await load();
      if (startVitals) { const b = page.querySelector('[data-act=vitals]'); if (b) b.click(); }
    });
  }

  function injuryDialog(base) {
    formDialog('Add an injury or finding', h('div', { class: 'form' }, field('Body part', select(REGIONS, 'head', { name: 'body_region' })), field('Side', select([['na', 'Not applicable'], ['left', 'Left'], ['right', 'Right'], ['both', 'Both'], ['midline', 'Midline']], 'na', { name: 'side' })),
      field('Type', select(INJURY_TYPES, 'fracture', { name: 'injury_type' })), h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 255 })))),
    async (fd) => { await post(`${base}/injuries`, compact({ body_region: val(fd, 'body_region'), side: val(fd, 'side'), injury_type: val(fd, 'injury_type'), notes: val(fd, 'notes') })); await load(); });
  }

  function treatmentDialog(base) {
    const members = roster.filter((m) => m.staff_status === 'active');
    const kind = select(TREATMENTS, 'splint', { name: 'kind' });
    const meds = h('div', { class: 'form wide', hidden: true }, field('Medication', input({ name: 'medication', maxlength: 100 })), field('Dose', input({ name: 'dose', maxlength: 50, placeholder: '400 mg' })), field('Route', input({ name: 'route', maxlength: 30, placeholder: 'Oral' })));
    kind.addEventListener('change', () => { meds.hidden = kind.value !== 'medication'; });
    formDialog('Add treatment', h('div', { class: 'form' }, field('Time', input({ type: 'datetime-local', name: 'performed_at', value: nowInput(), required: true })), field('Treatment', kind), meds,
      field('Done by', select(opt(members.map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`]), 'Not recorded'), '', { name: 'performed_by_staff' })),
      h('div', { class: 'wide' }, field('Details', input({ name: 'description', maxlength: 255 })))),
    async (fd) => {
      const med = val(fd, 'kind') === 'medication';
      await post(`${base}/treatments`, compact({ performed_at: val(fd, 'performed_at'), kind: val(fd, 'kind'), description: val(fd, 'description'), medication: med ? val(fd, 'medication') : null, dose: med ? val(fd, 'dose') : null, route: med ? val(fd, 'route') : null, performed_by_staff: num(fd, 'performed_by_staff') }));
      await load();
    });
  }

  // ------------------------------------------------------------ signatures
  function signaturesPanel(c, editable) {
    return h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Signatures'), editable ? anchor(button('Collect signature', () => signatureDialog(c), { small: true }), 'signatures') : null),
      c.signatures.length ? h('ul', { class: 'plain' }, c.signatures.map((s) => {
        const who = s.patient_id ? c.patients.find((p) => p.id === s.patient_id) : null;
        return h('li', { class: 'spread' }, h('span', null, h('b', null, label(s.kind)), ` signed by ${s.signer_name}`, who ? ` for ${who.first_name} ${who.last_name}` : '', h('span', { class: 'muted' }, ` ${fmtDateTime(s.signed_at)}`)),
          button('View', async () => { const full = await get(`/patrol/incidents/${id}/signatures/${s.id}`); dialog(`${label(s.kind)}: ${s.signer_name}`, h('img', { class: 'sig-img', src: full.image, alt: `Signature of ${s.signer_name}` })); }, { small: true }));
      })) : h('p', { class: 'muted' }, 'No signatures yet. A patient who refuses care needs a signed refusal before the report can be submitted.'),
      editable ? null : null, h('p', { class: 'muted small' }, 'Signatures cannot be edited or removed once saved.'));
  }
  function signatureDialog(c) {
    const pad = signaturePad();
    const patients = [['', 'Not tied to one patient'], ...c.patients.map((p) => [p.id, `${p.first_name} ${p.last_name}`])];
    const hasRefusal = c.patients.some((p) => p.disposition === 'refused_care');
    const name = input({ name: 'signer_name', required: true, maxlength: 150 });
    const kind = select(SIGNATURE_KINDS, hasRefusal ? 'refusal_of_care' : 'patient_acknowledgment', { name: 'kind' });
    const patientSel = select(patients, (c.patients.find((p) => p.disposition === 'refused_care') || c.patients[0] || {}).id || '', { name: 'patient_id' });
    const clearBtn = h('button', { type: 'button', class: 'btn small' }, 'Clear');
    clearBtn.addEventListener('click', () => pad.clear());
    formDialog('Collect a signature', h('div', { class: 'stack' },
      h('div', { class: 'form' }, field('Kind', kind), field('Patient', patientSel), h('div', { class: 'wide' }, field('Printed name of signer', name))),
      h('div', { class: 'field' }, h('span', null, 'Signature'), pad.el), h('div', { class: 'row' }, clearBtn),
      h('p', { class: 'muted small' }, 'The signer signs above with a finger or pen. For a refusal, read the refusal statement to the patient first.')),
    async (fd) => {
      if (pad.isEmpty()) throw new Error('The signature area is empty');
      await post(`/patrol/incidents/${id}/signatures`, compact({ kind: val(fd, 'kind'), signer_name: val(fd, 'signer_name'), patient_id: num(fd, 'patient_id'), image: pad.toDataUrl() }));
      toast('Signature saved');
      await load();
    }, { submitText: 'Save signature' });
  }

  // ------------------------------------------------------------ witnesses and notes
  function witnessList(c, editable) {
    return h('div', { class: 'stack' }, h('div', { class: 'spread' }, h('h4', null, 'Witnesses on file'), editable ? button('Add witness', () => witnessDialog(), { small: true }) : null),
      c.witnesses.length ? h('ul', { class: 'plain' }, c.witnesses.map((w) => h('li', { class: 'stack tight' }, h('div', { class: 'spread' }, h('span', null, w.relation ? `${label(w.relation)}: ` : '', h('b', null, w.name), h('span', { class: 'muted' }, ` ${[w.phone, w.email, [w.address, w.city, w.region, w.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ')}`)), editable ? button('Remove', change(() => del(`/patrol/incidents/${id}/witnesses/${w.id}`)), { small: true }) : null), w.statement ? h('p', { class: 'prewrap' }, w.statement) : null))) : h('p', { class: 'muted' }, 'No witnesses recorded.'));
  }
  function witnessDialog() {
    formDialog('Add a witness', h('div', { class: 'form' },
      field('Relation to the incident', select([['', 'Not recorded'], ['witnessed_by', 'Witnessed by'], ['accompanied_by', 'Accompanied by'], ['collided_with', 'Collided with'], ['other', 'Other']], '', { name: 'relation' })),
      field('Name', input({ name: 'name', required: true, maxlength: 150 })), field('Phone', input({ name: 'phone', type: 'tel', maxlength: 40 })), field('Email', input({ name: 'email', type: 'email', maxlength: 255 })),
      h('div', { class: 'wide' }, field('Home address', input({ name: 'address', maxlength: 255 }))), field('City', input({ name: 'city', maxlength: 100 })), field('Province or state', input({ name: 'region', maxlength: 60 })), field('Postal or zip code', input({ name: 'postal', maxlength: 20 })),
      h('div', { class: 'wide' }, field('What they saw', h('textarea', { name: 'statement', maxlength: 10000, rows: 4 }), 'In their own words. Do not lead them: ask what they saw and whether they noticed anything unusual before the incident.'))),
    async (fd) => { await post(`/patrol/incidents/${id}/witnesses`, compact({ relation: val(fd, 'relation'), name: val(fd, 'name'), phone: val(fd, 'phone'), email: val(fd, 'email'), address: val(fd, 'address'), city: val(fd, 'city'), region: val(fd, 'region'), postal: val(fd, 'postal'), statement: val(fd, 'statement') })); await load(); });
  }

  function notesPanel(c) {
    const text = h('textarea', { maxlength: 5000, rows: 3, 'aria-label': 'New note' });
    return h('section', { class: 'panel stack' }, h('h2', null, 'Notes and addenda'),
      c.notes.length ? c.notes.map((n) => h('div', { class: 'note' }, h('div', { class: 'muted small' }, `${fmtDateTime(n.created_at)}${n.author ? `, ${n.author}` : ''}`), h('p', { class: 'prewrap' }, n.body))) : h('p', { class: 'muted' }, 'No notes yet.'),
      field('Add a note', text, 'Notes stay open after a report is approved. Use them for corrections and follow-up.'),
      h('div', { class: 'row' }, button('Add note', async () => {
        if (!text.value.trim()) throw new Error('Write a note first');
        await post(`/patrol/incidents/${id}/notes`, { body: text.value.trim() });
        await load();
      })));
  }

  await load();
}

/** Label and value rows; rows with no value are left out. */
function kv(pairs) {
  const shown = pairs.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!shown.length) return null;
  return h('dl', { class: 'kv' }, shown.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}
export { kv, ctx, empty };
