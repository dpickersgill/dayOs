// Barcodes drawn as SVG: Code 128 (what a handheld or desktop scanner reads) and QR (what a phone reads).
// Both are built from shapes, never from markup strings.

import { svg } from './ui.js';
import qrcode from '../vendor/qrcode/qrcode.js';

// Code 128 bar and space widths for symbols 0-105, then the start/stop symbols.
const PATTERNS = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232 2331112').split(' ');
const START_B = 104;
const STOP = 106;

/** Symbol values for text in Code 128 set B (printable ASCII), with the check digit. */
export function code128Values(text) {
  const s = String(text);
  const values = [START_B];
  for (const ch of s) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 95) throw new Error('This text cannot be made into a barcode');
    values.push(v);
  }
  let sum = START_B;
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103, STOP);
  return values;
}

/** An SVG barcode. width is in pixels; the quiet zone either side is built in. */
export function code128(text, { height = 54, module = 2 } = {}) {
  const values = code128Values(text);
  const rects = [];
  let x = 10 * module; // quiet zone
  for (const v of values) {
    const widths = PATTERNS[v].split('').map(Number);
    widths.forEach((w, i) => {
      if (i % 2 === 0) rects.push(svg('rect', { x, y: 0, width: w * module, height, fill: '#000' }));
      x += w * module;
    });
  }
  const width = x + 10 * module;
  const el = svg('svg', { class: 'barcode', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Barcode ${text}` }, ...rects);
  el.insertBefore(svg('rect', { x: 0, y: 0, width, height, fill: '#fff' }), el.firstChild);
  return el;
}

/** An SVG QR code with a quiet zone. */
export function qr(text, { size = 120 } = {}) {
  const q = qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount();
  const quiet = 3;
  const total = n + quiet * 2;
  const cells = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) cells.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
  return svg('svg', { class: 'qr', width: size, height: size, viewBox: `0 0 ${total} ${total}`, role: 'img', 'aria-label': `QR code ${text}`, 'shape-rendering': 'crispEdges' },
    svg('rect', { width: total, height: total, fill: '#fff' }), svg('path', { d: cells.join(''), fill: '#000' }));
}
