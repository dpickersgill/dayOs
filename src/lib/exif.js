'use strict';

// Reads when and where a photo was taken from a JPEG's EXIF block: the original date and time, and the GPS position.
// Read-only and forgiving: anything it cannot make sense of comes back as null, never an error. Other formats (HEIC, PNG)
// return nulls; the upload still records when it arrived and where the phone said it was.

function readTiff(buf, start, end) {
  if (start + 8 > end) return null;
  const order = buf.toString('latin1', start, start + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o) => (o + 2 <= end ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : null);
  const u32 = (o) => (o + 4 <= end ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : null);
  if (u16(start + 2) !== 42) return null;
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function ifd(off) {
    const at = start + off; const n = u16(at);
    if (n === null || n > 500) return new Map();
    const out = new Map();
    for (let i = 0; i < n; i += 1) {
      const e = at + 2 + i * 12;
      const tag = u16(e); const type = u16(e + 2); const count = u32(e + 4);
      if (tag === null || type === null || count === null || !SIZES[type]) continue;
      const size = SIZES[type] * count;
      const vo = size <= 4 ? e + 8 : start + u32(e + 8);
      if (vo + size > end) continue;
      out.set(tag, { type, count, vo });
    }
    return out;
  }
  const ascii = (v) => (v && v.type === 2 ? buf.toString('latin1', v.vo, v.vo + v.count).replace(/\0.*$/s, '').trim() : null);
  const rationals = (v) => {
    if (!v || v.type !== 5) return null;
    const out = [];
    for (let i = 0; i < v.count; i += 1) { const d = u32(v.vo + i * 8 + 4); out.push(d ? u32(v.vo + i * 8) / d : 0); }
    return out;
  };
  const pointer = (m, tag) => { const v = m.get(tag); return v && (v.type === 4 || v.type === 13) ? u32(v.vo) : null; };

  const ifd0 = ifd(u32(start + 4));
  let takenAt = null; let lat = null; let lng = null;
  const exifOff = pointer(ifd0, 0x8769);
  if (exifOff !== null) {
    const ex = ifd(exifOff);
    const dt = ascii(ex.get(0x9003)) || ascii(ex.get(0x9004));
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(dt || '');
    if (m && m[1] !== '0000') takenAt = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  if (!takenAt) {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ascii(ifd0.get(0x0132)) || '');
    if (m && m[1] !== '0000') takenAt = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  const gpsOff = pointer(ifd0, 0x8825);
  if (gpsOff !== null) {
    const g = ifd(gpsOff);
    const dms = (v) => { const r = rationals(v); return r && r.length >= 3 ? r[0] + r[1] / 60 + r[2] / 3600 : null; };
    const la = dms(g.get(2)); const lo = dms(g.get(4));
    if (la !== null && lo !== null && (la !== 0 || lo !== 0)) {
      lat = (ascii(g.get(1)) === 'S' ? -la : la);
      lng = (ascii(g.get(3)) === 'W' ? -lo : lo);
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) { lat = null; lng = null; }
    }
  }
  return { taken_at: takenAt, lat: lat === null ? null : Math.round(lat * 1e6) / 1e6, lng: lng === null ? null : Math.round(lng * 1e6) / 1e6 };
}

/** { taken_at: 'YYYY-MM-DD HH:MM:SS' (camera's local time) | null, lat, lng } from a JPEG, or all nulls. */
function photoFacts(buf) {
  const none = { taken_at: null, lat: null, lng: null };
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return none;
    let o = 2;
    while (o + 4 <= buf.length) {
      if (buf[o] !== 0xff) return none;
      const marker = buf[o + 1];
      if (marker === 0xda || marker === 0xd9) return none; // image data starts: no EXIF before it
      const len = buf.readUInt16BE(o + 2);
      if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 10) === 'Exif\0\0') return readTiff(buf, o + 10, Math.min(buf.length, o + 2 + len)) || none;
      o += 2 + len;
    }
  } catch (_) { /* a damaged file: no facts */ }
  return none;
}

/** What a file is from its first bytes, so a mislabelled upload is stored as what it really is. */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(buf.toString('latin1', 8, 12))) return 'image/heic';
  return null;
}

/**
 * A copy of a photo with where it was taken removed, for anything shown publicly (muni release 1). The original is never
 * changed: it stays as taken, with its fingerprint. JPEG: the GPS block of the EXIF is blanked in place (its entries and
 * values zeroed, so every other offset still holds and the orientation stays) and XMP blocks (which can repeat the
 * position) are dropped. PNG: text and EXIF chunks are dropped. WebP: the EXIF and XMP chunks are dropped. Anything else
 * (HEIC, a file it cannot read) returns null: show it to staff only.
 */
function stripGps(input) {
  try {
    if (!Buffer.isBuffer(input)) return null;
    const kind = sniff(input);
    if (kind === 'image/jpeg') return stripJpeg(Buffer.from(input));
    if (kind === 'image/png') return stripPng(input);
    if (kind === 'image/webp') return stripWebp(input);
  } catch (_) { /* unreadable: not shown publicly */ }
  return null;
}

function blankGps(buf, start, end) {
  const order = buf.toString('latin1', start, start + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const ifd0 = start + u32(start + 4);
  if (ifd0 + 2 > end) return;
  const n0 = u16(ifd0);
  for (let i = 0; i < n0 && ifd0 + 2 + (i + 1) * 12 <= end; i += 1) {
    const e = ifd0 + 2 + i * 12;
    if (u16(e) !== 0x8825) continue;
    const gps = start + u32(e + 8);
    if (gps + 2 > end) return;
    const n = u16(gps);
    for (let j = 0; j < n && gps + 2 + (j + 1) * 12 <= end; j += 1) {
      const g = gps + 2 + j * 12;
      const size = (SIZES[u16(g + 2)] || 0) * u32(g + 4);
      if (size > 4) { const vo = start + u32(g + 8); if (vo >= start && vo + size <= end) buf.fill(0, vo, vo + size); }
      buf.fill(0, g, g + 12);
    }
    buf.fill(0, gps, gps + 2); // no entries left; the "next" pointer after them reads as none
  }
}

function stripJpeg(buf) {
  const keep = [buf.subarray(0, 2)];
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) break;
    const marker = buf[o + 1];
    if (marker === 0xda || marker === 0xd9) break; // the image data: kept as it is
    const len = buf.readUInt16BE(o + 2);
    const seg = buf.subarray(o, o + 2 + len);
    if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 10) === 'Exif\0\0') { blankGps(buf, o + 10, Math.min(buf.length, o + 2 + len)); keep.push(seg); }
    else if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 33).startsWith('http://ns.adobe.com/xap/1.0/')) { /* XMP: dropped */ }
    else keep.push(seg);
    o += 2 + len;
  }
  keep.push(buf.subarray(o));
  return Buffer.concat(keep);
}

function stripPng(buf) {
  const keep = [buf.subarray(0, 8)];
  let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const end = o + 12 + len;
    if (end > buf.length) { keep.push(buf.subarray(o)); return Buffer.concat(keep); }
    if (!['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(type)) keep.push(buf.subarray(o, end));
    o = end;
  }
  keep.push(buf.subarray(o));
  return Buffer.concat(keep);
}

function stripWebp(buf) {
  const keep = [];
  let o = 12;
  while (o + 8 <= buf.length) {
    const type = buf.toString('latin1', o, o + 4);
    const len = buf.readUInt32LE(o + 4);
    const end = Math.min(buf.length, o + 8 + len + (len % 2));
    if (type === 'VP8X') { const c = Buffer.from(buf.subarray(o, end)); c[8] &= ~0x0c; keep.push(c); } // no EXIF or XMP flags
    else if (type !== 'EXIF' && type !== 'XMP ') keep.push(buf.subarray(o, end));
    o = end;
  }
  const body = Buffer.concat(keep);
  const head = Buffer.from(buf.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

module.exports = { photoFacts, sniff, stripGps };
