'use strict';

// Pulls the words out of an uploaded file so documents can be searched by what is inside them.
//   Text, CSV, Markdown, RTF      read directly
//   Word, Excel, PowerPoint       the newer formats (.docx, .xlsx, .pptx) are zip files of XML; the text is read from them
//   PDF                           the text layer when there is one; pages that are only pictures of text are read with OCR
//   Images                        OCR (English)
// OCR is slower and uses more memory, so it only runs when asked for (ocr: true) and one file at a time. Set DOCS_OCR=0 to turn it off.
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');

const MAX_CHARS = 1_000_000;
const OCR_PAGE_LIMIT = 30;
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

function officeText(buf, ext) {
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => /^(word\/document|ppt\/slides\/slide\d+|xl\/sharedStrings|xl\/workbook)\.xml$/.test(f.name) || /^ppt\/slides\/slide\d+\.xml$/.test(f.name) });
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
const ocrImages = (images) => inQueue(() => withWorker(async (w) => { const out = []; for (const img of images) out.push((await w.recognize(img)).data.text); return out.join('\n\n'); }));

async function pdfText(buf, ocr) {
  const { getDocumentProxy, extractText, renderPageAsImage } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  const layer = squash(String(text || ''));
  if (layer.length >= 25 * Math.min(totalPages, 3)) return { text: layer, method: 'text' };
  if (!ocr || !OCR_ON) return { text: layer, method: layer ? 'text' : null, needsOcr: true };
  const images = [];
  for (let p = 1; p <= Math.min(totalPages, OCR_PAGE_LIMIT); p++) images.push(Buffer.from(await renderPageAsImage(pdf, p, { canvasImport: () => import('@napi-rs/canvas'), scale: 2 })));
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
    out = { text: await ocrImages([buf]), method: 'ocr' };
  } else return { unsupported: true };
  out.text = squash(out.text).slice(0, MAX_CHARS);
  return out;
}

module.exports = { extract, MAX_CHARS };
