// The ski school, round 2 (parents). school.js adds these tabs to Ski school and these pages to Settings, Ski school.
// tabs(ctx): [[key, label, (panel) => render]], ctx = { staff, names, certs }. settingsPages: { key: { title, render(panel) } }.
//
// Recaps: after a lesson, its instructor sends each student's family a short recap (skills, the level now, a note, up to
// two photos when the family said yes). The AI writer drafts the words when the mountain has it; nothing is sent until the
// instructor taps Approve and send. Waitlist: the families waiting for full lessons, for the desk. Families settings:
// recaps, photos, tips, the waitlist hold, next-step offers, and the lift ticket and rental each lesson offers online.
import { get, post, put, patch, del, config, session } from '../api.js';
import { h, clear, ctx, can, isManager, schoolCan, button, toast, fail, errorBox, empty, fmtDate, fmtTime, fmtDateTime, select, input, field, confirmDialog, state } from '../ui.js';
import { levelOptions, levelName } from '../levels.js';
import { card, row, toggle, amount } from './settings-kit.js';

const teaches = () => isManager() || (ctx.me && ctx.me.role === 'instructor');

export function tabs(_ctx) {
  const out = [];
  if (teaches()) out.push(['recaps', 'Recaps', (panel) => recapsTab(panel)]);
  if ((can('counter') || schoolCan('supervisor'))) out.push(['waitlist', 'Waitlist', (panel) => waitlistTab(panel)]);
  return out;
}

/** How many recaps the signed-in instructor still has to send (for My day's link). */
export async function recapCount() {
  try { return (await get('/skischool/recaps/count')).count; } catch (_) { return 0; }
}

// ---------------------------------------------------------------- recaps
/** Makes a phone photo at most 1600 px on its long side, as a JPEG. */
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
  } finally { URL.revokeObjectURL(url); }
}
async function rawPost(path, blob) {
  const res = await fetch(`${config.base}/api/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': blob.type || 'image/jpeg' }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'The photo did not upload');
  return data;
}
async function photoUrl(bookingId, id) {
  const res = await fetch(`${config.base}/api/v1/skischool/recaps/${bookingId}/photos/${id}`, { headers: { authorization: `Bearer ${session.token}` } });
  return res.ok ? URL.createObjectURL(await res.blob()) : '';
}
const Speech = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

/** The words the family reads, from the ticks and the note, when there is no AI writer. The instructor can change them. */
function plainRecap(first, skills, level, note, discipline) {
  const parts = [];
  if (skills.length) parts.push(`Today ${first} worked hard. ${first} can now: ${skills.map((s) => s.replace(/^I can /i, '').replace(/^I /i, '').replace(/\.$/, '')).join('; ')}.`);
  else parts.push(`${first} had a great lesson today.`);
  if (level) parts.push(`${first} is now at ${levelName(level, discipline)}.`);
  if (note) parts.push(note.trim().replace(/([^.!?])$/, '$1.'));
  return parts.join(' ');
}

async function recapsTab(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'After a lesson, send each family a short recap: what their child can do now, the level they are at, and a note. Nothing goes out until you tap Approve and send.'), body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const d = await get('/skischool/recaps');
      clear(body);
      if (!d.on) { body.append(empty('Recaps are turned off. A manager can turn them on in Settings, Ski school, Families.')); return; }
      if (!d.lessons.length) { body.append(empty('No recaps to send. They show here when your lessons end.')); return; }
      for (const l of d.lessons) {
        body.append(h('section', { class: 'panel stack recap-lesson', 'data-session': l.session_id },
          h('header', { class: 'row between' }, h('h2', null, `${l.product}, ${fmtDate(l.starts_at)} ${fmtTime(l.starts_at)}`), h('span', { class: 'muted small' }, `${l.level_words} · ${l.students.length} to send`)),
          l.students.map((s) => studentRecap(s, l, d, load))));
      }
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

function studentRecap(s, l, d, reload) {
  const id = `r${s.booking_id}`;
  const ticked = new Set((s.skills || []).map((k) => k.name));
  const level = select([['', 'Same level'], ...levelOptions(l.discipline)], String(s.level || ''), { id: `${id}-level`, 'aria-label': `${s.first_name}'s level now` });
  const note = h('textarea', { id: `${id}-note`, rows: 2, maxlength: 1000, placeholder: 'One thing they did well, one thing to practice' }, s.note || '');
  const words = h('textarea', { id: `${id}-body`, rows: 4, maxlength: 4000, 'aria-describedby': `${id}-body-hint` }, s.body || '');
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const boxes = s.skills_offered.map((k, i) => {
    const cb = h('input', { type: 'checkbox', id: `${id}-sk${i}`, checked: ticked.has(k.name), 'data-skill': k.id || '', 'data-name': k.name });
    return h('label', { class: 'check-row', for: `${id}-sk${i}` }, cb, h('span', null, k.name, h('span', { class: 'muted small' }, ` (level ${k.level})`)));
  });
  const skills = () => boxes.map((b) => b.querySelector('input')).filter((c) => c.checked).map((c) => ({ ...(c.dataset.skill ? { id: Number(c.dataset.skill) } : {}), name: c.dataset.name }));
  const payload = () => ({ skills: skills(), level: level.value ? Number(level.value) : null, note: note.value.trim() || null, body: words.value.trim() || null });
  // A spoken note: the browser turns speech into words (no audio is kept or sent).
  const mic = Speech ? button('Speak a note', () => {
    const rec = new Speech(); rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
    mic.disabled = true; mic.textContent = 'Listening…';
    rec.onresult = (e) => { note.value = `${note.value ? `${note.value} ` : ''}${e.results[0][0].transcript}`; };
    rec.onend = () => { mic.disabled = false; mic.textContent = 'Speak a note'; };
    rec.onerror = () => { mic.disabled = false; mic.textContent = 'Speak a note'; toast('Could not hear that. Type the note instead.', 'error'); };
    rec.start();
  }, { small: true }) : null;
  const write = button(d.ai ? 'Write it for me' : 'Fill in from my ticks', async () => {
    if (!d.ai) { words.value = plainRecap(s.first_name, skills().map((k) => k.name), level.value ? Number(level.value) : null, note.value, l.discipline); words.focus(); return; }
    write.disabled = true; clear(msg).append(h('p', { class: 'muted small' }, 'Writing…'));
    try { const r = await post(`/skischool/recaps/${s.booking_id}/write`, payload()); words.value = r.body; clear(msg).append(h('p', { class: 'muted small' }, 'Read it and change anything before you send.')); words.focus(); } catch (err) { clear(msg).append(errorBox(err)); } finally { write.disabled = false; }
  }, { small: true });
  // Photos: only when the family said yes.
  const photos = h('div', { class: 'recap-photos' });
  let photoCount = s.photos;
  const drawPhotos = async () => {
    clear(photos);
    if (!d.photos || !s.photo_ok) { photos.append(h('p', { class: 'muted small' }, d.photos ? 'No photos: the family has not said yes to photos.' : 'Recap photos are turned off.')); return; }
    const list = (await get(`/skischool/recaps/${s.booking_id}/photos`)).data;
    photoCount = list.length;
    for (const p of list) {
      const img = h('img', { alt: `Photo for ${s.first_name}`, width: 96, height: 96 });
      photoUrl(s.booking_id, p.id).then((u) => { img.src = u; });
      photos.append(h('figure', { class: 'recap-photo' }, img, button('Remove', async () => { await del(`/skischool/recaps/${s.booking_id}/photos/${p.id}`); await drawPhotos(); }, { small: true, label: `Remove photo of ${s.first_name}` })));
    }
    if (photoCount < 2) {
      const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', id: `${id}-photo`, class: 'visually-hidden', onchange: async (e) => {
        const f = e.target.files && e.target.files[0]; if (!f) return;
        try { await rawPost(`/skischool/recaps/${s.booking_id}/photos`, await shrink(f)); await drawPhotos(); } catch (err) { fail(err); }
      } });
      photos.append(h('label', { class: 'btn small', for: `${id}-photo` }, photoCount ? 'Add another photo' : 'Add a photo'), file);
    }
  };
  drawPhotos().catch(() => {});
  const send = button('Approve and send', async () => {
    if (!words.value.trim()) { words.value = plainRecap(s.first_name, skills().map((k) => k.name), level.value ? Number(level.value) : null, note.value, l.discipline); }
    if (words.value.trim().length < 10) { clear(msg).append(errorBox(new Error('Write a few words to the family first.'))); return; }
    try { await post(`/skischool/recaps/${s.booking_id}/send`, payload()); toast(`Sent to ${s.first_name}'s family`); await reload(); } catch (err) { clear(msg).append(errorBox(err)); }
  }, { kind: 'primary' });
  return h('article', { class: 'recap-card stack', 'data-booking': s.booking_id, 'aria-labelledby': `${id}-h` },
    h('header', { class: 'row between' }, h('h3', { id: `${id}-h` }, `${s.first_name} ${s.last_name}`), h('span', { class: 'muted small' }, levelName(s.level_now, l.discipline))),
    h('fieldset', { class: 'recap-skills' }, h('legend', null, 'Can do now (tick what you saw)'), boxes),
    h('div', { class: 'row wrap' }, field('Level now', level)),
    h('div', { class: 'stack tight' }, field('Your note', note), mic),
    h('div', { class: 'stack tight' }, h('div', { class: 'row between' }, h('label', { for: `${id}-body`, class: 'strong' }, 'What the family reads'), write), words,
      h('span', { class: 'muted small', id: `${id}-body-hint` }, 'Warm and short. Do not mention allergies or medical notes.')),
    photos, msg,
    h('div', { class: 'row wrap' }, send, button('Save for later', async () => { await put(`/skischool/recaps/${s.booking_id}`, payload()); toast('Saved'); }), button('Skip', () => confirmDialog(`Skip ${s.first_name}'s recap?`, 'The family gets no recap for this lesson.', 'Skip', async () => { await post(`/skischool/recaps/${s.booking_id}/skip`); await reload(); }))));
}

// ---------------------------------------------------------------- the waitlist
async function waitlistTab(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'Families waiting for a place in a full lesson. When a place opens, the first family gets an email (and a text with the add-on) with a link to claim it, held for a short time.'), body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get('/skischool/waitlists');
      clear(body).append(...(data.length ? data.map((s) => waitlistBlockFor(s, load)) : [empty('Nobody is waiting.')]));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}
function waitlistBlockFor(s, reload) {
  return h('section', { class: 'panel stack', 'data-session': s.id }, h('header', { class: 'row between' }, h('h2', null, `${s.product}, ${fmtDateTime(s.starts_at)}`), h('span', { class: 'muted small' }, `${s.level_words} · ${s.booked} of ${s.capacity} booked`)),
    waitingList(s.id, s.waiting, reload),
    h('div', { class: 'row' }, button('Offer open places now', async () => { const r = await post(`/skischool/sessions/${s.id}/waitlist/offer`); toast(r.offered ? `Offered to ${r.offered} family${r.offered === 1 ? '' : 'ies'}` : 'No open places right now'); await reload(); }, { small: true })));
}
function waitingList(sessionId, list, reload) {
  return h('ol', { class: 'waitlist' }, list.map((w) => h('li', { class: 'row between wrap' },
    h('span', null, h('strong', null, w.student), w.level ? h('span', { class: 'muted small' }, ` · Level ${w.level}`) : null, h('br'),
      h('span', { class: 'small' }, `${w.contact_name} · `, h('a', { href: `mailto:${w.contact_email}` }, w.contact_email), w.contact_phone ? ` · ${w.contact_phone}` : '')),
    h('span', { class: 'row' }, w.status === 'offered' ? state(`Offered, ${w.minutes_left} min left`, 'warn') : state('Waiting', 'neutral'),
      (can('counter') || schoolCan('supervisor')) ? button('Remove', () => confirmDialog('Take them off the waitlist?', `${w.student} (${w.contact_name})`, 'Remove', async () => { await del(`/skischool/waitlist/${w.id}`); await reload(); }), { small: true }) : null))));
}

/** The waitlist for one lesson, for a roster (CORE's lesson dialog can show it): an element, empty when nobody waits. */
export async function waitlistBlock(sessionId) {
  const box = h('div', { class: 'stack waitlist-block' });
  if (!(can('counter') || schoolCan('supervisor'))) return box;
  const load = async () => {
    try {
      const { data } = await get(`/skischool/sessions/${sessionId}/waitlist`);
      clear(box);
      if (data.length) box.append(h('h3', null, `Waitlist (${data.length})`), waitingList(sessionId, data, load));
    } catch (_) { /* nothing to show */ }
  };
  await load();
  return box;
}

// ---------------------------------------------------------------- Settings, Ski school: Families
async function familiesSettings(panel) {
  const [s, f] = await Promise.all([get('/skischool/settings'), get('/skischool/families/settings')]);
  const t = {
    recap_on: toggle({ checked: Boolean(s.recap_on) }), recap_photos: toggle({ checked: Boolean(s.recap_photos) }),
    tips_on: toggle({ checked: Boolean(s.tips_on) }), tip_policy: input({ value: s.tip_policy || '', maxlength: 500, placeholder: f.tip_policy_default }),
    waitlist_claim_minutes: input({ type: 'number', min: 5, max: 240, value: s.waitlist_claim_minutes }),
    next_lesson_on: toggle({ checked: Boolean(f.next_lesson_on) }), pack_on: toggle({ checked: Boolean(f.pack_on) }), pack_credit: toggle({ checked: Boolean(f.pack_credit) }),
    pass_on: toggle({ checked: Boolean(f.pass_on) }), pass_words: input({ value: f.pass_words || '', maxlength: 300, placeholder: 'You have had three lessons with us. Put what you spent toward a season pass: ask at the ski school desk.' }),
    followup_on: toggle({ checked: Boolean(f.followup_on) }),
  };
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const save = button('Save', async () => {
    clear(msg);
    try {
      await patch('/skischool/settings', { recap_on: t.recap_on.checked, recap_photos: t.recap_photos.checked, tips_on: t.tips_on.checked, tip_policy: t.tip_policy.value.trim() || null, waitlist_claim_minutes: Number(t.waitlist_claim_minutes.value) || 15 });
      await patch('/skischool/families/settings', { next_lesson_on: t.next_lesson_on.checked, pack_on: t.pack_on.checked, pack_credit: t.pack_credit.checked, pass_on: t.pass_on.checked, pass_words: t.pass_words.value.trim() || null, followup_on: t.followup_on.checked});
      toast('Saved');
    } catch (err) { msg.append(errorBox(err)); }
  }, { kind: 'primary' });
  const extras = f.lesson_products.map((p) => {
    const tk = select([['', 'No lift ticket'], ...f.tickets.map((x) => [String(x.id), x.name])], String(p.ticket_product_id || ''), { 'aria-label': `Lift ticket offered with ${p.name}` });
    const rn = select([['', 'No rental'], ...f.rentals.map((x) => [String(x.id), x.name])], String(p.rental_product_id || ''), { 'aria-label': `Rental offered with ${p.name}` });
    const go = async () => { try { await put(`/skischool/families/extras/${p.id}`, { ticket_product_id: tk.value ? Number(tk.value) : null, rental_product_id: rn.value ? Number(rn.value) : null }); toast(`${p.name} saved`); } catch (err) { fail(err); } };
    tk.addEventListener('change', go); rn.addEventListener('change', go);
    return row(p.name, h('span', { class: 'row wrap' }, tk, rn), 'Offered with this lesson on the booking page, priced by age. A rental waits in the rental shop\'s Ready to fit.', { wide: true });
  });
  panel.append(
    row('Send recaps after lessons', t.recap_on, 'Instructors send each family a short recap and the progress card.'),
    row('Photos in recaps', t.recap_photos, 'Only for children whose family said yes. Deleted after 90 days.'),
    row('Tips', t.tips_on, 'Families can tip from the recap. Tips go in full to the instructor.'),
    row('Tip policy in your words', t.tip_policy, 'Shown next to the tip buttons.', { wide: true }),
    row('Waitlist hold', amount(t.waitlist_claim_minutes, 'minutes'), 'How long the next family has to claim an open place.'),
    row('Offer the next lesson', t.next_lesson_on, 'After a lesson: the next lessons that fit the new level.'),
    row('Offer a lesson pack', t.pack_on, f.sells_packs ? 'Shows your lesson pack from the online shop.' : 'You do not sell a lesson pack online yet.'),
    row('Today\'s lesson counts toward the pack', t.pack_credit, 'Tells families to show the page at the desk.'),
    row('Season pass message after three lessons', t.pass_on, f.sells_passes ? 'With a link to your passes in the online shop.' : 'You do not sell passes online yet.'),
    row('Season pass words', t.pass_words, null, { wide: true }),
    row('Follow-up after a first lesson', t.followup_on, 'One email three days later when nothing else is booked.'),
    h('div', { class: 'set-row' }, msg, save),
    f.lesson_products.length ? h('h3', { class: 'set-subhead' }, 'Lift ticket and rental with a lesson') : null, ...extras);
}

export const settingsPages = {
  families: { title: 'Families: recaps, tips, waitlist and offers', who: 'manager', render: (panel) => familiesSettings(panel) },
};
