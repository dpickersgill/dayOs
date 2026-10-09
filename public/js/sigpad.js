// A small signature pad. Draws on a canvas with pointer events (finger, pen or mouse) and exports a compact
// PNG data URL that fits the server's size limit.

import { h } from './ui.js';

export const MAX_SIGNATURE_CHARS = 90000;

export function signaturePad() {
  const canvas = h('canvas', { class: 'sigpad', width: 480, height: 180, 'aria-label': 'Signature area. Sign with a finger, pen or mouse.', role: 'img' });
  const c = canvas.getContext ? canvas.getContext('2d') : null;
  let drawing = false;
  let inked = false;

  function setup() {
    if (!c) return;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.lineWidth = 3;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#111111';
  }
  setup();

  function point(e) {
    const r = canvas.getBoundingClientRect();
    const w = r.width || canvas.width;
    const hgt = r.height || canvas.height;
    return [((e.clientX - r.left) / w) * canvas.width, ((e.clientY - r.top) / hgt) * canvas.height];
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!c) return;
    drawing = true;
    inked = true;
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ } }
    const [x, y] = point(e);
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 0.1, y + 0.1);
    c.stroke();
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const [x, y] = point(e);
    c.lineTo(x, y);
    c.stroke();
    e.preventDefault();
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  return {
    el: canvas,
    isEmpty: () => !inked,
    clear() { inked = false; setup(); },
    /** PNG data URL, or null when nothing was drawn. Throws when the drawing is too large to store. */
    toDataUrl() {
      if (!inked) return null;
      const url = canvas.toDataURL('image/png');
      if (url.length > MAX_SIGNATURE_CHARS) throw new Error('That signature is too detailed to save. Clear it and sign again with a simpler stroke.');
      return url;
    },
  };
}
