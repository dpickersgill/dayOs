'use strict';

// Reading the words out of uploaded files: a small file built to unzip to gigabytes, or a picture too big to decode,
// is refused before it can use up the server's memory, while ordinary Word, Excel and PowerPoint files still read.
const test = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const { extract, imageSize } = require('../src/lib/doctext');

const MB = 1024 * 1024;
const docx = (bytes, opts = { level: 9 }) => Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<x/>'), 'word/document.xml': [bytes, opts] }));
/** Change the size the zip's table of contents states for one part, the way a hand-made zip can lie about it. */
function statedSize(zip, name, size) {
  const out = Buffer.from(zip);
  for (let i = 0; i < out.length - 46; i++) {
    if (out.readUInt32LE(i) === 0x02014b50 && out.subarray(i + 46, i + 46 + name.length).toString() === name) out.writeUInt32LE(size, i + 24);
  }
  return out;
}

test('a Word file that unzips to 300 MB is refused before it is unzipped', async () => {
  const bomb = docx(new Uint8Array(300 * MB).fill(0x20));
  assert.ok(bomb.length < 400 * 1024, `the upload itself is small (${bomb.length} bytes)`);
  const before = process.memoryUsage().rss;
  await assert.rejects(extract(bomb, 'bomb.docx'), /too big to read/);
  assert.ok(process.memoryUsage().rss - before < 50 * MB, 'nothing was unzipped');
});

test('one part over 20 MB, all parts over 50 MB, or a part that shrank over 100 times is refused', async () => {
  await assert.rejects(extract(docx(new Uint8Array(21 * MB).fill(0x41)), 'a.docx'), /too big to read/);
  const slides = {}; const noise = require('crypto').randomBytes(18 * MB); // does not shrink, so only the total is over
  for (let n = 1; n <= 3; n++) slides[`ppt/slides/slide${n}.xml`] = [noise, { level: 0 }];
  await assert.rejects(extract(Buffer.from(zipSync(slides)), 'a.pptx'), /over 52428800 bytes unzipped/);
  await assert.rejects(extract(docx(new Uint8Array(5 * MB).fill(0x41)), 'a.docx'), /over 100 times/);
});

test('a zip that states a small size and unzips to far more is stopped part way', async () => {
  const lying = statedSize(docx(new Uint8Array(300 * MB).fill(0x20)), 'word/document.xml', 900 * 1024);
  const before = process.memoryUsage().rss;
  await assert.rejects(extract(lying, 'liar.docx'), /unzips to more than the file says/);
  assert.ok(process.memoryUsage().rss - before < 100 * MB, 'unzipping stopped near the stated size');
});

test('ordinary Word, Excel and PowerPoint files still read, compressed or stored', async () => {
  const words = '<w:p><w:r><w:t>Chair 2 &amp; the summit lift</w:t></w:r></w:p>';
  assert.equal((await extract(docx(strToU8(words.repeat(3))), 'a.docx')).text, 'Chair 2 & the summit lift\nChair 2 & the summit lift\nChair 2 & the summit lift');
  const xlsx = Buffer.from(zipSync({ 'xl/workbook.xml': strToU8('<sheet name="Lifts" sheetId="1"/>'), 'xl/sharedStrings.xml': strToU8('<si><t>Chair 1</t></si>') }, { level: 0 }));
  assert.equal((await extract(xlsx, 'a.xlsx')).text, 'Lifts\nChair 1');
  const pptx = Buffer.from(zipSync({ 'ppt/slides/slide10.xml': strToU8('<a:p><a:t>Ten</a:t></a:p>'), 'ppt/slides/slide2.xml': strToU8('<a:p><a:t>Two</a:t></a:p>'), 'ppt/slides/slide1.xml': strToU8('<a:p><a:t>One</a:t></a:p>') }));
  assert.equal((await extract(pptx, 'a.pptx')).text, 'One\nTwo\nTen');
  // a real-sized document, well under the limits, with a normal amount of compression
  const para = (i) => `<w:p><w:r><w:t>Line ${i}: check the bullwheel, the haul rope and the brakes before loading.</w:t></w:r></w:p>`;
  const long = Array.from({ length: 9000 }, (_, i) => para(i)).join('');
  assert.match((await extract(docx(strToU8(long), { level: 6 }), 'long.docx')).text, /Line 8999: check the bullwheel/);
  await assert.rejects(extract(Buffer.from('PK not really a zip'), 'a.docx'), /not a zip file/);
});

test('a picture over 40 megapixels is refused before OCR decodes it', async () => {
  // A PNG header that says 10,000 by 10,000 pixels; the size alone is enough to refuse it.
  const png = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(png); png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(10000, 16); png.writeUInt32BE(10000, 20);
  assert.deepEqual(imageSize(png), [10000, 10000]);
  await assert.rejects(extract(png, 'huge.png', { ocr: true }), /too big to read \(10000 by 10000 pixels\)/);
  // sizes come from the header of every picture type that can be uploaded
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(321, 123);
  for (const kind of ['image/png', 'image/jpeg', 'image/webp']) assert.deepEqual(imageSize(canvas.toBuffer(kind)), [321, 123], kind);
  const gif = Buffer.from('GIF89a\x41\x01\x7b\x00', 'latin1');
  assert.deepEqual(imageSize(gif), [321, 123]);
});
