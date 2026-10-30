'use strict';
// A Code 128 barcode for email, drawn as a row of table cells (black and white), so it shows in Gmail, Outlook and Apple
// Mail without images: mail apps block images and drop SVG, but they all draw table cells. The gate's scanners read it
// from the phone screen like the one on the order page (public/js/barcode.js uses the same symbols).
const PATTERNS = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232 2331112').split(' ');
const START_B = 104; const STOP = 106;

/** Bar and space widths (in modules) for text in Code 128 set B, quiet zones included. */
function widths(text) {
  const values = [START_B];
  for (const ch of String(text)) {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 95) throw new Error('This text cannot be made into a barcode');
    values.push(v);
  }
  let sum = START_B;
  for (let i = 1; i < values.length; i += 1) sum += values[i] * i;
  values.push(sum % 103, STOP);
  const out = [10]; // quiet zone (a space)
  for (const v of values) for (const w of PATTERNS[v]) out.push(Number(w));
  out.push(10);
  return out; // even index: space, odd index: bar (the quiet zone starts with a space)
}

/** The barcode as an HTML table. module: pixels per module; height: pixels. */
function table(text, { module = 2, height = 64 } = {}) {
  const w = widths(text);
  const cells = w.map((n, i) => `<td width="${n * module}" height="${height}" style="width:${n * module}px;height:${height}px;padding:0;line-height:0;font-size:0;background:${i % 2 ? '#000000' : '#ffffff'}" bgcolor="${i % 2 ? '#000000' : '#ffffff'}"></td>`).join('');
  return `<table role="img" aria-label="Barcode ${String(text).replace(/[^A-Za-z0-9-]/g, '')}" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 auto;background:#ffffff"><tr>${cells}</tr></table>`;
}

module.exports = { widths, table };
