// A photo for a customer (shown at the gate next to a season pass). The picture is shrunk on this device to a small
// JPEG before it is sent, so a phone or webcam picture does not fill the database.

import { h, clear, button } from './ui.js';

const MAX_SIDE = 320;
const QUALITY = 0.78;
const LIMIT = 90_000; // characters of base64; the server accepts up to 120,000

/** Shrinks an image file to a JPEG data URL, or throws a readable error. */
export async function shrink(file) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('Choose a picture');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That picture could not be opened')); i.src = url; });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const hgt = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = hgt;
    const g = canvas.getContext && canvas.getContext('2d');
    if (!g) throw new Error('This browser cannot resize pictures');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, hgt);
    g.drawImage(img, 0, 0, w, hgt);
    let q = QUALITY;
    let out = canvas.toDataURL('image/jpeg', q);
    while (out.length > LIMIT && q > 0.3) { q -= 0.12; out = canvas.toDataURL('image/jpeg', q); }
    if (out.length > LIMIT) throw new Error('That picture is too detailed. Try a closer photo of the face.');
    return out;
  } finally { URL.revokeObjectURL(url); }
}

/**
 * A photo picker. On a phone or tablet the camera opens; on a computer it opens a file chooser.
 * has: a photo is already on file. value(): a new data URL or null. onChange runs when a new photo is chosen.
 */
export function photoControl({ has = false, current = null, onChange = null, label = 'Photo' } = {}) {
  let value = null;
  const input = h('input', { type: 'file', accept: 'image/*', capture: 'user', 'aria-label': `${label}: take or choose a picture`, class: 'photo-input' });
  const preview = h('div');
  const msg = h('p', { class: 'small', role: 'status' });
  const draw = () => {
    clear(preview);
    const src = value || current;
    if (src) preview.append(h('img', { class: 'photo-preview', src, alt: 'Photo' }));
    else preview.append(h('div', { class: 'photo-empty' }, has ? 'Photo on file' : 'No photo yet'));
  };
  input.addEventListener('change', async () => {
    clear(msg);
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      value = await shrink(file);
      draw();
      if (onChange) onChange(value);
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  const el = h('div', { class: 'photo-field', 'data-photo': '' }, h('span', { class: 'photo-label' }, label), preview, input, msg);
  draw();
  return {
    el,
    value: () => value,
    hasAny: () => Boolean(value || has || current),
    set(v) { value = v; draw(); },
    setHas(b) { has = b; draw(); },
    setCurrent(v) { current = v; draw(); },
  };
}
export { button };

/** Resizes any picture to fit maxSide, as a JPEG (photos) or PNG (logos keep their transparency). Throws a readable error. */
export async function fit(file, maxSide, type = 'image/jpeg', limit = 300_000) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('Choose a picture');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('That picture could not be opened')); i.src = url; });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = canvas.getContext('2d');
    if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); }
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    let q = 0.82; let out = canvas.toDataURL(type, q);
    while (out.length > limit && type === 'image/jpeg' && q > 0.3) { q -= 0.1; out = canvas.toDataURL(type, q); }
    if (out.length > limit) throw new Error('That picture is too detailed. Try a smaller or simpler one.');
    return out;
  } finally { URL.revokeObjectURL(url); }
}
