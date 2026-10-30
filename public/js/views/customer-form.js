// The shared customer form: name, contact, address, emergency contact, skiing details and email consent.
// The same fields appear wherever a customer is captured (ticket sales, lesson bookings, the People screen);
// the fields come from the server's customer definition, and the mountain's mandatory fields show a red star.

import { get, put } from '../api.js';
import { h, clear, field, button, toast, formDialog, label } from '../ui.js';
import { personPicker } from '../widgets.js';
import { photoControl } from '../photo.js';

let cache = null;
export async function loadCustomerForm(force = false) {
  if (!cache || force) cache = await get('/crm/form');
  return cache;
}
export const forgetCustomerForm = () => { cache = null; };

const AUTOCOMPLETE_OFF = { autocomplete: 'off' };
const star = h('span', { class: 'req', 'aria-hidden': 'true' }, ' *');

function control(f, value) {
  const common = { name: f.key, ...AUTOCOMPLETE_OFF };
  if (f.type === 'select') {
    const el = h('select', common, h('option', { value: '' }, 'Not given'), ...f.options.map((o) => h('option', { value: o, selected: value === o }, label(o))));
    return el;
  }
  if (f.type === 'check') return h('input', { type: 'checkbox', ...common, checked: Boolean(value) });
  return h('input', { type: f.type === 'text' ? 'text' : f.type, maxlength: f.key === 'email' ? 255 : 255, ...common, value: value || '' });
}

/**
 * The fields for one customer, grouped. scope ('ticket' | 'lesson' | null) decides which are mandatory.
 * Returns { el, values(), set(person), missing(), isEmpty() }.
 */
export function customerFields({ def, scope = null, person = null, groups = null, sale = false, sizing = false, photo = false, light = false, noContact = false }) {
  const required = new Set(scope ? def.required[scope] : []);
  // In a sale everyone needs a name, date of birth and sex. Adults also need a phone or an email; under 18s need neither.
  // light (a day ticket, Track WINDOW): a name only, no date of birth or sex. noContact: a guest on someone else's sale.
  const SALE_ALWAYS = light ? [] : ['date_of_birth', 'sex'];
  const isReq = (f) => f.fixed === 'required' || (required.has(f.key) && !(noContact && (f.key === 'phone' || f.key === 'email'))) || (sale && SALE_ALWAYS.includes(f.key));
  const inputs = new Map();
  const stars = new Map();
  const ruleNote = sale ? h('p', { class: 'muted small', 'data-note': 'sale-rule' }) : null;
  const isMinor = () => {
    const el = inputs.get('date_of_birth');
    const m = el && /^(\d{4})-(\d{2})-(\d{2})$/.exec(el.value.trim());
    if (!m) return false;
    const now = new Date();
    let age = now.getFullYear() - Number(m[1]);
    if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) age -= 1;
    return age < 18;
  };
  const refreshStars = () => {
    if (!sale) return;
    const minor = isMinor();
    for (const [key, st] of stars) st.hidden = minor && (key === 'phone' || key === 'email');
    ruleNote.textContent = light ? (minor ? 'Under 18: a name is all we need for a day ticket.' : noContact ? 'A day ticket needs only a name.' : 'A day ticket needs only a name, and a phone number or an email for the buyer.')
      : minor ? 'Under 18: name, date of birth and sex are all we need.' : 'Name, date of birth and sex are required. Adults also need a phone number or an email.';
  };
  const wrap = h('div', { class: 'stack' });
  const more = h('div', { class: 'stack' });
  for (const [gid, gtitle] of def.groups) {
    if (groups && !groups.includes(gid)) continue;
    if (gid === 'sizing' && !sizing) continue;
    const fs = def.fields.filter((f) => f.group === gid);
    const cells = fs.map((f) => {
      const el = control(f, person && person[f.key]);
      inputs.set(f.key, el);
      if (f.type === 'check') return h('label', { class: 'check wide' }, el, ` ${f.label}`);
      const st = isReq(f) ? star.cloneNode(true) : null;
      if (st) stars.set(f.key, st);
      return h('label', { class: f.key === 'address_line1' || f.key === 'address_line2' ? 'field wide' : 'field' }, h('span', null, f.label, st), el);
    });
    const set = h('fieldset', { class: 'stack tight cust-group', 'data-group': gid }, h('legend', null, gtitle), gid === 'contact' ? ruleNote : null, h('div', { class: 'form' }, cells));
    // At the window, only what is needed shows: other groups wait behind "More details" unless one of their fields is required.
    if (sale && gid !== 'contact' && gid !== 'sizing' && !fs.some(isReq)) more.append(set); else wrap.append(set);
  }
  if (more.childElementCount) wrap.append(h('details', { class: 'more-details' }, h('summary', null, 'More details (address, emergency contact, skiing, email news)'), more));
  // A photo of the person (season passes show it at the gate). photo: true shows it, 'hidden' keeps it out of sight until needed.
  const photoCtl = photo ? photoControl({ has: Boolean(person && person.has_photo), label: 'Photo' }) : null;
  if (photoCtl) { photoCtl.el.hidden = photo === 'hidden'; wrap.append(photoCtl.el); }
  const read = (f, el) => (f.type === 'check' ? el.checked : (el.value.trim() === '' ? null : el.value.trim()));
  const api = {
    el: wrap,
    photo: photoCtl,
    /** All the details as typed. Blank fields are null so an edit can clear a value. */
    values() {
      const out = {};
      for (const f of def.fields) if (inputs.has(f.key)) out[f.key] = read(f, inputs.get(f.key));
      return out;
    },
    set(p) {
      for (const f of def.fields) {
        const el = inputs.get(f.key);
        if (!el) continue;
        if (f.type === 'check') el.checked = Boolean(p && p[f.key]);
        else el.value = (p && p[f.key] !== null && p[f.key] !== undefined) ? p[f.key] : '';
      }
      if (photoCtl) { photoCtl.set(null); photoCtl.setCurrent(null); photoCtl.setHas(Boolean(p && p.has_photo)); }
    },
    isMinor: () => isMinor(),
    /** True when nothing has been typed (the consent box alone does not count). */
    isEmpty() { return def.fields.every((f) => f.type === 'check' || !inputs.has(f.key) || read(f, inputs.get(f.key)) === null); },
    /** Marks the blank mandatory fields (and clears the mark on the rest), so the clerk sees where to look. */
    mark(labels) {
      const want = new Set(labels);
      const either = want.has('Phone or email');
      for (const f of def.fields) {
        const el = inputs.get(f.key);
        if (!el) continue;
        const bad = want.has(f.label) || (either && (f.key === 'phone' || f.key === 'email'));
        if (bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
      }
      const first = [...inputs.values()].find((el) => el.getAttribute('aria-invalid') === 'true');
      if (first) { const box = first.closest('details'); if (box) box.open = true; first.focus(); }
    },
    /** Labels of mandatory fields that are still blank. */
    missing() {
      const v = api.values();
      const minor = sale && isMinor();
      const out = def.fields.filter((f) => inputs.has(f.key) && isReq(f) && v[f.key] === null && !(minor && (f.key === 'phone' || f.key === 'email'))).map((f) => f.label);
      if (sale && !minor && !noContact && inputs.has('phone') && inputs.has('email') && v.phone === null && v.email === null && !out.includes('Phone') && !out.includes('Email')) out.push('Phone or email');
      return out;
    },
  };
  wrap.addEventListener('input', refreshStars);
  wrap.addEventListener('change', refreshStars);
  const baseSet = api.set;
  api.set = (p) => { baseSet(p); refreshStars(); };
  refreshStars();
  return api;
}

/**
 * Customer capture for a sale or booking: find someone already on file (their details fill the form so the clerk
 * can confirm or correct them) or type a new customer. payload() gives what the API wants.
 */
export function customerCapture({ def, scope, who = 'Purchaser', optionalAll = false, onPick = null, sale = false, sizing = false, light = false, noContact = false }) {
  let chosen = null;
  let photoNeeded = false;
  const fields = customerFields({ def, scope, sale, sizing, photo: sale ? 'hidden' : false, light, noContact });
  const picker = personPicker({ label: `Find an existing ${who.toLowerCase()}`, required: false, onPick: (p) => {
    chosen = p;
    if (p) fields.set(p); else fields.set(null);
    if (onPick) onPick(p);
  } });
  const needPurchaser = !sale && scope === 'ticket' && def.required.ticket.includes(def.purchaser_key);
  const note = h('p', { class: 'muted small' }, sale ? '' : chosen ? '' : (needPurchaser ? `${who} details are required for every sale.` : optionalAll ? '' : 'Optional for a quick cash sale. Fill in at least the name to keep a record.'));
  const el = h('div', { class: 'stack' }, picker.el, fields.el, note);
  return {
    el,
    person: () => chosen,
    /** A season pass needs a photo of the holder: show the photo box and insist on one. */
    photoNeeded(on) { photoNeeded = Boolean(on); if (fields.photo) fields.photo.el.hidden = !photoNeeded; },
    hasPhoto: () => Boolean(fields.photo && fields.photo.hasAny()),
    isMinor: () => fields.isMinor(),
    /** Rental sizing as typed: height, weight, boot size, stance, skier type. */
    sizing() { const v = fields.values(); return { height_in: v.height_in, weight_lb: v.weight_lb, boot_size: v.boot_size, stance: v.stance, skier_type: v.skier_type }; },
    firstName: () => (fields.values().first_name || ''),
    usePerson(p) { chosen = p; picker.set(p); fields.set(p); if (onPick) onPick(p); },
    /** Fills the form for someone not on file yet (a driver's license read, a roster line). */
    fill(d) { chosen = null; picker.set(null); fields.set(d); if (onPick) onPick(null); },
    /** Throws a readable error when something mandatory is missing. */
    check() {
      if (!chosen && fields.isEmpty()) {
        if (sale || needPurchaser || scope === 'lesson') throw new Error(`Enter the ${who.toLowerCase()}'s details`);
        return;
      }
      const v = fields.values();
      const gaps = [];
      if (!v.first_name) gaps.push('First name');
      if (!v.last_name) gaps.push('Last name');
      for (const g of fields.missing()) if (!gaps.includes(g)) gaps.push(g);
      fields.mark(gaps);
      if (gaps.length) throw new Error(`Missing required details (marked in red): ${gaps.join(', ')}`);
      if (photoNeeded && fields.photo && !fields.photo.hasAny()) throw new Error('A season pass needs a photo of the holder. Take one with the camera or choose a picture.');
    },
    /** { person_id?, <key>: details } where key is 'purchaser' or 'student'. */
    payload(key) {
      if (!chosen && fields.isEmpty()) return {};
      const photo = fields.photo ? fields.photo.value() : null;
      return { ...(chosen ? { person_id: chosen.id } : {}), [key]: { ...fields.values(), ...(photo ? { photo } : {}) } };
    },
    reset() { chosen = null; picker.set(null); fields.set(null); if (onPick) onPick(null); },
  };
}

/** The mountain's choice of mandatory customer details (managers). */
export async function customerSettingsDialog(onDone) {
  const def = await loadCustomerForm(true);
  const boxes = [];
  const group = (scope, title, note) => {
    const items = def.fields.filter((f) => !f.fixed).map((f) => {
      const box = h('input', { type: 'checkbox', checked: def.required[scope].includes(f.key) });
      boxes.push([scope, f.key, box]);
      return h('label', { class: 'check setting' }, box, ` ${f.label}`);
    });
    const fixed = def.fields.filter((f) => f.fixed === 'required').map((f) => h('label', { class: 'check setting' }, h('input', { type: 'checkbox', checked: true, disabled: true }), ` ${f.label}`, h('span', { class: 'muted' }, ' (always required)')));
    let purchaser = null;
    if (scope === 'ticket') {
      const box = h('input', { type: 'checkbox', checked: def.required.ticket.includes(def.purchaser_key) });
      boxes.push([scope, def.purchaser_key, box]);
      purchaser = h('label', { class: 'check setting wide' }, box, ' Every ticket sale must have a purchaser (no anonymous sales)');
    }
    return h('fieldset', { class: 'stack tight' }, h('legend', null, title), h('p', { class: 'muted small' }, note), purchaser, h('div', { class: 'settings-list' }, [...fixed, ...items]));
  };
  formDialog('Customer details: mandatory fields', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Tick the details that must be filled in before a sale or booking can be completed. Names are always required once someone is recorded. Choose carefully: every extra mandatory field slows the ticket window line.'),
    group('ticket', 'When selling tickets', 'Checked for the purchaser on every ticket sale.'),
    group('lesson', 'When booking a lesson', 'Checked for the student on every lesson booking.')),
  async () => {
    const required = { ticket: [], lesson: [] };
    for (const [scope, key, box] of boxes) if (box.checked) required[scope].push(key);
    await put('/crm/form-config', { required });
    forgetCustomerForm();
    toast('Customer form settings saved');
    if (onDone) await onDone();
  }, { wide: true, submitText: 'Save settings' });
}
export { clear, field, button };
