// Photos on a case. Each is uploaded at full size, untouched, and the server records its SHA-256 fingerprint; a small
// preview made on the phone is what the case page shows. When and where it was taken come from the photo itself, so a
// photo taken with the phone's camera where there was no signal can be added later and still carries its real time and
// place. Opening a photo shows the original, with Verify (the stored file still matches its fingerprint) and Download.
import { get, post, sendBytes, fetchBlob, download } from '../api.js';
import { h, clear, button, toast, dialog, formDialog, field, input, select, fmtDateTime, state, errorBox } from '../ui.js';

const urls = new Map(); // photo id -> object URL of its preview, kept while the page is open
const ref = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const localStamp = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A small JPEG of the photo (longest side 640 px), made on the phone. Null where the browser cannot draw the file. */
async function previewOf(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((done) => { canvas.toBlob((b) => done(b), 'image/jpeg', 0.72); });
  } catch (_) { return null; }
}
/** Where the phone is now, if it says so within 4 seconds (used only for a photo that carries no place of its own). */
const herePos = () => new Promise((done) => {
  if (!navigator.geolocation) { done(null); return; }
  navigator.geolocation.getCurrentPosition((p) => done(p.coords), () => done(null), { timeout: 4000, maximumAge: 300000 });
});

/** The Photos panel on a case. */
export function photosPanel(c, { id, editable, reload, readOnly = false }) {
  const list = c.photos || [];
  const live = list.filter((p) => !p.voided_at);
  const voided = list.filter((p) => p.voided_at);
  const grid = h('div', { class: 'photo-grid' }, live.map((p) => tile(p)));
  const add = editable && !readOnly ? button('Add photos', () => addDialog(c, id, reload), { small: true, kind: live.length ? undefined : 'primary' }) : null;
  return h('section', { class: 'panel stack', 'data-area': 'photos' },
    h('div', { class: 'spread' }, h('h2', null, 'Photos'), add),
    live.length ? grid : h('p', { class: 'muted' }, editable ? 'None yet. Photos are kept exactly as taken, at full size, with a fingerprint that shows they have not been changed.' : 'No photos.'),
    voided.length ? h('details', null, h('summary', null, `Entered in error (${voided.length})`), h('ul', { class: 'plain' }, voided.map((p) => h('li', { class: 'voided' }, `Photo ${p.id}${p.caption ? `: ${p.caption}` : ''}`, h('span', { class: 'muted small' }, ` ${p.void_reason} (${p.voided_by_email || ''}, ${fmtDateTime(p.voided_at)})`))))) : null);

  function tile(p) {
    const img = h('img', { alt: p.caption || `Photo ${p.id}`, loading: 'lazy', width: 160, height: 120 });
    const box = h('button', { type: 'button', class: 'photo-tile', 'aria-label': `Open photo${p.caption ? `: ${p.caption}` : ''}` },
      p.has_preview ? img : h('span', { class: 'photo-none' }, p.mime === 'image/heic' ? 'HEIC photo' : 'Photo'),
      h('span', { class: 'photo-cap' }, p.caption || (p.taken_at ? fmtDateTime(p.taken_at) : fmtDateTime(p.uploaded_at))));
    if (p.has_preview) {
      if (urls.has(p.id)) img.src = urls.get(p.id);
      else fetchBlob(`/patrol/incidents/${id}/photos/${p.id}/preview`).then((b) => { const u = URL.createObjectURL(b); urls.set(p.id, u); img.src = u; }).catch(() => {});
    }
    box.addEventListener('click', () => viewer(p));
    return box;
  }

  function viewer(p) {
    const holder = h('div', { class: 'photo-view' }, h('p', { class: 'loading' }, 'Loading the original…'));
    const verdict = h('div', { role: 'status' });
    const d = dialog(p.caption || `Photo ${p.id}`, h('div', { class: 'stack' }, holder,
      h('dl', { class: 'photo-facts' },
        h('dt', null, 'Taken'), h('dd', null, p.taken_at ? fmtDateTime(p.taken_at) : 'Not recorded in the photo'),
        h('dt', null, 'Where'), h('dd', null, p.taken_lat !== null ? h('a', { href: `https://www.google.com/maps/search/?api=1&query=${p.taken_lat},${p.taken_lng}`, target: '_blank', rel: 'noopener' }, `${p.taken_lat.toFixed(5)}, ${p.taken_lng.toFixed(5)}`) : 'Not recorded'),
        h('dt', null, 'Added'), h('dd', null, `${fmtDateTime(p.uploaded_at)}${p.uploaded_by_name ? `, ${p.uploaded_by_name}` : ''}`),
        h('dt', null, 'File'), h('dd', null, `${p.mime.replace('image/', '').toUpperCase()}, ${mb(p.bytes)}`),
        h('dt', null, 'Fingerprint'), h('dd', null, h('code', { class: 'hash' }, p.sha256))),
      verdict,
      h('div', { class: 'row' },
        button('Verify', async () => {
          const v = await get(`/patrol/incidents/${id}/photos/${p.id}/verify`);
          clear(verdict).append(v.unchanged ? state('Unchanged since it was added: the file matches its fingerprint', 'good') : state('This file does not match the fingerprint recorded when it was added', 'bad'));
        }, { small: true }),
        button('Download original', () => download(`/patrol/incidents/${id}/photos/${p.id}/original?download=1`, `case-${c.case_number || id}-photo-${p.id}.${p.mime === 'image/jpeg' ? 'jpg' : p.mime.split('/')[1]}`), { small: true }),
        editable && !readOnly ? button('Entered in error', () => voidPhoto(p, d), { small: true, kind: 'quiet-danger' }) : null)), { wide: true });
    fetchBlob(`/patrol/incidents/${id}/photos/${p.id}/original`).then((b) => {
      const u = URL.createObjectURL(b);
      clear(holder).append(p.mime === 'image/heic' && !/Safari/.test(navigator.userAgent) ? h('p', { class: 'muted' }, 'This browser cannot show HEIC photos. Download the original to open it.') : h('img', { src: u, alt: p.caption || `Photo ${p.id}` }));
    }).catch((err) => { clear(holder).append(errorBox(err)); });
  }

  function voidPhoto(p, d) {
    const reason = input({ name: 'reason', required: true, minlength: 3, maxlength: 255, placeholder: 'Wrong patient, taken by mistake…' });
    formDialog('Mark this photo entered in error?', h('div', { class: 'stack' }, h('p', null, 'It stays in the record, struck through, with your name and reason. Nothing is deleted.'), field('Why', reason)), async () => {
      await post(`/patrol/incidents/${id}/photos/${p.id}/void`, { reason: reason.value.trim() });
      d.close(); toast('Marked entered in error'); await reload();
    }, { submitText: 'Mark entered in error' });
  }
}

function addDialog(c, id, reload) {
  if (navigator.onLine === false) { toast('Photos need a signal. Take them with the phone camera now and add them here later: their time and place come from the photo.', 'warn'); return; }
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, name: 'files', required: true });
  const caption = input({ name: 'caption', maxlength: 255, placeholder: 'For example "Left wrist, before splinting"' });
  const pts = (c.patients || []).filter((p) => !p.voided_at);
  const who = pts.length ? select([['', 'The whole case'], ...pts.map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim()])], pts.length === 1 ? pts[0].id : '', { name: 'patient' }) : null;
  const progress = h('p', { class: 'muted', role: 'status' });
  formDialog('Add photos', h('div', { class: 'stack' },
    field('Photos', files, 'Take new ones with the camera, or choose from the phone. They are kept at full size.'),
    field('Caption (optional, for all of them)', caption),
    who ? field('Of', who) : null, progress),
  async () => {
    const list = [...files.files];
    if (!list.length) throw new Error('Choose at least one photo');
    let here; let done = 0;
    for (const f of list) {
      if (f.size > 15 * 1048576) throw new Error(`${f.name} is ${mb(f.size)}; the most is 15 MB`);
      progress.textContent = `Sending ${done + 1} of ${list.length}…`;
      if (here === undefined) here = await herePos();
      const qs = new URLSearchParams({ client_ref: ref(), file_name: f.name.slice(0, 200), taken_at: localStamp(f.lastModified || Date.now()) });
      if (caption.value.trim()) qs.set('caption', caption.value.trim());
      if (who && who.value) qs.set('patient_id', who.value);
      if (here) { qs.set('lat', here.latitude.toFixed(6)); qs.set('lng', here.longitude.toFixed(6)); }
      const r = await sendBytes('POST', `/patrol/incidents/${id}/photos?${qs}`, f);
      const pv = await previewOf(f);
      if (pv) await sendBytes('PUT', `/patrol/incidents/${id}/photos/${r.id}/preview`, pv).catch(() => {});
      done += 1;
    }
    toast(`${done} photo${done === 1 ? '' : 's'} added`);
    await reload();
  }, { submitText: 'Add photos' });
}
