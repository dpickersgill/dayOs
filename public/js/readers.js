// Reading tickets and cards without extra hardware.
// - A desk RFID reader or barcode scanner types into whatever box has focus: nothing here is needed for those.
// - A phone with NFC (Chrome on Android) can read a card's chip serial through Web NFC.
// - A phone or tablet camera can read a ticket's barcode or QR code where the browser has BarcodeDetector.
// Both are offered only where the browser supports them.
import { h, button, dialog } from './ui.js';

export const nfcSupported = () => typeof window !== 'undefined' && 'NDEFReader' in window;
export const cameraSupported = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

/**
 * Listen for cards tapped on the phone. Calls onCard(serial) for each tap, with the serial as the phone reports it
 * ("04:a2:3b:..."); the server accepts that form. Returns stop(). Throws if the person refuses NFC permission.
 */
export async function listenNfc(onCard, onError) {
  const reader = new window.NDEFReader();
  const ctl = new AbortController();
  let last = ''; let lastAt = 0;
  reader.addEventListener('reading', (e) => {
    const serial = String(e.serialNumber || '');
    if (!serial) return;
    // A card held on the phone fires again and again: one read per card per two seconds.
    if (serial === last && Date.now() - lastAt < 2000) return;
    last = serial; lastAt = Date.now();
    onCard(serial);
  });
  reader.addEventListener('readingerror', () => onError && onError(new Error('Could not read that card. Hold it still on the back of the phone.')));
  await reader.scan({ signal: ctl.signal });
  return () => ctl.abort();
}

/** One card, read once: resolves with its serial, or null if the dialog is closed first. */
export function readOneCard(title = 'Tap the card on the back of the phone') {
  return new Promise((resolve) => {
    let stop = null; let done = false;
    const note = h('p', { class: 'muted' }, 'Waiting for a card…');
    let d = null;
    const finish = (v) => { if (done) return; done = true; if (stop) stop(); if (d) d.close(); resolve(v); };
    d = dialog(title, h('div', { class: 'stack' }, h('p', null, 'Hold the card flat against the back of the phone until it buzzes.'), note), { onClose: () => finish(null) });
    listenNfc((serial) => finish(serial), (err) => { note.textContent = err.message; })
      .then((s) => { stop = s; if (done) s(); })
      .catch((err) => { note.textContent = err && err.name === 'NotAllowedError' ? 'NFC is blocked. Allow NFC for this site in the browser settings.' : 'This phone cannot read cards here. Use a desk reader instead.'; });
  });
}

/** Read one barcode or QR code with the camera. Resolves with its text, or null if closed first. */
export function scanWithCamera(title = 'Point the camera at the barcode') {
  return new Promise((resolve) => {
    let stream = null; let timer = null; let done = false;
    const video = h('video', { class: 'camera-view', autoplay: true, muted: true, playsinline: true, 'aria-label': 'Camera view' });
    const note = h('p', { class: 'muted' }, 'Starting the camera…');
    let d = null;
    function finish(v) {
      if (done) return; done = true;
      clearInterval(timer);
      if (stream) for (const t of stream.getTracks()) t.stop();
      if (d) d.close();
      resolve(v);
    }
    d = dialog(title, h('div', { class: 'stack' }, video, note, button('Cancel', () => finish(null))), { onClose: () => finish(null) });
    (async () => {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        const want = ['code_128', 'qr_code', 'code_39', 'ean_13', 'pdf417', 'data_matrix'].filter((f) => formats.includes(f));
        const detector = new window.BarcodeDetector(want.length ? { formats: want } : undefined);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (done) { for (const t of stream.getTracks()) t.stop(); return; } // closed while the camera was starting
        video.srcObject = stream;
        note.textContent = 'Hold the barcode inside the picture.';
        timer = setInterval(async () => {
          if (done || video.readyState < 2) return;
          try {
            const found = await detector.detect(video);
            if (found.length && found[0].rawValue) finish(found[0].rawValue);
          } catch (_) { /* keep looking */ }
        }, 250);
      } catch (err) {
        note.textContent = err && err.name === 'NotAllowedError' ? 'The camera is blocked. Allow the camera for this site in the browser settings.' : 'The camera could not start on this device.';
      }
    })();
  });
}
