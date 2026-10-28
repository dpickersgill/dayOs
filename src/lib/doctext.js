'use strict';

// Pulls the words out of an uploaded file so documents can be searched by what is inside them.
//   Text, CSV, Markdown, RTF      read directly
//   Word, Excel, PowerPoint       the newer formats (.docx, .xlsx, .pptx) are zip files of XML; the text is read from them
//   PDF                           the text layer when there is one; pages that are only pictures of text are read with OCR
//   Images                        OCR (English)
// OCR is slower and uses more memory, so it only runs when asked for (ocr: true) and one file at a time. Set DOCS_OCR=0 to turn it off.
// A file that is over the limits below is refused with an error, so the caller marks it as not readable and keeps the upload.
// (This still runs inside the web request. Moving reading and OCR to a background job with its own memory limit is a later step.)
const path = require('path');
const { Inflate, strFromU8 } = require('fflate');

const MAX_CHARS = 1_000_000;
const OCR_PAGE_LIMIT = 30;
const PDF_PAGE_LIMIT = 1000;            // pages read from a PDF's text layer
const OCR_PIXEL_LIMIT = 40_000_000;     // one picture, or one PDF page drawn for OCR (40 megapixels is about 160 MB once decoded)
// Word, Excel and PowerPoint files are zip files, and a zip of a few hundred KB can unzip to gigabytes. Unzipping one in full
// would use up the server's memory and stop every mountain on it, so only the parts we read are unzipped, within these limits.
const ZIP_PART_LIMIT = 20 * 1024 * 1024;  // one part: the document, one slide, the shared strings
const ZIP_TOTAL_LIMIT = 50 * 1024 * 1024; // all the parts read from one file
const ZIP_RATIO_LIMIT = 100;              // real Office XML shrinks about 5 to 20 times; 100 times or more is built to blow up
const ZIP_RATIO_FROM = 1024 * 1024;       // a small part may shrink a lot without harm, so the ratio counts only above 1 MB
const OFFICE_PARTS = /^(word\/document|ppt\/slides\/slide\d+|xl\/sharedStrings|xl\/workbook)\.xml$/;
const OCR_ON = process.env.DOCS_OCR !== '0';
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const squash = (s) => s.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

function fromXml(xml, textTag, breakTag) {
  const withBreaks = breakTag ? xml.replace(new RegExp(`</${breakTag}>`, 'g'), '\n') : xml;
  const out = [];
  const re = new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>|(\\n)`, 'g');
  let m;
  while ((m = re.exec(withBreaks))) out.push(m[2] ? '\n' : decode(m[1]));
  return out.join('');
}

/**
 * The parts of a zip file whose names match `wanted`, read from the zip's own table of contents without unzipping anything.
 * Each part has its stated sizes and its still-compressed bytes. Throws on a damaged zip.
 */
function zipParts(u8, wanted) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => dv.getUint16(o, true); const u32 = (o) => dv.getUint32(o, true);
  let end = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 65557; i--) if (u32(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const parts = [];
  for (let n = u16(end + 10), o = u32(end + 16); n > 0; n--) {
    if (o + 46 > u8.length || u32(o) !== 0x02014b50) throw new Error('the zip table of contents is damaged');
    const method = u16(o + 10); const size = u32(o + 20); const originalSize = u32(o + 24); const local = u32(o + 42);
    const nameLen = u16(o + 28);
    const name = Buffer.from(u8.subarray(o + 46, o + 46 + nameLen)).toString('utf8');
    o += 46 + nameLen + u16(o + 30) + u16(o + 32);
    if (!wanted.test(name)) continue;
    if (local + 30 > u8.length || u32(local) !== 0x04034b50) throw new Error(`${name} is damaged`);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (start + size > u8.length) throw new Error(`${name} is damaged`);
    parts.push({ name, method, size, originalSize, data: u8.subarray(start, start + size) });
  }
  return parts;
}

/** Unzip one part, stopping as soon as it grows past what the zip said it would (a lying zip cannot get past the size checks). */
function inflateUpTo(name, data, limit) {
  const chunks = []; let total = 0;
  const inflater = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) throw new Error(`${name} unzips to more than the file says`);
    chunks.push(chunk);
  });
  // Small steps: one step of 4 KB can unzip to at most about 4 MB, so memory stays near the limit even when the zip lies.
  const STEP = 4096;
  for (let i = 0; i < data.length; i += STEP) inflater.push(data.subarray(i, i + STEP), i + STEP >= data.length);
  return Buffer.concat(chunks);
}

/** The XML parts of a Word, Excel or PowerPoint file, refused before unzipping when they would be too big to read safely. */
function officeParts(buf) {
  const parts = zipParts(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), OFFICE_PARTS);
  let total = 0;
  for (const p of parts) {
    total += p.originalSize;
    if (p.originalSize > ZIP_PART_LIMIT) throw new Error(`${p.name} is too big to read (${p.originalSize} bytes unzipped)`);
    if (total > ZIP_TOTAL_LIMIT) throw new Error(`the file is too big to read (over ${ZIP_TOTAL_LIMIT} bytes unzipped)`);
    if (p.originalSize > ZIP_RATIO_FROM && p.originalSize > ZIP_RATIO_LIMIT * Math.max(p.size, 1)) throw new Error(`${p.name} unzips to over ${ZIP_RATIO_LIMIT} times its size`);
  }
  const files = {};
  for (const p of parts) {
    if (p.method === 0) files[p.name] = p.data;
    else if (p.method === 8) files[p.name] = inflateUpTo(p.name, p.data, p.originalSize);
    else throw new Error(`${p.name} uses an unknown kind of compression`);
  }
  return files;
}

function officeText(buf, ext) {
  const files = officeParts(buf);
  const get = (name) => (files[name] ? strFromU8(files[name]) : '');
  if (ext === 'docx') return fromXml(get('word/document.xml'), 'w:t', 'w:p');
  if (ext === 'xlsx') {
    const sheets = [...get('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));
    return `${sheets.join('\n')}\n${fromXml(get('xl/sharedStrings.xml'), 't', 'si')}`;
  }
  const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
  return slides.map((n) => fromXml(strFromU8(files[n]), 'a:t', 'a:p')).join('\n\n');
}

function rtfText(s) {
  return s.replace(/\\'([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\par[d]?/g, '\n').replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
}

// ---- OCR, one job at a time so a busy library cannot use up the server's memory.
let queue = Promise.resolve();
const inQueue = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
async function withWorker(fn) {
  const { createWorker } = require('tesseract.js');
  const langPath = path.dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'));
  const worker = await createWorker('eng', 1, { langPath, gzip: true, cachePath: path.join(require('os').tmpdir(), 'tess-cache') });
  try { return await fn(worker); } finally { await worker.terminate().catch(() => {}); }
}

/** Width and height from a picture's header, without decoding it. null when the header cannot be read. */
function imageSize(b) {
  const s = (a, z) => b.subarray(a, z).toString('latin1');
  if (b.length >= 24 && b[0] === 0x89 && s(12, 16) === 'IHDR') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length >= 10 && s(0, 4) === 'GIF8') return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (b.length >= 30 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') {
    const kind = s(12, 16);
    if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    if (kind === 'VP8L') { const v = b.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >>> 14) & 0x3fff)]; }
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; } // fill byte
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // markers with no length
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}
/** Refuse a picture too big to decode safely, before OCR decodes it. */
function checkPixels(width, height, what) {
  if (!(width > 0 && height > 0)) throw new Error(`${what} has no readable size`);
  if (width * height > OCR_PIXEL_LIMIT) throw new Error(`${what} is too big to read (${width} by ${height} pixels)`);
}
const ocrImages = (images) => inQueue(() => withWorker(async (w) => { const out = []; for (const img of images) out.push((await w.recognize(img)).data.text); return out.join('\n\n'); }));

async function pdfText(buf, ocr) {
  const { getDocumentProxy, extractText, renderPageAsImage } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  if (pdf.numPages > PDF_PAGE_LIMIT) throw new Error(`the PDF has ${pdf.numPages} pages; the most that can be read is ${PDF_PAGE_LIMIT}`);
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const layer = squash(String(text || ''));
  if (layer.length >= 25 * Math.min(totalPages, 3)) return { text: layer, method: 'text' };
  if (!ocr || !OCR_ON) return { text: layer, method: layer ? 'text' : null, needsOcr: true };
  const images = [];
  for (let p = 1; p <= Math.min(totalPages, OCR_PAGE_LIMIT); p++) {
    const { width, height } = (await pdf.getPage(p)).getViewport({ scale: 2 });
    checkPixels(Math.ceil(width), Math.ceil(height), `page ${p}`);
    images.push(Buffer.from(await renderPageAsImage(pdf, p, { canvasImport: () => import('@napi-rs/canvas'), scale: 2 })));
  }
  return { text: squash(`${layer}\n${await ocrImages(images)}`), method: 'ocr' };
}

/**
 * Returns { text, method, needsOcr } or { unsupported: true }. method is 'text' or 'ocr'. needsOcr means the file looks like
 * a picture of text and the caller should run again with ocr: true.
 */
async function extract(buf, fileName, { ocr = false } = {}) {
  const ext = path.extname(String(fileName)).slice(1).toLowerCase();
  let out;
  if (['txt', 'csv', 'md'].includes(ext)) out = { text: buf.toString('utf8'), method: 'text' };
  else if (ext === 'rtf') out = { text: rtfText(buf.toString('latin1')), method: 'text' };
  else if (['docx', 'xlsx', 'pptx'].includes(ext)) out = { text: officeText(buf, ext), method: 'text' };
  else if (ext === 'pdf') out = await pdfText(buf, ocr);
  else if (IMAGE_EXT.has(ext)) {
    if (!ocr || !OCR_ON) return OCR_ON ? { text: '', method: null, needsOcr: true } : { unsupported: true };
    const size = imageSize(buf);
    checkPixels(size?.[0], size?.[1], 'the picture');
    out = { text: await ocrImages([buf]), method: 'ocr' };
  } else return { unsupported: true };
  out.text = squash(out.text).slice(0, MAX_CHARS);
  return out;
}

module.exports = { extract, MAX_CHARS, imageSize };
