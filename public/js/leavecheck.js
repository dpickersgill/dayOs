// Before the patient leaves: the things that can only be collected while the patient is still with patrol. The same list
// as src/lib/leavecheck.js, worked out on the phone too, so it shows with no signal. The checklist opens when the patroller
// records an outcome or stamps hand-off or transport. Each item is done there and then, or skipped with a reason; nothing
// here stops care or the outcome being saved. Everything is sent through the outbox, so it waits on the phone when there
// is no signal and goes, in order, when the signal returns.
import { h, button, toast, dialog, fail, nowStamp } from './ui.js';
import { send } from './outbox.js';

export const LEAVE_ITEMS = [
  ['contact', 'Contact details (phone or email)'],
  ['guardian', 'Parent or guardian name'],
  ['refusal_signature', 'Signed refusal of care'],
  ['rental', 'Rental boot or ski number'],
  ['witnesses', 'Witness names, or no witnesses'],
];
const LABEL = Object.fromEntries(LEAVE_ITEMS);
export const skipLabel = (k) => LABEL[k] || k;
const RENTAL = ['area_rental', 'other_rental', 'area_demos', 'other_demos'];
const CARE = ['injury', 'medical', 'collision'];
const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const formOf = (v) => (v && typeof v === 'object' ? v : (() => { try { return JSON.parse(v || '{}'); } catch (_) { return {}; } })());
const live = (list) => (list || []).filter((x) => !x.voided_at);

function ageOf(p, onDay) {
  if (p.age_years !== null && p.age_years !== undefined && p.age_years !== '') return Number(p.age_years);
  if (!p.date_of_birth) return null;
  const dob = String(p.date_of_birth).slice(0, 10); const day = String(onDay || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  let a = Number(day.slice(0, 4)) - Number(dob.slice(0, 4));
  if (day.slice(5) < dob.slice(5)) a -= 1;
  return a;
}
const leaving = (c, p) => Boolean(p.disposition) || live(c.events).some((e) => ['handoff', 'transport_started'].includes(e.kind) && (!e.patient_id || e.patient_id === p.id));

/** The checklist for a case: the server's list when online, worked out here when the case is only on this phone. */
export function leaveItems(c, { on = true, only = null } = {}) {
  if (!on || !CARE.includes(c.category)) return [];
  if (c.leave && !only) return withWaiting(c, c.leave);
  const skips = c.skips || [];
  const skipFor = (item, pid) => skips.find((s) => s.item_key === item && (s.patient_id ?? null) === (pid ?? null)) || null;
  const out = [];
  const pts = live(c.patients).filter((p) => (only ? p.id === only : leaving(c, p)));
  for (const p of pts) {
    const f = { ...(p.derived || {}), ...formOf(p.form) };
    const who = `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Patient';
    const age = ageOf(p, c.occurred_at);
    const minor = age !== null && age < 18;
    const add = (item, met) => out.push({ item, label: LABEL[item], patient_id: p.id, who, met: Boolean(met), skip: skipFor(item, p.id), minor });
    add('contact', !blank(p.phone) || !blank(p.email) || (minor && !blank(p.guardian_email)));
    if (minor) add('guardian', !blank(p.guardian_name) || !blank(f.refusal_guardian_name));
    if (p.disposition === 'refused_care') add('refusal_signature', (c.signatures || []).some((s) => s.kind === 'refusal_of_care' && s.patient_id === p.id));
    if (RENTAL.includes(f.equipment) || p.rental_equipment === 'yes') add('rental', !blank(f.rental_boot) || !blank(f.rental_ski));
  }
  if (pts.length) out.push({ item: 'witnesses', label: LABEL.witnesses, patient_id: null, who: null, met: (c.witnesses || []).length > 0 || Boolean(formOf(c.form).witnesses_none), skip: skipFor('witnesses', null) });
  return withWaiting(c, out);
}

/**
 * Counts what is waiting on this phone (no signal yet) as done: a skip, a witness, "no witnesses", contact details, a
 * parent's name or a rental number sent through the outbox. c.waiting is the outbox list for the case.
 */
function withWaiting(c, list) {
  const w = c.waiting || [];
  if (!w.length) return list;
  const has = (fn) => w.some((x) => !x.error && fn(x));
  const pidOf = (x) => { const m = String(x.path).match(/\/patients\/(-?\d+)$/); return m ? Number(m[1]) : null; };
  return list.map((i) => {
    if (i.met || i.skip) return i;
    if (has((x) => x.path.endsWith('/skips') && x.body.item === i.item && (x.body.patient_id ?? null) === (i.patient_id ?? null))) return { ...i, skip: { reason: 'waiting' } };
    const patch = (fn) => has((x) => x.method === 'PATCH' && pidOf(x) === i.patient_id && fn(x.body || {}));
    const met = (i.item === 'contact' && patch((b) => b.phone || b.email || b.guardian_email))
      || (i.item === 'guardian' && patch((b) => b.guardian_name))
      || (i.item === 'rental' && patch((b) => b.form && (b.form.rental_boot || b.form.rental_ski)))
      || (i.item === 'refusal_signature' && has((x) => x.path.endsWith('/signatures') && x.body.kind === 'refusal_of_care' && x.body.patient_id === i.patient_id))
      || (i.item === 'witnesses' && has((x) => (x.path.endsWith('/witnesses') && x.method === 'POST') || (x.method === 'PATCH' && /\/incidents\/-?\d+$/.test(x.path) && x.body.form && x.body.form.witnesses_none)));
    return met ? { ...i, met: true } : i;
  });
}

const REASONS = [['declined', 'Patient declined'], ['unable', 'Patient could not'], ['left', 'Patient left first'], ['not_applicable', 'Does not apply'], ['other', 'Other']];

/**
 * The checklist as a dialog. ctx: { id (case id), refusalHref(pid), reload, redraw }. Shows each open item with what is
 * needed to do it now, and Skip with a reason. Done items show ticked. Closing it leaves the open items on the case page
 * (and they hold up the submit until each is done or skipped).
 */
export function leaveDialog(c, ctx, { patientId = null } = {}) {
  const all = leaveItems(c, { on: true, only: patientId });
  const open = all.filter((i) => !i.met && !i.skip);
  if (!open.length) return null;
  const body = h('div', { class: 'stack leave-list', 'data-area': 'leave-dialog' });
  let dlg;
  const done = async (r, text) => {
    toast(r && r.queued ? `${text}. Kept on this phone until there is signal` : text, r && r.queued ? 'warn' : 'ok');
    if (r && r.queued) ctx.redraw(); else await ctx.reload();
  };
  const go = (method, path, payload, text) => send(method, path, payload, { caseId: ctx.id, label: text });
  const base = `/patrol/incidents/${ctx.id}`;

  function row(i) {
    const li = h('li', { class: 'leave-item', 'data-leave': i.item, 'data-patient': i.patient_id || '' });
    const title = h('div', { class: 'leave-title' }, h('b', null, i.label), i.who ? h('span', { class: 'muted' }, ` ${i.who}`) : null);
    const doArea = h('div', { class: 'leave-do' });
    const inp = (name, attrs = {}) => h('input', { name, autocomplete: 'off', ...attrs });
    const saveBtn = (label, fn) => button(label, async () => { try { await fn(); dlg.close(); } catch (err) { fail(err); } }, { small: true, kind: 'primary' });
    switch (i.item) {
      case 'contact': {
        const phone = inp('phone', { type: 'tel', placeholder: 'Phone', 'aria-label': 'Phone' });
        const email = inp('email', { type: 'email', placeholder: i.minor ? 'Parent\'s email' : 'Email', 'aria-label': i.minor ? 'Parent\'s email' : 'Email' });
        doArea.append(phone, email, saveBtn('Save', async () => {
          if (!phone.value.trim() && !email.value.trim()) throw new Error('Add a phone or an email, or skip it with a reason');
          const b = { ...(phone.value.trim() ? { phone: phone.value.trim() } : {}), ...(email.value.trim() ? { [i.minor ? 'guardian_email' : 'email']: email.value.trim() } : {}) };
          await done(await go('PATCH', `${base}/patients/${i.patient_id}`, b, 'Contact details'), 'Contact details saved');
        }));
        break;
      }
      case 'guardian': {
        const name = inp('guardian_name', { placeholder: 'Parent or guardian name', 'aria-label': 'Parent or guardian name', maxlength: 150 });
        doArea.append(name, saveBtn('Save', async () => {
          if (!name.value.trim()) throw new Error('Add the name, or skip it with a reason');
          await done(await go('PATCH', `${base}/patients/${i.patient_id}`, { guardian_name: name.value.trim() }, 'Parent or guardian'), 'Parent or guardian saved');
        }));
        break;
      }
      case 'rental': {
        const boot = inp('rental_boot', { placeholder: 'Boot number', 'aria-label': 'Rental boot number', maxlength: 60 });
        const ski = inp('rental_ski', { placeholder: 'Ski or board number', 'aria-label': 'Rental ski number', maxlength: 60 });
        doArea.append(boot, ski, saveBtn('Save', async () => {
          if (!boot.value.trim() && !ski.value.trim()) throw new Error('Add a number, or skip it with a reason');
          await done(await go('PATCH', `${base}/patients/${i.patient_id}`, { form: { ...(boot.value.trim() ? { rental_boot: boot.value.trim() } : {}), ...(ski.value.trim() ? { rental_ski: ski.value.trim() } : {}) } }, 'Rental numbers'), 'Rental numbers saved');
        }));
        break;
      }
      case 'refusal_signature':
        doArea.append(button('Get the refusal signed', () => { dlg.close(); location.hash = ctx.refusalHref(i.patient_id); }, { small: true, kind: 'primary' }));
        break;
      case 'witnesses': {
        const name = inp('witness_name', { placeholder: 'Witness name', 'aria-label': 'Witness name', maxlength: 150 });
        const phone = inp('witness_phone', { type: 'tel', placeholder: 'Phone', 'aria-label': 'Witness phone', maxlength: 40 });
        doArea.append(name, phone, saveBtn('Add witness', async () => {
          if (!name.value.trim()) throw new Error('Add the witness\'s name, or choose No witnesses');
          await done(await go('POST', `${base}/witnesses`, { name: name.value.trim(), ...(phone.value.trim() ? { phone: phone.value.trim() } : {}) }, 'Witness'), 'Witness added');
        }), button('No witnesses', async () => {
          try { await done(await go('PATCH', base, { form: { witnesses_none: true } }, 'No witnesses'), 'Marked: no witnesses'); dlg.close(); } catch (err) { fail(err); }
        }, { small: true }));
        break;
      }
      default: break;
    }
    // Skip, with a reason: one tap for the reason, a note only for Other.
    const note = inp('skip_note', { placeholder: 'Say why', 'aria-label': 'Why it was skipped', maxlength: 300, hidden: true });
    const reasons = h('div', { class: 'leave-reasons', hidden: true, role: 'group', 'aria-label': 'Why it is skipped' }, REASONS.map(([v, t]) => {
      const b = h('button', { type: 'button', class: 'req-cond', 'data-reason': v }, t);
      b.addEventListener('click', async () => {
        if (v === 'other' && !note.value.trim()) { note.hidden = false; note.focus(); return; }
        try {
          const r = await go('POST', `${base}/skips`, { item: i.item, patient_id: i.patient_id || null, reason: v, note: note.value.trim() || null, at: nowStamp() }, `Skipped: ${i.label}`);
          await done(r, `Skipped: ${i.label}`);
          dlg.close();
        } catch (err) { fail(err); }
      });
      return b;
    }), note);
    const skipBtn = h('button', { type: 'button', class: 'linkish', 'data-skip': i.item }, 'Skip, with a reason');
    skipBtn.addEventListener('click', () => { reasons.hidden = !reasons.hidden; });
    li.append(title, doArea, skipBtn, reasons);
    return li;
  }

  body.append(...[
    h('p', { class: 'muted' }, 'While the patient is still here. Do each one now, or skip it with a reason. Nothing here holds up care; your reviewer sees every skip.'),
    h('ul', { class: 'plain stack' }, open.map(row)),
    all.some((i) => i.met || i.skip) ? h('p', { class: 'muted small' }, `Already done: ${all.filter((i) => i.met || i.skip).map((i) => i.label.toLowerCase()).join(', ')}.`) : null].filter(Boolean));
  dlg = dialog('Before the patient leaves', body, { wide: true });
  return dlg;
}

/** The checklist on the case page, until every item is done or skipped. */
export function leavePanel(c, ctx, on) {
  const items = leaveItems(c, { on });
  const open = items.filter((i) => !i.met && !i.skip);
  if (!open.length) return null;
  return h('section', { class: 'panel leave-panel', 'data-area': 'leave', role: 'status' },
    h('div', { class: 'spread' },
      h('div', null, h('h3', null, 'Before the patient leaves'),
        h('p', { class: 'small' }, `${open.length} not done yet: ${open.map((i) => `${i.label.toLowerCase()}${i.who ? ` (${i.who})` : ''}`).join(', ')}. Do each, or skip it with a reason.`)),
      ctx.editable ? button('Open the checklist', () => leaveDialog(c, ctx), { kind: 'primary', small: true }) : null));
}
