'use strict';
// Is a signature image really signed? (2026.11.11) The signing pads (public/js/sigpad.js) send a PNG of the box: white,
// with dark ink where the person drew. A PNG that only starts with the right 8 bytes, or a blank box, is not a signature.
// This reads the PNG with Node's own zlib (no new dependency): the size must be sane, and enough of the box must be ink.
const zlib = require('zlib');

const MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_W = 60; const MAX_W = 4000; const MIN_H = 30; const MAX_H = 2000;
const MIN_INK = 60; // dark pixels: a short pen stroke on the pad draws several hundred
const MIN_SPAN = 12; // the ink must reach across at least this many pixels (not one dot)

/** Bytes per pixel for the color types a canvas or an image editor writes, at 8 bits per channel. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Checks a data URL. Returns { ok: true } or { ok: false, why } with words for the signer. Never throws.
 */
function check(dataUrl) {
  const no = (why) => ({ ok: false, why });
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return no('Please sign in the box');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 45 || !buf.subarray(0, 8).equals(MAGIC)) return no('Please sign in the box');
  let at = 8; let ihdr = null; let palette = null; let trns = null; const idat = [];
  try {
    while (at + 8 <= buf.length) {
      const len = buf.readUInt32BE(at); const type = buf.toString('latin1', at + 4, at + 8);
      const data = buf.subarray(at + 8, at + 8 + len);
      if (data.length !== len) return no('Please sign in the box');
      if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
      else if (type === 'PLTE') palette = data;
      else if (type === 'tRNS') trns = data;
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      at += 12 + len;
    }
    if (!ihdr || !idat.length) return no('Please sign in the box');
    const { w, h, depth, color, interlace } = ihdr;
    if (w < MIN_W || w > MAX_W || h < MIN_H || h > MAX_H) return no('Please sign in the box');
    const ch = CHANNELS[color];
    if (depth !== 8 || !ch || interlace !== 0 || (color === 3 && !palette)) return no('Please clear the box and sign again');
    const stride = w * ch;
    const raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * h + 1024 });
    if (raw.length < (stride + 1) * h) return no('Please sign in the box');
    let prev = Buffer.alloc(stride); const cur = Buffer.alloc(stride);
    let ink = 0; let minX = w; let maxX = -1;
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? cur[i - ch] : 0; const b = prev[i]; const c = i >= ch ? prev[i - ch] : 0;
        const x = line[i];
        cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : f === 4 ? x + paeth(a, b, c) : -1) & 0xff;
        if (f > 4) return no('Please clear the box and sign again');
      }
      for (let px = 0; px < w; px++) {
        const o = px * ch;
        let r; let g; let bl; let al = 255;
        if (color === 0) { r = g = bl = cur[o]; } else if (color === 4) { r = g = bl = cur[o]; al = cur[o + 1]; } else if (color === 2) { r = cur[o]; g = cur[o + 1]; bl = cur[o + 2]; } else if (color === 6) { r = cur[o]; g = cur[o + 1]; bl = cur[o + 2]; al = cur[o + 3]; } else {
          const k = cur[o]; r = palette[k * 3] || 0; g = palette[k * 3 + 1] || 0; bl = palette[k * 3 + 2] || 0; al = trns && k < trns.length ? trns[k] : 255;
        }
        // Ink: dark and not see-through. A transparent box counts as blank whatever its color values say.
        if (al >= 128 && (r * 299 + g * 587 + bl * 114) / 1000 < 128) { ink += 1; if (px < minX) minX = px; if (px > maxX) maxX = px; }
      }
      prev = Buffer.from(cur);
    }
    if (ink < MIN_INK || maxX - minX < MIN_SPAN) return no('Please sign in the box');
    return { ok: true };
  } catch (_) {
    return no('Please clear the box and sign again');
  }
}

module.exports = { check };
