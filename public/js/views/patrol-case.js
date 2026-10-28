// The patient care report ("case"). One page, three views, for the three jobs a patroller does with it:
//   Care    on the hill: time stamps, the bedside card, assessment tools and treatments, built for gloved thumbs
//   Report  the write-up: the NSAAR form (filled in from the care entries where it can be), a draft narrative, sign-off
//   Record  the history: notes and addenda, frozen versions, and everything marked entered in error
// A wristband bar at the top always says whose record this is and what might hurt them, and switches between the views.

import { get, post, patch } from '../api.js';
import { h, clear, state, input, select, field, button, toast, formDialog, dialog, confirmDialog, val, num, nowInput, nowStamp, fmtDateTime, fmtTime, fmtDate, fmtTimeZoned, label, empty, errorBox, fail, ctx } from '../ui.js';
import { has } from './patrol-feat.js';
import { shareButton } from '../share.js';
import { signaturePad } from '../sigpad.js';
import { personPicker } from '../widgets.js';
import { loadForm, keptForm, sectionPanel, sectionVisible, naWords } from './nsaar-form.js';
import { bedsideCard, voidedNote } from './patrol-bedside.js';
import { collisionPanel } from './patrol-collision.js';
import { checklistPanel, loadChecklists } from './patrol-checklists.js';
import { voidDialog, sentToast } from './patrol-tools.js';
import { send, pending, onChange as onOutbox, flush, retry, discard, waitingCounts, keepCase, keptCase, realCaseId, cachedList } from '../outbox.js';
import { draftNarrative } from '../narrative.js';
import { live, lateNote, treatmentName, atTime } from '../care-text.js';
import { searchPanel, recordsPanel } from './patrol-search.js';
import { legalHoldControl } from './patrol-records.js';
import { photosPanel } from './patrol-photos.js';
import { leaveDialog, leavePanel, skipLabel } from '../leavecheck.js';
import { conditionsBox, contactsPanel, liftBox, attractionBox, rentalsPanel } from './patrol-conditions.js';
import { kitUsePanel } from './patrol-kits.js';
import { claimPanel } from './patrol-claim.js';
import { scenePanel, witnessLinkButton } from './patrol-scene.js';

export const CATEGORIES = ['injury', 'collision', 'lost_person', 'equipment', 'medical', 'conduct', 'other'];
export const SEVERITY = ['minor', 'moderate', 'serious', 'critical'];
const INCIDENT_DISPOSITION = ['treated_released', 'transported', 'refused_care', 'no_injury', 'other'];
const EVENTS = [['call_received', 'Call received'], ['dispatched', 'Dispatched'], ['on_scene', 'On scene'], ['patient_contact', 'Patient contact'], ['transport_started', 'Transport started'], ['at_aid_room', 'At aid room'], ['handoff', 'Handoff'], ['cleared', 'Cleared'], ['other', 'Other']];
const REGIONS = ['head', 'face', 'neck', 'shoulder', 'arm', 'elbow', 'wrist_hand', 'chest', 'back', 'abdomen', 'pelvis', 'hip', 'thigh', 'knee', 'lower_leg', 'ankle_foot', 'multiple', 'other'];
const INJURY_TYPES = ['fracture', 'dislocation', 'sprain_strain', 'laceration', 'contusion', 'concussion', 'spinal', 'internal', 'cold_injury', 'illness', 'cardiac', 'other'];
const TREATMENTS = ['bandage', 'ice', 'warming', 'airway', 'cpr', 'aed', 'splint', 'spinal_motion_restriction', 'oxygen', 'pelvic_binder', 'other'];
const SIGNATURE_KINDS = [['refusal_of_care', 'Refusal of care'], ['patient_acknowledgment', 'Patient acknowledgment'], ['witness', 'Witness'], ['patroller', 'Patroller'], ['receiving_provider', 'Receiving provider (hand-off)']];
const sevTone = { minor: 'neutral', moderate: 'warn', serious: 'bad', critical: 'bad' };
const stateTone = { draft: 'warn', submitted: 'neutral', approved: 'good' };
const stateText = { draft: 'Draft', submitted: 'Waiting for review', approved: 'Approved and locked' };
const MODES = [['care', 'Care'], ['report', 'Report'], ['record', 'Record']];

/** Drops blanks so optional API fields are simply left out. */
export const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(v)));
const opt = (list, blank = 'Not recorded') => [['', blank], ...list.map((x) => (Array.isArray(x) ? x : [x, label(x)]))];

/** Set by "New case" so the next screen carries on: add the patient, then take the first vitals. */
export const flow = { addPatient: false, vitalsNext: false };

/**
 * opts: { roster, me, mode, version }. `version` opens a frozen copy (read only); `mode` picks the first view.
 */
export async function renderCase(root, id, { roster = [], me = {}, mode: wanted, version } = {}) {
  const page = h('div');
  root.append(page);
  let def = null;
  let trails = null;
  let lifts = null;
  let attractions = null;
  let checklists = [];
  let current = null;
  let frozen = null;
  let mode = MODES.some(([k]) => k === wanted) ? wanted : null;
  let activePid = null;

  async function load() {
    const keep = window.scrollY;
    let c;
    // A case started with no signal: shown from this phone until it reaches the server, then the page moves to it.
    if (id < 0 && !version) {
      const real = realCaseId(id);
      if (real) { location.replace(`#/patrol/case/${real}/${mode || 'care'}`); return; }
      const kept = keptCase(id);
      if (!kept) { clear(page).append(backLink(), errorBox(new Error('This case is not on this phone. If it was sent already, open it from the case list.'))); return; }
      ({ c, def, trails, checklists } = kept.data); lifts = kept.data.lifts || []; attractions = kept.data.attractions || [];
      def = def || keptForm();
      if (!def) { clear(page).append(backLink(), errorBox(new Error('This phone has not loaded the report form yet. The case is kept here: open it again once there is a signal.'))); return; }
      current = c; mode = 'care';
      redraw(); return;
    }
    try {
      if (version) {
        let v;
        [v, def] = await Promise.all([get(`/patrol/incidents/${id}/versions/${version}`), loadForm()]);
        frozen = v; c = v.case;
      } else {
        [c, def] = await Promise.all([get(`/patrol/incidents/${id}`), loadForm()]);
      }
      // the lists the location picker offers are kept on the phone for a dead spot (outbox.js)
      if (!trails) trails = await cachedList('trails', async () => (await get('/schedule/trails?limit=500')).data);
      if (!lifts) lifts = await cachedList('lifts', async () => (await get('/schedule/lifts?limit=200')).data).catch(() => []);
      if (!attractions) attractions = await cachedList('attractions', async () => (await get('/attractions')).data).catch(() => []);
      if (!checklists.length) checklists = await loadChecklists(id);
    } catch (err) {
      // No signal: keep what is on screen. Bedside entries are kept on the phone meanwhile.
      const offline = (globalThis.navigator && globalThis.navigator.onLine === false) || !(err && err.status);
      if (current && offline) { toast('No connection. Showing what was last loaded.', 'warn'); redraw(); return; }
      // Opened in a dead spot: the copy kept on this phone the last time it was opened (up to 12 hours).
      const kept = offline && !version ? keptCase(id) : null;
      if (kept) {
        ({ c, def, trails, checklists } = kept.data); lifts = kept.data.lifts || []; attractions = kept.data.attractions || [];
        current = c; if (!mode) mode = 'care';
        toast(`No connection. Showing the copy on this phone from ${new Date(kept.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}; new entries are sent when the signal returns.`, 'warn');
        redraw(); return;
      }
      clear(page).append(backLink(), errorBox(err)); return;
    }
    if (!version) keepCase(id, { c, def, trails, checklists, lifts, attractions });
    current = c;
    if (!mode) mode = c.report_state === 'draft' && !version ? 'care' : 'report';
    redraw();
    window.scrollTo(0, keep);
    if (flow.addPatient && !live(c.patients).length && c.report_state === 'draft') { flow.addPatient = false; patientDialog(); }
  }

  function redraw() {
    const open = openSections();
    clear(page).append(draw(current));
    restoreSections(open);
  }

  // The signal strip follows the connection: redraw (what is on screen) when it drops or returns.
  const onSignal = () => { if (!page.isConnected) { window.removeEventListener('online', onSignal); window.removeEventListener('offline', onSignal); return; } if (current) redraw(); };
  window.addEventListener('online', onSignal); window.addEventListener('offline', onSignal);
  // Redraw when entries kept on the phone go out (or come back refused).
  let outboxTimer = null;
  const stopOutbox = onOutbox(() => {
    if (!page.isConnected) { stopOutbox(); return; }
    clearTimeout(outboxTimer);
    outboxTimer = setTimeout(() => { if (!pending(id).length) load(); else redraw(); }, 200);
  });

  // ---- keep the reader's place: a save redraws the page, so remember which sections were open
  const secKey = (d) => `${(d.closest('[data-patient]') || { dataset: {} }).dataset.patient || 'case'}:${d.dataset.section}`;
  const openSections = () => ({ keys: [...page.querySelectorAll('details[data-section][open]')].map(secKey) });
  function restoreSections(open) {
    const want = new Set(open.keys);
    for (const d of page.querySelectorAll('details[data-section]')) if (want.has(secKey(d))) d.open = true;
    if (goNext) {
      const from = [...page.querySelectorAll('details[data-section]')].find((d) => secKey(d) === goNext);
      goNext = null;
      let next = from && from.nextElementSibling;
      while (next && !(next.matches && next.matches('details[data-section]'))) next = next.nextElementSibling;
      if (from && next) {
        from.open = false; next.open = true;
        next.scrollIntoView({ block: 'start' });
        const first = next.querySelector('input:not([type=hidden]), select, textarea');
        if (first) first.focus({ preventScroll: true });
      }
    }
  }
  let goNext = null;

  /** Runs an API change, then redraws the whole report so what is on screen is what the server holds. */
  const change = (fn, message) => async () => { await fn(); if (message) toast(message); await load(); };

  // ------------------------------------------------------------ the page
  function draw(c) {
    const editable = !version && (c.report_state === 'draft' || (c.report_state === 'submitted' && has('approve_case') && !(c.review && c.review.group)));
    const pts = live(c.patients);
    if (!pts.some((p) => p.id === activePid)) activePid = pts.length ? pts[0].id : null;
    const panes = {
      care: carePane(c, editable),
      report: reportPane(c, editable),
      record: recordPane(c, editable),
    };
    for (const [k, el] of Object.entries(panes)) { el.id = `pane-${k}`; el.hidden = k !== mode; }
    return h('div', { class: 'stack case', 'data-mode': mode },
      wristband(c),
      version ? versionBanner() : null,
      outboxStrip(c),
      editable || c.report_state !== 'draft' ? leavePanel({ ...c, waiting: pending(id) }, leaveCtx(editable), leaveOn()) : null,
      progressPanel(c, editable),
      panes.care, panes.report, panes.record);
  }

  function setMode(next, { focus = false } = {}) {
    mode = next;
    const box = page.querySelector('.case');
    if (!box) return;
    box.dataset.mode = next;
    for (const pane of box.querySelectorAll(':scope > .pane')) pane.hidden = pane.dataset.pane !== next;
    for (const t of box.querySelectorAll('.modes [role=tab]')) { const on = t.dataset.mode === next; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); }
    if (!version) { try { history.replaceState(null, '', `#/patrol/case/${id}/${next}`); } catch (_) { /* the view still switches */ } }
  }

  const backLink = () => h('p', { class: 'back' }, h('a', { href: '#/patrol/cases', 'aria-label': 'Back to cases' }, '‹ Cases'));

  /** The bar at the top: whose record, what might hurt them, the report state, and the three views. */
  function wristband(c) {
    const pts = live(c.patients);
    const p = pts.find((x) => x.id === activePid);
    const allergy = p && p.allergies && !/^(none|no|nkda|nka|n\/a|na|nil|denies)\b/i.test(p.allergies.trim()) ? p.allergies : null;
    const who = p ? h('div', { class: 'wb-who' },
      h('b', { class: 'wb-name' }, `${p.first_name} ${p.last_name}`.trim()),
      h('span', { class: 'wb-sub' }, [p.age_years != null && `${p.age_years} y`, p.sex && p.sex !== 'unknown' && label(p.sex)[0]].filter(Boolean).join(' ')),
      allergy ? h('span', { class: 'wb-allergy' }, `Allergy: ${allergy}`) : (p.allergies ? null : h('span', { class: 'wb-unknown' }, 'Allergies not asked')),
      pts.length > 1 ? h('span', { class: 'wb-more' }, `+${pts.length - 1} more`) : null)
      : h('div', { class: 'wb-who' }, h('b', { class: 'wb-name' }, c.summary));
    const tabs = h('div', { class: 'modes', role: 'tablist', 'aria-label': 'Case views' }, MODES.map(([k, text]) => {
      const t = h('button', { type: 'button', role: 'tab', 'data-mode': k, id: `tab-${k}`, 'aria-controls': `pane-${k}`, 'aria-selected': String(k === mode), tabIndex: k === mode ? 0 : -1 }, text);
      t.addEventListener('click', () => { if (mode !== k) { setMode(k); window.scrollTo(0, 0); } });
      t.addEventListener('keydown', (e) => {
        const i = MODES.findIndex(([x]) => x === k);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setMode(MODES[(i + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length][0], { focus: true }); }
      });
      return t;
    }));
    return h('header', { class: 'wristband' },
      h('div', { class: 'wb-top' }, backLink(),
        h('span', { class: 'wb-case' }, c.case_number ? `Report ${c.case_number}` : c.offline ? 'New case, not sent yet' : `Case ${c.id}`),
        h('span', { class: 'wb-state' }, state(stateText[c.report_state], stateTone[c.report_state]), state(label(c.severity), sevTone[c.severity])),
        c.offline ? null : shareButton('patrol_case', c.id)),
      who, tabs);
  }

  function versionBanner() {
    return h('div', { class: 'version-banner', role: 'note' },
      h('b', null, `Version ${frozen.version_no}: ${frozen.kind === 'approved' ? 'as approved' : 'as submitted'}`),
      ` by ${frozen.created_by || 'unknown'}, ${fmtDateTime(frozen.created_at)}. This is a frozen copy, kept so the record shows what was signed off. `,
      h('a', { href: `#/patrol/case/${id}/record` }, 'Open the live report'));
  }

  /**
   * The one signal strip on a case: no signal, a case started with none, what is kept on this phone waiting to send,
   * and any entry the server refused. It redraws as the signal and the outbox change.
   */
  function outboxStrip(c) {
    if (version) return null;
    const offline = globalThis.navigator && globalThis.navigator.onLine === false;
    const list = pending(id);
    const others = waitingCounts(id).others;
    if (!offline && !c.offline && !list.length && !others) return null;
    const waiting = list.filter((x) => !x.error);
    const refused = list.filter((x) => x.error);
    const count = `${waiting.length} entr${waiting.length === 1 ? 'y' : 'ies'}`;
    const head = c.offline ? 'Started with no signal. ' : offline ? 'No signal. ' : '';
    const words = waiting.length ? `${count} waiting to send.` : offline ? 'Bedside entries, time stamps and signatures are kept on this phone and sent when the signal returns.' : c.offline ? 'Sending the case now.' : '';
    return h('section', { class: `outbox-strip${offline ? ' no-signal' : ''}`, role: 'status', 'data-area': 'outbox', 'data-offline': offline ? 'true' : 'false' },
      head || words ? h('div', { class: 'spread' }, h('span', null, h('b', null, head), words),
        waiting.length && !offline ? button('Send now', async () => { const n = await flush(); toast(n ? `Sent ${n}` : 'Still no connection', n ? 'ok' : 'warn'); }, { small: true }) : null) : null, // Send now once there is a signal to send with
      others ? h('p', null, h('b', null, `${others} entr${others === 1 ? 'y' : 'ies'} for this case from another patroller ${others === 1 ? 'is' : 'are'} waiting on this phone. `), 'They send when that patroller signs in here with a signal.') : null,
      refused.map((x) => h('div', { class: 'spread refused' }, h('span', null, h('b', null, `Not saved: ${x.label}. `), x.error),
        h('span', { class: 'row tight' }, button('Try again', () => retry(x.id), { small: true }), button('Discard', () => confirmDialog('Discard this entry?', `${x.label}, taken ${fmtDateTime(x.at)}. It was never saved to the report.`, 'Discard', () => discard(x.id), { danger: true }), { small: true, kind: 'quiet-danger' })))));
  }

  /** What the form needs to know about the rest of the report: who has signed and how many witnesses are on file. */
  const sigCtx = (c, patient) => ({
    witnessCount: c.witnesses.filter((w) => !w.voided_at).length,
    signed: (f) => c.signatures.some((x) => x.kind === f.kind && (!patient || x.patient_id === patient.id || x.patient_id === null)),
  });

  /** Ask "before the patient leaves" (the patrol director turns it on under Report requirements). */
  const leaveOn = () => Boolean(def && def.rules && def.rules.options && def.rules.options.leave);
  const leaveCtx = (editable) => ({ id, editable, reload: load, redraw, refusalHref: (pid) => `#/patrol/refusal/${id}/${pid}` });
  /** After an outcome or a hand-off: the checklist for whoever is leaving, once the page shows the new state. */
  const askBeforeLeaving = (patientId, stamp = null) => {
    if (!leaveOn() || !current) return;
    // a stamp still waiting on the phone counts too, so the checklist opens with no signal
    const base = { ...current, waiting: pending(id) };
    const c = stamp ? { ...base, leave: null, events: [...(current.events || []), { kind: stamp, at: nowStamp(), patient_id: null }] } : base;
    leaveDialog(c, leaveCtx(true), { patientId });
  };

  /**
   * The report requirements for one row (the case, or one patient) as field key -> item. Online, the server worked them out;
   * a case started with no signal marks fields from the rules the phone keeps (without counting what is left).
   */
  function reqMap(c, scope, pid) {
    if (c.requirements) return new Map(c.requirements.items.filter((i) => i.scope === scope && (scope === 'case' ? !i.patient_id : i.patient_id === pid)).map((i) => [i.key, i]));
    // a frozen copy, or a case only on this phone: the levels from the rules, and the N/A answers the row holds
    const set = (def.rules || {})[c.category] || {};
    const row = scope === 'case' ? c : live(c.patients).find((p) => p.id === pid) || {};
    const na = row.na && typeof row.na === 'object' ? row.na : {};
    const out = new Map(Object.entries(set).filter(([k, r]) => k.startsWith(`${scope}.`) && !(r.when || []).length).map(([k, r]) => [k.slice(scope.length + 1), { level: r.level, met: true, na: na[k.slice(scope.length + 1)] || null }]));
    for (const [k, v] of Object.entries(na)) if (!out.has(k)) out.set(k, { level: 'submit', met: true, na: v });
    return out;
  }
  /** N/A with a reason (or taking it away). Waits on the phone with no signal, like a vital sign. */
  const setNa = (scope, pid) => async (key, reason, note) => {
    try {
      const r = await send('PUT', `/patrol/incidents/${id}/na`, { scope, field: key, patient_id: pid || null, reason, note: note || null }, { caseId: id, label: reason ? 'N/A answer' : 'N/A taken away' });
      sentToast(r, reason ? 'Saved as N/A' : 'N/A taken away');
      if (r && r.queued) redraw(); else await load();
    } catch (err) { fail(err); }
  };

  function caseSection(c, editable, sectionId, extra, suggest) {
    const section = def.sections.find((x) => x.id === sectionId);
    return sectionPanel({ def, section, scope: 'case', row: c, editable, required: def.required, reqs: reqMap(c, 'case', null), onNa: c.requirements ? setNa('case', null) : null, ctx: sigCtx(c), trails, extra, suggest,
      onSave: async (body, o) => { await patch(`/patrol/incidents/${id}`, body); if (o && o.next) goNext = `case:${sectionId}`; await load(); } });
  }

  /** Marks an element so a "missing" link can find it. */
  const anchor = (el, area) => { el.dataset.area = area; return el; };

  /**
   * Takes the reader to the thing a "missing" item points at: switches to the view that holds it, opens the section,
   * scrolls to the field, puts the cursor in it and outlines it for a moment. `where` is what the server sent.
   */
  function jumpTo(where) {
    if (where.patient_id && live(current.patients).some((p) => p.id === where.patient_id) && activePid !== where.patient_id) { activePid = where.patient_id; redraw(); }
    let scope = page;
    if (where.patient_id) scope = page.querySelector(`.pane [data-patient="${where.patient_id}"]`) || page;
    let el = null;
    if (where.section) {
      const sec = scope.querySelector(`details[data-section="${where.section}"]`);
      if (sec) { sec.open = true; el = (where.field && sec.querySelector(`[data-field="${where.field}"]`)) || sec; }
    } else if (where.area) {
      el = scope.querySelector(`[data-area="${where.area}"]`)
        || (where.patient_id && page.querySelector(`[data-bedside="${where.patient_id}"] [data-area="${where.area}"]`))
        || page.querySelector(`[data-area="${where.area}"]`);
    }
    if (!el) return;
    const pane = el.closest('.pane');
    if (pane && pane.hidden) setMode(pane.dataset.pane);
    for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const target = el.matches('input, select, textarea, button') ? el : el.querySelector('input:not([type=hidden]), select, textarea, button');
    if (target) target.focus({ preventScroll: true });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2500);
  }

  /** Required items not answered yet: "required to submit" first, then "for approval", each in the order of the report. */
  function missingItems(c) {
    if (!c.requirements) return [];
    const order = new Map(def.sections.map((x, i) => [x.id, i]));
    const pidOrder = new Map(live(c.patients).map((p, i) => [p.id, i]));
    return c.requirements.items.filter((i) => !i.met && !i.exception && ['submit', 'approve'].includes(i.level))
      .sort((a, b) => (a.level === b.level ? 0 : a.level === 'submit' ? -1 : 1) || (pidOrder.get(a.patient_id) ?? -1) - (pidOrder.get(b.patient_id) ?? -1) || (order.get(a.section) ?? 99) - (order.get(b.section) ?? 99));
  }
  /** "3 required, 1 for approval" and a button to the next one. */
  function requiredLine(c) {
    const gaps = missingItems(c);
    if (!c.requirements || !c.requirements.items.some((i) => ['submit', 'approve'].includes(i.level))) return null;
    const sub = gaps.filter((i) => i.level === 'submit').length; const app = gaps.length - sub;
    if (!gaps.length) return h('p', { class: 'req-line done', 'data-area': 'required' }, 'Everything your patrol director requires is in.');
    const words = [sub ? `${sub} required before you submit` : null, app ? `${app} your reviewer will need` : null].filter(Boolean).join(', ');
    const next = gaps[0];
    return h('div', { class: 'req-line', 'data-area': 'required' },
      h('span', null, h('b', null, `${gaps.length} left: `), words),
      button('Next missing item', () => jumpTo(next.where), { small: true }),
      h('span', { class: 'muted small' }, `Next: ${next.who ? `${next.who}, ` : ''}${next.label}`));
  }

  // ------------------------------------------------------------ progress: what is done, and the one next thing to do
  function progressPanel(c, editable) {
    if (c.report_state !== 'draft' || !editable) return null;
    const pts = live(c.patients);
    const withPatients = ['injury', 'collision', 'medical'].includes(c.category) || pts.length > 0;
    const first = pts.find((p) => p.id === activePid) || pts[0];
    const refused = pts.find((p) => p.disposition === 'refused_care');
    const inCare = (fn) => () => { setMode('care'); fn(); };
    const steps = [];
    if (withPatients) {
      steps.push({ key: 'patient', text: 'Add the patient', done: pts.length > 0, go: inCare(() => patientDialog()) });
      steps.push({ key: 'vitals', text: 'Take vitals', done: pts.some((p) => live(p.vitals).length), skip: !first, go: inCare(() => { const b = page.querySelector(`[data-bedside="${first.id}"] [data-act=vitals]`); if (b) b.click(); }) });
      steps.push({ key: 'care', text: 'Log injuries and treatment', done: pts.some((p) => live(p.injuries).length || live(p.treatments).length), skip: !first, go: inCare(() => injuryDialog(`/patrol/incidents/${id}/patients/${first.id}`)) });
      steps.push({ key: 'outcome', text: 'Record the outcome', done: pts.length > 0 && pts.every((p) => p.disposition), skip: !first, go: () => { const p = pts.find((x) => !x.disposition) || first; jumpTo({ patient_id: p.id, section: 'transport', field: 'disposition' }); } });
    }
    if (refused) steps.push({ key: 'refusal', text: 'Get the refusal signed', done: c.signatures.some((x) => x.kind === 'refusal_of_care' && x.patient_id === refused.id), go: () => { location.hash = `#/patrol/refusal/${id}/${refused.id}`; } });
    steps.push({ key: 'lead', text: 'Name the lead responder', done: c.responders.some((r) => r.role === 'lead' && !r.voided_at), go: () => { setMode('report'); responderDialog(); } });
    steps.push({ key: 'story', text: 'Say what happened', done: Boolean(c.narrative && c.narrative.trim()), go: () => jumpTo({ area: 'narrative' }) });
    const gaps = missingItems(c);
    if (c.requirements && c.requirements.items.some((i) => i.level === 'submit')) {
      steps.push({ key: 'required', text: 'Fill in what is required', done: !gaps.some((i) => i.level === 'submit'), go: () => { const n = gaps[0]; if (n) jumpTo(n.where); } });
    }
    const done = steps.filter((x) => x.done).length;
    const next = steps.find((x) => !x.done && !x.skip);
    const ready = !next;
    const fill = h('i');
    fill.style.width = `${Math.round((done / steps.length) * 100)}%`;
    return h('section', { class: 'panel progress', 'data-area': 'progress' },
      h('div', { class: 'progress-top' },
        h('div', { class: 'progress-words' }, h('h2', null, ready ? 'Ready to submit' : 'Next step'), h('p', { class: 'muted' }, ready ? 'Everything the report needs is in. Check it over, then submit it for approval.' : `${done} of ${steps.length} steps done. ${next.text} is next.`)),
        ready ? button('Submit report', () => { const b = page.querySelector('[data-act=submit]'); if (b) b.click(); }, { kind: 'primary' }) : button(next.text, () => next.go(), { kind: 'primary' })),
      h('div', { class: 'pbar', role: 'img', 'aria-label': `${done} of ${steps.length} steps done` }, fill),
      requiredLine(c),
      h('ol', { class: 'psteps' }, steps.map((st) => {
        const b = h('button', { type: 'button', class: `pstep${st.done ? ' done' : ''}${st === next ? ' next' : ''}`, 'data-step': st.key }, st.text);
        b.addEventListener('click', () => st.go());
        return h('li', null, b);
      })));
  }

  // ============================================================ CARE
  function carePane(c, editable) {
    const pts = live(c.patients);
    const voided = c.patients.filter((p) => p.voided_at);
    const callbacks = { id, editable, def, roster, reload: load, redraw, change, injuryDialog, treatmentDialog, pullDialog, followupDialog };
    const switcher = pts.length > 1 ? h('div', { class: 'pswitch', role: 'group', 'aria-label': 'Patients' }, pts.map((p) => {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(p.id === activePid), 'data-pid': p.id }, `${p.first_name} ${p.last_name}`.trim());
      b.addEventListener('click', () => { activePid = p.id; redraw(); });
      return b;
    })) : null;
    const addBtn = editable ? anchor(button(pts.length ? 'Add another patient' : 'Add patient', () => patientDialog(), { kind: pts.length ? undefined : 'primary', small: Boolean(pts.length) }), 'patients') : null;
    return h('section', { class: 'pane stack', 'data-pane': 'care', role: 'tabpanel', 'aria-labelledby': 'tab-care' },
      stagesPanel(c, editable),
      h('div', { class: 'spread care-patients' }, h('h2', null, pts.length > 1 ? 'Patients' : 'Patient'), switcher, pts.length ? addBtn : null),
      pts.length ? pts.map((p) => { const card = bedsideCard(p, c, { ...callbacks, base: `/patrol/incidents/${id}/patients/${p.id}` }); card.hidden = p.id !== activePid; return card; })
        : h('div', { class: 'empty stack' }, h('p', null, c.category === 'injury' || c.category === 'medical' ? 'Add the patient to start the care record.' : 'No patients on this report.'), addBtn),
      c.category === 'lost_person' && !version ? searchPanel(c, { editable, roster, trails: trails || [] }) : null,
      checklistPanel(c, { id, editable, reload: load, defs: checklists, frozen: Boolean(version) }),
      id > 0 ? photosPanel(c, { id, editable, reload: load, readOnly: Boolean(version) }) : null,
      voided.length ? h('section', { class: 'panel stack voided-patients' }, h('h3', null, 'Entered in error'), h('ul', { class: 'plain' }, voided.map((p) => h('li', { class: 'voided' }, h('span', { class: 'what' }, `${p.first_name} ${p.last_name}`), voidedNote(p))))) : null);
  }

  // ---- the call, as stages
  const STAGES = ['call_received', 'dispatched', 'on_scene', 'patient_contact', 'transport_started', 'at_aid_room', 'handoff', 'cleared'];
  /** The care timeline as a row of stages: each shows the time it happened, or can be tapped to stamp it now. */
  function stagesPanel(c, editable) {
    const ev = live(c.events);
    const waiting = pending(id).filter((x) => x.path === `/patrol/incidents/${id}/events` && !x.error);
    const first = (k) => ev.find((e) => e.kind === k);
    const chip = (k) => {
      const e = first(k);
      const q = waiting.find((x) => x.body.kind === k);
      if (e) return h('span', { class: 'stage done', 'data-stage': k }, h('span', { class: 'sname' }, label(k)), h('b', null, fmtTime(e.at)));
      if (q) return h('span', { class: 'stage queued', 'data-stage': k }, h('span', { class: 'sname' }, label(k)), h('b', null, atTime(q.body.at)), h('span', { class: 'queued-tag' }, 'Waiting to send'));
      if (!editable) return h('span', { class: 'stage', 'data-stage': k }, h('span', { class: 'sname' }, label(k)), h('span', { class: 'muted' }, 'Not recorded'));
      const b = h('button', { type: 'button', class: 'stage todo', 'data-stage': k }, h('span', { class: 'sname' }, label(k)), h('span', null, 'Tap to stamp'));
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const r = await send('POST', `/patrol/incidents/${id}/events`, { kind: k, at: nowStamp() }, { caseId: id, label: label(k) });
          sentToast(r, `${label(k)} stamped`);
          if (r && r.queued) redraw(); else await load();
          if (['handoff', 'transport_started'].includes(k)) askBeforeLeaving(null, r && r.queued ? k : null);
        } catch (err) { fail(err); b.disabled = false; }
      });
      return b;
    };
    return h('section', { class: 'panel stack timeline-panel', 'data-area': 'events' }, h('div', { class: 'spread' }, h('h2', null, 'Timeline'), editable ? button('Add with a time', () => eventDialog(), { small: true }) : null),
      h('div', { class: 'stages' }, STAGES.map(chip)),
      c.events.length ? h('details', { class: 'more' }, h('summary', null, `All entries (${ev.length}${c.events.length > ev.length ? `, ${c.events.length - ev.length} entered in error` : ''})`), h('ol', { class: 'timeline' }, c.events.map((e) => h('li', { class: e.voided_at ? 'voided' : null },
        h('span', null, h('b', null, fmtTime(e.at)), ' ', h('span', { class: 'what' }, label(e.kind)), e.note ? h('span', { class: 'muted' }, ` ${e.note}`) : null, lateNote(e, 'at') ? h('span', { class: 'late-tag' }, lateNote(e, 'at')) : null, voidedNote(e)),
        editable && !e.voided_at ? button('Entered in error', () => voidDialog({ what: `${label(e.kind)} at ${fmtTime(e.at)}`, path: `/patrol/incidents/${id}/events/${e.id}`, onDone: load }), { small: true, kind: 'quiet' }) : null)))) : h('p', { class: 'muted' }, 'No times recorded yet.'));
  }
  function eventDialog() {
    formDialog('Add a timeline entry', h('div', { class: 'form' }, field('What happened', select(EVENTS, 'other', { name: 'kind' })), field('Time', input({ type: 'datetime-local', name: 'at', value: nowInput(), required: true })), h('div', { class: 'wide' }, field('Note', input({ name: 'note', maxlength: 255 })))),
      async (fd) => { const r = await send('POST', `/patrol/incidents/${id}/events`, compact({ kind: val(fd, 'kind'), at: val(fd, 'at'), note: val(fd, 'note') }), { caseId: id, label: 'Timeline entry' }); sentToast(r, 'Added'); if (r && r.queued) redraw(); else await load(); });
  }

  // ============================================================ REPORT
  function reportPane(c, editable) {
    const pts = live(c.patients);
    const showCollision = c.category === 'collision' || c.collision || c.parties.length;
    const signoffSuggest = me && me.name ? { completed_by_name: { value: me.name, from: 'your sign-in' }, ...(me.patrol_number ? { completed_by_number: { value: me.patrol_number, from: 'your sign-in' } } : {}) } : {};
    const parts = [
      ['details', 'Incident and narrative', detailsPanel(c, editable)],
      ...pts.map((p) => [`patient-${p.id}`, `Patient form: ${p.first_name} ${p.last_name}`.trim(), patientCard(c, p, editable)]),
      ['witness', 'Witnesses', caseSection(c, editable, 'witness', witnessList(c, editable))],
      version ? null : ['scene', 'Scene diagram', scenePanel({ c, editable, id, onDone: load, version }) || h('div', { hidden: true })],
      ['location', 'Location', caseSection(c, editable, 'location', [liftBox({ c, editable, lifts, id, onDone: load }), attractionBox({ c, editable, attractions, id, onDone: load })])],
      ['conditions', 'Conditions', caseSection(c, editable, 'conditions', conditionsBox({ c, editable, id, onDone: load }), editable ? c.conditions_suggest || {} : {})],
      ['contacts', 'Who was told', contactsPanel({ c, editable, id, onDone: load, redraw })],
      ['rentals', 'Rental gear', rentalsPanel({ c, editable, id, onDone: load })],
      version ? null : ['kituse', 'Kit supplies used', kitUsePanel({ c, editable, id })],
      showCollision ? ['collision', 'Collision', collisionPanel(c, { id, editable, reload: load })] : null,
      ['responders', 'Responders', respondersPanel(c, editable)],
      ['signatures', 'Signatures', signaturesPanel(c, editable)],
      ['signoff', 'Sign off', caseSection(c, editable, 'signoff', null, signoffSuggest)],
    ].filter(Boolean);
    for (const [key, , el] of parts) el.id = `r-${key}`;
    const nav = h('nav', { class: 'report-nav', 'aria-label': 'Report sections' }, h('ol', null, parts.map(([key, text]) => {
      const a = h('a', { href: `#r-${key}` }, text);
      a.addEventListener('click', (e) => { e.preventDefault(); const el = page.querySelector(`#r-${key}`); if (el) { if (el.matches('details')) el.open = true; el.scrollIntoView({ block: 'start' }); } });
      return h('li', null, a);
    })));
    return h('section', { class: 'pane stack', 'data-pane': 'report', role: 'tabpanel', 'aria-labelledby': 'tab-report' },
      reportHead(c, editable),
      h('div', { class: 'report-grid' }, nav, h('div', { class: 'stack report-main' },
        parts.map(([, , el]) => el),
        showCollision || !editable ? null : h('div', { class: 'row' }, button('Record a collision', () => collisionStart(), { small: true })))));
  }

  /** The report's own header: the form it follows, what state it is in, and the sign-off buttons. */
  function reportHead(c, editable) {
    const actions = [];
    if (!version && c.report_state === 'draft') {
      const send_ = async () => {
        let r;
        try { r = await post(`/patrol/incidents/${id}/submit`, {}); } catch (err) { showProblems(err, 'Not ready to submit', editable); return; }
        await load();
        // Submitting is not held up by what only the reviewer needs, but the patroller hears about it now, while it can still be found.
        if (r && r.for_approval && r.for_approval.length) {
          dialog('Submitted', [h('p', null, 'Your report is with the review group. Your reviewer will also need these, so they may send it back for them:'),
            h('ul', { class: 'problems' }, r.for_approval.map((x) => h('li', null, x.message)))]);
        } else toast('Report submitted');
      };
      const submit = button('Submit report', async () => {
        // One pass: what the patrol director requires comes first, with no way past it; the suggestions, with Submit
        // anyway, are offered only once everything required is in. If the check cannot be fetched, the submit goes
        // ahead and the server's own required-field check still runs.
        let items = []; let required = [];
        try { const r = await get(`/patrol/incidents/${id}/check`); items = r.data || []; required = r.required || []; } catch (_) { items = []; required = []; }
        if (required.length) { showProblems({ message: 'The report is not complete yet', details: required }, 'Not ready to submit', editable); return; }
        if (items.length) checkDialog(items, send_); else await send_();
      });
      submit.dataset.act = 'submit';
      actions.push(submit);
    }
    const rv = c.review || {};
    let reviewPanel = null;
    if (!version && rv.group) {
      // The review group: approve with the review checks, send back with comments, or escalate.
      if (rv.can_review && !rv.own_report) reviewPanel = reviewBox(c);
      if (rv.can_reopen) actions.push(button('Reopen', () => reopenDialog(c)));
    } else if (!version) {
      if (has('approve_case') && c.report_state !== 'approved') actions.push(button('Approve and lock', () => confirmDialog('Approve this report?', 'Approved reports are locked. Corrections afterwards go in as notes, or you can reopen the report.', 'Approve', async () => {
        try { await post(`/patrol/incidents/${id}/approve`, {}); } catch (err) {
          if (err.status === 409 && Array.isArray(err.details) && err.details.length) {
            if (canExcept(c, err.details)) { exceptionDialog(c, err.details, {}); return; }
            showProblems(err, 'Not ready to approve', editable); return;
          }
          throw err;
        }
        toast('Report approved');
        await load();
      })));
      if (has('approve_case') && c.report_state !== 'draft') actions.push(button(c.report_state === 'approved' ? 'Reopen' : 'Send back', () => reopenDialog(c)));
    }
    const note = version ? null : !editable
      ? (c.report_state === 'approved' ? 'This report is approved and locked. You can still add a note under Record.'
        : rv.group ? (rv.can_review && rv.own_report ? 'You signed off this report, so another member of the review group will review it.' : rv.can_review ? null : 'Signed off and waiting for the review group. You can add a note under Record; a reviewer can send it back with comments.')
        : 'This report is waiting for a manager. You can add a note; a manager can send it back for changes.')
      : null;
    actions.push(button('Print', () => { for (const d of page.querySelectorAll('details')) d.open = true; window.print(); }, { small: true }));
    return h('section', { class: 'panel case-head stack' },
      h('div', { class: 'case-title' },
        h('div', null, h('h1', null, c.case_number ? `Report ${c.case_number}` : `Case ${c.id}`),
          h('p', null, `${fmtDate(c.occurred_at)}, ${fmtTimeZoned(c.occurred_at)} at ${c.location}`),
          h('p', { class: 'muted small' }, `National Ski Area Accident Report for ${c.resort.legal_name || c.resort.name}${c.season ? `, season ${c.season}` : ''}`))),
      note ? h('p', { class: 'lock-note', role: 'status' }, note) : null,
      !version && rv.changes_requested ? changesBox(rv.changes_requested) : null,
      !version && rv.escalated && c.report_state === 'submitted' ? h('p', { class: 'review-flag', role: 'status' }, h('strong', null, 'Escalated'), ` by ${rv.escalated.by || 'a reviewer'}: ${rv.escalated.note}`) : null,
      reviewPanel,
      gapsOnRecord(c),
      !version && c.report_state !== 'approved' ? checkList(c.check, c.report_state === 'draft' ? editable : true) : null,
      actions.length ? h('div', { class: 'row actions' }, actions) : null,
      !version && rv.history && rv.history.length ? reviewHistory(rv.history) : null);
  }

  /** What the reviewer asked to change, shown to the patroller at the top of the report until it is signed off again. */
  function changesBox(cr) {
    return h('section', { class: 'review-changes', role: 'status' },
      h('h2', null, 'Changes requested'),
      h('p', { class: 'muted small' }, `${cr.by || 'A reviewer'} sent this back on ${fmtDateTime(cr.at)}. Make the changes, then sign off again.`),
      h('ul', null, cr.comments.map((x) => h('li', null, h('strong', null, `${x.section}: `), x.text))),
      cr.note ? h('p', null, cr.note) : null);
  }

  /** The reviewer's panel: the review checks, then approve, send back or escalate. */
  function reviewBox(c) {
    const boxes = c.review.checks.map((k) => {
      const cb = h('input', { type: 'checkbox', name: k.key });
      return [k.key, cb, h('label', { class: 'check' }, cb, ' ', k.label)];
    });
    const note = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'A note for the patroller (optional)', 'aria-label': 'Note for the patroller' });
    const err = h('div');
    const approve = button('Approve and lock', async () => {
      clear(err);
      const checklist = Object.fromEntries(boxes.map(([k, cb]) => [k, cb.checked]));
      if (Object.values(checklist).some((v) => !v)) { err.append(h('p', { class: 'error-box', role: 'alert' }, 'Tick every review check first. If one does not apply to this case, tick it.')); return; }
      try { await post(`/patrol/incidents/${id}/approve`, { checklist, note: note.value.trim() || undefined }); } catch (ex) {
        if (ex.status === 409 && Array.isArray(ex.details) && ex.details.length) {
          if (canExcept(c, ex.details)) { exceptionDialog(c, ex.details, { checklist, note: note.value.trim() || undefined }); return; }
          showProblems(ex, ex.details.every((d) => d.level === 'approve') ? 'Not ready to approve: send it back, or ask the Patrol Director' : 'Not ready to approve', false); return;
        }
        err.append(errorBox(ex)); return;
      }
      toast('Approved. The patroller has been told.');
      await load();
    }, { kind: 'primary' });
    return h('section', { class: 'review-box stack' },
      h('h2', null, 'Review'),
      h('p', { class: 'muted small' }, `Signed off by the patroller${c.review.signed_again ? ' again, after changes' : ''}. Read the report, then tick each check.`),
      reviewGaps(c),
      h('div', { class: 'stack tight' }, boxes.map((b) => b[2])),
      note, err,
      h('div', { class: 'row' }, approve, button('Send back with comments', () => sendBackDialog(c)), button('Escalate', () => escalateDialog(c), { small: true })));
  }

  /** For the reviewer: what is still missing for approval, and what the patroller answered N/A or skipped, and why. */
  function reviewGaps(c) {
    const reqs = c.requirements ? c.requirements.items : [];
    const missing = reqs.filter((i) => !i.met && !i.exception && ['submit', 'approve'].includes(i.level));
    const nas = reqs.filter((i) => i.na);
    const skips = c.skips || [];
    if (!missing.length && !nas.length && !skips.length) return null;
    const who = (i) => (i.who ? `${i.who}: ` : '');
    return h('div', { class: 'review-gaps stack tight', 'data-area': 'review-gaps' },
      missing.length ? h('div', null, h('h3', null, `Missing for approval (${missing.length})`),
        h('ul', null, missing.map((i) => h('li', null, `${who(i)}${i.label}`))),
        h('p', { class: 'muted small' }, c.requirements.can_except ? 'Send it back for these, or approve with an exception and say why for each.' : 'Send it back for these. Only the Patrol Director can approve with an exception.')) : null,
      nas.length ? h('div', null, h('h3', null, `Answered N/A (${nas.length})`), h('ul', null, nas.map((i) => h('li', null, `${who(i)}${i.label}: `, h('i', null, naWords(def, i.na)))))) : null,
      skips.length ? h('div', null, h('h3', null, `Skipped before the patient left (${skips.length})`), h('ul', null, skips.map((x) => h('li', null, `${skipLabel(x.item_key)}: `, h('i', null, naWords(def, { reason: x.reason, note: x.note })), x.skipped_by ? h('span', { class: 'muted' }, ` (${x.skipped_by})`) : null)))) : null);
  }

  /**
   * What the report says about its own gaps, on every copy (printed, frozen and released): items approved with an
   * exception and why, items answered N/A and why, and checklist items skipped before the patient left.
   */
  function gapsOnRecord(c) {
    const exc = c.exceptions || [];
    const skips = c.skips || [];
    const nas = [];
    const naRows = [['', c.na], ...live(c.patients).map((p) => [`${p.first_name || ''} ${p.last_name || ''}`.trim(), p.na])];
    const labelOf = (key) => (def.fields.find((f) => f.key === key) || { label: key === 'narrative' ? 'Narrative' : key === 'photos' ? 'Photos' : key }).label;
    for (const [who, na] of naRows) for (const [k, v] of Object.entries(na && typeof na === 'object' ? na : {})) nas.push({ who, label: labelOf(k), na: v });
    if ((c.report_state !== 'approved' && !version) || (!exc.length && !skips.length && !nas.length)) return null;
    return h('section', { class: 'record-gaps stack tight', 'data-area': 'record-gaps' },
      exc.length ? h('div', null, h('h3', null, 'Approved with exceptions'),
        h('ul', null, exc.map((e) => h('li', null, h('b', null, e.label), `: ${e.reason}`, h('span', { class: 'muted' }, ` (${e.approved_by || 'Patrol Director'}, ${fmtDateTime(e.approved_at)})`))))) : null,
      nas.length ? h('div', null, h('h3', null, 'Answered N/A'), h('ul', null, nas.map((x) => h('li', null, `${x.who ? `${x.who}: ` : ''}${x.label}: `, h('i', null, naWords(def, x.na)))))) : null,
      skips.length ? h('div', null, h('h3', null, 'Skipped before the patient left'), h('ul', null, skips.map((x) => {
        const p = live(c.patients).find((q) => q.id === x.patient_id);
        return h('li', null, `${p ? `${p.first_name} ${p.last_name}: ` : ''}${skipLabel(x.item_key)}: `, h('i', null, naWords(def, { reason: x.reason, note: x.note })), x.skipped_by ? h('span', { class: 'muted' }, ` (${x.skipped_by})`) : null);
      }))) : null);
  }

  /** Only "required to approve" gaps are left and this reviewer is the Patrol Director. */
  const canExcept = (c, details) => Boolean(c.requirements && c.requirements.can_except) && details.every((d) => d.level === 'approve' && d.field);

  /**
   * Approve with an exception: the Patrol Director gives a reason for each missing item. Each one is kept with the report
   * and shows on every copy, including copies released to an insurer, a lawyer or the patient.
   */
  function exceptionDialog(c, details, body) {
    const rows = details.map((d, i) => ({ d, box: h('textarea', { name: `r${i}`, rows: 2, maxlength: 500, required: true, minlength: 5, placeholder: 'Why the report can be approved without it' }) }));
    formDialog('Approve with an exception', h('div', { class: 'stack' },
      h('p', null, 'These are still missing. Give a reason for each. The reasons are kept with the report and show on every copy, including copies released outside.'),
      ...rows.map(({ d, box }) => field(d.message, box))),
    async () => {
      const exceptions = rows.map(({ d, box }) => ({ scope: d.scope, field: d.field, patient_id: d.patient_id || null, reason: box.value.trim() }));
      if (exceptions.some((x) => x.reason.length < 5)) throw new Error('Give a reason for each item (a few words at least)');
      await post(`/patrol/incidents/${id}/approve`, { ...body, exceptions });
      toast('Approved with exceptions. The patroller has been told.');
      await load();
    }, { submitText: 'Approve with exceptions', wide: true });
  }

  function sendBackDialog(c) {
    const list = h('div', { class: 'stack' });
    const addRow = () => {
      const sec = select(c.review.sections.map((x) => [x, x]), 'Narrative', { 'aria-label': 'Section' });
      const text = input({ maxlength: 1000, placeholder: 'What needs changing', 'aria-label': 'What needs changing' });
      const row = h('div', { class: 'comment-row' }, sec, text, h('button', { type: 'button', class: 'linklike', onclick: () => { if (list.children.length > 1) row.remove(); } }, 'Remove'));
      list.append(row);
      text.focus();
    };
    addRow();
    formDialog('Send back with comments', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Say what needs changing, section by section. The patroller gets these in their Inbox and at the top of the report.'),
      list, h('div', null, button('Add another comment', addRow, { small: true })),
      field('Note (optional)', h('textarea', { name: 'note', rows: 2, maxlength: 1000 }))), async (fd) => {
      const comments = [...list.querySelectorAll('.comment-row')].map((r) => ({ section: r.querySelector('select').value, text: r.querySelector('input').value.trim() })).filter((x) => x.text);
      if (!comments.length) throw new Error('Write at least one comment');
      await post(`/patrol/incidents/${id}/return`, { comments, note: val(fd, 'note') || undefined });
      toast('Sent back. The patroller has been told.');
      await load();
    }, { submitText: 'Send back', wide: true });
  }

  function escalateDialog() {
    formDialog('Escalate this report', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'For a serious injury or a possible claim. The owner and managers get a message with a link to the case. The report stays with the review group for a decision.'),
      field('Why', h('textarea', { name: 'note', rows: 3, maxlength: 1000, required: true }))), async (fd) => {
      const out = await post(`/patrol/incidents/${id}/escalate`, { note: val(fd, 'note') });
      toast(`Escalated to ${out.told} ${out.told === 1 ? 'person' : 'people'}`);
      await load();
    }, { submitText: 'Escalate' });
  }

  function reviewHistory(list) {
    const words = { approved: 'Approved', returned: 'Sent back', escalated: 'Escalated', not_required: 'Signed off without review' };
    return h('details', { class: 'review-history' }, h('summary', null, `Review history (${list.length})`),
      h('ol', null, list.map((x) => h('li', null, h('strong', null, words[x.outcome] || x.outcome), ` ${x.reviewer ? `by ${x.reviewer} ` : ''}on ${fmtDateTime(x.created_at)}`,
        x.comments && x.comments.length ? h('ul', null, x.comments.map((cm) => h('li', null, `${cm.section}: ${cm.text}`))) : null,
        x.note ? h('div', { class: 'muted small' }, x.note) : null))));
  }

  /** Lists what is missing. Each item is a link to the field when the report can be edited by this reader. */
  /** One suggestion from the report check: a link to the field when there is one, and why it matters. */
  function checkItem(x, onGo) {
    const where = x.section || x.area;
    const text = where ? h('button', { type: 'button', class: 'problem-link' }, x.message) : h('span', null, x.message);
    if (where) text.addEventListener('click', () => { if (onGo) onGo(); jumpTo(x); });
    return h('li', null, text, x.why ? h('span', { class: 'check-why' }, x.why) : null);
  }

  /** "Things to check" at the top of the report: the patroller sees it while writing, the review group while reviewing. */
  function checkList(items, canJump) {
    if (!items || !items.length) return null;
    const n = items.length;
    return h('details', { class: 'report-check', 'data-area': 'report-check' },
      h('summary', null, h('b', null, `${n} thing${n === 1 ? '' : 's'} to check`), h('span', { class: 'muted' }, ' Suggestions only. The patroller and the review group decide.')),
      h('ul', { class: 'check-items' }, items.map((x) => (canJump ? checkItem(x) : h('li', null, x.message, x.why ? h('span', { class: 'check-why' }, x.why) : null)))));
  }

  /** Before submitting: what the check found, with the choice to fix it first or submit as it is. */
  function checkDialog(items, onSubmit) {
    let dlg;
    const fix = h('button', { type: 'button', class: 'btn primary' }, 'Fix first');
    const anyway = h('button', { type: 'button', class: 'btn' }, 'Submit anyway');
    const n = items.length;
    dlg = dialog(`${n} thing${n === 1 ? '' : 's'} to check`, [
      h('p', { class: 'muted' }, 'These are suggestions, not requirements. Select one to go straight to it, or submit the report as it is. You decide.'),
      h('ul', { class: 'check-items' }, items.map((x) => checkItem(x, () => dlg.close()))),
      h('div', { class: 'footer row' }, anyway, fix)]);
    fix.addEventListener('click', () => { dlg.close(); const first = items.find((x) => x.section || x.area); if (first) jumpTo(first); });
    anyway.addEventListener('click', async () => { anyway.disabled = true; dlg.close(); await onSubmit(); });
  }

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
      field('Reason', h('textarea', { name: 'reason', maxlength: 500, required: true }), 'This is written into the record. The approved version stays under Record as a frozen copy.'),
      async (fd) => {
        await post(`/patrol/incidents/${id}/reopen`, { reason: val(fd, 'reason') });
        toast('Report is a draft again');
        await load();
      }, { submitText: 'Reopen' });
  }

  /**
   * Fill in from the story: the server reads the narrative and proposes answers for empty patient fields, each with the
   * words it came from. The patroller ticks the right ones; only those are saved, through the normal patient update.
   */
  async function storyFill(story) {
    try {
      if (story.value.trim() !== String(current.narrative || '').trim()) await patch(`/patrol/incidents/${id}`, { narrative: story.value });
    } catch (err) { fail(err); return; }
    toast('Reading the story…');
    let props;
    try { props = (await post(`/patrol/incidents/${id}/story-fill`, {})).data || []; } catch (err) { fail(err); return; }
    if (!props.length) { toast('The story does not answer any of the empty fields', 'warn'); await load(); return; }
    const people = [...new Set(props.map((x) => x.patient_id))];
    const groups = people.map((pid) => {
      const mine = props.map((x, i) => [x, i]).filter(([x]) => x.patient_id === pid);
      return h('fieldset', { class: 'fill-group' },
        people.length > 1 ? h('legend', null, mine[0][0].patient) : null,
        mine.map(([x, i]) => h('label', { class: 'fill-row' },
          h('input', { type: 'checkbox', name: `p${i}`, checked: true }),
          h('span', { class: 'fill-text' }, h('b', null, x.label), h('span', { class: 'fill-value' }, x.value_label), h('q', { class: 'fill-quote' }, x.quote)))));
    });
    formDialog('Fill in from the story', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Each answer shows the words it came from. Untick anything that is not right; only ticked answers are saved, and you can change them afterwards like any other field.'),
      groups), async (fd) => {
      const byPatient = new Map();
      let n = 0;
      props.forEach((x, i) => {
        if (!fd.get(`p${i}`)) return;
        const body = byPatient.get(x.patient_id) || {};
        if (x.col) body[x.col] = x.value; else (body.form = body.form || {})[x.field] = x.value;
        byPatient.set(x.patient_id, body); n += 1;
      });
      for (const [pid, body] of byPatient) await patch(`/patrol/incidents/${id}/patients/${pid}`, body);
      toast(n ? `${n} answer${n === 1 ? '' : 's'} filled in` : 'Nothing filled in');
      await load();
    }, { submitText: 'Fill in ticked answers', wide: true, onClose: () => load() });
  }

  // ---- incident details and the narrative
  function detailsPanel(c, editable) {
    if (!editable) {
      return h('section', { class: 'panel stack' }, h('h2', null, 'Incident'),
        kv([['Type', label(c.category)], ['Severity', label(c.severity)], ['Outcome', c.disposition && label(c.disposition)]]),
        h('p', null, h('strong', null, c.summary)), c.narrative ? h('p', { class: 'prewrap' }, c.narrative) : null);
    }
    const story = h('textarea', { name: 'narrative', maxlength: 20000, rows: 8 }, c.narrative || '');
    const draft = (style) => () => {
      const text = draftNarrative(current, style);
      if (!text) { toast('Add the patient and some care entries first', 'warn'); return; }
      const put_ = () => { story.value = text; story.focus(); toast('Draft written. Read it, correct it, then save.'); };
      if (story.value.trim()) confirmDialog('Replace the narrative?', 'The draft replaces what is in the box now. Nothing is saved until you choose Save details.', 'Replace', async () => put_());
      else put_();
    };
    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'form' },
        field('Incident date and time', input({ type: 'datetime-local', name: 'occurred_at', value: String(c.occurred_at).slice(0, 16).replace(' ', 'T'), required: true }), 'The time it was reported to the first patroller or dispatch, or the time the patient gave'),
        field('Type', select(CATEGORIES, c.category, { name: 'category' })),
        field('Severity', select(SEVERITY, c.severity, { name: 'severity' })),
        field('Outcome', select(opt(INCIDENT_DISPOSITION), c.disposition || '', { name: 'disposition' }))),
      anchor(field('Summary', input({ name: 'summary', value: c.summary, required: true, maxlength: 500 }), 'One line for the case list'), 'summary'),
      anchor(h('div', { class: 'field narrative-field' },
        h('label', { for: `narr-${id}` }, 'Narrative'),
        h('div', { class: 'row tight draft-row' }, h('span', { class: 'muted small' }, 'Draft it from the care entries:'), button('CHART', draft('chart'), { small: true }), button('SOAP', draft('soap'), { small: true })),
        Object.assign(story, { id: `narr-${id}` }),
        h('span', { class: 'hint' }, 'What happened, in order, in plain words: what you saw, what the patient and witnesses said, what you did, how the patient changed. To speak it, tap the microphone on your phone\'s keyboard. A draft only says what the record says; read it and correct it before saving.'),
        c.story_fill && live(c.patients).length ? h('div', { class: 'row tight story-fill' }, button('Fill in from the story', () => storyFill(story), { small: true }),
          h('span', { class: 'muted small' }, 'Suggests answers for empty fields. Nothing is saved until you tick it.')) : null), 'narrative'),
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

  // The head strike question is asked on injury and collision cases; a medical call or a lost person skips it.
  const HEAD_ASKED = ['injury', 'collision'];
  /** Sections that only matter for some patients are shown when they apply, or once anything is in them. */
  function sectionShows(section, c, p) {
    const f = p.form || {};
    const any = () => def.fields.some((x) => x.scope === 'patient' && x.section === section.id && f[x.key] !== undefined && f[x.key] !== null && f[x.key] !== '');
    const inj = live(p.injuries);
    // Head injury: when the head strike answer is Yes or Not sure (typed, or worked out from the Care tab), when a head or
    // face injury or concussion is recorded, or once a head question has an answer. A neck injury belongs under Spine.
    if (section.show === 'head') return any() || ['yes', 'unsure'].includes(f.head_strike || (p.derived || {}).head_strike) || inj.some((i) => ['head', 'face'].includes(i.body_region) || i.injury_type === 'concussion') || Boolean(f.body_parts && (f.body_parts.head || f.body_parts.face));
    if (section.show === 'spine') return any() || inj.some((i) => ['neck', 'back'].includes(i.body_region) || i.injury_type === 'spinal') || live(p.treatments).some((t) => t.kind === 'spinal_motion_restriction');
    if (section.show === 'arrest') return any() || live(p.treatments).some((t) => ['cpr', 'aed', 'rosc'].includes(t.kind));
    return sectionVisible(def, section, 'patient', p);
  }

  function patientCard(c, p, editable) {
    const base = `/patrol/incidents/${id}/patients/${p.id}`;
    const suggest = Object.fromEntries(Object.entries(p.derived || {}).map(([k, v]) => [k, { value: v, from: 'the bedside card' }]));
    const sections = def.sections.filter((x) => x.scope === 'patient' && sectionShows(x, c, p)).map((section) => sectionPanel({
      def, section, scope: 'patient', row: p, editable, required: def.required, reqs: reqMap(c, 'patient', p.id), skip: HEAD_ASKED.includes(c.category) ? [] : ['head_strike'], onNa: c.requirements ? setNa('patient', p.id) : null, ctx: sigCtx(c, p), trails, suggest, open: section.id === 'patient' && live(c.patients).length === 1 && editable && !p.chief_complaint,
      onSave: async (body, o) => {
        await patch(base, body);
        if (o && o.next) goNext = `${p.id}:${section.id}`;
        await load();
        // An outcome just recorded: the patient is leaving, so ask for what can only be collected now.
        if (body.disposition && body.disposition !== p.disposition) askBeforeLeaving(p.id);
      },
    }));
    return h('article', { class: 'stack patient', 'data-patient': p.id }, h('h3', null, `Patient form: ${p.first_name} ${p.last_name}`), whoRow(p, editable), ...sections);
  }

  /**
   * Guest, staff on duty, staff off duty or volunteer on duty, as one row of buttons at the top of the patient, because it
   * changes what happens next: the owner and GM are told about staff, and staff hurt while working are not counted as guests
   * and get no guest follow-up email.
   */
  function whoRow(p, editable) {
    const cur = (p.form && p.form.patient_type) || (p.activity === 'staff' ? 'staff_work' : 'guest');
    const choices = [['guest', 'Guest'], ['staff_work', 'Staff member, on duty'], ['staff_off', 'Staff member, off duty'], ['volunteer_work', 'Volunteer, on duty']];
    const notes = {
      staff_work: 'The owner and GM are told. Not counted as a guest injury, and no guest follow-up email.',
      volunteer_work: 'The owner and GM are told, and decide whether it counts as a staff injury. Not counted as a guest injury, and no guest follow-up email.',
      staff_off: 'Stays a guest case. The owner and GM are told.',
    };
    const row = h('div', { class: 'seg', role: 'group', 'aria-label': `Who is ${p.first_name} ${p.last_name}` }, choices.map(([v, t]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(cur === v), disabled: !editable, dataset: { tone: v === 'guest' ? 'good' : 'warn' } }, t);
      b.addEventListener('click', async () => {
        if (v === cur) return;
        try { await patch(`/patrol/incidents/${id}/patients/${p.id}`, { form: { patient_type: v } }); } catch (e) { toast(e.message, 'error'); return; }
        toast(v === 'guest' ? 'Marked as a guest' : `Marked: ${t}. ${v === 'staff_off' ? 'The owner and GM are told.' : 'The owner and GM have been told.'}`);
        await load();
      });
      return b;
    }));
    return h('div', { class: 'stack tight patient-who' }, h('span', { class: 'muted small' }, 'Who is this patient?'), row, notes[cur] ? h('p', { class: 'muted small' }, notes[cur]) : null);
  }

  // ---- responders
  function respondersPanel(c, editable) {
    return h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Responders'), editable ? anchor(button('Add responder', () => responderDialog(), { small: true }), 'responders') : null),
      c.responders.length ? h('ul', { class: 'plain' }, c.responders.map((r) => h('li', { class: r.voided_at ? 'spread voided' : 'spread' }, h('span', null, h('span', { class: 'what' }, `${r.first_name} ${r.last_name} `), state(label(r.role), r.role === 'lead' && !r.voided_at ? 'good' : 'neutral'), r.patrol_number ? h('span', { class: 'muted small' }, ` No. ${r.patrol_number}`) : null, voidedNote(r)),
        editable && !r.voided_at ? button('Entered in error', () => voidDialog({ what: `${r.first_name} ${r.last_name}, ${label(r.role)}`, path: `/patrol/incidents/${id}/responders/${r.id}`, onDone: load }), { small: true, kind: 'quiet' }) : null))) : h('p', { class: 'muted' }, 'No responders named yet.'));
  }
  function responderDialog() {
    const members = roster.filter((m) => m.staff_status === 'active');
    // "Me" comes first: the signed-in patroller, whether or not their login is linked to a staff record yet. The server
    // makes (or links) their own staff record on the roster when it is not, so the lead can always be named.
    const myName = me.name || (ctx.me && (ctx.me.login_name || ctx.me.username || ctx.me.email)) || '';
    const choices = [['me', `Me${myName ? ` (${myName})` : ''}`], ...members.filter((m) => !me.staff_id || m.staff_id !== me.staff_id).map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`])];
    const hint = members.length ? null : 'Nobody is on the Roster yet. You can still name yourself.';
    const noLead = !(current && current.responders || []).some((r) => r.role === 'lead' && !r.voided_at); // the first responder named is the lead
    formDialog('Add a responder', h('div', { class: 'form' }, field('Patroller', select(choices, 'me', { name: 'staff_id' }), hint), field('Role', select([['assist', 'Assist'], ['lead', 'Lead (replaces the current lead)'], ['transport', 'Transport'], ['dispatch', 'Dispatch']], noLead ? 'lead' : 'assist', { name: 'role' }))),
      async (fd) => {
        if (val(fd, 'staff_id') === 'me') {
          const r = await post(`/patrol/incidents/${id}/responders/me`, { role: val(fd, 'role') });
          if (r && r.linked) { me.staff_id = r.staff_id; toast('Your login is now linked to your own staff record on the patrol roster'); }
        } else await post(`/patrol/incidents/${id}/responders`, { staff_id: num(fd, 'staff_id'), role: val(fd, 'role') });
        await load();
      });
  }

  /** Marks the case as a collision, so the collision section appears. */
  async function collisionStart() {
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

  /** Adding a patient needs only a name; everything else follows. */
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
      const out = await post(`/patrol/incidents/${id}/patients`, compact({ first_name: val(fd, 'first_name'), last_name: val(fd, 'last_name'), person_id: guest ? guest.id : null }));
      toast('Patient added');
      activePid = out.id;
      const startVitals = flow.vitalsNext;
      flow.vitalsNext = false;
      setMode('care');
      await load();
      if (startVitals) { const b = page.querySelector(`[data-bedside="${out.id}"] [data-act=vitals]`); if (b) b.click(); }
    });
  }

  function injuryDialog(base) {
    formDialog('Add an injury or finding', h('div', { class: 'form' }, field('Body part', select(REGIONS, 'head', { name: 'body_region' })), field('Side', select([['na', 'Not applicable'], ['left', 'Left'], ['right', 'Right'], ['both', 'Both'], ['midline', 'Midline']], 'na', { name: 'side' })),
      field('Type', select(INJURY_TYPES, 'fracture', { name: 'injury_type' })), h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 255 })))),
    async (fd) => { const r = await send('POST', `${base}/injuries`, compact({ body_region: val(fd, 'body_region'), side: val(fd, 'side'), injury_type: val(fd, 'injury_type'), notes: val(fd, 'notes') }), { caseId: id, label: 'Injury' }); sentToast(r, 'Injury added'); if (r && r.queued) redraw(); else await load(); });
  }

  /** Any other treatment, with a time and who did it. Splints, oxygen and medication have their own sheets on the bedside card. */
  function treatmentDialog(base) {
    const members = roster.filter((m) => m.staff_status === 'active');
    formDialog('Add treatment', h('div', { class: 'form' }, field('Time', input({ type: 'datetime-local', name: 'performed_at', value: nowInput(), required: true })), field('Treatment', select(TREATMENTS, 'bandage', { name: 'kind' })),
      field('Done by', select(opt(members.map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`]), 'Not recorded'), '', { name: 'performed_by_staff' })),
      h('div', { class: 'wide' }, field('Details', input({ name: 'description', maxlength: 255 })))),
    async (fd) => {
      const r = await send('POST', `${base}/treatments`, compact({ performed_at: val(fd, 'performed_at'), kind: val(fd, 'kind'), description: val(fd, 'description'), performed_by_staff: num(fd, 'performed_by_staff') }), { caseId: id, label: label(val(fd, 'kind')) });
      sentToast(r, 'Treatment logged');
      if (r && r.queued) redraw(); else await load();
    });
  }

  // ---- signatures
  function signaturesPanel(c, editable) {
    return h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Signatures'), editable ? anchor(button('Collect signature', () => signatureDialog(c), { small: true }), 'signatures') : null),
      c.signatures.length ? h('ul', { class: 'plain' }, c.signatures.map((s) => {
        const who = s.patient_id ? c.patients.find((p) => p.id === s.patient_id) : null;
        return h('li', { class: 'spread' }, h('span', null, h('b', null, (SIGNATURE_KINDS.find((k) => k[0] === s.kind) || [0, label(s.kind)])[1]), ` signed by ${s.signer_name}`, s.signer_role ? ` (${s.signer_role})` : '', who ? ` for ${who.first_name} ${who.last_name}` : '', h('span', { class: 'muted' }, ` ${fmtDateTime(s.signed_at)}`)),
          version ? null : button('View', async () => { const full = await get(`/patrol/incidents/${id}/signatures/${s.id}`); dialog(`${label(s.kind)}: ${s.signer_name}`, h('img', { class: 'sig-img', src: full.image, alt: `Signature of ${s.signer_name}` })); }, { small: true }));
      })) : h('p', { class: 'muted' }, 'No signatures yet. A patient who refuses care needs a signed refusal before the report can be submitted.'),
      h('p', { class: 'muted small' }, 'Signatures cannot be edited or removed once saved. The refusal form and the hand-off sheet collect their own signatures.'));
  }
  function signatureDialog(c) {
    const pad = signaturePad();
    const pts = live(c.patients);
    const patients = [['', 'Not tied to one patient'], ...pts.map((p) => [p.id, `${p.first_name} ${p.last_name}`])];
    const hasRefusal = pts.some((p) => p.disposition === 'refused_care');
    const name = input({ name: 'signer_name', required: true, maxlength: 150 });
    const role = input({ name: 'signer_role', maxlength: 150, placeholder: 'Mother, paramedic Medic 12, witness' });
    const kind = select(SIGNATURE_KINDS, hasRefusal ? 'refusal_of_care' : 'patient_acknowledgment', { name: 'kind' });
    const patientSel = select(patients, (pts.find((p) => p.disposition === 'refused_care') || pts.find((p) => p.id === activePid) || pts[0] || {}).id || '', { name: 'patient_id' });
    const clearBtn = h('button', { type: 'button', class: 'btn small' }, 'Clear');
    clearBtn.addEventListener('click', () => pad.clear());
    formDialog('Collect a signature', h('div', { class: 'stack' },
      h('div', { class: 'form' }, field('Kind', kind), field('Patient', patientSel), field('Printed name of signer', name), field('Role or relationship (optional)', role)),
      h('div', { class: 'field' }, h('span', null, 'Signature'), pad.el), h('div', { class: 'row' }, clearBtn),
      h('p', { class: 'muted small' }, 'The signer signs above with a finger or pen. For a refusal, use the refusal form from the bedside card: it reads the statement and checks the patient can decide.')),
    async (fd) => {
      if (pad.isEmpty()) throw new Error('The signature area is empty');
      await post(`/patrol/incidents/${id}/signatures`, compact({ kind: val(fd, 'kind'), signer_name: val(fd, 'signer_name'), signer_role: val(fd, 'signer_role'), patient_id: num(fd, 'patient_id'), image: pad.toDataUrl() }));
      toast('Signature saved');
      await load();
    }, { submitText: 'Save signature' });
  }

  // ---- witnesses
  function witnessList(c, editable) {
    return h('div', { class: 'stack' }, h('div', { class: 'spread' }, h('h4', null, 'Witnesses on file'), h('div', { class: 'row' }, editable ? witnessLinkButton({ c, editable, id, onDone: load }) : null, editable ? button('Add witness', () => witnessDialog(), { small: true }) : null)),
      c.witnesses.length ? h('ul', { class: 'plain' }, c.witnesses.map((w) => {
        // A statement the witness wrote by link is theirs: it is never edited or removed, only marked entered in error.
        const own = w.source === 'link';
        const action = !editable || w.voided_at ? null
          : own ? button('Entered in error', () => voidOwnStatement(w), { small: true })
            : button('Entered in error', () => voidDialog({ what: `Witness: ${w.name}`, path: `/patrol/incidents/${id}/witnesses/${w.id}`, onDone: load }), { small: true, kind: 'quiet' });
        return h('li', { class: w.voided_at ? 'stack tight voided' : 'stack tight' },
          h('div', { class: 'spread' }, h('span', null, w.relation ? `${label(w.relation)}: ` : '', h('b', null, w.name), h('span', { class: 'muted' }, ` ${[w.phone, w.email, [w.address, w.city, w.region, w.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ')}`)), action),
          own ? h('p', { class: 'small' }, state(`In their own words, received ${fmtDateTime(w.received_at)}`, 'good')) : null,
          w.statement ? h('p', { class: 'prewrap' }, w.statement) : null,
          w.voided_at ? h('p', { class: 'small muted' }, voidedNote(w)) : null);
      })) : h('p', { class: 'muted' }, 'No witnesses recorded.'));
  }
  function voidOwnStatement(w) {
    const why = input({ name: 'reason', maxlength: 255, required: true, placeholder: 'For example: sent to the wrong person' });
    formDialog('Mark this statement entered in error?', h('div', { class: 'form' }, h('p', null, `${w.name}'s own words stay on the record, struck through, with your reason.`), field('Why', why)),
      async () => { await post(`/patrol/incidents/${id}/witness-statements/${w.id}/void`, { reason: why.value.trim() }); await load(); }, { submitText: 'Mark entered in error' });
  }
  function witnessDialog() {
    formDialog('Add a witness', h('div', { class: 'form' },
      field('Relation to the incident', select([['', 'Not recorded'], ['witnessed_by', 'Witnessed by'], ['accompanied_by', 'Accompanied by'], ['collided_with', 'Collided with'], ['other', 'Other']], '', { name: 'relation' })),
      field('Name', input({ name: 'name', required: true, maxlength: 150 })), field('Phone', input({ name: 'phone', type: 'tel', maxlength: 40 })), field('Email', input({ name: 'email', type: 'email', maxlength: 255 })),
      h('div', { class: 'wide' }, field('Home address', input({ name: 'address', maxlength: 255 }))), field('City', input({ name: 'city', maxlength: 100 })), field('Province or state', input({ name: 'region', maxlength: 60 })), field('Postal or zip code', input({ name: 'postal', maxlength: 20 })),
      h('div', { class: 'wide' }, field('What they saw', h('textarea', { name: 'statement', maxlength: 10000, rows: 4 }), 'In their own words. Do not lead them: ask what they saw and whether they noticed anything unusual before the incident.'))),
    async (fd) => { await post(`/patrol/incidents/${id}/witnesses`, compact({ relation: val(fd, 'relation'), name: val(fd, 'name'), phone: val(fd, 'phone'), email: val(fd, 'email'), address: val(fd, 'address'), city: val(fd, 'city'), region: val(fd, 'region'), postal: val(fd, 'postal'), statement: val(fd, 'statement') })); await load(); });
  }

  // ============================================================ RECORD
  function recordPane(c) {
    return h('section', { class: 'pane stack', 'data-pane': 'record', role: 'tabpanel', 'aria-labelledby': 'tab-record' },
      c.protocol_stamp ? h('p', { class: 'muted small' }, c.protocol_stamp) : null,
      claimPanel({ c, id, version, load }),
      notesPanel(c), versionsPanel(c),
      !version && has('records') ? legalHoldControl({ ...c, legal_hold: Boolean(Number(c.legal_hold)) }, load) : (Number(c.legal_hold) ? h('p', { class: 'warn-note' }, `On legal hold: ${c.legal_hold_note || ''}`) : null),
      !version && has('view_cases') ? recordsPanel(c, { canManage: has('records') }) : null,
      correctionsPanel(c));
  }

  function notesPanel(c) {
    const text = h('textarea', { maxlength: 5000, rows: 3, 'aria-label': 'New note' });
    return h('section', { class: 'panel stack' }, h('h2', null, 'Notes and addenda'),
      c.notes.length ? c.notes.map((n) => h('div', { class: 'note' }, h('div', { class: 'muted small' }, `${fmtDateTime(n.created_at)}${n.author ? `, ${n.author}` : ''}`), h('p', { class: 'prewrap' }, n.body))) : h('p', { class: 'muted' }, 'No notes yet.'),
      version ? null : field('Add a note', text, 'Notes stay open after a report is approved. Use them for corrections and follow-up.'),
      version ? null : h('div', { class: 'row' }, button('Add note', async () => {
        if (!text.value.trim()) throw new Error('Write a note first');
        await post(`/patrol/incidents/${id}/notes`, { body: text.value.trim() });
        await load();
      })));
  }

  function versionsPanel(c) {
    const vs = c.versions || [];
    return h('section', { class: 'panel stack', 'data-area': 'versions' }, h('h2', null, 'Versions'),
      h('p', { class: 'muted small' }, 'A frozen copy is kept each time the report is submitted or approved, so what was signed off can always be shown, even after the report is reopened and changed.'),
      vs.length ? h('ol', { class: 'plain versions' }, vs.map((v) => h('li', { class: 'spread' },
        h('span', null, h('b', null, `Version ${v.version_no}`), ` ${v.kind === 'approved' ? 'approved' : 'submitted'} by ${v.created_by || 'unknown'}, ${fmtDateTime(v.created_at)}`),
        h('a', { class: 'btn small', href: `#/patrol/version/${id}/${v.id}` }, 'Open')))) : h('p', { class: 'muted' }, 'None yet. The first is kept when the report is submitted.'));
  }

  /** Everything marked entered in error, in one list, with who and why. */
  function correctionsPanel(c) {
    const rows = [];
    for (const e of c.events.filter((x) => x.voided_at)) rows.push([e.voided_at, `Timeline: ${label(e.kind)} at ${fmtTime(e.at)}`, e]);
    for (const p of c.patients) {
      const who = `${p.first_name} ${p.last_name}`.trim();
      if (p.voided_at) rows.push([p.voided_at, `Patient: ${who}`, p]);
      for (const v of p.vitals.filter((x) => x.voided_at)) rows.push([v.voided_at, `${who}: vitals at ${fmtTime(v.taken_at)}`, v]);
      for (const i of p.injuries.filter((x) => x.voided_at)) rows.push([i.voided_at, `${who}: ${label(i.injury_type)}, ${label(i.body_region)}`, i]);
      for (const t of p.treatments.filter((x) => x.voided_at)) rows.push([t.voided_at, `${who}: ${treatmentName(t)} at ${fmtTime(t.performed_at)}`, t]);
    }
    for (const r of c.responders.filter((x) => x.voided_at)) rows.push([r.voided_at, `Responder: ${r.first_name} ${r.last_name}`, r]);
    for (const w of c.witnesses.filter((x) => x.voided_at)) rows.push([w.voided_at, `Witness: ${w.name}`, w]);
    for (const p of (c.parties || []).filter((x) => x.voided_at)) rows.push([p.voided_at, `Person involved: ${[p.first_name, p.last_name].filter(Boolean).join(' ') || label(p.role)}`, p]);
    for (const r of (c.rentals || []).filter((x) => x.voided_at)) rows.push([r.voided_at, `Rental gear: ${(r.detail && r.detail.item && r.detail.item.sku) || 'item'}`, r]);
    rows.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    return h('section', { class: 'panel stack', 'data-area': 'corrections' }, h('h2', null, 'Entered in error'),
      rows.length ? h('ul', { class: 'plain log' }, rows.map(([, what, row]) => h('li', { class: 'voided' }, h('span', null, h('span', { class: 'what' }, what), voidedNote(row))))) : h('p', { class: 'muted' }, 'Nothing has been marked entered in error.'),
      h('p', { class: 'muted small' }, 'Nothing is deleted from a patient record. A wrong entry stays, struck through, with the reason and who marked it.'));
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
